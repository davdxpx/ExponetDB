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
import {
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
import { runAsSuperuser, serverFor, type TestServer } from '@exponetdb/testkit'
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
  planMigrationApply,
  readProgress,
} from '../src/index.ts'

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
    '  transactional: true',
    'compatibility:',
    `  declared: ${spec.declared ?? 'additive'}`,
    ...(spec.declared !== undefined && spec.declared !== 'additive' ? ['  notes: reviewed'] : []),
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${verify === null ? 'none' : 'verify.sql'}`,
    '',
  ].join('\n')
  return {
    directory: `${id}_${name}`,
    files: {
      'migration.yaml': yaml,
      'up.sql': spec.up,
      ...(verify === null ? {} : { 'verify.sql': verify }),
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
    }),
    ...migrationKinds({
      store: h.worker,
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
