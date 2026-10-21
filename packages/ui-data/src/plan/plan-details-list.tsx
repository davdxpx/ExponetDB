import { type NowInput, UntrustedName, useResolvedNow } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import { hashKnown, knownText } from './format.ts'
import { NewestBackupValue, type NewestBackupView } from './plan-evidence-block.tsx'
import {
  ClassificationsValue,
  ClassValue,
  ClientValue,
  CreatorValue,
  type PlanCreator,
  UnknownName,
} from './plan-values.tsx'
import {
  PolicyRequirementList,
  type PolicyRequirementView,
  type PolicyRuleView,
} from './policy-decision-block.tsx'
import {
  CopyButton,
  type FactItem,
  Facts,
  FullCode,
  keyedBy,
  Marked,
  NotKnown,
  TimeText,
  Words,
} from './shared.tsx'

/** The ids of what a plan changes; each is shown only when present. */
export interface PlanDetailsSubject {
  readonly targetPath?: string | null
  readonly targetId?: string | null
  readonly clusterId?: string | null
  readonly nodeId?: string | null
  /** The server a node plan names in its change (`change.content.serverId`). */
  readonly serverId?: string | null
}

export interface PlanDetailsListProps {
  /** `PlanView.id`, with a copy button. */
  readonly planId: string
  /** `PlanView.planHash`, in full with a copy button (the same value the actions send). */
  readonly planHash: string
  /** `PlanView.kind`. */
  readonly kind: string | null
  /** `PlanView.class`, with its meaning. */
  readonly planClass: string | null
  readonly subject: PlanDetailsSubject
  /**
   * `PlanView.subject.tier` in words. `null` is a plan without a tier (a server
   * or node plan), which the page treats as production (fails closed).
   */
  readonly tier: string | null
  /**
   * Statement classes found by the analysis. Leave it out where it does not
   * apply (a plan that is not a migration); `null` is "not known".
   */
  readonly classifications?: readonly string[] | null
  readonly creator: PlanCreator | null
  /**
   * The client the plan was made through (`PlanView.clientId`) and its own
   * name (untrusted, never verified). Leave it out for a plan made without a
   * client; a `null` name is "not known".
   */
  readonly client?: { readonly id: string | null; readonly name: string | null }
  readonly createdAt: string | null
  readonly expiresAt: string | null
  /** The operation that applies the plan; leave it out while there is none. */
  readonly operationId?: string | null
  /** `PlanView.requirements`; shown only when there are any. */
  readonly requirements?: readonly PolicyRequirementView[]
  /** `PlanView.policyRules`: the rules that did not pass; leave it out when the read had none. */
  readonly rules?: readonly PolicyRuleView[] | null
  /** The schema fingerprint a migration plan binds; leave it out for other plans. */
  readonly schemaFingerprint?: string | null
  /** The newest backup (Wave 9); leave it out where it does not apply, `null` is "not known". */
  readonly newestBackup?: NewestBackupView | null
  readonly now?: NowInput
}

function TierWords({ tier }: { readonly tier: string | null }): ReactNode {
  if (tier === 'prod' || tier === 'production') return <span data-plan-tier="prod">Production</span>
  if (tier === 'nonprod') return <span data-plan-tier="nonprod">Non-production</span>
  if (tier === null || tier === '') {
    return <span data-plan-tier="none">None; the page treats the plan as production</span>
  }
  return <UnknownName value={tier} what="tier" />
}

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== ''
}

/**
 * The technical details of a plan as one list: ids and the plan hash (each
 * with a copy button), kind, class with its meaning, the subject's ids and
 * tier, statement classes, creator and client, exact times, the operation,
 * the requirements and the rules that did not pass, the bound schema
 * fingerprint. A fact that does not apply to the plan is left out; "not
 * known" is shown only where a fact applies and the page could not establish
 * it. Every foreign string is rendered as marked text.
 */
