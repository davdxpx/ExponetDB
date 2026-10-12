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
  type McpServerFactory,
  ProtocolError,
  Server,
} from '@modelcontextprotocol/server'
import type { McpCallContext, ToolHost } from './registry.ts'
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
  readonly version: string
  readonly logger: Logger
}

export function mcpServerFactory(deps: ServerDeps): McpServerFactory {
  return ({ era, authInfo }) => {
    const server = new Server(
      { name: 'exponetdb', title: 'ExponetDB', version: deps.version },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: MCP_INSTRUCTIONS,
        supportedProtocolVersions: [...MCP_SERVED_VERSIONS],
        cacheHints: {
          'tools/list': { ttlMs: MCP_CACHE.privateListTtlMs, cacheScope: 'private' },
          'server/discover': { ttlMs: MCP_CACHE.privateListTtlMs, cacheScope: 'private' },
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
      return {
        tools: tools as never,
        _meta: {
          [EXPONETDB_META_KEYS.catalog]: MCP_CATALOG_VERSION,
          [EXPONETDB_META_KEYS.catalogDigest]: mcpCatalogDigest(tools),
        },
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
        const outcome = await deps.tools.call(ctx, name, request.params.arguments ?? {})
        if (outcome.kind === 'error') {
          return { content: [{ type: 'text', text: outcome.text }], isError: true }
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
