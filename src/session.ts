/**
 * 录制会话核心: 启动有头浏览器, 监听 UI 事件(点击/输入/提交)与网络事件(请求/响应/失败),
 * 内存留存全部事件供报告生成, 同时逐行写入 events.jsonl 防止进程崩溃丢数据。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
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
  /** CDP attach 模式下为 true, 此时不主动关闭浏览器进程 */
  private attached = false
  private cdpSession?: CDPSession
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

  /**
   * 启动浏览器并完成全部监听挂载; 失败时清理已建目录流。
   * attach 优先级: 显式配置的 cdpUrl → 自动发现 Playwright MCP 浏览器的 CDP 端口
   * (读取其 user-data-dir 下的 DevToolsActivePort, 需 MCP 以 --remote-debugging-port 启动);
   * 两者都不可用时回退到接管模式: 读取 MCP 浏览器当前页面 URL, 关闭旧浏览器,
   * 用 recorder 新开窗口并导航到相同 URL。
   */
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
      // 1. 显式配置的 CDP 地址优先
      let attached = await session.tryAttach(opts.cdpUrl?.trim())
      let playwrightMcpUrl: string | undefined
      if (!attached) {
        // 2. 自动发现 Playwright MCP 浏览器的 CDP 端口, attach 到用户正在使用的窗口
        const mcpCdpUrl = session.discoverMcpCdpUrl()
        if (mcpCdpUrl) attached = await session.tryAttach(mcpCdpUrl)
      }
      if (!attached) {
        // 3. 回退接管: 检测 Playwright MCP 浏览器, 关掉后用 recorder 新开窗口
        playwrightMcpUrl = session.detectPlaywrightMcpBrowser()
        if (playwrightMcpUrl) {
          // 关闭 Playwright MCP 浏览器进程
          session.killPlaywrightMcpBrowser()
          // 等待进程退出
          await new Promise(resolve => setTimeout(resolve, 1500))
        }
        // 新开浏览器窗口(优先使用接管的 URL)
        session.browser = await chromium.launch({
          headless: false,
          ...(opts.executablePath.trim()
            ? { executablePath: opts.executablePath.trim() }
            : { channel: opts.channel })
        })
        session.context = await session.browser.newContext({ viewport: null })
      }
      await session.context!.exposeBinding(
        '__huafengRecordUIEvent',
        (source, payload: UiPayload) => {
          session.pushUi(source.page, payload)
        }
      )
      await session.context!.addInitScript(INIT_SCRIPT)
      // attach 模式下已加载的页面不会触发 init script, 直接 evaluate 补装采集脚本
      // (脚本内 __huafengRecorderInstalled 守卫保证后续导航不重复安装)
      if (attached) {
        for (const page of session.context!.pages()) {
          await page.evaluate(INIT_SCRIPT).catch(() => undefined)
        }
      }
      session.context!.on('page', page => session.attachPage(page))
      // 用户直接关掉浏览器时自动收尾, 已录数据不丢; stop() 主动关窗时用 stop 的真实原因
      if (!session.attached) {
        session.browser!.on('disconnected', () => {
          if (session.noPageTimer) clearTimeout(session.noPageTimer)
          session.noPageTimer = undefined
          void session.finalize(session.stoppingReason ?? 'browser-closed')
        })
      }
      for (const page of session.context!.pages()) session.attachPage(page)
      // attach 模式只在调用方显式传入 URL 时才导航当前页, 否则保持用户正在看的页面不动
      const finalUrl = startUrl?.trim() || playwrightMcpUrl
      if (finalUrl?.trim()) {
        const page = session.context!.pages()[0] ?? (await session.context!.newPage())
        await page.goto(finalUrl.trim(), { waitUntil: 'domcontentloaded' })
      }
      return session
    } catch (cause) {
      session.jsonl.end()
      throw cause
    }
  }

  /**
   * 执行 PowerShell 脚本并返回 stdout。统一走 -EncodedCommand(UTF-16LE base64):
   * 脚本内含双引号(如正则 [^\s"])时, -Command "..." 经 cmd.exe + powershell 双层引号
   * 解析会断裂静默失败, EncodedCommand 完全绕开该问题。
   */
  private runPowerShell(script: string): string {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      timeout: 10000
    })
  }

  /** 查找正在运行的 Playwright MCP 浏览器的 user-data-dir(Windows: PowerShell CIM 查进程命令行)。 */
  private findMcpUserDataDir(): string | undefined {
    try {
      // Windows: 通过 PowerShell CIM 查找包含 ms-playwright-mcp 的浏览器进程
      const psScript = `
        Get-CimInstance Win32_Process | Where-Object {
          ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
          $_.CommandLine -match 'ms-playwright-mcp' -and
          $_.CommandLine -notmatch '--type='
        } | ForEach-Object {
          if ($_.CommandLine -match '--user-data-dir="?([^\\s"]+)') { $Matches[1] }
        } | Select-Object -First 1
      `
      const userDataDir = this.runPowerShell(psScript).trim()
      return userDataDir || undefined
    } catch {
      return undefined
    }
  }

  /**
   * 自动发现 Playwright MCP 浏览器的 CDP 地址: MCP 以 --remote-debugging-port 启动时,
   * Chrome 会把实际端口写入 user-data-dir 下的 DevToolsActivePort 文件(第一行)。
   * 读到则返回 http://127.0.0.1:<port>, 供 tryAttach 直接 attach 到用户正在使用的窗口。
   */
  private discoverMcpCdpUrl(): string | undefined {
    try {
      const userDataDir = this.findMcpUserDataDir()
      if (!userDataDir) return undefined
      const portFile = join(userDataDir, 'DevToolsActivePort')
      if (!existsSync(portFile)) return undefined
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim())
      if (!Number.isInteger(port) || port <= 0) return undefined
      return `http://127.0.0.1:${port}`
    } catch {
      return undefined
    }
  }

  /**
   * 检测是否有 Playwright MCP 浏览器在运行(通过查找 ms-playwright-mcp user-data-dir 的进程)。
   * 若找到, 从其 Chrome Tabs 文件中提取最近访问的 URL 并返回; 否则返回 undefined。
   */
  private detectPlaywrightMcpBrowser(): string | undefined {
    const userDataDir = this.findMcpUserDataDir()
    if (!userDataDir) return undefined
    // 从 Chrome Tabs 文件中提取最近访问的 URL
    return this.extractUrlFromTabs(userDataDir)
  }

  /** 从 Chrome 的 Sessions 目录中提取最近访问的 URL(读取 Tabs 文件, 其中包含明文 URL)。 */
  private extractUrlFromTabs(userDataDir: string): string | undefined {
    try {
      const sessionsDir = join(userDataDir, 'Default', 'Sessions')
      if (!existsSync(sessionsDir)) return undefined

      // 找最新的非空 Tabs 文件
      const files = execSync(`dir /b /o-d "${sessionsDir}\\Tabs_*" 2>nul`, {
        encoding: 'utf8',
        timeout: 5000,
        shell: 'cmd.exe'
      })
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.startsWith('Tabs_'))
      if (files.length === 0) return undefined

      for (const file of files) {
        const filePath = join(sessionsDir, file)
        try {
          const bytes = readFileSync(filePath)
          if (bytes.length === 0) continue
          const content = bytes.toString('ascii')
          // 匹配 http/https URL, 优先取带路径的(排除纯域名)
          const urls = content.match(/https?:\/\/[^\x00-\x1F\x7F\s"'<>]+/g) || []
          // 过滤: 优先选择包含路径的 URL(不只是域名)
          const withPath = urls.filter(u => {
            try {
              const url = new URL(u)
              return url.pathname !== '/' && url.pathname !== ''
            } catch {
              return false
            }
          })
          if (withPath.length > 0) {
            // 去重并返回最后一个(通常是最新访问的)
            const unique = [...new Set(withPath)]
            return unique[unique.length - 1]
          }
        } catch {
          continue
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /** 关闭 Playwright MCP 浏览器进程(通过 PowerShell Stop-Process)。 */
  private killPlaywrightMcpBrowser(): void {
    try {
      const psScript = `
        Get-CimInstance Win32_Process | Where-Object {
          ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
          $_.CommandLine -match 'ms-playwright-mcp'
        } | ForEach-Object {
          Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
      `
      this.runPowerShell(psScript)
    } catch {
      // 忽略错误, 即使关闭失败也继续新开浏览器
    }
  }

  /** 尝试通过 CDP attach 到已运行的浏览器(如 Playwright 打开的页面)。成功返回 true。 */
  private async tryAttach(cdpUrl?: string): Promise<boolean> {
    if (!cdpUrl) return false
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl)
      this.attached = true
      // connectOverCDP 返回的 browser 可能已有 context, 优先取已有页面的(用户正在用的窗口), 否则取第一个或新建
      const contexts = this.browser.contexts()
      this.context = contexts.find(c => c.pages().length > 0) ?? contexts[0]
      if (!this.context) {
        this.context = await this.browser.newContext({ viewport: null })
      }
      // CDP attach 模式下, 通过 CDP session 监听浏览器关闭
      this.cdpSession = await this.context.newCDPSession(this.context.pages()[0] ?? (await this.context.newPage()))
      this.cdpSession.on('Inspector.targetCrashed', () => {
        void this.finalize(this.stoppingReason ?? 'browser-crashed')
      })
      return true
    } catch {
      // attach 失败, 清理并返回 false 让调用方回退到 launch
      this.browser = undefined
      this.context = undefined
      this.cdpSession = undefined
      this.attached = false
      return false
    }
  }

  /** 供高级调用方(冒烟测试等)拿到当前页面对象。 */
  pages(): Page[] {
    return this.context?.pages() ?? []
  }

  /** 是否为 CDP attach 模式(attach 到已有浏览器窗口, 而非插件自启的窗口)。 */
  isAttached(): boolean {
    return this.attached
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
      if (this.attached) {
        // CDP attach 模式: 不关闭浏览器进程, 只断开 CDP 连接
        if (this.cdpSession) await this.cdpSession.detach().catch(() => undefined)
        if (this.browser) await this.browser.close().catch(() => undefined)
      } else {
        if (this.context) await this.context.close().catch(() => undefined)
        if (this.browser) await this.browser.close().catch(() => undefined)
      }
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
