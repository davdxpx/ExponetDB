import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import { keywordCompletionSource, PostgreSQL } from '@codemirror/lang-sql'
import { syntaxTree } from '@codemirror/language'

import { markInvisible, singleLine } from './text.ts'
import type { SqlCompletionKind, SqlCompletionProvider } from './types.ts'

/**
 * Completion from an injected provider (the browser holds no catalog) plus the
 * PostgreSQL keywords of the grammar. The provider is asked for the word being
 * typed, never inside a comment or a string literal; whatever it throws or
 * returns wrongly produces no suggestions, silently: the text the person typed
 * is not logged (C-26 and the secrets rule).
 */

const MAX_ITEMS = 500
const MAX_BEFORE = 2000
const MAX_LABEL = 256
const MAX_DETAIL = 120
/** Identifier characters and the dots that qualify them: `public.us`. */
const WORD = /[\p{L}\p{N}_$.]*/u
const NOT_IN = new Set(['LineComment', 'BlockComment', 'String', 'QuotedIdentifier'])

const TYPE_BY_KIND: Record<SqlCompletionKind, string> = {
  schema: 'namespace',
  table: 'class',
  column: 'property',
  function: 'function',
  keyword: 'keyword',
}

const isKind = (value: string): value is SqlCompletionKind => Object.hasOwn(TYPE_BY_KIND, value)

let localKeywords: ReadonlySet<string> | undefined

/** The words the grammar already completes, upper-cased: the provider's duplicates of them are dropped. */
function grammarWords(): ReadonlySet<string> {
  if (localKeywords === undefined) {
    const { keywords = '', types = '' } = PostgreSQL.spec
    localKeywords = new Set(`${keywords} ${types}`.toUpperCase().split(/\s+/))
  }
  return localKeywords
}

/** The valid items of what the provider returned, as options. Anything else is ignored. */
export function toCompletions(raw: unknown): Completion[] {
  if (!Array.isArray(raw)) return []
  const list: readonly unknown[] = raw
  const out: Completion[] = []
  for (const item of list.slice(0, MAX_ITEMS)) {
    if (typeof item !== 'object' || item === null) continue
    const label = 'label' in item ? item.label : undefined
    const kind = 'kind' in item ? item.kind : undefined
    const detail = 'detail' in item ? item.detail : undefined
    if (typeof label !== 'string' || label === '' || label.length > MAX_LABEL) continue
    if (/[\r\n]/.test(label)) continue
    if (typeof kind !== 'string' || !isKind(kind)) continue
    if (kind === 'keyword' && grammarWords().has(label.toUpperCase())) continue
    const option: Completion = { label, type: TYPE_BY_KIND[kind] }
    const shown = markInvisible(label)
    if (shown !== label) option.displayLabel = shown
    if (typeof detail === 'string' && detail !== '') {
      option.detail = singleLine(detail).slice(0, MAX_DETAIL)
    }
    out.push(option)
  }
  return out
}

/** A completion source that asks the provider `getProvider()` names (read at each request). */
export function providerCompletionSource(
  getProvider: () => SqlCompletionProvider | undefined,
): CompletionSource {
  return async (context) => {
    const provider = getProvider()
    if (provider === undefined) return null
    if (NOT_IN.has(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null
    const match = context.matchBefore(WORD)
    if (match === null || (match.from === match.to && !context.explicit)) return null
    const statement = context.state.sliceDoc(Math.max(0, match.from - MAX_BEFORE), match.from)
    const before = statement.slice(statement.lastIndexOf(';') + 1)
    let raw: unknown
    try {
      raw = await provider({ word: match.text, before })
    } catch {
      return null
    }
    if (context.aborted) return null
    const options = toCompletions(raw)
    if (options.length === 0) return null
    // Only the part after the last dot is replaced: `public.us` becomes `public.users`.
    return { from: match.from + match.text.lastIndexOf('.') + 1, options }
  }
}

/** The sources of an editor: the provider's, then the grammar's keywords. */
export function completionSources(
  getProvider: () => SqlCompletionProvider | undefined,
): CompletionSource[] {
  return [providerCompletionSource(getProvider), keywordCompletionSource(PostgreSQL, true)]
}
