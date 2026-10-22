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
import { ROLE_NAMES, readLedgerRows } from '@exponetdb/postgres'
import {
  findTarget,
  planEnvironmentCreate,
  planExecutionRoleExceptionDeclare,
  planExecutionRoleExceptionRevoke,
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
  runAsSuperuser,
  SUPABASE_ALIASES,
  SUPABASE_FILES,
  serverFor,
  supabaseTargetStatements,
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
  decideImportItem,
  importReportView,
  type MigrationPlanContext,
  migrationKinds,
  planBaseline,
  planImportAnalysis,
} from '../src/index.ts'

/**
 * Legacy import of a history in the shape real Supabase-origin projects
 * have (Wave 9 order A2), on real PostgreSQL 17: the Supabase ledger's
 * versions are 14-digit timestamps, its names are the file stems and its
 * `statements` hold one element, the whole file without comments; one entry
 * stands for two files; a drizzle-style runner's `applied_migrations`
 * table knows names only. Content decides with a recorded strength, a name
 * alone never records a file, and the scratch target must hold the
 * imported target's extensions.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const slug = `sup${Date.now().toString(36)}`
let clusterId = ''
let productId = ''
let projectId = ''
let imported: TargetRecord
let scratch: TargetRecord
let scratchDb = ''
let importedDb = ''

const OWNER = 'exdb_it_supabase_owner'
const BASELINE = 'acme-supabase-2026'

async function apply(p: PlanRecord): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.supabase.accept', (tx) =>
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
  const name = await targetDatabase(pg17, `sup_${envSlug}`, [
    // The execution role owns the database, as on real Supabase-origin installations: public
    // is its schema through pg_database_owner, which is no protected reach (ADR-0034 §3.1).
    `DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO %I', pg_catalog.current_database(), '${OWNER}'); END $$`,
    ...extra,
  ])
  if (envSlug === 'scratch') scratchDb = name
  else if (envSlug === 'staging') importedDb = name
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
  h = await harness('exdb_it_supabase')
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
    planProductCreate(tx, h.context, a, { slug, displayName: 'Supabase-shaped' }),
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
  imported = await registerTarget('staging', supabaseTargetStatements(OWNER, ROLE_NAMES.observer))
  scratch = await registerTarget('scratch', [])
}, 240_000)

afterAll(async () => {
  await h?.close()
})

function analysis(aliases: Record<string, string | readonly string[]> = SUPABASE_ALIASES) {
  return h.serve.transaction('test.supabase.analyze', (tx) =>
    planImportAnalysis(tx, ctx, a, imported.targetId, {
      scratchTarget: scratch.targetId,
      baseline: BASELINE,
      files: SUPABASE_FILES,
      ledgers: ['supabase', 'applied_migrations'],
      aliases,
    }),
  )
}

const reportOf = (p: PlanRecord) => String((p.body['content'] as { reportId: string }).reportId)

describe('legacy import of a real-shape Supabase history', () => {
  it('refuses an alias that names an unknown file or the same file twice', async () => {
    await expect(analysis({ x: ['0103_notes', 'nope'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    await expect(analysis({ x: ['0103_notes', '0103_notes'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('denies a replay plan whose execution role is not usable on the scratch target', async () => {
    await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} BYPASSRLS`])
    try {
      const p = await analysis()
      expect(p.decision).toBe('deny')
      const rule = (
        p.body['policy'] as { rules: { id: string; result: string; facts: unknown }[] }
      ).rules.find((r) => r.id === 'migration.import-execution-role')
      expect(rule).toMatchObject({
        result: 'fail',
        facts: { role: OWNER, problem: 'privileged_attribute' },
      })
    } finally {
      await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} NOBYPASSRLS`])
    }
  })

  it('checks the execution role again under the scratch target lock: a role changed after planning stops the replay', async () => {
    const p = await analysis()
    expect(p.decision).toBe('allow')
    await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} BYPASSRLS`])
    try {
      const op = await apply(p)
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
      expect((await operationError(h, op.operationId)).code).toBe('PLAN_STALE')
      const { rows } = await h.worker.query(
        'test.supabase.role',
        'SELECT state, incomplete_reason FROM migrations.import_reports WHERE report_id = $1',
        [reportOf(p)],
      )
      expect(rows.map((r) => [r.text('state'), r.textOrNull('incomplete_reason')])).toEqual([
        ['incomplete', 'execution_role:privileged_attribute'],
      ])
    } finally {
      await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} NOBYPASSRLS`])
    }
  })

  it("replays as a BYPASSRLS owner only under the scratch environment's declared exception, and stops once it is revoked", async () => {
    const declare = async (environmentId: string) => {
      const r = await run(h, a, (tx) =>
        planExecutionRoleExceptionDeclare(tx, h.context, a, projectId, environmentId, {
          role: OWNER,
          reason: 'Definer functions of the imported schema read FORCE tables.',
        }),
      )
      expect(r.operation.state).toBe('succeeded')
      return String((await planContent(h, r.plan.planId))['exceptionId'])
    }
    const revoke = async (exceptionId: string) => {
      const r = await run(h, a, (tx) =>
        planExecutionRoleExceptionRevoke(tx, h.context, a, projectId, exceptionId, {
          reason: 'The replay test is done with this declaration.',
        }),
      )
      expect(r.operation.state).toBe('succeeded')
    }
    const ruleOf = (p: PlanRecord, id: string) =>
      (p.body['policy'] as { rules: { id: string; result: string }[] }).rules.find(
        (r) => r.id === id,
      )?.result
    await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} BYPASSRLS`])
    try {
      // A declaration for the imported target's environment says nothing about the replay.
      const onImported = await declare(imported.environmentId)
      expect((await analysis()).decision).toBe('deny')

      const onScratch = await declare(scratch.environmentId)
      const p = await analysis()
      expect(p.decision).not.toBe('deny')
      expect(ruleOf(p, 'migration.import-execution-role')).not.toBe('fail')
      expect(ruleOf(p, 'migration.execution-role-exception')).toBe('fail')
      expect(p.body['content'] as Record<string, unknown>).toMatchObject({
        executionRoleCheck: { role: OWNER, problem: 'declared_exception' },
        executionRoleExceptions: { [OWNER]: { exceptionId: onScratch, revision: 1 } },
      })
      await revoke(onScratch)
      await expect(apply(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
      await revoke(onImported)
    } finally {
      await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${OWNER} NOBYPASSRLS`])
    }
  })

  it('refuses to replay when the scratch target lacks an extension of the imported target', async () => {
    await runAsSuperuser(pg17, importedDb, ['CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'])
    const p = await analysis()
    const op = await apply(p)
    expect(op.state).not.toBe('succeeded')
    const { rows } = await h.worker.query(
      'test.supabase.incomplete',
      'SELECT state, incomplete_reason FROM migrations.import_reports WHERE report_id = $1',
      [reportOf(p)],
    )
    expect(rows.map((r) => [r.text('state'), r.textOrNull('incomplete_reason')])).toEqual([
      ['incomplete', 'extensions_differ:pg_trgm'],
    ])
    // Refused before anything ran: the scratch target is still empty.
    await runAsSuperuser(pg17, scratchDb, ['CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'])
  })

  it('classifies by content with a strength; a name alone never records a file', async () => {
    const p = await analysis()
    expect(p).toMatchObject({ kind: 'migration.import.replay', decision: 'allow' })
    const reportId = reportOf(p)
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const r = await h.worker.transaction('test.supabase.report', (tx) =>
      importReportView(tx, imported.targetId, reportId),
    )
    expect(r.state).toBe('open')
    const item = (id: string) => r.items.find((i) => i.legacyId === id)
    // The whole file, comments stripped, against the parsed file: the normalized sequence.
    expect(item('legacy:0100_accounts')).toMatchObject({
      state: 'recorded_present',
      evidenceStrength: 'medium',
      evidence: expect.arrayContaining([
        'supabase:statements_normalized',
        'applied_migrations:name_hint',
      ]),
    })
    expect(item('legacy:0101_account_members')).toMatchObject({
      state: 'recorded_present',
      evidenceStrength: 'medium',
    })
    // The stripper removed the comment inside the function body too, as the hosted connector
    // does for every routine (follow-up 2, F5): the body normalized as code, medium.
    expect(item('legacy:0102_member_count')).toMatchObject({
      state: 'recorded_present',
      evidenceStrength: 'medium',
      evidence: expect.arrayContaining(['supabase:statements_bodies']),
    })
    // One entry for two files: the entry's statements against both files in file order.
    for (const stem of ['0103_notes', '0104_notes_index']) {
      expect(item(`legacy:${stem}`)).toMatchObject({
        state: 'recorded_present',
        evidenceStrength: 'medium',
        evidence: expect.arrayContaining(['supabase:statements_normalized']),
      })
    }
    // Edited after apply: only the name matches, so it is not recorded.
    const edited = item('legacy:0105_events')
    expect(edited?.evidenceStrength).toBe('weak')
    expect(edited?.state.startsWith('recorded_')).toBe(false)
    // An entry without statements and a name-only runner: weak, effects hold, unrecorded.
    expect(item('legacy:0106_tags')).toMatchObject({
      state: 'unrecorded_present',
      evidenceStrength: 'weak',
    })
    expect(item('legacy:0107_settings')).toMatchObject({
      state: 'unrecorded_present',
      evidenceStrength: 'weak',
      evidence: expect.arrayContaining(['applied_migrations:name_hint']),
    })
    // Every ledger entry relates to a file; the runner's own table is global drift.
    expect(r.items.some((i) => i.legacyId.startsWith('ledger:'))).toBe(false)
    expect(
      r.items.some(
        (i) => i.legacyId.startsWith('drift:') && i.legacyId.includes('applied_migrations'),
      ),
    ).toBe(true)

    // Review, baseline: the applied time comes from the Supabase version.
    for (const i of r.items.filter(
      (x) =>
        x.decision === null &&
        ['recorded_missing', 'unrecorded_missing', 'ambiguous'].includes(x.state),
    )) {
      await h.serve.transaction('test.supabase.decide', (tx) =>
        decideImportItem(tx, {
          targetId: imported.targetId,
          reportId,
          itemId: Number(i.itemId),
          state: i.legacyId.startsWith('drift:') ? 'unrecorded_present' : 'recorded_missing',
          note: 'reviewed in the test',
          identityId: a.identityId,
        }),
      )
    }
    const baseline = await h.serve.transaction('test.supabase.baseline', (tx) =>
      planBaseline(tx, ctx, a, imported.targetId, reportId),
    )
    const done = await apply(baseline)
    expect(done).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const opened = await h.workerConnector.forTarget(imported, 'observer', 'test')
    try {
      const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
      const row = (id: string) => rows.find((x) => x.migrationId === id)
      expect(row('legacy:0100_accounts')?.checksumProvenance).toBe('legacy_applied_statements')
      expect(row('legacy:0102_member_count')?.checksumProvenance).toBe('legacy_applied_statements')
      // Unrecorded, effect observed.
      expect(row('legacy:0107_settings')?.checksumProvenance).toBe('legacy_file_at_import')
    } finally {
      await opened.session.close()
    }
    // The applied time a recording ledger names; none is claimed from a name alone.
    const sources = await withSuperuser(pg17, importedDb, async (c) => {
      const res = await c.query(
        'SELECT migration_id, source FROM exponetdb.schema_migrations ORDER BY migration_id',
      )
      return new Map(res.rows.map((x) => [String(x.migration_id), x.source]))
    })
    expect(sources.get('legacy:0100_accounts')).toMatchObject({
      appliedAt: '2026-01-01T09:00:00.000Z',
    })
    expect(sources.get('legacy:0104_notes_index')).toMatchObject({
      appliedAt: '2026-01-04T09:00:00.000Z',
    })
    expect(sources.get('legacy:0107_settings')).toMatchObject({ appliedAtUnknown: true })
  })

  it('never cuts drift silently: a report with more drift than it holds is flagged and never baselined', async () => {
    const big = await registerTarget('big', [
      `SET ROLE ${OWNER}`,
      `DO $$ BEGIN FOR i IN 1..505 LOOP EXECUTE format('CREATE TABLE public.acme_hand_%s (id int)', i); END LOOP; END $$`,
      'RESET ROLE',
    ])
    const fresh = await registerTarget('scratch-big', [])
    const p = await h.serve.transaction('test.supabase.big', (tx) =>
      planImportAnalysis(tx, ctx, a, big.targetId, {
        scratchTarget: fresh.targetId,
        baseline: BASELINE,
        files: [{ name: '0001_unrelated.sql', text: 'CREATE TABLE public.acme_one (id int);\n' }],
      }),
    )
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const r = await h.worker.transaction('test.supabase.big.report', (tx) =>
      importReportView(tx, big.targetId, reportOf(p)),
    )
    expect(r.driftTruncated).toBe(true)
    // 505 tables only in the target and one only in the replay, each with its column:
    // every catalog entry is one drift entry.
    expect(r.driftTotal).toBe(1012)
    expect(r.items.filter((i) => i.legacyId.startsWith('drift:'))).toHaveLength(500)
    for (const i of r.items.filter((x) => x.decision === null && x.state === 'ambiguous')) {
      await h.serve.transaction('test.supabase.big.decide', (tx) =>
        decideImportItem(tx, {
          targetId: big.targetId,
          reportId: r.id,
          itemId: Number(i.itemId),
          state: 'unrecorded_present',
          note: 'accepted in the test',
          identityId: a.identityId,
        }),
      )
    }
    await expect(
      h.serve.transaction('test.supabase.big.baseline', (tx) =>
        planBaseline(tx, ctx, a, big.targetId, r.id),
      ),
    ).rejects.toMatchObject({
      code: 'LEGACY_IMPORT_TRUNCATED',
      details: { driftTotal: 1012, held: 500 },
    })
    // Every held item decided: the report still never reads resolved over drift it lacks.
    const decided = await h.worker.transaction('test.supabase.big.decided', (tx) =>
      importReportView(tx, big.targetId, r.id),
    )
    expect(decided.items.filter((i) => i.state === 'ambiguous' && i.decision === null)).toEqual([])
    expect(decided.state).toBe('open')
    // A report analyzed before drift totals were kept (no total, no mark) may have been cut
    // at 500 items without a sign: it is never baselined either, and never reads resolved.
    await h.db.asSuperuser(async (c) => {
      await c.query(
        'ALTER TABLE migrations.import_reports DISABLE TRIGGER import_reports_drift_guard',
      )
      await c.query(
        'UPDATE migrations.import_reports SET drift_total = NULL, drift_truncated = false WHERE report_id = $1',
        [r.id],
      )
      await c.query(
        'ALTER TABLE migrations.import_reports ENABLE TRIGGER import_reports_drift_guard',
      )
    })
    const older = await h.worker.transaction('test.supabase.big.older', (tx) =>
      importReportView(tx, big.targetId, r.id),
    )
    expect(older).toMatchObject({ state: 'open', driftTotal: null, driftTruncated: false })
    await expect(
      h.serve.transaction('test.supabase.big.baseline.older', (tx) =>
        planBaseline(tx, ctx, a, big.targetId, r.id),
      ),
    ).rejects.toMatchObject({
      code: 'LEGACY_IMPORT_TRUNCATED',
      details: { driftTotal: null, held: 500 },
    })
  })
})
