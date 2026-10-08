import { isIP } from 'node:net'
import {
  type AccessRole,
  actionDefinition,
  NODE_CAPABILITIES,
  type NodeCapabilityKey,
  type NodeChange,
  type NodeConfigUpdateRequest,
  type NodeInspectionRequest,
  type NodePlanKind,
  takesCluster,
} from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import { b64u } from '@exponetdb/kernel/node'
import { createPlan, type PlanRecord } from '@exponetdb/operations'
import {
  EXPECTED_MEMBERSHIPS,
  EXPECTED_REACH,
  evaluateRegistryPolicy,
  getServer,
  operationActor,
  type RegistryActor,
  type RegistryPolicyContext,
} from '@exponetdb/registry'
import { NodeError } from './errors.ts'
import { argsHashOf } from './jobs.ts'
import {
  type ClusterMapping,
  clusterArg,
  mapCluster,
  requireCapabilities,
  servedNode,
} from './mapping.ts'
import {
  latestObservation,
  OBSERVATION_MAX_AGE_MS,
  type ObservationRecord,
} from './observations.ts'
import { bundleTrusts, postgresCa } from './postgres-ca.ts'

/**
 * Plans of capability operations, made by `serve` from the change and the
 * latest node-signed observation ([control-plane.md §9.2, §9.3](../../../exponetdb-docs/07-node-agent/control-plane.md#93-plans-nodeplan)).
 * A plan never waits for a host: the analysis is the observation's, and the
 * worker checks the host again when the change runs.
 */

export interface CapabilityPlanContext {
  readonly policy: RegistryPolicyContext
  /**
   * The addresses serve and the worker connect to managed clusters from
   * (`EXPONETDB_EGRESS_ADDRESSES`): a pg_hba plan protects ExponetDB's own
   * access from them (§9.6).
   */
  readonly egressAddresses?: readonly string[]
}

export type CapabilityKindName = NodePlanKind | 'credential.rotate' | 'node.config.update'

/** The capability whose observation a plan binds (§9.3). */
export const BASIS: Readonly<Record<CapabilityKindName, NodeCapabilityKey>> = {
  'postgres.reload': 'postgres.status@1',
  'postgres.restart': 'postgres.restart.plan@1',
  'postgres.config.apply': 'postgres.config.plan@2',
  'postgres.hba.apply': 'postgres.hba.inspect@2',
  'postgres.roles.apply': 'postgres.roles.inspect@2',
  'postgres.extensions.apply': 'postgres.extensions.inspect@1',
  'postgres.tls.rotate': 'postgres.tls.inspect@1',
  'credential.rotate': 'postgres.roles.inspect@2',
  'node.config.update': 'agent.diagnostics@2',
}

/**
 * The capabilities a kind runs at apply time (each must be accepted by the
 * node). The majors the Wave 5 correction retired (F1) are never run: a node
 * whose agent does not accept the current major cannot be planned for.
 */
export const RUNS: Readonly<Record<CapabilityKindName, readonly NodeCapabilityKey[]>> = {
  'postgres.reload': ['postgres.status@1', 'postgres.reload@2'],
  'postgres.restart': ['postgres.restart.plan@1', 'postgres.status@1', 'postgres.restart@1'],
  'postgres.config.apply': [
    'postgres.config.inspect@2',
    'postgres.config.plan@2',
    'postgres.config.apply@2',
  ],
  'postgres.hba.apply': ['postgres.hba.inspect@2', 'postgres.hba.apply@2'],
  'postgres.roles.apply': ['postgres.roles.inspect@2', 'postgres.roles.apply@2'],
  'postgres.extensions.apply': ['postgres.extensions.inspect@1', 'postgres.extensions.apply@1'],
  'postgres.tls.rotate': ['postgres.tls.inspect@1', 'postgres.tls.plan@1', 'postgres.tls.rotate@1'],
  'credential.rotate': ['postgres.roles.inspect@2', 'postgres.roles.apply@2'],
  'node.config.update': ['agent.diagnostics@2', 'config.update@1'],
}

/** The arguments of a kind's basis capability (its observation is looked up by their hash). */
export function basisArgs(
  kind: CapabilityKindName,
  mapping: Pick<ClusterMapping, 'localName' | 'systemIdentifier'>,
  change: JsonObject,
): JsonObject {
  const cluster = clusterArg(mapping)
  switch (kind) {
    case 'postgres.config.apply':
      return { cluster, changes: change['changes'] ?? [] }
    case 'postgres.extensions.apply':
      return { cluster, database: change['database'] ?? null }
    case 'postgres.roles.apply':
    case 'credential.rotate':
      return { cluster, expectSettings: [] }
    default:
      return { cluster }
  }
}

