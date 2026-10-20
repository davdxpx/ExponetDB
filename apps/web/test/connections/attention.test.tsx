import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { AttentionStrip } from '../../src/features/connections/attention-strip.tsx'
import {
  DiagnosticsWorld,
  lockGraph,
  mountDiagnostics,
  NOW_ISO,
  project,
  session,
  sessionList,
  wait,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/connections'
const TARGET = 'shop/platform/staging'

function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.sessions = sessionList([session()])
  w.locks = lockGraph([])
  return w
}

/**
 * An incident: process 101 sits idle in a transaction and holds up 202, which holds up 505, and
 * 606; 303 runs the longest query; 404 is idle in a short transaction.
 */
function incident(): DiagnosticsWorld {
  const w = world()
  w.sessions = sessionList([
    session({
      pid: 101,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'idle in transaction',
      stateAgeMs: 720_000,
      transactionAgeMs: 900_000,
    }),
    session({
      pid: 202,
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 180_000,
      stateAgeMs: 180_000,
    }),
    session({ pid: 303, state: 'active', queryAgeMs: 245_000, stateAgeMs: 245_000 }),
    session({ pid: 404, state: 'idle in transaction', stateAgeMs: 30_000 }),
    session({
      pid: 505,
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 60_000,
    }),
    session({
      pid: 606,
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 50_000,
    }),
  ])
  w.locks = lockGraph([
    wait({ waitingPid: 202, blockingPids: [101] }),
    wait({ waitingPid: 505, blockingPids: [202] }),
    wait({ waitingPid: 606, blockingPids: [101] }),
  ])
  return w
}

const card = (name: string) => screen.findByRole('group', { name })

describe('the strip of what needs attention', () => {
  it('computes blocked sessions, the top blocker, the longest active query and the longest idle in transaction', async () => {
    mountDiagnostics(PATH, incident())
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(within(blocked).getByText('3')).toBeInTheDocument())
    const top = await card('Top blocker')
    await waitFor(() => expect(top).toHaveTextContent('Process 101'))
    // 202 and 606 wait for 101 directly; 505 waits behind 202: three in all.
    expect(top).toHaveTextContent('Holds up 3 in all')
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveTextContent('4 min 5 s'))
    expect(query).toHaveTextContent('Process 303')
    const idle = await card('Longest idle in transaction')
    await waitFor(() => expect(idle).toHaveTextContent('12 min 0 s'))
    expect(idle).toHaveTextContent('Process 101')
  })

  it('states the source and the age of the read behind every card', async () => {
    mountDiagnostics(PATH, incident())
    for (const name of [
      'Blocked sessions',
      'Top blocker',
      'Longest active query',
      'Longest idle in transaction',
    ]) {
      const el = await card(name)
      await waitFor(() => expect(el.querySelector('[data-slot="read"]')).not.toBeNull())
      const read = el.querySelector('[data-slot="read"]') as HTMLElement
      expect(read).toHaveTextContent('Live')
      expect(read).toHaveTextContent(/Observed (just now|\d+ s ago)/)
    }
  })

  it('takes a figure from the read that holds it: the lock graph for blocking, the sessions for ages', async () => {
    const w = incident()
    w.failures.set('/sessions', { status: 500, code: 'INTERNAL_ERROR', message: 'No sessions.' })
    mountDiagnostics(PATH, w)
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(blocked).toHaveTextContent('3'))
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveAttribute('data-state', 'failed'))
  })

  it('moves to the row of a process from its card', async () => {
    const user = userEvent.setup()
    mountDiagnostics(PATH, incident())
    const top = await card('Top blocker')
    await user.click(
      await within(top).findByRole('button', { name: 'Go to the row of process 101' }),
    )
    const row = document.querySelector('tr[data-pid="101"]')
    expect(row).not.toBeNull()
    expect(document.activeElement).toBe(row)
    const query = await card('Longest active query')
    await user.click(within(query).getByRole('button', { name: 'Go to the row of process 303' }))
    expect(document.activeElement).toBe(document.querySelector('tr[data-pid="303"]'))
  })

  it('says a process is not in the list when a filter hides its row, and offers no link', async () => {
    mountDiagnostics(`${PATH}?state=active`, incident())
    const top = await card('Top blocker')
    await waitFor(() => expect(top).toHaveTextContent('Process 101'))
    expect(top).toHaveTextContent('Not in the list below')
    expect(within(top).queryByRole('button', { name: /Go to the row/ })).toBeNull()
  })

  it('counts a session blocked by two roots for both and does not hide a cycle', async () => {
    const w = incident()
    w.locks = lockGraph([
      wait({ waitingPid: 202, blockingPids: [101, 303] }),
      wait({ waitingPid: 505, blockingPids: [303] }),
      wait({ waitingPid: 1, blockingPids: [2] }),
      wait({ waitingPid: 2, blockingPids: [1] }),
    ])
    mountDiagnostics(PATH, w)
    const top = await card('Top blocker')
    await waitFor(() => expect(top).toHaveTextContent('Process 303'))
    expect(top).toHaveTextContent('Holds up 2 in all')
    expect(top).toHaveTextContent('Another group of sessions waits in a cycle.')
    cleanup()
    const only = incident()
    only.locks = lockGraph([
      wait({ waitingPid: 1, blockingPids: [2] }),
      wait({ waitingPid: 2, blockingPids: [1] }),
    ])
    mountDiagnostics(PATH, only)
    const cycle = await card('Top blocker')
    await waitFor(() => expect(cycle).toHaveTextContent('A wait cycle'))
    expect(cycle).toHaveTextContent('no process holds the others up first')
  })
})

