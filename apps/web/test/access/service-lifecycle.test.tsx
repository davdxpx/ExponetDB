import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  grantItem,
  identityItem,
  mountApp,
  oauthClient,
  serviceAccount,
  World,
} from './support.tsx'

afterEach(cleanup)

const PLAN = 'pln_01JZ0000000000000000000001'
const BIDI = `admin${String.fromCodePoint(0x202e)}gpj.exe`
const HOSTILE = '<script>document.title="x"</script><img src=x onerror=alert(1)>'

function card(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li[data-service]')].find((li) =>
    li.querySelector('h2')?.textContent?.includes(name),
  )
  if (found === undefined) throw new Error(`no card for ${name}`)
  return found
}

const statusLine = (): HTMLElement | null => document.querySelector('p.status')

async function confirmWithCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  await user.type(
    within(reauth).getByLabelText('Or enter the code from your authenticator app'),
    '123456',
  )
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

function worldWith(over: Parameters<typeof serviceAccount>[0] = {}): World {
  const world = new World()
  world.accounts = [serviceAccount(over)]
  return world
}

describe('the responsible person of a service account', () => {
  it('is shown by name when the people read has them, and by ID when it has not', async () => {
    const world = worldWith()
    world.identities = [identityItem({ displayName: 'Ada Lovelace' })]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await waitFor(() => expect(card('Nightly checks').textContent).toContain('Ada Lovelace'))
    expect(card('Nightly checks').textContent).not.toContain('idn_01JZ0000000000000000000001')
    cleanup()

    // The read answers, but not with this person: the ID stands in.
    const unknown = worldWith()
    unknown.identities = [identityItem({ id: 'idn_01JZ0000000000000000000077' })]
    mountApp('/access/service-accounts', unknown)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await waitFor(() =>
      expect(unknown.requests.some((r) => r.path.startsWith('/api/v1/identities'))).toBe(true),
    )
    expect(card('Nightly checks').textContent).toContain('idn_01JZ0000000000000000000001')
    cleanup()

    // The read failed: the ID stands in, and nothing says the person is unknown.
    const failed = worldWith()
    failed.failures.set('GET /api/v1/identities', {
      status: 500,
      code: 'INTERNAL',
      message: 'The server failed.',
    })
    mountApp('/access/service-accounts', failed)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(card('Nightly checks').textContent).toContain('idn_01JZ0000000000000000000001')
  })

  it('shows a hostile name as text with hidden characters named', async () => {
    const world = worldWith()
    world.identities = [identityItem({ displayName: `${BIDI}${HOSTILE}` })]
    const { container } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks').textContent).toContain('⟨U+202E⟩'))
    expect(card('Nightly checks').textContent).toContain('<script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('disabling a service account', () => {
  it('asks first, keeps an optional reason in the audit, and needs a fresh proof', async () => {
    const user = userEvent.setup()
    const world = worldWith()
    world.needsProof = true
    const { container } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())

    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable this service account' })
    expect(dialog.textContent).toContain('stop working at once')
    // The reason is permanent, and the field says so.
    expect(within(dialog).getByText(/kept permanently in the audit log/)).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])

    // Canceling sends nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(world.changes).toEqual([])

    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Disable' }))
    const again = await screen.findByRole('alertdialog', { name: 'Disable this service account' })
    fireEvent.change(within(again).getByLabelText('Reason (optional)'), {
      target: { value: 'Pipeline retired' },
    })
    await user.click(within(again).getByRole('button', { name: 'Disable service account' }))
    await confirmWithCode(user)

    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'Disabled. Its API keys and machine grant no longer work.',
      ),
    )
    const sent = world.changes.filter((r) => r.path.endsWith('/disable'))
    // The first request answered REAUTH_REQUIRED; the second carries the proof and is the change.
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      method: 'POST',
      path: `/api/v1/identities/${world.accounts[0]?.id}/disable`,
      body: { reason: 'Pipeline retired' },
    })
    await waitFor(() => expect(card('Nightly checks')).toHaveClass('state-disabled'))
    // A disabled account can no longer be given keys, but can be enabled again by a plan.
    expect(
      within(card('Nightly checks')).queryByRole('button', { name: 'Create API key' }),
    ).toBeNull()
    expect(within(card('Nightly checks')).queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(
      within(card('Nightly checks')).getByRole('button', { name: 'Plan enabling' }),
    ).toBeInTheDocument()
  })

  it('sends no reason when none was typed', async () => {
    const user = userEvent.setup()
    const world = worldWith()
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable this service account' })
    await user.click(within(dialog).getByRole('button', { name: 'Disable service account' }))
    await waitFor(() => expect(world.changes).toHaveLength(1))
    expect(world.changes[0]?.body).toEqual({})
  })

  it('shows a refused change in the dialog with the server’s text and its code', async () => {
    const user = userEvent.setup()
    const world = worldWith()
    world.failures.set('POST /api/v1/identities/', {
      status: 409,
      code: 'IDENTITY_STATE_INVALID',
      message: 'The identity is not in a state that allows this.',
    })
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable this service account' })
    await user.click(within(dialog).getByRole('button', { name: 'Disable service account' }))
    expect(
      await within(dialog).findByText('The identity is not in a state that allows this.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('IDENTITY_STATE_INVALID')).toBeInTheDocument()
    expect(statusLine()).toHaveTextContent('')
  })
})

