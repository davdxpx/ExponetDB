import { databaseBootstrapStatements } from '@exponetdb/postgres'
import { dropDatabase, runAsSuperuser, serverFor, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getDatabase,
  planDatabaseRetire,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planTargetRegister,
  planTargetStateChange,
  type RegistryActor,
} from '../src/index.ts'
import {
  actor,
  type Harness,
  harness,
  plan,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  submit,
  targetDatabase,
  verifyCredentials,
} from './harness.ts'

/**
 * Retiring a database record (Wave 9 order A7): a wrong registration is
 * corrected through operations, never by editing the Control Store. A
 * database that is a current placement is not retired; once its target is
 * decommissioned the record ends for good, audited, and the same name on
 * the cluster (a re-created database, a new oid) registers again.
 */
const pg17 = serverFor(17)
let h: Harness
let a: RegistryActor
let clusterId = ''
let projectId = ''
let environmentId = ''
let name = ''

beforeAll(async () => {
  h = await harness('exdb_it_db_retire')
  a = actor()
  clusterId = await readyCluster(h, a, pg17)
  // Registration stamps the identity marker as the migrator and checks it as the verifier.
  await submit(h, a, clusterId, 'migrator')
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  const slug = `ret${Date.now().toString(36)}`
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Retire' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    }),
  )
  environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, { product: slug, slug: 'platform', displayName: 'P' }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
}, 120_000)

afterAll(async () => {
  await h?.close()
  if (name !== '') await dropDatabase(pg17, name).catch(() => undefined)
})

const retire = (databaseId: string) =>
  plan(h, (tx) => planDatabaseRetire(tx, h.context, a, clusterId, databaseId))

describe('registry.database.retire', () => {
  it('refuses a current placement, retires once its target is decommissioned, and frees the name', async () => {
    name = await targetDatabase(pg17, 'retire_me')
    const databaseId = await registerDatabase(h, a, clusterId, name)
    const registered = await run(h, a, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: projectId as never,
        environmentId: environmentId as never,
        databaseId: databaseId as never,
      }),
    )
    expect(registered.operation.state).toBe('succeeded')
    const targetId = String((await planContent(h, registered.plan.planId))['targetId'])
    await expect(retire(databaseId)).rejects.toMatchObject({
      code: 'REGISTRY_CONFLICT',
      details: { reason: 'database_in_use' },
    })

    const decommissioned = await run(h, a, (tx) =>
      planTargetStateChange(tx, h.context, a, 'target.decommission', targetId, {
        reason: 'wrong_database',
      }),
    )
    expect(decommissioned.operation.state).toBe('succeeded')
    const retired = await run(h, a, () => retire(databaseId))
    expect(retired.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect((await getDatabase(h.worker, databaseId))?.state).toBe('retired')
    const audit = await h.worker.query(
      'test.retire.audit',
      `SELECT (event::jsonb)->'changes'->>'databaseId' AS database FROM audit.audit_events
        WHERE operation_id = $1 AND action = 'registry.database.retire'`,
      [retired.operation.operationId],
    )
    expect(audit.rows.map((r) => r.text('database'))).toEqual([databaseId])
    await expect(retire(databaseId)).rejects.toMatchObject({
      code: 'REGISTRY_CONFLICT',
      details: { reason: 'database_retired' },
    })
    // The cluster was not touched: the database is still there.
    const exists = await withSuperuser(pg17, 'postgres', (c) =>
      c.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [name]),
    )
    expect(exists.rowCount).toBe(1)

    // Re-created under the same name (a new oid), it registers again as a new record.
    await withSuperuser(pg17, 'postgres', async (c) => {
      await c.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      await c.query(`CREATE DATABASE "${name}"`)
    })
    await runAsSuperuser(pg17, name, databaseBootstrapStatements(name))
    const again = await registerDatabase(h, a, clusterId, name)
    expect(again).not.toBe(databaseId)
    const record = await getDatabase(h.worker, again)
    expect(record?.state).toBe('registered')
    expect(record?.observedOid).not.toBe((await getDatabase(h.worker, databaseId))?.observedOid)
  })

  it('refuses a database of another cluster or one that does not exist', async () => {
    await expect(retire('dbs_01M5GZZZZZZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