describe('every read state of the strip', () => {
  it('is loading on the cards while their reads are out', async () => {
    const w = incident()
    let release: (value: unknown) => void = () => undefined
    w.delays.set('/locks', new Promise((resolve) => (release = resolve)))
    mountDiagnostics(PATH, w)
    const blocked = await card('Blocked sessions')
    expect(blocked).toHaveAttribute('data-state', 'loading')
    expect(blocked).not.toHaveTextContent(/^Blocked sessions0/)
    // The sessions do not wait for the lock graph.
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveTextContent('4 min 5 s'))
    release(undefined)
    await waitFor(() => expect(blocked).toHaveAttribute('data-state', 'ready'))
  })

  it('shows a failed lock read as a failed card with its code, never as zero blocked sessions', async () => {
    const w = incident()
    w.failures.set('/locks', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'diagnostics.read is missing.',
    })
    mountDiagnostics(PATH, w)
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(blocked).toHaveAttribute('data-state', 'failed'))
    expect(blocked).toHaveTextContent('Could not read this metric')
    expect(blocked).toHaveTextContent('PERMISSION_DENIED')
    expect(blocked).toHaveTextContent('This does not mean the value is zero.')
    const top = await card('Top blocker')
    await waitFor(() => expect(top).toHaveAttribute('data-state', 'failed'))
    expect(top).not.toHaveTextContent('None')
  })

  it('shows a failed sessions read as a failed card, never as no active query', async () => {
    const w = incident()
    w.failures.set('/sessions', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The sessions did not come.',
    })
    mountDiagnostics(PATH, w)
    for (const name of ['Longest active query', 'Longest idle in transaction']) {
      const el = await card(name)
      await waitFor(() => expect(el).toHaveAttribute('data-state', 'failed'))
      expect(el).not.toHaveTextContent('No active query')
      expect(el).not.toHaveTextContent('None idle in a transaction')
    }
  })

  it('shows an old read as a stale card with its age, and still the figure it had', async () => {
    const w = incident()
    w.sessions = sessionList(w.sessions?.sessions ?? [], {
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    mountDiagnostics(PATH, w)
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveAttribute('data-state', 'stale'))
    expect(query).toHaveTextContent('Stale, read')
    expect(query).toHaveTextContent('4 min 5 s')
    expect(query).toHaveTextContent(/Observed (9|10) min ago/)
  })

  it('marks a figure over a truncated sessions read as a lower bound and says what was cut', async () => {
    const w = incident()
    w.sessions = sessionList(w.sessions?.sessions ?? [], { truncated: true, cap: 500 })
    mountDiagnostics(PATH, w)
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveTextContent('At least 4 min 5 s'))
    expect(query).toHaveTextContent('The sessions read was cut at 500')
    const idle = await card('Longest idle in transaction')
    await waitFor(() => expect(idle).toHaveTextContent('At least 12 min 0 s'))
  })

  it('marks the blocked count over a truncated lock graph as a lower bound', async () => {
    const w = incident()
    w.locks = lockGraph(w.locks?.waits ?? [], { truncated: true })
    mountDiagnostics(PATH, w)
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(blocked).toHaveTextContent('At least 3'))
    expect(blocked).toHaveTextContent('The lock graph was cut; the figure is a lower bound.')
  })

  it('says none in the first 500 when a truncated read holds no such session', async () => {
    const w = world()
    w.sessions = sessionList([session({ state: 'idle' })], { truncated: true, cap: 500 })
    mountDiagnostics(PATH, w)
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveTextContent('None in the first 500'))
    expect(query).not.toHaveTextContent('No active query')
  })

  it('says none only after a successful read: no waits, no active query, no idle transaction', async () => {
    const w = world()
    w.sessions = sessionList([session({ state: 'idle' })])
    w.locks = lockGraph([])
    mountDiagnostics(PATH, w)
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(blocked).toHaveAttribute('data-state', 'ready'))
    expect(blocked).toHaveTextContent('0')
    const top = await card('Top blocker')
    await waitFor(() => expect(top).toHaveTextContent('None'))
    expect(top).toHaveTextContent('No session waits for a lock.')
    expect(await card('Longest active query')).toHaveTextContent('No active query')
    expect(await card('Longest idle in transaction')).toHaveTextContent(
      'None idle in a transaction',
    )
  })

  it('shows an age that the server did not report as not reported, never as zero', async () => {
    const w = world()
    w.sessions = sessionList([session({ pid: 9, state: 'active', queryAgeMs: null })])
    mountDiagnostics(PATH, w)
    const query = await card('Longest active query')
    await waitFor(() => expect(query).toHaveTextContent('Age not reported'))
    expect(query).not.toHaveTextContent('0 ms')
  })
})