describe('enabling and erasing a service account', () => {
  it('plans enabling a disabled account and opens the plan; nothing is enabled here', async () => {
    const user = userEvent.setup()
    const world = worldWith({ state: 'disabled' })
    const { router } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Plan enabling' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan enabling this service account',
    })
    expect(dialog.textContent).toContain('Nothing changes until the plan is approved and applied')
    expect(world.changes).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Create plan to enable' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/identities/${world.accounts[0]?.id}/enable-plans`,
        body: {},
      },
    ])
    expect(world.accounts[0]?.state).toBe('disabled')
  })

  it('offers enabling only to a disabled account and disabling only to an active one', async () => {
    const world = worldWith()
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(
      within(card('Nightly checks')).getByRole('button', { name: 'Disable' }),
    ).toBeInTheDocument()
    expect(
      within(card('Nightly checks')).queryByRole('button', { name: 'Plan enabling' }),
    ).toBeNull()
  })

  it('plans erasure only after the account’s name is typed exactly', async () => {
    const user = userEvent.setup()
    const world = worldWith()
    const { router } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Plan erasure' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan erasing this service account',
    })
    expect(dialog.textContent).toContain('critical plan')
    const action = within(dialog).getByRole('button', { name: 'Create erasure plan' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    const field = within(dialog).getByLabelText(/To confirm, type the account name/)

    // The wrong text, and the right text in the wrong case, are named and send nothing.
    fireEvent.change(field, { target: { value: 'nightly checks' } })
    await user.click(action)
    expect(
      await within(dialog).findByText(
        'The text must match exactly, including upper and lower case.',
      ),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])

    fireEvent.change(field, { target: { value: 'Nightly checks' } })
    expect(within(dialog).getByRole('button', { name: 'Create erasure plan' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create erasure plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/identities/${world.accounts[0]?.id}/erasure-plans`,
        body: {},
      },
    ])
  })

  it('cancels erasure without a request, and asks for the label when the account has no name', async () => {
    const user = userEvent.setup()
    const world = worldWith({ displayName: null, label: 'svc-anonymous' })
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('svc-anonymous')).toBeInTheDocument())
    await user.click(within(card('svc-anonymous')).getByRole('button', { name: 'Plan erasure' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan erasing this service account',
    })
    expect(dialog.textContent).toContain('svc-anonymous')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(world.changes).toEqual([])
  })

  it('names a hidden character of the account name in the typed confirmation', async () => {
    const user = userEvent.setup()
    const world = worldWith({ displayName: `ops${String.fromCodePoint(0x200b)}bot` })
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(document.querySelector('li[data-service]')).not.toBeNull())
    const li = document.querySelector('li[data-service]') as HTMLElement
    await user.click(within(li).getByRole('button', { name: 'Plan erasure' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan erasing this service account',
    })
    expect(dialog.textContent).toContain('⟨U+200B⟩')
  })
})

describe('ending a machine grant', () => {
  function grantWorld() {
    const world = worldWith({
      client: oauthClient({ registration: 'pre_registered', kind: 'ci', state: 'active' }),
    })
    const account = world.accounts[0]
    if (account === undefined) throw new Error('no account')
    const active = grantItem({
      id: 'grt_01JZ0000000000000000000051',
      kind: 'machine',
      identityId: account.id,
      resource: 'api',
    })
    const revoked = grantItem({
      id: 'grt_01JZ0000000000000000000052',
      kind: 'machine',
      identityId: account.id,
      resource: 'api',
      state: 'revoked',
      revokedAt: '2026-10-13T10:00:00Z',
    })
    world.accounts = [{ ...account, grants: [revoked, active] }]
    return { world, active, revoked }
  }

  it('revokes an active grant after a confirmation, with an optional reason and a fresh proof', async () => {
    const user = userEvent.setup()
    const { world, active, revoked } = grantWorld()
    world.needsProof = true
    const { container } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    // Only the active grant has a Revoke.
    expect(
      within(card('Nightly checks')).queryByRole('button', {
        name: `Revoke machine grant ${revoked.id}`,
      }),
    ).toBeNull()
    await user.click(
      within(card('Nightly checks')).getByRole('button', {
        name: `Revoke machine grant ${active.id}`,
      }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this machine grant' })
    expect(dialog.textContent).toContain('stops working at once')
    expect(within(dialog).getByText(/kept permanently in the audit log/)).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(world.changes).toEqual([])

    await user.click(
      within(card('Nightly checks')).getByRole('button', {
        name: `Revoke machine grant ${active.id}`,
      }),
    )
    const again = await screen.findByRole('alertdialog', { name: 'Revoke this machine grant' })
    fireEvent.change(within(again).getByLabelText('Reason (optional)'), {
      target: { value: 'Key rotation' },
    })
    await user.click(within(again).getByRole('button', { name: 'Revoke machine grant' }))
    await confirmWithCode(user)
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'Machine grant revoked. Every token of this grant has stopped working.',
      ),
    )
    const sent = world.changes.filter((r) => r.path.endsWith('/revoke'))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({
      method: 'POST',
      path: `/api/v1/grants/${active.id}/revoke`,
      body: { reason: 'Key rotation' },
    })
    await waitFor(() =>
      expect(
        within(card('Nightly checks')).queryByRole('button', {
          name: `Revoke machine grant ${active.id}`,
        }),
      ).toBeNull(),
    )
    expect(card('Nightly checks').textContent).toContain('revoked, until')
  })

  it('offers no revoke, disable or erase without access.manage', async () => {
    const { world } = grantWorld()
    world.permissions = ['access.read']
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(
      screen.queryByRole('button', {
        name: /Revoke machine grant|Disable|Plan erasure|Plan enabling/,
      }),
    ).toBeNull()
  })

  it('shows where a grant may act beside it', async () => {
    const { world, active } = grantWorld()
    const account = world.accounts[0]
    if (account === undefined) throw new Error('no account')
    world.accounts = [
      {
        ...account,
        grants: [
          {
            ...active,
            restrictions: {
              tiers: ['nonprod'],
              targets: { kind: 'list', targetIds: ['tgt_01JZ0000000000000000000011'] },
            },
          },
        ],
      },
    ]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(card('Nightly checks').textContent).toContain(
      'Targets: limited to 1 target (tgt_01JZ0000000000000000000011).',
    )
  })

  it('shows no lifecycle action on an erased account', async () => {
    const world = worldWith({ state: 'erased' })
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    for (const name of ['Disable', 'Plan enabling', 'Plan erasure']) {
      expect(within(card('Nightly checks')).queryByRole('button', { name })).toBeNull()
    }
  })
})
