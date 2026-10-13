import { newId, newUlid } from '@exponetdb/kernel'
import type { FetchLike } from '@modelcontextprotocol/client'

/**
 * Transcripts of MCP sessions for replay tests (Wave 7 order §29, §33):
 * the JSON-RPC messages a client sent and the answers it got, normalized
 * so that a recording stays comparable across runs and machines.
 *
 * Format `exponetdb.mcp-transcript/v1` (JSON Lines): a header line, then
 * one line per HTTP exchange with the request's JSON-RPC message, the
 * protocol headers and the answer (status and the JSON-RPC messages, from
 * a JSON body or an event stream). Normalization replaces every value
 * that differs per run by a placeholder numbered by first appearance:
 * entity ids (`<tgt:1>`), bare ULIDs (`<ulid:1>`), digests (`<sha256:1>`,
 * except the catalog digest, which must not change), timestamps
 * (`<time>`), durations, sealed cursors and request states, and the
 * per-answer data marker. Tokens never appear: they travel in a header the
 * recorder does not keep.
 *
 * Provenance is part of the header: a transcript made by a scripted test
 * session is `synthetic`; one taken from a real client names the client,
 * its version and the date. Nothing synthetic is ever called real.
 */
export const TRANSCRIPT_FORMAT = 'exponetdb.mcp-transcript/v1'

export interface TranscriptHeader {
  readonly format: typeof TRANSCRIPT_FORMAT
  readonly name: string
  readonly era: 'modern' | 'legacy' | 'auto'
  readonly provenance:
    | { readonly kind: 'synthetic'; readonly producer: string }
    | {
        readonly kind: 'recorded'
        readonly client: string
        readonly clientVersion: string
        readonly recordedOn: string
      }
  /** The fixture the session ran against. */
  readonly fixture: string
}

export interface Exchange {
  readonly request: {
    /** `POST` for messages; a client's `GET` (a standalone stream) or `DELETE` is kept too. */
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: unknown
  }
  readonly response: { readonly status: number; readonly messages: readonly unknown[] }
}

