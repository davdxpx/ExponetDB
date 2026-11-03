import { appendAuditEvent } from '@exponetdb/audit'
import type { ControlStore } from '@exponetdb/control-store'
import type { Clock, JsonObject } from '@exponetdb/kernel'
import { WORKER_ACTOR } from '@exponetdb/operations'
import { recordFinding, resolveFindingByKey } from './findings.ts'

const KEY = 'ledger_divergence'

/** What a ledger comparison found: the counts per class and the ids (bounded) for the finding. */
export interface LedgerWatchSighting {
  readonly counts: {
    readonly missing: number
    readonly checksumDiffers: number
    readonly unrecorded: number
  }
  readonly details: JsonObject
}

/**
 * What the ledger watch (VC-022) records for one target: a critical finding while its ledger and
 * the Control Store mirror differ, resolved when they agree. Opening and clearing are audited once
 * each (an alertable signal; a repeated, unchanged sighting is written at most once a day).
 */
export async function recordLedgerWatch(
  store: ControlStore,
  clock: Clock,
  targetId: string,
  sighting: LedgerWatchSighting | null,
): Promise<void> {
  await store.transaction('ledger.watch.record', async (tx) => {
    const audit = (action: string, changes: Record<string, number>) =>
      appendAuditEvent(
        tx,
        {
          action,
          phase: 'completed',
          actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
          subject: { targetId } as never,
          changes,
          result: { status: 'succeeded' },
        },
        { clock },
      )
    if (sighting === null) {
      const resolved = await resolveFindingByKey(tx, targetId, KEY, 'cleared')
      if (resolved.length > 0) {
        await audit('ledger.divergence.cleared', { findings: resolved.length })
      }
      return
    }
    const { opened } = await recordFinding(tx, {
      targetId,
      kind: 'health',
      code: KEY,
      severity: 'critical',
      dedupKey: KEY,
      summary:
        "The target's migration ledger and the Control Store mirror disagree; schema changes are blocked until a person reconciles it (ledger reconcile).",
      details: sighting.details,
    })
    if (opened) await audit('ledger.divergence.detected', sighting.counts)
  })
}
