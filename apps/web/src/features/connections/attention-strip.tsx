import { Button, cn } from '@exponetdb/ui'
import {
  MetricCard,
  type MetricCardState,
  ObservedTime,
  type Readable,
  type ReadMeta,
  type ReadSource,
  SourceLabel,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import {
  blockedSessionCount,
  type ConnectionFacts,
  connectionFacts,
  formatDuration,
  type Health,
  longestInStates,
  type SessionConditionFacts,
  type SessionConditionName,
  type Severity,
  type StateKind,
  sessionConditionFacts,
  summarizeBlockers,
} from './model.ts'
import type { LockGraph, Sessions } from './queries.ts'

/**
 * The strip above the sessions: what needs a person's attention first.
 *
 * Two groups, each card with its own truthful state (C-28) and its own
 * source and time:
 *
 * - **From the sessions and locks read now.** Computed here from the two
 *   live reads the page already makes: blocked sessions, the top blocker,
 *   the longest active query and the longest idle-in-transaction session.
 *   They are neutral numbers: the page has no limit of its own, so none of
 *   them is colored. A figure over a cut read is a lower bound and says so.
 * - **From the latest health sample.** The conditions about connections as
 *   the server reported them, with the values it sent (slots in use,
 *   counts, the oldest age) and its severity. Only the server judges.
 *
 * A failed read is the card's failed state, never a zero; a card never
 * shows a number whose read did not succeed.
 */

type Cell = ReactNode

/** The card state of a read; `derive` renders the value once there is one. */
function cardState<T>(
  readable: Readable<T>,
  derive: (value: T, meta: ReadMeta) => Cell,
): MetricCardState {
  switch (readable.state) {
    case 'loading':
      return { state: 'loading' }
    case 'failed':
      return { state: 'failed', failure: readable.error }
    case 'stale':
      return {
        state: 'stale',
        value: derive(readable.value, {
          state: 'stale',
          source: readable.source,
          observedAt: readable.observedAt,
        }),
        observedAt: readable.observedAt,
        ...(readable.error === undefined ? {} : { failure: readable.error }),
      }
    case 'partial':
      return {
        state: 'ready',
        value: derive(readable.value, {
          state: 'partial',
          source: readable.source,
          observedAt: readable.observedAt,
        }),
      }
    case 'ready':
      return {
        state: 'ready',
        value: derive(readable.value, {
          state: 'ready',
          source: readable.source,
          observedAt: readable.observedAt,
        }),
      }
  }
}

/** Where and when a figure was read; a source this page has no word for is left out, not guessed. */
interface Observation {
  readonly source?: ReadSource | undefined
  readonly observedAt: string
}

/** The figure, what to know about it, and where and when it was read. */
function ReadValue(props: {
  readonly main: Cell
  readonly note?: Cell
  readonly meta: Observation
}): ReactNode {
  return (
    <>
      <span data-slot="main">{props.main}</span>
      {props.note === undefined ? null : (
        <span className="mt-1 block text-xs font-normal text-foreground-light" data-slot="note">
          {props.note}
        </span>
      )}
      <span
        className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-normal text-foreground-light"
        data-slot="read"
      >
        {props.meta.source === undefined ? null : <SourceLabel source={props.meta.source} />}
        <span>
          {t('connections.observation')} <ObservedTime observedAt={props.meta.observedAt} seconds />
        </span>
      </span>
    </>
  )
}

/** The link to a row of the list, or the plain statement that the row is not there. */
function JumpLink(props: {
  readonly pid: number
  readonly listed: boolean
  readonly onJump: (pid: number) => void
}): ReactNode {
  if (!props.listed) return <span>{t('connections.card.notListed')}</span>
  return (
    <Button
      type="button"
      variant="link"
      size="tiny"
      className="h-auto px-0 py-0"
      aria-label={t('connections.card.jump.label', { pid: props.pid })}
      onClick={() => props.onJump(props.pid)}
    >
      {t('connections.card.jump')}
    </Button>
  )
}

export interface AttentionStripProps {
  readonly sessions: Readable<Sessions>
  readonly locks: Readable<LockGraph>
  readonly health: Readable<Health>
  /** The processes that have a row in the list below; a card links only to one of them. */
  readonly listed: ReadonlySet<number>
  readonly onJump: (pid: number) => void
}

export function AttentionStrip(props: AttentionStripProps): ReactNode {
  return (
    <div className="flex flex-col gap-4" data-section="attention-strip">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-light">
          {t('connections.attention.read.title')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <BlockedCard locks={props.locks} />
          <TopBlockerCard locks={props.locks} listed={props.listed} onJump={props.onJump} />
          <LongestQueryCard sessions={props.sessions} listed={props.listed} onJump={props.onJump} />
          <LongestIdleCard sessions={props.sessions} listed={props.listed} onJump={props.onJump} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground-light">
          {t('connections.attention.health.title')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <HealthCards health={props.health} />
        </div>
        <p className="text-xs text-foreground-light">{t('connections.attention.health.note')}</p>
      </div>
    </div>
  )
}

// ----- from the live reads -----

function BlockedCard({ locks }: { readonly locks: Readable<LockGraph> }): ReactNode {
  const state = cardState(locks, (graph, meta) => {
    const count = blockedSessionCount(graph.waits)
    return (
      <ReadValue
        meta={meta}
        main={graph.truncated ? t('connections.card.atLeast', { value: count }) : count}
        {...(graph.truncated ? { note: t('connections.card.cutLocks') } : {})}
      />
    )
  })
  return (
    <MetricCard
      {...state}
      label={t('connections.card.blocked')}
      help={t('connections.card.blocked.help')}
    />
  )
}

function TopBlockerCard(props: {
  readonly locks: Readable<LockGraph>
  readonly listed: ReadonlySet<number>
  readonly onJump: (pid: number) => void
}): ReactNode {
  const state = cardState(props.locks, (graph, meta) => {
    const cut = graph.truncated ? t('connections.card.cutLocks') : undefined
    if (graph.waits.length === 0) {
      return (
        <ReadValue
          meta={meta}
          main={t('connections.card.topBlocker.none')}
          note={t('connections.card.topBlocker.noneNote')}
        />
      )
    }
    const summary = summarizeBlockers(graph.waits)
    if (summary.top === undefined) {
      return (
        <ReadValue
          meta={meta}
          main={t('connections.card.topBlocker.cycle')}
          note={[t('connections.card.topBlocker.cycleNote'), cut].filter(Boolean).join(' ')}
        />
      )
    }
    const { pid, blocked } = summary.top
    return (
      <ReadValue
        meta={meta}
        main={t('connections.card.process', { pid })}
        note={
          <>
            {t('connections.card.topBlocker.holds', { count: blocked })}.{' '}
            <JumpLink pid={pid} listed={props.listed.has(pid)} onJump={props.onJump} />
            {summary.hasCycle ? <> {t('connections.card.topBlocker.cycleAlso')}</> : null}
            {cut === undefined ? null : <> {cut}</>}
          </>
        }
      />
    )
  })
  return (
    <MetricCard
      {...state}
      label={t('connections.card.topBlocker')}
      help={t('connections.card.topBlocker.help')}
    />
  )
}

/** The longest session of some states: shared by the active-query and idle-in-transaction cards. */
function LongestCard(props: {
  readonly sessions: Readable<Sessions>
  readonly kinds: readonly StateKind[]
  readonly label: string
  readonly help: string
  readonly none: string
  readonly listed: ReadonlySet<number>
  readonly onJump: (pid: number) => void
}): ReactNode {
  const state = cardState(props.sessions, (list, meta) => {
    const { count, longest } = longestInStates(list.sessions, props.kinds)
    const cut = list.truncated ? t('connections.card.cutSessions', { cap: list.cap }) : undefined
    if (count === 0) {
      return (
        <ReadValue
          meta={meta}
          main={list.truncated ? t('connections.card.noneInSample', { cap: list.cap }) : props.none}
          {...(cut === undefined ? {} : { note: cut })}
        />
      )
    }
    if (longest === undefined) {
      return (
        <ReadValue
          meta={meta}
          main={t('connections.card.ageUnknown')}
          {...(cut === undefined ? {} : { note: cut })}
        />
      )
    }
    const duration = formatDuration(longest.ageMs)
    const pid = longest.session.pid
    return (
      <ReadValue
        meta={meta}
        main={list.truncated ? t('connections.card.atLeast', { value: duration }) : duration}
        note={
          <>
            {t('connections.card.process', { pid })}{' '}
            <JumpLink pid={pid} listed={props.listed.has(pid)} onJump={props.onJump} />
            {cut === undefined ? null : <> {cut}</>}
          </>
        }
      />
    )
  })
  return <MetricCard {...state} label={props.label} help={props.help} />
}

function LongestQueryCard(props: {
  readonly sessions: Readable<Sessions>
  readonly listed: ReadonlySet<number>
  readonly onJump: (pid: number) => void
}): ReactNode {
  return (
    <LongestCard
      {...props}
      kinds={['active', 'waiting']}
      label={t('connections.card.longestQuery')}
      help={t('connections.card.longestQuery.help')}
      none={t('connections.card.longestQuery.none')}
    />
  )
}

function LongestIdleCard(props: {
  readonly sessions: Readable<Sessions>
  readonly listed: ReadonlySet<number>
  readonly onJump: (pid: number) => void
}): ReactNode {
  return (
    <LongestCard
      {...props}
      kinds={['idle_in_transaction', 'idle_in_transaction_aborted']}
      label={t('connections.card.longestIdle')}
      help={t('connections.card.longestIdle.help')}
      none={t('connections.card.longestIdle.none')}
    />
  )
}

// ----- from the health sample -----

const SEVERITY_KEYS: Readonly<Record<Severity, MessageKey>> = {
  info: 'connections.severity.info',
  warning: 'connections.severity.warning',
  critical: 'connections.severity.critical',
}

/**
 * The severity the server gave a condition, in words, colored only for the
 * two levels the server calls a problem. A level the page does not know
 * cannot reach here: the severity is one of the contract's three.
 */
export function SeverityChip({ severity }: { readonly severity: Severity }): ReactNode {
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        severity === 'critical' &&
          'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
        severity === 'warning' &&
          'border-state-degraded bg-state-degraded text-state-degraded-foreground',
        severity === 'info' && 'border-default text-foreground-light',
      )}
    >
      <span className="sr-only">{t('connections.severity.label')} </span>
      {t(SEVERITY_KEYS[severity])}
    </span>
  )
}

