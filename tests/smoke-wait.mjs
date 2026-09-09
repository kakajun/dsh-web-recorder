/**
 * 等待期(前置剔除)冒烟测试(手工运行, 非测试框架):
 *   pnpm smoke:wait   (等价: node tests/smoke-wait.mjs)
 *
 * 验证 recorder_start 的 waitSeconds: 开始录制后先等 N 秒再记录, 等待期内发生的
 * 页面初始化请求 / 点击 / 请求一律不落盘(等价把开头这段时间从录制结果里剔除),
 * 等待期结束后恢复正常记录。
 *
 * 运行前需先 pnpm build(产物 lib/index.js)。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecorderSession } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const WAIT_SECONDS = 8

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>recorder smoke wait</title></head>
<body>
  <h1>Wait Smoke</h1>
  <button id="early">等待期内点击</button>
  <button id="late">等待期后点击</button>
  <script>
    // 页面初始化接口: 导航时就发, 必然落在等待期内, 应被丢弃
    fetch('/api/init').then(() => {})
    for (const [id, path] of [['early', '/api/early'], ['late', '/api/late']]) {
      document.getElementById(id).addEventListener('click', () => {
        fetch(path).then(() => {})
      })
    }
  </script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE_HTML)
  } else if (req.url.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }))
  } else {
    res.writeHead(404).end('not found')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
console.log(`[smoke-wait] 本地服务: ${base}`)

const opts = {
  channel: process.env.SMOKE_CHANNEL || 'msedge',
  executablePath: '',
  cdpUrl: '',
  outputDir: join(here, '../reports/recorder-smoke-wait'),
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: false,
  requestResourceTypes: ['xhr', 'fetch'],
  redactHeaders: ['authorization', 'cookie'],
  waitSeconds: WAIT_SECONDS
}

const session = await RecorderSession.start(base + '/', opts)
const page = session.pages()[0]
await page.waitForSelector('#late')

// 用 status 自报的剩余等待时间对齐节奏, 避免依赖固定的 sleep 拍脑袋取值
const st = session.status()
console.log(
  `[smoke-wait] waitSeconds=${st.waitSeconds}, 剩余 ${st.waitRemainingSec}s, 已丢弃 ${st.skippedEvents} 个事件`
)
const enoughWaitLeft = st.waitRemainingSec > 1

// 1) 等待期内点击: 该点击与其请求都应被丢弃
const earlyResp = page.waitForResponse(r => r.url().includes('/api/early'))
await page.click('#early')
await earlyResp
// 2) 等过等待期再点击: 该点击与其请求都应被记录
await sleep(Math.max(0, st.waitRemainingSec) * 1000 + 800)
const lateResp = page.waitForResponse(r => r.url().includes('/api/late'))
await page.click('#late')
await lateResp
await sleep(300)

const result = await session.stop('smoke-wait-test')
server.close()

const jsonl = await readFile(result.eventsPath, 'utf8')
const events = jsonl.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const report = await readFile(result.reportPath, 'utf8')
const hasUrl = (frag) => events.some(e => 'url' in e && e.url.includes(frag))

const checks = [
  ['环境校验: 起录时仍处于等待期(剩余 > 1s)', enoughWaitLeft],
  ['status 报出 waitSeconds', st.waitSeconds === WAIT_SECONDS],
  ['等待期内的页面初始化请求 /api/init 未记录', !hasUrl('/api/init')],
  ['等待期内的点击(按钮 #early)未记录', !events.some(e => e.type === 'click' && e.selector.includes('early'))],
  ['等待期内的请求 /api/early 未记录', !hasUrl('/api/early')],
  ['等待期结束后的点击(按钮 #late)已记录', events.some(e => e.type === 'click' && e.selector.includes('late'))],
  ['等待期结束后的请求 /api/late 已记录', hasUrl('/api/late')],
  ['被丢弃事件数 > 0', result.skippedEvents > 0],
  ['StopResult 回显 waitSeconds', result.waitSeconds === WAIT_SECONDS],
  ['report.md 说明等待期', report.includes(`等待 ${WAIT_SECONDS}s 后开始记录`)]
]

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) failed++
}
console.log(
  `\n[smoke-wait] 事件总数 ${result.eventCount}, 等待期丢弃 ${result.skippedEvents} 个, 产物目录: ${result.sessionDir}`
)
console.log(`[smoke-wait] 报告: ${result.reportPath}`)
if (failed > 0) {
  console.error(`[smoke-wait] ${failed} 项断言失败`)
  process.exit(1)
}
console.log('[smoke-wait] 全部断言通过')
