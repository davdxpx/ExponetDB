import {
  type AccessRole,
  isNodeCapabilityKey,
  NODE_CAPABILITIES,
  type NodeCapabilityKey,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import {
  isId,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  newId,
  parseId,
} from '@exponetdb/kernel'
import { b64u } from '@exponetdb/kernel/node'
import {
  type ChangedBinding,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  OperationError,
  type OperationKind,
  type PlanRecord,
  readPlan,
} from '@exponetdb/operations'
import {
  Body,
  type Connector,
  ContentInvalid,
  type CredentialRecord,
  consumerOf,
  getCredential,
  latestCredential,
  recordActivation,
  recordVerification,
  verifyCredentialLogin,
} from '@exponetdb/registry'
import { addSecretVersion, createSecret } from '@exponetdb/secrets'
import {
  BASIS,
  type CapabilityKindName,
  jobKeySetDigest,
  RUNS,
  restartDigest,
  trustedJobKeys,
} from './capability-plans.ts'
import { NodeError } from './errors.ts'
import { createJob } from './jobs.ts'
import { clusterArg, mapCluster, requireCapabilities, servedNode } from './mapping.ts'
import { observationOfOperation, recordObservation } from './observations.ts'
import {
  certificateFingerprint,
  issuePostgresServerCertificate,
  presentedCertificate,
  tlsProofValid,
} from './postgres-ca.ts'
import {
  APPLY_JOB_SECONDS,
  awaitJob,
  type JobEnd,
  judgedEnd,
  outcomeOf,
  READ_JOB_SECONDS,
  type RunnerDeps,
  runJob,
  settleJob,
} from './runner.ts'
import { generatedPassword, scramVerifier } from './scram.ts'

/**
 * The capability operation kinds, executed by the worker
 * ([control-plane.md §9](../../../exponetdb-docs/07-node-agent/control-plane.md#9-capability-operations)):
 * a fresh basis read, the apply job with the plan's digests, and a separate
 * verification read. Reconciliation reads the host; it never runs an apply
 * job again.
 */
export interface CapabilityKindDeps extends RunnerDeps {
  /** The worker's connector (credential rotation logs in with the new password). */
  readonly connector?: Connector
}

type Read =
  | { readonly ok: true; readonly result: JsonObject }
  | { readonly ok: false; readonly end: JobEnd }

function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function obj(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

abstract class CapabilityKind implements OperationKind {
  abstract readonly kind: CapabilityKindName | 'node.inspect'
  readonly version = 1
  readonly actionClass: 'low' | 'standard' | 'high' | 'critical' = 'high'
  readonly verifies = true
  protected readonly d: CapabilityKindDeps

  constructor(deps: CapabilityKindDeps) {
    this.d = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    const c = Body.content(plan)
    return [`cluster:${c.text('clusterId')}:config`]
  }

  /** The capabilities the node must still accept. */
  protected needed(_content: Body): readonly NodeCapabilityKey[] {
    return [...RUNS[this.kind as CapabilityKindName]]
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let content: Body
    let expected: Body
    try {
      content = Body.content(plan)
      expected = Body.expected(plan)
    } catch (error) {
      if (error instanceof ContentInvalid) {
        return [{ binding: 'content', actual: 'invalid' }]
      }
      throw error
    }
    try {
      const nodeId = expected.text('nodeId')
      const now = this.d.clock.nowMs()
      const clusterId = content.textOrNull('clusterId')
      if (clusterId === null) {
        requireCapabilities(await servedNode(this.d.store, { nodeId }, now), this.needed(content))
        return []
      }
      const { mapping, node } = await mapCluster(this.d.store, clusterId, now, { nodeId })
      const changed: ChangedBinding[] = []
      for (const key of ['localName', 'systemIdentifier'] as const) {
        if (mapping[key] !== expected.textOrNull(key)) {
          changed.push({ binding: key, expected: expected.textOrNull(key), actual: mapping[key] })
        }
      }
      requireCapabilities(node, this.needed(content))
      return changed
    } catch (error) {
      if (error instanceof NodeError) {
        return [{ binding: 'node', actual: error.code.toLowerCase() }]
      }
      if (error instanceof ContentInvalid) {
        return [{ binding: 'content', actual: 'invalid' }]
      }
      throw error
    }
  }

  protected cluster(c: Body): JsonObject {
    return clusterArg({
      localName: c.text('localName'),
      systemIdentifier: c.text('systemIdentifier'),
    })
  }

  /**
   * The dispatch admission checked again before the worker prepares what an
   * apply job will carry (a server certificate): the same check the apply
   * job's creation runs, made earlier, so nothing is made for an effect that
   * will not be admitted (correction review, round 2).
   */
  protected async readmitted(ctx: ExecutionContext): Promise<ExecutionOutcome | undefined> {
    const readmit = ctx.readmit
    if (readmit === undefined) {
      return undefined
    }
    const changed = await this.d.store.transaction('nodes.kind.readmit', (tx) => readmit(tx))
    return changed.length === 0
      ? undefined
      : {
          outcome: 'not_applied',
          errorCode: 'PLAN_STALE',
          detail: { changedBindings: changed.map((b) => b.binding) },
        }
  }

  /** Runs one job of this operation. */
  protected job(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject | ((seal: (field: string, plaintext: Uint8Array) => JsonObject) => JsonObject),
    signingKeyId?: string,
  ): Promise<JobEnd> {
    const content = Body.content(ctx.plan)
    const apply = NODE_CAPABILITIES[capability].kind === 'apply'
    return runJob(
      this.d,
      {
        nodeId: content.text('nodeId'),
        operationId: ctx.operationId,
        capability,
        args: typeof args === 'function' ? args : () => args,
        windowSeconds: apply ? APPLY_JOB_SECONDS : READ_JOB_SECONDS,
        ...(signingKeyId === undefined ? {} : { signingKeyId }),
      },
      ctx.signal,
      ctx.leaseOwner,
      // An apply job starts an effect minutes after the operation started:
      // what admitted it is checked again where the job is created.
      apply ? ctx.readmit : undefined,
    )
  }

  /** A read job's result, or why there is none. */
  protected async read(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject,
    signingKeyId?: string,
  ): Promise<Read> {
    try {
      const end = await this.job(ctx, capability, args, signingKeyId)
      return end.end === 'succeeded' ? { ok: true, result: end.result } : { ok: false, end }
    } catch (error) {
      if (error instanceof NodeError) {
        return { ok: false, end: { end: 'unproven', jobId: '', why: error.code } }
      }
      throw error
    }
  }

  /**
   * The latest job of this operation for a capability, of any major, and
   * what it proves. An operation that began before the Wave 5 correction ran
   * a major it retired (F1): that job counts (it may have changed the host),
   * but nothing of its stored statement or arguments is read (quarantine);
   * it proves nothing and `args` is empty.
   */
  protected async ownJob(
    operationId: string,
    capability: NodeCapabilityKey,
  ): Promise<
    | {
        readonly jobId: string
        readonly capability: string
        readonly args: JsonObject
        readonly end: JobEnd | undefined
      }
    | undefined
  > {
    const name = NODE_CAPABILITIES[capability].name
    const { rows } = await this.d.store.query(
      'nodes.kind.own_job',
      `SELECT job_id, capability, CASE WHEN capability = $3 THEN envelope -> 'args' END AS args
         FROM nodes.jobs
        WHERE operation_id = $1 AND split_part(capability, '@', 1) = $2
        ORDER BY created_at DESC LIMIT 1`,
      [operationId, name, capability],
    )
    const row = rows[0]
    if (row === undefined) {
      return undefined
    }
    const jobId = row.text('job_id')
    const found = row.text('capability')
    const args = row.json('args')
    return {
      jobId,
      capability: found,
      args: found === capability && isJsonObject(args as JsonValue) ? (args as JsonObject) : {},
      end: await judgedEnd(this.d, jobId, isNodeCapabilityKey(found) ? found : capability, found),
    }
  }

  /**
   * The result of this operation's last succeeded job of a capability created
   * before `before` (a job id), e.g. the status read ahead of a restart.
   */
  protected async resultBefore(
    operationId: string,
    capability: NodeCapabilityKey,
    before: string,
  ): Promise<JsonObject | undefined> {
    const { rows } = await this.d.store.query(
      'nodes.kind.result_before',
      `SELECT job_id FROM nodes.jobs
        WHERE operation_id = $1 AND capability = $2
          AND created_at < (SELECT created_at FROM nodes.jobs WHERE job_id = $3)
        ORDER BY created_at DESC LIMIT 1`,
      [operationId, capability, before],
    )
    const jobId = rows[0]?.text('job_id')
    if (jobId === undefined) {
      return undefined
    }
    const end = await judgedEnd(this.d, jobId, capability)
    return end?.end === 'succeeded' ? end.result : undefined
  }

  /** A failed basis read: nothing was sent that could change the host. */
  protected readFailure(end: JobEnd, capability: NodeCapabilityKey): ExecutionOutcome {
    const o = outcomeOf(end, capability)
    if (o === undefined || o === 'unknown' || o === 'applied' || o === 'partially_applied') {
      return {
        outcome: 'not_applied',
        errorCode: 'NODE_CAPABILITY_FAILED',
        detail: { capability, jobId: end.jobId },
      }
    }
    return o
  }

  protected stale(binding: string): ExecutionOutcome {
    return {
      outcome: 'not_applied',
      errorCode: 'PLAN_STALE',
      detail: { changedBindings: [binding] },
    }
  }

  /** Checks the basis digest again; undefined when it still holds. */
  protected async freshBasis(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject,
    digestOf: (result: JsonObject) => string | null,
  ): Promise<{ readonly result: JsonObject } | { readonly outcome: ExecutionOutcome }> {
    const read = await this.read(ctx, capability, args)
    if (!read.ok) {
      return { outcome: this.readFailure(read.end, capability) }
    }
    const planned = Body.expected(ctx.plan).textOrNull('basisDigest')
    if (digestOf(read.result) !== planned) {
      return { outcome: this.stale('host_state') }
    }
    return { result: read.result }
  }

  protected applied(end: JobEnd, capability: NodeCapabilityKey): ExecutionOutcome {
    return outcomeOf(end, capability) ?? 'applied'
  }

  abstract execute(ctx: ExecutionContext): Promise<ExecutionOutcome>
  abstract verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'>

  /** Reconciliation by the host's state, after the apply job's own statement (if it arrived late). */
  protected async hostState(
    _ctx: ExecutionContext,
  ): Promise<'applied' | 'not_applied' | 'unknown'> {
    return 'unknown'
  }

  protected applyCapability(): NodeCapabilityKey | undefined {
    return undefined
  }

  /**
   * Reconciliation (§9.4) never runs the apply job again. No apply job means
   * none will ever exist (only the lease holder creates jobs); otherwise it
   * first settles the job, so the host is never judged while the job, or an
   * effect it began, can still change it.
   */
  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const capability = this.applyCapability()
    if (capability !== undefined) {
      const own = await this.ownJob(ctx.operationId, capability)
      if (own === undefined) {
        return 'not_applied'
      }
      const end = await settleJob(this.d, own.jobId, capability, ctx.signal, own.capability)
      if (ctx.signal.aborted) {
        return 'unknown'
      }
      if (end.end === 'succeeded') {
        return 'applied'
      }
      if (outcomeOf(end, capability) !== 'unknown') {
        return 'not_applied'
      }
    }
    return this.hostState(ctx)
  }
}

// ----- node.inspect -----

export class NodeInspectKind extends CapabilityKind {
  readonly kind = 'node.inspect' as const
  override readonly actionClass = 'low' as const

  override exclusivity(): readonly string[] {
    return []
  }

  protected override needed(content: Body): readonly NodeCapabilityKey[] {
    const capability = content.text('capability')
    return isNodeCapabilityKey(capability) ? [capability] : []
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const capability = c.text('capability')
    const args = c.raw('args')
    if (!isNodeCapabilityKey(capability) || !isJsonObject(args)) {
      return 'not_applied'
    }
    const end = await this.job(ctx, capability, args)
    if (end.end !== 'succeeded') {
      // A read changes nothing: only an unproven end leaves the outcome open.
      return end.end === 'unproven' ? 'unknown' : this.readFailure(end, capability)
    }
    await this.record(ctx, end)
    return 'applied'
  }

  private async record(
    ctx: ExecutionContext,
    end: { readonly jobId: string; readonly result: JsonObject },
  ) {
    const c = Body.content(ctx.plan)
    await recordObservation(this.d.store, {
      jobId: end.jobId,
      nodeId: c.text('nodeId'),
      clusterId: c.textOrNull('clusterId'),
      capability: c.text('capability'),
      argsHash: c.text('argsHash'),
      operationId: ctx.operationId,
      result: end.result,
    })
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    return (await observationOfOperation(this.d.store, ctx.operationId)) === undefined
      ? 'failed'
      : 'passed'
  }

  /** A read changes nothing: its job's end decides, never the host. */
  override async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const capability = Body.content(ctx.plan).text('capability')
    if (!isNodeCapabilityKey(capability)) {
      return 'not_applied'
    }
    const own = await this.ownJob(ctx.operationId, capability)
    if (own === undefined) {
      return 'not_applied'
    }
    const end = await awaitJob(this.d, own.jobId, capability, ctx.signal)
    if (ctx.signal.aborted) {
      return 'unknown'
    }
    if (end.end === 'succeeded') {
      await this.record(ctx, end)
      return 'applied'
    }
    return 'not_applied'
  }
}

