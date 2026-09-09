/**
 * 端到端验证: 模拟「playwright-mcp 已用 --remote-debugging-port=0 打开 Chrome」,
 * 再直接调 lib 的 RecorderSession.start(无 cdpUrl), 断言:
 *   1. 自动发现 CDP 端口并 attach(isAttached() === true)
 *   2. 原浏览器未被 kill、未新开第二个浏览器
 *   3. stop 后原浏览器仍存活
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'
import { RecorderSession } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
// 目录名含 ms-playwright-mcp, 让 session.ts 的进程检测命中
const userDataDir = join(tmpdir(), 'ms-playwright-mcp-verify')
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: 'chrome',
  args: ['--remote-debugging-port=0']
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto('data:text/html,<h1>mcp-verify</h1><button id="b">hi</button>')
console.log('[verify] 模拟 MCP Chrome 已启动:', userDataDir)

const opts = {
  channel: 'msedge',
  executablePath: '',
  cdpUrl: '',
  outputDir: join(here, '../reports/recorder-verify'),
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: false,
  requestResourceTypes: ['xhr', 'fetch'],
  redactHeaders: ['authorization', 'cookie']
}

let failed = 0
const session = await RecorderSession.start(undefined, opts)
const attached = session.isAttached()
console.log(`${attached ? 'PASS' : 'FAIL'}  自动 attach 到模拟 MCP 浏览器(未新开窗口)`)
if (!attached) failed++

// 在原页面点击, 验证已加载页面补装的采集脚本生效
await page.click('#b')
await page.waitForTimeout(300)
const result = await session.stop('verify')
const clicked = result.stats.clicks > 0
console.log(`${clicked ? 'PASS' : 'FAIL'}  已加载页面上的点击被录到(clicks=${result.stats.clicks})`)
if (!clicked) failed++

// stop 后原浏览器仍存活
let alive = false
try {
  await page.title()
  alive = true
} catch {
  alive = false
}
console.log(`${alive ? 'PASS' : 'FAIL'}  stop 后原浏览器仍存活`)
if (!alive) failed++

await ctx.close().catch(() => undefined)
if (failed > 0) {
  console.error(`[verify] ${failed} 项断言失败`)
  process.exit(1)
}
console.log('[verify] 全部断言通过, 产物:', result.sessionDir)
