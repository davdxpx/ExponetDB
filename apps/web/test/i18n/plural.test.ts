import { afterEach, describe, expect, it } from 'vitest'
import { en } from '../../src/lib/i18n/en.ts'
import { t, useCatalog } from '../../src/lib/i18n/i18n.ts'

/**
 * TC-066 (W-08): "1 projects", "1 clusters on this server are not retired", "1 nodes of this
 * server are not decommissioned" and "1 active endpoints". A count message picks its form with
 * Intl.PluralRules instead of appending an "s".
 */
afterEach(() => useCatalog(en))

describe('a count in a message', () => {
  it.each([
    ['projects.count', { total: 1 }, '1 project'],
    ['projects.count', { total: 2 }, '2 projects'],
    ['projects.count', { total: 0 }, '0 projects'],
    ['infra.retire.group.cluster', { count: 1 }, '1 cluster on this server is not retired'],
    ['infra.retire.group.cluster', { count: 3 }, '3 clusters on this server are not retired'],
    ['infra.retire.group.node', { count: 1 }, '1 node of this server is not decommissioned'],
    ['infra.retire.group.node', { count: 2 }, '2 nodes of this server are not decommissioned'],
    ['infra.retire.with.endpoint', { count: 1 }, '1 active endpoint'],
    ['infra.retire.with.endpoint', { count: 4 }, '4 active endpoints'],
  ] as const)('%s %j reads "%s"', (key, params, text) => {
    expect(t(key, params)).toBe(text)
  })

  it('picks the form by the plural rules and fills # with the number', () => {
    useCatalog({ ...en, 'projects.count': '{n, plural, one {# apple} other {# apples}}' } as never)
    expect(t('projects.count', { n: 1 })).toBe('1 apple')
    expect(t('projects.count', { n: 5 })).toBe('5 apples')
  })
})
