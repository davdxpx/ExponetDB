// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/TextHighlighter.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Children, type ComponentPropsWithoutRef, type ReactNode } from 'react'

import { useCommandMenuQuery } from './hooks/query-hooks.ts'

const MAX_QUERY_LENGTH = 200
const MAX_TERMS = 8

export interface HighlightPart {
  text: string
  match: boolean
}

/**
 * Splits `text` into the parts that match a word of `query` and the parts that do
 * not, ignoring case. The result is plain strings: the caller renders them as
 * text, never as markup. The parts always join back to `text`.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const terms = query
    .slice(0, MAX_QUERY_LENGTH)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
    .slice(0, MAX_TERMS)
  if (terms.length === 0) return [{ text, match: false }]

  const lower = text.toLowerCase()
  // Lower-casing can change the length of a string (a few letters expand); then offsets
  // would not line up with `text`, so nothing is highlighted.
  if (lower.length !== text.length) return [{ text, match: false }]

  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let from = lower.indexOf(term); from !== -1; from = lower.indexOf(term, from + 1)) {
      marked.fill(true, from, from + term.length)
    }
  }

  const parts: HighlightPart[] = []
  let start = 0
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || marked[i] !== marked[start]) {
      parts.push({ text: text.slice(start, i), match: marked[start] === true })
      start = i
    }
  }
  return parts.length === 0 ? [{ text, match: false }] : parts
}

interface TextHighlighterBaseProps extends ComponentPropsWithoutRef<'span'> {
  query: string
  text?: string
}

function TextHighlighterBase({ children, text, query, ...props }: TextHighlighterBaseProps) {
  const child: ReactNode = text ?? Children.toArray(children)[0]
  if (typeof child !== 'string') return child

  // UntrustedText: a command name can come from registry data; the orchestrator wires the
  // component that shows invisible and direction characters here.
  return (
    <span {...props}>
      {highlightParts(child, query).map((part, index) =>
        part.match ? (
          // The weight carries the highlight, so it does not rest on color alone.
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string
          <span key={index} className="font-semibold text-foreground">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </span>
  )
}

function TextHighlighter(props: Omit<TextHighlighterBaseProps, 'query'>) {
  const query = useCommandMenuQuery()

  return <TextHighlighterBase query={query} {...props} />
}

export { TextHighlighter, TextHighlighterBase }
