import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  EXPIRES_SOON_DAYS,
  filterKeys,
  keyFlags,
  UNUSED_DAYS,
} from '../../src/features/access/api-keys-model.ts'
import { accessKeys } from '../../src/features/access/keys.ts'
import { secretExposure } from '../security/secret-scan.ts'
import {
  apiKey,
  cacheText,
  mountApp,
  SECRET,
  serviceAccount,
  targetItem,
  World,
} from './support.tsx'

afterEach(cleanup)

const DAY = 24 * 60 * 60_000
const BOOM = { status: 500, code: 'INTERNAL', message: 'The server failed.' }
const BIDI = `admin${String.fromCodePoint(0x202e)}gpj.exe`
const HOSTILE = '<script>document.title="x"</script><img src=x onerror=alert(1)>'

/** A moment `days` from now (negative: before), as the API writes times. */
const at = (days: number): string => new Date(Date.now() + days * DAY).toISOString()
const tid = (n: number): string => `tgt_01JZ${String(n).padStart(22, '0')}`
const kid = (n: number): string => `key_01JZ${String(n).padStart(22, '0')}`

function section(): HTMLElement {
  const found = document.querySelector<HTMLElement>('section[aria-label="API key overview"]')
  if (found === null) throw new Error('no overview section')
  return found
}

async function open(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => expect(section()).toBeInTheDocument())
  await user.click(within(section()).getByRole('button', { name: 'All API keys' }))
  return section()
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('tr[data-api-key]')]
}

