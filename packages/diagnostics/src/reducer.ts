import type { HealthCondition, ProbeResult, TargetHealthState } from '@exponetdb/contracts'
import type { ActivitySummary, CapacitySettings, ProbeOutcome } from '@exponetdb/postgres'

/**
 * The health reducer ([health.md §1, §3, §4](../../../exponetdb-docs/10-observability/health.md)):
 * a pure function from one sample (probes per endpoint, identity, settings,
 * activity, the registry lifecycle) to a state and named conditions. No
 * clock, no I/O: the same sample always gives the same answer, and every
 * rule is a table test.
 *
 * - Every endpoint is a client path and is judged separately: a path whose
 *   simple probe fails is down; a path where `SELECT 1` works but the
 *   extended protocol fails, hangs or is more than ten times slower is the
 *   2026-09-24 signature (`extended_protocol_failing`).
 * - All paths down → `unreachable`; some down → `unhealthy`. A broken pooler
 *   is never averaged away by a working direct path.
 * - A read that failed is a condition, never an empty result: an unreadable
 *   activity view means "could not see", so the target cannot be healthy.
 * - An identity marker that is missing, unreadable or names something else
 *   is `identity_mismatch`; a suspended target is shown `suspended` with its
 *   conditions, reachable or not.
 */
export type EndpointKind = 'private' | 'public' | 'local_socket' | 'pooler'

export interface EndpointSample {
  readonly endpointId: string
  readonly kind: EndpointKind
  readonly label: string
  /** The connection itself: verified TLS and guards, or the failure before any probe. */
  readonly connect:
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string; readonly reason: string }
  readonly simple?: ProbeOutcome
  readonly extended?: ProbeOutcome
}

export type IdentitySample =
  | { readonly status: 'match' }
  | {
      readonly status: 'mismatch'
      readonly field: 'installation' | 'target' | 'generation' | 'system_identifier' | 'database'
    }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'not_run' }

export type ReadSample<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly errorClass: string }
  | { readonly status: 'not_run' }

export interface HealthSample {
  readonly lifecycle: 'registered' | 'active' | 'suspended' | 'decommissioned'
  /**
   * Set when ExponetDB could not probe at all for a reason of its own (no
   * observer credential, no endpoint): the state is `unknown` with this
   * reason, never `unreachable` (the database may be fine).
   */
  readonly unavailable?: string
  readonly endpoints: readonly EndpointSample[]
  /** The endpoint the identity, settings and activity reads ran on (a reachable direct path). */
  readonly diagnosticEndpointId: string | null
  readonly identity: IdentitySample
  readonly settings: ReadSample<CapacitySettings>
  readonly activity: ReadSample<ActivitySummary>
  readonly observedAt: string
}

export interface Thresholds {
  readonly connectionsHigh: number
  readonly connectionsCritical: number
  readonly idleInTransactionCriticalSeconds: number
  readonly longRunningCriticalSeconds: number
  readonly xidAgeWarning: number
  readonly xidAgeCritical: number
  /** Extended protocol this many times slower than simple counts as failing. */
  readonly extendedSlowdown: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  connectionsHigh: 0.75,
  connectionsCritical: 0.9,
  idleInTransactionCriticalSeconds: 300,
  longRunningCriticalSeconds: 300,
  xidAgeWarning: 500_000_000,
  xidAgeCritical: 1_200_000_000,
  extendedSlowdown: 10,
}

export interface HealthResult {
  readonly state: TargetHealthState
  readonly conditions: HealthCondition[]
  readonly unknownBecause: string | null
  readonly probes: ProbeResult[]
}

/** What a condition does to the state (health.md §3). */
type Effect = 'none' | 'degraded' | 'unhealthy' | 'unreachable'
const RANK: Readonly<Record<Effect, number>> = {
  none: 0,
  degraded: 1,
  unhealthy: 2,
  unreachable: 3,
}

const isDown = (o: ProbeOutcome | undefined) => o === undefined || o.status !== 'ok'

function pathDown(e: EndpointSample): boolean {
  return !e.connect.ok || isDown(e.simple)
}

function extendedFailing(e: EndpointSample, t: Thresholds): boolean {
  if (!e.connect.ok || e.simple?.status !== 'ok') return false
  if (e.extended === undefined || e.extended.status !== 'ok') return true
  return e.extended.durationMs > Math.max(e.simple.durationMs, 5) * t.extendedSlowdown
}

function errorClass(o: ProbeOutcome | undefined, e: EndpointSample): string | null {
  if (!e.connect.ok) return `${e.connect.code.toLowerCase()}`.slice(0, 64)
  if (o === undefined) return 'not_run'
  return o.status === 'failed' ? o.code.toLowerCase().slice(0, 64) : null
}

