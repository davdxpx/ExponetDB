import { newId, systemClock } from '@exponetdb/kernel'
import { scratchResetSql } from '@exponetdb/migrations/format'
import {
  acceptPlan,
  KindRegistry,
  type OperationRecord,
  type PlanRecord,
  processNextOperation,
  readOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { MIGRATION_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import { ROLE_NAMES } from '@exponetdb/postgres'
import {
  findTarget,
  noBackupEngine,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planProjectUpdate,
  planTargetRegister,
  type RegistryActor,
  registryAcceptDependencies,
  registryKinds,
  type TargetRecord,
} from '@exponetdb/registry'
import { runAsSuperuser, serverFor, type TestServer, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actor,
  type Harness,
  harness,
  operationError,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  submit,
  targetDatabase,
  verifyCredentials,
} from '../../registry/test/harness.ts'
import {
  type MigrationPlanContext,
  migrationKinds,
  planImportAnalysis,
  scratchCheck,
} from '../src/index.ts'

/**
 * The scratch preflight (Wave 9 order A7, legacy-import.md §2.5) on real
 * PostgreSQL 17: a prepared scratch target passes every check; a scratch
 * target without the schema-only copy of an identity service's table and
 * function the imported schema depends on, without its extension, with an
 * execution role that cannot run, or already used by a replay, fails the
 * matching check with what is missing; a target that cannot be a scratch
 * target is named.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const suffix = Date.now().toString(36)
const slug = `sc${suffix}`
let clusterId = ''
let productId = ''
let projectId = ''
const OWNER = 'exdb_it_scratch_check_owner'

/** The imported target: a public schema that depends on an identity service's schema (outside the scope). */
const IMPORTED = [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public',
  // Embeddings, as in every Supabase-origin project that uses them: access methods and casts
  // without a schema of their own (follow-up 2, F2).
  'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public',
  'CREATE SCHEMA acme_identity',
  'CREATE TABLE acme_identity.users (id uuid PRIMARY KEY)',
  "CREATE FUNCTION acme_identity.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'",
  `SET ROLE ${OWNER}`,
  'CREATE TABLE public.acme_profiles (id uuid PRIMARY KEY, handle text NOT NULL)',
  'RESET ROLE',
  'ALTER TABLE public.acme_profiles ADD CONSTRAINT acme_profiles_user FOREIGN KEY (id) REFERENCES acme_identity.users (id)',
  'ALTER TABLE public.acme_profiles ENABLE ROW LEVEL SECURITY',
  'CREATE POLICY acme_own ON public.acme_profiles USING (id = acme_identity.uid())',
]
let imported: TargetRecord
let scratch: TargetRecord
let scratchDb = ''
let importedDb = ''

async function apply(p: PlanRecord): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.sc.accept', (tx) =>
    acceptPlan(
      tx,
      {
        planId: p.planId,
        actor: {
          kind: 'human',
          identityId: a.identityId,
          label: a.label,
          client: 'web',
          clientId: null,
        },
      },
      registryAcceptDependencies(tx, { policy: ctx.policy, kinds, systemActor: WORKER_ACTOR }, a),
    ),
  )
  if (result.status !== 'accepted') throw result.error
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(h.worker, { workerId, kinds, clock: systemClock })
    if (r.status === 'idle') break
  }
  const op = await readOperation(h.worker, result.operation.operationId)
  if (op === undefined) throw new Error('operation vanished')
  return op
}

async function registerTarget(envSlug: string, extra: readonly string[]): Promise<TargetRecord> {
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      slug: envSlug,
      displayName: envSlug,
      tier: 'nonprod',
    }),
  )
  const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const name = await targetDatabase(pg17, `sc_${envSlug}`, [
    // The execution role owns the database, as on real Supabase-origin installations: public
    // is its schema through pg_database_owner, which is no protected reach (ADR-0034 §3.1).
    `DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO %I', pg_catalog.current_database(), '${OWNER}'); END $$`,
    ...extra,
  ])
  if (envSlug === 'scratch') scratchDb = name
  else importedDb = name
  const databaseId = await registerDatabase(h, a, clusterId, name)
  const r = await run(h, a, (tx) =>
    planTargetRegister(tx, h.context, a, {
      projectId: projectId as never,
      environmentId: environmentId as never,
      databaseId: databaseId as never,
    }),
  )
  if (r.operation.state !== 'succeeded') {
    throw new Error(JSON.stringify(await operationError(h, r.operation.operationId)))
  }
  const t = await findTarget(h.worker, String((await planContent(h, r.plan.planId))['targetId']))
  if (t === undefined) throw new Error('target not registered')
  return t
}

