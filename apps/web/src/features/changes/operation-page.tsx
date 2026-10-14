import type { MigrationProgress, OperationRead, PlanRead } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  ApplyVerifyIndicators,
  PlanBlock,
  PlanFrame,
  type PlanStep,
  PlanStepsBlock,
} from '@exponetdb/ui-data'
import {
  formatUtc,
  isProductionTier,
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  type Readable,
  ReadableView,
  readableValue,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { NotFoundPage } from '../../shell/not-found.tsx'
import type { PageMessage } from '../plans/decision-actions.tsx'
import { approvalQueueQuery, planQuery } from '../plans/keys.ts'
import { confirmFactsOf, isOperationId, isPlanId, planPath } from '../plans/plan-model.ts'
import { targetHrefOf } from '../targets/model.ts'
import { operationDetailQuery } from './keys.ts'
import {
  APPLY_TEXT,
  errorTextKey,
  operationPath,
  outcomeKey,
  stateTextKey,
  VERIFICATION_TEXT,
} from './model.ts'
import { CancelOperationAction, cancelOffered, VerifyAgainAction } from './operation-actions.tsx'

/**
 * The operation page `/changes/operations/<id>` (information-architecture.md
 * §5 "Running" and "Outcome"; Studio's merge request and workflow logs as the
 * layout model): what the operation is (kind, state, target in the
 * production frame, who started it, the plan it applies with a link to the
 * plan review page), the apply outcome and the verification outcome as two
 * separate indicators, the steps in order, the error code with its catalog
 * text, and for an operation that needs attention the reconciliation
 * checklist and "Verify again" when the server says it is retryable. Cancel
 * is offered while the operation has not started. The page polls the
 * operation while it is at work (backoff, paused while the tab is hidden,
 * stopped once it is terminal); there is no event stream.
 */
export function OperationPage({ operationId }: { readonly operationId: string }): ReactNode {
  if (!isOperationId(operationId)) return <NotFoundPage />
  return <ValidOperationPage key={operationId} operationId={operationId} />
}

interface PageData {
  readonly operation: OperationRead
  /** The plan the operation applies, when it was read. */
  readonly plan: PlanRead | undefined
  /** The client's own name from the approvals queue (untrusted, never verified). */
  readonly clientName: string | null
}

interface Message {
  readonly kind: 'status' | 'alert'
  readonly text: string
}

function ValidOperationPage({ operationId }: { readonly operationId: string }): ReactNode {
  const { client } = useApi()
  const [message, setMessage] = useState<Message | null>(null)
  const onMessage: PageMessage = (kind, text) => setMessage({ kind, text })
  const operationRead = useQuery(operationDetailQuery(client, operationId))
  const operation = operationRead.data
  const planId = operation?.planId ?? ''
  const planRead = useQuery({ ...planQuery(client, planId), refetchInterval: false })
  // The client's own name is known for an operation that waits in the person's queue.
  const awaiting = operation?.state === 'awaiting_approval'
  const queueRead = useQuery({ ...approvalQueueQuery(client), enabled: awaiting })

  const operationReadable = toReadable(operationRead)
  if (
    operationReadable.state === 'failed' &&
    classifyFailure(operationRead.error).kind === 'not_found'
  ) {
    // An operation that does not exist and one the person may not read look the same.
    return <NotFoundPage />
  }
  const clientName =
    queueRead.data?.items.find((item) => item.operationId === operationId)?.review?.clientName ??
    null
  let readable: Readable<PageData>
  if (operationReadable.state === 'loading' || operationReadable.state === 'failed') {
    readable = operationReadable
  } else {
    const value: PageData = {
      operation: operationReadable.value,
      plan: planRead.data,
      clientName,
    }
    const planMissing = isPlanId(planId) && planRead.isError && planRead.data === undefined
    readable =
      planMissing && operationReadable.state === 'ready'
        ? {
            state: 'partial',
            value,
            source: operationReadable.source,
            observedAt: operationReadable.observedAt,
            missing: [
              t('changes.operation.planMissing', { reason: describeError(planRead.error) }),
            ],
          }
        : { ...operationReadable, value }
  }
  const value = readableValue(readable)
  const production = value !== undefined && isProductionTier(value.operation.subject.tier)
  const refetch = (): void => {
    void operationRead.refetch()
    if (isPlanId(planId)) void planRead.refetch()
  }

  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle productionCue={production ? <TierChip tier="prod" /> : undefined}>
              {t('changes.operation.title')}
            </PageHeaderTitle>
            <PageHeaderDescription>
              <code className="font-mono text-xs">{operationId}</code>
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
          what={t('changes.operation.what')}
          onRetry={refetch}
          onRefresh={refetch}
          busy={operationRead.isFetching}
          headingLevel={2}
          ready={(data, meta) => (
            <OperationView data={data} stale={meta.state === 'stale'} onMessage={onMessage} />
          )}
        />
      </PageContainer>
    </>
  )
}

