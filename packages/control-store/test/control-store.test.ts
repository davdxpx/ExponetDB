import { describe, expect, it } from 'vitest'
import {
  bootstrapPsqlScript,
  ControlStoreError,
  checkNamesOf,
  compareSchema,
  databaseGrantsSql,
  type ExpectedMigration,
  isPlainLogin,
  type Ledger,
  type LoginFacts,
  loadBundleSet,
  lockKey2,
  MIGRATE_LOCK,
  rolesSql,
  SCRAM_VERIFIER,
  scramSha256Verifier,
  toControlStoreError,
} from '../src/index.ts'

const VERIFIER = scramSha256Verifier('a'.repeat(32), { salt: new Uint8Array(16) })
const verifiers = {
  exdb_migrate: VERIFIER,
  exdb_serve: VERIFIER,
  exdb_worker: VERIFIER,
  exdb_gateway: VERIFIER,
  exdb_audit_maint: VERIFIER,
}

describe('SCRAM verifiers', () => {
  it('have the PostgreSQL stored form', () => {
    expect(VERIFIER).toMatch(SCRAM_VERIFIER)
    expect(VERIFIER.startsWith('SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$')).toBe(true)
  })

  it('are deterministic for a fixed salt and differ with the salt', () => {
    expect(scramSha256Verifier('b'.repeat(20), { salt: new Uint8Array(16) })).toBe(
      scramSha256Verifier('b'.repeat(20), { salt: new Uint8Array(16) }),
    )
    expect(scramSha256Verifier('b'.repeat(20))).not.toBe(scramSha256Verifier('b'.repeat(20)))
  })

  it('refuse short, non-ASCII or control-character passwords and weak parameters', () => {
    expect(() => scramSha256Verifier('short')).toThrow()
    expect(() => scramSha256Verifier(`${'a'.repeat(20)}é`)).toThrow()
    expect(() => scramSha256Verifier(`${'a'.repeat(20)} `)).toThrow()
    expect(() => scramSha256Verifier('a'.repeat(20), { iterations: 1000 })).toThrow()
    expect(() => scramSha256Verifier('a'.repeat(20), { salt: new Uint8Array(8) })).toThrow()
  })
})

