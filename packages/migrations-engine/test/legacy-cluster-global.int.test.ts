import { newId, systemClock } from '@exponetdb/kernel'
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
import {
  clusterGlobalHistory,
  runAsSuperuser,
  serverFor,
  type TestServer,
  withSuperuser,
} from '@exponetdb/testkit'
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
  importReportView,
  type MigrationPlanContext,
  migrationKinds,
  planImportAnalysis,
} from '../src/index.ts'

/**
 * Legacy files with cluster-global effects (Wave 9 order A6,
 * legacy-import.md §2.4) on real PostgreSQL: the measured `42501` of role
 * statements run as an execution role on 16, 17 and 18, then a full
 * analysis on 17 whose files create, grant and configure roles (top level
 * and in `DO` blocks), use a mixed `DO` block, `CREATE INDEX CONCURRENTLY`
 * and a comment-only file. The replay elides the role statements, runs
 * `CONCURRENTLY` in autocommit, and the observer checks what the role
 * statements stated against the imported target's catalog.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const suffix = Date.now().toString(36)
const slug = `cg${suffix}`
const history = clusterGlobalHistory(suffix)
let clusterId = ''
let productId = ''
let projectId = ''
let imported: TargetRecord
let scratch: TargetRecord
let scratchDb = ''

const OWNER = 'exdb_it_cluster_global_owner'

async function apply(p: PlanRecord): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.cg.accept', (tx) =>
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
  const name = await targetDatabase(pg17, `cg_${envSlug}`, [
    `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER}`,
    ...extra,
  ])
  if (envSlug === 'scratch') scratchDb = name
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
  h = await harness('exdb_it_cluster_global')
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
    planProductCreate(tx, h.context, a, { slug, displayName: 'Cluster-global' }),
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
  await runAsSuperuser(pg17, 'postgres', history.clusterStatements)
  imported = await registerTarget('staging', history.targetStatements(OWNER))
  scratch = await registerTarget('scratch', [])
}, 240_000)

afterAll(async () => {
  await h?.close()
  await runAsSuperuser(
    pg17,
    'postgres',
    history.roles.map((r) => `DROP ROLE IF EXISTS ${r}`),
  ).catch(() => undefined)
})

const ROLE_ONLY_DO = (role: string) =>
  `DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`

describe('role statements as an execution role (measured, legacy-import.md §2.4)', () => {
  for (const major of [16, 17, 18] as const) {
    it(`fails with 42501 on PostgreSQL ${major}, for a new and an existing role, past a duplicate_object handler`, async () => {
      const server = serverFor(major)
      const owner = `exdb_it_cg_measure_${suffix}`
      const existing = `exdb_it_cg_existing_${suffix}`
      await runAsSuperuser(server, 'postgres', [
        `CREATE ROLE ${owner} NOLOGIN`,
        `CREATE ROLE ${existing} NOLOGIN`,
      ])
      try {
        await withSuperuser(server, 'postgres', async (c) => {
          await c.query(`SET ROLE ${owner}`)
          for (const statement of [
            ROLE_ONLY_DO(`exdb_it_cg_new_${suffix}`),
            ROLE_ONLY_DO(existing),
            `DO $$ BEGIN GRANT ${existing} TO ${owner}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
            `ALTER ROLE ${existing} SET search_path = public`,
            // The first real import's shape (follow-up 2, F1): the guard holds, the grant fails.
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN GRANT ${existing} TO ${owner}; END IF; END $$`,
          ]) {
            await expect(c.query(statement), statement).rejects.toMatchObject({ code: '42501' })
          }
          // Only a guard on pg_roles passes, and only when the role already exists.
          await c.query(
            `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${existing}') THEN CREATE ROLE ${existing}; END IF; END $$`,
          )
        })
      } finally {
        await runAsSuperuser(server, 'postgres', [
          `DROP ROLE IF EXISTS ${owner}`,
          `DROP ROLE IF EXISTS ${existing}`,
        ])
      }
    })
  }
})

describe('legacy import of files with cluster-global effects (PostgreSQL 17)', () => {
  const analysis = () =>
    h.serve.transaction('test.cg.analyze', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: scratch.targetId,
        baseline: 'acme-cluster-global-2026',
        files: history.files,
        ledgers: [],
      }),
    )

  it('lists in the replay plan what it elides, runs in autocommit, leaves to a person and skips', async () => {
    const p = await analysis()
    expect(p).toMatchObject({ kind: 'migration.import.replay', decision: 'allow' })
    const replay = (p.body['analysis'] as { replay: Record<string, unknown> }).replay
    expect(replay).toMatchObject({
      counts: { elided: 11, mixedDoBlocks: 1, autocommit: 1, noStatements: 1 },
      elided: [
        { file: '0200_roles', statement: 0, form: 'role_statement', type: 'CreateRoleStmt' },
        { file: '0200_roles', statement: 1, form: 'role_statement', type: 'CreateRoleStmt' },
        { file: '0200_roles', statement: 2, form: 'role_statement', type: 'CommentStmt' },
        { file: '0201_service_role', statement: 0, form: 'role_do_block', type: 'DoStmt' },
        { file: '0202_grants', statement: 2, form: 'role_statement', type: 'GrantRoleStmt' },
        { file: '0202_grants', statement: 3, form: 'role_statement', type: 'AlterRoleSetStmt' },
        // A guard on pg_roles around role statements only (follow-up 2, F1).
        { file: '0203_optional_role', statement: 0, form: 'role_do_block', type: 'DoStmt' },
        { file: '0206_limits', statement: 0, form: 'role_statement', type: 'AlterRoleStmt' },
        { file: '0207_case_studies', statement: 0, form: 'role_statement', type: 'CreateRoleStmt' },
        { file: '0207_case_studies', statement: 3, form: 'role_do_block', type: 'DoStmt' },
        { file: '0208_absent_role', statement: 0, form: 'role_do_block', type: 'DoStmt' },
      ],
      mixedDoBlocks: [{ file: '0209_mixed', statement: 0 }],
      autocommit: [{ file: '0204_index', statement: 1 }],
      noStatements: ['0205_notes'],
    })
  })

  it('replays without the role statements, CONCURRENTLY in autocommit, and checks the roles on the imported target', async () => {
    const p = await analysis()
    const reportId = String((p.body['content'] as { reportId: string }).reportId)
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const r = await h.worker.transaction('test.cg.report', (tx) =>
      importReportView(tx, imported.targetId, reportId),
    )
    expect([r.state, r.incompleteReason ?? null]).toEqual(['open', null])
    const item = (stem: string) => r.items.find((i) => i.legacyId === `legacy:${stem}`)
    // Role statements only: present by the cluster-global expectations alone.
    expect(item('0200_roles')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['cluster_global_held:6/6']),
    })
    // The DO block under a handler: only that the role and the membership exist.
    expect(item('0201_service_role')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['cluster_global_held:2/2']),
    })
    expect(item('0202_grants')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['cluster_global_held:4/4']),
    })
    // NOT EXISTS: only that the role exists, whether the block created it or found it.
    expect(item('0203_optional_role')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['cluster_global_held:1/1']),
    })
    expect(item('0204_index')).toMatchObject({
      state: 'unrecorded_present',
      evidence: ['expectations_held:6/6'],
    })
    expect(item('0205_notes')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['no_statements']),
    })
    // EXISTS: the grant is checked because its guard's role exists on the target; replayed as
    // the execution role it failed with 42501 on the first real import.
    expect(item('0207_case_studies')).toMatchObject({
      state: 'unrecorded_present',
      evidence: expect.arrayContaining(['expectations_held:5/5', 'cluster_global_held:3/3']),
    })
    // The guard's role does not exist: nothing is checked, and nothing proves the file ran.
    expect(item('0208_absent_role')).toMatchObject({
      state: 'ambiguous',
      evidence: ['cluster_global_guard_unmet:1'],
    })
    expect(item('0209_mixed')).toMatchObject({
      state: 'ambiguous',
      evidence: expect.arrayContaining(['do_block_mixed:0']),
    })
    // Changed by hand on the target since: the file's limit does not hold.
    expect(item('0206_limits')).toMatchObject({
      state: 'ambiguous',
      evidence: expect.arrayContaining(['cluster_global_held:0/1']),
    })
    // The replay ran nothing cluster-wide and built the index on the scratch target.
    const index = await withSuperuser(pg17, scratchDb, (c) =>
      c.query(
        `SELECT i.indisvalid AS valid FROM pg_catalog.pg_index i
          WHERE i.indexrelid = 'public.acme_events_kind'::regclass`,
      ),
    )
    expect(index.rows).toEqual([{ valid: true }])
    const limit = await withSuperuser(pg17, 'postgres', (c) =>
      c.query('SELECT rolconnlimit AS n FROM pg_catalog.pg_roles WHERE rolname = $1', [
        history.roles[2],
      ]),
    )
    expect(limit.rows).toEqual([{ n: 5 }])
  })
})
