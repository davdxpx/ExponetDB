import {
  createDatabase,
  dropDatabase,
  loginClient,
  matrix,
  runAsSuperuser,
  runPsql,
  type TestServer,
  withRolesHeld,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clusterBootstrapSql,
  planEnvironmentCreate,
  planExecutionRoleExceptionDeclare,
  planProductCreate,
  planProjectCreate,
  planProjectUpdate,
  planTargetRegister,
  type RegistryActor,
} from '../src/index.ts'
import {
  actor,
  type Harness,
  harness,
  password,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  submit,
  targetDatabase,
  verifyCredentials,
} from './harness.ts'

/**
 * The bootstrap SQL of an external cluster run with psql on real
 * PostgreSQL 16, 17 and 18 (Wave 9 order A8):
 *
 * - generated from the registry: the registered database, a database named
 *   in the request before its registration, the execution roles of the
 *   project placed on the cluster (and of a project named in the request),
 *   the legacy ledger read;
 * - run twice it converges: no error, the same roles, memberships,
 *   settings and privileges; a role created later is granted on the next
 *   run;
 * - the migrator gets `SET`, never `INHERIT`, on each fit execution role;
 *   a role that can log in, reaches a predefined role or holds `BYPASSRLS`
 *   without a declared exception is never granted (a warning names it), a
 *   missing one gets a notice.
 *
 * The test servers are shared, and their ExponetDB roles carry the shared
 * connection limit of the test kit (several installations per cluster), so
 * the run replaces the product's per-installation limits with that value
 * and holds the kit's role lock; everything else is the product's text.
 * The unit tests pin the limits.
 */
const suffix = Date.now().toString(36)
const role = (name: string) => `exdb_it_bs_${name}_${suffix}`
const OWNER = role('owner')
const ADOPTED = role('adopted')
const LOGIN = role('login')
const REACH = role('reach')
const LATER = role('later')
const OTHER = role('other')
const ROLES = [OWNER, ADOPTED, LOGIN, REACH, LATER, OTHER]

const SHARED_CONNECTION_LIMIT = 32
const shared = (script: string) =>
  script.replaceAll(/CONNECTION LIMIT [0-9]+/g, `CONNECTION LIMIT ${SHARED_CONNECTION_LIMIT}`)
/**
 * The script alters ExponetDB's shared roles: it runs under the test kit's role lock, so
 * no parallel suite provisions them at the same time (`tuple concurrently updated`).
 */
const runBootstrap = (s: TestServer, script: string) =>
  withRolesHeld(s, () => runPsql(s, shared(script)))

let h: Harness
let a: RegistryActor
let projectId = ''
let otherProjectId = ''
let productIdOf = ''
const created: { server: TestServer; database: string }[] = []

beforeAll(async () => {
  h = await harness('exdb_it_bootstrap')
  a = actor()
  const slug = `bs${suffix}`
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Bootstrap' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  productIdOf = productId
  for (const [name, roles] of [
    ['platform', { owner: OWNER, adopted: ADOPTED, login: LOGIN, reach: REACH, later: LATER }],
    ['other', { owner: OTHER }],
  ] as const) {
    const project = await run(h, a, (tx) =>
      planProjectCreate(tx, h.context, a, { product: slug, slug: name, displayName: name }),
    )
    const id = String((await planContent(h, project.plan.planId))['projectId'])
    const update = await run(h, a, (tx) =>
      planProjectUpdate(tx, h.context, a, id, { executionRoles: roles }),
    )
    expect(update.operation.state).toBe('succeeded')
    if (name === 'platform') projectId = id
    else otherProjectId = id
  }
}, 120_000)

afterAll(async () => {
  await h?.close()
  for (const c of created) await dropDatabase(c.server, c.database).catch(() => undefined)
  for (const s of matrix()) {
    await runAsSuperuser(
      s,
      'postgres',
      ROLES.map((r) => `DROP ROLE IF EXISTS ${r}`),
    ).catch(() => undefined)
  }
})