function HealthCards({ health }: { readonly health: Readable<Health> }): ReactNode {
  if (health.state === 'loading' || health.state === 'failed') {
    // Without a sample there is no condition to list: one card says why.
    return (
      <MetricCard
        {...cardState(health, () => null)}
        label={t('connections.card.conditions')}
        help={t('connections.card.slots.help')}
      />
    )
  }
  const conditions = sessionConditionFacts(health.value)
  return (
    <>
      <SlotsCard health={health} />
      {conditions.map((fact) => (
        <ConditionCard key={fact.condition} health={health} condition={fact.condition} />
      ))}
    </>
  )
}

/** "N of M connection slots used": the numbers the sample measured, neutral unless the server raised a condition. */
function capacityText(facts: Extract<ConnectionFacts, { kind: 'capacity' }>): string {
  return t('connections.card.slots.capacity', { used: facts.used, usable: facts.usable })
}

function slotsText(facts: Extract<ConnectionFacts, { kind: 'slots' }>): string {
  if (facts.used === null) return t('connections.card.slots.unusedUnknown')
  return facts.usable === null
    ? t('connections.card.slots.usedOnly', { used: facts.used })
    : t('connections.card.slots.value', { used: facts.used, usable: facts.usable })
}

function SlotsCard({ health }: { readonly health: Readable<Health> }): ReactNode {
  const state = cardState(health, (sample, meta) => {
    const facts = connectionFacts(sample)
    switch (facts.kind) {
      case 'capacity':
        return (
          <ReadValue
            // The measurement has its own source and time: they are what the figure is as old as.
            meta={{ source: readSourceOf(facts.source), observedAt: facts.observedAt }}
            main={capacityText(facts)}
            {...(facts.severity === null
              ? {}
              : { note: <SeverityChip severity={facts.severity} /> })}
          />
        )
      case 'slots':
        return (
          <ReadValue
            meta={meta}
            main={slotsText(facts)}
            note={<SeverityChip severity={facts.severity} />}
          />
        )
      case 'not_flagged':
        return (
          <ReadValue
            meta={meta}
            main={t('connections.card.slots.notFlagged')}
            note={t('connections.card.slots.notFlaggedNote')}
          />
        )
      case 'not_judged':
        return (
          <ReadValue
            meta={meta}
            main={t('connections.card.slots.notJudged')}
            note={
              facts.because === 'settings_unreadable'
                ? t('connections.card.slots.notJudged.settings_unreadable')
                : t('connections.card.slots.notJudged.activity_unreadable')
            }
          />
        )
      case 'unknown':
        return (
          <ReadValue
            meta={meta}
            main={t('connections.card.slots.unknown')}
            note={
              facts.because === null ? (
                t('connections.card.slots.unknownNoReason')
              ) : (
                <>
                  {t('connections.card.slots.unknownNote')}{' '}
                  <UntrustedName name={facts.because} mono label={t('connections.card.slots')} />
                </>
              )
            }
          />
        )
    }
  })
  return (
    <MetricCard
      {...state}
      label={t('connections.card.slots')}
      help={t('connections.card.slots.help')}
    />
  )
}

