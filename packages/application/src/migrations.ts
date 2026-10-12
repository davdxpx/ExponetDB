import { AuthError } from '@exponetdb/auth'
import type {
  BundleFile,
  BundleIngestRequest,
  BundleIngestResult,
  BundleView,
  MigrationDetail,
  MigrationLintRequest,
  MigrationLintResult,
  MigrationPlanRequest,
  MigrationStatus,
  OperationView,
  PlanView,
} from '@exponetdb/contracts'
import {
  bundleFile,
  bundleView,
  ingestBundles,
  lintProject,
  migrationDetail,
  migrationStatus,
  planMigrationApply,
  planMigrationRollback,
  planMigrationVerify,
} from '@exponetdb/migrations-engine'
import { findTarget, getProject, RegistryError, type TargetRecord } from '@exponetdb/registry'
import type { CallerLike, Idempotency, RegistryHost } from './registry.ts'

/**
 * The migration use cases of Wave 6 ([planning-and-apply.md §1](../../../exponetdb-docs/04-migrations/planning-and-apply.md#1-the-two-calls)):
 * bundle ingestion, the project lint, planning `migration.apply` (applied
 * through `plan.apply` like every plan), and the live reads of a target's
 * migrations. The central engine decides first on a subject the server
 * resolves from the registry, never from the request; the engine package
 * does the rest.
 */
export class MigrationUseCases {
  readonly #h: RegistryHost

  constructor(host: RegistryHost) {
    this.#h = host
  }

  #services() {
    const s = this.#h.services
    if (s === undefined) {
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    return s
  }

  async #target(action: string, caller: CallerLike, ref: string): Promise<TargetRecord> {
    await this.#h.admit(this.#h.store, action, caller)
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) {
      throw new RegistryError('TARGET_NOT_FOUND')
    }
    await this.#h.authorize(this.#h.store, action, caller, {
      kind: 'target',
      targetId: target.targetId,
    })
    return target
  }

  async #project(action: string, caller: CallerLike, projectId: string): Promise<void> {
    await this.#h.admit(this.#h.store, action, caller)
    if ((await getProject(this.#h.store, projectId)) === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    await this.#h.authorize(this.#h.store, action, caller, { kind: 'project', projectId })
  }

  /** `migration.bundle.ingest`: stores bundles (validated and hashed here) without planning. */
  async ingest(
    caller: CallerLike,
    projectId: string,
    request: BundleIngestRequest,
  ): Promise<BundleIngestResult> {
    await this.#project('migration.bundle.ingest', caller, projectId)
    const items = await this.#h.store.transaction('application.migrations.ingest', async (tx) => {
      await this.#h.authorize(tx, 'migration.bundle.ingest', caller, { kind: 'project', projectId })
      return ingestBundles(tx, {
        projectId,
        bundles: request.bundles,
        defaults: request.defaults ?? {},
        ...(request.source === undefined ? {} : { source: request.source }),
        identityId: this.#h.identityOf(caller),
      })
    })
    return {
      items: items.map((i) => ({
        migrationId: i.revision.migrationId,
        name: i.revision.name,
        checksum: i.revision.checksum,
        revision: i.revision.revision,
        status: i.status,
      })),
    } as unknown as BundleIngestResult
  }

  /** `migration.lint`: the shared linter on submitted bundles (read-only, offline facts). */
  async lint(
    caller: CallerLike,
    projectId: string,
    request: MigrationLintRequest,
  ): Promise<MigrationLintResult> {
    await this.#project('migration.lint', caller, projectId)
    return (await lintProject(this.#h.store, projectId, request)) as unknown as MigrationLintResult
  }

  /** `migration.plan`: a stored, immutable plan bound to the live target (also when denied). */
  async plan(
    caller: CallerLike,
    ref: string,
    request: MigrationPlanRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('migration.plan', caller, ref)
    return this.#h.plan(
      caller,
      'migration.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) => planMigrationApply(tx, this.#context(), actor, target.targetId, request),
    )
  }

  #context() {
    const { plans } = this.#services()
    return {
      policy: plans.policy,
      installationId: plans.installationId,
      connector: plans.connector,
    }
  }

  /** `migration.verify`: verification of an applied migration again (inline low plan; never up.sql). */
  async verify(
    caller: CallerLike,
    ref: string,
    migrationId: string,
    request: { readonly revision?: number | undefined },
    idem?: Idempotency,
  ): Promise<OperationView> {
    const target = await this.#target('migration.verify', caller, ref)
    return this.#h.inline(
      caller,
      'migration.verify',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) =>
        planMigrationVerify(tx, this.#context(), actor, target.targetId, migrationId, request),
    )
  }

  /** `migration.rollback.plan`: an explicit rollback plan (down.sql), applied through `plan.apply`. */
  async planRollback(
    caller: CallerLike,
    ref: string,
    migrationId: string,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('migration.rollback.plan', caller, ref)
    return this.#h.plan(
      caller,
      'migration.rollback.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) =>
        planMigrationRollback(tx, this.#context(), actor, target.targetId, migrationId),
    )
  }

  /** `migration.status.get`: the target's migrations, live. */
  async status(caller: CallerLike, ref: string): Promise<MigrationStatus> {
    const { observation } = this.#services()
    const target = await this.#target('migration.status.get', caller, ref)
    return (await migrationStatus(
      {
        store: this.#h.store,
        connector: observation.connector,
        installationId: observation.installationId,
      },
      target,
    )) as unknown as MigrationStatus
  }

  /** `migration.get`: one migration's history on the target, live. */
  async detail(caller: CallerLike, ref: string, migrationId: string): Promise<MigrationDetail> {
    const { observation } = this.#services()
    const target = await this.#target('migration.get', caller, ref)
    return (await migrationDetail(
      {
        store: this.#h.store,
        connector: observation.connector,
        installationId: observation.installationId,
      },
      target,
      migrationId,
    )) as unknown as MigrationDetail
  }

  async bundle(caller: CallerLike, projectId: string, migrationId: string): Promise<BundleView> {
    await this.#project('migration.bundle.get', caller, projectId)
    return (await bundleView(this.#h.store, projectId, migrationId)) as unknown as BundleView
  }

  async bundleFile(
    caller: CallerLike,
    projectId: string,
    migrationId: string,
    revision: number,
    file: 'migration.yaml' | 'up.sql' | 'verify.sql' | 'down.sql',
  ): Promise<BundleFile> {
    await this.#project('migration.bundle.get', caller, projectId)
    return (await bundleFile(
      this.#h.store,
      projectId,
      migrationId,
      revision,
      file,
    )) as unknown as BundleFile
  }
}
