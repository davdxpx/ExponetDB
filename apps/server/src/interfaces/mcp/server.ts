import {
  EXPONETDB_META_KEYS,
  MCP_CACHE,
  MCP_CATALOG_VERSION,
  MCP_ERROR_CODES,
  MCP_INSTRUCTIONS,
  MCP_SERVED_VERSIONS,
  type McpEra,
  mcpCatalogDigest,
} from '@exponetdb/contracts'
import { describeError, type Logger } from '@exponetdb/observability'
import {
  type AuthInfo,
  inputRequired,
  type McpServerFactory,
  ProtocolError,
  Server,
} from '@modelcontextprotocol/server'
import type { McpCallContext, ToolHost } from './registry.ts'
import type { ResourceHost } from './resources.ts'
import { renderError, toolError } from './results.ts'

/**
 * The MCP server behind the edge (ADR-0027 §2): the SDK's low-level
 * `Server`, one fresh instance per request (both eras, stateless), with
 * only `tools` declared in Wave 7's first phases. The SDK owns the
 * JSON-RPC framing, the modern header ladder (`Mcp-Method`, `Mcp-Name`),
 * `server/discover`, `initialize` and `ping`; ExponetDB owns everything a
 * tool does, and no handler ever throws text the SDK would send raw.
 */

/** Where the edge hands the request's context to the factory (pass-through `authInfo.extra`). */
const CONTEXT_KEY = 'exponetdb'

export function authInfoOf(ctx: McpCallContext, resource: string): AuthInfo {
  return {
    // The SDK never sees the token: verification already happened at the edge.
    token: 'redacted',
    clientId:
      ctx.principal.delegation.credential.type === 'access_token'
        ? ctx.principal.delegation.credential.clientId
        : 'api_key',
    scopes: [...ctx.principal.delegation.scopes].sort(),
    resource: new URL(resource),
    extra: { [CONTEXT_KEY]: ctx },
  }
}

function contextOf(authInfo: AuthInfo | undefined): McpCallContext | undefined {
  const value = authInfo?.extra?.[CONTEXT_KEY]
  return typeof value === 'object' && value !== null ? (value as McpCallContext) : undefined
}

export interface ServerDeps {
  readonly tools: ToolHost
  readonly resources: ResourceHost
  readonly version: string
  readonly logger: Logger
}

/** `data.uri` of a not-found error (SEP-2164 SHOULD): only a plain, short URI is echoed. */
function uriData(uri: string): { uri: string } | undefined {
  return uri.length <= 256 && /^[\x21-\x7e]+$/.test(uri) ? { uri } : undefined
}

