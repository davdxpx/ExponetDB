import { CircleAlert, CircleCheck, Lock, Trash2 } from '@exponetdb/icons'
import type { RetirementGroup, RetirementPreflight } from '@exponetdb/sdk/operations'
import { Button, Card, cn } from '@exponetdb/ui'
import {
  formatCount,
  ObservedTime,
  ReadableView,
  StateMessage,
  UntrustedName,
  useLinkComponent,
  WarningConfirmDialog,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { operationPath } from '../changes/model.ts'
import { type ReasonProblem, reasonCodeProblem } from '../configuration/lifecycle-model.ts'
import { ReasonCodeField } from '../configuration/reason-code-field.tsx'
import { inlineName } from '../consent/inline-name.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { retirementQuery } from './keys.ts'
import { clusterPath, nodePath, serverPath } from './model.ts'

type Kind = RetirementGroup['kind']

/** The mark of a retired record beside its name: a word, never a color alone. */
export function RetiredBadge(): ReactNode {
  return (
    <span
      data-state="retired"
      className="rounded-md border border-strong px-2 py-0.5 font-sans text-xs font-normal text-foreground-light"
    >
      {t('infra.state.retired')}
    </span>
  )
}

/** Bottom-up: what is resolved first is listed first (registry.md §4.4). */
const ORDER: readonly Kind[] = [
  'operation',
  'database',
  'credential',
  'node_job',
  'cluster',
  'node',
  'enrollment_token',
  'endpoint',
]

const GROUP_TITLE: Readonly<Record<Kind, MessageKey>> = {
  cluster: 'infra.retire.group.cluster',
  node: 'infra.retire.group.node',
  enrollment_token: 'infra.retire.group.enrollment_token',
  node_job: 'infra.retire.group.node_job',
  database: 'infra.retire.group.database',
  endpoint: 'infra.retire.group.endpoint',
  credential: 'infra.retire.group.credential',
  operation: 'infra.retire.group.operation',
}

const GROUP_HINT: Readonly<Record<Kind, MessageKey>> = {
  cluster: 'infra.retire.hint.cluster',
  node: 'infra.retire.hint.node',
  enrollment_token: 'infra.retire.hint.enrollment_token',
  node_job: 'infra.retire.hint.node_job',
  database: 'infra.retire.hint.database',
  endpoint: 'infra.retire.hint.endpoint',
  credential: 'infra.retire.hint.credential',
  operation: 'infra.retire.hint.operation',
}

const WITH_TITLE: Readonly<Record<Kind, MessageKey>> = {
  ...GROUP_TITLE,
  endpoint: 'infra.retire.with.endpoint',
  credential: 'infra.retire.with.credential',
}

export interface RetirementSubject {
  readonly kind: 'server' | 'cluster'
  readonly id: string
  readonly state: string
  /** When an operation retired it; null while it is not retired. */
  readonly retiredAt: string | null
  /** For the production cue of the confirmation: anything not exactly nonprod is production. */
  readonly tier: 'prod' | 'nonprod'
}

/**
 * "Remove from ExponetDB" for a server or a cluster (registry.md §4.4), in its own section at the
 * end of the page: what removal does and what it never does, then what blocks it now, bottom-up,
 * each blocker a link to where it is resolved, and the plan once nothing blocks. Nothing is
 * removed by a click here: "Plan removal" asks for a plan, reviewed, re-authenticated and applied
 * on its own page, and the server checks everything again. A retired record says so and offers
 * nothing. Without `registry.manage` the section says that blockers may exist and reads nothing.
 */
export function RetirementSection({ subject }: { readonly subject: RetirementSubject }): ReactNode {
  const me = useMe()
  const allowed = holds(me, 'registry.manage')
  return (
    <div className="flex flex-col gap-4" data-retirement={subject.kind}>
      <Effects kind={subject.kind} />
      {subject.state === 'retired' ? (
        <Retired subject={subject} />
      ) : allowed ? (
        <Preflight subject={subject} />
      ) : (
        <StateMessage
          data-state="not-permitted"
          icon={<Lock aria-hidden className="size-5 text-foreground-light" />}
          title={t('infra.retire.notPermitted.title')}
          headingLevel={3}
        >
          <p>{t('infra.retire.notPermitted.body')}</p>
        </StateMessage>
      )}
    </div>
  )
}

function Effects({ kind }: { readonly kind: 'server' | 'cluster' }): ReactNode {
  return (
    <Card className="grid gap-3 p-4 sm:grid-cols-2">
      <div className="flex gap-2">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-light" />
        <p className="m-0 text-sm">{t(`infra.retire.does.${kind}`)}</p>
      </div>
      <div className="flex gap-2">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <p className="m-0 text-sm">{t(`infra.retire.doesNot.${kind}`)}</p>
      </div>
    </Card>
  )
}

function Retired({ subject }: { readonly subject: RetirementSubject }): ReactNode {
  return (
    <p className="m-0 rounded-md border border-strong px-3 py-2 text-sm" data-state="retired">
      {t(`infra.retire.retired.${subject.kind}`)}{' '}
      {subject.retiredAt === null ? null : <ObservedTime observedAt={subject.retiredAt} withDate />}
    </p>
  )
}

function Preflight({ subject }: { readonly subject: RetirementSubject }): ReactNode {
  const { client } = useApi()
  const query = useQuery(retirementQuery(client, subject.kind, subject.id, true))
  return (
    <ReadableView
      readable={toReadable(query)}
      what={t('infra.retire.what')}
      onRetry={() => void query.refetch()}
      onRefresh={() => void query.refetch()}
      busy={query.isFetching}
      headingLevel={3}
      ready={(preflight) => <PreflightBody preflight={preflight} subject={subject} />}
    />
  )
}

const ordered = (groups: readonly RetirementGroup[]) =>
  [...groups].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))

