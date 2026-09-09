/**
 * stats.ts 单元测试: 计数口径是会话 status() 与 report.md 统计概览的公共基础,
 * 这里锁定「增量累加」与「一次性统计」结果一致, 避免两处口径漂移。
 *   pnpm test
 */
import { describe, expect, it } from 'vitest'
import { accumulateEvent, countEvents, createSessionStats } from '../src/stats.ts'
import type { RecordedEvent, UnstampedEvent } from '../src/types.ts'

const EVENT_TYPES: RecordedEvent['type'][] = [
  'navigate',
  'click',
  'change',
  'submit',
  'request',
  'response',
  'requestfailed',
  'console'
]

const KEY_OF: Record<RecordedEvent['type'], keyof ReturnType<typeof createSessionStats>> = {
  navigate: 'navigations',
  click: 'clicks',
  change: 'changes',
  submit: 'submits',
  request: 'requests',
  response: 'responses',
  requestfailed: 'failed',
  console: 'console'
}

const mk = (type: RecordedEvent['type']): RecordedEvent =>
  ({ seq: 1, ts: 0, type, url: 'http://example.com' }) as unknown as RecordedEvent

describe('stats', () => {
  it('createSessionStats: 全部计数为 0', () => {
    expect(createSessionStats()).toEqual({
      navigations: 0,
      clicks: 0,
      changes: 0,
      submits: 0,
      requests: 0,
      responses: 0,
      failed: 0,
      console: 0
    })
  })

  it('accumulateEvent: 每种事件类型只累加自己的计数', () => {
    for (const type of EVENT_TYPES) {
      const stats = createSessionStats()
      accumulateEvent(stats, type)
      for (const key of Object.values(KEY_OF)) {
        expect(stats[key], `${type} -> ${key}`).toBe(key === KEY_OF[type] ? 1 : 0)
      }
    }
  })

  it('countEvents 与逐个增量累加结果一致(会话侧与报告侧同口径)', () => {
    // 每类事件出现「下标 + 1」次
    const events = EVENT_TYPES.flatMap((type, i) => Array.from({ length: i + 1 }, () => mk(type)))
    const incremental = createSessionStats()
    for (const e of events) accumulateEvent(incremental, e.type)
    const counted = countEvents(events)
    expect(counted).toEqual(incremental)
    expect(counted.clicks).toBe(2)
    expect(counted.console).toBe(8)
    expect(events).toHaveLength(36)
  })

  it('countEvents: 空序列返回全零', () => {
    expect(countEvents([])).toEqual(createSessionStats())
  })

  it('UnstampedEvent 仍可用于构造测试事件(类型层面不报错)', () => {
    const base: UnstampedEvent = { type: 'navigate', url: 'http://example.com/a' }
    expect(countEvents([{ seq: 1, ts: 0, ...base }])).toMatchObject({ navigations: 1 })
  })
})
