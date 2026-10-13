import {
  type Admission,
  AuthError,
  type Authorization,
  type PlanActor,
  type SessionContext,
  type SubjectRef,
} from '@exponetdb/auth'
import type {
  AccessRole,
  Cluster,
  ClusterBootstrapSql,
  ClusterConfirmRequest,
  ClusterRegisterRequest,
  CredentialView,
  DatabaseRegisterRequest,
  DatabaseView,
  DriftCheck,
  EndpointRequest,
  EndpointView,
  Environment,
  EnvironmentChangeRequest,
  EnvironmentCreateRequest,
  Finding,
  Fleet,
  FleetFinding,
  LockGraph,
  OperationView,
  PlanView,
  Product,
  ProductCreateRequest,
  Project,
  ProjectChangeRequest,
  ProjectCreateRequest,
  SchemaDiff,
  SchemaFingerprintResult,
  SchemaObject,
  SchemaObjectRef,
  SchemaOverview,
  Server,
  ServerCreateRequest,
  SessionList,
  Target,
  TargetHealth,
  TargetHealthHistory,
  TargetRegisterRequest,
  TargetStateChangeRequest,
  TargetSummary,
  Tier,
} from '@exponetdb/contracts'
import type { ControlStore, Queryable, Tx } from '@exponetdb/control-store'
import {
  currentSchema,
  DocumentCorrupt,
  documentByFingerprint,
  driftCheckView,
  type FindingFilter,
  type FleetFindingFilter,
  findingView,
  fingerprintTargets,
  fleetFindingCounts,
  fleetTargetCounts,
  GAP_THRESHOLD_SECONDS,
  HISTORY_MAX_RANGE_MS,
  healthSummary,
  listFindings,
  listFleetFindings,
  listSessions,
  lockGraph,
  openFindingCount,
  readHealthHistory,
  readStatuses,
  runDriftCheck,
  SAMPLE_PERIOD_SECONDS,
  type SessionFilter,
  type SnapshotDeps,
  schemaDiffView,
  schemaFingerprintView,
  schemaObject,
  schemaOverviewView,
  searchSchemaView,
  targetHealthView,
} from '@exponetdb/diagnostics'
import type { IdentityId } from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'
import {
  brand,
  type ClusterRecord,
  CREDENTIAL_LIST_LIMIT,
  clusterBootstrapSql,
  clusterView,
  credentialView,
  DATABASE_LIST_LIMIT,
  databaseView,
  ENDPOINT_LIST_LIMIT,
  endpointView,
  environmentView,
  findTarget,
  getCluster,
  getEnvironment,
  getProduct,
  getProject,
  getServer,
  listClusters,
  listCredentials,
  listDatabases,
  listEndpoints,
  listEnvironments,
  listProducts,
  listProjects,
  listServers,
  listTargets,
  type OrganizationVisibility,
  type Page,
  type PageRequest,
  planClusterConfirm,
  planClusterRegister,
  planDatabaseRegister,
  planEndpointAdd,
  planEndpointRetire,
  planEnvironmentCreate,
  planEnvironmentUpdate,
  planProductCreate,
  planProjectCreate,
  planProjectUpdate,
  planServerCreate,
  planTargetRegister,
  planTargetStateChange,
  productView,
  projectView,
  type RegistryActor,
  RegistryError,
  type RegistryPlanContext,
  serverView,
  submitCredential,
  type TargetFilter,
  type TargetRecord,
  type TargetVisibility,
  targetSummaryView,
  targetView,
} from '@exponetdb/registry'

/**
 * The Wave 4 use cases: registry management, target reads, health,
 * findings, schema reads and diffs, drift checks, live session and lock
 * reads, and the write-only credential submission. As everywhere in this
 * package, the central engine decides first on a subject the server
 * resolved from the registry (never from the request), then the domain
 * package runs. Registry changes are plans (applied through `plan.apply`);
 * reads never change anything except the observation history a schema read
 * or a drift check records.
 */
export interface RegistryServices {
  /** Planning: the registry policy, this installation, serve's observer connector, the Control Store's own identifier. */
  readonly plans: RegistryPlanContext
  /** Schema, health, drift and session reads as `serve` (its Control Store login and observer connector). */
  readonly observation: SnapshotDeps
}

