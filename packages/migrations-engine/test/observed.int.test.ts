import { RegistrationSnapshotStore } from '@exponetdb/diagnostics'
import { canonicalBytes, type MigrationId, systemClock } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import type { PlanRecord } from '@exponetdb/operations'
import { ROLE_NAMES } from '@exponetdb/postgres'
import { runAsSuperuser, serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogFootprint } from '../../diagnostics/test/footprint.ts'
import { operationError } from '../../registry/test/harness.ts'
import {
  decideImportItem,
  importReportView,
  migrationDetail,
  migrationKinds,
  migrationStatus,
  planBaseline,
  planImportAnalysis,
  planLedgerReconcile,
  planMigrationResume,
  planMigrationRollback,
  planMigrationVerify,
} from '../src/index.ts'
import { migrationWorld, OWNER, type Target, type World } from './world.ts'

/**
 * Production plans on an observed target (W10-4, ADR-0039 §3 as amended on
 * 2026-11-04), on PostgreSQL 17: a managed staging with a baseline and five
 * bundles applied and verified, and an observed production whose evidence
 * comes from staging. A `migration.apply` plan for production is built for
 * real (pending since staging's baseline, the evidence read live, the
 * binding shown) and stored denied by `migration.observed-target`; it can
 * never be accepted, and nothing reaches production's database. Every other
 * migration plan stays refused at plan time with `TARGET_OBSERVED_ONLY`.
 */
const pg17 = serverFor(17)
const BASELINE = 'baseline:obs-history'
const BASE_TABLE = 'CREATE TABLE public.base_accounts (id bigint PRIMARY KEY);\n'
let w: World
let staging: Target
let production: Target
/** The five bundles staging applied and verified, in order. */
const five: MigrationId[] = []

beforeAll(async () => {
  w = await migrationWorld(
    'exdb_it_mig_observed',
    pg17,
    undefined,
    (input) =>
      new RegistrationSnapshotStore({
        store: input.worker,
        connector: input.workerConnector,
        installationId: input.installationId,
      }),
  )
  staging = await w.registerTarget('obs-stg', 'nonprod')
  const scratch = await w.registerTarget('obs-scratch', 'nonprod')
  // The history before ExponetDB: one file, present on staging (imported) and on production.
  await runAsSuperuser(pg17, staging.database, [
    BASE_TABLE,
    `ALTER TABLE public.base_accounts OWNER TO ${OWNER}`,
  ])
  const analysis = await w.h.serve.transaction('test.observed.analyze', (tx) =>
    planImportAnalysis(tx, w.ctx, w.a, staging.record.targetId, {
      scratchTarget: scratch.record.targetId,
      baseline: BASELINE.slice('baseline:'.length),
      files: [{ name: '0000_init.sql', text: BASE_TABLE }],
    }),
  )
  expect(await w.apply(analysis)).toMatchObject({ state: 'succeeded' })
  const reportId = String((analysis.body['content'] as { reportId: string }).reportId)
  const report = await w.h.worker.transaction('test.observed.report', (tx) =>
    importReportView(tx, staging.record.targetId, reportId),
  )
  for (const item of report.items.filter(
    (i) =>
      i.decision === null &&
      ['recorded_missing', 'unrecorded_missing', 'ambiguous'].includes(i.state),
  )) {
    await w.h.serve.transaction('test.observed.decide', (tx) =>
      decideImportItem(tx, {
        targetId: staging.record.targetId,
        reportId,
        itemId: Number(item.itemId),
        state: 'unrecorded_present',
        note: 'reviewed in the test: present on the imported target',
        identityId: w.a.identityId,
      }),
    )
  }
  const baseline = await w.h.serve.transaction('test.observed.baseline', (tx) =>
    planBaseline(tx, w.ctx, w.a, staging.record.targetId, reportId),
  )
  expect(await w.apply(baseline)).toMatchObject({
    state: 'succeeded',
    verificationOutcome: 'passed',
  })
  // Five bundles after the baseline, applied and verified on staging in one plan.
  const bundles = []
  for (let i = 1; i <= 5; i++) {
    const id = w.ulid()
    bundles.push(
      w.bundle({
        id,
        name: `step-${i}`,
        up: `CREATE TABLE public.step_${i} (id int);\n`,
        verify: `-- check: step ${i} exists\nSELECT to_regclass('public.step_${i}') IS NOT NULL AS ok;\n`,
        dependsOn: [five.at(-1) ?? BASELINE],
      }),
    )
    five.push(id)
  }
  expect(await w.apply(await w.plan(staging, { bundles }))).toMatchObject({
    state: 'succeeded',
    verificationOutcome: 'passed',
  })
  production = await w.registerTarget('obs-prd', 'prod', 'obs-stg', 'observed')
  // Production's real state: the legacy history, and a hand change staging never saw.
  await runAsSuperuser(pg17, production.database, [
    BASE_TABLE,
    `ALTER TABLE public.base_accounts OWNER TO ${OWNER}`,
    'CREATE TABLE public.prod_hotfix (id int)',
  ])
}, 300_000)

