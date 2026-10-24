import {
  dropDatabase,
  matrix,
  runAsSuperuser,
  type TestServer,
  withSuperuser,
} from '@exponetdb/testkit'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  changedGuards,
  checkExpectations,
  executionRoleFacts,
  executionRoleProblem,
  ident,
  insertLedgerRow,
  insertMigrationEvent,
  isReviewedStatement,
  lockMarker,
  pinSearchPath,
  REACHES_PROTECTED_ROLE,
  ReviewRefused,
  readEngineGuards,
  readLedgerRows,
  readMigrationEvents,
  reviewedStatements,
  type SupportedMajor,
  snapshotWithin,
  sql,
  stampTarget,
  TargetError,
  type TargetSession,
  takeSchemaLock,
  takeSnapshot,
} from '../src/index.ts'
import {
  analyzeMigrationSql,
  loadParser,
  SUPPORTED_MAJORS,
  survivingExpectations,
} from '../src/parser/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * The adapter's execution path of a transactional migration on PostgreSQL
 * 16, 17 and 18 (planning-and-apply.md §4.3, verification.md L0): reviewed
 * statements on a migrator session inside `SET LOCAL ROLE` of a declared
 * NOLOGIN owner, guards read around each statement, the structural
 * expectations in the same transaction, the in-transaction fingerprint, the
 * ledger row and its event; a wrong pre-existing shape fails L0 and rolls
 * back; a changed guard is noticed.
 */
const INSTALLATION = 'ins_01M4A000000000000000000001'
const TARGET = 'tgt_01M4A000000000000000000020'
const OPERATION = 'op_01M4A000000000000000000021'