const NEXT_ACTIONS: Readonly<Record<string, MessageKey>> = {
  none: 'plans.next.none',
  wait: 'plans.next.wait',
  approve: 'plans.next.approve',
  inspect: 'plans.next.inspect',
  resume: 'plans.next.resume',
  forward_fix: 'plans.next.forwardFix',
  replan: 'plans.next.replan',
}

function nextActionText(next: string | undefined): string | null {
  if (next === undefined || !Object.hasOwn(NEXT_ACTIONS, next)) return null
  const key = NEXT_ACTIONS[next]
  return key === undefined ? null : t(key)
}

const VIA: Readonly<Record<string, MessageKey>> = {
  web: 'approvals.via.web',
  rest: 'approvals.via.rest',
  mcp: 'approvals.via.mcp',
  cli: 'approvals.via.cli',
  ci: 'approvals.via.ci',
  system: 'approvals.via.system',
}

/** The state of an operation in words; an unknown state is shown as its own (marked) text. */
export function StateText({ state }: { readonly state: string }): ReactNode {
  const key = stateTextKey(state)
  return (
    <span data-state={state}>
      {key === undefined ? (
        <UntrustedName name={state} mono label={t('changes.column.state')} />
      ) : (
        t(key)
      )}
    </span>
  )
}

/** The target of an operation: a link for a valid path, marked text otherwise, and the tier. */
export function TargetText({ subject }: { readonly subject: OperationRead['subject'] }): ReactNode {
  const Link = useLinkComponent()
  const path = subject.targetPath
  const href = path === null ? undefined : targetHrefOf(path)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {path === null ? (
        <span>
          {subject.targetId === null && subject.clusterId === null && subject.nodeId === null ? (
            t('approvals.item.noTarget')
          ) : (
            // The operation read names its target by id only; show the id, never "no target".
            <UntrustedName
              name={subject.targetId ?? subject.clusterId ?? subject.nodeId ?? ''}
              mono
              label={t('changes.column.target')}
            />
          )}
        </span>
      ) : href === undefined ? (
        <UntrustedName name={path} mono label={t('changes.column.target')} />
      ) : (
        <Link href={href} className="underline focus-ring">
          <UntrustedName name={path} mono label={t('changes.column.target')} />
        </Link>
      )}
      {subject.tier === null ? (
        <span className="text-xs text-foreground-light">{t('changes.tier.unknown')}</span>
      ) : (
        <TierChip tier={subject.tier} />
      )}
    </span>
  )
}

/** Who started the operation: the interface, and for an agent the client's unverified name. */
export function ActorText({
  actor,
  clientName,
}: {
  readonly actor: OperationRead['actor']
  readonly clientName: string | null
}): ReactNode {
  const via = Object.hasOwn(VIA, actor.via) ? VIA[actor.via] : undefined
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>
        {via === undefined ? (
          <UntrustedName name={actor.via} mono label={t('changes.column.actor')} />
        ) : (
          t(via)
        )}
      </span>
      {actor.identityId === null ? null : (
        <code className="font-mono text-xs break-all text-foreground-light">
          {actor.identityId}
        </code>
      )}
      {clientName === null ? null : (
        <UntrustedName name={clientName} unverified label={t('changes.client.label')} />
      )}
    </span>
  )
}

