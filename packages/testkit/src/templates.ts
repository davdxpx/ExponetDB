import { createHash } from 'node:crypto'
import { runAsSuperuser, type TestServer, uniqueDatabaseName, withSuperuser } from './servers.ts'

/**
 * Template-database cache ([postgres-adapter.md §9](../../../exponetdb-docs/03-database-model/postgres-adapter.md#9-testing-support)):
 * a fixture is built once per server into `exdb_tpl_<hash of its SQL>` and
 * every suite copies it (`CREATE DATABASE … TEMPLATE …`), which is fast even
 * for the 2,000-table catalog. Building takes a cluster-wide advisory lock,
 * so parallel suites never build the same template twice.
 */
export interface Fixture {
  readonly name: string
  /** Cluster-wide statements (roles), run in `postgres` before the template is built. */
  readonly cluster: readonly string[]
  /** Statements run inside the template database. */
  readonly database: readonly string[]
}

const TEMPLATE_LOCK = 0x45584442_0004 // 'EXDB', Wave 4 test templates

function templateName(fixture: Fixture): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([fixture.name, fixture.cluster, fixture.database]))
    .digest('hex')
    .slice(0, 16)
  return `exdb_tpl_${fixture.name.replace(/[^a-z0-9_]/g, '_').slice(0, 20)}_${hash}`
}

async function templateExists(s: TestServer, name: string): Promise<boolean> {
  return withSuperuser(s, 'postgres', async (c) => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate', [
      name,
    ])
    return (r.rowCount ?? 0) > 0
  })
}

export async function ensureTemplate(s: TestServer, fixture: Fixture): Promise<string> {
  const name = templateName(fixture)
  if (await templateExists(s, name)) {
    return name
  }
  await withSuperuser(s, 'postgres', async (c) => {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [TEMPLATE_LOCK])
    try {
      const done = await c.query('SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate', [
        name,
      ])
      if ((done.rowCount ?? 0) > 0) {
        return
      }
      for (const statement of fixture.cluster) {
        await c.query(statement)
      }
      const building = `${name}_b`.slice(0, 63)
      await c.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`)
      await c.query(`CREATE DATABASE "${building}"`)
      await runAsSuperuser(s, building, fixture.database)
      await c.query(`ALTER DATABASE "${building}" RENAME TO "${name}"`)
      await c.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
    } finally {
      await c.query('SELECT pg_advisory_unlock($1::bigint)', [TEMPLATE_LOCK])
    }
  })
  return name
}

/** A fresh database copied from the fixture's template. */
export async function databaseFromFixture(
  s: TestServer,
  fixture: Fixture,
  label: string,
): Promise<string> {
  const template = await ensureTemplate(s, fixture)
  const name = uniqueDatabaseName(label)
  await withSuperuser(s, 'postgres', async (c) => {
    await c.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
  })
  return name
}
