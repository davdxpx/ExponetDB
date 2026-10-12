import { dropDatabase, matrix, runAsSuperuser } from '@exponetdb/testkit'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  admitChecks,
  changedConsumerCode,
  isAdmittedCheck,
  LockUnavailable,
  redactDetail,
  resolveVerifyCatalog,
  takeTargetLock,
  verifierProblems,
} from '../src/index.ts'
import {
  analyzeVerifyFile,
  loadParser,
  SUPPORTED_MAJORS,
  type VerifyCheckSpec,
} from '../src/parser/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * Target locks, the migrator's disconnect detection and the verify.sql
 * path on PostgreSQL 16, 17 and 18 (concurrency.md §2 to §4, verification.md
 * §4.2 to §4.4): the documented conflicts proven by real acquisition, the
 * catalog resolution of admitted checks, the result contract of each check
 * on a verifier session, and the verifier role's drift checks.
 */
const TARGET = 'tgt_01M4A000000000000000000030'

beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

function checksOf(major: 16 | 17 | 18, text: string): VerifyCheckSpec[] {
  const file = analyzeVerifyFile(major, text)
  if (!file.ok) throw new Error(`not admitted: ${JSON.stringify(file)}`)
  return [...file.checks]
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'locks and verification on PostgreSQL %i',
  (_m, server) => {
    it('excludes schema from schema and maintenance from both, in either order, and frees on release', async () => {
      const db = await prepareDatabase(server, `vl_lock_${server.major}`)
      const other = await prepareDatabase(server, `vl_lock2_${server.major}`)
      // Advisory locks need no privilege: three roles keep within the connection limits.
      const a = await open(server, db, 'migrator')
      const b = await open(server, db, 'operator')
      const c = await open(server, other, 'observer')
      try {
        const releaseA = await takeTargetLock(a, TARGET, 'schema')
        const waited: string[][] = []
        await expect(
          takeTargetLock(b, TARGET, 'schema', {
            deadlineMs: 700,
            onWait: (h) => waited.push([...h]),
          }),
        ).rejects.toBeInstanceOf(LockUnavailable)
        expect(waited.flat()).toContain('exponetdb/test/migrator')
        // The observer reads every holder: pg_monitor.
        await expect(
          takeTargetLock(b, TARGET, 'maintenance', { deadlineMs: 300 }),
        ).rejects.toBeInstanceOf(LockUnavailable)
        // Another database (another target) is not blocked: locks are per database.
        const releaseC = await takeTargetLock(c, TARGET, 'schema', { deadlineMs: 300 })
        await releaseC()
        await releaseA()
        // Maintenance first: schema waits for it, and so does a second maintenance.
        const releaseB = await takeTargetLock(b, TARGET, 'maintenance', { deadlineMs: 300 })
        await expect(
          takeTargetLock(a, TARGET, 'schema', { deadlineMs: 300 }),
        ).rejects.toBeInstanceOf(LockUnavailable)
        await expect(
          takeTargetLock(a, TARGET, 'maintenance', { deadlineMs: 300 }),
        ).rejects.toBeInstanceOf(LockUnavailable)
        await releaseB()
        // Nothing is left held after a refused attempt.
        const held = await a.query(
          (await import('../src/index.ts')).sql`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
            WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid()`,
        )
        expect(held[0]?.int('n')).toBe(0)
        const again = await takeTargetLock(a, TARGET, 'schema', { deadlineMs: 300 })
        await again()
      } finally {
        await a.close()
        await b.close()
        await c.close()
        await dropDatabase(server, db)
        await dropDatabase(server, other)
      }
    })

    it('ends a vanished migrator session and its lock on the server; reports the disconnect detection it has', async () => {
      const db = await prepareDatabase(server, `vl_drop_${server.major}`)
      const a = await open(server, db, 'migrator')
      const b = await open(server, db, 'operator')
      try {
        const detection = a.disconnectDetection
        expect(detection).toMatchObject({
          keepalivesIdleS: 30,
          keepalivesIntervalS: 10,
          keepalivesCount: 3,
        })
        // Linux servers support both; the values are what the server reports.
        expect([0, 60_000]).toContain(detection?.tcpUserTimeoutMs)
        expect([0, 10_000]).toContain(detection?.connectionCheckIntervalMs)
        await takeTargetLock(a, TARGET, 'schema')
        // The holder's backend ends (the server's view of a vanished client).
        await runAsSuperuser(server, db, [
          `SELECT pg_catalog.pg_terminate_backend(${a.facts.backendPid})`,
        ])
        const release = await takeTargetLock(b, TARGET, 'schema', { deadlineMs: 5000 })
        await release()
        const observer = await open(server, db, 'observer')
        expect(observer.disconnectDetection).toBeNull()
        await observer.close()
      } finally {
        await a.close()
        await b.close()
        await dropDatabase(server, db)
      }
    })

    it('resolves admitted checks on the target and runs them with the result contract', async () => {
      const db = await prepareDatabase(server, `vl_verify_${server.major}`, undefined, [
        'CREATE SCHEMA app',
        'CREATE TABLE app.leads (id int PRIMARY KEY, email text, tenant uuid)',
        `INSERT INTO app.leads VALUES (1, 'a@example.com', NULL), (2, NULL, NULL)`,
        'CREATE VIEW app.leads_view AS SELECT id FROM app.leads',
        `CREATE FUNCTION app.visible_leads(t uuid) RETURNS SETOF int LANGUAGE sql STABLE AS $$ SELECT id FROM app.leads WHERE tenant = t $$`,
        `CREATE FUNCTION app.twice(int) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$`,
        `CREATE FUNCTION app.twice(text) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$`,
        `CREATE FUNCTION app.definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
        'GRANT USAGE ON SCHEMA app TO exponetdb_verifier',
        'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO exponetdb_verifier',
      ])
      const observer = await open(server, db, 'observer')
      const verifier = await open(server, db, 'verifier')
      try {
        const text = `-- check: table exists
SELECT pg_catalog.to_regclass('app.leads') IS NOT NULL AS ok;
-- check: every lead has an email
SELECT email IS NOT NULL AS ok, 'lead ' || id || ' mail 1234567890123 x' AS detail FROM app.leads ORDER BY id;
-- check: nothing there
SELECT true AS ok FROM app.leads WHERE id < 0;
-- check: null is not ok
SELECT NULL::boolean AS ok;
-- check: too many
SELECT true AS ok FROM pg_catalog.generate_series(1, 1001);
-- check: not a boolean
SELECT 'yes'::text AS ok;
-- check: breaks
SELECT 1 / (id - id) = 1 AS ok FROM app.leads;
-- check: still runs after an error
-- calls: app.visible_leads(uuid)
SELECT count(*) = 0 AS ok FROM app.visible_leads('00000000-0000-0000-0000-000000000000');
-- check: a declared view
-- reads-view: app.leads_view
SELECT count(*) = 2 AS ok FROM app.leads_view;
`
        const checks = checksOf(server.major, text)
        const resolution = await observer.readOnly((tx) => resolveVerifyCatalog(tx, checks))
        expect(resolution).toMatchObject({ ok: true, checks: 9 })
        if (!resolution.ok) throw new Error('resolution')
        expect(resolution.consumer.map((c) => [c.check, c.kind, c.declared])).toEqual([
          [7, 'function', 'app.visible_leads(uuid)'],
          [8, 'view', 'app.leads_view'],
        ])
        const admitted = admitChecks(checks, resolution)
        expect(admitted.every(isAdmittedCheck)).toBe(true)
        expect(await verifier.readOnly((tx) => verifierProblems(tx))).toEqual([])
        const outcomes = await verifier.readOnly(async (tx) => {
          const out = []
          for (const check of admitted) out.push(await tx.runCheck(check))
          return out
        })
        expect(outcomes).toEqual([
          { status: 'passed' },
          { status: 'failed', reason: 'not_ok', detail: 'lead 2 mail <number> x' },
          { status: 'failed', reason: 'no_rows', detail: null },
          { status: 'failed', reason: 'null_ok', detail: null },
          { status: 'failed', reason: 'too_many_rows', detail: null },
          { status: 'error', reason: 'wrong_type', sqlstate: null },
          { status: 'error', reason: 'sql_error', sqlstate: '22012' },
          { status: 'passed' },
          { status: 'passed' },
        ])
        // The run changed nothing it could not: the transaction was read-only and rolled back.
        await expect(
          verifier.readOnly((tx) =>
            tx.runCheck({ kind: 'admitted_check', index: 0, name: 'x', text: 'SELECT true AS ok' }),
          ),
        ).rejects.toBeInstanceOf(TypeError)
        await expect(
          observer.readOnly((tx) => tx.runCheck(admitted[0] as never)),
        ).rejects.toBeInstanceOf(TypeError)
        await expect(verifier.runAdmittedCheck(admitted[0] as never)).rejects.toBeInstanceOf(
          TypeError,
        )

        // A changed consumer definition is noticed.
        await runAsSuperuser(server, db, [
          `CREATE OR REPLACE FUNCTION app.visible_leads(t uuid) RETURNS SETOF int LANGUAGE sql STABLE AS $$ SELECT id FROM app.leads WHERE tenant IS NOT DISTINCT FROM t $$`,
        ])
        const again = await observer.readOnly((tx) => resolveVerifyCatalog(tx, checks))
        if (!again.ok) throw new Error('resolution')
        expect(changedConsumerCode(resolution.consumer, again.consumer)).toEqual([
          'app.visible_leads(uuid)',
        ])
      } finally {
        await observer.close()
        await verifier.close()
        await dropDatabase(server, db)
      }
    })

    it('refuses what the names alone would admit: views, overloads, definers, shadowing built-ins', async () => {
      const db = await prepareDatabase(server, `vl_refuse_${server.major}`, undefined, [
        'CREATE SCHEMA app',
        'CREATE TABLE app.t (id int)',
        'CREATE VIEW app.v AS SELECT id FROM app.t',
        `CREATE FUNCTION app.twice(int) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$`,
        `CREATE FUNCTION app.twice(text) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$`,
        `CREATE FUNCTION app.definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
      ])
      const observer = await open(server, db, 'observer')
      try {
        const resolve = (text: string) =>
          observer.readOnly((tx) => resolveVerifyCatalog(tx, checksOf(server.major, text)))
        expect(await resolve('SELECT count(*) > 0 AS ok FROM app.v;')).toMatchObject({
          ok: false,
          reason: 'relation_kind',
          construct: 'app.v',
        })
        expect(await resolve('SELECT count(*) > 0 AS ok FROM app.missing;')).toMatchObject({
          ok: false,
          reason: 'relation_kind',
        })
        expect(
          await resolve('-- calls: app.twice(int)\nSELECT app.twice(1) = 2 AS ok;'),
        ).toMatchObject({ ok: false, reason: 'consumer_overloaded' })
        expect(
          await resolve('-- calls: app.definer()\nSELECT app.definer() = 1 AS ok;'),
        ).toMatchObject({
          ok: false,
          reason: 'consumer_security_definer',
        })
        expect(
          await resolve('-- calls: app.nothing()\nSELECT app.nothing() = 1 AS ok;'),
        ).toMatchObject({
          ok: false,
          reason: 'consumer_missing',
        })
        // A function in pg_catalog that initdb did not create shadows a built-in name.
        await runAsSuperuser(server, db, [
          `CREATE FUNCTION pg_catalog.lower(int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
        ])
        expect(await resolve(`SELECT lower('A') = 'a' AS ok;`)).toMatchObject({
          ok: false,
          reason: 'function',
          construct: 'pg_catalog.lower',
        })
        await runAsSuperuser(server, db, [
          'DROP FUNCTION pg_catalog.lower(int)',
          `CREATE CAST (uuid AS bigint) WITH INOUT`,
        ])
        expect(await resolve('SELECT true AS ok;')).toMatchObject({ ok: false, reason: 'cast' })
      } finally {
        await observer.close()
        await dropDatabase(server, db)
      }
    })

    it('finds verifier drift', async () => {
      const db = await prepareDatabase(server, `vl_drift_${server.major}`, undefined, [
        'CREATE TABLE public.w (id int)',
        'GRANT INSERT ON public.w TO exponetdb_verifier',
      ])
      const verifier = await open(server, db, 'verifier')
      try {
        expect(await verifier.readOnly((tx) => verifierProblems(tx))).toEqual(['write_privilege'])
      } finally {
        await verifier.close()
        await dropDatabase(server, db)
      }
    })
  },
)

describe('redaction of a failing detail', () => {
  it('masks e-mail addresses, long numbers and tokens, and removes control characters', () => {
    expect(
      redactDetail('user a.b@example.org\nid 123456789 key 3f9c2b1a4d5e6f708192a3b4c5d6e7f8 ok'),
    ).toBe('user <email> id <number> key <redacted> ok')
    expect(redactDetail('x'.repeat(500))).toHaveLength(200)
  })
})
