import '@testing-library/jest-dom/vitest'
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
