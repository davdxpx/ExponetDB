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
 *   as with `standard_conforming_strings = off`.
 *
 * Neither mode alone is safe for redaction: `'C:\'` ends in the first and not
 * in the second, which shifts every later literal. Redaction therefore masks
 * what is a literal under either mode (redact.ts).
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
/** Sticky: matched at a position, without a length limit (PostgreSQL has none for tags). */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y
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
  scan(text, mode, (kind, start, end, unterminated) => {
    out.push(unterminated ? { kind, start, end, unterminated } : { kind, start, end })
    return true
  })
  return out
}

/**
 * The number of tokens of a text other than space and comments, counted
 * without keeping them, up to `max + 1`: what bounds the parser's work
 * before it runs ([`parse.ts`](./parse.ts), deployment.md §2a). The parser's
 * memory grows with the nodes of its tree, which grow with the tokens, not
 * with the bytes: a function body is one token, `SELECT 1;` is three.
 */
export function countTokens(
  text: string,
  max: number,
  mode: LexMode = 'standard',
  /** Counts the tokens of a statement body instead of the literal it is in (a PL/pgSQL parse). */
  bodies = false,
): number {
  let count = 0
  scan(text, mode, (kind) => {
    if (kind === 'space' || kind === 'comment') return true
    count++
    return count <= max
  })
  if (!bodies || count > max) return count
  for (const body of statementBodies(text, mode)) {
    // The body's tokens replace the one literal they are inside (already counted).
    count += Math.max(1, countTokens(body, max - count + 1, mode)) - 1
    if (count > max) break
  }
  return count
}

const ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** The character an `E''` backslash escape stands for, and where the text goes on. */
function escapeAt(s: string, i: number): { text: string; next: number } {
  const c = s[i] ?? ''
  const known = ESCAPES[c]
  if (known !== undefined) return { text: known, next: i + 1 }
  const digits = (
    re: RegExp,
    from: number,
    radix: number,
  ): { text: string; next: number } | null => {
    const m = re.exec(s.slice(from, from + 8))
    if (m === null) return null
    const code = Number.parseInt(m[0], radix)
    return { text: code > 0x10ffff ? '�' : String.fromCodePoint(code), next: from + m[0].length }
  }
  const found =
    c >= '0' && c <= '7'
      ? digits(/^[0-7]{1,3}/, i, 8)
      : c === 'x'
        ? digits(/^[0-9a-fA-F]{1,2}/, i + 1, 16)
        : c === 'u'
          ? digits(/^[0-9a-fA-F]{4}/, i + 1, 16)
          : c === 'U'
            ? digits(/^[0-9a-fA-F]{8}/, i + 1, 16)
            : null
  return found ?? { text: c, next: i + 1 }
}

/**
 * The text a single-quoted literal denotes, as PostgreSQL reads it: `''` is
 * one quote, an `E` string decodes backslash escapes, and literals separated
 * by white space with a newline are one. `undefined` when the literal is
 * unterminated or is not a string. shortcut: a `U&''` string is read without
 * its `\XXXX` escapes (the count can only differ by encoded characters), a
 * rare form for a function body; decode them if one is ever seen in a history.
 */
export function quotedBody(literal: string): string | undefined {
  const prefix = /^(?:(e)|u&|n)?'/i.exec(literal)
  if (prefix === null) return undefined
  const escapes = prefix[1] !== undefined
  const n = literal.length
  let out = ''
  let i = prefix[0].length
  for (;;) {
    let j = i
    while (j < n && literal[j] !== "'" && !(escapes && literal[j] === '\\')) j++
    out += literal.slice(i, j)
    if (j >= n) return undefined
    if (literal[j] === '\\') {
      const e = escapeAt(literal, j + 1)
      out += e.text
      i = e.next
    } else if (literal[j + 1] === "'") {
      out += "'"
      i = j + 2
    } else {
      // the closing quote: a literal that continues after a newline is the same string
      let k = j + 1
      let newline = false
      while (k < n && SPACE.test(literal[k] ?? '')) {
        if (literal[k] === '\n' || literal[k] === '\r') newline = true
        k++
      }
      if (!newline || literal[k] !== "'") return out
      i = k + 1
    }
  }
}

/**
 * The bodies a statement hands to another parser: the text of every
 * terminated dollar-quoted literal, and of a single-quoted string where one
 * is a body, whatever the quoting: after `DO` (optionally `LANGUAGE x`) or
 * `AS`, or before `LANGUAGE` (`DO '…' LANGUAGE plpgsql`, `AS '…' LANGUAGE
 * sql`). Any other string, a large JSON literal for instance, is data.
 */
export function statementBodies(text: string, mode: LexMode = 'standard'): string[] {
  const out: string[] = []
  // The three words before this token (lower case, '' for any other token) and a string
  // that is a body if `LANGUAGE` follows it.
  let w1 = ''
  let w2 = ''
  let w3 = ''
  let maybe: [number, number] | undefined
  scan(text, mode, (kind, start, end, unterminated) => {
    if (kind === 'space' || kind === 'comment') return true
    const word = kind === 'ident' ? text.slice(start, end).toLowerCase() : ''
    if (word === 'language' && maybe !== undefined) {
      const body = quotedBody(text.slice(maybe[0], maybe[1]))
      if (body !== undefined) out.push(body)
    }
    maybe = undefined
    if (kind === 'dollar' && !unterminated) {
      DOLLAR_TAG.lastIndex = start
      const tag = DOLLAR_TAG.exec(text)?.[0] ?? ''
      out.push(text.slice(start + tag.length, end - tag.length))
    } else if (kind === 'string' && !unterminated) {
      if (w1 === 'do' || w1 === 'as' || (w3 === 'do' && w2 === 'language')) {
        const body = quotedBody(text.slice(start, end))
        if (body !== undefined) out.push(body)
      } else {
        maybe = [start, end]
      }
    }
    w3 = w2
    w2 = w1
    w1 = word
    return true
  })
  return out
}

/** Scans a text and hands every token to `emit`; `emit` returns false to stop. */
function scan(
  text: string,
  mode: LexMode,
  emit: (kind: TokenKind, start: number, end: number, unterminated: boolean) => boolean,
): void {
  let i = 0
  const n = text.length
  let stopped = false
  const push = (kind: TokenKind, start: number, end: number, unterminated = false) => {
    if (!emit(kind, start, end, unterminated)) stopped = true
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
  while (i < n && !stopped) {
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
      DOLLAR_TAG.lastIndex = i
      const tag = DOLLAR_TAG.exec(text)
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
}
