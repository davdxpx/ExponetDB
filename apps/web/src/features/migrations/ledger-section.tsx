import { Search } from '@exponetdb/icons'
import type { LedgerEntry, MigrationStatus, MigrationStream } from '@exponetdb/sdk/operations'
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
} from '@exponetdb/ui'
import {
  Admonition,
  formatCount,
  ObservedTime,
  Pager,
  pageSlice,
  SourceLabel,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { pagerText } from '../../lib/ui/pager-text.ts'
import { TOOLBAR_CONTROL, ToolbarField } from '../../lib/ui/toolbar.tsx'
import { readSourceOf } from '../target/gate.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { operationPath } from '../target-ops/ids.ts'
import { ledgerQuery, streamQuery } from '../target-ops/keys.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { evidenceOf, isMigrationId } from './bundle-model.ts'
import { BundleCheckbox, SelectAllCheckbox, useBundleSelection } from './bundle-select.tsx'
import { ViewSqlButton } from './bundle-sheet.tsx'
import {
  DEFAULT_HISTORY_SIZE,
  HISTORY_SEARCH_MAX_LENGTH,
  historyRows,
  type MigrationsSearch,
  ORIGINS,
  type OriginFilter,
  VERIFICATION_FILTERS,
  type VerificationFilter,
} from './history-model.ts'
import { EvidenceNote, PlanBundlesAction } from './plan-bundles.tsx'

/**
 * The target's ledger (`GET /targets/{t}/migrations`, `migrations.read`): the
 * applied entries with checksum, who and when (the operation), and the
 * verification of each, then the bundles of the project that are still
 * pending. The ledger in the target is the truth (constitution source-of-truth
 * map); the answer says whether the Control Store mirror agrees. Each row
 * opens the bundle's SQL; pending bundles can be planned on this target
 * ("Plan on <environment>"), with the evidence environment's state from the
 * project's stream for a production target. The server decides.
 */
export function LedgerSection({
  target,
  search,
  change,
}: {
  readonly target: Target
  readonly search: MigrationsSearch
  readonly change: (next: Partial<MigrationsSearch>) => void
}): ReactNode {
  const context = useLedgerContext(target)
  const { client } = useApi()
  const query = useQuery(ledgerQuery(client, context.path))
  return (
    <Section
      id="ledger"
      title={t('migrations.ledger.title')}
      description={t('migrations.ledger.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('migrations.ledger.what')}
        permission="migrations.read"
        ready={(status) => (
          <LedgerBody status={status} context={context} search={search} change={change} />
        )}
      />
    </Section>
  )
}

/**
 * The bundles of the project not yet applied to this target, on their own view of the migration
 * centre: the same ledger read (one cache entry), so they never disagree with the history.
 */
export function PendingSection({ target }: { readonly target: Target }): ReactNode {
  const context = useLedgerContext(target)
  const { client } = useApi()
  const query = useQuery(ledgerQuery(client, context.path))
  return (
    <Section
      id="pending"
      title={t('migrations.pending.title')}
      description={t('migrations.pending.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('migrations.ledger.what')}
        permission="migrations.read"
        ready={(status) => <PendingBlock pending={status.pending} context={context} />}
      />
    </Section>
  )
}

function useLedgerContext(target: Target): LedgerContext {
  const { client } = useApi()
  const route = useTargetScope().target
  // The same read as the timeline (one cache entry): the evidence environment's mirror.
  const stream = useQuery(streamQuery(client, target.projectId))
  return {
    projectId: target.projectId,
    path: route.path,
    environment: route.environment,
    tier: target.tier,
    stream: stream.data,
  }
}

/** What the ledger's actions need beyond the ledger: the project, the target and the stream. */
interface LedgerContext {
  readonly projectId: string
  /** The validated path of this target. */
  readonly path: string
  /** The validated slug of this target's environment. */
  readonly environment: string
  readonly tier: string
  /** The project's stream (the mirror of every environment), when it was read. */
  readonly stream: MigrationStream | undefined
}

function LedgerBody({
  status,
  context,
  search,
  change,
}: {
  readonly status: MigrationStatus
  readonly context: LedgerContext
  readonly search: MigrationsSearch
  readonly change: (next: Partial<MigrationsSearch>) => void
}): ReactNode {
  const source = readSourceOf(status.source)
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-light">
        {source === undefined ? (
          <span>{t('migrations.ledger.sourceUnknown')}</span>
        ) : (
          <SourceLabel source={source} />
        )}
        <span className="min-w-0 max-w-full">
          {t('migrations.ledger.observed')} <ObservedTime observedAt={status.observedAt} withDate />
        </span>
        {status.baselineId === null ? null : (
          <span className="min-w-0 max-w-full">
            {t('migrations.ledger.baseline')}{' '}
            <UntrustedName name={status.baselineId} mono label={t('migrations.ledger.baseline')} />
          </span>
        )}
        {status.ledgerStateHash === null ? null : (
          <span className="min-w-0 max-w-full">
            {t('migrations.ledger.hash')}{' '}
            <UntrustedName
              name={status.ledgerStateHash}
              mono
              maxCodePoints={24}
              label={t('migrations.ledger.hash')}
            />
          </span>
        )}
      </p>
      {status.mirror.inSync ? null : (
        <Admonition
          type="warning"
          title={t('migrations.ledger.mirrorDiffers.title')}
          description={t('migrations.ledger.mirrorDiffers.body')}
        />
      )}
      {status.incompleteNontransactional === undefined ||
      status.incompleteNontransactional.length === 0 ? null : (
        <Admonition
          type="warning"
          title={t('migrations.ledger.incomplete.title')}
          description={
            <>
              {t('migrations.ledger.incomplete.body')}{' '}
              {status.incompleteNontransactional.map((id, index) => (
                <span key={id}>
                  {index > 0 ? ', ' : ''}
                  <UntrustedName name={id} mono label={t('migrations.ledger.column.migration')} />
                </span>
              ))}
            </>
          }
        />
      )}
      {status.applied.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('migrations.ledger.empty')}</p>
      ) : (
        <History entries={status.applied} context={context} search={search} change={change} />
      )}
    </div>
  )
}

/**
 * The applied entries as a history to work through: a search over name and id, filters for
 * origin and verification and the sort, then one page of rows and the pager, every value in the
 * address. Only the page's rows are in the document, however long the ledger; the pager says
 * that the pages divide one whole read of the ledger (the server does not page it yet).
 */
function History({
  entries,
  context,
  search,
  change,
}: {
  readonly entries: readonly LedgerEntry[]
  readonly context: LedgerContext
  readonly search: MigrationsSearch
  readonly change: (next: Partial<MigrationsSearch>) => void
}): ReactNode {
  const rows = historyRows(entries, search)
  const size = search.size ?? DEFAULT_HISTORY_SIZE
  const page = pageSlice(rows, search.page ?? 1, size)
  return (
    <div className="flex flex-col gap-3" data-history>
      <HistoryToolbar search={search} change={change} />
      {/* Stays when no row matches and the pager (with its live range) is gone. */}
      <p role="status" className="sr-only">
        {t('migrations.history.matching', {
          shown: formatCount(rows.length),
          total: formatCount(entries.length),
        })}
      </p>
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-4">
          <p className="m-0 text-sm text-foreground-light">{t('migrations.history.noMatch')}</p>
          <Button
            type="button"
            size="tiny"
            variant="default"
            onClick={() =>
              change({ q: undefined, origin: undefined, verification: undefined, page: undefined })
            }
          >
            {t('migrations.history.reset')}
          </Button>
        </div>
      ) : (
        <LedgerTable entries={page.items} context={context} search={search} change={change} />
      )}
      {rows.length === 0 ? null : (
        <Pager
          label={t('migrations.history.pager')}
          page={page.page}
          pageSize={size}
          total={rows.length}
          onPage={(next) => change({ page: next })}
          onPageSize={(next) => change({ size: next, page: undefined })}
          text={pagerText()}
          note={t('migrations.history.note', {
            total: formatCount(entries.length),
            shown: formatCount(rows.length),
          })}
        />
      )}
    </div>
  )
}

