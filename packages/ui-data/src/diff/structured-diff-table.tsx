import {
  Button,
  cn,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  type HeadingLevel,
  type NowInput,
  type Readable,
  ReadableView,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useMemo, useState } from 'react'

import { ChangeMarker } from './change-marker.tsx'
import { ReadEmpty } from './read-empty.tsx'
import {
  classifyDiffRow,
  countDiffRows,
  type StructuredDiffCounts,
  type StructuredDiffKind,
  type StructuredDiffRow,
} from './structured-diff.ts'
import { uniqueKeys } from './unique-keys.ts'

export interface StructuredDiffTableProps {
  /** The rows to compare, as a read: a failed read is never drawn as "no differences". */
  rows: Readable<readonly StructuredDiffRow[]>
  /** What is shown, as a noun phrase that works after "no". Default "settings and grants". */
  what?: string
  /** The header of the key column. Default "Setting". */
  keyLabel?: string
  /** The header of the value before. Default "Before". */
  beforeLabel?: string
  /** The header of the value after. Default "After". */
  afterLabel?: string
  /** How a value that is absent is worded: "not set", "not granted". Default "not set". */
  absentLabel?: string
  /** The caption of the table for assistive technology. Default `Changes in ${what}`. */
  caption?: string
  onRetry?: () => void
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

const ROW_CLASS: Readonly<Record<StructuredDiffKind, string>> = {
  added: 'bg-success-200/20',
  removed: 'bg-destructive-200/20',
  changed: 'bg-warning-200/20',
  unchanged: '',
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** "1 added, 2 changed, 1 removed; 5 unchanged", only the parts that are not zero. */
function summarize(counts: StructuredDiffCounts, partial: boolean): string {
  const parts: string[] = []
  if (counts.added > 0) parts.push(`${counts.added.toLocaleString('en-US')} added`)
  if (counts.changed > 0) parts.push(`${counts.changed.toLocaleString('en-US')} changed`)
  if (counts.removed > 0) parts.push(`${counts.removed.toLocaleString('en-US')} removed`)
  const differences = parts.join(', ')
  if (differences === '') {
    // A partial read cannot say that nothing differs: only that nothing differs in what was read.
    if (partial) return 'No differences in the rows that were read.'
    return counts.unchanged === 0
      ? 'There are no rows.'
      : `No differences: all ${plural(counts.unchanged, 'row is', 'rows are')} the same.`
  }
  return counts.unchanged === 0
    ? `${differences}.`
    : `${differences}; ${counts.unchanged.toLocaleString('en-US')} unchanged.`
}

interface DiffValueProps {
  readonly value: string | null
  readonly absentLabel: string
  readonly label: string
}

function DiffValue({ value, absentLabel, label }: DiffValueProps): ReactNode {
  if (value === null) return <span className="italic text-foreground-muted">{absentLabel}</span>
  return <UntrustedText text={value} mono maxLines={6} maxCodePoints={400} label={label} />
}

interface BodyProps {
  readonly rows: readonly StructuredDiffRow[]
  readonly keyLabel: string
  readonly beforeLabel: string
  readonly afterLabel: string
  readonly absentLabel: string
  readonly caption: string
  readonly partial: boolean
}

function DiffBody({
  rows,
  keyLabel,
  beforeLabel,
  afterLabel,
  absentLabel,
  caption,
  partial,
}: BodyProps): ReactNode {
  const tableId = useId()
  const [showUnchanged, setShowUnchanged] = useState(false)
  const classified = useMemo(
    () =>
      uniqueKeys(rows, (row) => row.key).map(({ key, item }) => ({
        key,
        row: item,
        kind: classifyDiffRow(item),
      })),
    [rows],
  )
  const counts = useMemo(() => countDiffRows(rows), [rows])
  const visible = showUnchanged
    ? classified
    : classified.filter((entry) => entry.kind !== 'unchanged')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm text-foreground-light">{summarize(counts, partial)}</p>
        {counts.unchanged > 0 && (
          <Button
            type="button"
            size="tiny"
            variant="outline"
            aria-expanded={showUnchanged}
            aria-controls={tableId}
            onClick={() => setShowUnchanged((shown) => !shown)}
          >
            {`${showUnchanged ? 'Hide' : 'Show'} ${plural(counts.unchanged, 'unchanged row', 'unchanged rows')}`}
          </Button>
        )}
      </div>
      {visible.length > 0 && (
        <Table id={tableId}>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Change</TableHead>
              <TableHead scope="col">{keyLabel}</TableHead>
              <TableHead scope="col">{beforeLabel}</TableHead>
              <TableHead scope="col">{afterLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(({ key, row, kind }) => (
              <TableRow key={key} data-change={kind} className={cn('align-top', ROW_CLASS[kind])}>
                <TableCell className="px-4 py-2">
                  <ChangeMarker change={kind} />
                </TableCell>
                <TableCell className="px-4 py-2 text-sm">
                  <UntrustedName name={row.key} mono label={keyLabel.toLowerCase()} />
                </TableCell>
                <TableCell className="px-4 py-2 text-sm">
                  <DiffValue
                    value={row.before}
                    absentLabel={absentLabel}
                    label={beforeLabel.toLowerCase()}
                  />
                </TableCell>
                <TableCell className="px-4 py-2 text-sm">
                  <DiffValue
                    value={row.after}
                    absentLabel={absentLabel}
                    label={afterLabel.toLowerCase()}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/**
 * A before/after table for settings and grants (design-system.md §3): each row
 * is marked added, removed or changed with an icon and a word, and unchanged
 * rows are folded behind a button that says how many there are. Keys and
 * values are untrusted text, cut with "Show all"; an absent value ("not set")
 * is told apart from an empty one. The rows are a `Readable`, so a failed read
 * is a failed read and never "no differences".
 */
export function StructuredDiffTable({
  rows,
  what = 'settings and grants',
  keyLabel = 'Setting',
  beforeLabel = 'Before',
  afterLabel = 'After',
  absentLabel = 'not set',
  caption,
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel,
  className,
}: StructuredDiffTableProps): ReactNode {
  return (
    <div className={className}>
      <ReadableView
        readable={rows}
        what={what}
        onRetry={onRetry}
        onRefresh={onRefresh}
        busy={busy}
        now={now}
        headingLevel={headingLevel}
        ready={(value, meta) =>
          value.length === 0 ? (
            <ReadEmpty
              title="Nothing to compare"
              noun={what}
              meta={meta}
              headingLevel={headingLevel}
            />
          ) : (
            <DiffBody
              rows={value}
              keyLabel={keyLabel}
              beforeLabel={beforeLabel}
              afterLabel={afterLabel}
              absentLabel={absentLabel}
              caption={caption ?? `Changes in ${what}`}
              partial={meta.state === 'partial'}
            />
          )
        }
      />
    </div>
  )
}
