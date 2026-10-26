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
import { ROLE_NAMES, TargetError } from '@exponetdb/postgres'
import {
  type Connector,
  findTarget,
  noBackupEngine,
  planEnvironmentCreate,
  planExecutionRoleBindings,
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
  importReportView,
  type MigrationPlanContext,
  migrationKinds,
  planImportAnalysis,
  scratchCheck,
} from '../src/index.ts'

/**
 * How ledger entries relate to files, on real PostgreSQL 17 (Wave 9 Part A,
 * review round 1; legacy-import.md §2.3, §2.4):
 *
 * - content proves that one file ran, never which of several files with the
 *   same content: an entry that names one takes it; as many entries as files
 *   pair up; fewer entries than files record none of them
 *   (`content_matches_files:<n>`, ambiguous);
 * - an alias the entry's own statements contradict records nothing
 *   (`alias_contradicted`);
 * - a role effect that cannot be derived from the text keeps a file
 *   ambiguous even when later files superseded its objects;
 * - a scratch target on another major, or whose environment resolves the
 *   alias to another role than the imported target's, is not ready, and the
 *   replay refuses the major.
 */
let h: Harness
let a: RegistryActor
let kinds: KindRegistry
let ctx: MigrationPlanContext
const pg17: TestServer = serverFor(17)
const pg16: TestServer = serverFor(16)
const suffix = Date.now().toString(36)
const slug = `lm${suffix}`
let clusterId = ''
let productId = ''
let projectId = ''
const OWNER = 'exdb_it_ledger_match_owner'
const OTHER_OWNER = 'exdb_it_ledger_match_other'
let imported: TargetRecord
let scratch: TargetRecord

// Data statements: the same content in two files, without objects one could supersede.
const FIX = "UPDATE public.lm_t SET plan = 'free' WHERE plan IS NULL;\n"
const SEED = 'UPDATE public.lm_t SET plan = lower(plan);\n'
const FLAG = 'UPDATE public.lm_t SET plan = upper(plan);\n'
const APPLIED_EV = "UPDATE public.lm_t SET plan = 'pro' WHERE id = 2;\n"
const DUP = "UPDATE public.lm_t SET plan = 'y';\n"
const FILES = [
  { name: '0001_t.sql', text: 'CREATE TABLE public.lm_t (id int PRIMARY KEY, plan text);\n' },
  { name: '0002_fix.sql', text: FIX },
  // The same content as 0002, never recorded: its own entry is missing.
  { name: '0003_fix_again.sql', text: FIX },
  {
    name: '0004_x.sql',
    text: `CREATE TABLE public.lm_x (id int);\nGRANT ${OTHER_OWNER} TO CURRENT_USER;\n`,
  },
  { name: '0005_drop_x.sql', text: 'DROP TABLE public.lm_x;\n' },
  // Two files, two entries of the same content, neither named after a file.
  { name: '0006_seed.sql', text: SEED },
  { name: '0007_seed_again.sql', text: SEED },
  // An alias says one entry stands for both; the entry holds only the first.
  { name: '0008_notes.sql', text: 'CREATE TABLE public.lm_notes (id int);\n' },
  { name: '0009_notes_index.sql', text: 'CREATE INDEX lm_notes_id ON public.lm_notes (id);\n' },
  // Two files, one entry of their content, named after neither.
  { name: '0010_flag.sql', text: FLAG },
  { name: '0011_flag_again.sql', text: FLAG },
  // Review round 2. Edited after it ran; a copy keeps the text that ran.
  { name: '0012_ev.sql', text: "UPDATE public.lm_t SET plan = 'pro' WHERE id = 1;\n" },
  { name: '0013_ev_copy.sql', text: APPLIED_EV },
  // Reformatted after it ran (medium); a copy keeps the bytes that ran (strong).
  { name: '0014_fmt.sql', text: "UPDATE   public.lm_t   SET plan = 'x';\n" },
  { name: '0015_fmt_copy.sql', text: "UPDATE public.lm_t SET plan = 'x';\n" },
  // Two entries name the first file (two versions); the copy ran by neither.
  { name: '0016_dup.sql', text: DUP },
  { name: '0017_dup_copy.sql', text: DUP },
]
const text = (name: string) => FILES.find((f) => f.name === name)?.text.trim() ?? ''

