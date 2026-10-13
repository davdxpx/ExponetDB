import { AlertTriangle } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import {
  ClassificationBadge,
  formatUtc,
  type HeadingLevel,
  type NowInput,
  type StatementClassification,
  TierChip,
  toIso,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import {
  type ExpiryStatus,
  expiryStatus,
  formatRemaining,
  hashKnown,
  isPlanStateName,
  planStateLabel,
} from './format.ts'
import { activeUntil, PlanActions, type PlanBinding, usePlanClock } from './plan-actions.tsx'
import { PlanBlock } from './plan-frame.tsx'
import {
  CopyButton,
  type FactItem,
  Facts,
  FullCode,
  INLINE_ICON,
  lookup,
  Marked,
  NotKnown,
  TimeText,
  Words,
} from './shared.tsx'

/** Who made the plan (`PlanView.actor`). */
export interface PlanCreator {
  /** `human`, `service` or `system` (`Actor.kind`). */
  readonly kind: string
  /** `Actor.identityId`; `null` for the system. */
  readonly identityId: string | null
  /** The identity's display name when the page has it (untrusted: the person chose it). */
  readonly displayName?: string | null
  /** The client the identity acted through: `web`, `rest`, `mcp`, `cli`, `ci`, `system` (`Actor.via`). */
  readonly via: string
}

/** What the plan changes (`PlanView.subject`). The first present of target, cluster and node is shown. */
export interface PlanSubject {
  /** `<product>/<project>/<environment>`. */
  readonly targetPath: string | null
  readonly clusterId?: string | null
  readonly nodeId?: string | null
}

export interface PlanSummaryBlockProps {
  /** `PlanView.id`. */
  readonly planId: string
  /**
   * `PlanView.planHash`, shown in full with a copy button. `renderActions`
   * receives exactly this value; the page passes the same value to every
   * block that shows the hash (see `PlanBinding`).
   */
  readonly planHash: string
  readonly subject: PlanSubject
  /** `PlanView.subject.tier`: `prod` or `nonprod`; `null` when not known. */
  readonly tier: string | null
  /** `PlanView.kind`, such as `migration.apply`. */
  readonly kind: string | null
  /** `PlanView.class`: `read`, `low`, `standard`, `high`, `critical`. */
  readonly planClass: string | null
  /**
   * Statement classes the analysis found (`destructive`, `rewrite`,
   * `non_transactional`, `security`), shown through `ClassificationBadge`;
   * an empty list is "none found", `null` is "not known".
   */
  readonly classifications: readonly string[] | null
  /** `PlanView.state`. */
  readonly state: string | null
  readonly creator: PlanCreator | null
  /** The creating client's own name (`ApprovalReview.clientName`): untrusted, never verified. */
  readonly clientName: string | null
  /** `PlanView.createdAt`. */
  readonly createdAt: string | null
  /** `PlanView.expiresAt`: the countdown runs against it. */
  readonly expiresAt: string | null
  /** The read behind this view may be out of date: the actions are not offered. */
  readonly stale?: boolean
  /** The time the countdown measures against; without it the device clock, every second. */
  readonly now?: NowInput
  /** The plan's actions (apply, withdraw), offered only while the plan is active and not expired. */
  readonly renderActions?: (binding: PlanBinding) => ReactNode
  readonly headingLevel?: HeadingLevel
}

const KNOWN_CLASSES = ['read', 'low', 'standard', 'high', 'critical'] as const
type KnownClass = (typeof KNOWN_CLASSES)[number]

const CLASS_TEXT: Readonly<
  Record<KnownClass, { readonly label: string; readonly meaning: string }>
> = {
  read: { label: 'Read', meaning: 'Reads only and changes nothing.' },
  low: { label: 'Low', meaning: 'A small, reversible or self-limiting effect on one object.' },
  standard: {
    label: 'Standard',
    meaning: 'Changes the structure, configuration or availability of one target or cluster.',
  },
  high: {
    label: 'High',
    meaning:
      'A structural change, restart, credential rotation or session termination on production.',
  },
  critical: { label: 'Critical', meaning: 'Replaces or destroys data or identity.' },
}

function isKnownClass(value: string): value is KnownClass {
  return Object.hasOwn(CLASS_TEXT, value)
}

const CREATOR_KINDS: Readonly<Record<string, string>> = {
  human: 'Person',
  service: 'Service account',
  system: 'ExponetDB itself',
}

const CLIENT_KINDS: Readonly<Record<string, string>> = {
  web: 'Web App',
  rest: 'REST API',
  mcp: 'MCP (an AI agent)',
  cli: 'CLI',
  ci: 'CI (an API key or a machine grant)',
  system: 'ExponetDB itself',
}

const STATEMENT_CLASSES: readonly string[] = [
  'destructive',
  'rewrite',
  'non_transactional',
  'security',
  'read_only',
  'write',
]

function isStatementClassification(value: string): value is StatementClassification {
  return STATEMENT_CLASSES.includes(value)
}

function UnknownName({
  value,
  what,
}: {
  readonly value: string
  readonly what: string
}): ReactNode {
  return (
    <Words>
      <AlertTriangle aria-hidden="true" className={cn(INLINE_ICON, 'text-warning-600')} />
      <Marked text={value} mono />
      <span className="text-foreground-light">{`(not a known ${what})`}</span>
    </Words>
  )
}

function SubjectValue({
  subject,
  tier,
}: {
  readonly subject: PlanSubject
  readonly tier: string | null
}): ReactNode {
  // The contract's tiers are `prod` and `nonprod`; any other value is named as unknown, not shown
  // as a neutral chip (the page frame treats it as production, failing closed).
  const tierValue =
    tier === null || tier === '' ? (
      <span>
        tier <NotKnown />
      </span>
    ) : tier === 'prod' || tier === 'production' || tier === 'nonprod' ? (
      <TierChip tier={tier} />
    ) : (
      <UnknownName value={tier} what="tier" />
    )
  if (subject.targetPath !== null && subject.targetPath !== '') {
    return (
      <Words>
        <FullCode text={subject.targetPath} />
        {tierValue}
      </Words>
    )
  }
  if (subject.clusterId !== undefined && subject.clusterId !== null && subject.clusterId !== '') {
    return (
      <Words>
        <span>cluster</span>
        <FullCode text={subject.clusterId} />
        {tierValue}
      </Words>
    )
  }
  if (subject.nodeId !== undefined && subject.nodeId !== null && subject.nodeId !== '') {
    return (
      <Words>
        <span>node</span>
        <FullCode text={subject.nodeId} />
        {tierValue}
      </Words>
    )
  }
  return (
    <Words>
      <NotKnown />
      {tierValue}
    </Words>
  )
}

function ClassValue({ planClass }: { readonly planClass: string | null }): ReactNode {
  if (planClass === null || planClass === '') return <NotKnown />
  if (!isKnownClass(planClass)) return <UnknownName value={planClass} what="class" />
  const text = CLASS_TEXT[planClass]
  return (
    <span>
      <strong data-plan-class={planClass} className="font-medium">
        {text.label}
      </strong>
      {`: ${text.meaning}`}
    </span>
  )
}

function ClassificationsValue({
  classifications,
}: {
  readonly classifications: readonly string[] | null
}): ReactNode {
  if (classifications === null) return <NotKnown />
  if (classifications.length === 0) return <span>None found by the analysis</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {[...new Set(classifications)].map((c) =>
        isStatementClassification(c) ? (
          <ClassificationBadge key={c} classification={c} />
        ) : (
          <UnknownName key={c} value={c} what="statement class" />
        ),
      )}
    </span>
  )
}

