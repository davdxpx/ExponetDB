import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { ENROLLMENT_KEY } from '../../src/features/enrollment/enrollment-storage.ts'
import { forgetHeldLink, holdOneTimeLink, linkPageOf } from '../../src/features/enrollment/link.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { qrPath } from '../../src/lib/navigation/links.ts'
import {
  cacheText,
  FakeServer,
  LATER,
  mountApp,
  problem,
  storageText,
  TOKEN_TAIL,
} from '../account/support.tsx'

const webauthn = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'new-credential' })),
}))

vi.mock('../../src/lib/auth/webauthn.ts', () => ({
  PasskeyCanceled: class PasskeyCanceled extends Error {
    override readonly name = 'PasskeyCanceled'
  },
  passkeysSupported: () => true,
  assertWithPasskey: vi.fn(),
  createPasskey: webauthn.create,
}))

const SETUP = `exsu_${TOKEN_TAIL}`
const INVITE = `exiv_${TOKEN_TAIL}`
const TOTP_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ROWS = ['1010101', '0101010', '1110001', '0000000', '1111111', '1000001', '1010101']
const CODES = Array.from(
  { length: 10 },
  (_, n) => `AAAA-BBBB-CCCC-${String(n).padStart(4, '0').replaceAll('0', 'D')}`,
)

type Steps = { passkey: boolean; password: boolean; totp: boolean }

/** The values of the password fields when the password request was sent. */
let passwordFieldsAtSend: string[] = []

function stateOf(kind: string, steps: Partial<Steps> = {}, email = 'owner@example.test') {
  return {
    kind,
    email,
    expiresAt: LATER,
    steps: { passkey: false, password: false, totp: false, ...steps },
    complete: false,
  }
}

function server(kind = 'setup', email = 'owner@example.test'): FakeServer {
  const steps: Steps = { passkey: false, password: false, totp: false }
  return new FakeServer()
    .signedOut()
    .on('POST', '/auth/enrollment/redeem', () =>
      Response.json(stateOf(kind, steps, email), { status: 200 }),
    )
    .answer('POST', '/auth/enrollment/passkey/options', 200, { challenge: 'c' })
    .on('POST', '/auth/enrollment/passkey', () => {
      steps.passkey = true
      return Response.json(stateOf(kind, steps, email))
    })
    .on('POST', '/auth/enrollment/password', () => {
      passwordFieldsAtSend = [
        ...document.querySelectorAll<HTMLInputElement>('#set-password input'),
      ].map((input) => input.value)
      steps.password = true
      return Response.json(stateOf(kind, steps, email))
    })
    .answer('POST', '/auth/enrollment/totp/options', 200, {
      otpauthUri: `otpauth://totp/ExponetDB?secret=${TOTP_KEY}`,
      secret: TOTP_KEY,
      qr: { size: ROWS.length, rows: ROWS },
    })
    .on('POST', '/auth/enrollment/totp', () => {
      steps.totp = true
      return Response.json(stateOf(kind, steps, email))
    })
    .answer('POST', '/auth/enrollment/complete', 200, {
      signedIn: {
        identityId: 'idn_01JZ0000000000000000000001',
        label: 'owner',
        sessionId: 'ses_01JZ0000000000000000000001',
        assurance: 'full',
        recoveryRequired: false,
      },
      recoveryCodes: CODES,
    })
}

/** Opens a link in this tab the way the browser does, then runs the start-up step of `main.tsx`. */
function openLink(url: string): boolean {
  window.history.replaceState(null, '', url)
  return holdOneTimeLink(window.location, window.history)
}

function doneStep(title: string): HTMLElement | undefined {
  const steps = [...document.querySelectorAll<HTMLElement>('li.step.done')]
  return steps.find((li) => li.querySelector('h2')?.textContent?.includes(title) === true)
}

beforeEach(() => {
  forgetHeldLink()
  window.history.replaceState(null, '', '/')
  webauthn.create.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
  forgetHeldLink()
  window.history.replaceState(null, '', '/')
})