/** The state the script sets, read from the catalogs as the superuser. */
async function state(s: TestServer, databases: readonly string[]) {
  return withSuperuser(s, 'postgres', async (c) => {
    const roles = await c.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
              rolinherit, rolconnlimit,
              (SELECT array_agg(x ORDER BY x) FROM unnest(s.setconfig) x) AS settings
         FROM pg_catalog.pg_roles r
         LEFT JOIN pg_catalog.pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
        WHERE rolname LIKE 'exponetdb\\_%' OR rolname = ANY ($1)
        ORDER BY rolname`,
      [ROLES],
    )
    const members = await c.query(
      `SELECT g.rolname AS granted, m.rolname AS member, a.inherit_option, a.set_option, a.admin_option
         FROM pg_catalog.pg_auth_members a
         JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
         JOIN pg_catalog.pg_roles m ON m.oid = a.member
        WHERE m.rolname LIKE 'exponetdb\\_%' OR g.rolname = ANY ($1)
        ORDER BY 1, 2`,
      [ROLES],
    )
    const acls = await c.query(
      `SELECT datname, datacl::text FROM pg_catalog.pg_database WHERE datname = ANY ($1) ORDER BY 1`,
      [databases],
    )
    return { roles: roles.rows, members: members.rows, acls: acls.rows }
  })
}

const ledgerAcl = (s: TestServer, database: string) =>
  withSuperuser(s, database, async (c) => {
    const r = await c.query(
      `SELECT n.nspacl::text AS schema, c.relacl::text AS ledger
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations'`,
    )
    return r.rows[0]
  })

const migratorGrants = async (s: TestServer) =>
  withSuperuser(s, 'postgres', async (c) => {
    const r = await c.query(
      `SELECT g.rolname AS role, a.inherit_option AS inherit, a.set_option AS set
         FROM pg_catalog.pg_auth_members a
         JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
        WHERE a.member = 'exponetdb_migrator'::regrole AND g.rolname = ANY ($1)
        ORDER BY 1`,
      [ROLES],
    )
    return r.rows
  })

