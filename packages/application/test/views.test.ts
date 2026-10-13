import { describe, expect, it } from 'vitest'
import { nextActionOf, operationRead, planRead, verificationRetryable } from '../src/views.ts'

/**
 * The next action an operation read names (Wave 6, `OperationNextAction`):
 * derived from the state and the outcomes only, never "done" while the
 * server works, never a rollback for a failed verification.
 */
describe('nextActionOf', () => {
  it('names the action for every state and outcome that matters', () => {
    expect(nextActionOf('awaiting_approval', 'not_started', 'pending', null)).toBe('approve')
    for (const state of ['queued', 'running', 'verifying', 'needs_reconciliation'] as const) {
      expect(nextActionOf(state, 'not_started', 'pending', null)).toBe('wait')
    }
    expect(nextActionOf('needs_attention', 'unknown', 'pending', null)).toBe('inspect')
    expect(nextActionOf('succeeded', 'applied', 'passed', null)).toBe('none')
    expect(nextActionOf('canceled', 'not_started', 'not_applicable', null)).toBe('none')
    expect(nextActionOf('verification_failed', 'applied', 'failed', null)).toBe('forward_fix')
    expect(
      nextActionOf('verification_failed', 'partially_applied', 'partial', 'MIGRATION_INCOMPLETE'),
    ).toBe('resume')
    expect(nextActionOf('failed', 'not_applied', 'not_applicable', 'MIGRATION_SQL_FAILED')).toBe(
      'replan',
    )
    expect(nextActionOf('failed', 'partially_applied', 'partial', null)).toBe('resume')
    expect(nextActionOf('failed', 'unknown', 'pending', null)).toBe('inspect')
  })
})

/**
 * `retryable` (Wave 8 order §9): the one predicate the retry route uses, so a
 * button in the Web App and the call it makes cannot disagree about the
 * operation itself.
 */
describe('verificationRetryable', () => {
  const op = (over: Partial<Parameters<typeof verificationRetryable>[0]> = {}) => ({
    kind: 'migration.apply',
    state: 'needs_attention',
    applyOutcome: 'applied',
    verificationOutcome: 'error',
    ...over,
  })

  it('is true only for an applied change whose verification errored or never finished', () => {
    expect(verificationRetryable(op())).toBe(true)
    expect(verificationRetryable(op({ verificationOutcome: 'pending' }))).toBe(true)
    expect(verificationRetryable(op({ kind: 'migration.resume' }))).toBe(true)
    expect(verificationRetryable(op({ applyOutcome: 'partially_applied' }))).toBe(true)
  })

  it('is false for every other state, outcome and kind', () => {
    for (const state of [
      'queued',
      'running',
      'verifying',
      'succeeded',
      'failed',
      'verification_failed',
      'canceled',
    ]) {
      expect(verificationRetryable(op({ state })), state).toBe(false)
    }
    for (const applyOutcome of ['not_started', 'not_applied', 'unknown']) {
      expect(verificationRetryable(op({ applyOutcome })), applyOutcome).toBe(false)
    }
    for (const verificationOutcome of ['passed', 'failed', 'partial', 'not_applicable']) {
      expect(verificationRetryable(op({ verificationOutcome })), verificationOutcome).toBe(false)
    }
    for (const kind of ['node.inspect', 'postgres.reload', 'credential.rotate', 'access.change']) {
      expect(verificationRetryable(op({ kind })), kind).toBe(false)
    }
  })

  it('is not offered for an operation without a plan, which the route could not retry', () => {
    const view = { ...op(), planId: null } as never
    expect(operationRead(view).retryable).toBe(false)
    const planned = { ...op(), planId: 'pln_01HZZZZZZZZZZZZZZZZZZZZZZZ' } as never
    expect(operationRead(planned).retryable).toBe(true)
  })
})

describe('planRead', () => {
  it('adds the operation that applied the plan, or null when none did', () => {
    const view = { planId: 'pln_01HZZZZZZZZZZZZZZZZZZZZZZZ' } as never
    expect(planRead(view, undefined)).toMatchObject({ operationId: null })
    expect(planRead(view, 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ')).toMatchObject({
      operationId: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    })
    // A value that is not an operation id is not passed on.
    expect(planRead(view, 'not an id')).toMatchObject({ operationId: null })
  })
})
