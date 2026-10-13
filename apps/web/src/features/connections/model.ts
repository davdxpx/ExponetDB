import type { ResponseOf } from '../../lib/api/client.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * Pure read models of the Connections and Locks pages: sessions grouped by
 * role and application, the state of a session, durations, and the blocking
 * tree built from the lock graph. Every name and text in the server's answers
 * is data (C-26); nothing here interprets it. A tree is built from facts only
 * (who waits for whom), never from the text of a statement.
 */
export type SessionList = ResponseOf<'listSessions'>
export type Session = SessionList['sessions'][number]
export type LockGraph = ResponseOf<'getLockGraph'>
export type LockWait = LockGraph['waits'][number]

/** The kinds of state the page tells apart (pg_stat_activity `state`, plus waiting for a lock). */
export type StateKind =
  | 'waiting'
  | 'active'
  | 'idle'
  | 'idle_in_transaction'
  | 'idle_in_transaction_aborted'
  | 'other'

export const STATE_ORDER: readonly StateKind[] = [
  'active',
  'waiting',
  'idle_in_transaction',
  'idle_in_transaction_aborted',
  'idle',
  'other',
]

const STATE_KEYS: Readonly<Record<StateKind, MessageKey>> = {
  active: 'connections.state.active',
  waiting: 'connections.state.waiting',
  idle: 'connections.state.idle',
  idle_in_transaction: 'connections.state.idleInTransaction',
  idle_in_transaction_aborted: 'connections.state.idleInTransactionAborted',
  other: 'connections.state.other',
}

export function stateLabel(kind: StateKind): string {
  return t(STATE_KEYS[kind])
}

/**
 * The state of a session. A session that is active and waits for a heavyweight
 * lock is "waiting"; a state the page does not know is "other" and shown by its
 * own word, never as idle.
 */
export function stateOf(session: Session): StateKind {
  switch (session.state) {
    case 'active':
      return session.waitEvent?.type === 'Lock' ? 'waiting' : 'active'
    case 'idle':
      return 'idle'
    case 'idle in transaction':
      return 'idle_in_transaction'
    case 'idle in transaction (aborted)':
      return 'idle_in_transaction_aborted'
    default:
      return 'other'
  }
}

