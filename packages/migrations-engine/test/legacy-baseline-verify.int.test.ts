import { randomBytes } from 'node:crypto'
import type { MigrationPlanRequest } from '@exponetdb/contracts'
import { newId, newUlid, systemClock } from '@exponetdb/kernel'
import {
  acceptPlan,
  KindRegistry,
  type OperationRecord,
  type PlanRecord,
  processNextOperation,
  readOperation,
  requestVerificationRetry,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { MIGRATION_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import { ROLE_NAMES, TargetError } from '@exponetdb/postgres'
import {
  type Connector,
  findTarget,
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
import { matrix, runAsSuperuser, type TestServer, withRolesHeld } from '@exponetdb/testkit'
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
  decideImportItem,
  importReportView,
  type MigrationPlanContext,
  migrationDetail,
  migrationKinds,
  migrationStatus,
  planBaseline,
  planImportAnalysis,
  planMigrationApply,
  planMigrationVerify,
} from '../src/index.ts'

/**
 * A reviewed baseline passes its verification (Part A follow-up 3; the
 * first real baseline on `reos-db-01` could never pass): on PostgreSQL 16,
 * 17 and 18 a history whose files partly do not hold on the imported target
 * (row security enabled later by hand, a function body changed, a role's
 * attribute) is analyzed, a person accepts those files as applied, and the
 * baseline verifies with exactly those failures excused and named (F1, F2);
 * its schema becomes the drift reference (F4). A planned re-verification of
 * the baseline (F3) fails on a failure the review never saw and on a schema
 * change, and passes again once the cause is gone.
 */
const OWNER = 'exdb_it_bv_owner'
const BASELINE = 'acme-reviewed'

interface World {
  readonly h: Harness
  readonly a: RegistryActor
  readonly ctx: MigrationPlanContext
  readonly kinds: KindRegistry
  readonly imported: TargetRecord
  readonly scratch: TargetRecord
  readonly importedDb: string
  readonly role: string
  /** Each schema the worker recorded as a target's expected state for drift. */
  readonly expected: { readonly targetId: string; readonly fingerprint: string }[]
  /** While set, the worker cannot open the observer session a verification reads with. */
  readonly faults: { verifyUnreachable: boolean }
}

/** The worker's connector, with the observer session of a verification failing on request. */
function faulty(real: Connector, faults: World['faults']): Connector {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop !== 'forTarget' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (...args: Parameters<Connector['forTarget']>) => {
        if (faults.verifyUnreachable && args[1] === 'observer' && args[2].startsWith('verify/')) {
          throw new TargetError('TARGET_UNAVAILABLE', 'connection_lost')
        }
        return target.forTarget(...args)
      }
    },
  })
}