const CONDITION_LABELS: Readonly<
  Record<SessionConditionName, { readonly label: MessageKey; readonly help: MessageKey }>
> = {
  idle_in_transaction: {
    label: 'connections.card.condition.idle_in_transaction',
    help: 'connections.card.condition.idle_in_transaction.help',
  },
  long_running: {
    label: 'connections.card.condition.long_running',
    help: 'connections.card.condition.long_running.help',
  },
  stalled_sessions: {
    label: 'connections.card.condition.stalled_sessions',
    help: 'connections.card.condition.stalled_sessions.help',
  },
  lock_waits: {
    label: 'connections.card.condition.lock_waits',
    help: 'connections.card.condition.lock_waits.help',
  },
}

function ConditionCard(props: {
  readonly health: Readable<Health>
  readonly condition: SessionConditionName
}): ReactNode {
  const words = CONDITION_LABELS[props.condition]
  const state = cardState(props.health, (sample, meta) => {
    const fact: SessionConditionFacts | undefined = sessionConditionFacts(sample).find(
      (candidate) => candidate.condition === props.condition,
    )
    if (fact === undefined) return null
    return (
      <ReadValue
        meta={meta}
        main={fact.count === null ? t('connections.card.condition.countUnknown') : fact.count}
        note={
          <>
            <SeverityChip severity={fact.severity} />
            {fact.oldestSeconds === null ? null : (
              <>
                {' '}
                {t('connections.card.condition.oldest', {
                  duration: formatDuration(fact.oldestSeconds * 1_000),
                })}
              </>
            )}
          </>
        }
      />
    )
  })
  return <MetricCard {...state} label={t(words.label)} help={t(words.help)} />
}
