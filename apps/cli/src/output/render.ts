import type { Block, Column, CommandResult, OutputContext, Tone } from './model.ts'
import { OUTPUT_SCHEMA } from './model.ts'
import { clean, cleanLine, pad, truncate, width } from './text.ts'

/** How the person's terminal is set up (decided once in main). */
export interface Terminal {
  /** Columns available on stdout (80 when unknown). */
  readonly columns: number
  readonly color: boolean
  /** Box and ellipsis characters are replaced by ASCII. */
  readonly ascii: boolean
  readonly quiet: boolean
}

const CODES: Record<Tone, string> = {
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  info: '\u001b[36m',
  muted: '\u001b[2m',
}
const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'

function paint(t: Terminal, tone: Tone | 'bold', text: string): string {
  if (!t.color) return text
  return `${tone === 'bold' ? BOLD : CODES[tone]}${text}${RESET}`
}

const dot = (t: Terminal) => (t.ascii ? '-' : '·')

function header(t: Terminal, b: Extract<Block, { kind: 'header' }>): string[] {
  const title = `ExponetDB ${dot(t)} ${cleanLine(b.title)}`
  const context = (b.context ?? []).map(([k, v]) => `${k}: ${cleanLine(v)}`)
  const lines: string[] = []
  const first = context[0]
  const span = Math.min(t.columns, 80)
  if (first !== undefined && width(title) + 4 + width(first) <= t.columns) {
    const gap = Math.max(4, span - width(title) - width(first))
    lines.push(`${paint(t, 'bold', title)}${' '.repeat(gap)}${first}`)
    context.shift()
  } else {
    lines.push(paint(t, 'bold', title))
  }
  for (let i = 0; i < context.length; i += 2) {
    const pair = context.slice(i, i + 2)
    const line =
      pair.length === 2 && width(pair[0] ?? '') + 4 + width(pair[1] ?? '') <= span
        ? `${pad(pair[0] ?? '', span - width(pair[1] ?? ''))}${pair[1]}`
        : pair.join('    ')
    lines.push(truncate(line, t.columns, t.ascii))
  }
  lines.push('')
  return lines
}

function fields(t: Terminal, b: Extract<Block, { kind: 'fields' }>): string[] {
  const label = Math.max(0, ...b.rows.map(([k]) => width(k))) + 2
  const out: string[] = []
  for (const [k, v] of b.rows) {
    const value = v === null ? paint(t, 'muted', 'unknown') : clean(v)
    const [firstLine, ...more] = value.split('\n')
    out.push(
      `${pad(`${k}:`, label)}${truncate(firstLine ?? '', Math.max(10, t.columns - label), t.ascii)}`,
    )
    for (const line of more)
      out.push(`${' '.repeat(label)}${truncate(line, Math.max(10, t.columns - label), t.ascii)}`)
  }
  out.push('')
  return out
}

/** Column widths that fit the terminal: flexible columns shrink first, never below their title. */
function layout(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  total: number,
): number[] | undefined {
  const natural = columns.map((c, i) =>
    Math.max(width(c.title), ...rows.map((r) => width(cleanLine(r[i] ?? '')))),
  )
  const gaps = (columns.length - 1) * 2
  let widths = [...natural]
  let excess = widths.reduce((a, b) => a + b, 0) + gaps - total
  if (excess <= 0) return widths
  const flexible = columns.map((c, i) => (c.flexible === true ? i : -1)).filter((i) => i >= 0)
  for (const i of flexible.sort((a, b) => (natural[b] ?? 0) - (natural[a] ?? 0))) {
    const min = Math.max(width(columns[i]?.title ?? ''), 8)
    const cut = Math.min(excess, (widths[i] ?? 0) - min)
    if (cut > 0) {
      widths[i] = (widths[i] ?? 0) - cut
      excess -= cut
    }
    if (excess <= 0) return widths
  }
  widths = []
  return undefined
}

function table(t: Terminal, b: Extract<Block, { kind: 'table' }>): string[] {
  if (b.rows.length === 0) {
    return [paint(t, 'muted', b.empty ?? 'Nothing to show.'), '']
  }
  const widths = layout(b.columns, b.rows, t.columns)
  if (widths === undefined) {
    // Too narrow for a table: one record per row.
    const out: string[] = []
    for (const r of b.rows) {
      out.push(
        ...fields(t, { kind: 'fields', rows: b.columns.map((c, i) => [c.title, r[i] ?? '']) }),
      )
    }
    return out
  }
  const cell = (value: string, i: number) => {
    const w = widths[i] ?? 0
    const text = truncate(cleanLine(value), w, t.ascii)
    return b.columns[i]?.align === 'right' ? pad('', w - width(text)) + text : pad(text, w)
  }
  const out = [
    paint(
      t,
      'muted',
      b.columns
        .map((c, i) => cell(c.title, i))
        .join('  ')
        .trimEnd(),
    ),
  ]
  for (const r of b.rows)
    out.push(
      b.columns
        .map((_, i) => cell(r[i] ?? '', i))
        .join('  ')
        .trimEnd(),
    )
  out.push('')
  return out
}

function text(t: Terminal, b: Extract<Block, { kind: 'text' }>): string[] {
  const lines = b.lines.map((l) => clean(l))
  return [...lines.map((l) => (b.tone === undefined ? l : paint(t, b.tone, l))), '']
}

function status(t: Terminal, b: Extract<Block, { kind: 'status' }>): string[] {
  const word = paint(t, b.tone, cleanLine(b.word))
  return [b.text === undefined ? word : `${word}  ${cleanLine(b.text)}`, '']
}

