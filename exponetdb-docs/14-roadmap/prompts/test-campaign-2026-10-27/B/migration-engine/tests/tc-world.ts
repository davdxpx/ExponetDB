import type { BundleSubmission, MigrationPlanRequest } from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { type MigrationId, newId, newUlid, systemClock } from '@exponetdb/kernel'
import {
  acceptPlan,
  type DispatchAdmission,
  KindRegistry,
  type OperationRecord,
  type PlanRecord,
  processNextOperation,
  readOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { MIGRATION_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import {
  type Connector,
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
import { runAsSuperuser, type TestServer } from '@exponetdb/testkit'
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
import { MigrationBaselineStore } from '../../diagnostics/src/index.ts'
import { type MigrationPlanContext, migrationKinds, planMigrationApply } from '../src/index.ts'

/**
 * A registered project with migration targets on real PostgreSQL, for the
 * engine's failure-case suites: the same setup as `engine.int.test.ts`
 * (ingestion, plans through the Operations Engine, the worker's execution
 * as the declared owner). `wrap` replaces the worker's connector, so a
 * test can put a fault between the engine and PostgreSQL (a lost COMMIT
 * reply); the planner keeps the real one.
 */
export const OWNER = 'tc_mig_owner'
export const DEFAULTS = {
  lockTimeout: '2s',
  statementTimeout: '15m',
  role: 'owner',
  searchPath: ['public'],
}

export interface Target {
  readonly record: TargetRecord
  /** The database's name on the server (for the superuser's independent checks). */
  readonly database: string
}

export interface World {
  readonly h: Harness
  readonly a: RegistryActor
  readonly ctx: MigrationPlanContext
  readonly server: TestServer
  ulid(): MigrationId
  bundle(spec: BundleSpec): BundleSubmission
  plan(target: Target, request: Partial<MigrationPlanRequest>): Promise<PlanRecord>
  accept(p: PlanRecord): Promise<OperationRecord>
  /** Runs the worker until it is idle, with a connector wrapper and a dispatch admission (default: none). */
  drive(options?: DriveOptions): Promise<void>
  apply(p: PlanRecord, options?: DriveOptions): Promise<OperationRecord>
  operation(id: string): Promise<OperationRecord>
  registerTarget(envSlug: string, tier: 'prod' | 'nonprod', evidenceFrom?: string): Promise<Target>
  readonly kindsFor: (c: Connector) => KindRegistry
  /** Replaces the policy rules (the post-break-glass state is simulated by dropping the overridable rules). */
  setRules(rules: 'registry-only' | 'all'): void
  close(): Promise<void>
}

export interface DriveOptions {
  /** Puts a fault between the worker and PostgreSQL. */
  readonly wrap?: (c: Connector) => Connector
  /** The worker's dispatch admission (the server composes the application's). */
  readonly admit?: DispatchAdmission
}

export interface BundleSpec {
  readonly id?: string
  readonly name?: string
  readonly up: string
  readonly verify?: string | null
  readonly dependsOn?: readonly string[]
  readonly declared?: string
  readonly transactional?: boolean
  /** A reviewed, safe rollback script (`down.sql`). */
  readonly down?: string
}

export async function migrationWorld(label: string, server: TestServer): Promise<World> {
  const h = await harness(label)
  const a = actor()
  await runAsSuperuser(server, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER}') THEN CREATE ROLE ${OWNER} NOLOGIN; END IF; END $$`,
  ])
  const clusterId = await readyCluster(h, a, server)
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)
  await runAsSuperuser(server, 'postgres', [
    `GRANT ${OWNER} TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE`,
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
  const kindsWith = (connector: Connector) =>
    new KindRegistry([
      ...registryKinds({
        store: h.worker,
        clock: systemClock,
        connector,
        installationId: h.db.installationId,
        controlStoreSystemIdentifier: async () => h.controlStoreSystemIdentifier,
        snapshots: h.snapshots,
        backupBindings: noBackupEngine,
      }),
      ...migrationKinds({
        store: h.worker,
        keyring: h.keyring,
        clock: systemClock,
        connector,
        installationId: h.db.installationId,
        engineVersion: '0.1.0+test',
        expected: new MigrationBaselineStore({
          store: h.worker,
          connector,
          installationId: h.db.installationId,
        }),
      }),
    ])
  const kinds = kindsWith(h.workerConnector)
  const slug = `tc${Date.now().toString(36)}`
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Failures' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      // A schema outside the managed scope: a table there is not part of a fingerprint.
      managedScope: { excludeSchemas: ['outside_scope'] },
    }),
  )
  const projectId = String((await planContent(h, project.plan.planId))['projectId'])
  await run(h, a, (tx) =>
    planProjectUpdate(tx, h.context, a, projectId, { executionRoles: { owner: OWNER } }),
  )

  let last = ''
  const world: World = {
    h,
    a,
    ctx,
    server,
    ulid() {
      let id = newUlid(Date.now())
      while (id <= last) id = newUlid(Date.now())
      last = id
      // A ULID is a migration id (26 characters, Crockford base 32).
      return id as MigrationId
    },
    bundle(spec) {
      const id = spec.id ?? world.ulid()
      const name = spec.name ?? 'change'
      const verify = spec.verify === undefined ? null : spec.verify
      const yaml = [
        'schema: exponetdb.migration/v1',
        `id: ${id}`,
        `name: ${name}`,
        'description: "A change of the failure-case suite, applied on a disposable target."',
        `dependsOn: ${JSON.stringify(spec.dependsOn ?? [])}`,
        'execution:',
        `  transactional: ${spec.transactional ?? true}`,
        'compatibility:',
        `  declared: ${spec.declared ?? 'additive'}`,
        ...(spec.declared !== undefined && spec.declared !== 'additive'
          ? ['  notes: reviewed']
          : []),
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
    },
    plan(target, request) {
      return h.serve.transaction('test.migrations.plan', (tx: Tx) =>
        planMigrationApply(tx, ctx, a, target.record.targetId, {
          defaults: DEFAULTS,
          lintProfile: 'standard',
          ...request,
        } as MigrationPlanRequest),
      )
    },
    async accept(p) {
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
          registryAcceptDependencies(tx, { policy, kinds, systemActor: WORKER_ACTOR }, a),
        ),
      )
      if (result.status !== 'accepted') throw result.error
      return result.operation
    },
    async drive(options = {}) {
      const registry =
        options.wrap === undefined ? kinds : kindsWith(options.wrap(h.workerConnector))
      const workerId = newId('prc', Date.now())
      for (let i = 0; i < 50; i++) {
        const r = await processNextOperation(h.worker, {
          workerId,
          kinds: registry,
          clock: systemClock,
          ...(options.admit === undefined ? {} : { admit: options.admit }),
        })
        if (r.status === 'idle') return
      }
      throw new Error('the worker did not become idle')
    },
    async apply(p, options) {
      const accepted = await world.accept(p)
      await world.drive(options)
      return world.operation(accepted.operationId)
    },
    async operation(id) {
      const op = await readOperation(h.worker, id)
      if (op === undefined) throw new Error('operation vanished')
      return op
    },
    async registerTarget(envSlug, tier, evidenceFrom) {
      const env = await run(h, a, (tx) =>
        planEnvironmentCreate(tx, h.context, a, productId, {
          slug: envSlug,
          displayName: envSlug,
          tier,
          ...(evidenceFrom === undefined ? {} : { evidenceFrom }),
        }),
      )
      const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
      const database = await targetDatabase(server, `tc_mig_${envSlug}`, [
        `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER}`,
      ])
      const databaseId = await registerDatabase(h, a, clusterId, database)
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
          `registration: ${JSON.stringify(await operationError(h, r.operation.operationId))}`,
        )
      }
      const record = await findTarget(
        h.worker,
        String((await planContent(h, r.plan.planId))['targetId']),
      )
      if (record === undefined) throw new Error('target not registered')
      return { record, database }
    },
    kindsFor: kindsWith,
    setRules(rules) {
      ;(policy as { registry: RuleRegistry }).registry = new RuleRegistry(
        rules === 'all' ? [...REGISTRY_RULES, ...MIGRATION_RULES] : [...REGISTRY_RULES],
      )
    },
    close: () => h.close(),
  }
  return world
}
