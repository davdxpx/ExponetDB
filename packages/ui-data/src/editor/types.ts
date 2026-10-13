import type { Ref } from 'react'

/**
 * The editor interface of the Web App (OD-40): what the SQL section and the
 * plan review need from a text editor, with no library type in it. The
 * implementation is `sql-editor.tsx` (CodeMirror 6 in a shadow root); this
 * module is light and does not import it, so any screen can use the types
 * without loading the editor.
 */

/**
 * - `query`: a read-only data query the person will run (`onRun` on Mod+Enter).
 * - `draft`: the text of a migration draft; it is never run from the editor.
 * - `readonly`: display of SQL (focusable and selectable, never editable).
 */
export type SqlEditorMode = 'query' | 'draft' | 'readonly'

export type SqlDiagnosticSeverity = 'error' | 'warning' | 'info'

/**
 * A finding on the text, from the server's lint or classification. The editor
 * runs no lint of its own. Lines and columns are 1-based; a column counts
 * UTF-16 code units of the line (the JavaScript string index). Without a
 * column the whole line is marked; with a column and no end, the word at the
 * column is underlined; `endLine` and `endColumn` (the column after the last
 * marked character) give an explicit range. Contract mapping: a lint entry's `level`
 * `warn` is `warning`; an entry with `line: null` has no place in the text and
 * is shown elsewhere by the caller.
 *
 * `message` is untrusted (a server message may quote the statement): the
 * editor renders it as text with invisible characters made visible (C-26) and
 * cuts it at 500 characters. At most 200 findings are marked and 50 listed; the
 * list says how many were given when there are more.
 */
export interface SqlDiagnostic {
  readonly line: number
  readonly column?: number
  readonly endLine?: number
  readonly endColumn?: number
  readonly severity: SqlDiagnosticSeverity
  readonly message: string
}

export type SqlCompletionKind = 'schema' | 'table' | 'column' | 'function' | 'keyword'

/** One suggestion. `label` is the text inserted (quote it in the provider if it needs quoting). */
export interface SqlCompletionItem {
  readonly label: string
  readonly kind: SqlCompletionKind
  readonly detail?: string
}

/**
 * What the provider is asked. `word` is the identifier being typed, with its
 * dot-separated qualifiers (`public.us`); `before` is the text of the current
 * statement before the word (cut at the previous `;`, at most 2000
 * characters) so the provider can tell `FROM ` from `SELECT `. Both are what
 * the person typed: treat them as untrusted and sensitive; never log them.
 */
export interface SqlCompletionContext {
  readonly word: string
  readonly before: string
}

/**
 * An injected provider: the browser holds no catalog. The editor calls it
 * debounced and never in comments or string literals; a call that fails or
 * returns a malformed list shows nothing (and logs nothing). At most 500
 * items are used.
 */
export type SqlCompletionProvider = (
  context: SqlCompletionContext,
) => Promise<readonly SqlCompletionItem[]>

/** The imperative handle of the editor (`ref`). Lines and columns are 1-based. */
export interface EditorHandle {
  focus(): void
  /** Puts the cursor at the position (clamped to the text) and scrolls it into view. */
  setSelection(line: number, column: number): void
  /** The selected text, ranges joined with a line break; `''` when nothing is selected. */
  getSelectionText(): string
}

export interface SqlEditorProps {
  /** The text (controlled). A CR or CRLF in it is shown as a line break and reported as LF by `onChange`. */
  value: string
  /** Called with the whole text after a change by the person; never for a change of `value` from outside. */
  onChange?: (value: string) => void
  mode: SqlEditorMode
  diagnostics?: readonly SqlDiagnostic[]
  completion?: SqlCompletionProvider
  /**
   * Mod+Enter, in `query` mode only. The editor never runs anything: the
   * caller decides what "run" means (and asks for the plan or the permission).
   */
  onRun?: () => void
  /** The accessible name of the text box (an ID reference cannot cross the shadow boundary). */
  label: string
  /** Height at least this many lines. Default 3. */
  minLines?: number
  /** Height at most this many lines, then the editor scrolls. Default: grows with the text. */
  maxLines?: number
  placeholder?: string
  /** Wrap long lines. Default false. */
  wrap?: boolean
  /**
   * Tab indents instead of moving focus. Default false: Tab leaves the editor
   * (WCAG 2.1.2, no keyboard trap). With it on, Escape and then Tab leave the
   * editor, and the person chooses it (store it as a preference).
   */
  tabIndents?: boolean
  /** Class names of the frame around the editor. */
  className?: string
  ref?: Ref<EditorHandle>
}
