import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  DiagnosticsWorld,
  lockGraph,
  mountDiagnostics,
  project,
  session,
  sessionList,
  TAG,
  wait,
  ZWSP,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/locks'
const TARGET = 'shop/platform/staging'

const statement = (redacted: string) => ({ digest: null, redacted, truncated: false })

/** 101 holds a lock idle in a transaction; 202 waits for it and holds up 303. */
function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.locks = lockGraph([
    wait({ waitingPid: 202, blockingPids: [101] }),
    wait({ waitingPid: 303, blockingPids: [202] }),
  ])
  w.sessions = sessionList([
    session({
      pid: 101,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'idle in transaction',
      stateAgeMs: 720_000,
      transactionAgeMs: 900_000,
      backendStart: '2026-10-13T06:00:00.000Z',
      statement: statement('update orders set shipped = true where id = $1'),
    }),
    session({
      pid: 202,
      role: 'reporting',
      applicationName: 'bi',
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 95_000,
      statement: statement('select count(*) from orders'),
    }),
    session({ pid: 303, role: 'reporting', applicationName: 'bi', state: 'active', queryAgeMs: 5 }),
  ])
  return w
}

const tree = () => screen.findByRole('list', { name: 'Who blocks whom' })
const item = (list: HTMLElement, pid: number) =>
  list.querySelector(`li[data-pid="${pid}"]`) as HTMLElement