export function mcpServerFactory(deps: ServerDeps): McpServerFactory {
  return ({ era, authInfo }) => {
    const server = new Server(
      { name: 'exponetdb', title: 'ExponetDB', version: deps.version },
      {
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        instructions: MCP_INSTRUCTIONS,
        supportedProtocolVersions: [...MCP_SERVED_VERSIONS],
        cacheHints: {
          'tools/list': { ttlMs: MCP_CACHE.privateListTtlMs, cacheScope: 'private' },
          'server/discover': { ttlMs: MCP_CACHE.privateListTtlMs, cacheScope: 'private' },
          // The list names the targets this grant can see.
          'resources/list': { ttlMs: MCP_CACHE.privateListTtlMs, cacheScope: 'private' },
          'resources/templates/list': {
            ttlMs: MCP_CACHE.staticResourceTtlMs,
            cacheScope: 'public',
          },
        },
        // Stateless legacy has no back channel: an approval is a link in the result, never a server request.
        inputRequired: { legacyShim: false },
      },
    )
    const ctx = contextOf(authInfo)
    if (ctx === undefined || ctx.era !== (era satisfies McpEra)) {
      // The SDK classified the request differently from the edge (the oracle):
      // serve nothing (every method answers -32601) and report it.
      deps.logger.error('mcp.classification_mismatch', {
        ...(ctx === undefined ? {} : { era: ctx.era }),
        reason: era,
      })
      if (ctx !== undefined) ctx.outcome = 'classification_mismatch'
      return server
    }
    server.setRequestHandler('tools/list', async (request) => {
      if (request.params?.cursor !== undefined) {
        // One page holds the whole list; a cursor is never issued.
        throw new ProtocolError(MCP_ERROR_CODES.invalidParams, 'Invalid params: unknown cursor.')
      }
      const tools = deps.tools.list(ctx)
      ctx.outcome = 'ok'
      ctx.catalogDigest = mcpCatalogDigest(tools)
      return {
        tools: tools as never,
        _meta: {
          [EXPONETDB_META_KEYS.catalog]: MCP_CATALOG_VERSION,
          [EXPONETDB_META_KEYS.catalogDigest]: ctx.catalogDigest,
        },
      }
    })
    /** A failure the hosts did not map is a defect: logged, answered without its text. */
    const internal = (error: unknown): never => {
      if (error instanceof ProtocolError) throw error
      deps.logger.error('mcp.handler_failed', { ...describeError(error) })
      ctx.outcome = 'INTERNAL'
      throw new ProtocolError(MCP_ERROR_CODES.internalError, 'Internal error.')
    }
    server.setRequestHandler('resources/list', async (request) => {
      const listed = await deps.resources.list(ctx, request.params?.cursor).catch(internal)
      if (listed.kind === 'invalid_cursor') {
        throw new ProtocolError(MCP_ERROR_CODES.invalidParams, 'Invalid params: unknown cursor.')
      }
      ctx.outcome = 'ok'
      return {
        resources: listed.resources,
        ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      }
    })
    // No templates (order §23): the list is empty, never "method not found".
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }))
    server.setRequestHandler('resources/read', async (request) => {
      const uri = request.params.uri
      const read = await deps.resources.read(ctx, uri).catch(internal)
      if (read.kind === 'not_found') {
        ctx.outcome = 'resource_not_found'
        throw new ProtocolError(
          ctx.era === 'modern'
            ? MCP_ERROR_CODES.invalidParams
            : MCP_ERROR_CODES.legacyResourceNotFound,
          'Resource not found',
          uriData(uri),
        )
      }
      if (read.kind === 'refused') {
        ctx.outcome = read.code
        // A failure of ExponetDB is not the client's invalid parameter (as `internal` above).
        if (read.code === 'INTERNAL' || read.code === 'CONTROL_PLANE_DEGRADED') {
          throw new ProtocolError(MCP_ERROR_CODES.internalError, 'Internal error.')
        }
        throw new ProtocolError(MCP_ERROR_CODES.invalidParams, 'Resource not readable', {
          code: read.code,
          ...uriData(uri),
        })
      }
      ctx.outcome = 'ok'
      return {
        contents: [{ uri: read.uri, mimeType: read.mimeType, text: read.text }],
        // Modern results carry their own cache fields (a static guide is public).
        ...(ctx.era === 'modern' ? read.cache : {}),
      }
    })
    server.setRequestHandler('tools/call', async (request, extra) => {
      const name = request.params.name
      if (!deps.tools.has(name)) {
        // The name is never echoed: it is client text.
        ctx.outcome = 'unknown_tool'
        throw new ProtocolError(MCP_ERROR_CODES.invalidParams, 'Invalid params: unknown tool.')
      }
      ctx.follow(extra.mcpReq.signal)
      try {
        // A retry's sealed state (modern era); its inputResponses are never read as a decision.
        const state = ctx.era === 'modern' ? extra.mcpReq.requestState<unknown>() : undefined
        const outcome = await deps.tools.call(ctx, name, request.params.arguments ?? {}, {
          requestState: typeof state === 'string' ? state : undefined,
        })
        if (outcome.kind === 'error') {
          return { content: [{ type: 'text', text: outcome.text }], isError: true }
        }
        if (outcome.kind === 'input_required') {
          return inputRequired({
            inputRequests: {
              approval: inputRequired.elicitUrl({ url: outcome.url, message: outcome.message }),
            },
            requestState: outcome.requestState,
          }) as never
        }
        return {
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.structured,
        }
      } catch (error) {
        // The host maps every refusal itself; anything left is a defect, never sent raw.
        deps.logger.error('mcp.handler_failed', { ...describeError(error), tool: name })
        ctx.outcome = 'INTERNAL'
        const internal = toolError({ code: 'INTERNAL', requestId: ctx.requestId })
        return { content: [{ type: 'text', text: renderError(internal) }], isError: true }
      }
    })
    return server
  }
}
