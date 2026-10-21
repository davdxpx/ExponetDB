import type {
  ApprovalQueueItem,
  OperationNextAction,
  OperationRead,
} from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  type ApprovalBinding,
  type ApprovalEligibility,
  activeUntil,
  expiryStatus,
  hashKnown,
  NeedsAttentionNote,
  PlanAnalysisBlock,
  PlanBlock,
  PlanDetailsList,
  PlanFrame,
  planActionAvailability,
  RawPlanTextBlock,
  usePlanClock,
} from '@exponetdb/ui-data'
import {
  isProductionTier,
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  type Readable,
  ReadableView,
  readableValue,
  TierChip,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { type Me, useMe } from '../../lib/session/guard.tsx'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { VerifyAgainAction } from '../changes/operation-actions.tsx'
import { ViewSqlButton } from '../migrations/bundle-sheet.tsx'
import { ApplyAction, DecisionActions, type PageMessage } from './decision-actions.tsx'
import { approvalQueueQuery, operationQuery, planKeys, planQuery } from './keys.ts'
import { type DecisionState, PlanChecks } from './plan-checks.tsx'
import {
  ActorLine,
  HeaderFacts,
  KindTitle,
  OperationStateBadge,
  PLAN_ACTOR_WORDS,
  PlanExpiry,
  PlanStateBadge,
} from './plan-heading.tsx'
import {
  analysisOf,
  confirmFactsOf,
  evidenceOf,
  filesOf,
  isPlanId,
  type PlanSource,
  requirementsOf,
  rulesOf,
} from './plan-model.ts'
import { migrationCountOf, serverIdOf, type TitleRefs } from './plan-title.ts'
import { planBundlesOf, StoredFilesBlock, useStoredFiles } from './stored-files.tsx'
import { canOfferWithdraw, WithdrawAction } from './withdraw-action.tsx'

/**
 * The plan review page `/changes/plans/<id>` (information-architecture.md
 * §5, ADR-0029; the owner's design of 2026-10-21). It reads top-down:
 *
 * 1. The header: a title that says what happens (the plan's kind in words and
 *    its subject as untrusted text), the plan state, the expiry countdown and
 *    who created it through which interface; the production chip beside the
 *    title; the actions on the right (Apply, Approve and Reject for a person
 *    the server lets decide, Withdraw), which wrap below the title on phones.
 * 2. The production frame with one sentence (a plan whose tier is not exactly
 *    `nonprod` is production, failing closed; a plan without a tier says so).
 * 3. "Before it can run" (`.review .computed`): the policy decision with the
 *    rules that did not pass, the approvals with the agent note, the
 *    decisions and the self-approval acknowledgement, the staging evidence of
 *    a production migration, the expiry, and the operation's apply and
 *    verification outcomes as separate rows.
 * 4. "What changes": the migrations with "View SQL", their analysis and the
 *    files the plan runs as numbered text (`.raw`); for other kinds the stored
 *    change as data in a closed disclosure.
 * 5. "Technical details", closed: ids, the full plan hash, class, creator and
 *    client, exact times, requirements and rules. A fact that does not apply
 *    to the plan's kind is left out; "not known" only where it applies.
 *
 * The plan comes from the approvals queue when an operation of it waits for
 * the person (the queue carries the review: the client's name and the stored
 * files), else from `GET /plans/{id}`; then the files come from the bundle
 * store, matched by the revision and digest the plan binds. Whether the
 * person may approve is the server's answer (the queue lists only what the
 * person may decide). Every action sends the hash the page read
 * (`PlanBinding`) through the plan confirmation, with re-authentication.
 */
export function PlanPage({ planId }: { readonly planId: string }): ReactNode {
  // A path that is not a plan id renders "page not found" and requests nothing.
  if (!isPlanId(planId)) return <NotFoundPage />
  return <ValidPlanPage key={planId} planId={planId} />
}

interface PageData {
  readonly plan: PlanSource
  /** The queue item of this plan: an operation waits for the person's decision. */
  readonly item: ApprovalQueueItem | undefined
  /** The queue could not be read: eligibility and the stored files are not known. */
  readonly queueFailed: boolean
}

interface Message {
  readonly kind: 'status' | 'alert'
  readonly text: string
}

function useMessages(): readonly [Message | null, PageMessage] {
  const [message, setMessage] = useState<Message | null>(null)
  return [message, (kind, text) => setMessage({ kind, text })] as const
}

/** The one sentence of the production frame: a plan without a tier says why it is production. */
function productionNotice(tier: string | null): string {
  return tier === null ? t('plans.production.noTier') : t('plans.production.notice')
}

function ValidPlanPage({ planId }: { readonly planId: string }): ReactNode {
  const { client } = useApi()
  const queryClient = useQueryClient()
  const me = useMe()
  const planRead = useQuery(planQuery(client, planId))
  const queueRead = useQuery(approvalQueueQuery(client))
  const [message, onMessage] = useMessages()
  // The self-approval acknowledgement belongs to one operation and one plan hash.
  const [acknowledged, setAcknowledged] = useState<string | null>(null)

  const planReadable = toReadable(planRead)
  const queueReadable = toReadable(queueRead)
  const queue = readableValue(queueReadable)
  const item = queue?.items.find((entry) => entry.planId === planId)

  let readable: Readable<PageData>
  let notFound = false
  if (
    item?.review !== undefined &&
    queueReadable.state !== 'loading' &&
    queueReadable.state !== 'failed'
  ) {
    // The queue's review carries the full plan view, the client's name and the stored files.
    readable = { ...queueReadable, value: { plan: item.review.plan, item, queueFailed: false } }
  } else if (queueReadable.state === 'loading' || planReadable.state === 'loading') {
    readable = { state: 'loading' }
  } else if (planReadable.state === 'failed') {
    // A plan that does not exist and one the person may not read look the same.
    notFound = classifyFailure(planRead.error).kind === 'not_found'
    readable = planReadable
  } else {
    const queueFailed = queueReadable.state === 'failed'
    const value: PageData = { plan: planReadable.value, item, queueFailed }
    readable =
      queueFailed && planReadable.state === 'ready'
        ? {
            state: 'partial',
            value,
            source: planReadable.source,
            observedAt: planReadable.observedAt,
            missing: [
              t('plans.queue.missing', {
                reason: describeError(queueRead.error),
              }),
            ],
          }
        : { ...planReadable, value }
  }

  const value = readableValue(readable)
  const operationId =
    value === undefined ? null : (value.item?.operationId ?? value.plan.operationId ?? null)
  const operationRead = useQuery(operationQuery(client, operationId ?? ''))

  if (notFound) return <NotFoundPage />

  const stale = readable.state === 'stale'
  const decision =
    value === undefined
      ? undefined
      : decisionStateOf(value, operationRead.data, stale, acknowledged, setAcknowledged)
  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: planKeys.detail(planId) })
    void queueRead.refetch()
  }

  return (
    <>
      <PlanHeader
        planId={planId}
        data={value}
        me={me}
        stale={stale}
        decision={decision}
        operation={operationRead.data}
        onMessage={onMessage}
      />
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        {/* Live regions stay in the page while empty, so a new message is announced. */}
        <div className="flex flex-col">
          <p className="status text-sm" role="status">
            {message?.kind === 'status' ? message.text : ''}
          </p>
          <p className="alert text-sm text-destructive" role="alert">
            {message?.kind === 'alert' ? message.text : ''}
          </p>
        </div>
        <ReadableView
          readable={readable}
          what={t('plans.read.what')}
          onRetry={refetch}
          onRefresh={refetch}
          busy={planRead.isFetching || queueRead.isFetching}
          headingLevel={2}
          ready={(data) =>
            decision === undefined ? null : (
              <PlanReview
                data={data}
                decision={decision.state}
                operationId={operationId}
                operationRead={operationRead}
                onMessage={onMessage}
              />
            )
          }
        />
      </PageContainer>
    </>
  )
}