describe('the blockers with their sessions', () => {
  it('shows, for a blocker, its state and for how long, its role and application and its statement', async () => {
    mountDiagnostics(PATH, world())
    const list = await tree()
    const root = item(list, 101)
    const details = await waitFor(() => {
      const el = root.querySelector(':scope > [data-slot="blocker-details"]')
      if (el === null) throw new Error('no details yet')
      return el as HTMLElement
    })
    expect(details.querySelector('[data-slot="blocker-state"]')).toHaveTextContent(
      'Idle in transaction for 12 min 0 s',
    )
    expect(details).toHaveTextContent('Role: app_rw')
    expect(details).toHaveTextContent('Application: shop-api')
    expect(details).toHaveTextContent(/Session started .* ago/)
    expect(details).toHaveTextContent('update orders set shipped = true where id = $1')
  })

  it('shows the details of a blocker in the middle of the tree and none for a session that only waits', async () => {
    mountDiagnostics(PATH, world())
    const list = await tree()
    const middle = item(list, 202)
    await waitFor(() =>
      expect(middle.querySelector(':scope > [data-slot="blocker-details"]')).not.toBeNull(),
    )
    expect(middle.querySelector(':scope > [data-slot="blocker-details"]')).toHaveTextContent(
      'Query waiting for 1 min 35 s',
    )
    expect(middle.querySelector(':scope > [data-slot="blocker-details"]')).toHaveTextContent(
      'select count(*) from orders',
    )
    // 303 holds nothing up: no details for it.
    expect(item(list, 303).querySelector('[data-slot="blocker-details"]')).toBeNull()
  })

  it('says the details are as of the sessions read, matched by process number, and how far apart the reads are', async () => {
    const w = world()
    const graphAt = '2026-10-20T10:00:00.000Z'
    const sessionsAt = new Date(Date.parse(graphAt) + 7_000).toISOString()
    w.locks = lockGraph(w.locks?.waits ?? [], { observedAt: graphAt })
    w.sessions = sessionList(w.sessions?.sessions ?? [], { observedAt: sessionsAt })
    mountDiagnostics(PATH, w)
    await tree()
    const note = await waitFor(() => {
      const el = document.querySelector('[data-slot="join"]')
      if (el === null) throw new Error('no note')
      return el as HTMLElement
    })
    expect(note).toHaveTextContent('Session details are as of the sessions read')
    expect(note).toHaveTextContent('They are matched by process number. A number can be reused')
    expect(note).toHaveTextContent('The sessions were read 7 s after the lock graph.')
    cleanup()
    const earlier = world()
    earlier.locks = lockGraph(earlier.locks?.waits ?? [], { observedAt: sessionsAt })
    earlier.sessions = sessionList(earlier.sessions?.sessions ?? [], { observedAt: graphAt })
    mountDiagnostics(PATH, earlier)
    await tree()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="join"]')).toHaveTextContent(
        'The sessions were read 7 s before the lock graph.',
      ),
    )
  })

  it('says a blocker is not in the sessions read instead of filling it in', async () => {
    const w = world()
    w.sessions = sessionList(w.sessions?.sessions.filter((s) => s.pid !== 101) ?? [])
    mountDiagnostics(PATH, w)
    const list = await tree()
    await waitFor(() =>
      expect(item(list, 101).querySelector('[data-slot="blocker-missing"]')).toHaveTextContent(
        'This process is not in the sessions read. It may have ended since, or the list was cut.',
      ),
    )
    expect(item(list, 101).querySelector(':scope > [data-slot="blocker-details"]')).toBeNull()
  })

  it('shows the tree from the lock graph alone, and says why, when the sessions read failed', async () => {
    const w = world()
    w.failures.set('/sessions', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'diagnostics.read is missing.',
    })
    mountDiagnostics(PATH, w)
    const list = await tree()
    const note = await waitFor(() => {
      const el = document.querySelector('[data-join="failed"]')
      if (el === null) throw new Error('no failed note')
      return el as HTMLElement
    })
    expect(note).toHaveTextContent(
      'Session details could not be read: diagnostics.read is missing. (PERMISSION_DENIED). The tree below comes from the lock graph alone.',
    )
    expect(item(list, 101)).toHaveTextContent('Process 101 holds the lock')
    expect(list.querySelector('[data-slot="blocker-details"]')).toBeNull()
    expect(list.querySelector('[data-slot="blocker-missing"]')).toBeNull()
  })

  it('says the sessions are being read while that read is out, and shows no details yet', async () => {
    const w = world()
    let release: (value: unknown) => void = () => undefined
    w.delays.set('/sessions', new Promise((resolve) => (release = resolve)))
    mountDiagnostics(PATH, w)
    const list = await tree()
    expect(document.querySelector('[data-join="loading"]')).toHaveTextContent(
      'Reading the sessions of these processes.',
    )
    expect(list.querySelector('[data-slot="blocker-details"]')).toBeNull()
    release(undefined)
    await waitFor(() => expect(list.querySelector('[data-slot="blocker-details"]')).not.toBeNull())
  })

  it('names an earlier read of the sessions as such', async () => {
    const w = world()
    w.sessions = sessionList(w.sessions?.sessions ?? [], {
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    mountDiagnostics(PATH, w)
    await tree()
    await waitFor(() =>
      expect(document.querySelector('[data-join="stale"]')).toHaveTextContent('(an earlier read)'),
    )
  })

  it('says the sessions read was cut, so a missing blocker may still run', async () => {
    const w = world()
    w.sessions = sessionList(w.sessions?.sessions ?? [], { truncated: true, cap: 500 })
    mountDiagnostics(PATH, w)
    await tree()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="join"]')).toHaveTextContent(
        'The sessions read was cut at 500; a process missing from it may still run.',
      ),
    )
  })

  it('says a blocker without a statement has none', async () => {
    const w = world()
    w.sessions = sessionList([
      session({ pid: 101, state: 'idle in transaction', stateAgeMs: 1_000, statement: null }),
    ])
    mountDiagnostics(PATH, w)
    const list = await tree()
    await waitFor(() =>
      expect(item(list, 101).querySelector('[data-slot="blocker-details"]')).toHaveTextContent(
        'No statement reported',
      ),
    )
  })

  it('names a state the page does not know by its own word, and a session without timing as such', async () => {
    const w = world()
    w.sessions = sessionList([
      session({ pid: 101, state: 'fastpath function call', stateAgeMs: null }),
      session({ pid: 202, state: 'idle', stateAgeMs: null }),
    ])
    mountDiagnostics(PATH, w)
    const list = await tree()
    await waitFor(() =>
      expect(item(list, 101).querySelector('[data-slot="blocker-state"]')).toHaveTextContent(
        'fastpath function call',
      ),
    )
    expect(item(list, 202).querySelector('[data-slot="blocker-state"]')).toHaveTextContent(
      'Idle, no timing reported',
    )
  })

  it('shows a hostile role, application and statement as marked text, bounded', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessions = sessionList([
      session({
        pid: 101,
        role: `evil${BIDI}role`,
        applicationName: `<img src=x onerror=alert(1)>${ZWSP}`,
        state: 'idle in transaction',
        stateAgeMs: 1_000,
        statement: statement(
          `select '<script>alert(1)</script>'${BIDI}${TAG}\n${'x'.repeat(5_000)}`,
        ),
      }),
    ])
    mountDiagnostics(PATH, w)
    const list = await tree()
    const details = await waitFor(() => {
      const el = item(list, 101).querySelector('[data-slot="blocker-details"]')
      if (el === null) throw new Error('no details')
      return el as HTMLElement
    })
    expect(details.textContent).toContain('⟨U+202E⟩')
    expect(details.textContent).toContain('⟨U+200B⟩')
    expect(details.textContent).not.toContain(BIDI)
    expect(details.textContent).not.toContain(ZWSP)
    expect(details.textContent).not.toContain(TAG)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    // The statement is cut, with an explicit way to see the rest.
    expect((details.textContent ?? '').length).toBeLessThan(1_500)
    await user.click(within(details).getByRole('button', { name: /Show all/ }))
    expect((details.textContent ?? '').length).toBeGreaterThan(5_000)
  })

  it('enriches the blocking tree on the connections page from the sessions it already read', async () => {
    const w = world()
    mountDiagnostics('/t/shop/platform/staging/connections', w)
    const blocking = await screen.findByRole('heading', { level: 2, name: 'Blocking' })
    const section = blocking.closest('section') as HTMLElement
    const list = await within(section).findByRole('list', { name: 'Who blocks whom' })
    await waitFor(() =>
      expect(item(list, 101).querySelector('[data-slot="blocker-state"]')).toHaveTextContent(
        'Idle in transaction for 12 min 0 s',
      ),
    )
    const sessionsReads = w.requests.filter((r) => /\/sessions(\?|$)/.test(r)).length
    expect(sessionsReads).toBe(1)
  })

  it('has no accessibility violations with the enriched tree, a failed join and a missing blocker', async () => {
    mountDiagnostics(PATH, world())
    const list = await tree()
    await waitFor(() => expect(list.querySelector('[data-slot="blocker-details"]')).not.toBeNull())
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const failed = world()
    failed.failures.set('/sessions', { status: 500, code: 'INTERNAL_ERROR' })
    mountDiagnostics(PATH, failed)
    await tree()
    await waitFor(() => expect(document.querySelector('[data-join="failed"]')).not.toBeNull())
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const gone = world()
    gone.sessions = sessionList([])
    mountDiagnostics(PATH, gone)
    await tree()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="blocker-missing"]')).not.toBeNull(),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
