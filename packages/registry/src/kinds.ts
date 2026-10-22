import type { Tx } from '@exponetdb/control-store'
import type {
  ChangedBinding,
  ExecutionContext,
  OperationKind,
  PlanRecord,
} from '@exponetdb/operations'
import { readMarker } from '@exponetdb/postgres'
import { Body } from './content.ts'
import { RegistryError } from './errors.ts'
import {
  ExecutionRoleBindingSetKind,
  ExecutionRoleExceptionDeclareKind,
  ExecutionRoleExceptionRevokeKind,
} from './execution-roles.ts'
import { inspectDatabase } from './inspect.ts'
import { RegistryKind, type RegistryKindDeps, refusalOf } from './kind-base.ts'
import { observeClusterIdentity } from './plans.ts'
import {
  activeEndpointAt,
  clusterBySystemIdentifier,
  findTarget,
  getCluster,
  getDatabase,
  getEndpoint,
  getEnvironment,
  getProject,
  getServer,
  listEndpoints,
  liveTargetsOfEnvironment,
  productBySlug,
} from './reads.ts'
import { TargetRegisterKind } from './register.ts'

/**
 * Registry operation kinds ([operations-engine.md §2](../../../exponetdb-docs/02-control-plane/operations-engine.md#2-operation-kinds)):
 * products, environments, projects, servers, clusters, endpoints,
 * databases and the target lifecycle. `target.register` is in `register.ts`.
 */

// ----- products, environments, projects, servers -----

