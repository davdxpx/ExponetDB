import { codePointLabel, isInvisible, type Readable, takeCodePoints } from '@exponetdb/ui-patterns'
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

export type SessionOrder = 'default' | 'longest'

/**
 * Sessions grouped by role, then by application. By default groups and
 * sessions are in a stable order (name, then pid). With `longest`, the
 * sessions of a group, the applications of a role and the roles are ordered
 * by the longest session they hold (longest first; a group whose sessions
 * report no age comes last), and the name and pid break ties.
 */
export function groupSessions(
  sessions: readonly Session[],
  order: SessionOrder = 'default',
): readonly RoleGroup[] {
  const roles = new Map<string, Map<string, Session[]>>()
  for (const session of sessions) {
    const applications = roles.get(session.role) ?? new Map<string, Session[]>()
    const list = applications.get(session.applicationName) ?? []
    list.push(session)
    applications.set(session.applicationName, list)
    roles.set(session.role, applications)
  }
  const longest = (list: readonly Session[]): number =>
    list.reduce((max, session) => Math.max(max, sessionAgeMs(session) ?? -1), -1)
  const byAge = (a: number, b: number): number => b - a
  const applicationGroups = (applications: Map<string, Session[]>): ApplicationGroup[] =>
    [...applications.entries()]
      .map(([application, list]) => ({
        application,
        sessions: order === 'longest' ? orderSessions(list, 'longest') : sortByPid(list),
      }))
      .sort((a, b) =>
        order === 'longest'
          ? byAge(longest(a.sessions), longest(b.sessions)) ||
            compareText(a.application, b.application)
          : compareText(a.application, b.application),
      )
  return [...roles.entries()]
    .map(([role, applications]) => {
      const groups = applicationGroups(applications)
      return {
        role,
        count: groups.reduce((sum, group) => sum + group.sessions.length, 0),
        applications: groups,
      }
    })
    .sort((a, b) =>
      order === 'longest'
        ? byAge(
            Math.max(...a.applications.map((g) => longest(g.sessions))),
            Math.max(...b.applications.map((g) => longest(g.sessions))),
          ) || compareText(a.role, b.role)
        : compareText(a.role, b.role),
    )
}

