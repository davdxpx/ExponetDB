import type {
  MigrationBundle,
  MigrationBundleRevision,
  MigrationDetail,
} from '@exponetdb/sdk/operations'
import {
  Button,
  cn,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ReadableTextDiff, type TextDiffSides } from '@exponetdb/ui-data'
import {
  ObservedTime,
  type Readable,
  ReadableView,
  StateHeading,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { planPath } from '../plans/plan-model.ts'
import { isTargetPath } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { isProjectId, operationPath } from '../target-ops/ids.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { bundleFileQuery, bundleQuery, targetMigrationQuery } from './bundle-keys.ts'
import {
  BUNDLE_FILES,
  type BundleFileName,
  filesOfRevision,
  isMigrationId,
  isRevision,
  pickRevision,
  previousRevision,
  revisionsNewestFirst,
} from './bundle-model.ts'
import { NumberedFile } from './file-text.tsx'

/** A stored bundle the panel shows, and the target whose ledger row and runs it reads. */
export interface BundleRef {
  readonly projectId: string
  readonly migrationId: string
  /** Untrusted: the bundle's name, when the page knows it. */
  readonly name?: string | undefined
  /** The target whose ledger row, events and verification runs the panel reads (a path). */
  readonly targetPath?: string | undefined
  /** The revision to show first (a plan's revision); without it the newest. */
  readonly revision?: number | undefined
}

/** A stored file never changes: an earlier read of it is never out of date. */
const FILE_READ = { staleAfterMs: Number.POSITIVE_INFINITY } as const

/**
 * "View SQL": opens the side panel of one stored bundle. Nothing is read
 * before the panel opens; an id that fails its grammar offers no button.
 */
export function ViewSqlButton({
  bundle,
  open: controlledOpen,
  onOpenChange,
}: {
  readonly bundle: BundleRef
  /** Controlled from outside (the migration centre keeps it in the address); else its own state. */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
}): ReactNode {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  if (!isProjectId(bundle.projectId) || !isMigrationId(bundle.migrationId)) return null
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          size="tiny"
          variant="outline"
          data-view-sql={bundle.migrationId}
          aria-label={t('bundle.view.label', { migration: bundle.migrationId })}
        >
          {t('bundle.view')}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" size="w800" className="flex flex-col gap-0">
        {open ? <BundleSheetBody bundle={bundle} /> : null}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The side panel of a stored bundle: the bundle with its revisions, digests
 * and superseded checksums (`GET /projects/{p}/bundles/{m}`), each file of
 * the shown revision as numbered text (`…/revisions/{r}/files/{f}`; `down.sql`
 * says it never runs automatically), the difference between two revisions,
 * and this target's ledger row, events and verification runs (`GET
 * /targets/{t}/migrations/{m}`, a live read). Every read is its own section:
 * one that fails names its failure and leaves the others as they are. File
 * text, names and failure details are untrusted text.
 */
export function BundleSheetBody({ bundle }: { readonly bundle: BundleRef }): ReactNode {
  const { client } = useApi()
  const read = useQuery(bundleQuery(client, bundle.projectId, bundle.migrationId))
  const [wanted, setWanted] = useState<number | undefined>(
    isRevision(bundle.revision) ? bundle.revision : undefined,
  )
  const value = read.data
  const revision = value === undefined ? undefined : pickRevision(value, wanted)
  // Without the bundle the files are still read for the revision the page named.
  const revisionNumber = revision?.revision ?? wanted
  const files: readonly BundleFileName[] =
    revision !== undefined ? filesOfRevision(revision) : ['up.sql', 'verify.sql']
  const ids = useId()

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('bundle.title')}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-baseline gap-x-2">
          {bundle.name === undefined ? null : (
            <UntrustedName name={bundle.name} label={t('bundle.name')} />
          )}
          <span className="font-mono text-xs">{bundle.migrationId}</span>
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-5 py-4">
        <section aria-labelledby={`${ids}-bundle`} className="flex flex-col gap-2">
          <h3 id={`${ids}-bundle`} className="m-0 text-base font-medium">
            {t('bundle.stored.title')}
          </h3>
          <ReadableView
            readable={toReadable(read, FILE_READ)}
            what={nounPhrase('bundle.stored.what')}
            onRetry={() => void read.refetch()}
            onRefresh={() => void read.refetch()}
            busy={read.isFetching}
            headingLevel={4}
            ready={(stored) => (
              <BundleFacts
                stored={stored}
                shown={revision?.revision}
                onShow={(next) => setWanted(next)}
              />
            )}
          />
        </section>
        <section aria-labelledby={`${ids}-files`} className="flex flex-col gap-4" data-bundle-files>
          <h3 id={`${ids}-files`} className="m-0 text-base font-medium">
            {revisionNumber === undefined
              ? t('bundle.files.title')
              : t('bundle.files.revision', { revision: revisionNumber })}
          </h3>
          {revisionNumber === undefined ? (
            <p className="m-0 text-sm text-foreground-light">
              {read.isError ? t('bundle.files.noRevision') : t('bundle.files.waiting')}
            </p>
          ) : (
            <>
              {revision === undefined && value === undefined && read.isError ? (
                <p role="note" className="m-0 text-sm text-foreground-light">
                  {t('bundle.files.downNotKnown')}
                </p>
              ) : null}
              {files.map((file) => (
                <FileRead
                  key={`${revisionNumber}:${file}`}
                  projectId={bundle.projectId}
                  migrationId={bundle.migrationId}
                  revision={revisionNumber}
                  file={file}
                />
              ))}
            </>
          )}
        </section>
        {value !== undefined && revision !== undefined && value.revisions.length >= 2 ? (
          <RevisionDiff
            projectId={bundle.projectId}
            migrationId={bundle.migrationId}
            stored={value}
            revision={revision}
          />
        ) : null}
        {bundle.targetPath !== undefined && isTargetPath(bundle.targetPath) ? (
          <TargetMigration targetPath={bundle.targetPath} migrationId={bundle.migrationId} />
        ) : null}
      </div>
    </>
  )
}

function BundleFacts({
  stored,
  shown,
  onShow,
}: {
  readonly stored: MigrationBundle
  readonly shown: number | undefined
  readonly onShow: (revision: number) => void
}): ReactNode {
  const revisions = revisionsNewestFirst(stored)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-foreground-light">{t('bundle.stored.name')}</dt>
        <dd className="m-0 min-w-0">
          <UntrustedName name={stored.name} label={t('bundle.stored.name')} />
        </dd>
        <dt className="text-foreground-light">{t('bundle.stored.checksum')}</dt>
        <dd className="m-0 min-w-0 break-all font-mono text-xs">
          <UntrustedName name={stored.checksum} mono label={t('bundle.stored.checksum')} />
        </dd>
        <dt className="text-foreground-light">{t('bundle.stored.transactional')}</dt>
        <dd className="m-0">
          {stored.transactional
            ? t('bundle.stored.transactional.yes')
            : t('bundle.stored.transactional.no')}
        </dd>
        <dt className="text-foreground-light">{t('bundle.stored.dependsOn')}</dt>
        <dd className="m-0 min-w-0">
          {stored.dependsOn.length === 0 ? (
            t('bundle.stored.dependsOn.none')
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {stored.dependsOn.map((id) => (
                <li key={id}>
                  <UntrustedName name={id} mono label={t('bundle.stored.dependsOn')} />
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <Table>
        <TableCaption className="sr-only">{t('bundle.revisions.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('bundle.revisions.revision')}</TableHead>
            <TableHead scope="col">{t('bundle.revisions.ingested')}</TableHead>
            <TableHead scope="col">{t('bundle.revisions.digests')}</TableHead>
            <TableHead scope="col">
              <span className="sr-only">{t('bundle.revisions.show')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {revisions.map((revision) => (
            <TableRow
              key={revision.revision}
              data-revision={revision.revision}
              aria-current={revision.revision === shown ? 'true' : undefined}
            >
              <TableCell className={cn(revision.revision === shown && 'font-medium')}>
                {revision.revision}
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={revision.ingestedAt} withDate />
              </TableCell>
              <TableCell className="font-mono text-xs">
                <Digest label={t('bundle.revisions.bundleDigest')} value={revision.bundleDigest} />
                <Digest label={t('bundle.revisions.verifyDigest')} value={revision.verifyDigest} />
                <Digest
                  label={t('bundle.revisions.rollbackDigest')}
                  value={revision.rollbackDigest}
                />
              </TableCell>
              <TableCell>
                {revision.revision === shown ? (
                  <span className="text-xs text-foreground-light">
                    {t('bundle.revisions.shown')}
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="tiny"
                    variant="outline"
                    aria-label={t('bundle.revisions.showLabel', { revision: revision.revision })}
                    onClick={() => onShow(revision.revision)}
                  >
                    {t('bundle.revisions.show')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {stored.superseded.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <h4 className="m-0 text-sm font-medium">{t('bundle.superseded.title')}</h4>
          <p className="m-0 text-xs text-foreground-light">{t('bundle.superseded.body')}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-xs">
            {stored.superseded.map((entry) => (
              <li key={`${entry.checksum}:${entry.ingestedAt}`} className="flex flex-wrap gap-x-2">
                <UntrustedName name={entry.checksum} mono label={t('bundle.stored.checksum')} />
                <ObservedTime observedAt={entry.ingestedAt} withDate />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Digest({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-1">
      <span className="font-sans text-foreground-light">{label}</span>
      {value === null ? (
        <span className="font-sans">{t('bundle.revisions.none')}</span>
      ) : (
        <UntrustedName name={value} mono maxCodePoints={32} label={label} />
      )}
    </div>
  )
}

const DOWN_NOTE: MessageKey = 'bundle.down.note'

function FileRead({
  projectId,
  migrationId,
  revision,
  file,
}: {
  readonly projectId: string
  readonly migrationId: string
  readonly revision: number
  readonly file: BundleFileName
}): ReactNode {
  const { client } = useApi()
  const query = useQuery(bundleFileQuery(client, projectId, migrationId, revision, file))
  return (
    <div data-file-read={file} className="flex flex-col gap-2">
      {file === 'down.sql' ? (
        <p data-down-note className="m-0 text-sm font-medium">
          {t(DOWN_NOTE)}
        </p>
      ) : null}
      <ReadableView
        readable={toReadable(query, FILE_READ)}
        what={file}
        onRetry={() => void query.refetch()}
        onRefresh={() => void query.refetch()}
        busy={query.isFetching}
        headingLevel={4}
        ready={(stored) => (
          <NumberedFile
            file={file}
            migrationId={migrationId}
            revision={stored.revision}
            text={stored.text}
            bytes={stored.bytes}
            headingLevel={4}
          />
        )}
      />
    </div>
  )
}

/** Two reads of the same file as one comparison: failed when a side failed, loading until both are in. */
function sidesOf(
  before: UseQueryResult<{ readonly text: string }> | undefined,
  after: UseQueryResult<{ readonly text: string }> | undefined,
  missing: readonly string[],
): Readable<TextDiffSides> {
  for (const side of [before, after]) {
    if (side !== undefined && side.data === undefined) {
      const readable = toReadable(side, FILE_READ)
      if (readable.state === 'failed') return readable
    }
  }
  if (
    (before !== undefined && before.data === undefined) ||
    (after !== undefined && after.data === undefined)
  ) {
    return { state: 'loading' }
  }
  const value = { before: before?.data?.text ?? '', after: after?.data?.text ?? '' }
  const observedAt = new Date(
    Math.max(before?.dataUpdatedAt ?? 0, after?.dataUpdatedAt ?? 0),
  ).toISOString()
  return missing.length > 0
    ? { state: 'partial', value, source: 'cached', observedAt, missing }
    : { state: 'ready', value, source: 'cached', observedAt }
}

function RevisionDiff({
  projectId,
  migrationId,
  stored,
  revision,
}: {
  readonly projectId: string
  readonly migrationId: string
  readonly stored: MigrationBundle
  readonly revision: MigrationBundleRevision
}): ReactNode {
  const { client } = useApi()
  const ids = useId()
  const [file, setFile] = useState<BundleFileName>('up.sql')
  const previous = previousRevision(stored, revision.revision)
  const inBefore = previous !== undefined && Object.hasOwn(previous.files, file)
  const inAfter = Object.hasOwn(revision.files, file)
  const before = useQuery(
    bundleFileQuery(client, projectId, migrationId, previous?.revision ?? 1, file, inBefore),
  )
  const after = useQuery(
    bundleFileQuery(client, projectId, migrationId, revision.revision, file, inAfter),
  )
  const offered = BUNDLE_FILES.filter(
    (name) =>
      Object.hasOwn(revision.files, name) ||
      (previous !== undefined && Object.hasOwn(previous.files, name)),
  )
  return (
    <section aria-labelledby={`${ids}-diff`} className="flex flex-col gap-2" data-revision-diff>
      <h3 id={`${ids}-diff`} className="m-0 text-base font-medium">
        {t('bundle.diff.title')}
      </h3>
      {previous === undefined ? (
        <p className="m-0 text-sm text-foreground-light">
          {t('bundle.diff.first', { revision: revision.revision })}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label htmlFor={`${ids}-file`} className="flex flex-col gap-1 text-xs">
              <span className="text-foreground-light">{t('bundle.diff.file')}</span>
              <select
                id={`${ids}-file`}
                className="h-[30px] rounded-md border border-control bg-control px-2 text-sm"
                value={file}
                onChange={(event) =>
                  setFile(BUNDLE_FILES.find((name) => name === event.target.value) ?? 'up.sql')
                }
              >
                {offered.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <p className="m-0 text-sm text-foreground-light">
              {t('bundle.diff.between', { from: previous.revision, to: revision.revision })}
            </p>
          </div>
          <ReadableTextDiff
            readable={sidesOf(inBefore ? before : undefined, inAfter ? after : undefined, [
              ...(inBefore ? [] : [t('bundle.diff.absent', { file, revision: previous.revision })]),
              ...(inAfter ? [] : [t('bundle.diff.absent', { file, revision: revision.revision })]),
            ])}
            what={t('bundle.diff.what', { file })}
            label={t('bundle.diff.label', {
              file,
              from: previous.revision,
              to: revision.revision,
            })}
            beforeLabel={t('bundle.diff.side', { revision: previous.revision })}
            afterLabel={t('bundle.diff.side', { revision: revision.revision })}
            maxLines={30}
            onRetry={() => {
              void before.refetch()
              void after.refetch()
            }}
          />
        </>
      )}
    </section>
  )
}

const MIGRATION_STATES: Readonly<Record<string, MessageKey>> = {
  applied: 'bundle.target.state.applied',
  reverted: 'bundle.target.state.reverted',
  pending: 'bundle.target.state.pending',
  partially_applied: 'bundle.target.state.partially_applied',
  unknown_to_target: 'bundle.target.state.unknown_to_target',
}

const EVENTS: Readonly<Record<string, MessageKey>> = {
  nontx_started: 'bundle.event.nontx_started',
  nontx_statement_done: 'bundle.event.nontx_statement_done',
  nontx_failed: 'bundle.event.nontx_failed',
  applied: 'bundle.event.applied',
  reverted: 'bundle.event.reverted',
  imported: 'bundle.event.imported',
  baselined: 'bundle.event.baselined',
  ledger_reconciled: 'bundle.event.ledger_reconciled',
}

/** A word from a table, or the server's own value as untrusted text when this build does not know it. */
function Word({
  table,
  value,
  label,
}: {
  readonly table: Readonly<Record<string, MessageKey>>
  readonly value: string
  readonly label: string
}): ReactNode {
  const key = Object.hasOwn(table, value) ? table[value] : undefined
  return key === undefined ? <UntrustedName name={value} mono label={label} /> : t(key)
}

function TargetMigration({
  targetPath,
  migrationId,
}: {
  readonly targetPath: string
  readonly migrationId: string
}): ReactNode {
  const { client } = useApi()
  const ids = useId()
  const query = useQuery(targetMigrationQuery(client, targetPath, migrationId))
  return (
    <section aria-labelledby={`${ids}-target`} className="flex flex-col gap-2" data-on-target>
      <h3 id={`${ids}-target`} className="m-0 text-base font-medium">
        {t('bundle.target.title', { target: targetPath })}
      </h3>
      <ReadSection
        query={query}
        what={nounPhrase('bundle.target.what')}
        permission="migrations.read"
        headingLevel={4}
        ready={(detail) => <TargetMigrationBody detail={detail} />}
      />
    </section>
  )
}

function TargetMigrationBody({ detail }: { readonly detail: MigrationDetail }): ReactNode {
  const Link = useLinkComponent()
  const operation = operationPath(detail.operationId)
  const plan = planPath(detail.planId)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-foreground-light">{t('bundle.target.state')}</dt>
        <dd className="m-0" data-target-state={detail.state}>
          <Word table={MIGRATION_STATES} value={detail.state} label={t('bundle.target.state')} />
        </dd>
        <dt className="text-foreground-light">{t('bundle.stored.checksum')}</dt>
        <dd className="m-0 min-w-0 break-all font-mono text-xs">
          {detail.checksum === null ? (
            <span className="font-sans">{t('bundle.revisions.none')}</span>
          ) : (
            <UntrustedName name={detail.checksum} mono label={t('bundle.stored.checksum')} />
          )}
        </dd>
        <dt className="text-foreground-light">{t('bundle.target.applied')}</dt>
        <dd className="m-0">
          {detail.appliedAt === null ? (
            t('bundle.target.notApplied')
          ) : (
            <ObservedTime observedAt={detail.appliedAt} withDate />
          )}
        </dd>
        <dt className="text-foreground-light">{t('bundle.target.links')}</dt>
        <dd className="m-0 flex flex-wrap gap-x-3">
          {operation === undefined ? null : (
            <Link href={operation} className="text-primary underline focus-ring">
              {t('bundle.target.operation')}
            </Link>
          )}
          {plan === undefined ? null : (
            <Link href={plan} className="text-primary underline focus-ring">
              {t('bundle.target.plan')}
            </Link>
          )}
          {operation === undefined && plan === undefined ? t('bundle.target.noLinks') : null}
        </dd>
        <dt className="text-foreground-light">{t('bundle.target.fingerprints')}</dt>
        <dd className="m-0 min-w-0 break-all font-mono text-xs">
          <Digest label={t('bundle.target.before')} value={detail.fingerprintBefore} />
          <Digest label={t('bundle.target.after')} value={detail.fingerprintAfter} />
        </dd>
      </dl>
      <div className="flex flex-col gap-1">
        <StateHeading level={4} className="m-0 text-sm font-medium">
          {t('bundle.events.title')}
        </StateHeading>
        {detail.events.length === 0 ? (
          <p className="m-0 text-foreground-light">{t('bundle.events.none')}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.events.map((event, index) => {
              const href = operationPath(event.operationId)
              return (
                <li
                  // Events have no id; the server's order is the identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: the server's order is the identity
                  key={index}
                  data-event={event.event}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="font-medium">
                    <Word table={EVENTS} value={event.event} label={t('bundle.events.title')} />
                  </span>
                  <ObservedTime observedAt={event.at} withDate />
                  {event.statementIndex === null ? null : (
                    <span>{t('bundle.events.statement', { index: event.statementIndex + 1 })}</span>
                  )}
                  {event.sqlstate === null ? null : (
                    <span className="font-mono text-xs">
                      <UntrustedName name={event.sqlstate} mono label="SQLSTATE" />
                    </span>
                  )}
                  {href === undefined ? null : (
                    <Link href={href} className="text-primary underline focus-ring">
                      {t('bundle.target.operation')}
                    </Link>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <StateHeading level={4} className="m-0 text-sm font-medium">
          {t('bundle.runs.title')}
        </StateHeading>
        {detail.verifications.length === 0 ? (
          <p className="m-0 text-foreground-light">{t('bundle.runs.none')}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {detail.verifications.map((run) => (
              <li
                key={run.verificationId}
                data-verification={run.status}
                className="flex flex-col gap-1 rounded-md border border-default p-2"
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">
                    <Word table={RUN_STATES} value={run.status} label={t('bundle.runs.title')} />
                  </span>
                  <ObservedTime observedAt={run.finishedAt} withDate />
                </span>
                <span className="text-xs text-foreground-light">
                  {t('bundle.runs.parts', {
                    structural: run.structural.status,
                    runtime: run.runtime.status,
                    engine: run.engine.status,
                  })}
                </span>
                {[run.structural, run.runtime, run.engine].map((part, index) =>
                  part.firstFailure === null ? null : (
                    <UntrustedText
                      // biome-ignore lint/suspicious/noArrayIndexKey: three fixed parts
                      key={index}
                      text={`${part.firstFailure.name}${part.firstFailure.detail === null ? '' : `: ${part.firstFailure.detail}`}`}
                      mono
                      maxLines={4}
                      label={t('bundle.runs.failure')}
                    />
                  ),
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

const RUN_STATES: Readonly<Record<string, MessageKey>> = {
  passed: 'migrations.verification.passed',
  failed: 'migrations.verification.failed',
  partial: 'migrations.verification.partial',
  error: 'migrations.verification.error',
}
