import type { MigrationLintResult, SqlClassification } from '@exponetdb/sdk/operations'
import { Button, copyToClipboard, Input, Label, Textarea, toast } from '@exponetdb/ui'
import type { SqlEditorProps } from '@exponetdb/ui-data'
import {
  ConfirmDialog,
  FailedReadState,
  LoadingState,
  MarkedCode,
  type ReadFailure,
  UntrustedText,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { type ComponentType, type ReactNode, Suspense, useId, useMemo, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'
import { nounPhrase } from '../target/phrases.ts'
import {
  allClasses,
  type BundleDraftInput,
  bundleDirectory,
  type DeclaredCompatibility,
  MIGRATION_NAME,
  MIGRATION_NAME_MAX,
  manifestText,
  needsNonTransactional,
  newUlid,
  parseDependencies,
  suggestedCompatibility,
  verifySkeleton,
} from './sql-model.ts'

/**
 * "Create migration" (information-architecture.md §4): the text of the editor
 * becomes the `up.sql` of a bundle draft with a `migration.yaml` built from
 * what the person enters and a `verify.sql` skeleton generated here as text
 * the person edits. The server lints the draft; "Create plan" sends it to the
 * migration plan endpoint and opens the plan for review. Nothing is applied
 * from this page.
 */
const COMPATIBILITIES: readonly DeclaredCompatibility[] = [
  'additive',
  'potentially_breaking',
  'data_rewrite',
  'destructive',
]

type LintState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: ReadFailure }
  | { readonly state: 'ready'; readonly value: MigrationLintResult; readonly forText: string }

function failureOf(error: unknown): ReadFailure {
  const e = actionError(error)
  return { code: e.code, message: e.message }
}

export function DraftPanel(props: {
  readonly path: string
  readonly projectId: string
  readonly tier: 'prod' | 'nonprod'
  readonly postgresMajor: 16 | 17 | 18 | undefined
  readonly upSql: string
  readonly classification: SqlClassification | undefined
  readonly Editor: ComponentType<SqlEditorProps>
  readonly onClose: () => void
}): ReactNode {
  const id = useId()
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  const classes = allClasses(props.classification)
  const [migrationId] = useState(() => newUlid())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [depends, setDepends] = useState('')
  const [transactional, setTransactional] = useState(() => !needsNonTransactional(classes))
  const [compatibility, setCompatibility] = useState<DeclaredCompatibility>(() =>
    suggestedCompatibility(classes),
  )
  const [notes, setNotes] = useState('')
  const [verify, setVerify] = useState(() => verifySkeleton(props.classification))
  const [lint, setLint] = useState<LintState>({ state: 'idle' })
  const [planning, setPlanning] = useState(false)

  const nameOk = MIGRATION_NAME.test(name) && name.length <= MIGRATION_NAME_MAX
  const dependencies = parseDependencies(depends)
  const notesNeeded = compatibility !== 'additive' && notes.trim().length === 0
  const ready =
    nameOk &&
    description.trim().length > 0 &&
    dependencies.invalid.length === 0 &&
    !notesNeeded &&
    props.upSql.trim().length > 0

  const input: BundleDraftInput = {
    id: migrationId,
    name,
    description: description.trim(),
    dependsOn: dependencies.valid,
    transactional,
    compatibility,
    notes: notes.trim(),
  }
  const manifest = manifestText(input)
  const directory = bundleDirectory(migrationId, name)
  const bundle = useMemo(
    () => ({
      directory,
      files: { 'migration.yaml': manifest, 'up.sql': props.upSql, 'verify.sql': verify },
    }),
    [directory, manifest, props.upSql, verify],
  )
  const signature = JSON.stringify(bundle)

  const check = async (): Promise<void> => {
    setLint({ state: 'loading' })
    try {
      const value = await client.operation('lintMigrations', {
        params: { projectId: props.projectId },
        body: {
          bundles: [bundle],
          ...(props.postgresMajor === undefined ? {} : { postgresMajor: props.postgresMajor }),
        },
      })
      setLint({ state: 'ready', value, forText: signature })
    } catch (error) {
      setLint({ state: 'failed', error: failureOf(error) })
    }
  }

  const createPlan = async (): Promise<void> => {
    setPlanning(true)
    try {
      const plan = await withReauth(client, confirmIdentity, () =>
        client.operation('planMigrations', {
          params: { target: props.path },
          body: { bundles: [bundle] },
        }),
      )
      const to = planPath(plan.id)
      if (to === undefined) throw new Error('no plan')
      navigate(to)
    } catch (error) {
      throw actionError(error)
    } finally {
      setPlanning(false)
    }
  }

  const copy = async (text: string): Promise<void> => {
    const done = await copyToClipboard(text)
    if (done) toast.success(t('sql.draft.copied'))
    else toast.error(t('sql.draft.copyFailed'))
  }

  const Editor = props.Editor
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-md border border-default p-4"
      data-block="sql-bundle-draft"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="text-base font-medium">
            {t('sql.draft.title')}
          </h2>
          <p className="text-sm text-foreground-light">{t('sql.draft.intro')}</p>
        </div>
        <Button variant="outline" size="tiny" onClick={props.onClose}>
          {t('sql.draft.close')}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('sql.draft.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={`${id}-name-hint`}
            aria-invalid={(name.length > 0 && !nameOk) || undefined}
            autoComplete="off"
          />
          <p id={`${id}-name-hint`} className="text-xs text-foreground-lighter">
            {name.length > 0 && !nameOk ? t('sql.draft.nameInvalid') : t('sql.draft.nameHint')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-id`}>{t('sql.draft.id')}</Label>
          <MarkedCode id={`${id}-id`} text={migrationId} className="text-sm" />
          <p className="text-xs text-foreground-lighter">{t('sql.draft.idHint')}</p>
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-description`}>{t('sql.draft.description')}</Label>
          <Textarea
            id={`${id}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-depends`}>{t('sql.draft.dependsOn')}</Label>
          <Textarea
            id={`${id}-depends`}
            value={depends}
            onChange={(event) => setDepends(event.target.value)}
            rows={3}
            aria-describedby={`${id}-depends-hint`}
            aria-invalid={dependencies.invalid.length > 0 || undefined}
            className="font-mono"
          />
          <p id={`${id}-depends-hint`} className="text-xs text-foreground-lighter">
            {dependencies.invalid.length > 0
              ? t('sql.draft.dependsInvalid', { count: dependencies.invalid.length })
              : t('sql.draft.dependsHint')}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-compat`}>{t('sql.draft.compatibility')}</Label>
            <select
              id={`${id}-compat`}
              value={compatibility}
              onChange={(event) =>
                setCompatibility(
                  COMPATIBILITIES.find((c) => c === event.target.value) ?? 'additive',
                )
              }
              className="h-[30px] rounded-md border border-control bg-control px-2 text-sm"
            >
              {COMPATIBILITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={transactional}
              onChange={(event) => setTransactional(event.target.checked)}
            />
            {t('sql.draft.transactional')}
          </label>
          {needsNonTransactional(classes) && transactional ? (
            <p className="text-xs text-foreground-light">{t('sql.draft.nonTxHint')}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-notes`}>{t('sql.draft.notes')}</Label>
          <Textarea
            id={`${id}-notes`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            aria-invalid={notesNeeded || undefined}
            aria-describedby={`${id}-notes-hint`}
          />
          <p id={`${id}-notes-hint`} className="text-xs text-foreground-lighter">
            {notesNeeded ? t('sql.draft.notesNeeded') : t('sql.draft.notesHint')}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('sql.draft.verifyTitle')}</h3>
          <Button
            variant="outline"
            size="tiny"
            onClick={() => setVerify(verifySkeleton(props.classification))}
          >
            {t('sql.draft.verifyReset')}
          </Button>
        </div>
        <p className="text-xs text-foreground-lighter">{t('sql.draft.verifyHint')}</p>
        <Suspense fallback={<LoadingState what={nounPhrase('sql.editor.what')} lines={4} />}>
          <Editor
            value={verify}
            onChange={setVerify}
            mode="draft"
            label={t('sql.draft.verifyLabel')}
            minLines={6}
            maxLines={20}
          />
        </Suspense>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer">{t('sql.draft.manifestTitle')}</summary>
        <div className="mt-2 flex flex-col gap-2">
          <UntrustedText
            text={manifest}
            mono
            maxLines={40}
            label="migration.yaml"
            className="text-xs"
          />
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="tiny" onClick={() => void copy(manifest)}>
          {t('sql.draft.copyManifest')}
        </Button>
        <Button variant="outline" size="tiny" onClick={() => void copy(props.upSql)}>
          {t('sql.draft.copyUp')}
        </Button>
        <Button variant="outline" size="tiny" onClick={() => void copy(verify)}>
          {t('sql.draft.copyVerify')}
        </Button>
      </div>

      <LintView state={lint} current={signature} onRetry={() => void check()} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="tiny"
          onClick={() => void check()}
          disabled={!ready || lint.state === 'loading'}
        >
          {t('sql.draft.check')}
        </Button>
        <ConfirmDialog
          trigger={
            <Button variant="primary" size="tiny" disabled={!ready || planning}>
              {t('sql.draft.plan')}
            </Button>
          }
          title={t('sql.draft.planTitle')}
          description={
            <span className="flex flex-col gap-2">
              <span>{t('sql.draft.planBody')}</span>
              <MarkedCode text={props.path} />
            </span>
          }
          actionLabel={t('sql.draft.planAction')}
          tier={props.tier}
          onConfirm={createPlan}
        />
        {!ready ? (
          <p className="text-xs text-foreground-lighter">{t('sql.draft.incomplete')}</p>
        ) : null}
      </div>
    </section>
  )
}

