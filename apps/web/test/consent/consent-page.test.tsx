import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { browserNavigation } from '../../src/features/consent/leave.ts'
import {
  consentView,
  HANDLE,
  mountApp,
  OAuthWorld,
  offer,
  T_PRODUCTION,
  T_STAGING,
} from './support.tsx'

afterEach(cleanup)

let assign: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined)
})
afterEach(() => {
  assign.mockRestore()
})

const CONSENT_PATH = `/oauth/consent#request=${HANDLE}`

function input(selector: string): HTMLInputElement {
  const element = document.querySelector(selector)
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input ${selector}`)
  return element
}

async function openConsent(world: OAuthWorld, path = CONSENT_PATH) {
  const mounted = mountApp(path, world)
  await screen.findByRole('heading', { level: 1, name: /^Authorize / })
  return mounted
}

describe('the consent page: what a client asks for', () => {
  it('reads the request by the handle of the fragment and shows the Authorize screen', async () => {
    const world = new OAuthWorld()
    await openConsent(world)
    expect(world.bodiesOf('/auth/oauth/consent/view')).toEqual([{ request: HANDLE }])
    // The handle is never in a query string and never sent anywhere else.
    expect(world.paths().filter((p) => p.includes(HANDLE))).toEqual([])
    expect(
      world.sent.filter((s) => JSON.stringify(s.body ?? null).includes(HANDLE)).map((s) => s.path),
    ).toEqual(['/auth/oauth/consent/view'])

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Authorize Agent')
    expect(screen.getByText('This application wants to access ExponetDB')).toBeInTheDocument()
    const client = document.getElementById('consent-client')
    expect(client).toHaveTextContent('Agent')
    expect(client).toHaveTextContent('name not verified')
    expect(document.getElementById('consent-redirect')?.textContent).toBe('agent.example.test')
    expect(screen.getByText('https://agent.example.test/client.json')).toBeInTheDocument()
    expect(screen.getByText('The MCP server')).toBeInTheDocument()
    expect(screen.getByText('Signed in as')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(document.getElementById('lookalike')).toBeNull()
    // Production rows and a changing scope are asked for together.
    expect(document.getElementById('trifecta-warning')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Authorize Agent' })).toHaveAttribute(
      'id',
      'consent-allow',
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(document.querySelector('#consent-form')?.textContent).toContain(
      'Authorizing will redirect you to agent.example.test',
    )
  })

  it('preselects non-production only; production and production scopes are opt-in', async () => {
    const world = new OAuthWorld()
    await openConsent(world)
    expect(input('#consent-form input[name="tier"][value="nonprod"]').checked).toBe(true)
    expect(input('#consent-form input[name="tier"][value="prod"]').checked).toBe(false)
    expect(document.querySelector('input[name="production"]')).toBeNull()
    expect(input('input[name="scope"][value="targets.read"]').checked).toBe(true)
    expect(input('input[name="scope"][value="migrations.apply:nonprod"]').checked).toBe(true)
    const prodScope = input('input[name="scope"][value="data.read:prod"]')
    expect(prodScope.checked).toBe(false)
    expect(prodScope.disabled).toBe(true)
    expect(input('input[name="where"][value="all"]').checked).toBe(true)
  })

  it('groups scopes by effect with lower-case badges and never offers what cannot be granted', async () => {
    const world = new OAuthWorld()
    await openConsent(world)
    const badges = [...document.querySelectorAll('#consent-form .badge')].map((b) => b.textContent)
    expect(badges).toEqual(['reads', 'records plans or checks, changes nothing', 'changes'])
    // registry.manage is listed as asked for, without a control that could grant it.
    expect(document.querySelector('input[name="scope"][value="registry.manage"]')).toBeNull()
    expect(screen.getByText('registry.manage')).toBeInTheDocument()
    expect(screen.getByText('Never available to this application.')).toBeInTheDocument()
  })

  it('names the effect of reads and records without "changes" when nothing changes', async () => {
    const world = new OAuthWorld()
    world.view = consentView({
      scopes: [
        offer('targets.read'),
        offer('schema.read', { write: true, effect: 'control_record' }),
      ],
    })
    await openConsent(world)
    const badges = [...document.querySelectorAll('#consent-form .badge')].map((b) => b.textContent)
    expect(badges).toContain('reads')
    expect(badges).toContain('records plans or checks, changes nothing')
    expect(badges).not.toContain('changes')
  })

  it('has no accessibility violations', async () => {
    const world = new OAuthWorld()
    world.view = consentView({ client: { ...consentView().client, lookalike: true } })
    await openConsent(world)
    await userEvent.setup().click(input('input[name="where"][value="list"]'))
    expect(await axeViolations()).toEqual([])
  })
})

describe('the consent page: hostile names and warnings', () => {
  it('shows a hostile name as text with every hidden character by code point', async () => {
    const world = new OAuthWorld()
    const hostile = 'ExponetDB CLI ‮evil​ <img src=x onerror="document.title=1">'
    world.view = consentView({
      client: { ...consentView().client, name: hostile, lookalike: true },
    })
    await openConsent(world)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toContain('⟨U+202E⟩')
    expect(heading.textContent).not.toContain('‮')
    const client = document.getElementById('consent-client')
    expect(client?.textContent).toContain('⟨U+202E⟩')
    expect(client?.textContent).toContain('<img src=x onerror="document.title=1">')
    expect(client?.textContent).toContain('name not verified')
    expect(document.querySelector('img')).toBeNull()
    expect(document.getElementById('consent-allow')?.textContent).not.toContain('‮')
    const lookalike = document.getElementById('lookalike')
    expect(lookalike).toHaveAttribute('role', 'alert')
    expect(lookalike).toHaveTextContent('not one')
  })

  it('cuts a long name in the title and the button but shows it whole on request', async () => {
    const world = new OAuthWorld()
    world.view = consentView({ client: { ...consentView().client, name: 'A'.repeat(100) } })
    await openConsent(world)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      `Authorize ${'A'.repeat(48)}…`,
    )
    expect(document.getElementById('consent-client')?.textContent).toContain('A'.repeat(100))
  })

  it('marks a first-party client and does not call its name unverified', async () => {
    const world = new OAuthWorld()
    world.view = consentView({
      client: {
        ...consentView().client,
        name: 'ExponetDB CLI',
        kind: 'cli',
        firstParty: true,
        redirectHost: '127.0.0.1',
        loopbackRedirect: true,
      },
      resource: 'api',
    })
    await openConsent(world)
    const client = document.getElementById('consent-client')
    expect(client).toHaveTextContent('ExponetDB application')
    expect(client).not.toHaveTextContent('name not verified')
    expect(document.getElementById('consent-redirect')).toHaveTextContent('loopback')
    expect(screen.getByText('The REST API')).toBeInTheDocument()
  })

  it('names the lethal trifecta for an MCP client asking for production rows and changes', async () => {
    const world = new OAuthWorld()
    world.view = consentView({
      scopes: [
        ...consentView().scopes,
        offer('migrations.apply:prod', {
          write: true,
          effect: 'consequential',
          tier: 'prod',
          explicitConsent: true,
        }),
      ],
    })
    await openConsent(world)
    expect(document.getElementById('trifecta-warning')?.textContent).toContain(
      'read production rows and to change databases',
    )
  })

  it('does not name the trifecta for the REST API', async () => {
    const world = new OAuthWorld()
    world.view = consentView({ resource: 'api' })
    await openConsent(world)
    expect(document.getElementById('trifecta-warning')).toBeNull()
  })
})

describe('the consent page: hostile links', () => {
  const invalid = [
    '/oauth/consent',
    '/oauth/consent#request=',
    `/oauth/consent#request=exar_${'A'.repeat(42)}`,
    `/oauth/consent#request=exar_${'A'.repeat(44)}`,
    `/oauth/consent#request=${HANDLE}&x=1`,
    `/oauth/consent#request=exar_%2F${'A'.repeat(42)}`,
    `/oauth/consent#junk#request=${HANDLE}`,
    `/oauth/consent#request=exsu_${'A'.repeat(43)}`,
    `/oauth/consent?request=${HANDLE}`,
    '/oauth/consent#request=<script>alert(1)</script>',
  ]
  for (const path of invalid) {
    it(`refuses ${path} with fixed text and asks the server nothing`, async () => {
      const world = new OAuthWorld()
      mountApp(path, world)
      expect(
        await screen.findByRole('heading', { name: 'This sign-in request is not valid' }),
      ).toBeInTheDocument()
      expect(world.paths().filter((p) => p.startsWith('/auth/'))).toEqual([])
      expect(document.body.textContent).not.toContain('script')
      expect(document.body.textContent).not.toContain('exar_')
      expect(document.querySelector('#consent-form')).toBeNull()
    })
  }

  it('sends only an exact handle when the router decodes an encoded fragment', async () => {
    // The router decodes the fragment and writes the decoded address back; the page then
    // matches the exact grammar, so only a handle the server could have issued is sent.
    const world = new OAuthWorld()
    mountApp(`/oauth/consent#request=exar_%41${'A'.repeat(42)}`, world)
    await screen.findByRole('heading', { level: 1, name: 'Authorize Agent' })
    expect(world.bodiesOf('/auth/oauth/consent/view')).toEqual([{ request: HANDLE }])
  })

  it('reads the new request when the fragment names another one; nothing acts on the old one', async () => {
    const world = new OAuthWorld()
    const { history } = await openConsent(world)
    const other = `exar_${'B'.repeat(43)}`
    world.view = consentView({ client: { ...consentView().client, name: 'Second' } })
    act(() => history.push(`/oauth/consent#request=${other}`))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Authorize Second' }),
    ).toBeInTheDocument()
    expect(world.bodiesOf('/auth/oauth/consent/view')).toEqual([
      { request: HANDLE },
      { request: other },
    ])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Authorize Second' }))
    await waitFor(() => expect(world.bodiesOf('/auth/oauth/consent')).toHaveLength(1))
    expect(world.bodiesOf('/auth/oauth/consent')[0]).toMatchObject({ request: other })
  })

  it('keeps the handle and the view out of the query cache', async () => {
    const world = new OAuthWorld()
    const { queryClient } = await openConsent(world)
    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state.data]),
    )
    expect(cached).not.toContain(HANDLE)
    expect(cached).not.toContain('agent.example.test')
  })

  it('leaves for sign-in without reading the request when the session is gone', async () => {
    const world = new OAuthWorld()
    world.failures.set('/api/v1/me', {
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Sign in.',
      sticky: true,
    })
    const { onSessionGone } = mountApp(CONSENT_PATH, world)
    await waitFor(() => expect(onSessionGone).toHaveBeenCalled())
    expect(world.paths().filter((p) => p.startsWith('/auth/'))).toEqual([])
    expect(document.querySelector('#consent-form')).toBeNull()
  })
})

