import { describe, expect, it } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  type ActionDefinition,
  CLIENT_KINDS,
  isScopeGrantableTo,
  isWriteScope,
  MCP_INELIGIBLE_SCOPES,
  OAUTH_LIMITS,
  PublicJwkSchema,
  PublicJwksSchema,
  RESOURCES_BY_CLIENT_KIND,
  SCOPE_IDS,
  SCOPES,
  TokenResponseSchema,
  WRITE_SCOPES,
} from '../src/index.ts'

const def = (id: (typeof ACTION_IDS)[number]): ActionDefinition => ACTIONS[id]

describe('OAuth contracts (Wave 3B)', () => {
  it('derives write scopes from what their actions do, never from the name', () => {
    expect(isWriteScope('migrations.apply:prod')).toBe(true)
    expect(isWriteScope('migrations.apply:nonprod')).toBe(true)
    expect(isWriteScope('connections.operate:prod')).toBe(true)
    expect(isWriteScope('nodes.operate:prod')).toBe(true)
    expect(isWriteScope('access.manage')).toBe(true)
    expect(isWriteScope('data.read:prod')).toBe(false)
    expect(isWriteScope('data.read:nonprod')).toBe(false)
    expect(isWriteScope('targets.read')).toBe(false)
    expect(isWriteScope('audit.read')).toBe(false)
    for (const scope of WRITE_SCOPES) {
      const actions = ACTION_IDS.filter((id) => {
        const a = def(id)
        return (
          a.effect !== 'read' &&
          ((a.scope.kind === 'fixed' && a.scope.scope === scope) ||
            (a.scope.kind === 'tiered' && scope.startsWith(`${a.scope.permission}:`)))
        )
      })
      expect(actions.length, scope).toBeGreaterThan(0)
    }
  })

  it('never lets the Web App hold tokens, keeps service accounts and the CLI on the REST API', () => {
    expect(RESOURCES_BY_CLIENT_KIND.web).toEqual([])
    expect(RESOURCES_BY_CLIENT_KIND.cli).toEqual(['api'])
    expect(RESOURCES_BY_CLIENT_KIND.ci).toEqual(['api'])
    expect(RESOURCES_BY_CLIENT_KIND.mcp).toEqual(['mcp'])
    expect(Object.keys(RESOURCES_BY_CLIENT_KIND).sort()).toEqual([...CLIENT_KINDS].sort())
  })

  it('registers every protocol endpoint as an action with the protocol rule', () => {
    for (const id of [
      'oauth.metadata.get',
      'oauth.authorize',
      'oauth.token',
      'oauth.revoke',
      'oauth.register',
      'oauth.device_authorization',
    ] as const) {
      expect(def(id).permission).toEqual({ kind: 'protocol' })
      expect(def(id).scope).toEqual({ kind: 'none' })
    }
    const protocolActions = ACTION_IDS.filter((id) => def(id).permission.kind === 'protocol')
    expect(protocolActions.every((id) => id.startsWith('oauth.'))).toBe(true)
  })

  it('keeps every Wave 3B administration action human-only with a re-authentication for changes', () => {
    for (const id of ACTION_IDS) {
      const a = def(id)
      if (a.wave !== '3B' || a.permission.kind !== 'fixed') {
        continue
      }
      // Reads are reached through the human-only scope access.read; changes are human-only themselves.
      expect(a.clientKinds, id).toEqual(['web', 'cli'])
      if (a.effect !== 'read') {
        expect(a.humanOnly, id).toBe(true)
      }
      expect(a.clientKinds, id).not.toContain('mcp')
      expect(a.clientKinds, id).not.toContain('ci')
      if (a.effect === 'consequential') {
        expect(a.reauthentication, id).toBe(true)
        expect(a.reauthWithinSeconds, id).toBe(300)
        expect(a.permission, id).toEqual({ kind: 'fixed', permission: 'access.manage' })
      }
    }
  })

  it('never makes an MCP-ineligible scope grantable to an mcp client', () => {
    expect(MCP_INELIGIBLE_SCOPES.length).toBeGreaterThan(0)
    for (const scope of SCOPE_IDS) {
      expect(isScopeGrantableTo(scope, 'mcp'), scope).toBe(SCOPES[scope].mcpGrantable)
    }
  })

  it('accepts only public signing keys: private members and symmetric keys are refused', () => {
    const x = 'A'.repeat(43)
    expect(PublicJwkSchema.safeParse({ kty: 'OKP', crv: 'Ed25519', x, kid: 'k1' }).success).toBe(
      true,
    )
    expect(
      PublicJwkSchema.safeParse({ kty: 'OKP', crv: 'Ed25519', x, d: x, kid: 'k1' }).success,
    ).toBe(false)
    expect(PublicJwkSchema.safeParse({ kty: 'oct', k: x, kid: 'k1' }).success).toBe(false)
    expect(
      PublicJwkSchema.safeParse({ kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', alg: 'HS256' }).success,
    ).toBe(false)
    expect(
      PublicJwkSchema.safeParse({ kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', alg: 'none' }).success,
    ).toBe(false)
    expect(PublicJwkSchema.safeParse({ kty: 'OKP', crv: 'Ed25519', x }).success).toBe(false)
    const keys = Array.from({ length: OAUTH_LIMITS.maxJwksKeys + 1 }, (_, i) => ({
      kty: 'OKP',
      crv: 'Ed25519',
      x,
      kid: `k${i}`,
    }))
    expect(PublicJwksSchema.safeParse({ keys }).success).toBe(false)
    expect(
      PublicJwksSchema.safeParse({
        keys: [
          { kty: 'OKP', crv: 'Ed25519', x, kid: 'same' },
          { kty: 'OKP', crv: 'Ed25519', x, kid: 'same' },
        ],
      }).success,
    ).toBe(false)
  })

  it('shapes token responses without identity data or ID tokens', () => {
    const body = {
      access_token: `exat_${'a'.repeat(43)}`,
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'targets.read',
    }
    expect(TokenResponseSchema.safeParse(body).success).toBe(true)
    expect(TokenResponseSchema.safeParse({ ...body, id_token: 'x' }).success).toBe(false)
    expect(TokenResponseSchema.safeParse({ ...body, email: 'a@example.test' }).success).toBe(false)
    expect(TokenResponseSchema.safeParse({ ...body, expires_in: 3600 }).success).toBe(false)
  })
})
