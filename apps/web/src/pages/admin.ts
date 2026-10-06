import type {
  ApiKeyCreated,
  GrantView,
  OAuthClientView,
  ServiceAccountView,
  Tier,
} from '@exponetdb/contracts'
import { call } from '../api.ts'
import { field, formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { action, form, labeled, type Shell } from '../shell.ts'

/**
 * Administration of delegated access (OD-5, identity.md §5): OAuth clients
 * waiting for review and the service accounts with their keys, machine
 * grants and API keys. The server decides who may see and change what;
 * every change needs a fresh confirmation (`withReauth`). Client metadata
 * is untrusted text: shown, never interpreted, no remote logos.
 */
export async function clientsPage(ui: Shell): Promise<void> {
  const { items } = await call<{ items: OAuthClientView[] }>(
    'GET',
    '/api/v1/oauth-clients?limit=200',
  )
  const reload = () => clientsPage(ui)
  const add = form(
    ui,
    { id: 'cimd-add', class: 'inline' },
    async (f) => {
      const client = await call<OAuthClientView>('POST', '/api/v1/oauth-clients/cimd', {
        clientId: field(f, 'clientId').trim(),
      })
      await reload()
      ui.status(`${client.clientId} was fetched and waits for review.`)
    },
    labeled(
      'Client ID Metadata Document URL (exact)',
      h('input', {
        name: 'clientId',
        type: 'url',
        required: true,
        maxlength: 512,
        placeholder: 'exact client_id URL',
      }),
    ),
    h('button', { type: 'submit' }, 'Fetch for review'),
  )
  replace(
    ui.content,
    add,
    h('ul', { class: 'cards', id: 'client-list' }, ...items.map((c) => clientCard(ui, c, reload))),
  )
}

function clientCard(
  ui: Shell,
  client: OAuthClientView,
  reload: () => Promise<void>,
): HTMLLIElement {
  const decide = (verb: 'approve' | 'reject' | 'disable', body: object) =>
    action(
      verb === 'approve' ? 'Approve this exact client' : verb === 'reject' ? 'Reject' : 'Disable',
      ui,
      async () => {
        await withReauth(() =>
          call<OAuthClientView>('POST', `/api/v1/oauth-clients/${client.id}/${verb}`, body),
        )
        await reload()
        ui.status(
          verb === 'approve'
            ? 'Approved.'
            : verb === 'reject'
              ? 'Rejected.'
              : 'Disabled; its grants ended.',
        )
      },
      verb === 'approve' ? { class: 'primary' } : {},
    )
  return h(
    'li',
    { class: `card state-${client.state}`, 'data-client': client.id },
    h(
      'h2',
      {},
      client.name,
      h(
        'span',
        { class: client.firstParty ? 'badge' : 'badge warn' },
        client.firstParty ? 'ExponetDB' : 'name not verified',
      ),
      h('span', { class: 'badge' }, client.state),
    ),
    h(
      'dl',
      {},
      h('dt', {}, 'Client id'),
      h('dd', {}, h('code', {}, client.clientId)),
      h('dt', {}, 'Registration'),
      h('dd', {}, `${client.registration} (${client.kind}, ${client.tokenEndpointAuthMethod})`),
      h('dt', {}, 'Redirect URIs'),
      h(
        'dd',
        {},
        client.redirectUris.length === 0
          ? 'none'
          : h('ul', {}, ...client.redirectUris.map((u) => h('li', {}, h('code', {}, u)))),
      ),
      h('dt', {}, 'Fingerprint'),
      h('dd', {}, h('code', { class: 'hash' }, client.metadataFingerprint)),
      client.requesterHash === null ? null : h('dt', {}, 'Requester (pseudonym)'),
      client.requesterHash === null
        ? null
        : h('dd', {}, h('code', { class: 'hash' }, client.requesterHash)),
      client.pendingExpiresAt === null ? null : h('dt', {}, 'Expires unless approved'),
      client.pendingExpiresAt === null ? null : h('dd', {}, formatTime(client.pendingExpiresAt)),
    ),
    h(
      'div',
      { class: 'row' },
      client.state === 'pending' || client.state === 'rejected' || client.state === 'disabled'
        ? decide('approve', { fingerprint: client.metadataFingerprint })
        : null,
      client.state === 'pending' ? decide('reject', {}) : null,
      client.state === 'active' && !client.firstParty ? decide('disable', {}) : null,
      client.registration === 'cimd'
        ? action('Fetch metadata again', ui, async () => {
            await call('POST', `/api/v1/oauth-clients/${client.id}/refresh-metadata`)
            await reload()
            ui.status('Metadata fetched.')
          })
        : null,
    ),
  )
}

// ----- service accounts -----

function authorityFields(maxDays: number, defaultDays: number) {
  return [
    labeled(
      'Scopes (space-separated)',
      h('input', { name: 'scopes', required: true, value: 'targets.read' }),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', name: 'tier', value: 'nonprod', checked: true }),
      h('span', {}, 'Non-production'),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', name: 'tier', value: 'prod' }),
      h('span', {}, 'Production'),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', name: 'production', value: 'yes' }),
      h('span', {}, 'I give this service account production write authority'),
    ),
    labeled(
      `Days (at most ${maxDays})`,
      h('input', {
        name: 'days',
        type: 'number',
        min: 1,
        max: maxDays,
        value: defaultDays,
        required: true,
      }),
    ),
  ]
}

function authorityOf(f: HTMLFormElement) {
  const data = new FormData(f)
  // The server validates every scope against the catalog; this only splits the input.
  const scopes = field(f, 'scopes')
    .split(/\s+/)
    .filter((s) => s.length > 0)
  const tiers = data.getAll('tier').filter((v): v is Tier => v === 'prod' || v === 'nonprod')
  return {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' as const } },
    lifetimeDays: Number(field(f, 'days')),
    ...(data.get('production') === 'yes' ? { acknowledgeProductionWrite: true as const } : {}),
  }
}

/** The `keys` of a pasted JWKS; the server validates each key (public members only). */
function parseJwks(text: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The keys are not valid JSON.')
  }
  const keys =
    typeof parsed === 'object' && parsed !== null && 'keys' in parsed ? parsed.keys : parsed
  if (!Array.isArray(keys)) {
    throw new Error('A JWKS needs a "keys" array of public keys.')
  }
  return keys
}

