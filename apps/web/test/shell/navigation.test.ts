import { describe, expect, it } from 'vitest'
import { safeReturnTo, TARGET_SECTIONS } from '../../src/lib/navigation/links.ts'
import {
  GLOBAL_NAV,
  switchEnvironment,
  TARGET_NAV,
  targetHref,
} from '../../src/shell/navigation.ts'

describe('the navigation model', () => {
  it('lists every global section of the information architecture, each a safe return target', () => {
    for (const path of [
      '/',
      '/targets',
      '/changes',
      '/infrastructure/servers',
      '/infrastructure/clusters',
      '/infrastructure/nodes',
      '/infrastructure/certificates',
      '/backups',
      '/access/people',
      '/access/roles',
      '/access/service-accounts',
      '/access/api-keys',
      '/access/oauth-clients',
      '/access/connected-apps',
      '/audit',
      '/settings/products',
      '/settings/environments',
      '/settings/policies',
      '/settings/notifications',
      '/settings/installation',
    ]) {
      expect(
        GLOBAL_NAV.some((item) => item.path === path),
        path,
      ).toBe(true)
    }
    for (const item of GLOBAL_NAV) {
      expect(safeReturnTo(item.path), item.path).toBe(item.path)
    }
  })

  it('lists every target section once, each a safe return target', () => {
    expect(
      TARGET_NAV.map((s) => s.id)
        .filter((id) => id !== 'overview')
        .sort(),
    ).toEqual([...TARGET_SECTIONS].sort())
    for (const section of TARGET_NAV) {
      const href = targetHref(
        { product: 'shop', project: 'app', environment: 'staging' },
        section.suffix,
      )
      expect(safeReturnTo(href), href).toBe(href)
    }
  })

  it('marks the Wave 9 pages and the OD-21 page with their named requirement', () => {
    expect(GLOBAL_NAV.filter((i) => i.wave === '9').map((i) => i.id)).toEqual(['backups'])
    expect(TARGET_NAV.filter((i) => i.wave === '9').map((i) => i.id)).toEqual([
      'performance',
      'backups',
      'advisors',
    ])
    expect(GLOBAL_NAV.find((i) => i.id === 'notifications')?.requires).toEqual(['od21'])
  })

  it('has unique shortcut keys per level', () => {
    for (const list of [GLOBAL_NAV, TARGET_NAV]) {
      const keys = list.flatMap((i) => (i.shortcut === undefined ? [] : [i.shortcut]))
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('keeps the page when switching environment, but never an object name', () => {
    expect(switchEnvironment('/t/shop/app/staging/schema/indexes', 'production')).toBe(
      '/t/shop/app/production/schema/indexes',
    )
    expect(switchEnvironment('/t/shop/app/staging/schema/tables/public.users', 'production')).toBe(
      '/t/shop/app/production/schema/tables',
    )
    expect(switchEnvironment('/t/shop/app/staging/sql', 'dev')).toBe('/t/shop/app/dev/sql')
    expect(switchEnvironment('/t/shop/app/staging', 'dev')).toBe('/t/shop/app/dev')
    expect(switchEnvironment('/t/shop/app/staging/unknown', 'dev')).toBe('/t/shop/app/dev')
    expect(switchEnvironment('/targets', 'dev')).toBeUndefined()
  })
})