/**
 * What a restart would disrupt, as its plan binds it (§9.3): running base
 * backups or maintenance and the active replication slots. Connections come
 * and go; they are shown, not bound.
 */
export function restartDigest(result: JsonObject): string {
  const count = (v: JsonValue | undefined) => (typeof v === 'number' ? v : 0)
  const slots = list(result['replicationSlots'])
    .filter((s) => isJsonObject(s) && s['active'] === true)
    .map((s) => str(s, 'name') ?? '')
    .sort()
  return argsHashOf({
    backups: count(result['activeBackups']) > 0,
    maintenance: count(result['activeMaintenance']) > 0,
    activeSlots: slots,
  })
}

/** The digest a plan binds from its basis observation, or null for kinds that bind none. */
export function basisDigest(kind: CapabilityKindName, result: JsonObject): string | null {
  const text = (v: JsonValue | undefined) => (typeof v === 'string' ? v : null)
  switch (kind) {
    case 'postgres.restart':
      return restartDigest(result)
    case 'postgres.config.apply':
      return text(result['configVersion'])
    case 'postgres.hba.apply':
      return text(result['fileDigest'])
    case 'postgres.roles.apply':
      return text(result['rolesDigest'])
    case 'postgres.extensions.apply':
      return text(result['extensionsDigest'])
    case 'postgres.tls.rotate': {
      const certificate = result['certificate']
      return isJsonObject(certificate) ? text(certificate['fingerprint']) : null
    }
    default:
      return null
  }
}

function classOf(
  kind: CapabilityKindName | 'node.inspect',
  tier: 'prod' | 'nonprod',
  byPlan: 'high' | 'critical' | undefined,
) {
  const rule = actionDefinition(kind).class
  if (rule.kind === 'fixed') {
    return rule.class
  }
  if (rule.kind === 'by_tier') {
    return tier === 'prod' ? rule.prod : rule.nonprod
  }
  if (byPlan === undefined || !rule.possible.includes(byPlan)) {
    throw new NodeError('INTERNAL')
  }
  return byPlan
}

async function storePlan(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  draft: {
    readonly kind: CapabilityKindName | 'node.inspect'
    readonly tier: 'prod' | 'nonprod'
    readonly subject: {
      readonly clusterId?: string
      readonly nodeId: string
      readonly serverId: string
    }
    readonly content: JsonObject
    readonly expectedState: JsonObject
    readonly analysis: JsonObject
    /** The class the analysis gives a kind whose class is decided by its plan. */
    readonly byPlan?: 'high' | 'critical'
  },
): Promise<PlanRecord> {
  const actionClass = classOf(draft.kind, draft.tier, draft.byPlan)
  if (actionClass === 'read') {
    throw new NodeError('INTERNAL')
  }
  const policy = await evaluateRegistryPolicy(tx, context.policy, {
    kind: draft.kind,
    actor,
    subject: { tier: draft.tier },
    content: draft.content,
  })
  return createPlan(
    tx,
    {
      kind: draft.kind,
      kindVersion: 1,
      actionClass,
      actor: operationActor(actor),
      subject: { ...draft.subject, tier: draft.tier },
      content: draft.content,
      expectedState: draft.expectedState,
      analysis: draft.analysis,
      policy,
    },
    { clock: context.policy.clock },
  )
}

// ----- node.inspect -----

/** The tier of a server's clusters, production when unknown. */
async function serverTier(q: Queryable, serverId: string): Promise<'prod' | 'nonprod'> {
  return (await getServer(q, serverId))?.derivedTier ?? 'prod'
}

