// I15 Limits are announced: every limit (size, count, depth, time) has a named error and a documented value.
// For each limit found in code the boundary is hit twice: AT the limit (accepted) and ONE PAST it (refused with
// the named error). The expected value is the DOCUMENTED value; where the code differs, or the documentation is
// silent, the test says so in its title ("UNDOCUMENTED") and pins the code's value (see RESULTS.md and
// decisions-B2.md for the list).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BUNDLE_FILE_LIMITS, BundleSubmissionSchema, MIGRATION_REQUEST_LIMITS, MigrationPlanRequestSchema, parseDurationMs } from '@exponetdb/contracts'
import { validateBundle } from '@exponetdb/migrations/format'
import { prepareLint } from '@exponetdb/migrations/lint'
import { analyzeMigrationSql, loadParser, MAX_MIGRATION_PARSE_BYTES, MAX_PARSE_BYTES, MAX_PARSE_TOKENS } from '@exponetdb/postgres/parser'
import { enc, lint, manifestYaml, mk, ulidOf } from './lib/bundle.ts'
import { readBundles, readProject } from '../../apps/cli/src/local/project.ts'

beforeAll(async () => {
  await loadParser(17)
  await prepareLint(17)
})

const ID = ulidOf(1)
const pad = (bytes: number, head = ''): Uint8Array => {
  // a valid prefix, then a line comment padded with 'x' to the exact byte length
  const prefix = enc(head)
  const rest = bytes - prefix.length
  if (rest < 0) throw new Error('pad: too short')
  const out = new Uint8Array(bytes)
  out.set(prefix)
  out.fill(0x78, prefix.length)
  return out
}
const sqlOfSize = (bytes: number): Uint8Array => {
  const head = 'CREATE TABLE public.t (i int);\n--'
  const out = pad(bytes, head)
  return out
}
function reason(r: ReturnType<typeof validateBundle>): string {
  if (r.ok) return 'ok'
  const e = r.error as { code: string; details: { reason?: string; errors?: { code: string; path: string }[] } }
  return e.details.reason ?? `${e.code}:${e.details.errors?.map((x) => `${x.path}:${x.code}`).join(',')}`
}

