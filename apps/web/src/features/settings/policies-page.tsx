import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@exponetdb/ui'
import { readableValue, TierChip, TimestampInfo, UntrustedText } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds, NativeSelect } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { type StatusLine, StatusLines, useStatusLine } from '../access/status.tsx'
import { type PolicyRule, policiesQuery, type TargetItem, targetsQuery } from './keys.ts'
import {
  columnsOf,
  DATA_READ_MODES,
  DATA_READ_RULE,
  type DataReadMode,
  installationParams,
  isDataReadMode,
  latestSettings,
  modeByTier,
  modeLabel,
  modeText,
  parseColumns,
  parseParams,
  severityLabel,
  targetParams,
} from './policy-model.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/policies`: the policy rules with their defaults and configured
 * revisions (`GET /policy-settings`), and changes as plans
 * (`POST /policy-settings/plans`, `policy.manage`; the review page opens and
 * shows whether the change lowers safety, which only an owner may plan). The
 * data-read rule per tier (OD-13) comes first: who reads rows on production
 * and on non-production, at the installation and per target. Parameters are
 * shown as text; nothing in them is interpreted.
 */
export function PoliciesPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'policy.manage')
  const line = useStatusLine()
  const policies = useQuery(policiesQuery(client))
  const readable = toReadable(policies)
  return (
    <SettingsFrame
      title={t('settings.policies.title')}
      description={t('settings.policies.description')}
    >
      <StatusLines line={line} />
      {canManage ? null : (
        <p className="text-sm text-foreground-light">{t('settings.policies.manage.missing')}</p>
      )}
      <ListView
        readable={readable}
        error={policies.error}
        what={t('settings.policies.what')}
        permission="access.read"
        isEmpty={(value) => value.rules.length === 0}
        emptyTitle={t('settings.policies.empty.title')}
        emptyDescription={t('settings.policies.empty.body')}
        onRetry={() => void policies.refetch()}
        busy={policies.isFetching}
      >
        {(value) => {
          const dataRead = value.rules.find((rule) => rule.id === DATA_READ_RULE)
          return (
            <div className="flex flex-col gap-8">
              {dataRead === undefined ? (
                <p className="text-sm text-foreground-light">
                  {t('settings.policies.dataRead.missing')}
                </p>
              ) : (
                <DataReadSection rule={dataRead} line={line} canManage={canManage} />
              )}
              <section aria-labelledby="policy-rules-title" className="flex flex-col gap-3">
                <h2 id="policy-rules-title" className="text-base font-medium text-foreground">
                  {t('settings.policies.rules')}
                </h2>
                <ul id="policy-rules" className="cards flex flex-col gap-3">
                  {value.rules
                    .filter((rule) => rule.id !== DATA_READ_RULE)
                    .map((rule) => (
                      <RuleCard key={rule.id} rule={rule} line={line} canManage={canManage} />
                    ))}
                </ul>
              </section>
            </div>
          )
        }}
      </ListView>
    </SettingsFrame>
  )
}

function modeOf(params: Readonly<Record<string, unknown>>): DataReadMode | undefined {
  const mode = params['mode']
  return isDataReadMode(mode) ? mode : undefined
}

