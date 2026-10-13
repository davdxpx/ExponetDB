import '@testing-library/jest-dom/vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../src/lib/api/client.ts'
import { ApiProvider } from '../../src/lib/api/context.tsx'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { RequireSession, useMe } from '../../src/lib/session/guard.tsx'

afterEach(cleanup)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function Name() {
  const me = useMe() as { email?: string }
  return <p>Signed in as {me.email}</p>
}

function mount(fetchFn: (path: string) => Promise<Response>) {
  const gone = vi.fn()
  const client = new ApiClient({
    fetch: ((url: string | URL | Request) => fetchFn(String(url))) as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: gone,
  })
  const queryClient = createQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider value={{ client, confirmIdentity: async () => false }}>
        <RequireSession>
          <Name />
        </RequireSession>
      </ApiProvider>
    </QueryClientProvider>,
  )
  return { gone }
}

describe('RequireSession', () => {
  it('shows a busy skeleton while reading and the page once the person is known', async () => {
    mount(async () => json(200, { email: 'owner@example.test' }))
    expect(screen.getByLabelText('Checking your session')).toHaveAttribute('aria-busy', 'true')
    expect(await screen.findByText('Signed in as owner@example.test')).toBeInTheDocument()
  })

  it('leaves for the sign-in page when the session is gone and shows nothing of the page', async () => {
    const { gone } = mount(async () =>
      json(401, { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your session ended. Opening the sign-in page.',
    )
    expect(gone).toHaveBeenCalled()
    expect(screen.queryByText(/Signed in as/)).toBeNull()
  })

  it('says a failed read does not mean being signed out, with a retry', async () => {
    const { gone } = mount(async () => {
      throw new TypeError('Failed to fetch')
    })
    const alert = await screen.findByRole('alert', {}, { timeout: 8_000 })
    expect(alert).toHaveTextContent('Could not check your session')
    expect(alert).toHaveTextContent('This does not mean you are signed out.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(gone).not.toHaveBeenCalled()
  }, 15_000)
})
