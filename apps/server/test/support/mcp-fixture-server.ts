import { listen } from '../../src/roles/lifecycle.ts'
import { TOKEN, type WorldOptions, world } from './mcp-world.ts'

/**
 * The test composition of `/mcp` on a real port (support/mcp-world.ts),
 * for tools that speak HTTP: the conformance suite and the reference
 * clients. `injectToken` adds the fixture token to requests that carry no
 * `Authorization` header, because the conformance suite tests the protocol
 * and has no way to send one; authentication itself is tested by the
 * protocol suite and the integration suite. Tests only.
 */
export interface McpFixture {
  readonly url: string
  readonly lines: string[]
  stop(): Promise<void>
}

export async function startMcpFixture(
  options: WorldOptions & { readonly injectToken?: boolean } = {},
): Promise<McpFixture> {
  let target: ((request: Request) => Response | Promise<Response>) | undefined
  const lines: string[] = []
  const listener = await listen(
    (request) => {
      if (target === undefined) {
        return new Response(null, { status: 503 })
      }
      if (options.injectToken === true && !request.headers.has('authorization')) {
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${TOKEN}`)
        return target(new Request(request, { headers, duplex: 'half' } as RequestInit))
      }
      return target(request)
    },
    { host: '127.0.0.1', port: 0 },
  )
  const origin = `http://127.0.0.1:${listener.port}`
  // Behind a proxy the public origin is the proxy's (the Host the server checks).
  const composed = world({ ...options, publicOrigin: options.publicOrigin ?? origin })
  target = (request) => composed.app.fetch(request)
  return {
    url: `${origin}/mcp`,
    get lines() {
      return composed.lines.concat(lines)
    },
    stop: () => listener.close(1000),
  }
}

if (import.meta.main) {
  const fixture = await startMcpFixture({ injectToken: process.argv.includes('--inject-token') })
  process.stdout.write(`${fixture.url}\n`)
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
  await fixture.stop()
}
