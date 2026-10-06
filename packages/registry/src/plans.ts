import type {
  ClusterConfirmRequest,
  ClusterRegisterRequest,
  DatabaseRegisterRequest,
  EndpointRequest,
  EnvironmentChangeRequest,
  EnvironmentCreateRequest,
  ProductCreateRequest,
  ProjectChangeRequest,
  ProjectCreateRequest,
  ServerCreateRequest,
  TargetRegisterRequest,
  TargetStateChangeRequest,
} from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { type JsonObject, type JsonValue, newId } from '@exponetdb/kernel'
import {
  createPlan,
  type PlanRecord,
  type PlanSubject,
  type StoredActionClass,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { controlStoreSigns, readMarker, sql, TargetError } from '@exponetdb/postgres'
import type { Connector } from './connect.ts'
import { conflict, RegistryError, registrationRefused } from './errors.ts'
import { inspectDatabase } from './inspect.ts'
import {
  evaluateRegistryPolicy,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from './policy.ts'
import {
  activeCredential,
  activeEndpointAt,
  clusterBySystemIdentifier,
  environmentBySlug,
  findTarget,
  getCluster,
  getDatabase,
  getEndpoint,
  getEnvironment,
  getProduct,
  getProject,
  getServer,
  listEndpoints,
  liveTargetOf,
  liveTargetsOfEnvironment,
  pathHeld,
  productBySlug,
  registeredDatabaseNamed,
} from './reads.ts'
import type { EnvironmentRecord, TargetRecord } from './records.ts'
import { invalid, managedScope, parseCaBundle, tlsServerNameFor } from './validate.ts'

/**
 * Registry plans ([operations-engine.md §2, §3](../../../exponetdb-docs/02-control-plane/operations-engine.md),
 * resources.md "Registry"). A planner inspects the current registry (and,
 * where the change depends on what a cluster is, the cluster itself through
 * an observer session of `serve`), refuses what cannot be applied, and
 * stores an immutable plan with
 *
 * - `content`: exactly what the worker will write (new ids included);
 * - `expectedState`: the registry facts the plan was made against; the
 *   kind re-checks them at acceptance and under the locks (`PLAN_STALE`);
 * - `analysis`: what a reviewer needs (tier, production, the writes);
 * - the policy decision (`target.register-prod-approval` for production).
 *
 * Every planner runs in the caller's transaction; nothing in the registry
 * changes until the plan is applied and the worker executes it.
 */
export interface RegistryPlanContext {
  readonly policy: RegistryPolicyContext
  /** This installation's id (`ins_…`), written into identity markers. */
  readonly installationId: string
  /** `serve`'s observer connector, for planners that look at a cluster. */
  readonly connector: Connector
  /** The Control Store's own `system_identifier` (a cluster hosting it is never managed). */
  readonly controlStoreSystemIdentifier: () => Promise<string>
}

interface Draft {
  readonly kind: string
  readonly actionClass: StoredActionClass
  readonly subject: PlanSubject
  readonly content: JsonObject
  readonly expectedState: JsonObject
  readonly analysis?: JsonObject
}

async function store(
  tx: Tx,
  context: Pick<RegistryPlanContext, 'policy'>,
  actor: RegistryActor | 'system',
  draft: Draft,
): Promise<PlanRecord> {
  const subject = {
    ...(draft.subject.productId === undefined ? {} : { productId: draft.subject.productId }),
    ...(draft.subject.projectId === undefined ? {} : { projectId: draft.subject.projectId }),
    ...(draft.subject.environmentId === undefined
      ? {}
      : { environmentId: draft.subject.environmentId }),
    ...(draft.subject.targetId === undefined ? {} : { targetId: draft.subject.targetId }),
    ...(draft.subject.tier === undefined ? {} : { tier: draft.subject.tier }),
  }
  const policy = await evaluateRegistryPolicy(tx, context.policy, {
    kind: draft.kind,
    actor,
    subject,
    content: draft.content,
  })
  return createPlan(
    tx,
    {
      kind: draft.kind,
      kindVersion: 1,
      actionClass: draft.actionClass,
      actor: actor === 'system' ? WORKER_ACTOR : operationActor(actor),
      subject: draft.subject,
      content: draft.content,
      expectedState: draft.expectedState,
      ...(draft.analysis === undefined ? {} : { analysis: draft.analysis }),
      policy,
    },
    { clock: context.policy.clock },
  )
}

const now = (context: RegistryPlanContext) => context.policy.clock.nowMs()

// ----- products, environments, projects, servers -----

export async function planProductCreate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  input: ProductCreateRequest,
): Promise<PlanRecord> {
  if ((await productBySlug(tx, input.slug)) !== undefined) {
    throw conflict('slug_taken')
  }
  const productId = newId('prd', now(context))
  return store(tx, context, actor, {
    kind: 'registry.product.create',
    actionClass: 'standard',
    subject: {},
    content: { productId, slug: input.slug, displayName: input.displayName },
    expectedState: { slugTaken: false },
  })
}

/** The environment a slug names in a product, or a refusal naming the field. */
async function evidenceSource(
  q: Queryable,
  productId: string,
  slug: string | null | undefined,
): Promise<EnvironmentRecord | null> {
  if (slug === null || slug === undefined) return null
  const env = await environmentBySlug(q, productId, slug)
  if (env === undefined) {
    throw conflict('evidence_other_product')
  }
  return env
}

export async function planEnvironmentCreate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  productId: string,
  input: EnvironmentCreateRequest,
): Promise<PlanRecord> {
  const product = await getProduct(tx, productId)
  if (product === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  if ((await environmentBySlug(tx, productId, input.slug)) !== undefined) {
    throw conflict('slug_taken')
  }
  const evidence = await evidenceSource(tx, productId, input.evidenceFrom)
  const environmentId = newId('env', now(context))
  return store(tx, context, actor, {
    kind: 'registry.environment.create',
    actionClass: 'standard',
    subject: { productId, tier: input.tier },
    content: {
      environmentId,
      productId,
      slug: input.slug,
      displayName: input.displayName,
      tier: input.tier,
      evidenceFrom: evidence?.environmentId ?? null,
      rank: input.rank ?? 0,
    },
    expectedState: {
      slugTaken: false,
      evidenceRevision: evidence?.revision ?? null,
    },
    analysis: { production: input.tier === 'prod', evidenceFromSlug: evidence?.slug ?? null },
  })
}

/** Whether making `source` the evidence of `environmentId` closes a cycle. */
async function closesCycle(
  q: Queryable,
  environmentId: string,
  source: EnvironmentRecord,
): Promise<boolean> {
  let current: EnvironmentRecord | undefined = source
  for (let hops = 0; current !== undefined && hops < 64; hops++) {
    if (current.environmentId === environmentId) return true
    current =
      current.evidenceFrom === null ? undefined : await getEnvironment(q, current.evidenceFrom)
  }
  return current !== undefined
}

export async function planEnvironmentUpdate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  productId: string,
  environmentId: string,
  input: EnvironmentChangeRequest,
): Promise<PlanRecord> {
  const env = await getEnvironment(tx, environmentId)
  if (env === undefined || env.productId !== productId) {
    throw new RegistryError('NOT_FOUND')
  }
  const changes: Record<string, JsonValue> = {}
  if (input.displayName !== undefined && input.displayName !== env.displayName) {
    changes['displayName'] = input.displayName
  }
  if (input.rank !== undefined && input.rank !== env.rank) {
    changes['rank'] = input.rank
  }
  const liveTargets = await liveTargetsOfEnvironment(tx, environmentId)
  if (input.tier !== undefined && input.tier !== env.tier) {
    if (liveTargets.length > 0) {
      // Live targets carry the tier in their identity markers (EXG03).
      throw conflict('tier_in_use')
    }
    changes['tier'] = input.tier
  }
  if (input.evidenceFrom !== undefined && input.evidenceFrom !== env.evidenceFromSlug) {
    const source = await evidenceSource(tx, productId, input.evidenceFrom)
    if (source !== null && (await closesCycle(tx, environmentId, source))) {
      throw conflict('evidence_cycle')
    }
    changes['evidenceFrom'] = source?.environmentId ?? null
  }
  if (Object.keys(changes).length === 0) {
    throw invalid('', 'no_change', 'The request changes nothing.')
  }
  const significant = 'tier' in changes || 'evidenceFrom' in changes
  return store(tx, context, actor, {
    kind: 'registry.environment.update',
    actionClass: significant ? 'high' : 'standard',
    subject: { productId, environmentId, tier: env.tier },
    content: { environmentId, revision: env.revision + 1, changes },
    expectedState: { revision: env.revision, tier: env.tier, liveTargets },
    analysis: {
      before: {
        displayName: env.displayName,
        tier: env.tier,
        evidenceFrom: env.evidenceFromSlug,
        rank: env.rank,
      },
      changes: Object.keys(changes).sort(),
      production: env.tier === 'prod' || changes['tier'] === 'prod',
    },
  })
}