function CreatorValue({ creator }: { readonly creator: PlanCreator | null }): ReactNode {
  if (creator === null) return <NotKnown />
  const kind = lookup(CREATOR_KINDS, creator.kind)
  return (
    <Words>
      {kind === undefined ? (
        <UnknownName value={creator.kind} what="kind of creator" />
      ) : (
        <span>{kind}</span>
      )}
      {creator.displayName === undefined || creator.displayName === null ? null : (
        <UntrustedName name={creator.displayName} label="creator name" />
      )}
      {creator.identityId === null ? null : <Marked text={creator.identityId} mono />}
    </Words>
  )
}

function ClientValue({ creator }: { readonly creator: PlanCreator | null }): ReactNode {
  if (creator === null || creator.via === '') return <NotKnown />
  const via = lookup(CLIENT_KINDS, creator.via)
  return via === undefined ? (
    <UnknownName value={creator.via} what="client kind" />
  ) : (
    <span>{via}</span>
  )
}

function ExpiryValue({
  expiresAt,
  expiry,
  state,
}: {
  readonly expiresAt: string | null
  readonly expiry: ExpiryStatus
  readonly state: string | null
}): ReactNode {
  const iso = expiresAt === null ? undefined : toIso(expiresAt)
  const utc = expiresAt === null ? undefined : formatUtc(expiresAt)
  if (expiry.kind === 'unknown' || iso === undefined || utc === undefined) {
    return <NotKnown />
  }
  const absolute = <time dateTime={iso}>{`(${utc})`}</time>
  // The countdown matters while the plan can still be accepted; afterwards the time is a record.
  if (state === 'active' || state === 'expired') {
    if (expiry.kind === 'expired' || state === 'expired') {
      return (
        <Words>
          <strong data-expiry="expired" className="font-medium text-destructive">
            Expired
          </strong>
          {absolute}
        </Words>
      )
    }
    return (
      <Words>
        <span data-expiry="open" className="font-medium">
          {`Expires in ${formatRemaining(expiry.remainingMs)}`}
        </span>
        {absolute}
      </Words>
    )
  }
  return (
    <Words>
      <time dateTime={iso}>{utc}</time>
      {expiry.kind === 'expired' ? <span className="text-foreground-light">(passed)</span> : null}
    </Words>
  )
}

