/**
 * 录制事件类型与工具输出信封。
 * 事件同时缓存在内存(供停止时生成报告)并逐行写入 events.jsonl(防崩溃丢失)。
 */

// 与 dsh-tools 的 JsonValue 同构(避免仅为类型引入依赖包)
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// 页面内 UI 事件(init script 经 exposeBinding 回传的载荷)
export interface UiPayload {
  kind: 'click' | 'change' | 'submit'
  selector: string
  tag: string
  text?: string
  name?: string
  value?: string
  redacted?: boolean
  x?: number
  y?: number
}

export type RecordedEvent = { seq: number; ts: number; pageId?: number } & (
  | { type: 'navigate'; url: string }
  | {
      type: 'click'
      url: string
      selector: string
      tag: string
      text?: string
      x?: number
      y?: number
    }
  | {
      type: 'change'
      url: string
      selector: string
      tag: string
      name?: string
      value?: string
      redacted?: boolean
    }
  | { type: 'submit'; url: string; selector: string }
  | {
      type: 'request'
      requestId: number
      method: string
      url: string
      resourceType: string
      headers: Record<string, string>
      postData?: string
    }
  | {
      type: 'response'
      requestId: number
      status: number
      url: string
      body?: string
      bodyTruncated?: boolean
    }
  | { type: 'requestfailed'; requestId: number; url: string; errorText: string }
  | { type: 'console'; level: string; text: string }
)

export interface RecorderOptions {
  /** playwright-core 的浏览器渠道(msedge/chrome), executablePath 非空时优先 */
  channel: string
  /** 自定义浏览器可执行文件路径, 覆盖 channel */
  executablePath: string
  /** CDP 调试地址(如 http://127.0.0.1:9222), 非空时优先 attach 到已有浏览器 */
  cdpUrl: string
  /** 录制产物输出目录(每次录制在其下建时间戳子目录) */
  outputDir: string
  /** 是否抓取 xhr/fetch 响应体(截断到 maxBodyBytes) */
  captureResponseBodies: boolean
  /** 请求体/响应体单次最大记录字节数 */
  maxBodyBytes: number
  /** 是否记录 console 消息 */
  recordConsole: boolean
  /** 只记录这些 resourceType 的网络请求(默认 xhr/fetch, 即接口调用; 静态资源/文档不录) */
  requestResourceTypes: string[]
  /** 需要从请求头中抹除的头名(小写) */
  redactHeaders: string[]
  /**
   * 等待秒数: recorder_start 之后先等 N 秒再开始记录(这 N 秒内的事件一律丢弃, 不落盘也不计数),
   * 用来跳过登录页 / 首页加载那批与业务流程无关的初始化请求。0 或负数表示立即开始记录。
   * 计时自 recorder_start 调用时刻起算(浏览器启动与起始页导航都落在这段等待时间内)。
   */
  waitSeconds: number
}

// 用 type 别名而非 interface: 对象字面量类型带隐式索引签名, 可赋给输出 schema 推断的 Record<string, JsonValue>
export type SessionStats = {
  navigations: number
  clicks: number
  changes: number
  submits: number
  requests: number
  responses: number
  failed: number
  console: number
}

// Omit 默认不对联合类型分配, 需要分配式 Omit 才能表达「未盖时间戳的事件」
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type UnstampedEvent = DistributiveOmit<RecordedEvent, 'seq' | 'ts'>

export interface StopResult {
  reason: string
  startedAt: number
  endedAt: number
  eventCount: number
  sessionDir: string
  eventsPath: string
  reportPath: string
  stats: SessionStats
  /** 本次录制的等待秒数(0 表示立即开始记录) */
  waitSeconds: number
  /** 等待期内被丢弃的事件数 */
  skippedEvents: number
}

// 用 type 别名而非 interface: 对象字面量类型带隐式索引签名, 可赋给输出 schema 推断的 Record<string, JsonValue>
export type ToolError = {
  type: 'state' | 'browser' | 'internal'
  message: string
  hint?: string
}

export function toolError(err: ToolError): { ok: false; error: ToolError } {
  return { ok: false, error: err }
}