// ----- postgres.reload, postgres.restart -----

export class ReloadKind extends CapabilityKind {
  readonly kind = 'postgres.reload' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.reload@2'
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    // The basis again: a reload needs a running instance.
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (!status.ok) {
      return this.readFailure(status.end, 'postgres.status@1')
    }
    if (status.result['running'] !== true) {
      return this.stale('host_state')
    }
    const end = await this.job(ctx, 'postgres.reload@2', { cluster: this.cluster(c) })
    return this.applied(end, 'postgres.reload@2')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.reload@2')
    if (own?.end?.end !== 'succeeded') {
      return 'error'
    }
    if (list(own.end.result['fileErrors']).length > 0) {
      return 'failed'
    }
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (!status.ok) {
      return 'error'
    }
    return status.result['running'] === true && status.result['acceptingConnections'] === true
      ? 'passed'
      : 'failed'
  }
}

export class RestartKind extends CapabilityKind {
  readonly kind = 'postgres.restart' as const

  override exclusivity(plan: PlanRecord): readonly string[] {
    const c = Body.content(plan)
    const targets = list(c.raw('targetIds')).filter((t): t is string => typeof t === 'string')
    return [`cluster:${c.text('clusterId')}:config`, ...targets.map((t) => `target:${t}:schema`)]
  }

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.restart@1'
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    // What the restart would disrupt (backups, maintenance, active slots)
    // is read again; anything new since the plan makes it stale.
    const fresh = await this.freshBasis(
      ctx,
      'postgres.restart.plan@2',
      { cluster: this.cluster(c) },
      restartDigest,
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    // The start time before, from the host's own clock (reconciliation and
    // verification compare with it, never with the Control Plane's clock).
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (!status.ok) {
      return this.readFailure(status.end, 'postgres.status@1')
    }
    if (str(status.result['postmasterStartTime']) === null) {
      return this.stale('host_state')
    }
    const end = await this.job(ctx, 'postgres.restart@1', {
      cluster: this.cluster(c),
      shutdownMode: 'fast',
    })
    return this.applied(end, 'postgres.restart@1')
  }