/** `node.inspect`: one read or plan capability on a node (§9.2); accepted by the caller in the same transaction. */
export async function planNodeInspection(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  nodeId: string,
  request: NodeInspectionRequest,
): Promise<PlanRecord> {
  const now = context.policy.clock.nowMs()
  const capability = request.capability
  const node = await servedNode(tx, { nodeId }, now)
  requireCapabilities(node, [capability])
  if (Object.hasOwn(request.args, 'cluster')) {
    throw new NodeError('VALIDATION_FAILED')
  }
  let mapping: ClusterMapping | undefined
  let args: JsonObject = { ...(request.args as JsonObject) }
  if (takesCluster(capability)) {
    if (request.clusterId !== null) {
      mapping = (await mapCluster(tx, request.clusterId, now, { nodeId })).mapping
    }
    args = { ...args, cluster: mapping === undefined ? null : clusterArg(mapping) }
  } else if (request.clusterId !== null) {
    throw new NodeError('VALIDATION_FAILED')
  }
  if (!NODE_CAPABILITIES[capability].args.safeParse(args).success) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const tier = mapping?.tier ?? (await serverTier(tx, node.serverId))
  return storePlan(tx, context, actor, {
    kind: 'node.inspect',
    tier,
    subject: {
      nodeId,
      serverId: node.serverId,
      ...(mapping === undefined ? {} : { clusterId: mapping.clusterId }),
    },
    content: {
      nodeId,
      serverId: node.serverId,
      clusterId: mapping?.clusterId ?? null,
      capability,
      args,
      argsHash: argsHashOf(args),
    },
    expectedState: {
      nodeId,
      localName: mapping?.localName ?? null,
      systemIdentifier: mapping?.systemIdentifier ?? null,
    },
    analysis: { capability, kind: NODE_CAPABILITIES[capability].kind },
  })
}

// ----- node.plan -----

async function basisObservation(
  q: Queryable,
  kind: CapabilityKindName,
  mapping: ClusterMapping,
  change: JsonObject,
): Promise<ObservationRecord> {
  const capability = BASIS[kind]
  const observation = await latestObservation(q, {
    nodeId: mapping.nodeId,
    clusterId: mapping.clusterId,
    capability,
    argsHash: argsHashOf(basisArgs(kind, mapping, change)),
    withinMs: OBSERVATION_MAX_AGE_MS,
  })
  if (observation === undefined) {
    throw new NodeError('NODE_OBSERVATION_STALE', { capability })
  }
  return observation
}

const OWN_ROLE = /^exponetdb_/

/** The roles a role is a direct or indirect member of, as the observation shows. */
function ancestors(observed: JsonObject, role: string): Set<string> {
  const out = new Set<string>()
  const queue = [role]
  const memberships = list(observed['memberships'])
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const m of memberships) {
      const group = str(m, 'role')
      if (str(m, 'member') === next && group !== null && !out.has(group)) {
        out.add(group)
        queue.push(group)
      }
    }
  }
  return out
}

/**
 * Roles a grant to which would widen ExponetDB's own roles: those roles and
 * every role they are a direct or indirect member of (§9.3).
 */
function ownRolesReach(observed: JsonObject): Set<string> {
  const out = new Set<string>()
  const names = [
    ...list(observed['roles']).map((r) => str(r, 'name')),
    ...list(observed['memberships']).map((m) => str(m, 'member')),
  ]
  for (const name of names) {
    if (name !== null && OWN_ROLE.test(name)) {
      out.add(name)
      for (const a of ancestors(observed, name)) out.add(a)
    }
  }
  return out
}

/**
 * A step's class (§9.3), from the step and the observation: critical for a
 * `createrole`, `replication` or `bypassrls` attribute, and for a membership
 * in a predefined role or in a role that has, or reaches through its own
 * memberships, a privileged attribute or a predefined role.
 */
function roleStepClass(step: JsonObject, observed: JsonObject): 'critical' | 'high' {
  const attributes = step['attributes']
  if (isJsonObject(attributes)) {
    for (const a of ['createrole', 'replication', 'bypassrls'] as const) {
      if (attributes[a] === true) {
        return 'critical'
      }
    }
  }
  const group = str(step, 'role')
  if (step['op'] === 'grant_membership' && group !== null) {
    const privileged = new Set(
      list(observed['roles'])
        .filter(
          (r) =>
            isJsonObject(r) &&
            (r['superuser'] === true ||
              r['createrole'] === true ||
              r['replication'] === true ||
              r['bypassrls'] === true),
        )
        .map((r) => str(r, 'name')),
    )
    for (const g of [group, ...ancestors(observed, group)]) {
      if (g.startsWith('pg_') || privileged.has(g)) {
        return 'critical'
      }
    }
  }
  return 'high'
}

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function str(o: JsonValue | undefined, key: string): string | null {
  if (!isJsonObject(o)) return null
  const v = o[key]
  return typeof v === 'string' ? v : null
}

