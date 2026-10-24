import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  DiagnosticsWorld,
  lockGraph,
  mountDiagnostics,
  project,
  wait,
  ZWSP,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/locks'
const TARGET = 'shop/platform/staging'

function world(waits = [wait()]): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.locks = lockGraph(waits)
  return w
}

describe('the lock graph', () => {
  it('shows who blocks whom as a tree and as a table, with mode, relation and wait time', async () => {
    const w = world([
      wait({
        waitingPid: 202,
        blockingPids: [101],
        waitingSince: new Date(Date.now() - 12_000).toISOString(),
      }),
      wait({
        waitingPid: 303,
        blockingPids: [202],
        lockMode: 'AccessExclusiveLock',
        relation: 'public.items',
        waitingSince: new Date(Date.now() - 125_000).toISOString(),
      }),
    ])
    mountDiagnostics(PATH, w)
    const tree = await screen.findByRole('list', { name: 'Who blocks whom' })
    const root = tree.querySelector(':scope > li[data-pid="101"]') as HTMLElement
    expect(root).toHaveTextContent('Process 101 holds the lock')
    const second = root.querySelector('li[data-pid="202"]') as HTMLElement
    expect(second).toHaveTextContent('Process 202 has waited 1')
    expect(second).toHaveTextContent('RowExclusiveLock')
    const third = second.querySelector('li[data-pid="303"]') as HTMLElement
    expect(third).toHaveTextContent('AccessExclusiveLock')
    expect(third).toHaveTextContent('public.items')
    expect(third).toHaveTextContent(/2 min \d+ s/)
    const table = screen.getByRole('table', {
      name: 'Sessions waiting for a lock, with the sessions that block them',
    })
    const row = within(table).getByText('AccessExclusiveLock').closest('tr') as HTMLElement
    expect(row).toHaveTextContent('303')
    expect(row).toHaveTextContent('202')
    expect(row).toHaveTextContent(/2 min \d+ s/)
  })

  it('shows the source and age of the read', async () => {
    mountDiagnostics(PATH, world())
    await screen.findByRole('list', { name: 'Who blocks whom' })
    // The lock graph's own line, and the page's control, which names the oldest read.
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/^Observed/).length).toBeGreaterThanOrEqual(2)
  })

  it('names a process blocked by several others once, and says it', async () => {
    mountDiagnostics(
      PATH,
      world([
        wait({ waitingPid: 303, blockingPids: [101, 202] }),
        wait({ waitingPid: 404, blockingPids: [101] }),
      ]),
    )
    const tree = await screen.findByRole('list', { name: 'Who blocks whom' })
    expect(tree.querySelectorAll('li[data-pid="303"]')).toHaveLength(1)
    expect(tree.querySelector('li[data-pid="303"]')).toHaveTextContent(
      'Also blocked by process 202',
    )
  })

  it('does not hide a cycle of waits', async () => {
    mountDiagnostics(
      PATH,
      world([
        wait({ waitingPid: 1, blockingPids: [2] }),
        wait({ waitingPid: 2, blockingPids: [1] }),
      ]),
    )
    await screen.findByRole('table', { name: /Sessions waiting for a lock/ })
    const cycle = document.querySelector('[data-lock-cycle]') as HTMLElement
    expect(cycle).toHaveTextContent('These sessions wait for each other')
    expect(cycle.querySelectorAll('li[data-pid]').length).toBe(2)
  })

  it('renders a hostile relation and lock mode as marked text', async () => {
    mountDiagnostics(
      PATH,
      world([
        wait({ relation: `public.<script>x</script>${BIDI}${ZWSP}`, lockMode: `Row${BIDI}Lock` }),
      ]),
    )
    await screen.findByRole('table', { name: /Sessions waiting for a lock/ })
    expect(document.querySelector('script')).toBeNull()
    const main = screen.getByRole('main')
    expect(main.textContent).toContain('⟨U+202E⟩')
    expect(main.textContent).toContain('⟨U+200B⟩')
    expect(main.textContent).not.toContain(BIDI)
    expect(main.textContent).not.toContain(ZWSP)
  })

  it('says no session waits only after a successful read', async () => {
    mountDiagnostics(PATH, world([]))
    expect(
      await screen.findByText('No session waits for a lock on the target.'),
    ).toBeInTheDocument()
  })

  it('is loading while the read is out', async () => {
    const w = world()
    let release: (value: unknown) => void = () => undefined
    w.delays.set('/locks', new Promise((resolve) => (release = resolve)))
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('Loading lock waits')).toBeInTheDocument()
    expect(screen.queryByText('No session waits for a lock on the target.')).toBeNull()
    release(undefined)
    expect(await screen.findByRole('list', { name: 'Who blocks whom' })).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as no locks', async () => {
    const w = world()
    w.failures.set('/locks', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'diagnostics.read is missing.',
    })
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Could not read lock waits' }),
    ).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no lock waits.')).toBeInTheDocument()
    expect(screen.queryByText('No session waits for a lock on the target.')).toBeNull()
  })

  it('cannot tell when the target could not be read live', async () => {
    const w = world()
    w.failures.set('/locks', { status: 502, code: 'TARGET_TLS_FAILED', message: 'TLS failed.' })
    mountDiagnostics(PATH, w)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell what the target is doing',
    })
    expect(state).toHaveTextContent('TLS failed. (TARGET_TLS_FAILED)')
    expect(screen.queryByText('No session waits for a lock on the target.')).toBeNull()
  })

  it('is stale with its age when the graph is old', async () => {
    const w = world()
    w.locks = lockGraph([wait()], { observedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('Showing an earlier read of lock waits')).toBeInTheDocument()
  })

  it('is partial when the server cut the graph', async () => {
    const w = world()
    w.locks = lockGraph([wait()], { truncated: true })
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('Showing part of lock waits')).toBeInTheDocument()
    expect(
      screen.getByText('Lock waits the server cut; the tree is incomplete'),
    ).toBeInTheDocument()
  })

  it('shows the production cue on a production target and none elsewhere', async () => {
    const w = world()
    w.sample('shop/platform/production')
    mountDiagnostics('/t/shop/platform/production/locks', w)
    await screen.findByRole('list', { name: 'Who blocks whom' })
    const cue = document.querySelector('[data-slot="page-header-production-cue"]') as HTMLElement
    expect(within(cue).getByText('Production')).toBeInTheDocument()
  })

  it('shows the unreachable and the cannot-tell state instead of the graph, and reads no locks', async () => {
    const w = world()
    w.sample(TARGET, { state: 'unreachable' })
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByRole('region', { name: 'The target is unreachable' }),
    ).toBeInTheDocument()
    expect(w.requests.some((r) => r.endsWith('/locks'))).toBe(false)
    cleanup()
    const unknown = world()
    unknown.sample(TARGET, { state: 'unknown', unknownBecause: 'sampler_lagging' })
    mountDiagnostics(PATH, unknown)
    expect(
      await screen.findByRole('region', { name: 'Cannot tell whether the target is reachable' }),
    ).toBeInTheDocument()
    expect(unknown.requests.some((r) => r.endsWith('/locks'))).toBe(false)
  })

  it('has no axe violations with a graph, a cycle, an empty graph and a failed read', async () => {
    mountDiagnostics(
      PATH,
      world([
        wait(),
        wait({ waitingPid: 1, blockingPids: [2] }),
        wait({ waitingPid: 2, blockingPids: [1] }),
      ]),
    )
    await screen.findByRole('table', { name: /Sessions waiting for a lock/ })
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    mountDiagnostics(PATH, world([]))
    await screen.findByText('No session waits for a lock on the target.')
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const failed = world()
    failed.failures.set('/locks', { status: 500, code: 'INTERNAL_ERROR' })
    mountDiagnostics(PATH, failed)
    await screen.findByRole('heading', { level: 3, name: 'Could not read lock waits' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