  /** The postmaster start time read right before the restart job, and the job. */
  private async before(operationId: string) {
    const own = await this.ownJob(operationId, 'postgres.restart@1')
    if (own === undefined) {
      return undefined
    }
    const status = await this.resultBefore(operationId, 'postgres.status@1', own.jobId)
    const started = str(status?.['postmasterStartTime'])
    return started === null ? undefined : { own, started }
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const before = await this.before(ctx.operationId)
    if (before === undefined) {
      return 'error'
    }
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (!status.ok) {
      return 'error'
    }
    // Times of the host's clock only, compared with each other.
    const t = (v: JsonValue | undefined) => Date.parse(str(v) ?? '')
    const now = t(status.result['postmasterStartTime'])
    const started = Date.parse(before.started)
    const end = before.own.end
    // The job's own report when it stated one; otherwise the host alone
    // (a reconciled restart): a postmaster started since the read before it.
    const reported =
      end?.end !== 'succeeded' ||
      (t(end.result['postmasterStartTimeBefore']) === started &&
        t(end.result['postmasterStartTimeAfter']) > started &&
        now >= t(end.result['postmasterStartTimeAfter']))
    return now > started &&
      reported &&
      status.result['running'] === true &&
      status.result['acceptingConnections'] === true
      ? 'passed'
      : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const before = await this.before(ctx.operationId)
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    const now = status.ok ? Date.parse(str(status.result['postmasterStartTime']) ?? '') : Number.NaN
    const started = Date.parse(before?.started ?? '')
    if (Number.isNaN(now) || Number.isNaN(started)) {
      return 'unknown' as const
    }
    return now > started ? ('applied' as const) : ('not_applied' as const)
  }
}

// ----- postgres.config.apply -----

/**
 * What the managed fragment holds for each planned change, compared on the
 * host (`postgres.config.plan@2`, capabilities.md §6): the values never leave
 * the node, so the Control Plane verifies its own write without reading them.
 * A value the node withholds is never compared (`held`, correction review,
 * round 2); it counts as the requested one only with `heldProven`: the
 * fragment is byte for byte the one the signed apply statement reported
 * writing (its keyed digest), which wrote exactly the planned changes.
 */
export function managedShows(
  plan: JsonObject,
  changes: readonly { readonly name: string; readonly value: string | null }[],
  reload: boolean,
  heldProven = false,
): boolean {
  const parameters = list(plan['parameters']).map(obj)
  if (parameters.length !== changes.length) {
    return false
  }
  return changes.every((change, i) => {
    const p = parameters[i] ?? {}
    const managed = obj(p['managed'])
    if (str(p['name']) !== change.name) {
      return false
    }
    if (change.value === null) {
      return managed['state'] === 'absent'
    }
    const holds = managed['state'] === 'requested' || (heldProven && managed['state'] === 'held')
    if (!holds || managed['error'] !== false) {
      return false
    }
    // Loaded unless the change waits for a restart.
    return !reload || p['effect'] === 'restart' || managed['applied'] === true
  })
}

export class ConfigApplyKind extends CapabilityKind {
  readonly kind = 'postgres.config.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.config.apply@2'
  }

  private changes(c: Body): { readonly name: string; readonly value: string | null }[] {
    return list(obj(c.raw('change'))['changes']).map((x) => ({
      name: str(obj(x)['name']) ?? '',
      value: str(obj(x)['value']),
    }))
  }

  /** The plan read with this operation's own changes. */
  private planRead(ctx: ExecutionContext, c: Body): Promise<Read> {
    return this.read(ctx, 'postgres.config.plan@2', {
      cluster: this.cluster(c),
      changes: this.changes(c),
    })
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.config.inspect@2',
      { cluster: this.cluster(c) },
      (r) => str(r['configVersion']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    // Only the plan's changes travel; the helper keeps every other line of
    // the managed fragment on the host (Wave 5 correction F1).
    const include = obj(fresh.result['managedInclude'])
    const end = await this.job(ctx, 'postgres.config.apply@2', {
      cluster: this.cluster(c),
      changes: this.changes(c),
      expectedFragmentDigest: include['present'] === true ? str(include['digest']) : null,
      configVersion: str(fresh.result['configVersion']) ?? '',
      reload: obj(c.raw('change'))['reload'] === true,
    })
    return this.applied(end, 'postgres.config.apply@2')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.config.apply@2')
    if (own === undefined) {
      return 'error'
    }
    const read = await this.planRead(ctx, c)
    if (!read.ok) {
      return 'error'
    }
    // The fragment the job reported writing, when it stated one (a reconciled
    // operation has no statement: the comparison below decides alone, and a
    // withheld value it cannot compare fails the verification).
    const stated = own.end?.end === 'succeeded'
    if (
      stated &&
      str(obj(read.result['managedInclude'])['digest']) !== str(own.end.result['fragmentDigest'])
    ) {
      return 'failed'
    }
    const reload = obj(c.raw('change'))['reload'] === true
    return managedShows(read.result, this.changes(c), reload, stated) ? 'passed' : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.config.apply@2')
    const read = await this.planRead(ctx, c)
    if (own === undefined || !read.ok) {
      return 'unknown' as const
    }
    const include = obj(read.result['managedInclude'])
    const now = include['present'] === true ? str(include['digest']) : null
    return configHostState({
      plan: read.result,
      changes: this.changes(c),
      // A withheld value is the planned one only when the fragment is the
      // one the signed statement reported writing.
      proven:
        own.end?.end === 'succeeded' &&
        now !== null &&
        now === str(own.end.result['fragmentDigest']),
      // A job of a retired major (args quarantined) proves no basis to compare.
      unchanged:
        own.capability === 'postgres.config.apply@2' &&
        now === str(own.args['expectedFragmentDigest']),
    })
  }
}

/**
 * What the host shows of a configuration change whose job proved nothing
 * (reconciliation): applied when the managed fragment holds the plan;
 * not applied only when the fragment is still the one the plan was bound to
 * and no planned value is withheld, because the job may have written a
 * withheld value the fragment already held, leaving the same bytes
 * (correction review, round 3); unknown otherwise.
 */
export function configHostState(input: {
  readonly plan: JsonObject
  readonly changes: readonly { readonly name: string; readonly value: string | null }[]
  readonly proven: boolean
  readonly unchanged: boolean
}): 'applied' | 'not_applied' | 'unknown' {
  if (managedShows(input.plan, input.changes, false, input.proven)) {
    return 'applied'
  }
  const parameters = list(input.plan['parameters']).map(obj)
  const held = input.changes.some(
    (change, i) => change.value !== null && obj(parameters[i]?.['managed'])['state'] === 'held',
  )
  return input.unchanged && !held ? 'not_applied' : 'unknown'
}

// ----- postgres.hba.apply -----

/** The agent's own access, always passed; the agent checks it whatever the plan names (§9.6). */
const AGENT_ACCESS = {
  role: 'exponetdb_node',
  database: 'postgres',
  address: 'local',
  method: 'peer',
}

/** The netmask of a prefix length, as pg_hba_file_rules shows it. */
function netmask(prefix: number, v6: boolean): string {
  const bits = v6 ? 128 : 32
  const mask = Array.from({ length: bits }, (_, i) => (i < prefix ? 1 : 0))
  if (!v6) {
    return [0, 8, 16, 24].map((o) => parseInt(mask.slice(o, o + 8).join(''), 2)).join('.')
  }
  return expandV6(
    Array.from({ length: 8 }, (_, g) =>
      parseInt(mask.slice(g * 16, g * 16 + 16).join(''), 2).toString(16),
    ).join(':'),
  )
}

/** An IPv6 address with all eight groups, without leading zeros. */
function expandV6(address: string): string {
  const [head = '', tail] = address.toLowerCase().split('::')
  const h = head === '' ? [] : head.split(':')
  const t = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? h
      : [...h, ...Array.from({ length: 8 - h.length - t.length }, () => '0'), ...t]
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':')
}

