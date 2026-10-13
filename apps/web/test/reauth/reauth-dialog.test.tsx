import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReauthBridge, ReauthHost } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { CSRF_HEADER } from '../../src/lib/api/csrf.ts'
import { ApiError } from '../../src/lib/api/errors.ts'
import { withReauth } from '../../src/lib/api/reauth.ts'

afterEach(cleanup)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake server: an action that needs a fresh proof, and the TOTP proof (code 123456). */
function world() {
  let fresh = false
  let csrf = 'before'
  const log: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    const sent = ((init?.headers ?? {}) as Record<string, string>)[CSRF_HEADER]
    log.push(path)
    if (sent !== csrf) return json(401, { code: 'SESSION_EXPIRED', message: 'Sign in again.' })
    if (path === '/auth/reauth/totp') {
      const body = JSON.parse(String(init?.body)) as { code: string }
      if (body.code !== '123456') {
        return json(400, { code: 'REAUTH_FAILED', message: 'The proof was not accepted.' })
      }
      fresh = true
      csrf = 'after'
      return json(200, { reauthenticatedAt: '2026-10-13T12:00:00Z' })
    }
    if (path === '/needs-proof') {
      return fresh
        ? json(200, { done: true })
        : json(403, { code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' })
    }
    return json(200, { path })
  })
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => `__Host-exdb_csrf=${csrf}`,
    onSessionGone: vi.fn(),
  })
  return { client, log }
}

function setup() {
  const w = world()
  const bridge = createReauthBridge()
  render(<ReauthHost bridge={bridge} />)
  const action = () => w.client.send<{ done: boolean }>('POST', '/needs-proof', {})
  const run = () => withReauth(w.client, bridge.confirmIdentity, action)
  return { ...w, bridge, run }
}

describe('the re-authentication dialog', () => {
  it('opens on REAUTH_REQUIRED, takes the authenticator code and runs the action once more', async () => {
    const user = userEvent.setup()
    const { run, log } = setup()
    const result = run()
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(dialog).toHaveAttribute('data-reauth')
    await user.type(
      screen.getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm with code' }))
    await expect(result).resolves.toEqual({ done: true })
    expect(log.filter((p) => p === '/needs-proof')).toHaveLength(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the server message and clears the field when the proof is refused, and stays open', async () => {
    const user = userEvent.setup()
    const { run } = setup()
    void run().catch(() => undefined)
    const field = await screen.findByLabelText('Or enter the code from your authenticator app')
    await user.type(field, '000000')
    await user.click(screen.getByRole('button', { name: 'Confirm with code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The proof was not accepted. (REAUTH_FAILED)',
    )
    expect(field).toHaveValue('')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('cancels with "Canceled. Nothing was changed." and never runs the action again', async () => {
    const user = userEvent.setup()
    const { run, log } = setup()
    const outcome = expect(run()).rejects.toMatchObject({ code: 'REAUTH_CANCELED' })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await outcome
    expect(log.filter((p) => p === '/needs-proof')).toHaveLength(1)
  })

  it('cancels on Escape', async () => {
    const user = userEvent.setup()
    const { run } = setup()
    const outcome = expect(run()).rejects.toBeInstanceOf(ApiError)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await outcome
  })

  it('keeps every other request waiting until the confirmation is settled', async () => {
    const user = userEvent.setup()
    const { run, client, log } = setup()
    const result = run()
    await screen.findByRole('dialog')
    let otherDone = false
    const other = client.send('GET', '/other').then(() => {
      otherDone = true
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(otherDone).toBe(false)
    expect(log).not.toContain('/other')
    await user.type(
      screen.getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm with code' }))
    await result
    await other
    expect(otherDone).toBe(true)
  })

  it('offers no passkey button where the browser has no passkey support', async () => {
    const { run } = setup()
    void run().catch(() => undefined)
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Confirm with passkey' })).toBeNull()
  })

  it('settles an earlier open request as canceled if a second one arrives', async () => {
    const bridge = createReauthBridge()
    render(<ReauthHost bridge={bridge} />)
    const { client } = world()
    const first = bridge.confirmIdentity(client)
    const second = bridge.confirmIdentity(client)
    await expect(first).resolves.toBe(false)
    act(() => bridge.current()?.settle(true))
    await expect(second).resolves.toBe(true)
  })
})
