import { describe, expect, it } from 'vitest'
import { buildEnvironmentCommands } from '../../src/features/target/environment-commands.tsx'
import {
  type Environment,
  environmentHref,
  environmentShortcuts,
  toEnvironmentList,
} from '../../src/features/target/environments.ts'
import { parseTargetParams } from '../../src/features/target/params.ts'

function item(path: string, tier: 'prod' | 'nonprod', state = 'active' as const) {
  return {
    id: `tgt_${path.replace(/\W/g, '')}`,
    path,
    productId: 'prd_1',
    projectId: 'prj_1',
    environmentId: 'env_1',
    tier,
    state,
    generation: 1,
    health: null,
  }
}

function env(slug: string, tier: 'prod' | 'nonprod'): Environment {
  return { id: `tgt_${slug}`, path: `shop/platform/${slug}`, slug, tier, state: 'active' }
}

const TARGET = parseTargetParams({ product: 'shop', project: 'platform', environment: 'staging' })
if (TARGET === undefined) throw new Error('fixture target is invalid')

describe('toEnvironmentList', () => {
  it('takes the tier from the tier field, never from the slug', () => {
    const list = toEnvironmentList(
      {
        items: [item('shop/platform/prod', 'nonprod'), item('shop/platform/qa', 'prod')],
        nextCursor: null,
      },
      'shop',
      'platform',
    )
    expect(list.environments.map((e) => [e.slug, e.tier])).toEqual([
      ['prod', 'nonprod'],
      ['qa', 'prod'],
    ])
    expect(list.missing).toEqual([])
  })

  it('lists nonproduction first, then by slug', () => {
    const list = toEnvironmentList(
      {
        items: [
          item('shop/platform/production', 'prod'),
          item('shop/platform/staging', 'nonprod'),
          item('shop/platform/development', 'nonprod'),
        ],
        nextCursor: null,
      },
      'shop',
      'platform',
    )
    expect(list.environments.map((e) => e.slug)).toEqual(['development', 'staging', 'production'])
  })

  it('reports what it cannot show instead of dropping it silently', () => {
    const list = toEnvironmentList(
      {
        items: [
          item('shop/platform/staging', 'nonprod'),
          item('shop/other/staging', 'nonprod'),
          item('Shop/platform/x', 'nonprod'),
          item('shop/platform/staging', 'nonprod'),
        ],
        nextCursor: 'cur_1',
      },
      'shop',
      'platform',
    )
    expect(list.environments.map((e) => e.slug)).toEqual(['staging'])
    expect(list.missing).toHaveLength(2)
  })

  it('keeps an empty list empty, so the page can tell a successful empty read from a failed one', () => {
    expect(toEnvironmentList({ items: [], nextCursor: null }, 'shop', 'platform')).toEqual({
      environments: [],
      missing: [],
    })
  })
})

describe('environmentHref', () => {
  it('keeps the section and a schema kind and drops an object name', () => {
    expect(
      environmentHref(TARGET, '/t/shop/platform/staging/schema/tables/public.users', 'production'),
    ).toBe('/t/shop/platform/production/schema/tables')
    expect(environmentHref(TARGET, '/t/shop/platform/staging/migrations', 'production')).toBe(
      '/t/shop/platform/production/migrations',
    )
    expect(environmentHref(TARGET, '/t/shop/platform/staging', 'production')).toBe(
      '/t/shop/platform/production',
    )
  })

  it('falls back to the overview of the other environment for a path that is not a target page', () => {
    expect(environmentHref(TARGET, '/audit', 'production')).toBe('/t/shop/platform/production')
  })
})

describe('environmentShortcuts', () => {
  const bound = (list: Environment[], current = 'staging') =>
    environmentShortcuts(list, current).map((entry) => [entry.shortcut, entry.environment.slug])

  it('binds each shortcut to the environment whose slug is that word', () => {
    expect(
      bound(
        [env('development', 'nonprod'), env('staging', 'nonprod'), env('production', 'prod')],
        'development',
      ),
    ).toEqual([
      ['env.production', 'production'],
      ['env.staging', 'staging'],
    ])
  })

  it('leaves a shortcut unbound when there is no such environment', () => {
    expect(bound([env('qa', 'nonprod'), env('staging', 'nonprod')], 'qa')).toEqual([
      ['env.staging', 'staging'],
    ])
    expect(bound([env('qa', 'nonprod')], 'qa')).toEqual([])
  })

  it('does not bind the environment the person is on', () => {
    expect(bound([env('staging', 'nonprod'), env('production', 'prod')], 'production')).toEqual([
      ['env.staging', 'staging'],
    ])
  })

  it('falls back to the only environment with tier prod when none is called production', () => {
    expect(bound([env('staging', 'nonprod'), env('live', 'prod')], 'staging')).toEqual([
      ['env.production', 'live'],
    ])
  })

  it('does not guess between several environments with tier prod', () => {
    expect(
      bound([env('staging', 'nonprod'), env('live', 'prod'), env('live-eu', 'prod')], 'staging'),
    ).toEqual([])
  })

  it('prefers the slug production over the tier, even for a second prod environment', () => {
    expect(
      bound(
        [env('staging', 'nonprod'), env('production', 'prod'), env('live-eu', 'prod')],
        'staging',
      ),
    ).toEqual([['env.production', 'production']])
  })

  it('never takes a slug for a tier: an environment named prod is not the production shortcut', () => {
    expect(bound([env('staging', 'nonprod'), env('prod', 'nonprod')], 'staging')).toEqual([])
  })
})

describe('buildEnvironmentCommands', () => {
  const all = [env('development', 'nonprod'), env('staging', 'nonprod'), env('production', 'prod')]

  it('has one command per other environment, on the same page there', () => {
    const commands = buildEnvironmentCommands(TARGET, '/t/shop/platform/staging/locks', all)
    expect(commands.map((c) => [c.id, c.href, c.shortcut])).toEqual([
      ['env.switch.development', '/t/shop/platform/development/locks', 'env.development'],
      ['env.switch.production', '/t/shop/platform/production/locks', 'env.production'],
    ])
    expect(commands.map((c) => c.name)).toEqual(['Switch to development', 'Switch to production'])
  })

  it('registers none for a project with one environment', () => {
    expect(
      buildEnvironmentCommands(TARGET, '/t/shop/platform/staging', [env('staging', 'nonprod')]),
    ).toEqual([])
  })

  it('gives a second shortcut for the same environment a hidden entry of its own', () => {
    // The only environment with tier prod is also the one called staging.
    const dev = parseTargetParams({ product: 'shop', project: 'platform', environment: 'dev' })
    if (dev === undefined) throw new Error('fixture target is invalid')
    const commands = buildEnvironmentCommands(dev, '/t/shop/platform/dev', [
      env('dev', 'nonprod'),
      env('staging', 'prod'),
    ])
    expect(commands.map((c) => [c.id, c.shortcut, c.defaultHidden])).toEqual([
      ['env.switch.staging', 'env.production', undefined],
      ['env.switch.staging.env.staging', 'env.staging', true],
    ])
  })
})
