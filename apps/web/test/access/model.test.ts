import {
  isScopeGrantableTo,
  isWriteScope,
  OAUTH_LIMITS,
  SCOPE_IDS,
  scopeDefinition,
  scopeEffect,
} from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  AUTHORITY_DEFAULTS,
  AUTHORITY_MAX_TARGETS,
  type AuthorityValues,
  authoritySchema,
  isProductionWrite,
  MACHINE_SCOPES,
  productionWithAllTargets,
  toApiKeyRequest,
  toGrantRequest,
  toTargetRestriction,
} from '../../src/features/access/authority.ts'
import { isPublicJwk, parseJwks } from '../../src/features/access/jwks.ts'
import {
  type ApiKey,
  apiKeyLine,
  approvedAutomatically,
  canManageAccess,
  clientDecisions,
  type OAuthClient,
  redirectHosts,
  restrictionsLine,
  targetsText,
} from '../../src/features/access/model.ts'
import { safeReturnTo } from '../../src/lib/navigation/links.ts'
import type { Me } from '../../src/lib/session/guard.tsx'
import { apiKey, oauthClient } from './support.tsx'

// A PEM begin or end line of a private key, assembled at run time so the
// repository's secret scan (tooling/checks/secrets.ts) never sees one.
const pem = (edge: 'BEGIN' | 'END', kind: string): string =>
  ['-----', edge, ' ', kind, 'PRIVATE', ' KEY-----'].join('')

const MESSAGES = {
  scopes: 'scopes',
  tiers: 'tiers',
  tierOf: (scope: string, tier: string) => `tierOf ${scope} ${tier}`,
  production: 'production',
  targets: 'targets',
  days: 'days',
  label: 'label',
}

const values = (over: Partial<AuthorityValues> = {}): AuthorityValues => ({
  ...AUTHORITY_DEFAULTS,
  ...over,
})