/**
 * Whether an inspected rule (pg_hba_file_rules) is the planned one: type,
 * databases, users, method, map and address with its mask.
 */
export function hbaRuleShows(planned: JsonObject, seen: JsonObject | undefined): boolean {
  if (seen === undefined) return false
  const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
    JSON.stringify(list(a)) === JSON.stringify(list(b))
  const map = str(planned['map'])
  if (
    str(seen['type']) !== str(planned['type']) ||
    !same(seen['database'], planned['database']) ||
    !same(seen['userName'], planned['user']) ||
    str(seen['authMethod']) !== str(planned['method']) ||
    !same(seen['options'], map === null ? [] : [{ name: 'map', value: map }])
  ) {
    return false
  }
  const address = str(planned['address'])
  if (address === null) {
    return seen['address'] === null
  }
  const [network, prefix] = address.split('/')
  if (prefix === undefined || network === undefined) {
    return str(seen['address']) === address && seen['netmask'] === null
  }
  const v6 = network.includes(':')
  const shown = str(seen['address'])
  const mask = str(seen['netmask'])
  return (
    shown !== null &&
    mask !== null &&
    (v6 ? expandV6(shown) === expandV6(network) : shown === network) &&
    (v6 ? expandV6(mask) : mask) === netmask(Number(prefix), v6)
  )
}

export class HbaApplyKind extends CapabilityKind {
  readonly kind = 'postgres.hba.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.hba.apply@2'
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.hba.inspect@2',
      { cluster: this.cluster(c) },
      (r) => str(r['fileDigest']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const change = obj(c.raw('change'))
    const access = list(change['protectedAccess'])
    const end = await this.job(ctx, 'postgres.hba.apply@2', {
      cluster: this.cluster(c),
      managedRules: list(change['managedRules']),
      expectedFileDigest: str(fresh.result['fileDigest']) ?? '',
      protectedAccess: access.length > 0 ? access : [AGENT_ACCESS],
    })
    return this.applied(end, 'postgres.hba.apply@2')
  }

  /** Whether the managed block holds exactly the planned rules, field by field, in order. */
  private showsPlanned(inspect: JsonObject, c: Body): boolean {
    const managed = list(inspect['rules'])
      .map(obj)
      .filter((r) => r['managed'] === true)
    const planned = list(obj(c.raw('change'))['managedRules']).map(obj)
    return managed.length === planned.length && planned.every((p, i) => hbaRuleShows(p, managed[i]))
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.hba.apply@2')
    if (own === undefined) {
      return 'error'
    }
    const read = await this.read(ctx, 'postgres.hba.inspect@2', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    const errors = list(read.result['rules']).some((r) => obj(r)['error'] !== null)
    // The file the job reported writing, when it stated one.
    const written =
      own.end?.end !== 'succeeded' ||
      str(read.result['fileDigest']) === str(own.end.result['fileDigest'])
    return written && this.showsPlanned(read.result, c) && !errors ? 'passed' : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.hba.inspect@2', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'unknown' as const
    }
    if (str(read.result['fileDigest']) === Body.expected(ctx.plan).textOrNull('basisDigest')) {
      return 'not_applied' as const
    }
    return this.showsPlanned(read.result, c) ? ('applied' as const) : ('unknown' as const)
  }
}

// ----- postgres.roles.apply and credential.rotate -----

interface RoleExpectations {
  readonly attributes: Map<string, JsonObject>
  readonly passwords: Map<string, 'scram-sha-256' | 'none'>
  readonly memberships: Map<string, JsonObject | null>
  readonly settings: Map<string, string | null>
}

/** The state the steps leave, folded in order (a later step wins). */
export function roleExpectations(steps: readonly JsonValue[]): RoleExpectations {
  const e: RoleExpectations = {
    attributes: new Map(),
    passwords: new Map(),
    memberships: new Map(),
    settings: new Map(),
  }
  for (const step of steps.map(obj)) {
    const role = str(step['role']) ?? ''
    switch (step['op']) {
      case 'create_role':
      case 'alter_role':
        e.attributes.set(role, { ...(e.attributes.get(role) ?? {}), ...obj(step['attributes']) })
        break
      case 'set_password':
        e.passwords.set(role, 'scram-sha-256')
        break
      case 'clear_password':
        e.passwords.set(role, 'none')
        break
      case 'grant_membership':
        e.memberships.set(`${role}\u0000${str(step['member'])}`, {
          admin: step['admin'] ?? false,
          inherit: step['inherit'] ?? false,
          set: step['set'] ?? false,
        })
        break
      case 'revoke_membership':
        e.memberships.set(`${role}\u0000${str(step['member'])}`, null)
        break
      case 'set_role_setting':
        e.settings.set(
          `${role}\u0000${str(step['database']) ?? ''}\u0000${str(step['setting'])}`,
          str(step['value']),
        )
        break
      case 'reset_role_setting':
        e.settings.set(
          `${role}\u0000${str(step['database']) ?? ''}\u0000${str(step['setting'])}`,
          null,
        )
        break
    }
  }
  return e
}

const ATTRIBUTE_FIELDS: Readonly<Record<string, string>> = {
  login: 'login',
  inherit: 'inherit',
  createdb: 'createdb',
  createrole: 'createrole',
  replication: 'replication',
  bypassrls: 'bypassrls',
  connectionLimit: 'connectionLimit',
}

/**
 * The setting expectations, in a stable order, as `postgres.roles.inspect@2`
 * takes them: the host compares each value and answers whether it holds
 * (capabilities.md §6); the value itself is never read back.
 */
export function settingExpectations(e: RoleExpectations): JsonObject[] {
  return [...e.settings].map(([key, value]) => {
    const [role = '', database = '', name = ''] = key.split('\u0000')
    // '' is no database name (a managed name is never empty): all databases.
    return { role, database: database === '' ? null : database, name, value }
  })
}

/**
 * Whether `postgres.roles.inspect@2` (read with {@link settingExpectations})
 * shows every expectation: attributes, passwords and memberships from the
 * result, settings from the host's own comparisons.
 */
export function rolesShow(inspect: JsonObject, e: RoleExpectations): boolean {
  const roles = new Map(
    list(inspect['roles'])
      .map(obj)
      .map((r) => [str(r['name']), r]),
  )
  for (const [role, attributes] of e.attributes) {
    const r = roles.get(role)
    if (r === undefined) return false
    for (const [key, value] of Object.entries(attributes)) {
      const field = ATTRIBUTE_FIELDS[key]
      if (value !== null && field !== undefined && r[field] !== value) return false
    }
  }
  for (const [role, password] of e.passwords) {
    if (roles.get(role)?.['password'] !== password) return false
  }
  const memberships = new Map(
    list(inspect['memberships'])
      .map(obj)
      .map((m) => [`${str(m['role'])}\u0000${str(m['member'])}`, m]),
  )
  for (const [key, want] of e.memberships) {
    const m = memberships.get(key)
    if (want === null) {
      if (m !== undefined) return false
      continue
    }
    if (
      m === undefined ||
      m['admin'] !== want['admin'] ||
      m['inherit'] !== want['inherit'] ||
      m['set'] !== want['set']
    ) {
      return false
    }
  }
  const expectations = list(inspect['expectations']).map(obj)
  return expectations.length === e.settings.size && expectations.every((x) => x['holds'] === true)
}

