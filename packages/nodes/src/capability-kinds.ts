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
import type {
  ChangedBinding,
  ExecutionContext,
  ExecutionOutcome,
  OperationKind,
  PlanRecord,
} from '@exponetdb/operations'
import {
  Body,
  type Connector,
  ContentInvalid,
  consumerOf,
  getCredential,
  latestCredential,
  recordVerification,
  verifyCredentialLogin,
} from '@exponetdb/registry'
import { addSecretVersion, createSecret } from '@exponetdb/secrets'
import { type CapabilityKindName, RUNS } from './capability-plans.ts'
import { NodeError } from './errors.ts'
import { createJob } from './jobs.ts'
import { clusterArg, mapCluster, requireCapabilities, servedNode } from './mapping.ts'
import { observationOfOperation, recordObservation } from './observations.ts'
import {
  certificateFingerprint,
  issuePostgresServerCertificate,
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

  /** Runs one job of this operation. */
  protected job(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject | ((seal: (field: string, plaintext: Uint8Array) => JsonObject) => JsonObject),
  ): Promise<JobEnd> {
    const content = Body.content(ctx.plan)
    return runJob(
      this.d,
      {
        nodeId: content.text('nodeId'),
        operationId: ctx.operationId,
        capability,
        args: typeof args === 'function' ? args : () => args,
        windowSeconds:
          NODE_CAPABILITIES[capability].kind === 'apply' ? APPLY_JOB_SECONDS : READ_JOB_SECONDS,
      },
      ctx.signal,
    )
  }

  /** A read job's result, or why there is none. */
  protected async read(
    ctx: ExecutionContext,
    capability: NodeCapabilityKey,
    args: JsonObject,
  ): Promise<Read> {
    try {
      const end = await this.job(ctx, capability, args)
      return end.end === 'succeeded' ? { ok: true, result: end.result } : { ok: false, end }
    } catch (error) {
      if (error instanceof NodeError) {
        return { ok: false, end: { end: 'unproven', jobId: '', why: error.code } }
      }
      throw error
    }
  }

  /** The latest job of this operation for a capability, and what it proves. */
  protected async ownJob(
    operationId: string,
    capability: NodeCapabilityKey,
  ): Promise<
    | { readonly jobId: string; readonly args: JsonObject; readonly end: JobEnd | undefined }
    | undefined
  > {
    const { rows } = await this.d.store.query(
      'nodes.kind.own_job',
      `SELECT job_id, envelope -> 'args' AS args FROM nodes.jobs
        WHERE operation_id = $1 AND capability = $2 ORDER BY created_at DESC LIMIT 1`,
      [operationId, capability],
    )
    const row = rows[0]
    if (row === undefined) {
      return undefined
    }
    const jobId = row.text('job_id')
    const args = row.json('args')
    return {
      jobId,
      args: isJsonObject(args as JsonValue) ? (args as JsonObject) : {},
      end: await judgedEnd(this.d, jobId, capability),
    }
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

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const capability = this.applyCapability()
    if (capability !== undefined) {
      const own = await this.ownJob(ctx.operationId, capability)
      if (own === undefined) {
        return 'not_applied'
      }
      if (own.end !== undefined && own.end.end !== 'unproven') {
        if (own.end.end === 'succeeded') {
          return 'applied'
        }
        const o = outcomeOf(own.end, capability)
        if (o !== 'unknown') {
          return 'not_applied'
        }
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

  override async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const capability = Body.content(ctx.plan).text('capability')
    if (!isNodeCapabilityKey(capability)) {
      return 'not_applied'
    }
    const own = await this.ownJob(ctx.operationId, capability)
    if (own === undefined) {
      return 'not_applied'
    }
    if (own.end?.end === 'succeeded') {
      await this.record(ctx, own.end)
      return 'applied'
    }
    return own.end === undefined || own.end.end === 'unproven' ? 'unknown' : 'not_applied'
  }
}

// ----- postgres.reload, postgres.restart -----

export class ReloadKind extends CapabilityKind {
  readonly kind = 'postgres.reload' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.reload@1'
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const end = await this.job(ctx, 'postgres.reload@1', { cluster: this.cluster(c) })
    return this.applied(end, 'postgres.reload@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.reload@1')
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
    const end = await this.job(ctx, 'postgres.restart@1', {
      cluster: this.cluster(c),
      shutdownMode: 'fast',
    })
    return this.applied(end, 'postgres.restart@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.restart@1')
    if (own?.end?.end !== 'succeeded') {
      return 'error'
    }
    const before = Date.parse(str(own.end.result['postmasterStartTimeBefore']) ?? '')
    const after = Date.parse(str(own.end.result['postmasterStartTimeAfter']) ?? '')
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (!status.ok) {
      return 'error'
    }
    const now = Date.parse(str(status.result['postmasterStartTime']) ?? '')
    return after > before &&
      now >= after &&
      status.result['running'] === true &&
      status.result['acceptingConnections'] === true
      ? 'passed'
      : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.restart@1')
    const status = await this.read(ctx, 'postgres.status@1', { cluster: this.cluster(c) })
    if (own === undefined || !status.ok) {
      return 'unknown' as const
    }
    const { rows } = await this.d.store.query(
      'nodes.kind.job_started',
      'SELECT not_before FROM nodes.jobs WHERE job_id = $1',
      [own.jobId],
    )
    const issued = rows[0]?.date('not_before').getTime()
    const started = Date.parse(str(status.result['postmasterStartTime']) ?? '')
    if (issued === undefined || Number.isNaN(started)) {
      return 'unknown' as const
    }
    return started > issued ? ('applied' as const) : ('not_applied' as const)
  }
}

// ----- postgres.config.apply -----

/** The managed fragment's parameters as the inspection reports them, in file order (last value wins). */
export function managedParameters(inspect: JsonObject): Map<string, string> {
  const path = str(obj(inspect['managedInclude'])['path'])
  const out = new Map<string, string>()
  for (const row of list(inspect['fileSettings'])) {
    const r = obj(row)
    const name = str(r['name'])
    const setting = str(r['setting'])
    if (path !== null && r['sourcefile'] === path && name !== null && setting !== null) {
      out.set(name, setting)
    }
  }
  return out
}

export class ConfigApplyKind extends CapabilityKind {
  readonly kind = 'postgres.config.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.config.apply@1'
  }

  private changes(c: Body): { readonly name: string; readonly value: string | null }[] {
    return list(obj(c.raw('change'))['changes']).map((x) => ({
      name: str(obj(x)['name']) ?? '',
      value: str(obj(x)['value']),
    }))
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.config.inspect@1',
      { cluster: this.cluster(c) },
      (r) => str(r['configVersion']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const parameters = managedParameters(fresh.result)
    for (const change of this.changes(c)) {
      if (change.value === null) {
        parameters.delete(change.name)
      } else {
        parameters.set(change.name, change.value)
      }
    }
    const include = obj(fresh.result['managedInclude'])
    const end = await this.job(ctx, 'postgres.config.apply@1', {
      cluster: this.cluster(c),
      parameters: [...parameters].map(([name, value]) => ({ name, value })),
      expectedFragmentDigest: include['present'] === true ? str(include['digest']) : null,
      configVersion: str(fresh.result['configVersion']) ?? '',
      reload: obj(c.raw('change'))['reload'] === true,
    })
    return this.applied(end, 'postgres.config.apply@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.config.apply@1')
    if (own?.end?.end !== 'succeeded') {
      return 'error'
    }
    const read = await this.read(ctx, 'postgres.config.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    if (
      str(obj(read.result['managedInclude'])['digest']) !== str(own.end.result['fragmentDigest'])
    ) {
      return 'failed'
    }
    const managed = managedParameters(read.result)
    const path = str(obj(read.result['managedInclude'])['path'])
    const pending = new Set(
      list(read.result['settings']).flatMap((s) =>
        obj(s)['pendingRestart'] === true ? [str(obj(s)['name']) ?? ''] : [],
      ),
    )
    const reload = obj(c.raw('change'))['reload'] === true
    for (const change of this.changes(c)) {
      if (change.value === null) {
        if (managed.has(change.name)) return 'failed'
        continue
      }
      if (managed.get(change.name) !== change.value) {
        return 'failed'
      }
      if (reload && !pending.has(change.name)) {
        const rows = list(read.result['fileSettings'])
          .map(obj)
          .filter((r) => r['sourcefile'] === path && r['name'] === change.name)
        const last = rows[rows.length - 1]
        if (last === undefined || last['applied'] !== true || last['error'] !== null) {
          return 'failed'
        }
      }
    }
    return 'passed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.config.apply@1')
    const read = await this.read(ctx, 'postgres.config.inspect@1', { cluster: this.cluster(c) })
    if (own === undefined || !read.ok) {
      return 'unknown' as const
    }
    const managed = managedParameters(read.result)
    const planned = this.changes(c).every((ch) =>
      ch.value === null ? !managed.has(ch.name) : managed.get(ch.name) === ch.value,
    )
    if (planned) {
      return 'applied' as const
    }
    const include = obj(read.result['managedInclude'])
    const now = include['present'] === true ? str(include['digest']) : null
    return now === str(own.args['expectedFragmentDigest'])
      ? ('not_applied' as const)
      : ('unknown' as const)
  }
}

