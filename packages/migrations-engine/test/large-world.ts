import { readFileSync } from 'node:fs'
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
import { largeLegacyHistory, runAsSuperuser, serverFor, type TestServer } from '@exponetdb/testkit'
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
 * The world of a large legacy history (follow-up 2, F4): a cluster on
 * PostgreSQL 17, a project whose execution role owns its databases, an
 * imported target that ran the 600 files of `largeLegacyHistory` (3 MB) and
 * an empty scratch target, both with the identity service the history's
 * policies call. Shared by `legacy-large.int.test.ts` and
 * `scripts/measure-analyze-memory.ts`.
 */
export interface LargeWorld {
  readonly h: Harness
  readonly a: RegistryActor
  readonly ctx: MigrationPlanContext
  readonly history: ReturnType<typeof largeLegacyHistory>
  readonly imported: TargetRecord
  readonly scratch: TargetRecord
  /** Accepts the plan and runs the worker until the queue is idle. */
  readonly apply: (p: PlanRecord) => Promise<OperationRecord>
  /** Plans the analysis as serve does. */
  readonly plan: () => Promise<PlanRecord>
  readonly report: (p: PlanRecord) => Promise<Awaited<ReturnType<typeof importReportView>>>
  readonly close: () => Promise<void>
}

const pg17: TestServer = serverFor(17)
const suffix = Date.now().toString(36)
const slug = `lg${suffix}`
const history = largeLegacyHistory({ files: 600, bytes: 3_000_000 })

const OWNER = 'exdb_it_large_owner'
const PLATFORM_ROLES = [
  'authenticated',
  'acme_consent_writer',
  ...Array.from({ length: 7 }, (_, i) => `acme_reader_${i}`),
]

/** The identity service the history's policies call, outside the managed scope. */
const IDENTITY = [
  'CREATE SCHEMA auth',
  "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'",
  `GRANT USAGE ON SCHEMA auth TO ${OWNER}`,
  `GRANT EXECUTE ON FUNCTION auth.uid() TO ${OWNER}`,
]

export const peak = (): number => {
  const kib = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
  return Math.round(Number(kib ?? 0) / 1024)
}
export const rss = (): number => {
  const kib = /VmRSS:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
  return Math.round(Number(kib ?? 0) / 1024)
}

export async function largeWorld(): Promise<LargeWorld> {
  let h: Harness
  let a: RegistryActor
  let kinds: KindRegistry
  let ctx: MigrationPlanContext
  let clusterId = ''
  let productId = ''
  let projectId = ''
  let imported: TargetRecord
  let scratch: TargetRecord
  async function apply(p: PlanRecord): Promise<OperationRecord> {
    const result = await h.serve.transaction('test.lg.accept', (tx) =>
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
    const name = await targetDatabase(pg17, `lg_${envSlug}`, [
      `DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO %I', pg_catalog.current_database(), '${OWNER}'); END $$`,
      ...IDENTITY,
      ...extra,
    ])
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

  h = await harness('exdb_it_legacy_large')
  a = actor()
  clusterId = await readyCluster(h, a, pg17)
  await runAsSuperuser(pg17, 'postgres', [
    ...[OWNER, ...PLATFORM_ROLES].map(
      (r) =>
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`,
    ),
    `GRANT ${OWNER} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
  ])
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
      keyring: h.keyring,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      engineVersion: '0.1.0+test',
    }),
  ])
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Large history' }),
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
  // The imported target ran every file as its owner; the role grants as the platform did.
  imported = await registerTarget(
    'staging',
    history.flatMap((f) =>
      f.text.includes('GRANT acme_reader_')
        ? [f.text]
        : [`SET ROLE ${OWNER}`, f.text, 'RESET ROLE'],
    ),
  )
  scratch = await registerTarget('scratch', [])
  return {
    h,
    a,
    ctx,
    history,
    imported,
    scratch,
    apply,
    plan: () =>
      h.serve.transaction('test.lg.analyze', (tx) =>
        planImportAnalysis(tx, ctx, a, imported.targetId, {
          scratchTarget: scratch.targetId,
          baseline: 'acme-large-2026',
          files: history,
          ledgers: [],
        }),
      ),
    report: (p) =>
      h.worker.transaction('test.lg.report', (tx) =>
        importReportView(
          tx,
          imported.targetId,
          String((p.body['content'] as { reportId: string }).reportId),
        ),
      ),
    close: () => h.close(),
  }
}
