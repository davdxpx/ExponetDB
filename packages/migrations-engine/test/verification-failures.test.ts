import type { ExpectationResult } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import {
  clusterGlobalFailures,
  excusedBy,
  failuresOf,
  sameFailure,
  structuralFailures,
} from '../src/verification-failures.ts'

/**
 * What a review decision excuses at a baseline's verification (Part A
 * follow-up 3, F1; legacy-import.md §2 step 7), and how failures are kept.
 */
const rls: ExpectationResult = {
  statement: 0,
  kind: 'row_security',
  ok: false,
  description: 'row security of public.acme_items',
  failed: ['enabled'],
}

describe('failures of a baseline verification', () => {
  it('keeps the failing results only, with where they come from and what differs', () => {
    const held: ExpectationResult = { ...rls, ok: true, failed: undefined as never }
    expect(structuralFailures('0002_rls', [rls, held])).toEqual([
      {
        file: '0002_rls',
        statement: 0,
        kind: 'row_security',
        object: 'row security of public.acme_items',
        failed: ['enabled'],
      },
    ])
    expect(
      clusterGlobalFailures('0004_role', [
        {
          expectation: { kind: 'role', role: 'acme_r', exists: true },
          applies: true,
          ok: false,
        },
        {
          expectation: { kind: 'role_attribute', role: 'acme_r', attribute: 'login', value: true },
          applies: true,
          ok: false,
        },
        // A guard that does not hold states nothing: no failure.
        {
          expectation: { kind: 'role', role: 'acme_q', exists: true, when: [] },
          applies: false,
          ok: false,
        },
      ]).map((f) => [f.object, f.failed]),
    ).toEqual([
      ['role acme_r', ['missing']],
      ['login on for role acme_r', ['value']],
    ])
  })

  it('excuses exactly what the analysis recorded, failing the same way, for an accepted file', () => {
    const [recorded] = structuralFailures('0002_rls', [rls])
    if (recorded === undefined) throw new Error('no failure')
    const accepted = { accepted: true, recorded: [recorded] }
    expect(excusedBy(accepted, recorded)).toBe(true)
    // The same expectation failing another way is not what the person accepted.
    const otherWay = { ...recorded, failed: ['missing'] }
    expect(sameFailure(recorded, otherWay)).toBe(false)
    expect(excusedBy(accepted, otherWay)).toBe(false)
    // Another expectation of the same file is not either.
    expect(excusedBy(accepted, { ...recorded, statement: 1 })).toBe(false)
    // Nothing is excused without an accepting decision.
    expect(excusedBy({ accepted: false, recorded: [recorded] }, recorded)).toBe(false)
    // A report analyzed before failures were recorded: every failure of an accepted file.
    expect(excusedBy({ accepted: true, recorded: null }, otherWay)).toBe(true)
    expect(excusedBy({ accepted: false, recorded: null }, otherWay)).toBe(false)
  })

  it('reads a stored list back, and anything else as not recorded', () => {
    const list = structuralFailures('0002_rls', [rls])
    expect(failuresOf(JSON.parse(JSON.stringify(list)))).toEqual(list)
    expect(failuresOf(null)).toBe(null)
    expect(failuresOf([{ file: 1 }])).toBe(null)
  })
})
