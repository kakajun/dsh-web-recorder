/**
 * generateMarkdown(report.ts) 单元测试 —— 直接运行 TS 源码, 无需先构建 lib:
 *   pnpm test          (vitest run)
 *   pnpm test:watch    (watch 模式)
 *
 * 覆盖: 报告骨架与占位符、统计概览计数与响应状态分布、操作时间线(导航/点击文本/
 * 密码脱敏展示)、网络明细(请求与响应状态关联、请求体表格竖线转义、长 URL 截断、
 * 超长请求体截断)、失败请求小节(有无对应 request 两种形态)、空事件输出。
 */
import { describe, expect, it } from 'vitest'
import { generateMarkdown } from '../src/report.ts'
import type { RecordedEvent, UnstampedEvent } from '../src/types.ts'

const STARTED_AT = 1_700_000_000_000

function meta(eventCount: number) {
  return {
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + eventCount * 1000,
    reason: 'unit-test',
    sessionDir: '/tmp/session'
  }
}

let seq = 0
// i 为事件序号(1 起), ts = STARTED_AT + i*500ms, 便于按 relSec(+x.xs) 断言时间线
const mk = (i: number, base: UnstampedEvent): RecordedEvent =>
  ({ seq: ++seq, ts: STARTED_AT + i * 500, ...base }) as RecordedEvent

