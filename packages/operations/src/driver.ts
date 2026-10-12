import type { ControlStore, Tx } from '@exponetdb/control-store'
import type { Clock, ProcessInstanceId } from '@exponetdb/kernel'
import { WORKER_ACTOR } from './actors.ts'
import { type ChangedBinding, OperationError } from './errors.ts'
import type { ExecutionContext, KindRegistry, OperationKind } from './kinds.ts'
import {
  type Claim,
  claimNextOperation,
  LEASE_MS,
  LEASE_RENEW_MS,
  releaseQueuedLease,
  renewLease,
} from './leases.ts'
import { acquireLocks } from './locks.ts'
import { type PlanRecord, readPlan } from './plans.ts'
import { type OperationRecord, readOperation, transitionOperation } from './transitions.ts'

/**
 * The worker's execution loop for one operation (§4): claim, then, by state,
 *
 * - `queued`: take the exclusivity locks (or give the lease back and wait),
 *   re-check the plan's bindings under the locks (stale → `failed`, nothing
 *   executed), `running`, execute once, record the reported outcome;
 * - `needs_reconciliation`: ask the kind what happened, never re-execute;
 * - `verifying`: verify (read-only, so a takeover may verify again).
 *
 * The lease is renewed while a step runs; when it is lost, the step's signal
 * aborts and no further transition is possible. An exception from
 * `execute` is an unknown outcome, never a failure.
 */
/** A catalog error code (the transition and its audit event store it). */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * What the composition checks before a queued operation starts, under the
 * locks and after the kind's own bindings: whether what authorized it still
 * holds (Wave 5 correction F2: the policy with the current facts and the
 * approvals the plan requires). A changed binding fails the operation as
 * `PLAN_STALE` before anything runs; the immutable plan is never rewritten.
 */
export type DispatchAdmission = (
  tx: Tx,
  plan: PlanRecord,
  operation: OperationRecord,
) => Promise<readonly ChangedBinding[]>

export interface DriverOptions {
  readonly workerId: ProcessInstanceId
  readonly kinds: KindRegistry
  readonly clock: Clock
  readonly leaseMs?: number
  readonly renewMs?: number
  /**
   * The dispatch admission. Consulted only for a `queued` operation: one
   * that already started is reconciled or verified, never started again.
   */
  readonly admit?: DispatchAdmission
  /**
   * Told about an exception a step threw. The step's outcome is then
   * `unknown` (execute, reconcile) or `error` (verify), so the operation is
   * reconciled or needs attention, never reported as succeeded; this hook
   * only makes the cause visible to the operator. It must not throw.
   */
  readonly onStepError?: (event: StepError) => void
}

export interface StepError {
  readonly operationId: string
  readonly kind: string
  readonly step: 'execute' | 'reconcile' | 'verify'
  readonly error: unknown
}

export type DriverResult =
  | { readonly status: 'idle' }
  | {
      readonly status: 'waiting'
      readonly operationId: string
      readonly blockingOperationId: string
    }
  | { readonly status: 'lease_lost'; readonly operationId: string }
  | { readonly status: 'done'; readonly operation: OperationRecord; readonly takenOver: boolean }

async function withLease<T>(
  store: ControlStore,
  claim: Claim,
  options: DriverOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const leaseMs = options.leaseMs ?? LEASE_MS
  // A failed renewal does not lose the lease: it is lost when the store says
  // another worker holds it, or when it ran out without a renewal (a margin
  // of one renewal interval before its end).
  let heldUntil = Date.now() + leaseMs
  const renewMs = options.renewMs ?? LEASE_RENEW_MS
  const timer = setInterval(() => {
    const attempt = Date.now()
    renewLease(store, claim.operation.operationId, options.workerId, leaseMs)
      .then((held) => {
        if (!held) {
          controller.abort()
        } else {
          heldUntil = attempt + leaseMs
        }
      })
      .catch(() => {
        if (Date.now() >= heldUntil - renewMs) {
          controller.abort()
        }
      })
  }, renewMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearInterval(timer)
  }
}

async function step(
  store: ControlStore,
  operationId: string,
  name: string,
  phase: 'step_started' | 'step_finished',
  outcome?: string,
): Promise<void> {
  await store.query(
    'operations.event.step',
    `INSERT INTO operations.operation_events (operation_id, kind, detail)
     VALUES ($1, $2, jsonb_strip_nulls(jsonb_build_object('step', $3::text, 'outcome', $4::text)))`,
    [operationId, phase, name, outcome ?? null],
  )
}

