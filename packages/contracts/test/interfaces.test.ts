import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  type ActionDefinition,
  contractJsonSchema,
  ERROR_CODES,
  MCP_FORBIDDEN_TOOL_NAMES,
  MCP_READ_TOOL_LIST,
  ROUTE_LIST,
  SCOPES,
  type ScopeDefinition,
  tieredScope,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const action = (id: keyof typeof ACTIONS): ActionDefinition => ACTIONS[id]

/** The root object of a generated schema, following a top-level $ref into $defs. */
function root(schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema['$ref']
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const defs = schema['$defs'] as Record<string, Record<string, unknown>>
    const target = defs[ref.slice('#/$defs/'.length)]
    if (target === undefined) {
      throw new Error(`dangling ${ref}`)
    }
    return target
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

  it('reference registered actions; GET is a pure read; POST reads only for read or record actions (no mutation without a plan)', () => {
    for (const r of ROUTE_LIST) {
      const a = action(r.action)
      expect(a, r.operationId).toBeDefined()
      if (r.method === 'get') {
        expect(a.effect, r.operationId).toBe('read')
      } else {
        expect(['read', 'control_record'], r.operationId).toContain(a.effect)
      }
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

describe('MCP read tools', () => {
  const catalog = readDoc('05-mcp/tool-catalog.md')
  const documentedTools = new Map(
    tableRows(catalog)
      .map((row) => [row[0]?.match(/^`([a-z_]+)`$/)?.[1], row] as const)
      .filter((e): e is readonly [string, string[]] => e[0] !== undefined),
  )

  it('have unique snake_case names that exist in tool-catalog.md and are annotated RO there', () => {
    expect(new Set(MCP_READ_TOOL_LIST.map((t) => t.name)).size).toBe(MCP_READ_TOOL_LIST.length)
    for (const t of MCP_READ_TOOL_LIST) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/)
      const row = documentedTools.get(t.name)
      expect(row, t.name).toBeDefined()
      expect(row?.[2] ?? '', t.name).toContain('RO')
    }
  })

  it('require the scope tool-catalog.md names', () => {
    for (const t of MCP_READ_TOOL_LIST) {
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
    for (const t of MCP_READ_TOOL_LIST) {
      const route = ROUTE_LIST.find((r) => r.operationId === t.restOperationId)
      expect(route, t.name).toBeDefined()
      expect(
        route?.action === t.action ||
          (t.name === 'schema_inspect' && route?.action === 'schema.object.get'),
        t.name,
      ).toBe(true)
    }
  })

  it('are read-only by annotation and by action, and only need MCP-grantable scopes', () => {
    for (const t of MCP_READ_TOOL_LIST) {
      const a = action(t.action)
      expect(t.annotations.readOnlyHint, t.name).toBe(true)
      expect(t.annotations.destructiveHint, t.name).toBe(false)
      expect(a.effect, t.name).not.toBe('consequential')
      expect(a.clientKinds, t.name).toContain('mcp')
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

  it('have strict inputs, representable outputs and untrusted labels wherever database or caller text is returned', () => {
    const textFree = new Set([
      'targets_list',
      'plan_get',
      'operation_get',
      'operation_list',
      'backups_list',
      'nodes_list',
      'node_status',
      'target_health',
      'migration_lint',
    ])
    for (const t of MCP_READ_TOOL_LIST) {
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
    for (const t of MCP_READ_TOOL_LIST) {
      const input = contractJsonSchema(t.input, { io: 'input' }) as {
        properties?: Record<string, { maximum?: number }>
      }
      const limit = input.properties?.['limit']
      if (limit !== undefined) {
        expect(limit.maximum, t.name).toBe(t.limits.maxItems)
      }
    }
    const sql = MCP_READ_TOOL_LIST.find((t) => t.name === 'sql_query')
    expect(sql?.limits.maxRows).toBe(500)
  })

  it('never include a tool that tool-catalog.md §12 excludes', () => {
    const excluded = section(catalog, '## 12. What is deliberately not a tool')
    for (const name of MCP_FORBIDDEN_TOOL_NAMES) {
      expect(MCP_READ_TOOL_LIST.map((t) => t.name)).not.toContain(name)
    }
    expect(excluded).toContain('execute_sql')
  })
})
