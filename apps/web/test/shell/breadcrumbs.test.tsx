import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { mountApp, project, World } from '../target/support.tsx'

afterEach(cleanup)

const ULID = `01M4S9${'0'.repeat(19)}A`

const crumbs = (): Promise<HTMLElement> => screen.findByRole('navigation', { name: 'Breadcrumb' })

function names(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

describe('the breadcrumbs of detail pages', () => {
  it.each([
    [
      `/changes/plans/pln_${ULID}`,
      ['Changes', 'Plans', `pln_${ULID}`],
      ['/changes', '/changes/plans'],
    ],
    [
      `/changes/operations/op_${ULID}`,
      ['Changes', 'Operations', `op_${ULID}`],
      ['/changes', '/changes/operations'],
    ],
    [
      `/infrastructure/servers/srv_${ULID}`,
      ['Infrastructure', 'Servers', `srv_${ULID}`],
      ['/infrastructure/servers'],
    ],
    [
      `/infrastructure/clusters/cls_${ULID}`,
      ['Infrastructure', 'Clusters', `cls_${ULID}`],
      ['/infrastructure/servers', '/infrastructure/clusters'],
    ],
    [
      `/infrastructure/nodes/nod_${ULID}`,
      ['Infrastructure', 'Nodes', `nod_${ULID}`],
      ['/infrastructure/servers', '/infrastructure/nodes'],
    ],
  ] as const)('shows the trail of %s, linking only the parents', async (path, labels, hrefs) => {
    mountApp(path, new World())
    const nav = await crumbs()
    expect(names(nav)).toEqual([...labels])
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([...hrefs])
    // The last crumb is the current page and is not a link.
    const current = within(nav).getByText(labels[2])
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.closest('a')).toBeNull()
  })

  it('shows the trail of a schema kind below its database', async () => {
    const world = new World()
    project(world)
    mountApp('/t/shop/platform/staging/schema/materialized-views', world)
    const nav = await crumbs()
    expect(names(nav)).toEqual([
      'Databases',
      'shop/platform/staging',
      'Schema',
      'materialized views',
    ])
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/targets', '/t/shop/platform/staging', '/t/shop/platform/staging/schema'])
  })

  it('goes to a parent page through the router when a crumb is followed', async () => {
    const user = userEvent.setup()
    const { router } = mountApp(`/changes/plans/pln_${ULID}`, new World())
    const nav = await crumbs()
    await user.click(within(nav).getByRole('link', { name: 'Plans' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/changes/plans'))
    await screen.findByRole('heading', { level: 1, name: 'Plans' })
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull()
  })

  it('draws the row inside the shell, above the page, beside the section menu', async () => {
    mountApp(`/changes/plans/pln_${ULID}`, new World())
    const nav = await crumbs()
    expect(screen.getByRole('main')).toContainElement(nav)
    expect(screen.getByRole('navigation', { name: 'Changes pages' })).toBeInTheDocument()
  })

  it.each([
    '/',
    '/changes/plans',
    '/changes/operations',
    '/infrastructure/servers',
    '/targets',
    '/t/shop/platform/staging',
    '/t/shop/platform/staging/locks',
    '/t/shop/platform/staging/schema',
  ])('has no breadcrumb row on %s, a page of its own list or section', async (path) => {
    const world = new World()
    project(world)
    mountApp(path, world)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull()
  })

  it.each([
    '/changes/plans/pln_short',
    `/changes/plans/op_${ULID}`,
    `/changes/operations/OP_${ULID}`,
    `/infrastructure/servers/${ULID}`,
    '/infrastructure/nodes/nod_%3Cscript%3E',
    '/t/shop/platform/staging/schema/public.users',
    '/t/Shop/platform/staging/schema/tables',
    '/t/shop/%3Cscript%3E/staging/schema/tables',
  ])(
    'shows no trail for %s, whose parameter fails its grammar, and nothing of the address',
    async (path) => {
      mountApp(path, new World())
      await screen.findByRole('heading', { name: 'Page not found' })
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull()
      expect(document.body.textContent).not.toContain('script')
    },
  )

  it('has no accessibility violations with the trail', async () => {
    mountApp(`/changes/operations/op_${ULID}`, new World())
    await crumbs()
    expect(await axeViolations()).toEqual([])
  })
})
