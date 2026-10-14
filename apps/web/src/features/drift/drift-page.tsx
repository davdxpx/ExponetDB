import type { DriftCheck, DriftFinding, FleetFinding } from '@exponetdb/sdk/operations'
import {
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { StructuredDiffTable } from '@exponetdb/ui-data'
import {
  Admonition,
  ObservedTime,
  SourceLabel,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { operationPath } from '../target-ops/ids.ts'
import { findingsQuery, opsKeys } from '../target-ops/keys.ts'
import { useTargetHref, useTargetPath } from '../target-ops/links.ts'
import { LoadMore, pagedQuery, SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import { AcceptDrift } from './accept-drift.tsx'
import { bySeverity, countsOf, diffRowOf, lastSeenOf, triage } from './drift-model.ts'

/**
 * `/t/<product>/<project>/<environment>/drift`: what differs between the
 * schema ExponetDB expects (the fingerprint the last applied migration or the
 * baseline recorded) and the schema the target has. Open drift findings first
 * (the server keeps them between checks), then the result of a check run from
 * this page with expected and actual side by side, triaged `drifted`,
 * `unmanaged`, `matched`. Accepting drift only creates a plan.
 */
export function DriftPage(): ReactNode {
  return (
    <TargetPage section="drift" description={t('drift.description')}>
      {(target) => <DriftBody target={target} />}
    </TargetPage>
  )
}

function DriftBody({ target }: { readonly target: Target }): ReactNode {
  const path = useTargetPath()
  const { client } = useApi()
  const queryClient = useQueryClient()
  const [check, setCheck] = useState<DriftCheck | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const run = async (): Promise<void> => {
    setRunning(true)
    setFailure(undefined)
    try {
      // A read that records: it runs the comparison and opens or resolves findings; no plan.
      const result = await client.operation('runDriftCheck', {
        params: { target: path },
        body: {},
      })
      setCheck(result)
      await queryClient.invalidateQueries({ queryKey: opsKeys.all })
    } catch (error) {
      setFailure(describeError(error))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Section id="check" title={t('drift.check.title')} description={t('drift.check.description')}>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default" size="small" loading={running} onClick={() => void run()}>
            {t('drift.check.run')}
          </Button>
        </div>
        {failure === undefined ? null : (
          <Admonition type="destructive" title={t('drift.check.failed')} description={failure} />
        )}
        {check === undefined ? (
          <p className="m-0 text-sm text-foreground-light">{t('drift.check.none')}</p>
        ) : (
          <CheckSummary check={check} />
        )}
      </Section>
      <OpenFindings target={target} />
      {check === undefined ? null : <Triaged check={check} />}
    </>
  )
}

const COUNT_LABELS = {
  drifted: () => t('drift.count.drifted'),
  unmanaged: () => t('drift.count.unmanaged'),
  matched: () => t('drift.count.matched'),
  opened: () => t('drift.count.opened'),
  updated: () => t('drift.count.updated'),
  resolved: () => t('drift.count.resolved'),
} as const

function CheckSummary({ check }: { readonly check: DriftCheck }): ReactNode {
  return (
    <div className="flex flex-col gap-2 text-sm" data-drift-check={check.id}>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-foreground-light">
        <SourceLabel source="live" />
        <span>
          {t('drift.check.checked')} <ObservedTime observedAt={check.checkedAt} withDate />
        </span>
        <span>
          {t('drift.check.status')}{' '}
          <UntrustedName name={check.status} label={t('drift.check.status')} />
        </span>
        {check.errorCode === null ? null : (
          <span>
            {t('drift.check.errorCode')}{' '}
            <code className="font-mono text-foreground">{check.errorCode}</code>
          </span>
        )}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {countsOf(check).map(([name, count]) => (
          <li key={name}>
            {COUNT_LABELS[name]()}: <strong>{count}</strong>
          </li>
        ))}
      </ul>
      {check.truncated ? (
        <Admonition
          type="warning"
          title={t('drift.check.truncated.title')}
          description={t('drift.check.truncated.body')}
        />
      ) : null}
      {check.baselineFingerprint === null && check.currentFingerprint === null ? (
        <p className="m-0 text-foreground-light">{t('drift.check.noFingerprint')}</p>
      ) : null}
    </div>
  )
}

/** The open drift findings the server keeps, most severe first, with the page's one "Accept drift". */
function OpenFindings({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const path = useTargetPath()
  const href = useTargetHref()
  const query = useInfiniteQuery(findingsQuery(client, path, { state: 'open', kind: 'drift' }))
  const Link = useLinkComponent()
  const paged = pagedQuery(query)
  return (
    <Section id="open" title={t('drift.open.title')} description={t('drift.open.description')}>
      <ReadSection
        query={paged}
        what={nounPhrase('drift.open.what')}
        permission="diagnostics.read"
        missing={(value) => (value.more ? [t('drift.open.more')] : undefined)}
        empty={{ isEmpty: (value) => value.items.length === 0 }}
        ready={(value) => {
          const sorted = bySeverity(value.items)
          const first = sorted[0]
          const lastSeen = lastSeenOf(value.items)
          return (
            <div className="flex flex-col gap-3">
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-light">
                <span>{t('drift.open.count', { count: value.items.length })}</span>
                {lastSeen === undefined ? null : (
                  <span>
                    {t('drift.open.lastSeen')} <ObservedTime observedAt={lastSeen} withDate />
                  </span>
                )}
                <Link
                  href={href('/findings?kind=drift')}
                  className="text-primary underline focus-ring"
                >
                  {t('drift.open.allFindings')}
                </Link>
              </p>
              <OpenTable findings={sorted} />
              {first === undefined ? null : (
                <div className="flex flex-col gap-2">
                  <AcceptDrift
                    findingId={first.id}
                    covered={value.more ? undefined : value.items.length}
                    reasonExpected={sorted.some(
                      (finding) => finding.severity === 'critical' || finding.securityRelevant,
                    )}
                    tier={target.tier}
                  />
                  <p className="m-0 text-xs text-foreground-light">{t('drift.accept.explain')}</p>
                </div>
              )}
              <LoadMore
                more={value.more}
                loading={query.isFetchingNextPage}
                onLoad={() => void query.fetchNextPage()}
                label={t('findings.loadMore')}
              />
            </div>
          )
        }}
      />
    </Section>
  )
}

function OpenTable({ findings }: { readonly findings: readonly FleetFinding[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('drift.open.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('drift.open.column.severity')}</TableHead>
          <TableHead scope="col">{t('drift.open.column.object')}</TableHead>
          <TableHead scope="col">{t('drift.open.column.summary')}</TableHead>
          <TableHead scope="col">{t('drift.open.column.seen')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((finding) => (
          <TableRow key={finding.id} data-finding={finding.id}>
            <TableCell>
              <SeverityBadge severity={finding.severity} />
              {finding.securityRelevant ? (
                <div className="text-xs text-foreground-light">
                  {t('findings.securityRelevant')}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              {finding.object === null ? (
                <span className="text-foreground-light">{t('findings.noObject')}</span>
              ) : (
                <UntrustedName name={finding.object} mono label={t('drift.open.column.object')} />
              )}
              <div className="text-xs text-foreground-lighter">
                <UntrustedName name={finding.code} mono label={t('drift.open.column.code')} />
              </div>
            </TableCell>
            <TableCell>
              <UntrustedName
                name={finding.summary}
                maxCodePoints={200}
                label={t('drift.open.column.summary')}
              />
            </TableCell>
            <TableCell>
              <ObservedTime observedAt={finding.lastSeenAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The result of the check run from this page: drifted first, expected and actual side by side. */
function Triaged({ check }: { readonly check: DriftCheck }): ReactNode {
  const groups = triage(check.findings)
  return (
    <Section
      id="triage"
      title={t('drift.triage.title')}
      description={t('drift.triage.description')}
    >
      <Bucket
        name="drifted"
        findings={bySeverity(groups.drifted)}
        open
        absent={t('drift.absent')}
        checkedAt={check.checkedAt}
      />
      <Bucket
        name="unmanaged"
        findings={groups.unmanaged}
        open
        absent={t('drift.absent')}
        checkedAt={check.checkedAt}
      />
      <Bucket
        name="matched"
        findings={groups.matched}
        open={false}
        absent={t('drift.absent')}
        checkedAt={check.checkedAt}
      />
      {groups.other.length === 0 ? null : (
        <Bucket
          name="other"
          findings={groups.other}
          open
          absent={t('drift.absent')}
          checkedAt={check.checkedAt}
        />
      )}
    </Section>
  )
}

function Bucket({
  name,
  findings,
  open,
  absent,
  checkedAt,
}: {
  readonly checkedAt: string
  readonly name: 'drifted' | 'unmanaged' | 'matched' | 'other'
  readonly findings: readonly DriftFinding[]
  readonly open: boolean
  readonly absent: string
}): ReactNode {
  const Link = useLinkComponent()
  const rows = findings.map(diffRowOf)
  const title = `${t(`drift.bucket.${name}`)} (${findings.length})`
  return (
    <details open={open} data-bucket={name} className="rounded-md border border-default">
      <summary className="cursor-pointer px-3 py-2 text-base font-medium focus-ring">
        {title}
      </summary>
      <div className="flex flex-col gap-3 p-3">
        {findings.length === 0 ? (
          <p className="m-0 text-sm text-foreground-light">{t('drift.bucket.empty')}</p>
        ) : (
          <>
            <StructuredDiffTable
              rows={{ state: 'ready', value: rows, source: 'live', observedAt: checkedAt }}
              what={title.toLowerCase()}
              keyLabel={t('drift.column.object')}
              beforeLabel={t('drift.column.expected')}
              afterLabel={t('drift.column.actual')}
              absentLabel={absent}
              headingLevel={4}
            />
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-foreground-light">
              {findings.map((finding) => {
                const operation = operationPath(finding.explainedByOperationId)
                return (
                  <li key={finding.id} className="flex flex-wrap items-center gap-2">
                    <UntrustedName
                      name={finding.object ?? finding.code}
                      mono
                      maxCodePoints={60}
                      label={t('drift.column.object')}
                    />
                    <SeverityBadge severity={finding.severity} />
                    <span>{t('drift.kind', { kind: finding.driftKind })}</span>
                    {finding.explainedByOperationId === null ? null : operation === undefined ? (
                      <UntrustedName
                        name={finding.explainedByOperationId}
                        mono
                        label={t('drift.explained')}
                      />
                    ) : (
                      <Link href={operation} className="text-primary underline focus-ring">
                        {t('drift.explained')}
                      </Link>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </details>
  )
}