const ORIGIN_LABEL: Readonly<Record<OriginFilter, MessageKey>> = {
  exponetdb: 'migrations.history.origin.exponetdb',
  legacy_import: 'migrations.history.origin.legacy_import',
  baseline: 'migrations.history.origin.baseline',
}

const VERIFICATION_LABEL: Readonly<Record<VerificationFilter, MessageKey>> = {
  passed: 'migrations.history.verification.passed',
  pending: 'migrations.history.verification.pending',
  failed: 'migrations.history.verification.failed',
  superseded: 'migrations.history.verification.superseded',
}

function HistoryToolbar({
  search,
  change,
}: {
  readonly search: MigrationsSearch
  readonly change: (next: Partial<MigrationsSearch>) => void
}): ReactNode {
  const ids = useId()
  return (
    <search className="flex flex-wrap items-start gap-2">
      <div className="relative w-full sm:w-64">
        <label htmlFor={`${ids}-q`} className="sr-only">
          {t('migrations.history.search')}
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-lighter"
        />
        <Input
          id={`${ids}-q`}
          type="search"
          size="tiny"
          className="pl-7"
          value={search.q ?? ''}
          maxLength={HISTORY_SEARCH_MAX_LENGTH}
          placeholder={t('migrations.history.search.placeholder')}
          autoComplete="off"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            change({
              q: event.target.value === '' ? undefined : event.target.value,
              page: undefined,
            })
          }
        />
      </div>
      <ToolbarField id={`${ids}-origin`} label={t('migrations.history.origin')}>
        <select
          id={`${ids}-origin`}
          className={TOOLBAR_CONTROL}
          value={search.origin ?? ''}
          onChange={(event) =>
            change({
              origin: ORIGINS.find((origin) => origin === event.target.value),
              page: undefined,
            })
          }
        >
          <option value="">{t('migrations.history.any')}</option>
          {ORIGINS.map((origin) => (
            <option key={origin} value={origin}>
              {t(ORIGIN_LABEL[origin])}
            </option>
          ))}
        </select>
      </ToolbarField>
      <ToolbarField id={`${ids}-verification`} label={t('migrations.history.verification')}>
        <select
          id={`${ids}-verification`}
          className={TOOLBAR_CONTROL}
          value={search.verification ?? ''}
          onChange={(event) =>
            change({
              verification: VERIFICATION_FILTERS.find((value) => value === event.target.value),
              page: undefined,
            })
          }
        >
          <option value="">{t('migrations.history.any')}</option>
          {VERIFICATION_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(VERIFICATION_LABEL[value])}
            </option>
          ))}
        </select>
      </ToolbarField>
      <ToolbarField id={`${ids}-sort`} label={t('migrations.history.sort')}>
        <select
          id={`${ids}-sort`}
          className={TOOLBAR_CONTROL}
          value={search.sort ?? 'newest'}
          onChange={(event) =>
            change({
              sort: event.target.value === 'oldest' ? 'oldest' : undefined,
              page: undefined,
            })
          }
        >
          <option value="newest">{t('migrations.history.sort.newest')}</option>
          <option value="oldest">{t('migrations.history.sort.oldest')}</option>
        </select>
      </ToolbarField>
    </search>
  )
}