/** What the use cases need from the application around them. */
export interface RegistryHost {
  readonly store: ControlStore
  readonly keyring: Parameters<typeof submitCredential>[1]['keyring']
  readonly clock: Parameters<typeof submitCredential>[1]['clock']
  readonly services: RegistryServices | undefined
  authorize(
    q: Queryable,
    action: string,
    caller: CallerLike,
    subject: SubjectRef,
  ): Promise<Authorization>
  admit(q: Queryable, action: string, caller: CallerLike): Promise<Admission>
  /** The engine's decision without throwing (lists that show only what a restricted grant covers). */
  allowed(q: Queryable, action: string, caller: CallerLike, subject: SubjectRef): Promise<boolean>
  plan(
    caller: CallerLike,
    action: string,
    idempotency: Idempotency | undefined,
    subject: (tx: Tx) => Promise<SubjectRef>,
    create: (tx: Tx, actor: RegistryActor) => Promise<PlanRecord>,
  ): Promise<PlanView>
  /**
   * A low-class inline plan (operations-engine.md §1): planned and accepted
   * in one transaction; the worker executes it. Returns the operation.
   */
  inline(
    caller: CallerLike,
    action: string,
    idempotency: Idempotency | undefined,
    subject: (tx: Tx) => Promise<SubjectRef>,
    create: (tx: Tx, actor: RegistryActor) => Promise<PlanRecord>,
  ): Promise<OperationView>
  identityOf(caller: CallerLike): IdentityId
  planActor(caller: CallerLike): PlanActor
  /** The delegation restrictions of a bearer caller (undefined for a session). */
  restrictions(caller: CallerLike): TargetVisibilityRestriction | undefined
  /**
   * The caller with the step-up receipt its request names, matched against
   * the binding the use case recomputed (ADR-0026), and `redeem` for after
   * the bound action succeeded; a caller without a receipt is returned as is.
   */
  withStepUp(
    tx: Tx,
    caller: CallerLike,
    bound: {
      readonly action: 'plan.apply' | 'node.enrollment_token.reveal'
      readonly planId: string | null
      readonly planHash: string | null
      readonly tokenId: string | null
    },
  ): Promise<{ readonly caller: CallerLike; redeem(): Promise<void> }>
}

/** The caller as the host knows it (opaque here). */
export type CallerLike = { readonly kind: 'session' | 'bearer' }

export interface Idempotency {
  readonly key: string
  readonly requestHash: string
}

export interface TargetVisibilityRestriction {
  readonly targetIds?: readonly string[]
  readonly tiers?: readonly Tier[]
}

const INSTALLATION: SubjectRef = { kind: 'installation' }

/** A person planning a registry change: re-authentication counts only from a passkey or TOTP proof. */
export function registryActor(actor: PlanActor | SessionContext): RegistryActor {
  const session = 'reauthMethod' in actor ? actor : undefined
  const reauthAt =
    session === undefined
      ? actor.reauthAt
      : session.reauthMethod === 'passkey' || session.reauthMethod === 'totp'
        ? session.reauthAt
        : null
  return {
    identityId: actor.identityId,
    label: actor.label,
    reauthAt,
    client: ('client' in actor ? actor.client : undefined) ?? 'web',
    clientId: ('clientId' in actor ? actor.clientId : undefined) ?? null,
  }
}

function page<T, V>(p: Page<T>, view: (t: T) => V): { items: V[]; nextCursor: string | null } {
  return { items: p.items.map(view), nextCursor: p.nextCursor }
}

/** A list read with one row past its limit: the first `limit` items and whether it was cut. */
function bounded<T, V>(
  rows: readonly T[],
  limit: number,
  view: (t: T) => V,
): { items: V[]; truncated: boolean } {
  return { items: rows.slice(0, limit).map(view), truncated: rows.length > limit }
}

export class RegistryUseCases {
  readonly #h: RegistryHost

  constructor(host: RegistryHost) {
    this.#h = host
  }

  #services(): RegistryServices {
    const s = this.#h.services
    if (s === undefined) {
      // A composition without the registry (Wave 3 tests): nothing is served.
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    return s
  }