interface PageDecision {
  readonly state: DecisionState
  /** What Approve and Reject send, when they are offered. */
  readonly binding: ApprovalBinding | null
}

/**
 * Whether the person may decide now: the server's answer (the queue lists
 * every operation the person may decide; `ownPlan` marks a self-approval),
 * an operation that waits, a known plan hash and a current read. Nothing is
 * computed beyond that; the server checks every decision again.
 */
function decisionStateOf(
  data: PageData,
  operation: OperationRead | undefined,
  stale: boolean,
  acknowledged: string | null,
  setAcknowledged: (key: string | null) => void,
): PageDecision {
  const { plan, item } = data
  const eligibility: ApprovalEligibility | null =
    item !== undefined
      ? { canApprove: true, selfApproval: item.ownPlan }
      : data.queueFailed
        ? null
        : { canApprove: false, reason: null }
  const pending = item !== undefined || data.queueFailed || operation?.state === 'awaiting_approval'
  const offered = item !== undefined && hashKnown(plan.planHash) && !stale
  const key = item === undefined ? null : `${item.operationId}\n${plan.planHash}`
  const selfApproval = item?.ownPlan === true
  const acknowledgedSelfApproval = selfApproval && key !== null && acknowledged === key
  return {
    state: {
      eligibility,
      pending,
      offered,
      acknowledgement:
        selfApproval && key !== null
          ? {
              checked: acknowledgedSelfApproval,
              onCheckedChange: (checked) => setAcknowledged(checked ? key : null),
            }
          : null,
    },
    binding:
      offered && item !== undefined
        ? {
            planId: plan.id,
            planHash: plan.planHash,
            operationId: item.operationId,
            acknowledgedSelfApproval,
          }
        : null,
  }
}

