import { describe, expect, it } from 'vitest'
import {
  blockedSessionCount,
  connectionFacts,
  distinctValues,
  filterSessions,
  graphPids,
  groupSessions,
  hasServerFilter,
  localOnlyFilters,
  longestInStates,
  observedAtOf,
  oldestObservation,
  orderSessions,
  plainLabel,
  serverFilterOf,
  sessionAgeMs,
  sessionConditionFacts,
  summarizeBlockers,
} from '../../src/features/connections/model.ts'
import {
  connectionsSearch,
  MIN_AGE_SECONDS,
  searchString,
} from '../../src/features/connections/search.ts'
import { BIDI, session, TAG, wait, ZWSP } from './support.tsx'

type Condition = Parameters<typeof connectionFacts>[0]['conditions'][number]

const NOW = '2026-10-13T10:00:00.000Z'

function health(
  conditions: Condition[],
  over: Partial<Parameters<typeof connectionFacts>[0]> = {},
): Parameters<typeof connectionFacts>[0] {
  return {
    targetId: 'tgt_00000000000000000000000001',
    lifecycle: 'active',
    state: 'degraded',
    source: 'sampled',
    observedAt: NOW,
    conditions,
    unknownBecause: null,
    probes: [],
    node: null,
    backups: null,
    ...over,
  }
}

function condition(over: Partial<Condition> & { condition: string }): Condition {
  return { severity: 'warning', count: null, observedAt: NOW, ...over }
}

describe('sessionAgeMs', () => {
  it('is the query age of an active or waiting session and the time in state of every other one', () => {
    expect(sessionAgeMs(session({ state: 'active', queryAgeMs: 4_000, stateAgeMs: 9_000 }))).toBe(
      4_000,
    )
    expect(
      sessionAgeMs(
        session({
          state: 'active',
          waitEvent: { type: 'Lock', event: 'relation' },
          queryAgeMs: 7_000,
          stateAgeMs: 1,
        }),
      ),
    ).toBe(7_000)
    expect(
      sessionAgeMs(
        session({ state: 'idle in transaction', stateAgeMs: 300_000, transactionAgeMs: 900_000 }),
      ),
    ).toBe(300_000)
    expect(sessionAgeMs(session({ state: 'idle', stateAgeMs: 12 }))).toBe(12)
  })

  it('is unknown, never zero, when the server reports no age', () => {
    expect(
      sessionAgeMs(session({ state: 'active', queryAgeMs: null, stateAgeMs: 5 })),
    ).toBeUndefined()
    expect(sessionAgeMs(session({ state: 'idle', stateAgeMs: null }))).toBeUndefined()
  })
})

describe('longestInStates', () => {
  const sessions = [
    session({ pid: 1, state: 'active', queryAgeMs: 5_000 }),
    session({ pid: 2, state: 'active', queryAgeMs: 90_000 }),
    session({
      pid: 3,
      state: 'active',
      waitEvent: { type: 'Lock', event: 'x' },
      queryAgeMs: 90_000,
    }),
    session({ pid: 4, state: 'idle in transaction', stateAgeMs: 600_000 }),
    session({ pid: 5, state: 'idle in transaction (aborted)', stateAgeMs: 700_000 }),
    session({ pid: 6, state: 'idle', stateAgeMs: 9_999_999 }),
    session({ pid: 7, state: 'active', queryAgeMs: null }),
  ]

  it('finds the longest of the states, the lowest pid winning a tie, and counts them', () => {
    const active = longestInStates(sessions, ['active', 'waiting'])
    expect(active.count).toBe(4)
    expect(active.longest?.session.pid).toBe(2)
    expect(active.longest?.ageMs).toBe(90_000)
    const idle = longestInStates(sessions, ['idle_in_transaction', 'idle_in_transaction_aborted'])
    expect(idle.count).toBe(2)
    expect(idle.longest?.session.pid).toBe(5)
  })

  it('reports none and unknown apart', () => {
    expect(longestInStates([], ['active'])).toEqual({ count: 0, longest: undefined })
    const unknown = longestInStates([session({ state: 'active', queryAgeMs: null })], ['active'])
    expect(unknown.count).toBe(1)
    expect(unknown.longest).toBeUndefined()
  })
})