  // ----- target resolution -----

  /** A target by id or path; unknown (or decommissioned, by path) is TARGET_NOT_FOUND. */
  async #target(ref: string): Promise<TargetRecord> {
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) {
      throw new RegistryError('TARGET_NOT_FOUND')
    }
    return target
  }

  /**
   * Admission first (the caller holds the permission somewhere, through a
   * scope its client may use), then the lookup: a caller without any access
   * cannot tell an existing path from an unknown one (error-model.md §4).
   */
  async #authorizedTarget(action: string, caller: CallerLike, ref: string): Promise<TargetRecord> {
    await this.#h.admit(this.#h.store, action, caller)
    const target = await this.#target(ref)
    await this.#h.authorize(this.#h.store, action, caller, {
      kind: 'target',
      targetId: target.targetId,
    })
    return target
  }

  /** The targets a caller may read: the scopes of its grants, narrowed by a delegation. */
  async #visibility(caller: CallerLike, action: string): Promise<TargetVisibility> {
    const admission = await this.#h.admit(this.#h.store, action, caller)
    const v = {
      all: false,
      productIds: [] as string[],
      projectIds: [] as string[],
      environmentIds: [] as string[],
      targetIds: [] as string[],
    }
    for (const g of admission.grants) {
      if (g.permission !== admission.permission) continue
      switch (g.scope.kind) {
        case 'global':
          v.all = true
          break
        case 'product':
          v.productIds.push(g.scope.productId)
          break
        case 'project':
          v.projectIds.push(g.scope.projectId)
          break
        case 'environment':
          v.environmentIds.push(g.scope.environmentId)
          break
        case 'target':
          v.targetIds.push(g.scope.targetId)
          break
      }
    }
    const restricted = this.#h.restrictions(caller)
    return {
      ...v,
      ...(restricted?.targetIds === undefined ? {} : { onlyTargetIds: restricted.targetIds }),
      ...(restricted?.tiers === undefined ? {} : { onlyTiers: restricted.tiers }),
    }
  }

  /**
   * What of the organization a caller may list. A restricted delegation (a
   * target list or a single tier) reads targets, never products or
   * projects: the same refusal as `product.get` and `project.get`
   * (authorization.md §1.2, `restricted_scope`).
   */
  async #organization(caller: CallerLike, action: string): Promise<OrganizationVisibility> {
    const v = await this.#visibility(caller, action)
    if (v.onlyTargetIds !== undefined || (v.onlyTiers !== undefined && v.onlyTiers.length < 2)) {
      throw new AuthError('PERMISSION_DENIED')
    }
    return v
  }

  // ----- organization reads -----

  async products(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Product[]; nextCursor: string | null }> {
    const visible = await this.#organization(caller, 'product.list')
    return page(await listProducts(this.#h.store, visible, request), productView)
  }

  async product(caller: CallerLike, productId: string): Promise<Product> {
    await this.#h.authorize(this.#h.store, 'product.get', caller, { kind: 'product', productId })
    const product = await getProduct(this.#h.store, productId)
    if (product === undefined) throw new RegistryError('NOT_FOUND')
    return productView(product)
  }

  async environments(
    caller: CallerLike,
    productId: string,
    request: PageRequest,
  ): Promise<{ items: Environment[]; nextCursor: string | null }> {
    await this.#h.authorize(this.#h.store, 'environment.list', caller, {
      kind: 'product',
      productId,
    })
    return page(await listEnvironments(this.#h.store, productId, request), environmentView)
  }

  async projects(
    caller: CallerLike,
    filter: { readonly product?: string | undefined },
    request: PageRequest,
  ): Promise<{ items: Project[]; nextCursor: string | null }> {
    const visible = await this.#organization(caller, 'project.list')
    return page(
      await listProjects(this.#h.store, visible, { productSlug: filter.product }, request),
      projectView,
    )
  }

  async project(caller: CallerLike, projectId: string): Promise<Project> {
    await this.#h.authorize(this.#h.store, 'project.get', caller, { kind: 'project', projectId })
    const project = await getProject(this.#h.store, projectId)
    if (project === undefined) throw new RegistryError('NOT_FOUND')
    return projectView(project)
  }

  // ----- targets -----

  async targets(
    caller: CallerLike,
    filter: TargetFilter,
    request: PageRequest,
  ): Promise<{ items: TargetSummary[]; nextCursor: string | null }> {
    const visibility = await this.#visibility(caller, 'target.list')
    const p = await listTargets(this.#h.store, visibility, filter, request)
    const statuses = await readStatuses(
      this.#h.store,
      p.items.map((t) => t.targetId),
    )
    return {
      items: p.items.map((t) => targetSummaryView(t, healthSummary(statuses.get(t.targetId)))),
      nextCursor: p.nextCursor,
    }
  }

  async target(caller: CallerLike, ref: string): Promise<Target> {
    const target = await this.#authorizedTarget('target.get', caller, ref)
    const statuses = await readStatuses(this.#h.store, [target.targetId])
    return targetView(
      target,
      healthSummary(statuses.get(target.targetId)),
      await openFindingCount(this.#h.store, target.targetId),
    )
  }

  async targetHealth(caller: CallerLike, ref: string): Promise<TargetHealth> {
    const target = await this.#authorizedTarget('target.health.get', caller, ref)
    const statuses = await readStatuses(this.#h.store, [target.targetId])
    return targetHealthView(target, statuses.get(target.targetId))
  }

  /**
   * `target.health.history.get` (Wave 8): the sampled history of one target,
   * downsampled, with its gaps and their cause. The range defaults to the
   * last 24 hours and is at most 60 days (the longest retention) back from
   * now; a range that is not (`from` after `to`, in the future, older than
   * that, longer than that) is `VALIDATION_FAILED`. An invisible or unknown
   * target reads as not found, as for the latest health.
   */
  async targetHealthHistory(
    caller: CallerLike,
    ref: string,
    range: { readonly from?: string | undefined; readonly to?: string | undefined },
  ): Promise<TargetHealthHistory> {
    const target = await this.#authorizedTarget('target.health.history.get', caller, ref)
    const now = this.#h.clock.nowMs()
    const to = range.to === undefined ? now : Date.parse(range.to)
    const from = range.from === undefined ? to - 24 * 3_600_000 : Date.parse(range.from)
    const invalid = (path: string, message: string) =>
      new RegistryError('VALIDATION_FAILED', {
        errors: [{ path, code: 'invalid_range', message }],
      })
    // A little slack for a clock that differs from the store's by seconds.
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw invalid('/from', 'Not a timestamp.')
    }
    if (to > now + 60_000) throw invalid('/to', 'The range ends in the future.')
    if (from >= to) throw invalid('/from', 'The range starts at or after its end.')
    if (to - from > HISTORY_MAX_RANGE_MS)
      throw invalid('/from', 'The range is longer than 60 days.')
    if (from < now - HISTORY_MAX_RANGE_MS - 60_000) {
      throw invalid('/from', 'The range starts before the longest retention (60 days).')
    }
    const history = await readHealthHistory(this.#h.store, {
      targetId: target.targetId,
      state: target.state,
      stateChangedAt: target.stateChangedAt,
      from: new Date(from),
      to: new Date(to),
    })
    return {
      targetId: target.targetId as never,
      from: history.from,
      to: history.to,
      bucketSeconds: history.bucketSeconds,
      samplePeriodSeconds: SAMPLE_PERIOD_SECONDS,
      gapThresholdSeconds: GAP_THRESHOLD_SECONDS,
      firstSampleAt: history.firstSampleAt,
      buckets: [...history.buckets],
      gaps: [...history.gaps],
      gapsTruncated: history.gapsTruncated,
      source: 'sampled',
      observedAt: history.observedAt,
    }
  }

  async targetFindings(
    caller: CallerLike,
    ref: string,
    filter: FindingFilter,
    request: PageRequest,
  ): Promise<{ items: Finding[]; nextCursor: string | null }> {
    const target = await this.#authorizedTarget('target.finding.list', caller, ref)
    return page(await listFindings(this.#h.store, target.targetId, filter, request), findingView)
  }

  /**
   * The targets and findings parts of the fleet overview (`fleet.get`,
   * Wave 8). `targets.read` admits the request (the target list's
   * permission) and the same visibility applies: the scopes of the
   * caller's grants, narrowed by a delegation. The findings part needs
   * `diagnostics.read` as well, under the same visibility rule; a caller
   * that lacks it (or whose client may not use it) gets the part as
   * unavailable with a reason, never as zero. Two aggregate queries,
   * whatever the number of targets; both exact.
   */
  async fleetParts(caller: CallerLike): Promise<Pick<Fleet, 'targets' | 'findings'>> {
    const visibility = await this.#visibility(caller, 'fleet.get')
    const counts = await fleetTargetCounts(this.#h.store, visibility)
    const targets: Fleet['targets'] = {
      total: counts.total,
      decommissioned: counts.decommissioned,
      byTier: { ...counts.byTier },
      byHealth: { ...counts.byHealth },
      bySource: { ...counts.bySource },
      oldestSampleAt: counts.oldestObservedAt,
      source: 'live',
      observedAt: counts.asOf,
      lowerBound: false,
      lowerBoundReason: null,
    }
    let findingVisibility: TargetVisibility
    try {
      findingVisibility = await this.#visibility(caller, 'finding.list')
    } catch (error) {
      if (
        error instanceof AuthError &&
        (error.code === 'PERMISSION_DENIED' || error.code === 'INSUFFICIENT_SCOPE')
      ) {
        return { targets, findings: { available: false, reason: 'permission_denied' } }
      }
      throw error
    }
    const open = await fleetFindingCounts(this.#h.store, findingVisibility)
    return {
      targets,
      findings: {
        available: true,
        open: open.total,
        bySeverity: { ...open.bySeverity },
        source: 'live',
        observedAt: open.asOf,
        lowerBound: false,
        lowerBoundReason: null,
      },
    }
  }

  /**
   * `finding.list` (Wave 8): findings across targets, newest first, keyset
   * pages. `diagnostics.read` at the targets the caller may read (the rule
   * of `target.finding.list`); a named `target` is resolved and authorized
   * exactly as the per-target route does, so an unknown or invisible one is
   * `TARGET_NOT_FOUND`. Without `state` only open findings are listed.
   */
  async findings(
    caller: CallerLike,
    filter: Omit<FleetFindingFilter, 'targetId'> & { readonly target?: string | undefined },
    request: PageRequest,
  ): Promise<{ items: FleetFinding[]; nextCursor: string | null }> {
    const visibility = await this.#visibility(caller, 'finding.list')
    const { target, ...rest } = filter
    const targetId =
      target === undefined
        ? undefined
        : (await this.#authorizedTarget('finding.list', caller, target)).targetId
    const p = await listFleetFindings(
      this.#h.store,
      visibility,
      { ...rest, ...(targetId === undefined ? {} : { targetId }) },
      request,
    )
    return {
      items: p.items.map((f) => ({
        ...findingView(f),
        targetId: brand('tgt', f.targetId),
        targetPath: f.targetPath as FleetFinding['targetPath'],
      })),
      nextCursor: p.nextCursor,
    }
  }

  // ----- infrastructure reads (installation-wide: a cluster can host several products) -----

  async servers(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Server[]; nextCursor: string | null }> {
    await this.#h.authorize(this.#h.store, 'server.list', caller, INSTALLATION)
    return page(await listServers(this.#h.store, request), serverView)
  }

  async server(caller: CallerLike, serverId: string): Promise<Server> {
    await this.#h.authorize(this.#h.store, 'server.get', caller, { kind: 'server', serverId })
    const server = await getServer(this.#h.store, serverId)
    if (server === undefined) throw new RegistryError('NOT_FOUND')
    return serverView(server)
  }

  async clusters(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Cluster[]; nextCursor: string | null }> {
    await this.#h.authorize(this.#h.store, 'cluster.list', caller, INSTALLATION)
    return page(await listClusters(this.#h.store, request), (c: ClusterRecord) => clusterView(c))
  }

  async #cluster(action: string, caller: CallerLike, clusterId: string): Promise<ClusterRecord> {
    await this.#h.authorize(this.#h.store, action, caller, { kind: 'cluster', clusterId })
    const cluster = await getCluster(this.#h.store, clusterId)
    if (cluster === undefined) throw new RegistryError('NOT_FOUND')
    return cluster
  }

  async cluster(caller: CallerLike, clusterId: string): Promise<Cluster> {
    return clusterView(await this.#cluster('cluster.get', caller, clusterId))
  }

  async endpoints(
    caller: CallerLike,
    clusterId: string,
    state: 'active' | 'retired' | undefined,
  ): Promise<{ items: EndpointView[]; truncated: boolean }> {
    await this.#cluster('endpoint.list', caller, clusterId)
    return bounded(
      await listEndpoints(this.#h.store, clusterId, state),
      ENDPOINT_LIST_LIMIT,
      endpointView,
    )
  }

  async databases(
    caller: CallerLike,
    clusterId: string,
  ): Promise<{ items: DatabaseView[]; truncated: boolean }> {
    await this.#cluster('database.list', caller, clusterId)
    return bounded(await listDatabases(this.#h.store, clusterId), DATABASE_LIST_LIMIT, databaseView)
  }

  async credentials(
    caller: CallerLike,
    clusterId: string,
  ): Promise<{ items: CredentialView[]; truncated: boolean }> {
    await this.#cluster('credential.list', caller, clusterId)
    return bounded(
      await listCredentials(this.#h.store, clusterId),
      CREDENTIAL_LIST_LIMIT,
      credentialView,
    )
  }

  async bootstrapSql(caller: CallerLike, clusterId: string): Promise<ClusterBootstrapSql> {
    await this.#cluster('cluster.bootstrap_sql.get', caller, clusterId)
    return clusterBootstrapSql(this.#h.store, clusterId)
  }

  // ----- registry plans -----

  #plan(
    caller: CallerLike,
    action: string,
    idempotency: Idempotency | undefined,
    subject: SubjectRef | ((tx: Tx) => Promise<SubjectRef>),
    create: (tx: Tx, context: RegistryPlanContext, actor: RegistryActor) => Promise<PlanRecord>,
  ): Promise<PlanView> {
    const context = this.#services().plans
    return this.#h.plan(
      caller,
      action,
      idempotency,
      typeof subject === 'function' ? subject : async () => subject,
      (tx, actor) => create(tx, context, actor),
    )
  }

  planProduct(caller: CallerLike, body: ProductCreateRequest, idem?: Idempotency) {
    return this.#plan(caller, 'registry.product.create.plan', idem, INSTALLATION, (tx, c, a) =>
      planProductCreate(tx, c, a, body),
    )
  }

  planEnvironment(
    caller: CallerLike,
    productId: string,
    body: EnvironmentCreateRequest,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.environment.create.plan',
      idem,
      { kind: 'product', productId },
      (tx, c, a) => planEnvironmentCreate(tx, c, a, productId, body),
    )
  }

  planEnvironmentChange(
    caller: CallerLike,
    productId: string,
    environmentId: string,
    body: EnvironmentChangeRequest,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.environment.update.plan',
      idem,
      async (tx) => {
        const env = await getEnvironment(tx, environmentId)
        // Another product's environment is not found under this one.
        if (env === undefined || env.productId !== productId) {
          throw new RegistryError('NOT_FOUND')
        }
        return { kind: 'environment', environmentId }
      },
      (tx, c, a) => planEnvironmentUpdate(tx, c, a, productId, environmentId, body),
    )
  }

  planProject(caller: CallerLike, body: ProjectCreateRequest, idem?: Idempotency) {
    return this.#plan(
      caller,
      'registry.project.create.plan',
      idem,
      async (tx) => {
        const { rows } = await tx.query(
          'application.registry.product_by_slug',
          'SELECT product_id FROM registry.products WHERE slug = $1',
          [body.product],
        )
        const productId = rows[0]?.text('product_id')
        if (productId === undefined) throw new RegistryError('NOT_FOUND')
        return { kind: 'product', productId }
      },
      (tx, c, a) => planProjectCreate(tx, c, a, body),
    )
  }

  planProjectChange(
    caller: CallerLike,
    projectId: string,
    body: ProjectChangeRequest,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.project.update.plan',
      idem,
      { kind: 'project', projectId },
      (tx, c, a) => planProjectUpdate(tx, c, a, projectId, body),
    )
  }

  planServer(caller: CallerLike, body: ServerCreateRequest, idem?: Idempotency) {
    return this.#plan(caller, 'registry.server.create.plan', idem, INSTALLATION, (tx, c, a) =>
      planServerCreate(tx, c, a, body),
    )
  }

  planClusterRegistration(caller: CallerLike, body: ClusterRegisterRequest, idem?: Idempotency) {
    return this.#plan(caller, 'registry.cluster.register.plan', idem, INSTALLATION, (tx, c, a) =>
      planClusterRegister(tx, c, a, body),
    )
  }

  planClusterConfirmation(
    caller: CallerLike,
    clusterId: string,
    body: ClusterConfirmRequest,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.cluster.confirm.plan',
      idem,
      { kind: 'cluster', clusterId },
      (tx, c, a) => planClusterConfirm(tx, c, a, clusterId, body),
    )
  }

  planEndpoint(caller: CallerLike, clusterId: string, body: EndpointRequest, idem?: Idempotency) {
    return this.#plan(
      caller,
      'registry.endpoint.add.plan',
      idem,
      { kind: 'cluster', clusterId },
      (tx, c, a) => planEndpointAdd(tx, c, a, clusterId, body),
    )
  }

  planEndpointRetirement(
    caller: CallerLike,
    clusterId: string,
    endpointId: string,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.endpoint.retire.plan',
      idem,
      { kind: 'cluster', clusterId },
      (tx, c, a) => planEndpointRetire(tx, c, a, clusterId, endpointId),
    )
  }

  planDatabaseRegistration(
    caller: CallerLike,
    clusterId: string,
    body: DatabaseRegisterRequest,
    idem?: Idempotency,
  ) {
    return this.#plan(
      caller,
      'registry.database.register.plan',
      idem,
      { kind: 'cluster', clusterId },
      (tx, c, a) => planDatabaseRegister(tx, c, a, clusterId, body),
    )
  }

  planTargetRegistration(caller: CallerLike, body: TargetRegisterRequest, idem?: Idempotency) {
    return this.#plan(
      caller,
      'target.register.plan',
      idem,
      async (tx) => {
        // The target does not exist yet: the subject is the chain of its future path.
        const project = await getProject(tx, body.projectId)
        const env = await getEnvironment(tx, body.environmentId)
        if (project === undefined || env === undefined || env.productId !== project.productId) {
          throw new RegistryError('NOT_FOUND')
        }
        return {
          kind: 'plan',
          subject: {
            targetPath: `${project.productSlug}/${project.slug}/${env.slug}`,
            tier: env.tier,
          },
        }
      },
      (tx, c, a) => planTargetRegister(tx, c, a, body),
    )
  }

  async planTargetStateChange(
    caller: CallerLike,
    kind: 'target.suspend' | 'target.resume' | 'target.decommission',
    ref: string,
    body: TargetStateChangeRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    await this.#h.admit(this.#h.store, `${kind}.plan`, caller)
    const target = await this.#target(ref)
    return this.#plan(
      caller,
      `${kind}.plan`,
      idem,
      { kind: 'target', targetId: target.targetId },
      (tx, c, a) => planTargetStateChange(tx, c, a, kind, target.targetId, body),
    )
  }

  // ----- write-only credential submission (inline, Web App, re-authentication) -----

  async submitCredential(
    requestId: string,
    caller: CallerLike,
    clusterId: string,
    role: AccessRole,
    password: string,
  ): Promise<CredentialView> {
    const record = await this.#h.store.transaction(
      'application.registry.credential',
      async (tx) => {
        await this.#h.authorize(tx, 'registry.credential.submit', caller, {
          kind: 'cluster',
          clusterId,
        })
        return submitCredential(
          tx,
          { keyring: this.#h.keyring, clock: this.#h.clock },
          registryActor(this.#h.planActor(caller)),
          { clusterId, role, password },
          { requestId },
        )
      },
    )
    return credentialView(record)
  }

  // ----- schema reads -----

  async schemaOverview(caller: CallerLike, ref: string): Promise<SchemaOverview> {
    const target = await this.#authorizedTarget('schema.overview.get', caller, ref)
    return schemaOverviewView(target, await currentSchema(this.#services().observation, target))
  }

  async schemaFingerprint(caller: CallerLike, ref: string): Promise<SchemaFingerprintResult> {
    const target = await this.#authorizedTarget('schema.fingerprint.get', caller, ref)
    const current = await currentSchema(this.#services().observation, target, 0)
    return schemaFingerprintView(this.#h.store, target, current)
  }

  async searchSchema(
    caller: CallerLike,
    ref: string,
    query: { readonly q: string; readonly kinds?: readonly string[] | undefined },
    request: PageRequest,
  ): Promise<{ items: SchemaObjectRef[]; nextCursor: string | null }> {
    const target = await this.#authorizedTarget('schema.search', caller, ref)
    const current = await currentSchema(this.#services().observation, target)
    return searchSchemaView(
      current,
      { q: query.q, ...(query.kinds === undefined ? {} : { kinds: query.kinds }) },
      request,
    )
  }

  async schemaObject(
    caller: CallerLike,
    ref: string,
    kind: string,
    qualifiedName: string,
  ): Promise<SchemaObject> {
    const target = await this.#authorizedTarget('schema.object.get', caller, ref)
    return schemaObject(this.#services().observation, target, kind, qualifiedName)
  }

  /**
   * A diff of two targets or fingerprints. Each target side is authorized
   * for `schema.diff`; a fingerprint side is shown only when it was observed
   * on a target the caller may diff, so a fingerprint never reveals another
   * target's schema (a fingerprint nobody visible has is not found).
   */
  async schemaDiff(
    caller: CallerLike,
    body: {
      readonly left: { readonly target: string } | { readonly fingerprint: string }
      readonly right: { readonly target: string } | { readonly fingerprint: string }
    },
  ): Promise<SchemaDiff> {
    const side = async (
      s: { readonly target: string } | { readonly fingerprint: string },
    ): Promise<Awaited<ReturnType<typeof documentByFingerprint>>> => {
      if ('target' in s) {
        const target = await this.#authorizedTarget('schema.diff', caller, s.target)
        return (await currentSchema(this.#services().observation, target)).document
      }
      let readable = false
      for (const targetId of await fingerprintTargets(this.#h.store, s.fingerprint)) {
        try {
          await this.#h.authorize(this.#h.store, 'schema.diff', caller, {
            kind: 'target',
            targetId,
          })
          readable = true
          break
        } catch (error) {
          if (!(error instanceof AuthError)) throw error
        }
      }
      if (!readable) throw new RegistryError('NOT_FOUND')
      try {
        return await documentByFingerprint(this.#h.store, s.fingerprint)
      } catch (error) {
        if (error instanceof DocumentCorrupt) throw new AuthError('INTERNAL')
        throw error
      }
    }
    return schemaDiffView(await side(body.left), await side(body.right))
  }

  // ----- drift -----

  async runDriftCheck(caller: CallerLike, ref: string): Promise<DriftCheck> {
    const target = await this.#authorizedTarget('drift.check', caller, ref)
    const result = await runDriftCheck(
      this.#services().observation,
      target,
      this.#h.identityOf(caller),
    )
    return driftCheckView(result)
  }

  // ----- live sessions and locks -----

  async sessions(caller: CallerLike, ref: string, filter: SessionFilter): Promise<SessionList> {
    const target = await this.#authorizedTarget('session.list', caller, ref)
    // An agent reads at most 500 characters of a redacted statement (RED-2, order §22).
    const agent = (caller as { readonly resource?: string }).resource === 'mcp'
    return listSessions(this.#services().observation, target, {
      ...filter,
      reader: agent ? 'agent' : 'human',
    })
  }

  async locks(caller: CallerLike, ref: string): Promise<LockGraph> {
    const target = await this.#authorizedTarget('lock.list', caller, ref)
    return lockGraph(this.#services().observation, target)
  }
}
