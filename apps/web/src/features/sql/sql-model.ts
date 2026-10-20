import type { SqlClassification, SqlPosition } from '@exponetdb/sdk/operations'
import type { SqlDiagnostic, SqlDiagnosticSeverity } from '@exponetdb/ui-data'
import { codePointLabel, isInvisible } from '@exponetdb/ui-patterns'

/**
 * The pure part of the SQL workspace (information-architecture.md §4): the
 * query tabs and their storage, the deep-link reader, the mapping of the
 * server's classification onto the editor, and the text of a migration
 * bundle draft. Nothing here decides what may run: the server's admission
 * does (sql-execution-security.md §2.1); the classification is shown, never
 * turned into a promise of safety.
 */

export type SqlMode = 'query' | 'draft'

/**
 * Where the text of a tab came from. A tab opened from a link, the history, a
 * saved query or a template never runs on opening.
 */
export type TabOrigin = 'new' | 'link' | 'history' | 'saved' | 'template'

export const SQL_MODES: readonly SqlMode[] = ['query', 'draft']
export const TAB_ORIGINS: readonly TabOrigin[] = ['new', 'link', 'history', 'saved', 'template']

export interface SavedRef {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly visibility: 'personal' | 'project'
  readonly owned: boolean
}

export interface SqlTab {
  readonly id: string
  readonly mode: SqlMode
  readonly sql: string
  readonly origin: TabOrigin
  /** The saved query this tab holds, when it was opened from one or saved. */
  readonly saved?: SavedRef
}

export interface TabsState {
  readonly tabs: readonly SqlTab[]
  readonly active: string
}

/** The most tabs one target keeps; opening one more closes the oldest. */
export const MAX_TABS = 20
/** The longest text a tab keeps in storage (a longer one lives for the page only). */
export const MAX_STORED_SQL = 65_536
/** The longest text a `?sql=` link may open. A longer one is not opened at all, never shortened. */
export const LINK_MAX_CHARS = 16_384
/** The classification endpoint's bound, in UTF-8 bytes (sql-execution-security.md §2.5). */
export const CLASSIFY_MAX_BYTES = 65_536
/** The longest text a data read takes (`QueryRequest.sql`). */
export const QUERY_MAX_CHARS = 100_000

let counter = 0

export function newTabId(): string {
  counter += 1
  return `tab-${Date.now().toString(36)}-${counter}`
}

export function newTab(
  mode: SqlMode,
  sql = '',
  origin: TabOrigin = 'new',
  saved?: SavedRef,
): SqlTab {
  return { id: newTabId(), mode, sql, origin, ...(saved === undefined ? {} : { saved }) }
}

/** Adds a tab and makes it active; the oldest tabs leave beyond `MAX_TABS`. */
export function addTab(state: TabsState, tab: SqlTab): TabsState {
  const tabs = [...state.tabs, tab]
  return { tabs: tabs.slice(Math.max(0, tabs.length - MAX_TABS)), active: tab.id }
}

/** Closes a tab; the last tab is replaced by an empty one, so there is always a tab. */
export function closeTab(state: TabsState, id: string, mode: SqlMode): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) {
    const fresh = newTab(mode)
    return { tabs: [fresh], active: fresh.id }
  }
  if (state.active !== id) return { tabs, active: state.active }
  const next = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, active: next?.id ?? tabs[0]?.id ?? '' }
}

export function updateTab(state: TabsState, id: string, change: Partial<SqlTab>): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)),
  }
}

/**
 * Carries a rename or a change of visibility to the open tabs that hold the
 * same saved query. A tab takes the new name and visibility; it takes the new
 * revision only when it was based on the revision the change was made
 * against, so a tab based on an older one still meets the conflict when it
 * saves (its text was never merged).
 */
