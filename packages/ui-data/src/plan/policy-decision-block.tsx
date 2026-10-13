import { AlertTriangle, Check, CircleHelp, Lock, type LucideIcon, X } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import { type HeadingLevel, UntrustedText } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'

import { formatSeconds, knownNumber, knownText, plural } from './format.ts'
import { PlanBlock } from './plan-frame.tsx'
import { INLINE_ICON, keyedBy, Marked, Note, NotKnown, Words } from './shared.tsx'

/** A requirement of the decision (`PolicyRequirement`, by `kind`). */
export interface PolicyRequirementView {
  /** `approval`, `reauth`, `backup`, `maintenance_window`, `break_glass`. */
  readonly kind: string
  /** `approval`: how many approvals. */
  readonly count?: number | null
  /** `approval`: the permission an approver needs (`plans.approve`). */
  readonly permission?: string | null
  /** `reauth`: how fresh the re-authentication must be. */
  readonly withinSeconds?: number | null
  /** `backup`: an ISO 8601 duration the backup must be newer than. */
  readonly newerThan?: string | null
  /** `maintenance_window`: the window. */
  readonly windowId?: string | null
  /** `break_glass`: the rules a grant must name. */
  readonly rules?: readonly string[] | null
}

/** A rule that did not pass (`PolicyRuleResult`). */
export interface PolicyRuleView {
  readonly id: string
  /** `deny`, `require`, `warn`. */
  readonly severity: string | null
  /** `pass`, `fail`, `not_applicable`, `unknown`. */
  readonly result: string | null
  /** Catalog text of the rule; may name objects, so it is shown as untrusted text. */
  readonly message: string | null
  readonly remediation?: string | null
  readonly overridableByBreakGlass?: boolean | null
}

export interface PolicyDecisionBlockProps {
  /** `PlanView.decision`: `allow`, `require`, `deny`. */
  readonly decision: string | null
  /** `PlanView.requirements`. */
  readonly requirements: readonly PolicyRequirementView[] | null
  /** `PlanView.policyRules`: the rules that failed, warned or were unknown; `null` when not given. */
  readonly rules: readonly PolicyRuleView[] | null
  /** `PlanView.overriddenRules`: rules a break-glass grant overrode. */
  readonly overriddenRules?: readonly string[] | null
  readonly headingLevel?: HeadingLevel
}

const DECISIONS: Readonly<
  Record<string, { readonly label: string; readonly meaning: string; readonly icon: LucideIcon }>
> = {
  allow: { label: 'Allow', meaning: 'The policy allows this plan.', icon: Check },
  require: {
    label: 'Allow with requirements',
    meaning: 'The policy allows this plan once every requirement below is met.',
    icon: Lock,
  },
  deny: { label: 'Deny', meaning: 'The policy denies this plan. It cannot be applied.', icon: X },
}

const SEVERITIES: Readonly<Record<string, string>> = {
  deny: 'the rule denies',
  require: 'the rule requires',
  warn: 'the rule warns',
}

const RESULTS: Readonly<Record<string, string>> = {
  pass: 'passed',
  fail: 'failed',
  not_applicable: 'not applicable',
  unknown: 'could not be evaluated',
}

function DecisionValue({ decision }: { readonly decision: string | null }): ReactNode {
  const known = knownText(decision)
  if (known === undefined) {
    return (
      <p className="text-sm">
        The decision is <NotKnown />.
      </p>
    )
  }
  const text = Object.hasOwn(DECISIONS, known) ? DECISIONS[known] : undefined
  if (text === undefined) {
    return (
      <Words className="text-sm">
        <CircleHelp aria-hidden="true" className={INLINE_ICON} />
        <Marked text={known} mono />
        <span className="text-foreground-light">(not a known decision)</span>
      </Words>
    )
  }
  const Icon = text.icon
  return (
    <p className="text-sm">
      <Words>
        <strong
          data-decision={known}
          className={cn('font-medium', known === 'deny' && 'text-destructive')}
        >
          <Icon aria-hidden="true" className={cn(INLINE_ICON, 'mr-1')} />
          {text.label}
        </strong>
        <span className="text-foreground-light">{text.meaning}</span>
      </Words>
    </p>
  )
}

function RuleList({ rules }: { readonly rules: readonly string[] }): ReactNode {
  return (
    <Words>
      {keyedBy(rules, (rule) => rule).map(({ item: rule, key }, index) => (
        <Marked key={key} text={index < rules.length - 1 ? `${rule},` : rule} mono />
      ))}
    </Words>
  )
}

