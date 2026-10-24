import type { ExpectationResult } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import { layerFrom } from '../src/reads.ts'
import {
  clusterGlobalFailures,
  excusedBy,
  failuresOf,
  sameFailure,
  structuralFailures,
  unreadableFailure,
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

  it('records a file whose checks could not be read as one failure an acceptance excuses (review P1-1)', () => {
    const unreadable = unreadableFailure('0005_private', 'structural')
    expect(unreadable).toEqual({
      file: '0005_private',
      statement: null,
      kind: 'expectations',
      object: 'structural expectations of 0005_private',
      failed: ['unreadable'],
    })
    expect(excusedBy({ accepted: true, recorded: [unreadable] }, unreadable)).toBe(true)
    // Unreadable now, readable and failing at the analysis: not what the person accepted.
    const [rlsFailure] = structuralFailures('0005_private', [rls])
    if (rlsFailure === undefined) throw new Error('no failure')
    expect(excusedBy({ accepted: true, recorded: [rlsFailure] }, unreadable)).toBe(false)
    expect(unreadableFailure('0005_private', 'cluster_global').kind).toBe(
      'cluster_global_expectations',
    )
  })

  it('reads runs stored before layers had a status (review P3-6)', () => {
    expect(layerFrom({ checked: 3, held: 3 }, 'structural').status).toBe('passed')
    expect(layerFrom({ checked: 3, held: 2 }, 'structural')).toMatchObject({
      status: 'failed',
      failed: 1,
    })
    expect(layerFrom({ checked: 0, held: 0 }, 'structural').status).toBe('skipped')
    // An unparsed chain checked nothing and failed the run: an error, never skipped.
    expect(layerFrom({ checked: 0, held: 0, unparsed: '0007_x' }, 'structural')).toMatchObject({
      status: 'error',
      firstFailure: { name: 'unparsed: 0007_x' },
    })
    expect(layerFrom({ fingerprint: 'mismatch' }, 'engine').status).toBe('failed')
  })
})
