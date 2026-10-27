import { describe, expect, it } from 'vitest'
import { drillFindings } from '../src/findings.ts'

const NOW = Date.UTC(2026, 9, 27, 12)
const DAY = 86_400_000

const facts = (over: Partial<Parameters<typeof drillFindings>[0]> = {}) => ({
  clusterId: 'cls_01M5X840BJSCYX2JZ3HYCMHDBT',
  cadenceDays: 30,
  lastPassedAt: new Date(NOW - 5 * DAY),
  lastFailedAfterPass: false,
  scratchLeft: 0,
  ...over,
})

const codes = (f: ReturnType<typeof facts>) => drillFindings(f, NOW).map((w) => `${w.code}:${w.severity}`)

describe('drill findings (restore.md §6)', () => {
  it('a passed drill inside the cadence raises nothing', () => {
    expect(codes(facts())).toEqual([])
  })

  it('no passed drill under a policy is a warning; without a policy nothing is asked', () => {
    expect(codes(facts({ lastPassedAt: null }))).toEqual(['backup_drill_never_run:warning'])
    expect(codes(facts({ lastPassedAt: null, cadenceDays: null }))).toEqual([])
  })

  it('overdue is a warning at the cadence and critical at twice the cadence', () => {
    expect(codes(facts({ lastPassedAt: new Date(NOW - 31 * DAY) }))).toEqual(['backup_drill_overdue:warning'])
    expect(codes(facts({ lastPassedAt: new Date(NOW - 61 * DAY) }))).toEqual(['backup_drill_overdue:critical'])
  })

  it('a failed newest drill is critical; a scratch left behind is a warning', () => {
    expect(codes(facts({ lastFailedAfterPass: true }))).toEqual(['backup_drill_failed:critical'])
    expect(codes(facts({ scratchLeft: 2 }))).toEqual(['restore_scratch_left:warning'])
  })
})
