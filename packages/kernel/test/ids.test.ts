import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type EntityId,
  ID_PREFIXES,
  type IdPrefix,
  idPattern,
  idRefusal,
  isId,
  isIdPrefix,
  isMigrationId,
  MIGRATION_ID_PATTERN,
  type MigrationId,
  newId,
  newUlid,
  type PlanId,
  parseId,
  parseMigrationId,
  type TargetId,
  ulidRefusal,
} from '../src/index.ts'
import { loadGolden } from './golden.ts'

interface IdVector {
  id: string
  description: string
  value: string
  kind: string
  valid: boolean
  reason?: string
}

const { vectors } = loadGolden<{ vectors: IdVector[] }>('ids.json')
const VALID_ULID = '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'

function refusal(v: IdVector): string | undefined {
  if (v.kind === 'migration') {
    return ulidRefusal(v.value)
  }
  if (!isIdPrefix(v.kind)) {
    throw new Error(`unknown kind in vector ${v.id}`)
  }
  return idRefusal(v.kind, v.value)
}

describe('id golden vectors (tooling/golden/ids.json)', () => {
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      expect(refusal(v)).toBe(v.valid ? undefined : v.reason)
    })
  }
})

describe('id patterns', () => {
  it('agree with the validating functions on every golden vector', () => {
    for (const v of vectors) {
      const pattern = new RegExp(
        v.kind === 'migration' ? MIGRATION_ID_PATTERN : idPattern(v.kind as IdPrefix),
      )
      expect(pattern.test(v.value), v.id).toBe(v.valid)
    }
  })
})

describe('prefixed ids', () => {
  it('uses lowercase prefixes of two or three letters, each unique', () => {
    const prefixes = Object.keys(ID_PREFIXES)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const p of prefixes) {
      expect(p).toMatch(/^[a-z]{2,3}$/)
    }
  })

  it('parses a valid id into the branded type without changing the string', () => {
    const parsed = parseId('tgt', `tgt_${VALID_ULID}`)
    expect(parsed).toEqual({ ok: true, value: `tgt_${VALID_ULID}` })
  })

  it('reports the reason and the expected prefix on refusal', () => {
    expect(parseId('tgt', `pln_${VALID_ULID}`)).toEqual({
      ok: false,
      error: {
        code: 'invalid_id',
        message: 'Not a valid Target id (tgt_<ULID>).',
        details: { reason: 'wrong_prefix', expected: 'tgt' },
      },
    })
  })

  it('never folds case', () => {
    const lower = `tgt_${VALID_ULID.toLowerCase()}`
    const parsed = parseId('tgt', lower)
    expect(parsed.ok).toBe(false)
    expect(isId('tgt', lower)).toBe(false)
  })

  it('refuses non-string input', () => {
    for (const value of [undefined, null, 42, {}, [`tgt_${VALID_ULID}`]]) {
      expect(isId('tgt', value)).toBe(false)
      expect(parseId('tgt', value).ok).toBe(false)
    }
  })

  it('keeps entity types apart at compile time', () => {
    expectTypeOf<PlanId>().not.toEqualTypeOf<TargetId>()
    expectTypeOf<TargetId>().toMatchTypeOf<string>()
    const acceptsTarget = (id: TargetId): string => id
    const parsed = parseId('pln', `pln_${VALID_ULID}`)
    if (parsed.ok) {
      // @ts-expect-error a plan id is not a target id
      acceptsTarget(parsed.value)
      // @ts-expect-error a plain string is not a target id
      acceptsTarget(`tgt_${VALID_ULID}`)
    }
  })

  it('serializes to and from JSON as the same string', () => {
    const parsed = parseId('op', `op_${VALID_ULID}`)
    if (!parsed.ok) {
      throw new Error('expected valid')
    }
    const roundTrip: unknown = JSON.parse(JSON.stringify({ operationId: parsed.value }))
    expect(roundTrip).toEqual({ operationId: `op_${VALID_ULID}` })
    expect(isId('op', (roundTrip as { operationId: unknown }).operationId)).toBe(true)
  })
})

describe('migration ids', () => {
  it('are bare ULIDs, distinct from prefixed ids', () => {
    expect(isMigrationId(VALID_ULID)).toBe(true)
    expect(isMigrationId(`tgt_${VALID_ULID}`)).toBe(false)
    expect(isId('tgt', VALID_ULID)).toBe(false)
    expectTypeOf<MigrationId>().not.toEqualTypeOf<EntityId<IdPrefix>>()
  })

  it('refuse the 20-character example from the owner brief', () => {
    expect(parseMigrationId('01K6XQ4E9N8T3G5Y7Z2M')).toMatchObject({
      ok: false,
      error: { details: { reason: 'invalid_ulid', expected: 'migration' } },
    })
  })

  it('refuse lowercase as not canonical', () => {
    expect(parseMigrationId(VALID_ULID.toLowerCase())).toMatchObject({
      ok: false,
      error: { details: { reason: 'not_canonical' } },
    })
  })
})

describe('id generation', () => {
  const zeros = (size: number): Uint8Array => new Uint8Array(size)
  const ones = (size: number): Uint8Array => new Uint8Array(size).fill(0xff)

  it('encodes the time and randomness in canonical form', () => {
    expect(newUlid(0, zeros)).toBe('00000000000000000000000000')
    expect(newUlid(2 ** 48 - 1, ones)).toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(newUlid(1_759_579_200_000, zeros)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{9}0{16}$/)
  })

  it('creates valid ids with the injected time', () => {
    const id = newId('pln', 1_759_579_200_000)
    expect(isId('pln', id)).toBe(true)
    expectTypeOf(id).toEqualTypeOf<PlanId>()
  })

  it('creates different ids for the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('op', 1_759_579_200_000)))
    expect(ids.size).toBe(1000)
  })

  it('does not promise that ids sort by creation (randomness decides within a millisecond)', () => {
    const early = newId('op', 1_000, ones)
    const late = newId('op', 1_000, zeros)
    expect(early > late).toBe(true)
  })

  it('refuses times outside 48 bits and wrong randomness sizes', () => {
    expect(() => newUlid(-1)).toThrow()
    expect(() => newUlid(2 ** 48)).toThrow()
    expect(() => newUlid(1.5)).toThrow()
    expect(() => newUlid(0, () => new Uint8Array(9))).toThrow()
  })
})