beforeAll(async () => {
  h = await harness('exdb_it_scratch_check')
  a = actor()
  await runAsSuperuser(pg17, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF; END $$`,
  ])
  clusterId = await readyCluster(h, a, pg17)
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  await runAsSuperuser(pg17, 'postgres', [
    `GRANT ${OWNER} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
  ])
  ctx = {
    policy: {
      registry: new RuleRegistry([...REGISTRY_RULES, ...MIGRATION_RULES]),
      codeVersion: '0.1.0+test',
      clock: systemClock,
    },
    installationId: h.db.installationId,
    connector: h.serveConnector,
  }
  kinds = new KindRegistry([
    ...registryKinds({
      store: h.worker,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      controlStoreSystemIdentifier: async () => h.controlStoreSystemIdentifier,
      snapshots: h.snapshots,
      backupBindings: noBackupEngine,
    }),
    ...migrationKinds({
      store: h.worker,
      keyring: h.keyring,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      engineVersion: '0.1.0+test',
    }),
  ])
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Scratch check' }),
  )
  productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      managedScope: { includeSchemas: ['public'], excludeSchemas: [] },
    }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
  await run(h, a, (tx) =>
    planProjectUpdate(tx, h.context, a, projectId, { executionRoles: { owner: OWNER } }),
  )
  imported = await registerTarget('staging', IMPORTED)
  scratch = await registerTarget('scratch', [])
}, 240_000)

afterAll(async () => {
  await h?.close()
})

const check = (scratchRef: string) =>
  scratchCheck(
    h.worker,
    { connector: h.workerConnector, installationId: h.db.installationId },
    imported,
    scratchRef,
  )
const statusOf = (r: Awaited<ReturnType<typeof check>>) =>
  Object.fromEntries(r.checks.map((c) => [c.check, [c.status, c.detail]]))

