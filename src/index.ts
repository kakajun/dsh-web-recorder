/**
 * dsh-web-recorder 插件: 网页操作录制器。
 *
 * 面向「用户手动操作浏览器, 插件在后台录制」的场景:
 *   recorder_start(url?) —— 优先 CDP attach 到正在运行的浏览器窗口(显式 cdpUrl 或自动发现
 *     带 CDP 端口的 Playwright MCP 浏览器), 否则启动有头浏览器(默认本机 Edge), 用户在其中手动操作;
 *     插件监听每次点击/输入/表单提交(init script + exposeBinding)和每个网络请求/响应/失败,
 *     事件实时落盘 events.jsonl(防崩溃丢失)
 *   recorder_stop()      —— 停止录制, 生成 report.md 摘要报告, 关闭浏览器;
 *     用户直接关掉浏览器窗口也会自动收尾
 *   recorder_status()    —— 查询录制状态与事件计数
 *
 * 安全默认: 请求头中的 cookie/authorization 等敏感头默认脱敏为 <redacted>;
 * 密码输入框的值不落盘(只记录输入动作本身); 请求/响应体截断到 maxBodyBytes。
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { RecorderSession } from './session.ts'
import type { JsonValue, SessionStats, StopResult, ToolError } from './types.ts'
import { toolError } from './types.ts'

export const name = 'dsh-web-recorder'
export const inject = ['tools']

// 额外导出供包级 tests/ 冒烟测试与高级调用方使用(函数插件只禁止默认导出)
export { RecorderSession } from './session.ts'

// Config 默认值与 apply 内兜底共用单一来源(schemastery 校验后会填充默认值)
const RECORDER_DEFAULTS = {
  channel: 'msedge',
  executablePath: '',
  cdpUrl: '',
  outputDir: '',
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: false,
  requestResourceTypes: 'xhr,fetch',
  redactHeaders: 'cookie,authorization,proxy-authorization,x-api-key,set-cookie',
  waitSeconds: 0
} as const

export const Config = z.object({
  // 浏览器渠道(playwright-core channel), 随部署机器变化, 可在 cordis.yml 覆盖
  channel: z.string().default(RECORDER_DEFAULTS.channel),
  // 自定义浏览器可执行文件路径, 非空时覆盖 channel
  executablePath: z.string().default(RECORDER_DEFAULTS.executablePath),
  // CDP 调试地址(如 http://127.0.0.1:9222), 非空时优先 attach 到已有浏览器;
  // 留空也会自动发现带 CDP 端口的 Playwright MCP 浏览器并 attach
  cdpUrl: z.string().default(RECORDER_DEFAULTS.cdpUrl),
  // 录制产物输出根目录; 为空时默认当前工作目录(用户正在操作的文件夹)下 reports/recorder
  outputDir: z.string().default(RECORDER_DEFAULTS.outputDir),
  captureResponseBodies: z.boolean().default(RECORDER_DEFAULTS.captureResponseBodies),
  maxBodyBytes: z.number().default(RECORDER_DEFAULTS.maxBodyBytes),
  recordConsole: z.boolean().default(RECORDER_DEFAULTS.recordConsole),
  // 只记录这些 resourceType 的网络请求(逗号分隔); 默认 xhr,fetch 即只录接口调用, 静态资源/文档不录
  requestResourceTypes: z.string().default(RECORDER_DEFAULTS.requestResourceTypes),
  // 需要脱敏的请求头名(逗号分隔, 大小写不敏感)
  redactHeaders: z.string().default(RECORDER_DEFAULTS.redactHeaders)
})

/** apply 的配置入参类型(schemastery 无 z.infer, 与 Config 字段保持一致)。 */
interface RecorderConfig {
  channel?: string
  executablePath?: string
  cdpUrl?: string
  outputDir?: string
  captureResponseBodies?: boolean
  maxBodyBytes?: number
  recordConsole?: boolean
  requestResourceTypes?: string
  redactHeaders?: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
// dsh 经 profile node_modules 的 junction 链接加载本包时, import.meta.url 保留链接字符串路径,
// 先 realpath 还原仓库真实布局再上溯(与 @huafeng/project-tools 同款处理)
const __realDir = (() => {
  try {
    return realpathSync(__dirname)
  } catch {
    return __dirname
  }
})()
/**
 * 默认产物根目录: 优先「用户正在操作的目录」——harness 会话(会话 cwd 即 SessionHeader.cwd,
 * 会落到工具执行环境)与本仓库 CLI 都以用户目录为进程 cwd, 在其下建 reports/recorder;
 * 该目录不可写时退回插件仓库根 reports/recorder(lib/ 在仓库根下一级, 上溯一级)。
 */
function resolveDefaultOutputDir(): string {
  const cwdCandidate = join(process.cwd(), 'reports', 'recorder')
  try {
    mkdirSync(cwdCandidate, { recursive: true })
    return cwdCandidate
  } catch {
    return join(__realDir, '../reports/recorder')
  }
}

type StartSuccess = {
  ok: true
  sessionDir: string
  startedAt: number
  attached: boolean
  initialUrl?: string
  waitSeconds?: number
  hint: string
}

type StartResult = StartSuccess | { ok: false; error: ToolError }

type StopSuccess = {
  ok: true
  reason: string
  durationSec: number
  eventCount: number
  eventsPath: string
  reportPath: string
  stats: SessionStats
  waitSeconds: number
  skippedEvents: number
}

type StopResultOut = StopSuccess | { ok: false; error: ToolError }

type StatusSuccess = {
  ok: boolean
  recording: boolean
  startedAt?: number
  sessionDir?: string
  eventCount?: number
  counts?: SessionStats
  waitSeconds?: number
  waitRemainingSec?: number
  skippedEvents?: number
  lastResult?: JsonValue
}

export function apply(ctx: Context, config?: RecorderConfig): void {
  const outputDir = config?.outputDir?.trim() || resolveDefaultOutputDir()
  const opts = {
    channel: config?.channel ?? RECORDER_DEFAULTS.channel,
    executablePath: config?.executablePath ?? RECORDER_DEFAULTS.executablePath,
    cdpUrl: config?.cdpUrl ?? RECORDER_DEFAULTS.cdpUrl,
    outputDir,
    captureResponseBodies: config?.captureResponseBodies ?? RECORDER_DEFAULTS.captureResponseBodies,
    maxBodyBytes: config?.maxBodyBytes ?? RECORDER_DEFAULTS.maxBodyBytes,
    recordConsole: config?.recordConsole ?? RECORDER_DEFAULTS.recordConsole,
    requestResourceTypes: (config?.requestResourceTypes ?? RECORDER_DEFAULTS.requestResourceTypes)
      .split(',')
      .map(t => t.trim())
      .filter(Boolean),
    redactHeaders: (config?.redactHeaders ?? RECORDER_DEFAULTS.redactHeaders)
      .split(',')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean),
    // 等待期默认 0; 每次 recorder_start 可用入参 waitSeconds 覆盖(见下方工具定义)
    waitSeconds: RECORDER_DEFAULTS.waitSeconds
  }