describe('the health conditions about connections', () => {
  const at = () => new Date().toISOString()

  it('shows the slots and the severity as the server sent them', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      conditions: [
        {
          condition: 'connections_high',
          severity: 'warning',
          count: 212,
          observedAt: at(),
          values: { clientBackends: 212, usableSlots: 400 },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('212 of 400 slots'))
    const chip = slots.querySelector('[data-severity]') as HTMLElement
    expect(chip).toHaveAttribute('data-severity', 'warning')
    expect(chip).toHaveTextContent('Warning')
    expect(slots.querySelector('[data-slot="read"]')).toHaveTextContent('Sampled')
  })

  it('shows N of M connection slots used from the measured capacity, with its source and time, in no color', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'healthy',
      capacity: {
        clientBackends: 37,
        usableSlots: 97,
        source: 'sampled',
        observedAt: new Date(Date.now() - 2 * 60_000 - 20_000).toISOString(),
      },
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('37 of 97 connection slots used'))
    // The server raised no condition: nothing is colored, and the page compares no limit.
    expect(slots.querySelector('[data-severity]')).toBeNull()
    expect(slots).not.toHaveTextContent('Not flagged')
    const read = slots.querySelector('[data-slot="read"]') as HTMLElement
    expect(read).toHaveTextContent('Sampled')
    expect(read).toHaveTextContent('Observed 2 min ago')
  })

  it('takes the color of the measured capacity only from the condition the server raised', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      capacity: { clientBackends: 80, usableSlots: 97, source: 'sampled', observedAt: at() },
      conditions: [
        {
          condition: 'connections_high',
          severity: 'warning',
          count: 80,
          observedAt: at(),
          values: { clientBackends: 80, usableSlots: 97 },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('80 of 97 connection slots used'))
    const chip = slots.querySelector('[data-severity]') as HTMLElement
    expect(chip).toHaveAttribute('data-severity', 'warning')
  })

  it('shows a measured zero as zero, and names no source it has no word for', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'healthy',
      capacity: { clientBackends: 0, usableSlots: 97, source: 'quantum', observedAt: at() },
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('0 of 97 connection slots used'))
    const read = slots.querySelector('[data-slot="read"]') as HTMLElement
    expect(read.querySelector('[data-source]')).toBeNull()
    expect(read).toHaveTextContent('Observed')
  })

  it('keeps the text of the conditions when the sample carries no capacity, and never reads that as zero', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      conditions: [
        {
          condition: 'connections_high',
          severity: 'warning',
          count: 212,
          observedAt: at(),
          values: { clientBackends: 212, usableSlots: 400 },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('212 of 400 slots'))
    expect(slots).not.toHaveTextContent('connection slots used')
    cleanup()
    mountDiagnostics(PATH, incident())
    const quiet = await card('Connection slots')
    await waitFor(() => expect(quiet).toHaveTextContent('Not flagged'))
    expect(quiet).not.toHaveTextContent('0 of')
  })

  it('shows the capacity of an old health sample as a stale card with the figure it had', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'healthy',
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      capacity: {
        clientBackends: 12,
        usableSlots: 97,
        source: 'sampled',
        observedAt: new Date(Date.now() - 10 * 60_000 - 20_000).toISOString(),
      },
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveAttribute('data-state', 'stale'))
    expect(slots).toHaveTextContent('12 of 97 connection slots used')
    expect(slots.querySelector('[data-slot="read"]')).toHaveTextContent('Observed 10 min ago')
  })

  it('shows the count and the oldest age of a session condition, and only the conditions that were reported', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'unhealthy',
      conditions: [
        {
          condition: 'idle_in_transaction',
          severity: 'critical',
          count: 2,
          observedAt: at(),
          values: { oldestSeconds: 720, truncated: false },
        },
        {
          condition: 'long_running',
          severity: 'warning',
          count: 1,
          observedAt: at(),
          values: { oldestSeconds: 245, truncated: false },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const idle = await card('Idle in transaction')
    await waitFor(() => expect(idle).toHaveTextContent('Oldest 12 min 0 s'))
    expect(idle.querySelector('[data-severity]')).toHaveAttribute('data-severity', 'critical')
    expect(idle.querySelector('[data-slot="main"]')).toHaveTextContent('2')
    const long = await card('Long-running queries')
    expect(long).toHaveTextContent('Oldest 4 min 5 s')
    // No card for a condition the server did not report.
    expect(screen.queryByRole('group', { name: 'Stalled sessions' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Lock waits' })).toBeNull()
  })

  it('colors nothing that the server did not call a problem, and no number of the live reads', async () => {
    mountDiagnostics(PATH, incident())
    const blocked = await card('Blocked sessions')
    await waitFor(() => expect(blocked).toHaveTextContent('3'))
    const strip = document.querySelector('[data-section="attention-strip"]') as HTMLElement
    // The default sample has no condition: no severity chip anywhere in the strip.
    expect(strip.querySelector('[data-severity]')).toBeNull()
    expect(strip.querySelector('[class*="bg-state-"]')).toBeNull()
    const slots = await card('Connection slots')
    expect(slots).toHaveTextContent('Not flagged')
    expect(slots).toHaveTextContent('That is not a count of slots.')
  })

  it('says not judged, not fine, when the server could not read the capacity or the sessions', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      conditions: [
        { condition: 'settings_unreadable', severity: 'warning', count: null, observedAt: at() },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('Not judged'))
    expect(slots).toHaveTextContent('could not read the capacity settings')
    expect(slots).not.toHaveTextContent('Not flagged')
  })

  it('shows an old health sample as a stale card with the figure it had', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      conditions: [
        {
          condition: 'connections_critical',
          severity: 'critical',
          count: 390,
          observedAt: at(),
          values: { clientBackends: 390, usableSlots: 400 },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveAttribute('data-state', 'stale'))
    expect(slots).toHaveTextContent('390 of 400 slots')
    expect(slots).toHaveTextContent('Stale, read')
  })
})

describe('the strip as a component', () => {
  function strip(props: Partial<Parameters<typeof AttentionStrip>[0]>) {
    return (
      <TooltipProvider>
        <AttentionStrip
          sessions={{ state: 'loading' }}
          locks={{ state: 'loading' }}
          health={{ state: 'loading' }}
          listed={new Set()}
          onJump={() => undefined}
          {...props}
        />
      </TooltipProvider>
    )
  }

  it('shows one failed card for the conditions when the health read failed, never a slot count', () => {
    render(
      strip({
        health: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'No sample.' } },
      }),
    )
    const conditions = screen.getByRole('group', { name: 'Connection conditions' })
    expect(conditions).toHaveAttribute('data-state', 'failed')
    expect(conditions).toHaveTextContent('INTERNAL_ERROR')
    expect(screen.queryByRole('group', { name: 'Connection slots' })).toBeNull()
  })

  it('is loading on the cards of reads that have not answered, and shows no figure', () => {
    render(strip({}))
    for (const group of screen.getAllByRole('group')) {
      expect(group).toHaveAttribute('data-state', 'loading')
    }
    expect(screen.getAllByRole('group').length).toBe(5)
  })

  it('shows a partial sessions read as a lower bound with the cap named', () => {
    render(
      strip({
        sessions: {
          state: 'partial',
          source: 'live',
          observedAt: NOW_ISO(),
          missing: ['cut'],
          value: sessionList([session({ pid: 1, state: 'active', queryAgeMs: 61_000 })], {
            truncated: true,
            cap: 50,
          }),
        },
      }),
    )
    const query = screen.getByRole('group', { name: 'Longest active query' })
    expect(query).toHaveTextContent('At least 1 min 1 s')
    expect(query).toHaveTextContent('cut at 50')
  })

  it('has no accessibility violations in its states', async () => {
    const { container } = render(
      strip({
        sessions: {
          state: 'ready',
          source: 'live',
          observedAt: NOW_ISO(),
          value: sessionList([session({ pid: 1, state: 'active', queryAgeMs: 61_000 })]),
        },
        locks: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'No graph.' } },
        health: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'No sample.' } },
        listed: new Set([1]),
      }),
    )
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no accessibility violations on the page, with an incident and server conditions', async () => {
    const w = incident()
    w.sample(TARGET, {
      state: 'degraded',
      conditions: [
        {
          condition: 'connections_high',
          severity: 'warning',
          count: 212,
          observedAt: NOW_ISO(),
          values: { clientBackends: 212, usableSlots: 400 },
        },
        {
          condition: 'idle_in_transaction',
          severity: 'critical',
          count: 2,
          observedAt: NOW_ISO(),
          values: { oldestSeconds: 720 },
        },
      ],
    })
    mountDiagnostics(PATH, w)
    const slots = await card('Connection slots')
    await waitFor(() => expect(slots).toHaveTextContent('212 of 400 slots'))
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Blocked sessions' })).toHaveTextContent('3'),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
