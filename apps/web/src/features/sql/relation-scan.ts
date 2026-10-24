/**
 * A scan of the relations a statement names, for column completion only
 * (`u.` after `FROM users u`). It reads the text the person is typing, which
 * may be incomplete and is never trusted: it decides what to suggest, not what
 * may run. Nothing here classifies, admits or refuses a statement; the server
 * parses and admits every text that is sent.
 *
 * The scan is deliberately small: comments and string literals are skipped,
 * `FROM`, `JOIN`, `UPDATE`, `INTO` and `USING` introduce a relation with an
 * optional alias, a comma continues a `FROM` list, and a subquery, a function
 * call or a CTE name is not a relation. What it cannot see, it does not
 * resolve, and the person gets no column suggestions rather than wrong ones.
 */

/** A relation named in the text. Names are folded the way PostgreSQL folds them. */
export interface RelationRef {
  /** The schema, when the text qualifies the relation with one. */
  readonly schema: string | undefined
  readonly name: string
  readonly alias: string | undefined
}

/** A relation by name, as a qualifier resolves to it. */
export interface RelationName {
  readonly schema: string | undefined
  readonly name: string
}

interface Ident {
  readonly kind: 'ident'
  /** As written, without the quotes of a quoted identifier. */
  readonly value: string
  /** As PostgreSQL reads it: lower case unless quoted. */
  readonly folded: string
  readonly quoted: boolean
}
interface Punct {
  readonly kind: 'punct'
  readonly value: '.' | ',' | '(' | ')'
}
interface Other {
  readonly kind: 'other'
}
type Token = Ident | Punct | Other

const OTHER: Other = { kind: 'other' }
const IDENT_START = /[\p{L}_]/u
const IDENT_PART = /[\p{L}\p{N}_$]/u
const DOLLAR_TAG = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u

/** Words that cannot be an alias without `AS`. */
const NOT_ALIAS: ReadonlySet<string> = new Set([
  'where',
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'group',
  'order',
  'limit',
  'offset',
  'fetch',
  'union',
  'intersect',
  'except',
  'having',
  'window',
  'for',
  'returning',
  'set',
  'values',
  'select',
  'from',
  'tablesample',
  'lateral',
  'and',
  'or',
  'not',
  'is',
  'in',
  'as',
  'when',
  'then',
  'else',
  'end',
  'with',
  'into',
  'do',
  'partition',
  'over',
  'filter',
  'within',
  'only',
])

/** Words after which a relation is named. */
const INTRODUCERS: ReadonlySet<string> = new Set(['from', 'join', 'update', 'into', 'using'])
/** Introducers that continue with a comma-separated list of relations. */
const LISTS: ReadonlySet<string> = new Set(['from', 'using'])

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (/\s/.test(ch)) {
      i += 1
    } else if (ch === '-' && text.charAt(i + 1) === '-') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end + 1
    } else if (ch === '/' && text.charAt(i + 1) === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (ch === "'") {
      i += 1
      while (i < text.length) {
        if (text.charAt(i) === "'") {
          if (text.charAt(i + 1) === "'") i += 2
          else break
        } else {
          i += 1
        }
      }
      i += 1
      tokens.push(OTHER)
    } else if (ch === '$' && DOLLAR_TAG.test(text.slice(i))) {
      const tag = DOLLAR_TAG.exec(text.slice(i))?.[0] ?? '$$'
      const end = text.indexOf(tag, i + tag.length)
      i = end < 0 ? text.length : end + tag.length
      tokens.push(OTHER)
    } else if (ch === '"') {
      let value = ''
      i += 1
      while (i < text.length) {
        if (text.charAt(i) === '"') {
          if (text.charAt(i + 1) === '"') {
            value += '"'
            i += 2
          } else {
            break
          }
        } else {
          value += text.charAt(i)
          i += 1
        }
      }
      i += 1
      tokens.push({ kind: 'ident', value, folded: value, quoted: true })
    } else if (IDENT_START.test(ch)) {
      let end = i + 1
      while (end < text.length && IDENT_PART.test(text.charAt(end))) end += 1
      const value = text.slice(i, end)
      tokens.push({ kind: 'ident', value, folded: value.toLowerCase(), quoted: false })
      i = end
    } else if (ch === '.' || ch === ',' || ch === '(' || ch === ')') {
      tokens.push({ kind: 'punct', value: ch })
      i += 1
    } else {
      tokens.push(OTHER)
      i += 1
    }
  }
  return tokens
}

function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === 'ident' && !token.quoted && token.folded === word
}

function isPunct(token: Token | undefined, value: Punct['value']): boolean {
  return token?.kind === 'punct' && token.value === value
}

/** The index after the parenthesis that closes the one at `open`; the end of the tokens when it never closes. */
function afterParens(tokens: readonly Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], '(')) depth += 1
    else if (isPunct(tokens[i], ')')) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return tokens.length
}

