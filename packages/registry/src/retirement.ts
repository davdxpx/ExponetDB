import type { Queryable } from '@exponetdb/control-store'

/**
 * What a retirement of a server or a cluster meets (registry.md §4.4): the records that depend on
 * it and block it, the records the retirement retires with it, and the history that stays. One
 * set of queries serves the preflight read, the planner and the kind's bindings, so the three
 * never disagree; the Control Store's guards decide again under the row lock (bundle
 * `registry-retirement`). Bottom-up and never by cascade: a blocker is retired, decommissioned or
 * finished by its own operation first.
 */

export type DependencyKind =
  | 'cluster'
  | 'node'
  | 'enrollment_token'
  | 'node_job'
  | 'database'
  | 'endpoint'
  | 'credential'
  | 'operation'

export interface Dependency {
  readonly kind: DependencyKind
  readonly id: string
  readonly state: string
  /** A name the record carries (untrusted registry text); null when it has none. */
  readonly label: string | null
  /** A registered database's current placement; null when it has none (and for other kinds). */
  readonly targetId: string | null
}

export interface DependencyGroup {
  readonly kind: DependencyKind
  readonly total: number
  /** At most `GROUP_LIMIT`, by id. */
  readonly items: readonly Dependency[]
}

/** The state of the backup engine's bindings to the subject (a port Wave 9 fills; registry.md §4.4). */
export type BackupBindings = 'not_installed' | 'none' | 'blocking' | 'unknown'

export interface Retirement {
  readonly subjectState: string
  readonly blockers: readonly DependencyGroup[]
  readonly retiredWith: readonly DependencyGroup[]
  readonly retiredChildren: number
  readonly backups: BackupBindings
}

/** Records named per group; the total says how many there are. */
export const GROUP_LIMIT = 50

/** The operation states that are not finished: an operation in one of them blocks a retirement. */
const OPEN_OPERATION_STATES = [
  'awaiting_approval',
  'queued',
  'running',
  'verifying',
  'needs_reconciliation',
  'needs_attention',
] as const

/** The node job states that are not finished (an `outcome_unknown` job is not known to be done). */
const OPEN_JOB_STATES = ['pending', 'dispatched', 'running', 'outcome_unknown'] as const

/**
 * The backup bindings of a subject. Wave 9 Part B replaces this with its engine's answer; until
 * then no backup record exists in the Control Store, so nothing can bind a server or cluster
 * (`not_installed`). A provider that cannot tell answers `unknown`, which blocks. Required
 * wherever a retirement is read, planned or applied: the composition root passes one instance to
 * all three, so the preflight, the planner and the kind never ask different engines.
 */
export type BackupBindingsPort = (
  q: Queryable,
  subject: { readonly kind: 'server' | 'cluster'; readonly id: string },
) => Promise<BackupBindings>

export const noBackupEngine: BackupBindingsPort = async () => 'not_installed'

export interface RetirementOptions {
  /** The retirement's own plan, which does not block itself. */
  readonly exceptPlanId?: string
  readonly backups: BackupBindingsPort
}

/**
 * A token that ran out less than this long ago still blocks a server's retirement: the frozen
 * `nodes.enroll` read the clock before the guard did and may still be inserting its node. The
 * guard of bundle `registry-retirement` uses the same margin, so a clear preflight is never refused
 * for a token alone.
 */
const TOKEN_MARGIN = "interval '5 minutes'"

interface GroupQuery {
  readonly kind: DependencyKind
  readonly name: string
  /** Selects `id`, `state`, `label` and `target_id` of every matching row (unordered, unlimited). */
  readonly sql: string
  readonly params: readonly unknown[]
}

async function group(q: Queryable, query: GroupQuery): Promise<DependencyGroup> {
  const { rows } = await q.query(
    query.name,
    `WITH m AS (${query.sql})
     SELECT id, state, label, target_id, (SELECT count(*) FROM m)::int AS total
       FROM m ORDER BY id LIMIT ${GROUP_LIMIT}`,
    [...query.params],
  )
  const total = rows[0]?.int('total') ?? 0
  return {
    kind: query.kind,
    total,
    items: rows.map((row) => ({
      kind: query.kind,
      id: row.text('id'),
      state: row.text('state'),
      label: row.textOrNull('label'),
      targetId: row.textOrNull('target_id'),
    })),
  }
}

