import { appendAuditEvent } from '@exponetdb/audit'
import type { AuditEventInput } from '@exponetdb/contracts'
import type { Row, Tx } from '@exponetdb/control-store'
import {
  type Clock,
  InvariantError,
  type JsonObject,
  type OperationId,
  type PlanId,
  type ProcessInstanceId,
  parseId,
} from '@exponetdb/kernel'
import { auditActor, type OperationActor } from './actors.ts'
import { OperationError } from './errors.ts'
import {
  type ApplyOutcome,
  admits,
  canTransition,
  isApplyOutcome,
  isOperationState,
  isTerminal,
  isVerificationOutcome,
  type OperationState,
  type VerificationOutcome,
} from './states.ts'

/**
 * The single transition API (§4.1). Every state change of an operation goes
 * through `transitionOperation`: it checks the state machine, updates the row
 * only if it is still in the expected state (and, for worker transitions, the
 * caller still holds an unexpired lease), records the event, releases the
 * exclusivity locks when the operation finishes, and appends the audit
 * event, all in the caller's transaction. If any part fails, nothing changes.
 */
export interface OperationRecord {
  readonly operationId: OperationId
  readonly planId: PlanId | null
  readonly kind: string
  readonly kindVersion: number
  readonly state: OperationState
  readonly applyOutcome: ApplyOutcome
  readonly verificationOutcome: VerificationOutcome
  readonly leaseOwner: string | null
  readonly attempt: number
}

export const OPERATION_COLUMNS =
  'operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome, lease_owner, attempt'

export function operationFromRow(row: Row): OperationRecord {
  const operationId = parseId('op', row.text('operation_id'))
  const plan = row.textOrNull('plan_id')
  const planId = plan === null ? null : parseId('pln', plan)
  const state = row.text('state')
  const apply = row.text('apply_outcome')
  const verification = row.text('verification_outcome')
  if (
    !operationId.ok ||
    (planId !== null && !planId.ok) ||
    !isOperationState(state) ||
    !isApplyOutcome(apply) ||
    !isVerificationOutcome(verification)
  ) {
    throw new InvariantError('stored operations match the database checks')
  }
  return {
    operationId: operationId.value,
    planId: planId === null ? null : planId.value,
    kind: row.text('kind'),
    kindVersion: row.int('kind_version'),
    state,
    applyOutcome: apply,
    verificationOutcome: verification,
    leaseOwner: row.textOrNull('lease_owner'),
    attempt: row.int('attempt'),
  }
}

export interface Transition {
  readonly operationId: OperationId
  readonly from: OperationState
  readonly to: OperationState
  readonly applyOutcome?: ApplyOutcome
  readonly verificationOutcome?: VerificationOutcome
  /** Worker transitions name the lease they hold; the update fails if it is lost. */
  readonly lease?: { readonly owner: ProcessInstanceId }
  readonly actor: OperationActor
  /** Error code of the catalog for failed outcomes (audit `result.errorCode`). */
  readonly errorCode?: string
  readonly detail?: JsonObject
}

type Phase = AuditEventInput['phase']

function phaseOf(from: OperationState, to: OperationState): Phase {
  if (from === 'needs_reconciliation' && (to === 'verifying' || to === 'failed')) {
    return 'reconciled'
  }
  switch (to) {
    case 'awaiting_approval':
    case 'queued':
      return 'accepted'
    case 'running':
      return 'requested'
    case 'verifying':
    case 'succeeded':
      return 'completed'
    default:
      return 'failed'
  }
}

