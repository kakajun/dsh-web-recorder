/**
 * dsh-web-recorder CDP attach 模式冒烟测试(手工运行, 非测试框架):
 *   pnpm smoke:cdp   (等价: node tests/smoke-cdp.mjs)
 *
 * 流程: 起一个本地 HTTP 服务, 先用 playwright-core 在本机启动一个带
 * --remote-debugging-port 的浏览器, 再用 RecorderSession 通过 cdpUrl attach
 * 到该浏览器实例, 程序化模拟「输入 + 点击 + 跳转」, 停止录制后断言
 * events.jsonl 与 report.md 包含预期事件, 并确认 stop 后浏览器进程未被关闭
 * (仍可对原页面进行操作)。
 *
 * 运行前需先 pnpm build(产物 lib/index.js)。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { RecorderSession } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>recorder smoke cdp</title></head>
<body>
  <h1>Smoke CDP Page</h1>
  <input id="kw" name="keyword" placeholder="关键词">
  <input id="pwd" name="secret" type="password" placeholder="密码">
  <button id="btn">查询</button>
  <a id="go" href="/page2">去第二页</a>
  <script>
    document.getElementById('btn').addEventListener('click', async () => {
      await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer should-be-redacted' },
        body: JSON.stringify({ kw: document.getElementById('kw').value }),
      })
    })
  </script>
</body></html>`

const PAGE2_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>page2</title></head>
<body><h1>Page 2</h1>
  <script>fetch('/api/page2-load').then(() => {})</script>
</body></html>`

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE_HTML)
  } else if (req.url === '/page2') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE2_HTML)
  } else if (req.url === '/api/query') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, echo: 'pong-cdp' }))
  } else if (req.url === '/api/page2-load') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ loaded: true }))
  } else {
    res.writeHead(404).end('not found')
  }
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
console.log(`[smoke-cdp] 本地服务: ${base}`)

const outputDir = join(here, '../reports/recorder-smoke-cdp')
const cdpPort = await getFreePort()
const cdpUrl = `http://127.0.0.1:${cdpPort}`
console.log(`[smoke-cdp] CDP 端口: ${cdpPort}`)

const channel = process.env.SMOKE_CHANNEL || 'msedge'
let externalBrowser
let session
try {
  externalBrowser = await chromium.launch({
    headless: false,
    channel,
    args: [`--remote-debugging-port=${cdpPort}`]
  })
} catch (cause) {
  console.error(`[smoke-cdp] 浏览器启动失败: ${cause.message}`)
  server.close()
  process.exit(1)
}

const opts = {
  channel,
  executablePath: '',
  cdpUrl,
  outputDir,
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: true,
  requestResourceTypes: ['xhr', 'fetch'],
  redactHeaders: ['authorization', 'cookie'],
  waitSeconds: 0
}

try {
  session = await RecorderSession.start(base + '/', opts)
} catch (cause) {
  console.error(`[smoke-cdp] CDP attach 失败: ${cause.message}`)
  await externalBrowser.close().catch(() => undefined)
  server.close()
  process.exit(1)
}

const page = session.pages()[0]
await page.waitForSelector('#btn')

// 模拟用户操作
await page.fill('#kw', '风机故障')
await page.fill('#pwd', 'super-secret')
const queryResp = page.waitForResponse(r => r.url().includes('/api/query'))
await page.click('#btn')
await queryResp
await page.waitForTimeout(500)
const loadResp = page.waitForResponse(r => r.url().includes('/api/page2-load'))
await page.click('#go')
await loadResp
await page.waitForTimeout(300)

const result = await session.stop('smoke-cdp-test')

const jsonl = await readFile(result.eventsPath, 'utf8')
const events = jsonl
  .trim()
  .split('\n')
  .map(line => JSON.parse(line))
const report = await readFile(result.reportPath, 'utf8')

const checks = [
  ['CDP attach 成功并录制到点击事件', events.some(e => e.type === 'click' && e.selector.includes('button#btn'))],
  ['点击事件带文本 "查询"', events.some(e => e.type === 'click' && e.text === '查询')],
  ['输入事件(name=keyword, 值=风机故障)', events.some(e => e.type === 'change' && e.name === 'keyword' && e.value === '风机故障')],
  ['密码输入值已脱敏', events.some(e => e.type === 'change' && e.name === 'secret' && e.redacted === true && !('value' in e && e.value))],
  ['导航到 /page2', events.some(e => e.type === 'navigate' && e.url.endsWith('/page2'))],
  ['POST /api/query 请求已记录', events.some(e => e.type === 'request' && e.method === 'POST' && e.url.includes('/api/query'))],
  ['Authorization 头已脱敏', events.some(e => e.type === 'request' && e.headers?.authorization === '<redacted>')],
  ['请求体已记录(含 风机故障)', events.some(e => e.type === 'request' && e.postData?.includes('风机故障'))],
  ['响应状态 200 已关联', events.some(e => e.type === 'response' && e.status === 200 && e.url.includes('/api/query'))],
  ['xhr 响应体已记录(含 pong-cdp)', events.some(e => e.type === 'response' && e.body?.includes('pong-cdp'))],
  ['report.md 含操作时间线', report.includes('## 操作时间线') && report.includes('查询')],
  ['report.md 含网络请求明细', report.includes('## 网络请求明细') && report.includes('/api/query')]
]

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) failed++
}
console.log(`\n[smoke-cdp] 事件总数 ${result.eventCount}, 产物目录: ${result.sessionDir}`)
console.log(`[smoke-cdp] 报告: ${result.reportPath}`)

// 关键断言: CDP attach 模式下 stop 不应关闭外部浏览器进程
// RecorderSession 内部的 browser.close() 只会断开 CDP 连接, 浏览器进程应仍在运行
let browserStillAlive = false
try {
  const reconnected = await chromium.connectOverCDP(cdpUrl)
  const pages = reconnected.contexts()[0]?.pages() ?? []
  if (pages.length > 0) {
    const title = await pages[0].title()
    browserStillAlive = title === 'page2'
  }
  await reconnected.close().catch(() => undefined)
} catch {
  browserStillAlive = false
}
console.log(`${browserStillAlive ? 'PASS' : 'FAIL'}  stop 后外部浏览器进程未被关闭(仍可重新 CDP 连接)`)
if (!browserStillAlive) failed++

await externalBrowser.close().catch(() => undefined)
server.close()

if (failed > 0) {
  console.error(`[smoke-cdp] ${failed} 项断言失败`)
  process.exit(1)
}
console.log('[smoke-cdp] 全部断言通过')
