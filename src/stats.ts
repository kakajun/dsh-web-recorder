/**
 * 事件计数: 会话侧增量维护与报告侧一次性统计共用同一套口径, 避免两处各写一份 switch。
 */
import type { RecordedEvent, SessionStats } from './types.ts'

export function createSessionStats(): SessionStats {
  return {
    navigations: 0,
    clicks: 0,
    changes: 0,
    submits: 0,
    requests: 0,
    responses: 0,
    failed: 0,
    console: 0
  }
}

/** 把一个事件计入统计(会话 push 时增量调用, status() 不必每次全量遍历事件)。 */
export function accumulateEvent(stats: SessionStats, type: RecordedEvent['type']): void {
  switch (type) {
    case 'navigate':
      stats.navigations++
      break
    case 'click':
      stats.clicks++
      break
    case 'change':
      stats.changes++
      break
    case 'submit':
      stats.submits++
      break
    case 'request':
      stats.requests++
      break
    case 'response':
      stats.responses++
      break
    case 'requestfailed':
      stats.failed++
      break
    case 'console':
      stats.console++
      break
  }
}

/** 一次性统计整段事件序列(报告生成与测试用)。 */
export function countEvents(events: Iterable<RecordedEvent>): SessionStats {
  const stats = createSessionStats()
  for (const e of events) accumulateEvent(stats, e.type)
  return stats
}
