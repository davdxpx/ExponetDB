import type { CredentialView } from '@exponetdb/contracts'
import { call } from '../api.ts'
import { formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { credentialTarget } from '../safe.ts'
import { action, type Shell } from '../shell.ts'

/**
 * Submitting the password of one of ExponetDB's roles on an external
 * cluster ([`credentials-and-roles.md` §5](../../../../exponetdb-docs/03-database-model/credentials-and-roles.md)):
 * the person set the password on the cluster (psql `\password`, or a SCRAM
 * verifier) and enters the same password here once. Write-only: the page
 * never shows a password, clears the fields after sending, and the server
 * encrypts it at once; the worker logs in with it over verified TLS before
 * it becomes active. Needs a fresh re-authentication. The CLI opens this
 * page (`exponetdb cluster credential submit`) and watches the state.
 */
const ROLES = ['observer', 'reader', 'verifier', 'operator', 'migrator'] as const

function stateLine(c: CredentialView | undefined): string {
  if (c === undefined) return 'No password submitted yet.'
  const when = c.verifiedAt === null ? formatTime(c.submittedAt) : formatTime(c.verifiedAt)
  return c.state === 'failed'
    ? `Version ${c.version} failed (${c.failureCode ?? 'unknown reason'}), ${when}.`
    : `Version ${c.version} is ${c.state}, ${when}.`
}

export async function credentialsPage(ui: Shell): Promise<void> {
  const target = credentialTarget(location.hash)
  if (target === undefined) {
    replace(ui.content, h('p', { id: 'credentials-missing' }, 'Open the link your terminal shows.'))
    return
  }
  const { cluster } = target
  const list = await call<{ items: CredentialView[] }>(
    'GET',
    `/api/v1/clusters/${cluster}/credentials`,
  )
  const latest = (role: string) =>
    list.items.filter((c) => c.accessRole === role).sort((a, b) => b.version - a.version)[0]
  const role = h(
    'select',
    { name: 'role', id: 'credential-role' },
    ...ROLES.map((r) =>
      h('option', r === target.role ? { value: r, selected: '' } : { value: r }, r),
    ),
  )
  const state = h('p', { id: 'credential-state' }, stateLine(latest(target.role ?? 'observer')))
  role.addEventListener('change', () => {
    state.textContent = stateLine(latest(role.value))
  })
  const password = h('input', {
    name: 'password',
    id: 'credential-password',
    type: 'password',
    autocomplete: 'new-password',
    minlength: '16',
    maxlength: '256',
  })
  const confirm = h('input', {
    name: 'confirm',
    id: 'credential-confirm',
    type: 'password',
    autocomplete: 'new-password',
    minlength: '16',
    maxlength: '256',
  })
  replace(
    ui.content,
    h(
      'section',
      { class: 'card', id: 'credentials' },
      h('h2', {}, 'Submit a role password'),
      h(
        'dl',
        {},
        h('dt', {}, 'Cluster'),
        h('dd', { id: 'credential-cluster' }, h('code', {}, cluster)),
      ),
      h('label', {}, 'Role', role),
      state,
      h(
        'p',
        { class: 'hint' },
        'Enter the password you set for this role on the cluster. It is stored encrypted and never shown again; the worker signs in with it over verified TLS before it is used.',
      ),
      h('label', {}, 'Password', password),
      h('label', {}, 'Repeat the password', confirm),
      h(
        'div',
        { class: 'row' },
        action(
          'Submit',
          ui,
          async () => {
            const value = password.value
            const repeated = confirm.value
            password.value = ''
            confirm.value = ''
            if (value !== repeated) throw new Error('The two passwords differ. Nothing was sent.')
            if (value.length < 16)
              throw new Error('The password has fewer than 16 characters. Nothing was sent.')
            const submitted = await withReauth(() =>
              call<CredentialView>(
                'POST',
                `/api/v1/clusters/${cluster}/credentials/${role.value}`,
                {
                  password: value,
                },
              ),
            )
            state.textContent = stateLine(submitted)
            ui.status(
              `Submitted version ${submitted.version} of ${submitted.roleName}: pending until the worker verifies it. Your terminal shows when it is active.`,
            )
          },
          { class: 'primary', id: 'credential-submit' },
        ),
      ),
    ),
  )
}