describe('bootstrap SQL', () => {
  it('creates five plain login roles with verifiers, never passwords', () => {
    const sql = rolesSql(verifiers).join('\n')
    for (const role of [
      'exdb_migrate',
      'exdb_serve',
      'exdb_worker',
      'exdb_gateway',
      'exdb_audit_maint',
    ]) {
      expect(sql).toContain(
        `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      )
    }
    expect(sql).not.toContain('a'.repeat(32))
  })

  it('refuses anything that is not a verifier and any unsafe database name', () => {
    expect(() => rolesSql({ ...verifiers, exdb_serve: "x'; DROP ROLE postgres; --" })).toThrow()
    expect(() => databaseGrantsSql('exponetdb"; DROP DATABASE x; --')).toThrow()
    expect(() => databaseGrantsSql('Upper')).toThrow()
  })

  it('revokes everything from PUBLIC and keeps the database owned by the bootstrap superuser', () => {
    const script = bootstrapPsqlScript('exponetdb_control', verifiers)
    expect(script).toContain('REVOKE ALL ON DATABASE "exponetdb_control" FROM PUBLIC')
    expect(script).toContain(
      'GRANT CONNECT, CREATE ON DATABASE "exponetdb_control" TO exdb_migrate',
    )
    expect(script).not.toMatch(/OWNER\s+exdb_/)
    expect(script).toContain('DROP SCHEMA IF EXISTS public')
    expect(script).toContain('\\connect "exponetdb_control"')
  })
})

describe('login check', () => {
  const plain: LoginFacts = {
    role: 'exdb_serve',
    database: 'exponetdb_control',
    serverVersionNum: 170011,
    superuser: false,
    createRole: false,
    createDb: false,
    replication: false,
    bypassRls: false,
    memberships: 0,
  }

  it('accepts only the expected role without any privilege', () => {
    expect(isPlainLogin(plain, 'exdb_serve')).toBe(true)
    expect(isPlainLogin(plain, 'exdb_worker')).toBe(false)
    expect(isPlainLogin({ ...plain, role: 'postgres' }, 'exdb_serve')).toBe(false)
  })

  it('refuses the expected role as soon as it holds any privilege or membership', () => {
    for (const privileged of [
      { superuser: true },
      { createRole: true },
      { createDb: true },
      { replication: true },
      { bypassRls: true },
      { memberships: 1 },
    ]) {
      expect(
        isPlainLogin({ ...plain, ...privileged }, 'exdb_serve'),
        JSON.stringify(privileged),
      ).toBe(false)
    }
  })
})

describe('advisory lock keys', () => {
  it('use the EXDB namespace and a stable derived second key', () => {
    expect(MIGRATE_LOCK.key1).toBe(0x45584442)
    expect(MIGRATE_LOCK.key2).toBe(lockKey2('control-store/migrate'))
    expect(lockKey2('control-store/migrate')).not.toBe(lockKey2('control-store/audit-chain'))
    expect(Number.isInteger(lockKey2('x'))).toBe(true)
  })
})

describe('error mapping', () => {
  const pgError = (code: string): Error =>
    Object.assign(new Error(`message with a value "secret-ish"`), { code })
  it.each([
    ['42501', 'control_store_permission_denied'],
    ['23505', 'control_store_conflict'],
    ['40001', 'control_store_serialization_failure'],
    ['57014', 'control_store_timeout'],
    ['55P03', 'control_store_timeout'],
    ['08006', 'control_store_unavailable'],
    ['57P01', 'control_store_unavailable'],
    ['EXA01', 'control_store_append_only'],
    ['22012', 'control_store_query_failed'],
  ])('%s → %s', (sqlstate, code) => {
    const mapped = toControlStoreError(pgError(sqlstate))
    expect(mapped).toBeInstanceOf(ControlStoreError)
    expect(mapped.code).toBe(code)
    expect(mapped.sqlstate).toBe(sqlstate)
    expect(mapped.message).not.toContain('secret-ish')
  })

  it('maps connection failures without a SQLSTATE to unavailable', () => {
    expect(toControlStoreError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code).toBe(
      'control_store_unavailable',
    )
    expect(toControlStoreError(new Error('Connection terminated unexpectedly')).code).toBe(
      'control_store_unavailable',
    )
  })
})

describe('schema compatibility', () => {
  const expected: ExpectedMigration[] = [
    { id: 'A', name: 'a', checksum: 'c-a', verifyDigest: 'v-a' },
    { id: 'B', name: 'b', checksum: 'c-b', verifyDigest: 'v-b' },
  ]
  const entry = (id: string, checksum: string) => ({
    migrationId: id,
    name: id,
    checksum,
    verifyDigest: 'x',
    appliedSeq: 1,
    appliedAt: new Date(0),
  })
  const verified = (id: string, digest: string, status: 'passed' | 'failed' = 'passed') =>
    [id, { migrationId: id, verifyDigest: digest, status, finishedAt: new Date(0) }] as const
  const ledger = (
    entries: ReturnType<typeof entry>[],
    latest: (readonly [string, ReturnType<typeof verified>[1]])[] = [],
  ): Ledger => ({
    exists: true,
    entries,
    latest: new Map(latest),
  })

  it('checks every expected id, its checksum and its verification, never only the latest id', () => {
    expect(compareSchema(expected, { exists: false, entries: [], latest: new Map() })).toEqual({
      status: 'uninitialized',
    })
    expect(compareSchema(expected, ledger([entry('B', 'c-b')], [verified('B', 'v-b')]))).toEqual({
      status: 'pending',
      missing: ['A'],
    })
    expect(
      compareSchema(
        expected,
        ledger([entry('A', 'c-a'), entry('B', 'c-b')], [verified('A', 'v-a')]),
      ),
    ).toEqual({
      status: 'unverified',
      ids: ['B'],
    })
    expect(
      compareSchema(
        expected,
        ledger(
          [entry('A', 'c-a'), entry('B', 'c-b')],
          [verified('A', 'v-a'), verified('B', 'v-old')],
        ),
      ),
    ).toEqual({ status: 'unverified', ids: ['B'] })
    expect(
      compareSchema(
        expected,
        ledger(
          [entry('A', 'c-a'), entry('B', 'c-b')],
          [verified('A', 'v-a'), verified('B', 'v-b', 'failed')],
        ),
      ),
    ).toEqual({ status: 'unverified', ids: ['B'] })
    expect(
      compareSchema(
        expected,
        ledger(
          [entry('A', 'c-a'), entry('B', 'c-b')],
          [verified('A', 'v-a'), verified('B', 'v-b')],
        ),
      ),
    ).toEqual({ status: 'current' })
  })

  it('a checksum mismatch outranks a newer schema, which outranks everything else', () => {
    expect(compareSchema(expected, ledger([entry('A', 'c-x'), entry('Z', 'c-z')]))).toEqual({
      status: 'mismatch',
      ids: ['A'],
    })
    expect(compareSchema(expected, ledger([entry('A', 'c-a'), entry('Z', 'c-z')]))).toEqual({
      status: 'newer',
      unknown: ['Z'],
    })
  })
})

describe('shipped bundles', () => {
  it('load, validate with migrations/format and order with migrations/graph', async () => {
    const set = await loadBundleSet()
    expect(set.project.project).toBe('exponetdb/control-store')
    expect(set.bundles.length).toBeGreaterThanOrEqual(2)
    expect(set.bundles[0]?.name).toBe('control-foundation')
    for (const b of set.bundles) {
      expect(b.digests.checksum).toMatch(/^sha256:c1:[0-9a-f]{64}$/)
      expect(b.checkNames.length).toBeGreaterThan(0)
    }
  })

  it('contain no transaction control in up.sql and name every verify.sql check', async () => {
    const set = await loadBundleSet()
    for (const b of set.bundles) {
      // Remove dollar-quoted bodies (function code) before looking at statement starts.
      const outside =
        b.digests.executableText['up.sql']?.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '') ?? ''
      const starts = outside.split(';').map((s) => s.trim().split(/\s+/)[0]?.toUpperCase() ?? '')
      for (const word of ['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'ABORT', 'START']) {
        expect(starts, `${b.directory}: ${word}`).not.toContain(word)
      }
      const statements = b.verifySql
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.replace(/--.*$/gm, '').trim())
        .filter((s) => s.length > 0)
      expect(b.checkNames.length, b.directory).toBe(statements.length)
    }
  })

  it('reads -- check: directives in order', () => {
    expect(
      checkNamesOf(
        '-- check: one\nSELECT true AS ok;\n  --check:two  \nSELECT 1;\n-- not a check\n',
      ),
    ).toEqual(['one', 'two'])
  })
})