export class RolesApplyKind extends CapabilityKind {
  readonly kind = 'postgres.roles.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.roles.apply@2'
  }

  private steps(c: Body): JsonValue[] {
    return list(obj(c.raw('change'))['steps'])
  }

  /** The roles read with this operation's setting expectations. */
  private expectRead(ctx: ExecutionContext, c: Body): Promise<Read> {
    return this.read(ctx, 'postgres.roles.inspect@2', {
      cluster: this.cluster(c),
      expectSettings: settingExpectations(roleExpectations(this.steps(c))),
    })
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.roles.inspect@2',
      { cluster: this.cluster(c), expectSettings: [] },
      (r) => str(r['rolesDigest']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const end = await this.job(ctx, 'postgres.roles.apply@2', {
      cluster: this.cluster(c),
      expectedRolesDigest: str(fresh.result['rolesDigest']) ?? '',
      steps: this.steps(c),
    })
    return this.applied(end, 'postgres.roles.apply@2')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const read = await this.expectRead(ctx, c)
    if (!read.ok) {
      return 'error'
    }
    return rolesShow(read.result, roleExpectations(this.steps(c))) ? 'passed' : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.expectRead(ctx, c)
    if (!read.ok) {
      return 'unknown' as const
    }
    if (str(read.result['rolesDigest']) === Body.expected(ctx.plan).textOrNull('basisDigest')) {
      return 'not_applied' as const
    }
    return rolesShow(read.result, roleExpectations(this.steps(c)))
      ? ('applied' as const)
      : ('unknown' as const)
  }
}

// ----- postgres.extensions.apply -----

