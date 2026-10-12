import { describe, expect, it } from 'vitest'
import { nextActionOf } from '../src/views.ts'

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
