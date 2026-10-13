import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  afterSignIn,
  returnToOf,
  secondFactorForms,
} from '../../src/features/sign-in/sign-in-model.ts'
import { en } from '../../src/lib/i18n/en.ts'
import {
  cacheText,
  FakeServer,
  json,
  meOf,
  mountApp,
  problem,
  storageText,
} from '../account/support.tsx'

const webauthn = vi.hoisted(() => ({
  supported: true,
  assert: vi.fn(async () => ({ id: 'credential' })),
}))

vi.mock('../../src/lib/auth/webauthn.ts', () => ({
  PasskeyCanceled: class PasskeyCanceled extends Error {
    override readonly name = 'PasskeyCanceled'
  },
  passkeysSupported: () => webauthn.supported,
  assertWithPasskey: webauthn.assert,
  createPasskey: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

beforeEach(() => {
  webauthn.supported = true
  webauthn.assert.mockReset()
  webauthn.assert.mockResolvedValue({ id: 'credential' })
})

const OP = 'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const SIGNED_IN = {
  identityId: 'idn_01JZ0000000000000000000001',
  label: 'owner',
  sessionId: 'ses_01JZ0000000000000000000002',
  assurance: 'full',
  recoveryRequired: false,
}
const RECOVERY = { ...SIGNED_IN, assurance: 'recovery', recoveryRequired: true }
const STEP = { next: 'second_factor', methods: ['totp', 'recovery_code'] }

function server(): FakeServer {
  return new FakeServer()
    .signedOut()
    .answer('POST', '/auth/login/passkey/options', 200, { challenge: 'abc' })
    .answer('POST', '/auth/login/passkey', 200, SIGNED_IN)
    .answer('POST', '/auth/login/password', 200, STEP)
    .answer('POST', '/auth/login/totp', 200, SIGNED_IN)
    .answer('POST', '/auth/login/recovery-code', 200, RECOVERY)
}

function signInPath(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`
}

async function passwordStep(email = 'owner@example.test', password = 'tangerine fjord 42') {
  const user = userEvent.setup()
  const form = await waitFor(() => {
    const found = document.querySelector('#password-sign-in')
    if (!(found instanceof HTMLFormElement)) throw new Error('no password form yet')
    return found
  })
  await user.type(within(form).getByLabelText(en['signIn.email']), email)
  await user.type(within(form).getByLabelText(en['signIn.password']), password)
  await user.click(within(form).getByRole('button', { name: en['signIn.password.submit'] }))
  return user
}

function alertText(): string {
  return document.querySelector('.alert')?.textContent ?? ''
}

describe('the sign-in decisions', () => {
  it('returns to an allowlisted page only, and a recovery session always to the account', () => {
    const full = { assurance: 'full', recoveryRequired: false } as const
    expect(afterSignIn(full, `/approvals#operation=${OP}`)).toBe(`/approvals#operation=${OP}`)
    expect(afterSignIn(full, null)).toBe('/account')
    expect(afterSignIn(full, 'https://evil.example/account')).toBe('/account')
    expect(afterSignIn({ assurance: 'recovery', recoveryRequired: true }, '/approvals')).toBe(
      '/account',
    )
    expect(afterSignIn({ assurance: 'full', recoveryRequired: true }, '/approvals')).toBe(
      '/account',
    )
  })

  it('reads returnTo from the query string as URLSearchParams decodes it', () => {
    expect(returnToOf('?returnTo=%2Faccount')).toBe('/account')
    expect(returnToOf('?returnTo=%22%2Fapprovals%22')).toBe('"/approvals"')
    expect(returnToOf('?x=1')).toBeNull()
    expect(secondFactorForms({ next: 'second_factor', methods: ['totp'] })).toEqual({
      totp: true,
      recoveryCode: false,
    })
  })
})

