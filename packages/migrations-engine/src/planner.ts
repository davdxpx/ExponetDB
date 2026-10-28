import type { MigrationPlanRequest, ProjectConfig } from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import {
  buildGraph,
  type GraphFailure,
  type GraphMigration,
  isBaselineRef,
  type PendingFailure,
  selectionOrder,
} from '@exponetdb/migrations/graph'
import { type LintReport, lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import { createPlan, type PlanRecord } from '@exponetdb/operations'
import type { MigrationFacts } from '@exponetdb/policy'
import {
  blocksExecution,
  type CatalogReader,
  type ExecutionRoleFacts,
  executionRoleFacts,
  type LedgerRecord,
  readVerifications,
  resolveVerifyCatalog,
  sql,
  type VerificationRecord,
  type VerifyResolution,
} from '@exponetdb/postgres'
import {
  analyzeMigrationSql,
  analyzeVerifyFile,
  COMPATIBILITY_ORDER,
  type CompatibilityClass,
  type LockSeverity,
  mergeProceduralReasons,
  proceduralReasons,
  worstSeverity,
} from '@exponetdb/postgres/parser'
import {
  type Connector,
  evaluateRegistryPolicy,
  findTarget,
  grantUsable,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
  readBreakGlassGrant,
  type TargetRecord,
} from '@exponetdb/registry'
import { type LintEntry, migrationAnalysis, resolutionFinding } from './analysis.ts'
import type { PlanContent, PlanItem } from './content.ts'
import { divergenceDetails, ledgerDivergence } from './divergence.ts'
import { MigrationError } from './errors.ts'
import { collectEvidence, evidenceTargetOf } from './evidence.ts'
import {
  type ExceptionBinding,
  executionRolesFor,
  type ResolvedExecutionRoles,
  roleUnder,
} from './execution-roles.ts'
import {
  ingestBundles,
  readRevision,
  revisionInput,
  type StoredRevision,
  storedStream,
} from './store.ts'
import { readTargetState, type TargetState } from './target.ts'
import { satisfies, serverVersion } from './versions.ts'

/**
 * Planning `migration.apply` ([planning-and-apply.md §3](../../../../exponetdb-docs/04-migrations/planning-and-apply.md#3-planning-algorithm)):
 *
 * 1. resolve the target from the registry (never from the request) and
 *    refuse a target that is not active;
 * 2. ingest submitted bundles (re-validated and re-hashed here) or take
 *    the named ids from the bundle store;
 * 3. read the target in one read-only snapshot as the observer: identity
 *    marker, ledger and `ls1`, fingerprint, extensions, sizes, the
 *    execution roles' facts and the verify.sql catalog resolution;
 * 4. order: the selected ids and their pending ancestors (never applied
 *    ids again, never a reverted id);
 * 5. lint and analyze the stored bytes with the target's major;
 * 6. collect evidence live from the evidence target (production);
 * 7. evaluate the policy and store the immutable plan, also when denied.
 *
 * Planning writes nothing to any target and takes no lock there. A refusal
 * is an error, never an empty plan.
 */
export interface MigrationPlanContext {
  readonly policy: RegistryPolicyContext
  readonly installationId: string
  /** serve's connector: observer sessions only. */
  readonly connector: Connector
}

interface ProjectSettings {
  readonly projectId: string
  readonly slug: string
  readonly productSlug: string
  readonly trustedExtensions: readonly string[]
  readonly managedScope: { readonly includeSchemas?: string[]; readonly excludeSchemas: string[] }
}

async function projectSettings(q: Queryable, projectId: string): Promise<ProjectSettings> {
  const { rows } = await q.query(
    'migrations.plan.project',
    `SELECT p.project_id, p.slug, pr.slug AS product_slug, p.trusted_extensions, p.managed_scope
       FROM registry.projects p JOIN registry.products pr ON pr.product_id = p.product_id
      WHERE p.project_id = $1`,
    [projectId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new MigrationError('NOT_FOUND')
  }
  const trusted = row.json('trusted_extensions') as JsonValue
  const scope = row.json('managed_scope') as JsonValue
  const s = isJsonObject(scope) ? scope : {}
  const include = Array.isArray(s['includeSchemas'])
    ? s['includeSchemas'].filter((x): x is string => typeof x === 'string')
    : undefined
  const exclude = Array.isArray(s['excludeSchemas'])
    ? s['excludeSchemas'].filter((x): x is string => typeof x === 'string')
    : []
  return {
    projectId: row.text('project_id'),
    slug: row.text('slug'),
    productSlug: row.text('product_slug'),
    trustedExtensions: Array.isArray(trusted)
      ? trusted.filter((x): x is string => typeof x === 'string')
      : [],
    managedScope: {
      ...(include === undefined ? {} : { includeSchemas: include }),
      excludeSchemas: exclude,
    },
  }
}

/**
 * The live ledger against the mirror (ledger.md §5), on every plan: a
 * difference no operation of this target explains stops schema plans. The
 * comparison is live; `ledger_state.divergent` only records what the worker
 * saw last.
 */
async function assertLedgerAgrees(
  q: Queryable,
  target: TargetRecord,
  ledger: readonly LedgerRecord[],
): Promise<void> {
  const divergence = await ledgerDivergence(q, target.targetId, target.generation, ledger)
  if (divergence !== null) {
    throw new MigrationError('LEDGER_DIVERGENCE', divergenceDetails(divergence))
  }
}

function graphRefusal(failure: GraphFailure | PendingFailure): MigrationError {
  switch (failure.code) {
    case 'cycle':
      return new MigrationError('MIGRATION_DEPENDENCY_CYCLE', {
        cycle: [...failure.cycle].slice(0, 256),
      })
    case 'unknown_dependency':
      return new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', {
        migrationId: failure.from,
        missing: [...failure.missing].slice(0, 256),
      })
    case 'dependency_missing':
      return new MigrationError('MIGRATION_DEPENDENCY_MISSING', {
        missing: [...failure.missing].slice(0, 256),
      })
    case 'baseline_missing':
      return new MigrationError('MIGRATION_DEPENDENCY_MISSING', { missing: [failure.baseline] })
    case 'unanchored_root':
      return new MigrationError('MIGRATION_DEPENDENCY_MISSING', { missing: [failure.id] })
    case 'duplicate_id':
      return new MigrationError('MIGRATION_BUNDLE_INVALID', { reason: 'duplicate_migration_id' })
    case 'unknown_applied':
      return new MigrationError('LEDGER_DIVERGENCE')
    case 'unknown_selection':
      return new MigrationError('NOT_FOUND')
    default:
      return new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN')
  }
}

