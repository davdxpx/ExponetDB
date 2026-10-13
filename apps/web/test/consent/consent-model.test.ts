import type { ConsentView } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  allowBlocker,
  consentWarnings,
  initialChoice,
  reachesProduction,
  scopesByEffect,
  toDecision,
} from '../../src/features/consent/consent-model.ts'

const T1 = 'tgt_01M4S9000000000000000000AB'
const T2 = 'tgt_01M4S9000000000000000000AC'

function view(overrides: Partial<ConsentView> = {}): ConsentView {
  return {
    kind: 'authorization_code',
    client: {
      clientId: 'https://agent.example.test/client.json',
      name: 'Agent',
      kind: 'mcp',
      firstParty: false,
      redirectHost: 'agent.example.test',
      loopbackRedirect: false,
      lookalike: false,
    },
    resource: 'mcp',
    resourceUri: 'https://db.example.test/mcp',
    scopes: [
      {
        scope: 'targets.read',
        available: true,
        reason: null,
        write: false,
        effect: 'read',
        tier: null,
        explicitConsent: false,
        humanOnly: false,
      },
      {
        scope: 'data.read:prod',
        available: true,
        reason: null,
        write: false,
        effect: 'read',
        tier: 'prod',
        explicitConsent: true,
        humanOnly: false,
      },
      {
        scope: 'migrations.plan',
        available: true,
        reason: null,
        write: false,
        effect: 'control_record',
        tier: null,
        explicitConsent: false,
        humanOnly: false,
      },
      {
        scope: 'migrations.apply:nonprod',
        available: true,
        reason: null,
        write: true,
        effect: 'consequential',
        tier: 'nonprod',
        explicitConsent: false,
        humanOnly: false,
      },
      {
        scope: 'registry.manage',
        available: false,
        reason: 'not_held',
        write: true,
        effect: 'consequential',
        tier: null,
        explicitConsent: true,
        humanOnly: false,
      },
    ],
    defaults: { tiers: ['nonprod'], targets: { kind: 'all' } },
    targets: [
      { id: T1, path: 'shop/app/staging', tier: 'nonprod' },
      { id: T2, path: 'shop/app/production', tier: 'prod' },
    ],
    lifetimeDays: { default: 30, max: 90 },
    reauth: { fresh: false, withinSeconds: 300 },
    expiresAt: '2026-10-13T12:10:00.000Z',
    ...overrides,
  } as unknown as ConsentView
}

describe('the consent model', () => {
  it('preselects available scopes without explicit consent and the default tiers', () => {
    const choice = initialChoice(view())
    expect([...choice.scopes]).toEqual([
      'targets.read',
      'migrations.plan',
      'migrations.apply:nonprod',
    ])
    expect([...choice.tiers]).toEqual(['nonprod'])
    expect(choice.production).toBe(false)
    expect(choice.lifetimeDays).toBe(30)
  })

  it('warns about lookalikes, unverified names and the lethal trifecta', () => {
    expect(consentWarnings(view())).toEqual({
      lookalike: false,
      nameUnverified: true,
      trifecta: true,
    })
    const firstParty = view({ client: { ...view().client, firstParty: true, lookalike: false } })
    expect(consentWarnings(firstParty).nameUnverified).toBe(false)
    const rest = view({ resource: 'api' })
    expect(consentWarnings(rest).trifecta).toBe(false)
  })

  it('groups offers by effect: reads, records, changes', () => {
    expect(scopesByEffect(view()).map((g) => [g.effect, g.offers.map((o) => o.scope)])).toEqual([
      ['read', ['targets.read', 'data.read:prod']],
      ['control_record', ['migrations.plan']],
      ['consequential', ['migrations.apply:nonprod', 'registry.manage']],
    ])
  })

  it('never sends a scope that was not offered or not available', () => {
    const choice = {
      ...initialChoice(view()),
      scopes: new Set(['targets.read', 'registry.manage', 'nodes.operate:prod']),
    }
    expect(toDecision(view(), choice, 'allow').scopes).toEqual(['targets.read'])
  })

  it('keeps the lifetime within bounds and the targets to the listed ones', () => {
    const v = view()
    const choice = {
      ...initialChoice(v),
      lifetimeDays: 900,
      where: 'list' as const,
      targets: new Set([T1, 'tgt_forged']),
    }
    expect(toDecision(v, choice, 'allow')).toMatchObject({
      lifetimeDays: 30,
      targets: { kind: 'list', targetIds: [T1] },
    })
    expect(toDecision(v, { ...choice, lifetimeDays: 7 }, 'allow').lifetimeDays).toBe(7)
  })

  it('needs the production acknowledgement when the choice reaches production', () => {
    const v = view()
    const prodScope = { ...initialChoice(v), scopes: new Set(['data.read:prod']) }
    expect(reachesProduction(v, prodScope)).toBe(true)
    expect(allowBlocker(v, prodScope)).toBe('Confirm that you allow access to production.')
    const prodTier = { ...initialChoice(v), tiers: new Set(['prod'] as const) }
    expect(reachesProduction(v, prodTier)).toBe(true)
    const acknowledged = { ...prodTier, production: true }
    expect(allowBlocker(v, acknowledged)).toBeUndefined()
    expect(toDecision(v, acknowledged, 'allow').acknowledgeProduction).toBe(true)
    expect(toDecision(v, initialChoice(v), 'allow').acknowledgeProduction).toBeUndefined()
  })

  it('sends a denial without scopes, tiers, targets or acknowledgements', () => {
    const v = view()
    const choice = {
      ...initialChoice(v),
      production: true,
      where: 'list' as const,
      targets: new Set([T1]),
    }
    expect(toDecision(v, choice, 'deny')).toEqual({
      decision: 'deny',
      scopes: [],
      tiers: [],
      lifetimeDays: 30,
    })
  })

  it('explains why Authorize is not possible yet', () => {
    const v = view()
    expect(allowBlocker(v, { ...initialChoice(v), scopes: new Set() })).toBe(
      'Choose at least one permission.',
    )
    expect(allowBlocker(v, { ...initialChoice(v), tiers: new Set() })).toBe(
      'Choose where the application may act.',
    )
    expect(allowBlocker(v, { ...initialChoice(v), where: 'list' })).toBe(
      'Choose at least one target, or allow every target of the chosen kinds.',
    )
    expect(allowBlocker(v, initialChoice(v))).toBeUndefined()
  })
})