describe.each(matrix().map((s) => [s.major, s] as const))(
  'the bootstrap SQL on PostgreSQL %i',
  (_major, s) => {
    it('converges when run twice, grants only fit execution roles and lets the observer read the ledger', async () => {
      // One staging environment per server (one target per path), with the declared exception.
      const env = await run(h, a, (tx) =>
        planEnvironmentCreate(tx, h.context, a, productIdOf, {
          slug: `staging${s.major}`,
          displayName: `Staging ${s.major}`,
          tier: 'nonprod',
        }),
      )
      const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
      const declared = await run(h, a, (tx) =>
        planExecutionRoleExceptionDeclare(tx, h.context, a, projectId, environmentId, {
          role: ADOPTED,
          reason: 'Definer functions of the adopted schema read FORCE tables.',
        }),
      )
      expect(declared.operation.state).toBe('succeeded')
      const clusterId = await readyCluster(h, a, s, 'ip', `bootstrap pg${s.major}`)
      await submit(h, a, clusterId, 'verifier')
      await verifyCredentials(h)
      await runAsSuperuser(s, 'postgres', [
        `CREATE ROLE ${OWNER} NOLOGIN`,
        `CREATE ROLE ${ADOPTED} NOLOGIN BYPASSRLS`,
        `CREATE ROLE ${LOGIN} LOGIN`,
        `CREATE ROLE ${REACH} NOLOGIN`,
        `GRANT pg_read_all_data TO ${REACH}`,
        `CREATE ROLE ${OTHER} NOLOGIN`,
      ])
      // A registered database with a placed target of the project, and one not registered yet.
      const registered = await targetDatabase(s, 'bs_registered')
      created.push({ server: s, database: registered })
      const databaseId = await registerDatabase(h, a, clusterId, registered)
      const target = await run(h, a, (tx) =>
        planTargetRegister(tx, h.context, a, {
          projectId: projectId as never,
          environmentId: environmentId as never,
          databaseId: databaseId as never,
        }),
      )
      expect(target.operation.state).toBe('succeeded')
      const pending = await createDatabase(s, 'bs_pending')
      created.push({ server: s, database: pending })
      await runAsSuperuser(s, pending, [
        'CREATE SCHEMA supabase_migrations',
        'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])',
        `INSERT INTO supabase_migrations.schema_migrations VALUES ('20260101000000', 'init', ARRAY['select 1'])`,
      ])

      const generate = (projects: { projectId?: string } = {}) =>
        clusterBootstrapSql(h.worker, clusterId, {
          databases: [pending, registered],
          ledgers: ['supabase', 'drizzle'],
          ...projects,
        })
      const bootstrap = await generate()
      expect(bootstrap.databases).toEqual([registered, pending])
      expect(bootstrap.pendingDatabases).toEqual([pending])
      expect(bootstrap.legacyLedgers).toEqual(['drizzle', 'supabase'])
      expect(bootstrap.executionRoles).toEqual(
        [
          { name: ADOPTED, bypassRlsExcused: true },
          { name: LATER, bypassRlsExcused: false },
          { name: LOGIN, bypassRlsExcused: false },
          { name: OWNER, bypassRlsExcused: false },
          { name: REACH, bypassRlsExcused: false },
        ].sort((x, y) => (x.name < y.name ? -1 : 1)),
      )
      expect(bootstrap.script).not.toMatch(/PASSWORD/)
      // A project named in the request (no target here yet) adds its roles.
      const withOther = await generate({ projectId: otherProjectId })
      expect(withOther.executionRoles.map((r) => r.name)).toContain(OTHER)

      const first = await runBootstrap(s, withOther.script)
      expect(first.stderr).not.toMatch(/ERROR/)
      expect(first.status).toBe(0)
      expect(first.stderr).toContain(`execution role ${LATER} does not exist yet`)
      expect(first.stderr).toContain(`WARNING:  execution role ${LOGIN} is not granted`)
      expect(first.stderr).toContain(`WARNING:  execution role ${REACH} is not granted`)
      expect(await migratorGrants(s)).toEqual(
        [ADOPTED, OTHER, OWNER].sort().map((r) => ({ role: r, inherit: false, set: true })),
      )
      const after = await state(s, [registered, pending])
      const ledgerAfter = await ledgerAcl(s, pending)
      expect(ledgerAfter?.ledger).toContain('exponetdb_observer=r/')
      expect(ledgerAfter?.schema).toContain('exponetdb_observer=U/')
      for (const row of after.acls) {
        expect(String(row.datacl)).toContain('exponetdb_migrator=c/')
        expect(String(row.datacl)).toContain('exponetdb_ledger_owner=C/')
      }

      // Again: the same state, the same notices, no error.
      const second = await runBootstrap(s, withOther.script)
      expect(second.status).toBe(0)
      expect(second.stderr).not.toMatch(/ERROR/)
      expect(await state(s, [registered, pending])).toEqual(after)
      expect(await ledgerAcl(s, pending)).toEqual(ledgerAfter)

      // The observer reads the declared ledger, and only through the grant.
      const observer = await loginClient(s, 'exponetdb_observer', password('observer'), pending)
      try {
        const rows = await observer.query(
          'SELECT version FROM supabase_migrations.schema_migrations',
        )
        expect(rows.rows).toEqual([{ version: '20260101000000' }])
      } finally {
        await observer.end()
      }

      // A role created afterwards is granted on the next run.
      await runAsSuperuser(s, 'postgres', [`CREATE ROLE ${LATER} NOLOGIN`])
      const third = await runBootstrap(s, withOther.script)
      expect(third.status).toBe(0)
      expect(third.stderr).not.toContain(`execution role ${LATER}`)
      expect((await migratorGrants(s)).map((r) => r.role)).toContain(LATER)
      await runAsSuperuser(s, 'postgres', [
        `REVOKE ${OWNER}, ${ADOPTED}, ${OTHER}, ${LATER} FROM exponetdb_migrator`,
        ...ROLES.map((r) => `DROP ROLE ${r}`),
      ])
    }, 180_000)
  },
)
