import type { RequestOptions, SecondFactorStep, SignedIn } from '@exponetdb/contracts'
import { call } from '../api.ts'
import { field, h, replace } from '../dom.ts'
import { safeReturnTo } from '../safe.ts'
import { action, form, labeled, type Shell } from '../shell.ts'
import { passkeysSupported, usePasskey } from '../webauthn.ts'

/**
 * Sign-in: a passkey first (discoverable, nothing to type, nothing to
 * enumerate), the password with a second factor as fallback. Every failure
 * of the fallback reads the same, whatever was wrong.
 */
export function loginPage(ui: Shell): void {
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'))
  const enter = (signedIn: SignedIn) => {
    location.assign(signedIn.recoveryRequired ? '/account' : returnTo)
  }

  const passkey = action(
    'Sign in with a passkey',
    ui,
    async () => {
      const options = await call<RequestOptions>('POST', '/auth/login/passkey/options')
      const credential = await usePasskey(options)
      enter(await call<SignedIn>('POST', '/auth/login/passkey', { credential }))
    },
    { id: 'passkey-sign-in', class: 'primary' },
  )

  const second = h('div', { id: 'second-factor' })
  const password = form(
    ui,
    { id: 'password-sign-in' },
    async (f) => {
      const step = await call<SecondFactorStep>('POST', '/auth/login/password', {
        email: field(f, 'email'),
        password: field(f, 'password'),
      })
      f.hidden = true
      showSecondFactor(ui, second, step, enter)
    },
    labeled(
      'E-mail address',
      h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
    ),
    labeled(
      'Password',
      h('input', {
        name: 'password',
        type: 'password',
        autocomplete: 'current-password',
        required: true,
      }),
    ),
    h('button', { type: 'submit' }, 'Continue'),
  )

  replace(
    ui.content,
    passkeysSupported()
      ? passkey
      : h(
          'p',
          {},
          'This browser does not support passkeys. Use your password and authenticator app.',
        ),
    h('h2', {}, 'Or use your password'),
    password,
    second,
  )
}

function showSecondFactor(
  ui: Shell,
  container: HTMLElement,
  step: SecondFactorStep,
  enter: (signedIn: SignedIn) => void,
): void {
  const totp = form(
    ui,
    { id: 'totp-sign-in' },
    async (f) =>
      enter(await call<SignedIn>('POST', '/auth/login/totp', { code: field(f, 'code') })),
    labeled(
      'Code from your authenticator app',
      h('input', {
        name: 'code',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        pattern: '[0-9]{6}',
        maxlength: 6,
        required: true,
      }),
    ),
    h('button', { type: 'submit' }, 'Sign in'),
  )
  const recovery = form(
    ui,
    { id: 'recovery-sign-in', hidden: 'hidden' },
    async (f) =>
      enter(await call<SignedIn>('POST', '/auth/login/recovery-code', { code: field(f, 'code') })),
    labeled(
      'Recovery code',
      h('input', { name: 'code', autocomplete: 'off', spellcheck: 'false', required: true }),
    ),
    h(
      'p',
      { class: 'hint' },
      'A recovery code signs you in to replace your passkey and authenticator app; nothing else is possible until you have.',
    ),
    h('button', { type: 'submit' }, 'Sign in with recovery code'),
  )
  const toggle = h(
    'button',
    { type: 'button', class: 'link', id: 'use-recovery-code' },
    'Use a recovery code instead',
  )
  toggle.addEventListener('click', () => {
    totp.hidden = true
    toggle.hidden = true
    recovery.hidden = false
  })
  replace(
    container,
    step.methods.includes('totp') ? totp : null,
    step.methods.includes('recovery_code') ? toggle : null,
    recovery,
  )
  ui.status('Enter the code from your authenticator app.')
}
