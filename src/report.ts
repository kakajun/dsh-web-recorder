/**
 * 录制报告生成: 从内存事件序列生成 Markdown 报告。
 * 报告是给人/模型快速浏览的摘要; 完整数据(含请求头、请求体、响应体)在 events.jsonl。
 */
import { countEvents } from './stats.ts'
import type { RecordedEvent } from './types.ts'

interface ReportMeta {
  startedAt: number
  endedAt: number
  reason: string
  sessionDir: string
}

const MAX_URL = 100

function shortUrl(url: string): string {
  let text = url
  try {
    const u = new URL(url)
    text = u.pathname + u.search
  } catch {
    // 非标准 URL 原样展示
  }
  return text.length > MAX_URL ? text.slice(0, MAX_URL) + '...' : text
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function relSec(ts: number, startedAt: number): string {
  return `+${((ts - startedAt) / 1000).toFixed(1)}s`
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function generateMarkdown(events: RecordedEvent[], meta: ReportMeta): string {
  const lines: string[] = []
  const durationSec = ((meta.endedAt - meta.startedAt) / 1000).toFixed(1)

  lines.push('# 网页操作录制报告')
  lines.push('')
  lines.push(`- 开始时间: ${fmtTime(meta.startedAt)}`)
  lines.push(`- 结束时间: ${fmtTime(meta.endedAt)}(持续 ${durationSec}s, 结束原因: ${meta.reason})`)
  lines.push(`- 事件总数: ${events.length}`)
  lines.push(`- 数据目录: ${meta.sessionDir}`)
  lines.push('')

  // ---- 统计概览 ---- (与会话侧 status() 共用一套计数口径)
  const counts = countEvents(events)
  const statusClass = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'response') {
      const cls = `${Math.floor(e.status / 100)}xx`
      statusClass.set(cls, (statusClass.get(cls) ?? 0) + 1)
    }
  }
  lines.push('## 统计概览')
  lines.push('')
  lines.push('| 类别 | 数量 |')
  lines.push('| --- | --- |')
  lines.push(`| 页面导航 | ${counts.navigations} |`)
  lines.push(`| 点击 | ${counts.clicks} |`)
  lines.push(`| 输入/选择变更 | ${counts.changes} |`)
  lines.push(`| 表单提交 | ${counts.submits} |`)
  lines.push(`| 网络请求 | ${counts.requests} |`)
  lines.push(`| 请求失败 | ${counts.failed} |`)
  if (statusClass.size > 0) {
    lines.push(
      `| 响应状态分布 | ${[...statusClass.entries()].map(([k, v]) => `${k}:${v}`).join(' ')} |`
    )
  }
  lines.push('')

  // ---- 操作时间线(UI 事件 + 导航) ----
  lines.push('## 操作时间线')
  lines.push('')
  const uiEvents = events.filter(e => ['navigate', 'click', 'change', 'submit'].includes(e.type))
  if (uiEvents.length === 0) {
    lines.push('(无 UI 操作记录)')
  } else {
    for (const e of uiEvents) {
      const t = relSec(e.ts, meta.startedAt)
      if (e.type === 'navigate') {
        lines.push(`- [${t}] 导航到 ${shortUrl(e.url)}`)
      } else if (e.type === 'click') {
        lines.push(
          `- [${t}] 点击 \`${e.selector}\`${e.text ? ` "${escapeCell(e.text)}"` : ''} (${shortUrl(e.url)})`
        )
      } else if (e.type === 'change') {
        const value = e.redacted ? '<已脱敏>' : (e.value ?? '')
        lines.push(
          `- [${t}] 输入 \`${e.selector}\`${e.name ? ` (name=${e.name})` : ''} = "${escapeCell(value)}" (${shortUrl(e.url)})`
        )
      } else if (e.type === 'submit') {
        lines.push(`- [${t}] 提交表单 \`${e.selector}\` (${shortUrl(e.url)})`)
      }
    }
  }
  lines.push('')

  // ---- 网络请求明细 ----
  lines.push('## 网络请求明细')
  lines.push('')
  const responses = new Map<number, { status: number; bodyTruncated?: boolean; hasBody: boolean }>()
  const failures = new Map<number, string>()
  for (const e of events) {
    if (e.type === 'response')
      responses.set(e.requestId, {
        status: e.status,
        bodyTruncated: e.bodyTruncated,
        hasBody: e.body !== undefined
      })
    if (e.type === 'requestfailed') failures.set(e.requestId, e.errorText)
  }
  const requests = events.filter(
    (e): e is Extract<RecordedEvent, { type: 'request' }> => e.type === 'request'
  )
  if (requests.length === 0) {
    lines.push('(无网络请求记录)')
  } else {
    lines.push('| # | 时间 | 方法 | URL | 类型 | 状态 | 请求体 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const r of requests) {
      const resp = responses.get(r.requestId)
      const failed = failures.get(r.requestId)
      const status = resp ? String(resp.status) : failed ? `失败(${failed})` : '...'
      const body = r.postData
        ? escapeCell(r.postData.slice(0, 60)) + (r.postData.length > 60 ? '...' : '')
        : ''
      lines.push(
        `| ${r.requestId} | ${relSec(r.ts, meta.startedAt)} | ${r.method} | ${escapeCell(shortUrl(r.url))} | ${r.resourceType} | ${status} | ${body} |`
      )
    }
  }
  lines.push('')

  // ---- 失败请求 ----
  if (failures.size > 0) {
    lines.push('## 失败请求')
    lines.push('')
    // 按 requestId 建索引, 避免每个失败请求都线性扫描整表(O(n^2))
    const requestsById = new Map(requests.map(r => [r.requestId, r]))
    for (const [id, errorText] of failures) {
      const req = requestsById.get(id)
      lines.push(`- #${id} ${req ? `${req.method} ${shortUrl(req.url)}` : ''}: ${errorText}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('完整数据(请求头/请求体/响应体/console)见同目录 events.jsonl。')
  return lines.join('\n') + '\n'
}
