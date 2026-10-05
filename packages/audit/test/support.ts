import type { AuditEventInput, StoredAuditEvent } from '@exponetdb/contracts'
import type { ControlStore } from '@exponetdb/control-store'
import { expectOk, newId, toJsonValue } from '@exponetdb/kernel'
import { auditChainHash } from '../src/index.ts'

/** A minimal valid event input. */
export function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    action: 'test.recorded',
    phase: 'completed',
    actor: { kind: 'system', identityId: null, label: 'system:worker' },
    ...overrides,
  }
}

/** A stored event built by the test itself (for direct inserts that bypass the writer). */
export function storedEvent(
  seq: number,
  occurredAt: string,
  overrides: Partial<AuditEventInput> = {},
): StoredAuditEvent {
  return {
    ...input(overrides),
    schema: 'exponetdb.audit/v1',
    seq,
    id: newId('aud', Date.parse(occurredAt)),
    occurredAt,
  }
}

export interface RawRow {
  readonly seq: number
  readonly occurredAt: string
  readonly eventId: string
  readonly action: string
  readonly phase: string
  readonly actorKind: string
  readonly actorId: string | null
  readonly operationId: string | null
  readonly planId: string | null
  readonly event: string
  readonly prevHash: string
  readonly hash: string
}

/** The row the writer would insert for `event` after `prevHash`. */
export function rawRow(prevHash: string, event: StoredAuditEvent): RawRow {
  const json = toJsonValue(event)
  if (!json.ok) {
    throw new Error('test event is not JSON')
  }
  const hashed = expectOk(auditChainHash(prevHash, json.value), 'test event hash')
  return {
    seq: event.seq,
    occurredAt: event.occurredAt,
    eventId: event.id,
    action: event.action,
    phase: event.phase,
    actorKind: event.actor.kind,
    actorId: event.actor.identityId,
    operationId: event.refs?.operationId ?? null,
    planId: event.refs?.planId ?? null,
    event: hashed.canonical,
    prevHash,
    hash: hashed.hash,
  }
}

export const INSERT_RAW = `INSERT INTO audit.audit_events
  (seq, occurred_at, event_id, action, phase, actor_kind, actor_id, operation_id, plan_id, event, prev_hash, hash)
  VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`

export function rawParams(row: RawRow): unknown[] {
  return [
    row.seq,
    row.occurredAt,
    row.eventId,
    row.action,
    row.phase,
    row.actorKind,
    row.actorId,
    row.operationId,
    row.planId,
    row.event,
    row.prevHash,
    row.hash,
  ]
}

/** Runs one statement as `role` and returns the SQLSTATE, or undefined on success. */
export async function sqlstateAs(
  store: ControlStore,
  sql: string,
  params: readonly unknown[] = [],
): Promise<string | undefined> {
  try {
    await store.query('test.statement', sql, params)
    return undefined
  } catch (error) {
    return sqlstateOf(error) ?? 'unknown'
  }
}

/** The SQLSTATE behind an error thrown through the Control Store or the audit writer. */
export function sqlstateOf(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const sqlstate: unknown = Reflect.get(current, 'sqlstate')
    if (typeof sqlstate === 'string') {
      return sqlstate
    }
    current = Reflect.get(current, 'cause')
  }
  return undefined
}