async function world(server: TestServer, role: string): Promise<World> {
  const h = await harness(`exdb_it_bv${server.major}`)
  const a = actor()
  const slug = `bv${server.major}${Date.now().toString(36)}`
  await withRolesHeld(server, () =>
    runAsSuperuser(server, 'postgres', [
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF; END $$`,
      // The role the history creates with LOGIN exists here without it (an F1 failure).
      `DROP ROLE IF EXISTS ${role}`,
      `CREATE ROLE ${role} NOLOGIN`,
    ]),
  )
  const clusterId = await readyCluster(h, a, server)
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  await runAsSuperuser(server, 'postgres', [
    `GRANT ${OWNER} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
  ])
  const policy = {
    registry: new RuleRegistry([...REGISTRY_RULES, ...MIGRATION_RULES]),
    codeVersion: '0.1.0+test',
    clock: systemClock,
  }
  const ctx: MigrationPlanContext = {
    policy,
    installationId: h.db.installationId,
    connector: h.serveConnector,
  }
  const expected: { targetId: string; fingerprint: string }[] = []
  const faults = { verifyUnreachable: false }
  const kinds = new KindRegistry([
    ...registryKinds({
      store: h.worker,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      controlStoreSystemIdentifier: async () => h.controlStoreSystemIdentifier,
      snapshots: h.snapshots,
    }),
    ...migrationKinds({
      store: h.worker,
      clock: systemClock,
      connector: faulty(h.workerConnector, faults),
      installationId: h.db.installationId,
      engineVersion: '0.1.0+test',
      expected: {
        record: async (input) => {
          expected.push({ targetId: input.targetId, fingerprint: input.fingerprint })
          return 'recorded'
        },
      },
    }),
  ])
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Reviewed baseline' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      managedScope: { includeSchemas: ['public'], excludeSchemas: [] },
    }),
  )
  const projectId = String((await planContent(h, project.plan.planId))['projectId'])
  await run(h, a, (tx) =>
    planProjectUpdate(tx, h.context, a, projectId, { executionRoles: { owner: OWNER } }),
  )
  const databases: Record<string, string> = {}
  const register = async (envSlug: string, extra: readonly string[]) => {
    const env = await run(h, a, (tx) =>
      planEnvironmentCreate(tx, h.context, a, productId, {
        slug: envSlug,
        displayName: envSlug,
        tier: 'nonprod',
      }),
    )
    const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
    const name = await targetDatabase(server, `bv_${envSlug}`, [
      `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER}`,
      // The history creates a schema of its own.
      `DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${OWNER}', current_database()); END $$`,
      ...extra,
    ])
    databases[envSlug] = name
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
  // The imported database as its history left it, and then changed by hand: row security was
  // never enabled, the function's body is another one.
  const imported = await register('imported', [
    'CREATE TABLE public.acme_items (id bigint PRIMARY KEY, name text NOT NULL)',
    `ALTER TABLE public.acme_items OWNER TO ${OWNER}`,
    'CREATE FUNCTION public.acme_touch() RETURNS int LANGUAGE plpgsql AS $f$BEGIN RETURN 2; END$f$',
    `ALTER FUNCTION public.acme_touch() OWNER TO ${OWNER}`,
    // A schema outside the managed scope the observer may not use: its checks raise
    // `permission denied for schema` (review P1-1; a Supabase history touches auth, storage).
    `CREATE SCHEMA acme_private AUTHORIZATION ${OWNER}`,
    'CREATE TABLE acme_private.things (id bigint)',
    `ALTER TABLE acme_private.things OWNER TO ${OWNER}`,
  ])
  const scratch = await register('scratch', [])
  return {
    h,
    a,
    ctx,
    kinds,
    imported,
    scratch,
    importedDb: databases['imported'] ?? '',
    role,
    expected,
    faults,
  }
}

const files = (role: string) => [
  {
    name: '0001_items.sql',
    text: 'CREATE TABLE public.acme_items (id bigint PRIMARY KEY, name text NOT NULL);\n',
  },
  {
    name: '0002_items_rls.sql',
    text: 'ALTER TABLE public.acme_items ENABLE ROW LEVEL SECURITY;\n',
  },
  {
    name: '0003_touch.sql',
    text: 'CREATE FUNCTION public.acme_touch() RETURNS int LANGUAGE plpgsql AS $f$BEGIN RETURN 1; END$f$;\n',
  },
  { name: '0004_role.sql', text: `CREATE ROLE ${role} LOGIN;\n` },
  {
    name: '0005_private.sql',
    text: 'CREATE SCHEMA acme_private;\nCREATE TABLE acme_private.things (id bigint);\n',
  },
  // A table the history created and dropped again: the first file is superseded.
  { name: '0006_scratch.sql', text: 'CREATE TABLE public.acme_scratch (id int);\n' },
  { name: '0007_scratch_gone.sql', text: 'DROP TABLE public.acme_scratch;\n' },
]

async function apply(w: World, p: PlanRecord): Promise<OperationRecord> {
  const result = await w.h.serve.transaction('test.bv.accept', (tx) =>
    acceptPlan(
      tx,
      {
        planId: p.planId,
        actor: {
          kind: 'human',
          identityId: w.a.identityId,
          label: w.a.label,
          client: 'web',
          clientId: null,
        },
      },
      registryAcceptDependencies(
        tx,
        { policy: w.ctx.policy, kinds: w.kinds, systemActor: WORKER_ACTOR },
        w.a,
      ),
    ),
  )
  if (result.status !== 'accepted') throw result.error
  return drive(w, result.operation.operationId)
}

