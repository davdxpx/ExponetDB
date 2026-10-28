import type { Tx } from '@exponetdb/control-store'
import { canonicalBytes, type JsonObject } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  type OperationKind,
  type PlanRecord,
} from '@exponetdb/operations'
import type { LedgerRecord } from '@exponetdb/postgres'
import {
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
import { type MigrationKindDeps, projectRegistry } from './deps.ts'
import {
  compareLedger,
  type LedgerDivergence,
  operationsOfTarget,
  readMirrorFacts,
} from './divergence.ts'
import { MigrationError } from './errors.ts'
import type { MigrationPlanContext } from './planner.ts'
import { type Fence, fenced, insertMirrorRow, LeaseLost } from './records.ts'
import { readTargetState, type TargetState } from './target.ts'

/**
 * `ledger.reconcile` (TC-007, MIG-03, failure case E25;
 * [ledger.md §5](../../../exponetdb-docs/04-migrations/ledger.md#5-mirror-and-reconciliation)).
 * A target restored to a point older than the Control Store's mirror, or a
 * ledger changed by hand, refuses every schema plan with `LEDGER_DIVERGENCE`,
 * and nothing could unblock it. The operator's explicit decision,
 * `adopt_target`, makes the live ledger the truth: the mirror rows the target
 * no longer has, or has with another checksum, move to
 * `migrations.ledger_mirror_history` (no row is deleted anywhere), the live
 * rows are mirrored, and the lost migrations are pending again.
 *
 * It writes only the Control Store; the target is read, through the observer,
 * with its identity marker and cluster identity checked (a ledger of another
 * installation, target, generation or cluster is never adopted). The plan
 * binds the live ledger's hash and a digest of the divergence it showed; the
 * kind reads both again under the target's schema lock.
 */
export interface LedgerReconcileRequest {
  readonly decision: 'adopt_target' | 'flag_untrusted'
  readonly note: string
}

const SHOWN = 256
/** Ids per class a plan names; the digest covers all of them. */
const ALL = Number.MAX_SAFE_INTEGER

interface ReconcileContent {
  readonly decision: 'adopt_target'
  readonly note: string
  readonly projectId: string
  readonly targetId: string
  readonly path: string
  readonly tier: 'prod' | 'nonprod'
  readonly generation: number
  readonly clusterSystemIdentifier: string
  readonly expectedState: { readonly ledgerStateHash: string; readonly divergenceDigest: string }
  /** Up to 256 ids per class (untrusted text: ids read from the target's ledger). */
  readonly divergence: LedgerDivergence
  readonly counts: {
    readonly missing: number
    readonly checksumDiffers: number
    readonly unrecorded: number
  }
  readonly liveRows: number
  readonly mirrorRows: number
}

function contentOf(plan: Pick<PlanRecord, 'body'>): ReconcileContent {
  const c = plan.body['content'] as unknown as ReconcileContent | undefined
  if (
    c === undefined ||
    c.decision !== 'adopt_target' ||
    typeof c.targetId !== 'string' ||
    typeof c.generation !== 'number' ||
    typeof c.expectedState?.ledgerStateHash !== 'string' ||
    typeof c.expectedState?.divergenceDigest !== 'string'
  ) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

const validation = (code: string, message: string) =>
  new RegistryError('VALIDATION_FAILED', { errors: [{ path: '/decision', code, message }] })

/** The sorted ids of each class and a digest over all of them: what the plan binds. */
function summary(d: LedgerDivergence): { divergence: LedgerDivergence; digest: string } {
  const sorted: LedgerDivergence = {
    missing: [...d.missing].sort(),
    checksumDiffers: [...d.checksumDiffers].sort(),
    unrecorded: [...d.unrecorded].sort(),
  }
  const bytes = canonicalBytes({ ...sorted })
  const digest = bytes.ok ? `sha256:${sha256Hex(bytes.value)}` : 'sha256:unreadable'
  return { divergence: sorted, digest }
}

/**
 * What the target's ledger and the mirror differ in, every id: `null` when they agree or the
 * target was never mirrored. (The refusal of a plan shows a few; a reconciliation needs them all.)
 */
async function fullDivergence(
  q: Pick<Tx, 'query'>,
  target: Pick<TargetRecord, 'targetId' | 'generation'>,
  live: readonly LedgerRecord[],
): Promise<{ divergence: LedgerDivergence; mirrorRows: number } | null> {
  const mirror = await readMirrorFacts(q, target.targetId, target.generation)
  if (mirror === undefined) return null
  const mirrored = new Set(mirror.map((r) => r.migrationId))
  const known = await operationsOfTarget(
    q,
    target.targetId,
    live.filter((r) => !mirrored.has(r.migrationId)).map((r) => r.operationId),
  )
  const divergence = compareLedger(mirror, live, known, ALL)
  return divergence === null ? null : { divergence, mirrorRows: mirror.length }
}

export async function planLedgerReconcile(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  request: LedgerReconcileRequest,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.state !== 'active') {
    throw new MigrationError('TARGET_SUSPENDED', { reason: target.stateReason ?? 'administrator' })
  }
  if (target.placement === null) throw new MigrationError('TARGET_UNAVAILABLE')
  if (request.decision !== 'adopt_target') {
    throw validation(
      'not_built',
      'Only adopt_target is built; flagging rows as untrusted is an open decision (OD-59).',
    )
  }
  const project = await projectRegistry(tx, target.projectId)
  const opened = await ctx.connector.forTarget(
    target,
    'observer',
    `ledger-reconcile-plan/${target.targetId}`,
  )
  let state: TargetState
  try {
    state = await opened.session.readOnly(
      (rtx) =>
        readTargetState(
          rtx,
          {
            installationId: ctx.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: target.placement?.systemIdentifier ?? null,
          },
          project.scope,
          { sizes: false },
        ),
      { statementTimeoutMs: 60_000 },
    )
  } finally {
    await opened.session.close()
  }
  const found = await fullDivergence(tx, target, state.ledger)
  if (found === null) {
    throw validation('nothing_to_reconcile', 'The ledger of the target agrees with the mirror.')
  }
  const { divergence, digest } = summary(found.divergence)
  const shown = (ids: readonly string[]) => ids.slice(0, SHOWN)
  const content: ReconcileContent = {
    decision: 'adopt_target',
    note: request.note,
    projectId: target.projectId,
    targetId: target.targetId,
    path: target.path,
    tier: target.tier,
    generation: target.generation,
    clusterSystemIdentifier: state.systemIdentifier,
    expectedState: { ledgerStateHash: state.ledgerStateHash, divergenceDigest: digest },
    divergence: {
      missing: shown(divergence.missing),
      checksumDiffers: shown(divergence.checksumDiffers),
      unrecorded: shown(divergence.unrecorded),
    },
    counts: {
      missing: divergence.missing.length,
      checksumDiffers: divergence.checksumDiffers.length,
      unrecorded: divergence.unrecorded.length,
    },
    liveRows: state.ledger.length,
    mirrorRows: found.mirrorRows,
  }
  const subject = {
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    targetId: target.targetId,
    tier: target.tier,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'ledger.reconcile',
    actor,
    subject,
    content: content as unknown as JsonObject,
  })
  return createPlan(
    tx,
    {
      kind: 'ledger.reconcile',
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: { decision: 'adopt_target', ...content.counts },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

interface Observed {
  readonly target: TargetRecord
  readonly state: TargetState
  readonly found: Awaited<ReturnType<typeof fullDivergence>>
}

export class LedgerReconcileKind implements OperationKind {
  readonly kind = 'ledger.reconcile'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${contentOf(plan).targetId}:schema`]
    } catch {
      return []
    }
  }

  /** The live state, identity checked, and what differs from the mirror. */
  async #observe(c: ReconcileContent, purpose: string): Promise<Observed> {
    const target = await findTarget(this.#deps.store, c.targetId)
    if (target === undefined || target.state !== 'active' || target.generation !== c.generation) {
      throw new MigrationError('TARGET_UNAVAILABLE')
    }
    const project = await projectRegistry(this.#deps.store, target.projectId)
    const opened = await this.#deps.connector.forTarget(
      target,
      'observer',
      `${purpose}/${c.targetId}`,
    )
    try {
      const state = await opened.session.readOnly((rtx) =>
        readTargetState(
          rtx,
          {
            installationId: this.#deps.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: c.clusterSystemIdentifier,
          },
          project.scope,
          { sizes: false },
        ),
      )
      return { target, state, found: await fullDivergence(this.#deps.store, target, state.ledger) }
    } finally {
      await opened.session.close()
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: ReconcileContent
    try {
      c = contentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    try {
      const { state, found } = await this.#observe(c, 'ledger-reconcile-bindings')
      const changed: ChangedBinding[] = []
      if (state.ledgerStateHash !== c.expectedState.ledgerStateHash) {
        changed.push({ binding: 'ledger', actual: 'changed' })
      }
      if (found === null || summary(found.divergence).digest !== c.expectedState.divergenceDigest) {
        changed.push({ binding: 'mirror', actual: 'changed' })
      }
      return changed
    } catch (error) {
      if (error instanceof MigrationError && error.code === 'TARGET_UNAVAILABLE') {
        return [{ binding: 'target', actual: 'unavailable' }]
      }
      return [{ binding: 'target', actual: 'unreachable' }]
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    let c: ReconcileContent
    try {
      c = contentOf(ctx.plan)
    } catch {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: ['content'] },
      }
    }
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    let seen: Observed
    try {
      seen = await this.#observe(c, 'ledger-reconcile')
    } catch (error) {
      // The identity marker or the cluster is not the one the plan was made for: nothing is adopted.
      const code =
        error instanceof MigrationError &&
        (error.code === 'TARGET_IDENTITY_MISMATCH' ||
          error.code === 'CLUSTER_IDENTITY_MISMATCH' ||
          error.code === 'LEDGER_NOT_INITIALIZED')
          ? error.code
          : 'TARGET_UNAVAILABLE'
      return { outcome: 'not_applied', errorCode: code }
    }
    const { state, found } = seen
    if (
      state.ledgerStateHash !== c.expectedState.ledgerStateHash ||
      found === null ||
      summary(found.divergence).digest !== c.expectedState.divergenceDigest
    ) {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: ['ledger', 'mirror'] },
      }
    }
    const { divergence } = summary(found.divergence)
    const live = new Map(state.ledger.map((r) => [r.migrationId, r]))
    try {
      await fenced(fence, 'migrations.reconcile.adopt', async (tx) => {
        for (const [ids, reason] of [
          [divergence.missing, 'missing'],
          [divergence.checksumDiffers, 'differs'],
        ] as const) {
          if (ids.length === 0) continue
          await tx.query(
            'migrations.reconcile.archive',
            'SELECT migrations.archive_mirror_rows($1, $2, $3, $4::text[], $5) AS moved',
            [ctx.operationId, c.targetId, c.generation, ids, reason],
          )
        }
        for (const id of [...divergence.checksumDiffers, ...divergence.unrecorded]) {
          const row = live.get(id)
          if (row !== undefined) await insertMirrorRow(tx, c.targetId, c.generation, row)
        }
        await tx.query(
          'migrations.reconcile.state',
          `INSERT INTO migrations.ledger_state
             (target_id, generation, ledger_state_hash, baseline_id, observed_at, divergent, divergence)
           VALUES ($1, $2, $3, $4, clock_timestamp(), false, NULL)
           ON CONFLICT (target_id) DO UPDATE SET generation = EXCLUDED.generation,
             ledger_state_hash = EXCLUDED.ledger_state_hash, baseline_id = EXCLUDED.baseline_id,
             observed_at = EXCLUDED.observed_at, divergent = false, divergence = NULL`,
          [c.targetId, c.generation, state.ledgerStateHash, state.meta.baselineId],
        )
      })
    } catch (error) {
      if (error instanceof LeaseLost) return 'unknown'
      throw error
    }
    return 'applied'
  }

  /** Verified when the live ledger and the mirror agree. */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    try {
      const c = contentOf(ctx.plan)
      const { found } = await this.#observe(c, 'ledger-reconcile-verify')
      return found === null ? 'passed' : 'failed'
    } catch {
      return 'error'
    }
  }

  /** After a lost worker: adopted when the ledger and the mirror agree, otherwise not (and no retry). */
  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    try {
      const c = contentOf(ctx.plan)
      const { found } = await this.#observe(c, 'ledger-reconcile-recover')
      return found === null ? 'applied' : 'not_applied'
    } catch {
      return 'unknown'
    }
  }

  auditSummary(plan: PlanRecord): JsonObject {
    try {
      const c = contentOf(plan)
      return { decision: c.decision, targetId: c.targetId, ...c.counts }
    } catch {
      return {}
    }
  }
}
