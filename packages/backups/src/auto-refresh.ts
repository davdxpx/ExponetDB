import {
  type ControlStore,
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Queryable,
} from '@exponetdb/control-store'
import { acceptPlan, WORKER_ACTOR } from '@exponetdb/operations'
import { type RegistryAcceptContext, registryAcceptDependencies } from '@exponetdb/registry'
import { BackupError } from './errors.ts'
import { type BackupPlanContext, planCatalogRefresh } from './plans.ts'

/** What one pass of the worker's catalog refresh did, by cluster. */
export interface SystemRefreshPass {
  /** Clusters whose refresh the system planned and accepted in this pass. */
  readonly planned: readonly string[]
  /**
   * Clusters skipped because a refresh is already open (waiting, queued, running, verifying or
   * needs reconciliation). `needs_attention` is not open on purpose: a refresh that waits for
   * a person must not stop the next one.
   */
  readonly pending: readonly string[]
  /** Clusters the refresh cannot reach now (no node with the capability, cluster not confirmed). */
  readonly unreachable: readonly { readonly clusterId: string; readonly reason: string }[]
  /** Clusters whose refresh failed for another reason (a refused acceptance, the store). */
  readonly failed: readonly { readonly clusterId: string; readonly error: unknown }[]
}

const REFRESHABLE_CLUSTERS = `SELECT DISTINCT r.cluster_id FROM backups.repositories r
  WHERE r.state <> 'retired' AND r.ownership <> 'external' ORDER BY r.cluster_id`

const OPEN_REFRESH = `SELECT 1 FROM operations.operations o
  JOIN operations.plan_bodies b ON b.plan_id = o.plan_id
  WHERE o.kind = 'backup.catalog.refresh'
    AND o.state IN ('awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation')
    AND (b.body::jsonb #>> '{content,clusterId}') = $1
  LIMIT 1`

/**
 * The worker's own `backup.catalog.refresh` of every cluster with a repository it observes
 * (OD-73): planned and accepted by the system actor and executed like a refresh a person
 * starts, so the mirror stays inside its freshness window without anyone asking. The kind
 * is low and read-only on the host (the engine's own catalog listing); one open refresh per
 * cluster at a time (a per-cluster lock and the open operation are checked first).
 */
export async function refreshCatalogsAsSystem(
  worker: ControlStore,
  context: {
    readonly plan: Pick<BackupPlanContext, 'policy'>
    readonly accept: RegistryAcceptContext
  },
): Promise<SystemRefreshPass> {
  const { rows } = await worker.query('backups.system_refresh.clusters', REFRESHABLE_CLUSTERS)
  const planned: string[] = []
  const pending: string[] = []
  const unreachable: { clusterId: string; reason: string }[] = []
  const failed: { clusterId: string; error: unknown }[] = []
  for (const row of rows) {
    const clusterId = row.text('cluster_id')
    let outcome: Awaited<ReturnType<typeof refreshOne>>
    try {
      outcome = await refreshOne(worker, context, clusterId)
    } catch (error) {
      // One cluster's failure never stops the refresh of the others; the caller reports it.
      failed.push({ clusterId, error })
      continue
    }
    if (outcome === 'planned') planned.push(clusterId)
    else if (outcome === 'pending') pending.push(clusterId)
    else unreachable.push({ clusterId, reason: outcome.reason })
  }
  return { planned, pending, unreachable, failed }
}

function refreshOne(
  worker: ControlStore,
  context: {
    readonly plan: Pick<BackupPlanContext, 'policy'>
    readonly accept: RegistryAcceptContext
  },
  clusterId: string,
): Promise<'planned' | 'pending' | { readonly reason: string }> {
  return worker.transaction('backups.system_refresh', async (tx) => {
    await tx.query(
      'backups.system_refresh.lock',
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [EXDB_LOCK_NAMESPACE, lockKey2(`backups/system-refresh/${clusterId}`)],
    )
    if (await refreshOpen(tx, clusterId)) return 'pending'
    let planId: string
    try {
      planId = (await planCatalogRefresh(tx, context.plan, 'system', clusterId)).planId
    } catch (error) {
      // No node serves the cluster now, or it is not confirmed: the next pass tries again.
      if (error instanceof BackupError) {
        const reason = error.details?.['reason']
        return { reason: typeof reason === 'string' ? reason : error.code }
      }
      throw error
    }
    const accepted = await acceptPlan(
      tx,
      { planId: planId as never, actor: WORKER_ACTOR },
      registryAcceptDependencies(tx, context.accept, 'system'),
    )
    if (accepted.status !== 'accepted') throw accepted.error
    return 'planned'
  })
}

async function refreshOpen(q: Queryable, clusterId: string): Promise<boolean> {
  const { rows } = await q.query('backups.system_refresh.open', OPEN_REFRESH, [clusterId])
  return rows.length > 0
}
