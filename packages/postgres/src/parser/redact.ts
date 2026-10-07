import { sha256Hex } from '@exponetdb/kernel/hash'
import { isLiteral, type LexMode, lex, type Token } from './lexer.ts'
import type { SupportedMajor } from './majors.ts'
import { type JsonNode, loadParser, names, nodeType, parseWith, walk } from './parse.ts'

/**
 * Statement redaction ([statement-redaction.md](../../../../exponetdb-docs/03-database-model/statement-redaction.md)):
 * every statement text is redacted before it leaves the component that read
 * it, and the redacted form is the default everywhere.
 *
 * 1. **Parse-based** (`mode: parse`): the text parses with the target's
 *    grammar; every literal token becomes `$n` (numbered after the highest
 *    parameter already in the text), comments are removed, identifiers and
 *    keywords stay. Each constant of the parse tree must sit on a literal
 *    token the lexer found; if one does not, the parse result is not trusted
 *    and the lexical path runs instead.
 * 2. **Sensitive commands** (`mode: summary`), whatever the parse outcome:
 *    role passwords, user mappings, foreign server options, settings named
 *    like secrets, `COPY … PROGRAM`, `set_config` of such a setting: a fixed
 *    summary replaces the statement.
 * 3. **Lexical** (`mode: lexical`): the text does not parse (most often it
 *    was cut at `track_activity_query_size`), or the two string modes
 *    disagree about where a literal is: the text is lexed both with
 *    `standard_conforming_strings` on and off, and every character that is
 *    inside a literal under either reading becomes part of a `$?` (inside a
 *    comment under either, it is dropped). A backslash before a quote can
 *    end a literal in one reading and not in the other, so neither reading
 *    alone is safe (`'C:\', 'secret'` flips every later literal).
 * 4. **Unparseable** (`mode: unparseable`): text that is not well-formed
 *    Unicode becomes a fixed marker with the digest.
 * 5. A length cap after redaction (2,000 characters by default, 500 for MCP)
 *    with `truncated`.
 *
 * Long runs of constants (`IN ($1, $2, …)`) are shortened to the first five
 * and an ellipsis.
 */
export type RedactionMode = 'parse' | 'lexical' | 'summary' | 'unparseable'

export interface RedactedStatement {
  readonly text: string
  readonly mode: RedactionMode
  readonly truncated: boolean
  /** `sha256:<hex>` of the redacted text before the length cap. */
  readonly digest: string
}

export interface RedactOptions {
  /** Grammar to parse with (the target's major). */
  readonly major: SupportedMajor
  readonly maxLength?: number
}

export const DEFAULT_MAX_LENGTH = 2000
export const MCP_MAX_LENGTH = 500
const RUN_KEEP = 5
const SECRET_NAME = /pass(word|wd)?|secret|token|key|credential|private/i

function digest(text: string): string {
  return `sha256:${sha256Hex(text)}`
}

function finish(text: string, mode: RedactionMode, maxLength: number): RedactedStatement {
  const full = text.trim()
  const truncated = full.length > maxLength
  return {
    text: truncated ? full.slice(0, maxLength) : full,
    mode,
    truncated,
    digest: digest(full),
  }
}

function defNames(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    const n = nodeType(item)
    return n?.type === 'DefElem' && typeof n.body['defname'] === 'string' ? [n.body['defname']] : []
  })
}