/**
 * The head of the plan review: target and tier, kind and class with the
 * statement classes, plan state, creator and client (the client's own name
 * marked "name not verified"), creation and expiry with a live countdown, the
 * full plan hash with a copy button, and the plan's actions while it can
 * still be accepted. Every value comes from props; a missing one reads
 * "not known". The classification badges need a `TooltipProvider` above
 * (the app shell has one).
 */
export function PlanSummaryBlock({
  planId,
  planHash,
  subject,
  tier,
  kind,
  planClass,
  classifications,
  state,
  creator,
  clientName,
  createdAt,
  expiresAt,
  stale = false,
  now,
  renderActions,
  headingLevel,
}: PlanSummaryBlockProps): ReactNode {
  const clock = usePlanClock(now, activeUntil(state, expiresAt))
  const expiry = expiryStatus(expiresAt, clock)
  const expiredNow = (state === 'active' && expiry.kind === 'expired') || state === 'expired'

  const items: FactItem[] = [
    { id: 'target', label: 'Target', value: <SubjectValue subject={subject} tier={tier} /> },
    {
      id: 'kind',
      label: 'Change',
      value: kind === null || kind === '' ? <NotKnown /> : <Marked text={kind} mono />,
    },
    { id: 'class', label: 'Plan class', value: <ClassValue planClass={planClass} /> },
    {
      id: 'classifications',
      label: 'Statement classes',
      value: <ClassificationsValue classifications={classifications} />,
    },
    {
      id: 'state',
      label: 'Plan state',
      value:
        state === null || state === '' ? (
          <NotKnown />
        ) : isPlanStateName(state) ? (
          <span data-plan-state={state}>{planStateLabel(state)}</span>
        ) : (
          <UnknownName value={state} what="plan state" />
        ),
    },
    { id: 'creator', label: 'Created by', value: <CreatorValue creator={creator} /> },
    { id: 'client', label: 'Through', value: <ClientValue creator={creator} /> },
    {
      id: 'client-name',
      label: 'Client name',
      value:
        clientName === null ? (
          <NotKnown />
        ) : (
          <span className="client-name">
            <UntrustedName name={clientName} unverified label="client name" />
          </span>
        ),
    },
    { id: 'created', label: 'Created', value: <TimeText at={createdAt} now={clock} /> },
    {
      id: 'expires',
      label: 'Expiry',
      value: <ExpiryValue expiresAt={expiresAt} expiry={expiry} state={state} />,
    },
    {
      id: 'plan-hash',
      label: 'Plan hash',
      value: hashKnown(planHash) ? (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <FullCode text={planHash} data-full-hash="" className="full-hash" />
          <CopyButton text={planHash} label="plan hash" />
        </span>
      ) : (
        <NotKnown />
      ),
    },
  ]

  return (
    <PlanBlock title="Summary" headingLevel={headingLevel} data-plan-block="summary">
      <Facts items={items} />
      {stale && renderActions === undefined ? (
        <p role="note" className="text-sm text-foreground-light">
          This view may be out of date. Refresh it before you decide.
        </p>
      ) : null}
      {/* Announced once, when the plan expires while the page is open; the countdown itself is not live. */}
      <p role="status" className="sr-only">
        {expiredNow ? 'This plan expired.' : ''}
      </p>
      {renderActions === undefined ? null : (
        <PlanActions
          planId={planId}
          planHash={planHash}
          state={state}
          expiresAt={expiresAt}
          stale={stale}
          now={clock}
          render={renderActions}
        />
      )}
    </PlanBlock>
  )
}