/** Incomplete non-transactional migrations: started, never recorded, never cleaned up (failure-and-recovery.md §2). */
const INCOMPLETE_NONTX = sql`SELECT DISTINCT e.migration_id FROM exponetdb.migration_events e
 WHERE e.event = 'nontx_started'
   AND NOT EXISTS (SELECT 1 FROM exponetdb.schema_migrations m WHERE m.migration_id = e.migration_id)
   AND NOT EXISTS (SELECT 1 FROM exponetdb.migration_events r
                    WHERE r.migration_id = e.migration_id AND r.event = 'ledger_reconciled'
                      AND r.event_seq > e.event_seq)`

const DATABASE_CREATE = sql`SELECT r.role, pg_catalog.has_database_privilege(r.role, pg_catalog.current_database(), 'CREATE') AS can_create
  FROM pg_catalog.jsonb_array_elements_text($1::jsonb) AS r(role)
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = r.role)`

const EXTENSION_TRUST = sql`SELECT n.name, a.default_version,
       (SELECT v.trusted FROM pg_catalog.pg_available_extension_versions v
         WHERE v.name = n.name AND v.version = a.default_version) AS trusted
  FROM pg_catalog.jsonb_array_elements_text($1::jsonb) AS n(name)
  LEFT JOIN pg_catalog.pg_available_extensions a ON a.name = n.name`

interface Live {
  readonly state: TargetState
  readonly order: readonly StoredRevision[]
  readonly verifications: readonly VerificationRecord[]
  /** Per execution role: its facts for the migrator, its problem under the exceptions, the exception it relies on. */
  readonly roleChecks: ReadonlyMap<
    string,
    {
      readonly facts: ExecutionRoleFacts
      readonly problem: string | null
      readonly binding: ExceptionBinding | null
    }
  >
  readonly verify: ReadonlyMap<
    string,
    { checks: ReturnType<typeof checksOf>; resolution: VerifyResolution | null }
  >
  readonly untrustedExtensions: readonly string[]
  readonly incomplete: readonly string[]
}

function checksOf(major: 16 | 17 | 18, revision: StoredRevision) {
  const bytes = revision.files['verify.sql']
  if (bytes === null) return { ok: true as const, checks: [] }
  const text = normalizeSqlSource(bytes)
  if (!text.ok) return { ok: false as const, checks: [] }
  const file = analyzeVerifyFile(major, text.value)
  return file.ok
    ? { ok: true as const, checks: [...file.checks] }
    : { ok: false as const, checks: [] }
}

function executionAlias(revision: StoredRevision): string {
  const execution = revision.manifest['execution']
  const role = isJsonObject(execution) ? execution['role'] : undefined
  return typeof role === 'string' ? role : ''
}

