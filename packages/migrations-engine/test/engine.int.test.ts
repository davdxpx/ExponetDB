import type { BundleSubmission, MigrationPlanRequest } from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { newId, newUlid, systemClock } from '@exponetdb/kernel'
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
import { readLedgerRows, readMigrationEvents, readVerifications } from '@exponetdb/postgres'
import { loadParser } from '@exponetdb/postgres/parser'
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
import { runAsSuperuser, serverFor, superuserClient, type TestServer } from '@exponetdb/testkit'
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
  ingestBundles,
  type MigrationPlanContext,
  migrationKinds,
  planMigrationApply,
  planMigrationResume,
  planMigrationRollback,
  planMigrationVerify,
  readProgress,
} from '../src/index.ts'
import { runtimeLayer } from '../src/verification.ts'

/**
 * The migration engine end to end on real PostgreSQL 17 (G6 order §19 to
 * §29): bundles ingested and re-hashed by the server, a plan bound to the
 * live target, acceptance through the Operations Engine, the worker's
 * execution as the declared owner under the target lock with L0 in the
 * transaction, verification L1 to L3 with verify.sql on the verifier
 * connection, the ledger, the mirror and the per-migration progress.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const slug = `mig${Date.now().toString(36)}`
let clusterId = ''
let productId = ''
let projectId = ''
let staging: TargetRecord
let production: TargetRecord

const OWNER = 'exdb_it_app_owner'

let last = ''
/** A fresh migration id, strictly increasing within the run. */
function ulid(): string {
  let id = newUlid(Date.now())
  while (id <= last) id = newUlid(Date.now())
  last = id
  return id
}

