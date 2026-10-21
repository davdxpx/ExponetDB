import type { ApprovalQueueItem, OperationRead } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import {
  AgentProposedNote,
  ApprovalDecisionList,
  type ApprovalEligibility,
  activeUntil,
  applyVerifyChecks,
  BreakGlassNote,
  EvidenceItemList,
  EvidenceStatus,
  evidenceCheckState,
  expiryStatus,
  formatRemaining,
  OverriddenRulesNote,
  type PlanCheck,
  PlanChecklist,
  PolicyRequirementList,
  PolicyRuleList,
  SelfApprovalAcknowledgement,
  usePlanClock,
} from '@exponetdb/ui-data'
import {
  formatUtc,
  type Readable,
  readableValue,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { operationPath } from '../changes/model.ts'
import {
  approvalEntriesOf,
  evidenceOf,
  type PlanSource,
  requirementsOf,
  rulesOf,
} from './plan-model.ts'

/**
 * "Before it can run": one card of rows for what stands between the plan and
 * its effect (the owner's design of 2026-10-21): the policy decision (the
 * rules that did not pass only when there are any), the approvals, the
 * staging evidence of a production migration, the expiry, and once an
 * operation applies the plan its apply and verification outcomes as two
 * separate rows (C-13) with a link to the operation. A read that failed is a
 * row that says so (C-28), never a passed or an empty one.
 */

/** Whether the person may decide now, and what the self-approval box holds. */
export interface DecisionState {
  /** The server's answer for the person; `null` when the queue could not be read. */
  readonly eligibility: ApprovalEligibility | null
  /** An operation of the plan waits for a decision (or the queue could not say). */
  readonly pending: boolean
  /** Approve and reject are offered (eligible, an operation waits, a current read). */
  readonly offered: boolean
  /** The self-approval acknowledgement, when approving is a self-approval. */
  readonly acknowledgement: {
    readonly checked: boolean
    readonly onCheckedChange: (checked: boolean) => void
  } | null
}

/** The operation that applies the plan, as read. */
export interface OperationRow {
  readonly id: string | null
  readonly read: Readable<OperationRead>
  readonly onRetry: () => void
}

/** Operation states past the decision: the plan's requirements were met when it was applied. */
const PROGRESSED: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'verifying',
  'needs_attention',
  'needs_reconciliation',
  'succeeded',
  'failed',
  'verification_failed',
])

function policyCheck(
  plan: PlanSource,
  approvalsMet: boolean,
  progressed: boolean,
  rulesHeadingId: string,
): PlanCheck {
  const rules = rulesOf(plan) ?? []
  const requirements = requirementsOf(plan)
  const children =
    rules.length === 0 && plan.overriddenRules.length === 0 ? undefined : (
      <>
        <OverriddenRulesNote rules={plan.overriddenRules} />
        {rules.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <p id={rulesHeadingId} className="m-0 text-xs text-foreground-lighter">
              {t('plans.check.policy.rules')}
            </p>
            <PolicyRuleList rules={rules} aria-labelledby={rulesHeadingId} />
          </div>
        )}
      </>
    )
  const base = { id: 'policy', title: t('plans.check.policy'), children } as const
  switch (plan.decision) {
    case 'allow':
      return { ...base, state: 'passed', line: t('plans.check.policy.allow') }
    case 'deny':
      return { ...base, state: 'blocked', line: t('plans.check.policy.deny') }
    case 'require': {
      if (progressed) return { ...base, state: 'passed', line: t('plans.check.policy.met') }
      if (requirements.every((requirement) => requirement.kind === 'approval')) {
        return {
          ...base,
          state: approvalsMet ? 'passed' : 'waiting',
          line: t('plans.check.policy.approval'),
        }
      }
      return {
        ...base,
        state: 'waiting',
        line: t('plans.check.policy.require'),
        children: (
          <>
            <PolicyRequirementList
              requirements={requirements}
              aria-label={t('plans.check.policy.requirements')}
            />
            {children}
          </>
        ),
      }
    }
    default:
      return { ...base, state: 'unknown', line: t('plans.check.policy.unknown') }
  }
}