export function applySavedChange(
  state: TabsState,
  before: { readonly id: string; readonly revision: number },
  after: Pick<SavedRef, 'id' | 'name' | 'visibility' | 'revision'>,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      const saved = tab.saved
      if (saved === undefined || saved.id !== before.id) return tab
      return {
        ...tab,
        saved: {
          ...saved,
          name: after.name,
          visibility: after.visibility,
          revision: saved.revision === before.revision ? after.revision : saved.revision,
        },
      }
    }),
  }
}

export function activeTab(state: TabsState): SqlTab {
  const found = state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0]
  return found ?? newTab('query')
}

// --- Deep links: `?sql=` and `?mode=draft` open text and never run it. ------------------------

export type LinkedSql =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly sql: string }
  | { readonly kind: 'too_long'; readonly length: number }

export interface SqlLink {
  readonly mode: SqlMode | undefined
  readonly sql: LinkedSql
}

/**
 * Reads the raw query string of the page as plain strings (never through the
 * router's JSON reading). `mode` is `query` or `draft`, anything else is
 * ignored; `sql` is text that is opened in a new tab and never run. A text
 * longer than `LINK_MAX_CHARS` is not opened at all.
 */
export function parseSqlLink(search: string): SqlLink {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  } catch {
    return { mode: undefined, sql: { kind: 'none' } }
  }
  const rawMode = params.get('mode')
  const mode = SQL_MODES.find((m) => m === rawMode)
  const sql = params.get('sql')
  if (sql === null || sql.length === 0) return { mode, sql: { kind: 'none' } }
  if (sql.length > LINK_MAX_CHARS) return { mode, sql: { kind: 'too_long', length: sql.length } }
  return { mode, sql: { kind: 'text', sql: normalizeBreaks(sql) } }
}

export function normalizeBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The text with every hidden, control or direction character (line breaks and
 * tabs excepted) written as its code point, `⟨U+202E⟩`: what a server message
 * shows, so a message can never reorder or hide what is read.
 */
export function markHidden(text: string): string {
  let out = ''
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    out += char !== '\n' && char !== '\t' && isInvisible(point) ? codePointLabel(point) : char
  }
  return out
}

/** How many hidden, control or direction characters the text holds (the editor shows each as its code point). */
export function hiddenCharacterCount(text: string): number {
  let count = 0
  for (const char of text) {
    if (char === '\n' || char === '\t') continue
    if (isInvisible(char.codePointAt(0) ?? 0)) count += 1
  }
  return count
}

export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

// --- Saved query names and failed runs. ----------------------------------------------------

/** The longest name of a saved query, in code points (`SavedQuery.name`). */
export const SAVED_NAME_MAX = 120

export type SavedNameCheck = 'ok' | 'empty' | 'too_long'

/** The name rules of the save and rename dialogs; the server checks the name again. */
export function checkSavedName(name: string): SavedNameCheck {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'empty'
  return [...trimmed].length > SAVED_NAME_MAX ? 'too_long' : 'ok'
}

/**
 * The name of a copy: the name with the suffix, cut (by code points, in the
 * name) so the result still fits the name rules.
 */
export function copyName(name: string, suffix: (name: string) => string): string {
  const whole = suffix(name)
  if ([...whole].length <= SAVED_NAME_MAX) return whole
  const overshoot = [...whole].length - SAVED_NAME_MAX
  const kept = [...name].slice(0, Math.max(0, [...name].length - overshoot)).join('')
  return suffix(kept)
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * The SQLSTATE a failed data read carries: `details.sqlstate` of a
 * `QUERY_FAILED` problem, only when it has the five characters of a SQLSTATE.
 * Anything else, and every other code, has none (the page shows nothing the
 * server did not send).
 */
export function sqlstateOf(code: string, details: unknown): string | undefined {
  if (code !== 'QUERY_FAILED' || typeof details !== 'object' || details === null) return undefined
  const value: unknown = 'sqlstate' in details ? details.sqlstate : undefined
  return typeof value === 'string' && SQLSTATE.test(value) ? value : undefined
}

// --- Which text a run sends. ---------------------------------------------------------------

/** What a run sent: all of the text, the selected text, or one statement of several. */
export type RunScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'selection' }
  | {
      readonly kind: 'statement'
      /** 1-based position of the statement among `count`. */
      readonly n: number
      readonly count: number
      /** The line the statement starts on. */
      readonly line: number
    }

