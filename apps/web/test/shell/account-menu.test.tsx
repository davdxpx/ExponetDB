import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { FakeServer, ids, json, meOf, mountApp, problem } from '../account/support.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

const SHA = `sha256:${'b'.repeat(64)}`
const AVATAR_URL = `/api/v1/identities/${ids.identity}/avatar?v=${SHA}`

function signedIn(over: Record<string, unknown> = {}): FakeServer {
  return new FakeServer()
    .signedIn({ ...meOf(), ...over })
    .answer('GET', '/api/v1/me/factors', 200, { items: [] })
    .answer('GET', '/api/v1/me/sessions', 200, { items: [] })
    .answer('GET', '/api/v1/me/grants', 200, { items: [] })
}

async function trigger(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: 'Account' })
}

describe('the account menu of the header', () => {
  it('is an avatar button named "Account", with initials from the display name', async () => {
    mountApp('/', signedIn({ displayName: 'Grace Hopper' }))
    const button = await trigger()
    expect(button.textContent).toBe('GH')
    expect(button.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Theme' })).toBeNull()
  })

  it('uses the e-mail for the initials when there is no name', async () => {
    mountApp(
      '/',
      signedIn({
        identity: { ...meOf().identity, displayName: null, email: 'owner@example.test' },
      }),
    )
    expect((await trigger()).textContent).toBe('O')
  })

  it('shows the uploaded picture from the same-origin address only, with an empty alt', async () => {
    mountApp('/', signedIn({ avatar: { url: AVATAR_URL, sha256: SHA, width: 64, height: 64 } }))
    const button = await trigger()
    const img = button.querySelector('img')
    expect(img?.getAttribute('src')).toBe(AVATAR_URL)
    expect(img?.getAttribute('alt')).toBe('')
    cleanup()
    vi.restoreAllMocks()

    mountApp(
      '/',
      signedIn({
        avatar: { url: 'https://evil.example/a.png', sha256: SHA, width: 64, height: 64 },
      }),
    )
    const other = await trigger()
    expect(other.querySelector('img')).toBeNull()
    expect(document.body.innerHTML).not.toContain('evil.example')
  })

  it('opens with the name, the e-mail, the account links, the theme switch and sign out', async () => {
    mountApp('/', signedIn({ displayName: 'Grace Hopper' }))
    const user = userEvent.setup()
    await user.click(await trigger())
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Grace Hopper')).toBeVisible()
    expect(within(menu).getByText('owner@example.test')).toBeVisible()
    for (const name of [
      en['shell.account.settings'],
      en['accountMenu.preferences'],
      en['accountMenu.security'],
      en['accountMenu.applications'],
      en['accountMenu.activity'],
    ]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeVisible()
    }
    expect(within(menu).getByRole('menuitem', { name: en['shell.signOut'] })).toHaveAttribute(
      'id',
      'sign-out',
    )
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
    expect(await axeViolations()).toEqual([])
  })

  it('switches the theme in the menu', async () => {
    mountApp('/', signedIn())
    const user = userEvent.setup()
    await user.click(await trigger())
    await user.click(await screen.findByRole('menuitemradio', { name: en['shell.theme.dark'] }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('exdb.theme')).toBe('dark')
    await user.click(await trigger())
    expect(await screen.findByRole('menuitemradio', { name: en['shell.theme.dark'] })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: en['shell.theme.light'] }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await user.click(await trigger())
    await user.click(await screen.findByRole('menuitemradio', { name: en['shell.theme.system'] }))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('works with the keyboard: open, move, go to a page, close and return focus', async () => {
    const { router } = mountApp('/', signedIn())
    const user = userEvent.setup()
    const button = await trigger()
    button.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    // The first item has the focus when the menu opens.
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: en['shell.account.settings'] }),
    )
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: en['accountMenu.preferences'] }),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(button)

    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/security'))
  })

  it('goes to the pages of the account area', async () => {
    const { router } = mountApp('/', signedIn())
    const user = userEvent.setup()
    await user.click(await trigger())
    await user.click(await screen.findByRole('menuitem', { name: en['accountMenu.activity'] }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/activity'))
  })

  it('shows a hostile display name with visible code points and nothing as markup', async () => {
    mountApp('/', signedIn({ displayName: 'Eve ‮​<img src=x onerror=alert(1)>' }))
    const user = userEvent.setup()
    await user.click(await trigger())
    const menu = await screen.findByRole('menu')
    expect(menu.textContent).toContain('⟨U+202E⟩')
    expect(menu.textContent).toContain('⟨U+200B⟩')
    expect(menu.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(menu.querySelectorAll('img')).toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })

  it('signs out through the ceremony', async () => {
    const fake = signedIn().answer('POST', '/auth/logout', 200, {})
    mountApp('/', fake)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    await user.click(await trigger())
    await user.click(await screen.findByRole('menuitem', { name: en['shell.signOut'] }))
    await waitFor(() => expect(fake.to('POST', '/auth/logout')).toHaveLength(1))
  })

  it('removes the SQL tabs kept in this browser on sign-out, and only them', async () => {
    window.localStorage.setItem(`exdb.sql.tabs.${ids.identity}.tgt_1`, '{"tabs":[],"active":0}')
    window.localStorage.setItem('exdb.sql.tabs.tgt_2', '{"tabs":[],"active":0}')
    window.localStorage.setItem('exdb.keep', 'yes')
    const fake = signedIn().answer('POST', '/auth/logout', 200, {})
    mountApp('/', fake)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    await user.click(await trigger())
    await user.click(await screen.findByRole('menuitem', { name: en['shell.signOut'] }))
    await waitFor(() => expect(fake.to('POST', '/auth/logout')).toHaveLength(1))
    await waitFor(() =>
      expect(
        Object.keys(window.localStorage).filter((k) => k.startsWith('exdb.sql.tabs.')),
      ).toEqual([]),
    )
    expect(window.localStorage.getItem('exdb.keep')).toBe('yes')
  })
})

describe('the tabs of the account area', () => {
  it('lists the tabs with the current one marked', async () => {
    mountApp('/account/preferences', signedIn())
    const nav = await screen.findByRole('navigation', { name: en['accountArea.nav'] })
    expect(within(nav).getAllByRole('link')).toHaveLength(5)
    expect(within(nav).getByRole('link', { name: en['accountMenu.preferences'] })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: en['accountArea.profile'] })).not.toHaveAttribute(
      'aria-current',
    )
    expect(within(nav).getByRole('link', { name: en['accountMenu.security'] })).toHaveAttribute(
      'href',
      '/account/security',
    )
    expect(await axeViolations()).toEqual([])
  })

  it('changes the theme, sidebar and shortcut preferences of this browser', async () => {
    mountApp('/account/preferences', signedIn())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: en['shell.theme.dark'] }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    await user.click(screen.getByRole('radio', { name: en['shell.sidebar.open'] }))
    expect(window.localStorage.getItem('exdb.sidebar.mode')).toBe('open')
    const letters = screen.getByRole('checkbox', { name: en['preferences.shortcuts.letters'] })
    await user.click(letters)
    expect(letters).not.toBeChecked()
    expect(screen.getByRole('button', { name: en['preferences.shortcuts.show'] })).toBeVisible()
    expect(await axeViolations()).toEqual([])
  })

  it('shows the own audit events, and the not-permitted state without audit.read', async () => {
    const event = {
      id: 'aev_01JZ00000000000000000000AA',
      action: 'login.succeeded',
      occurredAt: '2026-10-13T11:58:00.000Z',
      phase: 'completed',
      result: { status: 'succeeded', errorCode: null },
      client: { kind: 'web', clientId: null, grantId: null, sessionId: null },
      actor: { identityId: ids.identity, kind: 'human', label: 'owner' },
      denial: null,
      reason: null,
      refs: { jobId: null, operationId: null, planHash: null, planId: null },
    }
    const fake = signedIn().on('GET', '/api/v1/audit-events', () =>
      json(200, { items: [event], nextCursor: null }),
    )
    mountApp('/account/activity', fake)
    await waitFor(() => expect(document.querySelector('#activity-list li')).not.toBeNull())
    expect(fake.to('GET', '/api/v1/audit-events?actor=self&limit=25')).toHaveLength(1)
    expect(document.querySelector('#activity-list')?.textContent).toContain('login.succeeded')
    expect(document.querySelector('#activity-list')?.textContent).toContain('Succeeded')
    expect(await axeViolations()).toEqual([])
    cleanup()
    vi.restoreAllMocks()

    const denied = signedIn().on('GET', '/api/v1/audit-events', () =>
      problem(403, 'PERMISSION_DENIED', 'You may not read the audit.'),
    )
    mountApp('/account/activity', denied)
    expect(
      await screen.findByText(
        `You do not have access to ${en['account.activity.what'].toLowerCase()}`,
      ),
    ).toBeVisible()
    expect(document.body.textContent).toContain('audit.read')
    expect(document.querySelector('#no-activity')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('never shows an empty activity list for a failed read', async () => {
    const failing = signedIn().on('GET', '/api/v1/audit-events', () =>
      problem(500, 'INTERNAL', 'The request failed on the server.'),
    )
    mountApp('/account/activity', failing)
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        `Could not read ${en['account.activity.what'].toLowerCase()}`,
      ),
    )
    expect(document.querySelector('#no-activity')).toBeNull()
  })

  it('says so when the audit holds no event of the person', async () => {
    const fake = signedIn().answer('GET', '/api/v1/audit-events', 200, {
      items: [],
      nextCursor: null,
    })
    mountApp('/account/activity', fake)
    expect(await screen.findByText(en['account.activity.none'])).toHaveAttribute(
      'id',
      'no-activity',
    )
  })
})
