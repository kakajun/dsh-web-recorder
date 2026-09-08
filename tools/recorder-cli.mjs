/**
 * recorder 插件的 CLI 启动器(插件未随 DSH 重启加载期间的等效入口):
 *   node tools/recorder-cli.mjs <起始URL> <停止信号文件>
 *
 * 用已构建的 lib/index.js 的 RecorderSession 启动有头 Edge 并全程录制;
 * 每秒轮询停止信号文件, 出现后 session.stop('user-stop') 生成报告并退出;
 * 用户直接关掉浏览器窗口也会自动收尾(reason: browser-closed)并退出。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecorderSession } from '../lib/index.js'

const [url, stopFile] = process.argv.slice(2)
if (!stopFile) {
  console.error('用法: node recorder-cli.mjs <起始URL> <停止信号文件>')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(root, 'reports', 'recorder')

const opts = {
  channel: 'msedge',
  executablePath: '',
  outputDir,
  captureResponseBodies: true,
  maxBodyBytes: 16384,
  recordConsole: false,
  requestResourceTypes: ['xhr', 'fetch'],
  redactHeaders: ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'set-cookie']
}

let session
try {
  session = await RecorderSession.start(url || undefined, opts)
} catch (cause) {
  console.error(
    `[recorder] Edge 启动失败(${cause instanceof Error ? cause.message : cause}), 改用 Chrome`
  )
  opts.channel = 'chrome'
  session = await RecorderSession.start(url || undefined, opts)
}
console.log(`[recorder] 录制已开始, 产物目录: ${session.sessionDir}`)

const timer = setInterval(() => {
  void (async () => {
    if (session.isFinished()) {
      clearInterval(timer)
      const r = session.result()
      console.log(
        `[recorder] 浏览器已关闭, 自动收尾(${r?.reason}); 事件 ${r?.eventCount}, 报告: ${r?.reportPath}`
      )
      process.exit(0)
    }
    if (existsSync(stopFile)) {
      clearInterval(timer)
      const r = await session.stop('user-stop')
      console.log(`[recorder] 已停止; 事件 ${r.eventCount}, 报告: ${r.reportPath}`)
      process.exit(0)
    }
  })().catch(cause => {
    console.error(`[recorder] 轮询异常: ${cause instanceof Error ? cause.message : cause}`)
  })
}, 1000)
