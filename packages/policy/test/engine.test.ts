import { fixedClock, isJsonObject, type JsonObject } from '@exponetdb/kernel'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type Fact,
  type FactProvider,
  type PolicyDecision,
  PolicyEngine,
  type PolicyRequest,
  principalFacts,
  type Requirement,
  type Rule,
  type RuleEvaluation,
  RuleRegistry,
  RuleRegistryError,
  recheckDecision,
  resolveParams,
  type SettingRow,
  type Severity,
} from '../src/index.ts'

const approval: Requirement = { kind: 'approval', count: 1, permission: 'plans.approve' }
const reauth: Requirement = { kind: 'reauth', withinSeconds: 300 }

function rule(
  id: string,
  severity: Severity,
  outcome: RuleEvaluation['result'] | (() => RuleEvaluation['result']),
  options: Partial<
    Pick<Rule, 'overridableByBreakGlass' | 'facts' | 'defaults' | 'appliesTo' | 'version'>
  > & {
    requirements?: readonly Requirement[]
  } = {},
): Rule {
  return {
    id,
    version: options.version ?? 1,
    description: `test rule ${id}`,
    appliesTo: options.appliesTo ?? ['test.*'],
    severity,
    overridableByBreakGlass: options.overridableByBreakGlass ?? false,
    facts: options.facts ?? [],
    defaults: options.defaults ?? {},
    requirements: () => (severity === 'require' ? (options.requirements ?? [approval]) : []),
    evaluate: () => ({
      result: typeof outcome === 'function' ? outcome() : outcome,
      message: `${id} evaluated`,
    }),
  }
}

const human: PolicyRequest = {
  kind: 'test.apply',
  principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client: 'web' },
  subject: { tier: 'prod' },
}
const agent: PolicyRequest = {
  ...human,
  principal: { kind: 'service', identityId: null, client: 'mcp' },
}

function engine(rules: readonly Rule[], providers: readonly FactProvider[] = []): PolicyEngine {
  return new PolicyEngine({
    registry: new RuleRegistry(rules),
    providers,
    codeVersion: '0.1.0+abcdef1',
    clock: fixedClock(Date.parse('2026-10-05T12:00:00Z')),
  })
}

const decide = (
  rules: readonly Rule[],
  request = human,
  settings: readonly SettingRow[] = [],
  providers: readonly FactProvider[] = [],
) => engine(rules, providers).evaluate({ request, settings })

