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
  type Session,
  session,
  sessionList,
  TAG,
  wait,
  ZWSP,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const PATH = '/t/shop/platform/staging/connections'
const TARGET = 'shop/platform/staging'

const statement = (redacted: string) => ({ digest: null, redacted, truncated: false })

function sessions(): Session[] {
  return [
    session({
      pid: 11,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'active',
      queryAgeMs: 4_000,
      stateAgeMs: 4_000,
      statement: statement('select * from orders where id = $1'),
    }),
    session({
      pid: 12,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'idle',
      stateAgeMs: 90_000,
      queryAgeMs: 90_000,
    }),
    session({
      pid: 13,
      role: 'app_rw',
      applicationName: 'shop-worker',
      state: 'idle in transaction',
      stateAgeMs: 300_000,
      transactionAgeMs: 310_000,
      queryAgeMs: 300_000,
      statement: statement('update ORDERS set shipped = true'),
    }),
    session({
      pid: 14,
      role: 'reporting',
      applicationName: '',
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 20_000,
      stateAgeMs: 20_000,
      statement: statement('select count(*) from items'),
    }),
    session({
      pid: 15,
      role: 'reporting',
      applicationName: 'bi',
      state: 'idle',
      stateAgeMs: 10,
      queryAgeMs: 10,
    }),
  ]
}

function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.sessions = sessionList(sessions())
  w.locks = lockGraph([wait({ waitingPid: 14, blockingPids: [13] })])
  return w
}

const pids = (): number[] =>
  Array.from(document.querySelectorAll<HTMLElement>('tr[data-pid]')).map((row) =>
    Number(row.dataset['pid']),
  )

/** Waits for the list to hold exactly these processes. */
async function listed(expected: number[]): Promise<void> {
  await waitFor(() => expect(pids()).toEqual(expected))
}

const select = (label: string) => screen.findByLabelText(label) as Promise<HTMLSelectElement>

const sessionRequests = (w: DiagnosticsWorld): URLSearchParams[] =>
  w.requests
    .filter((request) => new URL(request, 'http://x').pathname.endsWith('/sessions'))
    .map((request) => new URL(request, 'http://x').searchParams)

describe('filtering by the address', () => {
  it('shows the sessions of one state from ?state= and says how many of how many', async () => {
    mountDiagnostics(`${PATH}?state=idle_in_transaction`, world())
    await listed([13])
    expect(await screen.findByText('Showing 1 of 5 sessions')).toBeInTheDocument()
    expect(await select('State')).toHaveValue('idle_in_transaction')
  })

  it('tells waiting from active, as the state chips do', async () => {
    mountDiagnostics(`${PATH}?state=waiting`, world())
    await listed([14])
    cleanup()
    mountDiagnostics(`${PATH}?state=active`, world())
    await listed([11])
  })

  it('writes a changed state into the address and reads it back', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    await user.selectOptions(await select('State'), 'idle')
    await listed([12, 15])
    expect(router.state.location.searchStr).toBe('?state=idle')
    await user.selectOptions(await select('State'), 'Any')
    await listed([11, 12, 13, 14, 15])
    expect(router.state.location.searchStr).toBe('')
  })

  it('ignores hostile and unknown parameters: nothing is filtered, nothing is echoed', async () => {
    const hostile =
      '?state=%3Cscript%3Ealert(1)%3C%2Fscript%3E&view=../../etc&sort=__proto__&layout=%3Cimg%20src%3Dx%3E&minAge=999999&role=app_rw&application=shop-api&text=orders'
    const w = world()
    mountDiagnostics(`${PATH}${hostile}`, w)
    await listed([11, 12, 13, 14, 15])
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('alert(1)')
    expect(text).not.toContain('../../etc')
    // Only the fixed lists reach the request: the target is asked for the sessions, unfiltered.
    for (const query of sessionRequests(w)) {
      expect([...query.keys()].sort()).toEqual(['limit'])
    }
  })

  it('narrows to the sessions that have run at least as long as the minimum', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    await user.selectOptions(await select('Running at least'), '1 min')
    await listed([12, 13])
    expect(router.state.location.searchStr).toBe('?minAge=60')
  })
})

