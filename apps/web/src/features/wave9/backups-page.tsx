import type { Finding, Operation } from '@exponetdb/sdk/operations'
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
  formatCount,
  ObservedTime,
  StateMessage,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { Observation } from '../connections/live-read.tsx'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { clusterPath, operationPath } from '../target-ops/ids.ts'
import { LoadMore, SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import {
  DiscardRestore,
  PlanBackupRun,
  PlanDrill,
  PlanRecovery,
  RecordOfflineDrill,
  RefreshCatalog,
  VerifyBackup,
} from './backup-actions.tsx'
import {
  catalogQuery,
  clusterFindingsQuery,
  drillsQuery,
  policyQuery,
  repositoriesQuery,
  restoresQuery,
  runsQuery,
} from './keys.ts'
import {
  type BackupEntry,
  backupTone,
  type Drill,
  drillTone,
  type EngineRun,
  formatBytes,
  formatSeconds,
  isDiscardable,
  type Restore,
  type Runbook,
  restoreTone,
  runTone,
} from './model.ts'
import { flatPages, Missing, StartedNotice, ToneBadge, useRefusals } from './parts.tsx'
import { PlanPolicy, PolicyFacts } from './policy.tsx'
import { ProtectionView, WalCoverageList } from './protection.tsx'
import { AdoptRepository, RepositoriesTable } from './repositories.tsx'

/**
 * `/t/<product>/<project>/<environment>/backups`: the protection of the
 * cluster the target is placed on, as the Control Store mirrors the backup
 * engines' catalogs (backup-and-restore architecture §3): state and reasons,
 * RPO with basis and uncertainty, RTO from the last passed drill, the PITR
 * window, the repositories with ownership and lock, the policy, the backups
 * (paged), engine runs, drills (an offline drill is labeled an attestation),
 * restores and the cluster's findings. Every list is the server's page; a
 * failed read is a named failure, never an empty list. Actions are plans or
 * inline operations, never a direct restore: execution is human-only on the
 * plan page.
 */
export function TargetBackupsPage(): ReactNode {
  return (
    <TargetPage section="backups" description={t('wave9.backups.description')}>
      {(target) =>
        target.placement === null ? (
          <StateMessage
            data-state="no-placement"
            title={t('wave9.backups.noPlacement.title')}
            headingLevel={2}
          >
            <p>{t('wave9.backups.noPlacement.body')}</p>
          </StateMessage>
        ) : (
          <ClusterBackups target={target} clusterId={target.placement.clusterId} />
        )
      }
    </TargetPage>
  )
}

interface Started {
  readonly operation: Operation
  readonly message: string
}

function ClusterBackups({
  target,
  clusterId,
}: {
  readonly target: Target
  readonly clusterId: string
}): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const refusals = useRefusals()
  const [started, setStarted] = useState<Started | undefined>(undefined)
  const [runbook, setRunbook] = useState<Runbook | undefined>(undefined)
  const [recorded, setRecorded] = useState(false)
  const catalogRead = useInfiniteQuery(catalogQuery(client, clusterId))
  const catalog = flatPages(catalogRead, (page) => page.backups)
  const repositories = useQuery(repositoriesQuery(client, clusterId))
  const policy = useQuery(policyQuery(client, clusterId))
  const runsRead = useInfiniteQuery(runsQuery(client, clusterId))
  const drillsRead = useInfiniteQuery(drillsQuery(client, clusterId))
  const restoresRead = useInfiniteQuery(restoresQuery(client, clusterId))
  const findingsRead = useInfiniteQuery(clusterFindingsQuery(client, clusterId))
  const first = catalog.data?.first
  const summaries = first?.repositories ?? []
  const backups = catalog.data?.items ?? []
  const tier = target.tier === 'prod' ? 'prod' : 'nonprod'
  const actionProps = {
    clusterId,
    targetPath: target.path,
    tier,
    repositories: summaries,
    backups,
    refusals,
  } as const
  const cluster = clusterPath(clusterId)
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t('wave9.backups.protection.title')}
        description={t('wave9.backups.protection.description')}
      >
        {cluster === undefined || target.placement === null ? null : (
          <p className="m-0 text-xs text-foreground-light">
            {t('wave9.backups.cluster')}{' '}
            <Link href={cluster} className="text-primary underline focus-ring">
              <UntrustedName name={target.placement.clusterName} expandable={false} />
            </Link>
          </p>
        )}
        <ReadSection
          query={catalog}
          what={nounPhrase('wave9.backups.catalog.what')}
          permission="backups.read"
          ready={(value) => (
            <div className="flex flex-col gap-4">
              <Observation source={value.first.source} observedAt={value.first.observedAt} />
              <ProtectionView protection={value.first.protection} />
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-sm font-medium">{t('wave9.wal.title')}</h3>
                <WalCoverageList coverage={value.first.walCoverage} />
              </div>
            </div>
          )}
        />
        <div className="flex flex-col gap-3" data-slot="backup-actions">
          <h3 className="m-0 text-sm font-medium">{t('wave9.actions.title')}</h3>
          <p className="m-0 text-xs text-foreground-light">{t('wave9.actions.note')}</p>
          <div className="flex flex-wrap items-start gap-4">
            <RefreshCatalog
              clusterId={clusterId}
              refusals={refusals}
              onStarted={(operation) =>
                setStarted({ operation, message: t('wave9.refresh.started') })
              }
            />
            {first === undefined ? null : (
              <>
                <PlanBackupRun {...actionProps} />
                <PlanDrill {...actionProps} />
                <PlanRecovery {...actionProps} />
                <RecordOfflineDrill
                  clusterId={clusterId}
                  repositories={summaries}
                  runbookDigest={runbook?.digest}
                  refusals={refusals}
                  onRecorded={() => setRecorded(true)}
                />
              </>
            )}
          </div>
          {first === undefined ? (
            <p className="m-0 text-xs text-foreground-light">{t('wave9.actions.needCatalog')}</p>
          ) : null}
          <StartedNotice operation={started?.operation} message={started?.message ?? ''} />
          {recorded ? (
            <p className="m-0 text-sm" role="status" data-recorded="">
              {t('wave9.offline.recorded')}
            </p>
          ) : null}
        </div>
      </Section>

      <Section
        title={t('wave9.repositories.title')}
        description={t('wave9.repositories.description')}
      >
        <ReadSection
          query={{ ...repositories, refetch: () => repositories.refetch() }}
          what={nounPhrase('wave9.repositories.what')}
          permission="backups.read"
          empty={{
            isEmpty: (value) => value.repositories.length === 0,
            content: (
              <p className="m-0 text-sm text-foreground-light" data-empty="repositories">
                {t('wave9.repositories.empty')}
              </p>
            ),
          }}
          ready={(value) => (
            <RepositoriesTable
              clusterId={clusterId}
              repositories={value.repositories}
              refusals={refusals}
              onRunbook={setRunbook}
            />
          )}
        />
        <AdoptRepository clusterId={clusterId} refusals={refusals} />
      </Section>

      <Section title={t('wave9.policy.title')} description={t('wave9.policy.description')}>
        <ReadSection
          query={{ ...policy, refetch: () => policy.refetch() }}
          what={nounPhrase('wave9.policy.what')}
          permission="backups.read"
          ready={(value) => (
            <div className="flex flex-col gap-3">
              <PolicyFacts policy={value.policy} />
              <PlanPolicy
                clusterId={clusterId}
                policy={value.policy}
                repositories={summaries}
                refusals={refusals}
              />
            </div>
          )}
        />
      </Section>

      <Section
        title={t('wave9.list.backups.title')}
        description={t('wave9.list.backups.description')}
      >
        <ReadSection
          query={catalog}
          what={nounPhrase('wave9.list.backups.what')}
          permission="backups.read"
          missing={(value) => (value.more ? [t('wave9.list.more')] : undefined)}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: (
              <p className="m-0 text-sm text-foreground-light" data-empty="backups">
                {t('wave9.list.backups.empty')}
              </p>
            ),
          }}
          ready={(value) => (
            <div className="flex flex-col gap-3">
              <BackupsTable
                backups={value.items}
                clusterId={clusterId}
                tier={tier}
                refusals={refusals}
                onStarted={(operation) =>
                  setStarted({ operation, message: t('wave9.verify.started') })
                }
              />
              <LoadMore
                more={value.more}
                loading={catalogRead.isFetchingNextPage}
                onLoad={() => void catalogRead.fetchNextPage()}
                label={t('wave9.list.loadMore')}
              />
            </div>
          )}
        />
      </Section>

      <Section
        title={t('wave9.list.drills.title')}
        description={t('wave9.list.drills.description')}
      >
        <PagedList
          query={drillsRead}
          itemsOf={(page) => page.drills}
          what={nounPhrase('wave9.list.drills.what')}
          empty={t('wave9.list.drills.empty')}
          render={(items) => <DrillsTable drills={items} />}
        />
      </Section>

      <Section
        title={t('wave9.list.restores.title')}
        description={t('wave9.list.restores.description')}
      >
        <PagedList
          query={restoresRead}
          itemsOf={(page) => page.restores}
          what={nounPhrase('wave9.list.restores.what')}
          empty={t('wave9.list.restores.empty')}
          render={(items) => (
            <RestoresTable restores={items} clusterId={clusterId} tier={tier} refusals={refusals} />
          )}
        />
      </Section>

      <Section title={t('wave9.list.runs.title')} description={t('wave9.list.runs.description')}>
        <PagedList
          query={runsRead}
          itemsOf={(page) => page.runs}
          what={nounPhrase('wave9.list.runs.what')}
          empty={t('wave9.list.runs.empty')}
          render={(items) => <RunsTable runs={items} />}
        />
      </Section>

      <Section
        title={t('wave9.list.findings.title')}
        description={t('wave9.list.findings.description')}
      >
        <PagedList
          query={findingsRead}
          itemsOf={(page) => page.items}
          what={nounPhrase('wave9.list.findings.what')}
          empty={t('wave9.list.findings.empty')}
          render={(items) => <FindingsList findings={items} />}
        />
      </Section>
    </div>
  )
}

