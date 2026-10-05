import { describe, expect, it } from 'vitest'
import { computeBundleDigests, parseStrictYaml, validateBundle } from '../src/format/index.ts'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const MANIFEST = `schema: exponetdb.migration/v1          # required, exact string
id: 01JB2Z6G8M4Q7R9T1V3W5X7Y9Z
name: add-lead-index
description: |
  Adds a partial index on leads(tenant_id, created_at) for the inbox query.

dependsOn:
  - 01JB2YX7M3K5N7Q9S1V3W5Y7A9
  - baseline:reosa-platform-2026-11

execution:
  transactional: true
  lockTimeout: 5s
  statementTimeout: 10m
  role: owner
  searchPath: ["public"]

requires:
  postgres: ">=16 <19"
  extensions:
    - name: vector
      version: ">=0.7.0"
    - name: pg_trgm

compatibility:
  declared: additive

verification:
  expectations: auto
  runtimeChecks: verify.sql

rollback:
  script: down.sql
  safety: unsafe
  notes: |
    Drops the index. Safe; no data loss.

source:
  authors: ["dev@example.com"]
  ticket: "LIN-1234"
`
const DIR = '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_add-lead-index'
const files = (overrides: Record<string, string | undefined> = {}): Map<string, Uint8Array> => {
  const base: Record<string, string | undefined> = {
    'migration.yaml': MANIFEST,
    'up.sql': 'CREATE INDEX leads_inbox_idx ON public.leads (tenant_id, created_at);\n',
    'verify.sql':
      "SELECT count(*) = 1 AS ok FROM pg_catalog.pg_indexes WHERE indexname = 'leads_inbox_idx';\n",
    'down.sql': 'DROP INDEX public.leads_inbox_idx;\n',
    ...overrides,
  }
  return new Map(
    Object.entries(base).flatMap(([k, v]) => (v === undefined ? [] : [[k, utf8(v)] as const])),
  )
}
const defaults = {
  lockTimeout: '5s',
  statementTimeout: '15m',
  role: 'owner',
  searchPath: ['public'],
}
const reason = (r: ReturnType<typeof validateBundle>): string =>
  r.ok ? 'ok' : r.error.code === 'MIGRATION_BUNDLE_INVALID' ? r.error.details.reason : r.error.code

describe('strict YAML', () => {
  it('parses the documented example manifest', () => {
    const parsed = parseStrictYaml(MANIFEST)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        id: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
        execution: { transactional: true, lockTimeout: '5s' },
      })
    }
  })

  it('refuses aliases, anchors, tags, duplicate keys and several documents', () => {
    expect(parseStrictYaml('a: &x 1\nb: *x\n')).toMatchObject({ ok: false })
    expect(parseStrictYaml('a: !!binary aGk=\n')).toMatchObject({
      ok: false,
      error: { code: 'yaml_tag' },
    })
    expect(parseStrictYaml('a: 1\na: 2\n')).toMatchObject({
      ok: false,
      error: { code: 'yaml_syntax' },
    })
    expect(parseStrictYaml('a: 1\n---\nb: 2\n')).toMatchObject({
      ok: false,
      error: { code: 'yaml_multiple_documents' },
    })
    expect(parseStrictYaml('base: &b {x: 1}\nother:\n  <<: *b\n')).toMatchObject({ ok: false })
  })

  it('uses the YAML 1.2 core schema (yes and on stay strings)', () => {
    expect(parseStrictYaml('a: yes\nb: on\nc: true\n')).toEqual({
      ok: true,
      value: { a: 'yes', b: 'on', c: true },
    })
  })
})

