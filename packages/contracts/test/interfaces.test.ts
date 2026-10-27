import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  type ActionDefinition,
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  contractJsonSchema,
  ERROR_CODES,
  MCP_FORBIDDEN_TOOL_NAMES,
  MCP_SERVED_TOOL_LIST,
  MCP_TOOL_LIST,
  ROUTE_LIST,
  SCOPES,
  type ScopeDefinition,
  tieredScope,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const action = (id: keyof typeof ACTIONS): ActionDefinition => ACTIONS[id]

/** A plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `value` as an object, or a test failure naming what was expected. */
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label}: expected an object`)
  }
  return value
}

/** The root object of a generated schema, following a top-level $ref into $defs. */
function root(schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema['$ref']
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const defs = record(schema['$defs'], `$defs for ${ref}`)
    const target = defs[ref.slice('#/$defs/'.length)]
    if (target === undefined) {
      throw new Error(`dangling ${ref}`)
    }
    return record(target, ref)
  }
  return schema
}

function hasUntrusted(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(hasUntrusted)
  }
  if (typeof schema !== 'object' || schema === null) {
    return false
  }
  return Object.entries(schema).some(
    ([k, v]) => (k === 'untrusted' && v === true) || hasUntrusted(v),
  )
}

describe('REST read routes', () => {
  it('have unique operation ids and unique method + path', () => {
    expect(new Set(ROUTE_LIST.map((r) => r.operationId)).size).toBe(ROUTE_LIST.length)
    expect(new Set(ROUTE_LIST.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTE_LIST.length)
  })

  it('never shadow a later route: a path with a parameter where a later one of the same method has a literal', () => {
    // The server registers routes in this order and the first match answers: a GET
    // /targets/{target}/migrations/{migrationId} listed first took /…/migrations/scratch-check
    // (found by the CLI end-to-end test of Wave 9 Part A).
    const param = (s: string) => s.startsWith('{')
    for (const list of [ROUTE_LIST, AUTH_ROUTES]) {
      list.forEach((later, j) => {
        const literal = later.path.split('/')
        for (const earlier of list.slice(0, j)) {
          const segments = earlier.path.split('/')
          if (earlier.method !== later.method || segments.length !== literal.length) continue
          const covers = segments.every((s, i) => s === literal[i] || param(s))
          const wider = segments.some((s, i) => param(s) && !param(literal[i] ?? ''))
          expect(covers && wider, `${earlier.operationId} shadows ${later.operationId}`).toBe(false)
        }
      })
    }
  })

  it('reference registered actions; GET is a pure read; POST and DELETE never mutate without a plan', () => {
    for (const r of [...ROUTE_LIST, ...AUTH_ROUTES]) {
      const a = action(r.action)
      expect(a, r.operationId).toBeDefined()
      if (r.method === 'get') {
        expect(a.effect, r.operationId).toBe('read')
      } else if (r.method === 'delete' || r.method === 'put') {
        // DELETE creates a plan for the removal (a record), it removes nothing itself;
        // PUT replaces a Control Store record of the caller's own (Wave 8: a saved query).
        expect(a.effect, r.operationId).toBe('control_record')
      } else if (a.effect === 'consequential') {
        // C-6: a consequential POST is the generic apply of a stored plan or an
        // inline plan whose precondition the request carries.
        expect(['plan_apply', 'inline_plan'], r.operationId).toContain(a.mechanism)
      } else {
        expect(['read', 'control_record'], r.operationId).toContain(a.effect)
      }
    }
  })

  it('keep the browser ceremonies under /auth: POST only, Web App only, documented in identity.md', () => {
    const identity = readDoc('08-auth-and-security/identity.md').replaceAll(/\{[a-zA-Z]+\}/g, '{}')
    expect(new Set(AUTH_ROUTES.map((r) => r.operationId)).size).toBe(AUTH_ROUTES.length)
    for (const r of AUTH_ROUTES) {
      expect(r.method, r.operationId).toBe('post')
      expect(action(r.action).clientKinds, r.operationId).toEqual(['web'])
      expect(r.path.startsWith('/'), r.operationId).toBe(true)
      const path = `${AUTH_BASE_PATH}${r.path}`.replaceAll(/\{[a-zA-Z]+\}/g, '{}')
      expect(identity, path).toContain(`\`POST ${path}\``)
      expect(
        ROUTE_LIST.some((rest) => rest.operationId === r.operationId),
        r.operationId,
      ).toBe(false)
    }
  })

  it('declare exactly the path parameters that appear in the path', () => {
    for (const r of ROUTE_LIST) {
      const inPath = [...r.path.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort()
      expect(Object.keys(r.pathParams.shape).sort(), r.operationId).toEqual(inPath)
    }
  })

  it('exist in resources.md (placeholders normalized)', () => {
    const resources = readDoc('06-rest-api/resources.md').replaceAll(/\{[a-zA-Z]+\}/g, '{}')
    for (const r of ROUTE_LIST) {
      const path = r.path.replaceAll(/\{[a-zA-Z]+\}/g, '{}')
      expect(resources, `${r.method.toUpperCase()} ${r.path}`).toMatch(
        new RegExp(`${r.method.toUpperCase()} ${path.replaceAll(/[{}?]/g, '\\$&')}[\`, ?]`),
      )
    }
  })

  it('list only catalog error codes', () => {
    for (const r of ROUTE_LIST) {
      for (const e of r.errors) {
        expect(ERROR_CODES, r.operationId).toContain(e)
      }
    }
  })

  it('have strict path, query and body schemas and representable responses', () => {
    for (const r of ROUTE_LIST) {
      const params = root(contractJsonSchema(r.pathParams, { io: 'input' }))
      expect(params['additionalProperties'], r.operationId).toBe(false)
      if (r.query !== undefined) {
        expect(
          root(contractJsonSchema(r.query, { io: 'input' }))['additionalProperties'],
          r.operationId,
        ).toBe(false)
      }
      if (r.body !== undefined) {
        expect(
          root(contractJsonSchema(r.body, { io: 'input' }))['additionalProperties'],
          r.operationId,
        ).toBe(false)
      }
      expect(
        () => contractJsonSchema(r.response.schema, { io: 'input' }),
        r.operationId,
      ).not.toThrow()
    }
  })
})