function EligibilityText({ decision }: { readonly decision: DecisionState }): ReactNode {
  const { eligibility } = decision
  if (eligibility === null) return <p className="m-0">{t('plans.check.approvals.unknown')}</p>
  if (!eligibility.canApprove) {
    return (
      <div className="flex flex-col gap-1">
        <p className="m-0">{t('plans.check.approvals.cannot')}</p>
        {eligibility.reason === null ? null : (
          <UntrustedText text={eligibility.reason} label="reason" />
        )}
      </div>
    )
  }
  if (!decision.offered) return <p className="m-0">{t('plans.check.approvals.stale')}</p>
  return (
    <p className="m-0">
      {eligibility.selfApproval
        ? t('plans.check.approvals.canOwn')
        : t('plans.check.approvals.can')}
    </p>
  )
}

function approvalsCheck(
  plan: PlanSource,
  item: ApprovalQueueItem | undefined,
  decision: DecisionState,
): PlanCheck {
  const required = item?.required ?? plan.approvals.required
  const given =
    item === undefined
      ? plan.approvals.given
      : item.approvals.filter((approval) => approval.decision === 'approved').length
  const entries = item === undefined ? [] : approvalEntriesOf(item)
  const operationId = item?.operationId ?? plan.operationId ?? null
  const children =
    required === 0 ? undefined : (
      <>
        {plan.actor.via === 'mcp' ? (
          <AgentProposedNote id={operationId === null ? undefined : `agent-note-${operationId}`} />
        ) : null}
        {entries.length === 0 ? null : <ApprovalDecisionList approvals={entries} />}
        {decision.pending ? <EligibilityText decision={decision} /> : null}
        {decision.offered && decision.acknowledgement !== null ? (
          <SelfApprovalAcknowledgement
            checked={decision.acknowledgement.checked}
            onCheckedChange={decision.acknowledgement.onCheckedChange}
          />
        ) : null}
      </>
    )
  const base = { id: 'approvals', title: t('plans.check.approvals'), children } as const
  if (required === 0) return { ...base, state: 'passed', line: t('plans.check.approvals.none') }
  const line =
    required === 1
      ? t('plans.check.approvals.countOne', { given })
      : t('plans.check.approvals.count', { given, required })
  return { ...base, state: given >= required ? 'passed' : 'waiting', line }
}

function evidenceCheck(plan: PlanSource, production: boolean): PlanCheck | undefined {
  // The staging evidence is a condition of production migrations only (C-15).
  const evidence = production ? evidenceOf(plan) : undefined
  if (evidence === undefined) return undefined
  const children =
    evidence.breakGlass === null &&
    (evidence.items === null || evidence.items.length < 2) ? undefined : (
      <>
        <BreakGlassNote breakGlass={evidence.breakGlass} />
        {evidence.items !== null && evidence.items.length > 1 ? (
          <EvidenceItemList items={evidence.items} />
        ) : null}
      </>
    )
  return {
    id: 'evidence',
    title: t('plans.check.evidence'),
    state: evidenceCheckState(evidence.evidence),
    line: <EvidenceStatus status={evidence.evidence} />,
    children,
  }
}

