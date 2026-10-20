import type {
  ExplainResult,
  QueryHistoryEntry,
  QueryResult,
  SavedQuery,
  SqlClassification,
} from '@exponetdb/sdk/operations'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { answer, World as TargetWorld } from '../target/support.tsx'

export { project } from '../target/support.tsx'

/**
 * The fake server of the SQL workspace: the target pages' reads plus the
 * SQL endpoints, with the method and body of every request recorded, so a
 * test can prove that a request was (or was not) sent. A path nobody set up
 * answers 404.
 */
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

export const BIDI = String.fromCodePoint(0x202e)
export const ZWSP = String.fromCodePoint(0x200b)
export const TAG = String.fromCodePoint(0xe0041, 0xe0042)

export interface Sent {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

type Answer = { readonly status: number; readonly body: unknown }

export class SqlWorld extends TargetWorld {
  readonly sent: Sent[] = []
  /** The classification of a text; the default classifies statement by statement. */
  classify: (sql: string) => Answer = (sql) => ({ status: 200, body: classifyText(sql) })
  run: (body: { sql: string; queryId: string; maxRows?: number }) => Answer = (body) => ({
    status: 200,
    body: resultFixture({ queryId: body.queryId }),
  })
  explain: (body: { sql: string; queryId: string }) => Answer = (body) => ({
    status: 200,
    body: explainFixture(body.queryId),
  })
  cancel: (queryId: string) => Answer = (queryId) => ({
    status: 200,
    body: { queryId, outcome: 'canceled' },
  })
  history: Answer = { status: 200, body: { items: [], nextCursor: null, source: 'audit' } }
  saved: Answer = { status: 200, body: { items: [], nextCursor: null } }
  createSaved: (body: Record<string, unknown>) => Answer = (body) => ({
    status: 201,
    body: savedFixture({ name: String(body['name']), sql: String(body['sql']) }),
  })
  updateSaved: (id: string, body: Record<string, unknown>) => Answer = (id, body) => ({
    status: 200,
    body: savedFixture({
      id,
      name: String(body['name']),
      sql: String(body['sql']),
      visibility: body['visibility'] === 'project' ? 'project' : 'personal',
      revision: Number(body['revision']) + 1,
    }),
  })
  getSaved: (id: string) => Answer = (id) => ({ status: 200, body: savedFixture({ id }) })
  lint: Answer = {
    status: 200,
    body: {
      bundles: [
        {
          directory: 'x',
          findings: [],
          bundleDigest: null,
          checksum: null,
          migrationId: null,
          rollbackDigest: null,
          sourceDigest: null,
          verifyDigest: null,
        },
      ],
      graph: { valid: true, errors: [] },
    },
  }
  plan: Answer = { status: 201, body: { id: 'pln_01M4V3RV9F5XM2TB8KC6QZJ0NS' } }
  /** Requests held until the promise settles, by their exact `METHOD path`. */
  readonly holds = new Map<string, Promise<unknown>>()

  /** The requests of one kind, by method and a path substring. */
  calls(method: string, part: string): Sent[] {
    return this.sent.filter((s) => s.method === method && s.path.includes(part))
  }
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function reply(a: Answer): Response {
  return json(a.status, a.body)
}

async function sqlAnswer(world: SqlWorld, input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input), 'http://localhost')
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  world.sent.push({ method, path: `${url.pathname}${url.search}`, body })
  for (const [part, held] of world.holds) {
    if (`${method} ${url.pathname}` === part) await held
  }
  const p = url.pathname
  if (method === 'POST' && p === '/api/v1/sql/classifications') {
    return reply(world.classify((body as { sql: string }).sql))
  }
  const target = /^\/api\/v1\/targets\/[^/]+\/queries$/.test(p)
  if (method === 'POST' && target) {
    return reply(world.run(body as { sql: string; queryId: string; maxRows?: number }))
  }
  if (method === 'POST' && /^\/api\/v1\/targets\/[^/]+\/explain$/.test(p)) {
    return reply(world.explain(body as { sql: string; queryId: string }))
  }
  const cancel = /^\/api\/v1\/targets\/[^/]+\/queries\/([^/]+)\/cancel$/.exec(p)
  if (method === 'POST' && cancel?.[1] !== undefined) return reply(world.cancel(cancel[1]))
  if (method === 'GET' && /^\/api\/v1\/targets\/[^/]+\/queries\/history$/.test(p)) {
    return reply(world.history)
  }
  if (method === 'GET' && p === '/api/v1/saved-queries') return reply(world.saved)
  if (method === 'POST' && p === '/api/v1/saved-queries') {
    return reply(world.createSaved(body as Record<string, unknown>))
  }
  const one = /^\/api\/v1\/saved-queries\/([^/]+)$/.exec(p)
  if (one?.[1] !== undefined && method === 'PUT') {
    return reply(world.updateSaved(one[1], body as Record<string, unknown>))
  }
  if (one?.[1] !== undefined && method === 'GET') return reply(world.getSaved(one[1]))
  if (method === 'POST' && /\/migrations\/lint$/.test(p)) return reply(world.lint)
  if (method === 'POST' && /^\/api\/v1\/targets\/[^/]+\/migrations\/plans$/.test(p)) {
    return reply(world.plan)
  }
  if (method === 'GET' && /\/schema\/search$/.test(p)) {
    return reply({ status: 200, body: { items: [], nextCursor: null } })
  }
  return answer(world, input)
}

