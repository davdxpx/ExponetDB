import type { ActivitySummary, CapacitySettings, SessionNote } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  type EndpointSample,
  type HealthSample,
  reduceHealth,
  type StatusRecord,
  targetHealthView,
} from '../src/index.ts'

/**
 * The health reducer as table tests (health.md §1, §3, §4, §6; order §129
 * to §135). Every rule is checked on a sample built here: no clock, no
 * database, the same input always gives the same output.
 */
const AT = '2026-10-06T12:00:00.000Z'
const DIRECT = 'end_01M48WRFNFYAY62E1146END001'
const POOLER = 'end_01M48WRFNFYAY62E1146END002'

const ok = (durationMs = 2) => ({ status: 'ok', durationMs }) as const
const timeout = (durationMs = 5000) => ({ status: 'timeout', durationMs }) as const

const direct = (over: Partial<EndpointSample> = {}): EndpointSample => ({
  endpointId: DIRECT,
  kind: 'private',
  label: 'direct',
  connect: { ok: true },
  simple: ok(),
  extended: ok(),
  ...over,
})
const pooler = (over: Partial<EndpointSample> = {}): EndpointSample => ({
  endpointId: POOLER,
  kind: 'pooler',
  label: 'pooler',
  connect: { ok: true },
  simple: ok(),
  extended: ok(),
  ...over,
})

const settings: CapacitySettings = {
  maxConnections: 100,
  superuserReserved: 3,
  reserved: 0,
  serverVersionNum: 170004,
  usableSlots: 97,
}

const note = (over: Partial<SessionNote> = {}): SessionNote => ({
  pid: 4242,
  backendStart: '2026-10-06 11:00:00+00',
  user: 'app',
  applicationName: 'app',
  state: 'active',
  waitEventType: null,
  waitEvent: null,
  queryAgeSeconds: 0,
  transactionAgeSeconds: 0,
  stateAgeSeconds: 0,
  blockedBy: [],
  ...over,
})

/** An activity summary; unless given, the exact counts and oldest ages follow the lists. */
const activity = (over: Partial<ActivitySummary> = {}): ActivitySummary => {
  const stalled = over.stalled ?? []
  const idleInTransactionLong = over.idleInTransactionLong ?? []
  const longRunning = over.longRunning ?? []
  const lockWaits = over.lockWaits ?? []
  const oldest = (list: readonly SessionNote[], pick: (n: SessionNote) => number | null) =>
    list.length === 0 ? null : Math.max(...list.map((n) => pick(n) ?? 0))
  return {
    clientBackends: 10,
    active: 2,
    idleInTransaction: 0,
    plaintextRemote: 0,
    xidAge: 1000,
    truncated: false,
    ...over,
    stalled,
    idleInTransactionLong,
    longRunning,
    lockWaits,
    counts: over.counts ?? {
      stalled: stalled.length,
      idleInTransactionLong: idleInTransactionLong.length,
      longRunning: longRunning.length,
      lockWaits: lockWaits.length,
    },
    oldestIdleInTransactionSeconds:
      over.oldestIdleInTransactionSeconds ??
      oldest(idleInTransactionLong, (n) => n.stateAgeSeconds),
    oldestLongRunningSeconds:
      over.oldestLongRunningSeconds ?? oldest(longRunning, (n) => n.queryAgeSeconds),
  }
}

const sample = (over: Partial<HealthSample> = {}): HealthSample => ({
  lifecycle: 'active',
  endpoints: [direct()],
  diagnosticEndpointId: DIRECT,
  identity: { status: 'match' },
  settings: { status: 'ok', value: settings },
  activity: { status: 'ok', value: activity() },
  observedAt: AT,
  ...over,
})

const names = (s: HealthSample) => reduceHealth(s).conditions.map((c) => c.condition)

