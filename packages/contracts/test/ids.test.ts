import { describe, expect, it } from 'vitest'
import {
  MigrationIdSchema,
  PlanIdSchema,
  RequestIdSchema,
  TargetIdSchema,
  validationProblem,
} from '../src/index.ts'

/**
 * The reason an id is refused reaches the client (error-model.md §1: a
 * refusal explains itself) and the submitted value never does: a caller can
 * paste anything into an id field, and the message is catalog-like text.
 */
const VALID = '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'

function messageOf(
  schema: { safeParse(value: unknown): { success: boolean; error?: unknown } },
  value: unknown,
) {
  const result = schema.safeParse(value)
  expect(result.success).toBe(false)
  const issues = (result.error as { issues: { message: string; code: string }[] }).issues
  expect(issues).toHaveLength(1)
  return issues[0]?.message ?? ''
}

describe('id refusals', () => {
  it('names the length rule for a 25-character id and never repeats the value', () => {
    const submitted = `pln_${VALID.slice(0, 25)}`
    const message = messageOf(PlanIdSchema, submitted)
    expect(message).toContain('exactly 26 characters')
    expect(message).toContain('after pln_')
    expect(message).not.toContain(submitted)
    expect(message).not.toContain(VALID.slice(0, 25))
  })

  it('names the case rule for a lowercase id', () => {
    const submitted = `pln_${VALID.toLowerCase()}`
    const message = messageOf(PlanIdSchema, submitted)
    expect(message).toContain('uppercase')
    expect(message).toContain('never case-folded')
    expect(message).not.toContain(VALID.toLowerCase())
  })

  it('names the prefix for a missing, another or non-text id', () => {
    for (const submitted of [VALID, `tgt_${VALID}`, 'garbage', 5, null, { id: 1 }]) {
      const message = messageOf(PlanIdSchema, submitted)
      expect(message, JSON.stringify(submitted)).toContain(
        'Expected the prefix pln_ followed by 26',
      )
      if (typeof submitted === 'string') expect(message).not.toContain(submitted)
    }
  })

  it('says the same about every character that is not Crockford base32', () => {
    for (const bad of ['I', 'L', 'O', 'U', '-', ' ']) {
      const submitted = `tgt_0${bad}${VALID.slice(2)}`
      const message = messageOf(TargetIdSchema, submitted)
      expect(message).toContain('without I, L, O, U')
      expect(message).not.toContain(submitted)
    }
  })

  it('uses the prefix of the schema that refused', () => {
    expect(messageOf(RequestIdSchema, 'x')).toContain('req_')
    expect(messageOf(TargetIdSchema, 'x')).toContain('tgt_')
  })

  it('refuses a migration id by the same rules, without a prefix', () => {
    const short = messageOf(MigrationIdSchema, '01K6XQ4E9N8T3G5Y7Z2M')
    expect(short).toContain('exactly 26 characters')
    expect(short).not.toContain('01K6XQ4E9N8T3G5Y7Z2M')
    expect(messageOf(MigrationIdSchema, VALID.toLowerCase())).toContain('never case-folded')
  })

  it('still accepts a canonical id', () => {
    expect(PlanIdSchema.safeParse(`pln_${VALID}`).success).toBe(true)
    expect(MigrationIdSchema.safeParse(VALID).success).toBe(true)
  })

  it('keeps the message inside the VALIDATION_FAILED issue limits', () => {
    const message = messageOf(PlanIdSchema, 'x')
    expect(message.length).toBeLessThanOrEqual(512)
    const problem = validationProblem('req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' as never, [
      { path: '/planId', code: 'custom', message },
    ])
    expect(problem.ok).toBe(true)
  })
})