/** A fixed summary for a sensitive statement, or undefined. */
function sensitiveSummary(type: string, node: JsonNode): string | undefined {
  switch (type) {
    case 'CreateRoleStmt':
    case 'AlterRoleStmt':
      return defNames(node['options']).includes('password')
        ? `${type === 'CreateRoleStmt' ? 'CREATE' : 'ALTER'} ROLE <name> PASSWORD <redacted>`
        : undefined
    case 'CreateUserMappingStmt':
      return 'CREATE USER MAPPING <redacted>'
    case 'AlterUserMappingStmt':
      return 'ALTER USER MAPPING <redacted>'
    case 'CreateForeignServerStmt':
    case 'AlterForeignServerStmt':
      return defNames(node['options']).length > 0
        ? `${type === 'CreateForeignServerStmt' ? 'CREATE' : 'ALTER'} SERVER <name> OPTIONS <redacted>`
        : undefined
    case 'CopyStmt':
      return node['is_program'] === true ? 'COPY <redacted> PROGRAM <redacted>' : undefined
    case 'VariableSetStmt': {
      const name = node['name']
      return typeof name === 'string' && SECRET_NAME.test(name)
        ? 'SET <setting> <redacted>'
        : undefined
    }
    case 'AlterSystemStmt':
    case 'AlterRoleSetStmt':
    case 'AlterDatabaseSetStmt': {
      const set = nodeType(node['setstmt'])
      const name = set?.body['name']
      return typeof name === 'string' && SECRET_NAME.test(name)
        ? 'ALTER … SET <setting> <redacted>'
        : undefined
    }
    default:
      return undefined
  }
}

/** `set_config('<secret-like name>', …)` anywhere in a statement. */
function setsSecret(node: unknown): boolean {
  let found = false
  walk(node, (type, body) => {
    if (found) return false
    if (type === 'FuncCall') {
      const parts = names(body['funcname'])
      if (parts?.[parts.length - 1] === 'set_config') {
        const first = Array.isArray(body['args']) ? nodeType(body['args'][0]) : undefined
        const value = first?.type === 'A_Const' ? first.body['sval'] : undefined
        const s =
          typeof value === 'object' && value !== null ? (value as JsonNode)['sval'] : undefined
        if (typeof s !== 'string' || SECRET_NAME.test(s)) found = true
      }
    }
    return true
  })
  return found
}

/** The lexical form of the sensitive classes (when the text does not parse). */
function lexicalSensitive(tokens: readonly Token[], text: string): boolean {
  const words = tokens
    .filter((t) => t.kind === 'ident' || t.kind === 'qident')
    .map((t) => text.slice(t.start, t.end).toLowerCase())
  const has = (w: string) => words.includes(w)
  if ((has('role') || has('user') || has('group')) && has('password')) return true
  if (has('user') && has('mapping')) return true
  if (has('server') && has('options')) return true
  if (has('copy') && has('program')) return true
  if ((has('set') || has('set_config')) && words.some((w) => SECRET_NAME.test(w))) return true
  return false
}

function maxParam(tokens: readonly Token[], text: string): number {
  let max = 0
  for (const t of tokens) {
    if (t.kind === 'param') max = Math.max(max, Number(text.slice(t.start + 1, t.end)) || 0)
  }
  return max
}

/**
 * For each token, the index of the next token for which `significant` holds
 * (`tokens.length` if none): one backward pass, so lookahead stays linear
 * however many constants a statement has.
 */
function nextIndexes(tokens: readonly Token[], significant: (t: Token) => boolean): Int32Array {
  const next = new Int32Array(tokens.length + 1)
  next[tokens.length] = tokens.length
  for (let k = tokens.length - 1; k >= 0; k--) {
    const following = tokens[k + 1]
    next[k] =
      following !== undefined && significant(following) ? k + 1 : (next[k + 1] ?? tokens.length)
  }
  return next
}

/**
 * Rebuilds the text: literals (and the word tokens in `hiddenWords`, constants
 * written as bare or quoted words) → placeholders, comments → space,
 * whitespace collapsed, long runs cut.
 */