function manifestNumber(
  revision: StoredRevision,
  field: 'lockTimeout' | 'statementTimeout',
): number {
  const execution = revision.manifest['execution']
  const value = isJsonObject(execution) ? execution[field] : undefined
  return typeof value === 'number' ? value : 0
}

function searchPathOf(revision: StoredRevision): string[] {
  const execution = revision.manifest['execution']
  const path = isJsonObject(execution) ? execution['searchPath'] : undefined
  return Array.isArray(path) ? path.filter((p): p is string => typeof p === 'string') : []
}

function requires(revision: StoredRevision): {
  postgres: string | null
  extensions: { name: string; version: string | null }[]
} {
  const r = revision.manifest['requires']
  const postgres = isJsonObject(r) && typeof r['postgres'] === 'string' ? r['postgres'] : null
  const list = isJsonObject(r) && Array.isArray(r['extensions']) ? r['extensions'] : []
  return {
    postgres,
    extensions: list.filter(isJsonObject).map((e) => ({
      name: String(e['name']),
      version: typeof e['version'] === 'string' ? e['version'] : null,
    })),
  }
}

/**
 * The ids reachable from `start` through `dependsOn`, with their dependencies, as far as `lookup`
 * knows them. A plan's graph is made of these and of the ledger, not of the whole stored stream:
 * another bundle that names an unknown id is that bundle's problem. It refuses the plan of itself
 * and of what depends on it, and no other plan of the project (TC-008, MIG-04).
 */
function reachable(
  start: Iterable<string>,
  lookup: (id: string) => readonly string[] | undefined,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  const queue = [...start]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (out.has(id)) continue
    const dependsOn = lookup(id)
    if (dependsOn === undefined) continue
    out.set(id, dependsOn)
    queue.push(...dependsOn)
  }
  return out
}

/** Order the selection against the target's ledger with the project's stream (store and ledger). */
async function planOrder(
  q: Queryable,
  project: ProjectSettings,
  state: TargetState,
  chosen: ReadonlyMap<string, StoredRevision>,
): Promise<StoredRevision[]> {
  const stream = await storedStream(q, project.projectId)
  const ledger = state.ledger
  const applied = new Set<string>()
  const reverted = new Set<string>()
  const baselines = new Set<string>()
  if (state.meta.baselineId !== null) baselines.add(state.meta.baselineId)
  const nodes = new Map<string, GraphMigration>()
  for (const r of ledger) {
    if (r.origin === 'legacy_import') continue
    if (r.origin === 'baseline' || isBaselineRef(r.migrationId)) {
      baselines.add(r.migrationId)
      applied.add(r.migrationId)
      continue
    }
    if (r.revertedAt !== null) reverted.add(r.migrationId)
    else applied.add(r.migrationId)
    nodes.set(r.migrationId, { id: r.migrationId, dependsOn: [...r.dependencies] })
  }
  // The graph of this plan is the ledger, what is chosen and the stored bundles they depend on,
  // however far (the chosen revision's own dependencies win over the stream's).
  for (const [id, dependsOn] of reachable(
    chosen.keys(),
    (id) => chosen.get(id)?.dependsOn ?? nodes.get(id)?.dependsOn ?? stream.get(id)?.dependsOn,
  )) {
    nodes.set(id, { id, dependsOn: [...dependsOn] })
  }
  for (const b of baselines) nodes.delete(b)
  // The target's ledger is the truth: a chosen id it has applied is a no-op or a mismatch.
  for (const [id, r] of chosen) {
    const row = ledger.find((l) => l.migrationId === id)
    if (row !== undefined && row.checksum !== r.checksum) {
      throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', {
        migrationId: id,
        knownChecksum: row.checksum,
        where: { kind: 'target_ledger', targetId: state.marker.targetId },
      })
    }
  }
  const graph = buildGraph({ migrations: [...nodes.values()], baselines: [...baselines] })
  if (!graph.ok) throw graphRefusal(graph.error)
  // Reverted ids are neither applied nor pending: selecting one is a refusal.
  const selected = [...chosen.keys()]
  const again = selected.find((id) => reverted.has(id))
  if (again !== undefined) {
    throw new MigrationError('MIGRATION_REVERTED', { migrationId: again })
  }
  const order = selectionOrder(graph.value, new Set([...applied, ...reverted]), selected)
  if (!order.ok) throw graphRefusal(order.error)
  if (order.value.length === 0) {
    throw new MigrationError('MIGRATION_ALREADY_APPLIED')
  }
  const out: StoredRevision[] = []
  for (const id of order.value) {
    const explicit = chosen.get(id)
    const revision = explicit ?? (await readRevision(q, project.projectId, id))
    if (revision === undefined) {
      throw new MigrationError('MIGRATION_DEPENDENCY_MISSING', { missing: [id] })
    }
    out.push(revision)
  }
  // A dependency an ancestor pulls in must also be pending or applied (checked by the graph);
  // a dependency on a reverted migration is missing.
  for (const r of out) {
    const missing = r.dependsOn.filter((d) => reverted.has(d))
    if (missing.length > 0) {
      throw new MigrationError('MIGRATION_DEPENDENCY_MISSING', { missing })
    }
  }
  return out
}