describe('I15 file sizes (documented: migration-bundles.md §1; code: BUNDLE_FILE_LIMITS)', () => {
  test('code values equal the documented values (64 KiB, 4 MiB, 512 KiB, 4 MiB)', () => {
    expect(BUNDLE_FILE_LIMITS).toEqual({ 'migration.yaml': 64 * 1024, 'up.sql': 4 * 1024 * 1024, 'verify.sql': 512 * 1024, 'down.sql': 4 * 1024 * 1024 })
  })
  test('up.sql: 4 MiB is accepted by the format layer, 4 MiB + 1 is MIGRATION_BUNDLE_INVALID file_too_large', () => {
    expect(reason(validateBundle(mk({ up: sqlOfSize(4 * 1024 * 1024) })))).toBe('ok')
    const over = validateBundle(mk({ up: sqlOfSize(4 * 1024 * 1024 + 1) }))
    expect(reason(over)).toBe('file_too_large')
    expect(JSON.stringify(over)).toContain('"file":"up.sql"')
  })
  test('up.sql: the limit counts BYTES (a 2-byte character counts twice)', () => {
    const half = 'CREATE TABLE public.t (i int);\n-- ' + '\u00e9'.repeat((4 * 1024 * 1024 - 34) / 2)
    expect(enc(half).length).toBe(4 * 1024 * 1024)
    expect(reason(validateBundle(mk({ up: half })))).toBe('ok')
    expect(reason(validateBundle(mk({ up: half + 'é' })))).toBe('file_too_large')
  })
  test('verify.sql: 512 KiB / +1', () => {
    const v = (n: number) => pad(n, '-- check: a\nSELECT true AS ok;\n--')
    expect(reason(validateBundle(mk({ up: 'CREATE TABLE public.t (i int);', verify: v(512 * 1024) })))).toBe('ok')
    const over = validateBundle(mk({ up: 'CREATE TABLE public.t (i int);', verify: v(512 * 1024 + 1) }))
    expect(reason(over)).toBe('file_too_large')
    expect(JSON.stringify(over)).toContain('"file":"verify.sql"')
  })
  test('down.sql: 4 MiB / +1', () => {
    const d = (n: number) => pad(n, 'DROP TABLE public.t;\n--')
    expect(reason(validateBundle(mk({ up: 'CREATE TABLE public.t (i int);', down: d(4 * 1024 * 1024) })))).toBe('ok')
    expect(reason(validateBundle(mk({ up: 'CREATE TABLE public.t (i int);', down: d(4 * 1024 * 1024 + 1) })))).toBe('file_too_large')
  })
  test('migration.yaml: 64 KiB / +1 (padded with a YAML comment)', () => {
    const y = manifestYaml({}, ID, 'change')
    const yaml = (n: number) => { const head = y + '#'; return pad(n, head) }
    expect(reason(validateBundle(mk({ yaml: yaml(64 * 1024) })))).toBe('ok')
    expect(reason(validateBundle(mk({ yaml: yaml(64 * 1024 + 1) })))).toBe('file_too_large')
  })
  test('the same limits hold on the wire: BundleSubmissionSchema refuses a file one byte over (UTF-8 bytes, not characters)', () => {
    const files = (up: string) => ({ directory: `${ID}_change`, files: { 'migration.yaml': 'x', 'up.sql': up } })
    expect(BundleSubmissionSchema.safeParse(files('a'.repeat(4 * 1024 * 1024))).success).toBe(true)
    expect(BundleSubmissionSchema.safeParse(files('a'.repeat(4 * 1024 * 1024 + 1))).success).toBe(false)
    expect(BundleSubmissionSchema.safeParse(files('é'.repeat(2 * 1024 * 1024 + 1))).success).toBe(false)
  })
})

