import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { computeBundleDigests, executableText, ledgerStateHash } from '../src/format/index.ts'
import { loadGolden } from './golden.ts'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const hex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16))

const SqlVectorSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  input: z.string().optional(),
  inputHex: z.string().optional(),
  expected: z.string().optional(),
  expectedError: z.string().optional(),
})

describe('c1 executable text (tooling/golden/c1-sql.json)', () => {
  const { vectors } = loadGolden('c1-sql.json', z.object({ vectors: z.array(SqlVectorSchema) }))
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const bytes = v.inputHex !== undefined ? hex(v.inputHex) : utf8(v.input ?? '')
      const result = executableText(bytes)
      if (v.expectedError !== undefined) {
        expect(result).toEqual({ ok: false, error: v.expectedError })
      } else {
        expect(result).toEqual({ ok: true, value: v.expected })
      }
    })
  }
})

const BundleVectorSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  manifest: z.unknown(),
  projectDefaults: z.unknown(),
  files: z.record(z.string(), z.string()),
  expected: z
    .strictObject({
      applyProjection: z.string(),
      verifyProjection: z.string(),
      rollbackProjection: z.string(),
      executableText: z.record(z.string(), z.string().nullable()),
      checksum: z.string(),
      verifyDigest: z.string(),
      rollbackDigest: z.string(),
      bundleDigest: z.string(),
      sourceDigest: z.string(),
    })
    .optional(),
  expectedError: z.strictObject({ code: z.string(), file: z.string().optional() }).optional(),
  sameDigestsAs: z.string().optional(),
})

describe('c1 digests (tooling/golden/c1-bundles.json)', () => {
  const { vectors } = loadGolden(
    'c1-bundles.json',
    z.object({ vectors: z.array(BundleVectorSchema) }),
  )
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const files: { 'up.sql'?: Uint8Array; 'verify.sql'?: Uint8Array; 'down.sql'?: Uint8Array } =
        {}
      for (const name of ['up.sql', 'verify.sql', 'down.sql'] as const) {
        const text = v.files[name]
        if (text !== undefined) {
          files[name] = utf8(text)
        }
      }
      const result = computeBundleDigests({
        manifest: v.manifest,
        projectDefaults: v.projectDefaults,
        files,
      })
      if (v.expectedError !== undefined) {
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe(v.expectedError.code)
          expect('file' in result.error ? result.error.file : undefined).toBe(v.expectedError.file)
        }
        return
      }
      expect(result.ok ? 'ok' : JSON.stringify(result.error)).toBe('ok')
      if (result.ok && v.expected !== undefined) {
        const d = result.value
        expect(d.projections).toEqual({
          apply: v.expected.applyProjection,
          verify: v.expected.verifyProjection,
          rollback: v.expected.rollbackProjection,
        })
        expect(d.executableText).toEqual(v.expected.executableText)
        expect(d.checksum).toBe(v.expected.checksum)
        expect(d.verifyDigest).toBe(v.expected.verifyDigest)
        expect(d.rollbackDigest).toBe(v.expected.rollbackDigest)
        expect(d.bundleDigest).toBe(v.expected.bundleDigest)
        expect(d.sourceDigest).toBe(v.expected.sourceDigest)
      }
    })
  }

  it('keeps every sameDigestsAs relation', () => {
    const byId = new Map(vectors.map((v) => [v.id, v]))
    const related = vectors.filter((v) => v.sameDigestsAs !== undefined)
    expect(related.length).toBeGreaterThan(10)
    for (const v of related) {
      const other = byId.get(v.sameDigestsAs ?? '')
      expect(other?.expected?.checksum, v.id).toBe(v.expected?.checksum)
      expect(other?.expected?.bundleDigest, v.id).toBe(v.expected?.bundleDigest)
    }
  })
})

const LedgerVectorSchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  entries: z.array(
    z.strictObject({ migrationId: z.string(), checksum: z.string(), reverted: z.boolean() }),
  ),
  baselineId: z.string().nullable(),
  expected: z.strictObject({ hashInput: z.string(), ledgerStateHash: z.string() }).optional(),
  expectedError: z.string().optional(),
})

describe('ls1 ledger state hash (tooling/golden/ls1.json)', () => {
  const { vectors } = loadGolden('ls1.json', z.object({ vectors: z.array(LedgerVectorSchema) }))
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const result = ledgerStateHash(v.entries, v.baselineId)
      if (v.expectedError !== undefined) {
        expect(result.ok ? 'ok' : result.error.code).toBe(v.expectedError)
      } else {
        expect(result).toEqual({
          ok: true,
          value: { hash: v.expected?.ledgerStateHash, hashInput: v.expected?.hashInput },
        })
      }
    })
  }
})
