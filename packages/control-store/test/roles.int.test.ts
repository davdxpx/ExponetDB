import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONTROL_STORE_ROLES,
  ControlStore,
  ControlStoreError,
  type ControlStoreRole,
  scramSha256Verifier,
} from '../src/index.ts'
import {
  type MigratedTestDatabase,
  migratedTestDatabase,
  testPassword,
  testSuperuserUrl,
} from '../src/testing/index.ts'

/**
 * Least privilege, proven against PostgreSQL itself (G2 security items):
 * every forbidden action is attempted and must fail. Grants are not read and
 * trusted; they are exercised.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_roles')
})

afterAll(async () => {
  await db?.drop()
})

async function sqlstateOf(
  role: ControlStoreRole,
  sql: string,
  database?: string,
): Promise<string | undefined> {
  const url = new URL(db.url(role))
  if (database !== undefined) {
    url.pathname = `/${database}`
  }
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    await client.query(sql)
    return undefined
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
    return typeof code === 'string' ? code : 'unknown'
  } finally {
    await client.end()
  }
}

const RUNTIME: readonly ControlStoreRole[] = [
  'exdb_serve',
  'exdb_worker',
  'exdb_gateway',
  'exdb_audit_maint',
]

describe('Control Store logins', () => {
  it('every login is a plain role: no superuser, no CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, no memberships', async () => {
    for (const role of CONTROL_STORE_ROLES) {
      const facts = await db.store(role).verifyLogin()
      expect(facts).toMatchObject({
        role,
        superuser: false,
        createRole: false,
        createDb: false,
        replication: false,
        bypassRls: false,
        memberships: 0,
      })
      expect(facts.serverVersionNum).toBeGreaterThanOrEqual(170000)
    }
  })

  it('a store refuses a login that is not the role it expects', async () => {
    const mislabeled = new ControlStore({ url: db.url('exdb_serve'), role: 'exdb_worker' })
    await expect(mislabeled.verifyLogin()).rejects.toMatchObject({
      code: 'control_store_wrong_role',
    })
    await mislabeled.close()
  })

  it('passwords are stored as SCRAM-SHA-256 verifiers and our verifier matches PostgreSQL bit for bit', async () => {
    const stored = await db.asSuperuser(
      async (c) =>
        (
          await c.query(
            "SELECT rolname, rolpassword FROM pg_authid WHERE rolname LIKE 'exdb\\_%' ORDER BY rolname",
          )
        ).rows,
    )
    expect(stored.map((r) => r.rolname).sort()).toEqual([...CONTROL_STORE_ROLES].sort())
    for (const row of stored) {
      expect(row.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/)
      const [, params] = String(row.rolpassword).split('$')
      const salt = Buffer.from(String(params).split(':')[1] ?? '', 'base64')
      const ours = scramSha256Verifier(testPassword(testSuperuserUrl(), row.rolname), { salt })
      expect(ours).toBe(row.rolpassword)
    }
  })

  it('a wrong password is refused', async () => {
    const url = new URL(db.url('exdb_serve'))
    url.password = ['wrong', 'password', 'for', 'this', 'role'].join('-')
    const client = new pg.Client({ connectionString: url.toString() })
    await expect(client.connect()).rejects.toMatchObject({ code: '28P01' })
  })

  it('PUBLIC cannot connect to the Control Store database', async () => {
    const outsider = 'exdb_test_outsider'
    await db.asSuperuser(async (c) => {
      await c.query(`DROP ROLE IF EXISTS ${outsider}`)
      await c.query(`CREATE ROLE ${outsider} LOGIN PASSWORD '${'o'.repeat(24)}'`)
    })
    const url = new URL(db.url('exdb_serve'))
    url.username = outsider
    url.password = 'o'.repeat(24)
    const client = new pg.Client({ connectionString: url.toString() })
    await expect(client.connect()).rejects.toMatchObject({ code: '42501' })
    await db.asSuperuser((c) => c.query(`DROP ROLE ${outsider}`))
  })

  it('runtime logins have an empty search_path', async () => {
    for (const role of RUNTIME) {
      const { rows } = await db.store(role).query('test.search_path', 'SHOW search_path')
      expect(rows[0]?.text('search_path')).toBe('""')
    }
  })
})

describe('forbidden actions fail for every runtime login', () => {
  const forbidden: readonly [string, string, string][] = [
    ['CREATE TABLE in an ExponetDB schema', 'CREATE TABLE control.x (a int)', '42501'],
    ['CREATE SCHEMA', 'CREATE SCHEMA x', '42501'],
    ['CREATE EXTENSION (trusted pgcrypto)', 'CREATE EXTENSION pgcrypto SCHEMA control', '42501'],
    ['ALTER SYSTEM', "ALTER SYSTEM SET work_mem = '64MB'", '42501'],
    ['CREATE ROLE', 'CREATE ROLE x', '42501'],
    ['SET ROLE to the owner', 'SET ROLE exdb_migrate', '42501'],
    [
      'write the ledger',
      "INSERT INTO control.schema_migrations (migration_id) VALUES ('x')",
      '42501',
    ],
    [
      'change the installation marker',
      "UPDATE control.installation SET created_by_engine = 'x'",
      '42501',
    ],
    [
      'disable an append-only trigger',
      'ALTER TABLE control.schema_migrations DISABLE TRIGGER USER',
      '42501',
    ],
    ['truncate the ledger', 'TRUNCATE control.schema_migrations', '42501'],
  ]
  for (const [what, sql, code] of forbidden) {
    it(`refuses: ${what}`, async () => {
      for (const role of RUNTIME) {
        expect(await sqlstateOf(role, sql), `${role}: ${sql}`).toBe(code)
      }
    })
  }

  it('refuses DROP DATABASE, even from another database', async () => {
    for (const role of [...RUNTIME, 'exdb_migrate' as const]) {
      expect(await sqlstateOf(role, `DROP DATABASE "${db.name}"`, 'postgres')).toBe('42501')
    }
  })

  it('the owner cannot change append-only rows either (the trigger fires for the owner)', async () => {
    expect(
      await sqlstateOf('exdb_migrate', "UPDATE control.installation SET created_by_engine = 'x'"),
    ).toBe('EXA01')
    expect(await sqlstateOf('exdb_migrate', 'DELETE FROM control.schema_migrations')).toBe('EXA01')
    expect(await sqlstateOf('exdb_migrate', 'TRUNCATE control.migration_verifications')).toBe(
      'EXA01',
    )
    expect(await sqlstateOf('exdb_migrate', 'CREATE ROLE x')).toBe('42501')
    expect(await sqlstateOf('exdb_migrate', "ALTER SYSTEM SET work_mem = '64MB'")).toBe('42501')
  })

  it('maps a refused statement to control_store_permission_denied with its SQLSTATE', async () => {
    await expect(
      db
        .store('exdb_serve')
        .query('test.forbidden', "INSERT INTO control.settings (key, value) VALUES ('a', '1')"),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof ControlStoreError &&
        e.code === 'control_store_permission_denied' &&
        e.sqlstate === '42501',
    )
  })
})
