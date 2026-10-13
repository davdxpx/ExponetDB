import type { TargetHealthHistory } from '@exponetdb/sdk/operations'
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
import {
  type BreakdownSegment,
  ObservedTime,
  ReadableView,
  StackedBreakdown,
  TimeSeriesChart,
  type TimeSeriesSeries,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { Block, HealthStateChip } from './block.tsx'
import {
  gapCauseKey,
  gapReasonKey,
  historyBreakdown,
  historyPoints,
  SERIES_KEYS,
  seriesLabelKey,
  worstOf,
} from './health-model.ts'
import { HISTORY_RANGES, type HistoryRange } from './keys.ts'
import { type BlockRead, type HealthHistory, useHealthHistory } from './queries.ts'

const HEADING = 3

const RANGE_LABEL = {
  '24h': 'overview.history.range.24h',
  '7d': 'overview.history.range.7d',
  '14d': 'overview.history.range.14d',
} as const

/** Words for one gap: its cause and, when the server derived one, the reason. */
export function gapWords(gap: TargetHealthHistory['gaps'][number]): string {
  const cause = t(gapCauseKey(gap.cause))
  return gap.reason === null ? cause : `${cause} (${t(gapReasonKey(gap.reason)).toLowerCase()})`
}

const SERIES: readonly TimeSeriesSeries[] = SERIES_KEYS.map((key) => ({
  key,
  label: t(seriesLabelKey(key)),
}))

const SEGMENTS: readonly BreakdownSegment[] = SERIES_KEYS.map((key) => ({
  key,
  label: t(seriesLabelKey(key)),
}))

/**
 * The health history: buckets with their worst state and counts as a chart, a
 * gap drawn as a break (never interpolated) with its cause, the same data as a
 * table (the chart's own data-table alternative) and a list of the gaps.
 */
export function HistoryBlock(props: { readonly path: string }): ReactNode {
  const [range, setRange] = useState<HistoryRange>('24h')
  const read = useHealthHistory(props.path, range, (value) =>
    value.gapsTruncated
      ? [t('overview.history.gaps.truncated', { count: value.gaps.length })]
      : undefined,
  )
  return (
    <Block
      id="history"
      title={t('overview.history.title')}
      description={t('overview.history.description')}
    >
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{t('overview.history.range')}</legend>
        {HISTORY_RANGES.map((value) => (
          <Button
            key={value}
            type="button"
            size="tiny"
            variant={range === value ? 'default' : 'outline'}
            aria-pressed={range === value}
            onClick={() => setRange(value)}
          >
            {t(RANGE_LABEL[value])}
          </Button>
        ))}
      </fieldset>
      <HistoryView read={read} />
    </Block>
  )
}

export function HistoryView(props: { readonly read: BlockRead<HealthHistory> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('overview.history.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      empty={{
        isEmpty: (value) => value.buckets.length === 0 && value.gaps.length === 0,
        content: <NoSamples />,
      }}
      ready={(value) => <HistoryBody history={value} />}
    />
  )
}

function NoSamples(): ReactNode {
  return (
    <div data-slot="no-samples" className="flex flex-col gap-1 text-sm">
      <p className="font-medium">{t('overview.history.chart.empty')}</p>
      <p>{t('overview.history.chart.emptyDescription')}</p>
      <p className="text-foreground-light">{t('overview.history.noFirstSample')}</p>
    </div>
  )
}

function HistoryBody({ history }: { readonly history: TargetHealthHistory }): ReactNode {
  const points = useMemo(() => historyPoints(history, gapWords), [history])
  const bars = useMemo(
    () => historyBreakdown(history, t('overview.history.breakdown.bar')),
    [history],
  )
  const worst = worstOf(history)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {worst === null ? null : (
          <>
            <span>{t('overview.history.worst')}</span>
            <HealthStateChip state={worst} />
          </>
        )}
        <span className="text-foreground-light">
          {t('overview.history.bucket', { seconds: history.bucketSeconds })}
        </span>
      </div>
      <TimeSeriesChart
        name={nounPhrase('overview.history.chart.name')}
        data={{
          state: 'ready',
          value: points,
          source: 'sampled',
          observedAt: history.observedAt,
        }}
        series={SERIES}
        variant="line"
        emptyTitle={t('overview.history.chart.empty')}
        emptyDescription={t('overview.history.chart.emptyDescription')}
      />
      <StackedBreakdown
        name={nounPhrase('overview.history.breakdown.name')}
        data={{
          state: 'ready',
          value: bars,
          source: 'sampled',
          observedAt: history.observedAt,
        }}
        segments={SEGMENTS}
        height={120}
      />
      {history.firstSampleAt === null ? (
        <p className="text-sm text-foreground-light">{t('overview.history.noFirstSample')}</p>
      ) : (
        <p className="text-sm text-foreground-light">
          {t('overview.history.firstSample')}{' '}
          <ObservedTime observedAt={history.firstSampleAt} withDate />.{' '}
          {t('overview.history.firstSampleNote')}
        </p>
      )}
      <GapList history={history} />
    </div>
  )
}

function GapList({ history }: { readonly history: TargetHealthHistory }): ReactNode {
  if (history.gaps.length === 0) {
    return (
      <p className="text-sm" data-slot="no-gaps">
        {t('overview.history.gaps.none', { seconds: history.gapThresholdSeconds })}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2" data-slot="gaps">
      <h4 className="text-sm font-medium">{t('overview.history.gaps.title')}</h4>
      <Table>
        <TableCaption className="sr-only">{t('overview.history.gaps.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('overview.history.gaps.column.from')}</TableHead>
            <TableHead scope="col">{t('overview.history.gaps.column.to')}</TableHead>
            <TableHead scope="col">{t('overview.history.gaps.column.duration')}</TableHead>
            <TableHead scope="col">{t('overview.history.gaps.column.cause')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.gaps.map((gap) => (
            <TableRow key={`${gap.from}-${gap.to}`}>
              <TableCell>
                <ObservedTime observedAt={gap.from} withDate />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={gap.to} withDate />
              </TableCell>
              <TableCell>{duration(gap.durationSeconds)}</TableCell>
              <TableCell>
                {/* The cause words are the catalog's; a cause the page does not know is shown as marked text. */}
                {t(gapCauseKey(gap.cause))}
                {gap.reason === null ? null : <> ({t(gapReasonKey(gap.reason)).toLowerCase()})</>}
                {isKnownCause(gap.cause) ? null : (
                  <>
                    {' '}
                    <UntrustedName
                      name={gap.cause}
                      mono
                      label={t('overview.history.gaps.column.cause')}
                    />
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {history.gapsTruncated ? (
        <p className="text-sm" data-slot="gaps-truncated">
          {t('overview.history.gaps.truncated', { count: history.gaps.length })}
        </p>
      ) : null}
    </div>
  )
}

function isKnownCause(cause: string): boolean {
  return cause === 'control_plane_down' || cause === 'sampler_lagging' || cause === 'unknown'
}

function duration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}