describe('MCP tools', () => {
  const catalog = readDoc('05-mcp/tool-catalog.md')
  const documentedTools = new Map(
    tableRows(catalog)
      .map((row) => [row[0]?.match(/^`([a-z_]+)`$/)?.[1], row] as const)
      .filter((e): e is readonly [string, string[]] => e[0] !== undefined),
  )

  /** The annotation markers of a tool-catalog.md row: RO, D, I (`—` for none). */
  const markers = (row: readonly string[] | undefined): Set<string> =>
    new Set(
      (row?.[2] ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m !== '' && m !== '—'),
    )

  it('have unique snake_case names that exist in tool-catalog.md with the same annotations', () => {
    expect(new Set(MCP_TOOL_LIST.map((t) => t.name)).size).toBe(MCP_TOOL_LIST.length)
    for (const t of MCP_TOOL_LIST) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/)
      const row = documentedTools.get(t.name)
      expect(row, t.name).toBeDefined()
      const m = markers(row)
      expect(m.has('RO'), t.name).toBe(t.annotations.readOnlyHint)
      expect(m.has('D'), t.name).toBe(t.annotations.destructiveHint)
      // idempotentHint is meaningful only for tools that are not read-only.
      if (!t.annotations.readOnlyHint) {
        expect(m.has('I'), t.name).toBe(t.annotations.idempotentHint)
      }
    }
  })

  it('never annotate a plan-creating tool in tool-catalog.md as read-only (a plan is a record)', () => {
    const planTools = [...documentedTools.keys()].filter((name) => name.endsWith('_plan'))
    expect(planTools.length).toBeGreaterThan(3)
    for (const name of planTools) {
      expect(markers(documentedTools.get(name)).has('RO'), name).toBe(false)
    }
  })

  it('require the scope tool-catalog.md names', () => {
    for (const t of MCP_TOOL_LIST) {
      const raw = documentedTools.get(t.name)?.[1] ?? ''
      const sameAs = raw.match(/^as `([a-z_]+)`$/)?.[1]
      const documentedScope = sameAs === undefined ? raw : (documentedTools.get(sameAs)?.[1] ?? '')
      const a = action(t.action)
      if (a.scope.kind === 'fixed') {
        expect(documentedScope, t.name).toContain(`\`${a.scope.scope}\``)
      } else if (a.scope.kind === 'tiered') {
        expect(documentedScope, t.name).toContain(`\`${a.scope.permission}:nonprod\``)
        expect(documentedScope, t.name).toContain(`\`${a.scope.permission}:prod\``)
      }
    }
  })

  it('map to a REST route of the same action (one engine, C-9)', () => {
    for (const t of MCP_TOOL_LIST) {
      const route = ROUTE_LIST.find((r) => r.operationId === t.restOperationId)
      expect(route, t.name).toBeDefined()
      expect(
        route?.action === t.action ||
          (t.name === 'schema_inspect' && route?.action === 'schema.object.get'),
        t.name,
      ).toBe(true)
    }
  })

  it('keep the MCP meaning of the annotations: read-only exactly for pure reads, destructive only for consequential actions, open world exactly where foreign text is returned', () => {
    for (const t of MCP_TOOL_LIST) {
      const a = action(t.action)
      expect(t.annotations.readOnlyHint, t.name).toBe(a.effect === 'read')
      if (t.annotations.destructiveHint) {
        expect(a.effect, t.name).toBe('consequential')
      }
      if (a.effect === 'read') {
        expect(t.annotations.destructiveHint, t.name).toBe(false)
      }
      const output = contractJsonSchema(t.output, { io: 'output' })
      expect(t.annotations.openWorldHint, t.name).toBe(hasUntrusted(output))
    }
  })

  it('mark drift_check as recording, not read-only, not destructive, not idempotent', () => {
    const drift = MCP_TOOL_LIST.find((t) => t.name === 'drift_check')
    expect(drift?.action).toBe('drift.check')
    expect(action('drift.check').effect).toBe('control_record')
    expect(drift?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  it('say that advisors_run records its run and findings, never that it changes nothing (review F-4)', () => {
    const advisors = MCP_TOOL_LIST.find((t) => t.name === 'advisors_run')
    expect(advisors?.action).toBe('advisor.run')
    expect(advisors?.description).not.toMatch(/never changes anything/)
    expect(advisors?.description).toMatch(/recorded in ExponetDB's own store/)
  })

  it('reach only actions an MCP client may call, with MCP-grantable scopes', () => {
    for (const t of MCP_TOOL_LIST) {
      const a = action(t.action)
      expect(a.clientKinds, t.name).toContain('mcp')
      expect(a.humanOnly, t.name).toBe(false)
      const scopes =
        a.scope.kind === 'fixed'
          ? [a.scope.scope]
          : a.scope.kind === 'tiered'
            ? [tieredScope(a.scope.permission, 'prod'), tieredScope(a.scope.permission, 'nonprod')]
            : []
      for (const s of scopes) {
        expect(s, t.name).toBeDefined()
        if (s !== undefined) {
          const sd: ScopeDefinition = SCOPES[s]
          expect(sd.mcpGrantable, `${t.name} needs ${s}`).toBe(true)
        }
      }
    }
  })

  it('apply nothing but a stored plan: the only destructive tool is plan_apply, and it takes the plan id alone', () => {
    const destructive = MCP_TOOL_LIST.filter((t) => t.annotations.destructiveHint)
    expect(destructive.map((t) => t.name)).toEqual(['plan_apply'])
    const apply = MCP_TOOL_LIST.find((t) => t.name === 'plan_apply')
    expect(Object.keys(apply?.input.shape ?? {})).toEqual(['planId'])
  })

  it('have strict inputs, representable outputs and untrusted labels wherever database or caller text is returned', () => {
    const textFree = new Set([
      'targets_list',
      'plan_get',
      'plan_apply',
      'plan_withdraw',
      'operation_get',
      'operation_list',
      'operation_cancel',
      'sql_cancel',
      'migration_plan',
      'migration_rollback_plan',
      'migration_verify',
      'backups_list',
      'nodes_list',
      'node_status',
      'target_health',
      'migration_lint',
    ])
    for (const t of MCP_TOOL_LIST) {
      expect(
        root(contractJsonSchema(t.input, { io: 'input' }))['additionalProperties'],
        t.name,
      ).toBe(false)
      const output = contractJsonSchema(t.output, { io: 'input' })
      // MCP requires object schemas at the root of inputSchema and outputSchema.
      expect(root(output)['type'], t.name).toBe('object')
      expect(root(contractJsonSchema(t.input, { io: 'input' }))['type'], t.name).toBe('object')
      if (!textFree.has(t.name)) {
        expect(hasUntrusted(output), t.name).toBe(true)
      }
    }
  })

  it('cap list sizes and data rows', () => {
    for (const t of MCP_TOOL_LIST) {
      const properties = contractJsonSchema(t.input, { io: 'input' })['properties']
      const limit =
        properties === undefined ? undefined : record(properties, `${t.name} properties`)['limit']
      if (limit !== undefined) {
        expect(record(limit, `${t.name} limit`)['maximum'], t.name).toBe(t.limits.maxItems)
      }
    }
    const sql = MCP_TOOL_LIST.find((t) => t.name === 'sql_query')
    expect(sql?.limits.maxRows).toBe(500)
  })

  it('serve the Wave 7 part and the Wave 9 performance and backup reads only (the other Wave 9 tools stay planned), and node planning is not a tool (OD-29)', () => {
    const served9 = ['advisors_run', 'backups_list', 'query_stats', 'table_stats']
    for (const t of MCP_TOOL_LIST) {
      if (t.wave === '9') {
        expect(t.status, t.name).toBe(served9.includes(t.name) ? 'served' : 'planned')
      }
    }
    expect(MCP_TOOL_LIST.map((t) => t.name)).not.toContain('node_plan')
    expect(MCP_SERVED_TOOL_LIST.every((t) => t.status === 'served')).toBe(true)
  })

  it('never include a tool that tool-catalog.md §12 excludes', () => {
    const excluded = section(catalog, '## 12. What is deliberately not a tool')
    for (const name of MCP_FORBIDDEN_TOOL_NAMES) {
      expect(MCP_TOOL_LIST.map((t) => t.name)).not.toContain(name)
    }
    expect(excluded).toContain('execute_sql')
  })
})
