import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { type Segment, segmentLine } from '../untrusted/segments.ts'

export interface MarkedCodeProps {
  /** The text, shown in full: a person reads or types all of it. */
  readonly text: string
  readonly id?: string
  readonly className?: string
}

/**
 * Text a person must read exactly (the expected text of a typed confirmation,
 * a target path, a plan hash) in a `code` element, as text nodes only. Every
 * invisible, bidirectional or control character is shown by its code point
 * (`⟨U+202E⟩`) instead of acting, a tab as an arrow, and every visible
 * character outside printable ASCII is underlined and followed by its code
 * point for screen readers, so a look-alike cannot pass for the real text.
 * Never truncated.
 */
export function MarkedCode({ text, id, className }: MarkedCodeProps): ReactNode {
  const { segments } = segmentLine(text)
  return (
    <code
      id={id}
      // Never rewritten by a page translator, never laid out right to left.
      translate="no"
      dir="ltr"
      className={cn(
        'rounded-sm bg-surface-200 px-1 py-0.5 font-mono text-foreground break-all whitespace-pre-wrap',
        className,
      )}
    >
      {segments.map((segment, index) =>
        // Segments never reorder; the index is a stable key for one text.
        renderSegment(segment, `${index}`),
      )}
    </code>
  )
}

function renderSegment(segment: Segment, key: string): ReactNode {
  switch (segment.kind) {
    case 'text':
      return <span key={key}>{segment.text}</span>
    case 'tab':
      return (
        <span key={key} className="text-warning-600">
          <span aria-hidden>→</span>
          <span className="sr-only">(tab)</span>
        </span>
      )
    case 'hidden':
      return (
        <span
          key={key}
          data-marked="hidden"
          className="mx-px rounded-sm border border-warning-500 px-0.5 text-warning-600"
        >
          {segment.label}
        </span>
      )
    case 'non-ascii':
      return (
        <span key={key} data-marked="non-ascii">
          <span className="underline decoration-warning-500 decoration-dotted underline-offset-2">
            {segment.text}
          </span>
          <span className="sr-only">{` (${codePointName(segment.codePoint)}) `}</span>
        </span>
      )
  }
}

/** `U+0430` for a code point. */
function codePointName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * How many characters of a text `MarkedCode` marks (invisible, control,
 * bidirectional and non-ASCII characters).
 */
export function markedCount(text: string): number {
  return segmentLine(text).marked
}