function render(
  tokens: readonly Token[],
  text: string,
  placeholder: (i: number) => string,
  hiddenWords: ReadonlySet<number> = new Set(),
): string {
  const hidden = (k: number) => {
    const t = tokens[k]
    return t !== undefined && (isLiteral(t) || hiddenWords.has(k))
  }
  const next = nextIndexes(tokens, (t) => t.kind !== 'space' && t.kind !== 'comment')
  let out = ''
  let literalIndex = 0
  let run = 0
  let skipping = false
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token
    if (t.kind === 'space' || t.kind === 'comment') {
      if (!skipping && !out.endsWith(' ')) out += ' '
      continue
    }
    if (hidden(k)) {
      literalIndex++
      run++
      if (run > RUN_KEEP) {
        if (!skipping) {
          out += '...'
          skipping = true
        }
        continue
      }
      out += placeholder(literalIndex)
      continue
    }
    const piece = text.slice(t.start, t.end)
    if (piece === ',' && run > 0) {
      // A comma inside a run of constants keeps the run going.
      if (hidden(next[k] ?? tokens.length)) {
        if (!skipping) out += ','
        continue
      }
    }
    run = 0
    skipping = false
    out += piece
  }
  return out
}

/**
 * Tokens of the text under both string modes at once: a character inside a
 * literal under either reading is literal, otherwise inside a comment under
 * either reading is comment; what neither reading hides is lexed again on
 * its own (which can only find more literals, never fewer).
 */
function unionTokens(
  text: string,
  standard: readonly Token[],
  conservative: readonly Token[],
): Token[] {
  const cls = new Uint8Array(text.length)
  for (const t of [...standard, ...conservative]) {
    const v = isLiteral(t) ? 2 : t.kind === 'comment' ? 1 : 0
    if (v === 0) continue
    for (let i = t.start; i < t.end; i++) {
      if ((cls[i] ?? 0) < v) cls[i] = v
    }
  }
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const v = cls[i] ?? 0
    let j = i + 1
    while (j < text.length && cls[j] === v) j++
    if (v === 2) out.push({ kind: 'string', start: i, end: j })
    else if (v === 1) out.push({ kind: 'comment', start: i, end: j })
    else {
      for (const t of lex(text.slice(i, j), 'standard')) {
        out.push({ ...t, start: t.start + i, end: t.end + i })
      }
    }
    i = j
  }
  return out
}

/** Whether every literal character of `other` is inside a literal or comment of `base`. */
function covered(text: string, base: readonly Token[], other: readonly Token[]): boolean {
  const hidden = new Uint8Array(text.length)
  for (const t of base) {
    if (!isLiteral(t) && t.kind !== 'comment') continue
    hidden.fill(1, t.start, t.end)
  }
  return other.every((t) => !isLiteral(t) || hidden.subarray(t.start, t.end).every((h) => h === 1))
}

function lexical(text: string, maxLength: number): RedactedStatement {
  const standard = lex(text, 'standard')
  const conservative = lex(text, 'conservative')
  const tokens = unionTokens(text, standard, conservative)
  if (
    lexicalSensitive(standard, text) ||
    lexicalSensitive(conservative, text) ||
    lexicalSensitive(tokens, text)
  ) {
    return finish('<statement redacted: sensitive command>', 'summary', maxLength)
  }
  return finish(
    render(tokens, text, () => '$?', settingValueWords(tokens, text)),
    'lexical',
    maxLength,
  )
}

/**
 * Without a parse tree, the words after `SET … =` or `SET … TO` up to the end
 * of the statement may be a setting's value written without quotes (`SET`,
 * `ALTER SYSTEM`, `ALTER ROLE`, `ALTER DATABASE`, `CREATE FUNCTION … SET`):
 * they are hidden like literals. The one exception is the `SET` of an
 * `UPDATE` (also `ON CONFLICT DO UPDATE` and `MERGE … UPDATE`), whose column
 * names stay readable: a `SET` with the word `UPDATE` between it and the
 * previous `SET` or the start of the statement. Anything else, a misspelled
 * or quoted keyword included, fails closed.
 */
function settingValueWords(tokens: readonly Token[], text: string): Set<number> {
  const out = new Set<number>()
  let updateSinceSet = false
  let afterSet = false
  let inValue = false
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token
    const word = text.slice(t.start, t.end)
    if (word === ';') {
      updateSinceSet = false
      afterSet = false
      inValue = false
      continue
    }
    const keyword = t.kind === 'ident' ? word.toLowerCase() : undefined
    if (keyword === 'update') updateSinceSet = true
    if (keyword === 'set') {
      if (!updateSinceSet) afterSet = true
      updateSinceSet = false
      continue
    }
    if (
      afterSet &&
      !inValue &&
      (word === '=' || (t.kind === 'ident' && word.toLowerCase() === 'to'))
    ) {
      inValue = true
      continue
    }
    if (inValue && (t.kind === 'ident' || t.kind === 'qident')) out.add(k)
  }
  return out
}

