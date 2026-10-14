import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessKeys } from '../../src/features/access/keys.ts'
import { accountKeys } from '../../src/features/account/keys.ts'
import { en } from '../../src/lib/i18n/en.ts'
import {
  World as AccessWorld,
  mountApp as mountAccess,
  oauthClient,
  serviceAccount,
} from '../access/support.tsx'
import {
  FakeServer,
  grant,
  json,
  meOf,
  mountApp,
  passkey,
  problem,
  webSession,
} from '../account/support.tsx'

/**
 * Read states of the administration and account lists that their own test files do not name
 * (the registry in `registry.ts` maps the access and account components here as well). A stale
 * read is made the way it happens: the list was read, then the next read fails.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BOOM = { status: 500, code: 'INTERNAL', message: 'The server failed.' }

describe('the access lists', () => {
  it('shows a failed service account read as failed, never as an empty list', async () => {
    const world = new AccessWorld()
    world.failures.set('GET /api/v1/service-accounts', BOOM)
    mountAccess('/access/service-accounts', world)
    expect(await screen.findByText(/Could not read Service account list/)).toBeInTheDocument()
    expect(screen.queryByText(en['access.services.empty.title'])).toBeNull()
  })

  it('says a partial service account list is partial and never empty', async () => {
    const world = new AccessWorld()
    world.nextCursor = 'more'
    mountAccess('/access/service-accounts', world)
    expect(await screen.findByText(/More service accounts exist/)).toBeInTheDocument()
    expect(screen.queryByText(en['access.services.empty.title'])).toBeNull()
  })

  it('shows an old OAuth client list as stale with its age and a refresh', async () => {
    const world = new AccessWorld()
    world.clients = [oauthClient({ name: 'Agent' })]
    const { queryClient } = mountAccess('/access/oauth-clients', world)
    expect(await screen.findByText('Agent')).toBeInTheDocument()
    world.failures.set('GET /api/v1/oauth-clients', BOOM)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: accessKeys.oauthClients })
    })
    await waitFor(() =>
      expect(screen.getByText('Showing an earlier read of OAuth client list')).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByText('Agent')).toBeInTheDocument()
  })

  it('shows an old service account list as stale with its age and a refresh', async () => {
    const world = new AccessWorld()
    world.accounts = [serviceAccount({ displayName: 'Deploy bot' })]
    const { queryClient } = mountAccess('/access/service-accounts', world)
    expect(await screen.findByText('Deploy bot')).toBeInTheDocument()
    world.failures.set('GET /api/v1/service-accounts', BOOM)
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: accessKeys.serviceAccounts })
    })
    await waitFor(() =>
      expect(
        screen.getByText('Showing an earlier read of Service account list'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByText('Deploy bot')).toBeInTheDocument()
  })
})

describe('the account area', () => {
  it('shows an old read of factors, sessions and applications as stale, with a refresh', async () => {
    const fake = new FakeServer()
      .on('GET', '/api/v1/me', () => json(200, meOf()))
      .on('GET', '/api/v1/me/factors', () => json(200, { items: [passkey(1, 'Laptop')] }))
      .on('GET', '/api/v1/me/sessions', () => json(200, { items: [webSession(1)] }))
      .on('GET', '/api/v1/me/grants', () => json(200, { items: [grant(1, { name: 'Agent' })] }))
    async function staleAt(path: string, list: string, keys: readonly (readonly unknown[])[]) {
      const { queryClient } = mountApp(path, fake)
      await waitFor(() => expect(document.querySelector(list)).not.toBeNull())
      for (const read of ['factors', 'sessions', 'grants']) {
        fake.on('GET', `/api/v1/me/${read}`, () => problem(500, 'INTERNAL', 'The server failed.'))
      }
      await act(async () => {
        await Promise.all(keys.map((queryKey) => queryClient.refetchQueries({ queryKey })))
      })
      await waitFor(() =>
        expect(document.querySelectorAll('[data-state="stale"]').length).toBe(keys.length),
      )
      for (const banner of document.querySelectorAll<HTMLElement>('[data-state="stale"]')) {
        expect(banner.textContent).toContain('Showing an earlier read of')
        expect(banner.textContent).toMatch(/Observed/)
        expect(within(banner).getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
      }
      cleanup()
    }
    await staleAt('/account/security', '#passkey-list', [accountKeys.factors, accountKeys.sessions])
    fake
      .on('GET', '/api/v1/me/factors', () => json(200, { items: [passkey(1, 'Laptop')] }))
      .on('GET', '/api/v1/me/sessions', () => json(200, { items: [webSession(1)] }))
      .on('GET', '/api/v1/me/grants', () => json(200, { items: [grant(1, { name: 'Agent' })] }))
    await staleAt('/account/applications', '#grant-list', [accountKeys.grants])
  })
})
