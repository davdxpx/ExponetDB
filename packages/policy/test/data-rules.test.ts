import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  DATA_RULES,
  lowersSafety,
  PolicyEngine,
  type PolicyRequest,
  RuleRegistry,
  type SettingRow,
} from '../src/index.ts'

/** The Wave 7 `data.read` rule (ADR-0028 §3, OD-13 option a). */
const engine = new PolicyEngine({
  registry: new RuleRegistry(DATA_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 13)),
})

const TARGET = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const PERSON: PolicyRequest['principal'] = {
  kind: 'human',
  identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  client: 'web',
}

function setting(params: Record<string, unknown>): SettingRow {
  return {
    scopeKind: 'target',
    scopeId: TARGET,
    ruleId: 'data.read',
    revision: 1,
    params: params as never,
  }
}

async function decide(
  tier: 'prod' | 'nonprod' | undefined,
  principal: PolicyRequest['principal'],
  settings: SettingRow[] = [],
  kind = 'query.run',
) {
  const d = await engine.evaluate({
    request: {
      kind,
      principal,
      subject: { targetId: TARGET, ...(tier === undefined ? {} : { tier }) },
    },
    settings,
  })
  return { decision: d.decision, rule: d.rules.find((r) => r.id === 'data.read') }
}

const agents: PolicyRequest['principal'][] = [
  { ...PERSON, client: 'mcp' },
  { kind: 'service', identityId: PERSON.identityId, client: 'ci' },
  { kind: 'service', identityId: PERSON.identityId, client: 'rest' },
  { kind: 'human', identityId: PERSON.identityId, client: 'rest' },
]

describe('data.read', () => {
  it('by tier: people read every tier, agents only non-production, an unknown tier is production', async () => {
    for (const client of ['web', 'cli'] as const) {
      expect((await decide('prod', { ...PERSON, client })).decision).toBe('allow')
      expect((await decide('nonprod', { ...PERSON, client })).decision).toBe('allow')
    }
    for (const agent of agents) {
      expect((await decide('nonprod', agent)).decision, agent.client).toBe('allow')
      const prod = await decide('prod', agent)
      expect(prod.decision, agent.client).toBe('deny')
      expect(prod.rule?.facts).toMatchObject({ effective: 'humans_only', agent: true })
      expect((await decide(undefined, agent)).decision, agent.client).toBe('deny')
    }
    // EXPLAIN is a data read as well: the same rule.
    expect((await decide('prod', agents[0] ?? PERSON, [], 'query.explain')).decision).toBe('deny')
  })

  it('a target setting opens, closes or disables reads, and a scope never lifts humans_only', async () => {
    const mcp = agents[0] ?? PERSON
    expect((await decide('prod', mcp, [setting({ mode: 'enabled' })])).decision).toBe('allow')
    expect((await decide('nonprod', mcp, [setting({ mode: 'humans_only' })])).decision).toBe('deny')
    expect((await decide('nonprod', PERSON, [setting({ mode: 'humans_only' })])).decision).toBe(
      'allow',
    )
    const off = await decide('nonprod', PERSON, [setting({ mode: 'disabled' })])
    expect(off.decision).toBe('deny')
    expect(off.rule?.message).toBe('Row reads are disabled for this target.')
  })

  it('reports the sensitive columns it decided with, and fails closed on an invalid setting', async () => {
    const masked = await decide('nonprod', PERSON, [
      setting({ sensitiveColumns: ['public.accounts.email', '*.*.password'] }),
    ])
    expect(masked.decision).toBe('allow')
    expect(masked.rule?.facts['sensitiveColumns']).toEqual([
      'public.accounts.email',
      '*.*.password',
    ])
    for (const params of [
      { mode: 'sometimes' },
      { sensitiveColumns: ['no dots'] },
      { sensitiveColumns: ['a.b.c; drop'] },
    ]) {
      const bad = await decide('nonprod', PERSON, [setting(params)])
      expect(bad.decision, JSON.stringify(params)).toBe('deny')
      expect(bad.rule?.result).toBe('unknown')
    }
  })
})

describe('data.read settings', () => {
  it('refuses parameters it does not understand when a setting is planned', () => {
    const check = (params: Record<string, unknown>) =>
      DATA_RULES[0]?.checkParams?.(params as never) ?? false
    expect(check({ mode: 'humans_only', sensitiveColumns: ['public.users.email'] })).toBe(true)
    expect(check({ mode: 'everyone', sensitiveColumns: [] })).toBe(false)
    expect(check({ mode: 'enabled', sensitiveColumns: ['email'] })).toBe(false)
  })

  it('knows which changes loosen it: a looser mode, a column no longer masked', () => {
    const both = (mode: string, columns: string[] = []) => ({ mode, sensitiveColumns: columns })
    expect(lowersSafety('data.read', both('humans_only'), both('by_tier'))).toBe(true)
    expect(lowersSafety('data.read', both('by_tier'), both('enabled'))).toBe(true)
    expect(lowersSafety('data.read', both('disabled'), both('humans_only'))).toBe(true)
    expect(lowersSafety('data.read', both('by_tier'), both('humans_only'))).toBe(false)
    expect(lowersSafety('data.read', both('enabled', ['a.b.c']), both('enabled'))).toBe(true)
    expect(lowersSafety('data.read', both('enabled'), both('enabled', ['a.b.c']))).toBe(false)
    expect(lowersSafety('data.read', both('enabled'), { ...both('enabled'), other: 1 })).toBe(null)
  })
})
