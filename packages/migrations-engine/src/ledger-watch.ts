import type { Queryable } from '@exponetdb/control-store'
import { readLedgerRows } from '@exponetdb/postgres'
import type { Connector, TargetRecord } from '@exponetdb/registry'
import { compareWithMirror, type LedgerDivergence } from './divergence.ts'

/**
 * The periodic ledger watch (VC-022,
 * [ledger.md §5](../../../exponetdb-docs/04-migrations/ledger.md#5-mirror-and-reconciliation)):
 * a divergence between a target's ledger and the Control Store mirror was noticed only when
 * someone planned. One read on the observer session and the same comparison status, plans and
 * `ledger.reconcile` use; `null` when they agree or the target was never mirrored. Anything that
 * cannot be read is an error, never "agrees".
 */
export async function ledgerDivergenceOf(
  deps: { readonly store: Queryable; readonly connector: Connector },
  target: TargetRecord,
): Promise<LedgerDivergence | null> {
  const opened = await deps.connector.forTarget(
    target,
    'observer',
    `ledger-watch/${target.targetId}`,
  )
  try {
    const live = await opened.session.readOnly((tx) => readLedgerRows(tx))
    return (
      (await compareWithMirror(deps.store, target.targetId, target.generation, live))?.divergence ??
      null
    )
  } finally {
    await opened.session.close()
  }
}
