import { appendAuditEvent } from '@exponetdb/audit'
import { AuthError } from '@exponetdb/auth'
import type { Finding, OperationView, PlanView } from '@exponetdb/contracts'
import {
  type AdvisorCategory,
  type AdvisorRun,
  type FindingSummary,
  findingSummary,
  listClusterFindings,
  planCancel,
  planTerminate,
  type QueryStats,
  type QueryStatsRequest,
  queryStats,
  runAdvisors,
  type TableStats,
  type TableStatsRequest,
  type TerminateCondition,
  tableStats,
} from '@exponetdb/diagnostics'
import {
  findTarget,
  getCluster,
  type PageRequest,
  RegistryError,
  type TargetRecord,
  type TargetVisibility,
} from '@exponetdb/registry'
import type { ReadParties } from './queries.ts'
import type { CallerLike, Idempotency, RegistryHost, RegistryServices } from './registry.ts'

/**
 * The diagnostics of Wave 9 Part B ([performance.md](../../../exponetdb-docs/10-observability/performance.md)):
 * statement statistics (sampled), table statistics and advisors (live,
 * read-only), the finding summary and cluster findings, and the session
 * actions (`connections.cancel` as an inline low plan,
 * `connections.terminate.plan` as a stored plan). As everywhere in this
 * package, the central engine decides first on a subject the registry
 * resolved, then the diagnostics package runs; REST and MCP call these
 * methods and nothing else.
 */
export interface PerformanceHost extends RegistryHost {
  parties(caller: CallerLike): ReadParties
}

/** An MCP caller reads at most 500 characters of a statement (RED-2), a person 2,000. */
const readerOf = (caller: CallerLike): 'agent' | 'human' =>
  (caller as { readonly resource?: string }).resource === 'mcp' ? 'agent' : 'human'

export class PerformanceUseCases {
  readonly #h: PerformanceHost

  constructor(host: PerformanceHost) {
    this.#h = host
  }