function LedgerTable({
  entries,
  context,
  search,
  change,
}: {
  readonly entries: readonly LedgerEntry[]
  readonly context: LedgerContext
  readonly search: MigrationsSearch
  readonly change: (next: Partial<MigrationsSearch>) => void
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('migrations.ledger.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('migrations.ledger.column.migration')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.checksum')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.origin')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.applied')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.verification')}</TableHead>
          <TableHead scope="col">
            <span className="sr-only">{t('migrations.ledger.column.sql')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const operation = operationPath(entry.operationId)
          return (
            <TableRow
              key={`${entry.migrationId}:${entry.appliedAt}:${entry.checksum}`}
              data-migration={entry.migrationId}
            >
              <TableCell>
                <UntrustedName name={entry.name} label={t('migrations.ledger.column.migration')} />
                <div className="text-xs text-foreground-lighter">
                  <UntrustedName
                    name={entry.migrationId}
                    mono
                    label={t('migrations.ledger.column.migration')}
                  />
                </div>
                {entry.reverted ? (
                  <div className="text-xs text-foreground-light">
                    {t('migrations.ledger.reverted')}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs">
                <UntrustedName
                  name={entry.checksum}
                  mono
                  maxCodePoints={40}
                  label={t('migrations.ledger.column.checksum')}
                />
              </TableCell>
              <TableCell>
                <UntrustedName name={entry.origin} label={t('migrations.ledger.column.origin')} />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={entry.appliedAt} withDate />
                {operation === undefined ? null : (
                  <div className="text-xs">
                    <Link href={operation} className="text-primary underline focus-ring">
                      {t('migrations.ledger.operation')}
                    </Link>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <Verification entry={entry} />
              </TableCell>
              <TableCell>
                {isMigrationId(entry.migrationId) ? (
                  <ViewSqlButton
                    bundle={{
                      projectId: context.projectId,
                      migrationId: entry.migrationId,
                      name: entry.name,
                      targetPath: context.path,
                    }}
                    // The open panel is in the address (`?migration=`), so a link opens it again.
                    open={search.migration === entry.migrationId}
                    onOpenChange={(open) =>
                      change({ migration: open ? entry.migrationId : undefined })
                    }
                  />
                ) : null}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** "Verified 3 min ago", "Verification pending": a word for each status, never a color alone. */
function Verification({ entry }: { readonly entry: LedgerEntry }): ReactNode {
  const { status, verifiedAt, via, excused, superseded } = entry.verification
  if (superseded === true) {
    // An imported file decided superseded: its baseline's verification does not check it.
    return <span data-verification-via="baseline">{t('migrations.verification.superseded')}</span>
  }
  const label = ((): string | undefined => {
    switch (status) {
      case 'passed':
        return t('migrations.verification.passed')
      case 'pending':
        return t('migrations.verification.pending')
      case 'failed':
        return t('migrations.verification.failed')
      case 'partial':
        return t('migrations.verification.partial')
      case 'error':
        return t('migrations.verification.error')
      default:
        return undefined
    }
  })()
  return (
    <span {...(via === undefined ? {} : { 'data-verification-via': 'baseline' })}>
      {label ?? (
        <UntrustedName name={String(status)} label={t('migrations.ledger.column.verification')} />
      )}
      {via === undefined ? null : (
        <>
          {' '}
          {excused === undefined
            ? t('migrations.verification.viaBaseline')
            : t('migrations.verification.viaBaselineExcused', { count: excused })}
        </>
      )}
      {verifiedAt === null ? null : (
        <>
          {' '}
          <ObservedTime observedAt={verifiedAt} />
        </>
      )}
    </span>
  )
}

/**
 * The bundles of the project not applied to this target, from the target's
 * own read: each with its SQL, and for a production target what the evidence
 * environment's mirror says. The chosen ones are planned on this target; the
 * server orders them by `dependsOn`, checks the evidence live and decides.
 */
function PendingBlock({
  pending,
  context,
}: {
  readonly pending: MigrationStatus['pending']
  readonly context: LedgerContext
}): ReactNode {
  const plannable = pending.filter((bundle) => isMigrationId(bundle.migrationId))
  const selection = useBundleSelection(
    context.path,
    plannable.map((bundle) => bundle.migrationId),
  )
  const production = context.tier !== 'nonprod'
  const evidence = (bundle: MigrationStatus['pending'][number]) =>
    evidenceOf(context.stream, { slug: context.environment, tier: context.tier }, bundle)
  return (
    <div className="flex flex-col gap-2" data-pending-block>
      {pending.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('migrations.pending.empty')}</p>
      ) : (
        <>
          <Table>
            <TableCaption className="sr-only">{t('migrations.pending.caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-0">
                  <SelectAllCheckbox
                    total={plannable.length}
                    selected={selection.selected.length}
                    onChange={selection.setAll}
                  />
                </TableHead>
                <TableHead scope="col">{t('migrations.ledger.column.migration')}</TableHead>
                <TableHead scope="col">{t('migrations.ledger.column.checksum')}</TableHead>
                {production ? (
                  <TableHead scope="col">{t('promote.column.evidence')}</TableHead>
                ) : null}
                <TableHead scope="col">
                  <span className="sr-only">{t('migrations.ledger.column.sql')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((bundle) => {
                const valid = isMigrationId(bundle.migrationId)
                return (
                  <TableRow key={bundle.migrationId} data-pending={bundle.migrationId}>
                    <TableCell>
                      {valid ? (
                        <BundleCheckbox
                          migrationId={bundle.migrationId}
                          checked={selection.isSelected(bundle.migrationId)}
                          onChange={(on) => selection.toggle(bundle.migrationId, on)}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <UntrustedName
                        name={bundle.name}
                        label={t('migrations.ledger.column.migration')}
                      />
                      <div className="text-xs text-foreground-lighter">
                        <UntrustedName
                          name={bundle.migrationId}
                          mono
                          label={t('migrations.ledger.column.migration')}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <UntrustedName
                        name={bundle.checksum}
                        mono
                        maxCodePoints={40}
                        label={t('migrations.ledger.column.checksum')}
                      />
                    </TableCell>
                    {production ? (
                      <TableCell className="text-sm">
                        <EvidenceNote
                          evidence={evidence(bundle)}
                          destination={context.environment}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      {valid ? (
                        <ViewSqlButton
                          bundle={{
                            projectId: context.projectId,
                            migrationId: bundle.migrationId,
                            name: bundle.name,
                            targetPath: context.path,
                          }}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <PlanBundlesAction
            targetPath={context.path}
            environment={context.environment}
            tier={context.tier}
            bundles={plannable
              .filter((bundle) => selection.isSelected(bundle.migrationId))
              .map((bundle) => ({
                migrationId: bundle.migrationId,
                name: bundle.name,
                evidence: evidence(bundle),
              }))}
          />
        </>
      )}
    </div>
  )
}
