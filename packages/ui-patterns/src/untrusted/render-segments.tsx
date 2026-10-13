import { Fragment, type ReactNode } from 'react'

import { codePointId, describeCodePoint } from './describe-code-point.ts'
import { segmentLine } from './segments.ts'

export interface RenderedLine {
  readonly nodes: readonly ReactNode[]
  /** Characters shown as code points. */
  readonly hidden: number
  /** Visible characters outside printable ASCII, marked with a dotted underline. */
  readonly nonAscii: number
}

/**
 * One line of untrusted text as React nodes: printable text as text nodes,
 * every control, bidirectional, format or invisible character as a visible
 * `⟨U+XXXX⟩` label in a distinct style (with a spoken name for screen
 * readers), a tab as an arrow, and other non-ASCII characters underlined so a
 * look-alike letter is not mistaken for the ASCII one. Nothing is ever applied
 * as markup, direction or spacing.
 *
 * `keyPrefix` keeps the keys of several lines apart; within a line a key is
 * the offset of the segment in the text, so it does not depend on a position
 * in an array.
 */
export function renderLine(line: string, keyPrefix: string): RenderedLine {
  const { segments } = segmentLine(line)
  const nodes: ReactNode[] = []
  let offset = 0
  let hidden = 0
  let nonAscii = 0
  for (const segment of segments) {
    const key = `${keyPrefix}:${offset}`
    switch (segment.kind) {
      case 'text':
        nodes.push(<Fragment key={key}>{segment.text}</Fragment>)
        offset += segment.text.length
        break
      case 'tab':
        nodes.push(
          <span key={key} data-segment="tab" className="text-foreground-lighter">
            <span aria-hidden="true">→</span>
            <span className="sr-only select-none">tab</span>
          </span>,
        )
        offset += 1
        break
      case 'hidden':
        hidden += 1
        nodes.push(
          <span
            key={key}
            data-segment="hidden"
            data-code-point={codePointId(segment.codePoint)}
            className="mx-px rounded-sm border border-warning-400 bg-warning-200 px-0.5 font-mono text-[0.85em] text-warning-600"
          >
            <span aria-hidden="true">{segment.label}</span>
            <span className="sr-only select-none">
              {` hidden character ${codePointId(segment.codePoint)}, ${describeCodePoint(segment.codePoint)} `}
            </span>
          </span>,
        )
        offset += String.fromCodePoint(segment.codePoint).length
        break
      case 'non-ascii':
        nonAscii += 1
        nodes.push(
          <span
            key={key}
            data-segment="non-ascii"
            data-code-point={codePointId(segment.codePoint)}
            className="underline decoration-warning-500 decoration-dotted underline-offset-4"
          >
            {segment.text}
          </span>,
        )
        offset += segment.text.length
        break
    }
  }
  return { nodes, hidden, nonAscii }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What the view marked, in words: "2 hidden characters shown as code points; 1 non-ASCII character underlined". */
export function describeMarks(hidden: number, nonAscii: number): string | undefined {
  const parts: string[] = []
  if (hidden > 0) parts.push(`${plural(hidden, 'hidden character')} shown as code points`)
  if (nonAscii > 0) parts.push(`${plural(nonAscii, 'non-ASCII character')} underlined`)
  return parts.length === 0 ? undefined : parts.join('; ')
}
