import { fixedClock, type JsonValue } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_RULES,
  type FactProvider,
  lowersSafety,
  PolicyEngine,
  type PolicyRequest,
  RuleRegistry,
} from '../src/index.ts'

/**
 * The Wave 3A access and approval rules, combined by the real engine: an
 * owner-only change by an admin, escalation, the last owner, safety-lowering
 * policy changes and OD-9 self-approval. A missing `access` fact denies.
 */
const base = {
  actorIsOwner: false,
  targetIsSelf: false,
  targetIsOwner: false,
  roleId: null as string | null,
  grantsNotHeld: [] as string[],
  activeOwners: 1,
  removesOwner: false,
  lowersSafety: null as boolean | null,
}

function engine(access?: Partial<typeof base> | 'malformed'): PolicyEngine {
  const providers: FactProvider[] =
    access === undefined
      ? []
      : [
          {
            name: 'access',
            load: async () => ({
              status: 'known',
              value: access === 'malformed' ? { actorIsOwner: 'yes' } : { ...base, ...access },
            }),
          },
        ]
  return new PolicyEngine({
    registry: new RuleRegistry(ACCESS_RULES),
    providers,
    codeVersion: '0.1.0+test',
    clock: fixedClock(Date.UTC(2026, 9, 5)),
  })
}

const request = (kind: string, content?: JsonValue): PolicyRequest => ({
  kind,
  principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client: 'web' },
  subject: {},
  ...(content === undefined ? {} : { content }),
})

async function decision(
  kind: string,
  access?: Partial<typeof base> | 'malformed',
  content?: JsonValue,
) {
  const result = await engine(access).evaluate({ request: request(kind, content), settings: [] })
  return {
    decision: result.decision,
    failed: result.rules
      .filter((r) => r.result === 'fail' || r.result === 'unknown')
      .map((r) => r.id),
  }
}

