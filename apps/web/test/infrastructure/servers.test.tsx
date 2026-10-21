import '@testing-library/jest-dom/vitest'
import { SERVER_PROVIDERS } from '@exponetdb/contracts'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { infraKeys } from '../../src/features/infrastructure/keys.ts'
import { BIDI, HOSTILE, mountApp, NODE, PLAN, SERVER, server, World } from './support.tsx'

afterEach(cleanup)

const FAILED = 'Could not read Server list'
const EMPTY = 'No servers yet'

describe('the servers page', () => {
  it('lists the servers with a link built from the id only, and passes axe', async () => {
    const world = new World()
    const { container } = mountApp('/infrastructure/servers', world)
    const table = await screen.findByRole('table', { name: 'Servers' })
    expect(within(table).getByRole('link', { name: SERVER })).toHaveAttribute(
      'href',
      `/infrastructure/servers/${SERVER}`,
    )
    expect(table.textContent).toContain('acme-db-01')
    expect(table.textContent).toContain('Hetzner Cloud')
    expect(table.textContent).toContain('8 CPUs, 32.0 GiB memory')
    expect(await axeViolations(container)).toEqual([])
  })

  it('stays loading while the read runs, with neither the failure nor the empty text', async () => {
    const world = new World()
    world.hang.add('GET /api/v1/servers')
    mountApp('/infrastructure/servers', world)
    expect(await screen.findByText('Loading Server list')).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).toBeNull()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('shows a failed read as failed, never as an empty list', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/servers', {
      status: 503,
      code: 'CONTROL_PLANE_DEGRADED',
      message: 'The Control Store is not reachable.',
    })
    mountApp('/infrastructure/servers', world)
    expect(await screen.findByText(FAILED, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no Server list.')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('names the missing permission when the read is refused', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/servers', { status: 403, code: 'PERMISSION_DENIED' })
    mountApp('/infrastructure/servers', world)
    expect(await screen.findByText(/nodes\.read/)).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh', async () => {
    const world = new World()
    world.hang.add('GET /api/v1/servers')
    mountApp('/infrastructure/servers', world, (queryClient) =>
      queryClient.setQueryData(
        infraKeys.servers(),
        { items: [server()], nextCursor: null },
        { updatedAt: Date.now() - 5 * 60_000 },
      ),
    )
    expect(await screen.findByText('Showing an earlier read of Server list')).toBeInTheDocument()
    expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Source: cached\. Observed [45] min ago/,
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Servers' })).toBeInTheDocument()
  })

  it('says what is missing from a partial list and never shows it as empty', async () => {
    const world = new World()
    world.servers = []
    world.serversNextCursor = 'next'
    mountApp('/infrastructure/servers', world)
    expect(await screen.findByText('Items after the first 200')).toBeInTheDocument()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('is empty only after a successful read', async () => {
    const world = new World()
    world.servers = []
    const { container } = mountApp('/infrastructure/servers', world)
    expect(await screen.findByText(EMPTY)).toBeInTheDocument()
    expect(screen.queryByText(FAILED)).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('renders hostile names as text with visible code points', async () => {
    const world = new World()
    world.servers = [server({ displayName: HOSTILE, location: `fsn${BIDI}1` })]
    const { container } = mountApp('/infrastructure/servers', world)
    const table = await screen.findByRole('table', { name: 'Servers' })
    expect(container.querySelector('script')).toBeNull()
    expect(table.textContent).toContain('<script>alert(1)</script>')
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
    expect(await axeViolations(container)).toEqual([])
  })

  it('asks for the server registration plan and opens its review page', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp('/infrastructure/servers', world)
    const form = await waitFor(() => {
      const found = document.getElementById('server-register-form')
      if (found === null) throw new Error('no form')
      return found
    })
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: 'shop-db-02' },
    })
    fireEvent.change(within(form).getByLabelText('Location (optional)'), {
      target: { value: 'nbg1' },
    })
    await user.click(within(form).getByRole('button', { name: 'Plan server registration' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/servers',
        body: { displayName: 'shop-db-02', provider: 'unknown', location: 'nbg1' },
      },
    ])
  })

  it('lists every provider in its group, each with its logo, and plans the chosen one', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router, container } = mountApp('/infrastructure/servers', world)
    const form = await waitFor(() => {
      const found = document.getElementById('server-register-form')
      if (found === null) throw new Error('no form')
      return found
    })
    const trigger = within(form).getByRole('combobox', { name: 'Provider' })
    expect(trigger).toHaveTextContent('Not known')
    expect(await axeViolations(container)).toEqual([])
    await user.click(trigger)
    const listbox = await screen.findByRole('listbox')
    for (const group of ['Cloud platforms', 'Dedicated and hosting', 'Own hardware and other']) {
      expect(within(listbox).getByText(group)).toBeInTheDocument()
    }
    const options = within(listbox).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Akamai Cloud (Linode)',
      'Alibaba Cloud',
      'Amazon Web Services (AWS)',
      'DigitalOcean',
      'Exoscale',
      'Google Cloud',
      'Hetzner Cloud',
      'IBM Cloud',
      'Microsoft Azure',
      'Oracle Cloud Infrastructure',
      'Scaleway',
      'STACKIT',
      'UpCloud',
      'Vultr',
      'Contabo',
      'Hetzner Dedicated (Robot)',
      'IONOS',
      'Netcup',
      'OVHcloud',
      'On premises (own hardware)',
      'Other',
      'Not known',
    ])
    // As many as the contract has, each once.
    expect(options).toHaveLength(SERVER_PROVIDERS.length)
    expect(new Set(options.map((o) => o.textContent)).size).toBe(SERVER_PROVIDERS.length)
    for (const option of options) {
      const logo = option.querySelector('[data-provider-logo]')
      expect(logo, option.textContent ?? '').not.toBeNull()
      expect(logo?.getAttribute('aria-hidden')).toBe('true')
      expect(logo?.querySelector('svg')).not.toBeNull()
    }
    const logoOf = (name: string) =>
      within(listbox)
        .getByRole('option', { name })
        .querySelector('[data-provider-logo]')
        ?.getAttribute('data-provider-logo')
    expect(logoOf('Hetzner Cloud')).toBe('hetzner')
    expect(logoOf('Hetzner Dedicated (Robot)')).toBe('hetzner')
    expect(logoOf('OVHcloud')).toBe('ovh')
    // No glyph in the pinned Simple Icons version: a neutral glyph, never a logo from elsewhere.
    for (const name of ['Amazon Web Services (AWS)', 'Microsoft Azure', 'STACKIT', 'Other']) {
      expect(logoOf(name), name).toBe('neutral')
    }
    // A long list: choose by typing, as a keyboard user does (jsdom races Radix's guard against
    // the opening click's pointer-up on the first click into the list).
    await user.keyboard('Scaleway')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(trigger).toHaveTextContent('Scaleway'))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger.querySelector('[data-provider-logo="scaleway"]')).not.toBeNull()
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: 'shop-db-03' },
    })
    await user.click(within(form).getByRole('button', { name: 'Plan server registration' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/servers',
        body: { displayName: 'shop-db-03', provider: 'scaleway' },
      },
    ])
  })

  it('shows the provider logo left of its name, and a neutral glyph where there is no logo', async () => {
    const world = new World()
    world.servers = [
      server(),
      server({ id: 'srv_01M4S9000000000000000000S2', displayName: 'b', provider: 'aws' }),
    ]
    const { container } = mountApp('/infrastructure/servers', world)
    const table = await screen.findByRole('table', { name: 'Servers' })
    const rows = within(table).getAllByRole('row').slice(1)
    const cellOf = (row: HTMLElement) =>
      row.querySelector('[data-provider-logo]')?.closest('td') ?? undefined
    const first = rows[0]
    const second = rows[1]
    if (first === undefined || second === undefined) throw new Error('two rows expected')
    expect(cellOf(first)?.textContent).toBe('Hetzner Cloud')
    expect(first.querySelector('[data-provider-logo]')?.getAttribute('data-provider-logo')).toBe(
      'hetzner',
    )
    expect(first.querySelector('[data-brand="hetzner"]')?.getAttribute('fill')).toBe('#D50C2D')
    expect(cellOf(second)?.textContent).toBe('Amazon Web Services (AWS)')
    expect(second.querySelector('[data-provider-logo]')?.getAttribute('data-provider-logo')).toBe(
      'neutral',
    )
    expect(await axeViolations(container)).toEqual([])
  })

  it('sends nothing for a name with control characters', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp('/infrastructure/servers', world)
    const form = await waitFor(() => {
      const found = document.getElementById('server-register-form')
      if (found === null) throw new Error('no form')
      return found
    })
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: 'a\u0007b' },
    })
    await user.click(within(form).getByRole('button', { name: 'Plan server registration' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/without control characters/)
    expect(world.changes).toEqual([])
  })
})

