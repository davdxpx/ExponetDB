import type {
  HealthCondition,
  HealthSummary,
  ProbeResult,
  TargetHealth,
} from '@exponetdb/contracts'
import {
  type ControlStore,
  ControlStoreError,
  type Queryable,
  type Row,
} from '@exponetdb/control-store'
import { isJsonObject, type JsonObject, newId } from '@exponetdb/kernel'
import {
  probeExtended,
  probeSimple,
  readActivity,
  readCapacity,
  TargetError,
} from '@exponetdb/postgres'
import {
  brand,
  type Connector,
  type EndpointRecord,
  listEndpoints,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
import { openFindings, recordFinding, resolveFinding } from './findings.ts'
import { checkIdentity, mismatchField } from './identity.ts'
import {
  DEFAULT_THRESHOLDS,
  type EndpointSample,
  type HealthResult,
  type HealthSample,
  type IdentitySample,
  type ReadSample,
  reduceHealth,
  type Thresholds,
} from './reducer.ts'

/**
 * The health sampler ([health.md §2, §4, §6, §7](../../../exponetdb-docs/10-observability/health.md),
 * order §128 to §136), run by the worker every 15 seconds per active or
 * suspended target:
 *
 * - every registered endpoint is a client path and is probed on its own
 *   observer session, opened over the simple protocol so a path whose
 *   extended protocol hangs still opens: `SELECT 1` (simple) and
 *   `SELECT $1::int` (extended), each with its deadline;
 * - one separate diagnostic session on a direct path reads the identity
 *   marker, the capacity settings and the activity summary, each on its
 *   own: a read that fails is recorded as failed with its class, never as
 *   zero sessions;
 * - the pure reducer turns the sample into a state with named conditions;
 *   the worker replaces the latest status and appends the raw sample to
 *   its daily partition;
 * - an identity mismatch opens a critical finding and plans the target's
 *   suspension through the Operations Engine (nothing is re-stamped);
 *   plaintext client connections open a security finding.
 *
 * Pages and API reads never probe: they read the latest status
 * ({@link targetHealth}), which says how old it is.
 */
export interface HealthDeps {
  /** The worker's Control Store login. */
  readonly store: ControlStore
  /** The worker's connector. */
  readonly connector: Connector
  readonly installationId: string
  readonly thresholds?: Thresholds
  /** Deadline of each probe (default 5 s, health.md §2). */
  readonly probeDeadlineMs?: number
  /** Plans the system suspension of a target on an identity mismatch (registry). */
  readonly suspend: (targetId: string, observed: JsonObject) => Promise<unknown>
}

export interface HealthObservation {
  readonly targetId: string
  readonly observedAt: string
  readonly result: HealthResult
  /** Whether a suspension was requested in this sample. */
  readonly suspensionRequested: boolean
}

export const SAMPLE_INTERVAL_MS = 15_000

const errorClass = (error: unknown): string => {
  if (error instanceof TargetError) return error.reason
  if (error instanceof RegistryError) {
    const reason = error.details?.['reason']
    return typeof reason === 'string' ? reason : error.code.toLowerCase()
  }
  return 'internal'
}

async function probeEndpoint(
  deps: HealthDeps,
  target: TargetRecord,
  endpoint: EndpointRecord,
  deadline: number,
): Promise<EndpointSample> {
  const base = { endpointId: endpoint.endpointId, kind: endpoint.kind, label: endpoint.label }
  const placement = target.placement
  if (placement === null) {
    return { ...base, connect: { ok: false, code: 'TARGET_UNAVAILABLE', reason: 'no_placement' } }
  }
  let opened: Awaited<ReturnType<Connector['open']>>
  try {
    opened = await deps.connector.open({
      clusterId: placement.clusterId,
      database: placement.databaseName,
      role: 'observer',
      purpose: `health/${target.targetId}`,
      endpointId: endpoint.endpointId,
      guardProtocol: 'simple',
    })
  } catch (error) {
    if (error instanceof TargetError) {
      return { ...base, connect: { ok: false, code: error.code, reason: error.reason } }
    }
    throw error
  }
  try {
    const simple = await probeSimple(opened.session, deadline)
    const extended = opened.session.usable
      ? await probeExtended(opened.session, deadline)
      : undefined
    return {
      ...base,
      connect: { ok: true },
      simple,
      ...(extended === undefined ? {} : { extended }),
    }
  } finally {
    await opened.session.close()
  }
}

interface DiagnosticReads {
  readonly diagnosticEndpointId: string | null
  readonly identity: IdentitySample
  readonly settings: HealthSample['settings']
  readonly activity: HealthSample['activity']
}

async function read<T>(run: () => Promise<T>): Promise<ReadSample<T>> {
  try {
    return { status: 'ok', value: await run() }
  } catch (error) {
    return { status: 'failed', errorClass: errorClass(error) }
  }
}

/** One separate diagnostic session (direct path) for identity, settings and activity. */
async function diagnosticReads(deps: HealthDeps, target: TargetRecord): Promise<DiagnosticReads> {
  let opened: Awaited<ReturnType<Connector['forTarget']>>
  try {
    opened = await deps.connector.forTarget(target, 'observer', `health/diag/${target.targetId}`)
  } catch (error) {
    const failed = { status: 'failed', errorClass: errorClass(error) } as const
    if (error instanceof TargetError && error.code === 'CLUSTER_IDENTITY_MISMATCH') {
      return {
        diagnosticEndpointId: null,
        identity: { status: 'mismatch', field: 'system_identifier' },
        settings: failed,
        activity: failed,
      }
    }
    if (error instanceof TargetError && error.code === 'TARGET_IDENTITY_MISMATCH') {
      return {
        diagnosticEndpointId: null,
        identity: { status: 'mismatch', field: 'database' },
        settings: failed,
        activity: failed,
      }
    }
    return {
      diagnosticEndpointId: null,
      identity: { status: 'failed', reason: errorClass(error) },
      settings: failed,
      activity: failed,
    }
  }
  try {
    let identity: IdentitySample
    try {
      identity = await checkIdentity(opened.session, target, deps.installationId)
    } catch (error) {
      identity = { status: 'failed', reason: errorClass(error) }
    }
    const settings = opened.session.usable
      ? await read(() => readCapacity(opened.session))
      : ({ status: 'failed', errorClass: 'session_closed' } as const)
    const activity = opened.session.usable
      ? await read(() => readActivity(opened.session))
      : ({ status: 'failed', errorClass: 'session_closed' } as const)
    return { diagnosticEndpointId: opened.endpoint.endpointId, identity, settings, activity }
  } finally {
    await opened.session.close()
  }
}

/** Takes one health sample of a target (probes and reads only; nothing is written to it). */
export async function takeHealthSample(
  deps: HealthDeps,
  target: TargetRecord,
): Promise<HealthSample> {
  const observedAt = new Date().toISOString()
  const lifecycle = target.state
  const placement = target.placement
  if (placement === null) {
    return {
      lifecycle,
      unavailable: 'no_placement',
      endpoints: [],
      diagnosticEndpointId: null,
      identity: { status: 'not_run' },
      settings: { status: 'not_run' },
      activity: { status: 'not_run' },
      observedAt,
    }
  }
  const deadline = deps.probeDeadlineMs ?? 5000
  const endpoints = await listEndpoints(deps.store, placement.clusterId, 'active')
  let samples: EndpointSample[]
  let diagnostics: DiagnosticReads
  try {
    ;[samples, diagnostics] = await Promise.all([
      Promise.all(endpoints.map((e) => probeEndpoint(deps, target, e, deadline))),
      diagnosticReads(deps, target),
    ])
  } catch (error) {
    // ExponetDB itself cannot probe (no observer credential, no usable endpoint).
    if (error instanceof RegistryError) {
      return {
        lifecycle,
        unavailable: errorClass(error),
        endpoints: [],
        diagnosticEndpointId: null,
        identity: { status: 'not_run' },
        settings: { status: 'not_run' },
        activity: { status: 'not_run' },
        observedAt,
      }
    }
    throw error
  }
  return {
    lifecycle,
    endpoints: samples,
    diagnosticEndpointId: diagnostics.diagnosticEndpointId,
    identity: diagnostics.identity,
    settings: diagnostics.settings,
    activity: diagnostics.activity,
    observedAt,
  }
}

const IDENTITY_FINDING = 'health:identity_mismatch'
const PLAINTEXT_FINDING = 'health:plaintext_connections'

function identityObserved(sample: HealthSample): JsonObject | undefined {
  const endpointMismatch = sample.endpoints.find(
    (e) =>
      !e.connect.ok &&
      (e.connect.code === 'CLUSTER_IDENTITY_MISMATCH' ||
        e.connect.code === 'TARGET_IDENTITY_MISMATCH'),
  )
  const s = sample.identity.status
  if (s === 'mismatch' || s === 'absent' || s === 'unreadable') {
    return { field: mismatchField(sample.identity), endpointId: sample.diagnosticEndpointId }
  }
  if (endpointMismatch !== undefined && !endpointMismatch.connect.ok) {
    return {
      field:
        endpointMismatch.connect.code === 'CLUSTER_IDENTITY_MISMATCH'
          ? 'system_identifier'
          : 'database',
      endpointId: endpointMismatch.endpointId,
    }
  }
  return undefined
}

/**
 * Samples a target, records the result (latest status and the raw sample),
 * keeps the health findings current and, on an identity mismatch of an
 * active target, plans its suspension.
 */
export async function sampleTarget(
  deps: HealthDeps,
  target: TargetRecord,
): Promise<HealthObservation | undefined> {
  if (target.state !== 'active' && target.state !== 'suspended') {
    return undefined
  }
  const sample = await takeHealthSample(deps, target)
  const result = reduceHealth(sample, deps.thresholds ?? DEFAULT_THRESHOLDS)
  const mismatch = identityObserved(sample)
  const plaintext =
    sample.activity.status === 'ok' && sample.activity.value.plaintextRemote > 0
      ? sample.activity.value.plaintextRemote
      : 0
  await deps.store.transaction('observation.health.record', async (tx) => {
    await tx.query(
      'observation.health.status',
      `INSERT INTO observation.target_status AS s (target_id, state, conditions, probes, unknown_because, observed_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       ON CONFLICT (target_id) DO UPDATE SET state = EXCLUDED.state, conditions = EXCLUDED.conditions,
         probes = EXCLUDED.probes, unknown_because = EXCLUDED.unknown_because,
         observed_at = EXCLUDED.observed_at, updated_at = clock_timestamp()
       WHERE s.observed_at <= EXCLUDED.observed_at`,
      [
        target.targetId,
        result.state,
        JSON.stringify(result.conditions),
        JSON.stringify(result.probes),
        result.unknownBecause,
        sample.observedAt,
      ],
    )
    await tx
      .savepoint(async (sp) => {
        await sp.query(
          'observation.health.sample',
          `INSERT INTO observation.health_samples (sample_id, target_id, endpoint_id, observed_at, state, probes, conditions)
         VALUES ($1, $2, NULL, $3, $4, $5::jsonb, $6::jsonb)`,
          [
            newId('smp', Date.now()),
            target.targetId,
            sample.observedAt,
            result.state,
            JSON.stringify(result.probes),
            JSON.stringify(result.conditions),
          ],
        )
      })
      .catch((error: unknown) => {
        // No partition for this day yet (the worker creates them ahead): the latest
        // status is still recorded; the history has a gap, which reads as a gap.
        if (!(error instanceof ControlStoreError && error.sqlstate === '23514')) throw error
      })
    const open = await openFindings(tx, target.targetId, 'health')
    const openKey = (key: string) => open.find((f) => f.dedupKey === key)
    if (mismatch !== undefined) {
      await recordFinding(tx, {
        targetId: target.targetId,
        kind: 'health',
        code: 'identity_mismatch',
        severity: 'critical',
        dedupKey: IDENTITY_FINDING,
        summary:
          'The database behind this target no longer carries its identity marker; writes are stopped until a person resolves it.',
        details: { ...mismatch, securityRelevant: true, object: null },
      })
    } else if (sample.identity.status === 'match') {
      const f = openKey(IDENTITY_FINDING)
      if (f !== undefined) await resolveFinding(tx, f.findingId, 'cleared', null)
    }
    if (plaintext > 0) {
      await recordFinding(tx, {
        targetId: target.targetId,
        kind: 'health',
        code: 'plaintext_connections',
        severity: 'warning',
        dedupKey: PLAINTEXT_FINDING,
        summary: 'Clients connect to this database from other hosts without TLS.',
        details: { count: plaintext, securityRelevant: true, object: null },
      })
    } else if (sample.activity.status === 'ok') {
      const f = openKey(PLAINTEXT_FINDING)
      if (f !== undefined) await resolveFinding(tx, f.findingId, 'cleared', null)
    }
  })
  let suspensionRequested = false
  if (mismatch !== undefined && target.state === 'active') {
    await deps.suspend(target.targetId, mismatch)
    suspensionRequested = true
  }
  return { targetId: target.targetId, observedAt: sample.observedAt, result, suspensionRequested }
}

/** Targets the sampler covers: active and suspended ones with a placement. */
export async function targetsToSample(q: Queryable): Promise<string[]> {
  const { rows } = await q.query(
    'observation.health.targets',
    `SELECT t.target_id FROM registry.targets t
      WHERE t.state IN ('active', 'suspended')
        AND EXISTS (SELECT FROM registry.placements p WHERE p.target_id = t.target_id AND p.valid_to IS NULL)
      ORDER BY t.target_id`,
  )
  return rows.map((r) => r.text('target_id'))
}

/** Creates the next days' sample partitions and drops expired ones (data-retention.md §2). */
export async function maintainSamplePartitions(
  worker: Queryable,
  retentionDays = 14,
): Promise<{ readonly created: number; readonly dropped: number }> {
  const created = await worker.query(
    'observation.health.partitions.ensure',
    'SELECT observation.ensure_sample_partitions(2) AS n',
  )
  const dropped = await worker.query(
    'observation.health.partitions.drop',
    'SELECT observation.drop_expired_sample_partitions($1) AS n',
    [retentionDays],
  )
  return { created: created.rows[0]?.int('n') ?? 0, dropped: dropped.rows[0]?.int('n') ?? 0 }
}

// ----- reads (serve): the latest status, with its age -----

export interface StatusRecord {
  readonly targetId: string
  readonly state: TargetHealth['state']
  readonly conditions: HealthCondition[]
  readonly probes: ProbeResult[]
  readonly unknownBecause: string | null
  readonly observedAt: string
  readonly ageMs: number
}

const HEALTH_STATES: readonly TargetHealth['state'][] = [
  'healthy',
  'degraded',
  'unhealthy',
  'unreachable',
  'unknown',
  'suspended',
]

function statusFrom(row: Row): StatusRecord {
  const state = row.text('state')
  const conditions = row.json('conditions')
  const probes = row.json('probes')
  return {
    targetId: row.text('target_id'),
    state: (HEALTH_STATES as readonly string[]).includes(state)
      ? (state as TargetHealth['state'])
      : 'unknown',
    conditions: Array.isArray(conditions)
      ? (conditions.filter(isJsonObject) as unknown as HealthCondition[])
      : [],
    probes: Array.isArray(probes) ? (probes.filter(isJsonObject) as unknown as ProbeResult[]) : [],
    unknownBecause: row.textOrNull('unknown_because'),
    observedAt: row.text('observed_at'),
    ageMs: Math.max(0, Math.round(Number(row.text('age_ms')))),
  }
}

export async function readStatuses(
  q: Queryable,
  targetIds: readonly string[],
): Promise<Map<string, StatusRecord>> {
  if (targetIds.length === 0) return new Map()
  const { rows } = await q.query(
    'observation.health.read',
    `SELECT s.target_id, s.state, s.conditions, s.probes, s.unknown_because,
            to_char(s.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
            (extract(epoch FROM clock_timestamp() - s.observed_at) * 1000)::bigint::text AS age_ms
       FROM observation.target_status s WHERE s.target_id = ANY($1::text[])`,
    [[...targetIds]],
  )
  return new Map(rows.map((r) => [r.text('target_id'), statusFrom(r)]))
}

/** Older than two sampling intervals: served as `cached` (stale), never as a fresh sample. */
export const STALE_AFTER_MS = 2 * SAMPLE_INTERVAL_MS
/** Older than eight intervals: the sampler is lagging and the state is `unknown`. */
export const LAGGING_AFTER_MS = 8 * SAMPLE_INTERVAL_MS

export function healthSummary(status: StatusRecord | undefined): HealthSummary | null {
  if (status === undefined) return null
  if (status.ageMs > LAGGING_AFTER_MS) {
    return { state: 'unknown', source: 'cached', observedAt: status.observedAt }
  }
  return {
    state: status.state,
    source: status.ageMs > STALE_AFTER_MS ? 'cached' : 'sampled',
    observedAt: status.observedAt,
  }
}

/** The health of a target as the latest sample shows it (health.md §1, §9). */
export function targetHealthView(
  target: TargetRecord,
  status: StatusRecord | undefined,
  now: string = new Date().toISOString(),
): TargetHealth {
  const base = {
    targetId: brand('tgt', target.targetId),
    lifecycle: target.state,
    node: null,
    backups: null,
  }
  if (status === undefined) {
    return {
      ...base,
      state: 'unknown',
      source: 'inferred',
      observedAt: now,
      conditions: [],
      unknownBecause: 'never_sampled',
      probes: [],
    }
  }
  const lagging = status.ageMs > LAGGING_AFTER_MS
  return {
    ...base,
    state: lagging ? 'unknown' : status.state,
    source: status.ageMs > STALE_AFTER_MS ? 'cached' : 'sampled',
    observedAt: status.observedAt,
    conditions: status.conditions,
    unknownBecause: lagging ? 'sampler_lagging' : status.unknownBecause,
    probes: status.probes,
  }
}