export class ProductCreateKind extends RegistryKind {
  readonly kind = 'registry.product.create'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, content: Body) {
    return (await productBySlug(this.deps.store, content.text('slug'))) === undefined
      ? []
      : [{ binding: 'slugTaken', expected: false, actual: true }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.product.insert',
        `INSERT INTO registry.products (product_id, slug, display_name, created_by_operation_id)
         VALUES ($1, $2, $3, $4)`,
        [c.id('prd', 'productId'), c.text('slug'), c.text('displayName'), ctx.operationId],
      )
      await this.audit(tx, ctx, { productId: c.text('productId'), slug: c.text('slug') })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.product.verify',
      'SELECT 1 FROM registry.products WHERE product_id = $1 AND created_by_operation_id = $2',
      [c.text('productId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

export class EnvironmentCreateKind extends RegistryKind {
  readonly kind = 'registry.environment.create'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const changed: ChangedBinding[] = []
    const product = c.text('productId')
    const { rows } = await this.deps.store.query(
      'registry.kind.environment.slug',
      'SELECT 1 FROM registry.environments WHERE product_id = $1 AND slug = $2',
      [product, c.text('slug')],
    )
    if (rows.length > 0) changed.push({ binding: 'slugTaken', expected: false, actual: true })
    const evidence = c.textOrNull('evidenceFrom')
    if (evidence !== null) {
      const env = await getEnvironment(this.deps.store, evidence)
      if (
        env === undefined ||
        env.productId !== product ||
        env.revision !== expected.intOrNull('evidenceRevision')
      ) {
        changed.push({
          binding: 'evidenceRevision',
          expected: expected.intOrNull('evidenceRevision'),
          actual: env?.revision ?? null,
        })
      }
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.environment.insert',
        `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, evidence_from, rank,
                                            created_by_operation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          c.id('env', 'environmentId'),
          c.id('prd', 'productId'),
          c.text('slug'),
          c.text('displayName'),
          c.oneOf(['prod', 'nonprod'] as const, 'tier'),
          c.idOrNull('env', 'evidenceFrom'),
          c.int('rank'),
          ctx.operationId,
        ],
      )
      await this.audit(tx, ctx, {
        environmentId: c.text('environmentId'),
        productId: c.text('productId'),
        slug: c.text('slug'),
        tier: c.text('tier'),
        evidenceFrom: c.textOrNull('evidenceFrom'),
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.environment.verify',
      `SELECT 1 FROM registry.environments WHERE environment_id = $1 AND created_by_operation_id = $2
         AND tier = $3 AND revision = 1`,
      [c.text('environmentId'), ctx.operationId, c.text('tier')],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.environment.reconcile',
      'SELECT 1 FROM registry.environments WHERE environment_id = $1 AND created_by_operation_id = $2',
      [c.text('environmentId'), ctx.operationId],
    )
  }
}

export class EnvironmentUpdateKind extends RegistryKind {
  readonly kind = 'registry.environment.update'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const env = await getEnvironment(this.deps.store, c.text('environmentId'))
    const changed: ChangedBinding[] = []
    if (env === undefined || env.revision !== expected.int('revision')) {
      changed.push({
        binding: 'revision',
        expected: expected.int('revision'),
        actual: env?.revision ?? null,
      })
    }
    const live = await liveTargetsOfEnvironment(this.deps.store, c.text('environmentId'))
    const before = expected
      .list('liveTargets')
      .map((t) => `${t.text('targetId')}@${t.int('generation')}`)
    const now = live.map((t) => `${t.targetId}@${t.generation}`)
    if (before.join(',') !== now.join(',')) {
      changed.push({
        binding: 'liveTargets',
        expected: before.join(',').slice(0, 512),
        actual: now.join(',').slice(0, 512),
      })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    const changes = c.object('changes')
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.environment.update',
        `UPDATE registry.environments
            SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
                tier = CASE WHEN $5::boolean THEN $6 ELSE tier END,
                evidence_from = CASE WHEN $7::boolean THEN $8 ELSE evidence_from END,
                rank = CASE WHEN $9::boolean THEN $10::int ELSE rank END,
                revision = $2, updated_by_operation_id = $11
          WHERE environment_id = $1 AND revision = $2 - 1`,
        [
          c.id('env', 'environmentId'),
          c.int('revision'),
          changes.has('displayName'),
          changes.textOrNull('displayName'),
          changes.has('tier'),
          changes.has('tier') ? changes.oneOf(['prod', 'nonprod'] as const, 'tier') : null,
          changes.has('evidenceFrom') || changes.raw('evidenceFrom') === null,
          changes.idOrNull('env', 'evidenceFrom'),
          changes.has('rank'),
          changes.intOrNull('rank'),
          ctx.operationId,
        ],
      )
      if (rowCount !== 1) return false
      await this.audit(tx, ctx, {
        environmentId: c.text('environmentId'),
        revision: c.int('revision'),
        changes: Object.keys(changes.json()).sort(),
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.environment_update.verify',
      `SELECT 1 FROM registry.environments WHERE environment_id = $1 AND revision = $2 AND updated_by_operation_id = $3`,
      [c.text('environmentId'), c.int('revision'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

export class ProjectCreateKind extends RegistryKind {
  readonly kind = 'registry.project.create'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body) {
    const { rows } = await this.deps.store.query(
      'registry.kind.project.slug',
      'SELECT 1 FROM registry.projects WHERE product_id = $1 AND slug = $2',
      [c.text('productId'), c.text('slug')],
    )
    return rows.length === 0 ? [] : [{ binding: 'slugTaken', expected: false, actual: true }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.project.insert',
        `INSERT INTO registry.projects (project_id, product_id, slug, display_name, managed_scope, evidence_override,
                                        created_by_operation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
          c.id('prj', 'projectId'),
          c.id('prd', 'productId'),
          c.text('slug'),
          c.text('displayName'),
          JSON.stringify(c.object('managedScope').json()),
          JSON.stringify(c.object('evidenceOverride').json()),
          ctx.operationId,
        ],
      )
      await this.audit(tx, ctx, {
        projectId: c.text('projectId'),
        productId: c.text('productId'),
        slug: c.text('slug'),
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.project.verify',
      'SELECT 1 FROM registry.projects WHERE project_id = $1 AND created_by_operation_id = $2 AND revision = 1',
      [c.text('projectId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.project.reconcile',
      'SELECT 1 FROM registry.projects WHERE project_id = $1 AND created_by_operation_id = $2',
      [c.text('projectId'), ctx.operationId],
    )
  }
}

export class ProjectUpdateKind extends RegistryKind {
  readonly kind = 'registry.project.update'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const project = await getProject(this.deps.store, c.text('projectId'))
    return project !== undefined && project.revision === expected.int('revision')
      ? []
      : [
          {
            binding: 'revision',
            expected: expected.int('revision'),
            actual: project?.revision ?? null,
          },
        ]
  }

  async run(ctx: ExecutionContext, c: Body) {
    const changes = c.object('changes')
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.project.update',
        `UPDATE registry.projects
            SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
                managed_scope = CASE WHEN $5::boolean THEN $6::jsonb ELSE managed_scope END,
                evidence_override = CASE WHEN $7::boolean THEN $8::jsonb ELSE evidence_override END,
                execution_roles = CASE WHEN $10::boolean THEN $11::jsonb ELSE execution_roles END,
                trusted_extensions = CASE WHEN $12::boolean THEN $13::jsonb ELSE trusted_extensions END,
                revision = $2, updated_by_operation_id = $9
          WHERE project_id = $1 AND revision = $2 - 1`,
        [
          c.id('prj', 'projectId'),
          c.int('revision'),
          changes.has('displayName'),
          changes.textOrNull('displayName'),
          changes.has('managedScope'),
          changes.has('managedScope')
            ? JSON.stringify(changes.object('managedScope').json())
            : null,
          changes.has('evidenceOverride'),
          changes.has('evidenceOverride')
            ? JSON.stringify(changes.object('evidenceOverride').json())
            : null,
          ctx.operationId,
          changes.has('executionRoles'),
          changes.has('executionRoles')
            ? JSON.stringify(changes.object('executionRoles').json())
            : null,
          changes.has('trustedExtensions'),
          changes.has('trustedExtensions')
            ? JSON.stringify(changes.raw('trustedExtensions'))
            : null,
        ],
      )
      if (rowCount !== 1) return false
      await this.audit(tx, ctx, {
        projectId: c.text('projectId'),
        revision: c.int('revision'),
        changes: Object.keys(changes.json()).sort(),
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.project_update.verify',
      'SELECT 1 FROM registry.projects WHERE project_id = $1 AND revision = $2 AND updated_by_operation_id = $3',
      [c.text('projectId'), c.int('revision'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

export class ServerCreateKind extends RegistryKind {
  readonly kind = 'registry.server.create'
  readonly actionClass = 'standard'

  async bindings() {
    return []
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.server.insert',
        `INSERT INTO registry.servers (server_id, display_name, provider, provider_ref, location, created_by_operation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          c.id('srv', 'serverId'),
          c.text('displayName'),
          c.text('provider'),
          c.textOrNull('providerRef'),
          c.textOrNull('location'),
          ctx.operationId,
        ],
      )
      await this.audit(
        tx,
        ctx,
        { serverId: c.text('serverId'), provider: c.text('provider') },
        {
          serverId: c.text('serverId'),
        },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.server.verify',
      'SELECT 1 FROM registry.servers WHERE server_id = $1 AND created_by_operation_id = $2',
      [c.text('serverId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

// ----- clusters, endpoints, databases -----

async function insertEndpoint(
  tx: Tx,
  clusterId: string,
  e: Body,
  operationId: string,
): Promise<void> {
  await tx.query(
    'registry.kind.endpoint.insert',
    `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, pooler_mode, host, port, tls_server_name, label,
                                     state, created_by_operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
    [
      e.id('end', 'endpointId'),
      clusterId,
      e.oneOf(['private', 'public', 'local_socket', 'pooler'] as const, 'kind'),
      e.textOrNull('poolerMode'),
      e.text('host'),
      e.int('port'),
      e.text('tlsServerName'),
      e.text('label'),
      operationId,
    ],
  )
}

export class ClusterRegisterKind extends RegistryKind {
  readonly kind = 'registry.cluster.register'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body) {
    const changed: ChangedBinding[] = []
    const serverId = c.textOrNull('serverId')
    if (serverId !== null && (await getServer(this.deps.store, serverId)) === undefined) {
      changed.push({ binding: 'server', expected: serverId, actual: null })
    }
    for (const e of c.list('endpoints')) {
      if ((await activeEndpointAt(this.deps.store, e.text('host'), e.int('port'))) !== undefined) {
        changed.push({ binding: 'address', expected: 'free', actual: 'taken' })
      }
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    const clusterId = c.id('cls', 'clusterId')
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.cluster.insert',
        `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle,
                                        created_by_operation_id)
         VALUES ($1, $2, 'external', $3, 'pending', $4, $5)`,
        [
          clusterId,
          c.idOrNull('srv', 'serverId'),
          c.text('displayName'),
          c.text('caBundle'),
          ctx.operationId,
        ],
      )
      for (const e of c.list('endpoints')) {
        await insertEndpoint(tx, clusterId, e, ctx.operationId)
      }
      await this.audit(
        tx,
        ctx,
        { clusterId, endpoints: c.list('endpoints').map((e) => e.text('endpointId')) },
        { clusterId },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster.verify',
      `SELECT 1 FROM registry.clusters cl WHERE cl.cluster_id = $1 AND cl.created_by_operation_id = $2
         AND cl.state = 'pending'
         AND (SELECT count(*) FROM registry.endpoints e WHERE e.cluster_id = cl.cluster_id
                AND e.created_by_operation_id = $2) = $3`,
      [c.text('clusterId'), ctx.operationId, c.list('endpoints').length],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster.reconcile',
      'SELECT 1 FROM registry.clusters WHERE cluster_id = $1 AND created_by_operation_id = $2',
      [c.text('clusterId'), ctx.operationId],
    )
  }
}

export class ClusterConfirmKind extends RegistryKind {
  readonly kind = 'registry.cluster.confirm'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const cluster = await getCluster(this.deps.store, c.text('clusterId'))
    return cluster !== undefined && cluster.state === expected.text('state')
      ? []
      : [
          {
            binding: 'clusterState',
            expected: expected.text('state'),
            actual: cluster?.state ?? null,
          },
        ]
  }

  async run(ctx: ExecutionContext, c: Body) {
    const clusterId = c.id('cls', 'clusterId')
    const planned = c.text('systemIdentifier')
    try {
      const observed = await observeClusterIdentity(
        this.deps.connector,
        clusterId,
        `confirm/${ctx.operationId}`,
      )
      if (observed.systemIdentifier !== planned) {
        return { outcome: 'not_applied' as const, errorCode: 'CLUSTER_IDENTITY_MISMATCH' }
      }
      if (observed.systemIdentifier === (await this.deps.controlStoreSystemIdentifier())) {
        return {
          outcome: 'not_applied' as const,
          errorCode: 'TARGET_REGISTRATION_REFUSED',
          detail: { reason: 'cluster_hosts_control_store' },
        }
      }
      if ((await clusterBySystemIdentifier(this.deps.store, planned)) !== undefined) {
        return {
          outcome: 'not_applied' as const,
          errorCode: 'REGISTRY_CONFLICT',
          detail: { reason: 'system_identifier_taken' },
        }
      }
      return await this.effect(async (tx) => {
        const { rowCount } = await tx.query(
          'registry.kind.cluster.confirm',
          `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = $3,
                  confirmed_by_operation_id = $4
            WHERE cluster_id = $1 AND state = 'pending'`,
          [clusterId, planned, observed.serverVersionNum, ctx.operationId],
        )
        if (rowCount !== 1) return false
        await this.audit(
          tx,
          ctx,
          { clusterId, systemIdentifier: planned, serverVersionNum: observed.serverVersionNum },
          { clusterId },
        )
        return true
      })
    } catch (error) {
      return refusalOf(error)
    }
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster_confirm.verify',
      `SELECT 1 FROM registry.clusters WHERE cluster_id = $1 AND state = 'active' AND system_identifier = $2
         AND confirmed_by_operation_id = $3`,
      [c.text('clusterId'), c.text('systemIdentifier'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster_confirm.reconcile',
      'SELECT 1 FROM registry.clusters WHERE cluster_id = $1 AND confirmed_by_operation_id = $2',
      [c.text('clusterId'), ctx.operationId],
    )
  }
}

/**
 * Declares a cluster's intended tier (OD-22, extended 2026-10-13). Bound to
 * the declared tier and the cluster state the plan was made against; the
 * Control Store guard admits the write only from an operation of this kind
 * and stamps its time.
 */
export class ClusterDeclareTierKind extends RegistryKind {
  readonly kind = 'registry.cluster.declare_tier'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const cluster = await getCluster(this.deps.store, c.text('clusterId'))
    const changed: ChangedBinding[] = []
    if (cluster === undefined || cluster.state === 'retired') {
      changed.push({
        binding: 'clusterState',
        expected: expected.text('clusterState'),
        actual: cluster?.state ?? null,
      })
    }
    if (cluster !== undefined && cluster.declaredTier !== expected.textOrNull('declaredTier')) {
      changed.push({
        binding: 'declaredTier',
        expected: expected.textOrNull('declaredTier'),
        actual: cluster.declaredTier,
      })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    const clusterId = c.id('cls', 'clusterId')
    const declaredTier = c.oneOf(['prod', 'nonprod'] as const, 'declaredTier')
    return this.effect(async (tx) => {
      const { rows } = await tx.query(
        'registry.kind.cluster.declared_tier_before',
        `SELECT declared_tier FROM registry.clusters WHERE cluster_id = $1 AND state <> 'retired' FOR UPDATE`,
        [clusterId],
      )
      const before = rows[0]
      if (before === undefined) return false
      const { rowCount } = await tx.query(
        'registry.kind.cluster.declare_tier',
        `UPDATE registry.clusters SET declared_tier = $2, declared_tier_by_operation_id = $3
          WHERE cluster_id = $1 AND state <> 'retired'`,
        [clusterId, declaredTier, ctx.operationId],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        { clusterId, declaredTier, before: before.textOrNull('declared_tier') },
        { clusterId, tier: 'prod' },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster_declare_tier.verify',
      `SELECT 1 FROM registry.clusters
        WHERE cluster_id = $1 AND declared_tier = $2 AND declared_tier_by_operation_id = $3`,
      [c.text('clusterId'), c.text('declaredTier'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.cluster_declare_tier.reconcile',
      'SELECT 1 FROM registry.clusters WHERE cluster_id = $1 AND declared_tier_by_operation_id = $2',
      [c.text('clusterId'), ctx.operationId],
    )
  }
}

export class EndpointAddKind extends RegistryKind {
  readonly kind = 'registry.endpoint.add'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body) {
    const cluster = await getCluster(this.deps.store, c.text('clusterId'))
    const e = c.object('endpoint')
    const changed: ChangedBinding[] = []
    if (cluster === undefined || cluster.state === 'retired') {
      changed.push({
        binding: 'clusterState',
        expected: 'pending|active',
        actual: cluster?.state ?? null,
      })
    }
    if ((await activeEndpointAt(this.deps.store, e.text('host'), e.int('port'))) !== undefined) {
      changed.push({ binding: 'address', expected: 'free', actual: 'taken' })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    const clusterId = c.id('cls', 'clusterId')
    const e = c.object('endpoint')
    return this.effect(async (tx) => {
      await insertEndpoint(tx, clusterId, e, ctx.operationId)
      await this.audit(
        tx,
        ctx,
        { endpointId: e.text('endpointId'), kind: e.text('kind'), label: e.text('label') },
        { clusterId },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.endpoint.verify',
      `SELECT 1 FROM registry.endpoints WHERE endpoint_id = $1 AND state = 'active' AND created_by_operation_id = $2`,
      [c.object('endpoint').text('endpointId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.endpoint.reconcile',
      'SELECT 1 FROM registry.endpoints WHERE endpoint_id = $1 AND created_by_operation_id = $2',
      [c.object('endpoint').text('endpointId'), ctx.operationId],
    )
  }
}

export class EndpointRetireKind extends RegistryKind {
  readonly kind = 'registry.endpoint.retire'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body) {
    const endpoint = await getEndpoint(this.deps.store, c.text('endpointId'))
    const changed: ChangedBinding[] = []
    if (endpoint === undefined || endpoint.state !== 'active') {
      changed.push({
        binding: 'endpointState',
        expected: 'active',
        actual: endpoint?.state ?? null,
      })
    }
    const cluster = await getCluster(this.deps.store, c.text('clusterId'))
    const direct = (await listEndpoints(this.deps.store, c.text('clusterId'), 'active')).filter(
      (e) => e.kind !== 'pooler',
    )
    if (endpoint?.kind !== 'pooler' && direct.length <= 1 && cluster?.derivedTier !== null) {
      changed.push({ binding: 'remainingDirect', expected: '>=1', actual: 0 })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.endpoint.retire',
        `UPDATE registry.endpoints SET state = 'retired', retired_by_operation_id = $2
          WHERE endpoint_id = $1 AND state = 'active'`,
        [c.id('end', 'endpointId'), ctx.operationId],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        { endpointId: c.text('endpointId') },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.endpoint_retire.verify',
      `SELECT 1 FROM registry.endpoints WHERE endpoint_id = $1 AND state = 'retired' AND retired_by_operation_id = $2`,
      [c.text('endpointId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `registry.database.retire`: the record ends (final); the cluster is not touched. */
export class DatabaseRetireKind extends RegistryKind {
  readonly kind = 'registry.database.retire'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body) {
    const database = await getDatabase(this.deps.store, c.text('databaseId'))
    const changed: ChangedBinding[] = []
    if (database === undefined || database.state !== 'registered') {
      changed.push({
        binding: 'databaseState',
        expected: 'registered',
        actual: database?.state ?? null,
      })
    } else if (database.placedTargetId !== null) {
      changed.push({ binding: 'placed', expected: false, actual: true })
    }
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      // The guard refuses a current placement (EXG09); retirement is final.
      const { rowCount } = await tx.query(
        'registry.kind.database.retire',
        `UPDATE registry.databases SET state = 'retired'
          WHERE database_id = $1 AND cluster_id = $2 AND state = 'registered'`,
        [c.id('dbs', 'databaseId'), c.id('cls', 'clusterId')],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        { databaseId: c.text('databaseId') },
        { clusterId: c.text('clusterId') },
      )
      return true
    })
  }

  async check(ctx: ExecutionContext, c: Body) {
    // No column names the retiring operation: its audit event does.
    return (
      (await this.exists(
        'registry.kind.database_retire.verify',
        `SELECT 1 FROM registry.databases WHERE database_id = $1 AND state = 'retired'`,
        [c.text('databaseId')],
      )) &&
      (await this.exists(
        'registry.kind.database_retire.audited',
        'SELECT 1 FROM audit.audit_events WHERE operation_id = $1 AND action = $2',
        [ctx.operationId, this.kind],
      ))
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

export class DatabaseRegisterKind extends RegistryKind {
  readonly kind = 'registry.database.register'
  readonly actionClass = 'standard'

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const cluster = await getCluster(this.deps.store, c.text('clusterId'))
    const changed: ChangedBinding[] = []
    if (
      cluster === undefined ||
      cluster.state !== 'active' ||
      cluster.systemIdentifier !== expected.text('systemIdentifier')
    ) {
      changed.push({
        binding: 'cluster',
        expected: expected.text('systemIdentifier'),
        actual: cluster?.systemIdentifier ?? null,
      })
    }
    const { rows } = await this.deps.store.query(
      'registry.kind.database.name',
      `SELECT 1 FROM registry.databases WHERE cluster_id = $1 AND name = $2 AND state = 'registered'`,
      [c.text('clusterId'), c.text('name')],
    )
    if (rows.length > 0) changed.push({ binding: 'databaseTaken', expected: false, actual: true })
    return changed
  }

  async run(ctx: ExecutionContext, c: Body) {
    try {
      const observed = await inspectDatabase(
        this.deps.connector,
        c.text('clusterId'),
        c.text('name'),
        'observer',
      )
      if (observed.oid !== c.text('oid')) {
        return {
          outcome: 'not_applied' as const,
          errorCode: 'REGISTRY_CONFLICT',
          detail: { reason: 'database_not_found' },
        }
      }
      return await this.effect(async (tx) => {
        await tx.query(
          'registry.kind.database.insert',
          `INSERT INTO registry.databases (database_id, cluster_id, name, state, observed_oid, observed_owner,
                                           observed_encoding, observed_collation, observed_at, created_by_operation_id)
           VALUES ($1, $2, $3, 'registered', $4::bigint, $5, $6, $7, clock_timestamp(), $8)`,
          [
            c.id('dbs', 'databaseId'),
            c.id('cls', 'clusterId'),
            c.text('name'),
            observed.oid,
            observed.owner,
            observed.encoding,
            observed.collation,
            ctx.operationId,
          ],
        )
        await this.audit(
          tx,
          ctx,
          { databaseId: c.text('databaseId'), name: c.text('name') },
          { clusterId: c.text('clusterId') },
        )
        return true
      })
    } catch (error) {
      return refusalOf(error)
    }
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.database.verify',
      `SELECT 1 FROM registry.databases WHERE database_id = $1 AND created_by_operation_id = $2
         AND observed_oid = $3::bigint AND state = 'registered'`,
      [c.text('databaseId'), ctx.operationId, c.text('oid')],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.database.reconcile',
      'SELECT 1 FROM registry.databases WHERE database_id = $1 AND created_by_operation_id = $2',
      [c.text('databaseId'), ctx.operationId],
    )
  }
}

// ----- target lifecycle (no data-plane write) -----

export class TargetStateKind extends RegistryKind {
  readonly kind: 'target.suspend' | 'target.resume' | 'target.decommission'
  readonly actionClass: 'standard' | 'critical'
  readonly #to: 'suspended' | 'active' | 'decommissioned'

  constructor(
    deps: RegistryKindDeps,
    kind: 'target.suspend' | 'target.resume' | 'target.decommission',
  ) {
    super(deps)
    this.kind = kind
    this.actionClass = kind === 'target.decommission' ? 'critical' : 'standard'
    this.#to =
      kind === 'target.suspend'
        ? 'suspended'
        : kind === 'target.resume'
          ? 'active'
          : 'decommissioned'
  }

  override exclusivity(plan: PlanRecord): readonly string[] {
    // Decommissioning takes the maintenance domain of the target (operations-engine.md §7).
    const target = Body.content(plan).text('targetId')
    return this.kind === 'target.decommission' ? [`target:${target}:maintenance`] : []
  }

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const target = await findTarget(this.deps.store, c.text('targetId'))
    return target !== undefined &&
      target.state === expected.text('state') &&
      target.generation === expected.int('generation')
      ? []
      : [
          {
            binding: 'targetState',
            expected: `${expected.text('state')}@${expected.int('generation')}`,
            actual: target === undefined ? null : `${target.state}@${target.generation}`,
          },
        ]
  }

  async run(ctx: ExecutionContext, c: Body) {
    const target = await findTarget(this.deps.store, c.text('targetId'))
    if (target === undefined) return 'not_applied' as const
    if (this.kind === 'target.resume') {
      // Writes resume only when the database still carries this target's marker.
      try {
        await this.#checkMarker(target.targetId, ctx.operationId)
      } catch (error) {
        return refusalOf(error)
      }
    }
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.target.state',
        `UPDATE registry.targets SET state = $2, state_reason = $3, state_changed_by_operation_id = $4
          WHERE target_id = $1 AND state = $5`,
        [
          target.targetId,
          this.#to,
          this.#to === 'active' ? null : c.text('reason'),
          ctx.operationId,
          target.state,
        ],
      )
      if (rowCount !== 1) return false
      if (this.#to === 'decommissioned' && target.placement !== null) {
        await tx.query(
          'registry.kind.target.placement_end',
          `UPDATE registry.placements SET valid_to = clock_timestamp(), ended_by_operation_id = $2
            WHERE placement_id = $1 AND valid_to IS NULL`,
          [target.placement.placementId, ctx.operationId],
        )
      }
      await this.audit(
        tx,
        ctx,
        { from: target.state, to: this.#to, reason: c.text('reason') },
        { targetId: target.targetId, targetPath: target.path, tier: target.tier },
      )
      return true
    })
  }

  async #checkMarker(targetId: string, operationId: string): Promise<void> {
    const target = await findTarget(this.deps.store, targetId)
    if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
    const opened = await this.deps.connector.forTarget(target, 'observer', `resume/${operationId}`)
    try {
      const marker = await readMarker(opened.session)
      if (
        marker.status !== 'present' ||
        marker.marker.installationId !== this.deps.installationId ||
        marker.marker.targetId !== target.targetId ||
        marker.marker.generation !== target.generation
      ) {
        throw new RegistryError('TARGET_IDENTITY_MISMATCH')
      }
    } finally {
      await opened.session.close()
    }
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.target_state.verify',
      `SELECT 1 FROM registry.targets t WHERE t.target_id = $1 AND t.state = $2 AND t.state_changed_by_operation_id = $3
         AND ($2 <> 'decommissioned' OR NOT EXISTS (SELECT FROM registry.placements p
                                                     WHERE p.target_id = t.target_id AND p.valid_to IS NULL))`,
      [c.text('targetId'), this.#to, ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.target_state.reconcile',
      'SELECT 1 FROM registry.targets WHERE target_id = $1 AND state_changed_by_operation_id = $2',
      [c.text('targetId'), ctx.operationId],
    )
  }
}

/** Every registry kind, bound to the worker's login and connector. */
export function registryKinds(deps: RegistryKindDeps): readonly OperationKind[] {
  return [
    new ProductCreateKind(deps),
    new EnvironmentCreateKind(deps),
    new EnvironmentUpdateKind(deps),
    new ProjectCreateKind(deps),
    new ProjectUpdateKind(deps),
    new ServerCreateKind(deps),
    new ClusterRegisterKind(deps),
    new ClusterConfirmKind(deps),
    new ClusterDeclareTierKind(deps),
    new EndpointAddKind(deps),
    new EndpointRetireKind(deps),
    new DatabaseRetireKind(deps),
    new DatabaseRegisterKind(deps),
    new TargetRegisterKind(deps),
    new TargetStateKind(deps, 'target.suspend'),
    new TargetStateKind(deps, 'target.resume'),
    new TargetStateKind(deps, 'target.decommission'),
    new ExecutionRoleBindingSetKind(deps),
    new ExecutionRoleExceptionDeclareKind(deps),
    new ExecutionRoleExceptionRevokeKind(deps),
  ]
}
