import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { peopleKeys } from '../../src/features/access/people-keys.ts'
import { grantItem, mountApp, oauthClient, World } from './support.tsx'

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

/** The grant of a client, as the grants read carries it. */
function grantOf(
  client: ReturnType<typeof oauthClient>,
  over: Parameters<typeof grantItem>[0] = {},
): ReturnType<typeof grantItem> {
  return grantItem({
    client: {
      clientId: client.clientId,
      firstParty: false,
      id: client.id,
      kind: 'mcp',
      name: client.name,
      registration: 'dcr',
      state: 'active',
    },
    ...over,
  })
}

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

describe('the last use of an OAuth client, from the grants this page could read', () => {
  it('shows the latest recorded use and the active grants of the client, labeled as what the read could see', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    const other = oauthClient({ name: 'Other agent', state: 'active', approvedBy: null })
    world.clients = [agent, other]
    world.grants = [
      grantOf(agent, { lastUsedAt: '2026-10-13T10:15:00Z', lastUseClass: 'plan' }),
      grantOf(agent, {
        state: 'revoked',
        revokedAt: '2026-10-14T09:00:00Z',
        lastUsedAt: '2026-10-14T08:00:00Z',
        lastUseClass: 'rest',
      }),
      grantOf(agent, { lastUsedAt: null, lastUseClass: null }),
      grantOf(other, { lastUsedAt: '2026-10-01T00:00:00Z', lastUseClass: 'read' }),
    ]
    const { container } = mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use="ready"]')).not.toBeNull())
    const use = card(agent.id).querySelector('[data-use="ready"]') as HTMLElement
    // The newest of the three uses, with how it came in; the other client's use is not mixed in.
    expect(use.textContent).toContain('REST API')
    expect(use.textContent).not.toContain('Plan')
    expect(use.textContent).not.toContain('Read')
    expect(use.textContent).toContain('Active grants: 2')
    expect(use.textContent).toContain('From the grants this page could read.')
    const otherUse = card(other.id).querySelector('[data-use="ready"]') as HTMLElement
    expect(otherUse.textContent).toContain('Active grants: 1')
    expect(otherUse.textContent).toContain('Read')
    // The old placeholder is gone.
    expect(document.body.textContent).not.toContain('Not reported by the server yet')
    // All states are read, as the Connected applications page's "All grants" does.
    expect(world.requests.some((r) => r.path === '/api/v1/grants?limit=200')).toBe(true)
    expect(await axeViolations(container)).toEqual([])
  })

  it('says no use is recorded, never "never used", for a client whose grants hold none', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    const unused = oauthClient({ name: 'Unused agent', state: 'active', approvedBy: null })
    world.clients = [agent, unused]
    world.grants = [grantOf(agent, { lastUsedAt: null, lastUseClass: null })]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use="ready"]')).not.toBeNull())
    for (const client of [agent, unused]) {
      const text = card(client.id).querySelector('[data-use="ready"]')?.textContent ?? ''
      expect(text).toContain(
        'No use recorded in the grants this page could read. This does not mean it was never used.',
      )
    }
    expect(card(agent.id).textContent).toContain('Active grants: 1')
    expect(card(unused.id).textContent).toContain('Active grants: 0')
    expect(document.body.textContent).not.toMatch(/\bnever used\b(?!\.)/i)
  })

  it('says the last use could not be read when the grants read failed, and nothing else about use', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    world.clients = [agent]
    world.failures.set('GET /api/v1/grants', BOOM)
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use="failed"]')).not.toBeNull())
    const text = card(agent.id).querySelector('[data-use="failed"]')?.textContent ?? ''
    expect(text).toContain('The last use could not be read: The server failed. (INTERNAL)')
    expect(text).toContain('This does not mean the client was never used.')
    expect(card(agent.id).textContent).not.toContain('Active grants')
    expect(card(agent.id).textContent).not.toContain('No use recorded')
  })

  it('marks the aggregate partial when the grants read was cut', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    world.clients = [agent]
    world.grants = [grantOf(agent, { lastUsedAt: '2026-10-13T10:15:00Z', lastUseClass: 'plan' })]
    world.cursors.set('/api/v1/grants', 'more')
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use="ready"]')).not.toBeNull())
    const text = card(agent.id).querySelector('[data-use="ready"]')?.textContent ?? ''
    expect(text).toContain('Active grants: at least 1')
    expect(text).toContain('Only the first 200 grants were read, so this may be incomplete.')
  })

  it('says an earlier read of the grants is old when a refresh failed, and keeps what it showed', async () => {
    const world = new World()
    const agent = oauthClient({ name: 'Agent', state: 'active', approvedBy: null })
    world.clients = [agent]
    world.grants = [grantOf(agent, { lastUsedAt: '2026-10-13T10:15:00Z', lastUseClass: 'plan' })]
    const { queryClient } = mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(agent.id).querySelector('[data-use="ready"]')).not.toBeNull())
    world.failures.set('GET /api/v1/grants', BOOM)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: peopleKeys.grantsAll })
    })
    await waitFor(() =>
      expect(card(agent.id).textContent).toContain('This is an earlier read of the grants.'),
    )
    expect(card(agent.id).textContent).toContain('Plan')
    expect(card(agent.id).textContent).toContain('Active grants: 1')
  })
})
