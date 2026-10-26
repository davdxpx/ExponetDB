import type { BundleSubmission, MigrationPlanRequest } from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
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
import {
  ROLE_NAMES,
  readLedgerMeta,
  readLedgerRows,
  readMigrationEvents,
} from '@exponetdb/postgres'
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
import {
  LEGACY_ALIASES,
  LEGACY_FILES,
  LEGACY_NOT_APPLICABLE,
  legacyTargetStatements,
  runAsSuperuser,
  serverFor,
  type TestServer,
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
  planMigrationApply,
} from '../src/index.ts'

/**
 * Legacy import end to end on real PostgreSQL 17 (G6 order §36): a
 * synthetic REOSA-shaped history is replayed on an explicit, empty scratch
 * target, compared with the imported target (only read), classified by
 * content first, reviewed by a person, baselined in one transaction and
 * verified; new bundles then depend on the baseline.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const slug = `leg${Date.now().toString(36)}`
let clusterId = ''
let productId = ''
let projectId = ''
let legacy: TargetRecord
let scratch: TargetRecord
let scratchDb = ''

const OWNER = 'exdb_it_legacy_owner'

async function accept(p: PlanRecord): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.legacy.accept', (tx) =>
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

async function apply(p: PlanRecord): Promise<OperationRecord> {
  const accepted = await accept(p)
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(h.worker, { workerId, kinds, clock: systemClock })
    if (r.status === 'idle') break
  }
  const op = await readOperation(h.worker, accepted.operationId)
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
  const name = await targetDatabase(pg17, `leg_${envSlug}`, [
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
  h = await harness('exdb_it_legacy')
  a = actor()
  await runAsSuperuser(pg17, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF; END $$`,
    // The optional role of the conditional policy does not exist on this cluster.
    'DROP ROLE IF EXISTS acme_agent_admin',
  ])
  clusterId = await readyCluster(h, a, pg17)
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  await runAsSuperuser(pg17, 'postgres', [
    `GRANT ${OWNER} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
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
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      engineVersion: '0.1.0+test',
    }),
  ])
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Legacy' }),
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
  legacy = await registerTarget('legacy', legacyTargetStatements(OWNER, ROLE_NAMES.observer))
  scratch = await registerTarget('scratch', [])
}, 240_000)

afterAll(async () => {
  await h?.close()
})

const BASELINE = 'acme-2026'
let reportId = ''

function analysis(target: TargetRecord) {
  return h.serve.transaction('test.legacy.analyze', (tx) =>
    planImportAnalysis(tx, ctx, a, target.targetId, {
      scratchTarget: scratch.targetId,
      baseline: BASELINE,
      files: LEGACY_FILES,
      ledgers: ['supabase', 'drizzle'],
      aliases: LEGACY_ALIASES,
      notApplicable: [...LEGACY_NOT_APPLICABLE],
    }),
  )
}

const report = () =>
  h.worker.transaction('test.legacy.report', (tx) =>
    importReportView(tx, legacy.targetId, reportId),
  )

describe('legacy import', () => {
  it('replays on the scratch target, reads the imported one and classifies by content', async () => {
    const p = await analysis(legacy)
    expect(p).toMatchObject({ kind: 'migration.import.replay', decision: 'allow' })
    reportId = String((p.body['content'] as { reportId: string }).reportId)
    const op = await apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const r = await report()
    expect(r.state).toBe('open')
    const states = Object.fromEntries(r.items.map((i) => [i.legacyId, [i.state, i.evidence]]))
    expect(states['legacy:0005_status_incidents']?.[0]).toBe('not_applicable')
    // Only its name matches a ledger entry (weak): a name never records a file (Wave 9 A2).
    expect(states['legacy:0003_notes']).toEqual([
      'unrecorded_missing',
      expect.arrayContaining(['supabase:name_hint']),
    ])
    expect(states['legacy:0001_conditional_policy']?.[0]).toBe('ambiguous')
    expect(states['legacy:0006_listing_tmp']?.[0]).toBe('superseded')
    // Content evidence: the hash ledger, a curated alias; a name alone is only a hint.
    expect(states['legacy:0008_events']).toEqual([
      'recorded_present',
      expect.arrayContaining(['drizzle:hash']),
    ])
    expect(states['legacy:0004_listing_status']).toEqual([
      'recorded_present',
      expect.arrayContaining(['supabase:alias']),
    ])
    expect(states['legacy:0002_listings']).toEqual([
      'unrecorded_present',
      expect.arrayContaining(['supabase:name_hint']),
    ])
    const strength = Object.fromEntries(r.items.map((i) => [i.legacyId, i.evidenceStrength]))
    expect(strength).toMatchObject({
      'legacy:0008_events': 'strong',
      'legacy:0009_event_index': 'strong',
      'legacy:0004_listing_status': 'curated',
      'legacy:0002_listings': 'weak',
      'legacy:0000_init': null,
    })
    expect(states['legacy:0000_init']?.[0]).toBe('unrecorded_present')
    expect(states['legacy:0009_event_index']).toEqual([
      'recorded_present',
      expect.arrayContaining(['supabase:statements']),
    ])
    expect(states['ledger:supabase:0010_deleted_file']?.[0]).toBe('ambiguous')
    expect(
      Object.keys(states).some((k) => k.startsWith('drift:') && k.includes('acme_handmade')),
    ).toBe(true)
    // The imported target was only read: no legacy row, no baseline yet.
    const opened = await h.workerConnector.forTarget(legacy, 'observer', 'test')
    try {
      expect(await opened.session.readOnly((tx) => readLedgerRows(tx))).toEqual([])
    } finally {
      await opened.session.close()
    }
  })

  it('refuses a baseline while items are unresolved', async () => {
    await expect(
      h.serve.transaction('test.legacy.baseline', (tx) =>
        planBaseline(tx, ctx, a, legacy.targetId, reportId),
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_IMPORT_AMBIGUOUS' })
  })

  it('records a decision with a note for every item that needs one, then baselines and verifies', async () => {
    const r = await report()
    for (const item of r.items.filter(
      (i) =>
        i.decision === null &&
        ['recorded_missing', 'unrecorded_missing', 'ambiguous'].includes(i.state),
    )) {
      const state =
        item.legacyId.startsWith('drift:') && item.evidence.includes('only_in_target')
          ? 'unrecorded_present'
          : item.legacyId === 'legacy:0001_conditional_policy'
            ? 'unrecorded_present'
            : item.legacyId.startsWith('ledger:')
              ? 'not_applicable'
              : 'recorded_missing'
      await h.serve.transaction('test.legacy.decide', (tx) =>
        decideImportItem(tx, {
          targetId: legacy.targetId,
          reportId,
          itemId: Number(item.itemId),
          state,
          note: `reviewed in the test: ${state}`,
          identityId: a.identityId,
        }),
      )
    }
    expect((await report()).state).toBe('resolved')
    const p = await h.serve.transaction('test.legacy.baseline', (tx) =>
      planBaseline(tx, ctx, a, legacy.targetId, reportId),
    )
    expect(p).toMatchObject({ kind: 'migration.baseline', decision: 'allow' })
    const op = await apply(p)
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    const opened = await h.workerConnector.forTarget(legacy, 'observer', 'test')
    try {
      const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
      const ids = rows.map((x) => x.migrationId)
      expect(ids).toContain(`baseline:${BASELINE}`)
      expect(ids).toContain('legacy:0009_event_index')
      expect(ids).not.toContain('legacy:0003_notes')
      expect(ids).not.toContain('legacy:0005_status_incidents')
      expect(rows.find((x) => x.migrationId === 'legacy:0008_events')?.checksumProvenance).toBe(
        'legacy_tool_hash',
      )
      const meta = await opened.session.readOnly((tx) => readLedgerMeta(tx))
      expect(meta?.baselineId).toBe(`baseline:${BASELINE}`)
      const events = await opened.session.readOnly((tx) =>
        readMigrationEvents(tx, { migrationId: `baseline:${BASELINE}` }),
      )
      expect(events.map((e) => e.event)).toEqual(['baselined'])
    } finally {
      await opened.session.close()
    }
    expect((await report()).state).toBe('baselined')
  })

  it('lets new bundles depend on the baseline, and refuses a second import or a used scratch target', async () => {
    const id = newId('prc', Date.now()).slice(4)
    const migrationId = `01${id.slice(2)}`
    const bundle: BundleSubmission = {
      directory: `${migrationId}_after-baseline`,
      files: {
        'migration.yaml': [
          'schema: exponetdb.migration/v1',
          `id: ${migrationId}`,
          'name: after-baseline',
          'description: "The first change after the legacy history was baselined."',
          `dependsOn: ["baseline:${BASELINE}"]`,
          'execution:',
          '  transactional: true',
          'compatibility:',
          '  declared: additive',
          'verification:',
          '  expectations: auto',
          '  runtimeChecks: none',
          '',
        ].join('\n'),
        'up.sql': 'CREATE TABLE public.acme_after (id int);\n',
      },
    }
    const planned = await h.serve.transaction('test.legacy.next', (tx: Tx) =>
      planMigrationApply(tx, ctx, a, legacy.targetId, {
        bundles: [bundle],
        defaults: {
          lockTimeout: '5s',
          statementTimeout: '15m',
          role: 'owner',
          searchPath: ['public'],
        },
        lintProfile: 'standard',
      } as MigrationPlanRequest),
    )
    expect(planned.decision).toBe('allow')
    const op = await apply(planned)
    expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    // A baselined target is not imported again (that is a deliberate rebaseline).
    await expect(analysis(legacy)).rejects.toMatchObject({ code: 'CONFLICT' })
    // The scratch target holds the replay now: another analysis there is refused, never mixed.
    const other = await registerTarget('other', legacyTargetStatements(OWNER, ROLE_NAMES.observer))
    const second = await apply(await analysis(other))
    expect(second.state).not.toBe('succeeded')
    const reportOf = String((second as unknown as { planId: string }).planId)
    expect(reportOf).toMatch(/^pln_/)
    const { rows } = await h.worker.query(
      'test.legacy.incomplete',
      `SELECT state, incomplete_reason FROM migrations.import_reports WHERE target_id = $1`,
      [other.targetId],
    )
    expect(rows.map((r) => [r.text('state'), r.textOrNull('incomplete_reason')])).toEqual([
      ['incomplete', 'scratch_not_empty'],
    ])
    expect(scratchDb).not.toBe('')
  })
})
