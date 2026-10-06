import type {
  CreationOptions,
  FactorView,
  Me,
  RecoveryCodesView,
  SessionView,
  TotpSetup,
} from '@exponetdb/contracts'
import { call } from '../api.ts'
import { field, formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { action, form, labeled, type Shell } from '../shell.ts'
import { createPasskey } from '../webauthn.ts'
import { showRecoveryCodes, showTotp } from './enrollment.ts'

/**
 * The signed-in person's own account: who they are, their roles, their
 * passkeys and other factors, and their sessions. Changes to credentials
 * need a recent confirmation (the server decides; `withReauth` asks).
 */
export async function accountPage(ui: Shell): Promise<void> {
  const [me, factors, sessions] = await Promise.all([
    call<Me>('GET', '/api/v1/me'),
    call<{ items: FactorView[] }>('GET', '/api/v1/me/factors'),
    call<{ items: SessionView[] }>('GET', '/api/v1/me/sessions'),
  ])
  const reload = () => accountPage(ui)
  const recovery = me.session.assurance === 'recovery' || me.identity.recoveryRequired
  replace(
    ui.content,
    recovery
      ? h(
          'div',
          { class: 'banner', id: 'recovery-banner', role: 'note' },
          h('strong', {}, 'Recovery in progress. '),
          'Add a new passkey and set up a new authenticator app to finish. Until then nothing else can be changed.',
        )
      : null,
    identitySection(me),
    passkeysSection(ui, factors.items, reload),
    otherFactorsSection(ui, factors.items, reload),
    sessionsSection(ui, sessions.items, reload),
  )
}

function identitySection(me: Me): HTMLElement {
  const roles = me.bindings
    .filter((b) => b.state === 'active')
    .map((b) => `${b.roleId} (${b.scope.kind})`)
  return h(
    'section',
    { 'aria-labelledby': 'who' },
    h('h2', { id: 'who' }, 'You'),
    h(
      'dl',
      {},
      h('dt', {}, 'E-mail'),
      h('dd', { id: 'me-email' }, me.identity.email ?? '–'),
      h('dt', {}, 'Name'),
      h('dd', {}, me.identity.displayName ?? '–'),
      h('dt', {}, 'Audit label'),
      h('dd', {}, me.identity.label),
      h('dt', {}, 'Roles'),
      h('dd', { id: 'me-roles' }, roles.length === 0 ? 'none' : roles.join(', ')),
    ),
  )
}

function passkeysSection(ui: Shell, factors: readonly FactorView[], reload: () => Promise<void>) {
  const passkeys = factors.flatMap((f) => (f.kind === 'passkey' ? [f] : []))
  const label = h('input', {
    name: 'label',
    maxlength: 64,
    autocomplete: 'off',
    value: 'Another passkey',
  })
  return h(
    'section',
    { 'aria-labelledby': 'passkeys' },
    h('h2', { id: 'passkeys' }, 'Passkeys'),
    h(
      'ul',
      { class: 'list', id: 'passkey-list' },
      ...passkeys.map((p) =>
        h(
          'li',
          {},
          h('span', {}, p.label),
          h(
            'span',
            { class: 'meta' },
            `added ${formatTime(p.createdAt)}`,
            p.lastUsedAt === null ? '' : `, last used ${formatTime(p.lastUsedAt)}`,
          ),
          action(
            'Remove',
            ui,
            async () => {
              await withReauth(() => call('POST', `/auth/passkeys/${p.id}/remove`))
              await reload()
              ui.status('Passkey removed.')
            },
            { class: 'link' },
          ),
        ),
      ),
    ),
    labeled('Name for a new passkey', label),
    action(
      'Add a passkey',
      ui,
      async () => {
        await withReauth(async () => {
          const options = await call<CreationOptions>('POST', '/auth/passkeys/options')
          const credential = await createPasskey(options)
          const name = label.value.trim()
          await call('POST', '/auth/passkeys', {
            credential,
            ...(name === '' ? {} : { label: name }),
          })
        })
        await reload()
        ui.status('Passkey added.')
      },
      { id: 'add-passkey' },
    ),
  )
}

function otherFactorsSection(
  ui: Shell,
  factors: readonly FactorView[],
  reload: () => Promise<void>,
) {
  const totpArea = h('div', { class: 'totp' })
  const password = form(
    ui,
    { id: 'change-password' },
    async (f) => {
      if (field(f, 'password') !== field(f, 'confirm')) {
        ui.status('The two passwords differ.')
        return
      }
      await withReauth(() => call('POST', '/auth/password', { password: field(f, 'password') }))
      f.reset()
      ui.status('Password changed.')
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
    h('button', { type: 'submit' }, 'Change password'),
  )
  const hasTotp = factors.some((f) => f.kind === 'totp')
  return h(
    'section',
    { 'aria-labelledby': 'factors' },
    h('h2', { id: 'factors' }, 'Password, authenticator app and recovery codes'),
    password,
    action(
      hasTotp ? 'Replace authenticator app' : 'Set up authenticator app',
      ui,
      async () => {
        const setup = await withReauth(() => call<TotpSetup>('POST', '/auth/totp/options'))
        showTotp(ui, totpArea, setup, async (code) => {
          await withReauth(() => call('POST', '/auth/totp', { code }))
          await reload()
          ui.status('Authenticator app replaced.')
        })
      },
      { id: 'replace-totp' },
    ),
    totpArea,
    action(
      'Create new recovery codes',
      ui,
      async () => {
        const codes = await withReauth(() =>
          call<RecoveryCodesView>('POST', '/auth/recovery-codes'),
        )
        showRecoveryCodes(ui, codes.recoveryCodes, '/account')
      },
      { id: 'regenerate-codes' },
    ),
  )
}

function sessionsSection(ui: Shell, sessions: readonly SessionView[], reload: () => Promise<void>) {
  return h(
    'section',
    { 'aria-labelledby': 'sessions' },
    h('h2', { id: 'sessions' }, 'Signed-in sessions'),
    h(
      'ul',
      { class: 'list', id: 'session-list' },
      ...sessions.map((s) =>
        h(
          'li',
          {},
          h('span', {}, s.device, s.current ? h('span', { class: 'badge' }, 'this browser') : null),
          h(
            'span',
            { class: 'meta' },
            `since ${formatTime(s.createdAt)}, ends by ${formatTime(s.expiresAt)}`,
          ),
          s.current
            ? null
            : action(
                'Sign out',
                ui,
                async () => {
                  await call('POST', `/api/v1/me/sessions/${s.id}/revoke`)
                  await reload()
                  ui.status('Session signed out.')
                },
                { class: 'link' },
              ),
        ),
      ),
    ),
    action(
      'Sign out all other sessions',
      ui,
      async () => {
        await call('POST', '/api/v1/me/sessions/revoke-others')
        await reload()
        ui.status('Other sessions signed out.')
      },
      { id: 'revoke-others' },
    ),
  )
}
