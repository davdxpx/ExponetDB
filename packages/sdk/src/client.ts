import {
  type Authenticator,
  type AuthOptions,
  apiKeyAuthenticator,
  serviceAccountAuthenticator,
} from './auth.ts'
import type { OperationId, Operations } from './generated/api.ts'
import { err, ok, type Result } from './result.ts'
import { request, type TransportOptions } from './transport.ts'

/**
 * The ExponetDB client (sdk.md §2, §3; order §124 to §126). Namespaces
 * follow the REST resources; every method is one request (pagination
 * helpers repeat it with the server's cursor). The SDK decides nothing the
 * server decides: no authorization, no policy, no plans, no tiers, no
 * drift. It never accepts a database connection string.
 */
export interface ExponetDBOptions {
  /** The installation's public origin, e.g. `https://db.exponet.cloud`. */
  readonly baseUrl: string
  readonly auth: AuthOptions
  /** A `fetch` implementation (default: the global one). */
  readonly fetch?: typeof fetch
  /** Per-request deadline (default 30 s). */
  readonly timeoutMs?: number
}

export const SDK_VERSION = '1.0.0-alpha.1'
/** The REST API version this SDK speaks (`GET /installation` reports the server's). */
export const REST_API_VERSION = 'v1'

type Response<Id extends OperationId> = Operations[Id]['response']
type Query<Id extends OperationId> = Operations[Id]['query']
type PageOf<Id extends OperationId> =
  Response<Id> extends {
    readonly items: ReadonlyArray<infer T>
    readonly nextCursor: string | null
  }
    ? T
    : never

export class ExponetDB {
  readonly #t: TransportOptions

  constructor(options: ExponetDBOptions) {
    const base = new URL(options.baseUrl)
    if (
      base.protocol !== 'https:' &&
      base.hostname !== 'localhost' &&
      base.hostname !== '127.0.0.1'
    ) {
      throw new TypeError('The base URL is https (plain http only for localhost).')
    }
    if (base.username !== '' || base.password !== '') {
      throw new TypeError('The base URL carries no credentials.')
    }
    const fetchImpl = options.fetch ?? globalThis.fetch
    const timeoutMs = options.timeoutMs ?? 30_000
    const auth: Authenticator =
      options.auth.kind === 'apiKey'
        ? apiKeyAuthenticator(options.auth.key)
        : serviceAccountAuthenticator(options.auth, {
            baseUrl: base.origin,
            fetch: fetchImpl,
            now: () => Date.now(),
            timeoutMs,
          })
    this.#t = {
      baseUrl: base.origin,
      auth,
      fetch: fetchImpl,
      timeoutMs,
      userAgent: `exponetdb-sdk/${SDK_VERSION}`,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
  }

  #call<Id extends OperationId>(
    id: Id,
    input: Parameters<typeof request<Id>>[2] = {},
  ): Promise<Result<Response<Id>>> {
    return request(this.#t, id, input)
  }

  /** Every page of a list, in order; stops at the first error (which is yielded). */
  async *#pages<Id extends OperationId>(
    id: Id,
    params: Operations[Id]['params'] | undefined,
    query: Query<Id>,
  ): AsyncGenerator<Result<Response<Id>>> {
    let cursor: string | undefined
    for (;;) {
      const page = await this.#call(id, {
        ...(params === undefined ? {} : { params }),
        query: { ...query, ...(cursor === undefined ? {} : { cursor }) } as Query<Id>,
      })
      yield page
      if (!page.ok) return
      const next = (page.value as { readonly nextCursor?: string | null }).nextCursor
      if (next === null || next === undefined) return
      cursor = next
    }
  }

  /** Every item of a list (at most `maxItems`, default 10,000), or the first error. */
  async #all<Id extends OperationId>(
    id: Id,
    params: Operations[Id]['params'] | undefined,
    query: Query<Id>,
    maxItems = 10_000,
  ): Promise<Result<PageOf<Id>[]>> {
    const items: PageOf<Id>[] = []
    if (maxItems < 1) return ok(items)
    for await (const page of this.#pages(id, params, query)) {
      if (!page.ok) return err(page.error)
      for (const item of (page.value as { readonly items: readonly PageOf<Id>[] }).items) {
        items.push(item)
        // Enough: no further page is asked for.
        if (items.length >= maxItems) return ok(items)
      }
    }
    return ok(items)
  }

  readonly installation = {
    /** The server's release and contract versions. */
    get: () => this.#call('getInstallation'),
    /** Whether the server speaks this SDK's REST API version. */
    compatible: async (): Promise<Result<boolean>> => {
      const i = await this.#call('getInstallation')
      return i.ok ? ok(i.value.contracts.restApi === REST_API_VERSION) : i
    },
  }

  readonly products = {
    list: (query: Query<'listProducts'> = {}) => this.#call('listProducts', { query }),
    all: (query: Query<'listProducts'> = {}) => this.#all('listProducts', undefined, query),
    get: (productId: string) => this.#call('getProduct', { params: { productId } }),
  }

  readonly environments = {
    list: (productId: string, query: Query<'listProductEnvironments'> = {}) =>
      this.#call('listProductEnvironments', { params: { productId }, query }),
  }

  readonly projects = {
    list: (query: Query<'listProjects'> = {}) => this.#call('listProjects', { query }),
    get: (projectId: string) => this.#call('getProject', { params: { projectId } }),
  }

  readonly targets = {
    list: (query: Query<'listTargets'> = {}) => this.#call('listTargets', { query }),
    pages: (query: Query<'listTargets'> = {}) => this.#pages('listTargets', undefined, query),
    all: (query: Query<'listTargets'> = {}, maxItems?: number) =>
      this.#all('listTargets', undefined, query, maxItems),
    /** A target by `tgt_` id or by path (`product/project/environment`). */
    get: (target: string) => this.#call('getTarget', { params: { target } }),
    /** The live target at a path (`product/project/environment`). */
    resolve: (path: string) => this.#call('getTarget', { params: { target: path } }),
  }

  readonly clusters = {
    list: (query: Query<'listClusters'> = {}) => this.#call('listClusters', { query }),
    get: (clusterId: string) => this.#call('getCluster', { params: { clusterId } }),
  }

  readonly health = {
    /** The latest sample with its source and time (the server never probes for a read). */
    get: (target: string) => this.#call('getTargetHealth', { params: { target } }),
  }

  readonly findings = {
    list: (target: string, query: Query<'listTargetFindings'> = {}) =>
      this.#call('listTargetFindings', { params: { target }, query }),
  }

  readonly schema = {
    overview: (target: string) => this.#call('getSchemaOverview', { params: { target } }),
    fingerprint: (target: string) => this.#call('getSchemaFingerprint', { params: { target } }),
    search: (target: string, query: Query<'searchSchema'>) =>
      this.#call('searchSchema', { params: { target }, query }),
    /** One object: `qualifiedName` is `schema.name`, `schema.table.name` or `schema.name(args)`. */
    object: (target: string, kind: string, qualifiedName: string) =>
      this.#call('getSchemaObject', { params: { target, kind, qualifiedName } }),
    diff: (body: Operations['createSchemaDiff']['body']) =>
      this.#call('createSchemaDiff', { body }),
  }

  readonly drift = {
    /** Runs a drift check now (recorded; changes no database). Sent once, never retried. */
    check: (target: string) => this.#call('runDriftCheck', { params: { target }, body: {} }),
  }
}
