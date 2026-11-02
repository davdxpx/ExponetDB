import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE_LIST } from '@exponetdb/contracts'
import { expect } from 'vitest'
import { run } from '../src/main.ts'
import { testIo } from './support.ts'

/**
 * A small fake REST server behind a fake `fetch` for CLI tests: success bodies are checked against
 * the route's response schema before they are served (as the CLI checks them), every request is
 * recorded, and the installation answer can be changed per test. `backups.test.ts` carries the
 * larger fixture set of the backup commands.
 */
const ROUTES = new Map(ROUTE_LIST.map((r) => [r.operationId, r]))

export const SERVER = 'https://db.example.test'

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: unknown
}

export type Answer = readonly [status: number, body: unknown]
type Handler = (req: Recorded) => Answer

export const ulid = (prefix: string, n: number) => `${prefix}_01J${String(n).padStart(23, '0')}`

export const INSTALLATION = {
  version: '0.9.0',
  contracts: {
    restApi: 'v1',
    mcpCatalog: 'exponetdb.mcp/v1',
    nodeProtocol: 'exponetdb.node/v1',
    migrationManifest: 'exponetdb.migration/v1',
    projectConfig: 'exponetdb.project/v1',
  },
  features: [],
}

/** A success body, checked against the operation's response schema first. */
export function ok(operationId: string, body: unknown): Answer {
  const route = ROUTES.get(operationId)
  if (route === undefined) throw new Error(`no route ${operationId}`)
  const parsed = route.response.schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`fixture for ${operationId} is invalid: ${JSON.stringify(parsed.error.issues)}`)
  }
  return [route.response.status, body]
}

export const refusal = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): Answer => [
  status,
  { code, title: code, message: `Refused: ${code}.`, retryable: false, ...extra },
]

export class FakeApi {
  readonly requests: Recorded[] = []
  /** The body of `GET /installation`; a test may replace it to play another server version. */
  installation: unknown = INSTALLATION
  readonly #handlers = new Map<string, Handler>()
  dir = ''

  /** Registers an answer for `METHOD /path` (the path under /api/v1). */
  on(method: string, path: string, handler: Handler | Answer): void {
    this.#handlers.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler)
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const method = init?.method ?? 'GET'
    if (path === '/installation') return Response.json(this.installation)
    this.requests.push({
      method,
      path,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const handler = this.#handlers.get(`${method} ${path}`)
    if (handler === undefined) return Response.json(refusal(404, 'NOT_FOUND')[1], { status: 404 })
    const [status, body] = handler(this.requests.at(-1) as Recorded)
    return Response.json(body, { status })
  }

  async cli(argv: readonly string[], extra: Partial<Parameters<typeof testIo>[0]> = {}) {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await run(
      argv,
      testIo({
        configDir: join(this.dir, 'config'),
        cwd: this.dir,
        fetch: this.fetch,
        stdout,
        stderr,
        now: () => Date.parse('2026-10-26T12:00:00.000Z'),
        ...extra,
      }),
    )
    return { code, stdout: stdout.join(''), stderr: stderr.join('') }
  }

  /** A signed-in profile named `lab` on a fresh temporary directory. */
  async open(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), 'exdb-cli-fake-'))
    const key = join(this.dir, 'k.txt')
    await writeFile(key, `exak_${'k'.repeat(32)}\n`)
    await chmod(key, 0o600)
    const add = await this.cli([
      'profile',
      'add',
      'lab',
      '--server',
      SERVER,
      '--auth',
      'api-key',
      '--key-file',
      key,
    ])
    expect(add.code, add.stderr).toBe(0)
    expect((await this.cli(['profile', 'use', 'lab'])).code).toBe(0)
  }

  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }
}