export function PlanDetailsList({
  planId,
  planHash,
  kind,
  planClass,
  subject,
  tier,
  classifications,
  creator,
  client,
  createdAt,
  expiresAt,
  operationId,
  requirements,
  rules,
  schemaFingerprint,
  newestBackup,
  now,
}: PlanDetailsListProps): ReactNode {
  const current = useResolvedNow(now)
  const items: FactItem[] = [
    {
      id: 'plan-id',
      label: 'Plan ID',
      value: (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Marked text={planId} mono />
          <CopyButton text={planId} label="plan ID" />
        </span>
      ),
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
    {
      id: 'kind',
      label: 'Kind',
      value: present(kind) ? <Marked text={kind} mono /> : <NotKnown />,
    },
    { id: 'class', label: 'Plan class', value: <ClassValue planClass={planClass} /> },
  ]
  if (present(subject.targetPath)) {
    items.push({ id: 'target', label: 'Target', value: <FullCode text={subject.targetPath} /> })
  }
  if (present(subject.targetId)) {
    items.push({
      id: 'target-id',
      label: 'Target ID',
      value: <Marked text={subject.targetId} mono />,
    })
  }
  if (present(subject.clusterId)) {
    items.push({
      id: 'cluster',
      label: 'Cluster ID',
      value: <Marked text={subject.clusterId} mono />,
    })
  }
  if (present(subject.serverId)) {
    items.push({ id: 'server', label: 'Server ID', value: <Marked text={subject.serverId} mono /> })
  }
  if (present(subject.nodeId)) {
    items.push({ id: 'node', label: 'Node ID', value: <Marked text={subject.nodeId} mono /> })
  }
  items.push({ id: 'tier', label: 'Tier', value: <TierWords tier={tier} /> })
  if (classifications !== undefined) {
    items.push({
      id: 'classifications',
      label: 'Statement classes',
      value: <ClassificationsValue classifications={classifications} />,
    })
  }
  items.push(
    { id: 'creator', label: 'Created by', value: <CreatorValue creator={creator} /> },
    { id: 'through', label: 'Through', value: <ClientValue creator={creator} /> },
  )
  if (client !== undefined) {
    items.push({
      id: 'client-name',
      label: 'Client',
      value: (
        <Words>
          {client.name === null ? (
            <NotKnown />
          ) : (
            <span className="client-name">
              <UntrustedName name={client.name} unverified label="client name" />
            </span>
          )}
          {client.id === null ? null : <Marked text={client.id} mono />}
        </Words>
      ),
    })
  }
  items.push(
    { id: 'created', label: 'Created', value: <TimeText at={createdAt} now={current} /> },
    { id: 'expires', label: 'Expires', value: <TimeText at={expiresAt} withAge={false} /> },
  )
  if (present(operationId)) {
    items.push({
      id: 'operation',
      label: 'Operation ID',
      value: <Marked text={operationId} mono />,
    })
  }
  if (requirements !== undefined && requirements.length > 0) {
    items.push({
      id: 'requirements',
      label: 'Requirements',
      value: <PolicyRequirementList requirements={requirements} aria-label="Requirements" />,
    })
  }
  if (rules !== undefined) {
    items.push({
      id: 'rules',
      label: 'Rules that did not pass',
      value:
        rules === null ? (
          <NotKnown />
        ) : rules.length === 0 ? (
          <span>None</span>
        ) : (
          <Words>
            {keyedBy(rules, (rule) => rule.id).map(({ item: rule, key }, index) => (
              <Marked key={key} text={index < rules.length - 1 ? `${rule.id},` : rule.id} mono />
            ))}
          </Words>
        ),
    })
  }
  if (schemaFingerprint !== undefined) {
    items.push({
      id: 'schema-fingerprint',
      label: 'Schema state',
      value:
        schemaFingerprint === null || knownText(schemaFingerprint) === undefined ? (
          <NotKnown />
        ) : (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span>
              bound to fingerprint <FullCode text={schemaFingerprint} />
            </span>
            <span className="text-foreground-light">
              Any schema change before the apply makes the plan stale.
            </span>
          </span>
        ),
    })
  }
  if (newestBackup !== undefined) {
    items.push({
      id: 'newest-backup',
      label: 'Newest backup',
      value: <NewestBackupValue backup={newestBackup} now={current} />,
    })
  }
  return <Facts items={items} />
}
