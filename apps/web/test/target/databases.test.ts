import type { TargetSummary } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import { recentDatabases, toDatabaseGroups } from '../../src/features/target/databases.ts'

function summary(path: string, over: Partial<TargetSummary> = {}): TargetSummary {
  return {
    id: `tgt_${path.length.toString().padStart(26, '0')}`,
    path,
    productId: 'prd_00000000000000000000000001',
    projectId: 'prj_00000000000000000000000001',
    environmentId: 'env_00000000000000000000000001',
    tier: 'nonprod',
    state: 'active',
    generation: 1,
    health: null,
    ...over,
  }
}

describe('the databases of the switcher', () => {
  it('groups by product and project, nonproduction first, then by environment', () => {
    const groups = toDatabaseGroups({
      items: [
        summary('shop/platform/production', { tier: 'prod' }),
        summary('shop/platform/staging'),
        summary('shop/platform/development'),
        summary('billing/api/staging'),
        summary('shop/admin/staging'),
      ],
      more: false,
    })
    expect(groups.groups.map((g) => g.key)).toEqual(['billing/api', 'shop/admin', 'shop/platform'])
    expect(groups.groups[2]?.databases.map((d) => d.route.environment)).toEqual([
      'development',
      'staging',
      'production',
    ])
    expect(groups.missing).toEqual([])
    expect(groups.truncated).toBe(false)
  })

  it('takes the tier from the field and never from the slug', () => {
    const { byPath } = toDatabaseGroups({
      items: [
        summary('shop/platform/prod', { tier: 'nonprod' }),
        summary('shop/platform/live', { tier: 'prod' }),
      ],
      more: false,
    })
    expect(byPath.get('shop/platform/prod')?.tier).toBe('nonprod')
    expect(byPath.get('shop/platform/live')?.tier).toBe('prod')
  })

  it('leaves out a path that is not three slugs, and says that some were left out', () => {
    const groups = toDatabaseGroups({
      items: [
        summary('shop/platform/staging'),
        summary('Shop/platform/<script>alert(1)</script>'),
        summary('shop/platform/staging‮evil'),
        summary('shop/platform'),
        summary('shop/platform/staging'),
      ],
      more: false,
    })
    expect([...groups.byPath.keys()]).toEqual(['shop/platform/staging'])
    expect(groups.missing).toEqual(['Some databases have a path the page cannot show.'])
  })

  it('says that more databases exist than the read followed', () => {
    const groups = toDatabaseGroups({ items: [summary('shop/platform/staging')], more: true })
    expect(groups.truncated).toBe(true)
    expect(groups.missing).toEqual([
      'More databases exist than one read returns. Open the Databases page for the rest.',
    ])
  })

  it('is empty for an empty list, which the caller says only after a successful read', () => {
    const groups = toDatabaseGroups({ items: [], more: false })
    expect(groups.groups).toEqual([])
    expect(groups.missing).toEqual([])
  })
})

describe('the recent databases', () => {
  const list = toDatabaseGroups({
    items: [
      summary('shop/platform/staging'),
      summary('shop/platform/production', { tier: 'prod' }),
    ],
    more: false,
  })

  it('keeps the order of the person and what the list says about each', () => {
    const recent = recentDatabases(['shop/platform/production', 'shop/platform/staging'], list)
    expect(recent.map((r) => [r.path, r.database?.tier])).toEqual([
      ['shop/platform/production', 'prod'],
      ['shop/platform/staging', 'nonprod'],
    ])
  })

  it('drops a database a complete list does not hold (it is gone or no longer visible)', () => {
    expect(recentDatabases(['shop/platform/gone', 'shop/platform/staging'], list)).toHaveLength(1)
  })

  it('keeps it, with the tier unknown, when the list is only part of the databases', () => {
    const partial = toDatabaseGroups({ items: [summary('shop/platform/staging')], more: true })
    const recent = recentDatabases(['shop/platform/elsewhere'], partial)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.database).toBeUndefined()
    expect(recent[0]?.route.path).toBe('shop/platform/elsewhere')
  })

  it('ignores a path that is not three slugs', () => {
    expect(
      recentDatabases(['<script>', '../x'], toDatabaseGroups({ items: [], more: true })),
    ).toEqual([])
  })
})
