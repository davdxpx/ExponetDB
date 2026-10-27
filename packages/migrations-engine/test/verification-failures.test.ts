import { type ExpectationResult, TargetError } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import { readsAsUnreadable } from '../src/legacy.ts'
import { layerFrom } from '../src/reads.ts'
import {
  clusterGlobalFailures,
  excusedBy,
  excusedValue,
  failuresOf,
  isValueFailure,
  type RecordedValues,
  sameFailure,
  structuralDigests,
  structuralFailures,
  structuralValueDigest,
  unreadableFailure,
  valueKeyOf,
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

  it('calls a read unreadable only when it would fail the same way again (re-review)', () => {
    const sqlError = (sqlstate: string) =>
      new TargetError('TARGET_SQL_ERROR', 'server_error', { sqlstate })
    expect(
      readsAsUnreadable(
        new TargetError('PERMISSION_DENIED', 'insufficient_privilege', { sqlstate: '42501' }),
      ),
    ).toBe(true)
    expect(readsAsUnreadable(sqlError('0A000'))).toBe(true)
    expect(readsAsUnreadable(new Error('a row the engine cannot decode'))).toBe(true)
    // What may pass on its own errors the run, which a person can retry.
    expect(readsAsUnreadable(new TargetError('QUERY_TIMEOUT', 'statement_timeout'))).toBe(false)
    expect(readsAsUnreadable(new TargetError('TARGET_UNAVAILABLE', 'connection_lost'))).toBe(false)
    for (const transient of ['57014', '55P03', '40001', '40P01', '53300', '08006']) {
      expect(readsAsUnreadable(sqlError(transient))).toBe(false)
    }
  })
})

describe('excused values (OD-56 (a))', () => {
  const body = {
    file: '0003_touch',
    statement: 2,
    kind: 'function',
    object: 'function "public"."acme_touch"()',
    failed: ['body'],
  }
  const key = 'sec_01M5X840BQEDCSCF9ADCZCFW5S:1'
  const recorded = (digest: string | undefined, keyRef: string | null | undefined = key) =>
    ({
      keyRef,
      digests: new Map(digest === undefined ? [] : [[3, new Map([[valueKeyOf(body), digest]])]]),
    }) satisfies RecordedValues

  it('treats only failures of a value as values', () => {
    expect(isValueFailure(body)).toBe(true)
    expect(isValueFailure({ failed: ['value'] })).toBe(true)
    for (const aspect of ['missing', 'present', 'unreadable', 'changed']) {
      expect(isValueFailure({ failed: [aspect] }), aspect).toBe(false)
    }
  })

  it('never excuses an excused value that can no longer be read (review E-4)', () => {
    // The decision excused the body; the same object now reads as unreadable: another failure.
    const unreadable = { ...body, failed: ['unreadable'] }
    expect(excusedBy({ accepted: true, recorded: [body] }, unreadable)).toBe(false)
    expect(
      excusedBy({ accepted: true, recorded: [body] }, { ...body, failed: ['body', 'unreadable'] }),
    ).toBe(false)
  })

  it('excuses a value only under the same key with the same digest; fails closed otherwise', () => {
    const now = (digest: string | undefined, keyRef: string | null = key) => ({ keyRef, digest })
    expect(excusedValue(recorded('hmac-sha256:aa'), 3, body, now('hmac-sha256:aa'))).toBe('held')
    expect(excusedValue(recorded('hmac-sha256:aa'), 3, body, now('hmac-sha256:bb'))).toBe(
      'value_changed',
    )
    // A rotated key, no key, no digest now, nothing recorded, or a report without a key.
    expect(
      excusedValue(recorded('hmac-sha256:aa'), 3, body, now('hmac-sha256:aa', `${key}0`)),
    ).toBe('value_unverifiable')
    expect(excusedValue(recorded('hmac-sha256:aa'), 3, body, now('hmac-sha256:aa', null))).toBe(
      'value_unverifiable',
    )
    expect(excusedValue(recorded('hmac-sha256:aa'), 3, body, now(undefined))).toBe(
      'value_unverifiable',
    )
    expect(excusedValue(recorded(undefined), 3, body, now('hmac-sha256:aa'))).toBe(
      'value_unverifiable',
    )
    expect(excusedValue(recorded('hmac-sha256:aa', null), 3, body, now('hmac-sha256:aa'))).toBe(
      'value_unverifiable',
    )
    // Another item's digest is not this one's.
    expect(excusedValue(recorded('hmac-sha256:aa'), 4, body, now('hmac-sha256:aa'))).toBe(
      'value_unverifiable',
    )
    // A report analyzed before digests (no key row) keeps its baseline's rule; existence is no value.
    const before: RecordedValues = { keyRef: undefined, digests: new Map() }
    expect(excusedValue(before, 3, body, now(undefined))).toBe('held')
    expect(
      excusedValue(recorded(undefined), 3, { ...body, failed: ['missing'] }, now(undefined)),
    ).toBe('held')
  })

  it('binds the digest to the failure, and keeps it out of the failure records', () => {
    const inputs: string[] = []
    const options = structuralValueDigest('0003_touch', (input) => {
      inputs.push(input)
      return 'hmac-sha256:00'
    })
    const result = {
      statement: 2,
      kind: 'function' as const,
      ok: false,
      description: 'function "public"."acme_touch"()',
      failed: ['body' as const],
    }
    const digest = options.valueDigest?.(result, '{"body":"BEGIN RETURN 2; END"}')
    expect(digest).toBe('hmac-sha256:00')
    expect(inputs).toEqual([`${valueKeyOf(body)}\n{"body":"BEGIN RETURN 2; END"}`])
    const withDigest = { ...result, observedDigest: digest ?? '' }
    expect(structuralDigests('0003_touch', [withDigest])).toEqual(
      new Map([[valueKeyOf(body), 'hmac-sha256:00']]),
    )
    expect(JSON.stringify(structuralFailures('0003_touch', [withDigest]))).not.toContain('hmac')
  })
})