export async function serviceAccountsPage(ui: Shell): Promise<void> {
  const { items } = await call<{ items: ServiceAccountView[] }>(
    'GET',
    '/api/v1/service-accounts?limit=200',
  )
  const reload = () => serviceAccountsPage(ui)
  const create = form(
    ui,
    { id: 'service-create', class: 'inline' },
    async (f) => {
      await withReauth(() =>
        call<ServiceAccountView>('POST', '/api/v1/service-accounts', {
          displayName: field(f, 'name').trim(),
        }),
      )
      await reload()
      ui.status('Service account created. It has no role and no credential yet.')
    },
    labeled('Name', h('input', { name: 'name', required: true, maxlength: 128 })),
    h('button', { type: 'submit' }, 'Create service account'),
  )
  replace(
    ui.content,
    create,
    h(
      'ul',
      { class: 'cards', id: 'service-list' },
      ...items.map((s) => serviceCard(ui, s, reload)),
    ),
  )
}

function grantLine(grant: GrantView): HTMLLIElement {
  return h(
    'li',
    {},
    h('span', {}, grant.scopes.join(' ')),
    h(
      'span',
      { class: 'meta' },
      ` ${grant.restrictions.tiers.join('+')}, ${grant.state}, until ${formatTime(grant.expiresAt)}`,
    ),
  )
}

function serviceCard(
  ui: Shell,
  account: ServiceAccountView,
  reload: () => Promise<void>,
): HTMLLIElement {
  const secret = h('div', { class: 'secret', 'aria-live': 'polite' })
  const keysForm = form(
    ui,
    { class: 'inline' },
    async (f) => {
      const jwks = { keys: parseJwks(field(f, 'jwks')) }
      const path =
        account.client === null
          ? `/api/v1/service-accounts/${account.id}/oauth-client`
          : `/api/v1/service-accounts/${account.id}/oauth-client/keys`
      await withReauth(() => call<OAuthClientView>('POST', path, { jwks }))
      await reload()
      ui.status(account.client === null ? 'Client registered.' : 'Keys replaced.')
    },
    h(
      'label',
      {},
      h('span', {}, 'Public keys (JWKS JSON; never a private key)'),
      h('textarea', { name: 'jwks', rows: 4, required: true }),
    ),
    h('button', { type: 'submit' }, account.client === null ? 'Register client' : 'Replace keys'),
  )
  const grantForm =
    account.client === null
      ? null
      : form(
          ui,
          { class: 'inline' },
          async (f) => {
            await withReauth(() =>
              call<GrantView>(
                'POST',
                `/api/v1/service-accounts/${account.id}/grants`,
                authorityOf(f),
              ),
            )
            await reload()
            ui.status('Machine grant created; any previous one ended.')
          },
          ...authorityFields(365, 90),
          h('button', { type: 'submit' }, 'Grant'),
        )
  const keyForm = form(
    ui,
    { class: 'inline' },
    async (f) => {
      const created = await withReauth(() =>
        call<ApiKeyCreated>(
          'POST',
          `/api/v1/service-accounts/${account.id}/api-keys`,
          authorityOf(f),
        ),
      )
      replace(
        secret,
        h('p', {}, 'Copy the key now. It is shown only this once:'),
        h('code', { class: 'once', id: 'api-key-secret' }, created.secret),
      )
      ui.status('API key created.')
    },
    ...authorityFields(365, 90),
    h('button', { type: 'submit' }, 'Create API key'),
  )
  return h(
    'li',
    { class: `card state-${account.state}`, 'data-service': account.id },
    h('h2', {}, account.displayName ?? account.label, h('span', { class: 'badge' }, account.state)),
    h(
      'dl',
      {},
      h('dt', {}, 'Audit label'),
      h('dd', {}, account.label),
      h('dt', {}, 'Client'),
      h('dd', {}, account.client === null ? 'none' : h('code', {}, account.client.clientId)),
      h('dt', {}, 'Keys'),
      h(
        'dd',
        {},
        account.client === null
          ? '–'
          : account.client.keys.map((k) => `${k.kid} (${k.kty})`).join(', '),
      ),
    ),
    h('h3', {}, 'Machine grants'),
    h('ul', { class: 'list' }, ...account.grants.map(grantLine)),
    keysForm,
    grantForm,
    h('h3', {}, 'API keys'),
    h(
      'ul',
      { class: 'list' },
      ...account.apiKeys.map((k) =>
        h(
          'li',
          {},
          h('span', {}, k.label ?? k.id),
          h(
            'span',
            { class: 'meta' },
            ` ${k.scopes.join(' ')}, ${k.state}, until ${formatTime(k.expiresAt)}`,
            k.lastUsedAt === null ? '' : `, last used ${formatTime(k.lastUsedAt)}`,
          ),
          k.state === 'active'
            ? action(
                'Revoke',
                ui,
                async () => {
                  await withReauth(() => call('POST', `/api/v1/api-keys/${k.id}/revoke`, {}))
                  await reload()
                  ui.status('API key revoked.')
                },
                { class: 'link' },
              )
            : null,
        ),
      ),
    ),
    keyForm,
    secret,
  )
}
