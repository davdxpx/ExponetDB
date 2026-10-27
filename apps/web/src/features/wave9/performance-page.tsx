import {
  Badge,
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exponetdb/ui'
import {
  Admonition,
  formatCount,
  ObservedTime,
  readableValue,
  StateMessage,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { LiveReadView, Observation } from '../connections/live-read.tsx'
import { DiagnosticsFrame } from '../connections/page-frame.tsx'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetScope } from '../target/scope.tsx'
import { useTargetHref } from '../target-ops/links.ts'
import { queryStatsQuery, STATS_POLL_MS, tableStatsQuery } from './keys.ts'
import {
  formatBytes,
  formatFactor,
  formatMs,
  type IndexStat,
  isUnusedIndex,
  ORDERS,
  type QueryStats,
  RESET_KEYS,
  type Regression,
  SAMPLING_KEYS,
  type Sampling,
  STATEMENT_LIMITS,
  type StatementLimit,
  type StatsOrder,
  type StatsWindow,
  samplingProblem,
  type TableStats,
  WINDOWS,
} from './model.ts'
import { Missing, SelectField } from './parts.tsx'

const WINDOW_LABELS = {
  '1h': 'wave9.statements.window.1h',
  '24h': 'wave9.statements.window.24h',
  '7d': 'wave9.statements.window.7d',
} as const
const ORDER_LABELS = {
  total_time: 'wave9.statements.order.total',
  mean_time: 'wave9.statements.order.mean',
  calls: 'wave9.statements.order.calls',
  io: 'wave9.statements.order.io',
} as const

/**
 * `/t/<product>/<project>/<environment>/performance` (performance.md):
 * "Statements" are the sampled `pg_stat_statements` history of a window (the
 * sampler's state, resets and gaps said on the window; a regression is a
 * time coincidence with migrations, never a proven cause); "Tables and
 * indexes" is a live read of the target (unused since the statistics count,
 * duplicate and invalid indexes, bloat as an estimate). The statement text is
 * normalized and untrusted; text that could carry a secret comes redacted.
 * The page needs no reachable target for the history; the live tab says when
 * the target cannot be read.
 */
export function PerformancePage(): ReactNode {
  return (
    <DiagnosticsFrame section="performance" description={t('wave9.performance.description')}>
      <PerformanceBody />
    </DiagnosticsFrame>
  )
}

type PerformanceTab = 'statements' | 'tables'

function PerformanceBody(): ReactNode {
  const [tab, setTab] = useState<PerformanceTab>('statements')
  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next === 'tables' ? 'tables' : 'statements')}>
      <TabsList>
        <TabsTrigger value="statements">{t('wave9.performance.tab.statements')}</TabsTrigger>
        <TabsTrigger value="tables">{t('wave9.performance.tab.tables')}</TabsTrigger>
      </TabsList>
      <TabsContent value="statements" className="flex flex-col gap-4 pt-4">
        <StatementsSection />
      </TabsContent>
      <TabsContent value="tables" className="flex flex-col gap-4 pt-4">
        <TablesSection />
      </TabsContent>
    </Tabs>
  )
}

// ----- statements -----