function DataReadSection({
  rule,
  line,
  canManage,
}: {
  readonly rule: PolicyRule
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  const params = installationParams(rule)
  const mode = modeOf(params)
  const targetSettings = latestSettings(rule).filter((setting) => setting.scopeKind === 'target')
  return (
    <section
      id="data-read-policy"
      aria-labelledby="data-read-title"
      className="flex flex-col gap-4 rounded-lg border border-default p-5"
    >
      <h2 id="data-read-title" className="text-base font-medium text-foreground">
        {t('settings.policies.dataRead.title')}
      </h2>
      <p className="text-sm text-foreground-light">{t('settings.policies.dataRead.description')}</p>
      {mode === undefined ? (
        <p className="text-sm text-foreground" role="alert">
          {t('settings.policies.dataRead.invalid')}
        </p>
      ) : (
        <ModeTable mode={mode} />
      )}
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('settings.policies.dataRead.masked')}
        </h3>
        {columnsOf(params['sensitiveColumns']).length === 0 ? (
          <p className="text-sm text-foreground-lighter">
            {t('settings.policies.dataRead.masked.none')}
          </p>
        ) : (
          <UntrustedText
            text={columnsOf(params['sensitiveColumns']).join('\n')}
            mono
            maxLines={20}
            label={t('settings.policies.dataRead.masked')}
          />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('settings.policies.dataRead.targets')}
        </h3>
        {targetSettings.length === 0 ? (
          <p className="text-sm text-foreground-lighter">
            {t('settings.policies.dataRead.targets.none')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {targetSettings.map((setting) => {
              const own = modeOf(setting.params)
              return (
                <li key={setting.scopeId} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono text-xs">{setting.scopeId}</code>
                  <span>
                    {own === undefined ? t('settings.policies.dataRead.inherits') : modeLabel(own)}
                  </span>
                  <span className="text-foreground-lighter">
                    {t('settings.policies.revision', { revision: setting.revision })}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {canManage ? <DataReadForm rule={rule} line={line} /> : null}
    </section>
  )
}

function ModeTable({ mode }: { readonly mode: DataReadMode }): ReactNode {
  const who = modeByTier(mode)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-foreground">
        {t('settings.policies.dataRead.current', { mode: modeLabel(mode) })}{' '}
        <span className="text-foreground-light">{modeText(mode)}</span>
      </p>
      <Table id="data-read-tiers">
        <TableCaption className="sr-only">{t('settings.policies.dataRead.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('settings.policies.dataRead.tier')}</TableHead>
            <TableHead scope="col">{t('settings.policies.dataRead.who')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-tier="prod">
            <TableCell>
              <TierChip tier="prod" />
            </TableCell>
            <TableCell>{who.prod}</TableCell>
          </TableRow>
          <TableRow data-tier="nonprod">
            <TableCell>
              <TierChip tier="nonprod" />
            </TableCell>
            <TableCell>{who.nonprod}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function DataReadForm({
  rule,
  line,
}: {
  readonly rule: PolicyRule
  readonly line: StatusLine
}): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const id = useId()
  const targets = useQuery(targetsQuery(client))
  const targetList: readonly TargetItem[] = readableValue(toReadable(targets))?.items ?? []
  const initial = installationParams(rule)
  const [scope, setScope] = useState('installation')
  const [mode, setMode] = useState<DataReadMode>(modeOf(initial) ?? 'by_tier')
  const [columns, setColumns] = useState(columnsOf(initial['sensitiveColumns']).join('\n'))
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const choose = (next: string): void => {
    setScope(next)
    const params = next === 'installation' ? installationParams(rule) : targetParams(rule, next)
    setMode(modeOf(params) ?? 'by_tier')
    setColumns(columnsOf(params['sensitiveColumns']).join('\n'))
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const parsed = parseColumns(columns)
    if (!parsed.ok) {
      setError(t('settings.policies.dataRead.columns.invalid', { line: parsed.line }))
      return
    }
    setError(undefined)
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      await createPlan(() =>
        client.operation('planPolicySettings', {
          body: {
            ruleId: DATA_READ_RULE,
            scopeKind: scope === 'installation' ? 'installation' : 'target',
            scopeId: scope,
            params: { mode, sensitiveColumns: parsed.columns },
          },
        }),
      )
    } catch (failure) {
      line.fail(failure)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const chosenTarget = targetList.find((target) => target.id === scope)
  return (
    <form id="data-read-form" className="flex flex-col gap-3" noValidate onSubmit={submit}>
      <h3 className="text-sm font-medium text-foreground">
        {t('settings.policies.dataRead.change')}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id={`${id}-scope`}
          label={t('settings.policies.scope')}
          description={
            targets.isError
              ? t('settings.policies.scope.targetsFailed', { reason: describeError(targets.error) })
              : t('settings.policies.scope.hint')
          }
        >
          <NativeSelect
            id={`${id}-scope`}
            value={scope}
            aria-describedby={`${id}-scope-description`}
            options={[
              { value: 'installation', label: t('settings.policies.scope.installation') },
              ...targetList.map((target) => ({
                value: target.id,
                label: t('settings.policies.scope.target', {
                  path: target.path,
                  tier:
                    target.tier === 'prod' ? t('settings.tier.prod') : t('settings.tier.nonprod'),
                }),
              })),
            ]}
            onChange={(event) => choose(event.target.value)}
          />
        </Field>
        <Field
          id={`${id}-mode`}
          label={t('settings.policies.dataRead.modeLabel')}
          description={modeText(mode)}
        >
          <NativeSelect
            id={`${id}-mode`}
            value={mode}
            aria-describedby={`${id}-mode-description`}
            options={DATA_READ_MODES.map((value) => ({ value, label: modeLabel(value) }))}
            onChange={(event) => {
              if (isDataReadMode(event.target.value)) setMode(event.target.value)
            }}
          />
        </Field>
      </div>
      {chosenTarget?.tier === 'prod' ? (
        <p className="flex items-center gap-2 text-sm text-foreground-light">
          <TierChip tier="prod" /> {t('settings.policies.dataRead.prodTarget')}
        </p>
      ) : null}
      <Field
        id={`${id}-columns`}
        label={t('settings.policies.dataRead.columns')}
        description={t('settings.policies.dataRead.columns.hint')}
        error={error}
      >
        <Textarea
          id={`${id}-columns`}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          value={columns}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-columns-description`}
          onChange={(event) => setColumns(event.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('settings.policies.plan')}
        </Button>
      </div>
    </form>
  )
}

function RuleCard({
  rule,
  line,
  canManage,
}: {
  readonly rule: PolicyRule
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const formId = useId()
  const settings = latestSettings(rule)
  return (
    <li
      className="card flex flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4"
      data-rule={rule.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-sm text-foreground">{rule.id}</h3>
        <span className="flex items-center gap-2">
          <Badge>{severityLabel(rule.severity)}</Badge>
          <span className="text-xs text-foreground-lighter">
            {t('settings.policies.version', { version: rule.version })}
          </span>
        </span>
      </div>
      <p className="text-sm text-foreground-light">{rule.description}</p>
      <p className="text-xs text-foreground-lighter">
        {t('settings.policies.appliesTo', { kinds: rule.appliesTo.join(', ') })}
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">{t('settings.policies.defaults')}</p>
        <UntrustedText
          text={JSON.stringify(rule.defaults)}
          mono
          maxLines={6}
          label={t('settings.policies.defaults')}
        />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">{t('settings.policies.settings')}</p>
        {settings.length === 0 ? (
          <p className="text-sm text-foreground-lighter">{t('settings.policies.settings.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {settings.map((setting) => (
              <li
                key={`${setting.scopeKind}:${setting.scopeId}`}
                className="flex flex-col gap-0.5 text-sm"
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono text-xs">
                    {setting.scopeKind === 'installation'
                      ? t('settings.policies.scope.installation')
                      : `${setting.scopeKind} ${setting.scopeId}`}
                  </code>
                  <span className="text-foreground-lighter">
                    {t('settings.policies.revision', { revision: setting.revision })}
                  </span>
                  <TimestampInfo timestamp={setting.createdAt} />
                </span>
                <UntrustedText
                  text={JSON.stringify(setting.params)}
                  mono
                  maxLines={6}
                  label={t('settings.policies.settings')}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {canManage ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="text"
              size="tiny"
              aria-expanded={open}
              aria-controls={formId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t('settings.policies.change.hide') : t('settings.policies.change')}
            </Button>
          </div>
          <div id={formId} hidden={!open}>
            {open ? <RuleForm rule={rule} line={line} /> : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

function RuleForm({
  rule,
  line,
}: {
  readonly rule: PolicyRule
  readonly line: StatusLine
}): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const id = useId()
  const [text, setText] = useState(JSON.stringify(installationParams(rule), null, 2))
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const params = parseParams(text)
    if (params === undefined) {
      setError(t('settings.policies.params.invalid'))
      return
    }
    setError(undefined)
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      await createPlan(() =>
        client.operation('planPolicySettings', {
          body: { ruleId: rule.id, scopeKind: 'installation', scopeId: 'installation', params },
        }),
      )
    } catch (failure) {
      line.fail(failure)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form className="rule-form flex flex-col gap-2" noValidate onSubmit={submit}>
      <Field
        id={`${id}-params`}
        label={t('settings.policies.params', { rule: rule.id })}
        description={t('settings.policies.params.hint')}
        error={error}
      >
        <Textarea
          id={`${id}-params`}
          rows={5}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          value={text}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-params-description`}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('settings.policies.plan')}
        </Button>
      </div>
    </form>
  )
}