function probeResult(
  probe: ProbeResult['probe'],
  e: EndpointSample,
  o: ProbeOutcome | undefined,
  observedAt: string,
): ProbeResult {
  const outcome = !e.connect.ok ? 'failed' : o === undefined ? 'failed' : o.status
  return {
    probe,
    endpoint: {
      id: e.endpointId as ProbeResult['endpoint']['id'],
      kind: e.kind,
      label: e.label,
      verified: e.connect.ok,
    },
    outcome,
    // A timeout is not a duration.
    durationMs: o !== undefined && e.connect.ok && o.status !== 'timeout' ? o.durationMs : null,
    errorClass: outcome === 'ok' ? null : errorClass(o, e),
    tls: e.connect.ok
      ? 'verified'
      : e.connect.code === 'TARGET_TLS_FAILED'
        ? 'failed'
        : e.connect.code === 'TARGET_UNAVAILABLE'
          ? 'not_reached'
          : 'verified',
    observedAt,
  }
}

function readProbe(
  probe: 'identity' | 'activity' | 'settings',
  endpoint: EndpointSample | undefined,
  outcome: 'ok' | 'failed' | 'timeout',
  errorClassValue: string | null,
  observedAt: string,
): ProbeResult | undefined {
  if (endpoint === undefined) return undefined
  return {
    probe,
    endpoint: {
      id: endpoint.endpointId as ProbeResult['endpoint']['id'],
      kind: endpoint.kind,
      label: endpoint.label,
      verified: endpoint.connect.ok,
    },
    outcome,
    durationMs: null,
    errorClass: errorClassValue,
    tls: 'verified',
    observedAt,
  }
}