/** The details a catalog code names as plain data, and how a list of them is joined. */
const NAMED_DETAILS: readonly (readonly [key: string, joiner: string])[] = [
  ['migrationId', ', '],
  ['missing', ', '],
  ['cycle', ' → '],
]

/** `key: value` for each named detail that is a string or a list of strings (at most five entries). */
function namedLines(details: unknown): string[] {
  if (typeof details !== 'object' || details === null) return []
  const data = details as Record<string, unknown>
  return NAMED_DETAILS.flatMap(([key, joiner]) => {
    const value = data[key]
    const items = Array.isArray(value) ? value : [value]
    const texts = items.filter((v): v is string => typeof v === 'string')
    if (texts.length === 0) return []
    const shown = texts.slice(0, 5).join(joiner)
    return [
      `${key}: ${texts.length > 5 ? `${shown}${joiner === ', ' ? ', ' : ' '}… ${texts.length - 5} more` : shown}`,
    ]
  })
}

/** At most five `path: message` lines of an error's field details (`details.errors`). */
function detailLines(details: unknown): string[] {
  const errors =
    typeof details === 'object' &&
    details !== null &&
    'errors' in details &&
    Array.isArray(details.errors)
      ? (details.errors as unknown[])
      : []
  const lines = errors.slice(0, 5).flatMap((e) => {
    if (typeof e !== 'object' || e === null) return []
    const path = 'path' in e && typeof e.path === 'string' ? e.path : ''
    const message = 'message' in e && typeof e.message === 'string' ? e.message : ''
    return message === '' ? [] : [`${path === '' ? '(request)' : path}: ${message}`]
  })
  return [
    ...(errors.length > 5 ? [...lines, `… ${errors.length - 5} more`] : lines),
    ...namedLines(details),
  ]
}

/** The human view of a result: stdout lines and stderr lines (the error goes to stderr). */
export function renderHuman(r: CommandResult, t: Terminal): { out: string[]; err: string[] } {
  const out: string[] = []
  for (const b of r.blocks) {
    if (t.quiet && (b.kind === 'header' || (b.kind === 'text' && b.tone === 'muted'))) continue
    if (b.kind === 'header') out.push(...header(t, b))
    else if (b.kind === 'fields') out.push(...fields(t, b))
    else if (b.kind === 'table') out.push(...table(t, b))
    else if (b.kind === 'text') out.push(...text(t, b))
    else out.push(...status(t, b))
  }
  const err: string[] = []
  if (r.error !== undefined) {
    err.push(
      `${paint(t, 'error', 'Error')} ${cleanLine(r.error.code)}: ${cleanLine(r.error.message)}`,
    )
    if (r.error.remediation !== undefined) err.push(`  ${cleanLine(r.error.remediation)}`)
    // Field errors of a refused request (the catalog's details), as data.
    for (const line of detailLines(r.error.details)) err.push(`  ${cleanLine(line)}`)
    const ids = [
      r.requestId === undefined ? undefined : `request ${r.requestId}`,
      r.planId === undefined ? undefined : `plan ${r.planId}`,
      r.operationId === undefined ? undefined : `operation ${r.operationId}`,
    ].filter((x): x is string => x !== undefined)
    if (ids.length > 0) err.push(`  (${ids.join(', ')})`)
  }
  if (!t.quiet && r.next !== undefined && r.next.length > 0) {
    const target = r.error === undefined ? out : err
    for (const n of r.next) target.push(`${paint(t, 'muted', 'Next:')} ${cleanLine(n)}`)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return { out, err }
}

/** The envelope of JSON and of the final NDJSON record. */
export function envelope(r: CommandResult, context: OutputContext): Record<string, unknown> {
  return {
    schema: OUTPUT_SCHEMA,
    command: r.command,
    status: r.status,
    ...(Object.keys(context).length === 0 ? {} : { context }),
    ...(r.requestId === undefined ? {} : { requestId: r.requestId }),
    ...(r.planId === undefined ? {} : { planId: r.planId }),
    ...(r.operationId === undefined ? {} : { operationId: r.operationId }),
    ...(r.data === undefined
      ? r.items === undefined
        ? {}
        : { data: { items: r.items, ...(r.partial === true ? { partial: true } : {}) } }
      : { data: r.data }),
    ...(r.error === undefined ? {} : { error: r.error }),
    ...(r.next === undefined || r.next.length === 0 ? {} : { next: r.next }),
  }
}

// Characters JSON.stringify leaves raw that a terminal may act on: DEL, C1
// controls, bidi steering and the line separators. Escaping them keeps the
// parsed value identical (they occur only inside strings).
const UNSAFE_IN_JSON = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** JSON text that is the same value and safe to show on a terminal. */
export function safeJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    UNSAFE_IN_JSON,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  )
}

/** One JSON document. */
export function renderJson(r: CommandResult, context: OutputContext): string {
  return safeJson(envelope(r, context), 2)
}

/** NDJSON: item records, then exactly one result or error record. */
export function renderNdjson(r: CommandResult, context: OutputContext): string[] {
  const lines: string[] = []
  for (const item of r.items ?? [])
    lines.push(safeJson({ schema: OUTPUT_SCHEMA, type: 'item', data: item }))
  const { data: _data, ...rest } = envelope(r, context)
  const final =
    r.error === undefined
      ? {
          ...rest,
          type: 'result',
          ...(r.items === undefined && r.data !== undefined ? { data: r.data } : {}),
        }
      : { ...rest, type: 'error', ...(r.partial === true ? { partial: true } : {}) }
  lines.push(safeJson(final))
  return lines
}

/** A progress record (NDJSON while watching). */
export function progressRecord(command: string, data: unknown): string {
  return safeJson({ schema: OUTPUT_SCHEMA, type: 'progress', command, data })
}
