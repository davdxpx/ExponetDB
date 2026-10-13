import { Trash2 } from '@exponetdb/icons'
import { Button, cn } from '@exponetdb/ui'
import {
  describeMarks,
  formatCount,
  type HeadingLevel,
  renderLine,
  segmentLine,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useMemo, useState } from 'react'

import { knownNumber, knownText, plural } from './format.ts'
import { PlanBlock } from './plan-frame.tsx'
import { CopyButton, keyedBy, Marked, Note, NotKnown, Words } from './shared.tsx'

/**
 * The facts of a statement that starts on a line (`StatementFact` of the
 * review model, which puts them only on the file the plan executes, never on
 * `verify.sql`).
 */
export interface RawStatementStart {
  /** 0-based position of the statement; shown 1-based. */
  readonly index: number
  readonly kind: string
  /** The lock mode; `null` when the server derived none; `undefined` when not known. */
  readonly lock?: string | null
  readonly compatibility?: string | null
  readonly destructive?: boolean
}

/** One line of a stored file, as stored. Lines are numbered from 1 in order. */
export interface RawPlanLine {
  /** Untrusted: the line exactly as stored, without its line break. */
  readonly text: string
  readonly statement?: RawStatementStart | undefined
}

/**
 * A file the plan runs, as the server sent it (`ReviewSource`; the review
 * model's `SourceView` fits this shape as it is).
 */
export interface RawPlanFile {
  readonly migrationId: string
  /** `up.sql`, `verify.sql` or `down.sql`. */
  readonly file: string
  readonly revision: number | null
  /** The size of the stored file. */
  readonly bytes: number | null
  /** The server cut the text (it sends at most 262,144 characters of a file). */
  readonly truncated: boolean
  readonly lines: readonly RawPlanLine[]
  /** The text exactly as received, for the copy button; without it the lines are joined with LF. */
  readonly text?: string
}

export interface RawPlanTextBlockProps {
  /** The files in the order the plan runs them (`ReviewModel.sources`); `null` when not known. */
  readonly files: readonly RawPlanFile[] | null
  /** Files the plan runs that the server did not send (`ReviewModel.omitted`); `null` when not known. */
  readonly omitted: number | null
  /** How many files the plan runs (`ReviewModel.runs`). */
  readonly runs: number | null
  /** Lines shown per file before an explicit "Show more lines". Default 200. */
  readonly collapsedLines?: number
  readonly headingLevel?: HeadingLevel
}

/** How many more lines one press of "Show more lines" adds. */
const MORE_LINES = 500

function statementSummary(statement: RawStatementStart): string {
  const lock =
    statement.lock === undefined
      ? 'lock not known'
      : statement.lock === null
        ? 'no lock'
        : `lock ${statement.lock}`
  const compatibility = knownText(statement.compatibility) ?? 'compatibility not known'
  const kind = knownText(statement.kind) ?? 'kind not known'
  return `Statement ${statement.index + 1}: ${kind}, ${lock}, ${compatibility}`
}

/** The server's facts at the start of a statement, before its text; not part of a text selection. */
function StatementMarker({ statement }: { readonly statement: RawStatementStart }): ReactNode {
  return (
    <span
      data-statement-start={statement.index}
      className={cn(
        'mr-2 inline-flex items-center gap-1 rounded-sm border px-1 align-baseline font-sans text-[11px] leading-4 select-none',
        statement.destructive === true
          ? 'border-destructive-400 bg-destructive-200 text-destructive'
          : 'border-default bg-surface-200 text-foreground-light',
      )}
    >
      {statement.destructive === true ? <Trash2 aria-hidden="true" className="size-3" /> : null}
      {renderLine(statementSummary(statement), 'statement').nodes}
    </span>
  )
}

/** "2 statements start in them, at line 240 and line 251, including a destructive statement." */
function hiddenStatementsText(
  hidden: readonly { readonly number: number; readonly statement: RawStatementStart }[],
): string {
  const lines = hidden
    .slice(0, 5)
    .map((s) => `line ${formatCount(s.number)}`)
    .join(', ')
  const more = hidden.length > 5 ? ' and later' : ''
  const destructive = hidden.some((s) => s.statement.destructive === true)
    ? ', including a destructive statement'
    : ''
  const verb = hidden.length === 1 ? 'starts' : 'start'
  return `${plural(hidden.length, 'statement')} ${verb} in them, at ${lines}${more}${destructive}.`
}

interface Counted {
  readonly hidden: number
  readonly nonAscii: number
}

