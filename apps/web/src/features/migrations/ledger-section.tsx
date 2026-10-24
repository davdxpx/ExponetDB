import type { LedgerEntry, MigrationStatus, MigrationStream } from '@exponetdb/sdk/operations'
import {
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
  ObservedTime,
  SourceLabel,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
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
export function LedgerSection({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const route = useTargetScope().target
  const query = useQuery(ledgerQuery(client, route.path))
  // The same read as the timeline below (one cache entry): the evidence environment's mirror.
  const stream = useQuery(streamQuery(client, target.projectId))
  const context: LedgerContext = {
    projectId: target.projectId,
    path: route.path,
    environment: route.environment,
    tier: target.tier,
    stream: stream.data,
  }
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
        ready={(status) => <LedgerBody status={status} context={context} />}
      />
    </Section>
  )
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
}: {
  readonly status: MigrationStatus
  readonly context: LedgerContext
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
        <LedgerTable entries={status.applied} context={context} />
      )}
      <PendingBlock pending={status.pending} context={context} />
    </div>
  )
}

function LedgerTable({
  entries,
  context,
}: {
  readonly entries: readonly LedgerEntry[]
  readonly context: LedgerContext
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
      <h3 className="m-0 text-base font-medium">{t('migrations.pending.title')}</h3>
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