function PreflightBody({
  preflight,
  subject,
}: {
  readonly preflight: RetirementPreflight
  readonly subject: RetirementSubject
}): ReactNode {
  const backups = preflight.providers.find((p) => p.provider === 'backups')?.state ?? 'unknown'
  const blocked = preflight.verdict !== 'can_plan'
  return (
    <div className="flex flex-col gap-4" data-verdict={preflight.verdict}>
      {blocked && preflight.blockers.length > 0 ? (
        <section aria-labelledby={`retire-blockers-${subject.id}`} className="flex flex-col gap-2">
          <h3 id={`retire-blockers-${subject.id}`} className="m-0 text-sm font-medium">
            {t('infra.retire.blockers.title')}
          </h3>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {ordered(preflight.blockers).map((group, index) => (
              <BlockerGroup key={group.kind} group={group} step={index + 1} subject={subject} />
            ))}
          </ol>
        </section>
      ) : null}
      {preflight.verdict === 'can_plan' ? (
        <p className="m-0 flex items-center gap-2 text-sm" role="status">
          <CircleCheck aria-hidden className="size-4 text-state-healthy" />
          {t('infra.retire.clear')}
        </p>
      ) : null}
      {preflight.retiredWith.length === 0 ? null : (
        <div className="flex flex-col gap-1 text-sm">
          <p className="m-0 font-medium">{t('infra.retire.with.title')}</p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-foreground-light">
            {preflight.retiredWith.map((group) => (
              <li key={group.kind}>
                {t(WITH_TITLE[group.kind], { count: formatCount(group.total) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-foreground-light">
        <li>{t('infra.retire.kept', { count: formatCount(preflight.kept.retiredChildren) })}</li>
        <li data-backups={backups}>{t(`infra.retire.backups.${backups}`)}</li>
        <li>
          {t('infra.retire.observed')} <ObservedTime observedAt={preflight.observedAt} />
        </li>
      </ul>
      <PlanRemoval subject={subject} blocked={blocked} why={blockedWhy(preflight, backups)} />
    </div>
  )
}

/** One reason per cause, so a disabled action never points at a list that is not there. */
function blockedWhy(preflight: RetirementPreflight, backups: string): MessageKey {
  if (preflight.verdict === 'retired') return 'infra.retire.blockedWhy.retired'
  if (preflight.blockers.length > 0) return 'infra.retire.blockedWhy'
  if (backups === 'blocking' || backups === 'unknown') return 'infra.retire.blockedWhy.backups'
  return 'infra.retire.blockedWhy.other'
}

function BlockerGroup({
  group,
  step,
  subject,
}: {
  readonly group: RetirementGroup
  readonly step: number
  readonly subject: RetirementSubject
}): ReactNode {
  const Link = useLinkComponent()
  const rest = group.total - group.items.length
  return (
    <li data-blocker={group.kind} className="flex gap-3 rounded-lg border bg-surface-100 p-3">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-warning bg-warning-200 text-xs tabular-nums"
      >
        {step}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="m-0 text-sm font-medium">
          {t(GROUP_TITLE[group.kind], { count: formatCount(group.total) })}
        </p>
        <p className="m-0 text-xs text-foreground-light">{t(GROUP_HINT[group.kind])}</p>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {group.items.map((item) => {
            const href = blockerHref(item.kind, item.id, subject)
            const name =
              item.label === null ? (
                <code className="font-mono text-xs">{item.id}</code>
              ) : (
                <UntrustedName name={item.label} expandable={false} maxCodePoints={64} />
              )
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {href === undefined ? (
                  name
                ) : (
                  <Link href={href} className="rounded-sm hover:underline focus-ring">
                    {name}
                  </Link>
                )}
                <span className="text-xs text-foreground-lighter">{item.state}</span>
              </li>
            )
          })}
        </ul>
        {rest > 0 ? (
          <p className="m-0 text-xs text-foreground-lighter">
            {t('infra.retire.more', { count: formatCount(rest) })}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** Where a blocker is resolved; a kind without a page of its own links nothing. */
function blockerHref(kind: Kind, id: string, subject: RetirementSubject): string | undefined {
  switch (kind) {
    case 'cluster':
      return clusterPath(id)
    case 'node':
      return nodePath(id)
    case 'operation':
      return operationPath(id)
    case 'database': {
      const page = subject.kind === 'cluster' ? clusterPath(subject.id) : undefined
      return page === undefined ? undefined : `${page}#cluster-placements`
    }
    case 'enrollment_token': {
      const page = subject.kind === 'server' ? serverPath(subject.id) : undefined
      return page === undefined ? undefined : `${page}#server-enroll`
    }
    default:
      return undefined
  }
}

function PlanRemoval({
  subject,
  blocked,
  why,
}: {
  readonly subject: RetirementSubject
  readonly blocked: boolean
  readonly why: MessageKey
}): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined)
  const plan = async (): Promise<void> => {
    const found = reasonCodeProblem(reason, false)
    setProblem(found)
    if (found !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 0, t('configuration.lifecycle.reason.invalid'))
    }
    const code = reason.trim()
    const body = code === '' ? {} : { reason: code }
    await createPlan(() =>
      subject.kind === 'server'
        ? client.operation('planServerRetirement', { params: { serverId: subject.id }, body })
        : client.operation('planClusterRetirement', { params: { clusterId: subject.id }, body }),
    )
  }
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="danger"
          size="small"
          disabled={blocked}
          // Reachable by Tab while disabled, so its reason is heard.
          focusableWhenDisabled
          aria-describedby={blocked ? `${id}-why` : undefined}
          icon={<Trash2 aria-hidden="true" strokeWidth={1.5} />}
          onClick={() => setOpen(true)}
        >
          {t(`infra.retire.action.${subject.kind}`)}
        </Button>
        {blocked ? (
          <span id={`${id}-why`} className={cn('text-xs text-foreground-light')}>
            {t(why)}
          </span>
        ) : null}
      </div>
      <WarningConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t(`infra.retire.confirm.title.${subject.kind}`)}
        description={t(`infra.retire.confirm.body.${subject.kind}`)}
        actionLabel={t('infra.retire.confirm.action')}
        checklistLegend={t('infra.retire.confirm.legend')}
        checklist={[
          t('infra.retire.confirm.check.final'),
          t(`infra.retire.confirm.check.physical.${subject.kind}`),
        ]}
        resetKey={subject.id}
        destructive
        tier={subject.tier}
        onConfirm={plan}
      >
        <ReasonCodeField
          id={`${id}-reason`}
          value={reason}
          problem={problem}
          optional
          onChange={(value) => {
            setReason(value)
            if (problem !== undefined) setProblem(undefined)
          }}
        />
      </WarningConfirmDialog>
    </div>
  )
}

/**
 * "Retire record" on a registered database that is no current placement (Wave 9 order A7,
 * `planDatabaseRetirement`): the step between decommissioning its target and removing the
 * cluster. A warning confirmation with two statements and an optional reason code, then a plan
 * reviewed on its own page; the database on the cluster is not touched. `registry.manage` only.
 */
export function RetireDatabaseButton({
  clusterId,
  databaseId,
  name,
  tier,
}: {
  readonly clusterId: string
  readonly databaseId: string
  readonly name: string
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const me = useMe()
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<ReasonProblem | undefined>(undefined)
  if (!holds(me, 'registry.manage')) return null
  const retire = async (): Promise<void> => {
    const found = reasonCodeProblem(reason, false)
    setProblem(found)
    if (found !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 0, t('configuration.lifecycle.reason.invalid'))
    }
    const code = reason.trim()
    await createPlan(() =>
      client.operation('planDatabaseRetirement', {
        params: { clusterId, databaseId },
        body: code === '' ? {} : { reason: code },
      }),
    )
  }
  return (
    <>
      <Button
        type="button"
        variant="text"
        size="tiny"
        // A hidden or direction character in the name is shown by its code point, not obeyed.
        aria-label={t('infra.database.retire.label', { database: inlineName(name) ?? databaseId })}
        onClick={() => setOpen(true)}
      >
        {t('infra.database.retire')}
      </Button>
      <WarningConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('infra.database.retire.title')}
        description={
          <>
            <span>{t('infra.database.retire.body')}</span>{' '}
            <span className="block pt-2">
              <UntrustedName name={name} mono label={t('infra.cluster.placements.database')} />
            </span>
          </>
        }
        actionLabel={t('infra.retire.confirm.action')}
        checklistLegend={t('infra.retire.confirm.legend')}
        checklist={[
          t('infra.retire.confirm.check.final'),
          t('infra.database.retire.check.untouched'),
        ]}
        resetKey={databaseId}
        destructive
        tier={tier}
        onConfirm={retire}
      >
        <ReasonCodeField
          id={`${id}-reason`}
          value={reason}
          problem={problem}
          optional
          onChange={(value) => {
            setReason(value)
            if (problem !== undefined) setProblem(undefined)
          }}
        />
      </WarningConfirmDialog>
    </>
  )
}