/** Checks a change against its basis observation; returns the plan's analysis. */
function analyze(kind: NodePlanKind, change: JsonObject, result: JsonObject): JsonObject {
  switch (kind) {
    case 'postgres.reload':
    case 'postgres.restart':
      if (kind === 'postgres.reload' && result['running'] !== true) {
        throw new NodeError('CONFLICT')
      }
      return { observed: result }
    case 'postgres.config.apply': {
      const include = result['managedInclude']
      if (!isJsonObject(include) || include['included'] !== true) {
        throw new NodeError('CONFLICT')
      }
      const parameters = list(result['parameters'])
      for (const p of parameters) {
        if (!isJsonObject(p) || p['valid'] !== true) {
          throw new NodeError('VALIDATION_FAILED')
        }
        if (p['conflict'] !== null) {
          throw new NodeError('CONFLICT')
        }
      }
      const planned = list(change['changes']).map((c) => str(c, 'name'))
      const analyzed = parameters.map((p) => str(p, 'name'))
      if (planned.length !== analyzed.length || planned.some((n, i) => n !== analyzed[i])) {
        throw new NodeError('CONFLICT')
      }
      const restart = parameters.some((p) => isJsonObject(p) && p['effect'] === 'restart')
      return { parameters, managedInclude: include, needsRestart: restart }
    }
    case 'postgres.hba.apply': {
      const rules = list(result['rules'])
      return {
        hbaFile: result['hbaFile'] ?? null,
        managedBlockBefore: result['managedBlock'] ?? null,
        foreignRules: rules.filter((r) => isJsonObject(r) && r['managed'] === false).length,
        managedRulesAfter: list(change['managedRules']).length,
      }
    }
    case 'postgres.roles.apply': {
      const steps = list(change['steps'])
      const widening = ownRolesReach(result)
      for (const s of steps) {
        const role = str(s, 'role')
        const member = str(s, 'member')
        if ((role !== null && OWN_ROLE.test(role)) || (member !== null && OWN_ROLE.test(member))) {
          // ExponetDB's own roles change only through credential.rotate and the bootstrap SQL.
          throw new NodeError('VALIDATION_FAILED')
        }
        if (
          str(s, 'op') === 'grant_membership' &&
          member !== null &&
          (member.startsWith('pg_') || widening.has(member))
        ) {
          // A grant to a predefined role, or to a role ExponetDB's roles belong
          // to, widens every holder of it (the agent refuses it too).
          throw new NodeError('VALIDATION_FAILED')
        }
      }
      const classified = steps.map((s) => ({
        op: str(s, 'op'),
        role: str(s, 'role'),
        classification: isJsonObject(s) ? roleStepClass(s, result) : 'high',
      }))
      return { steps: classified }
    }
    case 'postgres.extensions.apply': {
      const installed = new Map(
        list(result['installed']).flatMap((e) =>
          isJsonObject(e) && typeof e['name'] === 'string' ? [[e['name'], e]] : [],
        ),
      )
      const available = new Map(
        list(result['available']).flatMap((e) =>
          isJsonObject(e) && typeof e['name'] === 'string'
            ? [[e['name'], list(e['versions'])]]
            : [],
        ),
      )
      const seen = new Set<string>()
      for (const step of list(change['steps'])) {
        const name = str(step, 'name') ?? ''
        const version = str(step, 'version')
        const op = str(step, 'op')
        if (!(available.get(name) ?? []).includes(version)) {
          throw new NodeError('CONFLICT')
        }
        const present = installed.has(name) || seen.has(name)
        if ((op === 'create') === present) {
          throw new NodeError('CONFLICT')
        }
        seen.add(name)
      }
      return { database: change['database'] ?? null, installedBefore: [...installed.values()] }
    }
    case 'postgres.tls.rotate':
      return { certificateBefore: result['certificate'] ?? null, ssl: result['ssl'] ?? null }
  }
}

/** Placed targets of a cluster: a restart takes their schema domains (operations-engine.md §7). */
async function placedTargets(q: Queryable, clusterId: string): Promise<string[]> {
  const { rows } = await q.query(
    'nodes.plan.placed_targets',
    `SELECT DISTINCT pl.target_id FROM registry.placements pl
       JOIN registry.databases d ON d.database_id = pl.database_id
      WHERE d.cluster_id = $1 AND pl.valid_to IS NULL ORDER BY 1`,
    [clusterId],
  )
  return rows.map((r) => r.text('target_id'))
}