/** Names of the common table expressions of a statement that starts with `WITH`. */
function cteNames(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>()
  if (!isWord(tokens[0], 'with')) return names
  let depth = 0
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (isPunct(token, '(')) depth += 1
    else if (isPunct(token, ')')) depth -= 1
    else if (depth === 0 && isWord(token, 'as')) {
      let next = i + 1
      if (isWord(tokens[next], 'not')) next += 1
      if (isWord(tokens[next], 'materialized')) next += 1
      if (!isPunct(tokens[next], '(')) continue
      let nameAt = i - 1
      if (isPunct(tokens[nameAt], ')')) {
        let nesting = 0
        while (nameAt >= 0) {
          if (isPunct(tokens[nameAt], ')')) nesting += 1
          else if (isPunct(tokens[nameAt], '(')) {
            nesting -= 1
            if (nesting === 0) break
          }
          nameAt -= 1
        }
        nameAt -= 1
      }
      const named = tokens[nameAt]
      if (named?.kind === 'ident') names.add(named.folded)
    }
  }
  return names
}

interface Scan {
  readonly tokens: readonly Token[]
  readonly ctes: ReadonlySet<string>
  readonly refs: RelationRef[]
}

/** An optional `[AS] alias [(column aliases)]` at `start`: the alias (folded) and where the text goes on. */
function readAlias(
  tokens: readonly Token[],
  start: number,
): { readonly alias: string | undefined; readonly next: number } {
  const aliasAt = isWord(tokens[start], 'as') ? start + 1 : start
  const candidate = tokens[aliasAt]
  if (
    candidate?.kind !== 'ident' ||
    (aliasAt === start && !candidate.quoted && NOT_ALIAS.has(candidate.folded))
  ) {
    return { alias: undefined, next: start }
  }
  const after = aliasAt + 1
  return {
    alias: candidate.folded,
    next: isPunct(tokens[after], '(') ? afterParens(tokens, after) : after,
  }
}

/**
 * Reads `[schema.]name [[AS] alias]` at `start` into `scan.refs` and returns
 * where the text goes on. A subquery or a function call is no relation of its
 * own: what is inside its parentheses is scanned (a cursor may be in there),
 * its alias is skipped so a list can go on. After `INTO` a parenthesis is the
 * column list of the relation, not a call.
 */
function readRelation(scan: Scan, start: number, intoList: boolean): number {
  const { tokens } = scan
  let i = start
  while (isWord(tokens[i], 'only') || isWord(tokens[i], 'lateral')) i += 1
  const first = tokens[i]
  if (isPunct(first, '(')) return skipCall(scan, i)
  // A keyword here (`DO UPDATE SET`, `INSERT INTO t SELECT`) names no relation.
  if (first?.kind !== 'ident' || (!first.quoted && NOT_ALIAS.has(first.folded))) return i
  const parts: Ident[] = [first]
  i += 1
  while (isPunct(tokens[i], '.') && tokens[i + 1]?.kind === 'ident') {
    parts.push(tokens[i + 1] as Ident)
    i += 2
  }
  // A function call (`generate_series(1, 3) g`) is not a relation either.
  if (isPunct(tokens[i], '(') && !intoList) return skipCall(scan, i)
  const last = parts[parts.length - 1] as Ident
  const schema = parts.length >= 2 ? (parts[parts.length - 2] as Ident).folded : undefined
  const { alias, next } = readAlias(tokens, i)
  const isCte = schema === undefined && scan.ctes.has(last.folded)
  if (!isCte) scan.refs.push({ schema, name: last.folded, alias })
  return isPunct(tokens[next], '(') ? afterParens(tokens, next) : next
}

/** Scans inside the parentheses at `open` and returns the index after them and after an alias that follows. */
function skipCall(scan: Scan, open: number): number {
  const close = afterParens(scan.tokens, open)
  scanRange(scan, open + 1, close - 1)
  return readAlias(scan.tokens, close).next
}

function scanRange(scan: Scan, start: number, end: number): void {
  const { tokens } = scan
  let i = start
  while (i < end) {
    const token = tokens[i]
    if (token?.kind === 'ident' && !token.quoted && INTRODUCERS.has(token.folded)) {
      const list = LISTS.has(token.folded)
      const into = token.folded === 'into'
      i += 1
      for (;;) {
        i = Math.max(readRelation(scan, i, into), i)
        if (list && i < end && isPunct(tokens[i], ',')) {
          i += 1
          continue
        }
        break
      }
    } else {
      i += 1
    }
  }
}

/** The relations a statement names in `FROM`, `JOIN`, `UPDATE`, `INTO` and `USING`, in text order. */
export function relationReferences(statement: string): RelationRef[] {
  const tokens = tokenize(statement)
  const scan: Scan = { tokens, ctes: cteNames(tokens), refs: [] }
  scanRange(scan, 0, tokens.length)
  return scan.refs
}

/**
 * The relation a qualifier stands for. One part is an alias, or the name of a
 * relation that has no alias (PostgreSQL does not let the name through once
 * there is one); two parts are a schema and a relation. Any other qualifier
 * (or a name nothing in the statement matches) resolves to nothing.
 */
export function resolveQualifier(
  refs: readonly RelationRef[],
  qualifier: readonly string[],
): RelationName | undefined {
  if (qualifier.length === 2) {
    const [schema, name] = qualifier
    if (schema === undefined || name === undefined || schema === '' || name === '') return undefined
    return { schema: schema.toLowerCase(), name: name.toLowerCase() }
  }
  if (qualifier.length !== 1) return undefined
  const [typed] = qualifier
  if (typed === undefined || typed === '') return undefined
  const q = typed.toLowerCase()
  const hit =
    refs.find((ref) => ref.alias === q) ??
    refs.find((ref) => ref.alias === undefined && ref.name === q)
  return hit === undefined ? undefined : { schema: hit.schema, name: hit.name }
}