export async function transitionOperation(
  tx: Tx,
  t: Transition,
  options: { readonly clock: Clock },
): Promise<OperationRecord> {
  if (!canTransition(t.from, t.to)) {
    throw new OperationError('operation_transition_invalid')
  }
  const current = await tx.query(
    'operations.operation.current',
    `SELECT ${OPERATION_COLUMNS}, (lease_owner = $2 AND lease_expires_at > clock_timestamp()) AS lease_held
       FROM operations.operations WHERE operation_id = $1 FOR UPDATE`,
    [t.operationId, t.lease?.owner ?? null],
  )
  const row = current.rows[0]
  if (row === undefined) {
    throw new OperationError('OPERATION_NOT_FOUND')
  }
  const before = operationFromRow(row)
  if (before.state !== t.from) {
    throw new OperationError('operation_state_changed')
  }
  if (t.lease !== undefined && row.boolOrNull('lease_held') !== true) {
    throw new OperationError('operation_lease_lost')
  }
  const apply = t.applyOutcome ?? before.applyOutcome
  const verification = t.verificationOutcome ?? before.verificationOutcome
  if (!admits(t.to, apply, verification)) {
    throw new OperationError('operation_transition_invalid')
  }
  const finished = isTerminal(t.to)
  // A finished operation holds no lease. Only leased (worker) operations
  // have one to clear; serve's grants do not include the lease columns.
  const clearLease = finished && before.leaseOwner !== null
  const updated = await tx.query(
    clearLease ? 'operations.operation.transition_final' : 'operations.operation.transition',
    `UPDATE operations.operations
        SET state = $2, apply_outcome = $3, verification_outcome = $4
            ${clearLease ? ', lease_owner = NULL, lease_expires_at = NULL' : ''}
      WHERE operation_id = $1
      RETURNING ${OPERATION_COLUMNS}`,
    [t.operationId, t.to, apply, verification],
  )
  const afterRow = updated.rows[0]
  if (afterRow === undefined) {
    throw new OperationError('operation_state_changed')
  }
  await tx.query(
    'operations.event.transition',
    `INSERT INTO operations.operation_events (operation_id, kind, from_state, to_state, detail)
     VALUES ($1, 'transition', $2, $3, $4::jsonb)`,
    [t.operationId, t.from, t.to, JSON.stringify(t.detail ?? {})],
  )
  // Only the worker takes locks (from `queued` on), so only its transitions
  // can have locks to release; serve's cancellations never hold any.
  const held = finished
    ? await tx.query(
        'operations.locks.held_by',
        'SELECT 1 FROM operations.operation_locks WHERE operation_id = $1 LIMIT 1',
        [t.operationId],
      )
    : undefined
  if (held !== undefined && held.rows.length > 0) {
    const released = await tx.query(
      'operations.locks.release',
      'DELETE FROM operations.operation_locks WHERE operation_id = $1 RETURNING domain_key',
      [t.operationId],
    )
    if (released.rows.length > 0) {
      await tx.query(
        'operations.event.locks_released',
        `INSERT INTO operations.operation_events (operation_id, kind, detail)
         VALUES ($1, 'locks_released', jsonb_build_object('domains', $2::text[]))`,
        [t.operationId, released.rows.map((r) => r.text('domain_key'))],
      )
    }
  }
  const phase = phaseOf(t.from, t.to)
  await appendAuditEvent(
    tx,
    {
      action: 'operation.state_changed',
      phase,
      actor: auditActor(t.actor),
      refs: {
        operationId: t.operationId,
        ...(before.planId === null ? {} : { planId: before.planId }),
      },
      result: {
        status: phase === 'failed' ? 'failed' : 'succeeded',
        applyOutcome: apply,
        verificationOutcome: verification,
        ...(t.errorCode === undefined ? {} : { errorCode: t.errorCode }),
      },
      changes: { kind: before.kind, from: t.from, to: t.to },
    },
    { clock: options.clock },
  )
  return operationFromRow(afterRow)
}

export async function readOperation(
  tx: Pick<Tx, 'query'>,
  operationId: string,
): Promise<OperationRecord | undefined> {
  const { rows } = await tx.query(
    'operations.operation.read',
    `SELECT ${OPERATION_COLUMNS} FROM operations.operations WHERE operation_id = $1`,
    [operationId],
  )
  const row = rows[0]
  return row === undefined ? undefined : operationFromRow(row)
}
