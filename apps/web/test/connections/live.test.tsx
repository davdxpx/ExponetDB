import '@testing-library/jest-dom/vitest'
import { focusManager } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { RECENT_TARGETS_PREFIX } from '../../src/features/target/recent.ts'
import {
  DiagnosticsWorld,
  lockGraph,
  mountDiagnostics,
  project,
  session,
  sessionList,
  wait,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The timers are fake from the start, so the polling intervals of the page are fake too; real time
// still moves them a little (`shouldAdvanceTime`), and a test jumps ahead with `advance`.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const CONNECTIONS = '/t/shop/platform/staging/connections'
const LOCKS = '/t/shop/platform/staging/locks'
const TARGET = 'shop/platform/staging'

function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.sessions = sessionList([session({ pid: 11, state: 'active', queryAgeMs: 2_000 })])
  w.locks = lockGraph([wait({ waitingPid: 12, blockingPids: [11] })])
  return w
}

const reads = (w: DiagnosticsWorld, part: '/sessions' | '/locks' | '/health'): number =>
  w.requests.filter((request) => new URL(request, 'http://x').pathname.endsWith(part)).length

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

describe('live, pause and refresh', () => {
  it('reads the sessions and the locks every 15 seconds while live', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    const sessions = reads(w, '/sessions')
    const locks = reads(w, '/locks')
    expect(sessions).toBeGreaterThanOrEqual(1)
    await advance(15_000)
    await waitFor(() => expect(reads(w, '/sessions')).toBe(sessions + 1))
    expect(reads(w, '/locks')).toBe(locks + 1)
    await advance(15_000)
    await waitFor(() => expect(reads(w, '/sessions')).toBe(sessions + 2))
  })

  it('stops polling the sessions and the locks while paused, and says it is paused', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    const controls = screen.getByRole('group', { name: 'Updates' })
    expect(controls).toHaveAttribute('data-live', 'true')
    expect(controls).toHaveTextContent('Live: reading every 15 s while this page is visible')
    await user().click(within(controls).getByRole('button', { name: 'Pause' }))
    expect(controls).toHaveAttribute('data-live', 'false')
    expect(controls).toHaveTextContent('Paused: nothing is read until you resume or refresh')
    const sessions = reads(w, '/sessions')
    const locks = reads(w, '/locks')
    await advance(120_000)
    expect(reads(w, '/sessions')).toBe(sessions)
    expect(reads(w, '/locks')).toBe(locks)
  })

  it('reads at once when resumed and polls again from then on', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    const controls = screen.getByRole('group', { name: 'Updates' })
    await user().click(within(controls).getByRole('button', { name: 'Pause' }))
    await advance(45_000)
    const before = reads(w, '/sessions')
    await user().click(within(controls).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(reads(w, '/sessions')).toBe(before + 1))
    expect(controls).toHaveAttribute('data-live', 'true')
    await advance(15_000)
    await waitFor(() => expect(reads(w, '/sessions')).toBe(before + 2))
  })

  it('does not read when the tab is focused again while paused, though the reads have grown old', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    await user().click(
      within(screen.getByRole('group', { name: 'Updates' })).getByRole('button', { name: 'Pause' }),
    )
    // Older than the 15 seconds after which a focus would otherwise read again.
    await advance(120_000)
    const sessions = reads(w, '/sessions')
    const locks = reads(w, '/locks')
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(reads(w, '/sessions')).toBe(sessions)
    expect(reads(w, '/locks')).toBe(locks)
    focusManager.setFocused(undefined)
  })

  it('refreshes now on the button, also while paused, and stays paused', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    const controls = screen.getByRole('group', { name: 'Updates' })
    await user().click(within(controls).getByRole('button', { name: 'Pause' }))
    const sessions = reads(w, '/sessions')
    const locks = reads(w, '/locks')
    const health = reads(w, '/health')
    await user().click(within(controls).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(reads(w, '/sessions')).toBe(sessions + 1))
    expect(reads(w, '/locks')).toBe(locks + 1)
    expect(reads(w, '/health')).toBe(health + 1)
    expect(controls).toHaveAttribute('data-live', 'false')
    await advance(60_000)
    expect(reads(w, '/sessions')).toBe(sessions + 1)
  })

  it('shows how long ago the oldest read was observed', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    const controls = screen.getByRole('group', { name: 'Updates' })
    const observed = controls.querySelector('[data-slot="observed"]') as HTMLElement
    expect(observed).toHaveTextContent(/^Observed (just now|\d+ s ago)$/)
    await user().click(within(controls).getByRole('button', { name: 'Pause' }))
    await advance(30_000)
    await waitFor(() => expect(observed).toHaveTextContent(/^Observed (2|3)\d s ago$/))
  })

  it('turns a paused read stale on time instead of leaving it looking current', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    expect(screen.queryByText('Showing an earlier read of sessions')).toBeNull()
    await user().click(
      within(screen.getByRole('group', { name: 'Updates' })).getByRole('button', { name: 'Pause' }),
    )
    await advance(100_000)
    expect(await screen.findByText('Showing an earlier read of sessions')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
  })

  it('holds the pause for this visit only: nothing is stored, and the next visit is live', async () => {
    const w = world()
    mountDiagnostics(CONNECTIONS, w)
    await screen.findAllByText('shop-api')
    await user().click(
      within(screen.getByRole('group', { name: 'Updates' })).getByRole('button', { name: 'Pause' }),
    )
    // Nothing about updates is kept: the only key is the shell's list of recent targets.
    const kept = Object.keys(window.localStorage).filter(
      (key) => !key.startsWith(RECENT_TARGETS_PREFIX),
    )
    expect(kept).toEqual([])
    expect(window.sessionStorage.length).toBe(0)
    cleanup()
    mountDiagnostics(CONNECTIONS, world())
    await screen.findAllByText('shop-api')
    expect(screen.getByRole('group', { name: 'Updates' })).toHaveAttribute('data-live', 'true')
  })

  it('offers the same controls on the locks page, which reads the sessions too', async () => {
    const w = world()
    mountDiagnostics(LOCKS, w)
    await screen.findByRole('list', { name: 'Who blocks whom' })
    const controls = screen.getByRole('group', { name: 'Updates' })
    const sessions = reads(w, '/sessions')
    const locks = reads(w, '/locks')
    expect(sessions).toBeGreaterThanOrEqual(1)
    await user().click(within(controls).getByRole('button', { name: 'Pause' }))
    await advance(60_000)
    expect(reads(w, '/sessions')).toBe(sessions)
    expect(reads(w, '/locks')).toBe(locks)
    await user().click(within(controls).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(reads(w, '/locks')).toBe(locks + 1))
    expect(reads(w, '/sessions')).toBe(sessions + 1)
  })

  it('adds no cancel or terminate control', async () => {
    mountDiagnostics(CONNECTIONS, world())
    await screen.findAllByText('shop-api')
    expect(screen.queryByRole('button', { name: /terminate|cancel|kill/i })).toBeNull()
  })

  it('has no accessibility violations, live or paused', async () => {
    mountDiagnostics(CONNECTIONS, world())
    await screen.findAllByText('shop-api')
    expect(await axeViolations(document.body)).toEqual([])
    await user().click(
      within(screen.getByRole('group', { name: 'Updates' })).getByRole('button', { name: 'Pause' }),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
