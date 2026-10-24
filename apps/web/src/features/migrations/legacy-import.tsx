import type { ImportReport } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@exponetdb/ui'
import {
  Admonition,
  ConfirmDialog,
  ObservedTime,
  UntrustedName,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { withReauth } from '../../lib/api/reauth.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'
import { nounPhrase } from '../target/phrases.ts'
import { isItemId, isReportId } from '../target-ops/ids.ts'
import { importReportQuery, opsKeys } from '../target-ops/keys.ts'
import { useTargetHref, useTargetPath } from '../target-ops/links.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import {
  DECISION_STATES,
  type DecisionState,
  isDecisionState,
  NOTE_MAX_LENGTH,
  needsDecision,
} from './model.ts'

type Item = ImportReport['items'][number]

const STATE_LABELS: Readonly<Record<Item['state'], MessageKey>> = {
  recorded_present: 'migrations.import.state.recorded_present',
  unrecorded_present: 'migrations.import.state.unrecorded_present',
  recorded_missing: 'migrations.import.state.recorded_missing',
  unrecorded_missing: 'migrations.import.state.unrecorded_missing',
  superseded: 'migrations.import.state.superseded',
  not_applicable: 'migrations.import.state.not_applicable',
  ambiguous: 'migrations.import.state.ambiguous',
}

const REPORT_STATE_LABELS: Readonly<Record<ImportReport['state'], MessageKey>> = {
  pending: 'migrations.import.report.pending',
  incomplete: 'migrations.import.report.incomplete',
  open: 'migrations.import.report.open',
  resolved: 'migrations.import.report.resolved',
  baselined: 'migrations.import.report.baselined',
  superseded: 'migrations.import.report.superseded',
}

const STRENGTH_LABELS: Readonly<Record<NonNullable<Item['evidenceStrength']>, MessageKey>> = {
  strong: 'migrations.import.strength.strong',
  medium: 'migrations.import.strength.medium',
  low: 'migrations.import.strength.low',
  curated: 'migrations.import.strength.curated',
  weak: 'migrations.import.strength.weak',
}

function stateLabel(state: string): string | undefined {
  return Object.hasOwn(STATE_LABELS, state) ? t(STATE_LABELS[state as Item['state']]) : undefined
}

/**
 * The legacy-import status and review (legacy-import.md steps 4 to 6). The
 * Control Plane lists no import reports, so the page opens the report the
 * address names (`?report=imr_…`), which the analysis plan's operation
 * created. A person with `migrations.import` records a decision per review
 * item with a note; the decision is stored on the report and changes nothing
 * in the target. When no item waits for a decision, "Create baseline plan"
 * makes the plan that writes the baseline, reviewed on its own page.
 */
