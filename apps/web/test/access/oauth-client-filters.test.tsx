import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { mountApp, oauthClient, World } from './support.tsx'

afterEach(cleanup)

const BOOM = { status: 500, code: 'INTERNAL', message: 'The server failed.' }

function card(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`li[data-client="${id}"]`)
  if (found === null) throw new Error(`no card ${id}`)
  return found
}

const ids = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('li[data-client]')].map(
    (li) => li.getAttribute('data-client') ?? '',
  )

describe('the state filter of the OAuth clients', () => {
  function clientsWorld() {
    const world = new World()
    const waiting = oauthClient({ name: 'Waiting agent', state: 'pending' })
    const waiting2 = oauthClient({ name: 'Second waiting agent', state: 'pending' })
    const active = oauthClient({ name: 'Active agent', state: 'active', approvedBy: null })
    world.clients = [waiting, active, waiting2]
    return { world, waiting, waiting2, active }
  }

  it('lists every state by default and reads one state from the server when it is chosen', async () => {
    const user = userEvent.setup()
    const { world, waiting, waiting2, active } = clientsWorld()
    const { container } = mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(ids()).toEqual([waiting.id, active.id, waiting2.id]))
    expect(screen.getByLabelText('State')).toHaveValue('all')
    expect(
      [...(screen.getByLabelText('State') as HTMLSelectElement).options].map((o) => o.text),
    ).toEqual(['All states', 'Waiting for review', 'Active', 'Rejected', 'Disabled'])
    expect(world.requests.filter((r) => r.path.startsWith('/api/v1/oauth-clients'))[0]?.path).toBe(
      '/api/v1/oauth-clients?limit=200',
    )

    await user.selectOptions(screen.getByLabelText('State'), 'active')
    await waitFor(() => expect(ids()).toEqual([active.id]))
    expect(
      world.requests.some((r) => r.path === '/api/v1/oauth-clients?state=active&limit=200'),
    ).toBe(true)
    expect(await axeViolations(container)).toEqual([])
  })

  it('says how many clients wait for review when the read shows any', async () => {
    const { world } = clientsWorld()
    mountApp('/access/oauth-clients', world)
    expect(await screen.findByText('2 clients wait for review.')).toBeInTheDocument()
    cleanup()

    const one = new World()
    one.clients = [oauthClient({ state: 'pending' }), oauthClient({ state: 'active' })]
    mountApp('/access/oauth-clients', one)
    expect(await screen.findByText('1 client waits for review.')).toBeInTheDocument()
    cleanup()

    const none = new World()
    none.clients = [oauthClient({ state: 'active' })]
    mountApp('/access/oauth-clients', none)
    await waitFor(() => expect(ids()).toHaveLength(1))
    expect(screen.queryByText(/wait for review|waits for review/)).toBeNull()
  })

  it('says "at least" when the list is partial and more may wait', async () => {
    const { world } = clientsWorld()
    world.cursors.set('/api/v1/oauth-clients', 'more')
    mountApp('/access/oauth-clients', world)
    expect(
      await screen.findByText(
        'At least 2 clients wait for review. The list is cut, so more may wait.',
      ),
    ).toBeInTheDocument()
  })

  it('does not say anything about waiting clients when the read failed', async () => {
    const { world } = clientsWorld()
    world.failures.set('GET /api/v1/oauth-clients', BOOM)
    mountApp('/access/oauth-clients', world)
    expect(await screen.findByText(/Could not read OAuth client list/)).toBeInTheDocument()
    expect(screen.queryByText(/wait for review/)).toBeNull()
    expect(screen.queryByText('No match')).toBeNull()
  })

  it('says "No match" with a Reset for a state without clients, and "No OAuth clients yet" only for an empty list', async () => {
    const user = userEvent.setup()
    const { world } = clientsWorld()
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(ids()).toHaveLength(3))
    await user.selectOptions(screen.getByLabelText('State'), 'rejected')
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(screen.queryByText('No OAuth clients yet')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(ids()).toHaveLength(3))
    expect(screen.getByLabelText('State')).toHaveValue('all')
    cleanup()

    const empty = new World()
    mountApp('/access/oauth-clients', empty)
    expect(await screen.findByText('No OAuth clients yet')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull()
  })

  it('keeps the decisions: approving a waiting client under the filter moves it out of the list', async () => {
    const user = userEvent.setup()
    const world = new World()
    const waiting = oauthClient({ name: 'Waiting agent', state: 'pending' })
    world.clients = [waiting]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(ids()).toEqual([waiting.id]))
    await user.selectOptions(screen.getByLabelText('State'), 'pending')
    await waitFor(() => expect(card(waiting.id)).toBeInTheDocument())
    await user.click(
      within(card(waiting.id)).getByRole('button', { name: 'Approve this exact client' }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this exact client' })
    await user.click(within(dialog).getByRole('button', { name: 'Approve this exact client' }))
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(world.changes.map((r) => r.path)).toEqual([
      `/api/v1/oauth-clients/${waiting.id}/approve`,
    ])
    expect(world.clients[0]?.state).toBe('active')
  })
})