describe('I15 names, counts and lengths in the manifest', () => {
  const withManifest = (mut: (m: Record<string, unknown>) => void, id = ID, name = 'change') => {
    const base = JSON.parse(JSON.stringify({
      schema: 'exponetdb.migration/v1', id, name, description: 'd', dependsOn: [],
      execution: { transactional: true }, compatibility: { declared: 'additive' },
      verification: { expectations: 'auto', runtimeChecks: 'none' },
    })) as Record<string, unknown>
    mut(base)
    return validateBundle(mk({ id, name, yaml: JSON.stringify(base) }))
  }
  test('directory name: 91 characters ok, 92 invalid_directory_name; slug 64 ok, 65 refused', () => {
    const s64 = 'a'.repeat(64)
    expect(reason(withManifest(() => undefined, ID, s64))).toBe('ok')
    expect(reason(validateBundle(mk({ id: ID, name: 'a'.repeat(65) })))).toMatch(/invalid_directory_name|manifest/)
  })
  test('description: 2000 code points ok, 2001 refused; astral characters count once', () => {
    expect(reason(withManifest((m) => { m['description'] = '\u{1F600}'.repeat(2000) }))).toBe('ok')
    expect(reason(withManifest((m) => { m['description'] = 'a'.repeat(2001) }))).toMatch(/MIGRATION_MANIFEST_INVALID/)
    expect(reason(withManifest((m) => { m['description'] = '' }))).toMatch(/MIGRATION_MANIFEST_INVALID/)
  })
  test('UNDOCUMENTED dependsOn: 1000 entries ok, 1001 refused with too_big (migration-bundles.md names no maximum)', () => {
    const deps = (n: number) => Array.from({ length: n }, (_, i) => ulidOf(10_000 + i))
    expect(reason(withManifest((m) => { m['dependsOn'] = deps(1000) }))).toBe('ok')
    expect(reason(withManifest((m) => { m['dependsOn'] = deps(1001) }))).toContain('too_big')
  })
  test('UNDOCUMENTED counts: extensions 64, searchPath 32, authors 32 / 320 chars, ticket 200', () => {
    const ext = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `ext${i}` }))
    expect(reason(withManifest((m) => { m['requires'] = { extensions: ext(64) } }))).toBe('ok')
    expect(reason(withManifest((m) => { m['requires'] = { extensions: ext(65) } }))).toContain('too_big')
    const sp = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
    expect(reason(withManifest((m) => { (m['execution'] as Record<string, unknown>)['searchPath'] = sp(32) }))).toBe('ok')
    expect(reason(withManifest((m) => { (m['execution'] as Record<string, unknown>)['searchPath'] = sp(33) }))).toContain('too_big')
    expect(reason(withManifest((m) => { m['source'] = { authors: Array.from({ length: 33 }, () => 'a') } }))).toContain('too_big')
    expect(reason(withManifest((m) => { m['source'] = { authors: ['a'.repeat(321)] } }))).toContain('too_big')
    expect(reason(withManifest((m) => { m['source'] = { ticket: 't'.repeat(201) } }))).toContain('too_big')
  })
  test('durations (documented §2): 1ms..6h, zero refused, 6h+1ms refused with duration_out_of_range, grammar errors are invalid_duration', () => {
    const t = (v: string) => reason(withManifest((m) => { (m['execution'] as Record<string, unknown>)['statementTimeout'] = v }))
    expect(t('1ms')).toBe('ok')
    expect(t('6h')).toBe('ok')
    expect(t('360m')).toBe('ok')
    expect(t('1h30m')).toBe('ok')
    expect(t('0ms')).toMatch(/MIGRATION_MANIFEST_INVALID/)
    expect(t('0s')).toMatch(/MIGRATION_MANIFEST_INVALID/)
    expect(t('6h1ms')).toMatch(/MIGRATION_MANIFEST_INVALID/)
    expect(t('21600001ms')).toMatch(/MIGRATION_MANIFEST_INVALID/)
    for (const bad of ['90 s', '1.5h', '01s', '-1s', '1d', 'PT1S', '1s1h', '']) expect(t(bad), bad).toMatch(/MIGRATION_MANIFEST_INVALID/)
    expect(parseDurationMs('6h')).toBe(21_600_000)
  })
  test('lockTimeout above 60 s is accepted by the schema and needs the long_lock_timeout acknowledgement (§2)', () => {
    const bundle = (v: string) => mk({ up: 'CREATE TABLE public.t (i int);', executionExtra: [`  lockTimeout: ${v}`] })
    expect(lint([bundle('60s')]).bundles[0]?.findings.map((f) => f.rule)).not.toContain('long_lock_timeout')
    expect(lint([bundle('61s')]).bundles[0]?.findings.map((f) => f.rule)).toContain('long_lock_timeout')
  })
})

describe('I15 request limits (code: MIGRATION_REQUEST_LIMITS; UNDOCUMENTED in 04-migrations, partly in legacy-import.md)', () => {
  const bundle = { directory: `${ID}_change`, files: { 'migration.yaml': 'x', 'up.sql': 'x' } }
  test('50 bundles per plan request, 51 refused', () => {
    expect(MIGRATION_REQUEST_LIMITS).toEqual({ bundles: 50, migrationIds: 200 })
    const req = (n: number) => ({ bundles: Array.from({ length: n }, () => bundle) })
    expect(MigrationPlanRequestSchema.safeParse(req(50)).success).toBe(true)
    expect(MigrationPlanRequestSchema.safeParse(req(51)).success).toBe(false)
  })
  test('200 migration ids per plan request, 201 refused', () => {
    const ids = (n: number) => ({ migrationIds: Array.from({ length: n }, (_, i) => ulidOf(i)) })
    expect(MigrationPlanRequestSchema.safeParse(ids(200)).success).toBe(true)
    expect(MigrationPlanRequestSchema.safeParse(ids(201)).success).toBe(false)
  })
  test('lockWaitSeconds 1..600 (documented default 30 s, at most 10 minutes)', () => {
    const r = (n: number) => MigrationPlanRequestSchema.safeParse({ migrationIds: [ID], lockWaitSeconds: n }).success
    expect([r(1), r(600), r(0), r(601)]).toEqual([true, true, false, false])
  })
})

