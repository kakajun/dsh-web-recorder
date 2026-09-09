/**
 * 生成 dsh-web-recorder 播客封面插图
 *   node scripts/generate-podcast-cover.mjs
 *
 * 输出: assets/podcast-cover.png (1280x720)
 */
import { chromium } from 'playwright-core'
import { writeFile } from 'node:fs/promises'

const width = 1280
const height = 720

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${width}px;
      height: ${height}px;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(99, 102, 241, 0.07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(99, 102, 241, 0.07) 1px, transparent 1px);
      background-size: 40px 40px;
      mask-image: radial-gradient(ellipse at center, black 30%, transparent 80%);
    }
    .glow {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.35) 0%, transparent 70%);
      top: -150px;
      right: -150px;
    }
    .container {
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 32px;
    }
    .browser {
      width: 720px;
      height: 420px;
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      box-shadow:
        0 25px 80px rgba(0, 0, 0, 0.45),
        0 0 0 1px rgba(255, 255, 255, 0.1);
      overflow: hidden;
      position: relative;
    }
    .browser-header {
      height: 44px;
      background: linear-gradient(180deg, #f1f5f9 0%, #e2e8f0 100%);
      border-bottom: 1px solid #cbd5e1;
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 10px;
    }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .dot.red { background: #ef4444; }
    .dot.yellow { background: #f59e0b; }
    .dot.green { background: #10b981; }
    .address-bar {
      flex: 1;
      height: 28px;
      background: #fff;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      margin-left: 12px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-size: 13px;
      color: #475569;
    }
    .rec-badge {
      position: absolute;
      top: 60px;
      right: 20px;
      background: #dc2626;
      color: #fff;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(220, 38, 38, 0.35);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .rec-badge::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #fff;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.75; }
    }
    .browser-body {
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .page-title {
      font-size: 24px;
      font-weight: 700;
      color: #1e293b;
    }
    .form-row {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .input {
      flex: 1;
      height: 42px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 0 14px;
      font-size: 15px;
      color: #334155;
      background: #fff;
    }
    .button {
      height: 42px;
      padding: 0 22px;
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    .request-card {
      margin-top: 8px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 16px;
      font-family: "SF Mono", Monaco, monospace;
      font-size: 13px;
      color: #334155;
    }
    .request-line {
      display: flex;
      gap: 10px;
      margin-bottom: 8px;
    }
    .method {
      color: #059669;
      font-weight: 700;
    }
    .url {
      color: #475569;
    }
    .response {
      color: #0369a1;
    }
    .title-area {
      text-align: center;
      color: #fff;
    }
    .main-title {
      font-size: 52px;
      font-weight: 800;
      letter-spacing: -1px;
      text-shadow: 0 4px 20px rgba(0,0,0,0.3);
      margin-bottom: 10px;
    }
    .main-title span {
      color: #818cf8;
    }
    .subtitle {
      font-size: 22px;
      font-weight: 400;
      color: #c7d2fe;
      letter-spacing: 1px;
    }
    .feature-tags {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }
    .tag {
      padding: 6px 14px;
      border-radius: 20px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.15);
      color: #e0e7ff;
      font-size: 14px;
    }
    .floating-icon {
      position: absolute;
      z-index: 5;
      opacity: 0.15;
      color: #fff;
      font-size: 120px;
      font-weight: 900;
    }
    .floating-icon.left { left: -30px; top: 120px; transform: rotate(-15deg); }
    .floating-icon.right { right: -20px; bottom: 100px; transform: rotate(10deg); }
  </style>
</head>
<body>
  <div class="grid"></div>
  <div class="glow"></div>
  <div class="floating-icon left">UI</div>
  <div class="floating-icon right">API</div>
  <div class="container">
    <div class="browser">
      <div class="browser-header">
        <div class="dot red"></div>
        <div class="dot yellow"></div>
        <div class="dot green"></div>
        <div class="address-bar">https://example.com/platform/query</div>
      </div>
      <div class="rec-badge">REC</div>
      <div class="browser-body">
        <div class="page-title">业务查询平台</div>
        <div class="form-row">
          <div class="input">风机故障</div>
          <button class="button">查询</button>
        </div>
        <div class="request-card">
          <div class="request-line"><span class="method">POST</span><span class="url">/api/query</span></div>
          <div class="request-line"><span class="response">200 OK</span><span class="url">{ "ok": true, "items": [...] }</span></div>
        </div>
      </div>
    </div>
    <div class="title-area">
      <div class="main-title">dsh-<span>web-recorder</span></div>
      <div class="subtitle">网页操作录制器 · 操作一遍，接口全现</div>
      <div class="feature-tags">
        <div class="tag">点击 / 输入 / 导航</div>
        <div class="tag">xhr / fetch 录制</div>
        <div class="tag">自动生成报告</div>
      </div>
    </div>
  </div>
</body>
</html>`

const outputPath = 'assets/podcast-cover.png'

let browser
let page
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SMOKE_CHANNEL || 'msedge'
  })
  page = await browser.newPage({ viewport: { width, height } })
  await page.setContent(html, { waitUntil: 'networkidle' })
  // 等 CSS 动画/渲染稳定
  await page.waitForTimeout(500)
  await page.screenshot({ path: outputPath, type: 'png' })
  console.log(`[cover] 已生成: ${outputPath}`)
} catch (cause) {
  console.error(`[cover] 生成失败: ${cause.message}`)
  process.exit(1)
} finally {
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
}
