/**
 * Playwright MCP 浏览器的发现与接管(Windows 专用实现)。
 *
 * 用途: recorder 想「接管用户正在使用的浏览器」而不是另开窗口时, 需要定位那个浏览器实例:
 *   1. 经 PowerShell CIM 查进程命令行, 找到带 ms-playwright-mcp user-data-dir 的 chrome/msedge;
 *   2. 该 user-data-dir 下的 DevToolsActivePort 第一行即 CDP 端口(MCP 以 --remote-debugging-port 启动时写入),
 *      据此可直接 attach 到用户正在看的窗口;
 *   3. 没有调试端口时只能走接管: 从 Chrome Sessions 的 Tabs 文件里取最近访问的 URL, 关掉 MCP 浏览器,
 *      再用 recorder 自启窗口打开同一 URL。
 *
 * 非 Windows 平台不做实现: 这些手段(PowerShell CIM / Chrome Tabs 文件布局)都不适用,
 * 直接返回 undefined 让调用方回退到「新开窗口」, 省掉注定失败的子进程调用。
 *
 * 探针对象在同一次 RecorderSession.start() 内复用: user-data-dir 的查询要 spawn 一次 PowerShell
 * (CIM 查询偏慢), 发现 CDP 与接管两条路径共用缓存, 一次启动最多查一次。
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const IS_WIN32 = process.platform === 'win32'

/**
 * 执行 PowerShell 脚本并返回 stdout。统一走 -EncodedCommand(UTF-16LE base64):
 * 脚本内含双引号(如正则 [^\s"])时, -Command "..." 经 cmd.exe + powershell 双层引号
 * 解析会断裂静默失败, EncodedCommand 完全绕开该问题。
 */
function runPowerShell(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
    encoding: 'utf8',
    timeout: 10000
  })
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/** 查找正在运行的 Playwright MCP 浏览器的 user-data-dir(Windows: PowerShell CIM 查进程命令行)。 */
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

/** 关闭 Playwright MCP 浏览器进程(通过 PowerShell Stop-Process)。 */
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

export interface McpBrowserProbe {
  /** MCP 浏览器的 user-data-dir; 结果在探针内缓存, 查不到返回 undefined。 */
  findUserDataDir(): string | undefined
  /** CDP 调试地址(MCP 以 --remote-debugging-port 启动时才有), 供 connectOverCDP attach。 */
  discoverCdpUrl(): string | undefined
  /** 最近访问的 URL; 检测不到 MCP 浏览器时返回 undefined(接管回退用)。 */
  lastVisitedUrl(): string | undefined
  /** 关闭 MCP 浏览器进程并轮询等其退出(最长 timeoutMs), 避免固定 sleep 拍脑袋取值。 */
  closeAndWait(timeoutMs?: number): Promise<void>
}

export function createMcpBrowserProbe(): McpBrowserProbe {
  let cachedDir: string | undefined
  let dirQueried = false

  const findUserDataDir = (): string | undefined => {
    if (dirQueried) return cachedDir
    dirQueried = true
    cachedDir = queryMcpUserDataDir()
    return cachedDir
  }

  const invalidate = (): void => {
    dirQueried = false
    cachedDir = undefined
  }

  return {
    findUserDataDir,

    discoverCdpUrl(): string | undefined {
      try {
        const userDataDir = findUserDataDir()
        if (!userDataDir) return undefined
        // Chrome 把实际端口写入 user-data-dir 下的 DevToolsActivePort(第一行)
        const portFile = join(userDataDir, 'DevToolsActivePort')
        if (!existsSync(portFile)) return undefined
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim())
        if (!Number.isInteger(port) || port <= 0) return undefined
        return `http://127.0.0.1:${port}`
      } catch {
        return undefined
      }
    },

    lastVisitedUrl(): string | undefined {
      const userDataDir = findUserDataDir()
      if (!userDataDir) return undefined
      return extractUrlFromTabs(userDataDir)
    },

    async closeAndWait(timeoutMs = 3000): Promise<void> {
      killMcpBrowser()
      invalidate()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await sleep(400)
        invalidate()
        // 进程已退出则查不到 user-data-dir, 认为接管完成
        if (!queryMcpUserDataDir()) return
      }
    }
  }
}