  let session: RecorderSession | null = null
  let lastResult: StopResult | null = null

  // 活跃会话已收尾(用户关浏览器自动 finalize)时把结果转移到 lastResult 并清掉
  const clearFinished = (): void => {
    if (session?.isFinished()) {
      lastResult = session.result() ?? lastResult
      session = null
    }
  }

  const takeActive = (): RecorderSession | { ok: false; error: ToolError } => {
    clearFinished()
    if (!session) {
      return toolError({
        type: 'state',
        message: '当前没有进行中的录制',
        hint: '先用 recorder_start 开始录制'
      })
    }
    return session
  }

  ctx.tools.register(
    defineTool({
      name: 'recorder_start',
      description:
        '开始网页操作录制: 若检测到正在运行的 Playwright MCP 浏览器(带 CDP 端口)或配置了 cdpUrl, ' +
        '则 attach 到该已有窗口继续录制; 否则启动一个新的有头浏览器窗口(默认本机 Edge), 用户在其中手动操作网页;' +
        '插件在后台记录每次点击/输入/表单提交和每个网络请求/响应/失败, 实时落盘 events.jsonl。' +
        '入参 waitSeconds 可让录制先等待若干秒再开始记录(等价剔除开头这段时间), 用于跳过登录页 / ' +
        '页面初始化那批与业务流程无关的请求。' +
        '用 recorder_stop 结束并生成 report.md 报告; 用户直接关掉浏览器窗口也会自动收尾。',
      parameters: {
        url: { type: 'string', description: '起始 URL, 留空则打开空白页' },
        waitSeconds: {
          type: 'number',
          description:
            '等待多少秒再开始记录(默认 0 立即开始)。等待期内发生的点击/输入/请求一律不记录, ' +
            '等价于把开头这段时间从录制结果里剔除; 需要登录或等页面初始化完成时使用, 例如 10 表示等 10 秒。'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: '是否成功开始' },
            sessionDir: { type: 'string', description: '本次录制产物目录' },
            startedAt: { type: 'number', description: '开始时间戳(ms)' },
            attached: { type: 'boolean', description: '是否 attach 到已有浏览器窗口(而非新开窗口)' },
            initialUrl: { type: 'string', description: '起始 URL' },
            waitSeconds: {
              type: 'number',
              description: '等待多少秒后开始记录(0 表示立即开始); 等待期内的事件不记录'
            },
            hint: { type: 'string', description: '给模型的下一步指引' },
            error: {
              type: 'object',
              additionalProperties: true,
              description: '错误信封 {type, message, hint}(ok 为 false 时存在)'
            }
          }
        },
        render: (_args, value: StartResult) => {
          if (!value.ok) {
            const e = value.error
            return [
              {
                type: 'text',
                text: `开始录制失败 [${e.type}] ${e.message}${e.hint ? `\n下一步: ${e.hint}` : ''}`
              }
            ]
          }
          return [
            {
              type: 'text',
              text:
                `录制已开始${value.attached ? `(已 attach 到正在运行的浏览器窗口${opts.cdpUrl ? `: ${opts.cdpUrl}` : ''})` : ', 新的浏览器窗口已打开'}${value.initialUrl ? `并导航到 ${value.initialUrl}` : ''}。\n` +
                `产物目录: ${value.sessionDir}\n` +
                (value.waitSeconds && value.waitSeconds > 0
                  ? `前 ${value.waitSeconds}s 为等待期(期间的操作与请求不记录), 请在这段时间内完成登录 / 等页面加载完成。\n`
                  : '') +
                `请用户在浏览器中手动操作; 完成后调用 recorder_stop 生成报告。`
            }
          ]
        }
      },
      async execute(args, exec): Promise<StartResult> {
        clearFinished()
        if (session) {
          return toolError({
            type: 'state',
            message: '已有进行中的录制',
            hint: '先调用 recorder_stop 结束当前录制, 或用 recorder_status 查看状态'
          })
        }
        const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined
        // waitSeconds: 等待 N 秒再开始记录(等价剔除开头这段时间); 非法值(非数字/负数)按 0 处理
        const rawWait = Number(args.waitSeconds)
        const waitSeconds = Number.isFinite(rawWait) && rawWait > 0 ? rawWait : 0
        // 尊重 exec.signal: 调用已被取消时不再启动浏览器
        if (exec.signal.aborted) {
          return toolError({
            type: 'internal',
            message: '录制启动已取消',
            hint: '如仍需录制请重新调用 recorder_start'
          })
        }
        let started: RecorderSession
        try {
          started = await RecorderSession.start(url, { ...opts, waitSeconds })
        } catch (cause) {
          return toolError({
            type: 'browser',
            message: `浏览器启动失败: ${cause instanceof Error ? cause.message : String(cause)}`,
            hint: `请确认本机安装了 ${opts.channel === 'msedge' ? 'Edge' : opts.channel} 浏览器, 或在插件 Config 中设置 executablePath/channel/cdpUrl`
          })
        }
        // 启动期间调用被取消: 不收留会话, 立即收尾释放浏览器
        if (exec.signal.aborted) {
          void started.stop('aborted')
          return toolError({
            type: 'internal',
            message: '录制启动已取消',
            hint: '如仍需录制请重新调用 recorder_start'
          })
        }
        session = started
        return {
          ok: true,
          sessionDir: session.sessionDir,
          startedAt: session.startedAt,
          attached: session.isAttached(),
          ...(url ? { initialUrl: url } : {}),
          ...(waitSeconds > 0 ? { waitSeconds } : {}),
          hint:
            waitSeconds > 0
              ? `等待 ${waitSeconds}s 后开始记录, 请在这段时间内完成登录 / 等页面加载完成; 之后用户操作会被记录, 完成后调用 recorder_stop 生成报告`
              : '用户操作完成后调用 recorder_stop 停止并生成报告'
        }
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'recorder_stop',
      description:
        '停止当前的网页操作录制: 生成 report.md 摘要报告(操作时间线 + 网络请求明细 + 失败请求), 关闭浏览器。' +
        '完整事件数据(含请求头/请求体/响应体)在同目录 events.jsonl。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, description: '是否成功停止' },
            reason: { type: 'string', description: '结束原因' },
            durationSec: { type: 'number', description: '录制时长(秒)' },
            eventCount: { type: 'number', description: '事件总数' },
            eventsPath: { type: 'string', description: 'events.jsonl 路径' },
            reportPath: { type: 'string', description: 'report.md 路径' },
            stats: { type: 'object', additionalProperties: true, description: '分类计数' },
            waitSeconds: { type: 'number', description: '本次录制的等待秒数(0 表示立即开始记录)' },
            skippedEvents: { type: 'number', description: '等待期内被丢弃的事件数' },
            error: {
              type: 'object',
              additionalProperties: true,
              description: '错误信封(ok 为 false 时存在)'
            }
          }
        },
        render: (_args, value: StopResultOut) => {
          if (!value.ok) {
            const e = value.error
            return [
              {
                type: 'text',
                text: `停止录制失败 [${e.type}] ${e.message}${e.hint ? `\n下一步: ${e.hint}` : ''}`
              }
            ]
          }
          return [
            {
              type: 'text',
              text:
                `录制已停止(${value.durationSec.toFixed(1)}s, ${value.eventCount} 个事件)。\n` +
                `报告: ${value.reportPath}\n` +
                `明细: ${value.eventsPath}\n` +
                `点击 ${value.stats.clicks} 次, 输入 ${value.stats.changes} 次, 请求 ${value.stats.requests} 个(失败 ${value.stats.failed})。` +
                (value.waitSeconds > 0
                  ? `\n等待期 ${value.waitSeconds}s 内的 ${value.skippedEvents} 个事件已按设置丢弃(未记录)。`
                  : '')
            }
          ]
        }
      },
      async execute(): Promise<StopResultOut> {
        const active = takeActive()
        if (!(active instanceof RecorderSession)) return active
        const result = await active.stop('user-stop')
        lastResult = result
        session = null
        return {
          ok: true,
          reason: result.reason,
          durationSec: (result.endedAt - result.startedAt) / 1000,
          eventCount: result.eventCount,
          eventsPath: result.eventsPath,
          reportPath: result.reportPath,
          stats: result.stats,
          waitSeconds: result.waitSeconds,
          skippedEvents: result.skippedEvents
        }
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: 'recorder_status',
      description:
        '查询网页操作录制的当前状态: 是否在录制中、已记录事件计数、产物目录、上一次录制的收尾结果。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            recording: { type: 'boolean', required: true, description: '是否正在录制' },
            startedAt: { type: 'number', description: '开始时间戳(录制中时存在)' },
            sessionDir: { type: 'string', description: '产物目录(录制中时存在)' },
            eventCount: { type: 'number', description: '已记录事件数(录制中时存在)' },
            counts: {
              type: 'object',
              additionalProperties: true,
              description: '分类计数(录制中时存在)'
            },
            waitSeconds: { type: 'number', description: '本次录制的等待秒数(0 表示立即开始记录)' },
            waitRemainingSec: { type: 'number', description: '等待期剩余秒数(已开始记录时为 0)' },
            skippedEvents: { type: 'number', description: '等待期内已丢弃的事件数' },
            lastResult: { type: 'json', description: '上一次录制的收尾结果' }
          }
        },
        render: (_args, value: StatusSuccess) => {
          if (value.recording) {
            const c = value.counts!
            return [
              {
                type: 'text',
                text:
                  `录制中: 已记录 ${value.eventCount} 个事件` +
                  `(点击 ${c.clicks}, 输入 ${c.changes}, 请求 ${c.requests}, 失败 ${c.failed})。\n` +
                  (value.waitRemainingSec && value.waitRemainingSec > 0
                    ? `仍在等待期(共 ${value.waitSeconds}s, 还剩 ${value.waitRemainingSec}s), 此期间操作不记录。\n`
                    : '') +
                  `产物目录: ${value.sessionDir}`
              }
            ]
          }
          return [
            {
              type: 'text',
              text: `当前没有进行中的录制。${value.lastResult ? `上一次: ${JSON.stringify(value.lastResult)}` : ''}`
            }
          ]
        }
      },
      async execute(): Promise<StatusSuccess> {
        const active = takeActive()
        if (!(active instanceof RecorderSession)) {
          return {
            ok: true,
            recording: false,
            ...(lastResult ? { lastResult: lastResult as unknown as JsonValue } : {})
          }
        }
        const s = active.status()
        return {
          ok: true,
          recording: true,
          startedAt: s.startedAt,
          sessionDir: s.sessionDir,
          eventCount: s.eventCount,
          counts: s.counts,
          waitSeconds: s.waitSeconds,
          waitRemainingSec: s.waitRemainingSec,
          skippedEvents: s.skippedEvents
        }
      }
    })
  )

  // 注册即 effect: 插件被卸载(禁用/HMR/进程收尾)时, 兜底收尾仍在进行的录制,
  // 不残留浏览器进程; disposer 逆序执行且卸载会 await 异步 disposer。
  ctx.effect(() => {
    return () => {
      const active = session
      session = null
      if (active && !active.isFinished()) {
        return active.stop('plugin-disposed')
      }
    }
  })
}