function OperationView({
  data,
  stale,
  onMessage,
}: {
  readonly data: PageData
  readonly stale: boolean
  readonly onMessage: PageMessage
}): ReactNode {
  const { operation, plan, clientName } = data
  const production = isProductionTier(operation.subject.tier)
  const attention =
    operation.state === 'needs_attention' || operation.state === 'needs_reconciliation'
  const retryable = operation.retryable ?? null
  return (
    <PlanFrame production={production} data-operation={operation.id}>
      <OperationFacts operation={operation} plan={plan} clientName={clientName} />
      {stale ? (
        <p role="note" className="text-sm text-foreground-light" data-out-of-date="">
          {t('changes.operation.stale')}
        </p>
      ) : null}
      <ApplyVerifyIndicators
        headingLevel={2}
        applyOutcome={operation.applyOutcome}
        verificationOutcome={operation.verificationOutcome}
        operationState={operation.state}
        needsAttention={
          attention ? { nextAction: nextActionText(operation.nextAction), retryable } : null
        }
      />
      {attention && retryable === true && !stale ? (
        <div className="flex flex-col items-start gap-1">
          <VerifyAgainAction
            operation={operation}
            planFacts={plan === undefined ? undefined : confirmFactsOf(plan)}
            onMessage={onMessage}
          />
          <p className="text-xs text-foreground-light">{t('changes.verifyAgain.hint')}</p>
        </div>
      ) : null}
      {cancelOffered(operation) && !stale ? (
        <div className="flex flex-col items-start gap-1">
          <CancelOperationAction operation={operation} onMessage={onMessage} />
          <p className="text-xs text-foreground-light">{t('changes.cancel.hint')}</p>
        </div>
      ) : null}
      <ErrorCodeBlock code={operation.errorCode} />
      {attention ? (
        <section aria-labelledby="operation-reconcile" className="flex flex-col gap-1 text-sm">
          <h2 id="operation-reconcile" className="font-medium">
            {t('plans.reconcile.title')}
          </h2>
          <ol className="list-decimal pl-5">
            <li>{t('plans.reconcile.step1')}</li>
            <li>{t('plans.reconcile.step2')}</li>
            <li>{t('plans.reconcile.step3')}</li>
          </ol>
        </section>
      ) : null}
      <PlanStepsBlock headingLevel={2} steps={stepsOf(operation)} />
      {operation.migrations === undefined || operation.migrations.length === 0 ? null : (
        <MigrationProgressBlock migrations={operation.migrations} />
      )}
    </PlanFrame>
  )
}

function stepsOf(operation: OperationRead): readonly PlanStep[] {
  return [...operation.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => ({
      key: String(step.index),
      label: t('changes.step.label'),
      name: step.name,
      state: step.state,
      detail: stepTimes(step.startedAt, step.finishedAt),
    }))
}

function stepTimes(startedAt: string | null, finishedAt: string | null): string | null {
  const started = startedAt === null ? undefined : formatUtc(startedAt)
  const finished = finishedAt === null ? undefined : formatUtc(finishedAt)
  if (started === undefined) return null
  return finished === undefined
    ? t('changes.step.started', { time: started })
    : t('changes.step.startedFinished', { started, finished })
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-foreground-light">{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  )
}

function OperationFacts({
  operation,
  plan,
  clientName,
}: {
  readonly operation: OperationRead
  readonly plan: PlanRead | undefined
  readonly clientName: string | null
}): ReactNode {
  const Link = useLinkComponent()
  const planHref = planPath(operation.planId)
  const waitingHref =
    operation.waitingFor === null ? undefined : operationPath(operation.waitingFor.operationId)
  return (
    <PlanBlock
      title={t('changes.facts.title')}
      headingLevel={2}
      data-operation-block="facts"
      description={t('changes.facts.description')}
    >
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <Fact term={t('changes.column.kind')}>
          <UntrustedName name={operation.kind} mono label={t('changes.column.kind')} />
          {plan === undefined ? null : (
            <span className="ml-2 text-xs text-foreground-light">
              {t('approvals.item.class', { class: plan.class })}
            </span>
          )}
        </Fact>
        <Fact term={t('changes.column.state')}>
          <StateText state={operation.state} />
        </Fact>
        <Fact term={t('changes.column.target')}>
          <TargetText subject={operation.subject} />
        </Fact>
        <Fact term={t('changes.facts.plan')}>
          {planHref === undefined ? (
            t('changes.facts.noPlan')
          ) : (
            <Link
              href={planHref}
              className="break-all text-primary underline focus-ring"
              data-plan-link=""
            >
              {t('changes.facts.planLink', { id: operation.planId ?? '' })}
            </Link>
          )}
        </Fact>
        {plan === undefined ? null : (
          <Fact term={t('changes.facts.planHash')}>
            <code className="font-mono text-xs break-all">{plan.planHash}</code>
          </Fact>
        )}
        <Fact term={t('changes.column.actor')}>
          <ActorText actor={operation.actor} clientName={clientName} />
          {operation.actor.via === 'mcp' && clientName === null ? (
            <span className="block text-xs text-foreground-light">
              {t('changes.client.notGiven')}
            </span>
          ) : null}
        </Fact>
        <Fact term={t('changes.column.created')}>
          <ObservedTime observedAt={operation.createdAt} withDate />
        </Fact>
        <Fact term={t('changes.column.updated')}>
          <ObservedTime observedAt={operation.updatedAt} withDate />
        </Fact>
        {operation.waitingFor === null ? null : (
          <Fact term={t('changes.facts.waitingFor')}>
            {waitingHref === undefined ? (
              <UntrustedName
                name={operation.waitingFor.operationId}
                mono
                label={t('changes.facts.waitingFor')}
              />
            ) : (
              <Link href={waitingHref} className="text-primary underline focus-ring">
                {operation.waitingFor.operationId}
              </Link>
            )}
          </Fact>
        )}
      </dl>
    </PlanBlock>
  )
}

