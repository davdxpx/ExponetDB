import { SHORTCUT_DEFINITIONS } from '@exponetdb/ui-patterns'
import { describe, expect, it } from 'vitest'
import { safeReturnTo, TARGET_SECTIONS } from '../../src/lib/navigation/links.ts'
import {
  GLOBAL_NAV,
  isCurrent,
  NAV_SECTIONS,
  sectionMenu,
  sectionOf,
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
      '/access/oauth-clients',
      '/access/connected-apps',
      '/connect',
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
    // API keys live on the service accounts page: no page and no entry of their own.
    expect(GLOBAL_NAV.some((item) => item.path === '/access/api-keys')).toBe(false)
    // The connect page belongs to Access (its section menu and rail item are current there).
    expect(sectionOf('/connect')?.id).toBe('access')
    expect(sectionMenu('access').map((item) => item.path)).toContain('/connect')
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

  it('gives every rail section an icon, a shortcut and a page of its own', () => {
    expect(NAV_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'targets',
      'changes',
      'infrastructure',
      'backups',
      'access',
      'audit',
      'settings',
    ])
    for (const section of NAV_SECTIONS) {
      expect(section.icon, section.id).toBeDefined()
      expect(safeReturnTo(section.path), section.path).toBe(section.path)
      expect(
        GLOBAL_NAV.some((item) => item.section === section.id && item.path === section.path),
        section.id,
      ).toBe(true)
    }
  })

  it('finds the section of a path by whole segments, and lists the section pages', () => {
    expect(sectionOf('/')?.id).toBe('overview')
    expect(sectionOf('/t/shop/app/staging/sql')?.id).toBe('targets')
    expect(sectionOf('/approvals')?.id).toBe('changes')
    expect(sectionOf('/changes/plans/pln_1')?.id).toBe('changes')
    expect(sectionOf('/infrastructure/clusters')?.id).toBe('infrastructure')
    expect(sectionOf('/targetsx')).toBeUndefined()
    expect(sectionOf('/tx')).toBeUndefined()
    expect(sectionOf('/account')).toBeUndefined()
    expect(sectionMenu('targets')).toEqual([])
    expect(sectionMenu('infrastructure').map((i) => i.id)).toEqual([
      'servers',
      'clusters',
      'nodes',
      'certificates',
    ])
  })

  it('matches a page and the pages below it, never a sibling with the same prefix', () => {
    expect(isCurrent('/', '/')).toBe(true)
    expect(isCurrent('/', '/audit')).toBe(false)
    expect(isCurrent('/audit', '/audit')).toBe(true)
    expect(isCurrent('/changes', '/changes/plans/pln_1')).toBe(true)
    expect(isCurrent('/access/roles', '/access/roles-extra')).toBe(false)
  })

  it('uses each shortcut of the registry at most once, and only known ids', () => {
    const ids = [
      ...NAV_SECTIONS.map((s) => s.shortcut),
      ...GLOBAL_NAV.flatMap((i) => (i.shortcut === undefined ? [] : [i.shortcut])),
    ]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(SHORTCUT_DEFINITIONS).toHaveProperty(id)
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
