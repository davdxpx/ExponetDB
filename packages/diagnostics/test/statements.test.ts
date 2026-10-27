import { loadParser } from '@exponetdb/postgres/parser'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  bloatEstimate,
  type Counters,
  deltaOf,
  discontinuityOf,
  gapsOf,
  type LatestCounters,
  REGRESSION,
  regressionOf,
  STATEMENT_GAP_SECONDS,
  statementKey,
  storedText,
} from '../src/index.ts'

/** The pure rules of the statement statistics (performance.md §2). */
const c = (calls: number, time: number, extra: Partial<Counters> = {}): Counters => ({
  calls: BigInt(calls),
  totalTimeMs: time,
  rows: BigInt(calls),
  blksHit: 10n,
  blksRead: 1n,
  ...extra,
})

const T0 = Date.parse('2026-10-27T10:00:00.000Z')
const latest = (counters: Counters, over: Partial<LatestCounters> = {}): LatestCounters => ({
  ...counters,
  statsReset: '2026-10-01T00:00:00.000000Z',
  postmasterStart: '2026-10-01T00:00:00.000000Z',
  sampledAtMs: T0,
  ...over,
})
const ctx = {
  discontinuity: 'none' as const,
  statsReset: '2026-10-01T00:00:00.000000Z',
  postmasterStart: '2026-10-01T00:00:00.000000Z',
  sampledAtMs: T0 + 300_000,
}

describe('discontinuities', () => {
  const marks = {
    statsReset: '2026-10-01T00:00:00.000000Z',
    dealloc: 3n,
    postmasterStart: '2026-10-01T00:00:00.000000Z',
  }
  it('names the first sample, a restart, a reset and deallocations, in that order', () => {
    expect(discontinuityOf(undefined, marks)).toBe('first')
    expect(discontinuityOf(marks, marks)).toBe('none')
    expect(discontinuityOf(marks, { ...marks, postmasterStart: 'x', statsReset: 'y' })).toBe(
      'server_restart',
    )
    expect(discontinuityOf(marks, { ...marks, statsReset: '2026-10-27T00:00:00.000000Z' })).toBe(
      'stats_reset',
    )
    expect(discontinuityOf(marks, { ...marks, dealloc: 4n })).toBe('entries_deallocated')
    // A counter that went back is a reset, whatever stats_reset says.
    expect(discontinuityOf(marks, { ...marks, dealloc: 0n })).toBe('stats_reset')
  })
})

describe('deltas', () => {
  it('is the difference of the counters since the previous value', () => {
    expect(deltaOf(latest(c(10, 100)), { ...c(15, 160), statsSinceMs: null }, ctx)).toEqual({
      calls: 5n,
      totalTimeMs: 60,
      rows: 5n,
      blksHit: 0n,
      blksRead: 0n,
    })
  })

  it('is never computed across a reset, a restart or a first sample, nor without a previous value', () => {
    const now = { ...c(15, 160), statsSinceMs: null }
    expect(deltaOf(latest(c(10, 100)), now, { ...ctx, discontinuity: 'stats_reset' })).toBeNull()
    expect(deltaOf(latest(c(10, 100)), now, { ...ctx, discontinuity: 'server_restart' })).toBeNull()
    expect(deltaOf(latest(c(10, 100)), now, { ...ctx, discontinuity: 'first' })).toBeNull()
    expect(deltaOf(undefined, now, ctx)).toBeNull()
  })

  it('is allowed after deallocations, but a statement whose counters went down gets none', () => {
    const dealloc = { ...ctx, discontinuity: 'entries_deallocated' as const }
    expect(deltaOf(latest(c(10, 100)), { ...c(12, 120), statsSinceMs: null }, dealloc)?.calls).toBe(
      2n,
    )
    expect(deltaOf(latest(c(10, 100)), { ...c(3, 30), statsSinceMs: null }, dealloc)).toBeNull()
    expect(
      deltaOf(latest(c(10, 100)), { ...c(12, 90), statsSinceMs: null }, dealloc),
      'time went back',
    ).toBeNull()
  })

  it('skips a delta whose previous value is older than a gap: the statement re-entered the top 200 (review D-5)', () => {
    const now = { ...c(1015, 10_160), statsSinceMs: null }
    // Two periods apart (one sample missed): still one delta.
    expect(
      deltaOf(latest(c(10, 100)), now, { ...ctx, sampledAtMs: T0 + STATEMENT_GAP_SECONDS * 1000 })
        ?.calls,
    ).toBe(1005n)
    // Longer: the whole difference is not stamped on this sample; the interval is a gap.
    expect(
      deltaOf(latest(c(10, 100)), now, {
        ...ctx,
        sampledAtMs: T0 + STATEMENT_GAP_SECONDS * 1000 + 1,
      }),
    ).toBeNull()
    expect(deltaOf(latest(c(10, 100)), now, { ...ctx, sampledAtMs: T0 + 6 * 3_600_000 })).toBeNull()
    // After deallocations as well.
    expect(
      deltaOf(latest(c(10, 100)), now, {
        ...ctx,
        discontinuity: 'entries_deallocated',
        sampledAtMs: T0 + 3_600_000,
      }),
    ).toBeNull()
  })

  it('refuses a previous value of another epoch and an entry recreated after it (stats_since)', () => {
    const now = { ...c(15, 160), statsSinceMs: null }
    expect(deltaOf(latest(c(10, 100), { statsReset: 'other' }), now, ctx)).toBeNull()
    expect(deltaOf(latest(c(10, 100), { postmasterStart: 'other' }), now, ctx)).toBeNull()
    expect(deltaOf(latest(c(10, 100)), { ...c(15, 160), statsSinceMs: T0 + 1000 }, ctx)).toBeNull()
    expect(
      deltaOf(latest(c(10, 100)), { ...c(15, 160), statsSinceMs: T0 - 1000 }, ctx)?.calls,
    ).toBe(5n)
  })

  it('stores nothing for a statement that did not run in between', () => {
    expect(deltaOf(latest(c(10, 100)), { ...c(10, 100), statsSinceMs: null }, ctx)).toBeNull()
  })
})