/** The error code of the operation with the catalog's text; an unknown code says so. */
export function ErrorCodeBlock({ code }: { readonly code: string | null }): ReactNode {
  if (code === null) return null
  const key = errorTextKey(code)
  return (
    <PlanBlock title={t('changes.error.title')} headingLevel={2} data-operation-block="error">
      <p className="text-sm">
        <UntrustedName name={code} mono label={t('plans.operation.errorCode')} />
      </p>
      <p className="text-sm text-foreground-light" data-error-text="">
        {key === undefined ? t('changes.error.unknownCode') : t(key)}
      </p>
    </PlanBlock>
  )
}

function OutcomeWords({
  table,
  value,
  name,
}: {
  readonly table: Readonly<Record<string, MessageKey>>
  readonly value: string
  readonly name: 'apply' | 'verification'
}): ReactNode {
  const key = outcomeKey(table, value)
  return (
    <span data-indicator={name} data-outcome={value}>
      {key === undefined ? <UntrustedName name={value} mono label={name} /> : t(key)}
    </span>
  )
}

function MigrationProgressBlock({
  migrations,
}: {
  readonly migrations: readonly MigrationProgress[]
}): ReactNode {
  return (
    <PlanBlock
      title={t('changes.migrations.title')}
      headingLevel={2}
      data-operation-block="migrations"
    >
      <Table>
        <TableCaption className="sr-only">{t('changes.migrations.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('changes.migrations.migration')}</TableHead>
            <TableHead scope="col">{t('changes.column.apply')}</TableHead>
            <TableHead scope="col">{t('changes.column.verification')}</TableHead>
            <TableHead scope="col">{t('changes.migrations.error')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {migrations.map((migration) => (
            <TableRow key={migration.migrationId} data-migration={migration.migrationId}>
              <TableCell>
                <span className="flex flex-col gap-0.5">
                  <UntrustedName name={migration.name} label={t('changes.migrations.migration')} />
                  <code className="font-mono text-xs text-foreground-light">
                    {migration.migrationId}
                  </code>
                </span>
              </TableCell>
              <TableCell>
                <OutcomeWords table={APPLY_TEXT} value={migration.applyOutcome} name="apply" />
              </TableCell>
              <TableCell>
                <OutcomeWords
                  table={VERIFICATION_TEXT}
                  value={migration.verificationOutcome}
                  name="verification"
                />
              </TableCell>
              <TableCell>
                {migration.errorCode === null ? (
                  <span className="text-foreground-light">{t('changes.migrations.noError')}</span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    <UntrustedName
                      name={migration.errorCode}
                      mono
                      label={t('changes.migrations.error')}
                    />
                    {migration.statementIndex === null ? null : (
                      <span className="text-xs text-foreground-light">
                        {t('changes.migrations.statement', { index: migration.statementIndex + 1 })}
                      </span>
                    )}
                    {migration.sqlstate === null ? null : (
                      <span className="text-xs text-foreground-light">
                        {t('changes.migrations.sqlstate')}{' '}
                        <UntrustedName name={migration.sqlstate} mono label="SQLSTATE" />
                      </span>
                    )}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </PlanBlock>
  )
}

export { OutcomeWords }
