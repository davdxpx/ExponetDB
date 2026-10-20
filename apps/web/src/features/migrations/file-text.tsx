import { Button, cn, copyToClipboard, toast } from '@exponetdb/ui'
import {
  describeMarks,
  formatCount,
  type HeadingLevel,
  renderLine,
  StateHeading,
  segmentLine,
  splitLines,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { shownText } from './bundle-model.ts'

/** Lines shown before "Show more lines", and how many one press adds. */
export const FILE_LINES_SHOWN = 200
const MORE_LINES = 500

export interface NumberedFileProps {
  /** `up.sql`, `verify.sql` or `down.sql`. */
  readonly file: string
  readonly migrationId: string
  readonly revision: number
  /** Untrusted: the stored text exactly as the server sent it. */
  readonly text: string
  /** The size of the stored file, as the server reports it. */
  readonly bytes: number
  /** A note under the heading, such as "Never runs automatically" for `down.sql`. */
  readonly note?: string
  readonly headingLevel: HeadingLevel
}

/**
 * One stored file of a bundle as numbered text (the plan review's rules,
 * ADR-0029 §4): every line through `renderLine`, so control, direction, tag
 * and invisible characters are shown by their code point and never act,
 * other non-ASCII characters are marked, the line is isolated and laid out
 * left to right; never markup, never a link. Long files are collapsed with
 * the count of the lines not shown and a control to show them; a text
 * longer than the page renders says so. The copy button copies the text
 * exactly as received.
 */
export function NumberedFile({
  file,
  migrationId,
  revision,
  text,
  bytes,
  note,
  headingLevel,
}: NumberedFileProps): ReactNode {
  const shown = useMemo(() => shownText(text), [text])
  const lines = useMemo(() => splitLines(shown.text), [shown.text])
  const [visible, setVisible] = useState(FILE_LINES_SHOWN)
  const count = Math.min(lines.length, visible)
  const remaining = lines.length - count
  const marks = useMemo(() => {
    let hidden = 0
    let nonAscii = 0
    for (const line of lines) {
      for (const segment of segmentLine(line).segments) {
        if (segment.kind === 'hidden') hidden += 1
        else if (segment.kind === 'non-ascii') nonAscii += 1
      }
    }
    return describeMarks(hidden, nonAscii)
  }, [lines])
  const rows = useMemo(
    () =>
      lines.slice(0, count).map((line, i) => ({
        number: i + 1,
        nodes: renderLine(line, `l${i + 1}`).nodes,
      })),
    [lines, count],
  )
  const label = t('bundle.file.label', { file, migration: migrationId })
  const copy = async (): Promise<void> => {
    const done = await copyToClipboard(text)
    if (done) toast.success(t('bundle.file.copied', { file }))
    else toast.error(t('bundle.file.copyFailed'))
  }

  return (
    <section data-bundle-file={file} className="flex min-w-0 flex-col gap-2">
      <StateHeading level={headingLevel} className="m-0 text-sm font-medium">
        <span className="font-mono">{file}</span>{' '}
        <span className="font-normal text-foreground-light">
          {t('bundle.file.facts', {
            revision: formatCount(revision),
            bytes: formatCount(bytes),
            lines: formatCount(lines.length),
          })}
        </span>
      </StateHeading>
      {note === undefined ? null : (
        <p data-file-note={file} className="m-0 text-sm font-medium">
          {note}
        </p>
      )}
      {marks === undefined ? null : (
        <p role="note" className="m-0 text-xs text-foreground-light">
          {t('bundle.file.marks', { marks })}
        </p>
      )}
      <div
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be reachable by keyboard
        tabIndex={0}
        className="max-h-[60svh] max-w-full overflow-auto rounded-md border border-default focus-inset"
      >
        <table className="w-full border-collapse font-mono text-xs" data-file-text={file}>
          <caption className="sr-only">{t('bundle.file.caption', { label })}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">{t('bundle.file.line')}</th>
              <th scope="col">{t('bundle.file.text')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.number} data-line={row.number} className="align-top">
                <td className="w-0 border-r border-default px-2 py-px text-right whitespace-nowrap text-foreground-lighter select-none">
                  {row.number}
                </td>
                <td
                  dir="ltr"
                  className="px-2 py-px break-all whitespace-break-spaces text-foreground [unicode-bidi:isolate-override] [&_[data-segment]]:[unicode-bidi:isolate]"
                >
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
          <p className="m-0 font-medium">
            {t('bundle.file.collapsed', {
              count: formatCount(remaining),
              from: formatCount(count + 1),
              to: formatCount(lines.length),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="tiny"
              variant="default"
              aria-label={t('bundle.file.moreLabel', { label })}
              onClick={() => setVisible(Math.min(lines.length, count + MORE_LINES))}
            >
              {t('bundle.file.more')}
            </Button>
            <Button
              type="button"
              size="tiny"
              variant="default"
              aria-label={t('bundle.file.allLabel', { label })}
              onClick={() => setVisible(lines.length)}
            >
              {t('bundle.file.all', { count: formatCount(lines.length) })}
            </Button>
          </div>
        </div>
      ) : null}
      {shown.truncated ? (
        <p role="note" className={cn('m-0 text-sm font-medium text-warning-600')}>
          {t('bundle.file.truncated', {
            shown: formatCount(shown.text.length),
            total: formatCount(text.length),
            migration: migrationId,
          })}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          size="tiny"
          variant="outline"
          aria-label={t('bundle.file.copyLabel', { label })}
          onClick={() => void copy()}
        >
          {t('bundle.file.copy', { file })}
        </Button>
      </div>
    </section>
  )
}