export class ExtensionsApplyKind extends CapabilityKind {
  readonly kind = 'postgres.extensions.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.extensions.apply@1'
  }

  private args(c: Body): JsonObject {
    return { cluster: this.cluster(c), database: str(obj(c.raw('change'))['database']) ?? '' }
  }

  private shows(inspect: JsonObject, c: Body): boolean {
    const want = new Map<string, string>()
    for (const step of list(obj(c.raw('change'))['steps']).map(obj)) {
      want.set(str(step['name']) ?? '', str(step['version']) ?? '')
    }
    const installed = new Map(
      list(inspect['installed'])
        .map(obj)
        .map((e) => [str(e['name']), str(e['version'])]),
    )
    return [...want].every(([name, version]) => installed.get(name) === version)
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(ctx, 'postgres.extensions.inspect@1', this.args(c), (r) =>
      str(r['extensionsDigest']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const end = await this.job(ctx, 'postgres.extensions.apply@1', {
      ...this.args(c),
      expectedExtensionsDigest: str(fresh.result['extensionsDigest']) ?? '',
      steps: list(obj(c.raw('change'))['steps']),
    })
    return this.applied(end, 'postgres.extensions.apply@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.extensions.inspect@1', this.args(c))
    if (!read.ok) {
      return 'error'
    }
    return this.shows(read.result, c) ? 'passed' : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.extensions.inspect@1', this.args(c))
    if (!read.ok) {
      return 'unknown' as const
    }
    if (
      str(read.result['extensionsDigest']) === Body.expected(ctx.plan).textOrNull('basisDigest')
    ) {
      return 'not_applied' as const
    }
    return this.shows(read.result, c) ? ('applied' as const) : ('unknown' as const)
  }
}

// ----- postgres.tls.rotate -----

export class TlsRotateKind extends CapabilityKind {
  readonly kind = 'postgres.tls.rotate' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.tls.rotate@1'
  }

  private fingerprintOf(inspect: JsonObject): string | null {
    return str(obj(inspect['certificate'])['fingerprint'])
  }

  /** The fingerprint of the certificate this operation sent, from its rotate job. */
  private async issued(operationId: string): Promise<string | undefined> {
    const own = await this.ownJob(operationId, 'postgres.tls.rotate@1')
    const first = str(list(own?.args['certificateChain'])[0])
    if (first === null) {
      return undefined
    }
    return certificateFingerprint(new Uint8Array(Buffer.from(first, 'base64url')))
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.tls.inspect@1',
      { cluster: this.cluster(c) },
      (r) => this.fingerprintOf(r),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const change = obj(c.raw('change'))
    const dnsNames = list(change['dnsNames']).filter((x): x is string => typeof x === 'string')
    const ipAddresses = list(change['ipAddresses']).filter(
      (x): x is string => typeof x === 'string',
    )
    const plan = await this.job(ctx, 'postgres.tls.plan@1', {
      cluster: this.cluster(c),
      dnsNames,
      ipAddresses,
    })
    if (plan.end !== 'succeeded') {
      return this.readFailure(plan, 'postgres.tls.plan@1')
    }
    const stagingId = str(plan.result['stagingId']) ?? ''
    const publicKey = str(plan.result['publicKey']) ?? ''
    if (!tlsProofValid(plan.jobId, publicKey, str(plan.result['proof']) ?? '')) {
      return {
        outcome: 'not_applied',
        errorCode: 'NODE_CAPABILITY_FAILED',
        detail: { capability: 'postgres.tls.plan@1', jobId: plan.jobId, reason: 'proof_invalid' },
      }
    }
    const stale = await this.readmitted(ctx)
    if (stale !== undefined) {
      return stale
    }
    let issued: { readonly certificate: Uint8Array; readonly ca: Uint8Array }
    try {
      issued = await issuePostgresServerCertificate(this.d.store, this.d.keyring, this.d.clock, {
        publicKey,
        dnsNames,
        ipAddresses,
        validityDays: typeof change['validityDays'] === 'number' ? change['validityDays'] : 90,
      })
    } catch (error) {
      if (error instanceof NodeError) {
        return {
          outcome: 'not_applied',
          errorCode: error.code,
          ...(error.details === undefined ? {} : { detail: error.details }),
        }
      }
      throw error
    }
    const end = await this.job(ctx, 'postgres.tls.rotate@1', {
      cluster: this.cluster(c),
      stagingId,
      publicKey,
      certificateChain: [b64u(issued.certificate), b64u(issued.ca)],
      expectedCurrentFingerprint: this.fingerprintOf(fresh.result),
    })
    return this.applied(end, 'postgres.tls.rotate@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.tls.rotate@1')
    const issued = await this.issued(ctx.operationId)
    if (own === undefined || issued === undefined) {
      return 'error'
    }
    const read = await this.read(ctx, 'postgres.tls.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    // What the cluster presents to the Control Plane itself, over its
    // registered endpoint and CA bundle; and the job's report when it stated one.
    const presented = await presentedCertificate(this.d.store, c.text('clusterId'))
    if (presented === undefined) {
      return 'error'
    }
    const reported =
      own.end?.end !== 'succeeded' ||
      (str(own.end.result['fingerprint']) === issued &&
        str(own.end.result['presentedFingerprint']) === issued)
    return reported && this.fingerprintOf(read.result) === issued && presented === issued
      ? 'passed'
      : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const issued = await this.issued(ctx.operationId)
    const read = await this.read(ctx, 'postgres.tls.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'unknown' as const
    }
    const now = this.fingerprintOf(read.result)
    if (issued !== undefined && now === issued) {
      return 'applied' as const
    }
    return now === Body.expected(ctx.plan).textOrNull('basisDigest')
      ? ('not_applied' as const)
      : ('unknown' as const)
  }
}

// ----- credential.rotate -----

const ACCESS_ROLES = new Set<AccessRole>(['observer', 'reader', 'verifier', 'operator', 'migrator'])

export class CredentialRotateKind extends CapabilityKind {
  readonly kind = 'credential.rotate' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.roles.apply@2'
  }

  private role(c: Body): AccessRole {
    const role = c.text('role')
    if (!ACCESS_ROLES.has(role as AccessRole)) {
      throw new ContentInvalid('content.role')
    }
    return role as AccessRole
  }

  /**
   * The plan is bound to the role's active credential (or none) and to no
   * other credential waiting for verification (Wave 5 correction F5): at
   * acceptance and before the operation starts here, and again, locked,
   * where the new password is prepared.
   */
  override async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const changed = await super.checkBindings(plan)
    if (changed.length > 0) {
      return changed
    }
    try {
      const c = Body.content(plan)
      return credentialBindings(
        await credentialsOf(this.d.store, c.text('clusterId'), this.role(c), false),
        Body.expected(plan).textOrNull('activeCredentialId'),
      )
    } catch (error) {
      if (error instanceof ContentInvalid) {
        return [{ binding: 'content', actual: 'invalid' }]
      }
      throw error
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const role = this.role(c)
    const roleName = `exponetdb_${role}`
    const clusterId = c.text('clusterId')
    const identityId = ctx.plan.actor.identityId
    if (identityId === null || !isId('idn', identityId)) {
      return 'not_applied'
    }
    const read = await this.read(ctx, 'postgres.roles.inspect@2', {
      cluster: this.cluster(c),
      expectSettings: [],
    })
    if (!read.ok) {
      return this.readFailure(read.end, 'postgres.roles.inspect@2')
    }
    const present = list(read.result['roles'])
      .map(obj)
      .some((r) => r['name'] === roleName && r['login'] === true)
    if (!present) {
      return {
        outcome: 'not_applied',
        errorCode: 'REGISTRY_CONFLICT',
        detail: { reason: 'role_missing' },
      }
    }
    // The password is stored before any job, as the next version of the
    // role's secret; only its verifier goes to the node, sealed.
    const password = generatedPassword()
    const verifier = scramVerifier(password)
    let jobId: string | undefined
    let stale: readonly ChangedBinding[] = []
    try {
      jobId = await this.d.store.transaction('nodes.kind.credential.prepare', async (tx) => {
        // Only the lease holder stores a secret version and creates the job,
        // and only while what admitted the operation still holds.
        if (ctx.signal.aborted || !(await leaseHeld(tx, ctx.operationId, ctx.leaseOwner))) {
          return undefined
        }
        if (ctx.readmit !== undefined) {
          stale = await ctx.readmit(tx)
          if (stale.length > 0) {
            return undefined
          }
        }
        // Compare and set (F5): the role's credentials are locked and must
        // still be what the plan was approved for; a concurrent activation
        // makes the plan stale before any password exists.
        stale = credentialBindings(
          await credentialsOf(tx, clusterId, role, true),
          Body.expected(ctx.plan).textOrNull('activeCredentialId'),
        )
        if (stale.length > 0) {
          return undefined
        }
        const plaintext = new Uint8Array(Buffer.from(password, 'utf8'))
        try {
          const latest = await latestCredential(tx, clusterId, role)
          const ref =
            latest === undefined
              ? await createSecret(
                  tx,
                  this.d.keyring,
                  {
                    purpose: 'pg_credential',
                    subjectId: `${clusterId}/${roleName}`,
                    consumer: consumerOf(role),
                    plaintext,
                  },
                  { clock: this.d.clock },
                )
              : await addSecretVersion(
                  tx,
                  this.d.keyring,
                  (() => {
                    const id = parseId('sec', latest.secretId)
                    if (!id.ok) throw new NodeError('INTERNAL')
                    return id.value
                  })(),
                  plaintext,
                )
          await tx.query(
            'nodes.kind.credential.rotation',
            `INSERT INTO nodes.credential_rotations (operation_id, cluster_id, access_role, secret_id, secret_version)
             VALUES ($1, $2, $3, $4, $5)`,
            [ctx.operationId, clusterId, role, ref.secretId, ref.version],
          )
        } finally {
          plaintext.fill(0)
        }
        const created = await createJob(tx, this.d.keyring, this.d.clock, this.d.installationId, {
          nodeId: c.text('nodeId'),
          operationId: ctx.operationId,
          capability: 'postgres.roles.apply@2',
          windowSeconds: APPLY_JOB_SECONDS,
          args: (seal) => ({
            cluster: this.cluster(c),
            expectedRolesDigest: str(read.result['rolesDigest']) ?? '',
            steps: [
              {
                op: 'set_password',
                role: roleName,
                attributes: null,
                verifier: seal('verifier', new Uint8Array(Buffer.from(verifier, 'utf8'))),
                member: null,
                admin: null,
                inherit: null,
                set: null,
                database: null,
                setting: null,
                value: null,
              },
            ],
          }),
        })
        return created.jobId
      })
    } catch (error) {
      if (error instanceof NodeError) {
        return { outcome: 'not_applied', errorCode: error.code }
      }
      throw error
    }
    if (stale.length > 0) {
      return {
        outcome: 'not_applied',
        errorCode: 'PLAN_STALE',
        detail: { changedBindings: stale.map((b) => b.binding) },
      }
    }
    if (jobId === undefined) {
      return 'unknown'
    }
    const end = await awaitJob(this.d, jobId, 'postgres.roles.apply@2', ctx.signal)
    const outcome = this.applied(end, 'postgres.roles.apply@2')
    if (ctx.signal.aborted) {
      // The lease is lost: the next lease holder reconciles, and writes the
      // pending credential itself once the job has settled (reconcile).
      return 'unknown'
    }
    if (outcome === 'applied' || outcome === 'unknown') {
      // The pending credential, which verification activates once a login
      // with it succeeds; a job that did not run leaves the version unused.
      await this.pendingCredential(ctx, clusterId, role, identityId)
    }
    return outcome
  }

  private async pendingCredential(
    ctx: ExecutionContext,
    clusterId: string,
    role: AccessRole,
    identityId: string,
  ): Promise<void> {
    await this.d.store.transaction('nodes.kind.credential.pending', async (tx) => {
      const { rows } = await tx.query(
        'nodes.kind.credential.read',
        `SELECT secret_id, secret_version, credential_id FROM nodes.credential_rotations
          WHERE operation_id = $1 FOR UPDATE`,
        [ctx.operationId],
      )
      const row = rows[0]
      if (row === undefined || row.textOrNull('credential_id') !== null) {
        return
      }
      await tx.query(
        'nodes.kind.credential.supersede',
        `UPDATE registry.credentials SET state = 'failed', failure_code = 'superseded'
          WHERE cluster_id = $1 AND access_role = $2 AND state = 'pending'`,
        [clusterId, role],
      )
      const credentialId = newId('crd', this.d.clock.nowMs())
      await tx.query(
        'nodes.kind.credential.insert',
        `INSERT INTO registry.credentials (credential_id, cluster_id, access_role, role_name, secret_id,
                                           secret_version, state, submitted_at, submitted_by, state_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', clock_timestamp(), $7, clock_timestamp())`,
        [
          credentialId,
          clusterId,
          role,
          `exponetdb_${role}`,
          row.text('secret_id'),
          row.int('secret_version'),
          identityId,
        ],
      )
      await tx.query(
        'nodes.kind.credential.link',
        'UPDATE nodes.credential_rotations SET credential_id = $2 WHERE operation_id = $1',
        [ctx.operationId, credentialId],
      )
    })
  }

  private async credential(q: Queryable, operationId: string) {
    const { rows } = await q.query(
      'nodes.kind.credential.of_operation',
      'SELECT credential_id FROM nodes.credential_rotations WHERE operation_id = $1',
      [operationId],
    )
    const credentialId = rows[0]?.textOrNull('credential_id')
    return credentialId === undefined || credentialId === null
      ? undefined
      : getCredential(q, credentialId)
  }

  /**
   * What a login with the new password shows (Wave 5 correction F4). Only a
   * login proves anything: `works` (it logged in; `roleWrong` when the role
   * is not at its least privilege) means the host has the new password;
   * `rejected` means the server refused that password over a verified TLS
   * session; anything else (TLS, the pinned identity, the authentication
   * method, an unreachable cluster) is `inconclusive` and proves nothing
   * about the password.
   */
  private async loginWith(
    credential: CredentialRecord,
  ): Promise<'works' | 'roleWrong' | 'rejected' | 'inconclusive'> {
    if (this.d.connector === undefined) {
      return 'inconclusive'
    }
    const result = await verifyCredentialLogin(this.d.connector, this.d.store, credential)
    if (result.status === 'active') {
      return 'works'
    }
    if (result.status === 'failed' && result.failureCode === 'role_attributes') {
      return 'roleWrong'
    }
    if (result.status === 'failed' && result.failureCode === 'authentication_failed') {
      return 'rejected'
    }
    return 'inconclusive'
  }

  /**
   * Activates the new credential in place of exactly the credential the plan
   * approved (F5); `false` when another credential is active now (nothing is
   * replaced) or it cannot be decided yet.
   */
  private async activate(ctx: ExecutionContext, credential: CredentialRecord): Promise<boolean> {
    const replaces = Body.expected(ctx.plan).textOrNull('activeCredentialId')
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await recordActivation(this.d.store, this.d.clock, credential, replaces)
      if (result === 'activated') {
        return true
      }
      if (result !== 'busy') {
        // Decided by another worker (the periodic verification activates
        // the same way), or another credential is active: read what is.
        const now = await getCredential(this.d.store, credential.credentialId)
        return now?.state === 'active' || now?.state === 'retired'
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  /** Records that the new password is not the host's (a definitive refusal). */
  private async refuse(credential: CredentialRecord): Promise<void> {
    await recordVerification(this.d.store, this.d.clock, credential, {
      status: 'failed',
      failureCode: 'authentication_failed',
    })
  }

  /**
   * After a lost worker (§9.4; correction review of F4): the apply job is
   * settled first. The pending credential the lost worker may not have
   * written yet is written for a job that may have set the password, so the
   * password the host may have is never left unrecorded. A job that ran
   * (its statement succeeded) is applied; one that certainly never ran
   * fails the rotation's pending credential, so it blocks no later
   * rotation; anything else is judged by logins (hostState). Never runs the
   * job again.
   */
  override async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const capability = 'postgres.roles.apply@2'
    const own = await this.ownJob(ctx.operationId, capability)
    if (own === undefined) {
      return 'not_applied'
    }
    const end = await settleJob(this.d, own.jobId, capability, ctx.signal, own.capability)
    if (ctx.signal.aborted) {
      return 'unknown'
    }
    const c = Body.content(ctx.plan)
    const identityId = ctx.plan.actor.identityId
    const outcome = outcomeOf(end, capability)
    if (outcome === 'not_applied') {
      const credential = await this.credential(this.d.store, ctx.operationId)
      if (credential?.state === 'pending') {
        await recordVerification(this.d.store, this.d.clock, credential, {
          status: 'failed',
          failureCode: 'not_applied',
        })
      }
      return 'not_applied'
    }
    if (end.end === 'succeeded') {
      if (identityId !== null) {
        await this.pendingCredential(ctx, c.text('clusterId'), this.role(c), identityId)
      }
      return 'applied'
    }
    return this.hostState(ctx)
  }

  /**
   * Verification (§9.6): the new password logs in with the role at its least
   * privilege, and the credential is activated in place of the approved one.
   * A refusal of the password fails it; a role that is not at its least
   * privilege fails verification but keeps the credential pending (the host
   * has that password: it is activated once the role is fixed, without
   * setting it again); anything inconclusive is an error (needs attention),
   * the credential still pending.
   */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const credential = await this.credential(this.d.store, ctx.operationId)
    if (credential === undefined) {
      return 'error'
    }
    if (credential.state === 'active' || credential.state === 'retired') {
      return 'passed'
    }
    if (credential.state === 'failed') {
      return 'failed'
    }
    switch (await this.loginWith(credential)) {
      case 'works':
        return (await this.activate(ctx, credential)) ? 'passed' : 'error'
      case 'roleWrong':
        return 'failed'
      case 'rejected':
        await this.refuse(credential)
        return 'failed'
      default:
        return 'error'
    }
  }

  /**
   * Reconciliation after the apply job settled without a decisive statement
   * (F4): the host is judged by logins, never by the registry's metadata. The
   * new password logging in proves it was set (applied). It being refused
   * proves nothing alone: only when the password the plan replaces still
   * logs in is the change not applied (and the new credential failed). Every
   * other case stays unknown with the new credential pending, so it can be
   * decided later without setting any password again.
   */
  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const identityId = ctx.plan.actor.identityId
    const { rows } = await this.d.store.query(
      'nodes.kind.credential.rotation_row',
      'SELECT credential_id FROM nodes.credential_rotations WHERE operation_id = $1',
      [ctx.operationId],
    )
    if (rows[0] === undefined) {
      return 'not_applied' as const
    }
    if (rows[0].textOrNull('credential_id') === null && identityId !== null) {
      await this.pendingCredential(ctx, c.text('clusterId'), this.role(c), identityId)
    }
    const credential = await this.credential(this.d.store, ctx.operationId)
    if (credential === undefined) {
      return 'unknown' as const
    }
    if (credential.state === 'active' || credential.state === 'retired') {
      return 'applied' as const
    }
    if (credential.state === 'failed') {
      // Failed only on a definitive refusal, or superseded by a person's
      // submission: nothing proves the host either way any more.
      return credential.failureCode === 'authentication_failed' ||
        credential.failureCode === 'not_applied'
        ? ('not_applied' as const)
        : ('unknown' as const)
    }
    const shown = await this.loginWith(credential)
    if (shown === 'works' || shown === 'roleWrong') {
      return 'applied' as const
    }
    if (shown !== 'rejected') {
      return 'unknown' as const
    }
    const replacedId = Body.expected(ctx.plan).textOrNull('activeCredentialId')
    const replaced = replacedId === null ? undefined : await getCredential(this.d.store, replacedId)
    if (replaced === undefined || replaced.state !== 'active') {
      return 'unknown' as const
    }
    const old = await this.loginWith(replaced)
    if (old !== 'works' && old !== 'roleWrong') {
      return 'unknown' as const
    }
    await this.refuse(credential)
    return 'not_applied' as const
  }
}