// ----- postgres.hba.apply -----

/** The agent's own access, always passed; the agent checks it whatever the plan names (§9.6). */
const AGENT_ACCESS = {
  role: 'exponetdb_node',
  database: 'postgres',
  address: 'local',
  method: 'peer',
}

export class HbaApplyKind extends CapabilityKind {
  readonly kind = 'postgres.hba.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.hba.apply@1'
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.hba.inspect@1',
      { cluster: this.cluster(c) },
      (r) => str(r['fileDigest']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const change = obj(c.raw('change'))
    const access = list(change['protectedAccess'])
    const end = await this.job(ctx, 'postgres.hba.apply@1', {
      cluster: this.cluster(c),
      managedRules: list(change['managedRules']),
      expectedFileDigest: str(fresh.result['fileDigest']) ?? '',
      protectedAccess: access.length > 0 ? access : [AGENT_ACCESS],
    })
    return this.applied(end, 'postgres.hba.apply@1')
  }

  private managedRules(inspect: JsonObject): JsonObject[] {
    return list(inspect['rules'])
      .map(obj)
      .filter((r) => r['managed'] === true)
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const own = await this.ownJob(ctx.operationId, 'postgres.hba.apply@1')
    if (own?.end?.end !== 'succeeded') {
      return 'error'
    }
    const read = await this.read(ctx, 'postgres.hba.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    const planned = list(obj(c.raw('change'))['managedRules']).length
    const errors = list(read.result['rules']).some((r) => obj(r)['error'] !== null)
    return str(read.result['fileDigest']) === str(own.end.result['fileDigest']) &&
      this.managedRules(read.result).length === planned &&
      !errors
      ? 'passed'
      : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.hba.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'unknown' as const
    }
    if (str(read.result['fileDigest']) === Body.expected(ctx.plan).textOrNull('basisDigest')) {
      return 'not_applied' as const
    }
    const planned = list(obj(c.raw('change'))['managedRules']).length
    return this.managedRules(read.result).length === planned
      ? ('applied' as const)
      : ('unknown' as const)
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
          `${role}\u0000${str(step['database'])}\u0000${str(step['setting'])}`,
          str(step['value']),
        )
        break
      case 'reset_role_setting':
        e.settings.set(`${role}\u0000${str(step['database'])}\u0000${str(step['setting'])}`, null)
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

/** Whether `postgres.roles.inspect` shows every expectation. */
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
  const settings = new Map(
    list(inspect['settings'])
      .map(obj)
      .map((s) => [
        `${str(s['role'])}\u0000${str(s['database'])}\u0000${str(s['name'])}`,
        str(s['value']),
      ]),
  )
  for (const [key, want] of e.settings) {
    if (want === null ? settings.has(key) : settings.get(key) !== want) return false
  }
  return true
}

