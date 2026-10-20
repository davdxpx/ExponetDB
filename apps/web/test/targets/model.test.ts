import { describe, expect, it } from 'vitest'
import {
  defaultsOf,
  filterTargets,
  shownSort,
  shownView,
  sortTargets,
  targetHrefOf,
  targetPathParts,
  targetsSearch,
  withSearch,
} from '../../src/features/targets/model.ts'
import {
  credentialsPath,
  declaredTierOf,
  freeDatabases,
  registrationTier,
} from '../../src/features/targets/register-model.ts'
import { iso, targetFixture } from '../fleet/support.tsx'

describe('target paths', () => {
  it('links only three slugs', () => {
    expect(targetHrefOf('shop/platform/production', '/findings')).toBe(
      '/t/shop/platform/production/findings',
    )
    for (const bad of [
      '',
      'a/b',
      'a/b/c/d',
      '../b/c',
      'Shop/platform/production',
      'a/b/c%2f',
      `a/b/c${String.fromCodePoint(0x202e)}`,
      'a/b/1c',
      'a//c',
      ' a/b/c',
    ]) {
      expect(targetPathParts(bad)).toBeUndefined()
      expect(targetHrefOf(bad)).toBeUndefined()
    }
  })
})

describe('the search of the targets list', () => {
  it('keeps allowlisted values and drops everything else', () => {
    expect(
      targetsSearch({
        q: 'shop',
        tier: 'prod',
        state: 'all',
        health: 'none',
        sort: 'tier',
        view: 'grid',
      }),
    ).toEqual({ q: 'shop', tier: 'prod', state: 'all', health: 'none', sort: 'tier', view: 'grid' })
    expect(
      targetsSearch({
        q: {},
        tier: 'x',
        state: 1,
        health: ['healthy'],
        sort: null,
        view: 'iframe',
      }),
    ).toEqual({
      q: undefined,
      tier: undefined,
      state: undefined,
      health: undefined,
      sort: undefined,
      view: undefined,
    })
  })

  it('reads a number the router parsed as text, and drops long or control text', () => {
    expect(targetsSearch({ q: 2024 }).q).toBe('2024')
    expect(targetsSearch({ q: 'x'.repeat(101) }).q).toBeUndefined()
    expect(targetsSearch({ q: 'a\u0000b' }).q).toBeUndefined()
    expect(targetsSearch({ q: `a${String.fromCodePoint(0x202e)}` }).q).toBeUndefined()
    expect(targetsSearch({ q: `a${String.fromCodePoint(0x200b)}` }).q).toBeUndefined()
    expect(targetsSearch({ q: '' }).q).toBeUndefined()
  })

  it('keeps a product and project slug, and a project only together with its product', () => {
    expect(targetsSearch({ product: 'shop', project: 'platform' })).toMatchObject({
      product: 'shop',
      project: 'platform',
    })
    expect(targetsSearch({ project: 'platform' }).project).toBeUndefined()
    for (const bad of [
      'Shop',
      '1shop',
      'shop/platform',
      '../x',
      'a b',
      '',
      'x'.repeat(40),
      7,
      {},
    ]) {
      expect(targetsSearch({ product: bad, project: 'platform' }).product).toBeUndefined()
      expect(targetsSearch({ product: bad, project: 'platform' }).project).toBeUndefined()
      expect(targetsSearch({ product: 'shop', project: bad }).project).toBeUndefined()
    }
  })

  it('removes the defaults from the URL', () => {
    expect(withSearch({}, { q: '', sort: 'path', view: 'table' })).toEqual({
      q: undefined,
      tier: undefined,
      state: undefined,
      health: undefined,
      sort: undefined,
      view: undefined,
    })
  })
})