export function mountSql(initialPath: string, world: SqlWorld) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    sqlAnswer(world, input, init),
  )
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: vi.fn(),
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const queryClient = createQueryClient()
  render(
    <AppProviders
      services={{
        queryClient,
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, fetchFn, queryClient }
}

// ----- fixtures -----

const READS = /^(select|with|table|values|show)\b/i

/** A classification like the server's: statements split at `;`, UTF-16 offsets, one class set each. */
export function classifyText(sql: string, major: 16 | 17 | 18 = 17): SqlClassification {
  const statements: SqlClassification['statements'][number][] = []
  let offset = 0
  for (const part of sql.split(';')) {
    // Leading white space and line comments are not part of a statement (as in the server's answer).
    const lead = /^(?:\s|--[^\n]*(?:\n|$))*/.exec(part)?.[0].length ?? 0
    const body = part.slice(lead).trimEnd()
    if (body.length > 0) {
      const start = offset + lead
      const end = start + body.length
      const read = READS.test(body)
      const classes: SqlClassification['statements'][number]['classes'][number][] = read
        ? ['read_only']
        : /\b(drop|delete|truncate)\b/i.test(body)
          ? ['write', 'destructive']
          : ['write']
      statements.push({
        index: statements.length,
        start: position(sql, start),
        end: position(sql, end),
        kind: read ? 'SelectStmt' : 'DropStmt',
        label: read ? 'SELECT' : body.split(/\s+/).slice(0, 2).join(' ').toUpperCase(),
        classes,
        procedural: false,
        readOnlyPath: read,
        readOnlyRefusal: read ? null : { code: 'QUERY_NOT_READ_ONLY', reason: 'statement_class' },
        migrationRefusal: null,
      })
    }
    offset += part.length + 1
  }
  const admitted = statements.length === 1 && statements[0]?.readOnlyPath === true
  return {
    bytes: new TextEncoder().encode(sql).length,
    computedAt: new Date().toISOString(),
    grammar: 'libpg_query 17',
    parseError: null,
    postgresMajor: major,
    readOnlyPath: {
      admitted,
      refusal: admitted
        ? null
        : statements.length > 1
          ? { code: 'QUERY_NOT_READ_ONLY', reason: 'multiple_statements' }
          : (statements[0]?.readOnlyRefusal ?? null),
    },
    source: 'parser',
    statementCount: statements.length,
    statements,
    status: statements.length === 0 ? 'empty' : 'parsed',
  }
}

function position(text: string, offset: number) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  return { line, column: [...text.slice(lineStart, offset)].length + 1, offset }
}

export function resultFixture(over: Partial<QueryResult> = {}): QueryResult {
  return {
    queryId: 'qry_01M4V3RV9F5XM2TB8KC6QZJ0NS',
    columns: [
      { name: 'id', type: 'integer', masked: false },
      { name: 'email', type: 'text', masked: true },
    ],
    rows: [
      [1, null],
      [2, null],
    ],
    rowCount: 2,
    durationMs: 5,
    rlsRelations: [],
    statementDigest: `sha256:${'a'.repeat(64)}`,
    truncated: false,
    truncation: null,
    ...over,
  }
}

export function explainFixture(queryId: string): ExplainResult {
  return {
    queryId,
    durationMs: 3,
    plan: [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Startup Cost': 0,
          'Total Cost': 12.5,
          'Plan Rows': 100,
          'Plan Width': 8,
        },
      },
    ],
    summary: {
      totalCost: 12.5,
      planRows: 100,
      actualRows: null,
      misestimates: [],
      sequentialScans: ['public.orders'],
    },
  }
}

export function historyEntry(over: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
  return {
    queryId: 'qry_01M4V3RV9F5XM2TB8KC6QZJ0N1',
    kind: 'query',
    occurredAt: new Date().toISOString(),
    statement: 'SELECT * FROM public.orders WHERE id = $1',
    statementDigest: `sha256:${'b'.repeat(64)}`,
    rows: 3,
    truncated: false,
    durationMs: 7,
    outcome: 'succeeded',
    errorCode: null,
    client: 'web',
    callerClass: 'human',
    ...over,
  }
}

export function savedFixture(over: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: 'sqy_01M4V3RV9F5XM2TB8KC6QZJ0NS',
    name: 'Open orders',
    sql: 'SELECT id FROM public.orders',
    sqlDigest: `sha256:${'c'.repeat(64)}`,
    visibility: 'personal',
    scope: { kind: 'target', targetId: 'tgt_00000000000000000000000002' },
    ownerIdentityId: 'idn_00000000000000000000000001',
    ownedByCaller: true,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}
