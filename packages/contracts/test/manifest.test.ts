import { describe, expect, it } from 'vitest'
import {
  BundleSubmissionSchema,
  MigrationManifestSchema,
  ProjectConfigSchema,
  parseDurationMs,
} from '../src/index.ts'

const manifest = {
  schema: 'exponetdb.migration/v1',
  id: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  name: 'add-lead-index',
  description: 'Adds a partial index.',
  dependsOn: ['01JB2YX7M3K5N7Q9S1V3W5Y7A9', 'baseline:reosa-platform-2026-11'],
  execution: {
    transactional: true,
    lockTimeout: '5s',
    statementTimeout: '10m',
    role: 'owner',
    searchPath: ['public'],
  },
  requires: {
    postgres: '>=16 <19',
    extensions: [{ name: 'vector', version: '>=0.7.0' }, { name: 'pg_trgm' }],
  },
  compatibility: { declared: 'additive' },
  verification: { expectations: 'auto', runtimeChecks: 'verify.sql' },
  rollback: { script: 'down.sql', safety: 'unsafe', notes: 'Drops the index.' },
  source: { authors: ['dev@example.com'], ticket: 'LIN-1234' },
}

const ok = (value: unknown): boolean => MigrationManifestSchema.safeParse(value).success
const withChange = (path: string[], value: unknown): Record<string, unknown> => {
  const copy = structuredClone(manifest) as Record<string, unknown>
  let node: Record<string, unknown> = copy
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string, unknown>
  }
  const last = path.at(-1) ?? ''
  if (value === undefined) {
    delete node[last]
  } else {
    node[last] = value
  }
  return copy
}

describe('exponetdb.migration/v1', () => {
  it('accepts the documented example (with a valid dependency ULID)', () => {
    expect(MigrationManifestSchema.safeParse(manifest)).toMatchObject({ success: true })
  })

  it('refuses unknown keys at every level, so typos cannot fall back to defaults', () => {
    expect(ok({ ...manifest, transactinal: false })).toBe(false)
    expect(ok(withChange(['execution', 'transactinal'], false))).toBe(false)
    expect(ok(withChange(['source', 'repository'], 'github.com/x/y'))).toBe(false)
  })

  it('validates the id as a canonical ULID and refuses prefixed or lowercase ids', () => {
    expect(ok({ ...manifest, id: manifest.id.toLowerCase() })).toBe(false)
    expect(ok({ ...manifest, id: `mig_${manifest.id}` })).toBe(false)
    expect(ok({ ...manifest, id: '01K6XQ4E9N8T3G5Y7Z2M' })).toBe(false)
  })

  it('validates name and description limits', () => {
    expect(ok({ ...manifest, name: 'Add_Index' })).toBe(false)
    expect(ok({ ...manifest, name: 'a'.repeat(65) })).toBe(false)
    expect(ok({ ...manifest, name: 'a'.repeat(64) })).toBe(true)
    expect(ok({ ...manifest, description: '' })).toBe(false)
    expect(ok({ ...manifest, description: '😀'.repeat(2000) })).toBe(true)
    expect(ok({ ...manifest, description: '😀'.repeat(2001) })).toBe(false)
  })

  it('validates dependsOn entries', () => {
    expect(ok({ ...manifest, dependsOn: [] })).toBe(true)
    expect(ok({ ...manifest, dependsOn: ['01JB2YX7M3K5N7Q9S1U3W5Y7A9'] })).toBe(false)
    expect(ok({ ...manifest, dependsOn: ['baseline:Bad'] })).toBe(false)
    expect(ok({ ...manifest, dependsOn: [`baseline:${'a'.repeat(65)}`] })).toBe(false)
    expect(ok({ ...manifest, dependsOn: undefined })).toBe(false)
  })

  it('validates durations: grammar, 1 ms to 6 h, no zero', () => {
    for (const good of ['1ms', '5s', '10m', '1h30m', '6h', '1h0m0s0ms', '250ms']) {
      expect(ok(withChange(['execution', 'lockTimeout'], good)), good).toBe(true)
    }
    for (const bad of [
      '0s',
      '0ms',
      '6h1ms',
      '7h',
      '5 s',
      '1.5s',
      '5s1m',
      '05s',
      'PT5S',
      '1s1s',
      '',
      's',
      '5',
      '-5s',
    ]) {
      expect(ok(withChange(['execution', 'lockTimeout'], bad)), bad).toBe(false)
    }
    expect(parseDurationMs('1h30m')).toBe(5_400_000)
    expect(parseDurationMs('5ms')).toBe(5)
    expect(parseDurationMs('5m')).toBe(300_000)
    expect(parseDurationMs('x')).toBeUndefined()
  })

  it('requires compatibility notes unless additive', () => {
    expect(ok(withChange(['compatibility'], { declared: 'destructive' }))).toBe(false)
    expect(ok(withChange(['compatibility'], { declared: 'destructive', notes: '  ' }))).toBe(false)
    expect(
      ok(
        withChange(['compatibility'], {
          declared: 'destructive',
          notes: 'Drops column x after readers moved.',
        }),
      ),
    ).toBe(true)
  })

  it('requires rollback safety exactly when a script is present', () => {
    expect(ok(withChange(['rollback'], { script: 'down.sql' }))).toBe(false)
    expect(ok(withChange(['rollback'], { script: 'none', safety: 'safe' }))).toBe(false)
    expect(ok(withChange(['rollback'], { script: 'none' }))).toBe(true)
    expect(ok(withChange(['rollback'], undefined))).toBe(true)
  })

  it('refuses duplicate extensions and malformed version ranges', () => {
    expect(
      ok(withChange(['requires', 'extensions'], [{ name: 'vector' }, { name: 'vector' }])),
    ).toBe(false)
    expect(ok(withChange(['requires', 'postgres'], '>= 16'))).toBe(false)
    expect(ok(withChange(['requires', 'postgres'], '16.x'))).toBe(false)
  })

  it('refuses null for optional fields (absent is the only way to leave them unset)', () => {
    expect(ok(withChange(['execution', 'role'], null))).toBe(false)
    expect(ok(withChange(['requires'], null))).toBe(false)
  })
})

