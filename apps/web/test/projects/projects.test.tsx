import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  filterProjects,
  projectRows,
  projectsSearch,
  streamRows,
} from '../../src/features/projects/model.ts'
import {
  BIDI,
  CLUSTER,
  iso,
  mountApp,
  targetDetailFixture,
  targetFixture,
  World,
} from '../fleet/support.tsx'

afterEach(cleanup)

const PROJECT = 'prj_01M4S9000000000000000000J1'
const PRODUCT = 'prd_01M4S9000000000000000000P1'

function projectTarget(path: string, over: Parameters<typeof targetFixture>[1] = {}) {
  return targetFixture(path, { projectId: PROJECT, productId: PRODUCT, ...over })
}

function worldWithProject(): World {
  const world = new World()
  world.targetPages = [
    [
      projectTarget('shop/platform/staging', {
        health: { state: 'degraded', source: 'sampled', observedAt: iso(60_000) },
      }),
      projectTarget('shop/platform/production', { tier: 'prod' }),
    ],
  ]
  return world
}

function streamFixture() {
  const cell = (environment: string, state: string) => ({
    environment,
    state,
    checksum: null,
    checksumMatches: null,
    appliedAt: null,
    verification: null,
    observedAt: null,
  })
  return {
    projectId: PROJECT,
    graph: { valid: true, errors: [] },
    heads: ['01M4S90000000000000000000B'],
    baselines: [],
    bundles: [
      {
        migrationId: '01M4S90000000000000000000A',
        name: 'create_orders',
        revision: 1,
        checksum: `sha256:c1:${'a'.repeat(64)}`,
        dependsOn: [],
        states: [cell('staging', 'verified'), cell('production', 'verified')],
      },
      {
        migrationId: '01M4S90000000000000000000B',
        name: 'add_index',
        revision: 1,
        checksum: `sha256:c1:${'b'.repeat(64)}`,
        dependsOn: ['01M4S90000000000000000000A'],
        states: [cell('staging', 'applied'), cell('production', 'not_applied')],
      },
    ],
    bundleCount: 2,
    truncated: false,
    environments: [
      {
        slug: 'staging',
        displayName: 'Staging',
        tier: 'nonprod',
        evidenceFrom: null,
        rank: 1,
        target: {
          id: 'tgt_01M4S9000000000000000000T1',
          path: 'shop/platform/staging',
          lifecycle: 'active',
          generation: 1,
        },
        mirror: null,
      },
      {
        slug: 'production',
        displayName: 'Production',
        tier: 'prod',
        evidenceFrom: 'staging',
        rank: 2,
        target: null,
        mirror: null,
      },
    ],
  }
}

describe('the projects model', () => {
  it('drops search values outside the grammar and keeps the rest', () => {
    expect(projectsSearch({ q: 'orders', product: 'shop', view: 'table', page: '3' })).toEqual({
      q: 'orders',
      product: 'shop',
      view: 'table',
      page: 3,
    })
    expect(projectsSearch({ q: '   ', product: 'Shop!', view: 'cards', page: '-1' })).toEqual({
      q: undefined,
      product: undefined,
      view: undefined,
      page: undefined,
    })
    // Dropped, never shortened, like the targets search; so is a direction override.
    expect(projectsSearch({ q: 'x'.repeat(500) }).q).toBeUndefined()
    expect(projectsSearch({ q: 'shop\u202e' }).q).toBeUndefined()
    expect(projectsSearch({ q: 2024 }).q).toBe('2024')
  })

  it('joins projects with their product and the environments read, without a read per project', () => {
    const world = worldWithProject()
    const rows = projectRows(world.projects, world.products, world.targetPages[0])
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.productName).toBe('Shop')
    expect(row?.environments.map((e) => e.slug)).toEqual(['staging', 'production'])
    // A degraded staging needs a person; a healthy production does not.
    expect(row?.attention).toBe(1)
    expect(row?.worst).toBe('degraded')
    expect(filterProjects(rows, { q: 'PLAT' })).toHaveLength(1)
    expect(filterProjects(rows, { product: 'other' })).toHaveLength(0)
  })

  it('counts a stream cell the mirror holds nothing for as unknown, never as not applied', () => {
    const rows = streamRows({
      environments: [{ slug: 'staging', tier: 'nonprod', target: null }],
      bundles: [{ states: [] }, { states: [{ environment: 'staging', state: 'something_new' }] }],
    })
    expect(rows[0]).toMatchObject({ unknown: 2, notApplied: 0 })
  })
})

