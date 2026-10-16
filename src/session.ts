/**
 * 录制会话核心: 启动有头浏览器, 监听 UI 事件(点击/输入/提交)与网络事件(请求/响应/失败),
 * 内存留存全部事件供报告生成, 同时逐行写入 events.jsonl 防止进程崩溃丢数据。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  type WriteStream
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Request
} from 'playwright-core'
import { createBrowserProbe } from './browser-discovery.ts'
import { INIT_SCRIPT } from './init-script.ts'
import { generateMarkdown } from './report.ts'
import { accumulateEvent, createSessionStats } from './stats.ts'
import type {
  RecordedEvent,
  RecorderOptions,
  SessionStats,
  StopResult,
  UiPayload,
  UnstampedEvent
} from './types.ts'

export class RecorderSession {
  readonly startedAt = Date.now()
  readonly sessionDir: string
  readonly eventsPath: string
  private readonly opts: RecorderOptions
  private seq = 0
  private requestSeq = 0
  private events: RecordedEvent[] = []
  /** 分类计数随 push 增量维护, status()/报告不必再全量遍历事件 */
  private counts = createSessionStats()
  private jsonl: WriteStream
  /** 事件流收口(幂等): 启动失败与正常收尾都可能触发, 只 end 一次 */
  private jsonlClosed?: Promise<void>
  private browser?: Browser
  private context?: BrowserContext
  /** CDP attach 模式下为 true, 此时不主动关闭浏览器进程 */
  private attached = false
  private cdpSession?: CDPSession
  /** attach 模式下连上的外部浏览器 CDP 地址(回显给模型, 供驱动方复用) */
  private attachedCdpUrl?: string
  /** 自启窗口自身暴露的 CDP 地址(--remote-debugging-port=0, 端口由 Chrome 自选) */
  private launchedCdpUrl?: string
  /** 自启窗口使用的浏览器 profile 目录(持久化: 保留登录态) */
  private profileDir?: string
  /** 持久 profile 不可用而退回临时 profile 时的原因(回显用) */
  private profileFallbackReason?: string
  // 页面/请求用 WeakMap: 不持有强引用, 页面关闭或请求结束后条目可被回收, 长时间录制不堆积
  private pageIds = new WeakMap<Page, number>()
  private nextPageId = 1
  private openPages = 0
  private noPageTimer?: ReturnType<typeof setTimeout>
  private requestIds = new WeakMap<Request, number>()
  private pendingBodies = new Set<Promise<void>>()
  /**
   * 等待期结束的时间戳(绝对 ms), 0 表示立即开始记录。
   * 自 startedAt 起算(浏览器启动与起始页导航都在这段时间内, 正是要跳过的部分)。
   */
  private readonly waitUntil: number
  /** 生效的等待秒数(入参非法时归 0) */
  private readonly waitSeconds: number
  /** 等待期内被丢弃的事件数(只做统计: 这些事件既不落盘也不进内存事件数组) */
  private skipped = 0
  private stoppingReason?: string
  private stopResult?: StopResult
  /** 收尾的进行中 promise: stop / 关窗口 / 插件卸载可能并发触发, 只执行一次 */
  private finalizePromise?: Promise<StopResult>
  /** finished 的 resolve 侧(见 finished()): 构造时建好, 收尾时只调用一次 */
  private finishedResolve!: (result: StopResult) => void
  /**
   * 收尾完成信号: resolve 后携带最终 StopResult, 永不 reject。
   * 供宿主后台任务(ctx.jobs)结算用 —— 会话不收尾就保持 pending, 正是「录制仍在运行」的语义。
   */
  private readonly finishedPromise: Promise<StopResult>

  private constructor(opts: RecorderOptions, sessionDir: string) {
    this.opts = opts
    this.sessionDir = sessionDir
    this.eventsPath = join(sessionDir, 'events.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    this.jsonl = createWriteStream(this.eventsPath, { flags: 'w' })
    this.finishedPromise = new Promise<StopResult>(resolve => {
      this.finishedResolve = resolve
    })
    // 等待期: waitSeconds 非法(非数字/负数)时按 0 处理, 避免 NaN 比较导致行为不确定
    const seconds = Number(opts.waitSeconds)
    this.waitSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
    this.waitUntil = this.waitSeconds > 0 ? this.startedAt + this.waitSeconds * 1000 : 0
  }

  /** 是否还在等待期内(等待期内的事件不记录)。 */
  private waiting(): boolean {
    return this.waitUntil > 0 && Date.now() < this.waitUntil
  }

  /**
   * 启动浏览器并完成全部监听挂载; 失败时关闭已起的浏览器与事件流, 不残留进程/句柄。
   * attach 优先级: 显式配置的 cdpUrl → 自动发现本机任何**开启了远程调试端口**的 Chromium
   * (Playwright MCP 浏览器优先, 读取其 user-data-dir 下的 DevToolsActivePort);
   * 两者都不可用时回退到接管模式: 读取 MCP 浏览器当前页面 URL, 关闭旧浏览器,
   * 用 recorder 新开窗口并导航到相同 URL —— 新开窗口自身也会暴露 CDP 端口(见 launchBrowser),
   * 因此驱动方仍可 connectOverCDP 连上来接管这个窗口。
   */
  static async start(
    startUrl: string | undefined,
    opts: RecorderOptions
  ): Promise<RecorderSession> {
    const now = new Date()
    const pad2 = (n: number): string => String(n).padStart(2, '0')
    // 目录名 rec_DD_HH-mm-ss: 本地"日" + 时分秒(日与时间之间用下划线分隔), 不含年月保持简短
    const dirName = `rec_${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
    const session = new RecorderSession(opts, join(opts.outputDir, dirName))
    // 进程扫描的开销(spawn PowerShell CIM 查询)在一次启动内只付一次: attach 与接管共用探针
    const probe = createBrowserProbe()
    try {
      // 1. 显式配置的 CDP 地址优先
      let attached = await session.tryAttach(opts.cdpUrl?.trim())
      let playwrightMcpUrl: string | undefined
      if (!attached) {
        // 2. 自动发现本机开了调试端口的 Chromium(MCP 浏览器优先), attach 到用户正在使用的窗口
        const discoveredCdpUrl = probe.discoverCdpUrl()
        if (discoveredCdpUrl) attached = await session.tryAttach(discoveredCdpUrl)
      }
      if (!attached) {
        // 3. 回退接管: 检测 Playwright MCP 浏览器, 关掉(并等其退出)后用 recorder 新开窗口
        playwrightMcpUrl = probe.lastVisitedUrl()
        if (playwrightMcpUrl) await probe.closeAndWait()
        // 新开浏览器窗口(优先使用接管的 URL)
        await session.launchBrowser(opts)
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
      // 浏览器进程退出时自动收尾, 已录数据不丢; stop() 主动关窗时也会触发(此时用 stop 的真实原因);
      // attach 模式下则表示外部浏览器(MCP 浏览器)被关掉, 同样需要收尾。finalize 幂等。
      // 自启窗口走 launchPersistentContext, browser 句柄在部分 Playwright 版本下可能拿不到,
      // 因此 disconnected 与 context close 两条路径都挂上(重复触发由 finalize 去重)。
      const handleGone = (): void => {
        if (session.noPageTimer) clearTimeout(session.noPageTimer)
        session.noPageTimer = undefined
        void session.finalize(session.stoppingReason ?? 'browser-closed')
      }
      session.browser?.on('disconnected', handleGone)
      session.context!.on('close', handleGone)
      for (const page of session.context!.pages()) session.attachPage(page)
      // attach 模式只在调用方显式传入 URL 时才导航当前页, 否则保持用户正在看的页面不动
      const finalUrl = startUrl?.trim() || playwrightMcpUrl
      if (finalUrl?.trim()) {
        const page = session.context!.pages()[0] ?? (await session.context!.newPage())
        await page.goto(finalUrl.trim(), { waitUntil: 'domcontentloaded' })
      }
      return session
    } catch (cause) {
      // 启动中途失败: 已起的浏览器要关掉(attach 模式只是断开连接), 事件流也要收口
      if (session.context) await session.context.close().catch(() => undefined)
      else if (session.browser) await session.browser.close().catch(() => undefined)
      await session.closeJsonl()
      throw cause
    }
  }

  /**
   * 自启一个有头浏览器窗口。这里有两个「零配置」的关键点:
   *
   * 1. **固定带 `--remote-debugging-port=0`**: 让窗口自己暴露 CDP 端口(实际端口由 Chrome 写入
   *    `<profileDir>/DevToolsActivePort`)。于是任何驱动方(playwright MCP 的 `--cdp-endpoint`、
   *    browser-use、用户自己的 playwright 脚本)都能直接 connectOverCDP 连到这个窗口里继续操作——
   *    用户不必再去给 MCP 手写 `playwright-mcp.config.json`, 插件窗口本身就是一个可被接管的窗口。
   * 2. **持久化 profile**(默认 `~/.dsh-web-recorder/browser-profile`): 登录态 / cookie 跨次录制保留,
   *    目标站只需登录一次, 下次起录直接是已登录状态, 顺带省掉「登录跳转」那一批噪音请求。
   *
   * profile 被残留进程占用等导致启动失败时, 退回一次性临时 profile 重试(仍带调试端口),
   * 「能用」优先于「记住登录态」。
   */
  private async launchBrowser(opts: RecorderOptions): Promise<void> {
    const launchOptions = {
      headless: false,
      viewport: null,
      args: ['--remote-debugging-port=0'],
      ...(opts.executablePath.trim()
        ? { executablePath: opts.executablePath.trim() }
        : { channel: opts.channel })
    }
    const profileDir = resolveProfileDir(opts.userDataDir)
    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOptions)
      this.profileDir = profileDir
    } catch (cause) {
      // 持久 profile 不可用(被占用 / 无写权限 / 目录损坏): 退回临时 profile, 不阻断录制
      this.profileFallbackReason = cause instanceof Error ? cause.message : String(cause)
      const fallbackDir = mkdtempSync(join(tmpdir(), 'dsh-web-recorder-'))
      this.context = await chromium.launchPersistentContext(fallbackDir, launchOptions)
      this.profileDir = fallbackDir
    }
    this.browser = this.context.browser() ?? undefined
    // 端口为 0 时 Chrome 把实际端口写进 <profileDir>/DevToolsActivePort(第一行), 等它落盘
    const port = await waitDevToolsPort(this.profileDir)
    if (port) this.launchedCdpUrl = `http://127.0.0.1:${port}`
  }

  /** 尝试通过 CDP attach 到已运行的浏览器(如 Playwright 打开的页面)。成功返回 true。 */
  private async tryAttach(cdpUrl?: string): Promise<boolean> {
    if (!cdpUrl) return false
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl)
      this.attached = true
      this.attachedCdpUrl = cdpUrl
      // connectOverCDP 返回的 browser 可能已有 context, 优先取已有页面的(用户正在用的窗口), 否则取第一个或新建
      const contexts = this.browser.contexts()
      this.context = contexts.find(c => c.pages().length > 0) ?? contexts[0]
      if (!this.context) {
        this.context = await this.browser.newContext({ viewport: null })
      }
      // CDP attach 模式下, 通过 CDP session 监听浏览器关闭
      this.cdpSession = await this.context.newCDPSession(
        this.context.pages()[0] ?? (await this.context.newPage())
      )
      this.cdpSession.on('Inspector.targetCrashed', () => {
        void this.finalize(this.stoppingReason ?? 'browser-crashed')
      })
      return true
    } catch {
      // attach 失败(也可能是连上后建 CDP session 失败): 断开已建立的连接再清理,
      // 返回 false 让调用方回退到 launch
      if (this.browser) await this.browser.close().catch(() => undefined)
      this.browser = undefined
      this.context = undefined
      this.cdpSession = undefined
      this.attached = false
      this.attachedCdpUrl = undefined
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

  /**
   * 本次录制所用浏览器窗口的 CDP 地址, 供驱动方 connectOverCDP 复用。
   * attach 模式返回被接管窗口的地址; 自启窗口返回窗口自身暴露的地址(端口由 Chrome 自选)。
   */
  cdpUrl(): string | undefined {
    return this.attachedCdpUrl ?? this.launchedCdpUrl
  }

  /** 自启窗口使用的浏览器 profile 目录(持久化, 保留登录态); attach 模式为 undefined。 */
  profileDirectory(): string | undefined {
    return this.profileDir
  }

  /** 持久 profile 不可用而退回临时 profile 时的原因(正常为 undefined)。 */
  profileFallback(): string | undefined {
    return this.profileFallbackReason
  }

  isFinished(): boolean {
    return !!this.stopResult
  }

  /** 已收尾会话的最终结果(用户直接关浏览器自动收尾时也存在)。 */
  result(): StopResult | undefined {
    return this.stopResult
  }

  /**
   * 等到本次录制真正收尾(报告已落盘)为止; 已收尾则立即返回既有结果。
   * 宿主后台任务用它把「录制结束」这一刻结算成 job 完成, 从而通知模型。
   * 会话永不收尾时不 resolve —— 调用方应同时提供 cancel 通道(见 index.ts 的 job 注册)。
   */
  finished(): Promise<StopResult> {
    return this.finishedPromise
  }

  status(): {
    recording: boolean
    startedAt: number
    sessionDir: string
    cdpUrl?: string
    profileDir?: string
    counts: SessionStats
    eventCount: number
    waitSeconds: number
    waitRemainingSec: number
    skippedEvents: number
  } {
    const cdpUrl = this.cdpUrl()
    const profileDir = this.profileDirectory()
    return {
      recording: !this.stopResult,
      startedAt: this.startedAt,
      sessionDir: this.sessionDir,
      ...(cdpUrl ? { cdpUrl } : {}),
      ...(profileDir ? { profileDir } : {}),
      counts: this.stats(),
      eventCount: this.events.length,
      waitSeconds: this.waitSeconds,
      // 等待期剩余秒数(保留 1 位): 让调用方知道「还要等多久才开始记录」
      waitRemainingSec: this.waitUntil
        ? Math.max(0, Math.round((this.waitUntil - Date.now()) / 100) / 10)
        : 0,
      skippedEvents: this.skipped
    }
  }

  /**
   * 断开与外部浏览器的 CDP 连接, 但**不关闭它**。
   *
   * 为什么不用 browser.close(): 实测(playwright-core 1.63 + Edge)在 connectOverCDP 场景下,
   * browser.close() 会把外部浏览器进程真的关掉(调试端口随即 404)。而「接管用户正在用的窗口,
   * 录完就把它关掉」是致命的——MCP 会话随之中断、用户手上那个窗口也没了, 正是接入体验最糟的一环。
   * 因此优先关闭底层连接(只断 WebSocket, 浏览器继续存活), 拿不到内部句柄时才回退到公开 API。
   */
  private async disconnectBrowser(): Promise<void> {
    const browser = this.browser
    // 先摘掉引用: 避免后续 scheduleNoPageCheck 之类路径再对它调 close()
    this.browser = undefined
    if (!browser) return
    const connection = (browser as unknown as { _connection?: { close(): void } })._connection
    if (typeof connection?.close === 'function') {
      try {
        connection.close()
        return
      } catch {
        // 内部结构变化时回退到公开 API(最坏情况是外部浏览器被关闭)
      }
    }
    await browser.close().catch(() => undefined)
  }

  /** 停止录制: 等未完成的响应体抓取(宽限 2s), 生成报告, 关闭浏览器; 幂等(用户已关浏览器时返回既有结果)。 */
  async stop(reason: string): Promise<StopResult> {
    if (this.stopResult) return this.stopResult
    this.stoppingReason = reason
    // 宽限计时器 unref: 响应体都回来时不让它拖住进程退出
    await Promise.race([
      Promise.allSettled([...this.pendingBodies]),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000)
        timer.unref?.()
      })
    ])
    try {
      if (this.attached) {
        // CDP attach 模式: 只断开录制连接, 绝不关闭外部浏览器(MCP 浏览器等仍归用户 / MCP 使用)
        if (this.cdpSession) await this.cdpSession.detach().catch(() => undefined)
        await this.disconnectBrowser()
      } else {
        if (this.context) await this.context.close().catch(() => undefined)
        if (this.browser) await this.browser.close().catch(() => undefined)
      }
    } catch {
      // 关闭失败不阻断收尾: 报告与 stopResult 仍要产出
    }
    return this.finalize(reason)
  }

  private attachPage(page: Page): void {
    if (this.pageIds.has(page)) return
    this.pageIds.set(page, this.nextPageId++)
    this.openPages++
    // 新打开的 tab/popup 也要确保装上 UI 事件采集脚本。
    // addInitScript 理论上会自动注入，但 CDP attach 模式或某些 race 情况下可能漏注，
    // 这里显式补装作为双重保险；安装失败静默忽略，不影响网络事件监听。
    void page.evaluate(INIT_SCRIPT).catch(() => undefined)
    // 任何窗口/标签被关都立刻感知: 计数归零后延迟确认(允许操作途中短暂无页面),
    // 仍无页面则视为用户关闭浏览器, 自动收尾生成报告(兜底 disconnected 未触发的情况)。
    page.on('close', () => {
      this.pageIds.delete(page)
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
      // 等待期内的请求在此直接 return: 不登记 requestId, 其响应/失败事件随之被忽略,
      // 不会出现「请求被丢、响应被留」的半个三元组(登录/初始化接口正是要整组丢掉的)
      if (this.waiting()) {
        this.skipped++
        return
      }
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
      // 失败即终态: 该请求不会再有响应事件, 可以释放映射(WeakMap 之外再主动清)
      this.requestIds.delete(request)
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
    const ts = Date.now()
    // 等待期: 登录/页面初始化那批事件直接丢弃, 不落盘也不计数(只累计 skipped 供回显)
    if (ts < this.waitUntil) {
      this.skipped++
      return
    }
    const full = { ...event, seq: ++this.seq, ts } as RecordedEvent
    this.events.push(full)
    accumulateEvent(this.counts, full.type)
    this.jsonl.write(JSON.stringify(full) + '\n')
  }

  /** 当前分类计数(增量维护的结果, 只做一次浅拷贝, 不再遍历事件)。 */
  private stats(): SessionStats {
    return { ...this.counts }
  }

  /** 事件流收口(幂等): 启动失败与正常收尾两条路径都会走到, 只 end 一次。 */
  private closeJsonl(): Promise<void> {
    this.jsonlClosed ??= new Promise<void>(resolve => this.jsonl.end(resolve))
    return this.jsonlClosed
  }

  /**
   * 收尾入口: stop / 用户关窗口 / 插件卸载三条路径可能并发触发,
   * 用 finalizePromise 保证真正的收尾动作只跑一次, 后续调用复用同一结果。
   */
  private finalize(reason: string): Promise<StopResult> {
    this.finalizePromise ??= this.doFinalize(reason)
    return this.finalizePromise
  }

  private async doFinalize(reason: string): Promise<StopResult> {
    if (this.stopResult) return this.stopResult
    // 收尾后不再需要延迟检查, 清掉定时器免得它拖住进程退出
    if (this.noPageTimer) {
      clearTimeout(this.noPageTimer)
      this.noPageTimer = undefined
    }
    const endedAt = Date.now()
    const reportPath = join(this.sessionDir, 'report.md')
    // 报告生成/写盘失败都不阻断收尾: stopResult 必须被设置, 否则收尾会静默丢失
    let report: string
    try {
      report = generateMarkdown(this.events, {
        startedAt: this.startedAt,
        endedAt,
        reason,
        sessionDir: this.sessionDir,
        waitSeconds: this.waitSeconds,
        skippedEvents: this.skipped
      })
    } catch {
      report = `# 报告生成失败\n\n- 结束原因: ${reason}\n- 已记录事件: ${this.events.length} 个\n- 明细见 events.jsonl\n`
    }
    try {
      await writeFile(reportPath, report, 'utf8')
    } catch {
      // 报告写盘失败不阻断收尾
    }
    await this.closeJsonl()
    const cdpUrl = this.cdpUrl()
    const profileDir = this.profileDirectory()
    this.stopResult = {
      reason,
      startedAt: this.startedAt,
      endedAt,
      eventCount: this.events.length,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      reportPath,
      stats: this.stats(),
      waitSeconds: this.waitSeconds,
      skippedEvents: this.skipped,
      ...(cdpUrl ? { cdpUrl } : {}),
      ...(profileDir ? { profileDir } : {})
    }
    // 收尾即「录制结束」事件: 唤醒等待方(宿主后台任务的结算链)
    this.finishedResolve(this.stopResult)
    return this.stopResult
  }
}

/** 默认浏览器 profile 目录: ~/.dsh-web-recorder/browser-profile(跨项目复用, 保留登录态)。 */
function resolveProfileDir(configured?: string): string {
  const trimmed = configured?.trim()
  if (trimmed) return trimmed
  return join(homedir(), '.dsh-web-recorder', 'browser-profile')
}

/** 读 `<profileDir>/DevToolsActivePort` 第一行得到 Chrome 自选的实际 CDP 端口。 */
function readDevToolsPort(profileDir: string): number | undefined {
  try {
    const portFile = join(profileDir, 'DevToolsActivePort')
    if (!existsSync(portFile)) return undefined
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim())
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/** 轮询等 DevToolsActivePort 落盘(启动已完成时通常已就绪, 给一点余量避免偶发取不到端口)。 */
async function waitDevToolsPort(
  profileDir: string | undefined,
  timeoutMs = 2000
): Promise<number | undefined> {
  if (!profileDir) return undefined
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const port = readDevToolsPort(profileDir)
    if (port) return port
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