export class RolesApplyKind extends CapabilityKind {
  readonly kind = 'postgres.roles.apply' as const

  protected override applyCapability(): NodeCapabilityKey {
    return 'postgres.roles.apply@1'
  }

  private steps(c: Body): JsonValue[] {
    return list(obj(c.raw('change'))['steps'])
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = Body.content(ctx.plan)
    const fresh = await this.freshBasis(
      ctx,
      'postgres.roles.inspect@1',
      { cluster: this.cluster(c) },
      (r) => str(r['rolesDigest']),
    )
    if ('outcome' in fresh) {
      return fresh.outcome
    }
    const end = await this.job(ctx, 'postgres.roles.apply@1', {
      cluster: this.cluster(c),
      expectedRolesDigest: str(fresh.result['rolesDigest']) ?? '',
      steps: this.steps(c),
    })
    return this.applied(end, 'postgres.roles.apply@1')
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.roles.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    return rolesShow(read.result, roleExpectations(this.steps(c))) ? 'passed' : 'failed'
  }

  protected override async hostState(ctx: ExecutionContext) {
    const c = Body.content(ctx.plan)
    const read = await this.read(ctx, 'postgres.roles.inspect@1', { cluster: this.cluster(c) })
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
    if (own?.end?.end !== 'succeeded' || issued === undefined) {
      return 'error'
    }
    const read = await this.read(ctx, 'postgres.tls.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return 'error'
    }
    return str(own.end.result['fingerprint']) === issued &&
      str(own.end.result['presentedFingerprint']) === issued &&
      this.fingerprintOf(read.result) === issued
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
    return 'postgres.roles.apply@1'
  }