async function prepared(server: TestServer, label: string): Promise<string> {
  const db = await prepareDatabase(server, label)
  await runAsSuperuser(server, db, [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN CREATE ROLE app_owner NOLOGIN; END IF;
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_login') THEN CREATE ROLE app_login LOGIN; END IF;
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_inherits') THEN CREATE ROLE app_inherits NOLOGIN; END IF;
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_reacher') THEN CREATE ROLE app_reacher NOLOGIN; END IF;
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mx_member') THEN CREATE ROLE mx_member NOLOGIN; END IF;
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_db_owner') THEN CREATE ROLE app_db_owner NOLOGIN; END IF;
     END $$`,
    'GRANT app_owner TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE',
    'GRANT app_db_owner TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE',
    // Memberships of a shape the migrator must never have are made for another
    // role (the servers are shared with the registry's credential checks).
    'GRANT app_inherits TO mx_member WITH INHERIT TRUE, SET TRUE',
    'GRANT app_owner TO mx_member WITH INHERIT FALSE, SET TRUE',
    'GRANT pg_read_all_data TO app_reacher',
    'GRANT app_reacher TO mx_member WITH INHERIT FALSE, SET TRUE',
    'GRANT CREATE, USAGE ON SCHEMA public TO app_owner',
  ])
  const migrator = await open(server, db, 'migrator')
  try {
    const release = await takeSchemaLock(migrator, TARGET)
    await stampTarget(
      migrator,
      {
        databaseOid: migrator.facts.databaseOid,
        installationId: INSTALLATION,
        targetId: TARGET,
        targetPath: 'acme/app/staging',
        tier: 'nonprod',
        generation: 1,
        operationId: OPERATION,
        projectId: 'prj_01M4A000000000000000000022',
      },
      migrator.facts.systemIdentifier,
    )
    await release()
  } finally {
    await migrator.close()
  }
  return db
}

const UP = `-- a comment before the first statement
CREATE TABLE leads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(200) NOT NULL,
  note text
);
CREATE INDEX leads_email_idx ON leads (email);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE leads IS 'Leads';
`

interface Applied {
  readonly results: Awaited<ReturnType<typeof checkExpectations>>
  readonly fingerprint: string
}

/** One migration, transactional, the way the executor runs it. */
async function applyOnce(
  migrator: TargetSession,
  major: SupportedMajor,
  text: string,
  migrationId: string,
  role = 'app_owner',
): Promise<Applied> {
  const analysis = analyzeMigrationSql(major, text)
  const statements = reviewedStatements(text, analysis)
  if (!analysis.ok) throw new Error('parse')
  await migrator.query(sql`BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`)
  let committed = false
  try {
    await lockMarker(migrator, {
      installationId: INSTALLATION,
      targetId: TARGET,
      generation: 1,
      systemIdentifier: migrator.facts.systemIdentifier,
    })
    const reader = migrator.reader()
    await pinSearchPath(reader, ['public'])
    await migrator.query(sql`SET LOCAL ROLE ${ident(role)}`)
    const before = await readEngineGuards(reader)
    expect(before.currentUser).toBe(role)
    for (const statement of statements) {
      await migrator.executeReviewed(statement)
      expect(changedGuards(before, await readEngineGuards(reader))).toEqual([])
    }
    await migrator.query(sql`RESET ROLE`)
    const results = await checkExpectations(reader, survivingExpectations(analysis.statements))
    if (!results.every((r) => r.ok)) {
      return { results, fingerprint: '' }
    }
    const snapshot = await snapshotWithin(reader, { includeSchemas: ['public'] })
    await insertLedgerRow(migrator, {
      migrationId,
      origin: 'exponetdb',
      name: 'add-leads',
      checksum: `sha256:c1:${'a'.repeat(64)}`,
      checksumProvenance: 'computed_at_apply',
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      verifyDigest: null,
      rollbackDigest: null,
      manifest: { transactional: true },
      dependencies: ['baseline:none'],
      transactional: true,
      source: null,
      applyDurationMs: 12,
      planId: 'pln_01M4A000000000000000000023',
      operationId: OPERATION,
      actorRef: 'idn_01M4A000000000000000000024',
      clientRef: null,
      engineVersion: 'test',
      pgVersionNum: migrator.facts.serverVersionNum,
      fingerprintBefore: null,
      fingerprintAfter: snapshot.fingerprint,
    })
    await insertMigrationEvent(migrator, { migrationId, operationId: OPERATION, event: 'applied' })
    await migrator.query(sql`COMMIT`)
    committed = true
    return { results, fingerprint: snapshot.fingerprint }
  } finally {
    if (!committed && migrator.usable) {
      await migrator.query(sql`ROLLBACK`).catch(() => undefined)
    }
  }
}

beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

describe.each(matrix().map((s) => [s.major, s] as const))(
  'the migration execution path on PostgreSQL %i',
  (_m, server) => {
    it('lets an execution role own its database, and keeps every other predefined role protected (pg_database_owner)', async () => {
      const db = await prepared(server, `mx_dbo_${server.major}`)
      // As Supabase-origin and most self-managed installations: the owner owns the database,
      // and so, through pg_database_owner, its public schema.
      await runAsSuperuser(server, db, [`ALTER DATABASE "${db}" OWNER TO app_db_owner`])
      const reach = (database: string) =>
        withSuperuser(server, database, async (c) => {
          const r = await c.query(
            `SELECT r.rolname AS role, ${REACHES_PROTECTED_ROLE.text} AS protected,
                    pg_catalog.pg_has_role(r.oid, 'pg_database_owner', 'MEMBER') AS owns_here
               FROM pg_catalog.pg_roles r WHERE r.rolname = ANY ($1) ORDER BY 1`,
            [['app_db_owner', 'app_reacher']],
          )
          return r.rows
        })
      // Inside the database the owner is an implicit member of pg_database_owner; that is no
      // protected reach, and the answer is the same in postgres, where the bootstrap SQL runs.
      const inside = await reach(db)
      expect(inside).toEqual([
        { role: 'app_db_owner', protected: false, owns_here: true },
        { role: 'app_reacher', protected: true, owns_here: false },
      ])
      expect((await reach('postgres')).map((r) => [r.role, r.protected])).toEqual(
        inside.map((r) => [r.role, r.protected]),
      )
      const migrator = await open(server, db, 'migrator')
      try {
        const [owner] = await executionRoleFacts(migrator.reader(), ['app_db_owner'])
        expect(owner?.reachesProtected).toBe(false)
        expect(owner === undefined ? 'missing' : executionRoleProblem(owner)).toBe(null)
        const applied = await applyOnce(
          migrator,
          server.major,
          UP,
          '01M4A00000000000000000003D',
          'app_db_owner',
        )
        expect(applied.results.filter((r) => !r.ok)).toEqual([])
        const owned = await migrator.query(
          sql`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner FROM pg_catalog.pg_class c
               WHERE c.oid = 'public.leads'::pg_catalog.regclass`,
        )
        expect(owned[0]?.text('owner')).toBe('app_db_owner')
      } finally {
        await migrator.close()
      }
      // A role that owns the database and reaches pg_read_all_data is still refused there.
      await runAsSuperuser(server, db, [`ALTER DATABASE "${db}" OWNER TO app_reacher`])
      const reacher = await open(server, db, 'migrator')
      try {
        const [facts] = await executionRoleFacts(reacher.reader(), ['app_reacher'], 'mx_member')
        expect(facts === undefined ? 'missing' : executionRoleProblem(facts)).toBe(
          'reaches_protected_role',
        )
      } finally {
        await reacher.close()
      }
      await runAsSuperuser(server, 'postgres', [`ALTER DATABASE "${db}" OWNER TO postgres`])
      await dropDatabase(server, db)
    })

    it('applies a migration as the declared owner, checks L0 in the transaction and records the ledger row', async () => {
      const db = await prepared(server, `mx_${server.major}`)
      const migrator = await open(server, db, 'migrator')
      try {
        const facts = await executionRoleFacts(migrator.reader(), [
          'app_owner',
          'app_login',
          'exponetdb_migrator',
          'no_such_role',
        ])
        expect(facts.map((f) => executionRoleProblem(f))).toEqual([
          null,
          'can_login',
          'exponetdb_role',
          'missing',
        ])
        const other = await executionRoleFacts(
          migrator.reader(),
          ['app_owner', 'app_inherits', 'app_reacher'],
          'mx_member',
        )
        expect(other.map((f) => executionRoleProblem(f))).toEqual([
          null,
          'membership_inherits',
          'reaches_protected_role',
        ])
        // The planner reads the same facts as the observer, for the migrator.
        const observer0 = await open(server, db, 'observer')
        try {
          const seen = await observer0.readOnly((tx) =>
            executionRoleFacts(tx, ['app_owner', 'app_inherits'], 'exponetdb_migrator'),
          )
          expect(seen.map((f) => executionRoleProblem(f))).toEqual([null, 'not_a_member'])
        } finally {
          await observer0.close()
        }
        const migrationId = '01M4A00000000000000000003A'
        const applied = await applyOnce(migrator, server.major, UP, migrationId)
        expect(applied.results.length).toBeGreaterThan(5)
        expect(applied.results.filter((r) => !r.ok)).toEqual([])
        const rows = await readLedgerRows(migrator.reader())
        expect(rows.map((r) => [r.migrationId, r.operationId, r.fingerprintAfter])).toEqual([
          [migrationId, OPERATION, applied.fingerprint],
        ])
        expect(rows[0]?.dependencies).toEqual(['baseline:none'])
        expect(
          (await readMigrationEvents(migrator.reader(), { migrationId })).map((e) => e.event),
        ).toEqual(['applied'])
        // The fingerprint inside the transaction is what a fresh observer sees after commit.
        const observer = await open(server, db, 'observer')
        try {
          expect((await takeSnapshot(observer, { includeSchemas: ['public'] })).fingerprint).toBe(
            applied.fingerprint,
          )
        } finally {
          await observer.close()
        }
        // The owner owns what it created; the migrator gained nothing implicitly.
        const owner = await migrator.query(
          sql`SELECT pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class WHERE oid = 'public.leads'::regclass`,
        )
        expect(owner[0]?.text('owner')).toBe('app_owner')
        await expect(migrator.query(sql`SELECT count(*) FROM public.leads`)).rejects.toBeInstanceOf(
          TargetError,
        )
      } finally {
        await migrator.close()
        await dropDatabase(server, db)
      }
    })

    it('fails L0 when IF NOT EXISTS met an object of another shape, and rolls everything back', async () => {
      const db = await prepared(server, `mx_l0_${server.major}`)
      await runAsSuperuser(server, db, [
        'CREATE TABLE public.leads (id bigint, other text)',
        'ALTER TABLE public.leads OWNER TO app_owner',
      ])
      const migrator = await open(server, db, 'migrator')
      try {
        const text =
          'CREATE TABLE IF NOT EXISTS leads (id bigint, email text NOT NULL);\nCREATE INDEX leads_id_idx ON leads (id);\n'
        const applied = await applyOnce(migrator, server.major, text, '01M4A00000000000000000003B')
        const failed = applied.results.filter((r) => !r.ok).map((r) => r.description)
        expect(failed.length).toBeGreaterThan(0)
        expect(failed.join(' ')).toContain('leads')
        // Nothing of the migration survived the rollback: no index, no ledger row.
        const index = await migrator.query(
          sql`SELECT pg_catalog.to_regclass('public.leads_id_idx') IS NULL AS absent`,
        )
        expect(index[0]?.bool('absent')).toBe(true)
        expect(await readLedgerRows(migrator.reader())).toEqual([])
      } finally {
        await migrator.close()
        await dropDatabase(server, db)
      }
    })

    it('notices a statement that changes an engine setting through a function, and never accepts unreviewed text', async () => {
      const db = await prepared(server, `mx_guard_${server.major}`)
      await runAsSuperuser(server, db, [
        `CREATE FUNCTION public.loosen() RETURNS void LANGUAGE sql AS $$ SELECT pg_catalog.set_config('lock_timeout', '0', true) $$`,
        'GRANT EXECUTE ON FUNCTION public.loosen() TO app_owner',
      ])
      const migrator = await open(server, db, 'migrator')
      try {
        const text = 'SELECT public.loosen();\n'
        const analysis = analyzeMigrationSql(server.major, text)
        const [statement] = reviewedStatements(text, analysis)
        if (statement === undefined) throw new Error('no statement')
        expect(isReviewedStatement(statement)).toBe(true)
        await migrator.query(sql`BEGIN`)
        await migrator.query(sql`SELECT pg_catalog.set_config('lock_timeout', '5s', true)`)
        await migrator.query(sql`SET LOCAL ROLE app_owner`)
        const before = await readEngineGuards(migrator.reader())
        await migrator.executeReviewed(statement)
        expect(changedGuards(before, await readEngineGuards(migrator.reader()))).toEqual([
          'lockTimeout',
        ])
        await migrator.query(sql`ROLLBACK`)
        // Forbidden content never becomes a reviewed statement.
        const forbidden = 'SET ROLE app_owner;\n'
        expect(() =>
          reviewedStatements(forbidden, analyzeMigrationSql(server.major, forbidden)),
        ).toThrow(ReviewRefused)
        // A plain object is no reviewed statement; another role never runs one.
        await expect(
          migrator.executeReviewed({
            kind: 'reviewed_sql',
            index: 0,
            text: 'SELECT 1',
            autocommitOnly: false,
            line: 1,
          }),
        ).rejects.toBeInstanceOf(TypeError)
        const observer = await open(server, db, 'observer')
        try {
          await expect(observer.executeReviewed(statement)).rejects.toBeInstanceOf(TypeError)
        } finally {
          await observer.close()
        }
      } finally {
        await migrator.close()
        await dropDatabase(server, db)
      }
    })
  },
)
