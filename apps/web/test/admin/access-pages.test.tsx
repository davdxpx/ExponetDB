import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { binding, grant, identity, ROLES } from './fixtures.ts'
import {
  BIDI,
  cacheText,
  confirmWithCode,
  deferred,
  expectInert,
  HOSTILE,
  json,
  mountApp,
  OTHER,
  PLAN,
  plan,
  problem,
  T0,
  TAG,
  World,
  ZWSP,
} from './support.tsx'

afterEach(cleanup)

const LINK = `https://db.example.test/invite#token=exiv_${'L'.repeat(43)}`

function peopleWorld(): World {
  const world = new World()
  world.on('GET', '/api/v1/identities', { items: [identity()], nextCursor: null })
  world.on('GET', '/api/v1/role-bindings', { items: [binding()], nextCursor: null })
  world.on('GET', '/api/v1/roles', ROLES)
  return world
}

function card(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`li[data-identity="${id}"]`)
  if (found === null) throw new Error(`no card ${id}`)
  return found
}

describe('the People page', () => {
  it('lists people with their roles; names and addresses are text, never markup', async () => {
    const world = peopleWorld()
    world.on('GET', '/api/v1/identities', {
      items: [
        identity({ displayName: HOSTILE, email: `x${BIDI}@example.test` }),
        identity({ id: 'idn_01JZ0000000000000000000003', displayName: ZWSP, label: TAG }),
        // A service account is not a person: it is not listed here.
        identity({ id: 'idn_01JZ0000000000000000000004', kind: 'service', displayName: 'svc' }),
      ],
      nextCursor: null,
    })
    const { container } = mountApp('/access/people', world)
    expect(await screen.findByRole('heading', { level: 1, name: 'People' })).toBeInTheDocument()
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    expect(card(OTHER).querySelector('h2')?.textContent).toContain('<script>')
    expect(card(OTHER).textContent).toContain('⟨U+202E⟩')
    expect(card('idn_01JZ0000000000000000000003').textContent).toContain('⟨U+200B⟩')
    expect(document.querySelector('li[data-identity="idn_01JZ0000000000000000000004"]')).toBeNull()
    expectInert(container)
    expect(card(OTHER).textContent).toContain('Developer')
    expect(card(OTHER).textContent).toContain('Product prd_01JZ0000000000000000000001')
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows loading, then a failed read as a failure and never as an empty list', async () => {
    const world = peopleWorld()
    const hold = deferred()
    world.on('GET', '/api/v1/identities', async () => {
      await hold.promise
      return problem(503, 'CONTROL_PLANE_DEGRADED', 'The Control Store is degraded.')
    })
    const { container } = mountApp('/access/people', world)
    expect(await screen.findByText('Loading People list')).toBeInTheDocument()
    expect(screen.queryByText('No people yet')).toBeNull()
    expect(await axeViolations(container)).toEqual([])
    hold.resolve()
    expect(await screen.findByText('Could not read People list')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no People list.')).toBeInTheDocument()
    expect(screen.queryByText('No people yet')).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows empty only after a successful read, partial when more exist, stale after a failed refresh', async () => {
    const world = peopleWorld()
    world.on('GET', '/api/v1/identities', { items: [], nextCursor: null })
    const first = mountApp('/access/people', world)
    expect(await screen.findByText('No people yet')).toBeInTheDocument()
    cleanup()

    const partial = peopleWorld()
    partial.on('GET', '/api/v1/identities', { items: [identity()], nextCursor: 'next' })
    mountApp('/access/people', partial)
    expect(await screen.findByText('Showing part of People list')).toBeInTheDocument()
    expect(screen.queryByText('No people yet')).toBeNull()
    cleanup()

    const stale = peopleWorld()
    const view = mountApp('/access/people', stale)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    stale.on('GET', '/api/v1/identities', () => problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.'))
    await view.queryClient.refetchQueries({ queryKey: ['access', 'identities'] })
    expect(await screen.findByText('Showing an earlier read of People list')).toBeInTheDocument()
    expect(card(OTHER)).toBeInTheDocument()
    expect(first.container).toBeDefined()
  })

  it('says the roles are unknown when the binding read fails, never "no role"', async () => {
    const world = peopleWorld()
    world.on('GET', '/api/v1/role-bindings', () => problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.'))
    mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    expect(card(OTHER).textContent).toContain('The role bindings could not be read')
    expect(card(OTHER).textContent).not.toContain('No role.')
  })

  it('invites with a fresh proof and shows the link once, never in the cache', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.needsProof = true
    world.on('POST', '/api/v1/identities', {
      identity: identity({ state: 'invited', id: 'idn_01JZ0000000000000000000009' }),
      invitation: {
        delivery: { channel: 'none', status: 'not_configured' },
        expiresAt: '2026-10-20T09:00:00Z',
        link: LINK,
      },
    })
    const { queryClient } = mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    // jsdom: the shell's resize handle takes pointer focus, so fields are filled as one change.
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'new@example.test' } })
    await user.click(screen.getByRole('button', { name: 'Invite person' }))
    await confirmWithCode(user)
    expect(await screen.findByText(LINK)).toBeInTheDocument()
    expect(screen.getByText(/No e-mail channel is configured/)).toBeInTheDocument()
    expect(world.changes.filter((r) => r.path === '/api/v1/identities')).toHaveLength(2)
    expect(world.changes.at(-1)?.body).toEqual({ email: 'new@example.test' })
    expect(cacheText(queryClient)).not.toContain('exiv_')
    // The link is text to copy, never a link to follow.
    expect(document.querySelector(`a[href*="exiv_"]`)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Hide link' }))
    expect(screen.queryByText(LINK)).toBeNull()
  })

  it('refuses a malformed address before any request', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'not an address' } })
    await user.click(screen.getByRole('button', { name: 'Invite person' }))
    expect(await screen.findByText('Enter an address like name@example.com.')).toBeInTheDocument()
    expect(world.changes).toEqual([])
  })

  it('plans a role binding and opens the plan review page; nothing is bound here', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toEqual({
        identityId: OTHER,
        roleId: 'viewer',
        scope: { kind: 'target', targetId: 'tgt_01JZ0000000000000000000001' },
      })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    const form = within(card(OTHER)).getByRole('form', { name: 'Plan a role binding' })
    await user.selectOptions(within(form).getByLabelText('Applies to'), 'target')
    fireEvent.change(within(form).getByLabelText('Target ID'), { target: { value: 'tgt_bad' } })
    await user.click(within(form).getByRole('button', { name: 'Create plan to bind role' }))
    expect(await within(form).findByText(/starts with tgt_ followed by 26/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Target ID'), {
      target: { value: 'tgt_01JZ0000000000000000000001' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('plans removing a binding and an erasure only after a confirmation that states the consequence', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.on('DELETE', '/api/v1/role-bindings/rbd_01JZ0000000000000000000001', {
      status: 201,
      json: plan(),
    })
    world.on('POST', `/api/v1/identities/${OTHER}/erasure-plans`, { status: 201, json: plan() })
    const { router } = mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())

    await user.click(within(card(OTHER)).getByRole('button', { name: 'Plan erasure' }))
    const erase = await screen.findByRole('alertdialog', { name: 'Plan erasing this person' })
    expect(erase.textContent).toContain('critical plan')
    expect(world.changes).toEqual([])
    expect(await axeViolations(document.body)).toEqual([])
    await user.click(within(erase).getByRole('button', { name: 'Cancel' }))
    expect(world.changes).toEqual([])

    await user.click(
      within(card(OTHER)).getByRole('button', {
        name: 'Remove role Developer at Product prd_01JZ0000000000000000000001',
      }),
    )
    const remove = await screen.findByRole('alertdialog', {
      name: 'Plan removing this role binding',
    })
    await user.click(within(remove).getByRole('button', { name: 'Create plan to remove role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'DELETE /api/v1/role-bindings/rbd_01JZ0000000000000000000001',
    ])
  })

  it('disables a person with an optional reason after a confirmation and a fresh proof', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.needsProof = true
    world.on(
      'POST',
      `/api/v1/identities/${OTHER}/disable`,
      json(200, identity({ state: 'disabled' })),
    )
    mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    await user.click(within(card(OTHER)).getByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable this person' })
    expect(dialog.textContent).toContain('kept permanently in the audit log')
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Left the team')
    await user.click(within(dialog).getByRole('button', { name: 'Disable person' }))
    await confirmWithCode(user)
    await waitFor(() => expect(document.querySelector('p.status')).toHaveTextContent('Disabled.'))
    const sent = world.changes.filter((r) => r.path.endsWith('/disable'))
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body).toEqual({ reason: 'Left the team' })
  })

  it('offers no change to a person without access.manage', async () => {
    const world = peopleWorld()
    world.permissions = ['access.read']
    mountApp('/access/people', world)
    await waitFor(() => expect(card(OTHER)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Invite person' })).toBeNull()
    for (const name of ['Disable', 'Plan erasure', 'Create plan to bind role', /^Remove role/]) {
      expect(within(card(OTHER)).queryByRole('button', { name })).toBeNull()
    }
  })
})

describe('the Roles page', () => {
  it('lists the role catalog with holders; a failed binding read says who holds a role is unknown', async () => {
    const world = peopleWorld()
    const { container } = mountApp('/access/roles', world)
    const role = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('li[data-role="developer"]')
      if (found === null) throw new Error('no role')
      return found
    })
    await waitFor(() => expect(role.textContent).toContain('Grace'))
    expect(role.textContent).toContain('migrations.plan')
    expect(document.querySelector('li[data-role="owner"]')?.textContent).toContain(
      'Nobody holds this role.',
    )
    expect(await axeViolations(container)).toEqual([])
    cleanup()

    const failing = peopleWorld()
    failing.on('GET', '/api/v1/role-bindings', () =>
      problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.'),
    )
    mountApp('/access/roles', failing)
    expect(await screen.findByText('Could not read Role bindings')).toBeInTheDocument()
    expect(document.querySelector('li[data-role="owner"]')?.textContent).toContain(
      'Who holds this role could not be read.',
    )
  })
})