describe('the sign-in page', () => {
  it('offers the passkey first and the password as the fallback, accessibly', async () => {
    mountApp('/login', server())
    const passkey = await screen.findByRole('button', { name: en['signIn.passkey'] })
    expect(passkey).toHaveAttribute('id', 'passkey-sign-in')
    expect(screen.getByRole('heading', { level: 1, name: en['signIn.title'] })).toBeVisible()
    const form = document.querySelector('#password-sign-in')
    expect(form).not.toBeNull()
    const email = screen.getByLabelText(en['signIn.email'])
    expect(email).toHaveAttribute('name', 'email')
    expect(email).toHaveAttribute('autocomplete', 'username')
    expect(email).toHaveAttribute('type', 'email')
    const password = screen.getByLabelText(en['signIn.password'])
    expect(password).toHaveAttribute('name', 'password')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
    expect(password).toHaveAttribute('type', 'password')
    // The passkey comes before the password in the reading order.
    expect(passkey.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await axeViolations()).toEqual([])
  })

  it('says so when the browser has no passkeys, and keeps the password', async () => {
    webauthn.supported = false
    mountApp('/login', server())
    expect(await screen.findByText(en['signIn.passkey.unsupported'])).toBeVisible()
    expect(document.querySelector('#passkey-sign-in')).toBeNull()
    expect(document.querySelector('#password-sign-in')).not.toBeNull()
  })

  it('signs in with a passkey and goes to the allowlisted returnTo', async () => {
    const fake = server()
    const { assign } = mountApp(signInPath(`/approvals#operation=${OP}`), fake)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: en['signIn.passkey'] }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/approvals#operation=${OP}`))
    expect(webauthn.assert).toHaveBeenCalledWith({ challenge: 'abc' })
    expect(fake.to('POST', '/auth/login/passkey')[0]?.body).toEqual({
      credential: { id: 'credential' },
    })
    // Ceremonies carry the CSRF token and never an Authorization header.
    const sent = fake.to('POST', '/auth/login/passkey')[0]?.headers ?? {}
    expect(sent['x-csrf-token']).toBe('csrf-token')
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('falls back to the account page for every returnTo that is not on the allowlist', async () => {
    for (const hostile of [
      'https://evil.example/account',
      '//evil.example/account',
      '/\\evil.example',
      'javascript:alert(1)',
      '/account?x=1',
      '/account#x',
      '/%2F%2Fevil.example',
      ' /approvals',
      '/APPROVALS',
      `/approvals#operation=${OP}&x=1`,
      `/oauth/consent#request=exar_${'A'.repeat(43)}x`,
      '/step-up#id=evil',
      '/login',
      '/setup',
      // The router reads JSON in query values; what comes out must still pass the allowlist.
      '"https://evil.example/account"',
      '"//evil.example/account"',
      '["/approvals"]',
      '{"a":"/account"}',
      '123',
      'true',
    ]) {
      const { assign } = mountApp(signInPath(hostile), server())
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: en['signIn.passkey'] }))
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      expect(assign.mock.calls[0]?.[0], hostile).toBe('/account')
      cleanup()
      vi.restoreAllMocks()
    }
  })

  it('password and TOTP: the password leaves the field as it is sent; the code too', async () => {
    let fieldAtSend: string | undefined
    const fake = server().on('POST', '/auth/login/password', () => {
      fieldAtSend = document.querySelector<HTMLInputElement>(
        '#password-sign-in input[name="password"]',
      )?.value
      return json(200, STEP)
    })
    const { assign, queryClient } = mountApp(signInPath('/account'), fake)
    const user = await passwordStep('owner@example.test', 'tangerine fjord 42')
    const totp = await waitFor(() => {
      const found = document.querySelector('#totp-sign-in')
      if (!(found instanceof HTMLFormElement)) throw new Error('no TOTP form yet')
      return found
    })
    expect(fake.to('POST', '/auth/login/password')[0]?.body).toEqual({
      email: 'owner@example.test',
      password: 'tangerine fjord 42',
    })
    expect(fieldAtSend).toBe('')
    expect(document.querySelector('#password-sign-in')).toBeNull()
    expect(document.querySelector('.status')?.textContent).toBe(en['signIn.totp.prompt'])
    const code = within(totp).getByLabelText(en['signIn.totp.label'])
    expect(code).toHaveAttribute('name', 'code')
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    await user.type(code, '123456')
    await user.click(within(totp).getByRole('button', { name: en['signIn.totp.submit'] }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/account'))
    expect(fake.to('POST', '/auth/login/totp')[0]?.body).toEqual({ code: '123456' })
    expect(within(totp).getByLabelText(en['signIn.totp.label'])).toHaveValue('')
    // Nothing secret reached the query cache or browser storage.
    expect(cacheText(queryClient)).not.toContain('tangerine')
    expect(storageText()).toBe('')
    // Starting over shows an empty password field (the old value is gone, not hidden).
    expect(document.body.innerHTML).not.toContain('tangerine')
  })

  it('a wrong password and an unknown address read the same, and so do their failures', async () => {
    const pages: string[] = []
    for (const email of ['owner@example.test', 'nobody@example.test']) {
      const fake = server().on('POST', '/auth/login/totp', () =>
        problem(401, 'AUTHENTICATION_FAILED', 'The sign-in failed.'),
      )
      mountApp('/login', fake)
      const user = await passwordStep(email, 'not the password')
      const totp = await waitFor(() => {
        const found = document.querySelector('#totp-sign-in')
        if (!(found instanceof HTMLFormElement)) throw new Error('no TOTP form yet')
        return found
      })
      const afterStep = document.body.textContent ?? ''
      await user.type(within(totp).getByLabelText(en['signIn.totp.label']), '000000')
      await user.click(within(totp).getByRole('button', { name: en['signIn.totp.submit'] }))
      await waitFor(() => expect(alertText()).toContain('AUTHENTICATION_FAILED'))
      pages.push(`${afterStep}\n${alertText()}`)
      cleanup()
      vi.restoreAllMocks()
    }
    expect(pages[0]).toBe(pages[1])
    expect(pages[0]).toContain('The sign-in failed. (AUTHENTICATION_FAILED)')
  })

  it('shows the retry time of a rate limit and fixed text for network failures', async () => {
    const limited = server().on('POST', '/auth/login/password', () =>
      problem(429, 'RATE_LIMITED', 'Too many sign-in attempts.', { 'retry-after': '7' }),
    )
    mountApp('/login', limited)
    await passwordStep()
    await waitFor(() => expect(alertText()).toBe('Too many attempts. Try again in 7 seconds.'))
    cleanup()
    vi.restoreAllMocks()

    const down = server()
    down.on('POST', '/auth/login/passkey/options', () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.7:443 secret-host')
    })
    mountApp('/login', down)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: en['signIn.passkey'] }))
    await waitFor(() => expect(alertText()).toBe(en['error.network']))
    expect(document.body.textContent).not.toContain('ECONNREFUSED')
  })

  it('shows the catalog message and code of a refused passkey, never exception text', async () => {
    const forged = server().on('POST', '/auth/login/passkey', () =>
      problem(400, 'AUTH_CHALLENGE_INVALID', 'The challenge is not valid.'),
    )
    const { assign } = mountApp('/login', forged)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: en['signIn.passkey'] }))
    await waitFor(() =>
      expect(alertText()).toBe('The challenge is not valid. (AUTH_CHALLENGE_INVALID)'),
    )
    expect(assign).not.toHaveBeenCalled()

    const canceled = new Error('NotAllowedError: timed out at chrome://internal')
    canceled.name = 'PasskeyCanceled'
    webauthn.assert.mockRejectedValueOnce(canceled)
    await user.click(screen.getByRole('button', { name: en['signIn.passkey'] }))
    await waitFor(() => expect(alertText()).toBe(en['passkey.canceled']))
    expect(document.body.textContent).not.toContain('chrome://')
  })

  it('a recovery code signs in to the account page, whatever returnTo says', async () => {
    const fake = server()
    const { assign } = mountApp(signInPath(`/approvals#operation=${OP}`), fake)
    const user = await passwordStep()
    await user.click(await screen.findByRole('button', { name: en['signIn.recovery.toggle'] }))
    expect(document.querySelector('#totp-sign-in')).toBeNull()
    const form = document.querySelector('#recovery-sign-in')
    if (!(form instanceof HTMLFormElement)) throw new Error('no recovery form')
    const input = within(form).getByLabelText(en['signIn.recovery.label'])
    expect(input).toHaveAttribute('name', 'code')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
    await user.type(input, 'ABCD-EFGH-JKMN-PQRS')
    await user.click(within(form).getByRole('button', { name: en['signIn.recovery.submit'] }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/account'))
    expect(fake.to('POST', '/auth/login/recovery-code')[0]?.body).toEqual({
      code: 'ABCD-EFGH-JKMN-PQRS',
    })
    expect(input).toHaveValue('')
  })

  it('can start over from the second step with an empty password field', async () => {
    mountApp('/login', server())
    const user = await passwordStep('owner@example.test', 'tangerine fjord 42')
    await user.click(await screen.findByRole('button', { name: en['signIn.restart'] }))
    expect(screen.getByLabelText(en['signIn.email'])).toHaveValue('owner@example.test')
    expect(screen.getByLabelText(en['signIn.password'])).toHaveValue('')
    expect(await axeViolations()).toEqual([])
  })

  it('a signed-in person goes on at once; a signed-out probe never leaves for sign-in', async () => {
    const signedIn = server().signedIn(meOf())
    const { assign } = mountApp(signInPath('/admin/clients'), signedIn)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/clients'))
    cleanup()
    vi.restoreAllMocks()

    const recovering = server().signedIn(meOf({ recovery: true }))
    const second = mountApp(signInPath('/admin/clients'), recovering)
    await waitFor(() => expect(second.assign).toHaveBeenCalledWith('/account'))
    cleanup()
    vi.restoreAllMocks()

    const signedOut = server()
    const third = mountApp('/login', signedOut)
    await waitFor(() => expect(signedOut.to('GET', '/api/v1/me')).toHaveLength(1))
    await screen.findByRole('button', { name: en['signIn.passkey'] })
    // The app client's "session gone" (which loads the sign-in page) is never reached from here.
    expect(signedOut.sessionGone).not.toHaveBeenCalled()
    expect(third.assign).not.toHaveBeenCalled()
  })

  it('sends one ceremony at a time', async () => {
    let release: (value: Response) => void = () => undefined
    const slow = server().on(
      'POST',
      '/auth/login/password',
      () => new Promise<Response>((resolve) => (release = resolve)),
    )
    mountApp('/login', slow)
    await passwordStep()
    const passkey = screen.getByRole('button', { name: en['signIn.passkey'] })
    expect(passkey).toBeDisabled()
    release(json(200, STEP))
    await waitFor(() => expect(document.querySelector('#totp-sign-in')).not.toBeNull())
    expect(passkey).toBeEnabled()
  })
})
