import type {
  ApprovalQueueItem,
  OperationNextAction,
  OperationRead,
} from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  ApplyVerifyIndicators,
  type ApprovalBinding,
  type ApprovalEligibility,
  ApprovalsBlock,
  ComputedFactsSection,
  PlanAnalysisBlock,
  type PlanBinding,
  PlanBlock,
  PlanEvidenceBlock,
  PlanFrame,
  PlanSummaryBlock,
  PolicyDecisionBlock,
  RawPlanTextBlock,
} from '@exponetdb/ui-data'
import {
  isProductionTier,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  type PlanConfirmFacts,
  type Readable,
  ReadableView,
  readableValue,
  TierChip,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { operationPath } from '../changes/model.ts'
import { VerifyAgainAction } from '../changes/operation-actions.tsx'
import { ViewSqlButton } from '../migrations/bundle-sheet.tsx'
import { ApplyAction, DecisionActions, type PageMessage } from './decision-actions.tsx'
import { approvalQueueQuery, operationQuery, planKeys, planQuery } from './keys.ts'
import {
  analysisOf,
  approvalEntriesOf,
  confirmFactsOf,
  evidenceOf,
  filesOf,
  isPlanId,
  type PlanSource,
  requirementsOf,
  rulesOf,
} from './plan-model.ts'
import { planBundlesOf, StoredFilesBlock, useStoredFiles } from './stored-files.tsx'
import { canOfferWithdraw, WithdrawAction } from './withdraw-action.tsx'

/**
 * The plan review page `/changes/plans/<id>` (information-architecture.md
 * §5, ADR-0029): what ExponetDB computed from the stored plan first
 * (`.review .computed`: target and tier, kind and class, creator and client
 * with the client's own name marked "name not verified", the policy decision
 * with its rules, the evidence and the bound fingerprint, the expiry
 * countdown, the full plan hash with a copy button, the analysis per
 * migration), then the files the plan runs verbatim and numbered as text
 * (`.raw`), then the decision (the agent note, the own-plan
 * acknowledgement, approve and reject bound to the shown hash) and the apply
 * and verification outcomes of its operation as separate indicators.
 *
 * The plan comes from the approvals queue when an operation of it waits for
 * the person (the queue carries the review: the client's name and the stored
 * files), else from `GET /plans/{id}`; then the files come from the bundle
 * store, matched by the revision and digest the plan binds, so every reader
 * of the plan sees them (as text, in the same block). The person's own
 * active plan can be withdrawn. Whether the person may approve is the
 * server's answer (the queue lists only what the person may decide). The
 * review keeps the DOM hooks of the Wave 7 approvals page
 * (`li.card.focused[data-operation]`, `.review`, `.computed`, `.raw`), so
 * the browser suites keep selecting what they did.
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

function ValidPlanPage({ planId }: { readonly planId: string }): ReactNode {
  const { client } = useApi()
  const queryClient = useQueryClient()
  const planRead = useQuery(planQuery(client, planId))
  const queueRead = useQuery(approvalQueueQuery(client))
  const [message, onMessage] = useMessages()

  const planReadable = toReadable(planRead)
  const queueReadable = toReadable(queueRead)
  const queue = readableValue(queueReadable)
  const item = queue?.items.find((entry) => entry.planId === planId)

  let readable: Readable<PageData>
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
    if (classifyFailure(planRead.error).kind === 'not_found') {
      // A plan that does not exist and one the person may not read look the same.
      return <NotFoundPage />
    }
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
  const production = value !== undefined && isProductionTier(value.plan.subject.tier)
  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: planKeys.detail(planId) })
    void queueRead.refetch()
  }

  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle productionCue={production ? <TierChip tier="prod" /> : undefined}>
              {t('plans.page.title')}
            </PageHeaderTitle>
            <PageHeaderDescription>
              <code className="font-mono text-xs">{planId}</code>
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
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
          ready={(data, meta) => (
            <PlanReview data={data} stale={meta.state === 'stale'} onMessage={onMessage} />
          )}
        />
      </PageContainer>
    </>
  )
}

function eligibilityOf(
  data: PageData,
  operation: OperationRead | undefined,
): ApprovalEligibility | null {
  if (data.item !== undefined) return { canApprove: true, selfApproval: data.item.ownPlan }
  if (data.queueFailed) return null
  // Not in the person's queue: the server lists every operation the person may decide.
  return {
    canApprove: false,
    reason: operation?.state === 'awaiting_approval' ? null : t('plans.approvals.nothingWaiting'),
  }
}

function PlanReview({
  data,
  stale,
  onMessage,
}: {
  readonly data: PageData
  readonly stale: boolean
  readonly onMessage: PageMessage
}): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const { plan, item } = data
  const operationId = item?.operationId ?? plan.operationId ?? null
  const operationRead = useQuery(operationQuery(client, operationId ?? ''))
  const operation = operationRead.data

  const analysis = analysisOf(plan)
  const evidence = evidenceOf(plan)
  const files = item?.review === undefined ? undefined : filesOf(item.review)
  const isMigration = plan.kind.startsWith('migration.')
  // Without the queue's review (not an approver, nothing waiting, the queue unreadable), every
  // reader of the plan sees the files it runs from the bundle store, matched by its digest.
  const stored = useStoredFiles(plan, isMigration && files === undefined)
  const queryClient = useQueryClient()
  // Production unless the tier is exactly `nonprod` (fails closed).
  const production = isProductionTier(plan.subject.tier)
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

  return (
    <ul className="cards flex flex-col" aria-label={t('plans.review.label')}>
      <li
        className={cn('card', item !== undefined && 'focused')}
        data-operation={operationId ?? undefined}
      >
        <PlanFrame production={production}>
          <div className="review flex min-w-0 flex-col gap-4">
            <ComputedFactsSection headingLevel={2}>
              <PlanSummaryBlock
                headingLevel={3}
                planId={plan.id}
                planHash={plan.planHash}
                subject={{
                  targetPath: plan.subject.targetPath,
                  clusterId: plan.subject.clusterId,
                  nodeId: plan.subject.nodeId,
                }}
                tier={plan.subject.tier}
                kind={plan.kind}
                planClass={plan.class}
                classifications={analysis?.classifications ?? null}
                state={plan.state}
                creator={{
                  kind: plan.actor.kind,
                  identityId: plan.actor.identityId,
                  via: plan.actor.via,
                }}
                clientName={item?.review?.clientName ?? null}
                createdAt={plan.createdAt}
                expiresAt={plan.expiresAt}
                stale={stale}
                renderActions={(binding: PlanBinding) => (
                  <>
                    <ApplyAction
                      plan={plan}
                      planHash={binding.planHash}
                      onMessage={onMessage}
                      variant="primary"
                    />
                    {canOfferWithdraw(plan, me.identity.id) ? (
                      <WithdrawAction plan={plan} onMessage={onMessage} />
                    ) : null}
                  </>
                )}
              />
              <PolicyDecisionBlock
                headingLevel={3}
                decision={plan.decision}
                requirements={requirementsOf(plan)}
                rules={rulesOf(plan)}
                overriddenRules={plan.overriddenRules}
              />
              {evidence === undefined ? null : (
                <PlanEvidenceBlock
                  headingLevel={3}
                  evidence={evidence.evidence}
                  items={evidence.items}
                  breakGlass={evidence.breakGlass}
                  schemaFingerprint={evidence.schemaFingerprint}
                  newestBackup={null}
                />
              )}
              {analysis === undefined ? null : (
                <PlanAnalysisBlock
                  headingLevel={3}
                  overall={analysis.overall}
                  migrations={analysis.migrations}
                />
              )}
            </ComputedFactsSection>
            {!isMigration ? (
              <StoredChange plan={plan} />
            ) : files === undefined && stored !== undefined ? (
              <StoredFilesBlock
                readable={stored}
                collapsedLines={RAW_LINES_SHOWN}
                onRetry={() => void queryClient.invalidateQueries({ queryKey: ['bundles'] })}
              />
            ) : (
              <RawPlanTextBlock
                headingLevel={2}
                files={files?.files ?? null}
                omitted={files?.omitted ?? null}
                runs={files?.runs ?? null}
                collapsedLines={RAW_LINES_SHOWN}
              />
            )}
          </div>
          <ApprovalsBlock
            headingLevel={2}
            planId={plan.id}
            planHash={plan.planHash}
            operationId={item?.operationId ?? null}
            required={item?.required ?? plan.approvals.required}
            given={
              item === undefined
                ? plan.approvals.given
                : item.approvals.filter((a) => a.decision === 'approved').length
            }
            approvals={item === undefined ? null : approvalEntriesOf(item)}
            eligibility={eligibilityOf(data, operation)}
            proposedByAgent={plan.actor.via === 'mcp'}
            stale={stale}
            renderApproveActions={(binding: ApprovalBinding) => (
              <DecisionActions
                binding={binding}
                plan={plan}
                selfApproval={item?.ownPlan === true}
                release={release}
                onMessage={onMessage}
              />
            )}
          />
          <OperationOutcome
            operationId={operationId}
            planFacts={confirmFactsOf(plan)}
            read={toReadable(operationRead)}
            busy={operationRead.isFetching}
            onRetry={() => void operationRead.refetch()}
            onMessage={onMessage}
          />
          {isMigration ? <PlanBundles plan={plan} /> : null}
        </PlanFrame>
      </li>
    </ul>
  )
}

/**
 * Lines of a stored file shown before "Show more lines". The Wave 7 page
 * showed every line; a statement in the collapsed part is named above the
 * control, and the analysis lists every statement with its line first.
 */
export const RAW_LINES_SHOWN = 1_000

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
      headingLevel={2}
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

/** The stored change of a plan that is not a migration, as data. */
function StoredChange({ plan }: { readonly plan: PlanSource }): ReactNode {
  return (
    <PlanBlock
      title={t('plans.change.title')}
      headingLevel={2}
      className="raw"
      description={t('plans.change.description')}
    >
      {plan.change === undefined ? (
        <p className="text-sm text-foreground-light">{t('plans.change.none')}</p>
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
    </PlanBlock>
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

function OperationOutcome({
  operationId,
  planFacts,
  read,
  busy,
  onRetry,
  onMessage,
}: {
  readonly operationId: string | null
  /** The confirmation facts of this plan ("Verify again" on production uses them). */
  readonly planFacts: PlanConfirmFacts
  readonly read: Readable<OperationRead>
  readonly busy: boolean
  readonly onRetry: () => void
  readonly onMessage: PageMessage
}): ReactNode {
  const Link = useLinkComponent()
  const operation = readableValue(read)
  if (operationId === null) {
    return (
      <PlanBlock title={t('plans.outcome.title')} headingLevel={2} data-plan-block="outcome">
        <p className="text-sm text-foreground-light">{t('plans.outcome.noOperation')}</p>
      </PlanBlock>
    )
  }
  if (operation === undefined) {
    return (
      <PlanBlock title={t('plans.outcome.title')} headingLevel={2} data-plan-block="outcome">
        <ReadableView
          readable={read}
          what={t('plans.operation.what')}
          onRetry={onRetry}
          busy={busy}
          headingLevel={3}
          ready={() => null}
        />
      </PlanBlock>
    )
  }
  const attention =
    operation.state === 'needs_attention' || operation.state === 'needs_reconciliation'
  const retryable = operation.retryable ?? null
  const operationHref = operationPath(operation.id)
  return (
    <div data-operation-id={operation.id} className="flex flex-col gap-2">
      <p className="text-sm text-foreground-light">
        {t('plans.operation.line', {
          id: operation.id,
          state: operation.state.replaceAll('_', ' '),
        })}
      </p>
      {operationHref === undefined ? null : (
        <p className="text-sm">
          <Link href={operationHref} className="text-primary underline focus-ring">
            {t('changes.operation.open')}
          </Link>
        </p>
      )}
      {read.state === 'stale' ? (
        <p role="note" className="text-sm text-foreground-light">
          {t('plans.operation.stale')}
        </p>
      ) : null}
      <ApplyVerifyIndicators
        headingLevel={2}
        applyOutcome={operation.applyOutcome}
        verificationOutcome={operation.verificationOutcome}
        operationState={operation.state}
        needsAttention={
          attention
            ? {
                nextAction: nextActionText(operation.nextAction),
                retryable,
              }
            : null
        }
      />
      {attention && retryable === true && read.state !== 'stale' ? (
        <VerifyAgainAction operation={operation} planFacts={planFacts} onMessage={onMessage} />
      ) : null}
      {operation.errorCode === null ? null : (
        <p className="text-sm">
          {t('plans.operation.errorCode')}{' '}
          <UntrustedName name={operation.errorCode} mono label={t('plans.operation.errorCode')} />
        </p>
      )}
      {attention ? (
        <section aria-labelledby="plan-reconcile" className="flex flex-col gap-1 text-sm">
          <h3 id="plan-reconcile" className="font-medium">
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
