import type { SchemaErdData } from '@exponetdb/ui-data'
import { codePointLabel, isInvisible } from '@exponetdb/ui-patterns'

/**
 * The two exports of the schema diagram, built from the tables and foreign
 * keys of the read and from nothing else: an SVG file and a Markdown outline.
 *
 * The SVG is drawn from numbers, not from the page: a grid of boxes with the
 * columns of each table, a line with an arrow for each foreign key between two
 * tables, and the foreign keys listed as text under the drawing (a line is a
 * picture, the list is the content). It uses no `foreignObject`, no script, no
 * style element, no external reference and no web font (system monospace
 * only), so the file opens anywhere and nothing in it reaches out. Every name
 * is untrusted (C-26): hidden, control and direction characters are written as
 * their code points, never as themselves, and what is left is XML-escaped.
 * The exports say what the read left out, as the page does.
 */

export interface ExportMeta {
  /** The target path (`product/project/environment`), already validated. */
  readonly target: string
  /** When the oldest table of the read was observed (ISO 8601). */
  readonly observedAt: string
  /** Where the read comes from (`live`, `cached`, …). */
  readonly source: string
  /** Foreign keys the read could not draw. */
  readonly undrawn: number
  /** How many tables the read holds; more than the export holds when the diagram was focused on one table. */
  readonly tablesRead: number
}

/** The sentence that says an export holds only some of the tables read, or nothing when it holds them all. */
function subsetNote(data: SchemaErdData, meta: ExportMeta): string {
  return meta.tablesRead > data.tables.length
    ? ` Only ${data.tables.length} of the ${meta.tablesRead} tables read are included.`
    : ''
}

const MAX_NAME = 40
const MAX_TYPE = 20
const COLUMNS_SHOWN = 24
const RELATIONS_LISTED = 200

function isXmlInvalid(cp: number): boolean {
  return (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff
}

/** The text with every hidden or invalid character as its code point, cut at `max` code points. */
export function visibleText(text: string, max: number): string {
  let out = ''
  let count = 0
  for (const character of text) {
    if (count >= max) return `${out}…`
    const cp = character.codePointAt(0) ?? 0
    out += isInvisible(cp) || isXmlInvalid(cp) ? codePointLabel(cp) : character
    count += 1
  }
  return out
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

export function xmlText(text: string, max: number): string {
  return visibleText(text, max).replace(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? '')
}

// ----- SVG -----

const BOX_WIDTH = 270
const HEADER_HEIGHT = 30
const ROW_HEIGHT = 18
const PAD = 24
const GAP_X = 64
const GAP_Y = 40
const TITLE_HEIGHT = 64
const ROW_LIST_HEIGHT = 16
const MAX_PER_ROW = 4

interface Box {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly height: number
  readonly columns: SchemaErdData['tables'][number]['columns']
  readonly hidden: number
  readonly label: string
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function boxHeight(shown: number, hidden: number): number {
  return HEADER_HEIGHT + (Math.max(1, shown) + (hidden > 0 ? 1 : 0)) * ROW_HEIGHT + 8
}

function layout(data: SchemaErdData): { boxes: Box[]; width: number; height: number } {
  const tables = [...data.tables].sort(
    (a, b) => compare(a.schema, b.schema) || compare(a.name, b.name) || compare(a.id, b.id),
  )
  const perRow = Math.max(1, Math.min(MAX_PER_ROW, Math.ceil(Math.sqrt(tables.length))))
  const boxes: Box[] = []
  let y = TITLE_HEIGHT
  let widest = 0
  for (let start = 0; start < tables.length; start += perRow) {
    const row = tables.slice(start, start + perRow)
    const heights = row.map((table) =>
      boxHeight(
        Math.min(table.columns.length, COLUMNS_SHOWN),
        Math.max(0, table.columns.length - COLUMNS_SHOWN),
      ),
    )
    for (const [index, table] of row.entries()) {
      boxes.push({
        id: table.id,
        x: PAD + index * (BOX_WIDTH + GAP_X),
        y,
        height: heights[index] ?? 0,
        columns: table.columns.slice(0, COLUMNS_SHOWN),
        hidden: Math.max(0, table.columns.length - COLUMNS_SHOWN),
        label: `${visibleText(table.schema, MAX_NAME)}.${visibleText(table.name, MAX_NAME)}`,
      })
    }
    widest = Math.max(widest, row.length)
    y += Math.max(0, ...heights) + GAP_Y
  }
  const width = PAD * 2 + Math.max(1, widest) * BOX_WIDTH + Math.max(0, widest - 1) * GAP_X
  return { boxes, width, height: y }
}

/** Where the line from the center of one box toward another leaves the box. */
function edgePoint(
  from: Box,
  toward: Box,
): { readonly x: number; readonly y: number; readonly angle: number } {
  const cx = from.x + BOX_WIDTH / 2
  const cy = from.y + from.height / 2
  const dx = toward.x + BOX_WIDTH / 2 - cx
  const dy = toward.y + toward.height / 2 - cy
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : BOX_WIDTH / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : from.height / 2 / Math.abs(dy),
  )
  const t = Number.isFinite(scale) ? Math.min(1, scale) : 0
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) }
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10)
}

