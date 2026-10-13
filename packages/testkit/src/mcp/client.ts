import {
  Client,
  type ClientCapabilities,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { TranscriptRecorder } from './transcript.ts'

/**
 * The reference client of the Wave 7 order (§33): the official MCP SDK
 * client (`@modelcontextprotocol/client`, exactly pinned; only this
 * package may depend on it), at a fixed era or negotiating one, over
 * real sockets (`url` of a running server or the lab) or in process
 * (`fetch` is the handler of the app: no socket at all).
 *
 * Tokens come from the auth package's test helpers or from a test's own
 * code flow; never from a person's configuration (`~/.config`,
 * `~/.claude`, `~/.codex`).
 */
export type ProtocolEra = 'modern' | 'legacy' | 'auto'

export const MODERN_REVISION = '2026-07-28'

export interface ProtocolClientOptions {
  readonly era: ProtocolEra
  /** The bearer token (audience `mcp`). */
  readonly token: string
  /** The `/mcp` endpoint, e.g. `http://localhost:8480/mcp`. */
  readonly url: string
  /** In-process: the app's request function instead of the network. */
  readonly fetch?: FetchLike
  /** Records every JSON-RPC message and answer (replay, §29). */
  readonly recorder?: TranscriptRecorder
  readonly capabilities?: ClientCapabilities
  readonly name?: string
}

export interface ProtocolClient {
  readonly client: Client
  close(): Promise<void>
}

export async function createProtocolClient(
  options: ProtocolClientOptions,
): Promise<ProtocolClient> {
  const base: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const send: FetchLike = options.recorder === undefined ? base : options.recorder.wrap(base)
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: send,
    requestInit: { headers: { authorization: `Bearer ${options.token}` } },
  })
  const client = new Client(
    { name: options.name ?? 'exponetdb-testkit', version: '0.0.0' },
    {
      capabilities: options.capabilities ?? {},
      versionNegotiation: {
        mode:
          options.era === 'modern'
            ? { pin: MODERN_REVISION }
            : options.era === 'auto'
              ? 'auto'
              : 'legacy',
      },
    },
  )
  await client.connect(transport)
  return {
    client,
    async close() {
      await client.close()
    },
  }
}
