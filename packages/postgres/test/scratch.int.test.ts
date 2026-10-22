import { dropDatabase, matrix, runAsSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { missingObjects } from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * The scratch preflight's lookup of objects outside the managed scope
 * (legacy-import.md §2.5) on PostgreSQL 16, 17 and 18, read by the
 * observer: a function named by a legacy file's call site (no argument
 * types) is present in any overload (follow-up 2, F3); one read from the
 * imported target's catalog only with its exact arguments.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'objects outside the scope on PostgreSQL %i',
  (_major, server) => {
    let database = ''

    beforeAll(async () => {
      database = await prepareDatabase(server, `scratch_${server.major}`)
      await runAsSuperuser(server, database, [
        'CREATE SCHEMA acme_identity',
        'CREATE TABLE acme_identity.users (id uuid PRIMARY KEY)',
        "CREATE FUNCTION acme_identity.uid(uuid) RETURNS uuid LANGUAGE sql STABLE AS 'SELECT $1'",
      ])
    }, 120_000)

    afterAll(async () => {
      if (database !== '') await dropDatabase(server, database)
    })

    it('finds a function by its name alone or by its exact arguments', async () => {
      const s = await open(server, database, 'observer')
      try {
        const missing = await s.readOnly((rtx) =>
          missingObjects(rtx, [
            { kind: 'function', schema: 'acme_identity', name: 'uid', args: null },
            { kind: 'function', schema: 'acme_identity', name: 'uid', args: 'uuid' },
            { kind: 'function', schema: 'acme_identity', name: 'uid', args: '' },
            { kind: 'function', schema: 'acme_identity', name: 'jwt', args: null },
            { kind: 'relation', schema: 'acme_identity', name: 'users', args: null },
            { kind: 'type', schema: 'acme_identity', name: 'account_kind', args: null },
          ]),
        )
        expect(missing.map((m) => `${m.kind} ${m.name}(${m.args ?? '*'})`)).toEqual([
          'function uid()',
          'function jwt(*)',
          'type account_kind(*)',
        ])
      } finally {
        await s.close()
      }
    })
  },
)
