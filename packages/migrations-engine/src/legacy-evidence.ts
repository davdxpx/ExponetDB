import { normalizeSqlSource, scanExecutableText } from '@exponetdb/migrations/format'

/**
 * Content evidence between a legacy ledger entry and the legacy files
 * ([legacy-import.md §2.3](../../../exponetdb-docs/04-migrations/legacy-import.md#23-evidence-strength),
 * Wave 9 order A2). Pure functions; nothing here reads a database.
 *
 * A ledger that recorded the applied statements (Supabase's
 * `schema_migrations.statements`) rarely stores them the way the file is
 * written today: real ledgers hold one element with the whole file, its
 * comments stripped, while the parser splits the file into statements; a
 * header was edited after apply; drizzle's `--> statement-breakpoint`
 * comments sit between statements. The comparison therefore works on the
 * **joined executable statement sequence** of both sides, each normalized
 * with the lexical normalization of `c1` (`scanExecutableText`: comments
 * outside literals and dollar-quoted bodies removed, every whitespace run a
 * single space), then with the whitespace next to a top-level `;` removed
 * and the trailing semicolons dropped. `c1` itself is not changed.
 *
 * Strength, strongest first:
 *
 * - `strong`: a tool's hash of the file's bytes (drizzle), or the applied
 *   statements equal to the file's statements one by one, whitespace
 *   collapsed (the Wave 6 comparison);
 * - `medium`: the normalized joined sequences are equal;
 * - `low`: equal only when comments inside dollar-quoted bodies (function
 *   bodies, `DO` blocks) are removed too: what ran is the same code, but the
 *   stored body text differs;
 * - `curated`: a person's alias says the entry stands for the file;
 * - `weak`: a name only (the ledger's name equals the stem). Never makes a
 *   file `recorded`.
 */
export type EvidenceStrength = 'strong' | 'medium' | 'low' | 'curated' | 'weak'

export const STRENGTH_RANK: Readonly<Record<EvidenceStrength, number>> = {
  strong: 5,
  medium: 4,
  low: 3,
  curated: 2,
  weak: 1,
}

/** Content and curated evidence make a file recorded; a name alone never does. */
export function recordsTheFile(strength: EvidenceStrength | null): boolean {
  return strength !== null && strength !== 'weak'
}

const SEMICOLON = 0x3b
const QUOTE = 0x27
const DQUOTE = 0x22
const DOLLAR = 0x24
const BACKSLASH = 0x5c
const AMP = 0x26
const SPACE = 0x20

function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}
function isIdentCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c) || c === DOLLAR
}
function isTagCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c)
}

/**
 * Tokens of a text that already passed `scanExecutableText`: it never holds
 * a comment outside a literal or a dollar-quoted body, and separates tokens
 * by at most one space. The token rules mirror `c1` (N4), so a quote or a
 * `$` inside a literal or an identifier is never taken for a delimiter.
 */