describe('combination', () => {
  it('allows when every rule passes or does not apply', async () => {
    const d = await decide([
      rule('test.a', 'deny', 'pass'),
      rule('test.b', 'require', 'not_applicable'),
    ])
    expect(d).toMatchObject({ decision: 'allow', requirements: [], overriddenRules: [] })
    expect(d.policyVersion).toMatch(/^sha256:pv1:[0-9a-f]{64}$/)
    expect(d.evaluatedAt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('deny beats require beats allow', async () => {
    expect(
      (await decide([rule('test.a', 'require', 'fail'), rule('test.b', 'deny', 'fail')])).decision,
    ).toBe('deny')
    const req = await decide([rule('test.a', 'require', 'fail'), rule('test.b', 'deny', 'pass')])
    expect(req).toMatchObject({ decision: 'require', requirements: [approval] })
  })

  it('unions requirements without duplicates in a canonical order', async () => {
    const d = await decide([
      rule('test.a', 'require', 'fail', { requirements: [reauth, approval] }),
      rule('test.b', 'require', 'fail', { requirements: [approval] }),
    ])
    expect(d.requirements).toEqual([approval, reauth])
  })

  it('warnings never block, even when unknown', async () => {
    const d = await decide([rule('test.a', 'warn', 'fail'), rule('test.b', 'warn', 'unknown')])
    expect(d.decision).toBe('allow')
    expect(d.rules.map((r) => r.result)).toEqual(['fail', 'unknown'])
  })

  it('unknown fails closed at the rule severity', async () => {
    expect((await decide([rule('test.a', 'deny', 'unknown')])).decision).toBe('deny')
    expect(await decide([rule('test.a', 'require', 'unknown')])).toMatchObject({
      decision: 'require',
      requirements: [approval],
    })
  })

  it('reports every evaluated rule in rule id order, whatever the registration order', async () => {
    const d = await decide([
      rule('test.c', 'deny', 'pass'),
      rule('test.a', 'warn', 'pass'),
      rule('test.b', 'require', 'pass'),
    ])
    expect(d.rules.map((r) => r.id)).toEqual(['test.a', 'test.b', 'test.c'])
  })

  it('evaluates only the rules that apply to the kind', async () => {
    const d = await decide([
      rule('test.a', 'deny', 'fail', { appliesTo: ['other.apply'] }),
      rule('test.b', 'deny', 'pass', { appliesTo: ['test.apply'] }),
    ])
    expect(d.rules.map((r) => r.id)).toEqual(['test.b'])
    expect(d.decision).toBe('allow')
  })
})

describe('fail closed', () => {
  it('a missing, failing or invalid fact provider makes the rule unknown', async () => {
    const needs = (id: string) => rule(id, 'deny', 'pass', { facts: ['backups'] })
    const throwing: FactProvider = {
      name: 'backups',
      load: () => Promise.reject(new Error('down')),
    }
    const unknown: FactProvider = {
      name: 'backups',
      load: async (): Promise<Fact> => ({ status: 'unknown', reason: 'no data' }),
    }
    for (const providers of [[], [throwing], [unknown]]) {
      const d = await decide([needs('test.a')], human, [], providers)
      expect(d.decision).toBe('deny')
      expect(d.rules[0]).toMatchObject({ result: 'unknown', facts: { unknownFacts: ['backups'] } })
    }
  })

  it('a rule that throws or returns a malformed result is unknown', async () => {
    const throwing: Rule = {
      ...rule('test.a', 'deny', 'pass'),
      evaluate: () => {
        throw new Error('bug')
      },
    }
    const malformed: Rule = {
      ...rule('test.b', 'deny', 'pass'),
      evaluate: () => ({ result: 'pass', message: 'x'.repeat(2000) }),
    }
    const d = await decide([throwing, malformed])
    expect(d.decision).toBe('deny')
    expect(d.rules.map((r) => r.result)).toEqual(['unknown', 'unknown'])
  })

  it('a require rule whose requirements cannot be computed denies', async () => {
    const broken: Rule = {
      ...rule('test.a', 'require', 'fail'),
      requirements: (params) => {
        if (params['explode'] === true) {
          throw new Error('bug')
        }
        return [approval]
      },
      defaults: { explode: false },
    }
    const settings: SettingRow[] = [
      {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'test.a',
        revision: 1,
        params: { explode: true },
      },
    ]
    expect((await decide([broken], human, settings)).decision).toBe('deny')
  })

  it('invalid configuration makes the rule unknown', async () => {
    const r = rule('test.a', 'deny', 'pass', { defaults: { hours: 24 } })
    for (const params of [{ minutes: 5 }, { hours: '24' }]) {
      const settings: SettingRow[] = [
        {
          scopeKind: 'installation',
          scopeId: 'installation',
          ruleId: 'test.a',
          revision: 1,
          params,
        },
      ]
      const d = await decide([r], human, settings)
      expect(d.decision).toBe('deny')
      expect(d.rules[0]?.result).toBe('unknown')
    }
  })
})

describe('break-glass', () => {
  const overridable = rule('test.evidence', 'deny', 'fail', { overridableByBreakGlass: true })
  const fixed = rule('test.checksum', 'deny', 'fail')
  const grant = { grantId: 'bgl_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', rules: ['test.evidence'] }

  it('overrides exactly the named overridable rules and is never silent', async () => {
    const d = await decide([overridable], { ...human, breakGlass: grant })
    expect(d).toMatchObject({
      decision: 'require',
      overriddenRules: ['test.evidence'],
      requirements: [{ kind: 'break_glass', rules: ['test.evidence'] }],
    })
  })

  it('cannot override a rule that is not overridable, nor one it does not name', async () => {
    expect(
      (await decide([fixed], { ...human, breakGlass: { ...grant, rules: ['test.checksum'] } }))
        .decision,
    ).toBe('deny')
    const other = rule('test.other', 'deny', 'fail', { overridableByBreakGlass: true })
    const d = await decide([overridable, other], { ...human, breakGlass: grant })
    expect(d.decision).toBe('deny')
    expect(d.overriddenRules).toEqual(['test.evidence'])
  })

  it('is ignored for an AI agent client and for non-human actors', async () => {
    for (const request of [
      { ...agent, breakGlass: grant },
      { ...human, principal: { ...human.principal, client: 'mcp' as const }, breakGlass: grant },
      { ...human, principal: { ...human.principal, kind: 'service' as const }, breakGlass: grant },
    ]) {
      const d = await decide([overridable], request)
      expect(d).toMatchObject({ decision: 'deny', overriddenRules: [] })
    }
  })
})

describe('principal facts', () => {
  it('mark MCP clients as agents', async () => {
    const r: Rule = {
      ...rule('test.agent', 'require', 'pass'),
      facts: ['principal'],
      evaluate: ({ facts }) => {
        const p = facts.principal
        const isAgent = isJsonObject(p) && p['agent'] === true
        return {
          result: isAgent ? 'fail' : 'pass',
          message: 'agent check',
          facts: { agent: isAgent },
        }
      },
    }
    expect((await decide([r], agent, [], [principalFacts])).decision).toBe('require')
    expect((await decide([r], human, [], [principalFacts])).decision).toBe('allow')
  })

  it('mark every caller but a person in the Web App or the CLI as an agent (OD-13 (a))', async () => {
    const facts = async (principal: PolicyRequest['principal']) =>
      principalFacts.load({ ...human, principal })
    const id = 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
    const cases: [PolicyRequest['principal'], boolean][] = [
      [{ kind: 'human', identityId: id, client: 'web' }, false],
      [{ kind: 'human', identityId: id, client: 'cli' }, false],
      [{ kind: 'human', identityId: id, client: 'mcp' }, true],
      [{ kind: 'human', identityId: id, client: 'rest' }, true],
      [{ kind: 'service', identityId: id, client: 'ci' }, true],
      [{ kind: 'service', identityId: id, client: 'rest' }, true],
    ]
    for (const [principal, isAgent] of cases) {
      const fact = await facts(principal)
      expect(fact, `${principal.kind}/${principal.client}`).toMatchObject({
        status: 'known',
        value: { agent: isAgent },
      })
    }
  })
})

describe('policy version', () => {
  it('changes with configuration and rule versions, not with registration order', async () => {
    const a = rule('test.a', 'deny', 'pass', { defaults: { hours: 24 } })
    const b = rule('test.b', 'warn', 'pass')
    const base = (await decide([a, b])).policyVersion
    expect((await decide([b, a])).policyVersion).toBe(base)
    const settings: SettingRow[] = [
      {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'test.a',
        revision: 1,
        params: { hours: 48 },
      },
    ]
    expect((await decide([a, b], human, settings)).policyVersion).not.toBe(base)
    expect((await decide([{ ...a, version: 2 }, b])).policyVersion).not.toBe(base)
  })
})

describe('configuration resolution', () => {
  const r = rule('test.a', 'deny', 'pass', { defaults: { hours: 24, agents: true } })
  const row = (
    scopeKind: SettingRow['scopeKind'],
    scopeId: string,
    revision: number,
    params: JsonObject,
  ): SettingRow => ({
    scopeKind,
    scopeId,
    ruleId: 'test.a',
    revision,
    params,
  })
  it('the most specific level wins per parameter, the latest revision per level', () => {
    const rows = [
      row('installation', 'installation', 1, { hours: 12 }),
      row('installation', 'installation', 2, { hours: 6 }),
      row('project', 'prj_1', 1, { agents: false }),
      row('target', 'tgt_1', 1, { hours: 1 }),
      row('target', 'tgt_other', 1, { hours: 99 }),
    ]
    expect(resolveParams(r, rows, { projectId: 'prj_1', targetId: 'tgt_1' })).toEqual({
      ok: true,
      value: { hours: 1, agents: false },
    })
    expect(resolveParams(r, rows, { projectId: 'prj_1' })).toEqual({
      ok: true,
      value: { hours: 6, agents: false },
    })
    expect(resolveParams(r, rows, {})).toEqual({ ok: true, value: { hours: 6, agents: true } })
  })
})

describe('registry', () => {
  it('refuses invalid definitions at startup', () => {
    const cases: [Rule, string][] = [
      [rule('Bad.id', 'deny', 'pass'), 'invalid_rule_id'],
      [rule('test.a', 'deny', 'pass', { version: 0 }), 'invalid_version'],
      [rule('test.a', 'deny', 'pass', { appliesTo: [] }), 'invalid_applies_to'],
      [rule('test.a', 'deny', 'pass', { appliesTo: ['*'] }), 'invalid_applies_to'],
      [rule('test.a', 'require', 'pass', { requirements: [] }), 'require_without_requirements'],
      [
        { ...rule('test.a', 'deny', 'pass'), requirements: () => [approval] },
        'requirements_without_require',
      ],
    ]
    for (const [r, code] of cases) {
      expect(() => new RuleRegistry([r]), code).toThrow(RuleRegistryError)
      try {
        new RuleRegistry([r])
      } catch (error) {
        expect(error).toMatchObject({ code })
      }
    }
    expect(
      () => new RuleRegistry([rule('test.a', 'deny', 'pass'), rule('test.a', 'warn', 'pass')]),
    ).toThrow(RuleRegistryError)
  })

  it('refuses an engine without a valid build version', () => {
    expect(
      () =>
        new PolicyEngine({
          registry: new RuleRegistry(),
          providers: [],
          codeVersion: 'not valid',
          clock: fixedClock(0),
        }),
    ).toThrow()
  })
})

const outcomes = ['pass', 'fail', 'not_applicable', 'unknown'] as const
const severities = ['deny', 'require', 'warn'] as const
const arbitraryRules = fc
  .uniqueArray(
    fc.record({
      n: fc.integer({ min: 0, max: 30 }),
      severity: fc.constantFrom(...severities),
      outcome: fc.constantFrom(...outcomes),
      overridable: fc.boolean(),
    }),
    { selector: (r) => r.n, maxLength: 8 },
  )
  .map((list) =>
    list.map((r) =>
      rule(`test.r${r.n}`, r.severity, r.outcome, { overridableByBreakGlass: r.overridable }),
    ),
  )
const rank = (d: PolicyDecision) => ({ allow: 0, require: 1, deny: 2 })[d.decision]

describe('properties', () => {
  it('the decision does not depend on rule order', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRules, async (rules) => {
        const a = await decide(rules)
        const b = await decide([...rules].reverse())
        expect(b.decision).toBe(a.decision)
        expect(b.requirements).toEqual(a.requirements)
        expect(b.policyVersion).toBe(a.policyVersion)
      }),
    )
  })

  it('adding a rule never makes the decision more permissive', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryRules,
        fc.constantFrom(...severities),
        fc.constantFrom(...outcomes),
        async (rules, severity, outcome) => {
          const before = await decide(rules)
          const after = await decide([...rules, rule('test.extra', severity, outcome)])
          expect(rank(after)).toBeGreaterThanOrEqual(rank(before))
        },
      ),
    )
  })

  it('unknown is never more permissive than fail; warn never changes the decision', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRules, fc.constantFrom(...severities), async (rules, severity) => {
        const failing = await decide([...rules, rule('test.extra', severity, 'fail')])
        const unknown = await decide([...rules, rule('test.extra', severity, 'unknown')])
        expect(rank(unknown)).toBe(rank(failing))
        const base = await decide(rules)
        const warned = await decide([...rules, rule('test.extra', 'warn', 'fail')])
        expect(warned.decision).toBe(base.decision)
      }),
    )
  })

  it('break-glass for one rule never changes another rule’s effect', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRules, async (rules) => {
        const target = rule('test.zz', 'deny', 'fail', { overridableByBreakGlass: true })
        const without = await decide([...rules])
        const withGrant = await decide([...rules, target], {
          ...human,
          breakGlass: { grantId: 'bgl_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', rules: ['test.zz'] },
        })
        // Overriding test.zz leaves exactly the other rules' effect, plus the break-glass requirement.
        expect(rank(withGrant)).toBe(Math.max(rank(without), 1))
        expect(withGrant.overriddenRules).toContain('test.zz')
      }),
    )
  })

  it('a re-check is stale exactly when the current decision is stricter or adds requirements', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRules, arbitraryRules, async (a, b) => {
        const planned = await decide(a)
        const current = await decide(b)
        const recheck = recheckDecision(planned, current)
        const added = current.requirements.some(
          (r) => !planned.requirements.some((p) => JSON.stringify(p) === JSON.stringify(r)),
        )
        const stricter = rank(current) > rank(planned)
        expect(recheck.status === 'stale').toBe(stricter || added)
        if (recheck.status === 'proceed') {
          expect(recheck.requirements).toEqual(planned.requirements)
        }
      }),
    )
  })
})