describe('the lock graph in numbers', () => {
  it('counts a session that waits once, however many sessions block it', () => {
    expect(
      blockedSessionCount([
        wait({ waitingPid: 2, blockingPids: [1, 9] }),
        wait({ waitingPid: 3, blockingPids: [1] }),
      ]),
    ).toBe(2)
    expect(blockedSessionCount([])).toBe(0)
  })

  it('lists every process the graph names, as a waiter or a blocker', () => {
    expect([...graphPids([wait({ waitingPid: 2, blockingPids: [1, 9] })])].sort()).toEqual([
      1, 2, 9,
    ])
  })

  it('names the root that holds up the most sessions, counting those waiting behind waiters', () => {
    const summary = summarizeBlockers([
      wait({ waitingPid: 10, blockingPids: [1] }),
      wait({ waitingPid: 11, blockingPids: [10] }),
      wait({ waitingPid: 12, blockingPids: [11] }),
      wait({ waitingPid: 20, blockingPids: [2] }),
      wait({ waitingPid: 21, blockingPids: [2] }),
    ])
    expect(summary.top).toEqual({ pid: 1, blocked: 3 })
    expect(summary.rootCount).toBe(2)
    expect(summary.hasCycle).toBe(false)
  })

  it('counts a session blocked by two roots for both', () => {
    const summary = summarizeBlockers([
      wait({ waitingPid: 10, blockingPids: [1, 2] }),
      wait({ waitingPid: 11, blockingPids: [2] }),
    ])
    // The tree shows 10 under 1 only; the count follows every edge.
    expect(summary.top).toEqual({ pid: 2, blocked: 2 })
  })

  it('breaks a tie by the lowest pid', () => {
    const summary = summarizeBlockers([
      wait({ waitingPid: 10, blockingPids: [5] }),
      wait({ waitingPid: 20, blockingPids: [3] }),
    ])
    expect(summary.top).toEqual({ pid: 3, blocked: 1 })
  })

  it('reports a cycle, and no root when everything is in it', () => {
    const only = summarizeBlockers([
      wait({ waitingPid: 1, blockingPids: [2] }),
      wait({ waitingPid: 2, blockingPids: [1] }),
    ])
    expect(only.top).toBeUndefined()
    expect(only.hasCycle).toBe(true)
    const mixed = summarizeBlockers([
      wait({ waitingPid: 1, blockingPids: [2] }),
      wait({ waitingPid: 2, blockingPids: [1] }),
      wait({ waitingPid: 30, blockingPids: [9] }),
    ])
    expect(mixed.top).toEqual({ pid: 9, blocked: 1 })
    expect(mixed.hasCycle).toBe(true)
  })

  it('has no top blocker when nothing waits', () => {
    expect(summarizeBlockers([])).toEqual({ top: undefined, rootCount: 0, hasCycle: false })
  })
})

describe('filterSessions', () => {
  const sessions = [
    session({
      pid: 1,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'active',
      queryAgeMs: 90_000,
      statement: { digest: null, redacted: 'SELECT * FROM Orders', truncated: false },
    }),
    session({
      pid: 2,
      role: 'reporting',
      applicationName: '',
      state: 'active',
      waitEvent: { type: 'Lock', event: 'relation' },
      queryAgeMs: 5_000,
    }),
    session({
      pid: 3,
      role: 'app_rw',
      applicationName: 'shop-worker',
      state: 'idle',
      stateAgeMs: 100,
      queryAgeMs: 100,
    }),
    session({
      pid: 4,
      role: 'app_rw',
      applicationName: 'shop-api',
      state: 'weird',
      queryAgeMs: null,
    }),
  ]
  const pids = (list: readonly { pid: number }[]) => list.map((s) => s.pid)
  const run = (filters: Parameters<typeof filterSessions>[1], skip = false) =>
    pids(filterSessions(sessions, filters, { observedAt: NOW, skipServerFilters: skip }))

  it('filters by state kind, telling waiting from active', () => {
    expect(run({ state: 'active' })).toEqual([1])
    expect(run({ state: 'waiting' })).toEqual([2])
    expect(run({ state: 'idle' })).toEqual([3])
    expect(run({ state: 'other' })).toEqual([4])
  })

  it('compares role and application for equality, never as a pattern', () => {
    expect(run({ role: 'app_rw' })).toEqual([1, 3, 4])
    expect(run({ role: 'app' })).toEqual([])
    expect(run({ role: '.*' })).toEqual([])
    expect(run({ application: 'shop-api' })).toEqual([1, 4])
    expect(run({ application: '' })).toEqual([2])
  })

  it('searches the shown statement, case-insensitively, as a substring only', () => {
    expect(run({ text: 'from orders' })).toEqual([1])
    expect(run({ text: '  SELECT ' })).toEqual([1])
    expect(run({ text: '.*' })).toEqual([])
    // A session without a statement never matches a search.
    expect(run({ text: 'x' })).toEqual([])
    expect(run({ text: '   ' })).toEqual([1, 2, 3, 4])
  })

  it('keeps the sessions that have run at least as long as the minimum, by query start', () => {
    expect(run({ minAgeSeconds: 60 })).toEqual([1, 4])
    expect(run({ minAgeSeconds: 10 })).toEqual([1, 4])
    // A session without a query age is measured from its backend start (2026-10-13T08:00Z).
    expect(run({ minAgeSeconds: 1_800 })).toEqual([4])
  })

  it('leaves the filters the target applied to the target', () => {
    expect(run({ application: 'nonesuch', minAgeSeconds: 9_999 }, true)).toEqual([1, 2, 3, 4])
    // The state is always refined, for "waiting" is a part of what PostgreSQL calls active.
    expect(run({ state: 'waiting', application: 'nonesuch' }, true)).toEqual([2])
  })

  it('keeps only the processes of the lock graph in the blockers view', () => {
    expect(run({ graphPids: new Set([2, 4]) })).toEqual([2, 4])
    expect(run({ graphPids: new Set() })).toEqual([])
  })
})