const ENTITY_ID = /\b([a-z]{2,4})_[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/g
/** A bare ULID, also as the prefix of a bundle directory (`<ULID>_<slug>`). */
const ULID = /(?<![0-9A-Za-z])[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/g
/** Measured or sealed members inside a quoted JSON text block. */
const QUOTED_MEASURED = /"(durationMs|retryAfterSeconds)":\d+/g
/** The measured duration in the last server line of a tool result (`Request req_…, N ms.`). */
const MEASURED_LINE = /(\bRequest [^\s,]+, )\d+( ms\.)/g
const QUOTED_OPAQUE = /"(nextCursor|cursor|requestState|databaseOid|systemIdentifier)":"[^"]*"/g
const DIGEST = /\bsha256:(?:[a-z0-9]{2,8}:)?[0-9a-f]{64}\b/g
const TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b/g
const MARKER = /exponetdb-data-[0-9a-f]{12}/g
const STATE = /\brs1\.\d+\.[A-Za-z0-9_-]{16,}/g
/** Keys whose numeric value is a measurement, not a result. */
const MEASURED = new Set(['durationMs', 'retryAfterSeconds', 'cloud.exponet.db/durationMs'])
/** Keys whose value is opaque per run (sealed by the server, or the test cluster's own identity). */
const OPAQUE = new Set(['nextCursor', 'cursor', 'requestState', 'databaseOid', 'systemIdentifier'])
/** Keys whose value must stay exact: the catalog digest is the rug-pull check. */
const EXACT = new Set(['cloud.exponet.db/catalogDigest'])
/** The protocol headers kept in a transcript (never `authorization`). */
const KEPT_HEADERS = ['mcp-protocol-version', 'mcp-method', 'mcp-name']

/**
 * Replaces per-run values by numbered placeholders; the same value always
 * gets the same placeholder within one normalizer, and `resolve` maps a
 * placeholder back to the value it stood for in this run.
 */
export class Normalizer {
  readonly #forward = new Map<string, string>()
  readonly #back = new Map<string, string>()
  readonly #counts = new Map<string, number>()
  readonly #literals: [string, string][] = []

  /**
   * A per-run literal of the fixture (a generated slug) that appears inside
   * other values: replaced wherever it occurs, resolved back on replay.
   */
  literal(value: string, placeholder: string): this {
    this.#literals.push([value, placeholder])
    this.#back.set(placeholder, value)
    return this
  }

  #name(kind: string, value: string): string {
    const known = this.#forward.get(value)
    if (known !== undefined) return known
    const n = (this.#counts.get(kind) ?? 0) + 1
    this.#counts.set(kind, n)
    const placeholder = `<${kind}:${n}>`
    this.#forward.set(value, placeholder)
    this.#back.set(placeholder, value)
    return placeholder
  }

  /** Binds a placeholder to a value of this run (a fresh id a replayed request needs). */
  bind(placeholder: string, value: string): void {
    this.#forward.set(value, placeholder)
    this.#back.set(placeholder, value)
  }

  resolve(placeholder: string): string | undefined {
    return this.#back.get(placeholder)
  }

  text(value: string): string {
    let out = value
    for (const [literal, placeholder] of this.#literals) out = out.split(literal).join(placeholder)
    return out
      .replace(QUOTED_MEASURED, '"$1":0')
      .replace(MEASURED_LINE, (_line, head: string, tail: string) => `${head}0${tail}`)
      .replace(QUOTED_OPAQUE, '"$1":"<$1>"')
      .replace(STATE, '<requestState>')
      .replace(MARKER, 'exponetdb-data-<marker>')
      .replace(DIGEST, (d) => this.#name('sha256', d))
      .replace(ENTITY_ID, (id, prefix: string) => this.#name(prefix, id))
      .replace(ULID, (u) => this.#name('ulid', u))
      .replace(TIME, '<time>')
  }

  value(input: unknown, key?: string): unknown {
    if (key !== undefined && EXACT.has(key)) return input
    if (key !== undefined && OPAQUE.has(key) && typeof input === 'string') return `<${key}>`
    if (key !== undefined && MEASURED.has(key) && typeof input === 'number') return 0
    if (typeof input === 'string') {
      // A text block quotes JSON: normalize inside it the same way.
      return this.text(input)
    }
    if (Array.isArray(input)) return input.map((v) => this.value(v))
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, this.value(v, k)]),
      )
    }
    return input
  }
}

const PLACEHOLDER = /<([a-z]{2,6}):(\d+)>/g
const LITERAL = /<([a-z]+)>/g

/**
 * Turns a recorded (normalized) request back into one for this run: a
 * placeholder this run has seen becomes its value; one it has not seen (a
 * fresh id the client chose: a `queryId`, an idempotency key) becomes a
 * new id of the same kind.
 */
export function denormalize(input: unknown, n: Normalizer, now = Date.now()): unknown {
  if (typeof input === 'string') {
    const literals = input.replace(LITERAL, (placeholder) => n.resolve(placeholder) ?? placeholder)
    return literals.replace(PLACEHOLDER, (placeholder, kind: string) => {
      const known = n.resolve(placeholder)
      if (known !== undefined) return known
      const fresh =
        kind === 'ulid'
          ? newUlid(now)
          : kind === 'sha256'
            ? placeholder
            : newId(kind as Parameters<typeof newId>[0], now)
      n.bind(placeholder, fresh)
      return fresh
    })
  }
  if (Array.isArray(input)) return input.map((v) => denormalize(v, n, now))
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, denormalize(v, n, now)]),
    )
  }
  return input
}

/** The JSON-RPC messages of an answer: a JSON body or the `data:` lines of an event stream. */
export function messagesOf(contentType: string | null, text: string): unknown[] {
  if (text.length === 0) return []
  if ((contentType ?? '').includes('text/event-stream')) {
    const out: unknown[] = []
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data.length > 0) out.push(JSON.parse(data))
    }
    return out
  }
  try {
    return [JSON.parse(text)]
  } catch {
    return [{ nonJson: text.slice(0, 200) }]
  }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const h = new Headers(init?.headers)
  const out: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const v = h.get(name)
    if (v !== null) out[name] = v
  }
  return out
}

