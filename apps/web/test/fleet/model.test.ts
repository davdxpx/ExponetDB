import { describe, expect, it } from 'vitest'
import { chipStateOf } from '../../src/features/fleet/health.tsx'
import { fleetModel, partStale, unavailableKind } from '../../src/features/fleet/model.ts'
import { fleetFixture, iso } from './support.tsx'

describe('the fleet model', () => {
  it('turns every part into a count or an unavailable part, never a zero', () => {
    const ready = fleetModel(fleetFixture())
    expect(ready.targets).toMatchObject({ kind: 'count', count: 7, lowerBound: false })
    expect(ready.findings).toMatchObject({ kind: 'count', count: 9 })
    expect(ready.approval).toMatchObject({ kind: 'count', count: 1 })
    expect(ready.running).toMatchObject({ kind: 'count', count: 2 })
    expect(ready.attention).toMatchObject({ kind: 'count', count: 3 })
    const gone = fleetModel(
      fleetFixture({
        findings: { available: false, reason: 'permission_denied' },
        operations: { available: false, reason: 'x' },
      }),
    )
    expect(gone.findings).toEqual({ kind: 'unavailable', reason: 'permission_denied' })
    for (const part of [gone.approval, gone.running, gone.attention]) {
      expect(part).toEqual({ kind: 'unavailable', reason: 'x' })
    }
  })

  it('carries the lower bound and its reason', () => {
    const model = fleetModel(
      fleetFixture({
        operations: {
          available: true,
          awaiting_approval: 0,
          running: 5,
          needs_attention: 0,
          lowerBound: true,
          lowerBoundReason: 'bounded',
          observedAt: iso(),
          source: 'live',
        },
      }),
    )
    expect(model.running).toMatchObject({ lowerBound: true, lowerBoundReason: 'bounded' })
  })

  it('counts a part as stale after two minutes, and a time it cannot read as stale', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z')
    expect(partStale('2026-10-13T11:59:00.000Z', now)).toBe(false)
    expect(partStale('2026-10-13T11:57:00.000Z', now)).toBe(true)
    expect(partStale('yesterday', now)).toBe(true)
  })

  it('names only the permission reason; any other reason is "unknown"', () => {
    expect(unavailableKind('permission_denied')).toBe('permission_denied')
    expect(unavailableKind('anything')).toBe('unknown')
  })

  it('reads a health word it does not know as unknown, and a missing sample as none', () => {
    expect(chipStateOf('healthy')).toBe('healthy')
    expect(chipStateOf('brand-new')).toBe('unknown')
    expect(chipStateOf(null)).toBe('none')
  })
})