function StatementsSection(): ReactNode {
  const { client } = useApi()
  const path = useTargetScope().target.path
  const [window, setWindow] = useState<StatsWindow>('24h')
  const [order, setOrder] = useState<StatsOrder>('total_time')
  const [limit, setLimit] = useState<StatementLimit>(50)
  const query = useQuery(queryStatsQuery(client, path, window, order, limit))
  const interval = query.data?.sampling?.intervalSeconds
  const readable = toReadable(query, {
    // A sampled read is old after two sampling intervals (and never before two polls).
    staleAfterMs: Math.max(2 * STATS_POLL_MS, (interval ?? 0) * 2_000 + 60_000),
    missing: (value) =>
      value.truncated ? [t('wave9.statements.truncated', { limit })] : undefined,
  })
  const failure = query.data === undefined && query.isError ? readable : undefined
  const capability = failure?.state === 'failed' && failure.error.code === 'CAPABILITY_UNAVAILABLE'
  return (
    <section aria-labelledby="statements-title" className="flex flex-col gap-4">
      <h2 id="statements-title" className="m-0 text-base font-medium">
        {t('wave9.statements.title')}
      </h2>
      <p className="m-0 text-sm text-foreground-light">{t('wave9.statements.description')}</p>
      <form
        className="flex flex-wrap items-end gap-4"
        aria-label={t('wave9.statements.controls')}
        onSubmit={(event) => event.preventDefault()}
      >
        <SelectField
          label={t('wave9.statements.window')}
          value={window}
          options={WINDOWS.map((value) => ({ value, label: t(WINDOW_LABELS[value]) }))}
          onChange={setWindow}
        />
        <SelectField
          label={t('wave9.statements.order')}
          value={order}
          options={ORDERS.map((value) => ({ value, label: t(ORDER_LABELS[value]) }))}
          onChange={setOrder}
        />
        <SelectField
          label={t('wave9.statements.limit')}
          value={String(limit) as `${StatementLimit}`}
          options={STATEMENT_LIMITS.map((value) => ({
            value: String(value) as `${StatementLimit}`,
            label: t('wave9.statements.limitValue', { count: value }),
          }))}
          onChange={(value) =>
            setLimit(STATEMENT_LIMITS.find((candidate) => String(candidate) === value) ?? 50)
          }
        />
      </form>
      {capability ? (
        <StateMessage
          data-state="extension-missing"
          title={t('wave9.statements.sampling.missing.title')}
          headingLevel={3}
        >
          <p>{t('wave9.statements.sampling.missing.body')}</p>
          <p className="text-xs">
            {t('error.withCode', {
              message: failure.state === 'failed' ? failure.error.message : '',
              code: 'CAPABILITY_UNAVAILABLE',
            })}
          </p>
        </StateMessage>
      ) : (
        <LiveReadView
          readable={readable}
          what={nounPhrase('wave9.statements.what')}
          onRetry={() => void query.refetch()}
          busy={query.isFetching}
          isEmpty={(value: QueryStats) =>
            value.statements.length === 0 && samplingProblem(value.sampling) === undefined
          }
          empty={
            <p className="m-0 text-sm text-foreground-light" data-empty="statements">
              {t('wave9.statements.empty')}
            </p>
          }
          ready={(value) => <StatementsView stats={value} />}
        />
      )}
    </section>
  )
}

function StatementsView({ stats }: { readonly stats: QueryStats }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <Observation source={stats.source} observedAt={stats.observedAt} />
      <p className="m-0 text-xs text-foreground-light" data-slot="window">
        {t('wave9.statements.windowRange')} <ObservedTime observedAt={stats.window.from} withDate />{' '}
        – <ObservedTime observedAt={stats.window.to} withDate />
      </p>
      {stats.sampling === undefined ? (
        <p className="m-0 text-xs text-foreground-light" data-sampling="unreported">
          {t('wave9.statements.sampling.unreported')}
        </p>
      ) : (
        <SamplingView sampling={stats.sampling} />
      )}
      {stats.statements.length === 0 ? null : <StatementsTable stats={stats} />}
    </div>
  )
}