function mappingContent(m: ClusterMapping): JsonObject {
  return {
    nodeId: m.nodeId,
    serverId: m.serverId,
    clusterId: m.clusterId,
    localName: m.localName,
    systemIdentifier: m.systemIdentifier,
  }
}

/**
 * ExponetDB's own network access to a cluster, which a pg_hba plan protects
 * (§9.6): every access role with an active credential, to every registered
 * database (or `postgres`), from every egress address. A cluster with such
 * credentials and no egress address configured cannot be planned.
 */
async function ownNetworkAccess(
  q: Queryable,
  clusterId: string,
  addresses: readonly string[],
): Promise<JsonObject[]> {
  const roles = await q.query(
    'nodes.plan.active_roles',
    `SELECT DISTINCT access_role FROM registry.credentials
      WHERE cluster_id = $1 AND state = 'active' ORDER BY 1`,
    [clusterId],
  )
  if (roles.rows.length === 0) {
    return []
  }
  if (addresses.length === 0) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'egress_addresses_unknown' })
  }
  const dbs = await q.query(
    'nodes.plan.databases',
    `SELECT name FROM registry.databases WHERE cluster_id = $1 AND state = 'registered' ORDER BY 1`,
    [clusterId],
  )
  const databases = dbs.rows.length === 0 ? ['postgres'] : dbs.rows.map((r) => r.text('name'))
  const out: JsonObject[] = []
  for (const r of roles.rows) {
    for (const database of databases) {
      for (const address of addresses) {
        out.push({
          role: `exponetdb_${r.text('access_role')}`,
          database,
          address,
          method: 'scram-sha-256',
        })
      }
    }
  }
  return out
}

/**
 * A server certificate names only what the registry knows of the cluster
 * (§9.5): every DNS name is an active endpoint's TLS server name or host,
 * every IP address an active endpoint's host.
 */
async function requireRegisteredNames(q: Queryable, clusterId: string, change: JsonObject) {
  const { rows } = await q.query(
    'nodes.plan.endpoint_names',
    `SELECT host, tls_server_name FROM registry.endpoints WHERE cluster_id = $1 AND state = 'active'`,
    [clusterId],
  )
  const names = new Set<string>()
  const ips = new Set<string>()
  for (const r of rows) {
    const host = r.text('host').toLowerCase()
    if (isIP(host) === 0) names.add(host)
    else ips.add(host)
    const server = r.textOrNull('tls_server_name')
    if (server !== null) names.add(server.toLowerCase())
  }
  for (const n of list(change['dnsNames'])) {
    if (typeof n !== 'string' || n.length > 253 || !names.has(n.toLowerCase())) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'tls_name_not_registered' })
    }
  }
  for (const a of list(change['ipAddresses'])) {
    if (typeof a !== 'string' || isIP(a) === 0) {
      throw new NodeError('VALIDATION_FAILED')
    }
    if (!ips.has(a.toLowerCase())) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'tls_name_not_registered' })
    }
  }
}