function bundle(spec: {
  readonly id?: string
  readonly name?: string
  readonly up: string
  readonly verify?: string | null
  readonly dependsOn?: readonly string[]
  readonly declared?: string
  readonly transactional?: boolean
  readonly down?: string
}): BundleSubmission {
  const id = spec.id ?? ulid()
  const name = spec.name ?? 'change'
  const verify = spec.verify === undefined ? null : spec.verify
  const yaml = [
    'schema: exponetdb.migration/v1',
    `id: ${id}`,
    `name: ${name}`,
    'description: "Adds what the lead inbox needs, tested on staging first."',
    `dependsOn: ${JSON.stringify(spec.dependsOn ?? [])}`,
    'execution:',
    `  transactional: ${spec.transactional ?? true}`,
    'compatibility:',
    `  declared: ${spec.declared ?? 'additive'}`,
    ...(spec.declared !== undefined && spec.declared !== 'additive' ? ['  notes: reviewed'] : []),
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${verify === null ? 'none' : 'verify.sql'}`,
    ...(spec.down === undefined
      ? []
      : ['rollback:', '  script: down.sql', '  safety: safe', '  notes: reviewed']),
    '',
  ].join('\n')
  return {
    directory: `${id}_${name}`,
    files: {
      'migration.yaml': yaml,
      'up.sql': spec.up,
      ...(verify === null ? {} : { 'verify.sql': verify }),
      ...(spec.down === undefined ? {} : { 'down.sql': spec.down }),
    },
  }
}

const DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '15m',
  role: 'owner',
  searchPath: ['public'],
}

function plan(target: TargetRecord, request: Partial<MigrationPlanRequest>): Promise<PlanRecord> {
  return h.serve.transaction('test.migrations.plan', (tx: Tx) =>
    planMigrationApply(tx, ctx, a, target.targetId, {
      defaults: DEFAULTS,
      lintProfile: 'standard',
      ...request,
    } as MigrationPlanRequest),
  )
}

async function accept(p: PlanRecord): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.migrations.accept', (tx) =>
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
  return result.operation
}

async function drive(): Promise<void> {
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(h.worker, { workerId, kinds, clock: systemClock })
    if (r.status === 'idle') return
  }
  throw new Error('the worker did not become idle')
}

async function apply(p: PlanRecord): Promise<OperationRecord> {
  const accepted = await accept(p)
  await drive()
  const op = await readOperation(h.worker, accepted.operationId)
  if (op === undefined) throw new Error('operation vanished')
  return op
}

async function migrator<T>(
  t: TargetRecord,
  fn: (s: Awaited<ReturnType<typeof h.workerConnector.forTarget>>['session']) => Promise<T>,
): Promise<T> {
  const fresh = await findTarget(h.worker, t.targetId)
  if (fresh === undefined) throw new Error('target')
  const opened = await h.workerConnector.forTarget(fresh, 'observer', 'test')
  try {
    return await fn(opened.session)
  } finally {
    await opened.session.close()
  }
}

async function registerTarget(
  envSlug: string,
  tier: 'prod' | 'nonprod',
  evidenceFrom?: string,
): Promise<TargetRecord> {
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      slug: envSlug,
      displayName: envSlug,
      tier,
      ...(evidenceFrom === undefined ? {} : { evidenceFrom }),
    }),
  )
  const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const name = await targetDatabase(pg17, `mig_${envSlug}`, [
    `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER}`,
  ])
  const databaseId = await registerDatabase(h, a, clusterId, name)
  // The registry's own tests cover the production registration approval; here the
  // targets only need to exist (a rule-free policy registers them directly).
  const registration = {
    ...h.context,
    policy: { ...h.context.policy, registry: new RuleRegistry([]) },
  }
  const r = await run(h, a, (tx) =>
    planTargetRegister(tx, registration, a, {
      projectId: projectId as never,
      environmentId: environmentId as never,
      databaseId: databaseId as never,
    }),
  )
  if (r.operation.state !== 'succeeded') {
    throw new Error(
      `registration: ${JSON.stringify(r.operation)} ${JSON.stringify(await operationError(h, r.operation.operationId))}`,
    )
  }
  const t = await findTarget(h.worker, String((await planContent(h, r.plan.planId))['targetId']))
  if (t === undefined) throw new Error('target not registered')
  return t
}

beforeAll(async () => {
  h = await harness('exdb_it_migrations')
  a = actor()
  await runAsSuperuser(pg17, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF; END $$`,
  ])
  clusterId = await readyCluster(h, a, pg17)
  // verify.sql runs on the verifier's own credential (verification.md §4.3).
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  await runAsSuperuser(pg17, 'postgres', [
    `GRANT ${OWNER} TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE`,
  ])
  const policy = {
    registry: new RuleRegistry([...REGISTRY_RULES, ...MIGRATION_RULES]),
    codeVersion: '0.1.0+test',
    clock: systemClock,
  }
  ctx = { policy, installationId: h.db.installationId, connector: h.serveConnector }
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
    planProductCreate(tx, h.context, a, { slug, displayName: 'Migrations' }),
  )
  productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      managedScope: { excludeSchemas: [] },
    }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
  // Registry data: the project's execution role (an owner of the database's objects).
  const roles = await run(h, a, (tx) =>
    planProjectUpdate(tx, h.context, a, projectId, { executionRoles: { owner: OWNER } }),
  )
  expect(roles.operation.state).toBe('succeeded')
  staging = await registerTarget('staging', 'nonprod')
  production = await registerTarget('production', 'prod', 'staging')
}, 240_000)

afterAll(async () => {
  await h?.close()
})

const LEADS = `-- the lead inbox
CREATE TABLE public.leads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL
);
CREATE INDEX leads_email_idx ON public.leads (email);
`
const LEADS_VERIFY = `-- check: the table is empty and readable
SELECT count(*) = 0 AS ok FROM public.leads;
-- check: the index is valid
SELECT i.indisvalid AS ok FROM pg_catalog.pg_index i
 WHERE i.indexrelid = pg_catalog.to_regclass('public.leads_email_idx');
`