async function apply(p: PlanRecord, using: KindRegistry = kinds): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.lm.accept', (tx) =>
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
      registryAcceptDependencies(
        tx,
        { policy: ctx.policy, kinds: using, systemActor: WORKER_ACTOR },
        a,
      ),
    ),
  )
  if (result.status !== 'accepted') throw result.error
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(h.worker, { workerId, kinds: using, clock: systemClock })
    if (r.status === 'idle') break
  }
  const op = await readOperation(h.worker, result.operation.operationId)
  if (op === undefined) throw new Error('operation vanished')
  return op
}

async function environment(envSlug: string): Promise<string> {
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      slug: envSlug,
      displayName: envSlug,
      tier: 'nonprod',
    }),
  )
  return String((await planContent(h, env.plan.planId))['environmentId'])
}

async function registerTarget(
  envSlug: string,
  extra: readonly string[],
  on: { server: TestServer; clusterId: string } = { server: pg17, clusterId },
): Promise<TargetRecord> {
  const environmentId = await environment(envSlug)
  const name = await targetDatabase(on.server, `lm_${envSlug}`, [
    `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER}`,
    ...extra,
  ])
  const databaseId = await registerDatabase(h, a, on.clusterId, name)
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

const deps = () => ({ connector: h.workerConnector, installationId: h.db.installationId })

const roles = (s: TestServer) =>
  runAsSuperuser(s, 'postgres', [
    ...[OWNER, OTHER_OWNER].map(
      (r) =>
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`,
    ),
    `GRANT ${OWNER}, ${OTHER_OWNER} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
  ])

beforeAll(async () => {
  h = await harness('exdb_it_ledger_match')
  a = actor()
  // readyCluster creates ExponetDB's roles; the grant to the migrator needs them.
  clusterId = await readyCluster(h, a, pg17)
  await roles(pg17)
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
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
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      engineVersion: '0.1.0+test',
    }),
  ])
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Ledger match' }),
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
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`
  const entry = (version: string, name: string, statements: readonly string[]) =>
    `('${version}', ARRAY[${statements.map(q).join(', ')}]::text[], '${name}')`
  imported = await registerTarget('staging', [
    `SET ROLE ${OWNER}`,
    text('0001_t.sql'),
    'CREATE TABLE public.lm_x (id int)',
    text('0005_drop_x.sql'),
    text('0008_notes.sql'),
    text('0009_notes_index.sql'),
    'RESET ROLE',
    'CREATE SCHEMA supabase_migrations',
    'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)',
    `INSERT INTO supabase_migrations.schema_migrations VALUES
       ${entry('20260101090000', '0001_t', [text('0001_t.sql')])},
       ${entry('20260102090000', '0002_fix', [FIX.trim()])},
       ${entry('20260104090000', '0004_x', [`CREATE TABLE public.lm_x (id int)`, `GRANT ${OTHER_OWNER} TO CURRENT_USER`])},
       ${entry('20260105090000', '0005_drop_x', [text('0005_drop_x.sql')])},
       ${entry('20260106090000', 'seed_a', [SEED.trim()])},
       ${entry('20260107090000', 'seed_b', ['UPDATE public.lm_t  SET plan =  lower(plan)'])},
       ${entry('20260109090000', 'seed_c', [SEED.trim()])},
       ${entry('20260108090000', 'notes', [text('0008_notes.sql')])},
       ${entry('20260110090000', 'flags', [FLAG.trim()])},
       ${entry('20260112090000', '0012_ev', [APPLIED_EV.trim()])},
       ${entry('20260114090000', '0014_fmt', ["UPDATE public.lm_t SET plan = 'x'"])},
       ${entry('20260116090000', '0016_dup', [DUP.trim()])},
       ${entry('20260116100000', '0016_dup', [DUP.trim()])}`,
    `GRANT USAGE ON SCHEMA supabase_migrations TO ${ROLE_NAMES.observer}`,
    `GRANT SELECT ON supabase_migrations.schema_migrations TO ${ROLE_NAMES.observer}`,
  ])
  scratch = await registerTarget('scratch', [])
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe('ledger entries and files of the same content', () => {
  it('records a file by content once, and leaves to a person what content cannot tell', async () => {
    const p = await h.serve.transaction('test.lm.analyze', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: scratch.targetId,
        baseline: 'ledger-match-2026',
        files: FILES,
        ledgers: ['supabase'],
        aliases: { notes: ['0008_notes', '0009_notes_index'] },
      }),
    )
    expect(p.decision).toBe('allow')
    expect(await apply(p)).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const reportId = String((p.body['content'] as { reportId: string }).reportId)
    const r = await h.worker.transaction('test.lm.report', (tx) =>
      importReportView(tx, imported.targetId, reportId),
    )
    const item = (stem: string) => {
      const i = r.items.find((x) => x.legacyId === `legacy:${stem}`)
      if (i === undefined) throw new Error(`no item ${stem}`)
      return { state: i.state, strength: i.evidenceStrength, evidence: i.evidence }
    }
    // An entry that names one of two files of the same content takes that one only.
    expect(item('0002_fix')).toMatchObject({ state: 'recorded_present', strength: 'strong' })
    expect(item('0003_fix_again')).toMatchObject({ state: 'ambiguous', strength: null })
    expect(item('0003_fix_again').evidence).toEqual(['effects_not_derivable'])
    // As many entries as files: each file has its own, also when one entry matches only
    // with whitespace normalized; an entry beyond the files stays a ledger item.
    expect(item('0006_seed')).toMatchObject({ state: 'recorded_present', strength: 'strong' })
    expect(item('0007_seed_again')).toMatchObject({ state: 'recorded_present', strength: 'medium' })
    expect(r.items.map((i) => i.legacyId)).toContain('ledger:supabase:20260109090000_seed_c')
    // An entry that names a file never records another one of the same content.
    expect(item('0013_ev_copy').state).toBe('ambiguous')
    expect(item('0013_ev_copy').evidence).toContain('content_names_other_file')
    expect(item('0014_fmt')).toMatchObject({ state: 'recorded_present', strength: 'medium' })
    expect(item('0015_fmt_copy')).toMatchObject({ state: 'ambiguous', strength: null })
    expect(item('0016_dup')).toMatchObject({ state: 'recorded_present', strength: 'strong' })
    expect(item('0017_dup_copy').state).toBe('ambiguous')
    expect(item('0017_dup_copy').evidence).toContain('content_names_other_file')
    // Fewer entries than files: none is recorded by it, a person decides.
    for (const stem of ['0010_flag', '0011_flag_again']) {
      expect(item(stem).state).toBe('ambiguous')
      expect(item(stem).evidence).toContain('content_matches_files:2')
    }
    // The alias is contradicted by the entry's own statements: the second file is not recorded.
    expect(item('0008_notes')).toMatchObject({ state: 'recorded_present', strength: 'strong' })
    expect(item('0009_notes_index')).toMatchObject({ state: 'ambiguous', strength: 'weak' })
    expect(item('0009_notes_index').evidence).toContain('supabase:alias_contradicted')
    // A role effect no text can tell outlives the objects a later file dropped.
    expect(item('0004_x').state).toBe('ambiguous')
    expect(item('0004_x').evidence).toEqual(
      expect.arrayContaining(['expectations_superseded', 'cluster_global_unknown']),
    )
  })
})

describe('a scratch target that cannot stand for the imported one', () => {
  it('names an execution role other than the imported target resolves', async () => {
    await run(h, a, (tx) =>
      planExecutionRoleBindings(tx, h.context, a, projectId, scratch.environmentId, {
        roles: { owner: OTHER_OWNER },
      }),
    )
    const r = await scratchCheck(h.worker, deps(), imported, scratch.targetId)
    expect(r.ready).toBe(false)
    expect(r.checks.find((c) => c.check === 'execution_role')).toMatchObject({
      status: 'fail',
      detail: 'differs_from_target',
      items: [OTHER_OWNER, OWNER],
    })
    await run(h, a, (tx) =>
      planExecutionRoleBindings(tx, h.context, a, projectId, scratch.environmentId, { roles: {} }),
    )
  })

  it('refuses a scratch target on another major, in the preflight and in the replay', async () => {
    const cluster16 = await readyCluster(h, a, pg16)
    await roles(pg16)
    await submit(h, a, cluster16, 'verifier')
    await verifyCredentials(h)
    const on16 = await registerTarget('scratch16', [], { server: pg16, clusterId: cluster16 })
    const r = await scratchCheck(h.worker, deps(), imported, on16.targetId)
    expect(r.checks.find((c) => c.check === 'extensions')).toMatchObject({
      status: 'fail',
      detail: 'major_differs',
      items: expect.arrayContaining(['postgresql: target 17, scratch 16']),
    })
    const p = await h.serve.transaction('test.lm.analyze16', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: on16.targetId,
        baseline: 'ledger-match-16',
        files: [FILES[0] as (typeof FILES)[number]],
        ledgers: [],
      }),
    )
    await apply(p)
    const report = await h.worker.transaction('test.lm.report16', (tx) =>
      importReportView(
        tx,
        imported.targetId,
        String((p.body['content'] as { reportId: string }).reportId),
      ),
    )
    expect(report).toMatchObject({ state: 'incomplete', incompleteReason: 'major_differs:17/16' })
  }, 180_000)
})

describe('an imported target that cannot be read', () => {
  it('ends the analysis incomplete with target_unavailable instead of leaving it pending', async () => {
    const fresh = await registerTarget('scratch-blind', [])
    // The worker reaches every target but the imported one (a lost network, a stopped server).
    const blind = new Proxy(h.workerConnector, {
      get(t, property, receiver) {
        if (property === 'forTarget') {
          return (target: TargetRecord, ...rest: unknown[]) => {
            if (target.targetId === imported.targetId) {
              return Promise.reject(new TargetError('TARGET_UNAVAILABLE', 'connection_lost'))
            }
            return (t.forTarget as (...a: unknown[]) => unknown).call(t, target, ...rest)
          }
        }
        const value = Reflect.get(t, property, receiver)
        return typeof value === 'function' ? value.bind(t) : value
      },
    }) as Connector
    const blindKinds = new KindRegistry([
      ...migrationKinds({
        store: h.worker,
        clock: systemClock,
        connector: blind,
        installationId: h.db.installationId,
        engineVersion: '0.1.0+test',
      }),
    ])
    const p = await h.serve.transaction('test.lm.analyze_blind', (tx) =>
      planImportAnalysis(tx, ctx, a, imported.targetId, {
        scratchTarget: fresh.targetId,
        baseline: 'ledger-match-blind',
        files: [FILES[0] as (typeof FILES)[number]],
        ledgers: [],
      }),
    )
    const op = await apply(p, blindKinds)
    expect(op).toMatchObject({ applyOutcome: 'not_applied' })
    const report = await h.worker.transaction('test.lm.report_blind', (tx) =>
      importReportView(
        tx,
        imported.targetId,
        String((p.body['content'] as { reportId: string }).reportId),
      ),
    )
    expect(report).toMatchObject({ state: 'incomplete', incompleteReason: 'target_unavailable' })
  })
})
