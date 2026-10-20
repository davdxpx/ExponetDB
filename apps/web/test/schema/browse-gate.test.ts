import { describe, expect, it } from 'vitest'
import { browseGate, holdsDataRead, scopeReaches } from '../../src/features/schema/browse-gate.ts'

const TARGET = {
  id: 'tgt_00000000000000000000000001',
  productId: 'prd_00000000000000000000000001',
  projectId: 'prj_00000000000000000000000001',
  environmentId: 'env_00000000000000000000000001',
  tier: 'nonprod' as const,
}
const PROD = { ...TARGET, id: 'tgt_00000000000000000000000002', tier: 'prod' as const }

const GLOBAL = { kind: 'global' } as const
const OTHER_ENV = { kind: 'environment', environmentId: 'env_00000000000000000000000009' } as const

function grant(...scopes: Parameters<typeof scopeReaches>[0][]) {
  return [{ permission: 'data.read' as const, scopes }]
}

describe('scopeReaches', () => {
  it('reaches the target by its own id, its environment, its project, its product or globally', () => {
    expect(scopeReaches(GLOBAL, TARGET)).toBe(true)
    expect(scopeReaches({ kind: 'product', productId: TARGET.productId }, TARGET)).toBe(true)
    expect(scopeReaches({ kind: 'project', projectId: TARGET.projectId }, TARGET)).toBe(true)
    expect(scopeReaches({ kind: 'environment', environmentId: TARGET.environmentId }, TARGET)).toBe(
      true,
    )
    expect(scopeReaches({ kind: 'target', targetId: TARGET.id }, TARGET)).toBe(true)
  })

  it('does not reach another target, environment, project or product', () => {
    expect(scopeReaches(OTHER_ENV, TARGET)).toBe(false)
    expect(scopeReaches({ kind: 'target', targetId: PROD.id }, TARGET)).toBe(false)
    expect(
      scopeReaches({ kind: 'project', projectId: 'prj_00000000000000000000000009' }, TARGET),
    ).toBe(false)
    expect(
      scopeReaches({ kind: 'product', productId: 'prd_00000000000000000000000009' }, TARGET),
    ).toBe(false)
  })
})

describe('browseGate', () => {
  it('is open for a person who holds data.read where the target is', () => {
    expect(browseGate({ permissions: grant(GLOBAL), target: TARGET, policy: undefined })).toEqual({
      kind: 'open',
    })
  })

  it('names the missing permission and the scope of the target tier when there is none', () => {
    expect(browseGate({ permissions: [], target: TARGET, policy: undefined })).toEqual({
      kind: 'not_permitted',
      permission: 'data.read',
      scope: 'data.read:nonprod',
    })
    expect(
      browseGate({
        permissions: [{ permission: 'schema.read', scopes: [GLOBAL] }],
        target: PROD,
        policy: undefined,
      }),
    ).toEqual({ kind: 'not_permitted', permission: 'data.read', scope: 'data.read:prod' })
  })

  it('does not take a grant bound to another environment as a grant for this target', () => {
    expect(browseGate({ permissions: grant(OTHER_ENV), target: PROD, policy: undefined })).toEqual({
      kind: 'not_permitted',
      permission: 'data.read',
      scope: 'data.read:prod',
    })
    expect(holdsDataRead(grant(OTHER_ENV, GLOBAL), PROD)).toBe(true)
  })

  it('does not read a grant with no scope listed as "nowhere": the server decides', () => {
    expect(holdsDataRead(grant(), TARGET)).toBe(true)
  })

  it('is off when the data-read setting of the target is disabled', () => {
    const policy = { from: 'target', revision: 3, mode: 'disabled', sensitiveColumns: [] } as const
    expect(browseGate({ permissions: grant(GLOBAL), target: TARGET, policy })).toEqual({
      kind: 'reads_off',
    })
  })

  it.each(['by_tier', 'enabled', 'humans_only', 'unreadable'] as const)(
    'stays open for a person when the setting is %s',
    (mode) => {
      const policy = { from: 'default', revision: null, mode, sensitiveColumns: [] } as const
      expect(browseGate({ permissions: grant(GLOBAL), target: PROD, policy })).toEqual({
        kind: 'open',
      })
    },
  )

  it('says "not permitted" before "off": a person who may not read is told so first', () => {
    const policy = { from: 'target', revision: 1, mode: 'disabled', sensitiveColumns: [] } as const
    expect(browseGate({ permissions: [], target: TARGET, policy }).kind).toBe('not_permitted')
  })
})
