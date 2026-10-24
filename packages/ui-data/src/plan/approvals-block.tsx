import { AlertTriangle, Check, ShieldAlert, X } from '@exponetdb/icons'
import { Checkbox } from '@exponetdb/ui'
import {
  type HeadingLevel,
  type NowInput,
  UntrustedName,
  UntrustedText,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'

import { hashKnown, knownNumber, plural } from './format.ts'
import type { PlanBinding } from './plan-actions.tsx'
import { PlanBlock } from './plan-frame.tsx'
import { FullCode, keyedBy, Marked, Note, NotKnown, TimeText, Words } from './shared.tsx'

/** One decision on the plan (`ApprovalView`). */
export interface ApprovalEntry {
  /** `ApprovalView.id`. */
  readonly id: string
  /** `approverIdentityId`. */
  readonly approverIdentityId: string
  /** The approver's display name when the page has it (untrusted). */
  readonly approverName?: string | null
  /** `approved` or `rejected`. */
  readonly decision: string
  /** The approver is the plan's own actor (OD-9). */
  readonly selfApproval: boolean
  readonly decidedAt: string | null
  /** A critical self-approval cools down: the plan can be applied from this time. */
  readonly notBefore?: string | null
}

/**
 * Whether the person viewing may approve, as the server answered it (the
 * approvals queue lists only what the person may decide; `ownPlan` marks a
 * self-approval). The block shows this answer and never computes it.
 */
export type ApprovalEligibility =
  | {
      readonly canApprove: true
      /** Approving is a self-approval (`ApprovalQueueItem.ownPlan`): it needs an explicit acknowledgement. */
      readonly selfApproval: boolean
    }
  | {
      readonly canApprove: false
      /** The server's reason, when it gave one (catalog text). */
      readonly reason: string | null
    }

/** What the approve and reject actions receive: the plan binding and the acknowledgement. */
export interface ApprovalBinding extends PlanBinding {
  /** The operation that waits for the decision (`POST /api/v1/approvals/{operationId}/approve`). */
  readonly operationId: string
  /** The person ticked the self-approval acknowledgement (send `acknowledgeSelfApproval: true`). */
  readonly acknowledgedSelfApproval: boolean
}

export interface ApprovalsBlockProps {
  readonly planId: string
  /**
   * `PlanView.planHash`: shown beside the actions and handed to
   * `renderApproveActions` unchanged, the same value the summary shows (see
   * `PlanBinding`).
   */
  readonly planHash: string
  /** The operation waiting for approval; `null` when none waits. */
  readonly operationId: string | null
  /** `PlanView.approvals.required`. */
  readonly required: number | null
  /** `PlanView.approvals.given`. */
  readonly given: number | null
  /** The decisions so far, oldest first. */
  readonly approvals: readonly ApprovalEntry[] | null
  /** The server's answer for the person viewing; `null` when not known (nothing is offered). */
  readonly eligibility: ApprovalEligibility | null
  /**
   * An agent made the plan (`PlanView.actor.via === 'mcp'`). Required, so a
   * page cannot leave the note out by omission.
   */
  readonly proposedByAgent: boolean
  /** The read behind this view may be out of date: no decision is offered. */
  readonly stale?: boolean
  readonly now?: NowInput
  /** The approve and reject actions, offered only when the server says the person may approve. */
  readonly renderApproveActions?: (binding: ApprovalBinding) => ReactNode
  readonly headingLevel?: HeadingLevel
}

function DecisionText({ decision }: { readonly decision: string }): ReactNode {
  if (decision === 'approved') {
    return (
      <span data-decision="approved" className="inline-flex items-center gap-1 font-medium">
        <Check aria-hidden="true" className="size-3.5" />
        Approved
      </span>
    )
  }
  if (decision === 'rejected') {
    return (
      <span
        data-decision="rejected"
        className="inline-flex items-center gap-1 font-medium text-destructive"
      >
        <X aria-hidden="true" className="size-3.5" />
        Rejected
      </span>
    )
  }
  return (
    <Words>
      <Marked text={decision} mono />
      <span className="text-foreground-light">(not a known decision)</span>
    </Words>
  )
}

function laterThan(a: string | null | undefined, b: string | null): boolean {
  if (a === null || a === undefined || b === null) return false
  const left = Date.parse(a)
  const right = Date.parse(b)
  return !Number.isNaN(left) && !Number.isNaN(right) && left > right
}

function ApprovalItem({
  approval,
  now,
}: {
  readonly approval: ApprovalEntry
  readonly now: number
}): ReactNode {
  return (
    <li
      data-approval={approval.id}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-default px-3 py-2"
    >
      <Words className="min-w-0">
        <DecisionText decision={approval.decision} />
        <span>by</span>
        {approval.approverName === undefined || approval.approverName === null ? null : (
          <UntrustedName name={approval.approverName} label="approver name" />
        )}
        <Marked text={approval.approverIdentityId} mono />
        <TimeText at={approval.decidedAt} now={now} />
        {approval.selfApproval ? (
          <span className="inline-flex items-center gap-1 rounded-sm border border-warning-500 px-1 text-xs text-warning-600">
            <ShieldAlert aria-hidden="true" className="size-3" />
            Self-approval
          </span>
        ) : null}
      </Words>
      {laterThan(approval.notBefore, approval.decidedAt) ? (
        <span className="text-foreground-light">
          The plan can be applied from <TimeText at={approval.notBefore ?? null} now={now} />, with
          a fresh confirmation.
        </span>
      ) : null}
    </li>
  )
}

/**
 * The own-plan acknowledgement of a self-approval (OD-9): a check box the
 * person ticks before approving their own plan. Controlled, so the page can
 * keep it next to the approvals and pass it to actions elsewhere.
 */
export function SelfApprovalAcknowledgement({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
}): ReactNode {
  const checkboxId = useId()
  return (
    <div data-self-approval="" className="flex items-start gap-2 text-sm">
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <label htmlFor={checkboxId}>
        This is my own plan. I approve it myself and know this is recorded prominently.
      </label>
    </div>
  )
}

/** The note that an agent proposed the plan and cannot approve it. */
export function AgentProposedNote({ id }: { readonly id?: string }): ReactNode {
  return (
    <Note tone="warning" id={id} data-agent-note="">
      <span className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-600" />
        <span>
          <strong className="font-medium">
            An agent proposed this plan; it cannot approve it.
          </strong>{' '}
          Decide on what this page shows. Nothing the agent said in its conversation counts.
        </span>
      </span>
    </Note>
  )
}

/** The decisions on the plan so far, oldest first, each with its approver and time. */
export function ApprovalDecisionList({
  approvals,
  now,
}: {
  readonly approvals: readonly ApprovalEntry[]
  readonly now?: NowInput
}): ReactNode {
  const current = useResolvedNow(now)
  return (
    <ul aria-label="Decisions" className="flex flex-col gap-2 text-sm">
      {keyedBy(approvals, (approval) => approval.id).map(({ item: approval, key }) => (
        <ApprovalItem key={key} approval={approval} now={current} />
      ))}
    </ul>
  )
}

/** The approve and reject actions for an eligible person, with the self-approval acknowledgement. */
function DecisionArea({
  planId,
  planHash,
  operationId,
  selfApproval,
  render,
}: {
  readonly planId: string
  readonly planHash: string
  readonly operationId: string
  readonly selfApproval: boolean
  readonly render: (binding: ApprovalBinding) => ReactNode
}): ReactNode {
  // The acknowledgement belongs to one plan hash and one operation: another starts unticked.
  const bindingKey = `${operationId}\n${planHash}`
  const [acknowledged, setAcknowledged] = useState<string | null>(null)
  const acknowledgedSelfApproval = selfApproval && acknowledged === bindingKey
  return (
    <div className="flex flex-col gap-2">
      <span className="flex min-w-0 flex-col items-start gap-1 text-sm">
        <span className="text-foreground-light">Your decision names this plan hash:</span>
        <FullCode text={planHash} data-full-hash="" />
      </span>
      {selfApproval ? (
        <SelfApprovalAcknowledgement
          checked={acknowledgedSelfApproval}
          onCheckedChange={(checked) => setAcknowledged(checked ? bindingKey : null)}
        />
      ) : null}
      <div data-approval-actions="offered" className="flex flex-wrap items-center gap-2">
        {render({ planId, planHash, operationId, acknowledgedSelfApproval })}
      </div>
    </div>
  )
}

/**
 * The approvals of the plan: how many are required and given, each decision
 * with its approver and time, the server's answer whether the person viewing
 * may approve (never computed here), the self-approval acknowledgement where
 * the server says approving is one, and a note when an agent proposed the
 * plan. The approve and reject actions receive the plan hash shown beside
 * them.
 */
export function ApprovalsBlock({
  planId,
  planHash,
  operationId,
  required,
  given,
  approvals,
  eligibility,
  proposedByAgent,
  stale = false,
  now,
  renderApproveActions,
  headingLevel,
}: ApprovalsBlockProps): ReactNode {
  const current = useResolvedNow(now)
  const requiredCount = knownNumber(required)
  const givenCount = knownNumber(given)
  const generatedNoteId = useId()
  // The id the earlier approvals page gave the note (`#agent-note-<operation>`), kept for its browser suites.
  const noteId = operationId === null ? generatedNoteId : `agent-note-${operationId}`

  let status: ReactNode
  if (requiredCount === undefined) {
    status = (
      <span>
        The approvals this plan needs are <NotKnown />.
      </span>
    )
  } else if (requiredCount === 0) {
    status = <span>This plan needs no approval.</span>
  } else {
    status = (
      <span>
        {givenCount === undefined ? (
          <>
            <NotKnown /> {`of ${plural(requiredCount, 'required approval')} given`}
          </>
        ) : (
          `${givenCount} of ${plural(requiredCount, 'required approval')} given`
        )}
      </span>
    )
  }

  let decision: ReactNode
  if (eligibility === null) {
    decision = (
      <p className="text-sm">
        Whether you can approve this plan is <NotKnown />, so no decision is offered.
      </p>
    )
  } else if (!eligibility.canApprove) {
    decision = (
      <div className="flex flex-col gap-1 text-sm">
        <p>You cannot approve this plan.</p>
        {eligibility.reason === null ? null : (
          <UntrustedText text={eligibility.reason} label="reason" />
        )}
      </div>
    )
  } else if (operationId === null) {
    decision = <p className="text-sm">No operation is waiting for approval.</p>
  } else if (!hashKnown(planHash)) {
    decision = <p className="text-sm">The plan hash is not known, so no decision is offered.</p>
  } else if (stale) {
    decision = (
      <p className="text-sm">
        This view may be out of date, so no decision is offered. Refresh it before you decide.
      </p>
    )
  } else {
    decision = (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {eligibility.selfApproval
            ? 'You can approve this plan. It is your own plan, so approving it is a self-approval.'
            : 'You can approve this plan.'}
        </p>
        {renderApproveActions === undefined ? null : (
          <DecisionArea
            planId={planId}
            planHash={planHash}
            operationId={operationId}
            selfApproval={eligibility.selfApproval}
            render={renderApproveActions}
          />
        )}
      </div>
    )
  }

  return (
    <PlanBlock title="Approvals" headingLevel={headingLevel} data-plan-block="approvals">
      {proposedByAgent ? <AgentProposedNote id={noteId} /> : null}
      <p data-approvals-status="" className="text-sm">
        {status}
      </p>
      {approvals === null ? (
        <p className="text-sm">
          The decisions so far are <NotKnown />.
        </p>
      ) : approvals.length === 0 ? null : (
        <ApprovalDecisionList approvals={approvals} now={current} />
      )}
      {decision}
    </PlanBlock>
  )
}