describe('what the target can be asked', () => {
  it('maps a state to the one PostgreSQL names, and sends "waiting" as active', () => {
    expect(serverFilterOf({ state: 'active' })).toEqual({ state: 'active' })
    expect(serverFilterOf({ state: 'waiting' })).toEqual({ state: 'active' })
    expect(serverFilterOf({ state: 'idle_in_transaction' })).toEqual({
      state: 'idle in transaction',
    })
    expect(serverFilterOf({ state: 'idle_in_transaction_aborted' })).toEqual({
      state: 'idle in transaction (aborted)',
    })
    expect(serverFilterOf({ state: 'other' })).toEqual({})
  })

  it('sends application and minimum age, not the role, not the text, not an empty application', () => {
    expect(
      serverFilterOf({
        state: 'idle',
        role: 'app_rw',
        application: 'shop-api',
        minAgeSeconds: 60,
        text: 'x',
      }),
    ).toEqual({ state: 'idle', application: 'shop-api', minAgeSeconds: 60 })
    expect(serverFilterOf({ application: '' })).toEqual({})
    expect(hasServerFilter({})).toBe(false)
    expect(hasServerFilter({ minAgeSeconds: 10 })).toBe(true)
  })

  it('names the filters only this page can apply', () => {
    expect(
      localOnlyFilters({
        state: 'waiting',
        role: 'r',
        application: '',
        text: 'x',
        graphPids: new Set([1]),
      }),
    ).toEqual(['role', 'text', 'state', 'application', 'view'])
    expect(localOnlyFilters({ state: 'active', application: 'a', minAgeSeconds: 10 })).toEqual([])
    expect(localOnlyFilters({ text: '  ' })).toEqual([])
  })
})

describe('plain labels and distinct values', () => {
  it('spells out invisible and direction characters and bounds the length', () => {
    expect(plainLabel(`ev${BIDI}il${ZWSP}${TAG}`)).toBe('ev⟨U+202E⟩il⟨U+200B⟩⟨U+E0041⟩⟨U+E0042⟩')
    expect(plainLabel('a\tb')).toBe('a b')
    expect(plainLabel('x'.repeat(200))).toBe(`${'x'.repeat(80)}…`)
    expect(plainLabel('plain')).toBe('plain')
  })

  it('lists each role or application once, sorted', () => {
    const sessions = [
      session({ pid: 1, role: 'b', applicationName: 'y' }),
      session({ pid: 2, role: 'a', applicationName: 'y' }),
      session({ pid: 3, role: 'b', applicationName: '' }),
    ]
    expect(distinctValues(sessions, 'role')).toEqual(['a', 'b'])
    expect(distinctValues(sessions, 'applicationName')).toEqual(['', 'y'])
  })
})

describe('ordering the sessions', () => {
  const sessions = [
    session({ pid: 1, role: 'a', applicationName: 'x', state: 'idle', stateAgeMs: 10 }),
    session({ pid: 2, role: 'a', applicationName: 'x', state: 'active', queryAgeMs: 5_000 }),
    session({ pid: 3, role: 'b', applicationName: 'y', state: 'idle', stateAgeMs: 60_000 }),
    session({ pid: 4, role: 'b', applicationName: 'y', state: 'idle', stateAgeMs: null }),
  ]

  it('orders a flat list longest first, a session without an age last, pid breaking ties', () => {
    expect(orderSessions(sessions, 'longest').map((s) => s.pid)).toEqual([3, 2, 1, 4])
    expect(orderSessions(sessions, 'default').map((s) => s.pid)).toEqual([1, 2, 3, 4])
  })

  it('orders the groups by the longest session they hold when asked', () => {
    const groups = groupSessions(sessions, 'longest')
    expect(groups.map((g) => g.role)).toEqual(['b', 'a'])
    expect(groups[1]?.applications[0]?.sessions.map((s) => s.pid)).toEqual([2, 1])
    // The default order is by name, as before.
    expect(groupSessions(sessions).map((g) => g.role)).toEqual(['a', 'b'])
  })
})