  private role(c: Body): AccessRole {
    const role = c.text('role')
    if (!ACCESS_ROLES.has(role as AccessRole)) {
      throw new ContentInvalid('content.role')
    }
    return role as AccessRole
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
    const read = await this.read(ctx, 'postgres.roles.inspect@1', { cluster: this.cluster(c) })
    if (!read.ok) {
      return this.readFailure(read.end, 'postgres.roles.inspect@1')
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
    let jobId: string
    try {
      jobId = await this.d.store.transaction('nodes.kind.credential.prepare', async (tx) => {
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
          capability: 'postgres.roles.apply@1',
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
    const end = await awaitJob(this.d, jobId, 'postgres.roles.apply@1', ctx.signal)
    const outcome = this.applied(end, 'postgres.roles.apply@1')
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

  /** Logs in with the new credential and records the result (§9.6). */
  private async login(ctx: ExecutionContext): Promise<'active' | 'failed' | 'pending' | 'missing'> {
    const credential = await this.credential(this.d.store, ctx.operationId)
    if (credential === undefined) {
      return 'missing'
    }
    if (credential.state === 'active' || credential.state === 'retired') {
      return 'active'
    }
    if (credential.state === 'failed') {
      return 'failed'
    }
    if (this.d.connector === undefined) {
      return 'pending'
    }
    const result = await verifyCredentialLogin(this.d.connector, this.d.store, credential)
    if (result.status === 'pending') {
      return 'pending'
    }
    await recordVerification(this.d.store, this.d.clock, credential, result)
    const after = await this.credential(this.d.store, ctx.operationId)
    return after?.state === 'active' ? 'active' : 'failed'
  }

  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    switch (await this.login(ctx)) {
      case 'active':
        return 'passed'
      case 'failed':
        return 'failed'
      default:
        return 'error'
    }
  }

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
    switch (await this.login(ctx)) {
      case 'active':
        return 'applied' as const
      case 'failed':
        return 'not_applied' as const
      default:
        return 'unknown' as const
    }
  }
}

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
  ]
}