function titleRefsOf(plan: PlanSource): TitleRefs {
  return {
    targetPath: plan.subject.targetPath,
    targetId: plan.subject.targetId,
    clusterId: plan.subject.clusterId,
    nodeId: plan.subject.nodeId,
    serverId: serverIdOf(plan.change?.content),
  }
}

function PlanHeader({
  planId,
  data,
  me,
  stale,
  decision,
  operation,
  onMessage,
}: {
  readonly planId: string
  readonly data: PageData | undefined
  readonly me: Me
  readonly stale: boolean
  readonly decision: PageDecision | undefined
  /** The operation that applies the plan, when it was read. */
  readonly operation: OperationRead | undefined
  readonly onMessage: PageMessage
}): ReactNode {
  const plan = data?.plan
  // Production unless the tier is exactly `nonprod` (fails closed); said once, beside the title.
  const production = plan !== undefined && isProductionTier(plan.subject.tier)
  return (
    <PageHeader size="large">
      <PageHeaderMeta className="@xl:items-start">
        <PageHeaderSummary className="min-w-0">
          <PageHeaderTitle productionCue={production ? <TierChip tier="prod" /> : undefined}>
            {plan === undefined ? (
              t('plans.page.title')
            ) : (
              <KindTitle
                kind={plan.kind}
                refs={titleRefsOf(plan)}
                migrationCount={
                  plan.kind === 'migration.apply' ? migrationCountOf(plan.change?.content) : null
                }
              />
            )}
          </PageHeaderTitle>
          <PageHeaderDescription>
            {plan === undefined ? (
              <code className="font-mono text-xs">{planId}</code>
            ) : (
              <HeaderFacts>
                {/* A used plan's own state no longer says where the change stands: its operation's does. */}
                {plan.state === 'consumed' && operation !== undefined ? (
                  <OperationStateBadge state={operation.state} />
                ) : (
                  <PlanStateBadge state={plan.state} />
                )}
                <PlanExpiry state={plan.state} expiresAt={plan.expiresAt} />
                <ActorLine actor={plan.actor} meId={me.identity.id} words={PLAN_ACTOR_WORDS} />
              </HeaderFacts>
            )}
          </PageHeaderDescription>
        </PageHeaderSummary>
        {data === undefined || decision === undefined ? null : (
          <PlanHeaderActions
            data={data}
            me={me}
            stale={stale}
            binding={decision.binding}
            onMessage={onMessage}
          />
        )}
      </PageHeaderMeta>
    </PageHeader>
  )
}

/**
 * The plan's actions in the header: Apply while the plan is active, before its
 * expiry, with a known hash and from a current read (`planActionAvailability`);
 * Approve and Reject when the server lets the person decide an operation that
 * waits; Withdraw on the person's own active plan made in the Web App. The
 * actions are the existing ones, with their confirmations and re-authentication.
 */