function SamplingView({ sampling }: { readonly sampling: Sampling }): ReactNode {
  const problem = samplingProblem(sampling)
  return (
    <div className="flex flex-col gap-2" data-sampling={sampling.state}>
      {problem === undefined ? (
        <p className="m-0 text-xs text-foreground-light">
          {t('wave9.statements.sampling.active', { seconds: sampling.intervalSeconds })}{' '}
          {sampling.lastSampleAt === null ? null : (
            <>
              {t('wave9.statements.sampling.last')}{' '}
              <ObservedTime observedAt={sampling.lastSampleAt} />
            </>
          )}
        </p>
      ) : (
        <Admonition
          type="warning"
          title={t(SAMPLING_KEYS[problem].title)}
          description={
            <>
              {t(SAMPLING_KEYS[problem].body)}
              {sampling.lastErrorCode === null
                ? null
                : ` ${t('wave9.statements.sampling.lastError', { code: sampling.lastErrorCode })}`}
            </>
          }
        />
      )}
      {sampling.resets.length === 0 && sampling.gaps.length === 0 ? null : (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-xs text-foreground-light">
          {sampling.resets.map((reset) => (
            <li key={`reset-${reset.at}-${reset.kind}`} data-reset={reset.kind}>
              {t(RESET_KEYS[reset.kind])} <ObservedTime observedAt={reset.at} withDate />.{' '}
              {t('wave9.statements.reset.note')}
            </li>
          ))}
          {sampling.gaps.map((gap) => (
            <li key={`gap-${gap.from}`} data-gap="">
              {t('wave9.statements.gap')} <ObservedTime observedAt={gap.from} withDate /> –{' '}
              <ObservedTime observedAt={gap.to} withDate />.
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatementsTable({ stats }: { readonly stats: QueryStats }): ReactNode {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.statements.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.statements.column.statement')}</TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.statements.column.calls')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.statements.column.total')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.statements.column.mean')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.statements.column.rows')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('wave9.statements.column.blocks')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.statements.map((statement) => (
            <TableRow key={statement.digest} data-statement={statement.digest}>
              <TableCell className="max-w-xl align-top">
                <div className="flex flex-col gap-1">
                  {statement.textRedacted === true ? (
                    <p className="m-0 text-xs text-foreground-light" data-redacted="">
                      <Badge>{t('wave9.statements.redacted')}</Badge>{' '}
                      {t('wave9.statements.redacted.note')}
                    </p>
                  ) : null}
                  <UntrustedText
                    text={statement.normalizedText}
                    mono
                    maxLines={3}
                    maxCodePoints={400}
                    label={t('wave9.statements.column.statement')}
                  />
                  {statement.database === undefined && statement.role === undefined ? null : (
                    <p className="m-0 text-xs text-foreground-light">
                      {statement.database === undefined ? null : (
                        <>
                          {t('wave9.statements.database')}{' '}
                          <UntrustedName name={statement.database} mono />{' '}
                        </>
                      )}
                      {statement.role === undefined ? null : (
                        <>
                          {t('wave9.statements.role')} <UntrustedName name={statement.role} mono />
                        </>
                      )}
                    </p>
                  )}
                  {statement.regression === undefined ? null : (
                    <RegressionNote regression={statement.regression} />
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">
                {formatCount(statement.calls)}
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">
                {formatMs(statement.totalTimeMs)}
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">
                {formatMs(statement.meanTimeMs)}
              </TableCell>
              <TableCell className="text-right align-top tabular-nums">
                {formatCount(statement.rows)}
              </TableCell>
              <TableCell className="text-right align-top text-xs tabular-nums">
                <div>
                  {t('wave9.statements.hit', { count: formatCount(statement.sharedBlocksHit) })}
                </div>
                <div>
                  {t('wave9.statements.read', { count: formatCount(statement.sharedBlocksRead) })}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RegressionNote({ regression }: { readonly regression: Regression }): ReactNode {
  if (regression.state === 'none') return null
  if (regression.state === 'insufficient_data') {
    return (
      <p className="m-0 text-xs text-foreground-light" data-regression="insufficient_data">
        {t('wave9.regression.insufficient', { calls: regression.minCalls })}
      </p>
    )
  }
  const migrations = regression.migrationsBetween
  return (
    <div className="flex flex-col gap-1 text-xs" data-regression="regressed">
      <span>
        <Badge variant="warning">
          {regression.factor === null
            ? t('wave9.regression.badgeUnknown')
            : t('wave9.regression.badge', { factor: formatFactor(regression.factor) })}
        </Badge>
      </span>
      {regression.meanTimeMs24h === null || regression.meanTimeMs7d === null ? null : (
        <span className="text-foreground-light">
          {t('wave9.regression.means', {
            recent: formatMs(regression.meanTimeMs24h),
            baseline: formatMs(regression.meanTimeMs7d),
            threshold: formatFactor(regression.thresholdFactor),
          })}
        </span>
      )}
      {migrations === null ? (
        <span className="text-foreground-light">{t('wave9.regression.migrationsUnknown')}</span>
      ) : migrations > 0 ? (
        <span className="text-foreground-light" data-coincidence={String(migrations)}>
          {t('wave9.regression.coincidence', { count: migrations })}
        </span>
      ) : (
        <span className="text-foreground-light">{t('wave9.regression.noMigrations')}</span>
      )}
    </div>
  )
}

// ----- tables and indexes -----

const SCHEMA_NAME = /^[^\s]{1,63}$/u

function TablesSection(): ReactNode {
  const { client } = useApi()
  const path = useTargetScope().target.path
  const href = useTargetHref()
  const Link = useLinkComponent()
  const id = useId()
  const [draft, setDraft] = useState('')
  const [schema, setSchema] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const query = useQuery(tableStatsQuery(client, path, schema))
  const readable = toReadable(query, {
    staleAfterMs: 2 * STATS_POLL_MS,
    missing: (value) => (value.truncated ? [t('wave9.tables.truncated')] : undefined),
  })
  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '') {
      setProblem(undefined)
      setSchema(undefined)
      return
    }
    if (!SCHEMA_NAME.test(text)) {
      setProblem(t('wave9.tables.schema.invalid'))
      return
    }
    setProblem(undefined)
    setSchema(text)
  }
  const value = readableValue(readable)
  return (
    <section aria-labelledby="tables-title" className="flex flex-col gap-4">
      <h2 id="tables-title" className="m-0 text-base font-medium">
        {t('wave9.tables.title')}
      </h2>
      <p className="m-0 text-sm text-foreground-light">{t('wave9.tables.description')}</p>
      <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={apply}>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-schema`}>{t('wave9.tables.schema')}</Label>
          <Input
            id={`${id}-schema`}
            size="small"
            className="w-56 font-mono"
            autoComplete="off"
            spellCheck={false}
            maxLength={63}
            placeholder={t('wave9.tables.schema.all')}
            value={draft}
            aria-invalid={problem !== undefined}
            aria-describedby={problem === undefined ? undefined : `${id}-schema-error`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" size="tiny" variant="default">
          {t('wave9.tables.schema.apply')}
        </Button>
        {problem === undefined ? null : (
          <p id={`${id}-schema-error`} className="m-0 text-xs text-destructive" role="alert">
            {problem}
          </p>
        )}
      </form>
      <LiveReadView
        readable={readable}
        what={nounPhrase('wave9.tables.what')}
        onRetry={() => void query.refetch()}
        busy={query.isFetching}
        isEmpty={(stats: TableStats) => stats.tables.length === 0 && stats.indexes.length === 0}
        empty={
          <p className="m-0 text-sm text-foreground-light" data-empty="tables">
            {schema === undefined
              ? t('wave9.tables.empty')
              : t('wave9.tables.emptySchema', { schema })}
          </p>
        }
        ready={(stats) => <TablesView stats={stats} />}
      />
      {value === undefined ? null : (
        <p className="m-0 text-xs text-foreground-light">
          {t('wave9.tables.advisorsHint')}{' '}
          <Link href={href('/advisors')} className="text-primary underline focus-ring">
            {t('wave9.tables.advisorsLink')}
          </Link>
        </p>
      )}
    </section>
  )
}

function TablesView({ stats }: { readonly stats: TableStats }): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <Observation source={stats.source} observedAt={stats.observedAt} />
      <p className="m-0 text-xs text-foreground-light" data-slot="stats-since">
        {stats.statsSince == null ? (
          t('wave9.tables.statsSince.unknown')
        ) : (
          <>
            {t('wave9.tables.statsSince')} <ObservedTime observedAt={stats.statsSince} withDate />.
          </>
        )}
      </p>
      {stats.tables.length === 0 ? null : <TableList stats={stats} />}
      {stats.indexes.length === 0 ? null : (
        <IndexList indexes={stats.indexes} statsSince={stats.statsSince ?? null} />
      )}
    </div>
  )
}

function TableList({ stats }: { readonly stats: TableStats }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-sm font-medium">{t('wave9.tables.tables')}</h3>
      <div className="min-w-0 overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{t('wave9.tables.tables')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('wave9.tables.column.table')}</TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.size')}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.scans')}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.tuples')}
              </TableHead>
              <TableHead scope="col">{t('wave9.tables.column.maintenance')}</TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.bloat')}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.xid')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.tables.map((table) => (
              <TableRow key={`${table.schema}.${table.name}`} data-table="">
                <TableCell className="align-top">
                  <UntrustedName name={table.schema} mono />
                  <span className="text-foreground-lighter">.</span>
                  <UntrustedName name={table.name} mono />
                </TableCell>
                <TableCell className="text-right align-top text-xs tabular-nums">
                  <div>{formatBytes(table.sizeBytes)}</div>
                  <div className="text-foreground-light">
                    {t('wave9.tables.indexSize', { size: formatBytes(table.indexSizeBytes) })}
                  </div>
                </TableCell>
                <TableCell className="text-right align-top text-xs tabular-nums">
                  <div>{t('wave9.tables.seq', { count: formatCount(table.sequentialScans) })}</div>
                  <div>{t('wave9.tables.idx', { count: formatCount(table.indexScans) })}</div>
                </TableCell>
                <TableCell className="text-right align-top text-xs tabular-nums">
                  <div>{t('wave9.tables.live', { count: formatCount(table.liveTuples) })}</div>
                  <div>{t('wave9.tables.dead', { count: formatCount(table.deadTuples) })}</div>
                </TableCell>
                <TableCell className="align-top text-xs">
                  <Maintained
                    label={t('wave9.tables.vacuum')}
                    at={latest(table.lastVacuumAt, table.lastAutovacuumAt)}
                  />
                  <Maintained
                    label={t('wave9.tables.analyze')}
                    at={latest(table.lastAnalyzeAt, table.lastAutoanalyzeAt)}
                  />
                </TableCell>
                <TableCell className="text-right align-top text-xs tabular-nums" data-bloat="">
                  {table.bloatEstimateBytes === null ? (
                    <Missing>{t('wave9.tables.bloat.none')}</Missing>
                  ) : (
                    <>
                      <div>
                        {t('wave9.tables.bloat.value', {
                          size: formatBytes(table.bloatEstimateBytes),
                        })}
                      </div>
                      <div className="text-foreground-light">
                        {t('wave9.tables.bloat.estimate')}
                      </div>
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {formatCount(table.xidAge)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {stats.estimateMethod === undefined ? null : (
        <p className="m-0 text-xs text-foreground-light">{t('wave9.tables.bloat.method')}</p>
      )}
    </div>
  )
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

function Maintained({
  label,
  at,
}: {
  readonly label: string
  readonly at: string | null
}): ReactNode {
  return (
    <div>
      {label}:{' '}
      {at === null ? (
        <Missing>{t('wave9.tables.never')}</Missing>
      ) : (
        <ObservedTime observedAt={at} />
      )}
    </div>
  )
}

function IndexList({
  indexes,
  statsSince,
}: {
  readonly indexes: readonly IndexStat[]
  readonly statsSince: string | null
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-sm font-medium">{t('wave9.tables.indexes')}</h3>
      <div className="min-w-0 overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{t('wave9.tables.indexes')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('wave9.tables.column.index')}</TableHead>
              <TableHead scope="col">{t('wave9.tables.column.table')}</TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.size')}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t('wave9.tables.column.indexScans')}
              </TableHead>
              <TableHead scope="col">{t('wave9.tables.column.markers')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {indexes.map((index) => (
              <TableRow key={`${index.schema}.${index.name}`} data-index="">
                <TableCell className="align-top">
                  <UntrustedName name={index.name} mono />
                </TableCell>
                <TableCell className="align-top">
                  <UntrustedName name={index.schema} mono />
                  <span className="text-foreground-lighter">.</span>
                  <UntrustedName name={index.table} mono />
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {formatBytes(index.sizeBytes)}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {formatCount(index.scans)}
                </TableCell>
                <TableCell className="align-top">
                  <IndexMarkers index={index} statsSince={statsSince} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function IndexMarkers({
  index,
  statsSince,
}: {
  readonly index: IndexStat
  readonly statsSince: string | null
}): ReactNode {
  const markers: ReactNode[] = []
  if (!index.valid) {
    markers.push(
      <div key="invalid" data-marker="invalid">
        <Badge variant="destructive">{t('wave9.tables.marker.invalid')}</Badge>
      </div>,
    )
  }
  if (index.duplicateOf !== null) {
    markers.push(
      <div key="duplicate" data-marker="duplicate" className="text-xs">
        <Badge variant="warning">{t('wave9.tables.marker.duplicate')}</Badge>{' '}
        <UntrustedName name={index.duplicateOf} mono />
      </div>,
    )
  }
  if (isUnusedIndex(index)) {
    markers.push(
      <div key="unused" data-marker="unused" className="text-xs">
        <Badge variant="warning">{t('wave9.tables.marker.unused')}</Badge>{' '}
        {statsSince === null ? (
          <span className="text-foreground-light">{t('wave9.tables.marker.unusedUndated')}</span>
        ) : (
          <span className="text-foreground-light">
            {t('wave9.tables.marker.unusedSince')} <ObservedTime observedAt={statsSince} withDate />
          </span>
        )}
      </div>,
    )
  }
  if (index.primary === true) {
    markers.push(
      <div key="primary" className="text-xs text-foreground-light">
        {t('wave9.tables.marker.primary')}
      </div>,
    )
  } else if (index.unique === true) {
    markers.push(
      <div key="unique" className="text-xs text-foreground-light">
        {t('wave9.tables.marker.unique')}
      </div>,
    )
  }
  if (markers.length === 0) return <Missing>{t('wave9.tables.marker.none')}</Missing>
  return <div className="flex flex-col gap-1">{markers}</div>
}
