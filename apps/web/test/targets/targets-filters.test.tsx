import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { iso, mountApp, targetFixture, World } from '../fleet/support.tsx'

// The sort and the view a person chooses are remembered by the browser: no test starts with another's.
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

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
    ],
  ]
  return world
}

function project(id: number, productId: string, path: string) {
  const [, slug = ''] = path.split('/')
  return {
    id: `prj_01M4S9000000000000000000J${id}`,
    productId,
    slug,
    displayName: slug,
    path,
    revision: 1,
    evidenceOverride: {},
    managedScope: { includeSchemas: null, excludeSchemas: [] },
  }
}

function twoProducts(): World {
  const world = seeded()
  const shop = 'prd_01M4S9000000000000000000P1'
  const acme = 'prd_01M4S9000000000000000000P2'
  world.products = [
    { id: shop, slug: 'shop', displayName: 'Shop' },
    { id: acme, slug: 'acme', displayName: 'Acme' },
  ]
  world.projects = [
    project(1, shop, 'shop/platform'),
    project(2, shop, 'shop/billing'),
    project(3, acme, 'acme/core'),
  ]
  return world
}

async function ready(): Promise<void> {
  await screen.findByRole('table', { name: 'Targets' })
}

describe('the product and project filters', () => {
  it('asks the server for the targets of one product and project and keeps them in the address', async () => {
    const world = twoProducts()
    mountApp('/targets?product=shop&project=platform', world)
    await ready()
    expect(world.gets('/api/v1/targets')[0]?.path).toBe(
      '/api/v1/targets?limit=200&product=shop&project=platform',
    )
    expect(screen.getByRole('link', { name: 'Open shop/platform/staging' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open shop/billing/staging' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open acme/core/staging' })).toBeNull()
    await waitFor(() => expect(screen.getByLabelText('Product')).toHaveValue('shop'))
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('platform'))
  })

  it('offers the projects of the chosen product only, and drops a project when the product changes', async () => {
    const world = twoProducts()
    const { router } = mountApp('/targets', world)
    await ready()
    const project = screen.getByLabelText('Project')
    expect(project).toBeDisabled()
    expect(
      within(project).getByRole('option', { name: 'Choose a product first' }),
    ).toBeInTheDocument()
    const product = await screen.findByLabelText('Product')
    await waitFor(() => expect(within(product).getAllByRole('option')).toHaveLength(3))
    fireEvent.change(product, { target: { value: 'shop' } })
    await waitFor(() => expect(router.state.location.search).toMatchObject({ product: 'shop' }))
    await waitFor(() => expect(screen.getByLabelText('Project')).not.toBeDisabled())
    const options = within(screen.getByLabelText('Project'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['All projects', 'platform', 'billing'])
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'billing' } })
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ product: 'shop', project: 'billing' }),
    )
    await waitFor(() =>
      expect(world.gets('/api/v1/targets').some((r) => r.path.includes('project=billing'))).toBe(
        true,
      ),
    )
    expect(
      await screen.findByRole('link', { name: 'Open shop/billing/staging' }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'acme' } })
    await waitFor(() => expect(router.state.location.search).toMatchObject({ product: 'acme' }))
    expect((router.state.location.search as Record<string, unknown>)['project']).toBeUndefined()
    expect(
      await screen.findByRole('link', { name: 'Open acme/core/production' }),
    ).toBeInTheDocument()
  })

  it('keeps the toolbar, and the control that was used, while the list for a new filter is read', async () => {
    const world = twoProducts()
    mountApp('/targets', world)
    await ready()
    const product = await screen.findByLabelText('Product')
    await waitFor(() => expect(within(product).getAllByRole('option')).toHaveLength(3))
    let release: () => void = () => {}
    world.delays.set('product=shop', new Promise<void>((resolve) => (release = resolve)))
    product.focus()
    fireEvent.change(product, { target: { value: 'shop' } })
    expect((await screen.findAllByText(/Loading/)).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Product')).toBe(product)
    expect(product).toHaveFocus()
    release()
    await ready()
    expect(screen.getByLabelText('Product')).toBe(product)
  })

  it('ignores a project in the address that comes without its product, and values that are not slugs', async () => {
    const world = twoProducts()
    const { router } = mountApp('/targets?project=platform&product=Not%20A%20Slug', world)
    await ready()
    const search = router.state.location.search as Record<string, unknown>
    expect(search['project']).toBeUndefined()
    expect(search['product']).toBeUndefined()
    expect(world.gets('/api/v1/targets')[0]?.path).toBe('/api/v1/targets?limit=200')
  })

  it('says the server lists no target for a product after a successful empty read, not that nothing is registered', async () => {
    const world = twoProducts()
    mountApp('/targets?product=nothing', world)
    expect(await screen.findByText('No target matches')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The read succeeded and the server lists no target for this product and project.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('No target is registered')).toBeNull()
    // The address names a product the list does not know: it stays visible, marked.
    expect(
      await within(screen.getByLabelText('Product')).findByRole('option', {
        name: 'nothing (not in the list)',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('table', { name: 'Targets' })).toBeInTheDocument()
  })

  it('shows a failed read of the product list as failed, keeps the list and never claims there are no products', async () => {
    const world = twoProducts()
    world.failures.set('GET /api/v1/products', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    mountApp('/targets?product=shop', world)
    await ready()
    expect(
      await screen.findByText(
        /Could not read products: The registry did not answer\. \(INTERNAL\)/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/no product is registered/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // The address still says shop, and the list is the one of shop.
    expect(screen.getByLabelText('Product')).toHaveValue('shop')
    expect(screen.getByRole('link', { name: 'Open shop/platform/staging' })).toBeInTheDocument()
  })

  it('shows an earlier read of the product list as stale with a refresh', async () => {
    const world = twoProducts()
    const { queryClient } = mountApp('/targets', world)
    await ready()
    await waitFor(() =>
      expect(within(screen.getByLabelText('Product')).getAllByRole('option')).toHaveLength(3),
    )
    world.failures.set('GET /api/v1/products', { status: 500, code: 'INTERNAL', message: 'Down.' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['registry', 'products'] })
    })
    expect(await screen.findByText('Showing an earlier read of products.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(within(screen.getByLabelText('Product')).getAllByRole('option')).toHaveLength(3)
  })

  it('says the product list is partial when more products exist than it follows', async () => {
    const world = twoProducts()
    world.productsMore = true
    mountApp('/targets', world)
    await ready()
    expect(await screen.findByText('More products exist than this list shows.')).toBeInTheDocument()
    expect(world.gets('/api/v1/products')).toHaveLength(5)
  })

  it('says no product is registered only after a successful read of an empty list', async () => {
    const world = twoProducts()
    world.products = []
    mountApp('/targets', world)
    await ready()
    expect(
      await screen.findByText('The read succeeded and no product is registered.'),
    ).toBeInTheDocument()
  })
})

function clipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async (_text: string) => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  return writeText
}

describe('the row menu', () => {
  it('copies the path and the id of the target of the row', async () => {
    const user = userEvent.setup()
    const writeText = clipboard()
    mountApp('/targets', seeded())
    await ready()
    const staging = targetFixture('shop/platform/staging')
    await user.click(screen.getByRole('button', { name: 'Actions for shop/platform/staging' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy path' }))
    expect(writeText).toHaveBeenLastCalledWith('shop/platform/staging')
    expect(await screen.findByText('Target path copied')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions for shop/platform/staging' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy target ID' }))
    expect(writeText).toHaveBeenLastCalledWith(staging.id)
    expect(await screen.findByText('Target ID copied')).toBeInTheDocument()
  })

  it('says so when the clipboard refuses', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mountApp('/targets', seeded())
    await ready()
    await user.click(screen.getByRole('button', { name: 'Actions for shop/platform/staging' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy path' }))
    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
  })

  it('is in the grid view too', async () => {
    const user = userEvent.setup()
    const writeText = clipboard()
    mountApp('/targets?view=grid', seeded())
    await screen.findByRole('link', { name: 'Open shop/platform/staging' })
    await user.click(screen.getByRole('button', { name: 'Actions for shop/platform/staging' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy path' }))
    expect(writeText).toHaveBeenLastCalledWith('shop/platform/staging')
  })
})

describe('the view and sort this browser remembers', () => {
  it('remembers a chosen view and starts the next list with it', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/targets', seeded())
    await ready()
    await user.click(screen.getByRole('button', { name: 'Grid' }))
    await screen.findByRole('link', { name: 'Open shop/platform/production' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(window.localStorage.getItem('exdb.targets.view')).toBe('grid')
    // The chosen view is now the default, so the address does not need to name it.
    expect((router.state.location.search as Record<string, unknown>)['view']).toBeUndefined()
    cleanup()
    mountApp('/targets', seeded())
    await screen.findByRole('link', { name: 'Open shop/platform/production' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('remembers a chosen sort and starts the next list with it', async () => {
    mountApp('/targets', seeded())
    await ready()
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'health' } })
    await waitFor(() => expect(window.localStorage.getItem('exdb.targets.sort')).toBe('health'))
    cleanup()
    mountApp('/targets', seeded())
    await ready()
    expect(screen.getByLabelText('Sort by')).toHaveValue('health')
    const first = screen.getAllByRole('link', { name: /^Open / })[0]
    expect(first?.getAttribute('aria-label')).toBe('Open acme/core/production')
  })

  it('lets the address win over the remembered default, without replacing it', async () => {
    window.localStorage.setItem('exdb.targets.view', 'grid')
    window.localStorage.setItem('exdb.targets.sort', 'health')
    mountApp('/targets?view=table&sort=path', seeded())
    await ready()
    expect(screen.getByLabelText('Sort by')).toHaveValue('path')
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')
    const first = screen.getAllByRole('link', { name: /^Open / })[0]
    expect(first?.getAttribute('aria-label')).toBe('Open acme/core/production')
    expect(window.localStorage.getItem('exdb.targets.view')).toBe('grid')
    expect(window.localStorage.getItem('exdb.targets.sort')).toBe('health')
  })

  it('drops a choice from the address once it is the remembered default', async () => {
    window.localStorage.setItem('exdb.targets.sort', 'health')
    const { router } = mountApp('/targets', seeded())
    await ready()
    expect(screen.getByLabelText('Sort by')).toHaveValue('health')
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'path' } })
    // 'path' is now remembered, so the address stays clean and the list is sorted by path.
    await waitFor(() => expect(window.localStorage.getItem('exdb.targets.sort')).toBe('path'))
    expect((router.state.location.search as Record<string, unknown>)['sort']).toBeUndefined()
    expect(screen.getByLabelText('Sort by')).toHaveValue('path')
  })

  it('works when the browser refuses to store anything: the address carries the choice', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const user = userEvent.setup()
    const { router } = mountApp('/targets', seeded())
    await ready()
    await user.click(screen.getByRole('button', { name: 'Grid' }))
    await screen.findByRole('link', { name: 'Open shop/platform/production' })
    expect(router.state.location.search).toMatchObject({ view: 'grid' })
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('ignores a remembered value it does not know', async () => {
    window.localStorage.setItem('exdb.targets.view', 'iframe')
    window.localStorage.setItem('exdb.targets.sort', '<b>')
    mountApp('/targets', seeded())
    await ready()
    expect(screen.getByLabelText('Sort by')).toHaveValue('path')
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')
  })
})
