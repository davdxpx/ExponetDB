import { ACTION_IDS, actionDefinition } from '@exponetdb/contracts'
import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  NODE_APPLY_KINDS,
  NODE_RULES,
  PolicyEngine,
  type PolicyRequest,
  RuleRegistry,
} from '../src/index.ts'

/** `node.prod-apply-approval` (Wave 5 correction F2): production and unknown tiers require a human approval. */
const engine = new PolicyEngine({
  registry: new RuleRegistry(NODE_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 8)),
})

const request = (kind: string, tier?: 'prod' | 'nonprod'): PolicyRequest => ({
  kind,
  principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client: 'web' },
  subject: tier === undefined ? {} : { tier },
})

const decide = (kind: string, tier?: 'prod' | 'nonprod', params?: Record<string, number>) =>
  engine.evaluate({
    request: request(kind, tier),
    settings:
      params === undefined
        ? []
        : [
            {
              scopeKind: 'installation',
              scopeId: 'installation',
              ruleId: 'node.prod-apply-approval',
              revision: 1,
              params,
            },
          ],
  })

/**
 * The node lifecycle kinds change the registry's trust in a node, not the
 * host: human-only with re-authentication, outside this rule.
 */
const LIFECYCLE = ['node.enroll', 'node.revoke', 'node.decommission']

describe('node.prod-apply-approval', () => {
  it('requires one approval for every node or cluster apply on production', async () => {
    for (const kind of NODE_APPLY_KINDS) {
      const d = await decide(kind, 'prod')
      expect(d.decision, kind).toBe('require')
      expect(d.requirements, kind).toEqual([
        { kind: 'approval', count: 1, permission: 'plans.approve' },
      ])
    }
  })

  it('treats an unknown tier like production (fail closed)', async () => {
    for (const kind of NODE_APPLY_KINDS) {
      const d = await decide(kind)
      expect(d.decision, kind).toBe('require')
      expect(d.rules.find((r) => r.id === 'node.prod-apply-approval')?.result).toBe('unknown')
    }
  })

  it('allows nonprod changes without approval', async () => {
    for (const kind of NODE_APPLY_KINDS) {
      expect((await decide(kind, 'nonprod')).decision, kind).toBe('allow')
    }
  })

  it('takes a stricter configured count and never a count it cannot use', async () => {
    const two = await decide('postgres.reload', 'prod', { approvals: 2 })
    expect(two.requirements).toEqual([{ kind: 'approval', count: 2, permission: 'plans.approve' }])
    // An unusable configuration never drops the requirement: it denies.
    expect((await decide('postgres.reload', 'prod', { approvals: 0 })).decision).toBe('deny')
  })

  it('does not apply to reads or to the node lifecycle', async () => {
    for (const kind of ['node.inspect', ...LIFECYCLE]) {
      const applied = (await decide(kind, 'prod')).rules.map((r) => r.id)
      expect(applied, kind).not.toContain('node.prod-apply-approval')
    }
    expect((await decide('node.inspect', 'prod')).decision).toBe('allow')
    expect((await decide('node.enroll', 'prod')).decision).toBe('allow')
  })

  it('covers the whole Wave 5 and Wave 8 mutation catalog of nodes and clusters', () => {
    // Every consequential Wave 5 or Wave 8 kind on a node or cluster above
    // `low` is either an apply under the rule or a lifecycle kind named above.
    const mutations = ACTION_IDS.filter((id) => {
      const a = actionDefinition(id)
      return (
        a.operationKind &&
        a.effect === 'consequential' &&
        (a.subject === 'node' || a.subject === 'cluster') &&
        (a.wave.split('/').includes('5') || a.wave === '8') &&
        !(a.class.kind === 'fixed' && a.class.class === 'low')
      )
    })
    // A cluster's declared tier (OD-22, Wave 8) is a registry decision, not a node apply:
    // it always needs production authority and re-authentication (authorization.md §5.1).
    const REGISTRY = ['registry.cluster.declare_tier']
    expect([...mutations].sort()).toEqual([...NODE_APPLY_KINDS, ...LIFECYCLE, ...REGISTRY].sort())
  })
})

/** `node.lifecycle-reauth` (test campaign TC-019): the plan states the re-authentication its apply asks for. */
describe('node.lifecycle-reauth', () => {
  it('lists a fresh re-authentication for a revocation and a decommissioning, on every tier', async () => {
    for (const kind of ['node.revoke', 'node.decommission']) {
      for (const tier of [undefined, 'nonprod', 'prod'] as const) {
        const d = await decide(kind, tier)
        expect(d.decision, `${kind} ${tier}`).toBe('require')
        expect(d.requirements, `${kind} ${tier}`).toEqual([{ kind: 'reauth', withinSeconds: 300 }])
      }
    }
  })

  it('leaves enrollment and reads alone, and takes a shorter window but never an unusable one', async () => {
    expect((await decide('node.enroll', 'prod')).requirements).toEqual([])
    expect((await decide('node.inspect')).requirements).toEqual([])
    const shorter = await engine.evaluate({
      request: request('node.revoke', 'prod'),
      settings: [
        {
          scopeKind: 'installation',
          scopeId: 'installation',
          ruleId: 'node.lifecycle-reauth',
          revision: 1,
          params: { reauthWithinSeconds: 120 },
        },
      ],
    })
    expect(shorter.requirements).toEqual([{ kind: 'reauth', withinSeconds: 120 }])
    const unusable = await engine.evaluate({
      request: request('node.revoke', 'prod'),
      settings: [
        {
          scopeKind: 'installation',
          scopeId: 'installation',
          ruleId: 'node.lifecycle-reauth',
          revision: 1,
          params: { reauthWithinSeconds: 0 },
        },
      ],
    })
    expect(unusable.decision).toBe('deny')
  })
})