function sortByPid(list: readonly Session[]): Session[] {
  return [...list].sort((a, b) => a.pid - b.pid)
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

// ----- ages, ordering and the longest session -----

/**
 * How long a session has been doing what its state says, in milliseconds:
 * the running query for an active or waiting session, the time in its state
 * for every other one (for an idle-in-transaction session that is how long
 * it has been idle in the transaction, the figure the health condition uses).
 * `undefined` when the server reports none: an unknown age is never zero.
 */
export function sessionAgeMs(session: Session): number | undefined {
  const kind = stateOf(session)
  const ms = kind === 'active' || kind === 'waiting' ? session.queryAgeMs : session.stateAgeMs
  return ms ?? undefined
}

/** Longest first; a session without an age comes last; the pid breaks ties. */
function compareAge(a: Session, b: Session): number {
  const left = sessionAgeMs(a)
  const right = sessionAgeMs(b)
  if (left === undefined && right === undefined) return a.pid - b.pid
  if (left === undefined) return 1
  if (right === undefined) return -1
  return right - left || a.pid - b.pid
}

/** Sessions in the order of a flat list: by role, application and pid, or longest first. */
export function orderSessions(
  sessions: readonly Session[],
  order: SessionOrder,
): readonly Session[] {
  return [...sessions].sort((a, b) =>
    order === 'longest'
      ? compareAge(a, b)
      : compareText(a.role, b.role) ||
        compareText(a.applicationName, b.applicationName) ||
        a.pid - b.pid,
  )
}

export interface LongestSession {
  readonly session: Session
  readonly ageMs: number
}

/** How many sessions are in the given states and which of them has been in its state longest. */
export function longestInStates(
  sessions: readonly Session[],
  kinds: readonly StateKind[],
): { readonly count: number; readonly longest: LongestSession | undefined } {
  let count = 0
  let longest: LongestSession | undefined
  for (const session of sessions) {
    if (!kinds.includes(stateOf(session))) continue
    count += 1
    const ageMs = sessionAgeMs(session)
    if (ageMs === undefined) continue
    if (
      longest === undefined ||
      ageMs > longest.ageMs ||
      (ageMs === longest.ageMs && session.pid < longest.session.pid)
    ) {
      longest = { session, ageMs }
    }
  }
  return { count, longest }
}

export function sessionsByPid(sessions: readonly Session[]): ReadonlyMap<number, Session> {
  return new Map(sessions.map((session) => [session.pid, session]))
}

// ----- the lock graph in numbers -----

/** The number of distinct sessions that wait for a lock. */
export function blockedSessionCount(waits: readonly LockWait[]): number {
  return new Set(waits.map((wait) => wait.waitingPid)).size
}

/** Every process the graph names, as a waiter or as a blocker. */
export function graphPids(waits: readonly LockWait[]): ReadonlySet<number> {
  const pids = new Set<number>()
  for (const wait of waits) {
    pids.add(wait.waitingPid)
    for (const blocker of wait.blockingPids) pids.add(blocker)
  }
  return pids
}

export interface BlockerSummary {
  /** The root blocker that holds up the most sessions, transitively (the lowest pid wins a tie). */
  readonly top: { readonly pid: number; readonly blocked: number } | undefined
  readonly rootCount: number
  /** Some waits form a cycle: no root holds those sessions up first. */
  readonly hasCycle: boolean
}

/**
 * Who holds up the most sessions. The roots come from the blocking tree
 * (`buildBlockingTree`); the count follows every edge of the graph, not only
 * the first parent the tree shows a session under, so a session blocked by
 * two roots counts for both. A cycle is reported, never hidden.
 */
export function summarizeBlockers(waits: readonly LockWait[]): BlockerSummary {
  const tree = buildBlockingTree(waits)
  const waitersOf = new Map<number, number[]>()
  for (const wait of waits) {
    for (const blocker of wait.blockingPids) {
      const list = waitersOf.get(blocker) ?? []
      list.push(wait.waitingPid)
      waitersOf.set(blocker, list)
    }
  }
  const reach = (root: number): number => {
    const seen = new Set<number>([root])
    const queue = [root]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const waiter of waitersOf.get(next) ?? []) {
        if (seen.has(waiter)) continue
        seen.add(waiter)
        queue.push(waiter)
      }
    }
    return seen.size - 1
  }
  let top: BlockerSummary['top']
  for (const root of tree.roots) {
    const blocked = reach(root.pid)
    if (top === undefined || blocked > top.blocked) top = { pid: root.pid, blocked }
  }
  return { top, rootCount: tree.roots.length, hasCycle: tree.cycles.length > 0 }
}

// ----- filters -----

/** What the sessions list can be narrowed by (state, role and application are equality, text is a substring). */
export interface SessionFilters {
  readonly state?: StateKind | undefined
  /** Equal to the role of a session, as the data has it. */
  readonly role?: string | undefined
  /** Equal to the application name of a session (`''` is "no application name"). */
  readonly application?: string | undefined
  readonly minAgeSeconds?: number | undefined
  /** Case-insensitive substring of the redacted statement the list shows. */
  readonly text?: string | undefined
  /** The blockers view: only the processes the lock graph names. */
  readonly graphPids?: ReadonlySet<number> | undefined
}

/** How long since a session's query started (the server's `minAgeSeconds` measure), in milliseconds. */
function sinceQueryStartMs(session: Session, observedAt: string): number | undefined {
  if (session.queryAgeMs !== null) return session.queryAgeMs
  const started = Date.parse(session.backendStart)
  const observed = Date.parse(observedAt)
  return Number.isNaN(started) || Number.isNaN(observed) ? undefined : observed - started
}

/**
 * The sessions that match every filter that is set. `skipServerFilters`
 * leaves out the filters the target already applied (application and minimum
 * age), so a list the target filtered is not filtered a second time by
 * another formula; the state is always refined, because "waiting" and
 * "active" are one state for PostgreSQL.
 */
export function filterSessions(
  sessions: readonly Session[],
  filters: SessionFilters,
  options: { readonly observedAt: string; readonly skipServerFilters?: boolean },
): readonly Session[] {
  const needle = (filters.text ?? '').trim().toLowerCase()
  const skip = options.skipServerFilters === true
  return sessions.filter((session) => {
    if (filters.state !== undefined && stateOf(session) !== filters.state) return false
    if (filters.role !== undefined && session.role !== filters.role) return false
    if (
      !skip &&
      filters.application !== undefined &&
      session.applicationName !== filters.application
    ) {
      return false
    }
    if (!skip && filters.minAgeSeconds !== undefined) {
      const age = sinceQueryStartMs(session, options.observedAt)
      if (age === undefined || age < filters.minAgeSeconds * 1_000) return false
    }
    if (filters.graphPids !== undefined && !filters.graphPids.has(session.pid)) return false
    if (needle !== '') {
      const statement = session.statement?.redacted
      if (statement === undefined || !statement.toLowerCase().includes(needle)) return false
    }
    return true
  })
}