export interface StatementPick {
  readonly scope: Extract<RunScope, { kind: 'statement' }>
  /** The statement's own text, sliced by the server's offsets. */
  readonly text: string
}

/**
 * The statement under the cursor of a text the server classified into several
 * statements, by the offsets of that classification (UTF-16, as the editor
 * counts). `result` must be the classification of exactly `text`. A cursor
 * inside a statement, at its end or just after its semicolon is in it; a
 * cursor in the white space or comments between statements takes the
 * statement before it, or the first when none is. A single statement and a
 * text that did not parse pick nothing: the whole text is sent and the
 * server decides.
 *
 * This chooses which text to send, nothing more. It is never a safety
 * decision: the server classifies and admits what is sent.
 */
export function statementAtCursor(
  text: string,
  result: SqlClassification,
  offset: number,
): StatementPick | undefined {
  if (result.status !== 'parsed' || result.statements.length < 2) return undefined
  const { statements } = result
  const at = Math.min(Math.max(0, Math.trunc(offset)), text.length)
  let chosen: ClassifiedStatement | undefined
  for (const statement of statements) {
    const reach = statement.end.offset + (text.charAt(statement.end.offset) === ';' ? 1 : 0)
    if (at >= statement.start.offset && at <= reach) {
      chosen = statement
      break
    }
  }
  if (chosen === undefined) {
    for (const statement of statements) if (statement.end.offset <= at) chosen = statement
  }
  chosen ??= statements[0]
  if (chosen === undefined) return undefined
  const sliced = statementText(text, chosen.start, chosen.end).trim()
  if (sliced.length === 0) return undefined
  return {
    scope: {
      kind: 'statement',
      n: statements.indexOf(chosen) + 1,
      count: statements.length,
      line: lineColumnAt(text, chosen.start.offset).line,
    },
    text: sliced,
  }
}

// --- Classification on the editor. ---------------------------------------------------------

export type StatementClass = SqlClassification['statements'][number]['classes'][number]
export type ClassifiedStatement = SqlClassification['statements'][number]

/** UTF-8 size of a text, as the classification endpoint counts it. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function postgresMajorOf(version: string | null | undefined): 16 | 17 | 18 | undefined {
  if (typeof version !== 'string') return undefined
  const major = Number.parseInt(version, 10)
  return major === 16 || major === 17 || major === 18 ? major : undefined
}

/** A 1-based line and a 1-based column in UTF-16 code units (the editor's units) of an offset. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const at = Math.min(Math.max(0, Math.trunc(offset)), text.length)
  let line = 1
  let lineStart = 0
  for (let i = 0; i < at; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1
      lineStart = i + 1
    }
  }
  return { line, column: at - lineStart + 1 }
}

/** The text of one statement, sliced by the server's UTF-16 offsets. */
export function statementText(text: string, start: SqlPosition, end: SqlPosition): string {
  return text.slice(Math.max(0, start.offset), Math.max(start.offset, end.offset))
}

const SERIOUS: readonly StatementClass[] = [
  'write',
  'destructive',
  'rewrite',
  'non_transactional',
  'security',
]

/**
 * How a statement is marked in the gutter: a statement with a class that
 * changes something is a warning; a statement with no class at all (or one the
 * analysis cannot see into) is a warning too, because the absence of a class
 * is never a statement of safety; only a statement the read path admits is
 * informational.
 */
