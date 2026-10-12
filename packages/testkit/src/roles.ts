import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import { type TestServer, testRolePassword, withSuperuser } from './servers.ts'

/**
 * Creates ExponetDB's login roles on a test server with the product's own
 * bootstrap SQL (passed in, so the kit does not depend on the package it
 * tests), with SCRAM verifiers of passwords derived from the run's secret.
 * Roles are cluster-wide: suites take turns under an advisory lock, and a
 * server that already has the roles only gets its passwords set again.
 *
 * The product's connection limits (bootstrap SQL) hold per installation:
 * one cluster, one ExponetDB. A test server hosts many test installations
 * at once (parallel files and packages), all logging in as the same roles,
 * so the shared roles get room for several (`SHARED_CONNECTION_LIMIT`).
 * The limits themselves are proven where one installation owns its
 * cluster (the host tests and the local lab).
 */
export interface RoleProvisioning {
  /** Access role → login role name (e.g. observer → exponetdb_observer). */
  readonly roles: Readonly<Record<string, string>>
  readonly cluster: (verifiers: Readonly<Record<string, string>>) => readonly string[]
  readonly passwords: (verifiers: Readonly<Record<string, string>>) => readonly string[]
}

const ROLE_LOCK = 0x45584442_0005 // 'EXDB', Wave 4 test roles
const SHARED_CONNECTION_LIMIT = 32

export function loginPassword(loginRole: string): string {
  return testRolePassword(loginRole)
}

export async function provisionRoles(s: TestServer, p: RoleProvisioning): Promise<void> {
  const verifiers = Object.fromEntries(
    Object.entries(p.roles).map(([access, login]) => [
      access,
      scramSha256Verifier(loginPassword(login)),
    ]),
  )
  await withSuperuser(s, 'postgres', async (c) => {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [ROLE_LOCK])
    try {
      const logins = Object.values(p.roles)
      const existing = await c.query(
        'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)',
        [logins],
      )
      const n = Number(existing.rows[0]?.n ?? 0)
      const statements = n === 0 ? p.cluster(verifiers) : p.passwords(verifiers)
      if (n !== 0 && n !== logins.length) {
        throw new Error(
          'a test server has only some of the ExponetDB roles; recreate the containers',
        )
      }
      for (const statement of statements) {
        await c.query(statement)
      }
      for (const login of logins) {
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login)) throw new Error('unexpected role name')
        await c.query(`ALTER ROLE ${login} CONNECTION LIMIT ${SHARED_CONNECTION_LIMIT}`)
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock($1::bigint)', [ROLE_LOCK])
    }
  })
}

/**
 * Runs `fn` while no suite (re)sets the test roles' passwords on the server:
 * for a test that changes a role's password itself (a credential rotation)
 * and puts it back before it returns.
 */
export async function withRolesHeld<T>(s: TestServer, fn: () => Promise<T>): Promise<T> {
  return withSuperuser(s, 'postgres', async (c) => {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [ROLE_LOCK])
    try {
      return await fn()
    } finally {
      await c.query('SELECT pg_advisory_unlock($1::bigint)', [ROLE_LOCK])
    }
  })
}