async function readLive(
  tx: Tx,
  rtx: CatalogReader,
  ctx: MigrationPlanContext,
  target: TargetRecord,
  project: ProjectSettings,
  resolved: ResolvedExecutionRoles,
  chosen: ReadonlyMap<string, StoredRevision>,
): Promise<Live> {
  const placement = target.placement
  const state = await readTargetState(
    rtx,
    {
      installationId: ctx.installationId,
      targetId: target.targetId,
      generation: target.generation,
      systemIdentifier: placement?.systemIdentifier ?? null,
    },
    project.managedScope,
  )
  if (state.meta.projectId !== target.projectId) {
    throw new MigrationError('LEDGER_DIVERGENCE')
  }
  // Before the graph: a row the mirror never had is reported as such, with its id.
  await assertLedgerAgrees(tx, target, state.ledger)
  const order = await planOrder(tx, project, state, chosen)
  const verifications = await readVerifications(rtx)
  const roles = [
    ...new Set(order.map((r) => resolved.roles[executionAlias(r)]).filter((r) => r !== undefined)),
  ]
  const facts = await executionRoleFacts(rtx, roles, 'exponetdb_migrator')
  const roleChecks = new Map<
    string,
    { facts: ExecutionRoleFacts; problem: string | null; binding: ExceptionBinding | null }
  >()
  for (const f of facts) roleChecks.set(f.role, { facts: f, ...roleUnder(f, resolved.exceptions) })
  const verify = new Map<
    string,
    { checks: ReturnType<typeof checksOf>; resolution: VerifyResolution | null }
  >()
  // What the plan's own migrations create (parsed), cumulatively: a verify.sql may read a
  // relation or call a function an earlier statement of the plan creates.
  const plannedRelations = new Map<string, string>()
  const plannedFunctions = new Set<string>()
  // CREATE EXTENSION in up.sql (parsed): declared trusted (the analyzer forbids it otherwise),
  // trusted in PostgreSQL, and every execution role may create it.
  const created = new Set<string>()
  const RELKIND: Readonly<Record<string, string>> = {
    table: 'r',
    materialized_view: 'm',
    view: 'v',
    sequence: 'S',
  }
  for (const r of order) {
    const text = normalizeSqlSource(r.files['up.sql'])
    const analysis = text.ok
      ? analyzeMigrationSql(rtx.facts.major, text.value, {
          trustedExtensions: project.trustedExtensions,
        })
      : null
    const schemaOf = (schema: string | null) => schema ?? searchPathOf(r)[0] ?? 'public'
    for (const s of analysis?.ok === true ? analysis.statements : []) {
      for (const o of s.objects) {
        if (o.action !== 'create') continue
        if (o.kind === 'extension') created.add(o.name)
        const kind = RELKIND[o.kind]
        if (kind !== undefined) plannedRelations.set(`${schemaOf(o.schema)}.${o.name}`, kind)
        if (o.kind === 'function') plannedFunctions.add(`${schemaOf(o.schema)}.${o.name}`)
      }
    }
    const checks = checksOf(rtx.facts.major, r)
    const resolution =
      checks.ok && checks.checks.length > 0
        ? await resolveVerifyCatalog(rtx, checks.checks, {
            relations: plannedRelations,
            functions: plannedFunctions,
          })
        : null
    verify.set(r.migrationId, { checks, resolution })
  }
  const untrustedExtensions: string[] = []
  if (created.size > 0) {
    const trust = await rtx.query(EXTENSION_TRUST, [JSON.stringify([...created])])
    const canCreate = await rtx.query(DATABASE_CREATE, [JSON.stringify(roles)])
    const rolesCreate =
      canCreate.every((r) => r.bool('can_create')) && canCreate.length === roles.length
    for (const t of trust) {
      const name = t.text('name')
      if (
        !project.trustedExtensions.includes(name) ||
        t.boolOrNull('trusted') !== true ||
        !rolesCreate
      ) {
        untrustedExtensions.push(name)
      }
    }
  }
  const incomplete = (await rtx.query(INCOMPLETE_NONTX)).map((r) => r.text('migration_id'))
  return { state, order, verifications, roleChecks, verify, untrustedExtensions, incomplete }
}

