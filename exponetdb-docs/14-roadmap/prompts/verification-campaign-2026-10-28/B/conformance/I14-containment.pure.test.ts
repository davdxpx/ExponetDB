// I14 Containment, loader / parser level: hostile bundle content must not exhaust the process that loads,
// lints or plans it, and must not reach outside the bundle. Measured in CHILD PROCESSES started the way
// production starts a role (node --liftoff-only), so memory and CPU are the process's own and a hang or a
// kill is a result. Budgets: the documented serve container is 512 MiB (deployment.md §2a); wall time of
// one bundle through c1 + analysis + lint must stay below 10 s (no documented value: see decisions-B2.md).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { BundleSubmissionSchema } from '@exponetdb/contracts'
import { enc, mk } from './lib/bundle.ts'
// The CLI's loader, from the checkout (it is the code that reads a bundle directory from disk).
import { readBundles, readProject } from '../../apps/cli/src/local/project.ts'
import { validateBundle } from '@exponetdb/migrations/format'

const here = dirname(fileURLToPath(import.meta.url))
const PROBE = join(here, 'tools', 'probe.ts')
const WALL_BUDGET_MS = 10_000
const RSS_BUDGET_MB = 512

interface Probe {
  case: string
  n: number
  bytes: number
  analysis?: string
  validate?: string
  lint?: { rules: string[]; valid: boolean }
  threw?: string
  wallMs: number
  cpuMs: number
  maxRssMb: number
  ms?: Record<string, number>
}