export async function processNextOperation(
  store: ControlStore,
  options: DriverOptions,
): Promise<DriverResult> {
  const claim = await claimNextOperation(store, {
    workerId: options.workerId,
    kinds: options.kinds.names(),
    clock: options.clock,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  })
  if (claim === undefined) {
    return { status: 'idle' }
  }
  const kind = options.kinds.get(claim.operation.kind)
  const plan =
    claim.operation.planId === null ? undefined : await readPlan(store, claim.operation.planId)
  if (kind === undefined || plan === undefined) {
    throw new OperationError('operation_kind_unknown')
  }
  try {
    return await drive(store, claim, kind, plan, options)
  } catch (error) {
    if (error instanceof OperationError && error.code === 'operation_lease_lost') {
      return { status: 'lease_lost', operationId: claim.operation.operationId }
    }
    throw error
  }
}

async function drive(
  store: ControlStore,
  claim: Claim,
  kind: OperationKind,
  plan: PlanRecord,
  options: DriverOptions,
): Promise<DriverResult> {
  const lease = { owner: options.workerId }
  const id = claim.operation.operationId
  const clock = { clock: options.clock }
  let operation = claim.operation

  if (claim.next === 'start') {
    const started = await store.transaction('operations.driver.start', async (tx) => {
      const locks = await acquireLocks(tx, id, kind.exclusivity(plan))
      if (!locks.acquired) {
        return locks
      }
      let changed = await kind.checkBindings(plan)
      if (changed.length === 0 && options.admit !== undefined) {
        changed = await options.admit(tx, plan, operation)
      }
      if (changed.length > 0) {
        return transitionOperation(
          tx,
          {
            operationId: id,
            from: 'queued',
            to: 'failed',
            verificationOutcome: 'not_applicable',
            lease,
            actor: WORKER_ACTOR,
            errorCode: 'PLAN_STALE',
            detail: { changedBindings: changed.map((b) => b.binding) },
          },
          clock,
        )
      }
      return transitionOperation(
        tx,
        { operationId: id, from: 'queued', to: 'running', lease, actor: WORKER_ACTOR },
        clock,
      )
    })
    if ('acquired' in started) {
      await releaseQueuedLease(store, id, options.workerId)
      return {
        status: 'waiting',
        operationId: id,
        blockingOperationId: started.blockingOperationId,
      }
    }
    operation = started
    if (operation.state === 'failed') {
      return { status: 'done', operation, takenOver: claim.takenOver }
    }
    await step(store, id, 'execute', 'step_started')
    const reported = await withLease(store, claim, options, (signal) =>
      kind
        .execute(
          context(
            plan,
            id,
            signal,
            options.workerId,
            options.admit === undefined
              ? undefined
              : (tx) => (options.admit as DispatchAdmission)(tx, plan, operation),
          ),
        )
        .catch((error: unknown) => {
          report(options, operation, 'execute', error)
          return 'unknown' as const
        }),
    )
    const outcome = typeof reported === 'string' ? reported : reported.outcome
    const refusal =
      typeof reported === 'string' || !ERROR_CODE.test(reported.errorCode)
        ? undefined
        : { errorCode: reported.errorCode, detail: reported.detail }
    await step(store, id, 'execute', 'step_finished', outcome)
    operation = await store.transaction('operations.driver.executed', (tx) =>
      outcome === 'applied' || outcome === 'partially_applied'
        ? transitionOperation(
            tx,
            {
              operationId: id,
              from: 'running',
              to: 'verifying',
              applyOutcome: outcome,
              verificationOutcome: 'pending',
              lease,
              actor: WORKER_ACTOR,
            },
            clock,
          )
        : outcome === 'not_applied'
          ? transitionOperation(
              tx,
              {
                operationId: id,
                from: 'running',
                to: 'failed',
                applyOutcome: 'not_applied',
                verificationOutcome: 'not_applicable',
                lease,
                actor: WORKER_ACTOR,
                ...(refusal === undefined
                  ? {}
                  : {
                      errorCode: refusal.errorCode,
                      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
                    }),
              },
              clock,
            )
          : transitionOperation(
              tx,
              {
                operationId: id,
                from: 'running',
                to: 'needs_reconciliation',
                applyOutcome: 'unknown',
                lease,
                actor: WORKER_ACTOR,
                errorCode: 'OUTCOME_UNKNOWN',
              },
              clock,
            ),
    )
  }

  if (operation.state === 'needs_reconciliation') {
    await step(store, id, 'reconcile', 'step_started')
    const outcome = await withLease(store, claim, options, (signal) =>
      kind.reconcile(context(plan, id, signal, options.workerId)).catch((error: unknown) => {
        report(options, operation, 'reconcile', error)
        return 'unknown' as const
      }),
    )
    await step(store, id, 'reconcile', 'step_finished', outcome)
    operation = await store.transaction('operations.driver.reconciled', (tx) =>
      outcome === 'applied'
        ? transitionOperation(
            tx,
            {
              operationId: id,
              from: 'needs_reconciliation',
              to: 'verifying',
              applyOutcome: 'applied',
              verificationOutcome: 'pending',
              lease,
              actor: WORKER_ACTOR,
            },
            clock,
          )
        : outcome === 'not_applied'
          ? transitionOperation(
              tx,
              {
                operationId: id,
                from: 'needs_reconciliation',
                to: 'failed',
                applyOutcome: 'not_applied',
                verificationOutcome: 'not_applicable',
                lease,
                actor: WORKER_ACTOR,
              },
              clock,
            )
          : transitionOperation(
              tx,
              {
                operationId: id,
                from: 'needs_reconciliation',
                to: 'needs_attention',
                verificationOutcome: 'pending',
                lease,
                actor: WORKER_ACTOR,
                errorCode: 'OUTCOME_UNKNOWN',
              },
              clock,
            ),
    )
    if (operation.state === 'needs_attention') {
      await store.query(
        'operations.lease.drop_attention',
        `UPDATE operations.operations SET lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1 AND lease_owner = $2 AND state = 'needs_attention'`,
        [id, options.workerId],
      )
    }
  }

  if (operation.state === 'verifying') {
    let verification: 'passed' | 'failed' | 'partial' | 'error' | 'not_applicable' =
      'not_applicable'
    if (kind.verifies) {
      await step(store, id, 'verify', 'step_started')
      verification = await withLease(store, claim, options, (signal) =>
        kind.verify(context(plan, id, signal, options.workerId)).catch((error: unknown) => {
          report(options, operation, 'verify', error)
          return 'error' as const
        }),
      )
      await step(store, id, 'verify', 'step_finished', verification)
    }
    operation = await store.transaction('operations.driver.verified', (tx) =>
      verification === 'passed' || verification === 'not_applicable'
        ? transitionOperation(
            tx,
            {
              operationId: id,
              from: 'verifying',
              to: 'succeeded',
              verificationOutcome: verification,
              lease,
              actor: WORKER_ACTOR,
            },
            clock,
          )
        : verification === 'error'
          ? transitionOperation(
              tx,
              {
                operationId: id,
                from: 'verifying',
                to: 'needs_attention',
                verificationOutcome: 'error',
                lease,
                actor: WORKER_ACTOR,
                errorCode: 'VERIFICATION_ERROR',
              },
              clock,
            )
          : transitionOperation(
              tx,
              {
                operationId: id,
                from: 'verifying',
                to: 'verification_failed',
                verificationOutcome: verification,
                lease,
                actor: WORKER_ACTOR,
                errorCode: 'VERIFICATION_FAILED',
              },
              clock,
            ),
    )
    if (operation.state === 'needs_attention') {
      await store.query(
        'operations.lease.drop_attention',
        `UPDATE operations.operations SET lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1 AND lease_owner = $2 AND state = 'needs_attention'`,
        [id, options.workerId],
      )
    }
  }

  const final = (await readOperation(store, id)) ?? operation
  return { status: 'done', operation: final, takenOver: claim.takenOver }
}

function report(
  options: DriverOptions,
  operation: OperationRecord,
  step: StepError['step'],
  error: unknown,
): void {
  try {
    options.onStepError?.({ operationId: operation.operationId, kind: operation.kind, step, error })
  } catch {
    // A failing report never changes the step's outcome.
  }
}

function context(
  plan: PlanRecord,
  operationId: string,
  signal: AbortSignal,
  leaseOwner: string,
  readmit?: ExecutionContext['readmit'],
): ExecutionContext {
  return { plan, operationId, signal, leaseOwner, ...(readmit === undefined ? {} : { readmit }) }
}