/** Counts of sessions by state, in display order, for the states that occur. */
export function countByState(
  sessions: readonly Session[],
): readonly { readonly kind: StateKind; readonly count: number }[] {
  const counts = new Map<StateKind, number>()
  for (const session of sessions) {
    const kind = stateOf(session)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return STATE_ORDER.flatMap((kind) => {
    const count = counts.get(kind)
    return count === undefined ? [] : [{ kind, count }]
  })
}

export interface ApplicationGroup {
  /** The application name as reported; empty when the session reports none. */
  readonly application: string
  readonly sessions: readonly Session[]
}

export interface RoleGroup {
  readonly role: string
  readonly applications: readonly ApplicationGroup[]
  readonly count: number
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Sessions grouped by role, then by application; groups and sessions in a stable order (name, then pid). */
export function groupSessions(sessions: readonly Session[]): readonly RoleGroup[] {
  const roles = new Map<string, Map<string, Session[]>>()
  for (const session of sessions) {
    const applications = roles.get(session.role) ?? new Map<string, Session[]>()
    const list = applications.get(session.applicationName) ?? []
    list.push(session)
    applications.set(session.applicationName, list)
    roles.set(session.role, applications)
  }
  return [...roles.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([role, applications]) => ({
      role,
      count: [...applications.values()].reduce((sum, list) => sum + list.length, 0),
      applications: [...applications.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([application, list]) => ({
          application,
          sessions: [...list].sort((a, b) => a.pid - b.pid),
        })),
    }))
}

/** A duration in milliseconds, for a person: "850 ms", "4 s", "3 min 5 s", "2 h 5 min", "1 d 2 h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** The wait of a lock wait at the time of the read, or `undefined` when the server reports no start. */
export function waitMillis(wait: LockWait, observedAt: string): number | undefined {
  if (wait.waitingSince === null) return undefined
  const since = Date.parse(wait.waitingSince)
  const observed = Date.parse(observedAt)
  if (Number.isNaN(since) || Number.isNaN(observed)) return undefined
  return Math.max(0, observed - since)
}

/** "4 s", "3 min 5 s", "2 h 5 min" for a lock wait; "Not reported" when unknown. */
export function formatWait(ms: number | undefined): string {
  if (ms === undefined) return t('locks.wait.unknown')
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return t('locks.wait.seconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('locks.wait.minutes', { minutes, seconds: seconds % 60 })
  return t('locks.wait.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/** A node of the blocking tree: a process that holds a lock (root) or waits for one. */
export interface TreeNode {
  readonly pid: number
  /** The wait of this process; `undefined` for a root, which waits for nothing. */
  readonly wait: LockWait | undefined
  readonly children: readonly TreeNode[]
  /** The other processes that block this one (it is shown once, under the first). */
  readonly alsoBlockedBy: readonly number[]
}

export interface BlockingTree {
  readonly roots: readonly TreeNode[]
  /** Waits that form a cycle: every one of them waits for another that waits. */
  readonly cycles: readonly TreeNode[]
}

/**
 * The blocking tree of a lock graph. A root is a process that blocks others
 * and waits for nothing. A waiting process is shown once, under the first
 * process that blocks it (in pid order) and names the others; a cycle of
 * waits has no root and is returned apart, never silently dropped. Pure
 * graph logic over the integers the server reports.
 */
export function buildBlockingTree(waits: readonly LockWait[]): BlockingTree {
  const waitOf = new Map<number, LockWait>()
  for (const wait of waits) waitOf.set(wait.waitingPid, wait)
  const childrenOf = new Map<number, number[]>()
  for (const wait of waits) {
    for (const blocker of wait.blockingPids) {
      const list = childrenOf.get(blocker) ?? []
      if (!list.includes(wait.waitingPid)) list.push(wait.waitingPid)
      childrenOf.set(blocker, list)
    }
  }
  const placed = new Set<number>()
  const place = (pid: number): TreeNode => {
    placed.add(pid)
    const wait = waitOf.get(pid)
    const children: TreeNode[] = []
    for (const child of [...(childrenOf.get(pid) ?? [])].sort((a, b) => a - b)) {
      if (placed.has(child)) continue
      children.push(place(child))
    }
    const blockers = wait === undefined ? [] : [...wait.blockingPids].sort((a, b) => a - b)
    return { pid, wait, children, alsoBlockedBy: blockers.slice(1) }
  }
  const rootPids = [...childrenOf.keys()].filter((pid) => !waitOf.has(pid)).sort((a, b) => a - b)
  const roots = rootPids.map(place)
  const cycles: TreeNode[] = []
  for (const wait of [...waits].sort((a, b) => a.waitingPid - b.waitingPid)) {
    if (!placed.has(wait.waitingPid)) cycles.push(place(wait.waitingPid))
  }
  return { roots, cycles }
}

/** For one process: who blocks it and how many it blocks, from the lock graph. */
export function blockingFacts(
  graph: LockGraph | undefined,
  pid: number,
): { readonly blockedBy: readonly number[]; readonly blocks: number } {
  if (graph === undefined) return { blockedBy: [], blocks: 0 }
  const blockedBy = graph.waits.find((wait) => wait.waitingPid === pid)?.blockingPids ?? []
  const blocks = graph.waits.filter((wait) => wait.blockingPids.includes(pid)).length
  return { blockedBy: [...blockedBy].sort((a, b) => a - b), blocks }
}

/** The failure codes of a live read that mean "the target could not be read now". */
const LIVE_UNREADABLE = new Set([
  'TARGET_UNAVAILABLE',
  'TARGET_CREDENTIAL_INVALID',
  'TARGET_TLS_FAILED',
  'TARGET_IDENTITY_MISMATCH',
  'CLUSTER_IDENTITY_MISMATCH',
  'SAMPLE_STALE',
])

export function isLiveUnreadable(code: string): boolean {
  return LIVE_UNREADABLE.has(code)
}

/** The reasons `STATEMENT_NOT_AVAILABLE` carries (error-model.md). */
export const NOT_AVAILABLE_REASONS = [
  'not_held',
  'target_unreachable',
  'digest_mismatch',
  'extension_missing',
] as const
export type NotAvailableReason = (typeof NOT_AVAILABLE_REASONS)[number]

/** The reason in the details of a `STATEMENT_NOT_AVAILABLE` answer, or `undefined` for one the page does not know. */
export function notAvailableReason(details: unknown): NotAvailableReason | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined
  const reason = details.reason
  return NOT_AVAILABLE_REASONS.find((known) => known === reason)
}
