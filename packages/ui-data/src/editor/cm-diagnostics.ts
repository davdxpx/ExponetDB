import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  lineNumberMarkers,
  type Panel,
  showPanel,
} from '@codemirror/view'

import { untrustedMessage } from './text.ts'
import type { SqlDiagnostic, SqlDiagnosticSeverity } from './types.ts'

/**
 * Findings shown on the text: the line is tinted, the range is underlined
 * (wavy), the line number carries a symbol, and a list below the text states every
 * finding in words (the only place a screen reader finds them: the gutter is
 * hidden from assistive technology). Color is never the only signal: the
 * symbols differ in shape and the list names the severity.
 */

export const MAX_DIAGNOSTICS = 200
const MAX_LISTED = 50
const MAX_LINES_PER_DIAGNOSTIC = 200

const RANK: Record<SqlDiagnosticSeverity, number> = { error: 3, warning: 2, info: 1 }
const WORD: Record<SqlDiagnosticSeverity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
}

/** A diagnostic placed in the text. Positions follow the text through edits. */
interface Placed {
  readonly from: number
  /** End of the underlined range; equal to `from` when only the line is marked. */
  readonly to: number
  /** Last position of the marked lines (a position on the last line). */
  readonly last: number
  readonly severity: SqlDiagnosticSeverity
  readonly message: string
}

interface DiagnosticsValue {
  readonly placed: readonly Placed[]
  /** How many findings were given; more than `placed` when the list was cut at `MAX_DIAGNOSTICS`. */
  readonly total: number
  readonly decorations: DecorationSet
  readonly markers: RangeSet<GutterMarker>
}

const EMPTY: DiagnosticsValue = {
  placed: [],
  total: 0,
  decorations: Decoration.none,
  markers: RangeSet.empty,
}

/** The offset of a 1-based line and column, clamped into the text. */
export function locate(doc: Text, line: number, column = 1): number {
  const lineNumber = Math.min(Math.max(Math.trunc(line) || 1, 1), doc.lines)
  const at = doc.line(lineNumber)
  const col = Math.min(Math.max(Math.trunc(column) || 1, 1), at.length + 1)
  return at.from + col - 1
}

function place(state: EditorState, d: SqlDiagnostic): Placed {
  const doc = state.doc
  const lineNumber = Math.min(Math.max(Math.trunc(d.line) || 1, 1), doc.lines)
  const first = doc.line(lineNumber)
  const message = untrustedMessage(d.message)
  const hasColumn = d.column !== undefined
  const from = hasColumn ? locate(doc, lineNumber, d.column) : first.from
  const endLine = Math.min(
    Math.max(Math.trunc(d.endLine ?? lineNumber) || lineNumber, lineNumber),
    doc.lines,
  )
  let endPos: number | undefined
  if (d.endColumn !== undefined) endPos = locate(doc, endLine, d.endColumn)
  else if (d.endLine !== undefined) endPos = doc.line(endLine).to
  let to = from
  if (hasColumn) {
    if (endPos !== undefined && endPos > from) {
      to = endPos
    } else if (from < first.to) {
      const word = state.wordAt(from)
      to = word !== null && word.from <= from && word.to > from ? word.to : from + 1
    }
  }
  const last = endPos !== undefined ? Math.max(endPos, from) : from
  return { from, to, last, severity: d.severity, message }
}

function build(placed: readonly Placed[], doc: Text, total: number): DiagnosticsValue {
  if (placed.length === 0) return EMPTY
  const lineSeverity = new Map<number, SqlDiagnosticSeverity>()
  const ranges = []
  for (const p of placed) {
    const firstLine = doc.lineAt(p.from)
    const lastLine = doc.lineAt(Math.min(p.last, doc.length))
    const stop = Math.min(lastLine.number, firstLine.number + MAX_LINES_PER_DIAGNOSTIC - 1)
    for (let n = firstLine.number; n <= stop; n += 1) {
      const lineFrom = doc.line(n).from
      const seen = lineSeverity.get(lineFrom)
      if (seen === undefined || RANK[p.severity] > RANK[seen])
        lineSeverity.set(lineFrom, p.severity)
    }
    if (p.to > p.from) {
      ranges.push(
        Decoration.mark({ class: `exdb-diag-range exdb-diag-range-${p.severity}` }).range(
          p.from,
          Math.min(p.to, doc.length),
        ),
      )
    }
  }
  const markerRanges = []
  for (const [lineFrom, severity] of lineSeverity) {
    ranges.push(Decoration.line({ class: `exdb-diag-line-${severity}` }).range(lineFrom))
    markerRanges.push(new SeverityMarker(severity).range(lineFrom))
  }
  return {
    placed,
    total,
    decorations: Decoration.set(ranges, true),
    markers: RangeSet.of(markerRanges, true),
  }
}

/**
 * A mark on the line number of a line with findings. It adds classes to the
 * gutter element and no content of its own: the symbol is drawn by the theme
 * (`::before`), so the line number stays.
 */