describe('exponetdb.project/v1', () => {
  const project = {
    schema: 'exponetdb.project/v1',
    project: 'reosa/platform',
    layout: 'bundles',
    defaults: { lockTimeout: '5s', statementTimeout: '15m', role: 'owner', searchPath: ['public'] },
    executionRoles: { owner: 'reosa_owner' },
    managedScope: { includeSchemas: ['public', 'status'], excludeSchemas: [] },
    trustedExtensions: ['pg_trgm'],
    lintProfile: 'strict',
  }
  const okProject = (value: unknown): boolean => ProjectConfigSchema.safeParse(value).success

  it('accepts the documented example', () => {
    expect(okProject(project)).toBe(true)
  })

  it('requires defaults.role to name a declared alias and legacy for legacy layouts', () => {
    expect(okProject({ ...project, defaults: { role: 'missing' } })).toBe(false)
    expect(okProject({ ...project, layout: 'legacy+bundles' })).toBe(false)
    expect(
      okProject({
        ...project,
        layout: 'legacy+bundles',
        legacy: { directory: '../migrations', baseline: 'baseline:reosa-platform-2026-11' },
      }),
    ).toBe(true)
  })

  it('refuses unknown keys and an empty role map', () => {
    expect(okProject({ ...project, roots: ['a'] })).toBe(false)
    expect(okProject({ ...project, executionRoles: {} })).toBe(false)
  })
})

describe('bundle submission', () => {
  it('accepts an inline bundle and refuses unknown files or a bad directory', () => {
    const files = { 'migration.yaml': 'schema: x', 'up.sql': 'SELECT 1;' }
    expect(
      BundleSubmissionSchema.safeParse({ directory: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_add-index', files })
        .success,
    ).toBe(true)
    expect(
      BundleSubmissionSchema.safeParse({
        directory: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z_add-index',
        files: { ...files, 'helper.sql': '' },
      }).success,
    ).toBe(false)
    expect(BundleSubmissionSchema.safeParse({ directory: 'add-index', files }).success).toBe(false)
  })
})