export function LegacyImportSection({
  report,
  tier,
}: {
  readonly report: string | undefined
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  return (
    <Section
      id="import"
      title={t('migrations.import.title')}
      description={t('migrations.import.description')}
    >
      {report === undefined ? <NoReport /> : <ReportView reportId={report} tier={tier} />}
    </Section>
  )
}

function NoReport(): ReactNode {
  const navigate = useNavigate()
  const href = useTargetHref()
  const inputId = useId()
  const errorId = useId()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const candidate = value.trim()
    if (!isReportId(candidate)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    navigate(`${href('/migrations')}?report=${candidate}`)
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-foreground-light">{t('migrations.import.none')}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            {t('migrations.import.open.label')}
          </label>
          <Input
            id={inputId}
            value={value}
            placeholder="imr_…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <Button type="submit" variant="default" size="small">
          {t('migrations.import.open.button')}
        </Button>
      </form>
      {invalid ? (
        <p id={errorId} role="alert" className="m-0 text-sm text-destructive">
          {t('migrations.import.open.invalid')}
        </p>
      ) : null}
    </div>
  )
}

function ReportView({
  reportId,
  tier,
}: {
  readonly reportId: string
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const { client } = useApi()
  const path = useTargetPath()
  const query = useQuery(importReportQuery(client, path, reportId))
  return (
    <ReadSection
      query={query}
      what={nounPhrase('migrations.import.what')}
      permission="migrations.import"
      ready={(report) => <ReportBody report={report} tier={tier} />}
    />
  )
}

function ReportBody({
  report,
  tier,
}: {
  readonly report: ImportReport
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const open = report.state === 'open'
  return (
    <div className="flex flex-col gap-4" data-import-report={report.id}>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground-light">
        <span>
          {t('migrations.import.state')}{' '}
          <strong className="text-foreground">
            {Object.hasOwn(REPORT_STATE_LABELS, report.state) ? (
              t(REPORT_STATE_LABELS[report.state])
            ) : (
              <UntrustedName name={String(report.state)} label={t('migrations.import.state')} />
            )}
          </strong>
        </span>
        <span>{t('migrations.import.unresolved', { count: report.unresolved })}</span>
        <span>
          {t('migrations.import.baselineId')}{' '}
          <UntrustedName name={report.baselineId} mono label={t('migrations.import.baselineId')} />
        </span>
        <span>
          {t('migrations.import.created')} <ObservedTime observedAt={report.createdAt} withDate />
        </span>
      </p>
      {report.incompleteReason === undefined || report.incompleteReason === null ? null : (
        <Admonition type="warning" title={t('migrations.import.incomplete')}>
          <UntrustedName
            name={report.incompleteReason}
            maxCodePoints={200}
            label={t('migrations.import.incomplete')}
          />
        </Admonition>
      )}
      {report.driftTruncated === true ? (
        <Admonition type="warning" title={t('migrations.import.truncated.title')}>
          {t('migrations.import.truncated.body', {
            held: report.items.filter((i) => i.legacyId.startsWith('drift:')).length,
            total: report.driftTotal ?? 0,
          })}
        </Admonition>
      ) : null}
      {report.items.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('migrations.import.noItems')}</p>
      ) : (
        <ItemsTable report={report} editable={open} />
      )}
      {report.state === 'resolved' ? <BaselineAction report={report} tier={tier} /> : null}
      {open ? (
        <p className="m-0 text-xs text-foreground-light">{t('migrations.import.note')}</p>
      ) : null}
    </div>
  )
}

function ItemsTable({
  report,
  editable,
}: {
  readonly report: ImportReport
  readonly editable: boolean
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('migrations.import.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('migrations.import.column.file')}</TableHead>
          <TableHead scope="col">{t('migrations.import.column.classification')}</TableHead>
          <TableHead scope="col">{t('migrations.import.column.evidence')}</TableHead>
          <TableHead scope="col">{t('migrations.import.column.decision')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.items.map((item) => (
          <TableRow key={item.itemId} data-item={item.itemId}>
            <TableCell>
              <UntrustedName name={item.name} label={t('migrations.import.column.file')} />
              <div className="text-xs text-foreground-lighter">
                <UntrustedName
                  name={item.legacyId}
                  mono
                  label={t('migrations.import.column.file')}
                />
              </div>
            </TableCell>
            <TableCell>
              <StateText state={item.state} />
            </TableCell>
            <TableCell className="text-xs">
              {item.evidenceStrength === undefined ||
              item.evidenceStrength === null ||
              !Object.hasOwn(STRENGTH_LABELS, item.evidenceStrength) ? null : (
                <div className="mb-1 text-foreground">
                  {t('migrations.import.strength')}{' '}
                  <strong>{t(STRENGTH_LABELS[item.evidenceStrength])}</strong>
                </div>
              )}
              {item.failing === undefined ||
              item.failing === null ||
              item.failing.total === 0 ? null : (
                <div className="mb-1 text-foreground" data-failing={item.failing.total}>
                  {t('migrations.import.failing', { count: item.failing.total })}
                </div>
              )}
              {item.evidence === undefined || item.evidence.length === 0 ? (
                <span className="text-foreground-light">{t('migrations.import.noEvidence')}</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {item.evidence.map((line) => (
                    <li key={line}>
                      <UntrustedName
                        name={line}
                        mono
                        maxCodePoints={60}
                        label={t('migrations.import.column.evidence')}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </TableCell>
            <TableCell>
              {item.decision === null ? (
                <span className="text-foreground-light">
                  {needsDecision(item)
                    ? t('migrations.import.undecided')
                    : t('migrations.import.noDecisionNeeded')}
                </span>
              ) : (
                <div className="text-xs">
                  <div>
                    <StateText state={item.decision.state} />{' '}
                    <ObservedTime observedAt={item.decision.decidedAt} />
                  </div>
                  <UntrustedName
                    name={item.decision.note}
                    maxCodePoints={200}
                    label={t('migrations.import.note.label')}
                  />
                </div>
              )}
              {editable &&
              isItemId(item.itemId) &&
              (needsDecision(item) || item.decision !== null) ? (
                <DecideItem report={report} item={item} />
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function StateText({ state }: { readonly state: string }): ReactNode {
  const label = stateLabel(state)
  return label === undefined ? (
    <UntrustedName name={state} label={t('migrations.import.column.classification')} />
  ) : (
    <span>{label}</span>
  )
}

/** Records a decision on one review item (`POST …/items/{itemId}/decision`). */
function DecideItem({
  report,
  item,
}: {
  readonly report: ImportReport
  readonly item: Item
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const path = useTargetPath()
  const [state, setState] = useState<DecisionState | ''>('')
  const [note, setNote] = useState('')
  const stateId = useId()
  const noteId = useId()
  const reset = (): void => {
    setState('')
    setNote('')
  }
  const decide = async (): Promise<void> => {
    const trimmed = note.trim()
    if (!isDecisionState(state)) {
      throw new ApiError('VALIDATION_FAILED', 422, t('migrations.import.decide.stateMissing'))
    }
    if (trimmed.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 422, t('migrations.import.decide.noteMissing'))
    }
    try {
      const updated = await withReauth(client, confirmIdentity, () =>
        client.operation('decideImportItem', {
          params: { target: path, importReportId: report.id, itemId: item.itemId },
          body: { state, note: trimmed },
        }),
      )
      queryClient.setQueryData(opsKeys.report(path, report.id), updated)
    } catch (error) {
      throw actionError(error)
    }
  }
  return (
    <div className="mt-2">
      <ConfirmDialog
        onOpenChange={(isOpen) => {
          if (!isOpen) reset()
        }}
        trigger={
          <Button variant="default" size="tiny" data-decide={item.itemId}>
            {t('migrations.import.decide.button')}
          </Button>
        }
        title={t('migrations.import.decide.title')}
        description={t('migrations.import.decide.description')}
        actionLabel={t('migrations.import.decide.action')}
        onConfirm={decide}
      >
        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={stateId} className="text-sm font-medium">
              {t('migrations.import.decide.state')}
            </label>
            <select
              id={stateId}
              value={state}
              onChange={(event) => {
                const next = event.target.value
                setState(isDecisionState(next) ? next : '')
              }}
              className="h-8 rounded-md border border-default bg-surface-100 px-2 text-sm focus-ring"
            >
              <option value="">{t('migrations.import.decide.choose')}</option>
              {DECISION_STATES.map((value) => (
                <option key={value} value={value}>
                  {t(STATE_LABELS[value])}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-sm font-medium">
              {t('migrations.import.decide.note')}
            </label>
            <Textarea
              id={noteId}
              value={note}
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="m-0 text-xs text-foreground-light">
              {t('migrations.import.decide.noteHint', { max: NOTE_MAX_LENGTH })}
            </p>
          </div>
          <DecisionConsequence item={item} state={state} />
        </div>
      </ConfirmDialog>
    </div>
  )
}

/**
 * What the chosen decision means for the baseline's verification (Part A
 * follow-up 3, F1): accepting a file whose expectations did not hold
 * excuses exactly those, said before anyone is surprised later.
 */
function DecisionConsequence({
  item,
  state,
}: {
  readonly item: Item
  readonly state: DecisionState | ''
}): ReactNode {
  if (state === 'superseded') {
    return (
      <p role="note" className="m-0 text-sm text-foreground-light">
        {t('migrations.import.decide.supersededUnchecked')}
      </p>
    )
  }
  const failing = item.failing
  if (
    (state !== 'recorded_present' && state !== 'unrecorded_present') ||
    failing === undefined ||
    failing === null
  ) {
    return null
  }
  if (failing.total === 0) {
    // Nothing failed at the analysis: accepting excuses nothing, so all of it must hold.
    return (
      <p role="note" className="m-0 text-sm text-foreground-light" data-excuses={0}>
        {t('migrations.import.decide.excusesNothing')}
      </p>
    )
  }
  return (
    <div role="note" className="flex flex-col gap-1 text-sm" data-excuses={failing.total}>
      <p className="m-0">{t('migrations.import.decide.excuses', { count: failing.total })}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
        {failing.items.map((f) => (
          <li key={`${f.statement ?? ''}:${f.kind}:${f.object}:${f.failed.join(',')}`}>
            <UntrustedName
              name={`${f.object} (${f.failed.join(', ')})`}
              maxCodePoints={120}
              label={t('migrations.import.column.evidence')}
            />
          </li>
        ))}
      </ul>
      {failing.total > failing.items.length ? (
        <p className="m-0 text-xs text-foreground-light">
          {t('migrations.import.decide.excusesMore', {
            count: failing.total - failing.items.length,
          })}
        </p>
      ) : null}
      {failing.items.some((f) => f.failed.includes('unreadable')) ? (
        <p className="m-0 text-xs" data-unreadable="true">
          {t('migrations.import.decide.excusesUnread')}
        </p>
      ) : null}
    </div>
  )
}

/** "Create baseline plan": the plan that writes the baseline; it changes nothing until applied. */
function BaselineAction({
  report,
  tier,
}: {
  readonly report: ImportReport
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  const path = useTargetPath()
  const create = async (): Promise<void> => {
    try {
      const plan = await withReauth(client, confirmIdentity, () =>
        client.operation('planBaseline', {
          params: { target: path },
          body: { importReportId: report.id },
        }),
      )
      const href = planPath(plan.id)
      if (href !== undefined) navigate(href)
    } catch (error) {
      throw actionError(error)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-foreground-light">{t('migrations.import.baseline.ready')}</p>
      <div>
        <ConfirmDialog
          trigger={
            <Button variant="primary" size="small">
              {t('migrations.import.baseline.button')}
            </Button>
          }
          title={t('migrations.import.baseline.title')}
          description={t('migrations.import.baseline.description')}
          actionLabel={t('migrations.import.baseline.action')}
          tier={tier}
          onConfirm={create}
        />
      </div>
    </div>
  )
}