describe('generateMarkdown', () => {
  it('空事件: 报告骨架与无记录占位符', () => {
    const report = generateMarkdown([], meta(0))
    expect(report.startsWith('# 网页操作录制报告')).toBe(true)
    expect(report).toContain('## 统计概览')
    expect(report).toContain('## 操作时间线')
    expect(report).toContain('(无 UI 操作记录)')
    expect(report).toContain('(无网络请求记录)')
    expect(report).toContain('数据目录: /tmp/session')
    expect(report.trimEnd().endsWith('完整数据(请求头/请求体/响应体/console)见同目录 events.jsonl。')).toBe(true)
  })

  it('统计概览: 分类计数与响应状态分布', () => {
    const events = [
      mk(1, { type: 'navigate', pageId: 1, url: 'http://example.com/a' }),
      mk(2, {
        type: 'click',
        pageId: 1,
        url: 'http://example.com/a',
        selector: 'button#btn',
        tag: 'button',
        text: '查询',
        x: 10,
        y: 20
      }),
      mk(3, {
        type: 'change',
        pageId: 1,
        url: 'http://example.com/a',
        selector: 'input#pwd',
        tag: 'input',
        name: 'secret',
        redacted: true
      }),
      mk(4, {
        type: 'request',
        pageId: 1,
        requestId: 1,
        method: 'POST',
        url: 'http://example.com/api/query',
        resourceType: 'xhr',
        headers: { authorization: '<redacted>' },
        postData: '{"kw":"风机|故障"}'
      }),
      mk(5, {
        type: 'response',
        pageId: 1,
        requestId: 1,
        status: 200,
        url: 'http://example.com/api/query',
        body: '{"ok":true}'
      }),
      mk(6, {
        type: 'request',
        pageId: 1,
        requestId: 2,
        method: 'GET',
        url: `http://example.com/${'segment/'.repeat(20)}`,
        resourceType: 'fetch',
        headers: {}
      }),
      mk(7, {
        type: 'response',
        pageId: 1,
        requestId: 2,
        status: 500,
        url: `http://example.com/${'segment/'.repeat(20)}`
      }),
      mk(8, {
        type: 'requestfailed',
        pageId: 1,
        requestId: 3,
        url: 'http://example.com/api/net',
        errorText: 'net::ERR_CONNECTION_RESET'
      }),
      mk(9, { type: 'console', pageId: 1, level: 'error', text: 'boom' })
    ]
    const report = generateMarkdown(events, meta(events.length))

    // 统计概览
    for (const [label, n] of [
      ['页面导航', 1],
      ['点击', 1],
      ['输入/选择变更', 1],
      ['表单提交', 0],
      ['网络请求', 2],
      ['请求失败', 1]
    ]) {
      expect(report).toContain(`| ${label} | ${n} |`)
    }
    expect(report).toContain('| 响应状态分布 | 2xx:1 5xx:1 |')

    // 操作时间线
    const lines = report.split('\n')
    expect(lines.some(l => l.includes('导航到 /a'))).toBe(true)
    expect(lines.some(l => l.includes('点击 `button#btn`') && l.includes('"查询"'))).toBe(true)
    expect(
      lines.some(l => l.includes('输入 `input#pwd`') && l.includes('name=secret') && l.includes('<已脱敏>'))
    ).toBe(true)

    // 网络明细: 状态关联、转义、截断
    expect(lines.some(l => l.includes('| 1 | +2.0s | POST | /api/query | xhr | 200 |'))).toBe(true)
    expect(report).toContain('风机\\|故障') // 请求体内竖线在表格中应转义为 \|
    expect(lines.some(l => l.includes('GET') && l.includes('500') && l.includes('...'))).toBe(true)

    // 失败请求小节 + console 不进时间线
    expect(report).toContain('## 失败请求')
    expect(lines.some(l => l.includes('net::ERR_CONNECTION_RESET'))).toBe(true)
    expect(lines.some(l => l.includes('console') && l.includes('boom'))).toBe(false)
  })

  it('超长请求体在明细表中截断', () => {
    const long = `{"kw":"${'很长的关键词'.repeat(30)}"}`
    const events = [
      mk(1, {
        type: 'request',
        pageId: 1,
        requestId: 1,
        method: 'POST',
        url: 'http://example.com/api/search',
        resourceType: 'xhr',
        headers: {},
        postData: long
      }),
      mk(2, {
        type: 'response',
        pageId: 1,
        requestId: 1,
        status: 200,
        url: 'http://example.com/api/search'
      })
    ]
    const report = generateMarkdown(events, meta(events.length))
    // 明细表请求体列只显示前 60 字符并带 ...
    expect(report).toContain('...')
    const bodyCol = long.slice(0, 60)
    expect(report.includes(bodyCol)).toBe(true)
    expect(report.includes(long)).toBe(false)
  })

  it('失败请求: 有对应 request 时展示方法+URL', () => {
    const events = [
      mk(1, {
        type: 'request',
        pageId: 1,
        requestId: 9,
        method: 'GET',
        url: 'http://example.com/api/net',
        resourceType: 'fetch',
        headers: {}
      }),
      mk(2, {
        type: 'requestfailed',
        pageId: 1,
        requestId: 9,
        url: 'http://example.com/api/net',
        errorText: 'net::ERR_TIMED_OUT'
      })
    ]
    const report = generateMarkdown(events, meta(events.length))
    // 注意: 网络明细行的状态列也会显示 失败(net::ERR_TIMED_OUT), 失败小节行以 "- #9 " 开头
    const lines = report.split('\n')
    expect(
      lines.some(l => l.startsWith('- #9') && l.includes('GET /api/net') && l.includes('ERR_TIMED_OUT'))
    ).toBe(true)
  })

  it('密码输入不把明文写进报告', () => {
    const events = [
      mk(1, {
        type: 'change',
        pageId: 1,
        url: 'http://example.com/login',
        selector: 'input#pwd',
        tag: 'input',
        name: 'password',
        redacted: true
      }),
      mk(2, {
        type: 'request',
        pageId: 1,
        requestId: 1,
        method: 'POST',
        url: 'http://example.com/login',
        resourceType: 'xhr',
        headers: { authorization: '<redacted>' }
      })
    ]
    const report = generateMarkdown(events, meta(events.length))
    expect(report).not.toContain('super-secret')
    expect(report).toContain('<已脱敏>')
  })
})
