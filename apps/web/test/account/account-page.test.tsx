import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  type Grant,
  grantSummary,
  lastUseOf,
  removePasskeyPath,
} from '../../src/features/account/account-model.ts'
import { en } from '../../src/lib/i18n/en.ts'
import {
  cacheText,
  FakeServer,
  grant,
  ids,
  json,
  meOf,
  mountApp,
  NOW,
  passkey,
  problem,
  storageText,
  webSession,
} from './support.tsx'

const webauthn = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'new-credential' })),
  assert: vi.fn(async () => ({ id: 'proof' })),
}))

vi.mock('../../src/lib/auth/webauthn.ts', () => ({
  PasskeyCanceled: class PasskeyCanceled extends Error {
    override readonly name = 'PasskeyCanceled'
  },
  passkeysSupported: () => true,
  assertWithPasskey: webauthn.assert,
  createPasskey: webauthn.create,
}))

const TOTP_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const CODES = Array.from({ length: 10 }, (_, n) => `ZZZZ-YYYY-XXXX-WW${n}${n}`)

beforeEach(() => {
  webauthn.create.mockClear()
  webauthn.assert.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

interface World {
  me: unknown
  passkeys: unknown[]
  sessions: unknown[]
  grants: unknown[]
}

function server(world: World): FakeServer {
  return new FakeServer()
    .on('GET', '/api/v1/me', () => json(200, world.me))
    .on('GET', '/api/v1/me/factors', () =>
      json(200, {
        items: [
          ...world.passkeys,
          { id: ids.factor(90), kind: 'password', createdAt: NOW },
          { id: ids.factor(91), kind: 'totp', createdAt: NOW, lastUsedAt: null },
          { id: ids.factor(92), kind: 'recovery_codes', createdAt: NOW, remaining: 7 },
        ],
      }),
    )
    .on('GET', '/api/v1/me/sessions', () => json(200, { items: world.sessions }))
    .on('GET', '/api/v1/me/grants', () => json(200, { items: world.grants }))
}

function world(over: Partial<World> = {}): World {
  return {
    me: meOf(),
    passkeys: [passkey(1, 'Laptop')],
    sessions: [webSession(1), webSession(2), webSession(3)],
    grants: [
      grant(1, { name: 'ExponetDB CLI', firstParty: true, resource: 'api' }),
      grant(2, { name: 'Agent', lastUsedAt: '2026-10-13T11:58:00.000Z', lastUseClass: 'read' }),
    ],
    ...over,
  }
}

async function accountReady(): Promise<void> {
  await waitFor(() => expect(document.querySelector('#passkey-list')).not.toBeNull())
}

describe('the account model', () => {
  it('reads a grant from enums only, and a missing last use as "no use recorded"', () => {
    const api = grant(1, { resource: 'api', tiers: ['nonprod'] }) as unknown as Grant
    expect(grantSummary(api)).toBe('REST API: targets.read; nonprod')
    const both = grant(2, {
      resource: 'mcp',
      scopes: ['targets.read', 'schema.read'],
      tiers: ['nonprod', 'prod'],
    }) as unknown as Grant
    expect(grantSummary(both)).toBe('MCP: targets.read schema.read; nonprod and prod')
    expect(lastUseOf(api)).toBeUndefined()
    expect(
      lastUseOf(grant(3, { lastUsedAt: NOW, lastUseClass: 'apply' }) as unknown as Grant),
    ).toEqual({ at: NOW, use: 'Apply' })
  })

  it('builds the passkey removal path only from an id of the contract shape', () => {
    expect(removePasskeyPath(ids.factor(1))).toBe(`/auth/passkeys/${ids.factor(1)}/remove`)
    for (const hostile of ['fac_../../logout', 'fac_x', `${ids.factor(1)}/x`, '', 'ses_1']) {
      expect(removePasskeyPath(hostile), hostile).toBeUndefined()
    }
  })
})

describe('the account area', () => {
  it('shows who the person is, their factors, sessions and connected applications', async () => {
    const fake = server(world())
    mountApp('/account/security', fake)
    await accountReady()
    expect(screen.getByRole('heading', { level: 1, name: en['account.title'] })).toBeVisible()
    expect(document.querySelectorAll('#passkey-list li')).toHaveLength(1)
    expect(document.querySelector('#passkey-list')?.textContent).toContain('Laptop')
    expect(screen.getByText('Recovery codes left: 7')).toBeVisible()
    expect(document.querySelector('#replace-totp')?.textContent).toBe(en['account.totp.replace'])
    const sessions = document.querySelectorAll('#session-list li')
    expect(sessions).toHaveLength(3)
    // This browser has no "Sign out" of its own (the account menu signs out).
    expect(within(sessions[0] as HTMLElement).queryByRole('button')).toBeNull()
    expect(document.querySelector('#revoke-others')).not.toBeNull()
    expect(document.querySelector('#recovery-banner')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('shows who the person is on the profile tab and the grants on the applications tab', async () => {
    mountApp('/account', server(world()))
    await waitFor(() => expect(document.querySelector('#me-email')).not.toBeNull())
    expect(document.querySelector('#me-email')?.textContent).toBe('owner@example.test')
    expect(document.querySelector('#me-roles')?.textContent).toContain('owner (global)')
    expect(document.querySelector('#passkey-list')).toBeNull()
    cleanup()
    vi.restoreAllMocks()

    mountApp('/account/applications', server(world()))
    await waitFor(() => expect(document.querySelectorAll('#grant-list li')).toHaveLength(2))
    const list = document.querySelector('#grant-list')?.textContent ?? ''
    expect(list).toContain('REST API: targets.read; nonprod')
    expect(await axeViolations()).toEqual([])
  })

  it('marks third-party client names as not verified and never as markup', async () => {
    const hostile = 'ExponetDB CLI‮​ <img src=x onerror="document.title=1">'
    const fake = server(world({ grants: [grant(1, { name: hostile })] }))
    mountApp('/account/applications', fake)
    const row = await waitFor(() => {
      const found = document.querySelector('#grant-list li')
      if (found === null) throw new Error('no grant yet')
      return found as HTMLElement
    })
    expect(row.textContent).toContain('name not verified')
    expect(row.textContent).toContain('⟨U+202E⟩')
    expect(row.textContent).toContain('⟨U+200B⟩')
    expect(row.textContent).toContain('<img src=x onerror="document.title=1">')
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('‮')
  })

  it('shows the recorded last use with its kind, and "no use recorded" without one', async () => {
    const fake = server(world())
    mountApp('/account/applications', fake)
    await waitFor(() => expect(document.querySelectorAll('#grant-list li')).toHaveLength(2))
    const [cli, agent] = [...document.querySelectorAll<HTMLElement>('#grant-list li')]
    expect(cli?.textContent).toContain(en['account.grant.noUse'])
    expect(cli?.textContent).not.toMatch(/never/i)
    expect(cli?.textContent).not.toContain('name not verified')
    expect(agent?.textContent).toContain(`${en['account.grant.lastUsed']} 2026-10-13 11:58 UTC`)
    expect(agent?.textContent).toContain('Kind of use: Read')
    expect(agent?.textContent).toContain('name not verified')
  })

  it('says when no application is connected, and a failed read never says so', async () => {
    mountApp('/account/applications', server(world({ grants: [grant(1, { state: 'revoked' })] })))
    expect(await screen.findByText(en['account.grants.none'])).toHaveAttribute('id', 'no-grants')
    cleanup()
    vi.restoreAllMocks()

    const failing = server(world()).on('GET', '/api/v1/me/grants', () =>
      problem(500, 'INTERNAL', 'The request failed on the server.'),
    )
    mountApp('/account/applications', failing)
    await waitFor(() =>
      expect(document.body.textContent).toContain(`Could not read ${en['account.grants.what']}`),
    )
    expect(document.querySelector('#no-grants')).toBeNull()
    expect(document.querySelector('#grant-list')).toBeNull()
  })

  it('revokes a connected application and shows the list again', async () => {
    const state = world()
    const fake = server(state).on('POST', `/api/v1/me/grants/${ids.grant(1)}/revoke`, () => {
      state.grants = state.grants.slice(1)
      return json(200, { revoked: true })
    })
    mountApp('/account/applications', fake)
    await waitFor(() => expect(document.querySelectorAll('#grant-list li')).toHaveLength(2))
    const cli = [...document.querySelectorAll<HTMLElement>('#grant-list li')].find(
      (li) => !li.textContent?.includes('name not verified'),
    )
    if (cli === undefined) throw new Error('no first-party grant')
    const user = userEvent.setup()
    await user.click(within(cli).getByRole('button', { name: en['account.grant.revoke'] }))
    await waitFor(() => expect(document.querySelectorAll('#grant-list li')).toHaveLength(1))
    expect(fake.to('POST', `/api/v1/me/grants/${ids.grant(1)}/revoke`)[0]?.body).toEqual({})
    expect(document.querySelector('.status')?.textContent).toBe(en['account.grant.revoked'])
  })

  it('creates new recovery codes after a passkey proof and shows them once', async () => {
    let asked = 0
    const fake = server(world())
      .on('POST', '/auth/recovery-codes', () => {
        asked += 1
        return asked === 1
          ? problem(403, 'REAUTH_REQUIRED', 'Confirm it is you.')
          : json(200, { recoveryCodes: CODES })
      })
      .answer('POST', '/auth/reauth/passkey/options', 200, { challenge: 'r' })
      .answer('POST', '/auth/reauth/passkey', 200, { reauthAt: NOW, method: 'passkey' })
    const { queryClient } = mountApp('/account/security', fake)
    await accountReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['account.codes.regenerate'] }))
    await user.click(await screen.findByRole('button', { name: en['reauth.passkey'] }))
    await waitFor(() => expect(document.querySelectorAll('#recovery-codes li')).toHaveLength(10))
    // Asked twice: refused for the missing proof, then once more after the proof.
    expect(fake.to('POST', '/auth/recovery-codes')).toHaveLength(2)
    expect(fake.to('POST', '/auth/reauth/passkey')[0]?.body).toEqual({
      credential: { id: 'proof' },
    })
    expect(storageText()).not.toContain(CODES[0])
    expect(cacheText(queryClient)).not.toContain(CODES[0])
    const go = screen.getByRole('button', { name: en['enrollment.codes.continue'] })
    expect(go).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: en['enrollment.codes.stored'] }))
    await user.click(go)
    // Gone for good: nothing shows them again.
    expect(document.querySelector('#recovery-codes')).toBeNull()
    expect(document.body.textContent).not.toContain(CODES[0])
    expect(document.querySelector('.status')?.textContent).toBe(en['account.codes.closed'])
    await accountReady()
  })

  it('a canceled confirmation changes nothing and says so', async () => {
    const fake = server(world()).on('POST', '/api/v1/me/sessions/revoke-others', () =>
      problem(403, 'REAUTH_REQUIRED', 'Confirm it is you.'),
    )
    mountApp('/account/security', fake)
    await accountReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['account.sessions.revokeOthers'] }))
    await user.click(await screen.findByRole('button', { name: en['reauth.cancel'] }))
    await waitFor(() =>
      expect(document.querySelector('.alert')?.textContent).toBe(en['reauth.canceled']),
    )
    expect(fake.to('POST', '/api/v1/me/sessions/revoke-others')).toHaveLength(1)
  })

  it('signs out other sessions and says how many', async () => {
    const state = world()
    const fake = server(state).on('POST', '/api/v1/me/sessions/revoke-others', () => {
      state.sessions = state.sessions.slice(0, 1)
      return json(200, { revoked: 2 })
    })
    mountApp('/account/security', fake)
    await accountReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['account.sessions.revokeOthers'] }))
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe('Other sessions signed out: 2.'),
    )
    await waitFor(() => expect(document.querySelectorAll('#session-list li')).toHaveLength(1))
  })

  it('changes the password with both fields cleared before it is sent', async () => {
    let fieldsAtSend: string[] = []
    const fake = server(world()).on('POST', '/auth/password', () => {
      fieldsAtSend = [...document.querySelectorAll<HTMLInputElement>('#change-password input')].map(
        (input) => input.value,
      )
      return json(200, { id: ids.factor(90), kind: 'password', createdAt: NOW })
    })
    mountApp('/account/security', fake)
    await accountReady()
    const form = document.querySelector('#change-password')
    if (!(form instanceof HTMLFormElement)) throw new Error('no password form')
    const user = userEvent.setup()
    const first = within(form).getByLabelText(en['enrollment.password.new'])
    const second = within(form).getByLabelText(en['enrollment.password.repeat'])
    await user.type(first, 'a much longer passphrase')
    await user.type(second, 'a different passphrase!')
    await user.click(within(form).getByRole('button', { name: en['account.password.change'] }))
    expect(document.querySelector('.alert')?.textContent).toBe(en['enrollment.password.differ'])
    expect(fake.to('POST', '/auth/password')).toHaveLength(0)
    await user.type(first, 'a much longer passphrase')
    await user.type(second, 'a much longer passphrase')
    await user.click(within(form).getByRole('button', { name: en['account.password.change'] }))
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe(en['account.password.changed']),
    )
    expect(fake.to('POST', '/auth/password')[0]?.body).toEqual({
      password: 'a much longer passphrase',
    })
    expect(fieldsAtSend).toEqual(['', ''])
  })

  it('removes a passkey through the ceremony path of its id', async () => {
    const state = world({ passkeys: [passkey(1, 'Laptop'), passkey(2, 'Phone')] })
    const fake = server(state).on('POST', `/auth/passkeys/${ids.factor(2)}/remove`, () => {
      state.passkeys = state.passkeys.slice(0, 1)
      return json(200, { removed: true })
    })
    mountApp('/account/security', fake)
    await waitFor(() => expect(document.querySelectorAll('#passkey-list li')).toHaveLength(2))
    const phone = [...document.querySelectorAll<HTMLElement>('#passkey-list li')][1]
    if (phone === undefined) throw new Error('no second passkey')
    const user = userEvent.setup()
    await user.click(within(phone).getByRole('button', { name: en['account.passkey.remove'] }))
    await waitFor(() => expect(document.querySelectorAll('#passkey-list li')).toHaveLength(1))
    expect(document.querySelector('.status')?.textContent).toBe(en['account.passkey.removed'])
  })

  it('a recovery session only replaces factors, and the banner goes when it ends', async () => {
    const state = world({ me: meOf({ recovery: true }) })
    const fake = server(state)
      .answer('POST', '/auth/passkeys/options', 200, { challenge: 'p' })
      .on('POST', '/auth/passkeys', () => {
        state.passkeys = [...state.passkeys, passkey(2, 'New phone')]
        return json(200, passkey(2, 'New phone'))
      })
      .answer('POST', '/auth/totp/options', 200, {
        otpauthUri: `otpauth://totp/ExponetDB?secret=${TOTP_KEY}`,
        secret: TOTP_KEY,
        qr: { size: 21, rows: Array.from({ length: 21 }, () => '1'.repeat(21)) },
      })
      .on('POST', '/auth/totp', () => {
        // A new passkey and a new authenticator app end the recovery.
        state.me = meOf()
        return json(200, { id: ids.factor(93), kind: 'totp', createdAt: NOW, lastUsedAt: null })
      })
    mountApp('/account', fake)
    const banner = await waitFor(() => {
      const found = document.querySelector('#recovery-banner')
      if (found === null) throw new Error('no banner yet')
      return found
    })
    expect(banner.textContent).toContain(en['account.recovery.body'])
    expect(screen.queryByRole('navigation', { name: en['accountArea.nav'] })).toBeNull()
    // Connected applications are not read, and nothing but factors can be changed.
    expect(fake.to('GET', '/api/v1/me/grants')).toHaveLength(0)
    expect(document.querySelector('#grant-list')).toBeNull()
    expect(document.querySelector('#no-grants')).toBeNull()
    expect(document.querySelector('#revoke-others')).toBeNull()
    expect(
      within(document.querySelector('#session-list') as HTMLElement).queryAllByRole('button'),
    ).toHaveLength(0)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['account.passkey.add'] }))
    await waitFor(() => expect(document.querySelectorAll('#passkey-list li')).toHaveLength(2))
    expect(fake.to('POST', '/auth/passkeys')[0]?.body).toEqual({
      credential: { id: 'new-credential' },
      label: en['account.passkey.newDefault'],
    })
    await user.click(screen.getByRole('button', { name: en['account.totp.replace'] }))
    await waitFor(() => expect(document.querySelector('svg.qr')).not.toBeNull())
    const confirm = document.querySelector('#confirm-totp') as HTMLFormElement
    await user.type(within(confirm).getByLabelText(en['enrollment.totp.code.label']), '654321')
    await user.click(
      within(confirm).getByRole('button', { name: en['enrollment.totp.code.submit'] }),
    )
    await waitFor(() => expect(document.querySelector('#recovery-banner')).toBeNull())
    expect(document.querySelector('#totp-secret')).toBeNull()
    // The account area's navigation comes back with the end of the recovery.
    expect(
      await screen.findByRole('navigation', { name: en['accountArea.nav'] }),
    ).toBeInTheDocument()
  })

  it('shows the server catalog text with its code when a change fails', async () => {
    const fake = server(world()).on('POST', '/auth/passkeys/options', () =>
      problem(429, 'RATE_LIMITED', 'Too many changes.', { 'retry-after': '12' }),
    )
    mountApp('/account/security', fake)
    await accountReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['account.passkey.add'] }))
    await waitFor(() =>
      expect(document.querySelector('.alert')?.textContent).toBe(
        'Too many attempts. Try again in 12 seconds.',
      ),
    )
  })
})
