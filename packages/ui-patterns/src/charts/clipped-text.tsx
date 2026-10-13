import { cn } from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'

import { segmentLine } from '../untrusted/segments.ts'

/**
 * Untrusted text of a chart (series labels, row labels, gap causes) as a plain
 * string: invisible and direction characters are replaced by their code point
 * (`⟨U+202E⟩`) and a tab by an arrow, so nothing in a label can reorder or hide
 * what a reader sees (C-26). Used where a string is needed (axis ticks, sentences);
 * the same rules as `segmentLine`.
 */
export function visibleText(text: string): string {
  return visibleAtoms(text).join('')
}

/** The characters of `text` as they are shown: one entry per character, one per hidden character. */
function visibleAtoms(text: string): string[] {
  const atoms: string[] = []
  for (const segment of segmentLine(text).segments) {
    if (segment.kind === 'text') atoms.push(...Array.from(segment.text))
    else if (segment.kind === 'tab') atoms.push('→')
    else if (segment.kind === 'hidden') atoms.push(segment.label)
    else atoms.push(segment.text)
  }
  return atoms
}

/** At most `limit` characters of `text` as shown, with an ellipsis when it was cut. */
export function clipVisible(text: string, limit: number): string {
  const atoms = visibleAtoms(text)
  return atoms.length <= limit ? atoms.join('') : `${atoms.slice(0, limit).join('')}…`
}

/** What an expanded value shows at most; a longer one says how much it left out. */
const EXPANDED_LIMIT = 4000

/**
 * A long, untrusted value truncated with an explicit control to expand it
 * (design-system.md section 4). Rendered as text in a text node, never as markup.
 */
// UntrustedText: the orchestrator replaces this body with the UntrustedText component of src/untrusted/.
export function ClippedText({
  text,
  limit = 80,
  className,
}: {
  text: string
  limit?: number
  className?: string
}): ReactNode {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const atoms = visibleAtoms(text)
  const isLong = atoms.length > limit
  let shown: string
  if (!isLong) {
    shown = atoms.join('')
  } else if (!expanded) {
    shown = `${atoms.slice(0, limit).join('')}…`
  } else if (atoms.length > EXPANDED_LIMIT) {
    shown = `${atoms.slice(0, EXPANDED_LIMIT).join('')}… (${atoms.length - EXPANDED_LIMIT} more characters not shown)`
  } else {
    shown = atoms.join('')
  }
  return (
    <span className={cn('min-w-0 [overflow-wrap:anywhere]', className)}>
      <span id={id}>{shown}</span>
      {isLong ? (
        <>
          {' '}
          <button
            type="button"
            aria-expanded={expanded}
            aria-describedby={id}
            onClick={() => setExpanded((value) => !value)}
            className="focus-ring rounded-sm text-xs text-foreground-light underline underline-offset-2 hover:text-foreground"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      ) : null}
    </span>
  )
}