function relationLine(
  data: SchemaErdData,
  relation: SchemaErdData['relations'][number],
  max: number,
): string {
  const names = new Map(data.tables.map((table) => [table.id, `${table.schema}.${table.name}`]))
  const columns = (list: readonly string[]): string =>
    list.map((column) => visibleText(column, max)).join(', ')
  return `${visibleText(relation.name, max)}: ${visibleText(names.get(relation.fromTable) ?? '?', max)} (${columns(relation.fromColumns)}) -> ${visibleText(names.get(relation.toTable) ?? '?', max)} (${columns(relation.toColumns)})`
}

/** The diagram as a standalone SVG document (text), with a title, a description and the relations as a list. */
export function diagramSvg(data: SchemaErdData, meta: ExportMeta): string {
  const { boxes, width: drawingWidth, height: drawingHeight } = layout(data)
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const listed = data.relations.slice(0, RELATIONS_LISTED)
  const lines = listed.map((relation) => relationLine(data, relation, MAX_NAME))
  const hiddenLines = data.relations.length - listed.length
  const listHeight =
    lines.length === 0 ? 0 : (lines.length + 2 + (hiddenLines > 0 ? 1 : 0)) * ROW_LIST_HEIGHT
  const width = Math.max(drawingWidth, 640)
  const height = drawingHeight + listHeight + PAD
  const relationCount = data.relations.length
  const summary = `${data.tables.length} ${data.tables.length === 1 ? 'table' : 'tables'}, ${relationCount} ${relationCount === 1 ? 'relation' : 'relations'}. Read ${meta.observedAt} (${meta.source}).${meta.undrawn > 0 ? ` ${meta.undrawn} foreign keys were not drawn.` : ''}${subsetNote(data, meta)}`

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="exdb-title exdb-desc" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11">`,
    `<title id="exdb-title">${xmlText(`ExponetDB schema diagram of ${meta.target}`, 200)}</title>`,
    `<desc id="exdb-desc">${xmlText(summary, 400)}</desc>`,
    '<defs><marker id="exdb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#57606a"/></marker></defs>',
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${PAD}" y="26" font-size="15" font-weight="bold" fill="#1f2328">${xmlText(`Schema of ${meta.target}`, 120)}</text>`,
    `<text x="${PAD}" y="46" fill="#57606a">${xmlText(summary, 300)}</text>`,
  )

  // Lines first, so the boxes sit on top of them.
  for (const relation of data.relations) {
    const from = byId.get(relation.fromTable)
    const to = byId.get(relation.toTable)
    if (from === undefined || to === undefined || from === to) continue
    const start = edgePoint(from, to)
    const end = edgePoint(to, from)
    out.push(
      `<line x1="${round(start.x)}" y1="${round(start.y)}" x2="${round(end.x)}" y2="${round(end.y)}" stroke="#57606a" stroke-width="1.25" marker-end="url(#exdb-arrow)"/>`,
    )
  }

  for (const box of boxes) {
    out.push(
      `<g>`,
      `<rect x="${box.x}" y="${box.y}" width="${BOX_WIDTH}" height="${box.height}" rx="4" fill="#f6f8fa" stroke="#8b949e"/>`,
      `<rect x="${box.x}" y="${box.y}" width="${BOX_WIDTH}" height="${HEADER_HEIGHT}" rx="4" fill="#e6e8eb" stroke="#8b949e"/>`,
      `<text x="${box.x + 10}" y="${box.y + 19}" font-weight="bold" fill="#1f2328">${xmlText(box.label, MAX_NAME * 2 + 1)}</text>`,
    )
    let rowY = box.y + HEADER_HEIGHT + 14
    if (box.columns.length === 0) {
      out.push(`<text x="${box.x + 10}" y="${rowY}" fill="#57606a">No columns</text>`)
    }
    for (const column of box.columns) {
      out.push(
        `<text x="${box.x + 10}" y="${rowY}" fill="#1f2328">${column.pk === true ? 'PK ' : ''}${xmlText(column.name, MAX_NAME - 18)}</text>`,
        `<text x="${box.x + BOX_WIDTH - 10}" y="${rowY}" text-anchor="end" fill="#57606a">${xmlText(column.type, MAX_TYPE)}</text>`,
      )
      rowY += ROW_HEIGHT
    }
    if (box.hidden > 0) {
      out.push(
        `<text x="${box.x + 10}" y="${rowY}" fill="#57606a">and ${box.hidden} more columns</text>`,
      )
    }
    out.push('</g>')
  }

  if (lines.length > 0) {
    let listY = drawingHeight + ROW_LIST_HEIGHT
    out.push(`<text x="${PAD}" y="${listY}" font-weight="bold" fill="#1f2328">Relations</text>`)
    for (const line of lines) {
      listY += ROW_LIST_HEIGHT
      out.push(`<text x="${PAD}" y="${listY}" fill="#1f2328">${xmlText(line, 400)}</text>`)
    }
    if (hiddenLines > 0) {
      listY += ROW_LIST_HEIGHT
      out.push(
        `<text x="${PAD}" y="${listY}" fill="#57606a">and ${hiddenLines} more relations</text>`,
      )
    }
  }
  out.push('</svg>')
  return `${out.join('\n')}\n`
}