function RequirementText({
  requirement,
}: {
  readonly requirement: PolicyRequirementView
}): ReactNode {
  switch (requirement.kind) {
    case 'approval': {
      const count = knownNumber(requirement.count)
      const permission = knownText(requirement.permission)
      return (
        <Words>
          {count === undefined ? (
            <span>
              Approvals (how many is <NotKnown />)
            </span>
          ) : (
            <span>{plural(count, 'approval')}</span>
          )}
          {permission === undefined ? <span>by an approver</span> : <span>by a person with</span>}
          {permission === undefined ? null : <Marked text={permission} mono />}
        </Words>
      )
    }
    case 'reauth': {
      const seconds = knownNumber(requirement.withinSeconds)
      return seconds === undefined ? (
        <span>
          A fresh re-authentication (within <NotKnown />)
        </span>
      ) : (
        <span>{`A fresh re-authentication within ${formatSeconds(seconds)}`}</span>
      )
    }
    case 'backup': {
      const newerThan = knownText(requirement.newerThan)
      return (
        <Words>
          <span>A verified backup newer than</span>
          {newerThan === undefined ? <NotKnown /> : <Marked text={newerThan} mono />}
        </Words>
      )
    }
    case 'maintenance_window': {
      const windowId = knownText(requirement.windowId)
      return (
        <Words>
          <span>Inside maintenance window</span>
          {windowId === undefined ? <NotKnown /> : <Marked text={windowId} mono />}
        </Words>
      )
    }
    case 'break_glass': {
      const rules = requirement.rules ?? null
      return (
        <Words>
          <span>A break-glass grant for the rules</span>
          {rules === null || rules.length === 0 ? <NotKnown /> : <RuleList rules={rules} />}
        </Words>
      )
    }
    default:
      return (
        <Words>
          <AlertTriangle aria-hidden="true" className={cn(INLINE_ICON, 'text-warning-600')} />
          <span>Requirement</span>
          <Marked text={requirement.kind} mono />
          <span className="text-foreground-light">
            (not known to this version of the Web App; nothing is offered until it is met)
          </span>
        </Words>
      )
  }
}

function LabeledEnum({
  value,
  labels,
  what,
}: {
  readonly value: string | null
  readonly labels: Readonly<Record<string, string>>
  readonly what: string
}): ReactNode {
  if (value === null || value === '') {
    return (
      <span>
        {what} <NotKnown />
      </span>
    )
  }
  const label = Object.hasOwn(labels, value) ? labels[value] : undefined
  return label === undefined ? <Marked text={value} mono /> : <span>{label}</span>
}

function RuleItem({ rule }: { readonly rule: PolicyRuleView }): ReactNode {
  return (
    <li
      data-rule={rule.id}
      data-rule-result={rule.result ?? undefined}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-default px-3 py-2"
    >
      <Words>
        <Marked text={rule.id} mono className="font-medium" />
        <span className="text-foreground-light">
          (<LabeledEnum value={rule.result} labels={RESULTS} what="result" />;{' '}
          <LabeledEnum value={rule.severity} labels={SEVERITIES} what="severity" />)
        </span>
        {rule.overridableByBreakGlass === true ? (
          <span className="text-xs text-foreground-light">break-glass can override it</span>
        ) : null}
      </Words>
      {rule.message === null ? (
        <span className="text-sm">
          Message <NotKnown />
        </span>
      ) : (
        <UntrustedText text={rule.message} label="rule message" />
      )}
      {rule.remediation === undefined || rule.remediation === null ? null : (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-foreground-lighter">What to do</span>
          <UntrustedText text={rule.remediation} label="remediation" />
        </div>
      )}
    </li>
  )
}

/**
 * The policy decision the server recorded in the plan: allow, allow with
 * requirements, or deny; the requirements (approvals, re-authentication,
 * backup, maintenance window, break-glass); the rules that failed, warned or
 * could not be evaluated, with their ids; and the rules a break-glass grant
 * overrode. The block decides nothing (C-10).
 */
export function PolicyDecisionBlock({
  decision,
  requirements,
  rules,
  overriddenRules,
  headingLevel,
}: PolicyDecisionBlockProps): ReactNode {
  const requirementsId = useId()
  const rulesId = useId()
  return (
    <PlanBlock title="Policy decision" headingLevel={headingLevel} data-plan-block="policy">
      <DecisionValue decision={decision} />
      {overriddenRules === undefined ||
      overriddenRules === null ||
      overriddenRules.length === 0 ? null : (
        <Note tone="warning">
          <Words>
            <strong className="font-medium">Overridden by break-glass:</strong>
            <RuleList rules={overriddenRules} />
          </Words>
        </Note>
      )}
      <div className="flex flex-col gap-1">
        <p id={requirementsId} className="text-xs text-foreground-lighter">
          Requirements
        </p>
        {requirements === null ? (
          <p className="text-sm">
            <NotKnown />
          </p>
        ) : requirements.length === 0 ? (
          <p className="text-sm">None</p>
        ) : (
          <ul aria-labelledby={requirementsId} className="flex flex-col gap-1 text-sm">
            {keyedBy(requirements, (r) => r.kind).map(({ item: requirement, key }) => (
              <li key={key} data-requirement={requirement.kind}>
                <RequirementText requirement={requirement} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p id={rulesId} className="text-xs text-foreground-lighter">
          Rules that did not pass
        </p>
        {rules === null ? (
          <p className="text-sm">
            <NotKnown />
          </p>
        ) : rules.length === 0 ? (
          <p className="text-sm">None</p>
        ) : (
          <ul aria-labelledby={rulesId} className="flex flex-col gap-2 text-sm">
            {keyedBy(rules, (rule) => rule.id).map(({ item: rule, key }) => (
              <RuleItem key={key} rule={rule} />
            ))}
          </ul>
        )}
      </div>
    </PlanBlock>
  )
}
