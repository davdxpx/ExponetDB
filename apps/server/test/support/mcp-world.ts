import { randomBytes } from 'node:crypto'
import type { Application } from '@exponetdb/application'
import type { oauth } from '@exponetdb/auth'
import { MCP_BASELINE_SCOPES, type Scope } from '@exponetdb/contracts'
import { fixedClock, newId } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry, type ReadinessReport } from '@exponetdb/observability'
import { createPublicApp, httpMetrics } from '../../src/interfaces/http/app.ts'
import { createCursorCodec } from '../../src/interfaces/mcp/cursor.ts'
import { type McpLimits, mcpMetrics } from '../../src/interfaces/mcp/edge.ts'
import { RateLimiter } from '../../src/interfaces/mcp/rate-limit.ts'
import { BINDINGS, createToolHost } from '../../src/interfaces/mcp/registry.ts'
import { createRequestStateCodec, singleKey } from '../../src/interfaces/mcp/request-state.ts'
import { createResourceHost } from '../../src/interfaces/mcp/resources.ts'

/**
 * A test composition of `/mcp`: the real edge, SDK and tool host over a
 * stub application that knows one token and answers a few tools with fixed
 * results or fixed refusals. Used by the protocol suite and, served on a
 * port, by the conformance suite. Never part of a product build.
 */

export const NOW = Date.parse('2026-10-12T12:00:00Z')
export const TOKEN = `exat_${'A'.repeat(43)}`
export const API_TOKEN = `exat_${'B'.repeat(43)}`
export const SECRET_TEXT = 'password=hunter2 at /etc/exponetdb/keyring'

export const identityId = newId('idn', NOW)
export const grantId = newId('grt', NOW)
export const clientId = newId('cli', NOW)
export const TARGET = newId('tgt', NOW)

export function principal(scopes: readonly Scope[]): oauth.DelegatedPrincipal {
  return {
    kind: 'delegated',
    identityId,
    identityKind: 'human',
    label: 'human #1',
    client: 'mcp',
    delegation: {
      credential: { type: 'access_token', grantId, clientId, grantKind: 'delegated' },
      resource: 'mcp',
      scopes: new Set(scopes),
      restrictions: { targets: { kind: 'all' }, tiers: ['nonprod'] },
    },
  }
}

const ready: ReadinessReport = {
  status: 'ready',
  evaluatedAt: '2026-10-12T12:00:00.000Z',
  checks: [],
}

/** A limiter whose clock jumps an hour per call, so every bucket is always full. */
function unlimitedLimiter(): RateLimiter {
  let now = 0
  return new RateLimiter(() => {
    now += 3_600_000
    return now
  })
}

export interface WorldOptions {
  readonly scopes?: readonly Scope[]
  readonly available?: boolean
  readonly extraOrigins?: readonly string[]
  readonly bindings?: Partial<typeof BINDINGS>
  /** The public origin (default `http://localhost`, as `app.request` sends). */
  readonly publicOrigin?: string
  /** No rate limits (the conformance suite sends hundreds of requests from one grant). */
  readonly unlimited?: boolean
  /** Tighter edge limits (a slow client within a test's time). */
  readonly limits?: Partial<McpLimits>
  /** Keep no log lines or token uses (a load run must not measure its own records). */
  readonly discard?: boolean
  /** What reading a target (the `registry.target` use case) does instead of the default. */
  readonly target?: (caller: unknown, id: string) => Promise<unknown>
}

export function world(options: WorldOptions = {}) {
  const lines: string[] = []
  const logger = createLogger({
    role: 'serve',
    write: options.discard === true ? () => undefined : (l) => lines.push(l),
    level: options.discard === true ? 'info' : 'debug',
  })
  const seen: { token: string; resource: string }[] = []
  /** The use classes the edge noted for the grant's last use. */
  const uses: string[] = []
  const application = {
    registry: {
      targets: async (_caller: unknown, _filter: unknown, page: { cursor?: string }) => {
        if (page.cursor === 'r1_bad') {
          throw Object.assign(new Error('cursor'), { code: 'VALIDATION_FAILED' })
        }
        return page.cursor === undefined
          ? { items: [{ id: TARGET, tier: 'nonprod' }], nextCursor: 'r1_next' }
          : { items: [], nextCursor: null }
      },
      target: async (caller: unknown, id: string) => {
        if (options.target !== undefined) return options.target(caller, id)
        if (id !== TARGET) {
          throw Object.assign(new Error('nope'), { code: 'TARGET_NOT_FOUND' })
        }
        return { id: TARGET, path: `a/b/c${String.fromCodePoint(0x202e)}`, tier: 'nonprod' }
      },
    },
    authenticateBearer: async (token: string, resource: string) => {
      if (options.discard !== true) seen.push({ token, resource })
      if (token === TOKEN && resource === 'mcp') {
        return principal(options.scopes ?? MCP_BASELINE_SCOPES)
      }
      return undefined
    },
    noteGrantUse: (_caller: unknown, useClass: string) => {
      if (options.discard !== true) uses.push(useClass)
    },
  } as unknown as Application
  const bindings = {
    ...BINDINGS,
    targets_list: async () => ({ items: [], nextCursor: null }),
    target_get: async () => {
      throw Object.assign(new Error(SECRET_TEXT), { code: 'PERMISSION_DENIED' })
    },
    target_health: async () => {
      throw new Error(SECRET_TEXT)
    },
    schema_inspect: async () => {
      throw Object.assign(new Error('scope'), {
        code: 'INSUFFICIENT_SCOPE',
        details: { requiredScope: 'migrations.apply:nonprod' },
      })
    },
    migration_plan: async () => ({ not: 'a plan' }),
    ...options.bindings,
  } as typeof BINDINGS
  const registry = new MetricsRegistry()
  const key = randomBytes(32)
  const cursors = createCursorCodec(async () => key)
  const app = createPublicApp(
    {
      readiness: () => ready,
      version: '0.7.0-test',
      logger,
      metrics: httpMetrics(registry),
      clock: fixedClock(NOW),
    },
    {
      mcp: {
        application,
        tools: createToolHost(
          application,
          logger,
          { cursors, states: createRequestStateCodec(async () => singleKey(key)) },
          bindings,
        ),
        resources: createResourceHost(application, logger, cursors),
        publicOrigin: options.publicOrigin ?? 'http://localhost',
        extraOrigins: options.extraOrigins ?? [],
        version: '0.7.0-test',
        logger,
        metrics: mcpMetrics(registry),
        available: () => options.available ?? true,
        ...(options.unlimited === true ? { limiter: unlimitedLimiter() } : {}),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      },
    },
  )
  return { app, lines, seen, uses, registry }
}