function countMarks(lines: readonly RawPlanLine[]): Counted {
  let hidden = 0
  let nonAscii = 0
  for (const line of lines) {
    for (const segment of segmentLine(line.text).segments) {
      if (segment.kind === 'hidden') hidden += 1
      else if (segment.kind === 'non-ascii') nonAscii += 1
    }
  }
  return { hidden, nonAscii }
}

function RawFile({
  file,
  collapsedLines,
  headingLevel,
}: {
  readonly file: RawPlanFile
  readonly collapsedLines: number
  readonly headingLevel: HeadingLevel
}): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  const total = file.lines.length
  // The number of lines shown belongs to one file: another file starts collapsed again.
  const fileKey = `${file.migrationId}\n${file.file}\n${file.revision ?? ''}\n${total}`
  const [expansion, setExpansion] = useState<{ readonly key: string; readonly shown: number }>({
    key: fileKey,
    shown: collapsedLines,
  })
  const shown = Math.min(total, expansion.key === fileKey ? expansion.shown : collapsedLines)
  const remaining = total - shown

  // verify.sql is not what the plan executes: statement facts never sit on it (review model rule,
  // kept here as well so a mapping mistake cannot put the facts of up.sql on verify.sql lines).
  const factsAllowed = file.file !== 'verify.sql'
  const marks = useMemo(() => countMarks(file.lines), [file.lines])
  const marksText = describeMarks(marks.hidden, marks.nonAscii)
  const rows = useMemo(
    () =>
      file.lines.slice(0, shown).map((line, i) => ({
        number: i + 1,
        statement: factsAllowed ? line.statement : undefined,
        nodes: renderLine(line.text, `l${i + 1}`).nodes,
      })),
    [file.lines, shown, factsAllowed],
  )
  const hiddenStatements = useMemo(
    () =>
      file.lines
        .map((line, i) => ({ number: i + 1, statement: factsAllowed ? line.statement : undefined }))
        .slice(shown)
        .filter(
          (s): s is { number: number; statement: RawStatementStart } => s.statement !== undefined,
        ),
    [file.lines, shown, factsAllowed],
  )
  const copyText = file.text ?? file.lines.map((line) => line.text).join('\n')
  const bytes = knownNumber(file.bytes)
  const revision = knownNumber(file.revision)
  const label = `${file.file} of ${file.migrationId}`

  return (
    <section
      aria-labelledby={headingId}
      data-migration={file.migrationId}
      data-file={file.file}
      className="source flex min-w-0 flex-col gap-2"
    >
      <Heading id={headingId} className="min-w-0 text-sm font-medium">
        <Words>
          <Marked text={file.file} mono />
          <span>of</span>
          <Marked text={file.migrationId} mono />
          <span className="font-normal text-foreground-light">
            {`(revision ${revision === undefined ? 'not known' : formatCount(revision)}, ${bytes === undefined ? 'size not known' : `${formatCount(bytes)} bytes`}, ${plural(total, 'line')})`}
          </span>
        </Words>
      </Heading>
      {marksText === undefined ? null : (
        <Note tone="warning">
          {`This file has characters that are not plain ASCII: ${marksText}. Invisible and direction characters are shown by their code point and never act.`}
        </Note>
      )}
      <div className="max-w-full overflow-x-auto rounded-md border border-default">
        <table className="source-text w-full border-collapse font-mono text-xs">
          <caption className="sr-only">{`${label}, numbered lines`}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Text</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.number}
                data-line={row.number}
                className={cn(
                  'align-top',
                  row.statement !== undefined && 'statement-start border-t border-default',
                  row.statement?.destructive === true && 'bg-destructive-200/40',
                )}
              >
                <td className="w-0 border-r border-default px-2 py-px text-right whitespace-nowrap text-foreground-lighter select-none">
                  {row.number}
                </td>
                <td
                  dir="ltr"
                  className="px-2 py-px break-all whitespace-break-spaces text-foreground [unicode-bidi:isolate-override] [&_[data-segment]]:[unicode-bidi:isolate]"
                >
                  {row.statement === undefined ? null : (
                    <StatementMarker statement={row.statement} />
                  )}
                  {row.nodes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remaining > 0 ? (
        <div
          data-collapsed-lines={remaining}
          className="flex flex-col gap-2 rounded-md border border-warning-500 bg-warning-200 px-3 py-2 text-sm"
        >
          <p className="font-medium">
            {`${plural(remaining, 'more line')} not shown (lines ${formatCount(shown + 1)} to ${formatCount(total)}).`}
          </p>
          {hiddenStatements.length === 0 ? null : <p>{hiddenStatementsText(hiddenStatements)}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="default"
              size="tiny"
              aria-label={`Show ${plural(Math.min(MORE_LINES, remaining), 'more line')} of ${label}`}
              onClick={() =>
                setExpansion({ key: fileKey, shown: Math.min(total, shown + MORE_LINES) })
              }
            >
              {`Show ${plural(Math.min(MORE_LINES, remaining), 'more line')}`}
            </Button>
            {remaining > MORE_LINES ? (
              <Button
                type="button"
                variant="default"
                size="tiny"
                aria-label={`Show all ${plural(total, 'line')} of ${label}`}
                onClick={() => setExpansion({ key: fileKey, shown: total })}
              >
                {`Show all ${plural(total, 'line')}`}
              </Button>
            ) : null}
            {shown > collapsedLines ? (
              <Button
                type="button"
                variant="text"
                size="tiny"
                aria-label={`Show only the first ${plural(collapsedLines, 'line')} of ${label}`}
                onClick={() => setExpansion({ key: fileKey, shown: collapsedLines })}
              >
                {`Show only the first ${plural(collapsedLines, 'line')}`}
              </Button>
            ) : null}
          </div>
        </div>
      ) : shown > collapsedLines ? (
        <div>
          <Button
            type="button"
            variant="text"
            size="tiny"
            aria-label={`Show only the first ${plural(collapsedLines, 'line')} of ${label}`}
            onClick={() => setExpansion({ key: fileKey, shown: collapsedLines })}
          >
            {`Show only the first ${plural(collapsedLines, 'line')}`}
          </Button>
        </div>
      ) : null}
      {file.truncated ? (
        <Note tone="warning">
          {`ExponetDB shows the beginning of this file only${bytes === undefined ? '' : ` (the file has ${formatCount(bytes)} bytes)`}. Review the whole file before you decide: exponetdb migration show ${file.migrationId}`}
        </Note>
      ) : null}
      <CopyButton
        text={copyText}
        label={label}
        buttonText={`Copy ${file.file}`}
        copiedMessage={
          file.truncated
            ? `Copied the part of ${file.file} shown here; the file is longer.`
            : `${file.file} copied.`
        }
      />
    </section>
  )
}