describe('migration.apply on a nonprod target', () => {
  const first = ulid()

  it('plans from submitted bundles, applies as the owner, verifies L1 to L3 and records ledger, mirror and progress', async () => {
    const p = await plan(staging, {
      bundles: [bundle({ id: first, name: 'add-leads', up: LEADS, verify: LEADS_VERIFY })],
    })
    if (p.decision !== 'allow') {
      const policy = p.body['policy'] as {
        rules: { id: string; result: string; message: string }[]
      }
      const analysis = p.body['analysis'] as {
        perMigration: { lint: { rule: string; blocking: boolean; message: string }[] }[]
      }
      throw new Error(
        JSON.stringify({
          rules: policy.rules.filter((r) => r.result !== 'pass' && r.result !== 'not_applicable'),
          lint: analysis.perMigration.flatMap((m) => m.lint.filter((l) => l.blocking)),
          facts: (p.body['content'] as { facts: unknown }).facts,
        }),
      )
    }
    const content = p.body['content'] as Record<string, unknown>
    expect((content['migrations'] as unknown[]).length).toBe(1)
    const op = await apply(p)
    const progress = await readProgress(h.worker, op.operationId)
    if (op.state !== 'succeeded') {
      const events = await h.worker.query(
        'test.events',
        'SELECT kind, detail FROM operations.operation_events WHERE operation_id = $1 ORDER BY event_id',
        [op.operationId],
      )
      const runs = await h.worker.query(
        'test.runs',
        'SELECT structural, runtime, engine FROM migrations.verification_mirror WHERE operation_id = $1',
        [op.operationId],
      )
      throw new Error(
        JSON.stringify({
          progress,
          runs: runs.rows.map((r) => [r.json('structural'), r.json('runtime'), r.json('engine')]),
          events: events.rows.map((r) => [r.text('kind'), r.json('detail')]),
        }),
      )
    }
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    expect(progress).toMatchObject([
      { migrationId: first, applyOutcome: 'applied', verificationOutcome: 'passed' },
    ])
    await migrator(staging, async (s) => {
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.map((r) => [r.migrationId, r.operationId, r.origin])).toEqual([
        [first, op.operationId, 'exponetdb'],
      ])
      const verifications = await s.readOnly((tx) => readVerifications(tx, first))
      expect(verifications.map((v) => v.status)).toEqual(['passed'])
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: first }))
      expect(events.map((e) => e.event)).toEqual(['applied'])
      const owner = await s.query(
        (await import('@exponetdb/postgres'))
          .sql`SELECT pg_catalog.pg_get_userbyid(relowner) AS o FROM pg_catalog.pg_class WHERE oid = 'public.leads'::regclass`,
      )
      expect(owner[0]?.text('o')).toBe(OWNER)
    })
    const mirror = await h.worker.query(
      'test.mirror',
      'SELECT migration_id, operation_id FROM migrations.ledger_mirror WHERE target_id = $1',
      [staging.targetId],
    )
    expect(mirror.rows.map((r) => r.text('migration_id'))).toEqual([first])
  })

  it('refuses to plan an applied migration again, and a changed bundle under the same id', async () => {
    await expect(plan(staging, { migrationIds: [first as never] })).rejects.toMatchObject({
      code: 'MIGRATION_ALREADY_APPLIED',
    })
    await expect(
      plan(staging, {
        bundles: [
          bundle({
            id: first,
            name: 'add-leads',
            up: `${LEADS}\nCREATE TABLE public.extra (id int);\n`,
            verify: LEADS_VERIFY,
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' })
  })

  it('rolls back a failing statement: not applied, no ledger row, the statement index and SQLSTATE recorded', async () => {
    const id = ulid()
    const p = await plan(staging, {
      bundles: [
        bundle({
          id,
          name: 'broken',
          up: 'CREATE TABLE public.notes (id int);\nINSERT INTO public.notes SELECT 1 / 0;\n',
          dependsOn: [first],
        }),
      ],
    })
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    const progress = await readProgress(h.worker, op.operationId)
    expect(progress[0]).toMatchObject({
      applyOutcome: 'not_applied',
      errorCode: 'MIGRATION_EXECUTION_FAILED',
      statementIndex: 1,
      sqlstate: '22012',
    })
    await migrator(staging, async (s) => {
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.map((r) => r.migrationId)).toEqual([first])
    })
  })

  it('makes a plan stale when the schema changed after planning (fingerprint)', async () => {
    const p = await plan(staging, {
      bundles: [
        bundle({
          name: 'add-tags',
          up: 'CREATE TABLE public.tags (id int);\n',
          dependsOn: [first],
        }),
      ],
    })
    const db = staging.placement?.databaseName ?? ''
    await runAsSuperuser(pg17, db, ['CREATE TABLE public.out_of_band (id int)'])
    await expect(accept(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    await runAsSuperuser(pg17, db, ['DROP TABLE public.out_of_band'])
  })

  it('fails the pre-commit gate (L0) when IF NOT EXISTS met another shape: rolled back, recorded in the Control Store only', async () => {
    const db = staging.placement?.databaseName ?? ''
    await runAsSuperuser(pg17, db, [
      'CREATE TABLE public.contacts (id bigint, other text)',
      `ALTER TABLE public.contacts OWNER TO ${OWNER}`,
    ])
    const id = ulid()
    const p = await plan(staging, {
      bundles: [
        bundle({
          id,
          name: 'contacts',
          up: 'CREATE TABLE IF NOT EXISTS public.contacts (id bigint, email text NOT NULL);\n',
          dependsOn: [first],
        }),
      ],
    })
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    const progress = await readProgress(h.worker, op.operationId)
    expect(progress[0]).toMatchObject({
      applyOutcome: 'not_applied',
      verificationOutcome: 'failed',
      errorCode: 'VERIFICATION_FAILED',
      gate: { layer: 'L0' },
    })
    await migrator(staging, async (s) => {
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.map((r) => r.migrationId)).not.toContain(id)
    })
    await runAsSuperuser(pg17, db, ['DROP TABLE public.contacts'])
  })
})

describe('migration.verify and migration.rollback', () => {
  const labels = ulid()
  let base = ''

  it('verifies an applied migration again without running up.sql: a new run in history and mirror', async () => {
    base =
      (await migrator(staging, (s) => s.readOnly((tx) => readLedgerRows(tx))))[0]?.migrationId ?? ''
    const applied = await apply(
      await plan(staging, {
        bundles: [
          bundle({
            id: labels,
            name: 'labels',
            up: 'CREATE TABLE public.labels (id int PRIMARY KEY, title text);\n',
            verify: '-- check: labels readable\nSELECT count(*) >= 0 AS ok FROM public.labels;\n',
            down: 'DROP TABLE public.labels;\n',
            dependsOn: [base],
          }),
        ],
      }),
    )
    expect(applied).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const p = await h.serve.transaction('test.verify.plan', (tx) =>
      planMigrationVerify(tx, ctx, a, staging.targetId, labels, {}),
    )
    expect(p.decision).toBe('allow')
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    await migrator(staging, async (s) => {
      const runs = await s.readOnly((tx) => readVerifications(tx, labels))
      expect(runs.map((v) => [v.status, v.operationId])).toEqual([
        ['passed', applied.operationId],
        ['passed', op.operationId],
      ])
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: labels }))
      expect(events.map((e) => e.event)).toEqual(['applied'])
    })
    const mirror = await h.worker.query(
      'test.verify.mirror',
      'SELECT count(*)::int AS n FROM migrations.verification_mirror WHERE operation_id = $1',
      [op.operationId],
    )
    expect(mirror.rows[0]?.int('n')).toBe(1)
  })

  const stamps = ulid()
  const rollbackPlan = (id: string) =>
    h.serve.transaction('test.rollback.plan', (tx) =>
      planMigrationRollback(tx, ctx, a, staging.targetId, id),
    )

  it('refuses a rollback while a dependent is applied or a later migration is applied', async () => {
    await expect(rollbackPlan(base)).rejects.toMatchObject({
      code: 'MIGRATION_ROLLBACK_BLOCKED',
      details: { reason: 'dependents_applied' },
    })
    const later = await apply(
      await plan(staging, {
        bundles: [
          bundle({
            id: stamps,
            name: 'stamps',
            up: 'CREATE TABLE public.stamps (id int);\n',
            down: 'DROP TABLE public.stamps;\n',
            dependsOn: [base],
          }),
        ],
      }),
    )
    expect(later.state).toBe('succeeded')
    await expect(rollbackPlan(labels)).rejects.toMatchObject({
      code: 'MIGRATION_ROLLBACK_BLOCKED',
      details: { reason: 'not_latest' },
    })
    // The later one first: its rollback returns the schema to the fingerprint labels recorded.
    const op = await apply(await rollbackPlan(stamps))
    expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
  })

  it('rolls back with down.sql only on an explicit plan: reverted in the ledger, verified against the earlier fingerprint', async () => {
    const before = await migrator(staging, (s) => s.readOnly((tx) => readLedgerRows(tx)))
    const row = before.find((r) => r.migrationId === labels)
    const p = await h.serve.transaction('test.rollback.plan', (tx) =>
      planMigrationRollback(tx, ctx, a, staging.targetId, labels),
    )
    expect(p).toMatchObject({ kind: 'migration.rollback', decision: 'allow' })
    const op = await apply(p)
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    await migrator(staging, async (s) => {
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      const reverted = rows.find((r) => r.migrationId === labels)
      expect(reverted?.revertedAt).not.toBeNull()
      expect(reverted?.revertedByOp).toBe(op.operationId)
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: labels }))
      expect(events.map((e) => e.event)).toEqual(['applied', 'reverted'])
      const gone = await s.query(
        (await import('@exponetdb/postgres'))
          .sql`SELECT pg_catalog.to_regclass('public.labels') IS NULL AS gone`,
      )
      expect(gone[0]?.bool('gone')).toBe(true)
    })
    const runs = await h.worker.query(
      'test.rollback.runs',
      'SELECT fingerprint FROM migrations.verification_mirror WHERE operation_id = $1',
      [op.operationId],
    )
    expect(runs.rows[0]?.text('fingerprint')).toBe(row?.fingerprintBefore)
    // A reverted migration is neither verified, rolled back nor applied again.
    await expect(
      h.serve.transaction('test.verify.plan', (tx) =>
        planMigrationVerify(tx, ctx, a, staging.targetId, labels, {}),
      ),
    ).rejects.toMatchObject({ code: 'MIGRATION_REVERTED', details: { migrationId: labels } })
    await expect(rollbackPlan(labels)).rejects.toMatchObject({ code: 'MIGRATION_REVERTED' })
    await expect(plan(staging, { migrationIds: [labels as never] })).rejects.toMatchObject({
      code: 'MIGRATION_REVERTED',
    })
  })
})

