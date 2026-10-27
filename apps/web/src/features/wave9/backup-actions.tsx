import type { Operation } from '@exponetdb/sdk/operations'
import { Checkbox, Input, Label, Textarea } from '@exponetdb/ui'
import { ConfirmDialog, ReadableView } from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { nodesQuery } from '../infrastructure/keys.ts'
import { actionError } from '../plans/failure.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { FormDialog } from './form-dialog.tsx'
import { wave9Keys } from './keys.ts'
import {
  allowsRuns,
  type BackupEntry,
  isBackupId,
  isNodeId,
  isObserved,
  LAYER_KEYS,
  PROVIDER_KEYS,
  type RepositorySummary,
  type Restore,
} from './model.ts'
import { ActionButton, type Refusals, SelectField, useHolds, useInlineOperation } from './parts.tsx'

/**
 * The actions of a cluster's backups. Each is offered only as what it is:
 * reading the engine catalog again and verifying one backup start an inline
 * operation (linked, not reported as done); a backup run, a drill, a
 * recovery and a discard are plans whose review page shows what would run
 * and who must approve (execution of restores is human-only, and a recovery
 * is confirmed there with the target path typed); an offline drill is a
 * person's attestation, recorded and labeled as one. An action the person
 * lacks the permission for, or the server refused as not activated, is shown
 * disabled with the reason.
 */
export interface ClusterActionProps {
  readonly clusterId: string
  readonly targetPath: string
  readonly tier: 'prod' | 'nonprod'
  readonly repositories: readonly RepositorySummary[]
  readonly backups: readonly BackupEntry[]
  readonly refusals: Refusals
}

function repositoryLabel(repository: RepositorySummary): string {
  return t('wave9.repository.option', {
    layer: t(LAYER_KEYS[repository.layer]),
    engine: repository.engine,
    provider: t(PROVIDER_KEYS[repository.provider]),
    id: repository.id,
  })
}

/** The reason an action is not offered, or `undefined` when it is. */
export function useReason(refusals: Refusals) {
  const holds = useHolds()
  return (action: string, permission: Parameters<typeof holds>[0], extra?: string) => {
    if (!holds(permission)) return t('wave9.action.notPermitted', { permission })
    return refusals.reasonOf(action) ?? extra
  }
}

function useInvalidateCluster(clusterId: string): () => void {
  const queryClient = useQueryClient()
  return () => void queryClient.invalidateQueries({ queryKey: wave9Keys.cluster(clusterId) })
}

// ----- refresh the catalog -----

export function RefreshCatalog(props: {
  readonly clusterId: string
  readonly refusals: Refusals
  readonly onStarted: (operation: Operation) => void
}): ReactNode {
  const { client } = useApi()
  const start = useInlineOperation()
  const reason = useReason(props.refusals)
  const invalidate = useInvalidateCluster(props.clusterId)
  const [open, setOpen] = useState(false)
  return (
    <>
      <ActionButton
        label={t('wave9.refresh')}
        disabledReason={reason('refresh', 'backups.run')}
        onClick={() => setOpen(true)}
        data-action="refresh"
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.refresh.title')}
        description={t('wave9.refresh.body')}
        actionLabel={t('wave9.refresh.action')}
        onConfirm={async () => {
          try {
            const operation = await start(() =>
              client.operation('refreshBackupCatalog', {
                params: { clusterId: props.clusterId },
                body: {},
              }),
            )
            props.onStarted(operation)
            invalidate()
          } catch (error) {
            props.refusals.record('refresh', error)
            throw error
          }
        }}
      />
    </>
  )
}

// ----- verify one backup -----

