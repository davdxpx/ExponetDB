import {
  AUDIT_EVENT_SCHEMA_ID,
  type AuditEventInput,
  AuditEventInputSchema,
  type StoredAuditEvent,
} from '@exponetdb/contracts'
import {
  AUDIT_CHAIN_LOCK,
  ControlStoreError,
  type Queryable,
  type Tx,
} from '@exponetdb/control-store'
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

/**
 * The chain head lies more than 24 hours ahead of the database clock (a clock
 * step forward and back, VC-003): the chain guard refuses every event until the
 * clock passes the head, so every audited mutation stops. Nothing is broken in
 * the chain; the catalog code names the cause and both times. Up to 24 hours an
 * event takes the head's time with a row in `audit.clock_skew_marks` (OD-69 (b)).
 */
export class AuditClockSkewError extends Error {
  override readonly name = 'AuditClockSkewError'
  readonly code = 'AUDIT_CLOCK_SKEW'
  readonly details: { readonly headAt: string; readonly databaseNow: string }
  constructor(details: { readonly headAt: string; readonly databaseNow: string }) {
    super('The newest audit event lies ahead of the database clock; the change is refused.')
    this.details = details
  }
}

const UTC_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`

/** The head-ahead test of the chain guard (`audit-chain` bundle): more than a minute ahead. */
const HEAD_AHEAD = `h.occurred_at > clock_timestamp() + interval '1 minute'`
/** OD-69 (b): how far ahead the guard (`audit-clock-clamp` bundle) still takes a marked event. */
const HEAD_CLAMPABLE = `h.occurred_at <= clock_timestamp() + interval '24 hours'`

/** The skew a probe sees (readiness): the head's time and the database clock, or `undefined`. */
export async function auditClockSkew(
  q: Queryable,
): Promise<{ readonly headAt: string; readonly databaseNow: string } | undefined> {
  const { rows } = await q.query(
    'audit.clock_skew',
    `SELECT to_char(h.occurred_at AT TIME ZONE 'UTC', ${UTC_US}) AS head_at,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', ${UTC_US}) AS db_now
       FROM (SELECT a.occurred_at FROM audit.audit_events a ORDER BY a.seq DESC LIMIT 1) h
      WHERE ${HEAD_AHEAD}`,
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : { headAt: row.text('head_at'), databaseNow: row.text('db_now') }
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
              to_char(greatest(clock_timestamp(), h.occurred_at) AT TIME ZONE 'UTC', ${UTC_US}) AS now,
              coalesce(${HEAD_AHEAD}, false) AS ahead,
              coalesce(${HEAD_CLAMPABLE}, true) AS clampable,
              to_char(h.occurred_at AT TIME ZONE 'UTC', ${UTC_US}) AS head_at,
              to_char(clock_timestamp() AT TIME ZONE 'UTC', ${UTC_US}) AS db_now
         FROM (SELECT 1) AS one
         LEFT JOIN LATERAL (SELECT a.seq, a.hash, a.occurred_at FROM audit.audit_events a
                             ORDER BY a.seq DESC LIMIT 1) h ON true`,
    )
    const row = head.rows[0]
    if (row === undefined) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    // OD-69 (b): a head at most 24 h ahead is a clock step back; the event takes the head's time
    // and a clock-skew mark says so. Further ahead, nothing is written until the clock is repaired.
    const ahead = row.bool('ahead')
    if (ahead && !row.bool('clampable')) {
      throw new AuditClockSkewError({
        headAt: row.text('head_at'),
        databaseNow: row.text('db_now'),
      })
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
    if (ahead) {
      // The mark the guard needs for an event at the head's time (bundle audit-clock-clamp).
      await tx.query(
        'audit.append.clock_skew_mark',
        `INSERT INTO audit.clock_skew_marks (seq, database_at, chain_head_at) VALUES ($1, clock_timestamp(), $2::timestamptz)`,
        [event.seq, row.text('head_at')],
      )
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
    if (
      error instanceof AuditWriteError ||
      error instanceof AuditClockSkewError ||
      error instanceof InvariantError
    ) {
      throw error
    }
    throw new AuditWriteError('audit_append_failed', { cause: error })
  }
}