/** One paged list of the cluster, read by the server's cursor, shown truthfully. */
function PagedList<P extends { readonly nextCursor: string | null }, I>(props: {
  readonly query: Parameters<typeof flatPages<P, I>>[0]
  readonly itemsOf: (page: P) => readonly I[]
  readonly what: string
  readonly empty: string
  readonly render: (items: readonly I[]) => ReactNode
}): ReactNode {
  const section = flatPages(props.query, props.itemsOf)
  return (
    <ReadSection
      query={section}
      what={props.what}
      permission="backups.read"
      missing={(value) => (value.more ? [t('wave9.list.more')] : undefined)}
      empty={{
        isEmpty: (value) => value.items.length === 0,
        content: (
          <p className="m-0 text-sm text-foreground-light" data-empty="">
            {props.empty}
          </p>
        ),
      }}
      ready={(value) => (
        <div className="flex flex-col gap-3">
          {props.render(value.items)}
          <LoadMore
            more={value.more}
            loading={props.query.isFetchingNextPage}
            onLoad={() => void props.query.fetchNextPage()}
            label={t('wave9.list.loadMore')}
          />
        </div>
      )}
    />
  )
}

function When({ at }: { readonly at: string | null }): ReactNode {
  return at === null ? (
    <Missing>{t('wave9.none')}</Missing>
  ) : (
    <ObservedTime observedAt={at} withDate />
  )
}

