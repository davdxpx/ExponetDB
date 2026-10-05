import { createHmac, randomBytes } from 'node:crypto'
import { type InstallationId, newId } from '@exponetdb/kernel'
import pg from 'pg'
import { createDatabaseSql, databaseGrantsSql, inDatabaseSql, rolesSql } from '../bootstrap-sql.ts'
import { loadBundleSet } from '../bundles.ts'
import { TEST_ROLES_LOCK } from '../locks.ts'
import { CONTROL_STORE_ROLES, type ControlStoreRole } from '../roles.ts'
import { migrateControlStore } from '../runner.ts'
import { scramSha256Verifier } from '../scram.ts'
import { ControlStore, type ControlStoreOptions } from '../store.ts'

/**
 * Integration test harness: real PostgreSQL 17, never an emulation (P-2).
 *
 * `EXDB_TEST_PG_URL` names a superuser of a disposable server (a local
 * container or the CI service). Without it, integration suites fail with an
 * explanation instead of being skipped. The harness creates the five roles
 * through the production bootstrap SQL, with passwords derived from the
 * superuser URL (so parallel suites in several packages agree on them), and a
 * fresh database per suite through the production database SQL. Test-only:
 * product code never imports this subpath.
 */
export const TEST_PG_URL_ENV = 'EXDB_TEST_PG_URL'

export function testSuperuserUrl(): string {
  const url = process.env[TEST_PG_URL_ENV]
  if (url === undefined || url.length === 0) {
    throw new Error(
      `${TEST_PG_URL_ENV} is not set. Integration tests need a disposable PostgreSQL 17 superuser URL (see exponetdb-docs/12-operations/local-development.md).`,
    )
  }
  return url
}

export function testPassword(superUrl: string, role: ControlStoreRole): string {
  return createHmac('sha256', superUrl).update(`exponetdb-test/${role}`).digest('base64url')
}

function withDatabase(
  url: string,
  database: string,
  user?: { name: string; password: string },
): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  if (user !== undefined) {
    u.username = user.name
    u.password = user.password
  }
  return u.toString()
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Creates or updates the five roles with the production role SQL. Serialized across suites. */
export async function ensureTestRoles(superUrl = testSuperuserUrl()): Promise<void> {
  const verifiers = Object.fromEntries(
    CONTROL_STORE_ROLES.map((role) => [role, scramSha256Verifier(testPassword(superUrl, role))]),
  )
  await withClient(withDatabase(superUrl, 'postgres'), async (client) => {
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [
      TEST_ROLES_LOCK.key1,
      TEST_ROLES_LOCK.key2,
    ])
    try {
      const statements = rolesSql({
        exdb_migrate: verifiers['exdb_migrate'] ?? '',
        exdb_serve: verifiers['exdb_serve'] ?? '',
        exdb_worker: verifiers['exdb_worker'] ?? '',
        exdb_gateway: verifiers['exdb_gateway'] ?? '',
        exdb_audit_maint: verifiers['exdb_audit_maint'] ?? '',
      })
      for (const statement of statements) {
        await client.query(statement)
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
        TEST_ROLES_LOCK.key1,
        TEST_ROLES_LOCK.key2,
      ])
    }
  })
}

export interface TestDatabase {
  readonly name: string
  readonly superuserUrl: string
  url(role: ControlStoreRole): string
  store(role: ControlStoreRole, options?: Partial<ControlStoreOptions>): ControlStore
  /** Runs SQL as the bootstrap superuser in this database (fixtures, inspection). */
  asSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>
  /** Runs `fn` on a plain connection of `role` (assertions on SQLSTATE and server message). */
  asRole<T>(role: ControlStoreRole, fn: (client: pg.Client) => Promise<T>): Promise<T>
  drop(): Promise<void>
}

/** A new, empty Control Store database bootstrapped with the production SQL. */
export async function createTestDatabase(prefix = 'exdb_it'): Promise<TestDatabase> {
  const superUrl = testSuperuserUrl()
  await ensureTestRoles(superUrl)
  const name = `${prefix}_${randomBytes(6).toString('hex')}`
  await withClient(withDatabase(superUrl, 'postgres'), async (client) => {
    await client.query(createDatabaseSql(name))
    for (const statement of databaseGrantsSql(name)) {
      await client.query(statement)
    }
  })
  const dbSuperUrl = withDatabase(superUrl, name)
  await withClient(dbSuperUrl, async (client) => {
    for (const statement of inDatabaseSql()) {
      await client.query(statement)
    }
  })
  const stores: ControlStore[] = []
  const url = (role: ControlStoreRole): string =>
    withDatabase(superUrl, name, { name: role, password: testPassword(superUrl, role) })
  return {
    name,
    superuserUrl: dbSuperUrl,
    url,
    store(role, options) {
      const store = new ControlStore({ url: url(role), role, poolMax: 4, ...options })
      stores.push(store)
      return store
    },
    asSuperuser: (fn) => withClient(dbSuperUrl, fn),
    asRole: (role, fn) => withClient(url(role), fn),
    async drop() {
      await Promise.all(stores.map((s) => s.close()))
      await withClient(withDatabase(superUrl, 'postgres'), async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      })
    },
  }
}

export interface MigratedTestDatabase extends TestDatabase {
  readonly installationId: InstallationId
}

/** A test database with the shipped Control Store bundles applied and verified. */
export async function migratedTestDatabase(prefix?: string): Promise<MigratedTestDatabase> {
  const db = await createTestDatabase(prefix)
  const store = db.store('exdb_migrate', { poolMax: 2 })
  try {
    const report = await migrateControlStore({
      store,
      bundles: await loadBundleSet(),
      engineVersion: 'test',
      newInstallationId: () => newId('ins', Date.now()),
    })
    if (report.state.status !== 'current') {
      throw new Error(`test database not current after migration: ${report.state.status}`)
    }
    return { ...db, installationId: report.installationId }
  } finally {
    await store.close()
  }
}