describe('the last use of an OAuth client, from the client itself', () => {
  function use(id: string): HTMLElement {
    const found = card(id).querySelector<HTMLElement>('[data-use]')
    if (found === null) throw new Error(`no use summary on ${id}`)
    return found
  }

  it('shows the last use and the active grants the client carries, and reads no grants for them', async () => {
    const world = new World()
    const agent = oauthClient({
      name: 'Agent',
      state: 'active',
      approvedBy: null,
      lastUsedAt: '2026-10-13T10:15:00Z',
      activeGrantCount: 2,
    })
    const other = oauthClient({
      name: 'Other agent',
      state: 'active',
      approvedBy: null,
      lastUsedAt: '2026-10-01T00:00:00Z',
      activeGrantCount: 1,
    })
    world.clients = [agent, other]
    const { container } = mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use]')).not.toBeNull())
    const first = use(agent.id)
    expect(first).toHaveAttribute('data-use', 'reported')
    expect(within(first).getByRole('button').textContent).toMatch(/2026/)
    expect(first.querySelector('[data-slot="active-grants"]')).toHaveTextContent('2 active grants')
    expect(first.textContent).toContain('revoked and expired ones too')
    // Each client shows its own numbers.
    const second = use(other.id)
    expect(second.querySelector('[data-slot="active-grants"]')).toHaveTextContent('1 active grant')
    expect(second.querySelector('[data-slot="active-grants"]')).not.toHaveTextContent(
      '1 active grants',
    )
    expect(within(second).getByRole('button').textContent).toMatch(/2026/)
    // The interim aggregate is gone: the grants are not read for this page, and no label of it remains.
    expect(world.requests.some((r) => r.path.startsWith('/api/v1/grants'))).toBe(false)
    expect(document.body.textContent).not.toContain('From the grants this page could read')
    expect(await axeViolations(container)).toEqual([])
  })

  it('says no use is recorded, never "never used", for a client whose use is null, and shows a zero count', async () => {
    const world = new World()
    const agent = oauthClient({
      name: 'Agent',
      state: 'active',
      approvedBy: null,
      lastUsedAt: null,
      activeGrantCount: 0,
    })
    world.clients = [agent]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use]')).not.toBeNull())
    const text = use(agent.id).textContent ?? ''
    expect(text).toContain('No use recorded.')
    expect(text).toContain('That does not mean the client was never used')
    expect(use(agent.id).querySelector('[data-slot="active-grants"]')).toHaveTextContent(
      '0 active grants',
    )
    expect(text).not.toContain('not reported')
    expect(text.replace('That does not mean the client was never used', '')).not.toMatch(
      /never used/i,
    )
  })

  it('says not reported, and shows no zero, when the server sends neither field', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    world.clients = [agent]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use]')).not.toBeNull())
    const summary = use(agent.id)
    expect(summary).toHaveAttribute('data-use', 'unreported')
    expect(summary.textContent).toContain('Not reported by this server.')
    expect(summary.textContent).toContain('Active grants: not reported by this server.')
    expect(summary.textContent).not.toContain('No use recorded')
    expect(summary.textContent).not.toMatch(/\b0 active grants/)
    // No claim about where a figure came from when there is no figure.
    expect(summary.textContent).not.toContain('revoked and expired ones too')
  })

  it('says each field the server did not send is not reported on its own', async () => {
    const world = new World()
    const onlyGrants = oauthClient({
      name: 'A',
      state: 'active',
      approvedBy: null,
      activeGrantCount: 3,
    })
    const onlyUse = oauthClient({
      name: 'B',
      state: 'active',
      approvedBy: null,
      lastUsedAt: '2026-10-13T10:15:00Z',
    })
    world.clients = [onlyGrants, onlyUse]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(onlyUse.id).querySelector('[data-use]')).not.toBeNull())
    expect(use(onlyGrants.id).textContent).toContain('Not reported by this server.')
    expect(use(onlyGrants.id).textContent).toContain('3 active grants')
    expect(use(onlyUse.id).textContent).toContain('Active grants: not reported by this server.')
    expect(within(use(onlyUse.id)).getByRole('button').textContent).toMatch(/2026/)
  })

  it('shows a failed list read as failed, with no use and no count for any client', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/oauth-clients', BOOM)
    mountApp('/access/oauth-clients', world)
    expect(await screen.findByText(/Could not read OAuth client list/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('No use recorded')
    expect(document.body.textContent).not.toContain('active grants')
  })
})
