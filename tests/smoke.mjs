/**
 * dsh-web-recorder 冒烟测试(手工运行, 非测试框架):
 *   pnpm smoke   (等价: node tests/smoke.mjs)
 *
 * 流程: 起一个本地 HTTP 服务(一个带表单/按钮的页面 + 一个 POST /api/query 接口),
 * 用 RecorderSession 真实启动本机 Edge 打开该页面, 程序化模拟「输入 + 点击 + 跳转」,
 * 停止录制后断言 events.jsonl 与 report.md 中包含预期的点击/输入/请求/响应事件。
 * 运行前需先 pnpm build(产物 lib/index.js)。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecorderSession } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>recorder smoke</title></head>
<body>
  <h1>Smoke Page</h1>
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

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE_HTML)
  } else if (req.url === '/page2') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE2_HTML)
  } else if (req.url === '/api/query') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, echo: 'pong' }))
  } else if (req.url === '/api/page2-load') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ loaded: true }))
  } else {
    res.writeHead(404).end('not found')
  }
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
console.log(`[smoke] 本地服务: ${base}`)

const outputDir = join(here, '../reports/recorder-smoke')
const opts = {
  channel: process.env.SMOKE_CHANNEL || 'msedge',
  executablePath: '',
  outputDir,
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: true,
  requestResourceTypes: ['xhr', 'fetch'],
  redactHeaders: ['authorization', 'cookie']
}

let session
try {
  session = await RecorderSession.start(base + '/', opts)
} catch (cause) {
  console.error(`[smoke] 浏览器启动失败, 尝试 chrome: ${cause.message}`)
  opts.channel = 'chrome'
  session = await RecorderSession.start(base + '/', opts)
}

const page = session.pages()[0]
await page.waitForSelector('#btn')

// 模拟用户操作: 输入关键词 + 密码 + 点击按钮(触发 POST /api/query), 等响应看完后再跳页
// (真实用户节奏; 点击后立即跳转会取消页面未完成的响应体抓取, 属于已知限制)
await page.fill('#kw', '风机故障')
await page.fill('#pwd', 'super-secret')
// 先挂等待再点击, 避免本地服务响应太快导致 waitForResponse 错过事件
const queryResp = page.waitForResponse(r => r.url().includes('/api/query'))
await page.click('#btn')
await queryResp
await page.waitForTimeout(500)
const loadResp = page.waitForResponse(r => r.url().includes('/api/page2-load'))
await page.click('#go')
await loadResp
await page.waitForTimeout(300) // 等响应体事件入列

const result = await session.stop('smoke-test')
server.close()

const jsonl = await readFile(result.eventsPath, 'utf8')
const events = jsonl
  .trim()
  .split('\n')
  .map(line => JSON.parse(line))
const report = await readFile(result.reportPath, 'utf8')

const checks = [
  [
    '点击事件(selector 含 button#btn)',
    events.some(e => e.type === 'click' && e.selector.includes('button#btn'))
  ],
  ['点击事件带文本 "查询"', events.some(e => e.type === 'click' && e.text === '查询')],
  [
    '输入事件(name=keyword, 值=风机故障)',
    events.some(e => e.type === 'change' && e.name === 'keyword' && e.value === '风机故障')
  ],
  [
    '密码输入值已脱敏',
    events.some(
      e =>
        e.type === 'change' &&
        e.name === 'secret' &&
        e.redacted === true &&
        !('value' in e && e.value)
    )
  ],
  ['导航到 /page2', events.some(e => e.type === 'navigate' && e.url.endsWith('/page2'))],
  [
    'POST /api/query 请求已记录',
    events.some(e => e.type === 'request' && e.method === 'POST' && e.url.includes('/api/query'))
  ],
  [
    'Authorization 头已脱敏',
    events.some(e => e.type === 'request' && e.headers?.authorization === '<redacted>')
  ],
  [
    '请求体已记录(含 风机故障)',
    events.some(e => e.type === 'request' && e.postData?.includes('风机故障'))
  ],
  [
    '响应状态 200 已关联',
    events.some(e => e.type === 'response' && e.status === 200 && e.url.includes('/api/query'))
  ],
  [
    'xhr 响应体已记录(含 pong)',
    events.some(e => e.type === 'response' && e.body?.includes('pong'))
  ],
  [
    '静态资源/document 请求未录制(只录 xhr/fetch)',
    !events.some(e =>
      ['document', 'script', 'stylesheet', 'image', 'font'].includes(e.resourceType)
    )
  ],
  [
    '被过滤请求的响应也未录制',
    events.every(
      e =>
        e.type !== 'response' ||
        events.some(r => r.type === 'request' && r.requestId === e.requestId)
    )
  ],
  ['report.md 含操作时间线', report.includes('## 操作时间线') && report.includes('查询')],
  ['report.md 含网络请求明细', report.includes('## 网络请求明细') && report.includes('/api/query')]
]

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) failed++
}
console.log(`\n[smoke] 事件总数 ${result.eventCount}, 产物目录: ${result.sessionDir}`)
console.log(`[smoke] 报告: ${result.reportPath}`)
if (failed > 0) {
  console.error(`[smoke] ${failed} 项断言失败`)
  process.exit(1)
}
console.log('[smoke] 全部断言通过')