function PlanHeaderActions({
  data,
  me,
  stale,
  binding,
  onMessage,
}: {
  readonly data: PageData
  readonly me: Me
  readonly stale: boolean
  readonly binding: ApprovalBinding | null
  readonly onMessage: PageMessage
}): ReactNode {
  const { plan, item } = data
  const clock = usePlanClock(undefined, activeUntil(plan.state, plan.expiresAt))
  const expiry = expiryStatus(plan.expiresAt, clock)
  const availability = planActionAvailability({
    state: plan.state,
    expiry,
    stale,
    planHash: plan.planHash,
  })
  const mine = item?.approvals.find(
    (approval) =>
      approval.decision === 'approved' &&
      approval.selfApproval &&
      approval.approverIdentityId === me.identity.id,
  )
  const release =
    mine !== undefined && Date.parse(mine.notBefore) > Date.parse(mine.decidedAt)
      ? { notBefore: mine.notBefore }
      : undefined
  const withdraw = availability.offered && canOfferWithdraw(plan, me.identity.id)
  if (!availability.offered && binding === null) {
    // An active plan whose actions are withheld for a reason of this view (an out-of-date read,
    // a hash or an expiry that is not known) says why where the actions would be; a plan that
    // can no longer be applied says so in its expiry row.
    if (plan.state !== 'active' || expiry.kind === 'expired') return null
    return (
      <PageHeaderAside className="sm:max-w-sm">
        <p data-plan-actions="withheld" className="m-0 text-sm text-foreground-light">
          {availability.reason}
        </p>
      </PageHeaderAside>
    )
  }
  return (
    <PageHeaderAside className="flex-wrap items-start sm:max-w-md">
      <div data-plan-actions="offered" className="flex flex-wrap items-start gap-2">
        {availability.offered ? (
          <ApplyAction
            plan={plan}
            planHash={plan.planHash}
            onMessage={onMessage}
            variant="primary"
          />
        ) : null}
        {binding === null ? null : (
          <DecisionActions
            binding={binding}
            plan={plan}
            selfApproval={item?.ownPlan === true}
            release={release}
            onMessage={onMessage}
          />
        )}
        {withdraw ? <WithdrawAction plan={plan} onMessage={onMessage} /> : null}
      </div>
    </PageHeaderAside>
  )
}

/**
 * Lines of a stored file shown before "Show more lines". The Wave 7 page
 * showed every line; a statement in the collapsed part is named above the
 * control, and the analysis lists every statement with its line first.
 */
export const RAW_LINES_SHOWN = 1_000

function PlanReview({
  data,
  decision,
  operationId,
  operationRead,
  onMessage,
}: {
  readonly data: PageData
  readonly decision: DecisionState
  readonly operationId: string | null
  readonly operationRead: UseQueryResult<OperationRead>
  readonly onMessage: PageMessage
}): ReactNode {
  const { plan, item } = data
  const isMigration = plan.kind.startsWith('migration.')
  // Production unless the tier is exactly `nonprod` (fails closed).
  const production = isProductionTier(plan.subject.tier)
  const read = toReadable(operationRead)
  const operation = readableValue(read)
  return (
    <ul className="cards m-0 flex list-none flex-col p-0" aria-label={t('plans.review.label')}>
      <li
        className={cn('card', item !== undefined && 'focused')}
        data-operation={operationId ?? undefined}
      >
        <PlanFrame production={production} notice={productionNotice(plan.subject.tier)}>
          <div className="review flex min-w-0 flex-col gap-6">
            <div className="computed flex min-w-0 flex-col gap-4" data-review-part="computed">
              <PlanChecks
                plan={plan}
                item={item}
                decision={decision}
                production={production}
                operation={{
                  id: operationId,
                  read,
                  onRetry: () => void operationRead.refetch(),
                }}
              />
              {operation === undefined ? null : (
                <OperationAttention
                  operation={operation}
                  plan={plan}
                  stale={read.state === 'stale'}
                  onMessage={onMessage}
                />
              )}
            </div>
            <WhatChanges data={data} isMigration={isMigration} />
            <PlanTechnicalDetails
              data={data}
              operationId={operationId}
              isMigration={isMigration}
              production={production}
            />
          </div>
        </PlanFrame>
      </li>
    </ul>
  )
}

