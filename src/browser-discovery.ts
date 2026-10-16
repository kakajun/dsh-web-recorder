/**
 * 本机 Chromium 浏览器的 CDP 发现与接管(Windows 专用实现)。
 *
 * 用途: recorder 想「接管用户正在使用的浏览器」而不是另开窗口时, 需要定位那个浏览器实例:
 *   1. 经 PowerShell CIM 查进程命令行, 找出所有**开启了远程调试端口**的 chrome/msedge 顶层进程
 *      (即命令行含 --remote-debugging-port 且非 --type= 子进程);
 *   2. 端口取值: 命令行里写了具体端口就直接用; 写的是 0(让 Chrome 自选)则读该 user-data-dir 下的
 *      DevToolsActivePort 第一行 —— MCP 与插件自启窗口都是这种写法;
 *   3. 据此可直接 attach 到用户正在看的窗口, 无需任何配置;
 *   4. 若目标浏览器**没有**开调试端口(如 MCP 未配 --remote-debugging-port), 则无法 attach;
 *      此时走接管回退: 从 Chrome Sessions 的 Tabs 文件里取最近访问的 URL, 关掉它,
 *      再用 recorder 自启窗口打开同一 URL。
 *
 * 为什么扫描范围不限于 Playwright MCP: 「零配置接入」的前提是「谁开了调试端口就接管谁」。
 * 用户手工 `chrome --remote-debugging-port=9222` 起的浏览器、chrome-devtools MCP、
 * Playwright MCP 配置了调试端口的浏览器, 都属于「用户正在用的窗口」, 都应当能直接 attach。
 * MCP 特征的浏览器(命令行含 ms-playwright-mcp)排在候选列表最前, 因为它是本插件最主要的协作对象。
 *
 * 非 Windows 平台不做实现: 这些手段(PowerShell CIM / Chrome Tabs 文件布局)都不适用,
 * 直接返回空让调用方回退到「新开窗口」, 省掉注定失败的子进程调用。
 *
 * 探针对象在同一次 RecorderSession.start() 内复用: 进程扫描要 spawn 一次 PowerShell
 * (CIM 查询偏慢), 发现 CDP 与接管两条路径共用缓存, 一次启动最多查一次。
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const IS_WIN32 = process.platform === 'win32'

/** 一个暴露了 CDP 端口的本机 Chromium 浏览器。 */
export interface CdpBrowser {
  pid: number
  /** 可直接用于 connectOverCDP 的地址 */
  cdpUrl: string
  /** 是否为 Playwright MCP 启动的浏览器(排序优先) */
  isMcp: boolean
  userDataDir?: string
}

/**
 * 执行 PowerShell 脚本并返回 stdout。统一走 -EncodedCommand(UTF-16LE base64):
 * 脚本内含双引号(如正则 [^\s"])时, -Command "..." 经 cmd.exe + powershell 双层引号
 * 解析会断裂静默失败, EncodedCommand 完全绕开该问题。
 */
function runPowerShell(script: string): string {
  // 抑制「正在准备首次使用模块」等进度记录: 它们会被 PowerShell 以 CLIXML 形式写进 stderr,
  // 污染宿主终端输出(录制本身不受影响, 但看起来像报错)
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString(
    'base64'
  )
  return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    encoding: 'utf8',
    timeout: 10000
  })
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/** 命令行中 --flag=value 形式参数的取值(处理可选的双引号包裹)。 */
function argValue(commandLine: string, flag: string): string | undefined {
  const matched = commandLine.match(new RegExp(`--${flag}=(?:"([^"]+)"|(\\S+))`))
  return matched ? (matched[1] ?? matched[2]) : undefined
}

/** 从 user-data-dir 下的 DevToolsActivePort 读实际 CDP 端口(Chrome 自选端口时唯一可靠来源)。 */
function portFromDevToolsFile(userDataDir: string | undefined): number | undefined {
  if (!userDataDir) return undefined
  try {
    const portFile = join(userDataDir, 'DevToolsActivePort')
    if (!existsSync(portFile)) return undefined
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim())
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * 扫描本机所有「开了远程调试端口」的 Chromium 浏览器。
 * 一次 PowerShell 调用取全部候选(避免每个进程各 spawn 一次)。
 */
function scanCdpBrowsers(): CdpBrowser[] {
  if (!IS_WIN32) return []
  try {
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $items = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
        $_.CommandLine -like '*--remote-debugging-port=*' -and
        $_.CommandLine -notlike '*--type=*'
      } | Select-Object ProcessId, CommandLine)
      if ($items.Count -gt 0) { $items | ConvertTo-Json -Compress -Depth 3 }
    `
    const raw = runPowerShell(psScript).trim()
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as {
      ProcessId?: number
      CommandLine?: string | null
    }[]
    const found: CdpBrowser[] = []
    for (const row of rows) {
      const commandLine = row.CommandLine ?? ''
      if (!commandLine) continue
      const userDataDir = argValue(commandLine, 'user-data-dir')
      const declared = Number(argValue(commandLine, 'remote-debugging-port'))
      // 端口为 0 表示 Chrome 自选: 实际端口写在 user-data-dir/DevToolsActivePort
      const port = Number.isInteger(declared) && declared > 0 ? declared : portFromDevToolsFile(userDataDir)
      if (!port) continue
      found.push({
        pid: row.ProcessId ?? 0,
        cdpUrl: `http://127.0.0.1:${port}`,
        isMcp: /ms-playwright-mcp/i.test(commandLine),
        ...(userDataDir ? { userDataDir } : {})
      })
    }
    // MCP 浏览器优先(本插件最主要的协作对象), 其余按 pid 降序(通常越新启动的越相关)
    return found.sort((a, b) => Number(b.isMcp) - Number(a.isMcp) || b.pid - a.pid)
  } catch {
    return []
  }
}

