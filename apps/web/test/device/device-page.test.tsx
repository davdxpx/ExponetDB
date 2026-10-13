import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { consentView, mountApp, OAuthWorld, offer } from '../consent/support.tsx'

afterEach(cleanup)

function deviceView() {
  return consentView({
    kind: 'device',
    client: {
      ...consentView().client,
      clientId: 'exponetdb-cli',
      name: 'ExponetDB CLI',
      kind: 'cli',
      registration: 'first_party',
      firstParty: true,
      redirectHost: null,
      loopbackRedirect: false,
    },
    resource: 'api',
    scopes: [
      offer('targets.read'),
      offer('migrations.plan', { write: true, effect: 'control_record' }),
    ],
    targets: [],
  })
}

function codeField(): HTMLInputElement {
  const field = document.querySelector('#device-code input[name="code"]')
  if (!(field instanceof HTMLInputElement)) throw new Error('no code field')
  return field
}

async function openDevice(world: OAuthWorld, path = '/oauth/device') {
  const mounted = mountApp(path, world)
  await screen.findByRole('heading', { level: 1, name: 'Sign in a device' })
  return mounted
}

describe('the device code page', () => {
  it('takes the typed code in eight cells and reads the request by it', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    await openDevice(world)
    const field = codeField()
    expect(field).toHaveAttribute('autocomplete', 'off')
    expect(field).toHaveAccessibleName('Code shown on the device')
    expect(screen.getByText('Signed in as')).toBeInTheDocument()
    await user.type(field, 'bcdf-ghjk')
    expect(field.value).toBe('BCDFGHJK')
    const cells = [...document.querySelectorAll('[data-cell]')].map((c) => c.textContent)
    expect(cells).toEqual(['B', 'C', 'D', 'F', 'G', 'H', 'J', 'K'])
    await user.click(
      within(document.getElementById('device-code') as HTMLElement).getByRole('button', {
        name: 'Continue',
      }),
    )
    await screen.findByRole('heading', { level: 1, name: 'Authorize ExponetDB CLI' })
    expect(world.bodiesOf('/auth/oauth/device/view')).toEqual([{ userCode: 'BCDF-GHJK' }])
    expect(screen.getByText('BCDF-GHJK')).toBeInTheDocument()
    expect(document.getElementById('device-warning')).toHaveTextContent(
      'Someone who sends you a code to enter is trying to get access in your name.',
    )
    expect(document.getElementById('consent-client')).toHaveTextContent('ExponetDB')
    expect(document.getElementById('consent-redirect')).toHaveTextContent(
      'The device that started the sign-in',
    )
    expect(document.querySelector('#consent-form')?.textContent).toContain(
      'Authorizing lets the device that shows the code sign in.',
    )
  })

  it('accepts a pasted code with a dash, as the browser suites fill it', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    await openDevice(world)
    codeField().focus()
    await user.paste('bcdf-ghjk')
    expect(codeField().value).toBe('BCDFGHJK')
  })

  it('never takes the code from the address', async () => {
    const world = new OAuthWorld()
    await openDevice(world, '/oauth/device?user_code=BCDFGHJK#code=BCDFGHJK')
    expect(codeField().value).toBe('')
    expect(world.paths().filter((p) => p.startsWith('/auth/'))).toEqual([])
  })

  it('asks for all eight letters before it sends anything', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    await openDevice(world)
    await user.type(codeField(), 'bcd')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter all eight letters of the code.',
    )
    expect(codeField()).toHaveAttribute('aria-invalid', 'true')
    expect(world.paths().filter((p) => p.startsWith('/auth/'))).toEqual([])
  })

  it('shows a refused code with the catalog message and its code', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.failures.set('/auth/oauth/device/view', {
      status: 400,
      code: 'USER_CODE_INVALID',
      message: 'The code is unknown, expired or already used.',
    })
    await openDevice(world)
    await user.type(codeField(), 'BCDFGHJK')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The code is unknown, expired or already used. (USER_CODE_INVALID)',
    )
    expect(document.querySelector('#consent-form')).toBeNull()
  })

  it('approves on the consent screen and says so in #device-done', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    await openDevice(world)
    await user.type(codeField(), 'BCDFGHJK')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Authorize ExponetDB CLI' }))
    await waitFor(() =>
      expect(document.getElementById('device-done')).toHaveTextContent(
        'Approved. Return to your device.',
      ),
    )
    expect(world.bodiesOf('/auth/oauth/device')).toEqual([
      {
        userCode: 'BCDF-GHJK',
        decision: 'allow',
        scopes: ['targets.read', 'migrations.plan'],
        tiers: ['nonprod'],
        lifetimeDays: 30,
      },
    ])
    expect(screen.getByText('Permissions granted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enter another code' }))
    expect(codeField().value).toBe('')
  })

  it('denies with Cancel and says the device gets no access', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    world.deviceStatus = 'denied'
    await openDevice(world)
    await user.type(codeField(), 'BCDFGHJK')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(document.getElementById('device-done')).toHaveTextContent(
        'Denied. The device gets no access.',
      ),
    )
    expect(world.bodiesOf('/auth/oauth/device')[0]).toMatchObject({
      userCode: 'BCDF-GHJK',
      decision: 'deny',
      scopes: [],
      tiers: [],
    })
  })

  it('confirms identity once when production reach needs a fresh proof', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    world.needsProof = true
    await openDevice(world)
    await user.type(codeField(), 'BCDFGHJK')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { level: 1, name: 'Authorize ExponetDB CLI' })
    await user.click(document.querySelector('input[name="tier"][value="prod"]') as HTMLElement)
    await user.click(document.querySelector('input[name="production"]') as HTMLElement)
    expect(
      screen.getByText(/confirmation of your identity from the last 5 minutes/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Authorize ExponetDB CLI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(dialog).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() =>
      expect(document.getElementById('device-done')).toHaveTextContent('Approved'),
    )
    expect(world.bodiesOf('/auth/oauth/device')).toHaveLength(2)
    expect(world.bodiesOf('/auth/oauth/device')[1]).toMatchObject({
      tiers: ['nonprod', 'prod'],
      acknowledgeProduction: true,
    })
  })

  it('has no accessibility violations on the code and the consent step', async () => {
    const user = userEvent.setup()
    const world = new OAuthWorld()
    world.view = deviceView()
    await openDevice(world)
    expect(await axeViolations()).toEqual([])
    await user.type(codeField(), 'BCDFGHJK')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { level: 1, name: 'Authorize ExponetDB CLI' })
    expect(await axeViolations()).toEqual([])
  })
})
