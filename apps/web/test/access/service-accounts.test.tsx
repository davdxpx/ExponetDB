import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { accessKeys } from '../../src/features/access/keys.ts'
import {
  apiKey,
  cacheText,
  mountApp,
  oauthClient,
  SECRET,
  serviceAccount,
  World,
} from './support.tsx'

afterEach(cleanup)

const EC = {
  kty: 'EC',
  crv: 'P-256',
  kid: 'nightly-1',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
}

function card(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li[data-service]')].find((li) =>
    li.querySelector('h2')?.textContent?.includes(name),
  )
  if (found === undefined) throw new Error(`no card for ${name}`)
  return found
}

const statusLine = (): HTMLElement | null => document.querySelector('p.status')
const alertLine = (): HTMLElement | null => document.querySelector('p.alert')

async function confirmWithCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  await user.type(
    within(reauth).getByLabelText('Or enter the code from your authenticator app'),
    '123456',
  )
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

// Each case mounts the whole shell and runs axe; under a loaded machine that takes seconds.
describe('the service accounts page', { timeout: 20_000 }, () => {
  it('creates a service account with a fresh proof and says it has no role and no credential', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const { container } = mountApp('/access/service-accounts', world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Service accounts' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Scopes never add a permission')).toBeInTheDocument()

    const form = await waitFor(() => {
      const found = document.getElementById('service-create')
      if (found === null) throw new Error('no #service-create')
      return found
    })
    const name = form.querySelector('input[name="name"]')
    if (!(name instanceof HTMLInputElement)) throw new Error('no name field')
    // jsdom lays nothing out, so the shell's resize handle claims every pointer press: focus the field, then type.
    name.focus()
    await user.keyboard('Nightly checks')
    const submit = form.querySelector('button[type="submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('no submit')
    await user.click(submit)
    await confirmWithCode(user)

    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(card('Nightly checks')).toHaveClass('card', 'state-active')
    expect(world.changes.filter((r) => r.path === '/api/v1/service-accounts')).toEqual([
      { method: 'POST', path: '/api/v1/service-accounts', body: { displayName: 'Nightly checks' } },
      { method: 'POST', path: '/api/v1/service-accounts', body: { displayName: 'Nightly checks' } },
    ])
    expect(statusLine()).toHaveTextContent(
      'Service account created. It has no role and no credential yet.',
    )
    expect(name).toHaveValue('')
    expect(await axeViolations(container)).toEqual([])
  })

  it('registers the client with public keys and shows them as kid (kty)', async () => {
    const user = userEvent.setup()
    const world = new World()
    const account = serviceAccount()
    world.accounts = [account]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())

    const jwks = card('Nightly checks').querySelector('textarea[name="jwks"]')
    if (!(jwks instanceof HTMLTextAreaElement)) throw new Error('no jwks field')
    expect(jwks).toHaveAttribute('spellcheck', 'false')
    expect(jwks).toHaveAttribute('autocomplete', 'off')
    fireEvent.change(jwks, { target: { value: JSON.stringify({ keys: [EC] }) } })
    await user.click(
      within(card('Nightly checks')).getByRole('button', { name: 'Register client' }),
    )

    await waitFor(() => expect(card('Nightly checks').textContent).toContain('nightly-1 (EC)'))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/service-accounts/${account.id}/oauth-client`,
        body: { jwks: { keys: [EC] } },
      },
    ])
    expect(statusLine()).toHaveTextContent('Client registered.')
    expect(jwks).toHaveValue('')
    // A registered client offers the replacement and the machine grant.
    expect(
      within(card('Nightly checks')).getByRole('button', { name: 'Replace keys' }),
    ).toBeInTheDocument()
    expect(
      within(card('Nightly checks')).getByRole('button', { name: 'Create machine grant' }),
    ).toBeInTheDocument()
  })

  it('refuses a private key before anything is sent and clears the field at once', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.accounts = [serviceAccount()]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    const jwks = card('Nightly checks').querySelector('textarea[name="jwks"]')
    if (!(jwks instanceof HTMLTextAreaElement)) throw new Error('no jwks field')
    const register = within(card('Nightly checks')).getByRole('button', { name: 'Register client' })

    const privateJwk = JSON.stringify({
      keys: [{ ...EC, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' }],
    })
    fireEvent.change(jwks, { target: { value: privateJwk } })
    await user.click(register)
    expect(
      await within(card('Nightly checks')).findByText(
        'This is a private key. Nothing was sent, and the field was cleared. Paste only the public keys.',
      ),
    ).toBeInTheDocument()
    expect(jwks).toHaveValue('')
    expect(document.body.innerHTML).not.toContain('jpsQnnGQmL')

    fireEvent.change(jwks, {
      target: {
        value: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----',
      },
    })
    await user.click(register)
    await waitFor(() => expect(jwks).toHaveValue(''))
    expect(document.body.innerHTML).not.toContain('MIGHAgEAMBMGByqGSM49')

    // Text that is not JSON stays for the person to fix; nothing is sent either.
    fireEvent.change(jwks, { target: { value: '{"keys": [' } })
    await user.click(register)
    expect(
      await within(card('Nightly checks')).findByText(
        'The keys are not valid JSON. Paste the JWKS as it is.',
      ),
    ).toBeInTheDocument()
    expect(jwks).toHaveValue('{"keys": [')
    expect(world.changes).toEqual([])
  })

  it('shows a new API key once, never in the cache, and never again after it is hidden or the page is left', async () => {
    const user = userEvent.setup()
    const world = new World()
    const account = serviceAccount()
    world.accounts = [account]
    const { queryClient, router } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())

    // The defaults: targets.read, non-production, 90 days, summarized next to the button.
    expect(card('Nightly checks').textContent).toContain(
      'Scopes: targets.read. Tiers: Non-production. Lifetime: 90 days.',
    )
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Create API key' }))

    const secret = await screen.findByText(SECRET)
    expect(secret).toHaveAttribute('id', 'api-key-secret')
    expect(secret.textContent).toBe(SECRET)
    expect(card('Nightly checks')).toContainElement(secret)
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/service-accounts/${account.id}/api-keys`,
        body: {
          scopes: ['targets.read'],
          restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
          lifetimeDays: 90,
        },
      },
    ])
    expect(statusLine()).toHaveTextContent('API key created.')
    // The list holds the key without its secret; the caches never hold the secret.
    await waitFor(() =>
      expect(
        within(card('Nightly checks')).getByText(/targets\.read, active, until/),
      ).toBeInTheDocument(),
    )
    expect(cacheText(queryClient)).not.toContain(SECRET)
    expect(await axeViolations(document.body)).toEqual([])
    expect(document.querySelectorAll('#api-key-secret')).toHaveLength(1)
    for (const field of document.querySelectorAll('input, textarea')) {
      expect((field as HTMLInputElement).value).not.toContain(SECRET)
    }
    expect(document.title).not.toContain(SECRET)

    // A refresh of the list keeps the one display and never adds another.
    await act(() => queryClient.invalidateQueries({ queryKey: accessKeys.serviceAccounts }))
    expect(document.querySelectorAll('#api-key-secret')).toHaveLength(1)
    expect(cacheText(queryClient)).not.toContain(SECRET)

    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Hide the key' }))
    expect(document.getElementById('api-key-secret')).toBeNull()
    expect(document.body.innerHTML).not.toContain(SECRET)
    await act(() => queryClient.invalidateQueries({ queryKey: accessKeys.serviceAccounts }))
    expect(document.body.innerHTML).not.toContain(SECRET)

    // Created again, then the page is left and opened again: the secret is gone for good.
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Create API key' }))
    expect(await screen.findByText(SECRET)).toBeInTheDocument()
    await act(() => router.navigate({ to: '/access/oauth-clients' }))
    await screen.findByRole('heading', { level: 1, name: 'OAuth clients' })
    expect(document.body.innerHTML).not.toContain(SECRET)
    await act(() => router.history.back())
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(document.getElementById('api-key-secret')).toBeNull()
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(router.state.location)).not.toContain(SECRET)
    expect(cacheText(queryClient)).not.toContain(SECRET)
  })

  it('revokes an API key after a confirmation, and a revoked key loses its one-time display', async () => {
    const user = userEvent.setup()
    const world = new World()
    const account = serviceAccount({ apiKeys: [apiKey({ label: 'deploy' })] })
    world.accounts = [account]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())

    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Create API key' }))
    expect(await screen.findByText(SECRET)).toBeInTheDocument()
    const created = world.account(account.id).apiKeys[1]
    if (created === undefined) throw new Error('no created key')

    const row = await waitFor(() => {
      const li = [...card('Nightly checks').querySelectorAll('li')].find((item) =>
        item.textContent?.includes(created.id),
      )
      if (li === undefined) throw new Error('no row')
      return li
    })
    expect(row.textContent).toContain('targets.read, active')
    await user.click(within(row).getByRole('button', { name: `Revoke API key ${created.id}` }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this API key' })
    expect(dialog.textContent).toContain('This cannot be undone')
    expect(world.changes.filter((r) => r.path.endsWith('/revoke'))).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Revoke API key' }))

    await waitFor(() => expect(statusLine()).toHaveTextContent('API key revoked.'))
    expect(world.changes.filter((r) => r.path.endsWith('/revoke'))).toEqual([
      { method: 'POST', path: `/api/v1/api-keys/${created.id}/revoke`, body: {} },
    ])
    await waitFor(() => expect(row.textContent).toContain('targets.read, revoked'))
    expect(document.getElementById('api-key-secret')).toBeNull()
    // The other key keeps its label, shown as text.
    expect(card('Nightly checks').textContent).toContain('deploy')
  })

  it('asks for the production acknowledgement exactly when the choice is production write authority', async () => {
    const user = userEvent.setup()
    const world = new World()
    const account = serviceAccount()
    world.accounts = [account]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    const scope = () => within(card('Nightly checks'))
    // The API key form is the last authority form of the card (the account has no client yet).
    await user.click(scope().getByRole('button', { name: 'Change scopes and limits' }))
    expect(scope().getByText(/A ceiling, never a permission/)).toBeInTheDocument()
    await user.click(scope().getByRole('checkbox', { name: 'migrations.apply:prod' }))
    await user.click(scope().getByRole('button', { name: 'Create API key' }))
    expect(
      await scope().findByText('The scope migrations.apply:prod needs the tier Production.'),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])

    await user.click(scope().getByRole('checkbox', { name: 'Production' }))
    const acknowledgement = await scope().findByRole('checkbox', {
      name: 'I give this service account production write authority',
    })
    expect(await axeViolations(card('Nightly checks'))).toEqual([])
    await user.click(scope().getByRole('button', { name: 'Create API key' }))
    expect(
      await scope().findByText(
        'Confirm that you give production write authority, or leave production out.',
      ),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])

    await user.click(acknowledgement)
    await user.click(scope().getByRole('button', { name: 'Create API key' }))
    await screen.findByText(SECRET)
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/service-accounts/${account.id}/api-keys`,
        body: {
          scopes: ['targets.read', 'migrations.apply:prod'],
          restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
          lifetimeDays: 90,
          acknowledgeProductionWrite: true,
        },
      },
    ])
  })

  it('confirms before a new machine grant replaces the active one', async () => {
    const user = userEvent.setup()
    const world = new World()
    const account = serviceAccount({
      client: oauthClient({ registration: 'pre_registered', kind: 'ci', state: 'active' }),
    })
    world.accounts = [account]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())

    // No grant yet: created at once.
    await user.click(
      within(card('Nightly checks')).getByRole('button', { name: 'Create machine grant' }),
    )
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent('Machine grant created; any earlier one ended.'),
    )
    await waitFor(() =>
      expect(card('Nightly checks').textContent).toContain(
        'targets.read (Non-production), active, until',
      ),
    )

    // An active grant: the replacement is confirmed first.
    await user.click(
      within(card('Nightly checks')).getByRole('button', { name: 'Create machine grant' }),
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Replace the machine grant' })
    expect(world.changes.filter((r) => r.path.endsWith('/grants'))).toHaveLength(1)
    await user.click(within(dialog).getByRole('button', { name: 'Replace machine grant' }))
    await waitFor(() =>
      expect(world.changes.filter((r) => r.path.endsWith('/grants'))).toHaveLength(2),
    )
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('renders a hostile name as text and offers nothing to change without access.manage', async () => {
    const world = new World()
    world.permissions = ['access.read']
    world.accounts = [
      serviceAccount({ displayName: 'CI <script>alert(1)</script>‮exe', apiKeys: [apiKey()] }),
    ]
    const { container } = mountApp('/access/service-accounts', world)
    const heading = await waitFor(() => {
      const found = document.querySelector('li[data-service] h2')
      if (found === null) throw new Error('no card')
      return found
    })
    expect(heading.textContent).toContain('CI <script>alert(1)</script>')
    expect(heading.textContent).toContain('⟨U+202E⟩')
    expect(container.querySelectorAll('li[data-service] script')).toHaveLength(0)
    expect(document.getElementById('service-create')).toBeNull()
    expect(document.querySelector('textarea[name="jwks"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Create API key|Revoke/ })).toBeNull()
    expect(screen.getByText(/Changing it needs the permission access.manage/)).toBeInTheDocument()
    expect(alertLine()).toHaveTextContent('')
  })

  it('shows a refused change in the alert line with its code, never exception text', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.accounts = [serviceAccount()]
    world.failures.set('POST /api/v1/service-accounts/', {
      status: 403,
      code: 'SCOPE_NOT_DELEGABLE',
      message: 'You cannot delegate a scope you do not hold.',
    })
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    await user.click(within(card('Nightly checks')).getByRole('button', { name: 'Create API key' }))
    await waitFor(() =>
      expect(alertLine()).toHaveTextContent(
        'You cannot delegate a scope you do not hold. (SCOPE_NOT_DELEGABLE)',
      ),
    )
    expect(document.getElementById('api-key-secret')).toBeNull()
  })

  it('moves /admin/service-accounts to /access/service-accounts, replacing the old entry', async () => {
    const world = new World()
    const { router } = mountApp('/admin/service-accounts', world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Service accounts' }),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/access/service-accounts')
    expect(router.history.length).toBe(1)
  })
})
