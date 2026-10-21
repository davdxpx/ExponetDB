import { type HeadingLevel, type NowInput, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import { expiryStatus, hashKnown, isPlanStateName, planStateLabel } from './format.ts'
import { activeUntil, PlanActions, type PlanBinding, usePlanClock } from './plan-actions.tsx'
import { PlanBlock } from './plan-frame.tsx'
import {
  ClassificationsValue,
  ClassValue,
  ClientValue,
  CreatorValue,
  ExpiryValue,
  type PlanCreator,
  type PlanSubject,
  SubjectValue,
  UnknownName,
} from './plan-values.tsx'
import {
  CopyButton,
  type FactItem,
  Facts,
  FullCode,
  Marked,
  NotKnown,
  TimeText,
} from './shared.tsx'

export type { PlanCreator, PlanSubject } from './plan-values.tsx'

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