export function VerifyBackup(props: {
  readonly clusterId: string
  readonly backup: BackupEntry
  readonly tier: 'prod' | 'nonprod'
  readonly refusals: Refusals
  readonly onStarted: (operation: Operation) => void
}): ReactNode {
  const { client } = useApi()
  const start = useInlineOperation()
  const reason = useReason(props.refusals)
  const invalidate = useInvalidateCluster(props.clusterId)
  const [open, setOpen] = useState(false)
  const { backup } = props
  const notVerifiable =
    backup.state !== 'succeeded'
      ? t('wave9.verify.notFinished')
      : backup.divergence !== 'none'
        ? t('wave9.verify.missing')
        : !isBackupId(backup.id)
          ? t('wave9.verify.badId')
          : undefined
  return (
    <>
      <ActionButton
        label={t('wave9.verify')}
        disabledReason={reason('verify', 'backups.run', notVerifiable)}
        onClick={() => setOpen(true)}
        data-action="verify"
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.verify.title')}
        description={t('wave9.verify.body')}
        actionLabel={t('wave9.verify.action')}
        tier={props.tier}
        onConfirm={async () => {
          try {
            const operation = await start(() =>
              client.operation('verifyBackup', {
                params: { clusterId: props.clusterId, backupId: backup.id },
                body: {},
              }),
            )
            props.onStarted(operation)
            invalidate()
          } catch (error) {
            props.refusals.record('verify', error)
            throw error
          }
        }}
      />
    </>
  )
}

// ----- plan a backup run -----

const RUN_KINDS = ['full', 'differential', 'incremental', 'logical'] as const
type RunKind = (typeof RUN_KINDS)[number]
const RUN_KIND_KEYS = {
  full: 'wave9.kind.full',
  differential: 'wave9.kind.differential',
  incremental: 'wave9.kind.incremental',
  logical: 'wave9.kind.logical',
} as const

function kindsOf(repository: RepositorySummary | undefined): readonly RunKind[] {
  if (repository === undefined) return []
  return repository.engine === 'pgbackrest' ? ['full', 'differential', 'incremental'] : ['logical']
}

export function PlanBackupRun(props: ClusterActionProps): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const eligible = props.repositories.filter(
    (r) => allowsRuns(r.ownership) && r.state !== 'retired',
  )
  const [open, setOpen] = useState(false)
  const [repositoryId, setRepositoryId] = useState('')
  const [kind, setKind] = useState<RunKind | ''>('')
  const repository = eligible.find((r) => r.id === repositoryId) ?? eligible[0]
  const kinds = kindsOf(repository)
  const chosenKind = kinds.find((k) => k === kind) ?? kinds[0]
  return (
    <>
      <ActionButton
        label={t('wave9.run')}
        disabledReason={reason(
          'run',
          'backups.run',
          eligible.length === 0 ? t('wave9.run.noRepository') : undefined,
        )}
        onClick={() => setOpen(true)}
        data-action="run"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.run.title')}
        description={t('wave9.run.body')}
        submitLabel={t('wave9.run.submit')}
        problem={
          repository === undefined || chosenKind === undefined
            ? t('wave9.run.noRepository')
            : undefined
        }
        onFailure={(error) => props.refusals.record('run', error)}
        onSubmit={() =>
          repository === undefined || chosenKind === undefined
            ? Promise.reject(new Error('unreachable'))
            : createPlan(() =>
                client.operation('planBackupRun', {
                  params: { clusterId: props.clusterId },
                  body: { repositoryId: repository.id, kind: chosenKind },
                }),
              )
        }
      >
        {repository === undefined ? null : (
          <>
            <SelectField
              label={t('wave9.field.repository')}
              value={repository.id}
              options={eligible.map((r) => ({ value: r.id, label: repositoryLabel(r) }))}
              onChange={setRepositoryId}
            />
            {chosenKind === undefined ? null : (
              <SelectField
                label={t('wave9.field.kind')}
                value={chosenKind}
                options={kinds.map((k) => ({ value: k, label: t(RUN_KIND_KEYS[k]) }))}
                onChange={setKind}
              />
            )}
          </>
        )}
      </FormDialog>
    </>
  )
}

// ----- plan a drill -----