function probe(name: string, n: number, timeoutMs = 120_000): Probe | { timeout: true; case: string; n: number } {
  const r = spawnSync(process.env['B2_NODE'] ?? 'node', ['--liftoff-only', '--conditions=@exponetdb/source', PROBE, name, String(n)], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (r.error !== undefined || r.status === null) return { timeout: true, case: name, n }
  const line = r.stdout.trim().split('\n').at(-1) ?? '{}'
  return JSON.parse(line) as Probe
}

describe('I14 hostile SQL content: wall time and memory of one bundle through c1 + analysis + lint', () => {
  // [case, n, description]; sizes stay inside the documented 4 MiB per file
  const CASES: [string, number, string][] = [
    ['parens', 4_000, 'nested parentheses below the WebAssembly stack'],
    ['parens', 100_000, 'nested parentheses beyond every stack (200 KB)'],
    ['brackets', 100_000, 'nested ARRAY[ ] (700 KB)'],
    ['subselects', 20_000, 'nested sub-selects'],
    ['case-nesting', 30_000, 'nested CASE'],
    ['concat-chain', 400_000, 'a 2.8 MB concatenation chain'],
    ['tiny-statements', 66_000, 'just below the 200,000-token bound (SELECT 1; x 66,000)'],
    ['tiny-statements', 500_000, '100,000+ tiny statements, 5 MB (above the 4 MiB file limit)'],
    ['comment-statements', 28_000, 'COMMENT x 28,000: dense statements near the token bound'],
    ['dollar-tags', 28_000, 'DO $tN$ ... x 28,000 distinct dollar tags'],
    ['long-string', 4_000_000, 'a 4 MB string literal'],
    ['long-ident', 4_000_000, 'a 4 MB quoted identifier'],
    ['dollar-long-tag', 1_000_000, 'a 1 MB dollar-quote tag'],
    ['many-semicolons', 4_000_000, '4 million semicolons'],
    ['unterminated-string', 4_000_000, 'an unterminated 4 MB string'],
    ['whitespace', 4_000_000, '4 MB of whitespace'],
    ['line-comment', 4_000_000, 'a 4 MB line comment'],
    ['unicode-ident', 1_000_000, 'a 4 MB identifier of astral characters'],
    ['do-body-statements', 60_000, 'a DO body with 60,000 PERFORM'],
    ['in-list', 300_000, 'an IN list of 300,000 numbers'],
    ['columns', 5_000, '5,000 columns'],
    ['nested-comments', 5_000, 'nested block comments, depth 5,000 (20 KB)'],
    ['nested-comments', 40_000, 'nested block comments, depth 40,000 (160 KB, 4 % of the file limit)'],
    ['unterminated-nested-comments', 40_000, 'unterminated nested block comments, depth 40,000'],
  ]
  for (const [name, n, what] of CASES) {
    test(`${name} ${n}: ${what}`, () => {
      const r = probe(name, n)
      if ('timeout' in r) throw new Error(`${name} ${n}: the process did not finish in 120 s (or was killed)`)
      expect(r.threw, `${name} ${n} threw`).toBeUndefined()
      expect(r.maxRssMb, `${name} ${n}: peak RSS ${r.maxRssMb} MiB (budget ${RSS_BUDGET_MB})`).toBeLessThanOrEqual(RSS_BUDGET_MB)
      expect(r.wallMs, `${name} ${n}: ${r.wallMs} ms (budget ${WALL_BUDGET_MS}); ${JSON.stringify(r.ms)}`).toBeLessThanOrEqual(WALL_BUDGET_MS)
    })
  }

  test('quadratic scaling of the PostgreSQL scanner on nested comments: doubling the depth must not quadruple the time', () => {
    const a = probe('nested-comments', 10_000)
    const b = probe('nested-comments', 20_000)
    if ('timeout' in a || 'timeout' in b) throw new Error('probe did not finish')
    const ta = (a.ms?.['analysis'] ?? 1) + 1
    const tb = (b.ms?.['analysis'] ?? 1) + 1
    expect(tb / ta, `analysis ${ta} ms -> ${tb} ms for twice the depth`).toBeLessThan(3)
  })
})

describe('I14 memory per REQUEST (not per parse): several dense bundles in one lint', () => {
  // 66,000 x "SELECT 1;" = 198,000 tokens = 660 KB per bundle: valid SQL under every documented limit
  // (4 MiB per file, 200,000 tokens per parse, 50 bundles and 32 MiB per request).
  // The heap limit is the one deployment.md section 2a derives for the documented 512 MiB container (259 MiB).
  for (const k of [3, 6]) {
    test(`${k} dense bundles (${(k * 0.66).toFixed(1)} MB) in one lint request: no V8 out-of-memory, peak RSS within 512 MiB`, () => {
      const r = spawnSync(
        process.env['B2_NODE'] ?? 'node',
        ['--liftoff-only', '--max-old-space-size=259', '--conditions=@exponetdb/source', join(here, 'tools', 'densescale.ts'), String(k)],
        { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      )
      expect(r.status, `exit ${r.status} (134 = V8 fatal out of memory): ${(r.stderr || '').split('\n').find((l) => /heap|memory|FATAL/i.test(l)) ?? ''}`).toBe(0)
      const line = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { rssMb: number }
      expect(line.rssMb, `peak RSS ${line.rssMb} MiB for ${k} dense bundles`).toBeLessThanOrEqual(RSS_BUDGET_MB)
    }, 200_000)
  }
})

describe('I14 manifest (migration.yaml, at most 64 KiB): hostile YAML', () => {
  const YAML_CASES: [string, number, string][] = [
    ['yaml-flow-depth', 30_000, '30,000 nested flow sequences'],
    ['yaml-flow-depth', 1_000, '1,000 nested flow sequences'],
    ['yaml-map-depth', 10_000, '10,000 nested flow mappings'],
    ['yaml-alias-bomb', 9, 'alias bomb (billion laughs), nine levels'],
    ['yaml-many-keys', 5_000, '5,000 keys'],
    ['yaml-long-scalar', 60_000, 'a 60,000-character scalar'],
    ['yaml-many-docs', 10_000, '10,000 documents'],
  ]
  for (const [name, n, what] of YAML_CASES) {
    test(`${name} ${n}: ${what} is refused fast, never thrown`, () => {
      const r = probe(name, n)
      if ('timeout' in r) throw new Error('probe did not finish')
      expect(r.threw, `${name}: ${r.threw}`).toBeUndefined()
      expect(r.validate, JSON.stringify(r)).toMatch(/MIGRATION_(MANIFEST|BUNDLE)_INVALID/)
      expect(r.wallMs).toBeLessThanOrEqual(WALL_BUDGET_MS)
      expect(r.maxRssMb).toBeLessThanOrEqual(RSS_BUDGET_MB)
    })
  }
  test('depth 1,000 is refused with a NAMED limit, not with "Maximum call stack size exceeded"', () => {
    const r = probe('yaml-flow-depth', 1_000)
    if ('timeout' in r) throw new Error('probe did not finish')
    expect(r.validate ?? '', 'the stack overflow of the YAML library leaks into the error text').not.toMatch(/call stack/i)
  })
})

// ---------- the loader: reading a bundle directory from disk ----------
const root = mkdtempSync(join(tmpdir(), 'b2-i14-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const PROJECT_YAML = [
  'schema: exponetdb.project/v1',
  'project: conformance/project',
  'layout: bundles',
  'defaults:',
  '  role: owner',
  '  searchPath: [public]',
  'executionRoles:',
  '  owner: conformance_owner',
  'managedScope:',
  '  includeSchemas: [public]',
  '  excludeSchemas: []',
  'lintProfile: strict',
  '',
].join('\n')

const ID = '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
function makeProject(label: string): { dir: string; bundle: string } {
  const dir = join(root, label)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'exponetdb.project.yaml'), PROJECT_YAML)
  const b = mk({ id: ID, name: 'change', up: 'CREATE TABLE public.t (i int);\n' })
  const bundle = join(dir, b.directory)
  mkdirSync(bundle)
  for (const [name, bytes] of b.files) writeFileSync(join(bundle, name), bytes)
  return { dir, bundle }
}

async function load(dir: string) {
  const project = await readProject(join(dir, 'exponetdb.project.yaml'))
  return readBundles(project)
}

describe('I14 the CLI loader (apps/cli/src/local/project.ts) on a hostile directory', () => {
  test('a clean bundle loads and validates', async () => {
    const { dir } = makeProject('clean')
    const bundles = await load(dir)
    expect(bundles).toHaveLength(1)
    expect(validateBundle((bundles[0] as { input: never }).input).ok).toBe(true)
  })

  test('a symbolic link in place of up.sql is refused as a link (never followed, never reported as an empty file)', async () => {
    const { dir, bundle } = makeProject('symlink-up')
    rmSync(join(bundle, 'up.sql'))
    writeFileSync(join(dir, 'secret.txt'), 'SELECT 1;')
    symlinkSync(join(dir, 'secret.txt'), join(bundle, 'up.sql'))
    const [b] = await load(dir)
    const r = validateBundle((b as { input: never }).input)
    expect(r.ok).toBe(false)
    // The honest refusal names the link; "empty_migration" would send the author looking for an empty file.
    expect(JSON.stringify(r), 'refusal for a symlinked up.sql').toMatch(/symlink|link|unexpected/i)
  })

  test('a symbolic link in place of verify.sql must not turn into a silently accepted empty verify.sql', async () => {
    const { dir, bundle } = makeProject('symlink-verify')
    const b0 = mk({ id: ID, name: 'change', up: 'CREATE TABLE public.t (i int);\n', verify: 'SELECT true AS ok;\n' })
    writeFileSync(join(bundle, 'migration.yaml'), b0.files.get('migration.yaml') as Uint8Array)
    writeFileSync(join(dir, 'v.sql'), 'SELECT true AS ok;')
    symlinkSync(join(dir, 'v.sql'), join(bundle, 'verify.sql'))
    const [b] = await load(dir)
    const r = validateBundle((b as { input: never }).input)
    expect(r.ok, 'a link loaded as an EMPTY verify.sql validates').toBe(false)
  })

  test('a symlink to /dev/zero or a FIFO named up.sql never blocks the loader', async () => {
    const { dir, bundle } = makeProject('device')
    rmSync(join(bundle, 'up.sql'))
    symlinkSync('/dev/zero', join(bundle, 'up.sql'))
    const t0 = Date.now()
    await load(dir)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  test('a directory in place of up.sql is not read as a file', async () => {
    const { dir, bundle } = makeProject('dir-up')
    rmSync(join(bundle, 'up.sql'))
    mkdirSync(join(bundle, 'up.sql'))
    const [b] = await load(dir)
    const r = validateBundle((b as { input: never }).input)
    expect(r.ok).toBe(false)
  })

  test('a symlinked bundle directory is refused and named (links are not followed)', async () => {
    const { dir } = makeProject('symlink-dir')
    symlinkSync(join(dir, `${ID}_change`), join(dir, '01JB2Z6G8M4Q7R9T1V3W5X7YA0_other'))
    await expect(load(dir)).rejects.toThrow(/not a directory|links are not followed/)
  })

  test('an extra file in a bundle directory is refused (no hidden includes)', async () => {
    const { dir, bundle } = makeProject('extra')
    writeFileSync(join(bundle, 'helper.sql'), 'SELECT 1;')
    const [b] = await load(dir)
    expect(JSON.stringify(validateBundle((b as { input: never }).input))).toMatch(/unexpected_file/)
  })

  test('directory names that merely look like bundles are ignored or refused, never traversed', async () => {
    const { dir } = makeProject('names')
    for (const n of ['..%2f..%2fetc', '01jb2z6g8m4q7r9t1v3w5x7y9z_lower', `${ID}_UPPER`, `${ID}_a b`, `${ID}_аbc`, `${ID}_${'a'.repeat(70)}`]) {
      mkdirSync(join(dir, n), { recursive: true })
    }
    const bundles = await load(dir)
    // The loader only filters by pattern; the shared validation refuses what is not a bundle. Nothing outside the
    // root is ever opened, and only the real bundle validates.
    const valid = bundles.filter((b) => validateBundle(b.input).ok).map((b) => b.directory)
    expect(valid).toEqual([`${ID}_change`])
    for (const b of bundles) expect(b.path.startsWith(join(dir)), b.path).toBe(true)
  })

  test('a 512 MiB up.sql is rejected without being read whole into memory (the documented limit is 4 MiB)', async () => {
    const { dir, bundle } = makeProject('giant')
    const p = join(bundle, 'up.sql')
    writeFileSync(p, '')
    truncateSync(p, 512 * 1024 * 1024) // a sparse file: costs no disk
    const before = process.memoryUsage().rss
    const bundles = await load(dir)
    const grown = (process.memoryUsage().rss - before) / 1048576
    const r = validateBundle((bundles[0] as { input: never }).input)
    expect(JSON.stringify(r)).toMatch(/file_too_large/)
    // The loader's own comment says "an oversized file is read only up to the limit + 1 byte".
    expect(grown, `RSS grew by ${Math.round(grown)} MiB while loading a 512 MiB file`).toBeLessThan(64)
  }, 120_000)
})

describe('I14 submissions over the wire (REST / MCP): names and paths are data, never paths', () => {
  const base = { directory: `${ID}_change`, files: { 'migration.yaml': 'x', 'up.sql': 'SELECT 1;' } }
  test.each([
    ['traversal in the directory', { ...base, directory: `../${ID}_change` }],
    ['absolute path', { ...base, directory: `/etc/${ID}_change` }],
    ['backslash path', { ...base, directory: `..\\${ID}_change` }],
    ['slash in the name', { ...base, directory: `${ID}_a/b` }],
    ['NUL in the name', { ...base, directory: `${ID}_a\u0000b` }],
    ['newline at the end', { ...base, directory: `${ID}_change\n` }],
    ['directory 92 characters', { ...base, directory: `${ID}_${'a'.repeat(65)}` }],
    ['unknown file key', { ...base, files: { ...base.files, 'extra.sql': 'x' } }],
    ['traversal as a file key', { ...base, files: { ...base.files, '../up.sql': 'x' } }],
    ['upper-case file key', { ...base, files: { 'MIGRATION.YAML': 'x', 'up.sql': 'x' } }],
    ['missing up.sql', { ...base, files: { 'migration.yaml': 'x' } }],
    ['file as array', { ...base, files: { ...base.files, 'up.sql': ['x'] } }],
    ['extra top-level member', { ...base, extra: 1 }],
  ])('%s is refused by the schema', (_name, body) => {
    expect(BundleSubmissionSchema.safeParse(body).success).toBe(false)
  })
  test('a clean submission passes', () => {
    expect(BundleSubmissionSchema.safeParse(base).success).toBe(true)
  })
  test('__proto__ / constructor members cannot pollute a submission', () => {
    const body = JSON.parse(`{"directory":"${ID}_change","files":{"migration.yaml":"x","up.sql":"y","__proto__":{"polluted":true}}}`)
    expect(BundleSubmissionSchema.safeParse(body).success).toBe(false)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
  test('names with Unicode look-alikes in identifiers: the directory pattern is ASCII only', () => {
    for (const d of [`${ID}_café`, `${ID}_а`, `${ID}_ａ`, `${ID}_a​`]) {
      expect(BundleSubmissionSchema.safeParse({ ...base, directory: d }).success, d).toBe(false)
    }
  })
  test('validateBundle never throws on hostile file maps', () => {
    const weird = new Map<string, Uint8Array>([['migration.yaml', enc('x')], ['up.sql', enc('x')], ['__proto__', enc('x')], ['constructor', enc('x')]])
    expect(() => validateBundle({ directory: `${ID}_change`, files: weird, projectDefaults: {} })).not.toThrow()
  })
})