function lintConfig(
  project: ProjectSettings,
  roles: Readonly<Record<string, string>>,
  request: MigrationPlanRequest,
  defaults: JsonObject,
): ProjectConfig {
  return {
    schema: 'exponetdb.project/v1',
    project: `${project.productSlug}/${project.slug}`,
    layout: 'bundles',
    defaults: defaults as ProjectConfig['defaults'],
    executionRoles: Object.keys(roles).length > 0 ? roles : { owner: 'none' },
    managedScope: {
      includeSchemas: project.managedScope.includeSchemas ?? '*',
      excludeSchemas: project.managedScope.excludeSchemas,
    },
    trustedExtensions: [...project.trustedExtensions],
    lintProfile: request.lintProfile ?? 'strict',
    ...(request.lint === undefined ? {} : { lint: request.lint }),
    ...(request.invariants === undefined ? {} : { invariants: request.invariants }),
  } as ProjectConfig
}

function worstCompatibility(classes: readonly CompatibilityClass[]): CompatibilityClass {
  if (classes.includes('unknown')) return 'unknown'
  let worst: CompatibilityClass = 'additive'
  for (const c of classes) {
    if (COMPATIBILITY_ORDER.indexOf(c as never) > COMPATIBILITY_ORDER.indexOf(worst as never))
      worst = c
  }
  return worst
}

/**
 * Dependencies already applied on this target have a passing latest
 * verification, and so has the target's baseline (Part A follow-up 4): it
 * stands for the whole history before ExponetDB, so every later migration
 * builds on it, whether it names it or not.
 */
type RunFact = Pick<VerificationRecord, 'migrationId' | 'status' | 'finishedAt'>

export function dependenciesVerified(
  order: readonly StoredRevision[],
  ledger: readonly LedgerRecord[],
  verifications: readonly RunFact[],
): boolean {
  const planned = new Set(order.map((r) => r.migrationId))
  const deps = new Set(
    order.flatMap((r) => r.dependsOn).filter((d) => !planned.has(d) && !isBaselineRef(d)),
  )
  const passed = (migrationId: string) =>
    verifications
      .filter((v) => v.migrationId === migrationId)
      .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))[0]?.status === 'passed'
  for (const d of deps) {
    if (ledger.find((l) => l.migrationId === d && l.origin === 'exponetdb') === undefined) continue
    if (!passed(d)) return false
  }
  const baseline = ledger.find((l) => l.origin === 'baseline' && l.revertedAt === null)
  return baseline === undefined || passed(baseline.migrationId)
}

/**
 * The verification runs the production rule weighs, the baseline's taken
 * from the Control Store's mirror instead of the target: a migration's
 * procedural code can write the target's runs (OD-55), and one passed row
 * for the baseline would vouch for the whole history (follow-up 4 review).
 */
async function withMirroredBaselineRuns(
  tx: Tx,
  target: { readonly targetId: string; readonly generation: number },
  ledger: readonly LedgerRecord[],
  verifications: readonly RunFact[],
): Promise<RunFact[]> {
  const baseline = ledger.find((l) => l.origin === 'baseline' && l.revertedAt === null)
  if (baseline === undefined) return [...verifications]
  const { rows } = await tx.query(
    'migrations.plan.baseline_runs',
    `SELECT status,
            to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at
       FROM migrations.verification_mirror
      WHERE target_id = $1 AND generation = $2 AND migration_id = $3`,
    [target.targetId, target.generation, baseline.migrationId],
  )
  return [
    ...verifications.filter((v) => v.migrationId !== baseline.migrationId),
    ...rows.map((r) => ({
      migrationId: baseline.migrationId,
      status: r.text('status') as RunFact['status'],
      finishedAt: r.text('finished_at'),
    })),
  ]
}

