import type { ReauthResult, RequestOptions } from '@exponetdb/contracts'
import { ApiError, call } from './api.ts'
import { field, h } from './dom.ts'
import { describe } from './shell.ts'
import { assertWithPasskey } from './webauthn.ts'

/**
 * Step-up: when the server answers `REAUTH_REQUIRED`, the person confirms
 * with a passkey (preferred) or an authenticator code, and the action runs
 * once more. The window is decided and checked by the server only.
 */
export class ReauthCanceled extends Error {
  override readonly name = 'ReauthCanceled'
}

export async function withReauth<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'REAUTH_REQUIRED') {
      throw error
    }
  }
  await confirmIdentity()
  return run()
}

export async function reauthWithPasskey(): Promise<ReauthResult> {
  const options = await call<RequestOptions>('POST', '/auth/reauth/passkey/options')
  const credential = await assertWithPasskey(options)
  return call<ReauthResult>('POST', '/auth/reauth/passkey', { credential })
}

function confirmIdentity(): Promise<void> {
  return new Promise((resolve, reject) => {
    const message = h('p', { class: 'alert', role: 'alert' })
    const dialog = h('dialog', { 'aria-labelledby': 'reauth-title', class: 'reauth' })
    const done = (error?: unknown) => {
      dialog.close()
      dialog.remove()
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const attempt = (step: () => Promise<unknown>) => {
      message.textContent = ''
      step().then(
        () => done(),
        (error: unknown) => {
          message.textContent = describe(error)
        },
      )
    }
    const passkey = h('button', { type: 'button', id: 'reauth-passkey' }, 'Confirm with passkey')
    passkey.addEventListener('click', () => attempt(reauthWithPasskey))
    const code = h('input', {
      name: 'code',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      pattern: '[0-9]{6}',
      maxlength: 6,
      required: true,
    })
    const totp = h(
      'form',
      { class: 'inline', id: 'reauth-totp' },
      h('label', {}, h('span', {}, 'Or enter the code from your authenticator app'), code),
      h('button', { type: 'submit' }, 'Confirm with code'),
    )
    totp.addEventListener('submit', (event) => {
      event.preventDefault()
      attempt(() => call<ReauthResult>('POST', '/auth/reauth/totp', { code: field(totp, 'code') }))
    })
    const cancel = h('button', { type: 'button', class: 'link' }, 'Cancel')
    cancel.addEventListener('click', () => done(new ReauthCanceled('Confirmation canceled.')))
    dialog.append(
      h('h2', { id: 'reauth-title' }, 'Confirm it is you'),
      h('p', {}, 'This action needs a recent confirmation of your identity.'),
      message,
      passkey,
      totp,
      cancel,
    )
    document.body.append(dialog)
    dialog.showModal()
  })
}
