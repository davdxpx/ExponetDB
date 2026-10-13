import { describe, expect, it } from 'vitest'
import {
  blockingFacts,
  buildBlockingTree,
  countByState,
  formatDuration,
  formatWait,
  groupSessions,
  isLiveUnreadable,
  notAvailableReason,
  stateOf,
  waitMillis,
} from '../../src/features/connections/model.ts'
import { lockGraph, session, wait } from './support.tsx'

describe('stateOf', () => {
  it('tells the states apart and never calls an unknown state idle', () => {
    expect(stateOf(session({ state: 'active' }))).toBe('active')
    expect(stateOf(session({ state: 'idle' }))).toBe('idle')
    expect(stateOf(session({ state: 'idle in transaction' }))).toBe('idle_in_transaction')
    expect(stateOf(session({ state: 'idle in transaction (aborted)' }))).toBe(
      'idle_in_transaction_aborted',
    )
    expect(
      stateOf(session({ state: 'active', waitEvent: { type: 'Lock', event: 'relation' } })),
    ).toBe('waiting')
    // A wait for I/O is not a wait for a lock.
    expect(
      stateOf(session({ state: 'active', waitEvent: { type: 'IO', event: 'DataFileRead' } })),
    ).toBe('active')
    expect(stateOf(session({ state: 'disabled' }))).toBe('other')
    expect(stateOf(session({ state: '' }))).toBe('other')
  })

  it('counts by state in display order', () => {
    expect(
      countByState([
        session({ state: 'idle' }),
        session({ state: 'active' }),
        session({ state: 'idle' }),
      ]),
    ).toEqual([
      { kind: 'active', count: 1 },
      { kind: 'idle', count: 2 },
    ])
  })
})

describe('groupSessions', () => {
  it('groups by role, then application, in a stable order', () => {
    const groups = groupSessions([
      session({ pid: 3, role: 'b', applicationName: 'x' }),
      session({ pid: 1, role: 'a', applicationName: 'y' }),
      session({ pid: 2, role: 'a', applicationName: 'x' }),
      session({ pid: 0, role: 'a', applicationName: 'x' }),
    ])
    expect(groups.map((g) => [g.role, g.count])).toEqual([
      ['a', 3],
      ['b', 1],
    ])
    expect(
      groups[0]?.applications.map((a) => [a.application, a.sessions.map((s) => s.pid)]),
    ).toEqual([
      ['x', [0, 2]],
      ['y', [1]],
    ])
  })

  it('keeps a session without a role or application as its own group', () => {
    expect(groupSessions([session({ role: '', applicationName: '' })]).map((g) => g.role)).toEqual([
      '',
    ])
  })
})

describe('durations', () => {
  it.each([
    [0, '0 ms'],
    [850, '850 ms'],
    [4_000, '4 s'],
    [185_000, '3 min 5 s'],
    [7_500_000, '2 h 5 min'],
    [93_600_000, '1 d 2 h'],
    [-5, '0 ms'],
    [Number.NaN, '0 ms'],
  ])('formats %s as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })

  it('computes a wait from the read time, not the browser clock', () => {
    const w = wait({ waitingSince: '2026-10-13T08:00:00.000Z' })
    expect(waitMillis(w, '2026-10-13T08:00:12.000Z')).toBe(12_000)
    expect(waitMillis(wait({ waitingSince: null }), '2026-10-13T08:00:12.000Z')).toBeUndefined()
    expect(
      waitMillis(wait({ waitingSince: 'not a date' }), '2026-10-13T08:00:12.000Z'),
    ).toBeUndefined()
    expect(formatWait(undefined)).toBe('Not reported')
    expect(formatWait(12_000)).toBe('12 s')
    expect(formatWait(125_000)).toBe('2 min 5 s')
  })
})

describe('buildBlockingTree', () => {
  it('has no roots for no waits', () => {
    expect(buildBlockingTree([])).toEqual({ roots: [], cycles: [] })
  })

  it('puts a blocker at the root and its waiters below, in pid order', () => {
    const tree = buildBlockingTree([
      wait({ waitingPid: 30, blockingPids: [20] }),
      wait({ waitingPid: 20, blockingPids: [10] }),
      wait({ waitingPid: 15, blockingPids: [10] }),
    ])
    expect(tree.cycles).toEqual([])
    expect(tree.roots.map((r) => r.pid)).toEqual([10])
    expect(tree.roots[0]?.children.map((c) => c.pid)).toEqual([15, 20])
    expect(tree.roots[0]?.children[1]?.children.map((c) => c.pid)).toEqual([30])
  })

  it('shows a waiter with several blockers once and names the others', () => {
    const tree = buildBlockingTree([wait({ waitingPid: 3, blockingPids: [2, 1] })])
    expect(tree.roots.map((r) => r.pid)).toEqual([1, 2])
    const all = tree.roots.flatMap((r) => r.children)
    expect(all).toHaveLength(1)
    expect(all[0]?.alsoBlockedBy).toEqual([2])
  })

  it('returns a cycle apart instead of dropping it or looping', () => {
    const tree = buildBlockingTree([
      wait({ waitingPid: 1, blockingPids: [2] }),
      wait({ waitingPid: 2, blockingPids: [1] }),
    ])
    expect(tree.roots).toEqual([])
    expect(tree.cycles.map((c) => c.pid)).toEqual([1])
    expect(tree.cycles[0]?.children.map((c) => c.pid)).toEqual([2])
  })

  it('keeps a self-wait visible', () => {
    const tree = buildBlockingTree([wait({ waitingPid: 5, blockingPids: [5] })])
    expect(tree.cycles.map((c) => c.pid)).toEqual([5])
  })

  it('reports who blocks a process and how many it blocks', () => {
    const graph = lockGraph([
      wait({ waitingPid: 2, blockingPids: [1] }),
      wait({ waitingPid: 3, blockingPids: [1, 2] }),
    ])
    expect(blockingFacts(graph, 1)).toEqual({ blockedBy: [], blocks: 2 })
    expect(blockingFacts(graph, 3)).toEqual({ blockedBy: [1, 2], blocks: 0 })
    expect(blockingFacts(undefined, 1)).toEqual({ blockedBy: [], blocks: 0 })
  })
})

describe('error vocabulary', () => {
  it('knows the live-read failures and nothing else', () => {
    expect(isLiveUnreadable('TARGET_UNAVAILABLE')).toBe(true)
    expect(isLiveUnreadable('SAMPLE_STALE')).toBe(true)
    expect(isLiveUnreadable('PERMISSION_DENIED')).toBe(false)
    expect(isLiveUnreadable('INTERNAL_ERROR')).toBe(false)
  })

  it('reads the reason of STATEMENT_NOT_AVAILABLE and nothing it does not know', () => {
    expect(notAvailableReason({ reason: 'not_held' })).toBe('not_held')
    expect(notAvailableReason({ reason: 'digest_mismatch' })).toBe('digest_mismatch')
    expect(notAvailableReason({ reason: 'other' })).toBeUndefined()
    expect(notAvailableReason({})).toBeUndefined()
    expect(notAvailableReason(null)).toBeUndefined()
    expect(notAvailableReason('not_held')).toBeUndefined()
  })
})
