import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { mountWave9, OPERATION, PLAN, placedWorld, session, type Wave9World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/connections'

function world(): Wave9World {
  const w = placedWorld()
  w.permissions = ['connections.operate']
  w.sessions = [
    session(),
    session({ pid: 202, state: 'idle in transaction', queryStart: null }),
    session({ pid: 303, exponetdbOperationId: 'op_01M4S9000000000000000000P2' }),
  ]
  return w
}

const panel = () =>
  waitFor(() => {
    const found = document.querySelector('section[data-slot="session-actions"]')
    if (found === null) throw new Error('none')
    return found as HTMLElement
  })

function action(root: HTMLElement, name: string): HTMLElement {
  return root.querySelector(`[data-action="${name}"]`) as HTMLElement
}

describe('cancel and terminate on Connections', () => {
  it('cancels the running query bound to the process, backend start and query start', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    const root = await panel()
    expect(screen.queryByText(/not available yet/)).toBeNull()
    await user.click(
      within(action(root, 'cancel-query')).getByRole('button', { name: 'Cancel query' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel query' }))
    await waitFor(() => expect(root.querySelector(`[data-started="${OPERATION}"]`)).not.toBeNull())
    const sent = w.sent.find((s) => s.path.endsWith('/sessions/101/cancel'))
    expect(sent?.body).toEqual({
      backendStart: '2026-10-13T08:00:00.000Z',
      queryStart: '2026-10-13T08:10:00.000Z',
    })
  })

  it('plans the termination with the condition and opens the plan page', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountWave9(PATH, w)
    const root = await panel()
    await user.selectOptions(within(root).getByLabelText('Session'), '202')
    // An idle session runs no query, so there is nothing to cancel.
    expect(within(action(root, 'cancel-query')).getByRole('button')).toBeDisabled()
    expect(action(root, 'cancel-query')).toHaveTextContent('This session runs no query right now.')
    await user.click(within(action(root, 'terminate-session')).getByRole('button'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Terminate only while it is')).toHaveValue(
      'idle_in_transaction',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(w.sent.find((s) => s.path.endsWith('/sessions/202/terminate'))?.body).toEqual({
      backendStart: '2026-10-13T08:00:00.000Z',
      condition: 'idle_in_transaction',
    })
  })

  it("offers neither action for ExponetDB's own session, nor without the permission", async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    const root = await panel()
    await user.selectOptions(within(root).getByLabelText('Session'), '303')
    expect(action(root, 'terminate-session')).toHaveTextContent(
      'This session belongs to an ExponetDB operation.',
    )
    cleanup()
    const none = world()
    none.permissions = []
    mountWave9(PATH, none)
    const other = await panel()
    expect(within(action(other, 'terminate-session')).getByRole('button')).toBeDisabled()
    expect(action(other, 'terminate-session')).toHaveTextContent('(connections.operate)')
  })

  it('has no axe violations', async () => {
    mountWave9(PATH, world())
    await panel()
    expect(await axeViolations(document.body)).toEqual([])
  })
})