/** `node.plan`: a PostgreSQL operation through the node, bound to its basis observation (§9.3). */
export async function planNodeOperation(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  nodeId: string,
  request: { readonly clusterId: string; readonly change: NodeChange },
): Promise<PlanRecord> {
  const kind = request.change.kind
  const { mapping, node } = await mapCluster(tx, request.clusterId, context.policy.clock.nowMs(), {
    nodeId,
  })
  requireCapabilities(node, [BASIS[kind], ...RUNS[kind]])
  const change = request.change as unknown as JsonObject
  if (kind === 'postgres.tls.rotate') {
    const ca = await postgresCa(tx)
    if (ca === undefined) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'postgres_ca_missing' })
    }
    if (!bundleTrusts(mapping.caBundle, ca)) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'ca_bundle_lacks_postgres_ca' })
    }
  }
  if (kind === 'postgres.tls.rotate') {
    await requireRegisteredNames(tx, mapping.clusterId, change)
  }
  const observation = await basisObservation(tx, kind, mapping, change)
  let analysis = analyze(kind, change, observation.result)
  const digest = basisDigest(kind, observation.result)
  const { kind: _kind, ...rest } = change
  const fields: Record<string, JsonValue> = { ...rest }
  if (kind === 'postgres.hba.apply') {
    const derived = await ownNetworkAccess(tx, mapping.clusterId, context.egressAddresses ?? [])
    const requested = list(fields['protectedAccess'])
    const merged = new Map<string, JsonValue>()
    for (const a of [...requested, ...derived]) merged.set(JSON.stringify(a), a)
    // The agent adds its own peer access: one place of the job's 64 stays free.
    if (merged.size > 63) {
      throw new NodeError('VALIDATION_FAILED')
    }
    fields['protectedAccess'] = [...merged.values()]
    analysis = { ...analysis, protectedAccess: { requested: requested.length, derived } }
  }
  const steps = list(analysis['steps'])
  const byPlan =
    kind === 'postgres.roles.apply'
      ? steps.some((s) => str(s, 'classification') === 'critical')
        ? ('critical' as const)
        : ('high' as const)
      : undefined
  return storePlan(tx, context, actor, {
    kind,
    tier: mapping.tier,
    ...(byPlan === undefined ? {} : { byPlan }),
    subject: { clusterId: mapping.clusterId, nodeId, serverId: mapping.serverId },
    content: {
      ...mappingContent(mapping),
      change: fields,
      basis: { capability: BASIS[kind], jobId: observation.jobId, digest },
      ...(kind === 'postgres.restart'
        ? { targetIds: await placedTargets(tx, mapping.clusterId) }
        : {}),
    },
    expectedState: {
      nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
      basisDigest: digest,
    },
    analysis: {
      ...analysis,
      basis: {
        capability: BASIS[kind],
        observedAt: observation.observedAt.toISOString(),
        source: 'agent_reported',
      },
      tier: mapping.tier,
    },
  })
}

/** `credential.rotate` on an agent-managed cluster (§9.7). */
export async function planCredentialRotation(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  clusterId: string,
  role: AccessRole,
): Promise<PlanRecord> {
  const { mapping, node } = await mapCluster(tx, clusterId, context.policy.clock.nowMs())
  requireCapabilities(node, [BASIS['credential.rotate'], ...RUNS['credential.rotate']])
  const roleName = `exponetdb_${role}`
  const observation = await basisObservation(tx, 'credential.rotate', mapping, {})
  const row = list(observation.result['roles']).find(
    (r) => isJsonObject(r) && r['name'] === roleName && r['login'] === true,
  )
  if (!isJsonObject(row)) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'role_missing' })
  }
  // The role must already be at its documented least privilege, as the
  // login verification checks it: a role that is not would fail that
  // verification after the host already has the new password (§9.7).
  const memberships = list(observation.result['memberships'])
    .filter((m) => str(m, 'member') === roleName)
    .map((m) => {
      const o = isJsonObject(m) ? m : {}
      return `${str(o, 'role')}:${o['inherit'] === true ? 'i' : '-'}${o['set'] === true ? 's' : '-'}`
    })
    .sort()
  const expected = [...EXPECTED_MEMBERSHIPS[role]].sort()
  const bypass = role === 'reader' || role === 'verifier'
  if (
    row['superuser'] !== false ||
    row['createdb'] !== false ||
    row['createrole'] !== false ||
    row['replication'] !== false ||
    row['bypassrls'] !== bypass ||
    memberships.join(',') !== expected.join(',') ||
    // Every role it reaches, predefined roles' own memberships included
    // (a pg_monitor widened behind ExponetDB's back).
    [...ancestors(observation.result, roleName)].some((r) => !EXPECTED_REACH[role].includes(r))
  ) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'role_privileges' })
  }
  const { rows } = await tx.query(
    'nodes.plan.active_credential',
    `SELECT credential_id FROM registry.credentials
      WHERE cluster_id = $1 AND access_role = $2 AND state = 'active'`,
    [clusterId, role],
  )
  const replaces = rows[0]?.text('credential_id') ?? null
  return storePlan(tx, context, actor, {
    kind: 'credential.rotate',
    tier: mapping.tier,
    subject: { clusterId, nodeId: mapping.nodeId, serverId: mapping.serverId },
    content: {
      ...mappingContent(mapping),
      role,
      roleName,
      basis: { capability: BASIS['credential.rotate'], jobId: observation.jobId, digest: null },
    },
    expectedState: {
      nodeId: mapping.nodeId,
      localName: mapping.localName,
      systemIdentifier: mapping.systemIdentifier,
      basisDigest: null,
      activeCredentialId: replaces,
    },
    analysis: {
      role,
      roleName,
      replacesCredentialId: replaces,
      tier: mapping.tier,
      basis: {
        capability: BASIS['credential.rotate'],
        observedAt: observation.observedAt.toISOString(),
        source: 'agent_reported',
      },
    },
  })
}

