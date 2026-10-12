import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { freshProof, type Principal, stepUpBindingDigest } from '../src/index.ts'

/**
 * The engine's proof of presence for a delegated principal (ADR-0026): only
 * a person's first-party CLI, only with a step-up receipt the request's use
 * case redeemed, only inside the action's window. A service account, an MCP
 * client or a CLI without a receipt never has one.
 */
type Delegated = Extract<Principal, { kind: 'delegated' }>

function delegated(overrides: Partial<Delegated> = {}): Delegated {
  return {
    kind: 'delegated',
    identityId: newId('idn', 1),
    identityKind: 'human',
    label: 'human #1',
    client: 'cli',
    delegation: {
      credential: {
        type: 'access_token',
        grantId: newId('grt', 2),
        clientId: newId('cli', 3),
        grantKind: 'delegated',
      },
      resource: 'api',
      scopes: new Set(),
      restrictions: { tiers: ['nonprod', 'prod'], targetIds: null },
    },
    ...overrides,
  } as Delegated
}

describe('freshProof for a delegated principal', () => {
  it('counts a redeemed receipt of a person through the CLI within the window only', () => {
    const receipt = { reauthAt: new Date().toISOString(), reauthAgeSeconds: 40 }
    expect(freshProof(delegated(), 300, 'plan.apply')).toBe(false)
    expect(freshProof(delegated({ stepUp: receipt }), 300, 'plan.apply')).toBe(true)
    expect(freshProof(delegated({ stepUp: receipt }), 30, 'plan.apply')).toBe(false)
    expect(freshProof(delegated({ stepUp: receipt, client: 'mcp' }), 300, 'plan.apply')).toBe(false)
    expect(
      freshProof(delegated({ stepUp: receipt, identityKind: 'service', client: 'ci' }), 300),
    ).toBe(false)
  })

  it('binds a step-up to every field of its binding', () => {
    const binding = {
      installationId: newId('ins', 1),
      identityId: newId('idn', 1),
      clientId: newId('cli', 3),
      grantId: newId('grt', 2),
      action: 'plan.apply' as const,
      planId: newId('pln', 4),
      planHash: `sha256:${'a'.repeat(64)}`,
      tokenId: null,
    }
    const digest = stepUpBindingDigest(binding)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(stepUpBindingDigest({ ...binding })).toBe(digest)
    for (const changed of [
      { installationId: newId('ins', 9) },
      { identityId: newId('idn', 9) },
      { clientId: newId('cli', 9) },
      { grantId: newId('grt', 9) },
      { planId: newId('pln', 9) },
      { planHash: `sha256:${'b'.repeat(64)}` },
      { action: 'node.enrollment_token.reveal' as const },
    ]) {
      expect(stepUpBindingDigest({ ...binding, ...changed })).not.toBe(digest)
    }
  })
})
