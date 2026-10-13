import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { PolicyEngine, type PolicyRequest, REGISTRY_RULES, RuleRegistry } from '../src/index.ts'

/** `target.register-prod-approval`: production and unknown tiers require approval and re-authentication. */
const engine = new PolicyEngine({
  registry: new RuleRegistry(REGISTRY_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 6)),
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
              ruleId: 'target.register-prod-approval',
              revision: 1,
              params,
            },
          ],
  })

describe('target.register-prod-approval', () => {
  it('allows a nonprod registration without approval', async () => {
    const d = await decide('target.register', 'nonprod')
    expect(d.decision).toBe('allow')
    expect(d.requirements).toEqual([])
  })

  it('requires one approval and a 300-second re-authentication for production', async () => {
    const d = await decide('target.register', 'prod')
    expect(d.decision).toBe('require')
    expect(d.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'approval', count: 1, permission: 'plans.approve' },
        { kind: 'reauth', withinSeconds: 300 },
      ]),
    )
  })

  it('treats an unknown tier like production (fail closed)', async () => {
    const d = await decide('target.register')
    expect(d.decision).toBe('require')
    expect(d.requirements.some((r) => r.kind === 'approval')).toBe(true)
  })

  it('takes a stricter configured approval count', async () => {
    const d = await decide('target.register', 'prod', { approvals: 2, reauthWithinSeconds: 120 })
    expect(d.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'approval', count: 2, permission: 'plans.approve' },
        { kind: 'reauth', withinSeconds: 120 },
      ]),
    )
  })

  it('does not apply to other registry kinds', async () => {
    for (const kind of ['target.suspend', 'registry.cluster.confirm', 'registry.product.create']) {
      expect((await decide(kind, 'prod')).decision, kind).toBe('allow')
    }
  })
})

/** `drift.accept-prod` (Wave 8): accepting drift on production needs an approval and re-authentication. */
describe('drift.accept-prod', () => {
  it('allows accepting drift on a nonprod target without approval', async () => {
    const d = await decide('drift.accept', 'nonprod')
    expect(d.decision).toBe('allow')
    expect(d.requirements).toEqual([])
    expect(d.rules.map((r) => [r.id, r.result])).toEqual([['drift.accept-prod', 'not_applicable']])
  })

  it('requires one approval and a 300-second re-authentication for production', async () => {
    const d = await decide('drift.accept', 'prod')
    expect(d.decision).toBe('require')
    expect(d.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'approval', count: 1, permission: 'plans.approve' },
        { kind: 'reauth', withinSeconds: 300 },
      ]),
    )
    expect(d.rules.map((r) => [r.id, r.result])).toEqual([['drift.accept-prod', 'fail']])
  })

  it('treats an unknown tier like production (fail closed)', async () => {
    const d = await decide('drift.accept')
    expect(d.decision).toBe('require')
    expect(d.requirements.some((r) => r.kind === 'approval')).toBe(true)
  })

  it('applies to drift.accept only, and the registration rule not to it', async () => {
    const d = await decide('drift.accept', 'prod')
    expect(d.rules.some((r) => r.id === 'target.register-prod-approval')).toBe(false)
    const register = await decide('target.register', 'prod')
    expect(register.rules.some((r) => r.id === 'drift.accept-prod')).toBe(false)
    expect((await decide('drift.check', 'prod')).decision).toBe('allow')
  })
})
