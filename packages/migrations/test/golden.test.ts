import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  computeBundleDigests,
  executableText,
  ledgerStateHash,
  legacyDigests,
} from '../src/format/index.ts'
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
  /** Raw bytes a JSON string cannot hold (invalid UTF-8), as lowercase hex. */
  filesHex: z.record(z.string(), z.string().regex(/^(?:[0-9a-f]{2})*$/)).optional(),
  expected: z
    .strictObject({
      applyProjection: z.string(),
      verifyProjection: z.string(),
      rollbackProjection: z.string(),
      executableText: z.record(z.string(), z.string().nullable()),
      verifySource: z.string().nullable(),
      checksum: z.string(),
      verifyDigest: z.string(),
      rollbackDigest: z.string(),
      bundleDigest: z.string(),
      sourceDigest: z.string(),
    })
    .optional(),
  expectedError: z.strictObject({ code: z.string(), file: z.string().optional() }).optional(),
  sameDigestsAs: z.string().optional(),
  compareWith: z
    .strictObject({
      id: z.string(),
      same: z.array(z.string()),
      different: z.array(z.string()),
    })
    .optional(),
})

type BundleVector = z.infer<typeof BundleVectorSchema>

/** The bundle files of a vector: `files` as UTF-8, `filesHex` as raw bytes. */
function filesOf(v: BundleVector): {
  'up.sql'?: Uint8Array
  'verify.sql'?: Uint8Array
  'down.sql'?: Uint8Array
} {
  const files: { 'up.sql'?: Uint8Array; 'verify.sql'?: Uint8Array; 'down.sql'?: Uint8Array } = {}
  for (const name of ['up.sql', 'verify.sql', 'down.sql'] as const) {
    const text = v.files[name]
    const raw = v.filesHex?.[name]
    if (text !== undefined && raw !== undefined) {
      throw new Error(`${v.id}: ${name} is in both files and filesHex`)
    }
    if (text !== undefined) {
      files[name] = utf8(text)
    } else if (raw !== undefined) {
      files[name] = hex(raw)
    }
  }
  return files
}

const DIGEST_NAMES = [
  'bundleDigest',
  'checksum',
  'rollbackDigest',
  'sourceDigest',
  'verifyDigest',
] as const
type DigestName = (typeof DIGEST_NAMES)[number]
const isDigestName = (name: string): name is DigestName =>
  DIGEST_NAMES.some((known) => known === name)

describe('c1 digests (tooling/golden/c1-bundles.json)', () => {
  const { vectors } = loadGolden(
    'c1-bundles.json',
    z.object({ vectors: z.array(BundleVectorSchema) }),
  )
  for (const v of vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const result = computeBundleDigests({
        manifest: v.manifest,
        projectDefaults: v.projectDefaults,
        files: filesOf(v),
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
        expect(d.verifySource).toBe(v.expected.verifySource)
        expect(d.checksum).toBe(v.expected.checksum)
        expect(d.verifyDigest).toBe(v.expected.verifyDigest)
        expect(d.rollbackDigest).toBe(v.expected.rollbackDigest)
        expect(d.bundleDigest).toBe(v.expected.bundleDigest)
        expect(d.sourceDigest).toBe(v.expected.sourceDigest)
      }
    })
  }

  it('keeps every compareWith relation, as stated and as computed', () => {
    const byId = new Map(vectors.map((v) => [v.id, v]))
    const computed = (id: string) => {
      const v = byId.get(id)
      if (v === undefined) {
        throw new Error(`unknown vector ${id}`)
      }
      const result = computeBundleDigests({
        manifest: v.manifest,
        projectDefaults: v.projectDefaults,
        files: filesOf(v),
      })
      if (!result.ok || v.expected === undefined) {
        throw new Error(`${id} is not a success vector`)
      }
      return { computed: result.value, stated: v.expected }
    }
    const related = vectors.filter((v) => v.compareWith !== undefined)
    expect(related.length).toBeGreaterThan(5)
    for (const v of related) {
      const spec = v.compareWith
      if (spec === undefined) {
        continue
      }
      const names = [...spec.same, ...spec.different].sort()
      expect(names, v.id).toEqual([...DIGEST_NAMES])
      const a = computed(v.id)
      const b = computed(spec.id)
      for (const [list, equal] of [
        [spec.same, true],
        [spec.different, false],
      ] as const) {
        for (const name of list) {
          if (!isDigestName(name)) {
            throw new Error(`${v.id}: unknown digest ${name}`)
          }
          expect(a.computed[name] === b.computed[name], `${v.id} ${name} computed`).toBe(equal)
          expect(a.stated[name] === b.stated[name], `${v.id} ${name} stated`).toBe(equal)
        }
      }
    }
  })

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

describe('legacy file checksum (tooling/golden/legacy-checksum.json)', () => {
  const { vectors } = loadGolden(
    'legacy-checksum.json',
    z.object({
      vectors: z.array(
        z.object({
          id: z.string(),
          input: z.string(),
          expected: z.object({
            checksum: z.string(),
            sourceDigest: z.string(),
            bytesDigest: z.string(),
            executableText: z.string(),
          }),
        }),
      ),
    }),
  )
  for (const v of vectors) {
    it(v.id, () => {
      const d = legacyDigests(new TextEncoder().encode(v.input))
      expect(d.ok && d.value).toEqual(v.expected)
    })
  }
  it('ignores comment edits, never executable changes', () => {
    const a = legacyDigests(new TextEncoder().encode('CREATE TABLE t (id int);\n'))
    const b = legacyDigests(new TextEncoder().encode('-- edited\nCREATE TABLE t (id int);\n'))
    const c = legacyDigests(new TextEncoder().encode('CREATE TABLE t (id bigint);\n'))
    expect(a.ok && b.ok && a.value.checksum === b.value.checksum).toBe(true)
    expect(a.ok && c.ok && a.value.checksum === c.value.checksum).toBe(false)
  })
})
