import { loadClusterGlobalParsers } from '@exponetdb/postgres/parser'
import { RegistryError } from '@exponetdb/registry'
import { beforeAll, describe, expect, it } from 'vitest'
import { refuseOversizedLegacyFiles } from '../src/legacy-files.ts'

/**
 * The early refusal of a legacy file one parse could not be given
 * (`MAX_PARSE_TOKENS`, deployment.md §2a; TC-003, Part A P1 no. 1): the body
 * of a `DO` block counts the same in every quoting.
 */
beforeAll(async () => {
  await loadClusterGlobalParsers(18)
})

const block = (statements: number) => `BEGIN ${'PERFORM 1;'.repeat(statements)} END`
const OVER = 70_000
const MIB = 1024 * 1024

const refusal = (text: string): RegistryError | undefined => {
  try {
    refuseOversizedLegacyFiles([
      { name: '0001_a.sql', text: '-- ok\n' },
      { name: '0002_big.sql', text },
    ])
  } catch (error) {
    if (error instanceof RegistryError) return error
    throw error
  }
  return undefined
}

describe('refuseOversizedLegacyFiles', () => {
  it.each([
    ['a single-quoted DO body', `DO '${block(OVER)}';`],
    ['a DO body after LANGUAGE', `DO LANGUAGE plpgsql '${block(OVER)}';`],
    ['a DO body before LANGUAGE', `DO '${block(OVER)}' LANGUAGE plpgsql;`],
    ['an E string DO body', `DO E'${block(OVER)}';`],
    ['a dollar-quoted DO body', `DO $$${block(OVER)}$$;`],
  ])('refuses %s above the token budget, naming the file', (_name, text) => {
    const error = refusal(text)
    expect(error?.code).toBe('VALIDATION_FAILED')
    expect(error?.details).toMatchObject({
      errors: [{ path: '/files/1/text', code: 'too_large' }],
    })
  })

  it('accepts a body that fits and a large ordinary literal', () => {
    expect(refusal(`DO '${block(1000)}';`)).toBeUndefined()
    const json = `INSERT INTO public.t (doc) VALUES ('${'{"k": 1}, '.repeat(110_000)}');`
    expect(json.length).toBeGreaterThan(MIB)
    expect(refusal(json)).toBeUndefined()
  })

  it('refuses the largest legal file (4 MiB of DO body) without the memory a parse would take', () => {
    const unit = 'PERFORM 1;'
    const text = `DO '${'BEGIN '.concat(unit.repeat(Math.floor((4 * MIB - 100) / unit.length)))} END';`
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * MIB)
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * MIB - 1024)
    const before = process.memoryUsage().rss
    expect(refusal(text)?.code).toBe('VALIDATION_FAILED')
    // The parser measured 1,114 MiB on this text before the bound (TC-003); refusing it reads the text only.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MIB)
  })
})