const nonEmpty = (groups: readonly DependencyGroup[]): readonly DependencyGroup[] =>
  groups.filter((g) => g.total > 0)

/**
 * Open operations whose plan names the subject, other than the one of `exceptPlanId` (the
 * retirement itself). A body is parsed only when its text contains the id, and an escaped NUL
 * (`\u0000`, valid JSON that jsonb refuses) is read as U+FFFD first: no stored body, related or
 * not, can make the read fail.
 */
function openOperations(
  kind: 'server' | 'cluster',
  id: string,
  exceptPlanId: string | null,
): GroupQuery {
  return {
    kind: 'operation',
    name: `registry.retirement.${kind}.operations`,
    sql: `SELECT o.operation_id AS id, o.state, o.kind AS label, NULL::text AS target_id
            FROM operations.operations o JOIN operations.plan_bodies b ON b.plan_id = o.plan_id
           WHERE o.state = ANY($2::text[])
             AND CASE WHEN strpos(b.body, $1) > 0
                      THEN replace(b.body, '\\u0000', '\\ufffd')::jsonb -> 'subject'
                             ->> '${kind === 'server' ? 'serverId' : 'clusterId'}'
                 END = $1
             AND o.plan_id IS DISTINCT FROM $3`,
    params: [id, [...OPEN_OPERATION_STATES], exceptPlanId],
  }
}

/** What a retirement of the server meets. `undefined` when the server does not exist. */
export async function serverRetirement(
  q: Queryable,
  serverId: string,
  options: RetirementOptions,
): Promise<Retirement | undefined> {
  const { rows } = await q.query(
    'registry.retirement.server',
    'SELECT state FROM registry.servers WHERE server_id = $1',
    [serverId],
  )
  const state = rows[0]?.text('state')
  if (state === undefined) return undefined
  const blockers = await Promise.all([
    group(q, {
      kind: 'cluster',
      name: 'registry.retirement.server.clusters',
      sql: `SELECT cluster_id AS id, state, display_name AS label, NULL::text AS target_id
              FROM registry.clusters WHERE server_id = $1 AND state <> 'retired'`,
      params: [serverId],
    }),
    group(q, {
      kind: 'node',
      name: 'registry.retirement.server.nodes',
      // binding_failed is terminal and never changes again: it does not block.
      sql: `SELECT node_id AS id, state, NULL::text AS label, NULL::text AS target_id
              FROM nodes.nodes WHERE server_id = $1
               AND state IN ('pending_binding', 'active', 'degraded', 'revoked')`,
      params: [serverId],
    }),
    group(q, {
      kind: 'enrollment_token',
      name: 'registry.retirement.server.tokens',
      sql: `SELECT token_id AS id, state, NULL::text AS label, NULL::text AS target_id
              FROM nodes.enrollment_tokens WHERE server_id = $1
               AND ((state = 'created' AND reveal_until > clock_timestamp() - ${TOKEN_MARGIN})
                    OR (state = 'issued' AND expires_at > clock_timestamp() - ${TOKEN_MARGIN}))`,
      params: [serverId],
    }),
    group(q, {
      kind: 'node_job',
      name: 'registry.retirement.server.jobs',
      sql: `SELECT j.job_id AS id, j.state, j.capability AS label, NULL::text AS target_id
              FROM nodes.jobs j JOIN nodes.nodes n ON n.node_id = j.node_id
             WHERE n.server_id = $1 AND j.state = ANY($2::text[])`,
      params: [serverId, [...OPEN_JOB_STATES]],
    }),
    group(q, openOperations('server', serverId, options.exceptPlanId ?? null)),
  ])
  const { rows: kept } = await q.query(
    'registry.retirement.server.kept',
    `SELECT ((SELECT count(*) FROM registry.clusters WHERE server_id = $1 AND state = 'retired')
          + (SELECT count(*) FROM nodes.nodes WHERE server_id = $1
              AND state IN ('decommissioned', 'binding_failed')))::int AS n`,
    [serverId],
  )
  const backups = await options.backups(q, { kind: 'server', id: serverId })
  return {
    subjectState: state,
    blockers: nonEmpty(blockers),
    retiredWith: [],
    retiredChildren: kept[0]?.int('n') ?? 0,
    backups,
  }
}