describe('state and conditions', () => {
  it('is healthy only when every path answers both protocols and every read succeeded', () => {
    const r = reduceHealth(sample({ endpoints: [direct(), pooler()] }))
    expect(r.state).toBe('healthy')
    expect(r.conditions).toEqual([])
    expect(r.unknownBecause).toBeNull()
    // Both protocols on both paths, plus the three reads on the diagnostic path.
    expect(r.probes.map((p) => `${p.probe}@${p.endpoint.id}`)).toEqual([
      `simple@${DIRECT}`,
      `extended@${DIRECT}`,
      `simple@${POOLER}`,
      `extended@${POOLER}`,
      `identity@${DIRECT}`,
      `settings@${DIRECT}`,
      `activity@${DIRECT}`,
    ])
  })

  it('is never healthy when SELECT 1 works but the extended protocol hangs (the 2026-09-24 signature)', () => {
    const r = reduceHealth(sample({ endpoints: [direct(), pooler({ extended: timeout(800) })] }))
    expect(r.state).toBe('unhealthy')
    expect(r.conditions).toEqual([
      expect.objectContaining({
        condition: 'extended_protocol_failing',
        severity: 'critical',
        endpointId: POOLER,
        values: { simpleMs: 2, extendedTimedOut: true },
      }),
    ])
    const extended = r.probes.find((p) => p.probe === 'extended' && p.endpoint.id === POOLER)
    // A timeout is not a duration.
    expect(extended).toMatchObject({ outcome: 'timeout', durationMs: null })
  })

  it('counts an extended protocol more than ten times slower than simple as failing', () => {
    expect(names(sample({ endpoints: [direct({ simple: ok(10), extended: ok(101) })] }))).toEqual([
      'extended_protocol_failing',
    ])
    expect(names(sample({ endpoints: [direct({ simple: ok(10), extended: ok(100) })] }))).toEqual(
      [],
    )
    // A very fast simple probe does not make ordinary latency look like a failure.
    expect(names(sample({ endpoints: [direct({ simple: ok(0), extended: ok(40) })] }))).toEqual([])
  })

  it('keeps a broken pooler visible beside a working direct path, and calls all paths down unreachable', () => {
    const one = reduceHealth(
      sample({
        endpoints: [
          direct(),
          pooler({ connect: { ok: false, code: 'TARGET_UNAVAILABLE', reason: 'connect_refused' } }),
        ],
      }),
    )
    expect(one.state).toBe('unhealthy')
    expect(one.conditions).toEqual([
      expect.objectContaining({ condition: 'probe_simple_failed', endpointId: POOLER }),
    ])
    expect(one.probes.find((p) => p.endpoint.id === POOLER)).toMatchObject({
      outcome: 'failed',
      errorClass: 'target_unavailable',
      tls: 'not_reached',
    })
    const all = reduceHealth(
      sample({
        endpoints: [
          direct({ connect: { ok: false, code: 'TARGET_TLS_FAILED', reason: 'tls_unverified' } }),
        ],
        diagnosticEndpointId: null,
        identity: { status: 'failed', reason: 'tls_unverified' },
        settings: { status: 'failed', errorClass: 'tls_unverified' },
        activity: { status: 'failed', errorClass: 'tls_unverified' },
      }),
    )
    expect(all.state).toBe('unreachable')
    expect(all.probes[0]).toMatchObject({ tls: 'failed', outcome: 'failed' })
    expect(all.conditions[0]).toMatchObject({
      condition: 'probe_simple_failed',
      values: { tlsFailed: true },
    })
  })

  it('reports an unreadable activity view as a failed read, never as zero sessions', () => {
    const r = reduceHealth(sample({ activity: { status: 'failed', errorClass: 'query_timeout' } }))
    expect(r.state).toBe('degraded')
    expect(r.conditions.map((c) => c.condition)).toEqual(['activity_unreadable'])
    expect(r.probes.find((p) => p.probe === 'activity')).toMatchObject({
      outcome: 'failed',
      errorClass: 'query_timeout',
    })
    // Nothing derived from sessions appears: no connection ratio, no "0 stalled".
    expect(r.conditions.some((c) => c.condition.startsWith('connections_'))).toBe(false)
  })

  it('does not judge capacity without the settings', () => {
    const r = reduceHealth(
      sample({
        settings: { status: 'failed', errorClass: 'insufficient_privilege' },
        activity: { status: 'ok', value: activity({ clientBackends: 96 }) },
      }),
    )
    expect(r.conditions.map((c) => c.condition)).toEqual(['settings_unreadable'])
  })

  it.each([
    [
      { status: 'mismatch', field: 'target' },
      { markerAbsent: false, markerUnreadable: false },
    ],
    [{ status: 'mismatch', field: 'system_identifier' }, { systemIdentifier: true }],
    [{ status: 'absent' }, { markerAbsent: true }],
    [{ status: 'unreadable' }, { markerUnreadable: true }],
  ] as const)(
    'suspends on an identity mismatch (%o) even when every probe passes',
    (identity, values) => {
      const r = reduceHealth(sample({ identity }))
      expect(r.state).toBe('suspended')
      expect(r.conditions).toEqual([
        expect.objectContaining({
          condition: 'identity_mismatch',
          severity: 'critical',
          values: expect.objectContaining(values),
        }),
      ])
    },
  )

  it('suspends when an address now reaches another cluster or another database', () => {
    const r = reduceHealth(
      sample({
        endpoints: [
          direct(),
          pooler({
            connect: { ok: false, code: 'CLUSTER_IDENTITY_MISMATCH', reason: 'system_identifier' },
          }),
        ],
      }),
    )
    expect(r.state).toBe('suspended')
    expect(r.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          condition: 'identity_mismatch',
          endpointId: POOLER,
          values: { systemIdentifier: true },
        }),
      ]),
    )
  })

  it('reports an identity read that failed as unverified, not as a mismatch', () => {
    const r = reduceHealth(sample({ identity: { status: 'failed', reason: 'query_timeout' } }))
    expect(r.state).toBe('degraded')
    expect(r.conditions.map((c) => c.condition)).toEqual(['identity_unverified'])
  })

  it('shows a suspended target as suspended, with what is wrong with it', () => {
    const r = reduceHealth(
      sample({ lifecycle: 'suspended', activity: { status: 'failed', errorClass: 'x' } }),
    )
    expect(r.state).toBe('suspended')
    expect(r.conditions.map((c) => c.condition)).toEqual(['activity_unreadable'])
  })

  it('is unknown, never unreachable, when ExponetDB itself could not probe', () => {
    expect(reduceHealth(sample({ unavailable: 'observer_credential_missing' }))).toMatchObject({
      state: 'unknown',
      unknownBecause: 'observer_credential_missing',
    })
    expect(reduceHealth(sample({ endpoints: [] }))).toMatchObject({
      state: 'unknown',
      unknownBecause: 'no_endpoint',
    })
  })
})