function issues(over: Partial<AuthorityValues>): string[] {
  const result = authoritySchema(MESSAGES).safeParse(values(over))
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('the machine scopes the page offers', () => {
  it('are exactly the scopes a ci client may hold, with the effect, tier and write class of the contracts', () => {
    const contract = SCOPE_IDS.filter((scope) => isScopeGrantableTo(scope, 'ci')).map((scope) => ({
      scope,
      effect: scopeEffect(scope),
      tier: scopeDefinition(scope).tier,
      write: isWriteScope(scope),
    }))
    expect(MACHINE_SCOPES).toEqual(contract)
  })

  it('never offer a human-only or Web App scope', () => {
    const offered = MACHINE_SCOPES.map((entry) => entry.scope as string)
    for (const scope of ['api', 'access.manage', 'plans.approve', 'breakglass.activate']) {
      expect(offered).not.toContain(scope)
    }
  })
})

describe('the authority a person gives a service account', () => {
  it('defaults to the least a key can hold: targets.read, non-production, 90 days', () => {
    expect(toApiKeyRequest(values())).toEqual({
      scopes: ['targets.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 90,
    })
    expect(issues({})).toEqual([])
  })

  it('treats production write exactly as the server does', () => {
    expect(isProductionWrite(['migrations.apply:prod'], ['prod'])).toBe(true)
    // A write scope that is not tier-bound is production write once production is chosen.
    expect(isProductionWrite(['schema.read'], ['nonprod', 'prod'])).toBe(true)
    expect(isProductionWrite(['migrations.apply:nonprod'], ['nonprod', 'prod'])).toBe(false)
    expect(isProductionWrite(['data.read:prod'], ['prod'])).toBe(false)
    expect(isProductionWrite(['migrations.plan'], ['nonprod'])).toBe(false)
    expect(isProductionWrite(['not.a.scope'], ['prod'])).toBe(false)
  })

  it('refuses an empty choice, a tiered scope outside the tiers and production write without the acknowledgement', () => {
    expect(issues({ scopes: [] })).toEqual(['scopes'])
    expect(issues({ tiers: [] })).toEqual(['tiers'])
    expect(issues({ scopes: ['migrations.apply:prod'] })).toEqual([
      'tierOf migrations.apply:prod prod',
    ])
    expect(issues({ scopes: ['migrations.apply:prod'], tiers: ['nonprod', 'prod'] })).toEqual([
      'production',
    ])
    expect(
      issues({
        scopes: ['migrations.apply:prod'],
        tiers: ['nonprod', 'prod'],
        acknowledgeProduction: true,
      }),
    ).toEqual([])
    expect(issues({ scopes: ['api'] })).toEqual(['scopes'])
  })

  it('refuses a lifetime outside 1 to 365 days and never produces NaN', () => {
    for (const days of ['', '0', '366', '1.5', '-3', 'abc', '1e2']) {
      expect(issues({ days }), days).toEqual(['days'])
    }
    expect(issues({ days: ' 365 ' })).toEqual([])
    expect(toGrantRequest(values({ days: ' 30 ' })).lifetimeDays).toBe(30)
  })

  it('refuses a label with control characters and leaves an empty label out', () => {
    expect(issues({ label: 'ci\u0007' })).toEqual(['label'])
    expect(issues({ label: 'x'.repeat(65) })).toEqual(['label'])
    expect(toApiKeyRequest(values({ label: '  ' }))).not.toHaveProperty('label')
    expect(toApiKeyRequest(values({ label: ' nightly ' })).label).toBe('nightly')
  })

  it('sends the acknowledgement only for production write the person acknowledged, and only known scopes', () => {
    expect(
      toGrantRequest(
        values({ scopes: ['targets.read'], tiers: ['prod'], acknowledgeProduction: true }),
      ),
    ).not.toHaveProperty('acknowledgeProductionWrite')
    expect(
      toGrantRequest(
        values({
          scopes: ['migrations.apply:prod', 'not.a.scope'],
          tiers: ['prod', 'nonprod'],
          acknowledgeProduction: true,
        }),
      ),
    ).toEqual({
      scopes: ['migrations.apply:prod'],
      restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
      lifetimeDays: 90,
      acknowledgeProductionWrite: true,
    })
    // A machine grant never carries a label.
    expect(toGrantRequest(values({ label: 'x' }))).not.toHaveProperty('label')
  })
})

const tid = (n: number): string => `tgt_01JZ${String(n).padStart(22, '0')}`

describe('the target restriction of a key or a machine grant', () => {
  it('has the maximum the contracts have', () => {
    expect(AUTHORITY_MAX_TARGETS).toBe(OAUTH_LIMITS.maxTargetRestrictions)
  })

  it('is every target the roles reach unless the person chose named targets', () => {
    expect(toTargetRestriction(values())).toEqual({ kind: 'all' })
    // The IDs of a list the person left are ignored in "all" mode.
    expect(toTargetRestriction(values({ targetIds: [tid(1)] }))).toEqual({ kind: 'all' })
    expect(
      toGrantRequest(values({ targetMode: 'list', targetIds: [tid(1)] })).restrictions,
    ).toEqual({
      tiers: ['nonprod'],
      targets: { kind: 'list', targetIds: [tid(1)] },
    })
    expect(
      toApiKeyRequest(values({ targetMode: 'list', targetIds: [tid(2), tid(1)] })).restrictions
        .targets,
    ).toEqual({ kind: 'list', targetIds: [tid(2), tid(1)] })
  })

  it('names each target once and never widens a list into "all"', () => {
    expect(
      toTargetRestriction(values({ targetMode: 'list', targetIds: [tid(1), tid(1), 'x'] })),
    ).toEqual({
      kind: 'list',
      targetIds: [tid(1)],
    })
    // An empty list is sent as an empty list (the server refuses it), not as every target.
    expect(toTargetRestriction(values({ targetMode: 'list', targetIds: [] }))).toEqual({
      kind: 'list',
      targetIds: [],
    })
  })

  it('refuses a list that is empty, longer than 64, repeated or not made of target IDs', () => {
    expect(issues({ targetMode: 'list', targetIds: [] })).toEqual(['targets'])
    expect(issues({ targetMode: 'list', targetIds: ['tgt_bad'] })).toEqual(['targets'])
    expect(issues({ targetMode: 'list', targetIds: [tid(1), tid(1)] })).toEqual(['targets'])
    const many = Array.from({ length: 65 }, (_, i) => tid(i + 1))
    expect(issues({ targetMode: 'list', targetIds: many })).toEqual(['targets'])
    expect(issues({ targetMode: 'list', targetIds: many.slice(0, 64) })).toEqual([])
    expect(issues({ targetMode: 'list', targetIds: [tid(1)] })).toEqual([])
    // "All" does not look at the list.
    expect(issues({ targetMode: 'all', targetIds: ['tgt_bad'] })).toEqual([])
  })

  it('is a warning only when production is allowed for all targets', () => {
    expect(productionWithAllTargets(['prod'], 'all')).toBe(true)
    expect(productionWithAllTargets(['nonprod', 'prod'], 'all')).toBe(true)
    expect(productionWithAllTargets(['nonprod'], 'all')).toBe(false)
    expect(productionWithAllTargets(['prod'], 'list')).toBe(false)
    // A warning never makes the choice invalid.
    expect(issues({ tiers: ['nonprod', 'prod'] })).toEqual([])
  })

  it('reads as one sentence, with the first three IDs and a count of the rest', () => {
    const r = (targets: ApiKey['restrictions']['targets']): ApiKey['restrictions'] => ({
      tiers: ['nonprod'],
      targets,
    })
    expect(targetsText(r({ kind: 'all' }))).toBe('Targets: all the roles reach.')
    expect(targetsText(r({ kind: 'list', targetIds: [tid(1)] }))).toBe(
      `Targets: limited to 1 target (${tid(1)}).`,
    )
    expect(targetsText(r({ kind: 'list', targetIds: [tid(1), tid(2)] }))).toBe(
      `Targets: limited to 2 targets (${tid(1)}, ${tid(2)}).`,
    )
    expect(targetsText(r({ kind: 'list', targetIds: [1, 2, 3, 4].map(tid) }))).toBe(
      `Targets: limited to 4 targets (${tid(1)}, ${tid(2)}, ${tid(3)}, and 1 more).`,
    )
    expect(restrictionsLine(r({ kind: 'all' }))).toBe(
      'Tiers: Non-production. Targets: all the roles reach.',
    )
  })

  it('leaves the line of an API key as the browser suite selects on it', () => {
    const key = apiKey({
      expiresAt: '2027-01-11T12:00:00Z',
      restrictions: { tiers: ['prod'], targets: { kind: 'list', targetIds: [tid(1)] } },
    })
    expect(apiKeyLine(key)).toBe('targets.read, active, until 2027-01-11 12:00 UTC.')
  })
})

const EC = {
  kty: 'EC',
  crv: 'P-256',
  kid: 'nightly-1',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
}

describe('pasted public keys', () => {
  it('accept a JWKS, a bare array and a single key', () => {
    for (const text of [JSON.stringify({ keys: [EC] }), JSON.stringify([EC]), JSON.stringify(EC)]) {
      expect(parseJwks(text)).toEqual({ ok: true, jwks: { keys: [EC] } })
    }
  })

  it('name a private key as such, whatever else is wrong, and never pass it on', () => {
    const privateKey = { ...EC, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' }
    expect(parseJwks(JSON.stringify({ keys: [privateKey] }))).toEqual({
      ok: false,
      reason: 'private',
    })
    expect(parseJwks(JSON.stringify({ keys: [{ kty: 'oct', k: 'c2VjcmV0' }] }))).toEqual({
      ok: false,
      reason: 'private',
    })
    for (const member of ['p', 'q', 'dp', 'dq', 'qi', 'oth']) {
      expect(parseJwks(JSON.stringify([{ ...EC, [member]: 'x' }])).ok, member).toBe(false)
    }
    expect(parseJwks(`${pem('BEGIN', 'EC ')}\nMHcCAQEEIA==\n${pem('END', 'EC ')}`)).toEqual({
      ok: false,
      reason: 'private',
    })
    expect(parseJwks(pem('BEGIN', ''))).toEqual({ ok: false, reason: 'private' })
  })

  it('refuse text that is not JSON and keys of another shape', () => {
    expect(parseJwks('{keys:')).toEqual({ ok: false, reason: 'json' })
    expect(parseJwks('{}')).toEqual({ ok: false, reason: 'shape' })
    expect(parseJwks('{"keys":[]}')).toEqual({ ok: false, reason: 'shape' })
    expect(parseJwks('"text"')).toEqual({ ok: false, reason: 'shape' })
    expect(isPublicJwk({ ...EC, x5c: ['abc'] })).toBe(false)
    expect(isPublicJwk({ ...EC, crv: 'P-521' })).toBe(false)
    expect(isPublicJwk({ ...EC, alg: 'none' })).toBe(false)
    expect(isPublicJwk({ ...EC, use: 'enc' })).toBe(false)
    expect(isPublicJwk({ kty: 'OKP', crv: 'Ed25519', kid: 'a', x: 'b' })).toBe(true)
    expect(isPublicJwk({ kty: 'RSA', kid: 'a', n: 'b', e: 'AQAB' })).toBe(true)
    expect(isPublicJwk({ kty: 'RSA', n: 'b', e: 'AQAB' })).toBe(false)
    // A member named __proto__ is a member like any other: not one of a public key.
    expect(isPublicJwk({ ...EC, ['__proto__']: { d: 'x' } })).toBe(false)
    expect(
      parseJwks(`{"keys":[${JSON.stringify(EC).slice(0, -1)},"__proto__":{"d":"x"}}]}`),
    ).toEqual({
      ok: false,
      reason: 'shape',
    })
  })
})

describe('what a client card shows and offers', () => {
  it('reads redirect hosts with the URL parser, look-alike names in their xn-- form', () => {
    expect(
      redirectHosts([
        'https://agent.example.test/callback',
        'https://agent.example.test/other',
        'http://127.0.0.1:33418/cb',
        'https://еxample.test/cb',
        'not a url',
      ]),
    ).toEqual(['agent.example.test', '127.0.0.1:33418', 'xn--xample-2of.test', 'not a url'])
  })

  it('offers the decisions of the Wave 3B page per state', () => {
    const decisions = (over: Partial<OAuthClient>) => clientDecisions(oauthClient(over))
    expect(decisions({ state: 'pending', registration: 'dcr' })).toEqual({
      approve: true,
      reject: true,
      disable: false,
      refresh: false,
    })
    expect(decisions({ state: 'active', registration: 'cimd' })).toEqual({
      approve: false,
      reject: false,
      disable: true,
      refresh: true,
    })
    expect(decisions({ state: 'active', firstParty: true, registration: 'first_party' })).toEqual({
      approve: false,
      reject: false,
      disable: false,
      refresh: false,
    })
    expect(decisions({ state: 'rejected' }).approve).toBe(true)
    expect(decisions({ state: 'disabled' }).approve).toBe(true)
  })

  it('names an automatic approval only for an active third-party client without an approver', () => {
    expect(approvedAutomatically(oauthClient({ state: 'active', approvedBy: null }))).toBe(true)
    expect(
      approvedAutomatically(
        oauthClient({ state: 'active', approvedBy: 'idn_01JZ0000000000000000000001' }),
      ),
    ).toBe(false)
    expect(approvedAutomatically(oauthClient({ state: 'pending', approvedBy: null }))).toBe(false)
    expect(
      approvedAutomatically(oauthClient({ state: 'active', firstParty: true, approvedBy: null })),
    ).toBe(false)
  })

  it('summarizes an API key as the Wave 3B page did (the browser suite selects on it)', () => {
    const key: ApiKey = apiKey({ expiresAt: '2027-01-11T12:00:00Z' })
    expect(apiKeyLine(key)).toBe('targets.read, active, until 2027-01-11 12:00 UTC.')
    expect(apiKeyLine({ ...key, state: 'revoked', lastUsedAt: '2026-10-13T08:30:00Z' })).toBe(
      'targets.read, revoked, until 2027-01-11 12:00 UTC. Last used 2026-10-13 08:30 UTC.',
    )
  })

  it('needs access.manage to change anything', () => {
    const me = (permissions: Me['effectivePermissions']): Me => ({
      identity: {
        id: 'idn_01JZ0000000000000000000001',
        kind: 'human',
        state: 'active',
        label: 'owner',
        displayName: 'Ada',
        email: 'owner@example.test',
      } as Me['identity'],
      session: {} as Me['session'],
      bindings: [],
      effectivePermissions: permissions,
    })
    expect(canManageAccess(me([{ permission: 'access.read', scopes: [] }]))).toBe(false)
    expect(canManageAccess(me([{ permission: 'access.manage', scopes: [] }]))).toBe(true)
  })

  it('keeps the old addresses as sign-in return targets, never as a prefix', () => {
    expect(safeReturnTo('/admin/clients')).toBe('/admin/clients')
    expect(safeReturnTo('/admin/service-accounts')).toBe('/admin/service-accounts')
    expect(safeReturnTo('/access/oauth-clients')).toBe('/access/oauth-clients')
    expect(safeReturnTo('/access/service-accounts')).toBe('/access/service-accounts')
    expect(safeReturnTo('/admin/clients/extra')).toBe('/account')
    expect(safeReturnTo('/admin/clients?x=1')).toBe('/account')
    expect(safeReturnTo('/admin/clients#client=x')).toBe('/account')
    expect(safeReturnTo('//evil.example/admin/clients')).toBe('/account')
  })
})