async function checkOverride(
  q: Queryable,
  productId: string,
  override: Readonly<Record<string, 'none'>> | undefined,
): Promise<Record<string, 'none'>> {
  const out: Record<string, 'none'> = {}
  for (const slug of Object.keys(override ?? {}).sort()) {
    if ((await environmentBySlug(q, productId, slug)) === undefined) {
      throw invalid(
        `/evidenceOverride/${slug}`,
        'unknown',
        'No environment of the product has this slug.',
      )
    }
    out[slug] = 'none'
  }
  return out
}

export async function planProjectCreate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  input: ProjectCreateRequest,
): Promise<PlanRecord> {
  const product = await productBySlug(tx, input.product)
  if (product === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  const { rows } = await tx.query(
    'registry.plan.project_slug',
    'SELECT 1 FROM registry.projects WHERE product_id = $1 AND slug = $2',
    [product.productId, input.slug],
  )
  if (rows.length > 0) {
    throw conflict('slug_taken')
  }
  const projectId = newId('prj', now(context))
  return store(tx, context, actor, {
    kind: 'registry.project.create',
    actionClass: 'standard',
    subject: { productId: product.productId },
    content: {
      projectId,
      productId: product.productId,
      slug: input.slug,
      displayName: input.displayName,
      managedScope: managedScope(input.managedScope ?? {}),
      evidenceOverride: await checkOverride(tx, product.productId, input.evidenceOverride),
    },
    expectedState: { slugTaken: false },
  })
}

export async function planProjectUpdate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  projectId: string,
  input: ProjectChangeRequest,
): Promise<PlanRecord> {
  const project = await getProject(tx, projectId)
  if (project === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  const changes: Record<string, JsonValue> = {}
  if (input.displayName !== undefined && input.displayName !== project.displayName) {
    changes['displayName'] = input.displayName
  }
  if (input.managedScope !== undefined) {
    const next = managedScope(input.managedScope)
    const before = {
      ...(project.managedScope.includeSchemas === null
        ? {}
        : { includeSchemas: [...project.managedScope.includeSchemas] }),
      excludeSchemas: [...project.managedScope.excludeSchemas],
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      changes['managedScope'] = next
    }
  }
  if (input.evidenceOverride !== undefined) {
    const next = await checkOverride(tx, project.productId, input.evidenceOverride)
    if (JSON.stringify(next) !== JSON.stringify(project.evidenceOverride)) {
      changes['evidenceOverride'] = next
    }
  }
  if (Object.keys(changes).length === 0) {
    throw invalid('', 'no_change', 'The request changes nothing.')
  }
  const significant = 'managedScope' in changes || 'evidenceOverride' in changes
  return store(tx, context, actor, {
    kind: 'registry.project.update',
    actionClass: significant ? 'high' : 'standard',
    subject: { productId: project.productId, projectId },
    content: { projectId, revision: project.revision + 1, changes },
    expectedState: { revision: project.revision },
    analysis: { changes: Object.keys(changes).sort() },
  })
}

export async function planServerCreate(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  input: ServerCreateRequest,
): Promise<PlanRecord> {
  const serverId = newId('srv', now(context))
  return store(tx, context, actor, {
    kind: 'registry.server.create',
    actionClass: 'standard',
    subject: {},
    content: {
      serverId,
      displayName: input.displayName,
      provider: input.provider,
      providerRef: input.providerRef ?? null,
      location: input.location ?? null,
    },
    expectedState: {},
  })
}

// ----- clusters and endpoints -----

interface EndpointContent extends JsonObject {
  endpointId: string
  kind: string
  poolerMode: string | null
  host: string
  port: number
  tlsServerName: string
  label: string
}

async function endpointContent(
  q: Queryable,
  context: RegistryPlanContext,
  input: EndpointRequest,
  path: string,
): Promise<EndpointContent> {
  if (input.kind === 'local_socket') {
    throw invalid(`${path}/kind`, 'unsupported', 'An external cluster is reached over the network.')
  }
  const tlsServerName = tlsServerNameFor(input.host, input.tlsServerName, path)
  if ((await activeEndpointAt(q, input.host, input.port)) !== undefined) {
    throw conflict('address_taken')
  }
  return {
    endpointId: newId('end', now(context)),
    kind: input.kind,
    poolerMode: input.poolerMode ?? null,
    host: input.host,
    port: input.port,
    tlsServerName,
    label: input.label,
  }
}

export async function planClusterRegister(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  input: ClusterRegisterRequest,
): Promise<PlanRecord> {
  if (input.serverId !== undefined && (await getServer(tx, input.serverId)) === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  const certificates = parseCaBundle(input.caBundle)
  const endpoints: EndpointContent[] = []
  const seen = new Set<string>()
  for (const [i, e] of input.endpoints.entries()) {
    const address = `${e.host.toLowerCase()}:${e.port}`
    if (seen.has(address)) {
      throw invalid(`/endpoints/${i}`, 'duplicate', 'Each endpoint has its own address.')
    }
    seen.add(address)
    endpoints.push(await endpointContent(tx, context, e, `/endpoints/${i}`))
  }
  if (!endpoints.some((e) => e.kind !== 'pooler')) {
    throw invalid('/endpoints', 'direct_required', 'A cluster needs at least one direct endpoint.')
  }
  const clusterId = newId('cls', now(context))
  return store(tx, context, actor, {
    kind: 'registry.cluster.register',
    actionClass: 'standard',
    subject: { clusterId },
    content: {
      clusterId,
      displayName: input.displayName,
      serverId: input.serverId ?? null,
      managementMode: 'external',
      caBundle: input.caBundle,
      endpoints,
    },
    expectedState: {
      serverExists: input.serverId !== undefined,
      addresses: [...seen].sort(),
    },
    analysis: {
      caCertificates: certificates.map((c) => ({
        subject: c.subject,
        notAfter: c.notAfter,
        fingerprint256: c.fingerprint256,
        ca: c.ca,
      })),
      endpoints: endpoints.map((e) => ({
        kind: e.kind,
        label: e.label,
        tlsServerName: e.tlsServerName,
      })),
    },
  })
}

/** Reads a cluster's identity through an observer session (planning and execution). */
export async function observeClusterIdentity(
  connector: Connector,
  clusterId: string,
  purpose: string,
): Promise<{ systemIdentifier: string; serverVersionNum: number; endpointId: string }> {
  const opened = await connector.open({
    clusterId,
    database: 'postgres',
    role: 'observer',
    purpose,
    identity: 'unpinned',
  })
  try {
    return {
      systemIdentifier: opened.session.facts.systemIdentifier,
      serverVersionNum: opened.session.facts.serverVersionNum,
      endpointId: opened.endpoint.endpointId,
    }
  } finally {
    await opened.session.close()
  }
}

export async function planClusterConfirm(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: ClusterConfirmRequest,
): Promise<PlanRecord> {
  const cluster = await getCluster(tx, clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  if (cluster.state !== 'pending') {
    throw conflict(cluster.state === 'retired' ? 'cluster_retired' : 'cluster_already_confirmed')
  }
  if ((await activeCredential(tx, clusterId, 'observer')) === undefined) {
    throw conflict('observer_credential_missing')
  }
  const observed = await observeClusterIdentity(
    context.connector,
    clusterId,
    `confirm/${clusterId}`,
  )
  if (observed.systemIdentifier === (await context.controlStoreSystemIdentifier())) {
    throw registrationRefused('cluster_hosts_control_store')
  }
  if (
    input.systemIdentifier !== undefined &&
    input.systemIdentifier !== observed.systemIdentifier
  ) {
    throw new RegistryError('CLUSTER_IDENTITY_MISMATCH')
  }
  if ((await clusterBySystemIdentifier(tx, observed.systemIdentifier)) !== undefined) {
    throw conflict('system_identifier_taken')
  }
  return store(tx, context, actor, {
    kind: 'registry.cluster.confirm',
    actionClass: 'standard',
    subject: { clusterId },
    content: {
      clusterId,
      systemIdentifier: observed.systemIdentifier,
      serverVersionNum: observed.serverVersionNum,
      observedThrough: observed.endpointId,
    },
    expectedState: { state: 'pending' },
    analysis: {
      systemIdentifier: observed.systemIdentifier,
      postgresMajor: Math.floor(observed.serverVersionNum / 10_000),
      expectedByPerson: input.systemIdentifier ?? null,
      controlStore: 'different_cluster',
    },
  })
}

export async function planEndpointAdd(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: EndpointRequest,
): Promise<PlanRecord> {
  const cluster = await getCluster(tx, clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  if (cluster.state === 'retired') {
    throw conflict('cluster_retired')
  }
  const endpoint = await endpointContent(tx, context, input, '')
  const tier = cluster.derivedTier ?? undefined
  return store(tx, context, actor, {
    kind: 'registry.endpoint.add',
    actionClass: cluster.derivedTier === 'nonprod' ? 'standard' : 'high',
    subject: { clusterId, ...(tier === undefined ? {} : { tier }) },
    content: { clusterId, endpoint },
    expectedState: {
      clusterState: cluster.state,
      address: `${input.host.toLowerCase()}:${input.port}`,
    },
    analysis: { derivedTier: cluster.derivedTier, kind: endpoint.kind, label: endpoint.label },
  })
}

export async function planEndpointRetire(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  clusterId: string,
  endpointId: string,
): Promise<PlanRecord> {
  const cluster = await getCluster(tx, clusterId)
  const endpoint = await getEndpoint(tx, endpointId)
  if (cluster === undefined || endpoint === undefined || endpoint.clusterId !== clusterId) {
    throw new RegistryError('NOT_FOUND')
  }
  if (endpoint.state !== 'active') {
    throw conflict('endpoint_retired')
  }
  const direct = (await listEndpoints(tx, clusterId, 'active')).filter((e) => e.kind !== 'pooler')
  if (endpoint.kind !== 'pooler' && direct.length === 1 && cluster.derivedTier !== null) {
    // The last direct path of a cluster that hosts live targets: add another one first.
    throw conflict('no_active_endpoint')
  }
  const tier = cluster.derivedTier ?? undefined
  return store(tx, context, actor, {
    kind: 'registry.endpoint.retire',
    actionClass: cluster.derivedTier === 'nonprod' ? 'standard' : 'high',
    subject: { clusterId, ...(tier === undefined ? {} : { tier }) },
    content: { clusterId, endpointId },
    expectedState: { endpointState: 'active' },
    analysis: { kind: endpoint.kind, label: endpoint.label, remainingDirect: direct.length - 1 },
  })
}

// ----- databases -----

export async function planDatabaseRegister(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  clusterId: string,
  input: DatabaseRegisterRequest,
): Promise<PlanRecord> {
  const cluster = await getCluster(tx, clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  if (cluster.state !== 'active') {
    throw conflict(cluster.state === 'retired' ? 'cluster_retired' : 'cluster_not_confirmed')
  }
  if ((await registeredDatabaseNamed(tx, clusterId, input.name)) !== undefined) {
    throw conflict('database_taken')
  }
  const observed = await inspectDatabase(context.connector, clusterId, input.name, 'observer')
  const databaseId = newId('dbs', now(context))
  const tier = cluster.derivedTier ?? undefined
  return store(tx, context, actor, {
    kind: 'registry.database.register',
    actionClass: 'standard',
    subject: { clusterId, ...(tier === undefined ? {} : { tier }) },
    content: {
      databaseId,
      clusterId,
      name: input.name,
      oid: observed.oid,
      owner: observed.owner,
      encoding: observed.encoding,
      collation: observed.collation,
    },
    expectedState: { clusterState: 'active', systemIdentifier: cluster.systemIdentifier ?? '' },
    analysis: { owner: observed.owner, encoding: observed.encoding, collation: observed.collation },
  })
}

// ----- targets -----

/** A live inspection of the database a target will be stamped on (observer, read-only). */
async function inspectForRegistration(
  context: RegistryPlanContext,
  clusterId: string,
  database: string,
  targetId: string,
): Promise<{ markerBefore: 'absent' | 'same_target'; oid: string }> {
  const opened = await context.connector.open({
    clusterId,
    database,
    role: 'observer',
    purpose: `register/${targetId}`,
  })
  try {
    const signs = await controlStoreSigns(opened.session)
    if (signs.length > 0) {
      throw registrationRefused('control_store')
    }
    if (opened.session.facts.systemIdentifier === (await context.controlStoreSystemIdentifier())) {
      throw registrationRefused('cluster_hosts_control_store')
    }
    const oidRows = await opened.session.query(
      // A constant engine statement: the database's own oid.
      sql`SELECT d.oid::text AS oid FROM pg_catalog.pg_database d
        WHERE d.datname = pg_catalog.current_database()`,
    )
    const oid = oidRows[0]?.text('oid') ?? ''
    const marker = await readMarker(opened.session)
    if (marker.status === 'unreadable') {
      throw registrationRefused('marker_unreadable')
    }
    if (marker.status === 'present') {
      if (marker.marker.installationId !== context.installationId) {
        throw registrationRefused('foreign_installation')
      }
      if (marker.marker.targetId !== targetId) {
        throw registrationRefused('other_target')
      }
      if (marker.marker.generation !== 1) {
        throw registrationRefused('generation_mismatch')
      }
      return { markerBefore: 'same_target', oid }
    }
    const schema = await opened.session.query(
      sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
        WHERE nspname = 'exponetdb') AS present`,
    )
    if (schema[0]?.bool('present') === true) {
      throw registrationRefused('schema_exists_without_marker')
    }
    return { markerBefore: 'absent', oid }
  } finally {
    await opened.session.close()
  }
}

export async function planTargetRegister(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  input: TargetRegisterRequest,
): Promise<PlanRecord> {
  const project = await getProject(tx, input.projectId)
  const env = await getEnvironment(tx, input.environmentId)
  const database = await getDatabase(tx, input.databaseId)
  if (
    project === undefined ||
    env === undefined ||
    database === undefined ||
    env.productId !== project.productId
  ) {
    throw new RegistryError('NOT_FOUND')
  }
  const path = `${project.productSlug}/${project.slug}/${env.slug}`
  // A registration that stopped before activation is planned again for the
  // same target and placement; anything else live at this path is refused.
  const existing = await liveTargetOf(tx, project.projectId, env.environmentId)
  let resumed: TargetRecord | undefined
  if (existing !== undefined) {
    if (existing.state !== 'registered' || existing.placement?.databaseId !== database.databaseId) {
      throw conflict('path_taken')
    }
    resumed = existing
  } else if (await pathHeld(tx, path)) {
    // A decommissioned target keeps its path; a new target never takes it again.
    throw conflict('path_taken')
  }
  if (database.state !== 'registered') {
    throw conflict('database_not_found')
  }
  if (database.placedTargetId !== null && database.placedTargetId !== resumed?.targetId) {
    throw conflict('database_taken')
  }
  const cluster = await getCluster(tx, database.clusterId)
  if (cluster === undefined || cluster.state !== 'active' || cluster.systemIdentifier === null) {
    throw conflict('cluster_not_confirmed')
  }
  const observer = await activeCredential(tx, cluster.clusterId, 'observer')
  const migrator = await activeCredential(tx, cluster.clusterId, 'migrator')
  if (observer === undefined || migrator === undefined) {
    throw conflict('credential_missing')
  }
  const targetId = resumed?.targetId ?? newId('tgt', now(context))
  const placementId = resumed?.placement?.placementId ?? newId('plc', now(context))
  let inspected: Awaited<ReturnType<typeof inspectForRegistration>>
  try {
    inspected = await inspectForRegistration(context, cluster.clusterId, database.name, targetId)
  } catch (error) {
    if (error instanceof TargetError && error.code === 'TARGET_IDENTITY_MISMATCH') {
      throw registrationRefused('database_mismatch')
    }
    throw error
  }
  if (database.observedOid !== null && inspected.oid !== database.observedOid) {
    // Same name, another database (dropped and created again): register it anew.
    throw registrationRefused('database_mismatch')
  }
  return store(tx, context, actor, {
    kind: 'target.register',
    actionClass: 'standard',
    subject: {
      targetId,
      targetPath: path,
      tier: env.tier,
      generation: 1,
      clusterId: cluster.clusterId,
      productId: project.productId,
      projectId: project.projectId,
      environmentId: env.environmentId,
    },
    content: {
      targetId,
      path,
      tier: env.tier,
      generation: 1,
      installationId: context.installationId,
      productId: project.productId,
      projectId: project.projectId,
      environmentId: env.environmentId,
      databaseId: database.databaseId,
      databaseName: database.name,
      databaseOid: database.observedOid,
      clusterId: cluster.clusterId,
      systemIdentifier: cluster.systemIdentifier,
      placementId,
      resumesTarget: resumed !== undefined,
    },
    expectedState: {
      targetState: resumed?.state ?? null,
      databasePlacedTarget: database.placedTargetId,
      environmentRevision: env.revision,
      environmentTier: env.tier,
      clusterState: cluster.state,
      systemIdentifier: cluster.systemIdentifier,
      credentials: { observer: observer.secretVersion, migrator: migrator.secretVersion },
      markerBefore: inspected.markerBefore,
    },
    analysis: {
      production: env.tier === 'prod',
      tier: env.tier,
      cluster: cluster.displayName,
      database: database.name,
      systemIdentifier: cluster.systemIdentifier,
      markerBefore: inspected.markerBefore,
      writes: [
        'schema exponetdb (owner exponetdb_ledger_owner)',
        'exponetdb.target_identity: one row (installation, target, path, tier, generation 1, system_identifier)',
        'exponetdb.ledger_meta: one row; schema_migrations, migration_verifications, migration_events: empty',
      ],
    },
  })
}

const TRANSITIONS = {
  'target.suspend': { from: ['active'], actionClass: 'standard' },
  'target.resume': { from: ['suspended'], actionClass: 'standard' },
  'target.decommission': { from: ['registered', 'active', 'suspended'], actionClass: 'critical' },
} as const

/**
 * The worker's own suspension of a target whose database no longer carries
 * its identity (health.md §3 `identity_mismatch`, order §130): planned and
 * accepted by the system actor and executed like any other suspension, so
 * writes stop through the same guarded path. The system only ever
 * suspends: resuming, re-stamping and decommissioning stay human decisions.
 */
export async function planSystemSuspension(
  tx: Tx,
  context: Pick<RegistryPlanContext, 'policy'>,
  targetId: string,
  /** The state reason (`^[a-z][a-z0-9_]{0,63}$`), e.g. `identity_mismatch`. */
  reason: string,
  /** What was observed (field names and flags, never database text). */
  observed: JsonObject = {},
): Promise<PlanRecord> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason)) {
    throw invalid('/reason', 'invalid', 'A suspension reason is a lowercase code.')
  }
  const target = await findTarget(tx, targetId)
  if (target === undefined) {
    throw new RegistryError('TARGET_NOT_FOUND')
  }
  if (target.state !== 'active') {
    throw conflict('target_state')
  }
  return store(tx, context, 'system', {
    kind: 'target.suspend',
    actionClass: TRANSITIONS['target.suspend'].actionClass,
    subject: {
      targetId: target.targetId,
      targetPath: target.path,
      tier: target.tier,
      generation: target.generation,
      ...(target.placement === null ? {} : { clusterId: target.placement.clusterId }),
      productId: target.productId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    },
    content: {
      targetId: target.targetId,
      reason,
      placementId: target.placement?.placementId ?? null,
    },
    expectedState: { state: target.state, generation: target.generation },
    analysis: {
      from: target.state,
      production: target.tier === 'prod',
      effect: 'writes stop; observation continues',
      initiatedBy: 'system',
      observed,
    },
  })
}

export async function planTargetStateChange(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  kind: keyof typeof TRANSITIONS,
  targetRef: string,
  input: TargetStateChangeRequest,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) {
    throw new RegistryError('TARGET_NOT_FOUND')
  }
  const rule = TRANSITIONS[kind]
  if (!(rule.from as readonly string[]).includes(target.state)) {
    throw conflict('target_state')
  }
  return store(tx, context, actor, {
    kind,
    actionClass: rule.actionClass,
    subject: {
      targetId: target.targetId,
      targetPath: target.path,
      tier: target.tier,
      generation: target.generation,
      ...(target.placement === null ? {} : { clusterId: target.placement.clusterId }),
      productId: target.productId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    },
    content: {
      targetId: target.targetId,
      reason: input.reason,
      placementId: target.placement?.placementId ?? null,
    },
    expectedState: { state: target.state, generation: target.generation },
    analysis: {
      from: target.state,
      production: target.tier === 'prod',
      effect:
        kind === 'target.suspend'
          ? 'writes stop; observation continues'
          : kind === 'target.resume'
            ? 'writes allowed again after the identity marker is checked'
            : 'the target becomes history; its path is never reused; the database is not changed',
    },
  })
}
