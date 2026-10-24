import { AuthError } from '@exponetdb/auth'
import type {
  BundleFile,
  BundleIngestRequest,
  BundleIngestResult,
  BundleView,
  ImportReport,
  MigrationDetail,
  MigrationLintRequest,
  MigrationLintResult,
  MigrationPlanRequest,
  MigrationStatus,
  MigrationStream,
  OperationView,
  PlanView,
  ScratchCheck,
} from '@exponetdb/contracts'
import {
  bundleFile,
  bundleView,
  decideImportItem,
  type ImportAnalysisInput,
  type ImportItemState,
  importReportView,
  ingestBundles,
  lintProject,
  migrationDetail,
  migrationStatus,
  planBaseline,
  planImportAnalysis,
  planMigrationApply,
  planMigrationResume,
  planMigrationRollback,
  planMigrationVerify,
  projectStream,
  refuseOversizedLegacyFiles,
  scratchCheck,
} from '@exponetdb/migrations-engine'
import {
  findTarget,
  getProject,
  getProjectByPath,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
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

  /**
   * `migration.lint`: the shared linter on submitted bundles (read-only,
   * offline facts). The project is a `prj_` id or a `<product>/<project>`
   * path (MCP); a path is resolved here, and an unknown path answers like an
   * unknown id.
   */
  async lint(
    caller: CallerLike,
    projectRef: string,
    request: MigrationLintRequest,
  ): Promise<MigrationLintResult> {
    const projectId = await this.#projectId(caller, projectRef)
    await this.#project('migration.lint', caller, projectId)
    return (await lintProject(this.#h.store, projectId, request)) as unknown as MigrationLintResult
  }

  async #projectId(caller: CallerLike, ref: string): Promise<string> {
    const path = /^([a-z][a-z0-9-]{0,38})\/([a-z][a-z0-9-]{0,38})$/.exec(ref)
    if (path === null) {
      return ref
    }
    await this.#h.admit(this.#h.store, 'migration.lint', caller)
    const project = await getProjectByPath(this.#h.store, path[1] ?? '', path[2] ?? '')
    if (project === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    return project.projectId
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

  /**
   * `migration.resume.plan`: an explicit plan that continues a non-transactional
   * bundle that stopped part-way (event log and catalog readback bound; an
   * INVALID concurrent index only with `cleanup`), applied through `plan.apply`.
   */
  async planResume(
    caller: CallerLike,
    ref: string,
    migrationId: string,
    request: { readonly cleanup?: boolean | undefined },
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('migration.resume.plan', caller, ref)
    return this.#h.plan(
      caller,
      'migration.resume.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) =>
        planMigrationResume(tx, this.#context(), actor, target.targetId, migrationId, request),
    )
  }

  /**
   * `migration.import.analyze`: plans the replay of legacy files on an explicit
   * scratch target (the person needs `migrations.import` on both targets);
   * `plan.apply` runs it and writes the import report.
   */
  async planImportAnalysis(
    caller: CallerLike,
    ref: string,
    request: ImportAnalysisInput,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('migration.import.analyze', caller, ref)
    const scratch = await this.#target('migration.import.analyze', caller, request.scratchTarget)
    return this.#h.plan(
      caller,
      'migration.import.analyze',
      idem,
      async (tx) => {
        await this.#h.authorize(tx, 'migration.import.analyze', caller, {
          kind: 'target',
          targetId: scratch.targetId,
        })
        return { kind: 'target', targetId: target.targetId }
      },
      (tx, actor) =>
        planImportAnalysis(tx, this.#context(), actor, target.targetId, {
          ...request,
          scratchTarget: scratch.targetId,
        }),
    )
  }

  /**
   * `migration.import.scratch_check`: read only, whether a scratch target can take this
   * target's legacy replay (legacy-import.md §2.5). The caller holds the action on both.
   */
  async scratchCheck(
    caller: CallerLike,
    ref: string,
    scratchRef: string,
    alias?: string,
    files?: readonly { readonly name: string; readonly text: string }[],
    notApplicable: readonly string[] = [],
  ): Promise<ScratchCheck> {
    const { observation } = this.#services()
    const target = await this.#target('migration.import.scratch_check', caller, ref)
    if (files !== undefined) refuseOversizedLegacyFiles(files)
    const scratch = await findTarget(this.#h.store, scratchRef)
    if (scratch !== undefined) {
      await this.#h.authorize(this.#h.store, 'migration.import.scratch_check', caller, {
        kind: 'target',
        targetId: scratch.targetId,
      })
    }
    return scratchCheck(
      this.#h.store,
      { connector: observation.connector, installationId: observation.installationId },
      target,
      scratch?.targetId ?? scratchRef,
      alias,
      // The replay skips what the hints call not applicable; so does the check.
      files?.filter((f) => !notApplicable.includes(f.name.slice(0, -'.sql'.length))),
    )
  }

  /** `migration.import.report.get`: one import report with its items and decisions. */
  async importReport(caller: CallerLike, ref: string, reportId: string): Promise<ImportReport> {
    const target = await this.#target('migration.import.report.get', caller, ref)
    return (await importReportView(
      this.#h.store,
      target.targetId,
      reportId,
    )) as unknown as ImportReport
  }

  /** `migration.import.decide`: a person resolves one item, with a note. */
  async decideImportItem(
    caller: CallerLike,
    ref: string,
    reportId: string,
    itemId: number,
    request: { readonly state: Exclude<ImportItemState, 'ambiguous'>; readonly note: string },
  ): Promise<ImportReport> {
    const target = await this.#target('migration.import.decide', caller, ref)
    return this.#h.store.transaction('application.migrations.decide', async (tx) => {
      await this.#h.authorize(tx, 'migration.import.decide', caller, {
        kind: 'target',
        targetId: target.targetId,
      })
      return (await decideImportItem(tx, {
        targetId: target.targetId,
        reportId,
        itemId,
        state: request.state,
        note: request.note,
        identityId: this.#h.identityOf(caller),
      })) as unknown as ImportReport
    })
  }

  /** `migration.baseline.plan`: a resolved import report becomes the target's baseline. */
  async planBaseline(
    caller: CallerLike,
    ref: string,
    request: { readonly importReportId: string },
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('migration.baseline.plan', caller, ref)
    return this.#h.plan(
      caller,
      'migration.baseline.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) =>
        planBaseline(tx, this.#context(), actor, target.targetId, request.importReportId),
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

  /**
   * `migration.stream.get` (Wave 8): the promotion stream of a project from
   * the Control Store mirrors (never a live read of a target). The engine
   * decides on the project first; each target is then shown only when the
   * engine would let the caller read its migrations, and one it refuses is
   * left out with no count (a count would say what the caller may not see).
   */
  async stream(caller: CallerLike, projectId: string): Promise<MigrationStream> {
    await this.#project('migration.stream.get', caller, projectId)
    return this.#h.store.transaction(
      'application.migrations.stream',
      (tx) =>
        projectStream(tx, projectId, (targetId) =>
          this.#h.allowed(tx, 'migration.stream.get', caller, { kind: 'target', targetId }),
        ),
      { readOnly: true, isolation: 'repeatable read' },
    )
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