// ----- Markdown -----

/** A name as a Markdown code span: the delimiter is longer than any run of backticks inside; in a table cell a pipe is escaped. */
function code(text: string, max = MAX_NAME * 2, cell = false): string {
  const visible = visibleText(text, max)
  const shown = cell ? visible.replaceAll('|', '\\|') : visible
  const runs = shown.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1)
  const pad = shown.startsWith('`') || shown.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${shown}${pad}${fence}`
}

/** A text outline of the diagram: each table with its columns and keys, then the relations. */
export function diagramMarkdown(data: SchemaErdData, meta: ExportMeta): string {
  const names = new Map(data.tables.map((table) => [table.id, `${table.schema}.${table.name}`]))
  const foreignKeyColumns = new Map<string, Set<string>>()
  for (const relation of data.relations) {
    const set = foreignKeyColumns.get(relation.fromTable) ?? new Set<string>()
    for (const column of relation.fromColumns) set.add(column)
    foreignKeyColumns.set(relation.fromTable, set)
  }
  const out: string[] = [
    `# Schema of ${code(meta.target)}`,
    '',
    `${data.tables.length} ${data.tables.length === 1 ? 'table' : 'tables'}, ${data.relations.length} ${data.relations.length === 1 ? 'relation' : 'relations'}. Read ${meta.observedAt} (${meta.source}).${meta.undrawn > 0 ? ` ${meta.undrawn} foreign keys were not included.` : ''}${subsetNote(data, meta)}`,
  ]
  for (const table of data.tables) {
    out.push('', `## ${code(`${table.schema}.${table.name}`)}`, '')
    if (table.columns.length === 0) {
      out.push('No columns.')
      continue
    }
    out.push('| Column | Type | Keys |', '| --- | --- | --- |')
    for (const column of table.columns) {
      const keys = [
        column.pk === true ? 'PK' : '',
        foreignKeyColumns.get(table.id)?.has(column.name) === true ? 'FK' : '',
      ]
        .filter((key) => key !== '')
        .join(', ')
      out.push(
        `| ${code(column.name, MAX_NAME * 2, true)} | ${code(column.type, MAX_TYPE * 2, true)} | ${keys} |`,
      )
    }
  }
  if (data.relations.length > 0) {
    out.push('', '## Relations', '')
    for (const relation of data.relations) {
      const columns = (list: readonly string[]): string =>
        list.map((column) => code(column)).join(', ')
      out.push(
        `- ${code(relation.name)}: ${code(names.get(relation.fromTable) ?? '?')} (${columns(relation.fromColumns)}) -> ${code(names.get(relation.toTable) ?? '?')} (${columns(relation.toColumns)})`,
      )
    }
  }
  return `${out.join('\n')}\n`
}

/** The name of the downloaded file: from the validated target path only. */
export function exportFileName(target: string, extension: 'svg' | 'md'): string {
  return `schema-${target.replaceAll('/', '-')}.${extension}`
}