  #services(): RegistryServices {
    const s = this.#h.services
    if (s === undefined) throw new AuthError('CONTROL_PLANE_DEGRADED')
    return s
  }

  /** Admission first, then the lookup (error-model.md §4), then the decision on the target. */
  async #target(action: string, caller: CallerLike, ref: string): Promise<TargetRecord> {
    await this.#h.admit(this.#h.store, action, caller)
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
    await this.#h.authorize(this.#h.store, action, caller, {
      kind: 'target',
      targetId: target.targetId,
    })
    return target
  }

  /** The targets a caller may read with the action's permission (the target list's rule). */
  async #visibility(caller: CallerLike, action: string): Promise<TargetVisibility> {
    const admission = await this.#h.admit(this.#h.store, action, caller)
    const v = {
      all: false,
      productIds: [] as string[],
      projectIds: [] as string[],
      environmentIds: [] as string[],
      targetIds: [] as string[],
    }
    for (const g of admission.grants) {
      if (g.permission !== admission.permission) continue
      switch (g.scope.kind) {
        case 'global':
          v.all = true
          break
        case 'product':
          v.productIds.push(g.scope.productId)
          break
        case 'project':
          v.projectIds.push(g.scope.projectId)
          break
        case 'environment':
          v.environmentIds.push(g.scope.environmentId)
          break
        case 'target':
          v.targetIds.push(g.scope.targetId)
          break
      }
    }
    const restricted = this.#h.restrictions(caller)
    return {
      ...v,
      ...(restricted?.targetIds === undefined ? {} : { onlyTargetIds: restricted.targetIds }),
      ...(restricted?.tiers === undefined ? {} : { onlyTiers: restricted.tiers }),
    }
  }

  /** `query_stats.list`: the sampled statement statistics of a window. */
  async queryStats(
    caller: CallerLike,
    ref: string,
    request: Omit<QueryStatsRequest, 'reader'>,
  ): Promise<QueryStats> {
    const target = await this.#target('query_stats.list', caller, ref)
    return queryStats(
      this.#h.store,
      target,
      { ...request, reader: readerOf(caller) },
      this.#h.clock.nowMs(),
    )
  }

  /** `table_stats.list`: table and index statistics, read live. */
  async tableStats(
    caller: CallerLike,
    ref: string,
    request: TableStatsRequest,
  ): Promise<TableStats> {
    const target = await this.#target('table_stats.list', caller, ref)
    return tableStats(this.#services().observation, target, request)
  }

  /**
   * `advisor.run`: one run of the catalog's requested categories against the
   * target (read-only), its findings recorded and the run audited
   * (`advisor.run`: the run id, categories and counts, never catalog text).
   */
  async runAdvisors(
    caller: CallerLike,
    ref: string,
    categories: readonly AdvisorCategory[],
    options: { readonly requestId?: string } = {},
  ): Promise<AdvisorRun> {
    const target = await this.#target('advisor.run', caller, ref)
    const unique = [...new Set(categories)]
    const parties = this.#h.parties(caller)
    // The run, its findings and its audit event commit together (review F-4).
    return runAdvisors(
      this.#services().observation,
      target,
      unique,
      { kind: 'identity', identityId: this.#h.identityOf(caller) },
      this.#h.clock.nowMs(),
      {
        record: async (tx, run) => {
          await appendAuditEvent(
            tx,
            {
              action: 'advisor.run',
              phase: 'completed',
              actor: {
                kind: parties.actor.kind,
                identityId: parties.actor.identityId,
                label: parties.actor.label as never,
              },
              client: {
                clientId: parties.client.clientId as never,
                kind: parties.client.kind,
                grantId: parties.client.grantId as never,
                ...(parties.client.sessionId === undefined
                  ? {}
                  : { sessionId: parties.client.sessionId as never }),
              },
              subject: {
                targetId: target.targetId as never,
                targetPath: target.path,
                tier: target.tier,
              },
              ...(options.requestId === undefined
                ? {}
                : { request: { requestId: options.requestId as never } }),
              changes: {
                advisorRunId: run.id ?? null,
                catalogVersion: run.catalogVersion ?? null,
                categories: unique,
                findings: run.findings.length,
                skipped: run.skipped?.length ?? 0,
              },
              result: { status: 'succeeded' },
            },
            { clock: this.#h.clock },
          )
        },
      },
    )
  }

  /** `finding.summary`: open findings over the targets the caller may read. */
  async findingSummary(caller: CallerLike): Promise<FindingSummary> {
    const visibility = await this.#visibility(caller, 'finding.summary')
    return findingSummary(this.#h.store, visibility)
  }

  /** `cluster.finding.list`: the findings of a cluster (backups), newest first. */
  async clusterFindings(
    caller: CallerLike,
    clusterId: string,
    state: 'open' | 'resolved' | 'all',
    request: PageRequest,
  ): Promise<{ items: Finding[]; nextCursor: string | null }> {
    await this.#h.authorize(this.#h.store, 'cluster.finding.list', caller, {
      kind: 'cluster',
      clusterId,
    })
    if ((await getCluster(this.#h.store, clusterId)) === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    const page = await listClusterFindings(this.#h.store, clusterId, state, request)
    return { items: [...page.items], nextCursor: page.nextCursor }
  }

  #planContext() {
    const s = this.#services()
    return { policy: s.plans.policy, observation: s.observation }
  }

  /** `connections.cancel`: an inline low plan, accepted at once; the worker signals. */
  async cancel(
    caller: CallerLike,
    ref: string,
    pid: number,
    request: { readonly backendStart: string; readonly queryStart: string },
    idem?: Idempotency,
  ): Promise<OperationView> {
    const target = await this.#target('connections.cancel', caller, ref)
    const ctx = this.#planContext()
    return this.#h.inline(
      caller,
      'connections.cancel',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) => planCancel(tx, ctx, actor, target.targetId, { pid, ...request }),
    )
  }

  /** `connections.terminate.plan`: a stored plan, applied through `plan.apply`. */
  async planTermination(
    caller: CallerLike,
    ref: string,
    pid: number,
    request: {
      readonly backendStart: string
      readonly condition: TerminateCondition
      readonly reason?: string | undefined
    },
    idem?: Idempotency,
  ): Promise<PlanView> {
    const target = await this.#target('connections.terminate.plan', caller, ref)
    const ctx = this.#planContext()
    return this.#h.plan(
      caller,
      'connections.terminate.plan',
      idem,
      async () => ({ kind: 'target', targetId: target.targetId }),
      (tx, actor) => planTerminate(tx, ctx, actor, target.targetId, { pid, ...request }),
    )
  }
}
