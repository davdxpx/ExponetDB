import { encodeUtf8 } from '@exponetdb/kernel'
import type { SupportedMajor } from './majors.ts'

/**
 * PostgreSQL's own parser per major ([ADR-0021](../../../../exponetdb-docs/01-architecture/adr/0021-libpg-query-parser.md),
 * gate record G4 §4): `libpg-query` 16.7.3, 17.7.4 and 18.1.5 (WASM, pinned
 * exactly through npm aliases), loaded lazily, one build per major, because
 * one grammar for every target would accept syntax another server refuses.
 *
 * The tree is PostgreSQL's raw parse tree as JSON. Locations in it are UTF-8
 * byte offsets; statements are returned with JavaScript string ranges.
 * Text that contains U+0000 is refused before parsing: the parser reads a C
 * string and would silently stop at the NUL.
 */
interface Binding {
  loadModule(): Promise<void>
  parseSync(query: string): unknown
}

const loaded = new Map<SupportedMajor, Binding>()
const loading = new Map<SupportedMajor, Promise<Binding>>()

async function importBinding(major: SupportedMajor): Promise<Binding> {
  switch (major) {
    case 16:
      return (await import('libpg-query-16')) as unknown as Binding
    case 17:
      return (await import('libpg-query-17')) as unknown as Binding
    case 18:
      return (await import('libpg-query-18')) as unknown as Binding
  }
}

/** Loads (once) the parser of a major. */
export async function loadParser(major: SupportedMajor): Promise<void> {
  if (loaded.has(major)) {
    return
  }
  let pending = loading.get(major)
  if (pending === undefined) {
    pending = importBinding(major).then(async (binding) => {
      await binding.loadModule()
      loaded.set(major, binding)
      return binding
    })
    loading.set(major, pending)
  }
  await pending
}

/** The grammar versions the bindings were built from (recorded with every analysis). */
export const GRAMMARS: Readonly<Record<SupportedMajor, string>> = {
  16: 'libpg_query 16-5.2.0 (libpg-query 16.7.3)',
  17: 'libpg_query 17-6.1.0 (libpg-query 17.7.4)',
  18: 'libpg_query 18-constructive (libpg-query 18.1.5)',
}

/** The largest text the parser is given (data reads and verify checks are far smaller). */
export const MAX_PARSE_BYTES = 1024 * 1024

export type ParseFailure =
  | { readonly kind: 'nul' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_large' }
  /** A syntax error (or the parser's resource limit, e.g. nesting): `position` is a string index. */
  | { readonly kind: 'syntax'; readonly position: number | null; readonly resource: boolean }

export type JsonNode = Readonly<Record<string, unknown>>

export interface ParsedStatement {
  /** The statement's node type, e.g. `SelectStmt`. */
  readonly type: string
  /** The node body (`stmts[i].stmt[type]`). */
  readonly node: JsonNode
  /** JavaScript string range of the statement text (without leading whitespace). */
  readonly start: number
  readonly end: number
}

export type ParseResult =
  | {
      readonly ok: true
      readonly major: SupportedMajor
      readonly version: number
      readonly statements: readonly ParsedStatement[]
      /** Byte offset (UTF-8) → string index, for node locations. */
      readonly indexOf: (byteOffset: number) => number
    }
  | { readonly ok: false; readonly failure: ParseFailure }

/** Maps UTF-8 byte offsets to JavaScript string indices for one text. */
export function byteIndex(text: string): (byteOffset: number) => number {
  const bytes = encodeUtf8(text).length
  if (bytes === text.length) {
    return (b) => Math.max(0, Math.min(b, text.length))
  }
  const map = new Int32Array(bytes + 1)
  let b = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    for (let k = 0; k < width; k++) {
      map[b + k] = i
    }
    b += width
    if (code >= 0x10000) {
      i++
    }
  }
  map[bytes] = text.length
  return (offset) =>
    offset <= 0 ? 0 : offset >= bytes ? text.length : (map[offset] ?? text.length)
}

