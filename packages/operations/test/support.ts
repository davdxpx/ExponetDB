import type { ControlStore, ControlStoreRole } from '@exponetdb/control-store'
import type { MigratedTestDatabase } from '@exponetdb/control-store/testing'
import {
  expectOk,
  fixedClock,
  isJsonArray,
  isJsonObject,
  newId,
  parseId,
  systemClock,
} from '@exponetdb/kernel'
import {
  type PolicyDecision,
  PolicyEngine,
  type Requirement,
  RuleRegistry,
} from '@exponetdb/policy'
import {
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  KindRegistry,
  type OperationActor,
  type OperationKind,
  type PlanRecord,
} from '../src/index.ts'

export const human: OperationActor = {
  kind: 'human',
  identityId: expectOk(parseId('idn', 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'), 'identity'),
  label: 'human #1',
  client: 'web',
  clientId: null,
}
export const otherHuman: OperationActor = {
  ...human,
  identityId: expectOk(parseId('idn', 'idn_01JB2Z6G8M4Q7R9T1V3W5X7YA0'), 'identity'),
  label: 'human #2',
}
export const serveActor: OperationActor = {
  kind: 'system',
  identityId: null,
  label: 'system:serve',
  client: 'system',
  clientId: null,
}

const engine = new PolicyEngine({
  registry: new RuleRegistry(),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(0),
})

export async function decision(
  kind: PolicyDecision['decision'] = 'allow',
  requirements: readonly Requirement[] = [],
): Promise<PolicyDecision> {
  const base = await engine.evaluate({
    request: {
      kind: 'synthetic.apply',
      principal: { kind: 'human', identityId: null, client: 'web' },
      subject: {},
    },
    settings: [],
  })
  return { ...base, decision: kind, requirements }
}

export const target = () => newId('tgt', Date.now())

export interface SyntheticCalls {
  execute: number
  verify: number
  reconcile: number
}

export interface SyntheticBehavior {
  readonly execute?: (ctx: ExecutionContext) => Promise<ExecutionOutcome>
  readonly verify?: () => Promise<'passed' | 'failed' | 'partial' | 'error'>
  readonly reconcile?: () => Promise<'applied' | 'not_applied' | 'unknown'>
  readonly bindings?: () => Promise<readonly { binding: string }[]>
  readonly verifies?: boolean
}

/** A synthetic kind: domains from the plan content, behavior from the test. */
export function syntheticKind(
  name: string,
  behavior: SyntheticBehavior = {},
): OperationKind & { readonly calls: SyntheticCalls } {
  const calls: SyntheticCalls = { execute: 0, verify: 0, reconcile: 0 }
  return {
    calls,
    kind: name,
    version: 1,
    actionClass: 'standard',
    verifies: behavior.verifies ?? true,
    exclusivity(plan: PlanRecord) {
      const content = plan.body['content']
      const domains = isJsonObject(content) ? content['domains'] : undefined
      return isJsonArray(domains) ? domains.filter((d) => typeof d === 'string') : []
    },
    supersedes(plan: PlanRecord) {
      const content = plan.body['content']
      const named = isJsonObject(content) ? content['supersedes'] : undefined
      return isJsonArray(named) ? named.filter((d) => typeof d === 'string') : []
    },
    checkBindings: async () => (behavior.bindings === undefined ? [] : behavior.bindings()),
    async execute(ctx) {
      calls.execute += 1
      return behavior.execute === undefined ? 'applied' : behavior.execute(ctx)
    },
    async verify() {
      calls.verify += 1
      return behavior.verify === undefined ? 'passed' : behavior.verify()
    },
    async reconcile() {
      calls.reconcile += 1
      return behavior.reconcile === undefined ? 'unknown' : behavior.reconcile()
    },
  }
}

export function stores(db: MigratedTestDatabase): (role: ControlStoreRole) => ControlStore {
  const cache = new Map<ControlStoreRole, ControlStore>()
  return (role) => {
    let store = cache.get(role)
    if (store === undefined) {
      store = db.store(role)
      cache.set(role, store)
    }
    return store
  }
}

export async function newPlan(
  store: ControlStore,
  options: {
    kind?: string
    actor?: OperationActor
    domains?: readonly string[]
    /** Operations in needs_attention the plan names to close (TC-005). */
    supersedes?: readonly string[]
    decision?: PolicyDecision
    lifetimeMs?: number
  } = {},
): Promise<PlanRecord> {
  const policy = options.decision ?? (await decision())
  return store.transaction('test.plan.create', (tx) =>
    createPlan(
      tx,
      {
        kind: options.kind ?? 'synthetic.apply',
        kindVersion: 1,
        actionClass: 'standard',
        actor: options.actor ?? human,
        subject: { tier: 'nonprod' },
        content: {
          domains: [...(options.domains ?? [])],
          ...(options.supersedes === undefined ? {} : { supersedes: [...options.supersedes] }),
          note: 'synthetic',
        },
        policy,
        ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
      },
      { clock: systemClock },
    ),
  )
}

export const kinds = (...k: OperationKind[]) => new KindRegistry(k)

/** SQLSTATE behind an error from the Control Store, or `undefined` when the statement succeeded. */
export async function sqlstate(
  store: ControlStore,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await store.query('test.statement', sql, params)
    return undefined
  } catch (error) {
    let current: unknown = error
    while (typeof current === 'object' && current !== null) {
      const code: unknown = Reflect.get(current, 'sqlstate')
      if (typeof code === 'string') {
        return code
      }
      current = Reflect.get(current, 'cause')
    }
    return 'unknown'
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
