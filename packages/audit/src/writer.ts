import {
  AUDIT_EVENT_SCHEMA_ID,
  type AuditEventInput,
  AuditEventInputSchema,
  type StoredAuditEvent,
} from '@exponetdb/contracts'
import { AUDIT_CHAIN_LOCK, ControlStoreError, type Tx } from '@exponetdb/control-store'
import { type Clock, InvariantError, isId, newId, toJsonValue } from '@exponetdb/kernel'
import { auditChainHash, genesisPrevHash } from './chain.ts'

/**
 * The audit writer (audit.md §3). An event is appended **in the caller's
 * transaction**: the state change and its audit event commit together, and
 * if the append fails the whole mutation fails (fail closed, C-31).
 *
 * Sequence assignment is serialized: the writer takes the transaction-level
 * chain lock, reads the chain head, reads the database clock (never earlier
 * than the head's time, so time is monotonic along the chain), builds the
 * event, hashes it with ac1 and inserts it. The database chain guard takes
 * the same lock and recomputes everything, so even a faulty writer cannot
 * fork or break the chain. The lock is held until the caller commits; append
 * as the last step of a transaction.
 */
export class AuditWriteError extends Error {
  override readonly name = 'AuditWriteError'
  readonly code: 'audit_event_invalid' | 'audit_append_failed'
  constructor(code: 'audit_event_invalid' | 'audit_append_failed', options?: { cause?: unknown }) {
    super(
      code === 'audit_event_invalid'
        ? 'The audit event does not match exponetdb.audit/v1.'
        : 'The audit event could not be written; the change is refused.',
      options,
    )
    this.code = code
  }
}

export interface AppendedAuditEvent {
  readonly seq: number
  readonly id: string
  readonly occurredAt: string
  readonly hash: string
}

export interface AppendOptions {
  /** Supplies the time part of the new `aud_` id (the event time itself is the database clock). */
  readonly clock: Clock
}

export async function appendAuditEvent(
  tx: Tx,
  input: AuditEventInput,
  options: AppendOptions,
): Promise<AppendedAuditEvent> {
  const checked = AuditEventInputSchema.safeParse(input)
  if (!checked.success) {
    throw new AuditWriteError('audit_event_invalid')
  }
  try {
    await tx.query('audit.append.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      AUDIT_CHAIN_LOCK.key1,
      AUDIT_CHAIN_LOCK.key2,
    ])
    const head = await tx.query(
      'audit.append.head',
      `SELECT h.seq, h.hash,
              to_char(greatest(clock_timestamp(), h.occurred_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now
         FROM (SELECT 1) AS one
         LEFT JOIN LATERAL (SELECT a.seq, a.hash, a.occurred_at FROM audit.audit_events a
                             ORDER BY a.seq DESC LIMIT 1) h ON true`,
    )
    const row = head.rows[0]
    if (row === undefined) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    const headSeq = row.intOrNull('seq')
    let prevHash: string
    if (headSeq === null) {
      const inst = await tx.query(
        'audit.append.installation',
        'SELECT installation_id FROM control.installation',
      )
      const installationId = inst.rows[0]?.text('installation_id')
      if (!isId('ins', installationId)) {
        throw new ControlStoreError('control_store_invalid_result')
      }
      prevHash = genesisPrevHash(installationId)
    } else {
      prevHash = row.text('hash')
    }
    const event: StoredAuditEvent = {
      ...checked.data,
      schema: AUDIT_EVENT_SCHEMA_ID,
      seq: (headSeq ?? 0) + 1,
      id: newId('aud', options.clock.nowMs()),
      occurredAt: row.text('now'),
    }
    const json = toJsonValue(event)
    if (!json.ok) {
      throw new AuditWriteError('audit_event_invalid')
    }
    const hashed = auditChainHash(prevHash, json.value)
    if (!hashed.ok) {
      throw new InvariantError('a schema-valid audit event was refused by ac1')
    }
    await tx.query(
      'audit.append.insert',
      `INSERT INTO audit.audit_events
         (seq, occurred_at, event_id, action, phase, actor_kind, actor_id, operation_id, plan_id, event, prev_hash, hash)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.seq,
        event.occurredAt,
        event.id,
        event.action,
        event.phase,
        event.actor.kind,
        event.actor.identityId,
        event.refs?.operationId ?? null,
        event.refs?.planId ?? null,
        hashed.value.canonical,
        prevHash,
        hashed.value.hash,
      ],
    )
    return { seq: event.seq, id: event.id, occurredAt: event.occurredAt, hash: hashed.value.hash }
  } catch (error) {
    if (error instanceof AuditWriteError || error instanceof InvariantError) {
      throw error
    }
    throw new AuditWriteError('audit_append_failed', { cause: error })
  }
}
