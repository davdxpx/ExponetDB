import { appendAuditEvent } from '@exponetdb/audit'
import type { ControlStore, Queryable } from '@exponetdb/control-store'
import { type Clock, isId, isJsonArray, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type ExecutionContext,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
  WORKER_ACTOR,
} from '@exponetdb/operations'

/**
 * `migration.revisions.purge` (OD-70 (d), VC-001): bundle revisions are append-only, so bytes a
 * holder of `migrations.plan` stored never left the Control Store. A person plans the purge of a
 * project's revisions that no plan references and that were ingested more than
 * {@link PURGE_AGE_DAYS} days ago; the plan lists them, and the worker deletes exactly those
 * through `migrations.purge_revisions`. The database refuses any other delete (bundle
 * `migration-revision-purge`), so a revision planned since the plan stays.
 * shortcut: a planner that read a revision just before the purge took the plans tables, and
 * writes its plan just after, gets a plan whose revision is gone; its apply fails closed (the
 * revision is missing). Locking revisions where every planner reads them would close that.
 */
export const REVISION_PURGE_KIND = 'migration.revisions.purge'
export const PURGE_AGE_DAYS = 90
/** At most this many revisions per plan (the bundle refuses more). */
export const PURGE_MAX = 1000

export interface PurgeableRevision {
  readonly migrationId: string
  readonly revision: number
  readonly bundleDigest: string
  readonly bytes: number
}

const PURGEABLE = `SELECT r.migration_id, r.revision, r.bundle_digest,
        octet_length(r.manifest_yaml) + octet_length(r.up_sql)
          + coalesce(octet_length(r.verify_sql), 0) + coalesce(octet_length(r.down_sql), 0) AS bytes
   FROM migrations.bundle_revisions r
  WHERE r.project_id = $1 AND r.ingested_at < clock_timestamp() - make_interval(days => $2)
    AND NOT migrations.revision_referenced(r.migration_id)
  ORDER BY r.ingested_at, r.migration_id, r.revision LIMIT $3`

/** The project's revisions no plan references and older than the purge age, oldest first. */
export async function purgeableRevisions(
  q: Queryable,
  projectId: string,
): Promise<PurgeableRevision[]> {
  const { rows } = await q.query('migrations.purge.purgeable', PURGEABLE, [
    projectId,
    PURGE_AGE_DAYS,
    PURGE_MAX,
  ])
  return rows.map((r) => ({
    migrationId: r.text('migration_id'),
    revision: r.int('revision'),
    bundleDigest: r.text('bundle_digest'),
    bytes: r.int('bytes'),
  }))
}

export interface RevisionPurgeContent {
  readonly projectId: string
  readonly reason: string
  readonly revisions: readonly PurgeableRevision[]
}

export function revisionPurgeContent(plan: PlanRecord): RevisionPurgeContent | undefined {
  const c = plan.body['content']
  if (!isJsonObject(c)) return undefined
  const { projectId, reason, revisions } = c
  if (
    typeof projectId !== 'string' ||
    typeof reason !== 'string' ||
    !isJsonArray(revisions) ||
    revisions.length > PURGE_MAX
  ) {
    return undefined
  }
  const out: PurgeableRevision[] = []
  for (const r of revisions) {
    if (
      !isJsonObject(r) ||
      typeof r['migrationId'] !== 'string' ||
      typeof r['revision'] !== 'number' ||
      typeof r['bundleDigest'] !== 'string' ||
      typeof r['bytes'] !== 'number'
    ) {
      return undefined
    }
    out.push({
      migrationId: r['migrationId'],
      revision: r['revision'],
      bundleDigest: r['bundleDigest'],
      bytes: r['bytes'],
    })
  }
  return { projectId, reason, revisions: out }
}

const PRESENT = `SELECT count(*)::int AS n FROM migrations.bundle_revisions r
  JOIN unnest($2::text[], $3::int[]) AS k (migration_id, revision) USING (migration_id, revision)
 WHERE r.project_id = $1`

export class RevisionPurgeKind implements OperationKind {
  readonly kind = REVISION_PURGE_KIND
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #store: ControlStore
  readonly #clock: Clock

  constructor(deps: { readonly store: ControlStore; readonly clock: Clock }) {
    this.#store = deps.store
    this.#clock = deps.clock
  }

  exclusivity(): readonly string[] {
    return []
  }

  /** Every listed revision is still there, unchanged, unreferenced and old enough. */
  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const c = revisionPurgeContent(plan)
    if (c === undefined) return [{ binding: 'content', actual: 'invalid' }]
    const now = new Map(
      (await purgeableRevisions(this.#store, c.projectId)).map((r) => [
        `${r.migrationId}/${r.revision}`,
        r.bundleDigest,
      ]),
    )
    const changed = c.revisions.filter(
      (r) => now.get(`${r.migrationId}/${r.revision}`) !== r.bundleDigest,
    )
    return changed.length === 0 ? [] : [{ binding: 'revisions', actual: changed.length }]
  }

  async execute(ctx: ExecutionContext): Promise<'applied' | 'not_applied'> {
    const c = revisionPurgeContent(ctx.plan)
    const operationId = ctx.operationId
    if (c === undefined || !isId('op', operationId)) return 'not_applied'
    return this.#store.transaction('migrations.purge.execute', async (tx) => {
      if (!(await leaseHeld(tx, ctx.operationId, ctx.leaseOwner))) return 'not_applied'
      const { rows } = await tx.query(
        'migrations.purge.delete',
        'SELECT purged, bytes FROM migrations.purge_revisions($1, $2::text[], $3::int[])',
        [c.projectId, c.revisions.map((r) => r.migrationId), c.revisions.map((r) => r.revision)],
      )
      const purged = rows[0]?.int('purged') ?? 0
      await appendAuditEvent(
        tx,
        {
          action: 'migration.revisions.purged',
          phase: 'completed',
          actor: { kind: 'system', identityId: null, label: WORKER_ACTOR.label },
          refs: {
            operationId,
            planId: ctx.plan.planId,
            planHash: ctx.plan.planHash,
          },
          changes: {
            projectId: c.projectId,
            purged,
            bytes: Number(rows[0]?.text('bytes') ?? '0'),
          },
          result: { status: 'succeeded', applyOutcome: 'applied' },
        },
        { clock: this.#clock },
      )
      return 'applied'
    })
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed'> {
    return (await this.#present(ctx.plan)) === 0 ? 'passed' : 'failed'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const c = revisionPurgeContent(ctx.plan)
    const present = await this.#present(ctx.plan)
    if (c === undefined || present === undefined) return 'unknown'
    return present === 0 ? 'applied' : present === c.revisions.length ? 'not_applied' : 'unknown'
  }

  auditSummary(plan: PlanRecord): JsonObject {
    const c = revisionPurgeContent(plan)
    return c === undefined ? {} : { projectId: c.projectId, revisions: c.revisions.length }
  }

  async #present(plan: PlanRecord): Promise<number | undefined> {
    const c = revisionPurgeContent(plan)
    if (c === undefined) return undefined
    const { rows } = await this.#store.query('migrations.purge.present', PRESENT, [
      c.projectId,
      c.revisions.map((r) => r.migrationId),
      c.revisions.map((r) => r.revision),
    ])
    return rows[0]?.int('n') ?? 0
  }
}
