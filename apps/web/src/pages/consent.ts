import type { ConsentView, Scope, Tier } from '@exponetdb/contracts'
import { call } from '../api.ts'
import { field, formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { requestHandle } from '../safe.ts'
import { form, type Shell } from '../shell.ts'

/**
 * Consent (oauth.md §4): what a client asks for, shown so a person can tell
 * a real request from a lookalike. The client's name is untrusted text and
 * marked as such unless the client is first party; the host the code goes
 * to is shown prominently; production is opt-in. Nothing from the client is
 * rendered as markup and no remote logo is loaded. The server decides again
 * when the choice is submitted.
 */
export interface Choice {
  readonly decision: 'allow' | 'deny'
  readonly scopes: Scope[]
  readonly tiers: Tier[]
  readonly lifetimeDays: number
  readonly acknowledgeProduction?: true
}

export function consentForm(
  ui: Shell,
  view: ConsentView,
  submit: (choice: Choice) => Promise<void>,
): HTMLElement {
  const client = view.client
  const offered = view.scopes
  const scopeBoxes = offered.map((offer) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        name: 'scope',
        value: offer.scope,
        checked: offer.available && !offer.explicitConsent,
        disabled: !offer.available,
      }),
      h(
        'span',
        {},
        h('code', {}, offer.scope),
        offer.write
          ? h('span', { class: 'badge' }, 'changes')
          : h('span', { class: 'badge' }, 'reads'),
        offer.tier === 'prod' ? h('span', { class: 'badge warn' }, 'production') : null,
        offer.available
          ? null
          : h(
              'span',
              { class: 'meta' },
              offer.reason === 'not_held'
                ? ' you do not hold this'
                : ' never available to this client',
            ),
      ),
    ),
  )
  const tierBox = (tier: Tier, label: string) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        name: 'tier',
        value: tier,
        checked: view.defaults.tiers.includes(tier),
      }),
      h('span', {}, label),
    )
  const decide = (decision: 'allow' | 'deny') => async (f: HTMLFormElement) => {
    const data = new FormData(f)
    const scopes = data
      .getAll('scope')
      .filter((v): v is Scope => typeof v === 'string' && offered.some((o) => o.scope === v))
    const tiers = data.getAll('tier').filter((v): v is Tier => v === 'prod' || v === 'nonprod')
    const days = Number(field(f, 'days'))
    await submit({
      decision,
      scopes,
      tiers,
      lifetimeDays: Number.isInteger(days) && days >= 1 ? days : view.lifetimeDays.default,
      ...(data.get('production') === 'yes' ? { acknowledgeProduction: true } : {}),
    })
  }
  const allow = form(
    ui,
    { id: 'consent-form' },
    decide('allow'),
    h(
      'fieldset',
      {},
      h('legend', {}, 'What it may do (never more than you hold yourself)'),
      ...scopeBoxes,
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Where'),
      tierBox('nonprod', 'Non-production targets'),
      tierBox('prod', 'Production targets'),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', name: 'production', value: 'yes' }),
        h('span', {}, 'I allow access to production. Changes there need a fresh confirmation.'),
      ),
    ),
    h(
      'label',
      {},
      h('span', {}, `For how many days (at most ${view.lifetimeDays.max})`),
      h('input', {
        name: 'days',
        type: 'number',
        min: 1,
        max: view.lifetimeDays.max,
        value: view.lifetimeDays.default,
        required: true,
      }),
    ),
    h('button', { type: 'submit', class: 'primary', id: 'consent-allow' }, 'Allow'),
  )
  const deny = form(
    ui,
    { id: 'consent-deny' },
    decide('deny'),
    h('button', { type: 'submit' }, 'Deny'),
  )
  return h(
    'div',
    { class: 'consent' },
    client.lookalike
      ? h(
          'p',
          { class: 'banner warn', role: 'alert', id: 'lookalike' },
          'Warning: this application calls itself like an ExponetDB application but is not one. Deny unless you started it yourself.',
        )
      : null,
    h(
      'dl',
      {},
      h('dt', {}, 'Application'),
      h(
        'dd',
        { id: 'consent-client' },
        client.name,
        h(
          'span',
          { class: client.firstParty ? 'badge' : 'badge warn' },
          client.firstParty ? 'ExponetDB' : 'name not verified',
        ),
      ),
      h('dt', {}, 'Client id'),
      h('dd', {}, h('code', {}, client.clientId)),
      h('dt', {}, 'Returns to'),
      h(
        'dd',
        { id: 'consent-redirect' },
        client.loopbackRedirect
          ? 'an application on this computer (loopback)'
          : h('strong', {}, client.redirectHost ?? 'the device that started the sign-in'),
      ),
      h('dt', {}, 'For'),
      h(
        'dd',
        {},
        view.resource === 'mcp' ? 'the MCP server' : 'the REST API',
        ` (${view.resourceUri})`,
      ),
      h('dt', {}, 'Decide by'),
      h('dd', {}, formatTime(view.expiresAt)),
    ),
    allow,
    deny,
  )
}

/** /oauth/consent#request=exar_…: the decision on a pending authorization request. */
export async function consentPage(ui: Shell): Promise<void> {
  const request = requestHandle(location.hash)
  if (request === undefined) {
    replace(
      ui.content,
      h('p', {}, 'This sign-in request is not valid. Start again in the application.'),
    )
    return
  }
  const view = await call<ConsentView>('POST', '/auth/oauth/consent/view', { request })
  replace(
    ui.content,
    consentForm(ui, view, async (choice) => {
      const result = await withReauth(() =>
        call<{ redirectTo: string }>('POST', '/auth/oauth/consent', { request, ...choice }),
      )
      ui.status('Returning to the application…')
      location.assign(result.redirectTo)
    }),
  )
}

/** /oauth/device: the person types the code the device shows (never taken from a link). */
export async function devicePage(ui: Shell): Promise<void> {
  const entry = form(
    ui,
    { id: 'device-code' },
    async (f) => {
      const userCode = field(f, 'code').trim()
      const view = await call<ConsentView>('POST', '/auth/oauth/device/view', { userCode })
      replace(
        ui.content,
        h(
          'p',
          {},
          'Check that this is the code your device shows: ',
          h('strong', {}, userCode.toUpperCase()),
        ),
        consentForm(ui, view, async (choice) => {
          const result = await withReauth(() =>
            call<{ status: 'approved' | 'denied' }>('POST', '/auth/oauth/device', {
              userCode,
              ...choice,
            }),
          )
          replace(
            ui.content,
            h(
              'p',
              { id: 'device-done' },
              result.status === 'approved'
                ? 'Approved. Return to your device.'
                : 'Denied. The device gets no access.',
            ),
          )
        }),
      )
    },
    h(
      'label',
      {},
      h('span', {}, 'Code shown on the device'),
      h('input', {
        name: 'code',
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        maxlength: 16,
        required: true,
      }),
    ),
    h('button', { type: 'submit', class: 'primary' }, 'Continue'),
  )
  replace(ui.content, entry)
}
