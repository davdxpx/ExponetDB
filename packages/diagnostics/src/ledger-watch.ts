import { appendAuditEvent } from '@exponetdb/audit'
import type { AuditEventInput } from '@exponetdb/contracts'
import type { ControlStore, Queryable, Tx } from '@exponetdb/control-store'
import type { Clock, JsonObject } from '@exponetdb/kernel'
import { WORKER_ACTOR } from '@exponetdb/operations'
import { openFindings, recordFinding, resolveFindingByKey } from './findings.ts'

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

/** Who an audit event of these findings names: the worker, or the caller of a plan. */
export type AuditParty = Pick<AuditEventInput, 'actor' | 'client' | 'request'>

export const WORKER_AUDIT_PARTY: AuditParty = {
  actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
}

export interface MigrationFindingSighting {
  /** `{ migrationId, name, … }` each: ids and bundle names, never SQL. */
  readonly migrations: readonly JsonObject[]
  readonly details?: JsonObject
  /** The evidence target's own ledger disagrees with its mirror (E16): no row there is evidence. */
  readonly cause?: 'evidence_divergent'
}

const MIGRATION_FINDINGS_SHOWN = 64

const counted = (n: number) => (n === 1 ? '1 migration applied' : `${n} migrations applied`)
const verb = (n: number) => (n === 1 ? 'is' : 'are')

function migrationSummary(
  code: MigrationFindingCode,
  n: number,
  cause: MigrationFindingSighting['cause'],
): string {
  if (code === 'applied_not_in_source') {
    return `${counted(n)} on this target ${verb(n)} missing from the project's source; restore the bundle or write a migration that undoes it. The ledger row stays.`
  }
  if (cause === 'evidence_divergent') {
    return `${counted(n)} on this production target cannot be checked against the evidence target: the evidence target's own ledger disagrees with its mirror, so none of its rows is evidence. Reconcile the evidence target's ledger first.`
  }
  return `${counted(n)} on this production target ${verb(n)} not applied and verified with the same checksum on its evidence target; apply the same migration there (staging contains everything production contains).`
}

const idOf = (m: JsonObject): string =>
  typeof m['migrationId'] === 'string' ? m['migrationId'] : ''

/**
 * One open finding per target and code while the comparison names migrations, in the caller's
 * transaction (`health` kind like `ledger_divergence`: a drift check resolves only its own kind-C
 * findings and `drift.accept` adopts a schema, which gives no staging evidence and restores no
 * file). The finding names the {@link MIGRATION_FINDINGS_SHOWN} newest migrations and counts them
 * all; it is rewritten when that changes and resolved (`cleared`, or `superseded` when nothing can
 * be compared any more) for `null`. Opening and resolving are audited once each, with `party`.
 */
export async function recordMigrationFinding(
  tx: Tx,
  clock: Clock,
  targetId: string,
  code: MigrationFindingCode,
  sighting: MigrationFindingSighting | null,
  party: AuditParty,
  resolution: 'cleared' | 'superseded' = 'cleared',
): Promise<void> {
  const audit = (action: 'detected' | 'cleared', extra: Partial<AuditEventInput>) =>
    appendAuditEvent(
      tx,
      {
        action: `ledger.${code}.${action}`,
        phase: 'completed',
        ...party,
        subject: { targetId } as never,
        ...extra,
        result: { status: 'succeeded' },
      },
      { clock },
    )
  if (sighting === null || sighting.migrations.length === 0) {
    const resolved = await resolveFindingByKey(tx, targetId, code, resolution)
    if (resolved.length > 0) {
      await audit('cleared', { changes: { findings: resolved.length, resolution } })
    }
    return
  }
  const shown = [...sighting.migrations]
    .sort((a, b) => (idOf(a) < idOf(b) ? 1 : idOf(a) > idOf(b) ? -1 : 0))
    .slice(0, MIGRATION_FINDINGS_SHOWN)
  const { opened } = await recordFinding(tx, {
    targetId,
    kind: 'health',
    code,
    severity: 'warning',
    dedupKey: code,
    summary: migrationSummary(code, sighting.migrations.length, sighting.cause),
    details: {
      ...(sighting.details ?? {}),
      ...(sighting.cause === undefined ? {} : { cause: sighting.cause }),
      count: sighting.migrations.length,
      migrations: shown,
    },
  })
  if (opened) {
    await audit('detected', {
      changes: { count: sighting.migrations.length },
      refs: { migrationIds: shown.map(idOf) as never },
    })
  }
}

/** The migration ids the open finding of this code names (E18 keeps them until a source has them). */
export async function namedMigrationIds(
  q: Queryable,
  targetId: string,
  code: MigrationFindingCode,
): Promise<string[]> {
  const open = (await openFindings(q, targetId, 'health')).find((f) => f.dedupKey === code)
  const named = open?.details['migrations']
  return Array.isArray(named)
    ? named.flatMap((m) =>
        typeof m === 'object' && m !== null && !Array.isArray(m) ? [idOf(m as JsonObject)] : [],
      )
    : []
}