describe('the blockers view', () => {
  it('shows only the root blockers and the sessions that wait, from ?view=blockers', async () => {
    mountDiagnostics(`${PATH}?view=blockers`, world())
    await listed([13, 14])
    expect(screen.getByRole('button', { name: 'Blockers only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('toggles the view in the address', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    await user.click(screen.getByRole('button', { name: 'Blockers only' }))
    await listed([13, 14])
    expect(router.state.location.searchStr).toBe('?view=blockers')
    await user.click(screen.getByRole('button', { name: 'Blockers only' }))
    await listed([11, 12, 13, 14, 15])
  })

  it('shows no list, and the failed lock read, when the view cannot be drawn without it', async () => {
    const w = world()
    w.failures.set('/locks', { status: 500, code: 'INTERNAL_ERROR', message: 'No graph today.' })
    mountDiagnostics(`${PATH}?view=blockers`, w)
    expect(await screen.findByText('The blockers view needs the lock graph.')).toBeInTheDocument()
    // The sessions section shows the failed lock read and no rows: the list is not shown unfiltered.
    await waitFor(() =>
      expect(
        screen.getAllByRole('heading', { level: 3, name: 'Could not read lock waits' }).length,
      ).toBeGreaterThan(0),
    )
    expect(pids()).toEqual([])
  })

  it('says how many processes of the lock graph are not in the list', async () => {
    const w = world()
    w.locks = lockGraph([
      wait({ waitingPid: 14, blockingPids: [13] }),
      wait({ waitingPid: 777, blockingPids: [888] }),
    ])
    mountDiagnostics(`${PATH}?view=blockers`, w)
    await listed([13, 14])
    expect(
      await screen.findByText(
        '2 processes in the lock graph are not in this list: they may have ended, or the list was cut.',
      ),
    ).toBeInTheDocument()
  })

  it('says the blockers view can miss sessions when the lock graph was cut', async () => {
    const w = world()
    w.locks = lockGraph([wait({ waitingPid: 14, blockingPids: [13] })], { truncated: true })
    mountDiagnostics(`${PATH}?view=blockers`, w)
    await listed([13, 14])
    expect(
      await screen.findByText(
        'The lock graph was cut by the server, so the blockers view can miss sessions.',
      ),
    ).toBeInTheDocument()
  })
})

describe('the role, application and text filters', () => {
  it('offers the roles and applications of the data, and filters by equality', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    const role = await select('Role')
    expect(
      within(role)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any', 'app_rw', 'reporting'])
    await user.selectOptions(role, 'reporting')
    await listed([14, 15])
    const application = await select('Application')
    expect(
      within(application)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any', 'No application name', 'bi', 'shop-api', 'shop-worker'])
    await user.selectOptions(application, 'bi')
    await listed([15])
    // The role and the application are not parameters of the address.
    expect(router.state.location.searchStr).toBe('')
  })

  it('filters the sessions without an application name by the choice "No application name"', async () => {
    const user = userEvent.setup()
    mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    await user.selectOptions(await select('Application'), 'No application name')
    await listed([14])
  })

  it('filters by the text of the shown statement, ignoring case, and never as a pattern', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    const search = await screen.findByLabelText('Search statements')
    await user.type(search, 'ORDERS')
    await listed([11, 13])
    await user.clear(search)
    await user.type(search, '.*')
    expect(await screen.findByText('No match')).toBeInTheDocument()
    await user.clear(search)
    await user.type(search, '<script>')
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(router.state.location.searchStr).toBe('')
  })

  it('says no match, apart from an empty read, and the reset brings every filter back', async () => {
    const user = userEvent.setup()
    mountDiagnostics(`${PATH}?state=idle_in_transaction`, world())
    await listed([13])
    await user.selectOptions(await select('Role'), 'reporting')
    const state = await screen.findByText('No match')
    const box = state.closest('[data-state="no-match"]') as HTMLElement
    expect(box).toHaveTextContent(
      'The read itself returned 5 sessions, so this is not an empty target.',
    )
    expect(
      screen.queryByText('The target reported no sessions other than the observer.'),
    ).toBeNull()
    await user.click(within(box).getByRole('button', { name: 'Reset filters' }))
    await listed([11, 12, 13, 14, 15])
    expect(await select('State')).toHaveValue('')
    expect(await select('Role')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull()
  })

  it('keeps the sort and the layout when the filters are reset', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(`${PATH}?state=idle&sort=longest&layout=flat`, world())
    await listed([12, 15])
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await listed([13, 12, 14, 11, 15])
    expect(router.state.location.searchStr).toBe('?sort=longest&layout=flat')
  })

  it('shows a hostile role, application and statement as marked text in the options and the rows', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessions = sessionList([
      ...sessions(),
      session({
        pid: 99,
        role: `evil${BIDI}role`,
        applicationName: `<img src=x onerror=alert(1)>${ZWSP}${TAG}`,
        state: 'active',
        queryAgeMs: 1,
        statement: statement(`select '<script>x</script>'${BIDI}`),
      }),
    ])
    mountDiagnostics(PATH, w)
    await listed([11, 12, 13, 99, 14, 15])
    const role = await select('Role')
    const labels = within(role)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
    expect(labels).toContain('evil⟨U+202E⟩role')
    for (const label of labels) expect(label).not.toContain(BIDI)
    const application = await select('Application')
    const appLabels = within(application)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
    expect(appLabels.some((label) => label.startsWith('<img src=x'))).toBe(true)
    for (const label of appLabels) {
      expect(label).not.toContain(ZWSP)
      expect(label).not.toContain(TAG)
    }
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    // Choosing it filters by equality with the real value, not by its label.
    await user.selectOptions(role, 'evil⟨U+202E⟩role')
    await listed([99])
  })

  it('never lets a name that looks like "any" stand for it', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessions = sessionList([
      ...sessions(),
      session({ pid: 98, role: '', applicationName: '', state: 'idle' }),
      session({ pid: 97, role: '__all__', applicationName: 'null', state: 'idle' }),
    ])
    mountDiagnostics(PATH, w)
    await listed([98, 97, 11, 12, 13, 14, 15])
    await user.selectOptions(await select('Role'), '__all__')
    await listed([97])
    await user.selectOptions(await select('Role'), '(empty)')
    await listed([98])
  })
})

describe('arranging the sessions', () => {
  it('orders a flat list longest first and puts the sessions without an age last', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessions = sessionList([
      ...sessions(),
      session({ pid: 16, role: 'zeta', applicationName: 'z', state: 'idle', stateAgeMs: null }),
    ])
    const { router } = mountDiagnostics(`${PATH}?layout=flat`, w)
    await listed([11, 12, 13, 14, 15, 16])
    await user.click(screen.getByRole('button', { name: 'Longest first' }))
    // 13: 300 s, 12: 90 s, 14: 20 s, 11: 4 s, 15: 10 ms, 16: unknown.
    await listed([13, 12, 14, 11, 15, 16])
    expect(router.state.location.searchStr).toBe('?sort=longest&layout=flat')
  })

  it('orders the groups by the longest session they hold', async () => {
    mountDiagnostics(`${PATH}?sort=longest`, world())
    await listed([13, 12, 11, 14, 15])
    const roles = Array.from(document.querySelectorAll('[data-role-group]')).map(
      (el) => el.querySelector('h3')?.textContent,
    )
    expect(roles).toEqual(['Role: app_rw', 'Role: reporting'])
  })

  it('switches between the grouped and the flat list, keeping the rows', async () => {
    const user = userEvent.setup()
    const { router } = mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    expect(document.querySelectorAll('[data-role-group]').length).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Flat list' }))
    await waitFor(() => expect(document.querySelector('[data-flat-list]')).not.toBeNull())
    expect(document.querySelectorAll('[data-role-group]').length).toBe(0)
    expect(router.state.location.searchStr).toBe('?layout=flat')
    const table = screen.getByRole('table', { name: 'All shown sessions in one list' })
    expect(within(table).getByRole('columnheader', { name: 'Role' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Application' })).toBeInTheDocument()
    expect(pids()).toEqual([11, 12, 13, 14, 15])
    await user.click(screen.getByRole('button', { name: 'Grouped' }))
    await waitFor(() => expect(document.querySelector('[data-flat-list]')).toBeNull())
    expect(router.state.location.searchStr).toBe('')
  })
})

describe('a sessions read the target cut', () => {
  function cutWorld(): DiagnosticsWorld {
    const w = world()
    w.sessions = sessionList(sessions().slice(0, 3), { truncated: true, cap: 500 })
    w.sessionsFor = (query) => {
      const state = query.get('state')
      const application = query.get('application')
      const minAge = query.get('minAgeSeconds')
      return sessionList(
        sessions().filter(
          (s) =>
            (state === null || s.state === state) &&
            (application === null || s.applicationName === application) &&
            (minAge === null || (s.queryAgeMs ?? 0) >= Number(minAge) * 1_000),
        ),
      )
    }
    return w
  }

  it('asks the target for the state instead of filtering the sample, and says so', async () => {
    const w = cutWorld()
    mountDiagnostics(`${PATH}?state=idle`, w)
    await listed([12, 15])
    const asked = sessionRequests(w).filter((query) => query.has('state'))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked[0]?.get('state')).toBe('idle')
    expect(asked[0]?.get('limit')).toBe('500')
    expect(
      await screen.findByText(
        'The target has more than 500 sessions, so it applied the state, application and age filters itself. The list below is its answer.',
      ),
    ).toBeInTheDocument()
    // Session 15 is not in the cut sample: it is there only because the target was asked.
    expect(w.sessions?.sessions.some((s) => s.pid === 15)).toBe(false)
  })

  it('sends the application and the minimum age as the target takes them, and not the role', async () => {
    const user = userEvent.setup()
    const w = cutWorld()
    mountDiagnostics(`${PATH}?minAge=10`, w)
    await listed([12, 13, 14])
    await user.selectOptions(await select('Application'), 'shop-api')
    await listed([12])
    const asked = sessionRequests(w).filter((query) => query.has('application'))
    expect(asked.length).toBeGreaterThan(0)
    const last = asked[asked.length - 1]
    expect(last?.get('application')).toBe('shop-api')
    expect(last?.get('minAgeSeconds')).toBe('10')
    await user.selectOptions(await select('Role'), 'app_rw')
    for (const query of sessionRequests(w)) expect(query.has('role')).toBe(false)
  })

  it('asks for active sessions when "waiting" is chosen, refines them here and claims no cut', async () => {
    const w = cutWorld()
    mountDiagnostics(`${PATH}?state=waiting`, w)
    await listed([14])
    const asked = sessionRequests(w).filter((query) => query.has('state'))
    expect(asked[0]?.get('state')).toBe('active')
    // The target's answer was complete, so refining it here is exact and nothing is said to be cut.
    expect(screen.queryByText(/cannot see the rest/)).toBeNull()
  })

  it('says a role or a text filter ran over a cut list and cannot see the rest', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessions = sessionList(sessions(), { truncated: true, cap: 500 })
    mountDiagnostics(PATH, w)
    await listed([11, 12, 13, 14, 15])
    await user.selectOptions(await select('Role'), 'app_rw')
    await listed([11, 12, 13])
    expect(
      await screen.findByText(
        'The list is cut at 500 sessions. These filters ran over the sessions returned and cannot see the rest: role.',
      ),
    ).toBeInTheDocument()
    await user.type(await screen.findByLabelText('Search statements'), 'orders')
    expect(await screen.findByText(/cannot see the rest: role, text search\./)).toBeInTheDocument()
    // No filter of the target was involved: the target was asked for the sessions only once per poll.
    for (const query of sessionRequests(w)) expect(query.has('state')).toBe(false)
  })

  it('does not ask the target again when the read was not cut', async () => {
    const user = userEvent.setup()
    const w = world()
    w.sessionsFor = () => {
      throw new Error('the target must not be asked with a filter')
    }
    mountDiagnostics(PATH, w)
    await listed([11, 12, 13, 14, 15])
    await user.selectOptions(await select('State'), 'idle')
    await listed([12, 15])
    for (const query of sessionRequests(w)) expect(query.has('state')).toBe(false)
  })

  it('says no match, not an idle target, when the target found nothing for the filters', async () => {
    const w = cutWorld()
    w.sessionsFor = () => sessionList([])
    mountDiagnostics(`${PATH}?state=idle`, w)
    const state = await screen.findByText('No match')
    expect(state.closest('[data-state="no-match"]')).toHaveTextContent(
      'The target found no session that matches these filters. It has more than 500 sessions, so this is not an empty target.',
    )
    expect(
      screen.queryByText('The target reported no sessions other than the observer.'),
    ).toBeNull()
  })

  it('shows a failed filtered read as failed, never as the sample or as none', async () => {
    const w = cutWorld()
    w.failures.set('state=idle', {
      status: 503,
      code: 'TARGET_UNAVAILABLE',
      message: 'The filtered read timed out.',
    })
    mountDiagnostics(`${PATH}?state=idle`, w)
    expect(
      await screen.findByRole('region', { name: 'Cannot tell what the target is doing' }),
    ).toHaveTextContent('The filtered read timed out. (TARGET_UNAVAILABLE)')
    expect(pids()).toEqual([])
  })

  it('says where the role and application options come from when the list was cut', async () => {
    mountDiagnostics(PATH, cutWorld())
    expect(
      await screen.findByText('The role and application options come from the first 500 sessions.'),
    ).toBeInTheDocument()
  })
})

describe('accessibility of the filters', () => {
  it('has no axe violations with the filter bar, a flat list and the blockers view', async () => {
    mountDiagnostics(`${PATH}?layout=flat&sort=longest&view=blockers`, world())
    await listed([13, 14])
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations in the no-match state', async () => {
    const user = userEvent.setup()
    mountDiagnostics(PATH, world())
    await listed([11, 12, 13, 14, 15])
    await user.type(await screen.findByLabelText('Search statements'), 'nothing like this')
    await screen.findByText('No match')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