describe('I15 parser budgets (documented in deployment.md §2a, not in migration-bundles.md)', () => {
  test('values: 200,000 tokens per parse, 4 MiB per migration file, 1 MiB for data reads and verify checks', () => {
    expect(MAX_PARSE_TOKENS).toBe(200_000)
    expect(MAX_MIGRATION_PARSE_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_PARSE_BYTES).toBe(1024 * 1024)
  })
  test('199,998 tokens (66,666 x "SELECT 1;") parse; 200,001 tokens (66,667 x) are refused as too_large', () => {
    const ok = analyzeMigrationSql(17, 'SELECT 1;'.repeat(66_666), { trustedExtensions: [] })
    expect(ok.ok).toBe(true)
    const over = analyzeMigrationSql(17, 'SELECT 1;'.repeat(66_667), { trustedExtensions: [] })
    expect(over.ok).toBe(false)
    expect(JSON.stringify(over)).toContain('too_large')
  })
  test('the token bound is announced as a NAMED code at lint/plan time: parse_error naming too_large', () => {
    const r = lint([mk({ up: 'SELECT 1;'.repeat(66_667) })])
    const f = r.bundles[0]?.findings.find((x) => x.rule === 'parse_error')
    expect(f, 'a parse_error finding').toBeDefined()
    // The documentation says "(parse_error, too_large)": the finding must say too_large, not "does not parse".
    expect(f?.message ?? '').toMatch(/too_large|token/i)
  })
  test('a file the documentation allows (4 MiB) but the token bound refuses is a published limit of migration-bundles.md §1', () => {
    // 1 MB of SELECT 1; is far below the 4 MiB documented in §1 and above the real limit: §1 must name the token bound.
    const bytes = 'SELECT 1;\n'.repeat(100_000).length
    expect(bytes).toBeLessThan(BUNDLE_FILE_LIMITS['up.sql'])
    const r = analyzeMigrationSql(17, 'SELECT 1;\n'.repeat(100_000), { trustedExtensions: [] })
    expect(r.ok).toBe(false)
  })
})

describe('I15 the CLI loader (apps/cli/src/local/project.ts)', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-i15-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const PROJECT_YAML = ['schema: exponetdb.project/v1', 'project: conformance/project', 'layout: bundles', 'executionRoles:', '  owner: conformance_owner', 'managedScope:', '  includeSchemas: [public]', '  excludeSchemas: []', 'lintProfile: strict', ''].join('\n')
  function project(count: number): string {
    const dir = join(root, `p${count}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'exponetdb.project.yaml'), PROJECT_YAML)
    for (let i = 0; i < count; i++) mkdirSync(join(dir, `${ulidOf(i)}_b${i}`))
    return join(dir, 'exponetdb.project.yaml')
  }
  test('UNDOCUMENTED: exactly 5,000 bundle directories load, 5,001 are refused with a message naming the limit', async () => {
    const ok = await readBundles(await readProject(project(5000)))
    expect(ok).toHaveLength(5000)
    await expect(readBundles(await readProject(project(5001)))).rejects.toThrow(/5000|5,000/)
  }, 120_000)
  test('project file: 64 KiB ok, +1 refused', async () => {
    const dir = join(root, 'pf')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'exponetdb.project.yaml')
    writeFileSync(f, PROJECT_YAML + '#'.repeat(64 * 1024 - PROJECT_YAML.length))
    await expect(readProject(f)).resolves.toBeDefined()
    writeFileSync(f, PROJECT_YAML + '#'.repeat(64 * 1024 - PROJECT_YAML.length + 1))
    await expect(readProject(f)).rejects.toThrow(/64 KiB/)
  })
})