function row(id: string): HTMLElement {
  const found = rows().find((r) => r.getAttribute('data-api-key') === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

function overviewWorld(): World {
  const world = new World()
  const nightly = serviceAccount({
    id: 'idn_01JZ0000000000000000000011',
    displayName: 'Nightly checks',
  })
  const deploy = serviceAccount({
    id: 'idn_01JZ0000000000000000000012',
    displayName: 'Deploy bot',
    label: 'svc-deploy-bot',
  })
  world.accounts = [
    {
      ...nightly,
      apiKeys: [
        apiKey({
          id: kid(1),
          serviceAccountId: nightly.id,
          label: 'ci',
          createdAt: at(-100),
          lastUsedAt: at(-1),
          expiresAt: at(60),
        }),
        apiKey({
          id: kid(2),
          serviceAccountId: nightly.id,
          label: null,
          createdAt: at(-5),
          lastUsedAt: null,
          expiresAt: at(5),
        }),
      ],
    },
    {
      ...deploy,
      apiKeys: [
        apiKey({
          id: kid(3),
          serviceAccountId: deploy.id,
          label: 'old',
          state: 'revoked',
          revokedAt: at(-2),
          createdAt: at(-90),
          lastUsedAt: at(-60),
          expiresAt: at(3),
        }),
      ],
    },
  ]
  return world
}

describe('the key flags', () => {
  const key = (over: Parameters<typeof apiKey>[0]) => apiKey({ createdAt: at(-100), ...over })
  const now = Date.now()

  it('flags an active key that expires in under 14 days, and no other', () => {
    expect(EXPIRES_SOON_DAYS).toBe(14)
    expect(keyFlags(key({ expiresAt: at(13.9), lastUsedAt: at(-1) }), now).expiresSoon).toBe(true)
    expect(keyFlags(key({ expiresAt: at(14.1), lastUsedAt: at(-1) }), now).expiresSoon).toBe(false)
    // Already expired by date, or no longer active: nothing to warn about.
    expect(keyFlags(key({ expiresAt: at(-1), lastUsedAt: at(-1) }), now).expiresSoon).toBe(false)
    expect(
      keyFlags(key({ state: 'revoked', expiresAt: at(3), lastUsedAt: at(-1) }), now).expiresSoon,
    ).toBe(false)
    expect(keyFlags(key({ state: 'expired', expiresAt: at(3) }), now)).toEqual({
      expiresSoon: false,
      unused: false,
    })
  })

  it('flags an active key not used for 30 days, counting a never-used key from its creation', () => {
    expect(UNUSED_DAYS).toBe(30)
    expect(keyFlags(key({ lastUsedAt: at(-31), expiresAt: at(60) }), now).unused).toBe(true)
    expect(keyFlags(key({ lastUsedAt: at(-29), expiresAt: at(60) }), now).unused).toBe(false)
    expect(
      keyFlags(key({ lastUsedAt: null, createdAt: at(-31), expiresAt: at(60) }), now).unused,
    ).toBe(true)
    expect(
      keyFlags(key({ lastUsedAt: null, createdAt: at(-5), expiresAt: at(60) }), now).unused,
    ).toBe(false)
    expect(keyFlags(key({ state: 'revoked', lastUsedAt: at(-90) }), now).unused).toBe(false)
  })

  it('keeps the keys of one state, or all of them', () => {
    const keys = [
      apiKey({ state: 'active' }),
      apiKey({ state: 'revoked' }),
      apiKey({ state: 'expired' }),
    ]
    expect(filterKeys(keys, 'all')).toHaveLength(3)
    expect(filterKeys(keys, 'revoked').map((k) => k.state)).toEqual(['revoked'])
  })
})

describe('the All API keys overview', () => {
  it('is closed and reads nothing until it is opened, and has no page of its own', async () => {
    const world = overviewWorld()
    const { router } = mountApp('/access/service-accounts', world)
    await waitFor(() => expect(section()).toBeInTheDocument())
    const trigger = within(section()).getByRole('button', { name: 'All API keys' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() =>
      expect(world.requests.some((r) => r.path.startsWith('/api/v1/service-accounts'))).toBe(true),
    )
    expect(world.requests.some((r) => r.path.startsWith('/api/v1/api-keys'))).toBe(false)
    expect(rows()).toHaveLength(0)
    expect(router.state.location.pathname).toBe('/access/service-accounts')
    // There is deliberately no /access/api-keys.
    expect(document.querySelector('a[href="/access/api-keys"]')).toBeNull()
  })

  it('lists every key with its account, scopes, tier, state, last use and expiry', async () => {
    const world = overviewWorld()
    const { container } = mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const ci = row(kid(1))
    expect(ci.textContent).toContain('Nightly checks')
    expect(ci.textContent).toContain('ci')
    expect(ci.textContent).toContain(kid(1))
    expect(ci.textContent).toContain('targets.read')
    expect(ci.textContent).toContain('Non-production')
    expect(ci.textContent).toContain('All targets the roles reach')
    expect(within(ci).getByText('Active')).toBeInTheDocument()
    expect(row(kid(3)).textContent).toContain('Deploy bot')
    expect(within(row(kid(3))).getByText('Revoked')).toBeInTheDocument()
    expect(screen.getByText('Showing 3 of 3 API keys.')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('says "Never used" only for a key whose read has no use, and shows the time otherwise', async () => {
    const world = overviewWorld()
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(within(row(kid(2))).getByText('Never used')).toBeInTheDocument()
    expect(within(row(kid(1))).queryByText('Never used')).toBeNull()
    expect(
      within(row(kid(1))).getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, { selector: 'td' }),
    ).toBeInTheDocument()
  })

  it('flags a key that expires in under 14 days and one not used for 30 days', async () => {
    const world = overviewWorld()
    world.accounts = world.accounts.map((account) => ({
      ...account,
      apiKeys: [
        ...account.apiKeys,
        apiKey({
          id: kid(4),
          serviceAccountId: account.id,
          createdAt: at(-200),
          lastUsedAt: at(-45),
          expiresAt: at(100),
        }),
      ],
    }))
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows().length).toBeGreaterThan(3))
    // kid(2): active, never used, created 5 days ago, expires in 5 days.
    expect(within(row(kid(2))).getByText('Expires in under 14 days')).toBeInTheDocument()
    expect(within(row(kid(2))).queryByText('Not used for 30 days')).toBeNull()
    // kid(4): last used 45 days ago, expires far away.
    expect(within(row(kid(4))).getByText('Not used for 30 days')).toBeInTheDocument()
    expect(within(row(kid(4))).queryByText('Expires in under 14 days')).toBeNull()
    // kid(1): used yesterday, expires in 60 days. kid(3): revoked, even though it expires in 3 days.
    for (const id of [kid(1), kid(3)]) {
      expect(within(row(id)).queryByText('Expires in under 14 days')).toBeNull()
      expect(within(row(id)).queryByText('Not used for 30 days')).toBeNull()
    }
  })

  it('filters by state and says "No match" with a Reset when none fits, unlike an empty list', async () => {
    const user = userEvent.setup()
    const world = overviewWorld()
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    await user.selectOptions(within(section()).getByLabelText('State'), 'revoked')
    expect(rows().map((r) => r.getAttribute('data-api-key'))).toEqual([kid(3)])
    expect(screen.getByText('Showing 1 of 3 API keys.')).toBeInTheDocument()
    await user.selectOptions(within(section()).getByLabelText('State'), 'expired')
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(rows()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(rows()).toHaveLength(3)
    expect(within(section()).getByLabelText('State')).toHaveValue('all')
  })

  it('shows where a limited key may act, with paths when the registry can be read and IDs otherwise', async () => {
    const world = overviewWorld()
    const limited = apiKey({
      id: kid(5),
      serviceAccountId: 'idn_01JZ0000000000000000000011',
      restrictions: {
        tiers: ['prod'],
        targets: { kind: 'list', targetIds: [tid(1), tid(2)] },
      },
    })
    world.accounts = world.accounts.map((account, index) =>
      index === 0 ? { ...account, apiKeys: [...account.apiKeys, limited] } : account,
    )
    world.targets = [targetItem({ id: tid(1), path: 'shop/app/production', tier: 'prod' })]
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const cell = row(kid(5))
    expect(cell.textContent).toContain('Only 2 targets')
    expect(cell.textContent).toContain('Production')
    await waitFor(() => expect(cell.textContent).toContain('shop/app/production'))
    // A target the read does not hold is shown by its ID.
    expect(cell.textContent).toContain(tid(2))
    cleanup()

    // Without the registry read the IDs stand alone, and nothing is claimed about the paths.
    const blind = overviewWorld()
    blind.accounts = world.accounts
    blind.failures.set('GET /api/v1/targets', BOOM)
    mountApp('/access/service-accounts', blind)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(row(kid(5)).textContent).toContain(tid(1))
    expect(row(kid(5)).textContent).not.toContain('shop/app')
  })

  it('reads the registry only when a key is limited to named targets', async () => {
    const world = overviewWorld()
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(world.requests.some((r) => r.path.startsWith('/api/v1/targets'))).toBe(false)
  })

  it('shows hostile labels and names as text with hidden characters named', async () => {
    const world = overviewWorld()
    world.accounts = world.accounts.map((account, index) =>
      index === 0
        ? {
            ...account,
            displayName: `${BIDI}${HOSTILE}`,
            apiKeys: account.apiKeys.map((key, k) =>
              k === 0 ? { ...key, label: `${BIDI}x` } : key,
            ),
          }
        : account,
    )
    const { container } = mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(row(kid(1)).textContent).toContain('⟨U+202E⟩')
    expect(row(kid(1)).textContent).toContain('<script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('names the account by its ID when the service accounts could not be read', async () => {
    const world = overviewWorld()
    world.failures.set('GET /api/v1/service-accounts', BOOM)
    mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(row(kid(1)).textContent).toContain('idn_01JZ0000000000000000000011')
    expect(row(kid(1)).textContent).not.toContain('Nightly checks')
  })
})

describe('the read states of the All API keys overview', () => {
  it('shows a failed read as failed, never as an empty list of keys', async () => {
    const world = overviewWorld()
    world.failures.set('GET /api/v1/api-keys', BOOM)
    const { container } = mountApp('/access/service-accounts', world)
    await open()
    expect(await screen.findByText('Could not read API key list')).toBeInTheDocument()
    expect(screen.queryByText('No API keys yet')).toBeNull()
    expect(screen.queryByText('Never used')).toBeNull()
    expect(rows()).toHaveLength(0)
    expect(await axeViolations(container)).toEqual([])
  })

  it('names the missing permission when the server refuses the read', async () => {
    const world = overviewWorld()
    world.failures.set('GET /api/v1/api-keys', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'Not permitted.',
    })
    mountApp('/access/service-accounts', world)
    await open()
    expect(await screen.findByText(/You do not have access to API key list/)).toBeInTheDocument()
    expect(screen.queryByText('No API keys yet')).toBeNull()
  })

  it('says a partial read is partial: more keys exist than are listed', async () => {
    const world = overviewWorld()
    world.cursors.set('/api/v1/api-keys', 'more')
    mountApp('/access/service-accounts', world)
    await open()
    expect(await screen.findByText('Showing part of API key list')).toBeInTheDocument()
    expect(screen.getByText(/Only the first 200 API keys are shown/)).toBeInTheDocument()
    expect(rows()).toHaveLength(3)
  })

  it('shows an earlier read as stale with its age and a refresh when a refresh failed', async () => {
    const world = overviewWorld()
    const { queryClient } = mountApp('/access/service-accounts', world)
    await open()
    await waitFor(() => expect(rows()).toHaveLength(3))
    world.failures.set('GET /api/v1/api-keys', BOOM)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: accessKeys.apiKeys })
    })
    expect(await screen.findByText('Showing an earlier read of API key list')).toBeInTheDocument()
    expect(rows()).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('says the list is empty only after a successful read that found no key', async () => {
    const world = new World()
    world.accounts = [serviceAccount()]
    mountApp('/access/service-accounts', world)
    await open()
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
    expect(within(section()).queryByLabelText('State')).toBeNull()
  })
})

describe('the overview and the secret of a new key', () => {
  it('lists a new key without its secret, which is shown once in the account card only', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.accounts = [serviceAccount()]
    const { queryClient } = mountApp('/access/service-accounts', world)
    await open()
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument()
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('li[data-service]')
      if (found === null) throw new Error('no card')
      return found
    })
    await user.click(within(card).getByRole('button', { name: 'Create API key' }))
    expect(await screen.findByText(SECRET)).toBeInTheDocument()
    // The overview read the keys again (it sits under the service accounts' key) and holds the key.
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(section().textContent).not.toContain(SECRET)
    expect(cacheText(queryClient)).not.toContain(SECRET)
    expect(secretExposure(document.body, SECRET, '#api-key-secret')).toEqual([])
    fireEvent.click(within(card).getByRole('button', { name: 'Hide the key' }))
    expect(document.body.innerHTML).not.toContain(SECRET)
  })
})
