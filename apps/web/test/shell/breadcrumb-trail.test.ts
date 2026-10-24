import { describe, expect, it } from 'vitest'
import { breadcrumbTrail } from '../../src/shell/breadcrumb-trail.ts'

const ULID = `01M4S9${'0'.repeat(19)}A`

describe('the breadcrumb trail of a detail page', () => {
  it('names the plan page: Changes, Plans, then the typed id as the current page', () => {
    expect(breadcrumbTrail('/_app/changes/plans/$planId', { planId: `pln_${ULID}` })).toEqual([
      { label: 'Changes', href: '/changes' },
      { label: 'Plans', href: '/changes/plans' },
      { label: `pln_${ULID}` },
    ])
  })

  it('names the operation page', () => {
    expect(
      breadcrumbTrail('/_app/changes/operations/$operationId', { operationId: `op_${ULID}` }),
    ).toEqual([
      { label: 'Changes', href: '/changes' },
      { label: 'Operations', href: '/changes/operations' },
      { label: `op_${ULID}` },
    ])
  })

  it('names the infrastructure pages, and shows the section as text where it would link to the next crumb', () => {
    expect(
      breadcrumbTrail('/_app/infrastructure/servers/$serverId', { serverId: `srv_${ULID}` }),
    ).toEqual([
      { label: 'Infrastructure' },
      { label: 'Servers', href: '/infrastructure/servers' },
      { label: `srv_${ULID}` },
    ])
    expect(
      breadcrumbTrail('/_app/infrastructure/clusters/$clusterId', { clusterId: `cls_${ULID}` }),
    ).toEqual([
      { label: 'Infrastructure', href: '/infrastructure/servers' },
      { label: 'Clusters', href: '/infrastructure/clusters' },
      { label: `cls_${ULID}` },
    ])
    expect(
      breadcrumbTrail('/_app/infrastructure/nodes/$nodeId', { nodeId: `nod_${ULID}` }),
    ).toEqual([
      { label: 'Infrastructure', href: '/infrastructure/servers' },
      { label: 'Nodes', href: '/infrastructure/nodes' },
      { label: `nod_${ULID}` },
    ])
  })

  it('names the schema kind page below the database: Databases, the path, Schema, the kind', () => {
    expect(
      breadcrumbTrail('/_app/t/$product/$project/$environment/schema/$kind', {
        product: 'shop',
        project: 'platform',
        environment: 'staging',
        kind: 'materialized-views',
      }),
    ).toEqual([
      { label: 'Databases', href: '/targets' },
      { label: 'shop/platform/staging', href: '/t/shop/platform/staging' },
      { label: 'Schema', href: '/t/shop/platform/staging/schema' },
      { label: 'materialized views' },
    ])
  })

  it('has no trail for a list page, a section page or an unknown route', () => {
    expect(breadcrumbTrail('/_app/changes/plans/', {})).toBeUndefined()
    expect(breadcrumbTrail('/_app/t/$product/$project/$environment/locks', {})).toBeUndefined()
    expect(breadcrumbTrail('/_app/', {})).toBeUndefined()
    expect(breadcrumbTrail('__proto__', {})).toBeUndefined()
    expect(breadcrumbTrail('constructor', {})).toBeUndefined()
  })

  it('has no trail when an id fails its grammar, so nothing of the address is shown', () => {
    for (const planId of [
      'pln_short',
      `op_${ULID}`,
      `pln_${ULID}x`,
      `pln_${ULID.toLowerCase()}`,
      `pln_${ULID}<script>`,
      `pln_${ULID}‮`,
      '',
      undefined,
      7,
    ]) {
      expect(
        breadcrumbTrail('/_app/changes/plans/$planId', { planId }),
        String(planId),
      ).toBeUndefined()
    }
  })

  it('has no trail when a slug or the kind fails its grammar', () => {
    const base = { product: 'shop', project: 'platform', environment: 'staging', kind: 'tables' }
    const route = '/_app/t/$product/$project/$environment/schema/$kind'
    expect(breadcrumbTrail(route, base)).toHaveLength(4)
    for (const over of [
      { product: 'Shop' },
      { project: '<script>' },
      { environment: 'staging​' },
      { environment: undefined },
      { kind: 'public.users' },
      { kind: '..' },
      { kind: undefined },
    ]) {
      expect(breadcrumbTrail(route, { ...base, ...over }), JSON.stringify(over)).toBeUndefined()
    }
  })
})