/**
 * The role's active and pending credentials (locked in the preparation
 * transaction): the pending row first, then the active one, the order in
 * which a verification or an activation locks them, so the two never
 * deadlock (correction review).
 */
async function credentialsOf(
  q: Queryable,
  clusterId: string,
  role: AccessRole,
  lock: boolean,
): Promise<{ readonly active: string | null; readonly pending: string | null }> {
  const { rows } = await q.query(
    'nodes.kind.credential.states',
    `SELECT credential_id, state FROM registry.credentials
      WHERE cluster_id = $1 AND access_role = $2 AND state IN ('active', 'pending')
      ORDER BY state = 'pending' DESC, credential_id${lock ? ' FOR UPDATE' : ''}`,
    [clusterId, role],
  )
  const of = (state: string) =>
    rows.find((r) => r.text('state') === state)?.text('credential_id') ?? null
  return { active: of('active'), pending: of('pending') }
}

/** What changed against the credential a rotation plan was approved for. */
function credentialBindings(
  live: { readonly active: string | null; readonly pending: string | null },
  expected: string | null,
): ChangedBinding[] {
  const changed: ChangedBinding[] = []
  if (live.active !== expected) {
    changed.push({ binding: 'activeCredential', expected, actual: live.active })
  }
  if (live.pending !== null) {
    changed.push({ binding: 'pendingCredential', expected: null, actual: live.pending })
  }
  return changed
}

/**
 * The owner of a pending credential that a rotation created (Wave 5
 * correction F4), for the worker's periodic verification: the rotation's
 * credential is activated only in place of the credential its plan approved,
 * and never failed there on a login that proves nothing.
 */