describe('activity and capacity rules (health.md §3)', () => {
  const withActivity = (a: Partial<ActivitySummary>) =>
    reduceHealth(sample({ activity: { status: 'ok', value: activity(a) } }))

  it.each([
    [72, 'healthy', []],
    [73, 'degraded', ['connections_high']],
    [87, 'degraded', ['connections_high']],
    [88, 'unhealthy', ['connections_critical']],
  ] as const)('%i of 97 usable slots is %s', (backends, state, conditions) => {
    const r = withActivity({ clientBackends: backends })
    expect(r.state).toBe(state)
    expect(r.conditions.map((c) => c.condition)).toEqual(conditions)
  })

  it('treats zero usable slots as critical', () => {
    const r = reduceHealth(
      sample({
        settings: { status: 'ok', value: { ...settings, usableSlots: 0 } },
        activity: { status: 'ok', value: activity({ clientBackends: 0 }) },
      }),
    )
    expect(r.conditions).toEqual([
      expect.objectContaining({
        condition: 'connections_critical',
        values: expect.objectContaining({ usableSlots: 0 }),
      }),
    ])
  })

  it('reports exact counts and truncation per condition when the lists are capped (C-28)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => note({ pid: i + 1, queryAgeSeconds: 61 }))
    const r = withActivity({
      stalled: fifty,
      lockWaits: [note({ waitEventType: 'Lock' })],
      idleInTransactionLong: [note({ stateAgeSeconds: 12 })],
      counts: { stalled: 120, idleInTransactionLong: 70, longRunning: 0, lockWaits: 1 },
      // The oldest idle transaction is not among the listed sessions.
      oldestIdleInTransactionSeconds: 900,
      truncated: true,
    })
    const by = (name: string) => r.conditions.find((c) => c.condition === name)
    expect(by('stalled_sessions')).toMatchObject({ count: 120, values: { truncated: true } })
    expect(by('lock_waits')).toMatchObject({ count: 1, values: { truncated: false } })
    expect(by('idle_in_transaction')).toMatchObject({
      severity: 'critical',
      count: 70,
      values: { oldestSeconds: 900, truncated: true },
    })
    expect(by('long_running')).toBeUndefined()
  })

  it('names stalled sessions, lock waits and long-running queries with their counts', () => {
    const r = withActivity({
      stalled: [note({ waitEvent: 'ClientRead', queryAgeSeconds: 61 })],
      lockWaits: [note({ waitEventType: 'Lock', blockedBy: [1] }), note({ pid: 2 })],
      longRunning: [note({ queryAgeSeconds: 40 })],
    })
    expect(r.state).toBe('degraded')
    expect(r.conditions.map((c) => [c.condition, c.severity, c.count])).toEqual([
      ['stalled_sessions', 'warning', 1],
      ['long_running', 'warning', 1],
      ['lock_waits', 'warning', 2],
    ])
  })

  it('makes a long-running query critical at 300 s without making the target unhealthy', () => {
    const r = withActivity({ longRunning: [note({ queryAgeSeconds: 300 })] })
    expect(r.state).toBe('degraded')
    expect(r.conditions[0]).toMatchObject({ condition: 'long_running', severity: 'critical' })
  })

  it('makes idle-in-transaction unhealthy at 300 s', () => {
    expect(withActivity({ idleInTransactionLong: [note({ stateAgeSeconds: 12 })] })).toMatchObject({
      state: 'degraded',
      conditions: [
        expect.objectContaining({ condition: 'idle_in_transaction', severity: 'warning' }),
      ],
    })
    expect(withActivity({ idleInTransactionLong: [note({ stateAgeSeconds: 301 })] })).toMatchObject(
      {
        state: 'unhealthy',
        conditions: [
          expect.objectContaining({ condition: 'idle_in_transaction', severity: 'critical' }),
        ],
      },
    )
  })

  it.each([
    [499_999_999, 'healthy'],
    [500_000_000, 'degraded'],
    [1_200_000_000, 'unhealthy'],
  ] as const)('an xid age of %i is %s', (xidAge, state) => {
    expect(withActivity({ xidAge }).state).toBe(state)
  })

  it('reports plaintext client connections without changing the state', () => {
    const r = withActivity({ plaintextRemote: 3 })
    expect(r.state).toBe('healthy')
    expect(r.conditions).toEqual([
      expect.objectContaining({ condition: 'plaintext_connections', count: 3 }),
    ])
  })

  it('carries numbers and flags only in condition values, never database text', () => {
    const r = withActivity({
      stalled: [note({ applicationName: "'; DROP TABLE x; --", user: 'evil\u0000' })],
      plaintextRemote: 1,
    })
    for (const c of r.conditions) {
      for (const v of Object.values(c.values ?? {})) {
        expect(['number', 'boolean'].includes(typeof v) || v === null).toBe(true)
      }
    }
    expect(JSON.stringify(r)).not.toContain('DROP TABLE')
  })

  it('is deterministic', () => {
    const s = sample({ endpoints: [direct(), pooler({ extended: timeout() })] })
    expect(reduceHealth(s)).toEqual(reduceHealth(s))
    expect(reduceHealth(s, DEFAULT_THRESHOLDS)).toEqual(reduceHealth(s))
  })
})