describe('the server page', () => {
  it('shows the server, its nodes and clusters, and plans an enrollment', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router, container } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    expect(await screen.findByRole('heading', { level: 1, name: 'acme-db-01' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: NODE })).toHaveAttribute(
      'href',
      `/infrastructure/nodes/${NODE}`,
    )
    expect(await screen.findByText('shop-main')).toBeInTheDocument()
    const provider = container.querySelector('[data-provider-logo="hetzner"]')
    expect(provider?.getAttribute('aria-hidden')).toBe('true')
    expect(provider?.parentElement?.textContent).toBe('Hetzner Cloud')
    expect(await axeViolations(container)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Plan enrollment' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      { method: 'POST', path: `/api/v1/servers/${SERVER}/nodes/enroll`, body: {} },
    ])
  })

  it('carries the production frame for a production server', async () => {
    const world = new World()
    world.servers = [server({ derivedTier: 'prod' })]
    const { container } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    await screen.findByRole('heading', { level: 1, name: 'acme-db-01' })
    expect(container.querySelector('[data-production-frame]')).not.toBeNull()
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })

  it('is "page not found" for an id outside the grammar, without a request', async () => {
    const world = new World()
    mountApp('/infrastructure/servers/srv_..%2Fadmin', world)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(world.sent.filter((s) => s.path.startsWith('/api/v1/servers/'))).toEqual([])
  })
})
