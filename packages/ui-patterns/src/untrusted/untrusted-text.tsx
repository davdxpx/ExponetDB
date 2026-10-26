import { Button, cn } from '@exponetdb/ui'
import { Fragment, type HTMLAttributes, type ReactNode, useMemo, useState } from 'react'

import { formatCount } from '../states/format.ts'
import { describeMarks, renderLine } from './render-segments.tsx'
import { codePointCount, EXPANDED_CODE_POINT_LIMIT, truncateText } from './truncate.ts'

/** The default cut, by code points and by lines. */
export const DEFAULT_MAX_CODE_POINTS = 1_000
export const DEFAULT_MAX_LINES = 10

export interface UntrustedTextProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The foreign text: SQL, a comment, a log line, a row value. Shown as text, whatever it contains. */
  text: string
  /** Monospace, for SQL, identifiers and log lines. */
  mono?: boolean
  /** Longest text shown before "Show all", in code points. Default 1,000. */
  maxCodePoints?: number
  /** Most lines shown before "Show all". Default 10. */
  maxLines?: number
  /** Names the content for the "Show all" button of a screen reader ("SQL text", "comment"). */
  label?: string
  /**
   * Default true. False inside a link or another control (a whole-card link): a long text is cut
   * with an ellipsis and offers no "Show all" button, because a button inside a link is invalid and
   * unreachable; the full text is on the page the link opens.
   */
  expandable?: boolean
}

/**
 * Untrusted text as text (C-26, ADR-0029 §4): never HTML, Markdown or a link,
 * line by line through `segmentLine`, so a control, direction, tag or other
 * invisible character is shown by its code point (`⟨U+202E⟩`) in a distinct
 * style with a spoken name, a tab as an arrow and a look-alike letter marked.
 * Long values are cut by code points and lines; the explicit button "Show all
 * (N characters)" shows the rest (up to a hard limit). The text is isolated
 * from the bidirectional context around it and laid out left to right in
 * logical order (`isolate-override`): letters of a right-to-left script are
 * shown where they are stored and cannot carry the digits and punctuation
 * around them elsewhere (a Hebrew letter inside a SQL comment cannot make the
 * `+ 99` after the comment look commented out).
 */
export function UntrustedText({
  text,
  mono = false,
  maxCodePoints = DEFAULT_MAX_CODE_POINTS,
  maxLines = DEFAULT_MAX_LINES,
  label,
  expandable = true,
  className,
  ...rest
}: UntrustedTextProps): ReactNode {
  // Expansion belongs to one text: a different text starts collapsed again.
  const [expandedText, setExpandedText] = useState<string | null>(null)
  const expanded = expandedText === text

  const collapsed = useMemo(
    () => truncateText(text, { maxCodePoints, maxLines }),
    [text, maxCodePoints, maxLines],
  )
  const shown = useMemo(
    () =>
      expanded
        ? truncateText(text, {
            maxCodePoints: EXPANDED_CODE_POINT_LIMIT,
            maxLines: Number.POSITIVE_INFINITY,
          })
        : collapsed,
    [expanded, text, collapsed],
  )
  const total = useMemo(() => codePointCount(text), [text])

  const rendered = useMemo(() => {
    const nodes: ReactNode[] = []
    let hidden = 0
    let nonAscii = 0
    let lineNumber = 0
    for (const line of shown.lines) {
      const view = renderLine(line, `line${lineNumber}`)
      nodes.push(...view.nodes)
      hidden += view.hidden
      nonAscii += view.nonAscii
      lineNumber += 1
      if (lineNumber < shown.lines.length)
        nodes.push(<Fragment key={`break${lineNumber}`}>{'\n'}</Fragment>)
    }
    return { nodes, hidden, nonAscii }
  }, [shown])

  const marks = describeMarks(rendered.hidden, rendered.nonAscii)
  const count = formatCount(total)
  const showAll = `Show all (${count} characters)`

  return (
    <div
      data-untrusted="text"
      className={cn('min-w-0 text-sm text-foreground', className)}
      {...rest}
    >
      <div
        dir="ltr"
        className={cn(
          'whitespace-pre-wrap break-words [unicode-bidi:isolate-override]',
          mono && 'font-mono text-xs',
        )}
      >
        {text === '' ? (
          <span className="italic text-foreground-muted">(empty)</span>
        ) : (
          rendered.nodes
        )}
        {shown.truncated && <span aria-hidden="true">…</span>}
      </div>
      {marks !== undefined && <p className="mt-1 text-xs text-foreground-lighter">{marks}</p>}
      {expanded && shown.truncated && (
        <p className="mt-1 text-xs text-foreground-lighter">
          {`Showing the first ${formatCount(EXPANDED_CODE_POINT_LIMIT)} of ${count} characters.`}
        </p>
      )}
      {collapsed.truncated && expandable && (
        <Button
          type="button"
          variant="link"
          size="tiny"
          className="mt-1"
          aria-label={
            expanded ? undefined : label === undefined ? undefined : `${showAll} of ${label}`
          }
          onClick={() => setExpandedText(expanded ? null : text)}
        >
          {expanded ? 'Show less' : showAll}
        </Button>
      )}
    </div>
  )
}
