import type {
  CreationOptions,
  EnrollmentComplete,
  EnrollmentState,
  TotpSetup,
} from '@exponetdb/contracts'
import { call } from '../api.ts'
import { field, formatTime, h, qrImage, replace } from '../dom.ts'
import { groupSecret, type LinkPage, linkToken, qrPath } from '../safe.ts'
import { action, form, labeled, type Shell } from '../shell.ts'
import { createPasskey } from '../webauthn.ts'

/**
 * Setup, invitation and recovery links: the token is read from the
 * fragment, removed from the address bar and history at once, and redeemed;
 * the server keeps the ceremony in a short-lived cookie. A person sets up a
 * passkey, a password and an authenticator app; nothing is active until the
 * last step, which also shows the recovery codes once.
 */
const STATE_KEY = 'exdb.enrollment'

const INTRO: Readonly<Record<EnrollmentState['kind'], string>> = {
  setup: 'Set up the first owner of this installation.',
  invitation: 'You were invited. Set up how you sign in.',
  recovery:
    'Recover your account. Your previous passkeys, password and authenticator app stop working when you finish.',
}

export async function enrollmentPage(ui: Shell, page: LinkPage): Promise<void> {
  const token = linkToken(page, location.hash)
  if (location.hash !== '') {
    history.replaceState(null, '', location.pathname)
  }
  let state: EnrollmentState | undefined
  if (token !== undefined) {
    state = await call<EnrollmentState>('POST', '/auth/enrollment/redeem', { token })
  } else {
    state = remembered()
  }
  if (state === undefined) {
    replace(
      ui.content,
      h(
        'p',
        {},
        'This link is incomplete, expired or already used. Ask for a new link; each link works once.',
      ),
    )
    return
  }
  render(ui, state)
}

function remember(state: EnrollmentState): void {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Without storage a reload asks for a new link; nothing else depends on it.
  }
}

function remembered(): EnrollmentState | undefined {
  try {
    const text = sessionStorage.getItem(STATE_KEY)
    const value: unknown = text === null ? undefined : JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'steps' in value && 'email' in value) {
      // Shown only; the server holds the real state and refuses anything out of order.
      return value as EnrollmentState
    }
  } catch {
    return undefined
  }
  return undefined
}

function forget(): void {
  try {
    sessionStorage.removeItem(STATE_KEY)
  } catch {
    // Nothing to clean up.
  }
}

