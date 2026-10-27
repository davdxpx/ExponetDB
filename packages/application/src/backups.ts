import { appendAuditEvent } from '@exponetdb/audit'
import { AuthError } from '@exponetdb/auth'
import {
  activePolicy,
  BackupError,
  type BackupPlanContext,
  computeProtection,
  coverageView,
  type ExecutionSettings,
  generateRunbook,
  getCatalogEntry,
  getRepository,
  listCatalog,
  listCoverage,
  listDrills,
  listRepositories,
  listRestores,
  listRuns,
  planBackupRun,
  planBackupVerify,
  planCatalogRefresh,
  planDrill,
  planPolicySet,
  planRecovery,
  planRepositoryAdopt,
  planRepositoryOwnership,
  planRepositoryRetire,
  planRestoreDiscard,
  protectionFacts,
  RunbookRefused,
  repositoryView,
} from '@exponetdb/backups'
import type {
  BackupCatalog,
  BackupOverview,
  BackupPolicyBody,
  BackupPolicyView,
  BackupRepositoryAdoptRequest,
  BackupRepositoryList,
  BackupRepositoryOwnershipRequest,
  BackupRepositoryRetireRequest,
  Drill,
  DrillList,
  DrillPlanRequest,
  EngineRunList,
  OfflineDrillRecordRequest,
  OperationView,
  PlanView,
  RestoreList,
  RestorePlanRequest,
  RestoreRunbook,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isId, newId } from '@exponetdb/kernel'
import {
  decodeCursor,
  encodeCursor,
  findTarget,
  getCluster,
  RegistryError,
} from '@exponetdb/registry'
import { type CallerLike, type Idempotency, type RegistryHost, registryActor } from './registry.ts'

/**
 * The backup, restore and drill use cases of Wave 9 Part B
 * ([`09-backups-and-restore/`](../../../exponetdb-docs/09-backups-and-restore/architecture.md),
 * ADR-0036 to ADR-0038): reads of the Control Store's mirror, and plans
 * over `packages/backups` with the registry's engine (`#h.plan`,
 * `#h.inline`), so REST, CLI, MCP and the Web App share one path. No read
 * here talks to a node; the catalog is refreshed by an operation.
 */
export interface BackupHostOptions {
  /** The installation's activation settings (`EXPONETDB_BACKUP_EXECUTION`, `EXPONETDB_RESTORE_EXECUTION`). */
  readonly execution: () => ExecutionSettings
  /** The random source of `pitr_random` drills (tests inject one). */
  readonly random?: () => number
}

const LIMIT = 200
/** At most this many clusters are summed into the overview's counts (an internal installation is far below). */
const OVERVIEW_CLUSTERS = 1000

export class BackupUseCases {
  readonly #h: RegistryHost
  readonly #o: BackupHostOptions

  constructor(host: RegistryHost, options: BackupHostOptions) {
    this.#h = host
    this.#o = options
  }

  #context(): BackupPlanContext {
    const s = this.#h.services
    if (s === undefined) {
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    const random = this.#o.random
    return {
      policy: s.plans.policy,
      execution: this.#o.execution(),
      ...(random === undefined ? {} : { random }),
    }
  }

  #now(): string {
    return new Date(this.#h.clock.nowMs()).toISOString()
  }

