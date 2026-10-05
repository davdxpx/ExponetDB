import { decodeUtf8, err, ok, type Result } from '@exponetdb/kernel'

/**
 * `c1` executable-text canonicalization
 * ([migration-bundles.md, N1 to N5](../../../../exponetdb-docs/04-migrations/migration-bundles.md#normative-definition-of-c1-frozen-at-g1)).
 *
 * FROZEN AT G1. The output of this module for any input never changes, not
 * even to fix a bug: a change is a new canonicalizer `c2` through an ADR.
 * Golden vectors in tooling/golden/c1-sql.json pin it, and an independent Go
 * implementation reproduces them.
 *
 * The scan works on UTF-16 code units. Every character with a syntactic role
 * is ASCII and every non-ASCII code point belongs to the identifier class, so
 * classifying surrogate halves individually gives the same result as
 * classifying code points (N3).
 */

export type SqlRefusal =
  | 'invalid_utf8'
  | 'bom'
  | 'nul'
  | 'unterminated_string'
  | 'unterminated_quoted_identifier'
  | 'unterminated_dollar_quote'
  | 'unterminated_block_comment'

/** N1 (input checks, in order) and N2 (line endings). The result feeds the source digest and the scan. */
export function normalizeSqlSource(bytes: Uint8Array): Result<string, SqlRefusal> {
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return err('invalid_utf8')
  }
  const text = decoded.value
  if (text.charCodeAt(0) === 0xfeff) {
    return err('bom')
  }
  if (text.includes('\u0000')) {
    return err('nul')
  }
  return ok(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
}

/** N1 to N5: the executable text of a SQL file. May be empty. */
export function executableText(bytes: Uint8Array): Result<string, SqlRefusal> {
  const normalized = normalizeSqlSource(bytes)
  return normalized.ok ? scanExecutableText(normalized.value) : normalized
}

const LF = 0x0a
const QUOTE = 0x27 // '
const DQUOTE = 0x22 // "
const DOLLAR = 0x24 // $
const BACKSLASH = 0x5c
const DASH = 0x2d
const SLASH = 0x2f
const STAR = 0x2a
const AMP = 0x26

/** N3 whitespace: space, tab, LF, VT, FF (CR no longer exists after N2). */
function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === LF || c === 0x0b || c === 0x0c
}

/** N3 ident_start, also tag_start. */
function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

/** N3 ident_cont. */
function isIdentCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c) || c === DOLLAR
}

/** N3 tag_cont. */
function isTagCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c)
}

class Unterminated {
  readonly reason: SqlRefusal
  constructor(reason: SqlRefusal) {
    this.reason = reason
  }
}

/** N4 and N5 over text that already passed N1 and N2. */
export function scanExecutableText(text: string): Result<string, SqlRefusal> {
  try {
    return ok(new Scanner(text).run())
  } catch (e) {
    if (e instanceof Unterminated) {
      return err(e.reason)
    }
    throw e
  }
}

class Scanner {
  private readonly text: string
  private readonly n: number
  private readonly out: string[] = []
  /** A run of whitespace or comments was seen since the last token (N5). */
  private pendingSpace = false

  constructor(text: string) {
    this.text = text
    this.n = text.length
  }

  private at(i: number): number {
    return i < this.n ? this.text.charCodeAt(i) : -1
  }

  /** Copies a token; a preceding run becomes one space unless it is at the start (N5). */
  private emit(from: number, to: number): void {
    if (this.pendingSpace && this.out.length > 0) {
      this.out.push(' ')
    }
    this.pendingSpace = false
    this.out.push(this.text.slice(from, to))
  }

