import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HISTORY_MAX_BUCKETS, readHealthHistory } from '../src/index.ts'

/**
 * The sampled history of a target on real PostgreSQL 17 (order §9):
 * downsampled buckets with the worst state and the count of every state, and
 * the gaps between samples with the cause derived from the process
 * heartbeats that cover them. Samples and heartbeats are written the way the
 * worker's rows look; the clock is the test server's.
 */
let db: MigratedTestDatabase
let serve: ControlStore

const MIN = 60_000
const HOUR = 60 * MIN
let now = 0
const iso = (ms: number) => new Date(ms).toISOString()

/** Samples every `period` ms in [from, to), with the state `stateAt` gives. */
async function samples(
  targetId: string,
  from: number,
  to: number,
  stateAt: (at: number) => string = () => 'healthy',
  period = 15_000,
) {
  const times: number[] = []
  for (let t = from; t < to; t += period) times.push(t)
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO observation.health_samples (sample_id, target_id, observed_at, state, probes, conditions)
       SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::jsonb[], $6::jsonb[])`,
      [
        times.map((t) => newId('smp', t)),
        times.map(() => targetId),
        times.map(iso),
        times.map(stateAt),
        times.map(() => '[]'),
        times.map(() => '[]'),
      ],
    ),
  )
  return times.length
}

async function heartbeat(
  role: 'serve' | 'worker',
  startedAt: number,
  lastBeatAt: number,
  stoppedAt: number | null = null,
) {
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO control.process_heartbeats (process_id, role, build_version, build_commit, started_at, heartbeat_at, stopped_at)
       VALUES ($1, $2, '1.0.0', 'unknown', $3::timestamptz, $4::timestamptz, $5::timestamptz)`,
      [
        newId('prc', startedAt),
        role,
        iso(startedAt),
        iso(lastBeatAt),
        stoppedAt === null ? null : iso(stoppedAt),
      ],
    ),
  )
}