  /** Admission first, then the lookup, then the subject's decision (error-model.md §4). */
  async #cluster(action: string, caller: CallerLike, clusterId: string) {
    await this.#h.admit(this.#h.store, action, caller)
    const cluster = await getCluster(this.#h.store, clusterId)
    if (cluster === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    await this.#h.authorize(this.#h.store, action, caller, { kind: 'cluster', clusterId })
    return cluster
  }

  /** Whether the caller may see repository locations: the registry's own permission over the cluster. */
  #seesLocation(caller: CallerLike, clusterId: string): Promise<boolean> {
    return this.#h.allowed(this.#h.store, 'backup.repository.adopt.plan', caller, {
      kind: 'cluster',
      clusterId,
    })
  }

  async #repositoryCluster(repositoryId: string): Promise<string> {
    if (!isId('bkr', repositoryId)) throw new BackupError('NOT_FOUND')
    const r = await getRepository(this.#h.store, repositoryId)
    if (r === undefined) throw new BackupError('NOT_FOUND')
    return r.clusterId
  }

  // ----- reads -----

  /** `backup.overview`: the measured protection of every cluster the caller may read. */
  async overview(
    caller: CallerLike,
    request: { readonly limit: number; readonly cursor?: string; readonly state?: string },
  ): Promise<BackupOverview> {
    await this.#h.admit(this.#h.store, 'backup.overview', caller)
    const { rows } = await this.#h.store.query(
      'application.backups.overview_clusters',
      `SELECT c.cluster_id, c.server_id, c.display_name, c.management_mode,
              (SELECT count(*)::int FROM backups.repositories r
                WHERE r.cluster_id = c.cluster_id AND r.state <> 'retired') AS repositories
         FROM registry.clusters c WHERE c.state <> 'retired' ORDER BY c.cluster_id LIMIT $1`,
      [OVERVIEW_CLUSTERS],
    )
    const nowMs = this.#h.clock.nowMs()
    const items: BackupOverview['clusters'][number][] = []
    for (const row of rows) {
      const clusterId = row.text('cluster_id')
      if (
        !(await this.#h.allowed(this.#h.store, 'backup.overview', caller, {
          kind: 'cluster',
          clusterId,
        }))
      ) {
        continue
      }
      const protection = computeProtection(await protectionFacts(this.#h.store, clusterId, nowMs))
      items.push({
        clusterId: clusterId as never,
        serverId: (row.textOrNull('server_id') ?? null) as never,
        displayName: row.text('display_name'),
        managementMode: row.text('management_mode') === 'external' ? 'external' : 'agent',
        repositories: row.int('repositories'),
        protection,
      })
    }
    const counts = { protected: 0, atRisk: 0, unprotected: 0, unproven: 0, unknown: 0 }
    for (const i of items) {
      const s = i.protection.state
      if (s === 'at_risk') counts.atRisk++
      else counts[s]++
    }
    const after = decodeCursor(request.cursor)
    const filtered = items.filter(
      (i) =>
        (request.state === undefined || i.protection.state === request.state) &&
        (after === null || i.clusterId > after),
    )
    const pageItems = filtered.slice(0, request.limit)
    const last = pageItems[pageItems.length - 1]
    return {
      clusters: pageItems,
      counts,
      nextCursor:
        filtered.length > request.limit && last !== undefined ? encodeCursor(last.clusterId) : null,
      source: 'inferred',
      observedAt: this.#now(),
    }
  }

  /** `backup.list`: a cluster's mirrored catalog with its protection and WAL coverage. */
  async catalog(
    caller: CallerLike,
    clusterId: string,
    request: { readonly limit: number; readonly cursor?: string },
  ): Promise<BackupCatalog> {
    await this.#cluster('backup.list', caller, clusterId)
    const q = this.#h.store
    const nowMs = this.#h.clock.nowMs()
    const afterId = decodeCursor(request.cursor)
    let after: { startedAt: string; id: string } | undefined
    if (afterId !== null) {
      const entry = await getCatalogEntry(q, afterId)
      if (entry === undefined) {
        throw new RegistryError('VALIDATION_FAILED', {
          errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
        })
      }
      after = { startedAt: entry.view.startedAt, id: entry.view.id }
    }
    const page = await listCatalog(q, clusterId, {
      limit: request.limit,
      ...(after === undefined ? {} : { after }),
    })
    const facts = await protectionFacts(q, clusterId, nowMs)
    const protection = computeProtection(facts)
    const repositories = await listRepositories(q, clusterId, { includeRetired: false })
    const coverage = await listCoverage(q, clusterId)
    const { rows } = await q.query(
      'application.backups.last_drill',
      `SELECT max(finished_at) AS at FROM backups.drills WHERE cluster_id = $1 AND outcome = 'passed'`,
      [clusterId],
    )
    const last = page.items[page.items.length - 1]
    const window = protection.pitrWindow
    return {
      clusterId: clusterId as never,
      state: protection.state,
      backups: page.items.map((b) => b.view),
      walWindow: window === null ? null : { from: window.from, to: window.to },
      achievableRpoSeconds: protection.rpo.achievableSeconds,
      lastDrillAt: rows[0]?.dateOrNull('at')?.toISOString() ?? null,
      truncated: repositories.some((r) => r.reconciliationOutcome === 'partial'),
      source: 'cached',
      observedAt: this.#now(),
      repositories: repositories.map((r) => ({
        id: r.repositoryId as never,
        layer: r.layer,
        engine: r.engine,
        provider: r.provider as never,
        ownership: r.ownership,
        state: r.state,
        lockCapability: r.lockCapability,
        reconciledAt: r.reconciledAt?.toISOString() ?? null,
      })),
      protection,
      walCoverage: coverage.map(coverageView),
      nextCursor: page.more && last !== undefined ? encodeCursor(last.view.id) : null,
    }
  }

  /** `backup.repository.list`: the repositories; locations only for who may manage the registry. */
  async repositories(caller: CallerLike, clusterId: string): Promise<BackupRepositoryList> {
    await this.#cluster('backup.repository.list', caller, clusterId)
    const withLocation = await this.#seesLocation(caller, clusterId)
    const items = await listRepositories(this.#h.store, clusterId, { includeRetired: true })
    return {
      clusterId: clusterId as never,
      repositories: items.slice(0, 64).map((r) => repositoryView(r, withLocation)),
      source: 'control_store',
      observedAt: this.#now(),
    }
  }

  /** `backup.policy.get`: the active policy revision, or none. */
  async policy(caller: CallerLike, clusterId: string): Promise<BackupPolicyView> {
    await this.#cluster('backup.policy.get', caller, clusterId)
    const p = await activePolicy(this.#h.store, clusterId)
    return {
      clusterId: clusterId as never,
      policy:
        p === undefined
          ? null
          : {
              ...p.body,
              id: p.policyId as never,
              clusterId: p.clusterId as never,
              revision: p.revision,
              state: 'active',
              operationId: p.operationId as never,
              createdAt: p.createdAt.toISOString(),
            },
      source: 'control_store',
      observedAt: this.#now(),
    }
  }

  async runs(
    caller: CallerLike,
    clusterId: string,
    request: { readonly limit: number; readonly cursor?: string },
  ): Promise<EngineRunList> {
    await this.#cluster('backup.run.list', caller, clusterId)
    const before = decodeCursor(request.cursor)
    const page = await listRuns(this.#h.store, clusterId, {
      limit: Math.min(request.limit, LIMIT),
      ...(before === null ? {} : { before }),
    })
    const last = page.items[page.items.length - 1]
    return {
      clusterId: clusterId as never,
      runs: page.items.map((r) => r.view),
      nextCursor: page.more && last !== undefined ? encodeCursor(last.view.id) : null,
      source: 'control_store',
      observedAt: this.#now(),
    }
  }

  async restores(
    caller: CallerLike,
    clusterId: string,
    request: { readonly limit: number; readonly cursor?: string },
  ): Promise<RestoreList> {
    await this.#cluster('restore.list', caller, clusterId)
    const before = decodeCursor(request.cursor)
    const page = await listRestores(this.#h.store, clusterId, {
      limit: Math.min(request.limit, LIMIT),
      ...(before === null ? {} : { before }),
    })
    const last = page.items[page.items.length - 1]
    return {
      clusterId: clusterId as never,
      restores: page.items,
      nextCursor: page.more && last !== undefined ? encodeCursor(last.id) : null,
      source: 'control_store',
      observedAt: this.#now(),
    }
  }

  async drills(
    caller: CallerLike,
    clusterId: string,
    request: { readonly limit: number; readonly cursor?: string },
  ): Promise<DrillList> {
    await this.#cluster('restore.list', caller, clusterId)
    const before = decodeCursor(request.cursor)
    const page = await listDrills(this.#h.store, clusterId, {
      limit: Math.min(request.limit, LIMIT),
      ...(before === null ? {} : { before }),
    })
    const last = page.items[page.items.length - 1]
    return {
      clusterId: clusterId as never,
      drills: page.items,
      nextCursor: page.more && last !== undefined ? encodeCursor(last.id) : null,
      source: 'control_store',
      observedAt: this.#now(),
    }
  }

  /**
   * `restore.runbook.get`: the C-35 offline runbook of one repository. It
   * holds the recorded location and no secret; each download is audited,
   * since the script tells where the backups are.
   */
  async runbook(
    requestId: string,
    caller: CallerLike,
    clusterId: string,
    repositoryId: string,
  ): Promise<RestoreRunbook> {
    await this.#cluster('restore.runbook.get', caller, clusterId)
    // The script names the repository's location, which only who may manage the registry sees
    // (review findings F-3/A-11): the same check as the repository list.
    if (!(await this.#seesLocation(caller, clusterId))) throw new BackupError('PERMISSION_DENIED')
    return this.#h.store.transaction('application.backups.runbook', async (tx) => {
      const r = await getRepository(tx, repositoryId)
      if (r === undefined || r.clusterId !== clusterId) throw new BackupError('NOT_FOUND')
      const book = await runbookOf(tx, r)
      const actor = registryActor(this.#h.planActor(caller))
      await appendAuditEvent(
        tx,
        {
          action: 'backup.runbook.downloaded',
          phase: 'completed',
          actor: {
            kind: 'human',
            identityId: actor.identityId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          subject: { clusterId: clusterId as never },
          changes: { repositoryId, revision: r.revision, digest: book.digest },
          result: { status: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
          ...(isId('req', requestId) ? { request: { requestId } } : {}),
        },
        { clock: this.#h.clock },
      )
      return {
        clusterId: clusterId as never,
        repositoryId: repositoryId as never,
        repositoryRevision: r.revision,
        filename: book.filename,
        digest: book.digest,
        script: book.script,
        placeholders: [...book.placeholders],
        generatedAt: this.#now(),
      }
    })
  }

  // ----- plans -----

  planAdoption(
    caller: CallerLike,
    clusterId: string,
    request: BackupRepositoryAdoptRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    return this.#h.plan(
      caller,
      'backup.repository.adopt.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planRepositoryAdopt(tx, context, actor, clusterId, request),
    )
  }

  async planOwnership(
    caller: CallerLike,
    repositoryId: string,
    request: BackupRepositoryOwnershipRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    const clusterId = await this.#repositoryCluster(repositoryId)
    return this.#h.plan(
      caller,
      'backup.repository.ownership.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planRepositoryOwnership(tx, context, actor, repositoryId, request.to),
    )
  }

  async planRetirement(
    caller: CallerLike,
    repositoryId: string,
    request: BackupRepositoryRetireRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    const clusterId = await this.#repositoryCluster(repositoryId)
    return this.#h.plan(
      caller,
      'backup.repository.retire.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planRepositoryRetire(tx, context, actor, repositoryId, request.reason),
    )
  }

  planPolicy(
    caller: CallerLike,
    clusterId: string,
    body: BackupPolicyBody,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    return this.#h.plan(
      caller,
      'backup.policy.set.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planPolicySet(tx, context, actor, clusterId, body),
    )
  }

  planRun(
    caller: CallerLike,
    clusterId: string,
    request: {
      readonly repositoryId: string
      readonly kind: 'full' | 'differential' | 'incremental' | 'logical'
    },
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    return this.#h.plan(
      caller,
      'backup.run.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planBackupRun(tx, context, actor, clusterId, request),
    )
  }

  /** `backup.catalog.refresh` (inline, low): the worker lists every observed repository. */
  refresh(caller: CallerLike, clusterId: string, idem?: Idempotency): Promise<OperationView> {
    const context = this.#context()
    return this.#h.inline(
      caller,
      'backup.catalog.refresh',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planCatalogRefresh(tx, context, actor, clusterId),
    )
  }

  /** `backup.verify` (inline, low, behind the backup activation). */
  verify(
    caller: CallerLike,
    clusterId: string,
    backupId: string,
    idem?: Idempotency,
  ): Promise<OperationView> {
    const context = this.#context()
    return this.#h.inline(
      caller,
      'backup.verify',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planBackupVerify(tx, context, actor, clusterId, backupId),
    )
  }

  planDrill(
    caller: CallerLike,
    clusterId: string,
    request: DrillPlanRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    return this.#h.plan(
      caller,
      'restore.drill.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planDrill(tx, context, actor, clusterId, request),
    )
  }

  /** `restore.plan`: a recovery of a target into a new cluster on its cluster's node (never in place). */
  async planRecovery(
    caller: CallerLike,
    targetRef: string,
    request: RestorePlanRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    await this.#h.admit(this.#h.store, 'restore.plan', caller)
    const target = await findTarget(this.#h.store, targetRef)
    if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
    const clusterId = target.placement?.clusterId
    if (clusterId === undefined)
      throw new RegistryError('REGISTRY_CONFLICT', { reason: 'target_state' })
    return this.#h.plan(
      caller,
      'restore.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) =>
        planRecovery(tx, context, actor, { targetId: target.targetId, clusterId }, request),
    )
  }

  planDiscard(
    caller: CallerLike,
    clusterId: string,
    restoreId: string,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const context = this.#context()
    return this.#h.plan(
      caller,
      'restore.discard.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planRestoreDiscard(tx, context, actor, clusterId, restoreId),
    )
  }

  /**
   * `restore.drill.offline.record` (C-35): a person states that the
   * offline runbook was run with the Control Plane stopped. An attestation:
   * stored as `attested` (or `failed`), never as a measured pass, and it
   * gives no RTO.
   */
  async recordOfflineDrill(
    requestId: string,
    caller: CallerLike,
    clusterId: string,
    request: OfflineDrillRecordRequest,
  ): Promise<Drill> {
    await this.#cluster('restore.drill.offline.record', caller, clusterId)
    return this.#h.store.transaction('application.backups.offline_drill', async (tx) => {
      const r = await getRepository(tx, request.repositoryId)
      if (r === undefined || r.clusterId !== clusterId) throw new BackupError('NOT_FOUND')
      // The attestation names the runbook it ran: the repository's current one (review C-10).
      if (request.runbookDigest !== (await runbookOf(tx, r)).digest) {
        throw new BackupError('VALIDATION_FAILED', {
          errors: [
            {
              path: '/runbookDigest',
              code: 'invalid',
              message: "The digest is not the one of the repository's current runbook.",
            },
          ],
        })
      }
      const actor = registryActor(this.#h.planActor(caller))
      const drillId = newId('drl', this.#h.clock.nowMs())
      const outcome = request.outcome === 'passed' ? 'attested' : 'failed'
      const finishedMs = Date.parse(request.restoredAt)
      const startedAt = new Date(finishedMs - request.durationSeconds * 1000).toISOString()
      await tx.query(
        'application.backups.offline_drill.insert',
        `INSERT INTO backups.drills (drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome,
           runbook_digest, notes, recorded_by, started_at, finished_at)
         VALUES ($1, $2, NULL, $3, 'latest', 'offline_runbook', $4, $5, $6, $7, $8, $9)`,
        [
          drillId,
          clusterId,
          r.repositoryId,
          outcome,
          request.runbookDigest,
          request.notes,
          actor.identityId,
          startedAt,
          request.restoredAt,
        ],
      )
      await appendAuditEvent(
        tx,
        {
          action: 'restore.drill.offline.recorded',
          phase: 'completed',
          actor: {
            kind: 'human',
            identityId: actor.identityId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          subject: { clusterId: clusterId as never },
          changes: {
            drillId,
            repositoryId: r.repositoryId,
            outcome,
            runbookDigest: request.runbookDigest,
            durationSeconds: request.durationSeconds,
          },
          result: { status: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
          ...(isId('req', requestId) ? { request: { requestId } } : {}),
        },
        { clock: this.#h.clock },
      )
      return {
        id: drillId as never,
        clusterId: clusterId as never,
        restoreId: null,
        repositoryId: r.repositoryId as never,
        selection: 'latest',
        mode: 'offline_runbook',
        outcome,
        measuredRtoSeconds: null,
        startedAt,
        finishedAt: request.restoredAt,
      }
    })
  }
}

/** The repository's runbook as generated now (deterministic for one record revision). */
async function runbookOf(
  q: Queryable,
  r: NonNullable<Awaited<ReturnType<typeof getRepository>>>,
): Promise<ReturnType<typeof generateRunbook>> {
  const postgresMajor = await majorOf(q, r.clusterId)
  try {
    return generateRunbook({
      repositoryId: r.repositoryId,
      revision: r.revision,
      clusterId: r.clusterId,
      engine: r.engine,
      provider: r.provider,
      endpointHost: r.endpointHost,
      region: r.region,
      bucket: r.bucket,
      prefix: r.prefix,
      stanza: r.stanza,
      repoIndex: r.repoIndex,
      cipher: r.cipher,
      pinnedEngineVersion: r.pinnedEngineVersion,
      postgresMajor,
    })
  } catch (error) {
    // A recorded value the script cannot carry safely: no script rather than an unsafe one.
    if (error instanceof RunbookRefused) throw new BackupError('CAPABILITY_UNAVAILABLE')
    throw error
  }
}

async function majorOf(q: Queryable, clusterId: string): Promise<number | null> {
  const { rows } = await q.query(
    'application.backups.major',
    'SELECT server_version_num FROM registry.clusters WHERE cluster_id = $1',
    [clusterId],
  )
  const n = rows[0]?.intOrNull('server_version_num') ?? null
  return n === null ? null : Math.floor(n / 10000)
}