/** Redacts one statement text (the parser of `options.major` must be loaded). */
export function redactStatementSync(text: string, options: RedactOptions): RedactedStatement {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  if (!text.isWellFormed()) {
    return finish(`<statement redacted: unparseable> ${digest(text)}`, 'unparseable', maxLength)
  }
  const parsed = parseWith(options.major, text)
  if (!parsed.ok) {
    return lexical(text.replaceAll('\u0000', ' '), maxLength)
  }
  const summaries: string[] = []
  for (const stmt of parsed.statements) {
    const summary =
      sensitiveSummary(stmt.type, stmt.node) ??
      (setsSecret(stmt.node) ? 'SELECT set_config(<setting>, <redacted>, …)' : undefined)
    if (summary !== undefined) summaries.push(summary)
  }
  if (summaries.length > 0) {
    return finish(summaries.join('; '), 'summary', maxLength)
  }
  const mode: LexMode = 'standard'
  const tokens = lex(text, mode)
  // Every constant of the tree must lie on a literal token (or on the minus of a negative one).
  const tokenAt = (position: number): number | undefined => {
    let lo = 0
    let hi = tokens.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const t = tokens[mid] as Token
      if (position < t.start) hi = mid - 1
      else if (position >= t.end) lo = mid + 1
      else return mid
    }
    return undefined
  }
  const nextNonSpace = nextIndexes(tokens, (t) => t.kind !== 'space')
  // Constants written as words (`SET app.claims = hunter2`, `SET x TO "v"`): the
  // parse tree says they are values, so they are hidden like literals.
  const wordConstants = new Set<number>()
  let consistent = tokens.every((t) => t.unterminated !== true)
  for (const stmt of parsed.statements) {
    walk({ [stmt.type]: stmt.node }, (type, body) => {
      if (!consistent) return false
      if (type === 'A_Const' && typeof body['location'] === 'number' && body['location'] >= 0) {
        const index = tokenAt(parsed.indexOf(body['location']))
        const token = index === undefined ? undefined : tokens[index]
        const after = index === undefined ? undefined : tokens[nextNonSpace[index] ?? tokens.length]
        const word = token === undefined ? '' : text.slice(token.start, token.end)
        if (
          index !== undefined &&
          token !== undefined &&
          (token.kind === 'ident' || token.kind === 'qident') &&
          !(token.kind === 'ident' && /^(null|true|false)$/i.test(word))
        ) {
          wordConstants.add(index)
          return true
        }
        const ok =
          token !== undefined &&
          (isLiteral(token) ||
            (token.kind === 'op' && word === '-' && after !== undefined && isLiteral(after)) ||
            // `NULL`, `TRUE`, `FALSE` are A_Const without a literal token: nothing to hide.
            (token.kind === 'ident' && /^(null|true|false)$/i.test(word)))
        if (!ok) consistent = false
      }
      return true
    })
  }
  // The parse assumed standard_conforming_strings = on; a session with it off reads a
  // backslash before a quote differently. Where that reading finds a literal the standard
  // one would print, the statement is redacted under both readings instead.
  if (!consistent || !covered(text, tokens, lex(text, 'conservative'))) {
    return lexical(text, maxLength)
  }
  const base = maxParam(tokens, text)
  return finish(
    render(tokens, text, (i) => `$${base + i}`, wordConstants),
    'parse',
    maxLength,
  )
}

export async function redactStatement(
  text: string,
  options: RedactOptions,
): Promise<RedactedStatement> {
  await loadParser(options.major)
  return redactStatementSync(text, options)
}
