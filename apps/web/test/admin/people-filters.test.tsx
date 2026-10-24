import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { binding, identity, ROLES } from './fixtures.ts'
import { ME, mountApp, OTHER, PLAN, plan, problem, World } from './support.tsx'

afterEach(cleanup)

const HEIDI = 'idn_01JZ0000000000000000000003'
const IVAN = 'idn_01JZ0000000000000000000004'
const NEW = 'idn_01JZ0000000000000000000009'
const LINK = `https://db.example.test/invite#token=exiv_${'L'.repeat(43)}`

const people = () => [
  identity({ id: ME, displayName: 'Ada', email: 'owner@example.test', label: 'owner' }),
  identity(),
  identity({ id: HEIDI, displayName: 'Heidi', email: 'heidi@example.test', label: 'heidi' }),
  identity({
    id: IVAN,
    displayName: 'Ivan',
    email: 'ivan@example.test',
    label: 'ivan',
    state: 'disabled',
  }),
]

function peopleWorld(items = people()): World {
  const world = new World()
  world.on('GET', '/api/v1/identities', (request) => {
    const state = request.search.get('state')
    return {
      json: {
        items: state === null ? items : items.filter((item) => item.state === state),
        nextCursor: null,
      },
    }
  })
  world.on('GET', '/api/v1/role-bindings', { items: [binding()], nextCursor: null })
  world.on('GET', '/api/v1/roles', ROLES)
  return world
}

function card(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`li[data-identity="${id}"]`)
}

const cards = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('li[data-identity]')].map(
    (li) => li.getAttribute('data-identity') ?? '',
  )

describe('the People list filter', () => {
  it('filters by name, address or ID in the page and says how many are shown', async () => {
    const world = peopleWorld()
    const { container } = mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    expect(screen.queryByText(/^Showing \d+ of \d+ people\.$/)).toBeNull()
    const filter = screen.getByLabelText('Filter people')
    expect(filter).toHaveAttribute('type', 'search')

    // jsdom: the shell's resize handle takes pointer focus, so the field is filled as one change.
    fireEvent.change(filter, { target: { value: 'HEID' } })
    await waitFor(() => expect(cards()).toEqual([HEIDI]))
    expect(screen.getByText('Showing 1 of 4 people.')).toBeInTheDocument()

    fireEvent.change(filter, { target: { value: 'ivan@example' } })
    await waitFor(() => expect(cards()).toEqual([IVAN]))

    fireEvent.change(filter, { target: { value: OTHER } })
    await waitFor(() => expect(cards()).toEqual([OTHER]))

    fireEvent.change(filter, { target: { value: '' } })
    await waitFor(() => expect(cards()).toHaveLength(4))
    // The filter works on the read already made: no request goes out for it.
    expect(world.reads('/api/v1/identities').every((r) => !r.search.has('state'))).toBe(true)
    expect(await axeViolations(container)).toEqual([])
  })

  it('says "No match" with a Reset when the filter leaves nobody, distinct from an empty list', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    fireEvent.change(screen.getByLabelText('Filter people'), {
      target: { value: 'nobody-like-this' },
    })
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(screen.queryByText('No people yet')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(cards()).toHaveLength(4))
    expect(screen.getByLabelText('Filter people')).toHaveValue('')
    expect(screen.getByLabelText('State')).toHaveValue('all')
    cleanup()

    // An empty read, with no filter, is the empty state: it says the read succeeded.
    const empty = peopleWorld([])
    mountApp('/access/people', empty)
    expect(await screen.findByText('No people yet')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull()
  })

  it('reads one state from the server when the state is chosen, and "No match" resets it', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    await user.selectOptions(screen.getByLabelText('State'), 'disabled')
    await waitFor(() => expect(cards()).toEqual([IVAN]))
    expect(world.reads('/api/v1/identities').at(-1)?.search.get('state')).toBe('disabled')

    await user.selectOptions(screen.getByLabelText('State'), 'erased')
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(world.reads('/api/v1/identities').at(-1)?.search.get('state')).toBe('erased')
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(cards()).toHaveLength(4))
    expect(screen.getByLabelText('State')).toHaveValue('all')
  })

  it('shows a failed read as failed under a filter, never as "No match"', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    world.on('GET', '/api/v1/identities', () => problem(500, 'INTERNAL', 'The server failed.'))
    await user.selectOptions(screen.getByLabelText('State'), 'invited')
    expect(await screen.findByText('Could not read People list')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
  })
})