function LintView(props: {
  readonly state: LintState
  readonly current: string
  readonly onRetry: () => void
}): ReactNode {
  const { state } = props
  switch (state.state) {
    case 'idle':
      return null
    case 'loading':
      return <LoadingState what={nounPhrase('sql.lint.what')} lines={2} />
    case 'failed':
      return (
        <FailedReadState
          what={nounPhrase('sql.lint.what')}
          error={state.error}
          onRetry={props.onRetry}
          headingLevel={3}
        >
          <p className="text-sm">{t('sql.lint.failedNote')}</p>
        </FailedReadState>
      )
    case 'ready': {
      const findings = state.value.bundles.flatMap((bundle) => bundle.findings)
      const blocking = findings.filter((finding) => finding.blocking).length
      const outdated = state.forText !== props.current
      return (
        <section
          aria-labelledby="sql-lint-title"
          className="flex flex-col gap-2"
          data-block="sql-lint"
        >
          <h3 id="sql-lint-title" className="text-sm font-medium">
            {t('sql.lint.title')}
          </h3>
          {outdated ? (
            <p role="status" className="text-sm font-medium">
              {t('sql.lint.outdated')}
            </p>
          ) : null}
          <p className="text-sm">
            {findings.length === 0
              ? t('sql.lint.none')
              : t('sql.lint.count', { count: findings.length, blocking })}
          </p>
          {state.value.graph.valid ? null : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {state.value.graph.errors.map((error) => (
                <li key={`${error.code}-${error.migrationIds.join(',')}`}>
                  {t('sql.lint.graphError', { code: error.code })}
                </li>
              ))}
            </ul>
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {findings.map((finding, index) => (
              <li
                // Findings have no identity of their own; the order is the server's.
                // biome-ignore lint/suspicious/noArrayIndexKey: the server's order is the identity
                key={index}
                className="flex flex-col gap-1 rounded-md border border-default p-2 text-sm"
                data-finding={finding.rule}
              >
                <span className="font-medium">
                  {t('sql.lint.finding', {
                    level: finding.level,
                    rule: finding.rule,
                    file: finding.file ?? '-',
                    blocking: finding.blocking ? t('sql.lint.blocking') : t('sql.lint.notBlocking'),
                  })}
                </span>
                <UntrustedText text={finding.message} maxLines={4} label={t('sql.lint.message')} />
              </li>
            ))}
          </ul>
        </section>
      )
    }
  }
}