function BackupsTable(props: {
  readonly backups: readonly BackupEntry[]
  readonly clusterId: string
  readonly tier: 'prod' | 'nonprod'
  readonly refusals: ReturnType<typeof useRefusals>
  readonly onStarted: (operation: Operation) => void
}): ReactNode {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.list.backups.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.list.column.backup')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.state')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.time')}</TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.list.column.size')}
            </TableHead>
            <TableHead scope="col">{t('wave9.list.column.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.backups.map((backup) => (
            <TableRow key={backup.id} data-backup={backup.id}>
              <TableCell className="align-top text-sm">
                <div>{t(`wave9.kind.${backup.kind}`)}</div>
                <div className="text-xs text-foreground-light">
                  <UntrustedName name={backup.engineLabel} mono />
                </div>
                <div className="text-xs text-foreground-light">
                  {t('wave9.list.backup.repository', { id: backup.repositoryId })}
                </div>
                <div className="text-xs text-foreground-light">
                  {backup.timeline === null
                    ? null
                    : t('wave9.list.backup.timeline', { timeline: backup.timeline })}
                </div>
              </TableCell>
              <TableCell className="align-top text-xs">
                <ToneBadge tone={backupTone(backup)} data-verification={backup.verification.state}>
                  {backup.state === 'succeeded'
                    ? t(`wave9.verification.${backup.verification.state}`)
                    : t(`wave9.backupState.${backup.state}`)}
                </ToneBadge>
                {backup.verification.verifiedAt === null ? null : (
                  <div className="mt-1 text-foreground-light">
                    <ObservedTime observedAt={backup.verification.verifiedAt} />
                  </div>
                )}
                {backup.divergence === 'missing_in_engine' ? (
                  <div className="mt-1 text-destructive" data-divergence="">
                    {t('wave9.list.backup.missing')}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="align-top text-xs">
                <div>
                  {t('wave9.list.started')} <When at={backup.startedAt} />
                </div>
                <div>
                  {t('wave9.list.finished')} <When at={backup.finishedAt} />
                </div>
              </TableCell>
              <TableCell className="text-right align-top text-xs tabular-nums">
                {backup.sizeBytes === null ? (
                  <Missing>{t('wave9.none')}</Missing>
                ) : (
                  formatBytes(backup.sizeBytes)
                )}
              </TableCell>
              <TableCell className="align-top">
                <VerifyBackup
                  clusterId={props.clusterId}
                  backup={backup}
                  tier={props.tier}
                  refusals={props.refusals}
                  onStarted={props.onStarted}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function DrillsTable({ drills }: { readonly drills: readonly Drill[] }): ReactNode {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.list.drills.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.list.column.drill')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.outcome')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.rto')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.time')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {drills.map((drill) => {
            const attestation = drill.mode === 'offline_runbook'
            return (
              <TableRow key={drill.id} data-drill={drill.id} data-mode={drill.mode}>
                <TableCell className="align-top text-sm">
                  <div>
                    {t(
                      `wave9.drill.selection.${drill.selection === 'pitr_random' ? 'pitrRandom' : drill.selection}`,
                    )}
                  </div>
                  {attestation ? (
                    <div className="text-xs text-foreground-light" data-attestation="">
                      {t('wave9.list.drill.attestation')}
                    </div>
                  ) : (
                    <div className="text-xs text-foreground-light">
                      {t('wave9.list.drill.controlPlane')}
                    </div>
                  )}
                  <div className="font-mono text-xs text-foreground-lighter">{drill.id}</div>
                </TableCell>
                <TableCell className="align-top">
                  <ToneBadge tone={drillTone(drill)} data-outcome={drill.outcome}>
                    {t(`wave9.drillOutcome.${drill.outcome}`)}
                  </ToneBadge>
                </TableCell>
                <TableCell className="align-top text-sm">
                  {drill.outcome === 'passed' && drill.measuredRtoSeconds !== null ? (
                    formatSeconds(drill.measuredRtoSeconds)
                  ) : (
                    <Missing>
                      {drill.outcome === 'attested' || attestation
                        ? t('wave9.list.drill.rtoAttested')
                        : t('wave9.list.drill.rtoNone')}
                    </Missing>
                  )}
                </TableCell>
                <TableCell className="align-top text-xs">
                  <div>
                    {t('wave9.list.started')} <When at={drill.startedAt} />
                  </div>
                  <div>
                    {t('wave9.list.finished')} <When at={drill.finishedAt} />
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function RestoresTable(props: {
  readonly restores: readonly Restore[]
  readonly clusterId: string
  readonly tier: 'prod' | 'nonprod'
  readonly refusals: ReturnType<typeof useRefusals>
}): ReactNode {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.list.restores.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.list.column.restore')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.state')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.checks')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.restores.map((restore) => (
            <TableRow key={restore.id} data-restore={restore.id}>
              <TableCell className="align-top text-sm">
                <div>{t(`wave9.purpose.${restore.purpose}`)}</div>
                <div className="text-xs text-foreground-light">
                  {restore.source.backupId !== null
                    ? t('wave9.list.restore.fromBackup', { id: restore.source.backupId })
                    : restore.source.pointInTime !== null
                      ? t('wave9.list.restore.fromTime', { at: restore.source.pointInTime })
                      : t('wave9.list.restore.fromLatest')}
                </div>
                <div className="text-xs text-foreground-light">
                  {t(
                    restore.destination.kind === 'scratch'
                      ? 'wave9.list.restore.scratch'
                      : 'wave9.list.restore.newCluster',
                    { node: restore.destination.nodeId },
                  )}
                </div>
                <div className="font-mono text-xs text-foreground-lighter">{restore.id}</div>
              </TableCell>
              <TableCell className="align-top text-xs">
                <ToneBadge tone={restoreTone(restore.state)} data-state={restore.state}>
                  {t(`wave9.restoreState.${restore.state}`)}
                </ToneBadge>
                {restore.phases.length === 0 ? null : (
                  <ul className="m-0 mt-1 flex flex-col gap-0.5 pl-0 text-foreground-light">
                    {restore.phases.map((phase) => (
                      <li key={phase.name} className="list-none">
                        {t('wave9.list.restore.phase', {
                          phase: phase.name,
                          outcome: phase.outcome,
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell className="align-top text-xs">
                {restore.checks.length === 0 ? (
                  <Missing>{t('wave9.list.restore.noChecks')}</Missing>
                ) : (
                  <ul className="m-0 flex flex-col gap-0.5 pl-0">
                    {restore.checks.map((check) => (
                      <li key={check.check} className="list-none" data-check={check.outcome}>
                        {t('wave9.list.restore.check', {
                          check: check.check,
                          outcome: check.outcome,
                        })}
                        {check.detail === null ? null : (
                          <span className="block text-foreground-light">
                            <UntrustedName name={check.detail} maxCodePoints={160} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell className="align-top">
                {isDiscardable(restore) ? (
                  <DiscardRestore
                    clusterId={props.clusterId}
                    restore={restore}
                    tier={props.tier}
                    refusals={props.refusals}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RunsTable({ runs }: { readonly runs: readonly EngineRun[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.list.runs.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.list.column.run')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.state')}</TableHead>
            <TableHead scope="col">{t('wave9.list.column.time')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} data-run={run.id}>
              <TableCell className="align-top text-sm">
                <div>{t(`wave9.runPurpose.${run.purpose}`)}</div>
                {operationPath(run.operationId) === undefined ? null : (
                  <div className="text-xs">
                    <Link
                      href={operationPath(run.operationId) ?? ''}
                      className="text-primary underline focus-ring"
                    >
                      {t('wave9.action.followOperation')}
                    </Link>
                  </div>
                )}
              </TableCell>
              <TableCell className="align-top text-xs">
                <ToneBadge tone={runTone(run.state)} data-state={run.state}>
                  {t(`wave9.runState.${run.state}`)}
                </ToneBadge>
                {run.progress?.percent == null ? null : (
                  <div className="mt-1 text-foreground-light">
                    {t('wave9.list.run.progress', { percent: Math.round(run.progress.percent) })}
                  </div>
                )}
                {run.errorCode === null ? null : (
                  <div className="mt-1 font-mono text-foreground-light">{run.errorCode}</div>
                )}
              </TableCell>
              <TableCell className="align-top text-xs">
                <div>
                  {t('wave9.list.started')} <When at={run.startedAt} />
                </div>
                <div>
                  {t('wave9.list.finished')} <When at={run.finishedAt} />
                </div>
                {run.lastStatusAt === null ? null : (
                  <div className="text-foreground-light">
                    {t('wave9.list.run.lastStatus')} <ObservedTime observedAt={run.lastStatusAt} />
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function FindingsList({ findings }: { readonly findings: readonly Finding[] }): ReactNode {
  return (
    <ul className="m-0 flex flex-col gap-3 pl-0">
      {findings.map((finding) => (
        <li key={finding.id} className="flex list-none flex-col gap-1" data-finding={finding.id}>
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <UntrustedName name={finding.code} mono />
          </span>
          <UntrustedName name={finding.summary} maxCodePoints={200} />
          <span className="text-xs text-foreground-light">
            {t('wave9.advisors.lastSeen')} <ObservedTime observedAt={finding.lastSeenAt} />{' '}
            {t('wave9.advisors.occurrences', { count: formatCount(finding.occurrences) })}
          </span>
        </li>
      ))}
    </ul>
  )
}