async function drive(w: World, operationId: string): Promise<OperationRecord> {
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(w.h.worker, {
      workerId,
      kinds: w.kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') break
  }
  const op = await readOperation(w.h.worker, operationId)
  if (op === undefined) throw new Error('operation vanished')
  return op
}

/** The newest verification run of the baseline on the imported target (a live read). */
async function latestRun(w: World) {
  const detail = await migrationDetail(
    { store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId },
    w.imported,
    `baseline:${BASELINE}`,
  )
  const v = detail.verifications.at(-1)
  if (v === undefined) throw new Error('no verification run')
  return v
}

/** A bundle applied on top of the baseline (follow-up 4), as the project's owner. */
function bundle(spec: {
  readonly id: string
  readonly name: string
  readonly up: string
  readonly verify?: string
  readonly dependsOn: readonly string[]
}) {
  const yaml = [
    'schema: exponetdb.migration/v1',
    `id: ${spec.id}`,
    `name: ${spec.name}`,
    'description: "A change on top of the reviewed baseline."',
    `dependsOn: ${JSON.stringify(spec.dependsOn)}`,
    'execution:',
    '  transactional: true',
    'compatibility:',
    '  declared: additive',
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${spec.verify === undefined ? 'none' : 'verify.sql'}`,
    '',
  ].join('\n')
  return {
    directory: `${spec.id}_${spec.name}`,
    files: {
      'migration.yaml': yaml,
      'up.sql': spec.up,
      ...(spec.verify === undefined ? {} : { 'verify.sql': spec.verify }),
    },
  }
}

const applyBundles = async (w: World, bundles: readonly ReturnType<typeof bundle>[]) =>
  apply(
    w,
    await w.h.serve.transaction('test.bv.bundle', (tx) =>
      planMigrationApply(tx, w.ctx, w.a, w.imported.targetId, {
        defaults: {
          lockTimeout: '2s',
          statementTimeout: '15m',
          role: 'owner',
          searchPath: ['public'],
        },
        lintProfile: 'standard',
        bundles,
      } as MigrationPlanRequest),
    ),
  )

/** The imported rows' verification as `migration status` reads it: name → status and excusals. */
async function importedRows(w: World) {
  const s = await migrationStatus(
    { store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId },
    w.imported,
  )
  return Object.fromEntries(
    s.applied
      .filter((e) => e.origin === 'legacy_import')
      .map((e) => {
        const v = e.verification as {
          status: string
          via?: string
          excused?: number
          superseded?: true
        }
        return [e.name, [v.superseded === true ? 'superseded' : v.status, v.via, v.excused ?? 0]]
      }),
  )
}

const reverify = (w: World) =>
  w.h.serve.transaction('test.bv.reverify', (tx) =>
    planMigrationVerify(tx, w.ctx, w.a, w.imported.targetId, `baseline:${BASELINE}`, {}),
  )

describe.each(matrix().map((s) => [s.major, s] as const))(
  'a reviewed baseline on PostgreSQL %i',
  (_major, server) => {
    const role = `acme_bv_r${server.major}_${Date.now().toString(36)}`
    let w: World
    let reportId = ''

    beforeAll(async () => {
      w = await world(server, role)
    }, 300_000)

    afterAll(async () => {
      await w?.h.close()
      await withRolesHeld(server, () =>
        runAsSuperuser(server, 'postgres', [`DROP ROLE IF EXISTS ${role}`]),
      ).catch(() => undefined)
    })

    it('records what does not hold at the analysis, and shows what an accepting decision excuses', async () => {
      const p = await w.h.serve.transaction('test.bv.analyze', (tx) =>
        planImportAnalysis(tx, w.ctx, w.a, w.imported.targetId, {
          scratchTarget: w.scratch.targetId,
          baseline: BASELINE,
          files: files(role),
        }),
      )
      reportId = String((p.body['content'] as { reportId: string }).reportId)
      expect(await apply(w, p)).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
      const r = await w.h.worker.transaction('test.bv.report', (tx) =>
        importReportView(tx, w.imported.targetId, reportId),
      )
      const failing = Object.fromEntries(
        r.items
          .filter((i) => i.legacyId.startsWith('legacy:'))
          .map((i) => [i.name, i.failing?.items.map((f) => [f.kind, f.object, f.failed])]),
      )
      expect(failing).toEqual({
        '0001_items': [],
        '0002_items_rls': [['row_security', 'row security of "public"."acme_items"', ['enabled']]],
        '0003_touch': [['function', 'function "public"."acme_touch"()', ['body']]],
        '0004_role': [['role_attribute', `login on for role ${role}`, ['value']]],
        // Unreadable, not an error: recorded, so an acceptance excuses it explicitly.
        '0005_private': [
          ['expectations', 'structural expectations of 0005_private', ['unreadable']],
        ],
        '0006_scratch': [],
        '0007_scratch_gone': [],
      })
      // A person accepts the files as applied, and the drift the hand changes left as it is.
      for (const item of r.items.filter(
        (i) => i.decision === null && i.state !== 'unrecorded_present',
      )) {
        await w.h.serve.transaction('test.bv.decide', (tx) =>
          decideImportItem(tx, {
            targetId: w.imported.targetId,
            reportId,
            itemId: Number(item.itemId),
            state: item.name === '0006_scratch' ? 'superseded' : 'unrecorded_present',
            note: 'reviewed: changed by hand on the target, the intended state',
            identityId: w.a.identityId,
          }),
        )
      }
    })

    it('refuses a baseline of a report analyzed before failures were recorded (review P3-3)', async () => {
      // A report of the release before (failing null): its decisions would excuse anything.
      const item = '0002_items_rls'
      const kept = await w.h.db.asSuperuser(async (c) => {
        const r = await c.query(
          'SELECT failing::text AS failing FROM migrations.import_items WHERE report_id = $1 AND name = $2',
          [reportId, item],
        )
        await c.query(
          `BEGIN; SET LOCAL session_replication_role = replica;
           UPDATE migrations.import_items SET failing = NULL WHERE report_id = '${reportId}' AND name = '${item}';
           COMMIT`,
        )
        return String(r.rows[0]?.failing)
      })
      try {
        await expect(
          w.h.serve.transaction('test.bv.baseline', (tx) =>
            planBaseline(tx, w.ctx, w.a, w.imported.targetId, reportId),
          ),
        ).rejects.toMatchObject({ code: 'LEGACY_IMPORT_ANALYSIS_OUTDATED', details: { items: 1 } })
      } finally {
        await w.h.db.asSuperuser((c) =>
          c.query(
            `BEGIN; SET LOCAL session_replication_role = replica;
             UPDATE migrations.import_items SET failing = '${kept}'::jsonb WHERE report_id = '${reportId}' AND name = '${item}';
             COMMIT`,
          ),
        )
      }
    })

    it('baselines and verifies, the reviewed failures excused and named, and adopts the schema for drift (F1, F2, F4)', async () => {
      const p = await w.h.serve.transaction('test.bv.baseline', (tx) =>
        planBaseline(tx, w.ctx, w.a, w.imported.targetId, reportId),
      )
      expect(await apply(w, p)).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
      const v = await latestRun(w)
      expect(v.status).toBe('passed')
      expect(v.structural).toMatchObject({
        status: 'passed',
        failed: 0,
        excused: 4,
        failuresTotal: 4,
      })
      expect(v.structural.failures?.map((f) => [f.file, f.failed, f.excused])).toEqual([
        ['0002_items_rls', ['enabled'], true],
        ['0003_touch', ['body'], true],
        ['0004_role', ['value'], true],
        ['0005_private', ['unreadable'], true],
      ])
      expect(v.engine.status).toBe('passed')
      expect(w.expected).toEqual([{ targetId: w.imported.targetId, fingerprint: v.fingerprint }])
      // Each imported row is verified by the baseline, never "pending" (follow-up 4 addendum).
      const via = `baseline:${BASELINE}`
      expect(await importedRows(w)).toEqual({
        '0001_items': ['passed', via, 0],
        '0002_items_rls': ['passed', via, 1],
        '0003_touch': ['passed', via, 1],
        '0004_role': ['passed', via, 1],
        '0005_private': ['passed', via, 1],
        // Decided superseded: not checked by the baseline, and it says so.
        '0006_scratch': ['superseded', via, 0],
        '0007_scratch_gone': ['passed', via, 0],
      })
    })

    it('fails a planned re-verification on a failure the review never saw, and passes once it is gone (F3)', async () => {
      await withRolesHeld(server, () => runAsSuperuser(server, 'postgres', [`DROP ROLE ${role}`]))
      const failed = await apply(w, await reverify(w))
      expect(failed).toMatchObject({ kind: 'migration.verify', state: 'verification_failed' })
      const v = await latestRun(w)
      expect(v.structural.failed).toBe(1)
      // The role is missing: not what the person accepted. Its attribute still fails as reviewed.
      expect(
        v.structural.failures
          ?.filter((f) => f.file === '0004_role')
          .map((f) => [f.kind, f.excused]),
      ).toEqual([
        ['role', false],
        ['role_attribute', true],
      ])
      // Only the file with the open failure reads as failed; the others' share passed.
      const rows = await importedRows(w)
      expect(rows['0004_role']?.[0]).toBe('failed')
      expect(rows['0001_items']?.[0]).toBe('passed')
      expect(w.expected).toHaveLength(1)
      await withRolesHeld(server, () =>
        runAsSuperuser(server, 'postgres', [`CREATE ROLE ${role} NOLOGIN`]),
      )
      const passed = await apply(w, await reverify(w))
      expect(passed).toMatchObject({
        kind: 'migration.verify',
        state: 'succeeded',
        verificationOutcome: 'passed',
      })
      expect((await latestRun(w)).structural).toMatchObject({ failed: 0, excused: 4 })
      expect(w.expected).toHaveLength(2)
    })

    it('fails a re-verification of a target whose managed schema changed since the baseline', async () => {
      await runAsSuperuser(server, w.importedDb, ['CREATE TABLE public.acme_extra (id int)'])
      try {
        expect(await apply(w, await reverify(w))).toMatchObject({ state: 'verification_failed' })
        const v = await latestRun(w)
        expect(v.engine).toMatchObject({
          status: 'failed',
          firstFailure: { name: 'schema fingerprint' },
        })
        expect(w.expected).toHaveLength(2)
      } finally {
        await runAsSuperuser(server, w.importedDb, ['DROP TABLE public.acme_extra'])
      }
    })

    it('verifies a re-verification that errored again on an operator request, and releases the target (review P1-1)', async () => {
      w.faults.verifyUnreachable = true
      let op: OperationRecord
      try {
        op = await apply(w, await reverify(w))
      } finally {
        w.faults.verifyUnreachable = false
      }
      // Before the review this held the target's schema domain with no way to release it.
      expect(op).toMatchObject({
        kind: 'migration.verify',
        state: 'needs_attention',
        applyOutcome: 'applied',
        verificationOutcome: 'error',
      })
      const operator = newId('idn', Date.now())
      await w.h.db.asSuperuser((c) =>
        c.query(
          `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
           VALUES ($1, 'human', 'invited', $2, $2, $3)`,
          [operator, `operator-${server.major}@example.test`, randomBytes(32)],
        ),
      )
      await w.h.serve.transaction('test.bv.retry', (tx) =>
        requestVerificationRetry(tx, op.operationId, operator),
      )
      expect(await drive(w, op.operationId)).toMatchObject({
        state: 'succeeded',
        verificationOutcome: 'passed',
      })
      expect((await latestRun(w)).structural).toMatchObject({ failed: 0, excused: 4 })
      expect(w.expected).toHaveLength(3)
      const held = await w.h.worker.query(
        'test.bv.locks',
        'SELECT count(*)::int AS n FROM operations.operation_locks WHERE operation_id = $1',
        [op.operationId],
      )
      expect(held.rows[0]?.int('n')).toBe(0)
    })

    // Follow-up 4: the bundles applied on top of the baseline, in order.
    const first = newUlid(Date.now())
    const second = newUlid(Date.now() + 1)

    it('accepts the schema a verified bundle on top of the baseline left, and keeps the drift reference (follow-up 4)', async () => {
      // The bundle changes a table the history created: the history's column expectation of
      // it is superseded by the bundle, whose own verification checked what it left.
      const applied = await applyBundles(w, [
        bundle({
          id: first,
          name: 'acme-notes',
          up: 'ALTER TABLE public.acme_items ADD COLUMN note text;\nCREATE TABLE public.acme_more (id bigint PRIMARY KEY);\n',
          dependsOn: [`baseline:${BASELINE}`],
        }),
      ])
      expect(applied).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      const reference = w.expected.length
      const passed = await apply(w, await reverify(w))
      expect(passed).toMatchObject({
        kind: 'migration.verify',
        state: 'succeeded',
        verificationOutcome: 'passed',
      })
      const v = await latestRun(w)
      expect(v.engine).toMatchObject({
        status: 'passed',
        firstFailure: null,
        acceptedThrough: { migrations: 1, last: first },
      })
      expect(v.structural).toMatchObject({ failed: 0, excused: 4 })
      // The drift reference stays the bundle's (newest verified) schema.
      expect(w.expected).toHaveLength(reference)
      expect(w.expected.at(-1)?.fingerprint).toBe(v.fingerprint)
    })

    it('fails while a bundle after the baseline is not verified, and passes once it is', async () => {
      const failed = await applyBundles(w, [
        bundle({
          id: second,
          name: 'acme-flags',
          up: 'CREATE TABLE public.acme_flags (id bigint);\n',
          verify: '-- check: a flag exists\nSELECT count(*) > 0 AS ok FROM public.acme_flags;\n',
          dependsOn: [first],
        }),
      ])
      expect(failed).toMatchObject({ state: 'verification_failed', applyOutcome: 'applied' })
      expect(await apply(w, await reverify(w))).toMatchObject({ state: 'verification_failed' })
      expect((await latestRun(w)).engine).toMatchObject({
        status: 'failed',
        firstFailure: {
          name: `schema after the baseline: ${second}`,
          detail: 'its latest verification is failed',
        },
      })
      // Its data fixed, the bundle verifies, and so does the baseline again.
      await runAsSuperuser(server, w.importedDb, ['INSERT INTO public.acme_flags VALUES (1)'])
      const verified = await apply(
        w,
        await w.h.serve.transaction('test.bv.verify', (tx) =>
          planMigrationVerify(tx, w.ctx, w.a, w.imported.targetId, second, {}),
        ),
      )
      expect(verified).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      const reference = w.expected.length
      expect(await apply(w, await reverify(w))).toMatchObject({ state: 'succeeded' })
      expect((await latestRun(w)).engine).toMatchObject({
        acceptedThrough: { migrations: 2, last: second },
      })
      expect(w.expected).toHaveLength(reference)
    })

    it('fails on a change by hand after the last verified bundle', async () => {
      await runAsSuperuser(server, w.importedDb, ['CREATE TABLE public.acme_by_hand (id int)'])
      try {
        expect(await apply(w, await reverify(w))).toMatchObject({ state: 'verification_failed' })
        expect((await latestRun(w)).engine).toMatchObject({
          status: 'failed',
          firstFailure: {
            name: `schema after the baseline: ${second}`,
            detail: 'the live schema is not the one the last verified migration left',
          },
        })
      } finally {
        await runAsSuperuser(server, w.importedDb, ['DROP TABLE public.acme_by_hand'])
      }
      expect(await apply(w, await reverify(w))).toMatchObject({ state: 'succeeded' })
    })

    it('refuses to re-verify a baseline the target does not hold', async () => {
      await expect(
        w.h.serve.transaction('test.bv.reverify', (tx) =>
          planMigrationVerify(tx, w.ctx, w.a, w.imported.targetId, 'baseline:acme-other', {}),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  },
)
