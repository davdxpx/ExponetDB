import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { FINGERPRINT, mountApp, oauthClient, World } from './support.tsx'

afterEach(cleanup)

const HOSTILE = 'ExponetDB CLI <img src=x onerror="document.title=1">'

function card(clientId: string): HTMLElement {
  const list = document.getElementById('client-list')
  if (list === null) throw new Error('no #client-list')
  const found = [...list.querySelectorAll<HTMLElement>(':scope > li.card')].find((li) =>
    li.textContent?.includes(clientId),
  )
  if (found === undefined) throw new Error(`no card for ${clientId}`)
  return found
}

const statusLine = (): HTMLElement | null => document.querySelector('p.status')

async function confirmWithCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  expect(reauth).toHaveAttribute('data-reauth')
  await user.type(
    within(reauth).getByLabelText('Or enter the code from your authenticator app'),
    '123456',
  )
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

// Each case mounts the whole shell and runs axe; under a loaded machine that takes seconds.
describe('the OAuth clients page', { timeout: 20_000 }, () => {
  it('lists each client as li.card.state-<state> with its name as untrusted text, never markup or a logo', async () => {
    const world = new World()
    const dcr = oauthClient({ name: HOSTILE, clientId: `exdb-dcr-${'h'.repeat(43)}` })
    const bidi = oauthClient({
      name: 'Exponet‮DB​',
      state: 'active',
      clientId: 'https://agent.example.test/client.json',
      registration: 'cimd',
      redirectUris: ['https://agent.example.test/cb', 'http://127.0.0.1/cb'],
    })
    const firstParty = oauthClient({
      name: 'ExponetDB CLI',
      firstParty: true,
      state: 'active',
      registration: 'first_party',
      kind: 'cli',
      clientId: 'exponetdb-cli',
    })
    const long = oauthClient({
      clientId: `https://agent.example.test/${'m'.repeat(200)}.json`,
      registration: 'cimd',
    })
    world.clients = [dcr, bidi, firstParty, long]
    const { container } = mountApp('/access/oauth-clients', world)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'OAuth clients' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(card(dcr.clientId)).toBeInTheDocument())

    const hostile = card(dcr.clientId)
    expect(hostile).toHaveClass('card', 'state-pending')
    expect(hostile).toHaveAttribute('data-client', dcr.id)
    expect(hostile.querySelectorAll('h2')).toHaveLength(1)
    expect(hostile.querySelector('h2')?.textContent).toContain(HOSTILE)
    expect(hostile.textContent).toContain('name not verified')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(document.title).not.toBe('1')
    expect(hostile.textContent).toContain('DCR, MCP client, Public client without a secret')
    expect(hostile.textContent).toContain('agent.example.test')
    expect(hostile.textContent).toContain(FINGERPRINT)
    // Nothing the client declared becomes a link.
    expect(hostile.querySelectorAll('a')).toHaveLength(0)

    // Direction and invisible characters are shown by code point, the URL host as the parser reads it.
    const shown = card(bidi.clientId)
    expect(shown).toHaveClass('state-active')
    expect(shown.querySelector('h2')?.textContent).toContain('⟨U+202E⟩')
    expect(shown.querySelector('h2')?.textContent).toContain('⟨U+200B⟩')
    expect(shown.textContent).toContain('127.0.0.1')
    expect(shown.textContent).toContain(
      'Automatically, under open registration. Every person still consents.',
    )
    expect(shown.querySelectorAll('a')).toHaveLength(0)

    // A first-party client carries no marker and cannot be disabled from here.
    const own = card('exponetdb-cli')
    expect(own.textContent).not.toContain('name not verified')
    expect(own.textContent).toContain('First party')
    expect(within(own).queryByRole('button', { name: 'Disable' })).toBeNull()

    // An approval binds the exact client_id: a long one is shown whole, never cut.
    expect(card(long.clientId)).toHaveClass('state-pending')

    // The OD-5 copy: open registration by default, a person still consents.
    expect(screen.getByText('Open registration is the default')).toBeInTheDocument()
    expect(screen.getByText(/Every person still signs in and consents/)).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('approves the exact client after a confirmation and a fresh proof, retrying the change once', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const pending = oauthClient({ name: HOSTILE })
    world.clients = [pending]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(pending.clientId)).toBeInTheDocument())

    await user.click(
      within(card(pending.clientId)).getByRole('button', { name: 'Approve this exact client' }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this exact client' })
    // The dialog names what is approved: the exact client_id, the hosts and the fingerprint.
    expect(dialog.textContent).toContain(pending.clientId)
    expect(dialog.textContent).toContain('agent.example.test')
    expect(dialog.textContent).toContain(FINGERPRINT)
    expect(world.changes).toEqual([])
    expect(await axeViolations(document.body)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Approve this exact client' }))

    await confirmWithCode(user)
    await waitFor(() => expect(card(pending.clientId)).toHaveClass('state-active'))
    const approvals = world.changes.filter((r) => r.path.endsWith('/approve'))
    // Refused once for the missing proof, then sent once more: never a third time.
    expect(approvals).toHaveLength(2)
    expect(approvals[1]).toEqual({
      method: 'POST',
      path: `/api/v1/oauth-clients/${pending.id}/approve`,
      body: { fingerprint: FINGERPRINT },
    })
    await waitFor(() => expect(statusLine()).toHaveTextContent('Approved.'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('changes nothing when the confirmation of identity is canceled', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const pending = oauthClient()
    world.clients = [pending]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(pending.clientId)).toBeInTheDocument())

    await user.click(
      within(card(pending.clientId)).getByRole('button', { name: 'Approve this exact client' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Approve this exact client' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(reauth).getByRole('button', { name: 'Cancel' }))

    expect(await within(dialog).findByText('Canceled. Nothing was changed.')).toBeInTheDocument()
    expect(within(dialog).getByText('REAUTH_CANCELED')).toBeInTheDocument()
    expect(world.changes.filter((r) => r.path.endsWith('/approve'))).toHaveLength(1)
    expect(card(pending.clientId)).toHaveClass('state-pending')
  })

  it('shows a refused decision as catalog text with its code inside the dialog', async () => {
    const user = userEvent.setup()
    const world = new World()
    const pending = oauthClient()
    world.clients = [pending]
    world.failures.set('/approve', {
      status: 409,
      code: 'PLAN_STALE',
      message: 'The metadata changed since the review.',
    })
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(pending.clientId)).toBeInTheDocument())

    await user.click(
      within(card(pending.clientId)).getByRole('button', { name: 'Approve this exact client' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Approve this exact client' }))
    expect(
      await within(dialog).findByText('The metadata changed since the review.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('PLAN_STALE')).toBeInTheDocument()
    expect(card(pending.clientId)).toHaveClass('state-pending')
  })

  it('disables an active client and rejects a pending one, each after a confirmation that states the consequence', async () => {
    const user = userEvent.setup()
    const world = new World()
    const active = oauthClient({ state: 'active', clientId: `exdb-dcr-${'a'.repeat(43)}` })
    const pending = oauthClient({ state: 'pending', clientId: `exdb-dcr-${'p'.repeat(43)}` })
    world.clients = [active, pending]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(active.clientId)).toBeInTheDocument())

    await user.click(within(card(active.clientId)).getByRole('button', { name: 'Disable' }))
    const disable = await screen.findByRole('alertdialog', { name: 'Disable this client' })
    expect(disable.textContent).toContain('Every grant and token of this client ends at once')
    await user.click(within(disable).getByRole('button', { name: 'Disable client' }))
    await waitFor(() => expect(card(active.clientId)).toHaveClass('state-disabled'))
    await waitFor(() => expect(statusLine()).toHaveTextContent('Disabled; its grants ended.'))

    await user.click(within(card(pending.clientId)).getByRole('button', { name: 'Reject' }))
    const reject = await screen.findByRole('alertdialog', { name: 'Reject this client' })
    await user.click(within(reject).getByRole('button', { name: 'Reject client' }))
    await waitFor(() => expect(card(pending.clientId)).toHaveClass('state-rejected'))
    expect(world.changes.map((r) => r.path)).toEqual([
      `/api/v1/oauth-clients/${active.id}/disable`,
      `/api/v1/oauth-clients/${pending.id}/reject`,
    ])
  })

  it('adds a CIMD client by its exact https address and never echoes the address', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp('/access/oauth-clients', world)
    const form = await waitFor(() => {
      const found = document.getElementById('cimd-add')
      if (found === null) throw new Error('no #cimd-add')
      return found
    })
    const field = within(form).getByLabelText('Client ID Metadata Document URL (exact)')
    expect(field).toHaveAttribute('type', 'url')
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAttribute('spellcheck', 'false')

    await user.type(field, 'http://agent.example.test/client.json')
    await user.click(within(form).getByRole('button', { name: 'Fetch for review' }))
    expect(
      await within(form).findByText('Enter the exact https address of the metadata document.'),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])

    const address = 'https://agent.example.test/‮client.json'
    // jsdom keeps no selection in a url field, so the second address is set as one change.
    fireEvent.change(field, { target: { value: address } })
    await user.click(within(form).getByRole('button', { name: 'Fetch for review' }))
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('The client was fetched and waits for review.'),
    )
    expect(world.changes).toEqual([
      { method: 'POST', path: '/api/v1/oauth-clients/cimd', body: { clientId: address } },
    ])
    expect(statusLine()?.textContent).not.toContain('agent.example.test')
    expect(field).toHaveValue('')
    // The new card shows the direction character by its code point, never applied.
    await waitFor(() => expect(card('agent.example.test/⟨U+202E⟩')).toHaveClass('state-pending'))
  })

  it('fetches the metadata of a CIMD client again from its card', async () => {
    const user = userEvent.setup()
    const world = new World()
    const cimd = oauthClient({
      registration: 'cimd',
      state: 'active',
      clientId: 'https://a.example.test/c.json',
    })
    world.clients = [cimd]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(cimd.clientId)).toBeInTheDocument())
    await user.click(
      within(card(cimd.clientId)).getByRole('button', { name: 'Fetch metadata again' }),
    )
    await waitFor(() => expect(statusLine()).toHaveTextContent('Metadata fetched.'))
    expect(world.changes.map((r) => r.path)).toEqual([
      `/api/v1/oauth-clients/${cimd.id}/refresh-metadata`,
    ])
  })

  it('shows a failed read as failed, a refused read as not permitted and an empty read as empty', async () => {
    const failed = new World()
    failed.failures.set('GET /api/v1/oauth-clients', {
      status: 500,
      code: 'INTERNAL',
      message: 'The server failed.',
    })
    mountApp('/access/oauth-clients', failed)
    expect(await screen.findByText(/Could not read OAuth client list/)).toBeInTheDocument()
    expect(screen.queryByText('No OAuth clients yet')).toBeNull()
    cleanup()

    const refused = new World()
    refused.failures.set('GET /api/v1/oauth-clients', { status: 403, code: 'PERMISSION_DENIED' })
    mountApp('/access/oauth-clients', refused)
    expect(
      await screen.findByText('You do not have access to OAuth client list'),
    ).toBeInTheDocument()
    expect(screen.getByText('access.read')).toBeInTheDocument()
    cleanup()

    const empty = new World()
    const { container } = mountApp('/access/oauth-clients', empty)
    expect(await screen.findByText('No OAuth clients yet')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
    cleanup()

    const partial = new World()
    partial.nextCursor = 'more'
    mountApp('/access/oauth-clients', partial)
    expect(await screen.findByText(/More clients exist than one read returns/)).toBeInTheDocument()
    expect(screen.queryByText('No OAuth clients yet')).toBeNull()
  })

  it('offers no change to a person without access.manage', async () => {
    const world = new World()
    world.permissions = ['access.read']
    const pending = oauthClient()
    world.clients = [pending]
    mountApp('/access/oauth-clients', world)
    await waitFor(() => expect(card(pending.clientId)).toBeInTheDocument())
    expect(document.getElementById('cimd-add')).toBeNull()
    expect(
      within(card(pending.clientId)).queryByRole('button', { name: 'Approve this exact client' }),
    ).toBeNull()
    expect(screen.getByText(/Changing it needs the permission access.manage/)).toBeInTheDocument()
  })

  it('moves /admin/clients to /access/oauth-clients, replacing the old entry', async () => {
    const world = new World()
    const { router } = mountApp('/admin/clients', world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'OAuth clients' }),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/access/oauth-clients')
    expect(router.history.length).toBe(1)
  })
})