export function statementSeverity(statement: ClassifiedStatement): SqlDiagnosticSeverity {
  if (statement.classes.some((c) => SERIOUS.includes(c))) return 'warning'
  if (statement.classes.length === 0 || statement.procedural) return 'warning'
  return 'info'
}

/** The words of a class, for the editor's finding list (the badges carry their own). */
export const CLASS_WORDS: Readonly<Record<StatementClass, string>> = {
  read_only: 'read-only',
  write: 'write',
  destructive: 'destructive',
  rewrite: 'rewrite',
  non_transactional: 'non-transactional',
  security: 'security',
}

export interface DiagnosticTexts {
  readonly statement: (index: number, label: string, classes: string) => string
  readonly noClass: string
  readonly parseError: string
}

/**
 * The findings the editor marks for a classification of exactly `text`: one per
 * statement over its range, and the parse error at its position. A result for
 * another text marks nothing (its offsets would point elsewhere).
 */
export function classificationDiagnostics(
  text: string,
  classifiedText: string,
  result: SqlClassification,
  words: DiagnosticTexts,
): SqlDiagnostic[] {
  if (classifiedText !== text) return []
  const out: SqlDiagnostic[] = []
  if (result.status === 'parse_error') {
    const position = result.parseError?.position
    if (position !== null && position !== undefined) {
      const at = lineColumnAt(text, position.offset)
      out.push({ line: at.line, column: at.column, severity: 'error', message: words.parseError })
    }
    return out
  }
  for (const statement of result.statements) {
    const from = lineColumnAt(text, statement.start.offset)
    const to = lineColumnAt(text, statement.end.offset)
    const classes =
      statement.classes.length === 0
        ? words.noClass
        : statement.classes.map((c) => CLASS_WORDS[c] ?? String(c)).join(', ')
    out.push({
      line: from.line,
      column: from.column,
      endLine: to.line,
      endColumn: to.column,
      severity: statementSeverity(statement),
      message: words.statement(statement.index + 1, statement.label, classes),
    })
  }
  return out
}

/**
 * What the classification says about running the text in Query mode. `write`:
 * the parser refuses it as not read-only, or a statement has the `write`
 * class: the page does not send it as a query and offers a draft instead.
 * Anything else (admitted, refused for another reason, not classified) is sent
 * and the server decides.
 */
export type QueryVerdict =
  | { readonly kind: 'write'; readonly classes: readonly StatementClass[] }
  | { readonly kind: 'other' }

export function queryVerdict(result: SqlClassification): QueryVerdict {
  if (result.status !== 'parsed') return { kind: 'other' }
  const classes = new Set<StatementClass>()
  let write = result.readOnlyPath.refusal?.code === 'QUERY_NOT_READ_ONLY'
  for (const statement of result.statements) {
    if (statement.classes.includes('write')) write = true
    if (statement.readOnlyRefusal?.code === 'QUERY_NOT_READ_ONLY') write = true
    for (const c of statement.classes) if (c !== 'read_only') classes.add(c)
  }
  return write ? { kind: 'write', classes: [...classes] } : { kind: 'other' }
}

// --- The migration bundle draft. -----------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID: 48 bits of milliseconds, 80 random bits (migration-bundles.md §1). */
export function newUlid(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let time = ''
  let rest = Math.max(0, Math.trunc(now))
  for (let i = 0; i < 10; i += 1) {
    time = `${CROCKFORD[rest % 32]}${time}`
    rest = Math.floor(rest / 32)
  }
  const bytes = random(16)
  let tail = ''
  for (let i = 0; i < 16; i += 1) tail += CROCKFORD[(bytes[i] ?? 0) % 32]
  return `${time}${tail}`
}

export const MIGRATION_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MIGRATION_NAME_MAX = 64
const DEPENDENCY = /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|baseline:[a-z0-9]+(?:-[a-z0-9]+)*)$/

export type DeclaredCompatibility =
  | 'additive'
  | 'potentially_breaking'
  | 'data_rewrite'
  | 'destructive'