describe('the consent page: deciding', () => {
  it('sends exactly the choice: production with its acknowledgement, only the checked targets', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    await openConsent(world)
    const allow = screen.getByRole('button', { name: 'Authorize Agent' })

    await user.click(input('input[name="tier"][value="prod"]'))
    // Production needs its acknowledgement before Authorize can be pressed.
    expect(allow).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Confirm that you allow access to production.')).toBeInTheDocument()
    await user.click(allow)
    expect(world.bodiesOf('/auth/oauth/consent')).toEqual([])

    await user.click(input('input[name="production"]'))
    await user.click(input('input[name="scope"][value="data.read:prod"]'))
    await user.click(input('input[name="where"][value="list"]'))
    await user.click(input(`input[name="target"][value="${T_STAGING}"]`))
    const days = screen.getByLabelText('Access lasts (days)')
    await user.clear(days)
    await user.type(days, '7')
    await user.click(allow)

    await waitFor(() => expect(world.bodiesOf('/auth/oauth/consent')).toHaveLength(1))
    expect(world.bodiesOf('/auth/oauth/consent')[0]).toEqual({
      request: HANDLE,
      decision: 'allow',
      scopes: ['targets.read', 'schema.read', 'migrations.apply:nonprod', 'data.read:prod'],
      tiers: ['nonprod', 'prod'],
      lifetimeDays: 7,
      acknowledgeProduction: true,
      targets: { kind: 'list', targetIds: [T_STAGING] },
    })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Agent is connected' }),
    ).toBeInTheDocument()
    expect(assign).toHaveBeenCalledWith(world.redirectTo)
    expect(screen.getByText('Only 1 chosen targets')).toBeInTheDocument()
  })

  it('drops the scopes and targets of a tier switched off and asks for at least one target', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    await openConsent(world)
    await user.click(input('input[name="where"][value="list"]'))
    const production = input(`input[name="target"][value="${T_PRODUCTION}"]`)
    expect(production.disabled).toBe(true)
    await user.click(input(`input[name="target"][value="${T_STAGING}"]`))
    await user.click(input('input[name="tier"][value="nonprod"]'))
    expect(input('input[name="scope"][value="migrations.apply:nonprod"]').checked).toBe(false)
    expect(input(`input[name="target"][value="${T_STAGING}"]`).checked).toBe(false)
    expect(screen.getByText('Choose where the application may act.')).toBeInTheDocument()
    await user.click(input('input[name="tier"][value="nonprod"]'))
    // Switching it on again restores the preselection of the tier, not the targets.
    expect(input('input[name="scope"][value="migrations.apply:nonprod"]').checked).toBe(true)
    expect(
      screen.getByText('Choose at least one target, or allow every target of the chosen kinds.'),
    ).toBeInTheDocument()
  })

  it('says that production write access needs a recent proof and retries once after it', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = consentView({
      scopes: [
        offer('targets.read'),
        offer('migrations.apply:prod', {
          write: true,
          effect: 'consequential',
          tier: 'prod',
          explicitConsent: true,
        }),
      ],
      reauth: { fresh: false, withinSeconds: 300 },
    })
    world.needsProof = true
    await openConsent(world)
    expect(screen.queryByText(/confirmation of your identity from the last 5 minutes/)).toBeNull()
    await user.click(input('input[name="tier"][value="prod"]'))
    await user.click(input('input[name="production"]'))
    await user.click(input('input[name="scope"][value="migrations.apply:prod"]'))
    expect(
      screen.getByText(/confirmation of your identity from the last 5 minutes/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Authorize Agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(dialog).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Confirm with code' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Agent is connected' }),
    ).toBeInTheDocument()
    expect(world.bodiesOf('/auth/oauth/consent')).toHaveLength(2)
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('says "Canceled. Nothing was changed." when the confirmation is canceled', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.needsProof = true
    await openConsent(world)
    await user.click(screen.getByRole('button', { name: 'Authorize Agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Canceled. Nothing was changed.')
    expect(assign).not.toHaveBeenCalled()
    expect(document.querySelector('#consent-form')).not.toBeNull()
  })

  it('shows a refusal with its code in the footer and keeps the form', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.failures.set('/auth/oauth/consent', {
      status: 403,
      code: 'SCOPE_NOT_DELEGABLE',
      message: 'A scope cannot be delegated.',
    })
    await openConsent(world)
    await user.click(screen.getByRole('button', { name: 'Authorize Agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A scope cannot be delegated. (SCOPE_NOT_DELEGABLE)',
    )
    expect(assign).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Authorize Agent' })).toBeEnabled()
  })

  it('never shows exception text of a network failure', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    await openConsent(world)
    world.failures.set('/auth/oauth/consent', {
      status: 500,
      code: 'lowercase is no code',
      message: 'TypeError: secret stack trace',
    })
    await user.click(screen.getByRole('button', { name: 'Authorize Agent' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('stack trace')
  })

  it('cancels with a denial that carries no scopes, tiers, targets or acknowledgement', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.redirectTo = 'https://agent.example.test/callback?error=access_denied&state=y'
    await openConsent(world)
    await user.click(input('input[name="tier"][value="prod"]'))
    await user.click(input('input[name="production"]'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(world.bodiesOf('/auth/oauth/consent')).toHaveLength(1))
    expect(world.bodiesOf('/auth/oauth/consent')[0]).toEqual({
      request: HANDLE,
      decision: 'deny',
      scopes: [],
      tiers: [],
      lifetimeDays: 30,
    })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(assign).toHaveBeenCalledWith(world.redirectTo)
  })

  it('never opens a return address that is not http(s)', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.redirectTo = 'javascript:alert(document.cookie)'
    await openConsent(world)
    await user.click(screen.getByRole('button', { name: 'Authorize Agent' }))
    expect(
      await screen.findByText(
        'The server sent a return address this page does not open. Nothing was sent to the application.',
      ),
    ).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('the consent page: states', () => {
  it('shows a skeleton while the request is read', async () => {
    const world = new OAuthWorld()
    let release: (value?: unknown) => void = () => undefined
    world.holds.set(
      '/auth/oauth/consent/view',
      new Promise((resolve) => {
        release = resolve
      }),
    )
    mountApp(CONSENT_PATH, world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Loading the request' }),
    ).toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(document.querySelector('#consent-form')).toBeNull()
    release()
    await screen.findByRole('heading', { level: 1, name: 'Authorize Agent' })
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('ends a request the server no longer has open, with its message and code', async () => {
    const world = new OAuthWorld()
    world.failures.set('/auth/oauth/consent/view', {
      status: 400,
      code: 'AUTHORIZATION_REQUEST_INVALID',
      message:
        'The authorization request is unknown, expired, already decided or was started in another browser.',
    })
    mountApp(CONSENT_PATH, world)
    expect(
      await screen.findByRole('heading', { name: 'This request can no longer be decided' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/already decided.*\(AUTHORIZATION_REQUEST_INVALID\)/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(document.querySelector('#consent-form')).toBeNull()
  })

  it('offers to try again after a network failure, with fixed text', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.failures.set('/auth/oauth/consent/view', {
      status: 503,
      code: 'UNAVAILABLE',
      message: 'Unavailable.',
    })
    mountApp(CONSENT_PATH, world)
    expect(
      await screen.findByRole('heading', { name: 'Could not load the request' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Authorize Agent' }),
    ).toBeInTheDocument()
    expect(world.bodiesOf('/auth/oauth/consent/view')).toHaveLength(2)
  })

  it('shows only the expiry once the request expires', async () => {
    const world = new OAuthWorld()
    world.expiresInMs = 1_500
    await openConsent(world)
    expect(document.querySelector('#consent-form')).not.toBeNull()
    expect(
      await screen.findByText('This request has expired', undefined, { timeout: 5_000 }),
    ).toBeInTheDocument()
    expect(document.querySelector('#consent-form')).toBeNull()
    expect(document.getElementById('consent-client')).toBeNull()
  })

  it('leaves the expiry to the server when this clock already says it passed', async () => {
    const world = new OAuthWorld()
    world.view = consentView({ expiresAt: '2020-01-01T00:00:00.000Z' })
    await openConsent(world)
    expect(document.querySelector('#consent-form')).not.toBeNull()
    expect(screen.queryByText('This request has expired')).toBeNull()
  })
})