function retokenize(text: string, bodies: boolean): string {
  const out: string[] = []
  const n = text.length
  const at = (i: number) => (i < n ? text.charCodeAt(i) : -1)
  const literalEnd = (contentStart: number, escapes: boolean): number => {
    let j = contentStart
    while (j < n) {
      const c = at(j)
      if (escapes && c === BACKSLASH) {
        j += 2
      } else if (c === QUOTE) {
        if (at(j + 1) === QUOTE) {
          j += 2
          continue
        }
        // A continuation run (whitespace with a newline, then a quote) belongs to the token.
        let k = j + 1
        let newline = false
        while (k < n && (at(k) === SPACE || at(k) === 0x0a || at(k) === 0x09)) {
          if (at(k) === 0x0a) newline = true
          k++
        }
        if (newline && at(k) === QUOTE) {
          j = k + 1
          continue
        }
        return j + 1
      } else {
        j++
      }
    }
    return n
  }
  const dollarEnd = (i: number): number => {
    let j = i + 1
    if (at(j) === DOLLAR) return j + 1
    if (!isIdentStart(at(j))) return -1
    j++
    while (j < n && isTagCont(at(j))) j++
    return at(j) === DOLLAR ? j + 1 : -1
  }
  let i = 0
  while (i < n) {
    const c = at(i)
    const next = at(i + 1)
    if (c === SPACE) {
      // A space next to a top-level `;` never separates two tokens that need it.
      if (out.length === 0 || out[out.length - 1] === ';' || at(i + 1) === SEMICOLON) {
        i++
        continue
      }
      out.push(' ')
      i++
    } else if (c === SEMICOLON) {
      if (out[out.length - 1] === ' ') out.pop()
      out.push(';')
      i++
    } else if (c === QUOTE) {
      const end = literalEnd(i + 1, false)
      out.push(text.slice(i, end))
      i = end
    } else if ((c === 0x65 || c === 0x45) && next === QUOTE) {
      const end = literalEnd(i + 2, true)
      out.push(text.slice(i, end))
      i = end
    } else if ((c === 0x75 || c === 0x55) && next === AMP && at(i + 2) === QUOTE) {
      const end = literalEnd(i + 3, false)
      out.push(text.slice(i, end))
      i = end
    } else if (
      c === DQUOTE ||
      ((c === 0x75 || c === 0x55) && next === AMP && at(i + 2) === DQUOTE)
    ) {
      let j = c === DQUOTE ? i + 1 : i + 3
      while (j < n) {
        if (at(j) === DQUOTE) {
          if (at(j + 1) === DQUOTE) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out.push(text.slice(i, j))
      i = j
    } else if (c === DOLLAR && dollarEnd(i) > 0) {
      const open = dollarEnd(i)
      const delimiter = text.slice(i, open)
      const close = text.indexOf(delimiter, open)
      const end = close < 0 ? n : close + delimiter.length
      if (bodies && close >= 0) {
        // The weaker tier: the body as code, its comments gone and its whitespace collapsed.
        const body = scanExecutableText(text.slice(open, close))
        out.push(delimiter, body.ok ? body.value.trim() : text.slice(open, close), delimiter)
      } else {
        out.push(text.slice(i, end))
      }
      i = end
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentCont(at(j))) j++
      out.push(text.slice(i, j))
      i = j
    } else {
      out.push(text[i] ?? '')
      i++
    }
  }
  while (out.length > 0 && (out[out.length - 1] === ';' || out[out.length - 1] === ' ')) out.pop()
  return out.join('')
}

/**
 * The joined executable statement sequence of a side: each part (a ledger
 * element, or a whole file) normalized as described above, empty parts
 * dropped, joined with `;` and closed with one. `null` when a part is not
 * readable SQL text (an unterminated literal, a NUL): no evidence then.
 */
export function statementSequence(
  parts: readonly string[],
  options: { readonly bodies: boolean },
): string | null {
  const normalized: string[] = []
  for (const part of parts) {
    const source = normalizeSqlSource(new TextEncoder().encode(part))
    if (!source.ok) return null
    const scanned = scanExecutableText(source.value)
    if (!scanned.ok) return null
    const text = retokenize(scanned.value, options.bodies)
    if (text !== '') normalized.push(text)
  }
  return normalized.length === 0 ? '' : `${normalized.join(';')};`
}

/**
 * The applied time a Supabase ledger version carries: `YYYYMMDDHHMMSS`, as
 * the Supabase tooling writes it (in UTC); anything else carries none.
 */
export function supabaseVersionTime(version: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version)
  if (m === null) return null
  const [, y, mo, d, h, mi, s] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`
  const t = Date.parse(iso)
  return Number.isNaN(t) || new Date(t).toISOString() !== iso ? null : iso
}

/** What one ledger entry proves about one file (or a curated group of files). */
export interface ContentMatch {
  readonly strength: EvidenceStrength
  /** `hash`, `statements`, `statements_normalized`, `statements_bodies`, `alias`, `name_hint`. */
  readonly how: string
}

/**
 * The comparison keys of one side, computed once: the statements one by one
 * with whitespace collapsed (`exact`), the normalized joined sequence
 * (`normalized`) and the same with comments inside bodies removed
 * (`bodies`). A side without statements, or unreadable, has no key.
 */
export interface ContentKeys {
  readonly exact: string | null
  readonly normalized: string | null
  readonly bodies: string | null
}

const collapse = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/;$/, '')

/** The keys of statement texts (the parser's statements, or a ledger's elements) and of whole texts. */
export function contentKeys(statements: readonly string[], texts: readonly string[]): ContentKeys {
  const exact = statements.map(collapse).filter((s) => s !== '')
  const key = (v: string | null) => (v === null || v === '' ? null : v)
  return {
    exact: exact.length === 0 ? null : exact.join('\u0000'),
    normalized: key(statementSequence(texts, { bodies: false })),
    bodies: key(statementSequence(texts, { bodies: true })),
  }
}

/** The strongest content match between a ledger entry's keys and a file's (or a group's) keys. */
export function matchKeys(entry: ContentKeys, files: ContentKeys): ContentMatch | null {
  if (entry.exact !== null && entry.exact === files.exact) {
    return { strength: 'strong', how: 'statements' }
  }
  if (entry.normalized !== null && entry.normalized === files.normalized) {
    return { strength: 'medium', how: 'statements_normalized' }
  }
  if (entry.bodies !== null && entry.bodies === files.bodies) {
    return { strength: 'low', how: 'statements_bodies' }
  }
  return null
}

/**
 * The strongest content evidence between an entry's applied statements and
 * the files it stands for (one file, or the files of a curated multi-file
 * alias in file order). `fileStatements` are the parsed statement texts of
 * each file; `fileTexts` their whole texts.
 */
export function statementsMatch(
  applied: readonly string[],
  fileStatements: readonly (readonly string[])[],
  fileTexts: readonly string[],
): ContentMatch | null {
  if (applied.length === 0) return null
  return matchKeys(contentKeys(applied, applied), contentKeys(fileStatements.flat(), fileTexts))
}
