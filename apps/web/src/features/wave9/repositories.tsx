import {
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ObservedTime, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { saveFile } from '../audit/download.ts'
import { actionError } from '../plans/failure.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { useReason } from './backup-actions.tsx'
import { FormDialog } from './form-dialog.tsx'
import {
  ADVISORY_KEYS,
  digestOf,
  LAYER_KEYS,
  OWNERSHIP_KEYS,
  PROVIDER_KEYS,
  type Repository,
  type Runbook,
} from './model.ts'
import {
  ActionButton,
  LockBadge,
  Missing,
  type Refusals,
  SelectField,
  ToneBadge,
} from './parts.tsx'

/**
 * The backup repositories of a cluster as the registry records them: layer,
 * engine, the storage provider as a label (no lock or durability property is
 * derived from it), what ExponetDB may do with it, the lock (protecting only
 * when proven), encryption and whether a person confirmed an offline key
 * copy (an attestation), the engine version with its advisory, and the last
 * reconciliation. The location shows only for people with `registry.manage`
 * and never holds a credential. Each repository's offline runbook downloads
 * as a file with its digest checked in the browser first.
 */
export function RepositoriesTable(props: {
  readonly clusterId: string
  readonly repositories: readonly Repository[]
  readonly refusals: Refusals
  readonly onRunbook: (runbook: Runbook) => void
}): ReactNode {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.repositories.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.repositories.column.repository')}</TableHead>
            <TableHead scope="col">{t('wave9.repositories.column.ownership')}</TableHead>
            <TableHead scope="col">{t('wave9.repositories.column.lock')}</TableHead>
            <TableHead scope="col">{t('wave9.repositories.column.engine')}</TableHead>
            <TableHead scope="col">{t('wave9.repositories.column.reconciliation')}</TableHead>
            <TableHead scope="col">{t('wave9.repositories.column.runbook')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.repositories.map((repository) => (
            <TableRow key={repository.id} data-repository={repository.id}>
              <TableCell className="align-top text-sm">
                <div>
                  {t(LAYER_KEYS[repository.layer])}{' '}
                  <span className="text-foreground-light">{repository.engine}</span>
                </div>
                <div className="text-xs text-foreground-light">
                  {t('wave9.repositories.provider', {
                    provider: t(PROVIDER_KEYS[repository.provider]),
                  })}
                </div>
                <div className="text-xs text-foreground-light">
                  {t('wave9.repositories.purpose', {
                    purpose: repository.purpose,
                    priority: repository.priority,
                  })}
                </div>
                {repository.location === null ? null : (
                  <div className="text-xs text-foreground-light" data-location="">
                    {repository.location.endpointHost === null ? null : (
                      <UntrustedName name={repository.location.endpointHost} mono />
                    )}{' '}
                    {repository.location.bucket === null ? null : (
                      <UntrustedName name={repository.location.bucket} mono />
                    )}
                    {repository.location.prefix === '' ? null : (
                      <>
                        {' / '}
                        <UntrustedName name={repository.location.prefix} mono />
                      </>
                    )}
                  </div>
                )}
                <div className="font-mono text-xs text-foreground-lighter">{repository.id}</div>
              </TableCell>
              <TableCell className="align-top text-xs">
                <div className="text-sm">{t(OWNERSHIP_KEYS[repository.ownership])}</div>
                <div className="text-foreground-light">
                  {t('wave9.repositories.state', { state: repository.state })}
                </div>
              </TableCell>
              <TableCell className="align-top text-xs">
                <LockBadge capability={repository.lock.capability} />
                <div className="mt-1 text-foreground-light">
                  {t('wave9.repositories.lockMode', { mode: repository.lock.mode })}
                </div>
                {repository.lock.retentionDays === null ? null : (
                  <div className="text-foreground-light">
                    {t('wave9.repositories.lockRetention', { days: repository.lock.retentionDays })}
                  </div>
                )}
                {repository.lock.provenAt === null ||
                repository.lock.capability !== 'proven' ? null : (
                  <div className="text-foreground-light">
                    {t('wave9.repositories.lockProven')}{' '}
                    <ObservedTime observedAt={repository.lock.provenAt} withDate />
                  </div>
                )}
                <div className="mt-1 text-foreground-light">
                  {t('wave9.repositories.cipher', { cipher: repository.encryption.cipher })}
                </div>
                <div className="text-foreground-light" data-offline-key="">
                  {repository.encryption.offlineCopyConfirmedAt === null ? (
                    t('wave9.repositories.offlineKey.none')
                  ) : (
                    <>
                      {t('wave9.repositories.offlineKey.attested')}{' '}
                      <ObservedTime
                        observedAt={repository.encryption.offlineCopyConfirmedAt}
                        withDate
                      />
                    </>
                  )}
                </div>
              </TableCell>
              <TableCell className="align-top text-xs">
                <div>
                  {t('wave9.repositories.pinned')}{' '}
                  {repository.engineVersion.pinned === null ? (
                    <Missing>{t('wave9.none')}</Missing>
                  ) : (
                    <UntrustedName name={repository.engineVersion.pinned} mono />
                  )}
                </div>
                <div>
                  {t('wave9.repositories.observed')}{' '}
                  {repository.engineVersion.observed === null ? (
                    <Missing>{t('wave9.repositories.notObserved')}</Missing>
                  ) : (
                    <UntrustedName name={repository.engineVersion.observed} mono />
                  )}
                </div>
                <div className="mt-1">
                  <ToneBadge
                    tone={repository.engineVersion.advisory === 'none' ? 'neutral' : 'warning'}
                    data-advisory={repository.engineVersion.advisory}
                  >
                    {t(ADVISORY_KEYS[repository.engineVersion.advisory])}
                  </ToneBadge>
                </div>
              </TableCell>
              <TableCell className="align-top text-xs">
                {repository.reconciliation === null ? (
                  <Missing>{t('wave9.repositories.neverReconciled')}</Missing>
                ) : (
                  <>
                    <ToneBadge
                      tone={
                        repository.reconciliation.outcome === 'ok'
                          ? 'good'
                          : repository.reconciliation.outcome === 'partial'
                            ? 'warning'
                            : 'bad'
                      }
                      data-reconciliation={repository.reconciliation.outcome}
                    >
                      {t(`wave9.repositories.reconciliation.${repository.reconciliation.outcome}`)}
                    </ToneBadge>
                    <div className="mt-1 text-foreground-light">
                      <ObservedTime observedAt={repository.reconciliation.at} />
                    </div>
                    {repository.reconciliation.errorCode === null ? null : (
                      <div className="font-mono text-foreground-light">
                        {repository.reconciliation.errorCode}
                      </div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell className="align-top">
                <RunbookDownload
                  clusterId={props.clusterId}
                  repository={repository}
                  refusals={props.refusals}
                  onRunbook={props.onRunbook}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

const RUNBOOK_FILE = /^exponetdb-restore-[a-z0-9_-]{1,80}\.sh$/

/**
 * Downloads the offline runbook (plain POSIX shell, every secret a
 * placeholder): read on demand, never cached, its digest computed over the
 * script and compared with the one the server named before the file is
 * handed to the browser. A mismatch saves nothing.
 */
function RunbookDownload(props: {
  readonly clusterId: string
  readonly repository: Repository
  readonly refusals: Refusals
  readonly onRunbook: (runbook: Runbook) => void
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const reason = useReason(props.refusals)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState<Runbook | undefined>(undefined)
  const download = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const runbook = await withReauth(client, confirmIdentity, () =>
        client.operation('getRestoreRunbook', {
          params: { clusterId: props.clusterId },
          query: { repository: props.repository.id },
        }),
      )
      const computed = await digestOf(runbook.script)
      if (computed !== runbook.digest) {
        setFailure(
          computed === undefined ? t('wave9.runbook.cannotCheck') : t('wave9.runbook.mismatch'),
        )
        return
      }
      const name = RUNBOOK_FILE.test(runbook.filename)
        ? runbook.filename
        : 'exponetdb-restore-runbook.sh'
      saveFile(runbook.script, name, 'text/x-shellscript')
      setSaved(runbook)
      props.onRunbook(runbook)
    } catch (error) {
      setFailure(describeError(actionError(error)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      <ActionButton
        label={busy ? t('wave9.runbook.reading') : t('wave9.runbook.download')}
        disabledReason={reason('runbook', 'restore.plan')}
        onClick={() => void download()}
        data-action="runbook"
      />
      {failure === undefined ? null : (
        <p className="m-0 text-destructive" role="alert">
          {failure}
        </p>
      )}
      {saved === undefined ? null : (
        <div className="flex flex-col gap-1" role="status" data-runbook={saved.digest}>
          <span>{t('wave9.runbook.saved', { name: saved.filename })}</span>
          <span className="break-all font-mono text-foreground-light">{saved.digest}</span>
          <span className="text-foreground-light">{t('wave9.runbook.checked')}</span>
          {saved.placeholders.length === 0 ? null : (
            <ul className="m-0 list-disc pl-4 text-foreground-light">
              {saved.placeholders.map((placeholder) => (
                <li key={placeholder.name}>
                  <span className="font-mono">{placeholder.name}</span>:{' '}
                  <UntrustedName name={placeholder.meaning} maxCodePoints={200} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ----- adopt an existing repository -----

const LAYERS = ['l1_physical', 'l2_logical', 'l3_offprovider'] as const
type Layer = (typeof LAYERS)[number]
const ENGINES_OF: Readonly<Record<Layer, readonly ('pgbackrest' | 'pg_dump' | 'restic')[]>> = {
  l1_physical: ['pgbackrest'],
  l2_logical: ['pg_dump', 'restic'],
  l3_offprovider: ['restic', 'pgbackrest'],
}
const PROVIDERS = ['hetzner_object_storage', 'cloudflare_r2', 's3_compatible', 'posix'] as const
const LOCK_MODES = ['unknown', 'none', 's3_object_lock', 'r2_bucket_lock'] as const
const CIPHERS = ['unknown', 'aes-256-cbc', 'restic', 'none'] as const
const PURPOSES = ['primary', 'secondary', 'offsite'] as const

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const PREFIX = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/
const STANZA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/

/**
 * "Adopt a repository" (`planBackupRepositoryAdoption`, `registry.manage`,
 * human only): an existing repository is recorded for read-only
 * observation; nothing changes on the host or in the bucket. The form checks
 * the contract's rules before it asks for the plan; the server checks again.
 */
export function AdoptRepository(props: {
  readonly clusterId: string
  readonly refusals: Refusals
}): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const reason = useReason(props.refusals)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [layer, setLayer] = useState<Layer>('l1_physical')
  const [engine, setEngine] = useState<string>('pgbackrest')
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('hetzner_object_storage')
  const [host, setHost] = useState('')
  const [region, setRegion] = useState('')
  const [bucket, setBucket] = useState('')
  const [prefix, setPrefix] = useState('')
  const [stanza, setStanza] = useState('')
  const [repoIndex, setRepoIndex] = useState('1')
  const [purpose, setPurpose] = useState<(typeof PURPOSES)[number]>('primary')
  const [lockMode, setLockMode] = useState<(typeof LOCK_MODES)[number]>('unknown')
  const [cipher, setCipher] = useState<(typeof CIPHERS)[number]>('unknown')
  const [version, setVersion] = useState('')
  const engines = ENGINES_OF[layer]
  const chosenEngine = engines.find((e) => e === engine) ?? engines[0] ?? 'pgbackrest'
  const posix = provider === 'posix'
  const pgbr = chosenEngine === 'pgbackrest'
  const index = Number(repoIndex)
  const problem =
    !posix && !HOST.test(host.trim())
      ? t('wave9.adopt.host.invalid')
      : !posix && !BUCKET.test(bucket.trim())
        ? t('wave9.adopt.bucket.invalid')
        : region.trim() !== '' && !REGION.test(region.trim())
          ? t('wave9.adopt.region.invalid')
          : !PREFIX.test(prefix.trim()) ||
              prefix
                .trim()
                .split('/')
                .some((segment) => segment === '.' || segment === '..')
            ? t('wave9.adopt.prefix.invalid')
            : pgbr && !STANZA.test(stanza.trim())
              ? t('wave9.adopt.stanza.invalid')
              : pgbr && !(Number.isInteger(index) && index >= 1 && index <= 4)
                ? t('wave9.adopt.index.invalid')
                : version.trim() !== '' && !VERSION.test(version.trim())
                  ? t('wave9.adopt.version.invalid')
                  : undefined
  const submit = () =>
    createPlan(() =>
      client.operation('planBackupRepositoryAdoption', {
        params: { clusterId: props.clusterId },
        body: {
          layer,
          engine: chosenEngine,
          provider,
          location: {
            endpointHost: posix ? null : host.trim(),
            region: region.trim() === '' ? null : region.trim(),
            bucket: posix ? null : bucket.trim(),
            prefix: prefix.trim(),
            stanza: pgbr ? stanza.trim() : null,
            repoIndex: pgbr ? index : null,
          },
          priority: 1,
          purpose,
          declaredLockMode: lockMode,
          cipher,
          pinnedEngineVersion: version.trim() === '' ? null : version.trim(),
        },
      }),
    )
  const text = (
    key: string,
    label: string,
    value: string,
    set: (v: string) => void,
    hint?: string,
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        size="small"
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => set(event.target.value)}
      />
      {hint === undefined ? null : <p className="m-0 text-xs text-foreground-lighter">{hint}</p>}
    </div>
  )
  return (
    <>
      <ActionButton
        label={t('wave9.adopt')}
        disabledReason={reason('adopt', 'registry.manage')}
        onClick={() => setOpen(true)}
        data-action="adopt"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t('wave9.adopt.title')}
        description={t('wave9.adopt.body')}
        submitLabel={t('wave9.adopt.submit')}
        problem={problem}
        onFailure={(error) => props.refusals.record('adopt', error)}
        onSubmit={submit}
      >
        <SelectField
          label={t('wave9.adopt.layer')}
          value={layer}
          options={LAYERS.map((value) => ({ value, label: t(LAYER_KEYS[value]) }))}
          onChange={setLayer}
        />
        <SelectField
          label={t('wave9.adopt.engine')}
          value={chosenEngine}
          options={engines.map((value) => ({ value, label: value }))}
          onChange={setEngine}
        />
        <SelectField
          label={t('wave9.adopt.provider')}
          value={provider}
          options={PROVIDERS.map((value) => ({ value, label: t(PROVIDER_KEYS[value]) }))}
          onChange={setProvider}
        />
        <p className="m-0 text-xs text-foreground-light">{t('wave9.adopt.providerNote')}</p>
        {posix
          ? null
          : text('host', t('wave9.adopt.host'), host, setHost, t('wave9.adopt.host.hint'))}
        {posix ? null : text('bucket', t('wave9.adopt.bucket'), bucket, setBucket)}
        {text('region', t('wave9.adopt.region'), region, setRegion)}
        {text('prefix', t('wave9.adopt.prefix'), prefix, setPrefix)}
        {pgbr ? text('stanza', t('wave9.adopt.stanza'), stanza, setStanza) : null}
        {pgbr ? text('index', t('wave9.adopt.index'), repoIndex, setRepoIndex) : null}
        <SelectField
          label={t('wave9.adopt.purpose')}
          value={purpose}
          options={PURPOSES.map((value) => ({ value, label: value }))}
          onChange={setPurpose}
        />
        <SelectField
          label={t('wave9.adopt.lock')}
          value={lockMode}
          options={LOCK_MODES.map((value) => ({ value, label: value }))}
          onChange={setLockMode}
        />
        <p className="m-0 text-xs text-foreground-light">{t('wave9.adopt.lockNote')}</p>
        <SelectField
          label={t('wave9.adopt.cipher')}
          value={cipher}
          options={CIPHERS.map((value) => ({ value, label: value }))}
          onChange={setCipher}
        />
        {text('version', t('wave9.adopt.version'), version, setVersion)}
      </FormDialog>
    </>
  )
}