class SeverityMarker extends GutterMarker {
  readonly severity: SqlDiagnosticSeverity
  override elementClass: string

  constructor(severity: SqlDiagnosticSeverity) {
    super()
    this.severity = severity
    this.elementClass = `exdb-diag-number exdb-diag-number-${severity}`
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof SeverityMarker && other.severity === this.severity
  }
}

/** Replaces the findings shown on the text. */
export const setDiagnostics = StateEffect.define<readonly SqlDiagnostic[]>()

const diagnosticsField = StateField.define<DiagnosticsValue>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostics)) {
        return build(
          effect.value.slice(0, MAX_DIAGNOSTICS).map((d) => place(tr.state, d)),
          tr.state.doc,
          effect.value.length,
        )
      }
    }
    if (tr.docChanged && value.placed.length > 0) {
      const map = (pos: number, changes: ChangeDesc) => changes.mapPos(pos, 1)
      return build(
        value.placed.map((p) => ({
          ...p,
          from: map(p.from, tr.changes),
          to: map(p.to, tr.changes),
          last: map(p.last, tr.changes),
        })),
        tr.state.doc,
        value.total,
      )
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/**
 * How many findings of each severity, in words: "3 problems: 1 error, 2
 * warnings". When the list was cut, it says how many were given and that the
 * counts are of the first ones.
 */
export function summarize(
  placed: readonly { readonly severity: SqlDiagnosticSeverity }[],
  total = placed.length,
): string {
  const counts: Record<SqlDiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const p of placed) counts[p.severity] += 1
  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} ${counts.error === 1 ? 'error' : 'errors'}`)
  if (counts.warning > 0)
    parts.push(`${counts.warning} ${counts.warning === 1 ? 'warning' : 'warnings'}`)
  if (counts.info > 0) parts.push(`${counts.info} info`)
  const cut = total > placed.length ? ` (the first ${placed.length} are marked and counted)` : ''
  return `${total} ${total === 1 ? 'problem' : 'problems'}${cut}: ${parts.join(', ')}`
}

function createPanel(summaryId: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement('div')
    dom.className = 'exdb-diag-panel'
    dom.setAttribute('role', 'group')
    dom.setAttribute('aria-label', 'Problems')
    const summary = document.createElement('p')
    summary.className = 'exdb-diag-summary'
    summary.id = summaryId
    const list = document.createElement('ul')
    list.className = 'exdb-diag-list'
    list.setAttribute('role', 'list')
    dom.append(summary, list)

    const render = (state: EditorState) => {
      const { placed, total } = state.field(diagnosticsField)
      summary.textContent = summarize(placed, total)
      const items = placed.slice(0, MAX_LISTED).map((p) => {
        const line = state.doc.lineAt(Math.min(p.from, state.doc.length))
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'exdb-diag-item'
        const severity = document.createElement('span')
        severity.className = `exdb-diag-severity exdb-diag-severity-${p.severity}`
        severity.textContent = WORD[p.severity]
        const where = document.createElement('span')
        where.textContent = ` at line ${line.number}, column ${p.from - line.from + 1}: `
        const message = document.createElement('span')
        message.textContent = p.message
        button.append(severity, where, message)
        button.addEventListener('click', () => {
          const at = Math.min(p.from, view.state.doc.length)
          view.dispatch({
            selection: { anchor: at },
            effects: EditorView.scrollIntoView(at, { y: 'center' }),
          })
          view.focus()
        })
        item.append(button)
        return item
      })
      if (total > MAX_LISTED) {
        const more = document.createElement('li')
        more.textContent = `and ${total - MAX_LISTED} more`
        items.push(more)
      }
      list.replaceChildren(...items)
    }
    render(view.state)

    return {
      dom,
      update(update) {
        if (
          update.docChanged ||
          update.state.field(diagnosticsField) !== update.startState.field(diagnosticsField)
        ) {
          render(update.state)
        }
      },
    }
  }
}

/**
 * The extension. `idBase` makes the id of the summary unique (the text box
 * names it as its description while findings exist, and `aria-invalid` is set
 * while an error does). Dispatch `setDiagnostics` to change the findings.
 */
export function diagnosticsExtension(idBase: string): Extension {
  const summaryId = `${idBase}-problems`
  const panel = createPanel(summaryId)
  return [
    diagnosticsField,
    lineNumberMarkers.from(diagnosticsField, (value) => value.markers),
    showPanel.from(diagnosticsField, (value) => (value.placed.length > 0 ? panel : null)),
    EditorView.contentAttributes.compute([diagnosticsField], (state): Record<string, string> => {
      const { placed } = state.field(diagnosticsField)
      if (placed.length === 0) return {}
      return placed.some((p) => p.severity === 'error')
        ? { 'aria-describedby': summaryId, 'aria-invalid': 'true' }
        : { 'aria-describedby': summaryId }
    }),
  ]
}
