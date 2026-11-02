import { describe, expect, it } from 'vitest'
import { volumeComponent } from '../src/installation-health.ts'

/**
 * OD-70 (b): the Control Store volume as an installation health component, from the database's
 * size against the configured volume size: a warning at 80 %, ingest refused at 90 %.
 */
const NOW = Date.parse('2026-11-02T12:00:00Z')
const GIB = 1024 ** 3

describe('the Control Store volume component (OD-70)', () => {
  it('is operational below 80 % and says what it measured', () => {
    expect(volumeComponent(4 * GIB, 10 * GIB, NOW)).toEqual({
      component: 'control_store_volume',
      state: 'operational',
      source: 'live',
      observedAt: '2026-11-02T12:00:00.000Z',
      values: { usedBytes: 4 * GIB, volumeBytes: 10 * GIB, usedPercent: 40 },
    })
  })

  it('warns from 80 % and names the refused ingest from 90 %', () => {
    expect(volumeComponent(8 * GIB, 10 * GIB, NOW)).toMatchObject({
      state: 'degraded',
      reasons: ['volume_above_80_percent'],
    })
    expect(volumeComponent(9 * GIB, 10 * GIB, NOW)).toMatchObject({
      state: 'degraded',
      reasons: ['ingest_refused', 'volume_above_90_percent'],
    })
  })
})