// ----- node.config.update (§9.8) -----

/** The job keys a node trusts, as the Control Store records them. */
export async function trustedJobKeys(q: Queryable, nodeId: string): Promise<string[]> {
  const { rows } = await q.query(
    'nodes.plan.trusted_job_keys',
    'SELECT trusted_job_keys FROM nodes.nodes WHERE node_id = $1',
    [nodeId],
  )
  return list(rows[0]?.json('trusted_job_keys') as JsonValue).filter(
    (k): k is string => typeof k === 'string',
  )
}

/** The digest a job-key change binds: the key set, order aside. */
export function jobKeySetDigest(keys: readonly string[]): string {
  return argsHashOf({ jobKeys: [...keys].sort() })
}

/**
 * `node.config.update`: staged or active keys added to one node, retiring or
 * retired keys removed from it (§9.8). The plan binds the node's recorded
 * set, the active key and the state of every named key.
 */
export async function planNodeConfigUpdate(
  tx: Tx,
  context: CapabilityPlanContext,
  actor: RegistryActor,
  nodeId: string,
  request: NodeConfigUpdateRequest,
): Promise<PlanRecord> {
  const node = await servedNode(tx, { nodeId }, context.policy.clock.nowMs())
  requireCapabilities(node, RUNS['node.config.update'])
  const trusted = await trustedJobKeys(tx, nodeId)
  const named = [...request.addJobKeys, ...request.retireJobKeys]
  const { rows } = await tx.query(
    'nodes.plan.job_keys',
    `SELECT key_id, public_key, state,
            state = 'retiring' AND state_changed_at > clock_timestamp() - interval '7 days' AS overlap
       FROM nodes.job_keys
      WHERE key_id = ANY($1::text[]) OR state = 'active'`,
    [named],
  )
  const keys = new Map(
    rows.map((r) => [
      r.text('key_id'),
      { state: r.text('state'), publicKey: r.bytes('public_key'), overlap: r.bool('overlap') },
    ]),
  )
  const active = rows.find((r) => r.text('state') === 'active')?.text('key_id')
  if (active === undefined) {
    throw new NodeError('PRECONDITION_FAILED')
  }
  const add = request.addJobKeys.map((keyId) => {
    const key = keys.get(keyId)
    if (key === undefined || !['staged', 'active'].includes(key.state) || trusted.includes(keyId)) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'job_key_not_addable' })
    }
    return { keyId, publicKey: b64u(key.publicKey) }
  })
  for (const keyId of request.retireJobKeys) {
    const key = keys.get(keyId)
    if (
      key === undefined ||
      !['retiring', 'retired'].includes(key.state) ||
      !trusted.includes(keyId)
    ) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'job_key_not_removable' })
    }
    // The old key stays trusted for 7 days after its successor activated (ADR-0024 §1).
    if (key.overlap) {
      throw new NodeError('REGISTRY_CONFLICT', { reason: 'job_key_overlap' })
    }
  }
  const after = [
    ...trusted.filter((k) => !request.retireJobKeys.includes(k)),
    ...request.addJobKeys,
  ]
  if (after.length < 1 || after.length > 3 || !after.includes(active)) {
    throw new NodeError('REGISTRY_CONFLICT', { reason: 'job_keys_invalid' })
  }
  const keyStates: Record<string, JsonValue> = {}
  for (const k of named) {
    keyStates[k] = keys.get(k)?.state ?? null
  }
  return storePlan(tx, context, actor, {
    kind: 'node.config.update',
    tier: await serverTier(tx, node.serverId),
    subject: { nodeId, serverId: node.serverId },
    content: {
      nodeId,
      serverId: node.serverId,
      addJobKeys: add,
      retireJobKeys: [...request.retireJobKeys],
      before: [...trusted].sort(),
      after: [...after].sort(),
      // A job the added key signs verifies the change (§9.8); without one,
      // whatever key is active when it runs.
      verifyWith: request.addJobKeys[request.addJobKeys.length - 1] ?? null,
    },
    expectedState: {
      nodeId,
      trustedJobKeys: jobKeySetDigest(trusted),
      activeJobKey: active,
      keyStates,
    },
    analysis: {
      before: [...trusted].sort(),
      after: [...after].sort(),
      activeJobKey: active,
      gateway: 'unchanged',
      source: 'control_store',
    },
  })
}
