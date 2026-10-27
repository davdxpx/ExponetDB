import type { BackupPolicyBody } from '@exponetdb/sdk/operations'
import { Button, Checkbox, Input, Label } from '@exponetdb/ui'
import { ObservedTime } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { useReason } from './backup-actions.tsx'
import { FormDialog } from './form-dialog.tsx'
import { formatSeconds, type Policy, type RepositorySummary } from './model.ts'
import { ActionButton, Fact, Facts, Missing, type Refusals, SelectField } from './parts.tsx'

/** The active backup policy of a cluster: objectives, drill cadence, retention and schedules (UTC). */
export function PolicyFacts({ policy }: { readonly policy: Policy | null }): ReactNode {
  if (policy === null) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-policy="none">
        {t('wave9.policy.none')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-policy={policy.id}>
      <Facts>
        <Fact label={t('wave9.policy.rpo')}>
          {policy.objectives.rpoSeconds === null ? (
            <Missing>{t('wave9.policy.notSet')}</Missing>
          ) : (
            formatSeconds(policy.objectives.rpoSeconds)
          )}
        </Fact>
        <Fact label={t('wave9.policy.rto')}>
          {policy.objectives.rtoSeconds === null ? (
            <Missing>{t('wave9.policy.notSet')}</Missing>
          ) : (
            formatSeconds(policy.objectives.rtoSeconds)
          )}
        </Fact>
        <Fact label={t('wave9.policy.cadence')}>
          {t('wave9.policy.days', { days: policy.drillCadenceDays })}
        </Fact>
        <Fact label={t('wave9.policy.retention')}>
          {t('wave9.policy.retentionValue', {
            full: policy.retention.fullCount ?? '–',
            differential: policy.retention.differentialCount ?? '–',
            logical: policy.retention.logicalDays ?? '–',
          })}
        </Fact>
        <Fact label={t('wave9.policy.revision')}>
          {t('wave9.policy.revisionValue', { revision: policy.revision })}{' '}
          <ObservedTime observedAt={policy.createdAt} />
        </Fact>
      </Facts>
      {policy.schedules.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('wave9.policy.noSchedules')}</p>
      ) : (
        <ul
          className="m-0 flex flex-col gap-1 pl-0 text-sm"
          aria-label={t('wave9.policy.schedules')}
        >
          {policy.schedules.map((schedule, index) => (
            <li
              key={`${schedule.repositoryId}-${schedule.kind}-${String(index)}`}
              className="list-none"
            >
              {t('wave9.policy.schedule', {
                kind: schedule.kind,
                cron: schedule.cron,
                repository: schedule.repositoryId,
              })}{' '}
              {schedule.enabled ? null : (
                <span className="text-foreground-light">{t('wave9.policy.disabled')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const CRON = /^[0-9*,/-]+( [0-9*,/-]+){4}$/
const KINDS = ['full', 'differential', 'incremental', 'logical'] as const
type Kind = (typeof KINDS)[number]

interface ScheduleDraft {
  readonly kind: Kind
  readonly repositoryId: string
  readonly cron: string
  readonly enabled: boolean
}

const optionalInt = (text: string): number | null | undefined => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : undefined
}

const inRange = (value: number | null | undefined, min: number, max: number) =>
  value === null || (value !== undefined && value >= min && value <= max)

/**
 * "Plan a policy change" (`planBackupPolicy`, `registry.manage`; high, human,
 * re-authentication): a new revision of the whole policy, started from the
 * active one. The plan page shows the change and who must approve it.
 */
export function PlanPolicy(props: {
  readonly clusterId: string
  readonly policy: Policy | null
  readonly repositories: readonly RepositorySummary[]
  readonly refusals: Refusals
}): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const id = useId()
  const current = props.policy
  const minutes = (seconds: number | null | undefined) =>
    seconds == null ? '' : String(Math.round(seconds / 60))
  const [open, setOpen] = useState(false)
  const [rpo, setRpo] = useState(minutes(current?.objectives.rpoSeconds))
  const [rto, setRto] = useState(minutes(current?.objectives.rtoSeconds))
  const [cadence, setCadence] = useState(String(current?.drillCadenceDays ?? 30))
  const [full, setFull] = useState(String(current?.retention.fullCount ?? ''))
  const [differential, setDifferential] = useState(
    String(current?.retention.differentialCount ?? ''),
  )
  const [logical, setLogical] = useState(String(current?.retention.logicalDays ?? ''))
  const [schedules, setSchedules] = useState<readonly ScheduleDraft[]>(
    current?.schedules.map((s) => ({ ...s })) ?? [],
  )
  const repositories = props.repositories.filter((r) => r.state !== 'retired')
  const rpoMinutes = optionalInt(rpo)
  const rtoMinutes = optionalInt(rto)
  const cadenceDays = optionalInt(cadence)
  const fullCount = optionalInt(full)
  const differentialCount = optionalInt(differential)
  const logicalDays = optionalInt(logical)
  const problem = !inRange(rpoMinutes, 1, 7 * 1440)
    ? t('wave9.policy.rpo.invalid')
    : !inRange(rtoMinutes, 5, 30 * 1440)
      ? t('wave9.policy.rto.invalid')
      : cadenceDays === null || !inRange(cadenceDays, 1, 366)
        ? t('wave9.policy.cadence.invalid')
        : !inRange(fullCount, 1, 100) ||
            !inRange(differentialCount, 1, 100) ||
            !inRange(logicalDays, 1, 3650)
          ? t('wave9.policy.retention.invalid')
          : schedules.some((s) => !CRON.test(s.cron.trim()) || s.repositoryId === '')
            ? t('wave9.policy.schedule.invalid')
            : undefined
  const body = (): BackupPolicyBody => ({
    schedules: schedules.map((s) => ({ ...s, cron: s.cron.trim() })),
    retention: {
      fullCount: fullCount ?? null,
      differentialCount: differentialCount ?? null,
      logicalDays: logicalDays ?? null,
    },
    archiveTimeoutSeconds: current?.archiveTimeoutSeconds ?? null,
    objectives: {
      rpoSeconds: rpoMinutes == null ? null : rpoMinutes * 60,
      rtoSeconds: rtoMinutes == null ? null : rtoMinutes * 60,
    },
    drillCadenceDays: cadenceDays ?? 30,
    sizeFloorPercent: current?.sizeFloorPercent ?? 50,
  })
  const field = (key: string, label: string, value: string, set: (v: string) => void) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        size="small"
        inputMode="numeric"
        className="w-40"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </div>
  )
  const update = (index: number, change: Partial<ScheduleDraft>) =>
    setSchedules((all) => all.map((s, i) => (i === index ? { ...s, ...change } : s)))
  return (
    <>
      <ActionButton
        label={t('wave9.policy.plan')}
        disabledReason={reason('policy', 'registry.manage')}
        onClick={() => setOpen(true)}
        data-action="policy"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.policy.plan.title')}
        description={t('wave9.policy.plan.body')}
        submitLabel={t('wave9.policy.plan.submit')}
        problem={problem}
        onFailure={(error) => props.refusals.record('policy', error)}
        onSubmit={() =>
          createPlan(() =>
            client.operation('planBackupPolicy', {
              params: { clusterId: props.clusterId },
              body: body(),
            }),
          )
        }
      >
        <div className="flex flex-wrap gap-4">
          {field('rpo', t('wave9.policy.rpo.minutes'), rpo, setRpo)}
          {field('rto', t('wave9.policy.rto.minutes'), rto, setRto)}
          {field('cadence', t('wave9.policy.cadence.days'), cadence, setCadence)}
        </div>
        <div className="flex flex-wrap gap-4">
          {field('full', t('wave9.policy.full'), full, setFull)}
          {field('differential', t('wave9.policy.differential'), differential, setDifferential)}
          {field('logical', t('wave9.policy.logical'), logical, setLogical)}
        </div>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t('wave9.policy.schedules')}</legend>
          {schedules.map((schedule, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
              key={index}
              className="flex flex-wrap items-end gap-3"
              data-schedule-row=""
            >
              <SelectField
                label={t('wave9.field.kind')}
                value={schedule.kind}
                options={KINDS.map((k) => ({ value: k, label: k }))}
                onChange={(kind) => update(index, { kind })}
              />
              <SelectField
                label={t('wave9.field.repository')}
                value={schedule.repositoryId}
                options={[
                  { value: '', label: t('wave9.policy.chooseRepository') },
                  ...repositories.map((r) => ({ value: r.id, label: r.id })),
                ]}
                onChange={(repositoryId) => update(index, { repositoryId })}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-cron-${String(index)}`}>{t('wave9.policy.cron')}</Label>
                <Input
                  id={`${id}-cron-${String(index)}`}
                  size="small"
                  className="w-44 font-mono"
                  value={schedule.cron}
                  onChange={(event) => update(index, { cron: event.target.value })}
                />
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Checkbox
                  id={`${id}-enabled-${String(index)}`}
                  checked={schedule.enabled}
                  onCheckedChange={(checked) => update(index, { enabled: checked === true })}
                />
                <Label htmlFor={`${id}-enabled-${String(index)}`}>
                  {t('wave9.policy.enabled')}
                </Label>
              </div>
              <Button
                type="button"
                size="tiny"
                variant="text"
                onClick={() => setSchedules((all) => all.filter((_, i) => i !== index))}
              >
                {t('wave9.policy.removeSchedule')}
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              size="tiny"
              variant="default"
              disabled={schedules.length >= 16}
              onClick={() =>
                setSchedules((all) => [
                  ...all,
                  {
                    kind: 'full',
                    repositoryId: repositories[0]?.id ?? '',
                    cron: '0 2 * * 0',
                    enabled: true,
                  },
                ])
              }
            >
              {t('wave9.policy.addSchedule')}
            </Button>
          </div>
          <p className="m-0 text-xs text-foreground-lighter">{t('wave9.policy.cron.hint')}</p>
        </fieldset>
      </FormDialog>
    </>
  )
}