/** 关闭 Playwright MCP 浏览器进程(通过 PowerShell Stop-Process)。只认 MCP 特征进程, 不动用户自己的浏览器。 */
function killMcpBrowser(): void {
  if (!IS_WIN32) return
  try {
    const psScript = `
      Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
        $_.CommandLine -match 'ms-playwright-mcp'
      } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
    `
    runPowerShell(psScript)
  } catch {
    // 忽略错误, 即使关闭失败也继续新开浏览器
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 从 Chrome 的 Sessions 目录中提取最近访问的 URL(读取 Tabs 文件, 其中包含明文 URL)。 */
function extractUrlFromTabs(userDataDir: string): string | undefined {
  try {
    const sessionsDir = join(userDataDir, 'Default', 'Sessions')
    if (!existsSync(sessionsDir)) return undefined
    // 按修改时间倒序(最新访问的在前), 直接用 readdir 排序, 不再 spawn cmd 的 dir /b /o-d
    const files = readdirSync(sessionsDir)
      .filter(f => f.startsWith('Tabs_'))
      .map(f => ({ name: f, mtime: mtimeOf(join(sessionsDir, f)) }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name)

    for (const file of files) {
      try {
        const bytes = readFileSync(join(sessionsDir, file))
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

export interface BrowserProbe {
  /** 本机所有暴露 CDP 端口的 Chromium 浏览器(MCP 特征优先); 结果在探针内缓存。 */
  cdpBrowsers(): CdpBrowser[]
  /** 首个可 attach 的 CDP 地址; 没有则返回 undefined。 */
  discoverCdpUrl(): string | undefined
  /** 最近访问的 URL; 检测不到 MCP 浏览器时返回 undefined(接管回退用)。 */
  lastVisitedUrl(): string | undefined
  /** 关闭 MCP 浏览器进程并轮询等其退出(最长 timeoutMs), 避免固定 sleep 拍脑袋取值。 */
  closeAndWait(timeoutMs?: number): Promise<void>
}

export function createBrowserProbe(): BrowserProbe {
  let cached: CdpBrowser[] | undefined

  const cdpBrowsers = (): CdpBrowser[] => {
    cached ??= scanCdpBrowsers()
    return cached
  }

  const invalidate = (): void => {
    cached = undefined
  }

  /** 接管回退只针对 MCP 浏览器(唯一的 user-data-dir 缓存来源)。 */
  const mcpUserDataDir = (): string | undefined =>
    cdpBrowsers().find(b => b.isMcp)?.userDataDir ?? queryMcpUserDataDir()

  return {
    cdpBrowsers,

    discoverCdpUrl(): string | undefined {
      return cdpBrowsers()[0]?.cdpUrl
    },

    lastVisitedUrl(): string | undefined {
      const userDataDir = mcpUserDataDir()
      if (!userDataDir) return undefined
      return extractUrlFromTabs(userDataDir)
    },

    async closeAndWait(timeoutMs = 3000): Promise<void> {
      killMcpBrowser()
      invalidate()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await sleep(400)
        if (!queryMcpUserDataDir()) return
      }
    }
  }
}

/** 查询 Playwright MCP 浏览器的 user-data-dir(接管回退时定位其 profile 读最近 URL / 等进程退出)。 */
function queryMcpUserDataDir(): string | undefined {
  if (!IS_WIN32) return undefined
  try {
    const psScript = `
      Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
        $_.CommandLine -match 'ms-playwright-mcp' -and
        $_.CommandLine -notmatch '--type='
      } | ForEach-Object {
        if ($_.CommandLine -match '--user-data-dir="?([^\\s"]+)') { $Matches[1] }
      } | Select-Object -First 1
    `
    const userDataDir = runPowerShell(psScript).trim()
    return userDataDir || undefined
  } catch {
    return undefined
  }
}