describe('the Connected applications page', () => {
  function appsWorld(): World {
    const world = new World()
    world.on('GET', '/api/v1/grants', { items: [grant()], nextCursor: null })
    world.on('GET', '/api/v1/identities', { items: [identity()], nextCursor: null })
    return world
  }

  function grantCard(): HTMLElement {
    const found = document.querySelector<HTMLElement>('li[data-grant]')
    if (found === null) throw new Error('no grant card')
    return found
  }

  it('shows client, person, resource, scopes, tiers, expiry and the last recorded use', async () => {
    const world = appsWorld()
    world.on('GET', '/api/v1/grants', {
      items: [grant({ client: { ...grant().client, name: HOSTILE } })],
      nextCursor: null,
    })
    const { container } = mountApp('/access/connected-apps', world)
    await waitFor(() => expect(grantCard()).toBeInTheDocument())
    await waitFor(() => expect(grantCard().textContent).toContain('Grace'))
    const text = grantCard().textContent ?? ''
    expect(text).toContain('<script>')
    expect(text).toContain('name not verified')
    expect(text).toContain('MCP')
    expect(text).toContain('targets.read migrations.plan')
    expect(text).toContain('Non-production')
    expect(text).toContain('Plan')
    expectInert(container)
    expect(grantCard().querySelectorAll('a')).toHaveLength(0)
    expect(world.reads('/api/v1/grants')[0]?.search.get('state')).toBe('active')
    expect(await axeViolations(container)).toEqual([])
  })

  it('says "no use recorded", never "never used", without a recorded use', async () => {
    const world = appsWorld()
    world.on('GET', '/api/v1/grants', {
      items: [grant({ lastUsedAt: null, lastUseClass: null })],
      nextCursor: null,
    })
    mountApp('/access/connected-apps', world)
    await waitFor(() => expect(grantCard().textContent).toContain('No use recorded'))
    expect(grantCard().textContent).not.toMatch(/never used\b(?! *:)/i)
  })

  it('revokes only after the confirmation, with a fresh proof; canceling sends nothing', async () => {
    const user = userEvent.setup()
    const world = appsWorld()
    world.needsProof = true
    world.on('POST', `/api/v1/grants/${grant().id}/revoke`, { revoked: true })
    mountApp('/access/connected-apps', world)
    await waitFor(() => expect(grantCard()).toBeInTheDocument())

    await user.click(within(grantCard()).getByRole('button', { name: 'Revoke' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Revoke this grant' })
    expect(dialog.textContent).toContain('stops working at once')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(world.changes).toEqual([])

    await user.click(within(grantCard()).getByRole('button', { name: 'Revoke' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Revoke this grant' })
    await user.click(within(dialog).getByRole('button', { name: 'Revoke grant' }))
    await confirmWithCode(user)
    await waitFor(() => expect(document.querySelector('p.status')).toHaveTextContent('Revoked.'))
    expect(world.changes.filter((r) => r.path.endsWith('/revoke'))).toHaveLength(2)
  })

  it('names the missing permission when the server refuses the read', async () => {
    const world = appsWorld()
    world.on('GET', '/api/v1/grants', () => problem(403, 'PERMISSION_DENIED', 'Not permitted.'))
    mountApp('/access/connected-apps', world)
    expect(await screen.findByText(/You do not have access to Grant list/)).toBeInTheDocument()
    expect(screen.queryByText('No grants')).toBeNull()
  })

  it('reads another state when the filter changes', async () => {
    const user = userEvent.setup()
    const world = appsWorld()
    mountApp('/access/connected-apps', world)
    await waitFor(() => expect(grantCard()).toBeInTheDocument())
    world.on('GET', '/api/v1/grants', { items: [], nextCursor: null })
    await user.selectOptions(screen.getByLabelText('Show'), 'revoked')
    expect(await screen.findByText('No grants')).toBeInTheDocument()
    expect(world.reads('/api/v1/grants').at(-1)?.search.get('state')).toBe('revoked')
    expect(T0).toBeDefined()
  })
})

describe('the OAuth clients page (OD-5)', () => {
  it('states both registration rules and where the mode is set, without claiming the current mode', async () => {
    const world = new World()
    world.on('GET', '/api/v1/oauth-clients', { items: [], nextCursor: null })
    const { container } = mountApp('/access/oauth-clients', world)
    const modes = await waitFor(() => {
      const found = document.getElementById('registration-modes')
      if (found === null) throw new Error('no modes')
      return found
    })
    expect(modes.textContent).toMatch(/^Open \(the default\)/)
    expect(modes.textContent).toContain('approved automatically')
    expect(modes.textContent).toContain('Every person still signs in and consents')
    expect(modes.textContent).toContain(
      'Review: a new client waits on this page until an administrator approves the exact client',
    )
    expect(modes.textContent).toContain('EXPONETDB_OAUTH_CLIENT_REGISTRATION')
    expect(modes.textContent).toContain(
      'No read of this page tells which mode this installation uses',
    )
    expect(modes.textContent).not.toMatch(/this installation (uses|runs) (open|review)/i)
    expect(await axeViolations(container)).toEqual([])
  })
})