/** Records the exchanges of one client, normalized as they happen. */
export class TranscriptRecorder {
  readonly exchanges: Exchange[] = []
  readonly normalizer: Normalizer

  constructor(normalizer = new Normalizer()) {
    this.normalizer = normalizer
  }

  wrap(inner: FetchLike): FetchLike {
    return async (input, init) => {
      const raw = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      const request = {
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: this.normalizer.value(headersOf(init)) as Record<string, string>,
        body: this.normalizer.value(raw),
      }
      const response = await inner(input, init)
      const text = await response.clone().text()
      this.exchanges.push({
        request,
        response: {
          status: response.status,
          messages: this.normalizer.value(
            messagesOf(response.headers.get('content-type'), text),
          ) as unknown[],
        },
      })
      return response
    }
  }

  /** The transcript as JSON Lines. */
  serialize(header: TranscriptHeader): string {
    return `${[header, ...this.exchanges].map((line) => JSON.stringify(line)).join('\n')}\n`
  }
}

export function parseTranscript(text: string): { header: TranscriptHeader; exchanges: Exchange[] } {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const header = JSON.parse(lines[0] ?? '{}') as TranscriptHeader
  if (header.format !== TRANSCRIPT_FORMAT) {
    throw new Error(`not a ${TRANSCRIPT_FORMAT} transcript`)
  }
  return { header, exchanges: lines.slice(1).map((l) => JSON.parse(l) as Exchange) }
}

/** The first path where two normalized values differ, or undefined. */
export function firstDifference(expected: unknown, actual: unknown, path = ''): string | undefined {
  if (Object.is(expected, actual)) return undefined
  if (typeof expected === 'string' && typeof actual === 'string') {
    let i = 0
    while (i < expected.length && expected[i] === actual[i]) i++
    const from = Math.max(0, i - 40)
    return `${path || '/'} at character ${i}: expected …${JSON.stringify(expected.slice(from, i + 80))}, got …${JSON.stringify(actual.slice(from, i + 80))}`
  }
  if (
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    expected === null ||
    actual === null ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return `${path || '/'}: expected ${JSON.stringify(expected)?.slice(0, 120)}, got ${JSON.stringify(actual)?.slice(0, 120)}`
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length) {
    return `${path || '/'}: expected ${expected.length} items, got ${actual.length}`
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const k of [...keys].sort()) {
    const d = firstDifference(
      (expected as Record<string, unknown>)[k],
      (actual as Record<string, unknown>)[k],
      `${path}/${k}`,
    )
    if (d !== undefined) return d
  }
  return undefined
}

/**
 * Replays a recorded transcript: sends each recorded request (its
 * placeholders resolved for this run) through `send` and compares each
 * normalized answer with the recording. Returns the differences, one per
 * exchange that differs; an empty list is a faithful replay.
 */
export async function replayTranscript(
  exchanges: readonly Exchange[],
  send: (method: string, headers: Record<string, string>, body: unknown) => Promise<Response>,
  options: {
    /** The fixture's literals, as the recording named them. */
    readonly normalizer?: Normalizer
    /** Runs before an exchange is sent (the worker's turn before an observation). */
    readonly before?: (body: unknown) => Promise<void>
  } = {},
): Promise<string[]> {
  const n = options.normalizer ?? new Normalizer()
  const differences: string[] = []
  for (const [i, recorded] of exchanges.entries()) {
    const headers = denormalize(recorded.request.headers, n) as Record<string, string>
    const body = denormalize(recorded.request.body, n)
    await options.before?.(body)
    // The request passes through the normalizer like the recording did (same numbering).
    n.value(headersOf({ headers }))
    n.value(body)
    const response = await send(recorded.request.method, headers, body)
    const text = await response.text()
    const actual = {
      status: response.status,
      messages: n.value(messagesOf(response.headers.get('content-type'), text)),
    }
    const d = firstDifference(recorded.response, actual)
    if (d !== undefined) differences.push(`exchange ${i + 1}: ${d}`)
  }
  return differences
}
