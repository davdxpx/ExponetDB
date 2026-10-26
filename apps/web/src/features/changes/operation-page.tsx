import type { MigrationProgress, OperationRead, PlanRead } from '@exponetdb/sdk/operations'
import {
  Button,
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
  NeedsAttentionNote,
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
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { NotFoundPage } from '../../shell/not-found.tsx'
import type { PageMessage } from '../plans/decision-actions.tsx'
import { approvalQueueQuery, planQuery } from '../plans/keys.ts'
import {
  ActorLine,
  type ActorWords,
  HeaderFacts,
  KindTitle,
  OperationStateBadge,
} from '../plans/plan-heading.tsx'
import { confirmFactsOf, isOperationId, isPlanId, planPath } from '../plans/plan-model.ts'
import { migrationCountOf, serverIdOf } from '../plans/plan-title.ts'
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
 * layout model; the owner's design of 2026-10-21, as on the plan page): the
 * header says what happens (the kind in words and its subject), the state and
 * who started it, with the production chip beside the title and the actions
 * on the right ("Verify again" when the server says it is retryable, cancel
 * while the operation has not started, the plan it applies). In the
 * production frame, said once: the apply outcome and the verification
 * outcome as two separate indicators, the next action and the reconciliation
 * checklist of an operation that needs attention, the error code with its
 * catalog text, the steps in order and the migrations, then the technical
 * details closed (target, plan and plan hash, who started it with the
 * client's unverified name, times). The page polls the operation while it is
 * at work (backoff, paused while the tab is hidden, stopped once it is
 * terminal); there is no event stream.
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
  const stale = readable.state === 'stale'
  const refetch = (): void => {
    void operationRead.refetch()
    if (isPlanId(planId)) void planRead.refetch()
  }

  return (
    <>
      <OperationHeader operationId={operationId} data={value} stale={stale} onMessage={onMessage} />
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
          ready={(data, meta) => <OperationView data={data} stale={meta.state === 'stale'} />}
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
export function TargetText({
  subject,
  tierAs = 'chip',
}: {
  readonly subject: OperationRead['subject']
  /**
   * The tier as a chip (a list) or in words (the operation page's details, where the header's
   * chip already says production once).
   */
  readonly tierAs?: 'chip' | 'words'
}): ReactNode {
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
          <UntrustedName name={path} mono expandable={false} label={t('changes.column.target')} />
        </Link>
      )}
      {subject.tier === null ? (
        <span className="text-xs text-foreground-light">{t('changes.tier.unknown')}</span>
      ) : tierAs === 'words' ? (
        <span data-operation-tier={subject.tier} className="text-xs text-foreground-light">
          {t(subject.tier === 'nonprod' ? 'changes.tier.nonprod' : 'changes.tier.prod')}
        </span>
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

/** The one sentence of the production frame: an operation without a tier says why it is production. */
function productionNotice(tier: string | null): string {
  return tier === null ? t('changes.production.noTier') : t('changes.production.notice')
}

const OPERATION_ACTOR_WORDS: ActorWords = {
  you: 'changes.header.byYou',
  person: 'changes.header.byPerson',
  service: 'changes.header.byService',
  system: 'changes.header.bySystem',
}

/**
 * The head of the operation page: what happens (the kind in words and its
 * subject), the state and who started it; the production chip beside the
 * title; the actions on the right ("Verify again" when the server says the
 * operation is retryable on a current reading, cancel before it started, and
 * the plan it applies), wrapping below the title on phones.
 */
function OperationHeader({
  operationId,
  data,
  stale,
  onMessage,
}: {
  readonly operationId: string
  readonly data: PageData | undefined
  readonly stale: boolean
  readonly onMessage: PageMessage
}): ReactNode {
  const me = useMe()
  const Link = useLinkComponent()
  const operation = data?.operation
  const plan = data?.plan
  // Production unless the tier is exactly `nonprod` (fails closed); said once, beside the title.
  const production = operation !== undefined && isProductionTier(operation.subject.tier)
  const attention =
    operation !== undefined &&
    (operation.state === 'needs_attention' || operation.state === 'needs_reconciliation')
  const verifyAgain = attention && operation?.retryable === true && !stale
  const cancel = operation !== undefined && cancelOffered(operation) && !stale
  const planHref = operation === undefined ? undefined : planPath(operation.planId)
  return (
    <PageHeader size="large">
      <PageHeaderMeta className="@xl:items-start">
        <PageHeaderSummary className="min-w-0">
          <PageHeaderTitle productionCue={production ? <TierChip tier="prod" /> : undefined}>
            {operation === undefined ? (
              t('changes.operation.title')
            ) : (
              <KindTitle
                kind={operation.kind}
                refs={{
                  // The operation read may name its target by id only; the plan it applies has
                  // the path of the same target.
                  targetPath:
                    operation.subject.targetPath ??
                    (plan !== undefined && plan.subject.targetId === operation.subject.targetId
                      ? plan.subject.targetPath
                      : null),
                  targetId: operation.subject.targetId,
                  clusterId: operation.subject.clusterId,
                  nodeId: operation.subject.nodeId,
                  serverId: serverIdOf(plan?.change?.content),
                }}
                migrationCount={
                  operation.kind !== 'migration.apply'
                    ? null
                    : (operation.migrations?.length ??
                      (plan === undefined ? null : migrationCountOf(plan.change?.content)))
                }
              />
            )}
          </PageHeaderTitle>
          <PageHeaderDescription>
            {operation === undefined ? (
              <code className="font-mono text-xs">{operationId}</code>
            ) : (
              <HeaderFacts>
                <OperationStateBadge state={operation.state} />
                <ActorLine
                  actor={operation.actor}
                  meId={me.identity.id}
                  words={OPERATION_ACTOR_WORDS}
                />
              </HeaderFacts>
            )}
          </PageHeaderDescription>
        </PageHeaderSummary>
        {operation === undefined || (!verifyAgain && !cancel && planHref === undefined) ? null : (
          <PageHeaderAside className="flex-wrap items-start">
            <div data-operation-actions="" className="flex flex-wrap items-start gap-2">
              {verifyAgain ? (
                <VerifyAgainAction
                  operation={operation}
                  planFacts={plan === undefined ? undefined : confirmFactsOf(plan)}
                  onMessage={onMessage}
                />
              ) : null}
              {cancel ? (
                <CancelOperationAction operation={operation} onMessage={onMessage} />
              ) : null}
              {planHref === undefined ? null : (
                <Button asChild size="small" variant="default">
                  <Link href={planHref} data-header-plan-link="">
                    {t('changes.header.reviewPlan')}
                  </Link>
                </Button>
              )}
            </div>
          </PageHeaderAside>
        )}
      </PageHeaderMeta>
    </PageHeader>
  )
}

function OperationView({
  data,
  stale,
}: {
  readonly data: PageData
  readonly stale: boolean
}): ReactNode {
  const { operation, plan, clientName } = data
  const production = isProductionTier(operation.subject.tier)
  const attention =
    operation.state === 'needs_attention' || operation.state === 'needs_reconciliation'
  const retryable = operation.retryable ?? null
  const reconcileId = useId()
  return (
    <PlanFrame
      production={production}
      notice={productionNotice(operation.subject.tier)}
      data-operation={operation.id}
    >
      {stale ? (
        <p role="note" className="m-0 text-sm text-foreground-light" data-out-of-date="">
          {t('changes.operation.stale')}
        </p>
      ) : null}
      <ApplyVerifyIndicators
        headingLevel={2}
        applyOutcome={operation.applyOutcome}
        verificationOutcome={operation.verificationOutcome}
        operationState={operation.state}
      />
      {attention ? (
        <NeedsAttentionNote
          attention={{ nextAction: nextActionText(operation.nextAction), retryable }}
          action={<p className="m-0 text-foreground-light">{t('changes.verifyAgain.hint')}</p>}
        />
      ) : null}
      <ErrorCodeBlock code={operation.errorCode} />
      {attention ? (
        <section aria-labelledby={reconcileId} className="flex flex-col gap-1 text-sm">
          <h2 id={reconcileId} className="font-medium">
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
      <VerificationFailuresBlock runs={operation.verifications ?? []} />
      <OperationFacts operation={operation} plan={plan} clientName={clientName} />
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
    <details
      data-operation-block="facts"
      className="details rounded-lg border border-default bg-surface-100"
    >
      <summary className="cursor-pointer px-4 py-3 text-base font-medium focus-ring">
        {t('changes.details.title')}
      </summary>
      <div className="flex min-w-0 flex-col gap-3 border-t border-default p-4">
        <p className="m-0 text-sm text-foreground-light">{t('changes.details.description')}</p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <Fact term={t('changes.facts.operationId')}>
            <code className="font-mono text-xs break-all">{operation.id}</code>
          </Fact>
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
            <TargetText subject={operation.subject} tierAs="words" />
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
      </div>
    </details>
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

type VerificationRun = NonNullable<OperationRead['verifications']>[number]

/** How many failing expectations the page lists per run. */
const FAILURES_SHOWN = 50

/**
 * What a verification found failing (Part A follow-up 3, F2): per run that
 * did not pass or excused something, the counts and the failing
 * expectations, the open ones first. Names from the catalog and the files
 * are shown as untrusted text.
 */
function VerificationFailuresBlock({
  runs,
}: {
  readonly runs: readonly VerificationRun[]
}): ReactNode {
  const shown = runs.filter(
    (r) =>
      r.status !== 'passed' ||
      (r.structural.excused ?? 0) > 0 ||
      r.engine.acceptedThrough !== undefined,
  )
  if (shown.length === 0) return null
  return (
    <PlanBlock
      title={t('changes.verification.title')}
      headingLevel={2}
      data-operation-block="verification"
    >
      {shown.map((run) => {
        const failures = (
          [
            ['structural', run.structural],
            ['runtime', run.runtime],
            ['engine', run.engine],
          ] as const
        ).flatMap(([layer, l]) => (l.failures ?? []).map((f) => ({ ...f, layer })))
        const total = [run.structural, run.runtime, run.engine].reduce(
          (n, l) => n + (l.failuresTotal ?? l.failures?.length ?? 0),
          0,
        )
        return (
          <div
            key={run.verificationId}
            className="flex flex-col gap-2"
            data-verification={run.verificationId}
          >
            <p className="m-0 text-sm">
              {t('changes.verification.summary', {
                migration: run.migrationId,
                failed: run.structural.failed,
                checks: run.structural.checks,
                excused: run.structural.excused ?? 0,
              })}
            </p>
            {run.engine.status === 'failed' && run.engine.firstFailure !== null ? (
              <p className="m-0 text-sm text-foreground-light">
                {t('changes.verification.engineFailed', { name: run.engine.firstFailure.name })}
                {run.engine.firstFailure.detail === null
                  ? null
                  : ` (${run.engine.firstFailure.detail})`}
              </p>
            ) : null}
            {run.engine.acceptedThrough === undefined ? null : (
              <p className="m-0 text-sm text-foreground-light" data-accepted-through="true">
                {t('changes.verification.acceptedThrough', {
                  last: run.engine.acceptedThrough.last,
                  count: run.engine.acceptedThrough.migrations,
                })}
              </p>
            )}
            {failures.length === 0 ? null : (
              <Table>
                <TableCaption className="sr-only">{t('changes.verification.title')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('changes.verification.file')}</TableHead>
                    <TableHead scope="col">{t('changes.verification.statement')}</TableHead>
                    <TableHead scope="col">{t('changes.verification.expected')}</TableHead>
                    <TableHead scope="col">{t('changes.verification.differs')}</TableHead>
                    <TableHead scope="col">{t('changes.verification.excused')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {failures.slice(0, FAILURES_SHOWN).map((f) => (
                    <TableRow
                      key={`${f.layer}:${f.file ?? ''}:${f.statement ?? ''}:${f.kind}:${f.object}:${f.failed.join(',')}`}
                      data-failure-excused={f.excused ? 'true' : 'false'}
                    >
                      <TableCell>
                        {f.file === null ? (
                          <span className="text-foreground-light">-</span>
                        ) : (
                          <UntrustedName
                            name={f.file}
                            mono
                            label={t('changes.verification.file')}
                          />
                        )}
                      </TableCell>
                      <TableCell>{f.statement === null ? '-' : String(f.statement + 1)}</TableCell>
                      <TableCell>
                        <UntrustedName name={f.object} label={t('changes.verification.expected')} />
                      </TableCell>
                      <TableCell>
                        <UntrustedName
                          name={f.failed.join(', ')}
                          mono
                          label={t('changes.verification.differs')}
                        />
                      </TableCell>
                      <TableCell>
                        {f.excused
                          ? t('changes.verification.excusedYes')
                          : t('changes.verification.excusedNo')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {total > FAILURES_SHOWN ? (
              <p className="m-0 text-sm text-foreground-light">
                {t('changes.verification.more', { count: total - FAILURES_SHOWN })}
              </p>
            ) : null}
          </div>
        )
      })}
    </PlanBlock>
  )
}

export { OutcomeWords }