/** Daily partitions for the days the tests write to (the worker creates them ahead). */
async function partitions(from: number, to: number) {
  await db.asSuperuser(async (c) => {
    for (let day = Math.floor(from / 86_400_000); day <= Math.floor(to / 86_400_000); day++) {
      const lo = new Date(day * 86_400_000)
      const hi = new Date((day + 1) * 86_400_000)
      const name = `health_samples_d${lo.toISOString().slice(0, 10).replaceAll('-', '')}`
      const exists = await c.query(`SELECT to_regclass('observation.${name}') AS t`)
      if (exists.rows[0].t === null) {
        await c.query(
          `CREATE TABLE observation.${name} PARTITION OF observation.health_samples FOR VALUES FROM ('${lo.toISOString()}') TO ('${hi.toISOString()}')`,
        )
      }
    }
  })
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_health_history')
  serve = db.store('exdb_serve')
  const clock = await serve.query('test.clock', 'SELECT clock_timestamp() AS now')
  now = clock.rows[0]?.date('now').getTime() ?? Date.now()
  await partitions(now - 3 * 86_400_000, now)
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

describe('the buckets', () => {
  const target = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y01'

  it('hold the worst state and the count of every state, and none is lost', async () => {
    const start = now - 2 * HOUR
    // One hour healthy, with one unknown and one unreachable sample inside it.
    const written = await samples(target, start, start + HOUR, (t) =>
      t === start + 15 * MIN ? 'unknown' : t === start + 30 * MIN ? 'unreachable' : 'healthy',
    )
    const history = await readHealthHistory(serve, {
      targetId: target,
      state: 'active',
      stateChangedAt: iso(start),
      from: new Date(now - 3 * HOUR),
      to: new Date(now),
    })
    expect(history.bucketSeconds).toBe(30)
    expect(history.buckets.length).toBeLessThanOrEqual(HISTORY_MAX_BUCKETS + 1)
    const total = history.buckets.reduce((n, b) => n + b.samples, 0)
    expect(total).toBe(written)
    const sum = (key: 'healthy' | 'unknown' | 'unreachable') =>
      history.buckets.reduce((n, b) => n + b.counts[key], 0)
    expect([sum('healthy'), sum('unknown'), sum('unreachable')]).toEqual([written - 2, 1, 1])
    const worst = new Map(history.buckets.map((b) => [Date.parse(b.start), b.worst]))
    const bucketOf = (t: number) => Math.floor(t / 30_000) * 30_000
    expect(worst.get(bucketOf(start + 15 * MIN))).toBe('unknown')
    expect(worst.get(bucketOf(start + 30 * MIN))).toBe('unreachable')
    expect(worst.get(bucketOf(start))).toBe('healthy')
    // Buckets are ordered, aligned to their size, and hold at least one sample each.
    const starts = history.buckets.map((b) => Date.parse(b.start))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(starts.every((s) => s % 30_000 === 0)).toBe(true)
    expect(history.buckets.every((b) => b.samples >= 1)).toBe(true)
    expect(history.firstSampleAt).toBe(iso(start))
  })

  it('are at most the bound for a range of days', async () => {
    const other = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y02'
    await samples(other, now - 40 * HOUR, now - 37 * HOUR)
    const history = await readHealthHistory(serve, {
      targetId: other,
      state: 'active',
      stateChangedAt: iso(now - 40 * HOUR),
      from: new Date(now - 3 * 86_400_000),
      to: new Date(now),
    })
    expect(history.bucketSeconds).toBe(600)
    expect(history.buckets.length).toBeLessThanOrEqual(HISTORY_MAX_BUCKETS)
    expect(history.buckets.reduce((n, b) => n + b.samples, 0)).toBe(720)
  })

  it('are empty, with no gap, for a target that was never sampled', async () => {
    const history = await readHealthHistory(serve, {
      targetId: 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y09',
      state: 'active',
      stateChangedAt: iso(now - 5 * HOUR),
      from: new Date(now - 4 * HOUR),
      to: new Date(now),
    })
    expect(history).toMatchObject({
      buckets: [],
      gaps: [],
      gapsTruncated: false,
      firstSampleAt: null,
    })
  })
})

describe('the gaps and their cause', () => {
  const target = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y03'
  let t0 = 0
  beforeAll(() => {
    t0 = now - 3 * HOUR
  })

  it('derives sampler_lagging, control_plane_down and the trailing gap from the heartbeats', async () => {
    const at = (minutes: number) => t0 + minutes * MIN
    // Samples 0-60 min, 90-120 min and 150-175 min; the time since is the trailing gap.
    await samples(target, at(0), at(60))
    await samples(target, at(90), at(120))
    await samples(target, at(150), at(175))
    // A worker alive 0-120 min (then stopped), another from 150 min on; serve all along.
    await heartbeat('worker', at(-10), at(120), at(120))
    await heartbeat('worker', at(150) + 5_000, now)
    await heartbeat('serve', at(-10), now)
    const history = await readHealthHistory(serve, {
      targetId: target,
      state: 'active',
      stateChangedAt: iso(t0),
      from: new Date(t0),
      to: new Date(now),
    })
    const gaps = history.gaps.map((g) => ({
      cause: g.cause,
      reason: g.reason,
      from: g.from,
      to: g.to,
    }))
    expect(gaps).toHaveLength(3)
    // 60-90 min: a worker was alive and wrote nothing.
    expect(gaps[0]).toMatchObject({ cause: 'sampler_lagging', reason: null })
    expect(Date.parse(gaps[0]?.from ?? '')).toBe(at(60) - 15_000)
    expect(Date.parse(gaps[0]?.to ?? '')).toBe(at(90))
    // 120-150 min: no worker; serve was.
    expect(gaps[1]).toMatchObject({ cause: 'control_plane_down', reason: 'no_live_worker' })
    // After the last sample: the worker is alive, the sampler is not writing.
    expect(gaps[2]).toMatchObject({ cause: 'sampler_lagging', reason: null })
    expect(Date.parse(gaps[2]?.from ?? '')).toBe(at(175) - 15_000)
    expect(history.gapsTruncated).toBe(false)
    for (const g of history.gaps) {
      expect(g.durationSeconds).toBeGreaterThanOrEqual(30)
    }
  })

  it('clips a gap to the range asked for and finds none before the first sample', async () => {
    const history = await readHealthHistory(serve, {
      targetId: target,
      state: 'active',
      stateChangedAt: iso(t0),
      from: new Date(t0 - HOUR),
      to: new Date(t0 + 75 * MIN),
    })
    expect(history.firstSampleAt).toBe(iso(t0))
    // Nothing between the start of the range and the first sample; the gap at 60 min ends inside the range.
    expect(history.gaps).toHaveLength(1)
    expect(history.gaps[0]?.to).toBe(iso(t0 + 75 * MIN))
    expect(Date.parse(history.gaps[0]?.from ?? '')).toBe(t0 + 60 * MIN - 15_000)
  })

  it('reports a gap that began before the range as far as the range goes', async () => {
    const history = await readHealthHistory(serve, {
      targetId: target,
      state: 'active',
      stateChangedAt: iso(t0),
      from: new Date(t0 + 65 * MIN),
      to: new Date(t0 + 80 * MIN),
    })
    expect(history.buckets).toEqual([])
    expect(history.gaps).toHaveLength(1)
    expect(history.gaps[0]).toMatchObject({
      from: iso(t0 + 65 * MIN),
      to: iso(t0 + 80 * MIN),
      cause: 'sampler_lagging',
    })
  })

  it('does not call the end of sampling a gap once the target is decommissioned', async () => {
    const stopped = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y04'
    await samples(stopped, now - 2 * HOUR, now - HOUR)
    const history = await readHealthHistory(serve, {
      targetId: stopped,
      state: 'decommissioned',
      stateChangedAt: iso(now - HOUR),
      from: new Date(now - 3 * HOUR),
      to: new Date(now),
    })
    expect(history.gaps).toEqual([])
    const active = await readHealthHistory(serve, {
      targetId: stopped,
      state: 'active',
      stateChangedAt: iso(now - 3 * HOUR),
      from: new Date(now - 3 * HOUR),
      to: new Date(now),
    })
    // Still sampled, it has a gap to now; the heartbeats of the earlier cases split it where
    // no worker was alive (the hour's second half) and where one was.
    expect(active.gaps.map((g) => g.cause)).toEqual(['control_plane_down', 'sampler_lagging'])
  })

  it('says unknown, with the reason, where the heartbeats that could explain a gap are gone', async () => {
    const old = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y05'
    const base = now - 50 * HOUR
    await samples(old, base, base + HOUR)
    await samples(old, base + 2 * HOUR, base + 3 * HOUR)
    const history = await readHealthHistory(serve, {
      targetId: old,
      state: 'active',
      stateChangedAt: iso(base),
      from: new Date(base),
      to: new Date(base + 3 * HOUR),
    })
    expect(history.gaps).toHaveLength(1)
    expect(history.gaps[0]).toMatchObject({ cause: 'unknown', reason: 'heartbeats_pruned' })
  })
})