function render(ui: Shell, state: EnrollmentState): void {
  remember(state)
  const update = (next: EnrollmentState) => {
    render(ui, next)
    ui.status('Saved.')
  }
  const steps = h('ol', { class: 'steps' })

  const passkeyLabel = h('input', {
    name: 'label',
    maxlength: 64,
    autocomplete: 'off',
    value: 'My passkey',
  })
  steps.append(
    step(
      'Passkey',
      state.steps.passkey,
      'Your passkey is your main way to sign in.',
      labeled('Name for this passkey', passkeyLabel),
      action(
        'Create passkey',
        ui,
        async () => {
          const options = await call<CreationOptions>('POST', '/auth/enrollment/passkey/options')
          const credential = await createPasskey(options)
          const label = passkeyLabel.value.trim()
          update(
            await call<EnrollmentState>('POST', '/auth/enrollment/passkey', {
              credential,
              ...(label === '' ? {} : { label }),
            }),
          )
        },
        { id: 'create-passkey' },
      ),
    ),
  )

  steps.append(
    step(
      'Password',
      state.steps.password,
      'A fallback for when no passkey is at hand: at least 14 characters, not a common password.',
      form(
        ui,
        { id: 'set-password' },
        async (f) => {
          if (field(f, 'password') !== field(f, 'confirm')) {
            ui.status('The two passwords differ.')
            return
          }
          update(
            await call<EnrollmentState>('POST', '/auth/enrollment/password', {
              password: field(f, 'password'),
            }),
          )
        },
        labeled(
          'New password',
          h('input', {
            name: 'password',
            type: 'password',
            autocomplete: 'new-password',
            minlength: 14,
            required: true,
          }),
        ),
        labeled(
          'Repeat the password',
          h('input', {
            name: 'confirm',
            type: 'password',
            autocomplete: 'new-password',
            minlength: 14,
            required: true,
          }),
        ),
        h('button', { type: 'submit' }, 'Set password'),
      ),
    ),
  )

  const totpArea = h('div', { class: 'totp' })
  steps.append(
    step(
      'Authenticator app',
      state.steps.totp,
      'The second factor for the password, and a way to confirm actions.',
      totpArea,
      action(
        'Set up authenticator app',
        ui,
        async () => {
          const setup = await call<TotpSetup>('POST', '/auth/enrollment/totp/options')
          showTotp(ui, totpArea, setup, async (code) =>
            update(await call<EnrollmentState>('POST', '/auth/enrollment/totp', { code })),
          )
        },
        { id: 'setup-totp' },
      ),
    ),
  )

  const ready = state.steps.passkey && state.steps.password && state.steps.totp
  replace(
    ui.content,
    h('p', {}, INTRO[state.kind]),
    h('p', { class: 'meta' }, `${state.email} · link valid until ${formatTime(state.expiresAt)}`),
    steps,
    action(
      'Finish',
      ui,
      async () => {
        const done = await call<EnrollmentComplete>('POST', '/auth/enrollment/complete')
        forget()
        showRecoveryCodes(ui, done.recoveryCodes, '/account')
      },
      ready
        ? { id: 'finish', class: 'primary' }
        : { id: 'finish', class: 'primary', disabled: 'disabled' },
    ),
  )
}

function step(title: string, done: boolean, hint: string, ...body: Node[]): HTMLLIElement {
  return h(
    'li',
    { class: done ? 'step done' : 'step' },
    h('h2', {}, title, done ? h('span', { class: 'badge' }, 'done') : null),
    h('p', { class: 'hint' }, hint),
    ...(done ? [] : body),
  )
}

/** Shows the TOTP QR code (drawn locally) and the secret, and asks for one code to confirm. */
export function showTotp(
  ui: Shell,
  area: HTMLElement,
  setup: TotpSetup,
  confirm: (code: string) => Promise<void>,
): void {
  replace(
    area,
    qrImage(qrPath(setup.qr.rows), setup.qr.size, 'QR code for your authenticator app'),
    h('p', { class: 'hint' }, 'Scan the code, or type this key into the app:'),
    h('code', { class: 'secret', id: 'totp-secret' }, groupSecret(setup.secret)),
    form(
      ui,
      { id: 'confirm-totp' },
      async (f) => confirm(field(f, 'code')),
      labeled(
        'Code shown by the app',
        h('input', {
          name: 'code',
          inputmode: 'numeric',
          autocomplete: 'one-time-code',
          pattern: '[0-9]{6}',
          maxlength: 6,
          required: true,
        }),
      ),
      h('button', { type: 'submit' }, 'Confirm'),
    ),
  )
}

/** Recovery codes are shown exactly once; the person confirms they stored them. */
export function showRecoveryCodes(ui: Shell, codes: readonly string[], next: string): void {
  const stored = h('input', { type: 'checkbox', id: 'codes-stored' })
  const go = h(
    'button',
    { type: 'button', class: 'primary', id: 'continue', disabled: true },
    'Continue',
  )
  stored.addEventListener('change', () => {
    go.disabled = !stored.checked
  })
  go.addEventListener('click', () => location.assign(next))
  replace(
    ui.content,
    h(
      'p',
      {},
      'These recovery codes are shown only now. Each works once, to sign in when your passkey and authenticator app are lost. Store them somewhere safe and offline.',
    ),
    h(
      'ol',
      { class: 'codes', id: 'recovery-codes' },
      ...codes.map((c) => h('li', {}, h('code', {}, c))),
    ),
    h('label', { class: 'check' }, stored, h('span', {}, 'I have stored these codes')),
    go,
  )
  ui.status('Done.')
}