describe('regressions', () => {
  const base = { migrationsBetween: 1 }
  it('regresses at twice the baseline mean with enough calls in both windows', () => {
    expect(
      regressionOf({ ...base, calls24h: 50, timeMs24h: 1000, calls7d: 500, timeMs7d: 5000 }),
    ).toEqual({
      state: 'regressed',
      meanTimeMs24h: 20,
      meanTimeMs7d: 10,
      factor: 2,
      thresholdFactor: REGRESSION.thresholdFactor,
      minCalls: REGRESSION.minCalls,
      migrationsBetween: 1,
    })
    expect(
      regressionOf({ ...base, calls24h: 50, timeMs24h: 999, calls7d: 500, timeMs7d: 5000 }).state,
    ).toBe('none')
  })

  it('has insufficient data below the minimum calls in either window', () => {
    const r = regressionOf({ ...base, calls24h: 49, timeMs24h: 4900, calls7d: 500, timeMs7d: 5000 })
    expect(r.state).toBe('insufficient_data')
    expect(r.factor).toBe(10)
    expect(
      regressionOf({ ...base, calls24h: 100, timeMs24h: 100, calls7d: 0, timeMs7d: 0 }),
    ).toMatchObject({ state: 'insufficient_data', meanTimeMs7d: null, factor: null })
  })
})

describe('gaps', () => {
  const min = 60_000
  it('reports intervals longer than two sample periods, at the start, between and at the end', () => {
    const from = T0
    const to = T0 + 60 * min
    const gaps = gapsOf(
      [T0 + 20 * min, T0 + 25 * min, T0 + 40 * min],
      { fromMs: from, toMs: to },
      to,
    )
    expect(STATEMENT_GAP_SECONDS).toBe(600)
    expect(gaps).toEqual([
      { fromMs: from, toMs: T0 + 20 * min },
      { fromMs: T0 + 25 * min, toMs: T0 + 40 * min },
      { fromMs: T0 + 40 * min, toMs: to },
    ])
  })

  it('stops at now and reports none for regular samples', () => {
    const points = Array.from({ length: 13 }, (_, i) => T0 + i * 5 * min)
    expect(gapsOf(points, { fromMs: T0, toMs: T0 + 120 * min }, T0 + 60 * min)).toEqual([])
  })
})

describe('statement texts', () => {
  beforeAll(async () => {
    await loadParser(17)
  })

  it('replaces statements that can carry a secret by a fixed summary', () => {
    for (const text of [
      "ALTER ROLE app PASSWORD 'hunter2'",
      'CREATE ROLE app LOGIN PASSWORD $1',
      "CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password 'p')",
      "ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password 'p')",
      "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'h', password 'p')",
      "ALTER SERVER s OPTIONS (SET password 'p')",
      "SET app.secret_token = 'abc'",
    ]) {
      const stored = storedText(text, 17)
      expect(stored.textRedacted, text).toBe(true)
      expect(stored.text, text).not.toMatch(/hunter2|'p'|'abc'|'u'/)
    }
  })

  it('keeps normalized statements readable and masks literals', () => {
    expect(storedText('SELECT * FROM accounts WHERE id = $1', 17)).toEqual({
      text: 'SELECT * FROM accounts WHERE id = $1',
      textRedacted: false,
    })
    expect(storedText("SELECT 'a@b.de'", 17).text).not.toContain('a@b.de')
    expect(storedText(null, 17)).toEqual({
      text: '<statement text not available>',
      textRedacted: false,
    })
  })

  it('keys a statement by database, role and queryid', () => {
    const k = statementKey('16384', '10', '-123')
    expect(k).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(k).not.toBe(statementKey('16384', '11', '-123'))
  })
})

describe('bloat estimate', () => {
  it('is the dead share of the heap, and null when nothing was counted', () => {
    expect(bloatEstimate(8192 * 100, 75, 25)).toBe(8192 * 25)
    expect(bloatEstimate(0, 1, 1)).toBeNull()
    expect(bloatEstimate(8192, 0, 0)).toBeNull()
  })
})
