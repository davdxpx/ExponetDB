import { AlertTriangle } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import {
  ClassificationBadge,
  formatUtc,
  type StatementClassification,
  TierChip,
  toIso,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import { type ExpiryStatus, formatRemaining } from './format.ts'
import { FullCode, INLINE_ICON, lookup, Marked, NotKnown, Words } from './shared.tsx'

/**
 * The values of a plan's facts as the summary block and the details list show
 * them (internal to the plan blocks; not exported from the package). Every
 * value the server did not give reads "not known"; a value this version does
 * not know is shown as marked text with "not a known …".
 */

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

export function UnknownName({
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

/** The tier as a chip; "tier not known" for none, marked text for a tier this version does not know. */
export function TierValue({ tier }: { readonly tier: string | null }): ReactNode {
  // The contract's tiers are `prod` and `nonprod`; any other value is named as unknown, not shown
  // as a neutral chip (the page frame treats it as production, failing closed).
  if (tier === null || tier === '') {
    return (
      <span>
        tier <NotKnown />
      </span>
    )
  }
  if (tier === 'prod' || tier === 'production' || tier === 'nonprod')
    return <TierChip tier={tier} />
  return <UnknownName value={tier} what="tier" />
}

export function SubjectValue({
  subject,
  tier,
}: {
  readonly subject: PlanSubject
  readonly tier: string | null
}): ReactNode {
  const tierValue = <TierValue tier={tier} />
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

export function ClassValue({ planClass }: { readonly planClass: string | null }): ReactNode {
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

export function ClassificationsValue({
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

export function CreatorValue({ creator }: { readonly creator: PlanCreator | null }): ReactNode {
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

export function ClientValue({ creator }: { readonly creator: PlanCreator | null }): ReactNode {
  if (creator === null || creator.via === '') return <NotKnown />
  const via = lookup(CLIENT_KINDS, creator.via)
  return via === undefined ? (
    <UnknownName value={creator.via} what="client kind" />
  ) : (
    <span>{via}</span>
  )
}

export function ExpiryValue({
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