describe('non-transactional migrations', () => {
  let base = ''
  const partialId = ulid()

  it('runs a CONCURRENTLY statement in autocommit: started, done events, then the ledger row', async () => {
    base =
      (await migrator(staging, (s) => s.readOnly((tx) => readLedgerRows(tx))))[0]?.migrationId ?? ''
    const id = ulid()
    const p = await plan(staging, {
      bundles: [
        bundle({
          id,
          name: 'leads-lower',
          up: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_lower_idx ON public.leads (lower(email));\n',
          transactional: false,
          dependsOn: [base],
        }),
      ],
    })
    expect(p.decision).toBe('allow')
    const op = await apply(p)
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    await migrator(staging, async (s) => {
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: id }))
      expect(events.map((e) => e.event)).toEqual([
        'nontx_started',
        'nontx_statement_done',
        'applied',
      ])
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.find((r) => r.migrationId === id)?.transactional).toBe(false)
    })
    // Without down.sql there is nothing to roll back with.
    await expect(
      h.serve.transaction('test.rollback.plan', (tx) =>
        planMigrationRollback(tx, ctx, a, staging.targetId, id),
      ),
    ).rejects.toMatchObject({
      code: 'MIGRATION_ROLLBACK_BLOCKED',
      details: { reason: 'no_down_sql' },
    })
  })

  it('closes a failure before any effect as not applied: nothing blocks the target', async () => {
    const id = ulid()
    const p = await plan(staging, {
      bundles: [
        bundle({
          id,
          name: 'nt-zero',
          up: 'INSERT INTO public.leads (email) SELECT (1 / 0)::text;\nCREATE INDEX CONCURRENTLY leads_nt_zero_idx ON public.leads (email);\n',
          transactional: false,
          dependsOn: [base],
        }),
      ],
    })
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    expect((await readProgress(h.worker, op.operationId))[0]).toMatchObject({
      statementIndex: 0,
      sqlstate: '22012',
      errorCode: 'MIGRATION_EXECUTION_FAILED',
    })
    await migrator(staging, async (s) => {
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: id }))
      expect(events.map((e) => e.event)).toEqual([
        'nontx_started',
        'nontx_failed',
        'ledger_reconciled',
      ])
    })
    // Not blocking: a plan of another migration is admitted.
    await expect(
      plan(staging, {
        bundles: [
          bundle({ name: 'probe', up: 'CREATE TABLE public.probe (id int);\n', dependsOn: [base] }),
        ],
      }),
    ).resolves.toMatchObject({ kind: 'migration.apply' })
  })

  it('leaves a failure after an earlier effect partially applied and blocks further schema plans', async () => {
    const id = partialId
    const p = await plan(staging, {
      bundles: [
        bundle({
          id,
          name: 'nt-partial',
          up: 'CREATE TABLE public.nt_side (id int);\nCREATE INDEX CONCURRENTLY leads_id_idx ON public.leads (id);\n',
          transactional: false,
          dependsOn: [base],
        }),
      ],
    })
    const db = staging.placement?.databaseName ?? ''
    // An older snapshot: CONCURRENTLY waits for it (and times out) after building
    // the index, while catalog reads and statement 0 are not blocked by it.
    const holder = await superuserClient(pg17, db)
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1')
      const op = await apply(p)
      // partially_applied passes through verification (operations state machine).
      expect(op).toMatchObject({
        state: 'verification_failed',
        applyOutcome: 'partially_applied',
        verificationOutcome: 'partial',
      })
      expect((await readProgress(h.worker, op.operationId))[0]).toMatchObject({
        applyOutcome: 'partially_applied',
        statementIndex: 1,
        errorCode: 'MIGRATION_LOCK_TIMEOUT',
      })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    await migrator(staging, async (s) => {
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: id }))
      expect(events.map((e) => e.event)).toEqual([
        'nontx_started',
        'nontx_statement_done',
        'nontx_failed',
      ])
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.map((r) => r.migrationId)).not.toContain(id)
    })
    await expect(
      plan(staging, {
        bundles: [
          bundle({
            name: 'blocked',
            up: 'CREATE TABLE public.blocked (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_INCOMPLETE', details: { migrationId: id } })
  })

  const resumePlan = (cleanup?: boolean) =>
    h.serve.transaction('test.resume.plan', (tx) =>
      planMigrationResume(
        tx,
        ctx,
        a,
        staging.targetId,
        partialId,
        cleanup === undefined ? {} : { cleanup },
      ),
    )

  it('reads the INVALID index back and refuses to resume without an explicit cleanup', async () => {
    const db = staging.placement?.databaseName ?? ''
    const client = await superuserClient(pg17, db)
    try {
      const left = await client.query(
        "SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'leads_id_idx'",
      )
      expect(left.rows).toEqual([{ valid: false }])
    } finally {
      await client.end()
    }
    const p = await resumePlan()
    expect(p).toMatchObject({ kind: 'migration.resume', decision: 'deny' })
    expect(p.body['analysis']).toMatchObject({
      nextStatement: 1,
      readback: 'invalid_index',
      cleanup: null,
      findings: [{ rule: 'resume_cleanup_required' }],
    })
    // Nothing else is planned meanwhile, and the migration itself is not planned again.
    await expect(plan(staging, { migrationIds: [partialId as never] })).rejects.toMatchObject({
      code: 'MIGRATION_INCOMPLETE',
    })
  })

  it('resumes with the cleanup: drops exactly that index, runs the failed statement again, records and verifies', async () => {
    const p = await resumePlan(true)
    expect(p).toMatchObject({ kind: 'migration.resume', decision: 'allow' })
    const content = p.body['content'] as { resume: Record<string, unknown> }
    expect(content.resume).toMatchObject({
      nextStatement: 1,
      fromStatement: 1,
      readback: 'invalid_index',
      cleanup: { schema: 'public', name: 'leads_id_idx' },
    })
    const op = await apply(p)
    expect(op).toMatchObject({
      kind: 'migration.resume',
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    await migrator(staging, async (s) => {
      const events = await s.readOnly((tx) => readMigrationEvents(tx, { migrationId: partialId }))
      expect(events.map((e) => [e.event, e.operationId === op.operationId])).toEqual([
        ['nontx_started', false],
        ['nontx_statement_done', false],
        ['nontx_failed', false],
        ['nontx_statement_done', true],
        ['applied', true],
      ])
      expect(events[3]?.detail).toMatchObject({
        statementIndex: 1,
        resume: { cleanup: 'public.leads_id_idx' },
      })
      const rows = await s.readOnly((tx) => readLedgerRows(tx))
      expect(rows.find((r) => r.migrationId === partialId)).toMatchObject({
        operationId: op.operationId,
        transactional: false,
      })
      const valid = await s.query(
        (await import('@exponetdb/postgres'))
          .sql`SELECT i.indisvalid AS ok FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'leads_id_idx'`,
      )
      expect(valid[0]?.bool('ok')).toBe(true)
    })
    // The target is no longer blocked, and there is nothing left to resume.
    await expect(resumePlan()).rejects.toMatchObject({ code: 'MIGRATION_ALREADY_APPLIED' })
    await expect(
      plan(staging, {
        bundles: [
          bundle({
            name: 'after-resume',
            up: 'CREATE TABLE public.after_resume (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
    ).resolves.toMatchObject({ kind: 'migration.apply' })
  })
})

describe('migration.apply on a production target', () => {
  it('denies without evidence and binds the evidence of the staging target once it exists', async () => {
    // The first migration is applied and verified on staging; production has nothing yet.
    const stagingRows = await migrator(staging, (s) => s.readOnly((tx) => readLedgerRows(tx)))
    const first = stagingRows[0]?.migrationId
    if (first === undefined) throw new Error('staging has no migration')
    const evidenced = await plan(production, { migrationIds: [first as never] })
    const content = evidenced.body['content'] as { facts: { evidence: string }; evidence: unknown }
    expect(content.facts.evidence).toBe('present')
    expect(content.evidence).not.toBeNull()
    // A production plan of a migration staging never applied is denied (no override).
    const fresh = await plan(production, {
      bundles: [
        bundle({
          name: 'only-prod',
          up: 'CREATE TABLE public.only_prod (id int);\n',
          dependsOn: [first],
        }),
      ],
    })
    expect(fresh.decision).toBe('deny')
    expect((fresh.body['content'] as { facts: { evidence: string } }).facts.evidence).toBe(
      'missing',
    )
  })
})

/**
 * verify.sql refusals carry the decided codes (verification.md §4.2): a statement
 * form is MIGRATION_STATEMENT_FORBIDDEN, a construct the admission cannot classify
 * VERIFY_CONSTRUCT_UNSUPPORTED. At plan time the apply plan carries the code on its
 * blocking lint entry (and is denied); the verification plan refuses with it.
 */
describe('verify.sql refusals carry the decided codes at plan time', () => {
  const FORBIDDEN = 'MIGRATION_STATEMENT_FORBIDDEN'
  const UNSUPPORTED = 'VERIFY_CONSTRUCT_UNSUPPORTED'
  const FORMS: readonly (readonly [string, string, string])[] = [
    ['DELETE', 'DELETE FROM public.vz_base;', FORBIDDEN],
    ['INSERT', 'INSERT INTO public.vz_base VALUES (1);', FORBIDDEN],
    ['UPDATE', 'UPDATE public.vz_base SET id = 2;', FORBIDDEN],
    ['SELECT INTO', 'SELECT true AS ok INTO public.vz_copy;', FORBIDDEN],
    ['FOR UPDATE', 'SELECT true AS ok FROM public.vz_base FOR UPDATE;', FORBIDDEN],
    ['DO', 'DO $$ BEGIN PERFORM 1; END $$;', FORBIDDEN],
    ['CALL', 'CALL public.vz_proc();', FORBIDDEN],
    ['SET TRANSACTION READ WRITE', 'SET TRANSACTION READ WRITE;', FORBIDDEN],
    [
      'a function outside the allowlist',
      'SELECT pg_catalog.pg_sleep(1) IS NULL AS ok;',
      UNSUPPORTED,
    ],
    ['output columns', 'SELECT 1 AS n;', UNSUPPORTED],
  ]
  const UP = 'CREATE TABLE public.vz_base (id int);\n'

  it.each(FORMS)(
    'the apply plan denies a %s in verify.sql and names the code',
    async (_l, sql, code) => {
      const p = await plan(staging, {
        bundles: [bundle({ name: 'vz', up: UP, verify: `-- check: c\n${sql}\n` })],
      })
      expect(p.decision).toBe('deny')
      const analysis = p.body['analysis'] as {
        perMigration: {
          lint: { rule: string; blocking: boolean; file: string | null; code?: string }[]
        }[]
      }
      const entries = analysis.perMigration.flatMap((m) =>
        m.lint.filter((l) => l.file === 'verify.sql' && l.blocking),
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ code })
      const policy = p.body['policy'] as { rules: { id: string; result: string }[] }
      expect(policy.rules.filter((r) => r.result === 'fail').map((r) => r.id)).toContain(
        'migration.lint-errors',
      )
    },
  )

  it('carries no code on a lint entry that is not a verify.sql refusal', async () => {
    const p = await plan(staging, {
      bundles: [bundle({ name: 'vz-ok', up: UP, verify: '-- check: c\nSELECT true AS ok;\n' })],
    })
    const analysis = p.body['analysis'] as { perMigration: { lint: { code?: string }[] }[] }
    expect(
      analysis.perMigration.flatMap((m) => m.lint).filter((l) => l.code !== undefined),
    ).toEqual([])
  })

  it('the verification plan of an applied migration refuses a verify.sql revision with the decided code', async () => {
    const id = ulid()
    const submitted = (verify: string) =>
      bundle({ id, name: 'vz-applied', up: 'CREATE TABLE public.vz_applied (id int);\n', verify })
    const applied = await apply(
      await plan(staging, {
        bundles: [submitted('-- check: c\nSELECT count(*) >= 0 AS ok FROM public.vz_applied;\n')],
      }),
    )
    expect(applied).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    for (const [label, sql, code] of FORMS) {
      // A new revision of the same bundle: the verify.sql is outside the apply checksum.
      const stored = await h.serve.transaction('test.verify.revision', (tx) =>
        ingestBundles(tx, {
          projectId,
          bundles: [submitted(`-- check: c\n${sql}\n`)],
          defaults: DEFAULTS,
          identityId: a.identityId,
        }),
      )
      const revision = stored[0]?.revision.revision
      expect(stored[0]?.status, label).toBe('verify_revision')
      await expect(
        h.serve.transaction('test.verify.plan', (tx) =>
          planMigrationVerify(tx, ctx, a, staging.targetId, id, { revision }),
        ),
        label,
      ).rejects.toMatchObject({ code, details: { check: 'c' } })
    }
  })
})

/**
 * A8 (verification.md §4.3): the verify session is a dedicated, pinned one. The check
 * below runs on the production L2 layer and asserts its own session: the name
 * `exponetdb/verify/<operation id>`, the rendering settings (`DateStyle` is `ISO, YMD`,
 * as every session of the adapter and schema-fingerprints.md §4 say), the read-only mode
 * and the timeouts.
 */
describe('the verify session reports its pinned settings', () => {
  /** One check per setting, so a difference is named. */
  const PINNED: readonly (readonly [string, string])[] = [
    ['DateStyle', 'ISO, YMD'],
    ['TimeZone', 'UTC'],
    ['standard_conforming_strings', 'on'],
    ['default_transaction_read_only', 'on'],
    ['transaction_read_only', 'on'],
    ['constraint_exclusion', 'off'],
    ['search_path', ''],
    ['statement_timeout', '1min'],
    ['lock_timeout', '2s'],
    ['idle_in_transaction_session_timeout', '30s'],
  ]
  const settings = PINNED.map(
    ([name, value]) =>
      `-- check: ${name}\nSELECT pg_catalog.current_setting('${name}') = '${value}' AS ok;`,
  ).join('\n')
  const named = (operationId: string) =>
    `-- check: application name\nSELECT pg_catalog.current_setting('application_name') = 'exponetdb/verify/${operationId}' AS ok;\n${settings}`

  beforeAll(async () => {
    // The layer admits the file with the target's grammar; the planner loads it in the full flow.
    await loadParser(17)
  })

  it('is named exponetdb/verify/<operation id> and carries the pinned settings', async () => {
    const operationId = newId('op', Date.now())
    const layer = await runtimeLayer(
      h.workerConnector,
      staging,
      operationId,
      named(operationId),
      [],
    )
    expect(layer, JSON.stringify(layer)).toMatchObject({
      status: 'passed',
      checks: 1 + PINNED.length,
      failed: 0,
    })
  })

  it('fails the same checks for another operation id (the name is not vacuous)', async () => {
    const operationId = newId('op', Date.now())
    const other = newId('op', Date.now() + 1)
    expect(other).not.toBe(operationId)
    const layer = await runtimeLayer(h.workerConnector, staging, operationId, named(other), [])
    // Only the name differs: every pinned setting still passes.
    expect(layer).toMatchObject({ status: 'failed', checks: 1 + PINNED.length, failed: 1 })
    expect(layer.firstFailure?.name).toBe('application name')
  })
})