describe('connection capacity (Wave 8 completion)', () => {
  const stored = (r: ReturnType<typeof reduceHealth>, probe: string) =>
    r.probes.find((p) => p.probe === probe)

  it('stores the measured numbers with the successful settings and activity probes, whatever the thresholds', () => {
    // 10 of 97 slots: no condition, yet the numbers are kept.
    const r = reduceHealth(sample())
    expect(r.conditions).toEqual([])
    expect(stored(r, 'settings')?.values).toEqual({ usableSlots: 97 })
    expect(stored(r, 'activity')?.values).toEqual({ clientBackends: 10 })
  })

  it('stores a measured zero as a zero and none for a read that failed or did not run', () => {
    const zero = reduceHealth(
      sample({
        settings: { status: 'ok', value: { ...settings, usableSlots: 0 } },
        activity: { status: 'ok', value: activity({ clientBackends: 0 }) },
      }),
    )
    expect(stored(zero, 'settings')?.values).toEqual({ usableSlots: 0 })
    expect(stored(zero, 'activity')?.values).toEqual({ clientBackends: 0 })
    const failed = reduceHealth(
      sample({
        settings: { status: 'failed', errorClass: 'insufficient_privilege' },
        activity: { status: 'failed', errorClass: 'query_timeout' },
      }),
    )
    expect(stored(failed, 'settings')?.values).toBeUndefined()
    expect(stored(failed, 'activity')?.values).toBeUndefined()
    const notRun = reduceHealth(
      sample({ settings: { status: 'not_run' }, activity: { status: 'not_run' } }),
    )
    expect(notRun.probes.some((p) => p.values !== undefined)).toBe(false)
  })
})

describe('the health view and its capacity', () => {
  const target = { targetId: 'tgt_01M48WRFNFYAY62E1146TGT001', state: 'active' } as never
  const status = (over: Partial<StatusRecord> = {}): StatusRecord => ({
    targetId: 'tgt_01M48WRFNFYAY62E1146TGT001',
    state: 'healthy',
    conditions: [],
    probes: [],
    unknownBecause: null,
    capacity: { clientBackends: 12, usableSlots: 97 },
    observedAt: AT,
    ageMs: 5_000,
    ...over,
  })

  it('shows the capacity with the time and the source of the sample that measured it', () => {
    expect(targetHealthView(target, status()).capacity).toEqual({
      clientBackends: 12,
      usableSlots: 97,
      source: 'sampled',
      observedAt: AT,
    })
    // A sample older than two intervals is cached, and says so for the numbers as well.
    expect(targetHealthView(target, status({ ageMs: 45_000 })).capacity).toMatchObject({
      source: 'cached',
      observedAt: AT,
    })
  })

  it('has no capacity, not a zero, when the sample measured none or there is no sample', () => {
    const none = targetHealthView(target, status({ capacity: null }))
    expect('capacity' in none).toBe(false)
    const never = targetHealthView(target, undefined)
    expect('capacity' in never).toBe(false)
    expect(never.unknownBecause).toBe('never_sampled')
  })

  it('keeps a measured zero', () => {
    const view = targetHealthView(
      target,
      status({ capacity: { clientBackends: 0, usableSlots: 0 } }),
    )
    expect(view.capacity).toMatchObject({ clientBackends: 0, usableSlots: 0 })
  })
})