/** What `listSessions` can be asked for. */
export interface ServerFilter {
  readonly state?: string | undefined
  readonly application?: string | undefined
  readonly minAgeSeconds?: number | undefined
}

/** The PostgreSQL `state` the target filters by, for the states it names; "waiting" is a part of "active". */
const PG_STATE: Readonly<Partial<Record<StateKind, string>>> = {
  active: 'active',
  waiting: 'active',
  idle: 'idle',
  idle_in_transaction: 'idle in transaction',
  idle_in_transaction_aborted: 'idle in transaction (aborted)',
}

/**
 * The part of the filters the target can apply. The role has no parameter;
 * "other" is a state PostgreSQL does not name; an empty application name is
 * kept local, because an empty query parameter is not a reliable filter.
 */
export function serverFilterOf(filters: SessionFilters): ServerFilter {
  const state = filters.state === undefined ? undefined : PG_STATE[filters.state]
  return {
    ...(state === undefined ? {} : { state }),
    ...(filters.application === undefined || filters.application === ''
      ? {}
      : { application: filters.application }),
    ...(filters.minAgeSeconds === undefined ? {} : { minAgeSeconds: filters.minAgeSeconds }),
  }
}

export function hasServerFilter(filter: ServerFilter): boolean {
  return (
    filter.state !== undefined ||
    filter.application !== undefined ||
    filter.minAgeSeconds !== undefined
  )
}

export type LocalFilterName = 'role' | 'text' | 'state' | 'view' | 'application'

/**
 * The filters that only this page can apply (so, over a cut list, over the
 * sessions returned and no more): role, text, the blockers view, the two
 * states PostgreSQL does not filter by exactly ("waiting", "other") and an
 * empty application name.
 */
export function localOnlyFilters(filters: SessionFilters): readonly LocalFilterName[] {
  const names: LocalFilterName[] = []
  if (filters.role !== undefined) names.push('role')
  if (filters.text !== undefined && filters.text.trim() !== '') names.push('text')
  if (filters.state === 'waiting' || filters.state === 'other') names.push('state')
  if (filters.application === '') names.push('application')
  if (filters.graphPids !== undefined) names.push('view')
  return names
}

/**
 * A name for a `<select>` option or another place that can only hold plain
 * text: an invisible, control or direction character is shown by its code
 * point, and the length is bounded. The rich view of untrusted text
 * (`UntrustedName`) is used wherever the markup allows it.
 */
export function plainLabel(text: string, maxCodePoints = 80): string {
  const { head, truncated } = takeCodePoints(text, maxCodePoints)
  let out = ''
  for (const character of head) {
    const codePoint = character.codePointAt(0) ?? 0
    out += isInvisible(codePoint)
      ? codePoint === 0x09
        ? ' '
        : codePointLabel(codePoint)
      : character
  }
  return truncated ? `${out}…` : out
}

/** The distinct values of a text field of the sessions, sorted, for an equality filter. */
export function distinctValues(
  sessions: readonly Session[],
  field: 'role' | 'applicationName',
): readonly string[] {
  return [...new Set(sessions.map((session) => session[field]))].sort(compareText)
}

// ----- what the health sample says about connections -----

export type Health = ResponseOf<'getTargetHealth'>
export type HealthCondition = Health['conditions'][number]
export type Severity = HealthCondition['severity']

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, critical: 2 }

