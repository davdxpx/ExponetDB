import type { ConsentView } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  allowBlocker,
  consentWarnings,
  effectLabel,
  expiryDelay,
  initialChoice,
  needsFreshProof,
  reachesProduction,
  scopesByEffect,
  tierChosen,
  toDecision,
  withTier,
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

describe('the consent model: tiers, proofs and expiry', () => {
  it('labels effects from the catalog', () => {
    expect(effectLabel('read')).toBe('Reads')
    expect(effectLabel('control_record')).toBe('Records plans or checks, changes nothing')
    expect(effectLabel('consequential')).toBe('Changes')
  })

  it('treats a scope without a tier as always within the chosen tiers', () => {
    expect(tierChosen({ tier: null }, new Set())).toBe(true)
    expect(tierChosen({ tier: 'prod' }, new Set(['nonprod'] as const))).toBe(false)
    expect(tierChosen({ tier: 'prod' }, new Set(['prod'] as const))).toBe(true)
  })

  it('never sends a scope of a tier that is not chosen', () => {
    const v = view()
    const choice = { ...initialChoice(v), scopes: new Set(['targets.read', 'data.read:prod']) }
    expect(toDecision(v, choice, 'allow').scopes).toEqual(['targets.read'])
    const both = { ...choice, tiers: new Set(['nonprod', 'prod'] as const) }
    expect(toDecision(v, both, 'allow').scopes).toEqual(['targets.read', 'data.read:prod'])
  })

  it('switching a tier off drops its scopes and targets; on again restores only its preselection', () => {
    const v = view()
    const listed = { ...initialChoice(v), where: 'list' as const, targets: new Set([T1]) }
    const off = withTier(v, listed, 'nonprod', false)
    expect([...off.tiers]).toEqual([])
    expect(off.scopes.has('migrations.apply:nonprod')).toBe(false)
    expect([...off.targets]).toEqual([])
    const on = withTier(v, off, 'nonprod', true)
    expect(on.scopes.has('migrations.apply:nonprod')).toBe(true)
    // A production scope is never chosen by switching the tier on.
    const prod = withTier(v, on, 'prod', true)
    expect(prod.scopes.has('data.read:prod')).toBe(false)
    expect([...prod.tiers].sort()).toEqual(['nonprod', 'prod'])
  })

  it('sends the production acknowledgement only when the choice reaches production', () => {
    const v = view()
    const ticked = { ...initialChoice(v), production: true }
    expect(reachesProduction(v, ticked)).toBe(false)
    expect(toDecision(v, ticked, 'allow').acknowledgeProduction).toBeUndefined()
  })

  it('never sends a target of a tier that is not chosen', () => {
    const v = view()
    const choice = { ...initialChoice(v), where: 'list' as const, targets: new Set([T1, T2]) }
    expect(toDecision(v, choice, 'allow').targets).toEqual({ kind: 'list', targetIds: [T1] })
  })

  it('says a fresh proof is needed for production writes and human-only scopes', () => {
    const v = view({
      scopes: [
        ...view().scopes,
        {
          scope: 'schema.read',
          available: true,
          reason: null,
          write: true,
          effect: 'control_record',
          tier: null,
          explicitConsent: false,
          humanOnly: false,
        },
      ],
    } as Partial<ConsentView>)
    expect(needsFreshProof(v, initialChoice(v))).toBe(false)
    const prod = withTier(v, initialChoice(v), 'prod', true)
    // schema.read writes (drift checks record a result) and reaches production with the tier.
    expect(needsFreshProof(v, prod)).toBe(true)
    const nonprodOnly = { ...prod, scopes: new Set(['targets.read', 'migrations.apply:nonprod']) }
    expect(needsFreshProof(v, nonprodOnly)).toBe(false)
    const humanOnly = view({
      scopes: [
        {
          scope: 'migrations.import',
          available: true,
          reason: null,
          write: true,
          effect: 'consequential',
          tier: null,
          explicitConsent: true,
          humanOnly: true,
        },
      ],
    } as Partial<ConsentView>)
    expect(
      needsFreshProof(humanOnly, {
        ...initialChoice(humanOnly),
        scopes: new Set(['migrations.import']),
      }),
    ).toBe(true)
  })

  it('leaves expiry to the server when the time is no date or this clock is past it', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z')
    expect(expiryDelay('2026-10-13T12:05:00.000Z', now)).toBe(300_000)
    expect(expiryDelay('2026-10-13T11:59:00.000Z', now)).toBeUndefined()
    expect(expiryDelay('2026-10-13T12:00:00.000Z', now)).toBeUndefined()
    expect(expiryDelay('not a date', now)).toBeUndefined()
  })
})