describe('the projects portfolio', () => {
  it('shows each project as one card that is a link to its home, with environments and health', async () => {
    const world = worldWithProject()
    mountApp('/projects', world)
    const list = await screen.findByRole('list', { name: 'Projects' })
    const card = within(list).getByRole('link')
    expect(card).toHaveAttribute('href', '/p/shop/platform')
    expect(card).toHaveTextContent('Platform')
    expect(card).toHaveTextContent('shop/platform')
    expect(
      card.querySelector('[data-environment="staging"] [data-health="degraded"]'),
    ).not.toBeNull()
    expect(card.querySelector('a a, a button')).toBeNull()
    expect(card).toHaveTextContent('1 needs attention')
    // Three reads, whatever the number of projects.
    expect(world.gets('/api/v1/projects')).toHaveLength(1)
    expect(world.gets('/api/v1/products')).toHaveLength(1)
    expect(world.gets('/api/v1/targets')).toHaveLength(1)
  })

  it('never takes an unchecked value from the address (the router merges raw parent search)', async () => {
    const { router } = mountApp('/projects?view=evil&page=abc&product=Shop!', worldWithProject())
    await screen.findByRole('list', { name: 'Projects' })
    const search = router.state.matches.at(-1)?.search as Record<string, unknown>
    expect(search['view']).toBeUndefined()
    expect(search['page']).toBeUndefined()
    expect(search['product']).toBeUndefined()
  })

  it('keeps the search in the address and says when nothing matches', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/projects', worldWithProject())
    await screen.findByRole('list', { name: 'Projects' })
    await user.type(screen.getByRole('searchbox', { name: 'Search projects' }), 'nothing')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'nothing' }))
    expect(await screen.findByText('No project matches this search.')).toBeVisible()
    expect(screen.getByText('0 of 1 projects match')).toHaveAttribute('role', 'status')
    cleanup()
    // A product the read has no project of is shown as the filter in force, not as "All".
    mountApp('/projects?product=billing', worldWithProject())
    await screen.findByText('No project matches this search.')
    expect((screen.getByLabelText('Product') as HTMLSelectElement).value).toBe('billing')
    await user.click(screen.getByRole('button', { name: 'Reset the search' }))
    expect(await screen.findByRole('list', { name: 'Projects' })).toBeVisible()
  })

  it('shows a table when the address asks for it', async () => {
    mountApp('/projects?view=table', worldWithProject())
    const table = await screen.findByRole('table', { name: 'Projects, by path' })
    expect(within(table).getByRole('link', { name: /Platform/ })).toHaveAttribute(
      'href',
      '/p/shop/platform',
    )
  })

  it('divides a long list into pages and says the pages divide one read', async () => {
    const world = new World()
    world.projects = Array.from({ length: 30 }, (_, i) => ({
      ...world.projects[0],
      id: `prj_01M4S900000000000000000${String(i).padStart(3, '0')}`,
      slug: `p${String(i).padStart(2, '0')}`,
      path: `shop/p${String(i).padStart(2, '0')}`,
      displayName: `Project ${i}`,
    })) as World['projects']
    mountApp('/projects?page=2', world)
    const pager = await screen.findByRole('navigation', { name: 'Project pages' })
    expect(pager).toHaveTextContent('25–30 of 30')
    expect(pager).toHaveTextContent('All 30 come from one read of the list')
    expect(
      within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('link'),
    ).toHaveLength(6)
  })

  it('names what is missing when more projects exist than the page reads (partial)', async () => {
    const world = worldWithProject()
    world.projectsMore = true
    mountApp('/projects', world)
    expect(
      await screen.findByText(/More projects exist than the 1,000 this page reads/),
    ).toBeVisible()
  })

  it('says no project is registered only after a successful read (empty)', async () => {
    const world = new World()
    world.projects = []
    mountApp('/projects', world)
    expect(
      await screen.findByText('The read succeeded and no project is registered yet.'),
    ).toBeVisible()
  })

  it('shows a failed read as failed, never as no project', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/projects', { status: 500, code: 'INTERNAL', message: 'Down.' })
    mountApp('/projects', world)
    expect(await screen.findByText(/Could not read Projects/)).toBeVisible()
    expect(screen.queryByText('The read succeeded and no project is registered yet.')).toBeNull()
  })

  it('says the cards show no health when the environments could not be read, not that there are none', async () => {
    const world = worldWithProject()
    world.failures.set('GET /api/v1/targets', { status: 500, code: 'INTERNAL', message: 'Down.' })
    mountApp('/projects', world)
    expect(await screen.findByText(/The environments could not be read/)).toBeVisible()
    const card = within(screen.getByRole('list', { name: 'Projects' })).getByRole('link')
    expect(card).toHaveTextContent('Environments not read')
    expect(card).not.toHaveTextContent('No database registered yet')
    expect(card).not.toHaveTextContent('Nothing needs attention')
  })

  it('counts environments as a floor when the target read was cut (partial)', async () => {
    const world = worldWithProject()
    world.targetPages = [...world.targetPages, [], [], [], [], []]
    mountApp('/projects', world)
    const list = await screen.findByRole('list', { name: 'Projects' })
    const card = within(list).getByRole('link')
    expect(card).toHaveTextContent('At least 2 environments')
    expect(card).toHaveTextContent('At least 1 needs attention')
  })

  it('shows an earlier read as stale after a refresh failed (old), keeping the cards', async () => {
    const world = worldWithProject()
    const { queryClient } = mountApp('/projects', world)
    await screen.findByRole('list', { name: 'Projects' })
    world.failures.set('GET /api/v1/projects', { status: 500, code: 'INTERNAL', message: 'Down.' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['registry', 'projects'] })
    })
    await waitFor(() => expect(document.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(screen.getByRole('list', { name: 'Projects' })).toBeVisible()
  })

  it('renders hostile names as marked text', async () => {
    const world = worldWithProject()
    world.projects = [
      { ...world.projects[0], displayName: `Evil${BIDI}<b>x</b>` },
    ] as World['projects']
    mountApp('/projects', world)
    const card = within(await screen.findByRole('list', { name: 'Projects' })).getByRole('link')
    expect(card.textContent).toContain('⟨U+202E⟩')
    expect(card.innerHTML).not.toContain('<b>')
  })

  it('has no accessibility violations', async () => {
    mountApp('/projects', worldWithProject())
    await screen.findByRole('list', { name: 'Projects' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe("a project's home", () => {
  function homeWorld(): World {
    const world = worldWithProject()
    world.streams.set(PROJECT, streamFixture())
    for (const target of world.targetPages[0] ?? []) {
      world.targetDetails.set(target.path, targetDetailFixture(target))
    }
    return world
  }

  it('moves the focus to the first card "Show all" revealed, and says when a search matches none', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.targetPages = [
      Array.from({ length: 14 }, (_, i) =>
        projectTarget(`shop/platform/env-${String(i).padStart(2, '0')}`),
      ),
    ]
    mountApp('/p/shop/platform', world)
    const list = await screen.findByRole('list', { name: 'Environments' })
    expect(within(list).getAllByRole('link')).toHaveLength(12)
    await user.click(screen.getByRole('button', { name: /^Show all/ }))
    expect(within(list).getAllByRole('link')).toHaveLength(14)
    expect(within(list).getAllByRole('link')[12]).toHaveFocus()
    await user.type(screen.getByRole('searchbox'), 'nothing')
    expect(screen.getByText('No environment matches the search.')).toBeVisible()
    expect(screen.getByText('0 of 14 environments shown')).toHaveAttribute('role', 'status')
  })

  it('shows the environments as cards that link to each target, production marked', async () => {
    mountApp('/p/shop/platform', homeWorld())
    const list = await screen.findByRole('list', { name: 'Environments' })
    const production = within(list).getByRole('link', {
      name: /^production.*shop\/platform\/production/,
    })
    expect(production).toHaveAttribute('href', '/t/shop/platform/production')
    expect(production).toHaveAttribute('data-tone', 'production')
    expect(
      within(list).getByRole('link', { name: /^staging.*shop\/platform\/staging/ }),
    ).toHaveAttribute('data-tone', 'neutral')
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Platform')
  })

  it('summarizes the migration stream per environment, an unmirrored cell as unknown', async () => {
    mountApp('/p/shop/platform', homeWorld())
    const staging = await waitFor(() => {
      const row = document.querySelector('[data-stream-environment="staging"]')
      if (row === null) throw new Error('no stream row yet')
      return row as HTMLElement
    })
    expect(within(staging).getByRole('link', { name: 'staging' })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/migrations',
    )
    const cells = [...staging.querySelectorAll('td')].map((cell) => cell.textContent)
    expect(cells.slice(1)).toEqual(['1', '1', '0', '0', '0'])
    expect(screen.getByRole('link', { name: 'Open the promotion view' })).toBeVisible()
  })

  it('shows where the environments run, one card per cluster linking to it', async () => {
    mountApp('/p/shop/platform', homeWorld())
    const list = await screen.findByRole('list', { name: 'Where it runs' })
    const card = within(list).getByRole('link')
    expect(card).toHaveAttribute('href', `/infrastructure/clusters/${CLUSTER}`)
    expect(card).toHaveTextContent('Main cluster')
    expect(card).toHaveTextContent('Hosts staging, production')
  })

  it('counts environments whose record could not be read, never drops them (failed)', async () => {
    const world = homeWorld()
    world.targetDetails.delete('shop/platform/production')
    mountApp('/p/shop/platform', world)
    expect(await screen.findByText('1 environment could not be read')).toBeVisible()
  })

  it('says no database is registered only after a successful read (empty)', async () => {
    const world = new World()
    world.targetPages = [[]]
    mountApp('/p/shop/platform', world)
    expect(
      await screen.findByText(
        'The read succeeded and no database of this project is registered yet.',
      ),
    ).toBeVisible()
  })

  it('is not found for a project the complete read does not hold, and for bad slugs', async () => {
    mountApp('/p/shop/unknown', new World())
    expect(await screen.findByText(/page not found/i)).toBeVisible()
    cleanup()
    const world = new World()
    mountApp('/p/Shop/x', world)
    expect(await screen.findByText(/page not found/i)).toBeVisible()
    expect(world.gets('/api/v1/projects')).toHaveLength(0)
  })

  it('reads the projects again before calling a project missing from a cached list not found', async () => {
    const world = new World()
    const { router } = mountApp('/projects', world)
    await screen.findByRole('list', { name: 'Projects' })
    // Registered after the portfolio read; the cached list (fresh for 15 s) does not hold it.
    world.projects = [
      ...world.projects,
      {
        ...world.projects[0],
        id: 'prj_01M4S9000000000000000000J2',
        slug: 'billing',
        displayName: 'Billing',
        path: 'shop/billing',
      } as (typeof world.projects)[number],
    ]
    await router.navigate({
      to: '/p/$product/$project',
      params: { product: 'shop', project: 'billing' },
    })
    expect(await screen.findByRole('heading', { level: 1, name: /Billing/ })).toBeVisible()
    expect(screen.queryByText(/page not found/i)).toBeNull()
  })

  it('names what is missing when the project is beyond the projects read (partial, cut)', async () => {
    const world = new World()
    world.projectsMore = true
    mountApp('/p/shop/unknown', world)
    expect(await screen.findByText(/This project is not among the 1,000 projects/)).toBeVisible()
  })

  it('has a breadcrumb back to the portfolio and no accessibility violations', async () => {
    mountApp('/p/shop/platform', homeWorld())
    await screen.findByRole('list', { name: 'Environments' })
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i })
    expect(within(crumbs).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
