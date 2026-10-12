import {
  MCP_ERROR_CODES,
  MCP_LEGACY_VERSIONS,
  MCP_META_KEYS,
  MCP_MODERN_VERSIONS,
  MCP_SERVED_VERSIONS,
  type McpEra,
} from '@exponetdb/contracts'

/**
 * The era of every POST to `/mcp`, decided before anything else runs
 * ([protocol-baseline.md §4](../../../../../exponetdb-docs/05-mcp/protocol-baseline.md#4-classification-of-a-request)).
 * A pure function: the table in the baseline is its oracle, and the
 * protocol suite checks the endpoint (this function and the SDK behind it)
 * against that table. The header ladder of the modern era that the SDK
 * checks itself (`Mcp-Method`, `Mcp-Name`) is left to it; the version
 * ladder is answered here.
 */

/** A JSON-RPC message that passed the shape check. */
export interface RpcMessage {
  readonly jsonrpc: '2.0'
  readonly method: string
  /** Absent for a notification. */
  readonly id?: string | number
  readonly params?: Readonly<Record<string, unknown>>
}

export interface ClassifyHeaders {
  readonly protocolVersion?: string
}

export interface Refusal {
  readonly kind: 'refuse'
  readonly status: 400 | 404
  readonly code: number
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export type Classified =
  | { readonly kind: 'modern'; readonly version: string }
  /** `version` undefined: no header (the 2025-11-25 transport says: assume 2025-03-26 and serve). */
  | { readonly kind: 'legacy'; readonly version: string | undefined }
  | Refusal

export type ShapeRefusal = {
  readonly kind: 'refuse'
  readonly status: 400
  readonly code: number
  readonly message: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One JSON-RPC request or notification, nothing else (no batch, no response, no null id). */
export function checkShape(body: unknown): RpcMessage | ShapeRefusal {
  const invalid = (message: string): ShapeRefusal => ({
    kind: 'refuse',
    status: 400,
    code: MCP_ERROR_CODES.invalidRequest,
    message,
  })
  if (Array.isArray(body)) {
    return invalid('A POST carries exactly one JSON-RPC message; batches are not accepted.')
  }
  if (!isObject(body)) {
    return invalid('The body is not a JSON-RPC message.')
  }
  if (body['jsonrpc'] !== '2.0') {
    return invalid('The message is not JSON-RPC 2.0.')
  }
  if ('result' in body || 'error' in body) {
    return invalid('A client does not send responses to the server.')
  }
  const method = body['method']
  if (typeof method !== 'string' || method.length === 0 || method.length > 128) {
    return invalid('The message has no method.')
  }
  if ('id' in body) {
    const id = body['id']
    const valid =
      (typeof id === 'string' && id.length > 0 && id.length <= 256) ||
      (typeof id === 'number' && Number.isSafeInteger(id))
    if (!valid) {
      return invalid('A request id is a string or an integer, never null.')
    }
  }
  const params = body['params']
  if (params !== undefined && !isObject(params)) {
    return invalid('Parameters are an object.')
  }
  return {
    jsonrpc: '2.0',
    method,
    ...('id' in body ? { id: body['id'] as string | number } : {}),
    ...(params === undefined ? {} : { params }),
  }
}

const MODERN: readonly string[] = MCP_MODERN_VERSIONS
const LEGACY: readonly string[] = MCP_LEGACY_VERSIONS

/**
 * `-32022`. A request with a modern envelope learns the versions it can use
 * with an envelope (what `server/discover` lists: a client checks that the
 * two agree); a request without one learns every served version, since a
 * legacy client starts over with `initialize`.
 */
function unsupported(requested: string, supported: readonly string[]): Refusal {
  return {
    kind: 'refuse',
    status: 400,
    code: MCP_ERROR_CODES.unsupportedProtocolVersion,
    message: 'Unsupported protocol version',
    data: { supported: [...supported], requested },
  }
}

export function classify(message: RpcMessage, headers: ClassifyHeaders): Classified {
  const meta = message.params?.['_meta']
  const envelope = isObject(meta) ? meta : undefined
  const claim =
    envelope !== undefined &&
    (MCP_META_KEYS.protocolVersion in envelope || MCP_META_KEYS.clientCapabilities in envelope)
  const header = headers.protocolVersion?.trim()
  if (claim) {
    const version = envelope[MCP_META_KEYS.protocolVersion]
    const capabilities = envelope[MCP_META_KEYS.clientCapabilities]
    if (typeof version !== 'string' || !isObject(capabilities)) {
      return {
        kind: 'refuse',
        status: 400,
        code: MCP_ERROR_CODES.invalidParams,
        message:
          'Invalid params: every request carries io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities in _meta.',
      }
    }
    if (header === undefined || header === '' || header !== version) {
      return {
        kind: 'refuse',
        status: 400,
        code: MCP_ERROR_CODES.headerMismatch,
        message: 'Bad Request: the MCP-Protocol-Version header must equal the version in _meta.',
      }
    }
    if (!MODERN.includes(version)) {
      // An unknown version, or a legacy one in a modern envelope (a legacy client starts with initialize).
      return unsupported(version, MODERN)
    }
    return { kind: 'modern', version }
  }
  if (message.method === 'initialize') {
    // The handshake negotiates the version itself (an unserved offer is answered with 2025-11-25).
    return { kind: 'legacy', version: undefined }
  }
  if (header === undefined || header === '') {
    return { kind: 'legacy', version: undefined }
  }
  if (MODERN.includes(header)) {
    if (message.id === undefined) {
      // A notification need not carry the envelope; it is acknowledged and has no effect.
      return { kind: 'modern', version: header }
    }
    return {
      kind: 'refuse',
      status: 400,
      code: MCP_ERROR_CODES.invalidParams,
      message: `Invalid params: the MCP-Protocol-Version header names ${header}, but the request has no _meta envelope.`,
    }
  }
  if (LEGACY.includes(header)) {
    return { kind: 'legacy', version: header }
  }
  return unsupported(header, MCP_SERVED_VERSIONS)
}

export function eraOf(classified: Classified): McpEra | undefined {
  return classified.kind === 'refuse' ? undefined : classified.kind
}
