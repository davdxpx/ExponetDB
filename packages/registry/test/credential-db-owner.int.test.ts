import { dropDatabase, matrix, runAsSuperuser, withRolesHeld } from '@exponetdb/testkit'
import { describe, expect, it } from 'vitest'
import { listCredentials } from '../src/index.ts'
import {
  actor,
  harness,
  readyCluster,
  registerDatabase,
  submit,
  targetDatabase,
  verifyCredentials,
} from './harness.ts'

/**
 * The migrator's credential on a database that an execution role owns
 * (ADR-0034 §3.1), on PostgreSQL 16, 17 and 18. The migrator is a `SET`
 * member of that role, and inside the database the owner is an implicit
 * member of `pg_database_owner`, so the migrator reaches it there. That is
 * the owner's identity, not a privilege: the verification, which logs in to
 * the cluster's first registered database, accepts it as the execution-role
 * check does.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'the migrator credential on a database its execution role owns (PostgreSQL %i)',
  (_major, s) => {
    it('verifies the migrator there', async () => {
      const h = await harness('exdb_it_cred_dbo')
      const a = actor()
      const role = `exdb_it_cred_dbo_${s.major}`
      let name = ''
      try {
        const clusterId = await readyCluster(h, a, s)
        await withRolesHeld(s, () =>
          runAsSuperuser(s, 'postgres', [
            `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
            `GRANT ${role} TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE`,
          ]),
        )
        name = await targetDatabase(s, 'cred_dbo', [
          `DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO %I', pg_catalog.current_database(), '${role}'); END $$`,
        ])
        // The cluster's only registered database: the one the verification logs in to.
        await registerDatabase(h, a, clusterId, name)
        const pending = await submit(h, a, clusterId, 'migrator')
        await verifyCredentials(h)
        const migrator = (await listCredentials(h.worker, clusterId)).find(
          (c) => c.credentialId === pending.credentialId,
        )
        expect(migrator).toMatchObject({ state: 'active', failureCode: null })
      } finally {
        await h.close()
        if (name !== '') await dropDatabase(s, name).catch(() => undefined)
        await withRolesHeld(s, () =>
          runAsSuperuser(s, 'postgres', [
            `REVOKE ${role} FROM exponetdb_migrator`,
            `DROP ROLE IF EXISTS ${role}`,
          ]),
        ).catch(() => undefined)
      }
    }, 120_000)
  },
)