export function reduceHealth(
  sample: HealthSample,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): HealthResult {
  const at = sample.observedAt
  const conditions: HealthCondition[] = []
  let effect: Effect = 'none'
  const raise = (e: Effect) => {
    if (RANK[e] > RANK[effect]) effect = e
  }
  const add = (
    condition: string,
    severity: HealthCondition['severity'],
    e: Effect,
    extra: {
      count?: number | null
      endpointId?: string
      values?: Record<string, number | boolean | null>
    } = {},
  ) => {
    conditions.push({
      condition,
      severity,
      count: extra.count ?? null,
      ...(extra.endpointId === undefined
        ? {}
        : { endpointId: extra.endpointId as HealthCondition['endpointId'] }),
      ...(extra.values === undefined ? {} : { values: extra.values }),
      observedAt: at,
    })
    raise(e)
  }

  const probes: ProbeResult[] = []
  for (const e of sample.endpoints) {
    probes.push(probeResult('simple', e, e.simple, at))
    probes.push(probeResult('extended', e, e.extended, at))
  }

  if (sample.unavailable !== undefined || sample.endpoints.length === 0) {
    return {
      state: 'unknown',
      conditions,
      unknownBecause: sample.unavailable ?? 'no_endpoint',
      probes,
    }
  }

  // 1. Can we reach it, on every path real clients use?
  const down = sample.endpoints.filter(pathDown)
  for (const e of down) {
    add('probe_simple_failed', 'critical', 'unhealthy', {
      endpointId: e.endpointId,
      values: { tlsFailed: !e.connect.ok && e.connect.code === 'TARGET_TLS_FAILED' },
    })
  }
  if (down.length === sample.endpoints.length) {
    raise('unreachable')
  }
  // 2. Does it answer correctly (not just SELECT 1)?
  for (const e of sample.endpoints) {
    if (extendedFailing(e, thresholds)) {
      add('extended_protocol_failing', 'critical', 'unhealthy', {
        endpointId: e.endpointId,
        values: {
          simpleMs: e.simple?.status === 'ok' ? e.simple.durationMs : null,
          extendedTimedOut: e.extended?.status === 'timeout',
        },
      })
    }
  }
  const diagnostic = sample.endpoints.find((e) => e.endpointId === sample.diagnosticEndpointId)
  let identityMismatch = false
  // An address that now reaches another cluster or another database (C-27, order §173).
  for (const e of sample.endpoints) {
    if (
      !e.connect.ok &&
      (e.connect.code === 'CLUSTER_IDENTITY_MISMATCH' ||
        e.connect.code === 'TARGET_IDENTITY_MISMATCH')
    ) {
      identityMismatch = true
      add('identity_mismatch', 'critical', 'unhealthy', {
        endpointId: e.endpointId,
        values: { systemIdentifier: e.connect.code === 'CLUSTER_IDENTITY_MISMATCH' },
      })
    }
  }
  switch (sample.identity.status) {
    case 'match': {
      const p = readProbe('identity', diagnostic, 'ok', null, at)
      if (p !== undefined) probes.push(p)
      break
    }
    case 'mismatch':
    case 'absent':
    case 'unreadable': {
      identityMismatch = true
      add('identity_mismatch', 'critical', 'unhealthy', {
        values: {
          markerAbsent: sample.identity.status === 'absent',
          markerUnreadable: sample.identity.status === 'unreadable',
          systemIdentifier:
            sample.identity.status === 'mismatch' && sample.identity.field === 'system_identifier',
        },
      })
      const p = readProbe('identity', diagnostic, 'failed', 'identity_mismatch', at)
      if (p !== undefined) probes.push(p)
      break
    }
    case 'failed': {
      add('identity_unverified', 'warning', 'degraded')
      const p = readProbe('identity', diagnostic, 'failed', sample.identity.reason.slice(0, 64), at)
      if (p !== undefined) probes.push(p)
      break
    }
    case 'not_run':
      break
  }

  // 3. Is anything stuck or about to break?
  if (sample.settings.status === 'failed') {
    add('settings_unreadable', 'warning', 'degraded')
    const p = readProbe('settings', diagnostic, 'failed', sample.settings.errorClass, at)
    if (p !== undefined) probes.push(p)
  } else if (sample.settings.status === 'ok') {
    const p = readProbe('settings', diagnostic, 'ok', null, at)
    if (p !== undefined) probes.push(p)
  }
  if (sample.activity.status === 'failed') {
    // Could not read sessions: this does not mean nothing is stuck.
    add('activity_unreadable', 'warning', 'degraded')
    const p = readProbe('activity', diagnostic, 'failed', sample.activity.errorClass, at)
    if (p !== undefined) probes.push(p)
  } else if (sample.activity.status === 'ok') {
    const a = sample.activity.value
    const p = readProbe('activity', diagnostic, 'ok', null, at)
    if (p !== undefined) probes.push(p)
    if (sample.settings.status === 'ok') {
      const usable = sample.settings.value.usableSlots
      const ratio = usable === 0 ? Number.POSITIVE_INFINITY : a.clientBackends / usable
      const values = { clientBackends: a.clientBackends, usableSlots: usable }
      if (usable === 0 || ratio >= thresholds.connectionsCritical) {
        add('connections_critical', 'critical', 'unhealthy', { count: a.clientBackends, values })
      } else if (ratio >= thresholds.connectionsHigh) {
        add('connections_high', 'warning', 'degraded', { count: a.clientBackends, values })
      }
    }
    // Counts are exact (from SQL); a list shorter than its count is `truncated` (C-28).
    const listed = (count: number, list: readonly unknown[]) => ({ truncated: count > list.length })
    if (a.counts.stalled > 0) {
      add('stalled_sessions', 'warning', 'degraded', {
        count: a.counts.stalled,
        values: listed(a.counts.stalled, a.stalled),
      })
    }
    if (a.counts.idleInTransactionLong > 0) {
      const oldest = a.oldestIdleInTransactionSeconds ?? 0
      const critical = oldest >= thresholds.idleInTransactionCriticalSeconds
      add(
        'idle_in_transaction',
        critical ? 'critical' : 'warning',
        critical ? 'unhealthy' : 'degraded',
        {
          count: a.counts.idleInTransactionLong,
          values: {
            oldestSeconds: oldest,
            ...listed(a.counts.idleInTransactionLong, a.idleInTransactionLong),
          },
        },
      )
    }
    if (a.counts.longRunning > 0) {
      const oldest = a.oldestLongRunningSeconds ?? 0
      add(
        'long_running',
        oldest >= thresholds.longRunningCriticalSeconds ? 'critical' : 'warning',
        'degraded',
        {
          count: a.counts.longRunning,
          values: { oldestSeconds: oldest, ...listed(a.counts.longRunning, a.longRunning) },
        },
      )
    }
    if (a.counts.lockWaits > 0) {
      add('lock_waits', 'warning', 'degraded', {
        count: a.counts.lockWaits,
        values: listed(a.counts.lockWaits, a.lockWaits),
      })
    }
    if (a.xidAge >= thresholds.xidAgeCritical) {
      add('xid_age_high', 'critical', 'unhealthy', { values: { xidAge: a.xidAge } })
    } else if (a.xidAge >= thresholds.xidAgeWarning) {
      add('xid_age_high', 'warning', 'degraded', { values: { xidAge: a.xidAge } })
    }
    if (a.plaintextRemote > 0) {
      add('plaintext_connections', 'warning', 'none', { count: a.plaintextRemote })
    }
  }

  const byEffect: Record<Effect, TargetHealthState> = {
    none: 'healthy',
    degraded: 'degraded',
    unhealthy: 'unhealthy',
    unreachable: 'unreachable',
  }
  const state: TargetHealthState =
    identityMismatch || sample.lifecycle === 'suspended' ? 'suspended' : byEffect[effect]
  return { state, conditions, unknownBecause: null, probes }
}