/** "What changes": the migrations, their analysis and their files; the stored change otherwise. */
function WhatChanges({
  data,
  isMigration,
}: {
  readonly data: PageData
  readonly isMigration: boolean
}): ReactNode {
  const { plan, item } = data
  const headingId = useId()
  const queryClient = useQueryClient()
  const analysis = analysisOf(plan)
  const files = item?.review === undefined ? undefined : filesOf(item.review)
  // Without the queue's review (not an approver, nothing waiting, the queue unreadable), every
  // reader of the plan sees the files it runs from the bundle store, matched by its digest.
  const stored = useStoredFiles(plan, isMigration && files === undefined)
  return (
    <section
      aria-labelledby={headingId}
      data-plan-section="changes"
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 id={headingId} className="text-lg font-medium text-foreground">
        {t('plans.changes.title')}
      </h2>
      {!isMigration ? (
        <StoredChange plan={plan} />
      ) : (
        <>
          <PlanBundles plan={plan} />
          {analysis === undefined ? null : (
            <PlanAnalysisBlock
              headingLevel={3}
              overall={analysis.overall}
              migrations={analysis.migrations}
            />
          )}
          {files === undefined && stored !== undefined ? (
            <StoredFilesBlock
              readable={stored}
              collapsedLines={RAW_LINES_SHOWN}
              headingLevel={3}
              onRetry={() => void queryClient.invalidateQueries({ queryKey: ['bundles'] })}
            />
          ) : (
            <RawPlanTextBlock
              headingLevel={3}
              files={files?.files ?? null}
              omitted={files?.omitted ?? null}
              runs={files?.runs ?? null}
              collapsedLines={RAW_LINES_SHOWN}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * The bundles a migration plan names, each with "View SQL": the side panel
 * of the stored bundle (its revisions, every file as numbered text, its runs
 * on the plan's target). Buttons only; the panel opens outside the review.
 */
function PlanBundles({ plan }: { readonly plan: PlanSource }): ReactNode {
  const bundles = planBundlesOf(plan)
  if (bundles === undefined || bundles.items.length === 0) return null
  const targetPath = plan.subject.targetPath ?? undefined
  return (
    <PlanBlock
      title={t('plans.bundles.title')}
      headingLevel={3}
      data-plan-block="bundles"
      description={t('plans.bundles.description')}
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {bundles.items.map((item) => (
          <li
            key={item.migrationId}
            data-plan-bundle={item.migrationId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            {item.name === null ? null : (
              <UntrustedName name={item.name} label={t('plans.bundles.name')} />
            )}
            <span className="font-mono text-xs text-foreground-lighter">{item.migrationId}</span>
            {item.revision === null ? null : (
              <span className="text-xs text-foreground-light">
                {t('plans.bundles.revision', { revision: item.revision })}
              </span>
            )}
            <ViewSqlButton
              bundle={{
                projectId: bundles.projectId,
                migrationId: item.migrationId,
                name: item.name ?? undefined,
                targetPath,
                revision: item.revision ?? undefined,
              }}
            />
          </li>
        ))}
      </ul>
    </PlanBlock>
  )
}

/** The stored change of a plan that is not a migration, as data, in a closed disclosure. */
function StoredChange({ plan }: { readonly plan: PlanSource }): ReactNode {
  return (
    <details
      className="raw rounded-lg border border-default bg-surface-100"
      data-plan-block="change"
      data-review-part="raw"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-ring">
        {t('plans.change.title')}
      </summary>
      <div className="flex min-w-0 flex-col gap-3 border-t border-default p-4">
        <p className="m-0 text-sm text-foreground-light">{t('plans.change.description')}</p>
        {plan.change === undefined ? (
          <p className="m-0 text-sm text-foreground-light">{t('plans.change.none')}</p>
        ) : (
          <UntrustedText
            className="change"
            text={JSON.stringify(plan.change.content, null, 2) ?? ''}
            mono
            maxLines={60}
            maxCodePoints={20_000}
            label={t('plans.change.label')}
          />
        )}
      </div>
    </details>
  )
}

const NEXT_ACTIONS: Readonly<Record<OperationNextAction, MessageKey>> = {
  none: 'plans.next.none',
  wait: 'plans.next.wait',
  approve: 'plans.next.approve',
  inspect: 'plans.next.inspect',
  resume: 'plans.next.resume',
  forward_fix: 'plans.next.forwardFix',
  replan: 'plans.next.replan',
}

function nextActionText(next: OperationNextAction | undefined): string | null {
  if (next === undefined || !Object.hasOwn(NEXT_ACTIONS, next)) return null
  return t(NEXT_ACTIONS[next])
}

/**
 * An operation of the plan that needs attention: the next action the server
 * named, "Verify again" only when the server says it is retryable on a
 * current reading, the error code and the reconciliation steps.
 */
function OperationAttention({
  operation,
  plan,
  stale,
  onMessage,
}: {
  readonly operation: OperationRead
  readonly plan: PlanSource
  readonly stale: boolean
  readonly onMessage: PageMessage
}): ReactNode {
  const headingId = useId()
  const attention =
    operation.state === 'needs_attention' || operation.state === 'needs_reconciliation'
  if (!attention && operation.errorCode === null) return null
  const retryable = operation.retryable ?? null
  return (
    <div data-operation-id={operation.id} className="flex min-w-0 flex-col gap-3">
      {attention ? (
        <NeedsAttentionNote
          attention={{ nextAction: nextActionText(operation.nextAction), retryable }}
          action={
            retryable === true && !stale ? (
              <VerifyAgainAction
                operation={operation}
                planFacts={confirmFactsOf(plan)}
                onMessage={onMessage}
              />
            ) : undefined
          }
        />
      ) : null}
      {operation.errorCode === null ? null : (
        <p className="m-0 text-sm">
          {t('plans.operation.errorCode')}{' '}
          <UntrustedName name={operation.errorCode} mono label={t('plans.operation.errorCode')} />
        </p>
      )}
      {attention ? (
        <section aria-labelledby={headingId} className="flex flex-col gap-1 text-sm">
          <h3 id={headingId} className="font-medium">
            {t('plans.reconcile.title')}
          </h3>
          <ol className="list-decimal pl-5">
            <li>{t('plans.reconcile.step1')}</li>
            <li>{t('plans.reconcile.step2')}</li>
            <li>{t('plans.reconcile.step3')}</li>
          </ol>
        </section>
      ) : null}
    </div>
  )
}

/**
 * "Technical details", closed until opened: the facts a person checks against
 * another surface (the plan id and the full plan hash with copy buttons) and
 * the record of the plan. Facts that do not apply to the plan's kind are left
 * out: statement classes, the schema state and the newest backup belong to
 * migrations, the client to a plan made through one.
 */
function PlanTechnicalDetails({
  data,
  operationId,
  isMigration,
  production,
}: {
  readonly data: PageData
  readonly operationId: string | null
  readonly isMigration: boolean
  readonly production: boolean
}): ReactNode {
  const { plan, item } = data
  const analysis = analysisOf(plan)
  const evidence = evidenceOf(plan)
  return (
    <details
      data-plan-details=""
      className="details rounded-lg border border-default bg-surface-100"
    >
      <summary className="cursor-pointer px-4 py-3 text-base font-medium focus-ring">
        {t('plans.details.title')}
      </summary>
      <div className="min-w-0 border-t border-default p-4">
        <PlanDetailsList
          planId={plan.id}
          planHash={plan.planHash}
          kind={plan.kind}
          planClass={plan.class}
          subject={{
            targetPath: plan.subject.targetPath,
            targetId: plan.subject.targetId,
            clusterId: plan.subject.clusterId,
            nodeId: plan.subject.nodeId,
            serverId: serverIdOf(plan.change?.content),
          }}
          tier={plan.subject.tier}
          {...(isMigration ? { classifications: analysis?.classifications ?? null } : {})}
          creator={{
            kind: plan.actor.kind,
            identityId: plan.actor.identityId,
            via: plan.actor.via,
          }}
          {...(plan.clientId === null
            ? {}
            : { client: { id: plan.clientId, name: item?.review?.clientName ?? null } })}
          createdAt={plan.createdAt}
          expiresAt={plan.expiresAt}
          operationId={operationId}
          requirements={requirementsOf(plan)}
          {...(plan.policyRules === undefined && plan.decision === 'allow'
            ? {}
            : { rules: rulesOf(plan) })}
          {...(evidence === undefined ? {} : { schemaFingerprint: evidence.schemaFingerprint })}
          {...(isMigration && production ? { newestBackup: null } : {})}
        />
      </div>
    </details>
  )
}
