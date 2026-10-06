/**
 * A PostgreSQL lexer for redaction ([statement-redaction.md §2](../../../../exponetdb-docs/03-database-model/statement-redaction.md#2-algorithm)).
 * It follows the server's lexical rules (scan.l) closely enough to find
 * every literal, comment, identifier and parameter, and it never fails on
 * truncated text: an unterminated literal or comment runs to the end of the
 * text and is marked `unterminated`.
 *
 * Two modes for single-quoted strings:
 *
 * - `standard` (`standard_conforming_strings = on`): a backslash is an
 *   ordinary character, except in `E''` strings;
 * - `conservative`: a backslash escapes the next character in every string,
 *   as with `standard_conforming_strings = off`. A string can only become
 *   longer in this mode, so redacting with it never reveals more.
 */
export type TokenKind =
  | 'space'
  | 'comment'
  | 'string'
  | 'dollar'
  | 'number'
  | 'bitstring'
  | 'ident'
  | 'qident'
  | 'param'
  | 'op'

export interface Token {
  readonly kind: TokenKind
  readonly start: number
  readonly end: number
  readonly unterminated?: boolean
}

export type LexMode = 'standard' | 'conservative'

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/
const DIGIT = /[0-9]/
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/
const SPACE = /[ \t\n\r\f\v]/

/** The literal tokens: what redaction replaces. */
export function isLiteral(token: Token): boolean {
  return (
    token.kind === 'string' ||
    token.kind === 'dollar' ||
    token.kind === 'number' ||
    token.kind === 'bitstring'
  )
}

export function lex(text: string, mode: LexMode = 'standard'): Token[] {
  const out: Token[] = []
  let i = 0
  const n = text.length
  const push = (kind: TokenKind, start: number, end: number, unterminated = false) => {
    out.push(unterminated ? { kind, start, end, unterminated } : { kind, start, end })
  }
  /** A quoted run ending at an unescaped `quote`; `''` (doubled) escapes; `backslash` escapes too. */
  const quoted = (
    from: number,
    quote: string,
    backslash: boolean,
  ): { end: number; open: boolean } => {
    let j = from
    while (j < n) {
      const c = text[j]
      if (backslash && c === '\\') {
        j += 2
        continue
      }
      if (c === quote) {
        if (text[j + 1] === quote) {
          j += 2
          continue
        }
        return { end: j + 1, open: false }
      }
      j++
    }
    return { end: n, open: true }
  }
  /** Adjacent string continuation: `'a'` newline `'b'` is one literal in SQL. */
  const continuation = (from: number, backslash: boolean): number => {
    let j = from
    for (;;) {
      let k = j
      let newline = false
      while (k < n && SPACE.test(text[k] ?? '')) {
        if (text[k] === '\n' || text[k] === '\r') newline = true
        k++
      }
      if (!newline || text[k] !== "'") return j
      const q = quoted(k + 1, "'", backslash)
      j = q.end
      if (q.open) return j
    }
  }
  while (i < n) {
    const c = text[i] ?? ''
    const next = text[i + 1] ?? ''
    if (SPACE.test(c)) {
      let j = i + 1
      while (j < n && SPACE.test(text[j] ?? '')) j++
      push('space', i, j)
      i = j
      continue
    }
    if (c === '-' && next === '-') {
      let j = i + 2
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j++
      push('comment', i, j)
      i = j
      continue
    }
    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      push('comment', i, j, depth > 0)
      i = j
      continue
    }
    // E'…', B'…', X'…', N'…', U&'…' (and U&"…" identifiers)
    const lower = c.toLowerCase()
    if ((lower === 'e' || lower === 'b' || lower === 'x' || lower === 'n') && next === "'") {
      const backslashEscapes = lower === 'e' || mode === 'conservative'
      const q = quoted(i + 2, "'", backslashEscapes)
      const end = q.open ? q.end : continuation(q.end, backslashEscapes)
      push(lower === 'b' || lower === 'x' ? 'bitstring' : 'string', i, end, q.open)
      i = end
      continue
    }
    if (lower === 'u' && next === '&' && (text[i + 2] === "'" || text[i + 2] === '"')) {
      const quote = text[i + 2] ?? "'"
      const q = quoted(i + 3, quote, mode === 'conservative' && quote === "'")
      let end = q.end
      if (quote === "'" && !q.open) {
        // optional UESCAPE '<char>' belongs to the literal
        const m = /^\s*uescape\s*'(?:''|[^'])'/i.exec(text.slice(end))
        if (m !== null) end += m[0].length
      }
      push(quote === "'" ? 'string' : 'qident', i, end, q.open)
      i = end
      continue
    }
    if (c === "'") {
      const backslashEscapes = mode === 'conservative'
      const q = quoted(i + 1, "'", backslashEscapes)
      const end = q.open ? q.end : continuation(q.end, backslashEscapes)
      push('string', i, end, q.open)
      i = end
      continue
    }
    if (c === '"') {
      const q = quoted(i + 1, '"', false)
      push('qident', i, q.end, q.open)
      i = q.end
      continue
    }
    if (c === '$') {
      if (DIGIT.test(next)) {
        let j = i + 1
        while (j < n && DIGIT.test(text[j] ?? '')) j++
        push('param', i, j)
        i = j
        continue
      }
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 256))
      if (tag !== null) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        const end = close < 0 ? n : close + tag[0].length
        push('dollar', i, end, close < 0)
        i = end
        continue
      }
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(next))) {
      // decimal, real, hex/octal/binary (0x, 0o, 0b), underscores (16+); trailing junk stays attached
      let j = i
      const m =
        /^(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?)/.exec(
          text.slice(i),
        )
      j += m === null || m[0].length === 0 ? 1 : m[0].length
      while (j < n && IDENT_CONT.test(text[j] ?? '')) j++
      push('number', i, j)
      i = j
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < n && IDENT_CONT.test(text[j] ?? '')) j++
      push('ident', i, j)
      i = j
      continue
    }
    push('op', i, i + 1)
    i++
  }
  return out
}
