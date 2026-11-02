import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationWorld, type World } from './world.ts'

/**
 * VC-016, VC-017 on PostgreSQL 16, 17 and 18: a CREATE TABLE with a serial column is applied and
 * verified (the engine's structural verification used to expect a type no catalog holds), and the
 * ALTER TABLE ... ADD COLUMN that rewrites the table says so before it runs.
 */
describe.each([16, 17, 18] as const)('serial and identity columns on PostgreSQL %i', (major) => {
  const pg = serverFor(major)
  let w: World

  beforeAll(async () => {
    w = await migrationWorld(`exdb_it_mig_serial${major}`, pg)
  }, 240_000)

  afterAll(async () => {
    await w?.close()
  })

  it.each(['serial', 'bigserial', 'smallserial'])(
    'applies and verifies CREATE TABLE with a %s column',
    async (type) => {
      const t = await w.registerTarget(`sc-${type}`, 'nonprod')
      const op = await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({
              name: `table-${type}`,
              up: `CREATE TABLE public.va (id ${type} PRIMARY KEY, name text NOT NULL);\n`,
            }),
          ],
        }),
      )
      expect(op).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
    },
  )

  it.each(['bigserial', 'bigint GENERATED ALWAYS AS IDENTITY'])(
    'plans ADD COLUMN %s as a table rewrite, and PostgreSQL rewrites it',
    async (column) => {
      const t = await w.registerTarget(`sr-${column.split(' ')[0]}-${column.length}`, 'nonprod')
      const base = w.ulid()
      expect(
        await w.apply(
          await w.plan(t, {
            bundles: [
              w.bundle({
                id: base,
                name: 'base',
                up: 'CREATE TABLE public.rw (id int);\nINSERT INTO public.rw VALUES (1), (2);\n',
              }),
            ],
          }),
        ),
      ).toMatchObject({ state: 'succeeded' })
      const filenode = async () => {
        const c = await superuserClient(pg, t.database)
        try {
          const r = await c.query(
            `SELECT relfilenode FROM pg_class WHERE oid = 'public.rw'::regclass`,
          )
          return String(r.rows[0]?.relfilenode)
        } finally {
          await c.end()
        }
      }
      const before = await filenode()
      const plan = await w.plan(t, {
        bundles: [
          w.bundle({
            name: 'add-seq',
            up: `ALTER TABLE public.rw ADD COLUMN seq ${column};\n`,
            dependsOn: [base],
          }),
        ],
      })
      const statement = (
        plan.body['analysis'] as {
          perMigration: { statements: { rewrite: string; compatibility: string }[] }[]
        }
      ).perMigration[0]?.statements[0]
      expect(statement?.rewrite).toBe('table')
      expect(statement?.compatibility).toBe('data_rewrite')
      await w.apply(plan)
      // The classification is the truth: the file node changed.
      expect(await filenode()).not.toBe(before)
    },
  )
})