describe('the defaults of the list', () => {
  it('takes the remembered sort and view, else the built-in ones, and the address wins', () => {
    expect(defaultsOf({})).toEqual({ sort: 'path', view: 'table' })
    expect(defaultsOf({ sort: 'health', view: 'grid' })).toEqual({ sort: 'health', view: 'grid' })
    const defaults = defaultsOf({ sort: 'health', view: 'grid' })
    expect(shownSort({}, defaults)).toBe('health')
    expect(shownView({}, defaults)).toBe('grid')
    expect(shownSort({ sort: 'path' }, defaults)).toBe('path')
    expect(shownView({ view: 'table' }, defaults)).toBe('table')
  })

  it('names a sort or view in the address only when it differs from the default', () => {
    const defaults = defaultsOf({ sort: 'health', view: 'grid' })
    expect(withSearch({}, { sort: 'health', view: 'grid' }, defaults)).toMatchObject({
      sort: undefined,
      view: undefined,
    })
    expect(withSearch({}, { sort: 'path', view: 'table' }, defaults)).toMatchObject({
      sort: 'path',
      view: 'table',
    })
    // Nothing else changes what the address already says.
    expect(withSearch({ sort: 'tier' }, { q: 'x' }, defaults)).toMatchObject({
      sort: 'tier',
      q: 'x',
    })
  })

  it('drops a project when the product changes, keeps it when only the project changes', () => {
    const base = { product: 'shop', project: 'platform' }
    expect(withSearch(base, { product: 'acme' })).toMatchObject({
      product: 'acme',
      project: undefined,
    })
    expect(withSearch(base, { project: 'billing' })).toMatchObject({
      product: 'shop',
      project: 'billing',
    })
    expect(withSearch(base, { product: undefined })).toMatchObject({
      product: undefined,
      project: undefined,
    })
    expect(withSearch(base, { product: 'shop' })).toMatchObject({
      product: 'shop',
      project: 'platform',
    })
  })
})

describe('filtering and sorting', () => {
  const list = [
    targetFixture('shop/platform/production', { tier: 'prod' }),
    targetFixture('shop/platform/staging', { health: null }),
    targetFixture('acme/core/staging', { state: 'decommissioned' }),
    targetFixture('acme/core/production', {
      tier: 'prod',
      health: { state: 'weird-new-state' as never, source: 's', observedAt: iso() },
    }),
  ]
  it('hides decommissioned targets unless asked, and matches the path in any case', () => {
    expect(filterTargets(list, {}).map((t) => t.path)).not.toContain('acme/core/staging')
    expect(filterTargets(list, { state: 'all' })).toHaveLength(4)
    expect(filterTargets(list, { q: 'ACME' }).map((t) => t.path)).toEqual(['acme/core/production'])
  })
  it('treats a health state it does not know as unknown, never as healthy', () => {
    expect(filterTargets(list, { health: 'unknown' }).map((t) => t.path)).toEqual([
      'acme/core/production',
    ])
    expect(filterTargets(list, { health: 'healthy' }).map((t) => t.path)).toEqual([
      'shop/platform/production',
    ])
    expect(filterTargets(list, { health: 'none' }).map((t) => t.path)).toEqual([
      'shop/platform/staging',
    ])
  })
  it('sorts a copy', () => {
    const copy = [...list]
    sortTargets(list, 'health')
    expect(list).toEqual(copy)
    expect(sortTargets(list, 'path')[0]?.path).toBe('acme/core/production')
  })
})

describe('the registration cue', () => {
  it('is production unless the environment and the cluster are both non-production', () => {
    expect(registrationTier('nonprod', { declaredTier: 'nonprod' })).toBe('nonprod')
    expect(registrationTier('nonprod', { declaredTier: 'prod' })).toBe('prod')
    expect(registrationTier('nonprod', { declaredTier: null })).toBe('prod')
    expect(registrationTier('nonprod', {})).toBe('prod')
    expect(registrationTier('nonprod', undefined)).toBe('prod')
    expect(registrationTier('prod', { declaredTier: 'nonprod' })).toBe('prod')
    expect(registrationTier(undefined, { declaredTier: 'nonprod' })).toBe('prod')
  })
  it('reads the declared tier, or none', () => {
    expect(declaredTierOf({ declaredTier: 'prod' })).toBe('prod')
    expect(declaredTierOf({})).toBe('undeclared')
    expect(declaredTierOf(undefined)).toBe('undeclared')
  })
  it('offers only databases that are registered and placed nowhere', () => {
    const base = { clusterId: 'c', createdAt: '', observed: null }
    expect(
      freeDatabases([
        { ...base, id: 'a', name: 'a', state: 'registered', placement: null },
        { ...base, id: 'b', name: 'b', state: 'retired', placement: null },
        {
          ...base,
          id: 'c',
          name: 'c',
          state: 'registered',
          placement: { generation: 1, targetId: 't' },
        },
      ]).map((d) => d.id),
    ).toEqual(['a'])
  })
  it('links the credentials page only for a cluster id', () => {
    expect(credentialsPath('cls_01M4S9000000000000000000AF')).toBe(
      '/credentials#cluster=cls_01M4S9000000000000000000AF',
    )
    expect(credentialsPath('cls_x&role=evil')).toBeUndefined()
    expect(credentialsPath('')).toBeUndefined()
  })
})
