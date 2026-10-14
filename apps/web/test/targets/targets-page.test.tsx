import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, iso, mountApp, targetFixture, World } from '../fleet/support.tsx'

afterEach(cleanup)

function seeded(): World {
  const world = new World()
  world.targetPages = [
    [
      targetFixture('shop/platform/production', { tier: 'prod' }),
      targetFixture('shop/platform/staging'),
      targetFixture('shop/billing/staging', {
        health: { state: 'unknown', source: 'inferred', observedAt: iso(600_000) },
      }),
      targetFixture('acme/core/production', {
        tier: 'prod',
        health: { state: 'unreachable', source: 'sampled', observedAt: iso(120_000) },
      }),
      targetFixture('acme/core/staging', { health: null }),
      targetFixture('acme/old/staging', { state: 'decommissioned' }),
    ],
  ]
  return world
}

const rowFor = (path: string): HTMLElement =>
  screen.getByRole('link', { name: `Open ${path}` }).closest('tr') as HTMLElement

describe('the targets list', () => {
  it('lists the targets with path, tier, state and health with its source and age', async () => {
    const world = seeded()
    mountApp('/targets', world)
    const table = await screen.findByRole('table', { name: 'Targets' })
    const production = within(table).getByRole('link', { name: 'Open shop/platform/production' })
    expect(production).toHaveAttribute('href', '/t/shop/platform/production')
    const row = rowFor('shop/platform/production')
    expect(row).toHaveAttribute('data-tier', 'prod')
    expect(row.querySelector('[data-tier="production"]')).not.toBeNull()
    expect(row.textContent).toContain('Healthy')
    expect(row.textContent).toContain('sampled')
    expect(row.textContent).toMatch(/sampled, [0-9]+ min ago/)
    // Decommissioned targets are out of the default view.
    expect(screen.queryByRole('link', { name: 'Open acme/old/staging' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 5 of 6 targets')
  })

  it('shows unknown, unreachable and missing health as such, never as healthy', async () => {
    mountApp('/targets', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    const unknown = rowFor('shop/billing/staging')
    expect(unknown.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(unknown.querySelector('[data-health="healthy"]')).toBeNull()
    expect(unknown.textContent).toContain('inferred')
    const down = rowFor('acme/core/production')
    expect(down.querySelector('[data-health="unreachable"]')).not.toBeNull()
    const none = rowFor('acme/core/staging')
    expect(none.querySelector('[data-health="none"]')).not.toBeNull()
    expect(none.textContent).toContain('No health sample')
    expect(none.querySelector('[data-health="healthy"]')).toBeNull()
  })

  it('makes one list request and no request per target (no N+1)', async () => {
    const world = seeded()
    mountApp('/targets', world)
    await screen.findByRole('table', { name: 'Targets' })
    expect(world.apiRequests.map((r) => r.path)).toEqual(['/api/v1/targets?limit=200'])
  })

  it('follows the cursor to the next page of the list', async () => {
    const world = new World()
    world.targetPages = [
      [targetFixture('shop/platform/production', { tier: 'prod' })],
      [targetFixture('shop/platform/staging')],
    ]
    mountApp('/targets', world)
    await screen.findByRole('link', { name: 'Open shop/platform/staging' })
    expect(screen.getByRole('link', { name: 'Open shop/platform/production' })).toBeInTheDocument()
    expect(world.gets('/api/v1/targets')).toHaveLength(2)
    expect(world.gets('/api/v1/targets')[1]?.path).toContain('cursor=c1')
  })

  it('says the list is partial when more targets exist than the pages it follows', async () => {
    const world = new World()
    world.targetPages = Array.from({ length: 6 }, (_, i) => [targetFixture(`shop/p${i}/staging`)])
    mountApp('/targets', world)
    expect(
      await screen.findByText(/More targets exist than the 1000 this page loads/),
    ).toBeInTheDocument()
    expect(world.gets('/api/v1/targets')).toHaveLength(5)
  })

  it('shows an old read as stale with its age and a refresh, keeping the targets', async () => {
    const world = seeded()
    const { queryClient } = mountApp('/targets', world)
    await screen.findByRole('table', { name: 'Targets' })
    world.failures.set('GET /api/v1/targets', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Showing an earlier read of .*Observed/,
      ),
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Targets' })).toBeInTheDocument()
  })

  it('shows a failed read as failed and never as an empty list', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/targets', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    mountApp('/targets', world)
    expect(await screen.findByText('The registry did not answer.')).toBeInTheDocument()
    expect(screen.getByText(/Could not read Target list/)).toBeInTheDocument()
    expect(screen.queryByText('No target is registered')).toBeNull()
    expect(screen.queryByText('No target matches')).toBeNull()
  })

  it('says the list is empty only after a successful read, and offers to register', async () => {
    mountApp('/targets', new World())
    expect(await screen.findByText('No target is registered')).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: 'Register target' })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toHaveAttribute('href', '/targets/register')
  })

  it('shows the loading state while the list is being read', async () => {
    const world = seeded()
    let release: () => void = () => {}
    world.delays.set('/api/v1/targets', new Promise<void>((resolve) => (release = resolve)))
    mountApp('/targets', world)
    expect(await screen.findAllByText(/Loading/)).not.toHaveLength(0)
    expect(screen.queryByText('No target is registered')).toBeNull()
    release()
    expect(await screen.findByRole('table', { name: 'Targets' })).toBeInTheDocument()
  })

  it('names the infrastructure entry points and says where their forms come from', async () => {
    mountApp('/targets', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    const nav = screen.getByRole('navigation', { name: 'Register' })
    expect(within(nav).getByRole('link', { name: 'Add server' })).toHaveAttribute(
      'href',
      '/infrastructure/servers',
    )
    expect(within(nav).getByRole('link', { name: 'Register cluster' })).toHaveAttribute(
      'href',
      '/infrastructure/clusters',
    )
    expect(within(nav).getByRole('link', { name: 'Enroll node' })).toHaveAttribute(
      'href',
      '/infrastructure/nodes',
    )
    expect(nav.textContent).toContain('come with the infrastructure screens')
  })
})

describe('search, filter and sort in the URL', () => {
  it('reads the filters from the URL', async () => {
    mountApp('/targets?q=billing&tier=nonprod', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    expect(screen.getByRole('link', { name: 'Open shop/billing/staging' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open shop/platform/staging' })).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search targets' })).toHaveValue('billing')
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 6 targets')
  })

  it('writes the search text and a filter to the URL', async () => {
    const { router } = mountApp('/targets', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search targets' }), {
      target: { value: 'acme' },
    })
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'acme' }))
    fireEvent.change(screen.getByLabelText('Tier'), { target: { value: 'prod' } })
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: 'acme', tier: 'prod' }),
    )
    expect(screen.getByRole('link', { name: 'Open acme/core/production' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open acme/core/staging' })).toBeNull()
  })

  it('filters by health, including targets with no sample', async () => {
    mountApp('/targets?health=none', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Open acme/core/staging' })).toBeInTheDocument()
  })

  it('shows decommissioned targets when the state filter asks for them', async () => {
    mountApp('/targets?state=decommissioned', seeded())
    expect(await screen.findByRole('link', { name: 'Open acme/old/staging' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open shop/platform/staging' })).toBeNull()
  })

  it('sorts worst health first and production first', async () => {
    mountApp('/targets?sort=health', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    const order = screen
      .getAllByRole('link', { name: /^Open / })
      .map((link) => link.getAttribute('aria-label'))
    // Unreachable first, then unknown, no sample next to it, healthy last.
    expect(order[0]).toBe('Open acme/core/production')
    expect(order.slice(-2)).toEqual(['Open shop/platform/production', 'Open shop/platform/staging'])
    cleanup()
    mountApp('/targets?sort=tier', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    const tiers = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.getAttribute('data-tier'))
    expect(tiers).toEqual(['prod', 'prod', 'nonprod', 'nonprod', 'nonprod'])
  })

  it('ignores values it does not know and a search text with control characters', async () => {
    const { router } = mountApp(
      `/targets?tier=evil&state=%27%3B&sort=zzz&view=iframe&health=%3Cb%3E&q=${encodeURIComponent(`x${BIDI}y`)}`,
      seeded(),
    )
    await screen.findByRole('table', { name: 'Targets' })
    const search = router.state.location.search as Record<string, unknown>
    for (const key of ['tier', 'state', 'sort', 'view', 'health', 'q'])
      expect(search[key]).toBeUndefined()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 5 of 6 targets')
    expect(screen.getByRole('searchbox', { name: 'Search targets' })).toHaveValue('')
  })

  it('says no target matches after a successful read, and clears the filters', async () => {
    mountApp('/targets?q=nothing-like-this', seeded())
    expect(await screen.findByText('No target matches')).toBeInTheDocument()
    expect(screen.getByText(/holds 6 targets, none of which match/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('table', { name: 'Targets' })).toBeInTheDocument()
  })

  it('shows the grid view', async () => {
    mountApp('/targets?view=grid', seeded())
    await screen.findByRole('link', { name: 'Open shop/platform/production' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true')
    const card = screen.getByRole('link', { name: 'Open shop/platform/production' }).closest('li')
    expect(card).toHaveAttribute('data-tier', 'prod')
    expect(card?.querySelector('[data-tier="production"]')).not.toBeNull()
  })
})

describe('hostile target names', () => {
  it('renders a path that is not three slugs as marked text, without a link', async () => {
    const world = new World()
    world.targetPages = [
      [
        targetFixture(`../evil${BIDI}/x/<script>alert(1)</script>`, {
          id: 'tgt_00000000000000000000000001',
        }),
        targetFixture('javascript:alert(1)//a/b', { id: 'tgt_00000000000000000000000002' }),
        targetFixture('shop/platform/staging'),
      ],
    ]
    mountApp('/targets', world)
    const table = await screen.findByRole('table', { name: 'Targets' })
    expect(within(table).getAllByRole('link')).toHaveLength(1)
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
    expect(table.textContent).toContain('<script>alert(1)</script>')
    expect(table.querySelector('script')).toBeNull()
    expect(table.textContent).toContain('Not linked')
  })

  it('shows a health source with hidden characters as marked text', async () => {
    const world = new World()
    world.targetPages = [
      [
        targetFixture('shop/platform/staging', {
          health: { state: 'healthy', source: `sam${BIDI}pled`, observedAt: iso(1000) },
        }),
      ],
    ]
    mountApp('/targets', world)
    const table = await screen.findByRole('table', { name: 'Targets' })
    expect(table.textContent).toContain('⟨U+202E⟩')
  })
})

describe('accessibility', () => {
  it('has no violations as a table', async () => {
    mountApp('/targets', seeded())
    await screen.findByRole('table', { name: 'Targets' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no violations as a grid, empty and failed', async () => {
    mountApp('/targets?view=grid', seeded())
    await screen.findByRole('link', { name: 'Open shop/platform/production' })
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    mountApp('/targets', new World())
    await screen.findByText('No target is registered')
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const failing = new World()
    failing.failures.set('GET /api/v1/targets', { status: 500, code: 'INTERNAL', message: 'Down.' })
    mountApp('/targets', failing)
    await screen.findByText('Down.')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