afterAll(async () => {
  await w?.close()
})

async function refusal(p: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await p
  } catch (error) {
    return {
      code: String((error as { code?: unknown }).code),
      details: (error as { details?: unknown }).details,
    }
  }
  throw new Error('expected a refusal')
}

const code = async (p: Promise<unknown>) => (await refusal(p)).code

type Body = {
  content: Record<string, Record<string, unknown>>
  analysis: Record<string, unknown>
  policy: { rules: { id: string; result: string }[]; overriddenRules?: string[] }
}
const bodyOf = (p: PlanRecord) => p.body as unknown as Body
const resultOf = (p: PlanRecord, rule: string) =>
  bodyOf(p).policy.rules.find((r) => r.id === rule)?.result

const footprint = () => catalogFootprint(pg17, production.database)

describe('a production plan on an observed target (W10-4)', () => {
  let denied: PlanRecord
  let before: Awaited<ReturnType<typeof footprint>>

  it('is built for real and stored denied: the evidence passes, the observed-target rule fails', async () => {
    before = await footprint()
    expect([production.record.state, production.record.mode]).toEqual(['registered', 'observed'])
    denied = await w.plan(production, { migrationIds: five })
    expect([denied.decision, denied.state]).toEqual(['deny', 'denied'])
    expect(resultOf(denied, 'migration.observed-target')).toBe('fail')
    expect(resultOf(denied, 'migration.staging-evidence')).toBe('pass')
    const { content, analysis } = bodyOf(denied)
    // Pending means "not applied by ExponetDB", anchored on staging's baseline: all five.
    expect(
      (content['migrations'] as unknown as { migrationId: string }[]).map((m) => m.migrationId),
    ).toEqual(five)
    // The binding: production's cluster, database and schema as the observer read them.
    const placement = production.record.placement
    expect(content['target']).toMatchObject({
      targetId: production.record.targetId,
      tier: 'prod',
      mode: 'observed',
      clusterSystemIdentifier: placement?.systemIdentifier,
      databaseOid: placement?.databaseOid,
    })
    expect(content['expectedState']).toMatchObject({
      schemaFingerprint: expect.stringMatching(/^fp1:17:[0-9a-f]{64}$/),
      ledgerStateHash: expect.stringMatching(/^sha256:ls1:[0-9a-f]{64}$/),
      anchor: { evidenceTargetId: staging.record.targetId, baselineId: BASELINE },
      legacyLedger: { source: 'supabase', status: 'absent' },
    })
    expect(content['facts']).toMatchObject({ targetMode: 'observed', evidence: 'present' })
    // The evidence carries staging's verification of each bundle.
    const evidence = analysis['evidence'] as { migrationId: string; verificationId: string }[]
    expect(evidence.map((e) => e.migrationId)).toEqual(five)
    for (const e of evidence) {
      expect(e).toMatchObject({
        status: 'present',
        evidenceTargetId: staging.record.targetId,
        verificationId: expect.stringMatching(/^vfy_/),
      })
    }
    expect(Object.keys((content['evidence'] as { verifications: object }).verifications)).toEqual(
      five,
    )
    // Production's real objects show in the lineage: a mismatch with staging is expected.
    expect(analysis['observed']).toEqual({
      pending: 'not_applied_by_exponetdb',
      anchor: { evidenceTargetId: staging.record.targetId, baselineId: BASELINE },
      lineage: 'mismatch',
      legacyLedger: { source: 'supabase', status: 'absent' },
    })
  })

  it('is refused at accept with PLAN_DENIED: no operation, no approval', async () => {
    expect(await code(w.accept(denied))).toBe('PLAN_DENIED')
    const { rows } = await w.h.worker.query(
      'test.observed.nothing',
      `SELECT (SELECT count(*)::int FROM operations.operations WHERE plan_id = $1) AS operations,
              (SELECT count(*)::int FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
                WHERE p.target_id = $2 AND p.kind LIKE 'migration.%') AS on_target,
              (SELECT count(*)::int FROM approvals.plan_approvals a JOIN operations.plans p ON p.plan_id = a.plan_id
                WHERE p.target_id = $2) AS approvals`,
      [denied.planId, production.record.targetId],
    )
    expect([
      rows[0]?.int('operations'),
      rows[0]?.int('on_target'),
      rows[0]?.int('approvals'),
    ]).toEqual([0, 0, 0])
  })

  it('writes nothing to production: no exponetdb schema, the same catalog and roles', async () => {
    await w.plan(production, { migrationIds: five })
    expect(await footprint()).toEqual(before)
    const c = await superuserClient(pg17, production.database)
    try {
      const r = await c.query(
        `SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'exponetdb') AS ledger,
                to_regclass('public.step_1') IS NOT NULL AS applied`,
      )
      expect(r.rows[0]).toEqual({ ledger: false, applied: false })
    } finally {
      await c.end()
    }
  })

  it('says missing for a bundle staging lacks, and unverified for one staging did not verify', async () => {
    const sixth = w.bundle({
      name: 'not-on-staging',
      up: 'CREATE TABLE public.step_6 (id int);\n',
      dependsOn: [five[4] as string],
    })
    const missing = await w.plan(production, { bundles: [sixth] })
    expect(missing.decision).toBe('deny')
    expect(bodyOf(missing).content['facts']).toMatchObject({ evidence: 'missing' })
    expect(resultOf(missing, 'migration.staging-evidence')).toBe('fail')
    expect((bodyOf(missing).analysis['evidence'] as { status: string }[]).at(-1)).toMatchObject({
      status: 'missing',
    })
    const failing = w.bundle({
      name: 'unverified',
      up: 'CREATE TABLE public.step_7 (id int);\n',
      verify: '-- check: always fails\nSELECT false AS ok;\n',
      dependsOn: [five[4] as string],
    })
    expect(await w.apply(await w.plan(staging, { bundles: [failing] }))).toMatchObject({
      state: 'verification_failed',
    })
    const unverified = await w.plan(production, { bundles: [failing] })
    expect(bodyOf(unverified).content['facts']).toMatchObject({ evidence: 'unverified' })
    expect((bodyOf(unverified).analysis['evidence'] as { status: string }[]).at(-1)).toMatchObject({
      status: 'unverified',
    })
  })

  it('binds the names of the legacy ledger when the observer may read them, and says unreadable otherwise', async () => {
    await runAsSuperuser(pg17, production.database, [
      'CREATE SCHEMA supabase_migrations',
      'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])',
      `INSERT INTO supabase_migrations.schema_migrations VALUES
         ('20250101000000', 'init', ARRAY['CREATE TABLE public.base_accounts (id bigint PRIMARY KEY)']),
         ('20250201000000', 'hotfix', ARRAY['CREATE TABLE public.prod_hotfix (id int)'])`,
    ])
    const closed = await w.plan(production, { migrationIds: five })
    expect(bodyOf(closed).content['expectedState']).toMatchObject({
      legacyLedger: { source: 'supabase', status: 'unreadable' },
    })
    // The optional ledger part of the observer script (ADR-0039): names only, never statements.
    await runAsSuperuser(pg17, production.database, [
      `GRANT USAGE ON SCHEMA supabase_migrations TO ${ROLE_NAMES.observer}`,
      `GRANT SELECT (version, name) ON supabase_migrations.schema_migrations TO ${ROLE_NAMES.observer}`,
    ])
    const open = await w.plan(production, { migrationIds: five })
    const ledger = (bodyOf(open).content['expectedState'] as { legacyLedger: unknown }).legacyLedger
    expect(ledger).toEqual({
      source: 'supabase',
      status: 'read',
      entries: 2,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    // Bound only, never matched: the plan is the same five bundles.
    expect(
      (bodyOf(open).content['migrations'] as unknown as { migrationId: string }[]).map(
        (m) => m.migrationId,
      ),
    ).toEqual(five)
    // The digest is of the names: another name is another digest.
    await runAsSuperuser(pg17, production.database, [
      `UPDATE supabase_migrations.schema_migrations SET name = 'hotfix-2' WHERE version = '20250201000000'`,
    ])
    const renamed = await w.plan(production, { migrationIds: five })
    expect(
      (bodyOf(renamed).content['expectedState'] as { legacyLedger: { digest: string } })
        .legacyLedger.digest,
    ).not.toBe((ledger as { digest: string }).digest)
    // The digest is of the rows in the order of the ledger's version column, not of its text
    // (review L2): a numeric version 9 comes before 20250101000000.
    await runAsSuperuser(pg17, production.database, [
      'ALTER TABLE supabase_migrations.schema_migrations ALTER COLUMN version TYPE bigint USING version::bigint',
      "INSERT INTO supabase_migrations.schema_migrations VALUES (9, 'early', NULL)",
      `GRANT SELECT (version, name) ON supabase_migrations.schema_migrations TO ${ROLE_NAMES.observer}`,
    ])
    const numeric = await w.plan(production, { migrationIds: five })
    const expected = canonicalBytes([
      { version: '9', name: 'early' },
      { version: '20250101000000', name: 'init' },
      { version: '20250201000000', name: 'hotfix-2' },
    ])
    if (!expected.ok) throw new Error('canonical bytes')
    expect(
      (bodyOf(numeric).content['expectedState'] as { legacyLedger: unknown }).legacyLedger,
    ).toEqual({
      source: 'supabase',
      status: 'read',
      entries: 3,
      digest: `sha256:${sha256Hex(expected.value)}`,
    })
  })

  it('cannot be overridden by a break-glass grant naming the rule', async () => {
    const grantId = `bgl_${w.ulid()}`
    await w.h.db.asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
         VALUES ($1, 'human', 'invited', 'observed@example.test', 'observed@example.test', decode(repeat('ab', 32), 'hex'))
         ON CONFLICT DO NOTHING`,
        [w.a.identityId],
      )
      await c.query(
        `INSERT INTO breakglass.grants (grant_id, identity_id, target_id, rules, reason, expires_at)
         VALUES ($1, $2, $3, ARRAY['migration.observed-target', 'migration.staging-evidence'],
                 'Test: a grant cannot let a plan for an observed target through.',
                 clock_timestamp() + interval '30 minutes')`,
        [grantId, w.a.identityId, production.record.targetId],
      )
    })
    const sixth = w.bundle({
      name: 'under-grant',
      up: 'CREATE TABLE public.step_8 (id int);\n',
      dependsOn: [five[4] as string],
    })
    const glass = await w.plan(production, {
      bundles: [sixth],
      breakGlassGrantId: grantId as never,
    })
    expect(glass.decision).toBe('deny')
    expect(resultOf(glass, 'migration.observed-target')).toBe('fail')
    expect(bodyOf(glass).policy.overriddenRules ?? []).not.toContain('migration.observed-target')
  })

  /** Test-only edit: a denied plan never becomes active or consumed (the plans' guard is bypassed once). */
  async function force(plan: PlanRecord, state: 'active' | 'consumed') {
    await w.h.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE operations.plans SET state = $2, decision = 'allow' WHERE plan_id = $1`,
        [plan.planId, state],
      )
      await c.query('COMMIT')
    })
  }

  it('invalidates a plan forced to active at the bindings, audited, and refuses it at execute', async () => {
    const forced = await w.plan(production, { migrationIds: five })
    await force(forced, 'active')
    // Review M1: a changed binding, not a thrown error, so accept ends the plan and audits it.
    const stale = await w.accept(forced).then(
      () => undefined,
      (error: unknown) => error as { code: string; changedBindings: unknown },
    )
    expect(stale).toMatchObject({
      code: 'PLAN_STALE',
      changedBindings: [{ binding: 'target', actual: 'observed' }],
    })
    const { rows } = await w.h.worker.query(
      'test.observed.invalidated',
      `SELECT (SELECT state FROM operations.plans WHERE plan_id = $1) AS state,
              (SELECT count(*)::int FROM audit.audit_events
                WHERE action = 'plan.invalidated' AND (event::jsonb)->'refs'->>'planId' = $1) AS audited`,
      [forced.planId],
    )
    expect([rows[0]?.text('state'), rows[0]?.int('audited')]).toEqual(['invalidated', 1])
    const kind = migrationKinds({
      store: w.h.worker,
      keyring: w.h.keyring,
      clock: systemClock,
      connector: w.h.workerConnector,
      installationId: w.h.db.installationId,
      engineVersion: '0.1.0+test',
    }).find((k) => k.kind === 'migration.apply')
    if (kind === undefined) throw new Error('migration.apply kind')
    expect(await kind.checkBindings(forced)).toEqual([{ binding: 'target', actual: 'observed' }])
    const outcome = await kind.execute({
      plan: forced,
      operationId: 'op_01M6HQW7JQYHC8YR9KNTQ4PFFZ',
      leaseOwner: 'test',
      signal: new AbortController().signal,
    })
    expect(outcome).toMatchObject({ outcome: 'not_applied', errorCode: 'TARGET_OBSERVED_ONLY' })
    expect(await footprint()).not.toHaveProperty('schemas', expect.arrayContaining(['exponetdb']))
  })

  it('fails a queued operation of a forced plan at the worker start instead of keeping it queued', async () => {
    const forced = await w.plan(production, { migrationIds: five })
    await force(forced, 'consumed')
    const operationId = `op_${w.ulid()}`
    await w.h.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `INSERT INTO operations.operations
           (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome,
            actor_kind, actor_id, client_kind, client_id)
         VALUES ($1, $2, 'migration.apply', 1, 'queued', 'not_started', 'pending', 'human', $3, 'web', NULL)`,
        [operationId, forced.planId, w.a.identityId],
      )
      await c.query(
        `INSERT INTO operations.operation_events (operation_id, kind, to_state) VALUES ($1, 'created', 'queued')`,
        [operationId],
      )
      await c.query('COMMIT')
    })
    await w.drive()
    expect(await w.operation(operationId)).toMatchObject({
      state: 'failed',
      applyOutcome: 'not_started',
    })
    expect((await operationError(w.h, operationId)).code).toBe('PLAN_STALE')
    expect(await footprint()).not.toHaveProperty('schemas', expect.arrayContaining(['exponetdb']))
  })

  it('refuses every other migration plan and the ledger reads with TARGET_OBSERVED_ONLY', async () => {
    const t = production
    expect(
      await code(
        w.h.serve.transaction('test.observed.reconcile', (tx) =>
          planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, {
            decision: 'adopt_target',
            note: 'An observed target has no ledger to reconcile with the mirror.',
          }),
        ),
      ),
    ).toBe('TARGET_OBSERVED_ONLY')
    const plans = (label: string, fn: Parameters<typeof w.h.serve.transaction>[1]) =>
      code(w.h.serve.transaction(`test.observed.${label}`, fn))
    const id = five[0] as string
    const refused = {
      verify: await plans('verify', (tx) =>
        planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, id, {}),
      ),
      verifyBaseline: await plans('verify_baseline', (tx) =>
        planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, BASELINE, {}),
      ),
      resume: await plans('resume', (tx) =>
        planMigrationResume(tx, w.ctx, w.a, t.record.targetId, id, {}),
      ),
      rollback: await plans('rollback', (tx) =>
        planMigrationRollback(tx, w.ctx, w.a, t.record.targetId, id),
      ),
      baseline: await plans('baseline', (tx) =>
        planBaseline(tx, w.ctx, w.a, t.record.targetId, 'rpt_01M6HQW7JQYHC8YR9KNTQ4PFFZ'),
      ),
      importAnalysis: await plans('import', (tx) =>
        planImportAnalysis(tx, w.ctx, w.a, t.record.targetId, {
          scratchTarget: staging.record.targetId,
          baseline: 'other',
          files: [],
        }),
      ),
    }
    expect(refused).toEqual({
      verify: 'TARGET_OBSERVED_ONLY',
      verifyBaseline: 'TARGET_OBSERVED_ONLY',
      resume: 'TARGET_OBSERVED_ONLY',
      rollback: 'TARGET_OBSERVED_ONLY',
      baseline: 'TARGET_OBSERVED_ONLY',
      importAnalysis: 'TARGET_OBSERVED_ONLY',
    })
    const deps = {
      store: w.h.serve,
      connector: w.h.serveConnector,
      installationId: w.h.db.installationId,
    }
    expect(await code(migrationStatus(deps, t.record))).toBe('TARGET_OBSERVED_ONLY')
    expect(await code(migrationDetail(deps, t.record, id))).toBe('TARGET_OBSERVED_ONLY')
  })

  it('refuses a copy of the database (oid) and another cluster (system identifier)', async () => {
    const databaseId = production.record.placement?.databaseId
    const edit = (statement: string, value: unknown) =>
      w.h.db.asSuperuser(async (c) => {
        // Test-only edit: the registry keeps a recorded oid and a pinned system identifier.
        await c.query('BEGIN')
        await c.query('SET LOCAL session_replication_role = replica')
        await c.query(statement, [value])
        await c.query('COMMIT')
      })
    await edit(
      'UPDATE registry.databases SET observed_oid = observed_oid + 7 WHERE database_id = $1',
      databaseId,
    )
    try {
      expect(await refusal(w.plan(production, { migrationIds: five }))).toMatchObject({
        code: 'TARGET_IDENTITY_MISMATCH',
        details: { reason: 'database_oid' },
      })
    } finally {
      await edit(
        'UPDATE registry.databases SET observed_oid = observed_oid - 7 WHERE database_id = $1',
        databaseId,
      )
    }
    const clusterId = production.record.placement?.clusterId
    const { rows } = await w.h.worker.query(
      'test.observed.sysid',
      'SELECT system_identifier FROM registry.clusters WHERE cluster_id = $1',
      [clusterId],
    )
    const pinned = rows[0]?.text('system_identifier')
    await w.h.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(`UPDATE registry.clusters SET system_identifier = '1' WHERE cluster_id = $1`, [
        clusterId,
      ])
      await c.query('COMMIT')
    })
    try {
      expect(await code(w.plan(production, { migrationIds: five }))).toBe(
        'CLUSTER_IDENTITY_MISMATCH',
      )
    } finally {
      await w.h.db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query('SET LOCAL session_replication_role = replica')
        await c.query(`UPDATE registry.clusters SET system_identifier = $2 WHERE cluster_id = $1`, [
          clusterId,
          pinned,
        ])
        await c.query('COMMIT')
      })
    }
    expect((await w.plan(production, { migrationIds: five })).decision).toBe('deny')
  })
})