export async function rotationOwner(
  q: Queryable,
  credential: Pick<CredentialRecord, 'credentialId'>,
): Promise<{ readonly replaces: string | null } | undefined> {
  const { rows } = await q.query(
    'nodes.kind.credential.owner',
    `SELECT o.plan_id FROM nodes.credential_rotations r
       JOIN operations.operations o USING (operation_id)
      WHERE r.credential_id = $1`,
    [credential.credentialId],
  )
  const planId = rows[0]?.textOrNull('plan_id')
  if (planId === undefined || planId === null) {
    return undefined
  }
  let plan: PlanRecord | undefined
  try {
    plan = await readPlan(q, planId)
  } catch (error) {
    // A plan body that no longer hashes to its plan (scrubbed by the OD-28
    // procedure): what it replaced cannot be read, so nothing is activated
    // in place of anything unseen (correction review).
    if (error instanceof OperationError) {
      return { replaces: '' }
    }
    throw error
  }
  if (plan === undefined) {
    // A rotation without its plan: activated in place of nothing unseen.
    return { replaces: '' }
  }
  return { replaces: Body.expected(plan).textOrNull('activeCredentialId') }
}

// ----- node.config.update (§9.8) -----

function keySet(value: JsonValue | undefined): string[] {
  return list(value)
    .filter((k): k is string => typeof k === 'string')
    .sort()
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

export class NodeConfigUpdateKind extends CapabilityKind {
  readonly kind = 'node.config.update' as const

  /** The node's only domain in the frozen operations bundle (§9.8). */
  override exclusivity(plan: PlanRecord): readonly string[] {
    return [`node:${Body.content(plan).text('nodeId')}:packages`]
  }

  protected override applyCapability(): NodeCapabilityKey {
    return 'config.update@1'
  }

  override async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    const changed = [...(await super.checkBindings(plan))]
    if (changed.length > 0) {
      return changed
    }
    const content = Body.content(plan)
    const expected = Body.expected(plan)
    const nodeId = content.text('nodeId')
    const trusted = await trustedJobKeys(this.d.store, nodeId)
    if (jobKeySetDigest(trusted) !== expected.textOrNull('trustedJobKeys')) {
      changed.push({ binding: 'trustedJobKeys' })
    }
    const states = obj(expected.raw('keyStates'))
    const { rows } = await this.d.store.query(
      'nodes.kind.job_key_states',
      `SELECT key_id, state FROM nodes.job_keys WHERE key_id = ANY($1::text[]) OR state = 'active'`,
      [Object.keys(states)],
    )
    const active = rows.find((r) => r.text('state') === 'active')?.text('key_id') ?? null
    if (active !== expected.textOrNull('activeJobKey')) {
      changed.push({
        binding: 'activeJobKey',
        expected: expected.textOrNull('activeJobKey'),
        actual: active,
      })
    }
    for (const [keyId, state] of Object.entries(states)) {
      const now = rows.find((r) => r.text('key_id') === keyId)?.text('state') ?? null
      if (now !== state) {
        changed.push({ binding: 'jobKeyState', expected: str(state), actual: now })
      }
    }
    return changed
  }

  /**
   * The node's own, node-signed key sets (`agent.diagnostics@1`): the agent's
   * and the root helper's, which read them with the same job; `helper` is
   * null when the helper could not be asked.
   */
  private async nodeKeys(
    ctx: ExecutionContext,
    signingKeyId?: string,
  ): Promise<
    { readonly keys: string[]; readonly helper: string[] | null } | { readonly end: JobEnd }
  > {
    const read = await this.read(ctx, 'agent.diagnostics@2', {}, signingKeyId)
    if (!read.ok) {
      return { end: read.end }
    }
    const helper = read.result['helperJobKeys']
    return {
      keys: keySet(read.result['jobKeys']),
      helper: Array.isArray(helper) ? keySet(helper) : null,
    }
  }

  /**
   * Records the node's statement, only while this worker holds the
   * operation; false when nothing was recorded (the lease or the node gone).
   */
  private async record(ctx: ExecutionContext, keys: readonly string[]): Promise<boolean> {
    const nodeId = Body.content(ctx.plan).text('nodeId')
    return this.d.store.transaction('nodes.kind.record_trusted_job_keys', async (tx) => {
      if (!(await leaseHeld(tx, ctx.operationId, ctx.leaseOwner))) {
        return false
      }
      const { rows } = await tx.query(
        'nodes.kind.trusted_job_keys',
        `UPDATE nodes.nodes SET trusted_job_keys = $2::jsonb
          WHERE node_id = $1 AND state IN ('active', 'degraded')
          RETURNING node_id`,
        [nodeId, JSON.stringify(keys)],
      )
      return rows.length === 1
    })
  }

  /** The key a verification read is signed with: the added key while it may still sign, else the active key. */
  private async verifyingKey(c: Body): Promise<string | undefined> {
    const added = c.textOrNull('verifyWith')
    if (added === null) {
      return undefined
    }
    const { rows } = await this.d.store.query(
      'nodes.kind.verifying_key',
      `SELECT 1 FROM nodes.job_keys WHERE key_id = $1 AND state IN ('staged', 'active')`,
      [added],
    )
    return rows.length === 1 ? added : undefined
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const before = keySet(c.raw('before'))
    const after = keySet(c.raw('after'))
    // The agent's own set must still be the recorded one the plan was made
    // on; the helper's may already be the target (a partial update before,
    // which this job completes).
    const basis = await this.nodeKeys(ctx)
    if ('end' in basis) {
      return this.readFailure(basis.end, 'agent.diagnostics@2')
    }
    if (
      !sameSet(basis.keys, before) ||
      basis.helper === null ||
      !(sameSet(basis.helper, before) || sameSet(basis.helper, after))
    ) {
      return this.stale('host_state')
    }
    const end = await this.job(ctx, 'config.update@1', {
      gateway: null,
      addJobKeys: list(c.raw('addJobKeys')),
      retireJobKeys: list(c.raw('retireJobKeys')),
    })
    return this.applied(end, 'config.update@1')
  }

  /**
   * A separate read signed with the key the operation added (otherwise the
   * active key): the agent and the helper accepted it and both report
   * exactly the planned set. Only then is the node's set recorded.
   */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const after = keySet(c.raw('after'))
    const own = await this.ownJob(ctx.operationId, 'config.update@1')
    if (own?.end?.end === 'succeeded' && !sameSet(keySet(own.end.result['jobKeys']), after)) {
      return 'failed'
    }
    const read = await this.nodeKeys(ctx, await this.verifyingKey(c))
    if ('end' in read || read.helper === null) {
      return 'error'
    }
    if (!sameSet(read.keys, after) || !sameSet(read.helper, after)) {
      return 'failed'
    }
    return (await this.record(ctx, read.keys)) ? 'passed' : 'error'
  }

  /** Both sets at the target: applied; both as before: not applied; anything else is open. */
  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.nodeKeys(ctx)
    if ('end' in read || read.helper === null) {
      return 'unknown' as const
    }
    const before = keySet(c.raw('before'))
    const after = keySet(c.raw('after'))
    if (sameSet(read.keys, after) && sameSet(read.helper, after)) {
      return 'applied' as const
    }
    return sameSet(read.keys, before) && sameSet(read.helper, before)
      ? ('not_applied' as const)
      : ('unknown' as const)
  }
}

/**
 * Every operation kind of this package (the lifecycle kinds of `nodeKinds`
 * and the capability kinds below): the worker's dispatch admission re-checks
 * their policy and approvals before one starts (Wave 5 correction F2).
 */
export const NODE_OPERATION_KINDS: readonly string[] = [
  'node.enroll',
  'node.revoke',
  'node.decommission',
  'node.inspect',
  ...Object.keys(BASIS),
]

export function capabilityKinds(deps: CapabilityKindDeps): OperationKind[] {
  return [
    new NodeInspectKind(deps),
    new ReloadKind(deps),
    new RestartKind(deps),
    new ConfigApplyKind(deps),
    new HbaApplyKind(deps),
    new RolesApplyKind(deps),
    new ExtensionsApplyKind(deps),
    new TlsRotateKind(deps),
    new CredentialRotateKind(deps),
    new NodeConfigUpdateKind(deps),
  ]
}