function numberValue(condition: HealthCondition, key: string): number | null {
  const value = condition.values?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The condition of a name; when several exist (one per path), the most severe. */
function worstCondition(health: Health, name: string): HealthCondition | undefined {
  let worst: HealthCondition | undefined
  for (const condition of health.conditions) {
    if (condition.condition !== name) continue
    if (worst === undefined || SEVERITY_RANK[condition.severity] > SEVERITY_RANK[worst.severity]) {
      worst = condition
    }
  }
  return worst
}

/**
 * What the latest health sample says about connection capacity.
 *
 * When the sample measured it, the health read carries the capacity itself
 * (`capacity`: client backends in use and usable slots, with the source and
 * time of the measurement): the facts are those two numbers, always, and the
 * severity is the server's own judgment from its `connections_high` or
 * `connections_critical` condition when it raised one, else none. When the
 * sample did not measure it (the member is absent: never sampled, the target
 * unreachable, a read that failed, a sample from an older server), the facts
 * come from the values the server's conditions carry, as before. The server
 * decides what is high; this page never compares a number with a threshold.
 * A sample that reported no connection condition and no capacity is "not
 * flagged", which is neither a number nor "fine": when the capacity could not
 * be read (`settings_unreadable`, `activity_unreadable`) the answer is "not
 * judged". An absent capacity is never read as zero.
 */
export type ConnectionFacts =
  | {
      /** Both numbers were measured by the sample. */
      readonly kind: 'capacity'
      readonly used: number
      readonly usable: number
      /** The server's own judgment (a condition it raised), or `null`: not judged high. */
      readonly severity: Severity | null
      readonly source: string
      readonly observedAt: string
    }
  | {
      readonly kind: 'slots'
      readonly used: number | null
      readonly usable: number | null
      readonly severity: Severity
    }
  | { readonly kind: 'not_flagged' }
  | { readonly kind: 'not_judged'; readonly because: 'settings_unreadable' | 'activity_unreadable' }
  | { readonly kind: 'unknown'; readonly because: string | null }

export function connectionFacts(health: Health): ConnectionFacts {
  if (health.state === 'unknown') return { kind: 'unknown', because: health.unknownBecause }
  const high =
    worstCondition(health, 'connections_critical') ?? worstCondition(health, 'connections_high')
  const capacity = health.capacity
  if (capacity !== undefined) {
    return {
      kind: 'capacity',
      used: capacity.clientBackends,
      usable: capacity.usableSlots,
      severity: high?.severity ?? null,
      source: capacity.source,
      observedAt: capacity.observedAt,
    }
  }
  if (high !== undefined) {
    return {
      kind: 'slots',
      used: numberValue(high, 'clientBackends') ?? high.count,
      usable: numberValue(high, 'usableSlots'),
      severity: high.severity,
    }
  }
  if (worstCondition(health, 'settings_unreadable') !== undefined) {
    return { kind: 'not_judged', because: 'settings_unreadable' }
  }
  if (worstCondition(health, 'activity_unreadable') !== undefined) {
    return { kind: 'not_judged', because: 'activity_unreadable' }
  }
  return { kind: 'not_flagged' }
}

/** The session conditions the page shows as cards, in this order. */
export const SESSION_CONDITIONS = [
  'idle_in_transaction',
  'long_running',
  'stalled_sessions',
  'lock_waits',
] as const
export type SessionConditionName = (typeof SESSION_CONDITIONS)[number]

export interface SessionConditionFacts {
  readonly condition: SessionConditionName
  readonly severity: Severity
  /** The exact count of matching sessions, as the server counted them. */
  readonly count: number | null
  /** The age of the oldest matching session, when the condition carries one. */
  readonly oldestSeconds: number | null
}

/** The session conditions the sample reported (not the ones it did not: no card for a silence). */
export function sessionConditionFacts(health: Health): readonly SessionConditionFacts[] {
  return SESSION_CONDITIONS.flatMap((name) => {
    const condition = worstCondition(health, name)
    if (condition === undefined) return []
    return [
      {
        condition: name,
        severity: condition.severity,
        count: condition.count,
        oldestSeconds: numberValue(condition, 'oldestSeconds'),
      },
    ]
  })
}

// ----- when the reads were observed -----

/** When a read was observed, or `undefined` while it is loading or after it failed. */
export function observedAtOf<T>(readable: Readable<T>): string | undefined {
  return readable.state === 'loading' || readable.state === 'failed'
    ? undefined
    : readable.observedAt
}

/**
 * The oldest of the observation times (ISO 8601) that exist: a page built
 * from several reads is as current as the oldest of them. `undefined` when
 * no read has produced one yet, never a made-up "now".
 */
export function oldestObservation(times: readonly (string | undefined)[]): string | undefined {
  let oldest: { readonly at: string; readonly ms: number } | undefined
  for (const at of times) {
    if (at === undefined) continue
    const ms = Date.parse(at)
    if (Number.isNaN(ms)) continue
    if (oldest === undefined || ms < oldest.ms) oldest = { at, ms }
  }
  return oldest?.at
}
