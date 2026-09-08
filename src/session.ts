/**
 * 录制会话核心: 启动有头浏览器, 监听 UI 事件(点击/输入/提交)与网络事件(请求/响应/失败),
 * 内存留存全部事件供报告生成, 同时逐行写入 events.jsonl 防止进程崩溃丢数据。
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request
} from 'playwright-core'
import { generateMarkdown } from './report.ts'
import type {
  RecordedEvent,
  RecorderOptions,
  SessionStats,
  StopResult,
  UiPayload,
  UnstampedEvent
} from './types.ts'

/** 注入页面的 UI 事件采集脚本: 捕获阶段监听 click/change/submit, 经 exposeBinding 回传。 */
const INIT_SCRIPT = `(() => {
  if (window.__huafengRecorderInstalled) return
  window.__huafengRecorderInstalled = true
  const send = (p) => {
    try {
      if (window.__huafengRecordUIEvent) window.__huafengRecordUIEvent(p)
    } catch (e) { /* 绑定不可用时静默丢弃 */ }
  }
  const selectorOf = (el) => {
    const parts = []
    let cur = el
    while (cur && cur.tagName && parts.length < 5) {
      let part = cur.tagName.toLowerCase()
      if (cur.id) {
        parts.unshift(part + '#' + cur.id)
        break
      }
      if (typeof cur.className === 'string' && cur.className.trim()) {
        part += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.')
      }
      parts.unshift(part)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const labelOf = (el) =>
    (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 80)
  document.addEventListener('click', (e) => {
    const raw = e.target
    if (!raw || !raw.tagName) return
    const el = raw.closest ? raw.closest('button, a, [role="button"], input, select, textarea, [onclick]') || raw : raw
    send({
      kind: 'click',
      selector: selectorOf(el),
      tag: (el.tagName || '').toLowerCase(),
      text: labelOf(el) || undefined,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    })
  }, true)
  document.addEventListener('change', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    const isPassword = el.type === 'password'
    send({
      kind: 'change',
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      name: el.name || undefined,
      value: isPassword ? undefined : String(el.value == null ? '' : el.value).slice(0, 200),
      redacted: isPassword || undefined,
    })
  }, true)
  document.addEventListener('submit', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    send({ kind: 'submit', selector: selectorOf(el) })
  }, true)
})()`

export class RecorderSession {
  readonly startedAt = Date.now()
  readonly sessionDir: string
  readonly eventsPath: string
  private readonly opts: RecorderOptions
  private seq = 0
  private requestSeq = 0
  private events: RecordedEvent[] = []
  private jsonl: WriteStream
  private browser?: Browser
  private context?: BrowserContext
  private pageIds = new Map<Page, number>()
  private nextPageId = 1
  private openPages = 0
  private noPageTimer?: ReturnType<typeof setTimeout>
  private requestIds = new Map<Request, number>()
  private pendingBodies = new Set<Promise<void>>()
  private stoppingReason?: string
  private stopResult?: StopResult