describe('taking the one-time token', () => {
  it('happens in main.tsx before the router, the API client or anything else runs', () => {
    // The test runs from apps/web (the vitest root).
    const main = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8')
    const body = main.slice(main.lastIndexOf('\nimport '))
    const take = body.indexOf('holdOneTimeLink(window.location, window.history)')
    expect(take).toBeGreaterThan(0)
    for (const later of [
      'initTheme(',
      'createQueryClient(',
      'new ApiClient(',
      'createRouter(',
      'createRoot(',
    ]) {
      const at = body.indexOf(later)
      expect(at, later).toBeGreaterThan(take)
    }
  })

  it('knows the three link pages as the router matches them, and nothing else', () => {
    expect(linkPageOf('/setup')).toBe('/setup')
    expect(linkPageOf('/Invite/')).toBe('/invite')
    expect(linkPageOf('/recover')).toBe('/recover')
    for (const other of ['/', '/login', '/account', '/setup/x', '/setupx', '/oauth/consent']) {
      expect(linkPageOf(other), other).toBeUndefined()
    }
  })

  it('removes the fragment from the address bar and the history entry, whatever it holds', () => {
    const before = window.history.length
    expect(openLink(`/setup#token=${SETUP}`)).toBe(true)
    expect(window.location.hash).toBe('')
    expect(window.location.href).toBe(`${window.location.origin}/setup`)
    expect(window.history.length).toBe(before)
    for (const hostile of [
      `/invite#token=${SETUP}`,
      `/setup#token=${SETUP}x`,
      `/setup#token=${SETUP}&next=https://evil.example`,
      `/setup#token=EXSU_${TOKEN_TAIL}`,
      `/setup#access_token=${SETUP}`,
      `/recover#token=exrc_${'<'.repeat(43)}`,
    ]) {
      forgetHeldLink()
      expect(openLink(hostile), hostile).toBe(false)
      expect(window.location.hash, hostile).toBe('')
    }
    // Another page keeps its fragment (it is not a one-time link).
    window.history.replaceState(null, '', `/approvals#operation=op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z`)
    expect(holdOneTimeLink(window.location, window.history)).toBe(false)
    expect(window.location.hash).toBe('#operation=op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
  })
})

describe('the setup page', () => {
  it('redeems the token once, from memory, after it left the address bar', async () => {
    const fake = server()
    openLink(`/setup#token=${SETUP}`)
    const { queryClient } = mountApp('/setup', fake, { strict: true })
    await waitFor(() => expect(document.querySelector('#create-passkey')).not.toBeNull())
    const redeemed = fake.to('POST', '/auth/enrollment/redeem')
    expect(redeemed).toHaveLength(1)
    expect(redeemed[0]?.body).toEqual({ token: SETUP })
    expect(redeemed[0]?.hash).toBe('')
    expect(window.location.hash).toBe('')
    // Never shown, stored or cached; the tab keeps only the progress.
    expect(document.body.innerHTML).not.toContain(SETUP)
    expect(cacheText(queryClient)).not.toContain(SETUP)
    expect(storageText()).not.toContain(SETUP)
    expect(JSON.parse(window.sessionStorage.getItem(ENROLLMENT_KEY) ?? '{}')).toMatchObject({
      kind: 'setup',
      email: 'owner@example.test',
    })
    expect(
      screen.getByRole('heading', { level: 1, name: en['enrollment.title.setup'] }),
    ).toBeVisible()
    expect(screen.getByText(en['enrollment.intro.setup'])).toBeVisible()
  })

  it('a token of another kind never leaves the browser', async () => {
    const fake = server('invitation')
    openLink(`/invite#token=${SETUP}`)
    mountApp('/invite', fake)
    expect(await screen.findByText(en['enrollment.invalid'])).toBeVisible()
    expect(fake.to('POST', '/auth/enrollment/redeem')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain(SETUP)
  })

  it('walks through passkey, password, authenticator app and the recovery codes', async () => {
    const fake = server()
    openLink(`/setup#token=${SETUP}`)
    const { assign, queryClient } = mountApp('/setup', fake)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: en['enrollment.passkey.create'] }))
    await waitFor(() => expect(doneStep(en['enrollment.passkey.title'])).toBeDefined())
    expect(webauthn.create).toHaveBeenCalledWith({ challenge: 'c' })
    expect(fake.to('POST', '/auth/enrollment/passkey')[0]?.body).toEqual({
      credential: { id: 'new-credential' },
      label: en['enrollment.passkey.default'],
    })

    // Two different passwords: nothing is sent, and both fields are empty again.
    const form = document.querySelector('#set-password')
    if (!(form instanceof HTMLFormElement)) throw new Error('no password form')
    const first = within(form).getByLabelText(en['enrollment.password.new'])
    const second = within(form).getByLabelText(en['enrollment.password.repeat'])
    expect(first).toHaveAttribute('autocomplete', 'new-password')
    expect(first).toHaveAttribute('minlength', '14')
    await user.type(first, 'tangerine fjord radiator 42')
    await user.type(second, 'tangerine fjord radiator 43')
    await user.click(within(form).getByRole('button', { name: en['enrollment.password.set'] }))
    expect(document.querySelector('.alert')?.textContent).toBe(en['enrollment.password.differ'])
    expect(fake.to('POST', '/auth/enrollment/password')).toHaveLength(0)
    expect(first).toHaveValue('')
    expect(second).toHaveValue('')

    await user.type(first, 'tangerine fjord radiator 42')
    await user.type(second, 'tangerine fjord radiator 42')
    await user.click(within(form).getByRole('button', { name: en['enrollment.password.set'] }))
    await waitFor(() => expect(doneStep(en['enrollment.password.title'])).toBeDefined())
    expect(fake.to('POST', '/auth/enrollment/password')[0]?.body).toEqual({
      password: 'tangerine fjord radiator 42',
    })
    expect(passwordFieldsAtSend).toEqual(['', ''])

    // The QR code is drawn here from the server's matrix: an inline SVG path, no image.
    await user.click(screen.getByRole('button', { name: en['enrollment.totp.setup'] }))
    const qr = await waitFor(() => {
      const found = document.querySelector('svg.qr')
      if (found === null) throw new Error('no QR code yet')
      return found
    })
    expect(qr).toHaveAttribute('role', 'img')
    expect(qr).toHaveAttribute('aria-label', en['enrollment.totp.qr'])
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(ROWS))
    expect(document.querySelectorAll('img, image, object, iframe')).toHaveLength(0)
    expect(document.querySelector('#totp-secret')?.textContent).toBe(
      'ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567',
    )
    expect(document.body.textContent).not.toContain('otpauth://')
    const confirm = document.querySelector('#confirm-totp')
    if (!(confirm instanceof HTMLFormElement)) throw new Error('no confirm form')
    const code = within(confirm).getByLabelText(en['enrollment.totp.code.label'])
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    await user.type(code, '123456')
    await user.click(
      within(confirm).getByRole('button', { name: en['enrollment.totp.code.submit'] }),
    )
    await waitFor(() => expect(doneStep(en['enrollment.totp.title'])).toBeDefined())
    expect(fake.to('POST', '/auth/enrollment/totp')[0]?.body).toEqual({ code: '123456' })
    // The secret leaves the page once the app is confirmed.
    expect(document.querySelector('#totp-secret')).toBeNull()
    expect(document.body.textContent).not.toContain('ABCD EFGH')

    await user.click(screen.getByRole('button', { name: en['enrollment.finish'] }))
    await waitFor(() => expect(document.querySelectorAll('#recovery-codes li')).toHaveLength(10))
    expect(
      [...document.querySelectorAll('#recovery-codes code')].map((node) => node.textContent),
    ).toEqual(CODES)
    expect(window.sessionStorage.getItem(ENROLLMENT_KEY)).toBeNull()
    expect(storageText()).not.toContain(CODES[0])
    expect(cacheText(queryClient)).not.toContain(CODES[0])
    expect(await axeViolations()).toEqual([])

    const go = screen.getByRole('button', { name: en['enrollment.codes.continue'] })
    expect(go).toHaveAttribute('id', 'continue')
    expect(go).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: en['enrollment.codes.stored'] }))
    expect(document.querySelector('#codes-stored')).toHaveAttribute('aria-checked', 'true')
    expect(go).toBeEnabled()
    await user.click(go)
    expect(assign).toHaveBeenCalledWith('/account')
  })

  it('keeps the progress of this tab for a reload, for the same kind of link only', async () => {
    const fake = server()
    openLink(`/setup#token=${SETUP}`)
    mountApp('/setup', fake)
    await waitFor(() => expect(document.querySelector('#create-passkey')).not.toBeNull())
    cleanup()

    const reload = server()
    mountApp('/setup', reload)
    expect(
      await screen.findByRole('button', { name: en['enrollment.passkey.create'] }),
    ).toBeVisible()
    expect(reload.to('POST', '/auth/enrollment/redeem')).toHaveLength(0)
    cleanup()

    // Setup progress means nothing on the recovery page.
    mountApp('/recover', server('recovery'))
    expect(await screen.findByText(en['enrollment.invalid'])).toBeVisible()

    cleanup()
    window.sessionStorage.setItem(ENROLLMENT_KEY, '{"kind":"setup","email":{},"steps":null}')
    mountApp('/setup', server())
    expect(await screen.findByText(en['enrollment.invalid'])).toBeVisible()
  })

  it('an expired or used link reads as such, with the catalog code', async () => {
    const fake = server().on('POST', '/auth/enrollment/redeem', () =>
      problem(400, 'LINK_INVALID', 'The link is not valid.'),
    )
    window.sessionStorage.setItem(ENROLLMENT_KEY, JSON.stringify(stateOf('setup')))
    openLink(`/setup#token=${SETUP}`)
    mountApp('/setup', fake)
    expect(await screen.findByText(en['enrollment.invalid'])).toBeVisible()
    await waitFor(() =>
      expect(document.querySelector('.alert')?.textContent).toBe(
        'The link is not valid. (LINK_INVALID)',
      ),
    )
    // The failed link shows nothing of an earlier link's progress, and never its own token.
    expect(document.querySelector('#create-passkey')).toBeNull()
    expect(storageText()).not.toContain(SETUP)
  })

  it('a second link opened in the tab leaves the address bar at once and is redeemed', async () => {
    const fake = server('invitation')
    window.history.replaceState(null, '', '/invite')
    mountApp('/invite', fake)
    expect(await screen.findByText(en['enrollment.invalid'])).toBeVisible()
    window.history.replaceState(null, '', `/invite#token=${INVITE}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(window.location.hash).toBe('')
    await waitFor(() => expect(fake.to('POST', '/auth/enrollment/redeem')).toHaveLength(1))
    expect(fake.to('POST', '/auth/enrollment/redeem')[0]).toMatchObject({
      body: { token: INVITE },
      hash: '',
    })
    expect(await screen.findByText(en['enrollment.intro.invitation'])).toBeVisible()
  })

  it('shows the address of the link as text, with hidden characters by code point', async () => {
    const hostile = 'owner‮@example.test<img src=x onerror=alert(1)>'
    const fake = server('setup', hostile)
    openLink(`/setup#token=${SETUP}`)
    mountApp('/setup', fake)
    await waitFor(() => expect(document.querySelector('#enrollment-email')).not.toBeNull())
    const shown = document.querySelector('#enrollment-email')?.textContent ?? ''
    expect(shown).toContain('⟨U+202E⟩')
    expect(shown).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('‮')
    expect(await axeViolations()).toEqual([])
  })
})