describe('the scratch preflight', () => {
  it('names what the scratch target lacks: the extension, the objects outside the scope', async () => {
    const r = await check(scratch.targetId)
    expect(r.ready).toBe(false)
    expect(statusOf(r)).toEqual({
      scratch_usable: ['pass', null],
      identity: ['pass', null],
      empty: ['pass', null],
      extensions: ['fail', 'extensions_differ:2'],
      outside_scope: ['fail', 'missing:3'],
      execution_role: ['pass', null],
    })
    const items = Object.fromEntries(r.checks.map((c) => [c.check, c.items]))
    expect(items['extensions']).toEqual([
      expect.stringMatching(/^pg_trgm: target public@[0-9.]+, scratch missing$/),
      expect.stringMatching(/^vector: target public@[0-9.]+, scratch missing$/),
    ])
    // The foreign key needs the table and its unique index; the policy needs the function.
    expect(items['outside_scope']).toEqual([
      'function acme_identity.uid()',
      'relation acme_identity.users',
      'relation acme_identity.users_pkey',
    ])
  })

  it('passes once the scratch target is prepared like the imported one', async () => {
    await runAsSuperuser(pg17, scratchDb, [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public',
      'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public',
      // A schema-only copy of what the imported schema depends on outside its scope.
      'CREATE SCHEMA acme_identity',
      'CREATE TABLE acme_identity.users (id uuid PRIMARY KEY)',
      "CREATE FUNCTION acme_identity.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'",
    ])
    const r = await check(scratch.targetId)
    expect(statusOf(r)).toMatchObject({ extensions: ['pass', null], outside_scope: ['pass', null] })
    expect(r.ready).toBe(true)
    expect(r.copySchemas).toBeUndefined()
    // With the legacy files: what an old file names outside the scope that the imported
    // target's schema no longer depends on, as on the first real import (follow-up 2, F3).
    const history = [
      {
        name: '0013_members_own_read.sql',
        text: `CREATE TABLE public.acme_members (user_id uuid);
CREATE POLICY acme_members_own ON public.acme_members USING (user_id = (SELECT acme_identity.uid()));
CREATE POLICY acme_members_session ON public.acme_members USING (acme_identity.session_ok(user_id));
CREATE TABLE public.acme_audit (id uuid REFERENCES acme_identity.users (id));
`,
      },
      { name: '0014_drop.sql', text: 'DROP TABLE public.acme_members;\n' },
    ]
    const withFiles = await scratchCheck(
      h.worker,
      { connector: h.workerConnector, installationId: h.db.installationId },
      imported,
      scratch.targetId,
      'owner',
      history,
    )
    expect(withFiles.ready).toBe(false)
    expect(statusOf(withFiles)['legacy_references']).toEqual(['fail', 'missing:1'])
    expect(withFiles.checks.find((c) => c.check === 'legacy_references')?.items).toEqual([
      'function acme_identity.session_ok() (0013_members_own_read)',
    ])
    expect(withFiles.copySchemas).toEqual(['acme_identity'])
    await runAsSuperuser(pg17, scratchDb, [
      "CREATE FUNCTION acme_identity.session_ok(uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'",
    ])
    try {
      const prepared = await scratchCheck(
        h.worker,
        { connector: h.workerConnector, installationId: h.db.installationId },
        imported,
        scratch.targetId,
        'owner',
        history,
      )
      expect(statusOf(prepared)['legacy_references']).toEqual(['pass', null])
      expect(prepared.ready).toBe(true)
    } finally {
      await runAsSuperuser(pg17, scratchDb, ['DROP FUNCTION acme_identity.session_ok(uuid)'])
    }
    // And an analysis replays there (the preflight changed nothing).
    const p = await h.serve.transaction('test.sc.analyze', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: scratch.targetId,
        baseline: 'acme-scratch-2026',
        files: [
          {
            name: '0001_profiles.sql',
            text: 'CREATE TABLE public.acme_profiles (id uuid PRIMARY KEY, handle text NOT NULL);\n',
          },
        ],
        ledgers: [],
      }),
    )
    expect(p.decision).toBe('allow')
    expect((await apply(p)).state).toBe('succeeded')
  })

  it('reports a used scratch target and an unusable execution role', async () => {
    const used = await check(scratch.targetId)
    // The table the replay created, with its columns and key: each a catalog entry.
    expect(statusOf(used)['empty']).toEqual(['fail', 'objects:5'])
    expect(used.checks.find((c) => c.check === 'empty')?.items).toEqual(
      expect.arrayContaining([expect.stringMatching(/^table public\.acme_profiles/)]),
    )
    await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} CREATEDB`])
    try {
      const r = await check(scratch.targetId)
      expect(statusOf(r)['execution_role']).toEqual(['fail', 'privileged_attribute'])
    } finally {
      await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} NOCREATEDB`])
    }
  })

  it('resets the used scratch target in place: same database, same marker, ready again', async () => {
    const before = await withSuperuser(pg17, scratchDb, (c) =>
      c.query(
        `SELECT (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS oid,
                (SELECT target_id FROM exponetdb.target_identity) AS marker`,
      ),
    )
    const script = scratchResetSql({
      installationId: h.db.installationId,
      targetId: scratch.targetId,
      targetPath: scratch.path,
      generation: scratch.generation,
      includeSchemas: ['public'],
    })
    // The guard refuses any other database: here the imported target.
    await expect(runAsSuperuser(pg17, importedDb, [script])).rejects.toMatchObject({
      message: expect.stringContaining('is not the scratch target'),
    })
    // A view outside the scope on a table inside it would go with DROP SCHEMA ... CASCADE:
    // the reset refuses and names it, and drops nothing.
    await runAsSuperuser(pg17, scratchDb, [
      'CREATE VIEW acme_identity.profile_handles AS SELECT handle FROM public.acme_profiles',
    ])
    await expect(runAsSuperuser(pg17, scratchDb, [script])).rejects.toMatchObject({
      message: expect.stringMatching(
        /outside the managed scope depend on it and would be dropped \(1\): rule _RETURN on view acme_identity\.profile_handles$/,
      ),
    })
    await runAsSuperuser(pg17, scratchDb, ['DROP VIEW acme_identity.profile_handles'])
    // The casts and access methods of vector in public go with it and are re-created
    // (follow-up 2, F2); a member of it outside the scope would be dropped too: refused.
    await runAsSuperuser(pg17, scratchDb, [
      'CREATE TABLE acme_identity.exdb_vector_member (i int)',
      'ALTER EXTENSION vector ADD TABLE acme_identity.exdb_vector_member',
    ])
    await expect(runAsSuperuser(pg17, scratchDb, [script])).rejects.toMatchObject({
      message: expect.stringMatching(
        /would be dropped \(3\): table acme_identity\.exdb_vector_member, type acme_identity\.exdb_vector_member, type acme_identity\.exdb_vector_member\[\]$/,
      ),
    })
    await runAsSuperuser(pg17, scratchDb, [
      'ALTER EXTENSION vector DROP TABLE acme_identity.exdb_vector_member',
      'DROP TABLE acme_identity.exdb_vector_member',
    ])
    // A publication's member is no dependent worth refusing: the drop ends the membership only.
    await runAsSuperuser(pg17, scratchDb, [
      'CREATE PUBLICATION exdb_it_reset_pub FOR TABLE public.acme_profiles',
    ])
    // A schema name holding the script's own dollar-quote tag stays inside its literal.
    const hostile = 'x$reset$;COMMIT;CREATE TABLE public.exdb_breakout(i int);--'
    const tagged = scratchResetSql({
      installationId: h.db.installationId,
      targetId: scratch.targetId,
      targetPath: scratch.path,
      generation: scratch.generation,
      includeSchemas: ['public', hostile],
    })
    expect(tagged).toContain('DO $reset1$')
    await runAsSuperuser(pg17, scratchDb, [tagged])
    const breakout = await withSuperuser(pg17, scratchDb, (c) =>
      c.query(`SELECT pg_catalog.to_regclass('public.exdb_breakout') IS NULL AS absent`),
    )
    expect(breakout.rows[0]).toEqual({ absent: true })
    // An operator a replay left in a managed schema, with the exact types of a comparison the
    // script makes (oid = regclass), never runs as the superuser running it (review round 2).
    await runAsSuperuser(pg17, scratchDb, [
      'CREATE TABLE acme_identity.exdb_hijacked (n int)',
      `CREATE FUNCTION public.exdb_hijack(oid, regclass) RETURNS boolean LANGUAGE plpgsql AS $f$
         BEGIN INSERT INTO acme_identity.exdb_hijacked VALUES (1); RETURN $1 = $2::oid; END $f$`,
      'CREATE OPERATOR public.= (LEFTARG = oid, RIGHTARG = regclass, FUNCTION = public.exdb_hijack)',
    ])
    await runAsSuperuser(pg17, scratchDb, [script])
    const hijacked = await withSuperuser(pg17, scratchDb, (c) =>
      c.query('SELECT count(*)::int AS calls FROM acme_identity.exdb_hijacked'),
    )
    expect(hijacked.rows[0]).toEqual({ calls: 0 })
    // The database's owner may set standard_conforming_strings off for its database: a
    // backslash in a schema name then still never ends its literal (review of ADR-0034 §3.1).
    await runAsSuperuser(pg17, scratchDb, [
      `ALTER DATABASE "${scratchDb}" SET standard_conforming_strings = off`,
      `CREATE FUNCTION public.exdb_scs_hijack() RETURNS int LANGUAGE plpgsql AS $f$
         BEGIN INSERT INTO acme_identity.exdb_hijacked VALUES (3); RETURN 1; END $f$`,
    ])
    try {
      await runAsSuperuser(pg17, scratchDb, [
        scratchResetSql({
          installationId: h.db.installationId,
          targetId: scratch.targetId,
          targetPath: scratch.path,
          generation: scratch.generation,
          includeSchemas: [
            'public',
            'a\\',
            ']::text[];p int:=(SELECT public.exdb_scs_hijack());--',
          ],
        }),
      ])
    } finally {
      await runAsSuperuser(pg17, scratchDb, [
        `ALTER DATABASE "${scratchDb}" RESET standard_conforming_strings`,
      ])
    }
    const viaStrings = await withSuperuser(pg17, scratchDb, (c) =>
      c.query('SELECT count(*)::int AS calls FROM acme_identity.exdb_hijacked'),
    )
    expect(viaStrings.rows[0]).toEqual({ calls: 0 })
    // A replay that reached the ledger owner (a DO block's dynamic SET ROLE, OD-55) could put
    // a view in the marker's place whose condition runs a planted function as the superuser
    // (review round 3): the reset refuses before it reads the marker, and nothing runs.
    await runAsSuperuser(pg17, scratchDb, [
      `CREATE FUNCTION public.exdb_marker_hijack() RETURNS boolean LANGUAGE plpgsql AS $f$
         BEGIN INSERT INTO acme_identity.exdb_hijacked VALUES (2); RETURN true; END $f$`,
      'ALTER TABLE exponetdb.target_identity RENAME TO target_identity_kept',
      'CREATE VIEW exponetdb.target_identity AS SELECT * FROM exponetdb.target_identity_kept WHERE public.exdb_marker_hijack()',
      'ALTER VIEW exponetdb.target_identity OWNER TO exponetdb_ledger_owner',
    ])
    await expect(runAsSuperuser(pg17, scratchDb, [script])).rejects.toMatchObject({
      message: expect.stringContaining('is not as ExponetDB made it'),
    })
    const viaMarker = await withSuperuser(pg17, scratchDb, (c) =>
      c.query('SELECT count(*)::int AS calls FROM acme_identity.exdb_hijacked'),
    )
    expect(viaMarker.rows[0]).toEqual({ calls: 0 })
    await runAsSuperuser(pg17, scratchDb, [
      'DROP VIEW exponetdb.target_identity',
      'ALTER TABLE exponetdb.target_identity_kept RENAME TO target_identity',
      'DROP FUNCTION public.exdb_marker_hijack()',
    ])
    await runAsSuperuser(pg17, scratchDb, ['DROP TABLE acme_identity.exdb_hijacked'])
    const publication = await withSuperuser(pg17, scratchDb, (c) =>
      c.query(
        `SELECT (SELECT count(*)::int FROM pg_catalog.pg_publication WHERE pubname = 'exdb_it_reset_pub') AS kept,
                (SELECT count(*)::int FROM pg_catalog.pg_publication_tables WHERE pubname = 'exdb_it_reset_pub') AS members`,
      ),
    )
    expect(publication.rows[0]).toEqual({ kept: 1, members: 0 })
    await runAsSuperuser(pg17, scratchDb, ['DROP PUBLICATION exdb_it_reset_pub'])
    const after = await withSuperuser(pg17, scratchDb, (c) =>
      c.query(
        `SELECT (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS oid,
                (SELECT target_id FROM exponetdb.target_identity) AS marker,
                (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm') AS trgm,
                (SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'vector') AS vector,
                pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS owner_creates`,
        [OWNER],
      ),
    )
    expect(after.rows[0]).toEqual({ ...before.rows[0], trgm: 1, vector: 1, owner_creates: true })
    const r = await check(scratch.targetId)
    expect(r.ready, JSON.stringify(r.checks)).toBe(true)
    // The same target takes the next analysis.
    const p = await h.serve.transaction('test.sc.analyze_again', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: scratch.targetId,
        baseline: 'acme-scratch-2026',
        files: [
          {
            name: '0001_profiles.sql',
            text: 'CREATE TABLE public.acme_profiles (id uuid PRIMARY KEY, handle text NOT NULL);\n',
          },
        ],
        ledgers: [],
      }),
    )
    expect((await apply(p)).state).toBe('succeeded')
  })

  it('names a target that cannot be a scratch target, and checks nothing further', async () => {
    const same = await check(imported.targetId)
    expect(same.checks[0]).toMatchObject({
      check: 'scratch_usable',
      status: 'fail',
      detail: 'same_target',
    })
    expect(same.checks.slice(1).every((c) => c.status === 'unknown')).toBe(true)
    const none = await check('tgt_01M5GZZZZZZZZZZZZZZZZZZZZZ')
    expect(none).toMatchObject({ scratchTargetId: null, ready: false })
    expect(none.checks[0]).toMatchObject({ detail: 'not_found' })
  })
})