describe('a person’s card', () => {
  it('marks the signed-in person’s own card with "You" and no other', async () => {
    const world = peopleWorld()
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    expect(within(card(ME) as HTMLElement).getByText('You')).toBeInTheDocument()
    for (const id of [OTHER, HEIDI, IVAN]) {
      expect(within(card(id) as HTMLElement).queryByText('You')).toBeNull()
    }
  })

  it('shows the picture the server names, from its own path only, else the initials', async () => {
    const own = `/api/v1/identities/${OTHER}/avatar?v=sha256:${'a'.repeat(64)}`
    const world = peopleWorld([
      identity({
        avatar: { url: own, sha256: `sha256:${'a'.repeat(64)}`, width: 64, height: 64 },
      }),
      identity({
        id: HEIDI,
        displayName: 'Heidi',
        avatar: {
          url: 'https://evil.example/avatar.png',
          sha256: `sha256:${'b'.repeat(64)}`,
          width: 64,
          height: 64,
        },
      }),
      identity({ id: IVAN, displayName: 'Ivan Petrov' }),
    ])
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(3))
    const picture = (card(OTHER) as HTMLElement).querySelector('[data-slot="profile-avatar"] img')
    expect(picture).toHaveAttribute('src', own)
    expect(picture).toHaveAttribute('alt', '')
    // A picture at another address is never loaded; the initials stand in.
    const hostile = (card(HEIDI) as HTMLElement).querySelector('[data-slot="profile-avatar"]')
    expect(hostile?.querySelector('img')).toBeNull()
    expect(hostile).toHaveTextContent('H')
    expect(
      (card(IVAN) as HTMLElement).querySelector('[data-slot="profile-avatar"]'),
    ).toHaveTextContent('IP')
    // A picture that does not load falls back to the initials.
    fireEvent.error(picture as Element)
    await waitFor(() =>
      expect(
        (card(OTHER) as HTMLElement).querySelector('[data-slot="profile-avatar"] img'),
      ).toBeNull(),
    )
  })

  it('offers the role form to an invited person as well as an active one', async () => {
    const world = peopleWorld([
      identity({ state: 'invited', activatedAt: null }),
      identity({ id: IVAN, displayName: 'Ivan', state: 'disabled' }),
    ])
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(
      within(card(OTHER) as HTMLElement).getByRole('form', { name: 'Plan a role binding' }),
    ).toBeInTheDocument()
    expect(
      within(card(IVAN) as HTMLElement).queryByRole('form', { name: 'Plan a role binding' }),
    ).toBeNull()
  })
})

describe('after an invitation', () => {
  it('offers "Assign a role", which opens the binding form for the new person', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.on('POST', '/api/v1/identities', {
      identity: identity({
        id: NEW,
        displayName: 'Judy',
        email: 'judy@example.test',
        state: 'invited',
        activatedAt: null,
      }),
      invitation: {
        delivery: { channel: 'none', status: 'not_configured' },
        expiresAt: '2026-10-20T09:00:00Z',
        link: LINK,
      },
    })
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toEqual({
        identityId: NEW,
        roleId: 'developer',
        scope: { kind: 'global' },
      })
      return { status: 201, json: plan() }
    })
    const { router, container } = mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    expect(screen.queryByRole('button', { name: 'Assign a role' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'judy@example.test' } })
    await user.click(screen.getByRole('button', { name: 'Invite person' }))
    expect(await screen.findByText(LINK)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Assign a role' }))
    const panel = await waitFor(() => {
      const found = document.getElementById('assign-role')
      if (found === null) throw new Error('no panel')
      return found
    })
    expect(panel).toHaveTextContent('Assign a role to')
    expect(panel).toHaveTextContent('Judy')
    expect(await axeViolations(container)).toEqual([])
    const form = within(panel).getByRole('form', { name: 'Plan a role binding' })
    await user.selectOptions(within(form).getByLabelText('Role'), 'developer')
    await user.click(within(form).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v1/identities',
      'POST /api/v1/role-bindings',
    ])
  })

  it('closes the role form without sending anything', async () => {
    const user = userEvent.setup()
    const world = peopleWorld()
    world.on('POST', '/api/v1/identities', {
      identity: identity({
        id: NEW,
        displayName: null,
        email: 'judy@example.test',
        state: 'invited',
      }),
      invitation: {
        delivery: { channel: 'none', status: 'not_configured' },
        expiresAt: '2026-10-20T09:00:00Z',
        link: LINK,
      },
    })
    mountApp('/access/people', world)
    await waitFor(() => expect(cards()).toHaveLength(4))
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'judy@example.test' } })
    await user.click(screen.getByRole('button', { name: 'Invite person' }))
    await user.click(await screen.findByRole('button', { name: 'Assign a role' }))
    expect(document.getElementById('assign-role')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close role form' }))
    expect(document.getElementById('assign-role')).toBeNull()
    expect(world.changes.map((r) => r.path)).toEqual(['/api/v1/identities'])
  })
})