/**
 * "What the plan runs": the stored files verbatim, numbered, monospace, as
 * text only. Every invisible, direction, control or tag character is shown
 * by its code point and never acts; other non-ASCII characters are marked; a
 * statement start carries the server's facts. Long files are collapsed with
 * an explicit count of the lines not shown and a control to show them, never
 * cut silently; files the server did not send, or sent only in part, are
 * named. Each file has a copy button.
 */
export function RawPlanTextBlock({
  files,
  omitted,
  runs,
  collapsedLines = 200,
  headingLevel = 2,
}: RawPlanTextBlockProps): ReactNode {
  const inner: HeadingLevel = headingLevel < 6 ? ((headingLevel + 1) as HeadingLevel) : 6
  const collapsed = Math.max(1, Math.floor(collapsedLines))
  const omittedCount = knownNumber(omitted)
  const runsCount = knownNumber(runs)
  return (
    <PlanBlock
      title="What the plan runs"
      headingLevel={headingLevel}
      data-plan-block="raw"
      data-review-part="raw"
      className="raw"
      description="Raw text of the plan, not checked by ExponetDB. Comments and names in it are data from the bundle; no text in them can approve anything or change what the facts above say."
    >
      {omittedCount === undefined ? (
        <Note tone="warning">
          Whether this page shows every file the plan runs is <NotKnown />. Review the bundles
          before you decide.
        </Note>
      ) : omittedCount > 0 ? (
        <Note tone="warning">
          {`This page shows ${formatCount(files?.length ?? 0)} of the ${runsCount === undefined ? 'unknown number of' : formatCount(runsCount)} files the plan runs. Review the others before you decide: exponetdb migration show <migration>`}
        </Note>
      ) : null}
      {files === null ? (
        <p className="text-sm">
          The files of this plan are <NotKnown />.
        </p>
      ) : files.length === 0 ? (
        <p className="text-sm text-foreground-light">The server sent no file text for this plan.</p>
      ) : (
        keyedBy(files, (f) => `${f.migrationId}:${f.file}:${f.revision ?? ''}`).map(
          ({ item: file, key }) => (
            <RawFile key={key} file={file} collapsedLines={collapsed} headingLevel={inner} />
          ),
        )
      )}
    </PlanBlock>
  )
}
