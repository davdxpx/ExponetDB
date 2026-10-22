import { dropDatabase, matrix, runAsSuperuser, withRolesHeld } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkClusterGlobalExpectations } from '../src/index.ts'
import {
  type ClusterGlobalExpectation,
  clusterGlobalStatements,
  loadClusterGlobalParsers,
} from '../src/parser/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * Cluster-global expectations behind `IF EXISTS` guards (legacy-import.md
 * §2.4, follow-up 2 F1) against the live catalog of PostgreSQL 16, 17 and
 * 18, read by the observer: an expectation applies only while every
 * condition of its guards holds, and then it is checked as any other.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'guarded cluster-global expectations on PostgreSQL %i',
  (_major, server) => {
    const suffix = `${server.major}_${Date.now().toString(36)}`
    const reader = `exdb_it_cgx_reader_${suffix}`
    const writer = `exdb_it_cgx_writer_${suffix}`
    const absent = `exdb_it_cgx_absent_${suffix}`
    let database = ''

    beforeAll(async () => {
      await loadClusterGlobalParsers(server.major)
      database = await prepareDatabase(server, `cgx_${server.major}`)
      await withRolesHeld(server, () =>
        runAsSuperuser(server, 'postgres', [
          `CREATE ROLE ${reader} NOLOGIN`,
          `CREATE ROLE ${writer} NOLOGIN`,
          `GRANT ${reader} TO ${writer}`,
        ]),
      )
    }, 120_000)

    afterAll(async () => {
      if (database !== '') await dropDatabase(server, database)
      await withRolesHeld(server, () =>
        runAsSuperuser(server, 'postgres', [
          `DROP ROLE IF EXISTS ${writer}`,
          `DROP ROLE IF EXISTS ${reader}`,
        ]),
      ).catch(() => undefined)
    })

    const expectationsOf = (text: string): ClusterGlobalExpectation[] =>
      (clusterGlobalStatements(server.major, text) ?? []).flatMap((s) => [
        ...s.effects.expectations,
      ])

    it('checks a guarded grant while its guard holds, and skips it while it does not', async () => {
      const guarded = (role: string, member: string) => `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${member}') THEN
    GRANT ${role} TO ${member};
  END IF;
END $$;`
      const membership = (role: string, member: string) => `DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_auth_members
              WHERE roleid = '${role}'::regrole AND member = '${member}'::regrole) THEN
    REVOKE ${role} FROM ${member};
    GRANT ${role} TO ${member} WITH ADMIN OPTION;
  END IF;
END $$;`
      const expectations = [
        ...expectationsOf(guarded(reader, writer)),
        ...expectationsOf(guarded(reader, absent)),
        ...expectationsOf(membership(reader, writer)),
      ]
      const s = await open(server, database, 'observer')
      try {
        const results = await checkClusterGlobalExpectations(s.reader(), expectations)
        expect(results.map((r) => [r.expectation.kind, r.applies, r.ok])).toEqual([
          // The writer exists and holds the reader role.
          ['membership', true, true],
          // No such role: the grant states nothing on this cluster.
          ['membership', false, false],
          // REVOKE then GRANT … WITH ADMIN OPTION in one block: the grant supersedes the
          // revoke (review P2-2). The membership exists, so the guard holds; ADMIN was never
          // granted, so that option does not hold.
          ['membership', true, true],
          ['membership_option', true, false],
        ])
      } finally {
        await s.close()
      }
    })
  },
)