describe('bundle validation', () => {
  it('accepts the reference bundle and returns its digests', () => {
    const result = validateBundle({ directory: DIR, files: files(), projectDefaults: defaults })
    expect(reason(result)).toBe('ok')
    if (result.ok) {
      expect(result.value.digests.checksum).toMatch(/^sha256:c1:[0-9a-f]{64}$/)
      expect(result.value.digests.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(result.value.digests.canonicalManifest).toMatchObject({
        execution: { lockTimeout: 5000, statementTimeout: 600000 },
      })
    }
  })

  it('is deterministic and independent of line endings', () => {
    const a = validateBundle({ directory: DIR, files: files(), projectDefaults: defaults })
    const b = validateBundle({
      directory: DIR,
      files: files({
        'up.sql': 'CREATE INDEX leads_inbox_idx ON public.leads (tenant_id, created_at);\r\n',
        'migration.yaml': MANIFEST.replaceAll('\n', '\r\n'),
      }),
      projectDefaults: defaults,
    })
    expect(a.ok && b.ok && a.value.digests.checksum === b.value.digests.checksum).toBe(true)
  })

  const cases: [string, Parameters<typeof validateBundle>[0], string][] = [
    [
      'directory not <ULID>_<name>',
      { directory: 'add-lead-index', files: files(), projectDefaults: defaults },
      'invalid_directory_name',
    ],
    [
      'lowercase ULID directory',
      { directory: DIR.toLowerCase(), files: files(), projectDefaults: defaults },
      'invalid_directory_name',
    ],
    [
      'directory and manifest disagree',
      {
        directory: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_other-name',
        files: files(),
        projectDefaults: defaults,
      },
      'directory_mismatch',
    ],
    [
      'an extra helper file',
      {
        directory: DIR,
        files: new Map([...files(), ['helper.sql', utf8('')]]),
        projectDefaults: defaults,
      },
      'unexpected_file',
    ],
    [
      'missing up.sql',
      { directory: DIR, files: files({ 'up.sql': undefined }), projectDefaults: defaults },
      'missing_file',
    ],
    [
      'missing manifest',
      { directory: DIR, files: files({ 'migration.yaml': undefined }), projectDefaults: defaults },
      'missing_file',
    ],
    [
      'verify.sql without runtimeChecks',
      {
        directory: DIR,
        files: files({
          'migration.yaml': MANIFEST.replace('runtimeChecks: verify.sql', 'runtimeChecks: none'),
        }),
        projectDefaults: defaults,
      },
      'verify_file_mismatch',
    ],
    [
      'runtimeChecks without verify.sql',
      { directory: DIR, files: files({ 'verify.sql': undefined }), projectDefaults: defaults },
      'verify_file_mismatch',
    ],
    [
      'down.sql without a rollback script',
      {
        directory: DIR,
        files: files({ 'migration.yaml': MANIFEST.replace(/rollback:[\s\S]*?source:/, 'source:') }),
        projectDefaults: defaults,
      },
      'rollback_file_mismatch',
    ],
    [
      'empty up.sql',
      { directory: DIR, files: files({ 'up.sql': ' \n\t' }), projectDefaults: defaults },
      'empty_migration',
    ],
    [
      'comments-only up.sql',
      {
        directory: DIR,
        files: files({ 'up.sql': '-- todo\n/* later */\n' }),
        projectDefaults: defaults,
      },
      'no_statements',
    ],
    [
      'manifest with a BOM',
      {
        directory: DIR,
        files: files({ 'migration.yaml': `﻿${MANIFEST}` }),
        projectDefaults: defaults,
      },
      'bom',
    ],
    [
      'up.sql with an unterminated string',
      { directory: DIR, files: files({ 'up.sql': "SELECT 'x" }), projectDefaults: defaults },
      'unterminated_string',
    ],
    [
      'up.sql over 4 MiB',
      {
        directory: DIR,
        files: files({ 'up.sql': `SELECT 1;${' '.repeat(4 * 1024 * 1024)}` }),
        projectDefaults: defaults,
      },
      'file_too_large',
    ],
    [
      'manifest typo (unknown key)',
      {
        directory: DIR,
        files: files({
          'migration.yaml': MANIFEST.replace('transactional: true', 'transactinal: true'),
        }),
        projectDefaults: defaults,
      },
      'MIGRATION_MANIFEST_INVALID',
    ],
    [
      'manifest with an alias',
      {
        directory: DIR,
        files: files({ 'migration.yaml': `${MANIFEST}x: &a 1\ny: *a\n` }),
        projectDefaults: defaults,
      },
      'MIGRATION_MANIFEST_INVALID',
    ],
    [
      'unresolved execution role',
      {
        directory: DIR,
        files: files({ 'migration.yaml': MANIFEST.replace('  role: owner\n', '') }),
        projectDefaults: { searchPath: ['public'] },
      },
      'MIGRATION_MANIFEST_INVALID',
    ],
  ]
  for (const [name, input, expected] of cases) {
    it(`refuses: ${name}`, () => {
      expect(reason(validateBundle(input))).toBe(expected)
    })
  }

  it('reports manifest issues as JSON Pointers', () => {
    const result = validateBundle({
      directory: DIR,
      files: files({
        'migration.yaml': MANIFEST.replace('transactional: true', 'transactional: "yes"'),
      }),
      projectDefaults: defaults,
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'MIGRATION_MANIFEST_INVALID',
        details: { errors: [{ path: '/execution/transactional' }] },
      },
    })
  })
})

describe('digest layer', () => {
  it('reports invalid project defaults before anything else', () => {
    const result = computeBundleDigests({
      manifest: {},
      projectDefaults: { lockTimeout: 'soon' },
      files: {},
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_duration' } })
  })
})