  run(): string {
    let i = 0
    while (i < this.n) {
      const c = this.at(i)
      const next = this.at(i + 1)
      if (c === DASH && next === DASH) {
        // R1: line comment up to, not including, the next LF.
        const lf = this.text.indexOf('\n', i + 2)
        i = lf < 0 ? this.n : lf
        this.pendingSpace = true
      } else if (c === SLASH && next === STAR) {
        // R2: nested block comment.
        i = this.skipBlockComment(i)
        this.pendingSpace = true
      } else if (isWhitespace(c)) {
        // R3
        i++
        this.pendingSpace = true
      } else if (c === QUOTE) {
        // R4
        i = this.literal(i, i + 1, false)
      } else if ((c === 0x65 || c === 0x45) && next === QUOTE) {
        // R5: E'…' (the prefix belongs to the token)
        i = this.literal(i, i + 2, true)
      } else if ((c === 0x75 || c === 0x55) && next === AMP && this.at(i + 2) === QUOTE) {
        // R6: U&'…'
        i = this.literal(i, i + 3, false)
      } else if ((c === 0x75 || c === 0x55) && next === AMP && this.at(i + 2) === DQUOTE) {
        // R7: U&"…"
        i = this.quotedIdentifier(i, i + 3)
      } else if (c === DQUOTE) {
        // R8
        i = this.quotedIdentifier(i, i + 1)
      } else if (c === DOLLAR && this.dollarDelimiterEnd(i) > 0) {
        // R9
        i = this.dollarQuoted(i)
      } else if (isIdentStart(c)) {
        // R10: identifier run (a `$`, `e'` or `u&'` inside it belongs to it).
        let j = i + 1
        while (j < this.n && isIdentCont(this.at(j))) {
          j++
        }
        this.emit(i, j)
        i = j
      } else {
        // R11: any other code point, including a `$` that does not open R9.
        this.emit(i, i + 1)
        i++
      }
    }
    return this.out.join('')
  }

  private skipBlockComment(start: number): number {
    let depth = 1
    let j = start + 2
    while (j < this.n) {
      const c = this.at(j)
      const next = this.at(j + 1)
      if (c === SLASH && next === STAR) {
        depth++
        j += 2
      } else if (c === STAR && next === SLASH) {
        depth--
        j += 2
        if (depth === 0) {
          return j
        }
      } else {
        j++
      }
    }
    throw new Unterminated('unterminated_block_comment')
  }

  /** A string literal from `start` (its first code point) with content starting at `contentStart`. */
  private literal(start: number, contentStart: number, escapeMode: boolean): number {
    let j = contentStart
    for (;;) {
      if (j >= this.n) {
        throw new Unterminated('unterminated_string')
      }
      const c = this.at(j)
      if (escapeMode && c === BACKSLASH) {
        // The backslash and the code unit after it are content.
        if (j + 1 >= this.n) {
          throw new Unterminated('unterminated_string')
        }
        j += 2
      } else if (c === QUOTE) {
        if (this.at(j + 1) === QUOTE) {
          j += 2
          continue
        }
        const resume = this.continuation(j + 1)
        if (resume < 0) {
          this.emit(start, j + 1)
          return j + 1
        }
        // String continuation: the run and both quotes belong to the token.
        j = resume + 1
      } else {
        j++
      }
    }
  }

  /**
   * After a closing quote at `from - 1`: if a run of whitespace and line
   * comments containing at least one LF is followed by `'`, returns the index
   * of that quote, else -1.
   */
  private continuation(from: number): number {
    let j = from
    let sawNewline = false
    for (;;) {
      const c = this.at(j)
      if (isWhitespace(c)) {
        if (c === LF) {
          sawNewline = true
        }
        j++
      } else if (c === DASH && this.at(j + 1) === DASH) {
        const lf = this.text.indexOf('\n', j + 2)
        if (lf < 0) {
          return -1
        }
        j = lf
      } else {
        return sawNewline && c === QUOTE ? j : -1
      }
    }
  }

  private quotedIdentifier(start: number, contentStart: number): number {
    let j = contentStart
    for (;;) {
      if (j >= this.n) {
        throw new Unterminated('unterminated_quoted_identifier')
      }
      if (this.at(j) === DQUOTE) {
        if (this.at(j + 1) === DQUOTE) {
          j += 2
          continue
        }
        this.emit(start, j + 1)
        return j + 1
      }
      j++
    }
  }

  /** End index (exclusive) of a `$tag$` opening delimiter at `i`, or -1. */
  private dollarDelimiterEnd(i: number): number {
    let j = i + 1
    if (this.at(j) === DOLLAR) {
      return j + 1
    }
    if (!isIdentStart(this.at(j))) {
      return -1
    }
    j++
    while (j < this.n && isTagCont(this.at(j))) {
      j++
    }
    return this.at(j) === DOLLAR ? j + 1 : -1
  }

  private dollarQuoted(start: number): number {
    const delimiterEnd = this.dollarDelimiterEnd(start)
    const delimiter = this.text.slice(start, delimiterEnd)
    const close = this.text.indexOf(delimiter, delimiterEnd)
    if (close < 0) {
      throw new Unterminated('unterminated_dollar_quote')
    }
    const end = close + delimiter.length
    this.emit(start, end)
    return end
  }
}
