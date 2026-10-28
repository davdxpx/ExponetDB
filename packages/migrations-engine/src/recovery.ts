import type { Tx } from '@exponetdb/control-store'
import { readPlan } from '@exponetdb/operations'

/**
 * The operation a re-verification of `migrationId` recovers (TC-005, MIG-01):
 * the one in `needs_attention` that holds the target's schema domain and
 * concerns that migration (it applied it, resumed it or verified it). The
 * plan names it, so the person who accepts the plan sees which operation it
 * closes; the worker closes it in the transaction that takes the domain
 * ([operations-engine.md §4.1](../../../exponetdb-docs/02-control-plane/operations-engine.md#41-state-machine)).
 * Another migration's operation is not touched: it keeps the target until
 * its own recovery.
 */
export async function stuckOperationOf(
  tx: Pick<Tx, 'query'>,
  targetId: string,
  migrationId: string,
): Promise<string | undefined> {
  const held = await tx.query(
    'migrations.recovery.stuck',
    `SELECT o.operation_id, o.plan_id
       FROM operations.operation_locks l
       JOIN operations.operations o ON o.operation_id = l.operation_id
      WHERE l.domain_key = $1 AND o.state = 'needs_attention' AND o.plan_id IS NOT NULL`,
    [`target:${targetId}:schema`],
  )
  for (const row of held.rows) {
    const plan = await readPlan(tx, row.text('plan_id'))
    const content = plan?.body['content'] as
      | { migrationId?: unknown; migrations?: readonly { migrationId?: unknown }[] }
      | undefined
    const ids = [content?.migrationId, ...(content?.migrations ?? []).map((m) => m.migrationId)]
    if (ids.includes(migrationId)) return row.text('operation_id')
  }
  return undefined
}