export async function planMigrationApply(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  request: MigrationPlanRequest,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) {
    throw new MigrationError('TARGET_NOT_FOUND')
  }
  if (target.state !== 'active') {
    throw new MigrationError('TARGET_SUSPENDED', {
      reason:
        target.state === 'suspended' && target.stateReason !== null
          ? target.stateReason
          : 'administrator',
    })
  }
  if (target.placement === null) {
    throw new MigrationError('TARGET_UNAVAILABLE')
  }
  const project = await projectSettings(tx, target.projectId)
  // The roles of this target's environment and the exceptions there (ADR-0034).
  const resolved = await executionRolesFor(tx, target)
  const chosen = new Map<string, StoredRevision>()
  if ((request.bundles?.length ?? 0) > 0) {
    const ingested = await ingestBundles(tx, {
      projectId: project.projectId,
      bundles: request.bundles ?? [],
      defaults: request.defaults ?? {},
      ...(request.source === undefined ? {} : { source: request.source }),
      identityId: actor.identityId,
    })
    for (const item of ingested) chosen.set(item.revision.migrationId, item.revision)
  }
  for (const id of request.migrationIds ?? []) {
    if (chosen.has(id)) continue
    const revision = await readRevision(tx, project.projectId, id)
    if (revision === undefined) {
      throw new MigrationError('NOT_FOUND')
    }
    chosen.set(id, revision)
  }

  // ----- the target, live, as the observer -----
  const opened = await ctx.connector.forTarget(target, 'observer', `plan/${target.targetId}`)
  let live: Live
  try {
    await prepareLint(opened.session.facts.major)
    live = await opened.session.readOnly(
      (rtx) => readLive(tx, rtx, ctx, target, project, resolved, chosen),
      {
        statementTimeoutMs: 60_000,
      },
    )
  } finally {
    await opened.session.close()
  }
  const { state, order } = live
  const incomplete = live.incomplete[0]
  if (incomplete !== undefined) {
    // A started non-transactional migration blocks every schema plan until resume or cleanup.
    throw new MigrationError('MIGRATION_INCOMPLETE', { migrationId: incomplete })
  }
  const major = Math.floor(state.serverVersionNum / 10000) as 16 | 17 | 18
  const nontransactional = order.some((r) => !r.transactional)
  if (nontransactional && order.length > 1) {
    throw new MigrationError('MIGRATION_LINT_BLOCKED', {
      findings: [
        {
          rule: 'nontransactional_not_alone',
          level: 'error',
          message: 'A non-transactional bundle is planned alone; plan its dependencies first.',
        },
      ],
    })
  }

  // ----- lint and analysis of the stored bytes -----
  const defaults = order[0]?.defaults ?? {}
  const applied = new Map(
    state.ledger.map((r) => [
      r.migrationId,
      { checksum: r.checksum, name: r.name, sourceDigest: r.sourceDigest },
    ]),
  )
  const stream = await storedStream(tx, project.projectId)
  const report: LintReport = lintBundles(order.map(revisionInput), {
    major,
    project: lintConfig(project, resolved.roles, request, defaults),
    tier: target.tier,
    stream: [
      ...reachable(
        order.map((r) => r.migrationId),
        (id) => stream.get(id)?.dependsOn,
      ),
    ].map(([id, dependsOn]) => ({ id, dependsOn })),
    baselines: state.meta.baselineId === null ? [] : [state.meta.baselineId],
    applied,
    catalog: {
      source: 'live',
      observedAt: state.observedAt,
      relations: new Map(
        [...state.relations].map(([k, v]) => [
          k,
          { relkind: v.relkind, bytes: v.bytes, rows: v.rows },
        ]),
      ),
    },
  })
  const requirementsUnmet = new Set<'postgres' | 'extensions' | 'execution_role'>()
  const perMigration = order.map((r, i) => {
    const bundle = report.bundles[i]
    if (bundle === undefined) throw new MigrationError('INTERNAL')
    const verify = live.verify.get(r.migrationId)
    const extra: LintEntry[] = []
    const resolution = verify?.resolution ?? null
    const finding = resolution === null ? null : resolutionFinding(resolution)
    if (finding !== null) extra.push(finding)
    const role = resolved.roles[executionAlias(r)]
    const problem =
      role === undefined
        ? 'unmapped_alias'
        : live.roleChecks.has(role)
          ? (live.roleChecks.get(role)?.problem ?? null)
          : 'missing'
    if (problem !== null && blocksExecution(problem as never)) {
      requirementsUnmet.add('execution_role')
      extra.push({
        rule: 'execution_role',
        level: 'error' as const,
        blocking: true,
        message: `Execution role alias ${executionAlias(r)}: ${problem}.`,
        file: 'migration.yaml' as const,
        statementIndex: null,
        line: null,
        remediation:
          'Map the alias to a NOLOGIN owner in the project registry and grant it to exponetdb_migrator WITH INHERIT FALSE, SET TRUE.',
      })
    }
    const req = requires(r)
    if (req.postgres !== null && !satisfies(req.postgres, serverVersion(state.serverVersionNum))) {
      requirementsUnmet.add('postgres')
    }
    for (const e of req.extensions) {
      const installed = state.extensions[e.name]
      if (installed === undefined || (e.version !== null && !satisfies(e.version, installed))) {
        requirementsUnmet.add('extensions')
      }
    }
    for (const name of live.untrustedExtensions) {
      extra.push({
        rule: 'extension_not_trusted',
        level: 'error' as const,
        blocking: true,
        message: `CREATE EXTENSION ${name}: not declared trusted by the project, not trusted in PostgreSQL, or the execution role may not create it.`,
        file: 'up.sql' as const,
        statementIndex: null,
        line: null,
        remediation: 'Install the extension with a node operation (postgres.extensions.apply).',
      })
    }
    return migrationAnalysis(
      bundle,
      { checks: verify?.checks.checks ?? [], resolution },
      state.relations,
      searchPathOf(r),
      extra,
    )
  })
  const blockingFindings =
    perMigration.reduce((n, a) => n + a.lint.filter((l) => l.blocking).length, 0) +
    report.findings.filter((f) => f.blocking).length +
    (report.graph.valid ? 0 : 1)
  const compatibility = worstCompatibility(perMigration.map((a) => a.compatibility.observed))
  const lockSeverity: LockSeverity = worstSeverity(perMigration.map((a) => a.lockSeverity))
  const consumerCode = [...live.verify.values()].reduce(
    (n, v) => n + (v.resolution?.ok === true ? v.resolution.consumer.length : 0),
    0,
  )
  // OD-55 (c): whether the stored up.sql is procedural; a bundle without parsed statements
  // counts as procedural.
  const procedural = mergeProceduralReasons(
    order.map((_, i) => proceduralReasons(report.bundles[i]?.statements ?? null)),
  )

  // ----- evidence, live -----
  const evidence = await collectEvidence(
    tx,
    ctx.connector,
    ctx.installationId,
    target,
    order.map((r) => ({
      migrationId: r.migrationId,
      checksum: r.checksum,
      verifyDigest: r.verifyDigest,
    })),
    state.fingerprint,
  )

  const executionRoles: Record<string, string> = {}
  // The declared exceptions the plan relies on (ADR-0034 §3): bound, shown, counted.
  const executionRoleExceptions: Record<string, ExceptionBinding> = {}
  for (const r of order) {
    const alias = executionAlias(r)
    const role = resolved.roles[alias]
    if (role === undefined) continue
    executionRoles[alias] = role
    const binding = live.roleChecks.get(role)?.binding ?? null
    if (binding !== null) executionRoleExceptions[role] = binding
  }
  const exceptionsUsed = Object.keys(executionRoleExceptions).sort()
  const parity = await roleParity(tx, ctx, target, live, executionRoles)
  const items: PlanItem[] = order.map((r) => {
    const verify = live.verify.get(r.migrationId)
    const resolution = verify?.resolution
    return {
      migrationId: r.migrationId,
      name: r.name,
      revision: r.revision,
      checksum: r.checksum,
      verifyDigest: r.verifyDigest,
      rollbackDigest: r.rollbackDigest,
      sourceDigest: r.sourceDigest,
      bundleDigest: r.bundleDigest,
      transactional: r.transactional,
      executionRole: resolved.roles[executionAlias(r)] ?? '',
      searchPath: searchPathOf(r),
      lockTimeoutMs: manifestNumber(r, 'lockTimeout'),
      statementTimeoutMs: manifestNumber(r, 'statementTimeout'),
      dependsOn: [...r.dependsOn],
      source:
        r.source === null
          ? null
          : Object.fromEntries(
              Object.entries(r.source).filter(
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            ),
      verifyChecks: verify?.checks.checks.length ?? 0,
      consumerCode: resolution?.ok === true ? [...resolution.consumer] : [],
    }
  })
  const facts: MigrationFacts = {
    compatibility,
    lockSeverity,
    nontransactional,
    blockingFindings,
    consumerCode,
    requirementsUnmet: [...requirementsUnmet].sort(),
    evidence: evidence.fact,
    lineage: evidence.lineage,
    dependenciesVerified: dependenciesVerified(
      order,
      state.ledger,
      await withMirroredBaselineRuns(tx, target, state.ledger, live.verifications),
    ),
    legacyProject: state.meta.baselineId !== null,
    executionRoleExceptions: exceptionsUsed.length,
    executionRoleParity: parity,
    procedural: procedural.length > 0,
    proceduralReasons: procedural,
  }
  // A break-glass grant names the rules it may override; the engine decides which it does.
  let breakGlass: { readonly grantId: string; readonly rules: readonly string[] } | undefined
  if (request.breakGlassGrantId !== undefined) {
    const grant = await readBreakGlassGrant(tx, request.breakGlassGrantId)
    if (
      (actor.kind ?? 'human') !== 'human' ||
      actor.client === 'mcp' ||
      grant === undefined ||
      !grantUsable(grant, actor.identityId, target.targetId, ctx.policy.clock.nowMs())
    ) {
      throw new MigrationError('BREAK_GLASS_UNAVAILABLE', { reason: 'grant_not_usable' })
    }
    breakGlass = { grantId: grant.grantId, rules: [...grant.rules] }
  }
  const content: PlanContent = {
    projectId: project.projectId,
    migrations: items,
    execution: {
      mode: nontransactional ? 'nontransactional' : 'transactional',
      lockWaitSeconds: request.lockWaitSeconds ?? 30,
      stopOnVerificationFailure: true,
    },
    target: {
      targetId: target.targetId,
      path: target.path,
      tier: target.tier,
      generation: target.generation,
      clusterSystemIdentifier: state.systemIdentifier,
      databaseOid: state.databaseOid,
      serverVersionNum: state.serverVersionNum,
    },
    expectedState: {
      schemaFingerprint: state.fingerprint,
      ledgerStateHash: state.ledgerStateHash,
      extensions: { ...state.extensions },
      executionRoles,
      ...(exceptionsUsed.length === 0 ? {} : { executionRoleExceptions }),
    },
    evidence: evidence.binding,
    facts,
    ...(breakGlass === undefined ? {} : { breakGlass }),
  }
  const analysis = {
    perMigration,
    summary: {
      compatibility,
      lockSeverity,
      destructive: perMigration.some((a) => a.destructive.length > 0),
      nontransactional,
      consumerCodeChecks: consumerCode,
      blockingLints: blockingFindings,
    },
    evidence: [...evidence.items],
    executionRoleExceptions: exceptionsUsed.map((role) => {
      const e = resolved.exceptions.get(role)
      return {
        role,
        exceptionId: e?.exceptionId ?? null,
        revision: e?.revision ?? null,
        // The reason (a person's untrusted text) stays in the registry view, out of a plan
        // agents read.
        declaredBy: e?.declaredBy ?? null,
        reviewBy: e?.reviewBy ?? null,
      }
    }),
    executionRoleParity: parity,
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.apply',
    actor,
    subject,
    content: content as unknown as JsonObject,
    ...(breakGlass === undefined ? {} : { breakGlass }),
  })
  return createPlan(
    tx,
    {
      kind: 'migration.apply',
      kindVersion: 1,
      // Production is at least `high`, with or without a declared exception (ADR-0034 §3).
      actionClass: target.tier === 'prod' ? 'high' : 'standard',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        clusterId: target.placement.clusterId,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: analysis as unknown as JsonObject,
      evidence: evidence.items as unknown as JsonObject[],
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

/**
 * Production only (ADR-0034 §4): the evidence environment's execution role
 * of every alias the plan uses has the same attributes and the same
 * exception status as production's, or the evidence of staging says less
 * than it seems. `unknown` when the evidence target cannot be read.
 */
async function roleParity(
  tx: Tx,
  ctx: MigrationPlanContext,
  target: TargetRecord,
  live: Live,
  executionRoles: Readonly<Record<string, string>>,
): Promise<'match' | 'mismatch' | 'unknown' | 'not_required'> {
  if (target.tier !== 'prod') return 'not_required'
  const evidence = await evidenceTargetOf(tx, target)
  if (evidence === undefined || evidence.placement === null) return 'unknown'
  const theirs = await executionRolesFor(tx, evidence)
  const aliases = Object.keys(executionRoles)
  // An alias the evidence environment does not map at all ran as nothing there.
  if (aliases.some((a) => theirs.roles[a] === undefined)) return 'mismatch'
  const roles = [...new Set(aliases.map((a) => theirs.roles[a] as string))]
  let facts: ExecutionRoleFacts[]
  try {
    const opened = await ctx.connector.forTarget(evidence, 'observer', `parity/${target.targetId}`)
    try {
      facts = await opened.session.readOnly((rtx) =>
        executionRoleFacts(rtx, roles, 'exponetdb_migrator'),
      )
    } finally {
      await opened.session.close()
    }
  } catch {
    return 'unknown'
  }
  const attributes = (f: ExecutionRoleFacts) =>
    [f.exists, f.canLogin, f.superuser, f.createRole, f.createDb, f.replication, f.bypassRls].join()
  for (const alias of aliases) {
    const ours = live.roleChecks.get(executionRoles[alias] ?? '')
    const role = theirs.roles[alias]
    const other = facts.find((f) => f.role === role)
    if (ours === undefined || other === undefined || role === undefined) return 'unknown'
    const otherException = roleUnder(other, theirs.exceptions).problem === 'declared_exception'
    if (
      attributes(ours.facts) !== attributes(other) ||
      (ours.problem === 'declared_exception') !== otherException
    ) {
      return 'mismatch'
    }
  }
  return 'match'
}