const SELECTIONS = ['latest', 'older', 'pitr_random', 'backup', 'pitr'] as const
type Selection = (typeof SELECTIONS)[number]
const SELECTION_KEYS = {
  latest: 'wave9.drill.selection.latest',
  older: 'wave9.drill.selection.older',
  pitr_random: 'wave9.drill.selection.pitrRandom',
  backup: 'wave9.drill.selection.backup',
  pitr: 'wave9.drill.selection.pitr',
} as const

/** A `datetime-local` value (the person's local time) as ISO 8601 UTC, or `undefined`. */
export function localToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function restorableBackups(backups: readonly BackupEntry[], repositoryId: string) {
  return backups.filter(
    (b) =>
      b.repositoryId === repositoryId &&
      b.state === 'succeeded' &&
      b.divergence === 'none' &&
      isBackupId(b.id),
  )
}

export function PlanDrill(props: ClusterActionProps): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const id = useId()
  const eligible = props.repositories.filter(
    (r) => isObserved(r.ownership) && r.state !== 'retired',
  )
  const [open, setOpen] = useState(false)
  const [repositoryId, setRepositoryId] = useState('')
  const [selection, setSelection] = useState<Selection>('latest')
  const [backupId, setBackupId] = useState('')
  const [at, setAt] = useState('')
  const repository = eligible.find((r) => r.id === repositoryId) ?? eligible[0]
  const backups = repository === undefined ? [] : restorableBackups(props.backups, repository.id)
  const backup = backups.find((b) => b.id === backupId) ?? backups[0]
  const atIso = localToIso(at)
  const problem =
    repository === undefined
      ? t('wave9.drill.noRepository')
      : selection === 'backup' && backup === undefined
        ? t('wave9.drill.noBackup')
        : selection === 'pitr' && atIso === undefined
          ? t('wave9.field.time.invalid')
          : undefined
  const body = () => {
    if (repository === undefined) throw new Error('unreachable')
    const chosen =
      selection === 'backup' && backup !== undefined
        ? ({ kind: 'backup', backupId: backup.id } as const)
        : selection === 'pitr' && atIso !== undefined
          ? ({ kind: 'pitr', at: atIso } as const)
          : selection === 'older'
            ? ({ kind: 'older' } as const)
            : selection === 'pitr_random'
              ? ({ kind: 'pitr_random' } as const)
              : ({ kind: 'latest' } as const)
    return { repositoryId: repository.id, selection: chosen }
  }
  return (
    <>
      <ActionButton
        label={t('wave9.drill')}
        disabledReason={reason(
          'drill',
          'restore.plan',
          eligible.length === 0 ? t('wave9.drill.noRepository') : undefined,
        )}
        onClick={() => setOpen(true)}
        data-action="drill"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.drill.title')}
        description={t('wave9.drill.body')}
        submitLabel={t('wave9.drill.submit')}
        problem={problem}
        onFailure={(error) => props.refusals.record('drill', error)}
        onSubmit={() =>
          createPlan(() =>
            client.operation('planDrill', { params: { clusterId: props.clusterId }, body: body() }),
          )
        }
      >
        {repository === undefined ? null : (
          <>
            <SelectField
              label={t('wave9.field.repository')}
              value={repository.id}
              options={eligible.map((r) => ({ value: r.id, label: repositoryLabel(r) }))}
              onChange={setRepositoryId}
            />
            <SelectField
              label={t('wave9.drill.selection')}
              value={selection}
              options={SELECTIONS.map((s) => ({ value: s, label: t(SELECTION_KEYS[s]) }))}
              onChange={setSelection}
            />
            {selection === 'backup' ? (
              backup === undefined ? (
                <p className="m-0 text-sm text-foreground-light">{t('wave9.drill.noBackup')}</p>
              ) : (
                <SelectField
                  label={t('wave9.field.backup')}
                  value={backup.id}
                  options={backups.map((b) => ({
                    value: b.id,
                    label: t('wave9.backup.option', { kind: b.kind, at: b.startedAt, id: b.id }),
                  }))}
                  onChange={setBackupId}
                />
              )
            ) : null}
            {selection === 'pitr' ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-at`}>{t('wave9.field.time')}</Label>
                <Input
                  id={`${id}-at`}
                  type="datetime-local"
                  size="small"
                  value={at}
                  onChange={(event) => setAt(event.target.value)}
                />
              </div>
            ) : null}
          </>
        )}
      </FormDialog>
    </>
  )
}

// ----- plan a recovery -----

const SOURCES = ['latest', 'backup', 'pointInTime'] as const
type Source = (typeof SOURCES)[number]
const SOURCE_KEYS = {
  latest: 'wave9.recovery.source.latest',
  backup: 'wave9.recovery.source.backup',
  pointInTime: 'wave9.recovery.source.time',
} as const

export function PlanRecovery(props: ClusterActionProps): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const id = useId()
  const eligible = props.repositories.filter(
    (r) => isObserved(r.ownership) && r.state !== 'retired',
  )
  const [open, setOpen] = useState(false)
  const [repositoryId, setRepositoryId] = useState('')
  const [source, setSource] = useState<Source>('latest')
  const [backupId, setBackupId] = useState('')
  const [at, setAt] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [why, setWhy] = useState('')
  const repository = eligible.find((r) => r.id === repositoryId) ?? eligible[0]
  const backups = repository === undefined ? [] : restorableBackups(props.backups, repository.id)
  const backup = backups.find((b) => b.id === backupId) ?? backups[0]
  const atIso = localToIso(at)
  const reasonText = why.trim()
  const problem =
    repository === undefined
      ? t('wave9.drill.noRepository')
      : source === 'backup' && backup === undefined
        ? t('wave9.drill.noBackup')
        : source === 'pointInTime' && atIso === undefined
          ? t('wave9.field.time.invalid')
          : !isNodeId(nodeId)
            ? t('wave9.recovery.node.required')
            : reasonText.length === 0
              ? t('wave9.recovery.reason.required')
              : undefined
  const submit = () => {
    if (repository === undefined) return Promise.reject(new Error('unreachable'))
    const from =
      source === 'backup' && backup !== undefined
        ? { backupId: backup.id }
        : source === 'pointInTime' && atIso !== undefined
          ? { pointInTime: atIso }
          : ({ latest: true } as const)
    return createPlan(() =>
      client.operation('planRestore', {
        params: { target: props.targetPath },
        body: {
          purpose: 'recovery',
          repositoryId: repository.id,
          source: from,
          destination: { kind: 'new_cluster', nodeId },
          reason: reasonText,
        },
      }),
    )
  }
  return (
    <>
      <ActionButton
        label={t('wave9.recovery')}
        disabledReason={reason(
          'recovery',
          'restore.plan',
          eligible.length === 0 ? t('wave9.drill.noRepository') : undefined,
        )}
        onClick={() => setOpen(true)}
        destructive
        data-action="recovery"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.recovery.title')}
        description={t('wave9.recovery.body', { path: props.targetPath })}
        submitLabel={t('wave9.recovery.submit')}
        problem={problem}
        onFailure={(error) => props.refusals.record('recovery', error)}
        onSubmit={submit}
      >
        {repository === undefined ? null : (
          <>
            <p className="m-0 text-sm text-warning-600" data-slot="recovery-warning">
              {t('wave9.recovery.warning')}
            </p>
            <SelectField
              label={t('wave9.field.repository')}
              value={repository.id}
              options={eligible.map((r) => ({ value: r.id, label: repositoryLabel(r) }))}
              onChange={setRepositoryId}
            />
            <SelectField
              label={t('wave9.recovery.source')}
              value={source}
              options={SOURCES.map((s) => ({ value: s, label: t(SOURCE_KEYS[s]) }))}
              onChange={setSource}
            />
            {source === 'backup' && backup !== undefined ? (
              <SelectField
                label={t('wave9.field.backup')}
                value={backup.id}
                options={backups.map((b) => ({
                  value: b.id,
                  label: t('wave9.backup.option', { kind: b.kind, at: b.startedAt, id: b.id }),
                }))}
                onChange={setBackupId}
              />
            ) : null}
            {source === 'pointInTime' ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-at`}>{t('wave9.field.time')}</Label>
                <Input
                  id={`${id}-at`}
                  type="datetime-local"
                  size="small"
                  value={at}
                  onChange={(event) => setAt(event.target.value)}
                />
              </div>
            ) : null}
            <NodeField value={nodeId} onChange={setNodeId} />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-reason`}>{t('wave9.recovery.reason')}</Label>
              <Textarea
                id={`${id}-reason`}
                rows={3}
                maxLength={1000}
                value={why}
                onChange={(event) => setWhy(event.target.value)}
              />
              <p className="m-0 text-xs text-foreground-lighter">{t('audit.reason.warning')}</p>
            </div>
          </>
        )}
      </FormDialog>
    </>
  )
}

/** The node that will hold the new cluster directory, from the registry's node list. */
function NodeField(props: { readonly value: string; readonly onChange: (id: string) => void }) {
  const { client } = useApi()
  const query = useQuery(nodesQuery(client))
  return (
    <ReadableView
      readable={toReadable(query)}
      what={nounPhrase('wave9.recovery.nodes.what')}
      onRetry={() => void query.refetch()}
      busy={query.isFetching}
      headingLevel={3}
      empty={{
        isEmpty: (page) => page.items.length === 0,
        content: (
          <p className="m-0 text-sm text-foreground-light">{t('wave9.recovery.nodes.none')}</p>
        ),
      }}
      ready={(page) => {
        const nodes = page.items.filter((node) => isNodeId(node.id))
        return (
          <SelectField
            label={t('wave9.recovery.node')}
            value={props.value}
            options={[
              { value: '', label: t('wave9.recovery.node.choose') },
              ...nodes.map((node) => ({
                value: node.id,
                label: t('wave9.recovery.node.option', { id: node.id, state: node.state }),
              })),
            ]}
            onChange={props.onChange}
          />
        )
      }}
    />
  )
}

// ----- discard a scratch restore -----

export function DiscardRestore(props: {
  readonly clusterId: string
  readonly restore: Restore
  readonly tier: 'prod' | 'nonprod'
  readonly refusals: Refusals
}): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const [open, setOpen] = useState(false)
  return (
    <>
      <ActionButton
        label={t('wave9.discard')}
        disabledReason={reason('discard', 'restore.execute')}
        onClick={() => setOpen(true)}
        destructive
        data-action="discard"
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.discard.title')}
        description={t('wave9.discard.body')}
        actionLabel={t('wave9.discard.action')}
        destructive
        tier={props.tier}
        onConfirm={async () => {
          try {
            await createPlan(() =>
              client.operation('planRestoreDiscard', {
                params: { clusterId: props.clusterId, restoreId: props.restore.id },
                body: {},
              }),
            )
          } catch (error) {
            props.refusals.record('discard', error)
            throw error
          }
        }}
      />
    </>
  )
}

// ----- record an offline drill (an attestation) -----

const DIGEST = /^sha256:[0-9a-f]{64}$/

export function RecordOfflineDrill(props: {
  readonly clusterId: string
  readonly repositories: readonly RepositorySummary[]
  /** The digest of the runbook last downloaded on this page, to start with. */
  readonly runbookDigest: string | undefined
  readonly refusals: Refusals
  readonly onRecorded: () => void
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const reason = useReason(props.refusals)
  const invalidate = useInvalidateCluster(props.clusterId)
  const id = useId()
  const eligible = props.repositories.filter((r) => r.state !== 'retired')
  const [open, setOpen] = useState(false)
  const [repositoryId, setRepositoryId] = useState('')
  const [digest, setDigest] = useState<string | undefined>(undefined)
  const [at, setAt] = useState('')
  const [minutes, setMinutes] = useState('')
  const [outcome, setOutcome] = useState<'passed' | 'failed'>('passed')
  const [notes, setNotes] = useState('')
  const [attested, setAttested] = useState(false)
  const repository = eligible.find((r) => r.id === repositoryId) ?? eligible[0]
  const digestText = (digest ?? props.runbookDigest ?? '').trim()
  const atIso = localToIso(at)
  const duration = Math.round(Number(minutes) * 60)
  const problem =
    repository === undefined
      ? t('wave9.drill.noRepository')
      : !DIGEST.test(digestText)
        ? t('wave9.offline.digest.invalid')
        : atIso === undefined || Date.parse(atIso) > Date.now()
          ? t('wave9.offline.at.invalid')
          : !Number.isFinite(duration) || duration < 1 || duration > 30 * 86400
            ? t('wave9.offline.duration.invalid')
            : notes.trim().length === 0
              ? t('wave9.offline.notes.required')
              : !attested
                ? t('wave9.offline.attest.required')
                : undefined
  const submit = async (): Promise<void> => {
    if (repository === undefined || atIso === undefined) throw new Error('unreachable')
    try {
      await withReauth(client, confirmIdentity, () =>
        client.operation('recordOfflineDrill', {
          params: { clusterId: props.clusterId },
          body: {
            repositoryId: repository.id,
            runbookDigest: digestText,
            restoredAt: atIso,
            durationSeconds: duration,
            outcome,
            notes: notes.trim(),
          },
        }),
      )
    } catch (error) {
      throw actionError(error)
    }
    invalidate()
    props.onRecorded()
  }
  return (
    <>
      <ActionButton
        label={t('wave9.offline')}
        disabledReason={reason(
          'offline',
          'restore.execute',
          eligible.length === 0 ? t('wave9.drill.noRepository') : undefined,
        )}
        onClick={() => setOpen(true)}
        data-action="offline"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.offline.title')}
        description={t('wave9.offline.body')}
        submitLabel={t('wave9.offline.submit')}
        problem={problem}
        onFailure={(error) => props.refusals.record('offline', error)}
        onSubmit={submit}
      >
        {repository === undefined ? null : (
          <>
            <SelectField
              label={t('wave9.field.repository')}
              value={repository.id}
              options={eligible.map((r) => ({ value: r.id, label: repositoryLabel(r) }))}
              onChange={setRepositoryId}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-digest`}>{t('wave9.offline.digest')}</Label>
              <Input
                id={`${id}-digest`}
                size="small"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={digest ?? props.runbookDigest ?? ''}
                onChange={(event) => setDigest(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-at`}>{t('wave9.offline.at')}</Label>
              <Input
                id={`${id}-at`}
                type="datetime-local"
                size="small"
                value={at}
                onChange={(event) => setAt(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-minutes`}>{t('wave9.offline.duration')}</Label>
              <Input
                id={`${id}-minutes`}
                type="number"
                inputMode="numeric"
                min={1}
                size="small"
                className="w-40"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </div>
            <SelectField
              label={t('wave9.offline.outcome')}
              value={outcome}
              options={[
                { value: 'passed', label: t('wave9.offline.outcome.passed') },
                { value: 'failed', label: t('wave9.offline.outcome.failed') },
              ]}
              onChange={setOutcome}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-notes`}>{t('wave9.offline.notes')}</Label>
              <Textarea
                id={`${id}-notes`}
                rows={4}
                maxLength={4000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="m-0 text-xs text-foreground-lighter">{t('wave9.offline.notes.hint')}</p>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={`${id}-attest`}
                checked={attested}
                onCheckedChange={(checked) => setAttested(checked === true)}
              />
              <Label htmlFor={`${id}-attest`} className="leading-snug">
                {t('wave9.offline.attest')}
              </Label>
            </div>
          </>
        )}
      </FormDialog>
    </>
  )
}