export interface BundleDraftInput {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly dependsOn: readonly string[]
  readonly transactional: boolean
  readonly compatibility: DeclaredCompatibility
  readonly notes: string
}

/** The suggestion for the declared compatibility, from the classes; the person decides. */
export function suggestedCompatibility(classes: readonly StatementClass[]): DeclaredCompatibility {
  if (classes.includes('destructive')) return 'destructive'
  if (classes.includes('rewrite')) return 'potentially_breaking'
  return 'additive'
}

/** Whether a statement of the text needs a non-transactional bundle (the analysis' `autocommitOnly`). */
export function needsNonTransactional(classes: readonly StatementClass[]): boolean {
  return classes.includes('non_transactional')
}

export function allClasses(result: SqlClassification | undefined): StatementClass[] {
  if (result === undefined || result.status !== 'parsed') return []
  const set = new Set<StatementClass>()
  for (const statement of result.statements) for (const c of statement.classes) set.add(c)
  return [...set]
}

/** Dependencies typed one per line; the invalid ones are returned separately, never dropped silently. */
export function parseDependencies(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (entry.length === 0) continue
    if (DEPENDENCY.test(entry)) valid.push(entry)
    else invalid.push(entry)
  }
  return { valid, invalid }
}

/** A YAML block scalar of untrusted text: every line indented, so no line can leave the block. */
function blockScalar(text: string, indent: string): string {
  const lines = normalizeBreaks(text).split('\n')
  return lines.map((line) => (line.length === 0 ? '' : `${indent}${line}`)).join('\n')
}

/** `migration.yaml` of a draft (migration-bundles.md §2). The server validates it again. */
export function manifestText(input: BundleDraftInput): string {
  const lines = [
    'schema: exponetdb.migration/v1',
    `id: ${input.id}`,
    `name: ${input.name}`,
    'description: |',
    blockScalar(input.description, '  '),
  ]
  if (input.dependsOn.length === 0) lines.push('dependsOn: []')
  else {
    lines.push('dependsOn:')
    for (const dependency of input.dependsOn) lines.push(`  - ${JSON.stringify(dependency)}`)
  }
  lines.push('execution:', `  transactional: ${input.transactional ? 'true' : 'false'}`)
  lines.push('compatibility:', `  declared: ${input.compatibility}`)
  if (input.compatibility !== 'additive' || input.notes.trim().length > 0) {
    lines.push('  notes: |', blockScalar(input.notes, '    '))
  }
  lines.push('verification:', '  expectations: auto', '  runtimeChecks: verify.sql')
  return `${lines.join('\n')}\n`
}

/**
 * A `verify.sql` skeleton: one check per statement that fails until the person
 * writes the real check (`SELECT false AS ok`), so a skeleton left as it is
 * never verifies a change. Generated in the browser as text the person edits;
 * the statement labels come from the server's closed vocabulary.
 */
export function verifySkeleton(result: SqlClassification | undefined): string {
  const lines = [
    '-- verify.sql: read-only checks that run after apply (verification.md §4).',
    '-- Each check is one SELECT with a boolean column named ok.',
    '-- Every check below fails until you replace it with a real one.',
    '',
  ]
  const statements = (result?.status === 'parsed' ? result.statements : []).filter(
    (statement) => !(statement.classes.length === 1 && statement.classes[0] === 'read_only'),
  )
  if (statements.length === 0) {
    lines.push('-- check: replace with a real check', 'SELECT false AS ok;', '')
  }
  for (const statement of statements) {
    const label = statement.label.replace(/[^\x20-\x7e]/g, '?')
    lines.push(
      `-- check: statement ${statement.index + 1} (${label}) took effect`,
      `-- covers: ${statement.index + 1}`,
      'SELECT false AS ok;',
      '',
    )
  }
  return lines.join('\n')
}

export function bundleDirectory(id: string, name: string): string {
  return `${id}_${name}`
}
