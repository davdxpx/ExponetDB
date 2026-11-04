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

/** The ledger comparison findings of G6 failure cases E16 and E18 (Wave 10 W10-3, OD-65 (a)). */
export type MigrationFindingCode = 'hotfix_without_evidence' | 'applied_not_in_source'

const MIGRATION_FINDINGS_SHOWN = 64

const counted = (n: number) => (n === 1 ? '1 migration applied' : `${n} migrations applied`)
const verb = (n: number) => (n === 1 ? 'is' : 'are')

const MIGRATION_SUMMARY: Readonly<Record<MigrationFindingCode, (n: number) => string>> = {
  hotfix_without_evidence: (n) =>
    `${counted(n)} on this production target ${verb(n)} not applied and verified with the same checksum on its evidence target; apply the same migration there (staging contains everything production contains).`,
  applied_not_in_source: (n) =>
    `${counted(n)} on this target ${verb(n)} missing from the project's source; restore the bundle or write a migration that undoes it. The ledger row stays.`,
}

/**
 * One open finding per target and code while the comparison names migrations (`health` kind like
 * `ledger_divergence`: a drift check resolves only its own kind-C findings and `drift.accept`
 * adopts a schema, which gives no staging evidence and restores no file). The finding names at
 * most {@link MIGRATION_FINDINGS_SHOWN} migrations (ids and bundle names, never SQL) and counts
 * them all; it is rewritten when that changes and resolved `cleared` when none is left.
 */
export async function recordMigrationFinding(
  store: ControlStore,
  targetId: string,
  code: MigrationFindingCode,
  migrations: readonly JsonObject[],
  extra: JsonObject = {},
): Promise<void> {
  await store.transaction(`ledger.${code}.record`, async (tx) => {
    if (migrations.length === 0) {
      await resolveFindingByKey(tx, targetId, code, 'cleared')
      return
    }
    await recordFinding(tx, {
      targetId,
      kind: 'health',
      code,
      severity: 'warning',
      dedupKey: code,
      summary: MIGRATION_SUMMARY[code](migrations.length),
      details: {
        ...extra,
        count: migrations.length,
        migrations: migrations.slice(0, MIGRATION_FINDINGS_SHOWN),
      },
    })
  })
}