describe('what the health sample says about connections', () => {
  it('reads the slots from the values the server sent, and the severity it gave', () => {
    const facts = connectionFacts(
      health([
        condition({
          condition: 'connections_high',
          count: 212,
          values: { clientBackends: 212, usableSlots: 400 },
        }),
      ]),
    )
    expect(facts).toEqual({ kind: 'slots', used: 212, usable: 400, severity: 'warning' })
  })

  it('prefers the critical condition when both exist, and survives missing values', () => {
    const facts = connectionFacts(
      health([
        condition({ condition: 'connections_high', count: 300 }),
        condition({ condition: 'connections_critical', severity: 'critical', count: 390 }),
      ]),
    )
    expect(facts).toEqual({ kind: 'slots', used: 390, usable: null, severity: 'critical' })
  })

  it('does not call a sample without a connection condition healthy, nor judge what it could not read', () => {
    expect(connectionFacts(health([]))).toEqual({ kind: 'not_flagged' })
    expect(connectionFacts(health([condition({ condition: 'settings_unreadable' })]))).toEqual({
      kind: 'not_judged',
      because: 'settings_unreadable',
    })
    expect(connectionFacts(health([condition({ condition: 'activity_unreadable' })]))).toEqual({
      kind: 'not_judged',
      because: 'activity_unreadable',
    })
    expect(
      connectionFacts(health([], { state: 'unknown', unknownBecause: 'sampler_lagging' })),
    ).toEqual({ kind: 'unknown', because: 'sampler_lagging' })
  })

  it('lists the session conditions that were reported, in a fixed order, with the oldest age', () => {
    const facts = sessionConditionFacts(
      health([
        condition({ condition: 'lock_waits', count: 4 }),
        condition({
          condition: 'idle_in_transaction',
          severity: 'critical',
          count: 3,
          values: { oldestSeconds: 720, truncated: false },
        }),
        condition({ condition: 'tls_expiring' }),
      ]),
    )
    expect(facts).toEqual([
      { condition: 'idle_in_transaction', severity: 'critical', count: 3, oldestSeconds: 720 },
      { condition: 'lock_waits', severity: 'warning', count: 4, oldestSeconds: null },
    ])
    expect(sessionConditionFacts(health([]))).toEqual([])
  })
})

describe('observation times', () => {
  it('takes the oldest of the times that exist, and none when there are none', () => {
    expect(
      oldestObservation([
        undefined,
        '2026-10-13T10:00:05.000Z',
        '2026-10-13T10:00:01.000Z',
        'nope',
      ]),
    ).toBe('2026-10-13T10:00:01.000Z')
    expect(oldestObservation([undefined, undefined])).toBeUndefined()
  })

  it('has an observation time only for a read that produced one', () => {
    expect(observedAtOf({ state: 'loading' })).toBeUndefined()
    expect(observedAtOf({ state: 'failed', error: { code: 'X', message: 'm' } })).toBeUndefined()
    expect(observedAtOf({ state: 'ready', value: 1, source: 'live', observedAt: NOW })).toBe(NOW)
  })
})

describe('the search parameters of the address', () => {
  it('keeps only values from the fixed lists', () => {
    expect(
      connectionsSearch({
        state: 'idle_in_transaction',
        view: 'blockers',
        sort: 'longest',
        layout: 'flat',
        minAge: 300,
      }),
    ).toEqual({
      state: 'idle_in_transaction',
      view: 'blockers',
      sort: 'longest',
      layout: 'flat',
      minAge: 300,
    })
    expect(connectionsSearch({ minAge: '60' }).minAge).toBe(60)
    expect(MIN_AGE_SECONDS).toContain(1_800)
  })

  it('drops hostile, unknown and mistyped values instead of echoing them', () => {
    const hostile = connectionsSearch({
      state: '<script>alert(1)</script>',
      view: ['blockers'],
      sort: { toString: 'x' },
      layout: 'Flat',
      minAge: '60; drop table',
    })
    expect(hostile).toEqual({
      state: undefined,
      view: undefined,
      sort: undefined,
      layout: undefined,
      minAge: undefined,
    })
    expect(
      connectionsSearch({ state: '__proto__', minAge: 61, role: 'x', application: 'y' }),
    ).toEqual({
      state: undefined,
      view: undefined,
      sort: undefined,
      layout: undefined,
      minAge: undefined,
    })
    expect(connectionsSearch({ minAge: '060' }).minAge).toBeUndefined()
    expect(connectionsSearch({ minAge: 60.5 }).minAge).toBeUndefined()
  })

  it('writes only validated values, in a fixed order', () => {
    expect(searchString({})).toBe('')
    expect(
      searchString({
        layout: 'flat',
        minAge: 60,
        sort: 'longest',
        view: 'blockers',
        state: 'active',
      }),
    ).toBe('?state=active&view=blockers&sort=longest&layout=flat&minAge=60')
  })
})