  private constructor(opts: RecorderOptions, sessionDir: string) {
    this.opts = opts
    this.sessionDir = sessionDir
    this.eventsPath = join(sessionDir, 'events.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    this.jsonl = createWriteStream(this.eventsPath, { flags: 'w' })
  }

  /** 启动浏览器并完成全部监听挂载; 失败时清理已建目录流。 */
  static async start(
    startUrl: string | undefined,
    opts: RecorderOptions
  ): Promise<RecorderSession> {
    const now = new Date()
    const pad2 = (n: number): string => String(n).padStart(2, '0')
    // 目录名 rec-HH-mm-ss: 本地时间时分秒, 简短易分辨
    const dirName = `rec-${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
    const session = new RecorderSession(opts, join(opts.outputDir, dirName))
    try {
      session.browser = await chromium.launch({
        headless: false,
        ...(opts.executablePath.trim()
          ? { executablePath: opts.executablePath.trim() }
          : { channel: opts.channel })
      })
      session.context = await session.browser.newContext({ viewport: null })
      await session.context.exposeBinding(
        '__huafengRecordUIEvent',
        (source, payload: UiPayload) => {
          session.pushUi(source.page, payload)
        }
      )
      await session.context.addInitScript(INIT_SCRIPT)
      session.context.on('page', page => session.attachPage(page))
      // 用户直接关掉浏览器时自动收尾, 已录数据不丢; stop() 主动关窗时用 stop 的真实原因
      session.browser.on('disconnected', () => {
        if (session.noPageTimer) clearTimeout(session.noPageTimer)
        session.noPageTimer = undefined
        void session.finalize(session.stoppingReason ?? 'browser-closed')
      })
      for (const page of session.context.pages()) session.attachPage(page)
      const page = session.context.pages()[0] ?? (await session.context.newPage())
      if (startUrl?.trim()) await page.goto(startUrl.trim(), { waitUntil: 'domcontentloaded' })
      return session
    } catch (cause) {
      session.jsonl.end()
      throw cause
    }
  }

  /** 供高级调用方(冒烟测试等)拿到当前页面对象。 */
  pages(): Page[] {
    return this.context?.pages() ?? []
  }

  isFinished(): boolean {
    return !!this.stopResult
  }

  /** 已收尾会话的最终结果(用户直接关浏览器自动收尾时也存在)。 */
  result(): StopResult | undefined {
    return this.stopResult
  }

  status(): {
    recording: boolean
    startedAt: number
    sessionDir: string
    counts: SessionStats
    eventCount: number
  } {
    return {
      recording: !this.stopResult,
      startedAt: this.startedAt,
      sessionDir: this.sessionDir,
      counts: this.stats(),
      eventCount: this.events.length
    }
  }

  /** 停止录制: 等未完成的响应体抓取(宽限 2s), 生成报告, 关闭浏览器; 幂等(用户已关浏览器时返回既有结果)。 */
  async stop(reason: string): Promise<StopResult> {
    if (this.stopResult) return this.stopResult
    this.stoppingReason = reason
    try {
      await Promise.race([
        Promise.allSettled([...this.pendingBodies]),
        new Promise<void>(resolve => setTimeout(resolve, 2000))
      ])
      if (this.context) await this.context.close().catch(() => undefined)
      if (this.browser) await this.browser.close().catch(() => undefined)
    } finally {
      return this.finalize(reason)
    }
  }

  private attachPage(page: Page): void {
    if (this.pageIds.has(page)) return
    this.pageIds.set(page, this.nextPageId++)
    this.openPages++
    // 任何窗口/标签被关都立刻感知: 计数归零后延迟确认(允许操作途中短暂无页面),
    // 仍无页面则视为用户关闭浏览器, 自动收尾生成报告(兜底 disconnected 未触发的情况)。
    page.on('close', () => {
      this.openPages = Math.max(0, this.openPages - 1)
      this.scheduleNoPageCheck()
    })
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame())
        this.push({ type: 'navigate', pageId: this.pageIds.get(page), url: page.url() })
    })
    page.on('request', request => {
      // 只录指定 resourceType(默认 xhr/fetch); 不录的请求不进 requestIds, 其响应/失败事件随之丢弃
      if (!this.opts.requestResourceTypes.includes(request.resourceType())) return
      const requestId = ++this.requestSeq
      this.requestIds.set(request, requestId)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(request.headers())) {
        headers[key] = this.opts.redactHeaders.includes(key.toLowerCase()) ? '<redacted>' : value
      }
      let postData: string | undefined
      try {
        postData = request.postData() ?? undefined
      } catch {
        postData = '<binary>'
      }
      if (postData && Buffer.byteLength(postData) > this.opts.maxBodyBytes) {
        postData =
          postData.slice(0, this.opts.maxBodyBytes) +
          `...(截断, 原始长度 ${Buffer.byteLength(postData)} 字节)`
      }
      this.push({
        type: 'request',
        pageId: this.pageIds.get(page),
        requestId,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers,
        postData
      })
    })
    page.on('response', response => {
      const request = response.request()
      const requestId = this.requestIds.get(request)
      if (requestId === undefined) return
      const base = {
        type: 'response' as const,
        pageId: this.pageIds.get(page),
        requestId,
        status: response.status(),
        url: response.url()
      }
      if (this.opts.captureResponseBodies && ['xhr', 'fetch'].includes(request.resourceType())) {
        // 响应体异步抓取; 页面随即跳转会导致 CDP 取体调用被取消, 落入 catch 记录无体版本
        const pending = response
          .text()
          .then(text => {
            const truncated = Buffer.byteLength(text) > this.opts.maxBodyBytes
            this.push({
              ...base,
              body: truncated ? text.slice(0, this.opts.maxBodyBytes) : text,
              bodyTruncated: truncated || undefined
            })
          })
          .catch(() => this.push(base))
        this.pendingBodies.add(pending)
        void pending.finally(() => this.pendingBodies.delete(pending))
      } else {
        this.push(base)
      }
    })
    page.on('requestfailed', request => {
      const requestId = this.requestIds.get(request)
      if (requestId === undefined) return
      this.push({
        type: 'requestfailed',
        pageId: this.pageIds.get(page),
        requestId,
        url: request.url(),
        errorText: request.failure()?.errorText ?? 'unknown'
      })
    })
    if (this.opts.recordConsole) {
      page.on('console', message => {
        this.push({
          type: 'console',
          pageId: this.pageIds.get(page),
          level: message.type(),
          text: message.text().slice(0, 500)
        })
      })
    }
  }

  /**
   * 页面全部关闭后的自动收尾检查: 延迟 800ms 给「关了一个 tab 又立刻新开」留缓冲,
   * 之后仍无存活页面则视为用户关闭浏览器, 立即 finalize 生成报告;
   * 若浏览器进程仍连接着(如 Windows 上 Edge/Chrome 关窗口后进程后台驻留,
   * disconnected 迟迟不触发), 顺带关闭进程避免残留。与 disconnected 路径幂等。
   */
  private scheduleNoPageCheck(): void {
    if (this.stopResult || this.openPages > 0) return
    if (this.noPageTimer) clearTimeout(this.noPageTimer)
    this.noPageTimer = setTimeout(() => {
      this.noPageTimer = undefined
      if (this.stopResult || this.openPages > 0) return
      void this.finalize(this.stoppingReason ?? 'browser-closed').finally(() => {
        if (this.browser?.isConnected()) void this.browser.close().catch(() => undefined)
      })
    }, 800)
  }

  private pushUi(page: Page, payload: UiPayload): void {
    const pageId = this.pageIds.get(page)
    const url = page.url()
    if (payload.kind === 'click') {
      this.push({
        type: 'click',
        pageId,
        url,
        selector: payload.selector,
        tag: payload.tag,
        text: payload.text,
        x: payload.x,
        y: payload.y
      })
    } else if (payload.kind === 'change') {
      this.push({
        type: 'change',
        pageId,
        url,
        selector: payload.selector,
        tag: payload.tag,
        name: payload.name,
        value: payload.value,
        redacted: payload.redacted
      })
    } else {
      this.push({ type: 'submit', pageId, url, selector: payload.selector })
    }
  }

  private push(event: UnstampedEvent): void {
    if (this.stopResult) return
    const full = { ...event, seq: ++this.seq, ts: Date.now() } as RecordedEvent
    this.events.push(full)
    this.jsonl.write(JSON.stringify(full) + '\n')
  }

  private stats(): SessionStats {
    const stats: SessionStats = {
      navigations: 0,
      clicks: 0,
      changes: 0,
      submits: 0,
      requests: 0,
      responses: 0,
      failed: 0,
      console: 0
    }
    for (const e of this.events) {
      if (e.type === 'navigate') stats.navigations++
      else if (e.type === 'click') stats.clicks++
      else if (e.type === 'change') stats.changes++
      else if (e.type === 'submit') stats.submits++
      else if (e.type === 'request') stats.requests++
      else if (e.type === 'response') stats.responses++
      else if (e.type === 'requestfailed') stats.failed++
      else if (e.type === 'console') stats.console++
    }
    return stats
  }

  private async finalize(reason: string): Promise<StopResult> {
    if (this.stopResult) return this.stopResult
    const endedAt = Date.now()
    const reportPath = join(this.sessionDir, 'report.md')
    // 报告生成/写盘失败都不阻断收尾: stopResult 必须被设置, 否则收尾会静默丢失
    let report: string
    try {
      report = generateMarkdown(this.events, {
        startedAt: this.startedAt,
        endedAt,
        reason,
        sessionDir: this.sessionDir
      })
    } catch {
      report = `# 报告生成失败\n\n- 结束原因: ${reason}\n- 已记录事件: ${this.events.length} 个\n- 明细见 events.jsonl\n`
    }
    try {
      await writeFile(reportPath, report, 'utf8')
    } catch {
      // 报告写盘失败不阻断收尾
    }
    await new Promise<void>(resolve => this.jsonl.end(resolve))
    this.stopResult = {
      reason,
      startedAt: this.startedAt,
      endedAt,
      eventCount: this.events.length,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      reportPath,
      stats: this.stats()
    }
    return this.stopResult
  }
}