function isObject(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The single key of a node wrapper (`{ "SelectStmt": {…} }` → `SelectStmt`). */
export function nodeType(value: unknown): { type: string; body: JsonNode } | undefined {
  if (!isObject(value)) return undefined
  const keys = Object.keys(value)
  const key = keys[0]
  if (keys.length !== 1 || key === undefined || !/^[A-Z]/.test(key)) return undefined
  const body = value[key]
  return isObject(body) ? { type: key, body } : undefined
}

function errorPosition(error: unknown, text: string): number | null {
  const details = isObject(error) && isObject(error['sqlDetails']) ? error['sqlDetails'] : undefined
  const cursor = details?.['cursorPosition']
  return typeof cursor === 'number' && cursor >= 0 ? byteIndex(text)(cursor) : null
}

/** Parses text with the grammar of `major` (the parser must have been loaded). */
export function parseWith(major: SupportedMajor, text: string): ParseResult {
  if (text.includes('\u0000')) {
    return { ok: false, failure: { kind: 'nul' } }
  }
  if (encodeUtf8(text).length > MAX_PARSE_BYTES) {
    return { ok: false, failure: { kind: 'too_large' } }
  }
  const binding = loaded.get(major)
  if (binding === undefined) {
    throw new Error(`the PostgreSQL ${major} parser is not loaded`)
  }
  let raw: unknown
  try {
    raw = binding.parseSync(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return {
      ok: false,
      failure: {
        kind: 'syntax',
        position: errorPosition(error, text),
        resource: /memory|stack|too deep|recursion/i.test(message),
      },
    }
  }
  const tree = isObject(raw) ? raw : {}
  const version = typeof tree['version'] === 'number' ? tree['version'] : 0
  const stmts = Array.isArray(tree['stmts']) ? tree['stmts'] : []
  const indexOf = byteIndex(text)
  const bytes = encodeUtf8(text).length
  const statements: ParsedStatement[] = []
  for (const item of stmts) {
    if (!isObject(item)) continue
    const n = nodeType(item['stmt'])
    if (n === undefined) continue
    const loc = typeof item['stmt_location'] === 'number' ? item['stmt_location'] : 0
    const len =
      typeof item['stmt_len'] === 'number' && item['stmt_len'] > 0 ? item['stmt_len'] : bytes - loc
    let start = indexOf(loc)
    while (start < text.length && /\s/.test(text[start] ?? '')) start++
    statements.push({ type: n.type, node: n.body, start, end: indexOf(loc + len) })
  }
  if (statements.length === 0) {
    return { ok: false, failure: { kind: 'empty' } }
  }
  return { ok: true, major, version, statements, indexOf }
}

/** Loads the parser of `major` if needed, then parses. */
export async function parse(major: SupportedMajor, text: string): Promise<ParseResult> {
  await loadParser(major)
  return parseWith(major, text)
}

/**
 * Visits every node of a tree (depth first, in document order of the JSON).
 * `visit` returns false to skip the node's children.
 */
export function walk(
  value: unknown,
  visit: (type: string, body: JsonNode, parentKey: string | undefined) => boolean | undefined,
  parentKey?: string,
  depth = 0,
): void {
  if (depth > 10_000) {
    throw new RangeError('parse tree too deep')
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, parentKey, depth + 1)
    return
  }
  if (!isObject(value)) return
  const n = nodeType(value)
  if (n !== undefined) {
    if (visit(n.type, n.body, parentKey) === false) return
    for (const [k, v] of Object.entries(n.body)) walk(v, visit, k, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(value)) walk(v, visit, k, depth + 1)
}

/** Names from a list of `String` nodes (`funcname`, `names`, operator `name`). */
export function names(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const item of list) {
    const n = nodeType(item)
    const s = n?.type === 'String' ? n.body['sval'] : undefined
    if (typeof s !== 'string') return undefined
    out.push(s)
  }
  return out
}