function useExpiryCheck(plan: PlanSource): PlanCheck {
  const clock = usePlanClock(undefined, activeUntil(plan.state, plan.expiresAt))
  const expiry = expiryStatus(plan.expiresAt, clock)
  const base = { id: 'expiry', title: t('plans.check.expiry') } as const
  switch (plan.state) {
    case 'active':
      if (expiry.kind === 'open') {
        return {
          ...base,
          state: 'passed',
          line: t('plans.check.expiry.open', {
            at: formatUtc(plan.expiresAt) ?? plan.expiresAt,
            time: formatRemaining(expiry.remainingMs),
          }),
        }
      }
      if (expiry.kind === 'expired') {
        return { ...base, state: 'blocked', line: t('plans.check.expiry.expired') }
      }
      return { ...base, state: 'unknown', line: t('plans.check.expiry.unknown') }
    case 'consumed':
      return { ...base, state: 'passed', line: t('plans.check.expiry.used') }
    case 'expired':
      return { ...base, state: 'blocked', line: t('plans.check.expiry.expired') }
    case 'withdrawn':
      return { ...base, state: 'blocked', line: t('plans.check.expiry.withdrawn') }
    case 'invalidated':
      return { ...base, state: 'blocked', line: t('plans.check.expiry.invalidated') }
    case 'denied':
      return { ...base, state: 'blocked', line: t('plans.check.expiry.denied') }
    default:
      return { ...base, state: 'unknown', line: t('plans.check.expiry.unknown') }
  }
}

function OperationLink({ operationId }: { readonly operationId: string }): ReactNode {
  const Link = useLinkComponent()
  const href = operationPath(operationId)
  if (href === undefined) return null
  return (
    <Link href={href} className="text-primary underline focus-ring" data-operation-link="">
      {t('changes.operation.open')}
    </Link>
  )
}

function operationChecks(plan: PlanSource, operation: OperationRow): readonly PlanCheck[] {
  const base = { id: 'operation', title: t('plans.check.operation') } as const
  if (operation.id === null) {
    // The plan can still be applied: nothing ran yet. A plan that can no longer be applied
    // has no row: its expiry row says why.
    return plan.state === 'active'
      ? [{ ...base, state: 'waiting', line: t('plans.check.operation.none') }]
      : []
  }
  const value = readableValue(operation.read)
  if (value === undefined) {
    if (operation.read.state === 'failed') {
      return [
        {
          ...base,
          state: 'failed',
          line: t('plans.check.operation.failed', {
            reason: `${operation.read.error.message} (${operation.read.error.code})`,
          }),
          action: (
            <Button type="button" variant="default" size="tiny" onClick={operation.onRetry}>
              {t('plans.check.operation.retry')}
            </Button>
          ),
        },
      ]
    }
    return [{ ...base, state: 'unknown', line: t('plans.check.operation.reading') }]
  }
  const [apply, verification] = applyVerifyChecks({
    applyOutcome: value.applyOutcome,
    verificationOutcome: value.verificationOutcome,
    operationState: value.state,
  })
  return [
    { ...apply, action: <OperationLink operationId={value.id} /> },
    {
      ...verification,
      children:
        operation.read.state === 'stale' ? (
          <p role="note" className="m-0 text-foreground-light">
            {t('plans.operation.stale')}
          </p>
        ) : undefined,
    },
  ]
}

/** The checklist of the plan page. */
export function PlanChecks({
  plan,
  item,
  decision,
  operation,
  production,
}: {
  readonly plan: PlanSource
  readonly item: ApprovalQueueItem | undefined
  readonly decision: DecisionState
  readonly operation: OperationRow
  /** The plan is treated as production (its tier is not exactly `nonprod`). */
  readonly production: boolean
}): ReactNode {
  const rulesHeadingId = useId()
  const expiry = useExpiryCheck(plan)
  const operationValue = readableValue(operation.read)
  const progressed = operationValue !== undefined && PROGRESSED.has(operationValue.state)
  const approvals = approvalsCheck(plan, item, decision)
  const evidence = evidenceCheck(plan, production)
  const checks: PlanCheck[] = [
    policyCheck(plan, approvals.state === 'passed', progressed, rulesHeadingId),
    approvals,
    ...(evidence === undefined ? [] : [evidence]),
    expiry,
    ...operationChecks(plan, operation),
  ]
  return <PlanChecklist title={t('plans.checks.title')} checks={checks} headingLevel={2} />
}