/** What a retirement of the cluster meets. `undefined` when the cluster does not exist. */
export async function clusterRetirement(
  q: Queryable,
  clusterId: string,
  options: RetirementOptions,
): Promise<Retirement | undefined> {
  const { rows } = await q.query(
    'registry.retirement.cluster',
    'SELECT state, server_id, management_mode FROM registry.clusters WHERE cluster_id = $1',
    [clusterId],
  )
  const cluster = rows[0]
  if (cluster === undefined) return undefined
  const serverId = cluster.textOrNull('server_id')
  const agent = cluster.text('management_mode') === 'agent'
  const blockers = await Promise.all([
    group(q, {
      kind: 'database',
      name: 'registry.retirement.cluster.databases',
      sql: `SELECT d.database_id AS id, d.state, d.name AS label, pl.target_id
              FROM registry.databases d
              LEFT JOIN registry.placements pl ON pl.database_id = d.database_id AND pl.valid_to IS NULL
             WHERE d.cluster_id = $1 AND d.state = 'registered'`,
      params: [clusterId],
    }),
    group(q, {
      kind: 'credential',
      name: 'registry.retirement.cluster.pending_credentials',
      // A submission being verified: it becomes active or failed, never retired, so it waits.
      sql: `SELECT credential_id AS id, state, role_name AS label, NULL::text AS target_id
              FROM registry.credentials WHERE cluster_id = $1 AND state = 'pending'`,
      params: [clusterId],
    }),
    // The node agent of an agent-managed cluster runs jobs on its host: an open one blocks.
    agent && serverId !== null
      ? group(q, {
          kind: 'node_job',
          name: 'registry.retirement.cluster.jobs',
          sql: `SELECT j.job_id AS id, j.state, j.capability AS label, NULL::text AS target_id
                  FROM nodes.jobs j JOIN nodes.nodes n ON n.node_id = j.node_id
                 WHERE n.server_id = $1 AND j.state = ANY($2::text[])`,
          params: [serverId, [...OPEN_JOB_STATES]],
        })
      : Promise.resolve<DependencyGroup>({ kind: 'node_job', total: 0, items: [] }),
    group(q, openOperations('cluster', clusterId, options.exceptPlanId ?? null)),
  ])
  const retiredWith = await Promise.all([
    group(q, {
      kind: 'endpoint',
      name: 'registry.retirement.cluster.endpoints',
      sql: `SELECT endpoint_id AS id, state, label, NULL::text AS target_id
              FROM registry.endpoints WHERE cluster_id = $1 AND state = 'active'`,
      params: [clusterId],
    }),
    group(q, {
      kind: 'credential',
      name: 'registry.retirement.cluster.credentials',
      sql: `SELECT credential_id AS id, state, role_name AS label, NULL::text AS target_id
              FROM registry.credentials WHERE cluster_id = $1 AND state = 'active'`,
      params: [clusterId],
    }),
  ])
  const { rows: kept } = await q.query(
    'registry.retirement.cluster.kept',
    `SELECT ((SELECT count(*) FROM registry.databases WHERE cluster_id = $1 AND state = 'retired')
          + (SELECT count(*) FROM registry.endpoints WHERE cluster_id = $1 AND state = 'retired'))::int AS n`,
    [clusterId],
  )
  const backups = await options.backups(q, { kind: 'cluster', id: clusterId })
  return {
    subjectState: cluster.text('state'),
    blockers: nonEmpty(blockers),
    retiredWith: nonEmpty(retiredWith),
    retiredChildren: kept[0]?.int('n') ?? 0,
    backups,
  }
}

/** Whether a retirement may be planned now: nothing blocks and no backup binding is in doubt. */
export function retirementClear(retirement: Retirement): boolean {
  return (
    retirement.blockers.length === 0 &&
    (retirement.backups === 'not_installed' || retirement.backups === 'none')
  )
}

/**
 * What goes with a cluster, as its plan binds it (expected state `retiredWith`): how many records
 * and the ids named. An endpoint or credential added after the plan was made changes it, so the
 * apply fails `PLAN_STALE` instead of retiring a record nobody saw. shortcut: beyond `GROUP_LIMIT`
 * records of one kind only the total and the first ids are compared; bind a digest of every id
 * if a cluster ever carries that many.
 */
export function retiredWithBinding(retirement: Retirement): {
  readonly total: number
  readonly ids: readonly string[]
} {
  return {
    total: retirement.retiredWith.reduce((sum, g) => sum + g.total, 0),
    ids: retirement.retiredWith.flatMap((g) => g.items.map((item) => item.id)).sort(),
  }
}