describe('access rules', () => {
  it('denies when the access fact is missing or malformed (fail closed)', async () => {
    expect(await decision('access.role_binding.create')).toMatchObject({ decision: 'deny' })
    expect(await decision('access.role_binding.delete', 'malformed')).toMatchObject({
      decision: 'deny',
    })
  })

  it('refuses a binding for oneself and a role with permissions the actor lacks', async () => {
    expect(
      await decision('access.role_binding.create', { targetIsSelf: true, actorIsOwner: true }),
    ).toEqual({
      decision: 'deny',
      failed: ['access.no-self-escalation'],
    })
    expect(
      await decision('access.role_binding.create', { grantsNotHeld: ['breakglass.activate'] }),
    ).toEqual({
      decision: 'deny',
      failed: ['access.no-self-escalation'],
    })
    expect(await decision('access.role_binding.create', { roleId: 'developer' })).toEqual({
      decision: 'allow',
      failed: [],
    })
  })

  it('keeps owner changes to owners (no owner bypass for admins, no bypass of other rules for owners)', async () => {
    expect(await decision('access.role_binding.create', { roleId: 'owner' })).toEqual({
      decision: 'deny',
      failed: ['access.owner-only'],
    })
    expect(
      await decision('access.identity.disable', {
        targetIsOwner: true,
        activeOwners: 2,
        removesOwner: true,
      }),
    ).toEqual({
      decision: 'deny',
      failed: ['access.owner-only'],
    })
    expect(
      await decision('access.identity.disable', {
        targetIsOwner: true,
        actorIsOwner: true,
        activeOwners: 2,
        removesOwner: true,
      }),
    ).toEqual({ decision: 'allow', failed: [] })
    // An owner is still bound by escalation and last-owner rules.
    expect(
      await decision('access.role_binding.create', {
        actorIsOwner: true,
        targetIsSelf: true,
        roleId: 'owner',
      }),
    ).toEqual({
      decision: 'deny',
      failed: ['access.no-self-escalation'],
    })
  })

  it('never removes the last active owner', async () => {
    for (const kind of [
      'access.role_binding.delete',
      'access.identity.disable',
      'access.identity.erase',
    ]) {
      const result = await decision(kind, {
        actorIsOwner: true,
        targetIsOwner: true,
        removesOwner: true,
        activeOwners: 1,
      })
      // Erasure also needs an approval (require), which a deny overrides.
      expect(result).toEqual({
        decision: 'deny',
        failed:
          kind === 'access.identity.erase'
            ? ['access.erase-approval', 'access.last-owner']
            : ['access.last-owner'],
      })
    }
  })

  it('lets non-owners only tighten policy; unknown effects need an owner', async () => {
    expect(await decision('access.policy_settings.update', { lowersSafety: true })).toEqual({
      decision: 'deny',
      failed: ['access.policy-safety'],
    })
    expect(await decision('access.policy_settings.update', { lowersSafety: null })).toEqual({
      decision: 'deny',
      failed: ['access.policy-safety'],
    })
    expect(await decision('access.policy_settings.update', { lowersSafety: false })).toEqual({
      decision: 'allow',
      failed: [],
    })
    expect(
      await decision('access.policy_settings.update', { lowersSafety: true, actorIsOwner: true }),
    ).toEqual({
      decision: 'allow',
      failed: [],
    })
  })

  it('classifies self-approval parameter changes', () => {
    const current = { allowed: true, criticalCoolingSeconds: 600 }
    expect(
      lowersSafety('approval.self-approval', current, {
        allowed: false,
        criticalCoolingSeconds: 600,
      }),
    ).toBe(false)
    expect(
      lowersSafety('approval.self-approval', current, {
        allowed: true,
        criticalCoolingSeconds: 900,
      }),
    ).toBe(false)
    expect(
      lowersSafety('approval.self-approval', current, {
        allowed: true,
        criticalCoolingSeconds: 60,
      }),
    ).toBe(true)
    expect(
      lowersSafety(
        'approval.self-approval',
        { allowed: false, criticalCoolingSeconds: 600 },
        current,
      ),
    ).toBe(true)
    expect(lowersSafety('migration.agent-production', {}, {})).toBeNull()
  })
})

describe('erasure', () => {
  it('needs an approval by default (require), never allowed silently', async () => {
    const engine = new PolicyEngine({
      registry: new RuleRegistry(ACCESS_RULES),
      providers: [
        {
          name: 'access',
          load: async () => ({ status: 'known', value: { ...base, actorIsOwner: true } }),
        },
      ],
      codeVersion: '0.1.0+test',
      clock: fixedClock(0),
    })
    const result = await engine.evaluate({
      request: request('access.identity.erase'),
      settings: [],
    })
    expect(result.decision).toBe('require')
    expect(result.requirements).toEqual([
      { kind: 'approval', count: 1, permission: 'plans.approve' },
    ])
  })
})

describe('OD-9 self-approval', () => {
  it('allows an acknowledged self-approval by default and refuses it when the policy forbids it', async () => {
    expect(await decision('approval.approve', undefined, { selfApproval: true })).toEqual({
      decision: 'allow',
      failed: [],
    })
    expect(await decision('approval.approve', undefined, { selfApproval: false })).toEqual({
      decision: 'allow',
      failed: [],
    })
    const strict = await new PolicyEngine({
      registry: new RuleRegistry(ACCESS_RULES),
      providers: [],
      codeVersion: '0.1.0+test',
      clock: fixedClock(0),
    }).evaluate({
      request: request('approval.approve', { selfApproval: true }),
      settings: [
        {
          scopeKind: 'installation',
          scopeId: 'installation',
          ruleId: 'approval.self-approval',
          revision: 1,
          params: { allowed: false },
        },
      ],
    })
    expect(strict.decision).toBe('deny')
    expect(await decision('approval.approve', undefined, { other: true })).toMatchObject({
      decision: 'deny',
    })
  })
})
