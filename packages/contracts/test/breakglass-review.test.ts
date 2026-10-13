import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  BREAK_GLASS_GRANT_STATES,
  BreakGlassGrantListQuerySchema,
  BreakGlassReviewRequestSchema,
  BUILT_IN_ROLE_IDS,
  MCP_TOOL_LIST,
  ROUTE_LIST,
  rolePermissions,
  SCOPES,
} from '../src/index.ts'

/**
 * Break-glass list and review (Wave 8, order §9; operations-engine.md §8):
 * for owners and admins through `policy.manage`, which no MCP client and no
 * service account can hold; the review is a Web App action with a fresh
 * re-authentication; the note is bounded untrusted text.
 */
describe('break-glass list and review actions', () => {
  it('are reachable by owner and admin only, through a human session, and no MCP tool binds them', () => {
    const holders = BUILT_IN_ROLE_IDS.filter((r) => rolePermissions(r).includes('policy.manage'))
    expect([...holders].sort()).toEqual(['admin', 'owner'])
    expect(SCOPES['policy.manage']).toMatchObject({ mcpGrantable: false, humanOnly: true })
    expect(SCOPES['policy.manage'].clientKinds).toEqual(['web', 'cli'])

    const list = ACTIONS['breakglass.list']
    expect(list).toMatchObject({
      effect: 'read',
      permission: { kind: 'fixed', permission: 'policy.manage' },
      scope: { kind: 'fixed', scope: 'policy.manage' },
      humanOnly: true,
      reauthentication: false,
      wave: '8',
    })
    expect(list.clientKinds).toEqual(['web', 'cli'])

    const review = ACTIONS['breakglass.review']
    expect(review).toMatchObject({
      effect: 'control_record',
      permission: { kind: 'fixed', permission: 'policy.manage' },
      scope: { kind: 'fixed', scope: 'policy.manage' },
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 300,
      operationKind: false,
      wave: '8',
    })
    expect(review.clientKinds).toEqual(['web'])
    for (const id of ['breakglass.list', 'breakglass.review', 'breakglass.activate']) {
      expect(
        MCP_TOOL_LIST.some((t) => t.action === id),
        id,
      ).toBe(false)
    }
  })

  it('have the documented routes', () => {
    const route = (id: string) => ROUTE_LIST.find((r) => r.operationId === id)
    expect([route('listBreakGlassGrants')?.method, route('listBreakGlassGrants')?.path]).toEqual([
      'get',
      '/break-glass-grants',
    ])
    expect(route('listBreakGlassGrants')?.action).toBe('breakglass.list')
    expect([route('reviewBreakGlassGrant')?.method, route('reviewBreakGlassGrant')?.path]).toEqual([
      'post',
      '/break-glass-grants/{grant}/review',
    ])
    expect(route('reviewBreakGlassGrant')?.action).toBe('breakglass.review')
    expect(route('reviewBreakGlassGrant')?.errors).toEqual(
      expect.arrayContaining(['CONFLICT', 'REAUTH_REQUIRED', 'NOT_FOUND']),
    )
  })
})

describe('the list query', () => {
  it('admits only the states the stored grant can prove, and refuses unknown filters', () => {
    expect(BREAK_GLASS_GRANT_STATES).toEqual(['active', 'expired', 'revoked', 'used_up'])
    expect(BreakGlassGrantListQuerySchema.safeParse({ state: 'expired' }).success).toBe(true)
    expect(BreakGlassGrantListQuerySchema.safeParse({ review: 'open' }).success).toBe(true)
    for (const bad of [
      { state: 'pending' },
      { state: 'approved' },
      { review: 'maybe' },
      { target: 'not a target' },
      { owner: 'me' },
    ]) {
      expect(BreakGlassGrantListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('the review note', () => {
  const ok = (note: string) => BreakGlassReviewRequestSchema.safeParse({ note }).success

  it('takes 1 to 2000 characters with line feeds', () => {
    expect(ok('x')).toBe(true)
    expect(ok('a'.repeat(2000))).toBe(true)
    expect(ok('Root cause: staging was down.\nFollow-up: restore staging first.')).toBe(true)
    expect(ok('\u00dcberpr\u00fcft \u2013 ok')).toBe(true)
  })

  it('refuses empty, blank, too long, control characters and bidirectional overrides', () => {
    for (const note of [
      '',
      '   \n  ',
      'a'.repeat(2001),
      'carriage\rreturn',
      'tab\there',
      'nul\u0000',
      'escape\u001b[31m',
      'delete\u007f',
      'c1\u0085',
      'override\u202eevil',
      'isolate\u2066x',
    ]) {
      expect(ok(note), JSON.stringify(note)).toBe(false)
    }
    expect(BreakGlassReviewRequestSchema.safeParse({ note: 'x', extra: 1 }).success).toBe(false)
  })
})
