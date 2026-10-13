import {
  MCP_SERVED_TOOL_LIST,
  mcpCatalogDigest,
  mcpToolDefinition,
  type Scope,
  type Tier,
} from '@exponetdb/contracts'
import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { HANDLERS, servedRoutes } from '../src/interfaces/http/api.ts'
import { BINDINGS, usable } from '../src/interfaces/mcp/registry.ts'

/**
 * The tool list per grant shape is pinned (Wave 7 order §16, G7 criterion
 * 12): the canonical (JCS) digest of what `tools/list` offers each shape.
 * Any change of a definition, of the served set or of the listing filter
 * shows up here as a visible diff; update a pin only together with the
 * change that explains it.
 */
const READ: Scope[] = [
  'targets.read',
  'schema.read',
  'diagnostics.read',
  'migrations.read',
  'nodes.read',
  'audit.read',
]

const SHAPES: Record<string, { scopes: Scope[]; tiers: Tier[] }> = {
  'baseline, nonprod': {
    scopes: ['targets.read', 'schema.read', 'diagnostics.read'],
    tiers: ['nonprod'],
  },
  'every read, nonprod': { scopes: READ, tiers: ['nonprod'] },
  'agent, nonprod': {
    scopes: [...READ, 'migrations.plan', 'migrations.apply:nonprod'],
    tiers: ['nonprod'],
  },
  'agent, both tiers': {
    scopes: [...READ, 'migrations.plan', 'migrations.apply:nonprod', 'migrations.apply:prod'],
    tiers: ['nonprod', 'prod'],
  },
  'data reader, nonprod': { scopes: [...READ, 'data.read:nonprod'], tiers: ['nonprod'] },
}

// Pinned 2026-10-12 (Wave 7 Phase 5), re-pinned in Phase 6 (audit_search filters by
// client and grant; an audit event names a denial). The data reader's list equals
// every read's until the data-read tools are served (Phase 8).
const PINNED: Record<string, { tools: number; digest: string }> = {
  'baseline, nonprod': {
    tools: 12,
    digest: 'sha256:89c1c61936f239520bcf78292acfb1714b89d6faed6dc2f53d777a86e08817b3',
  },
  'every read, nonprod': {
    tools: 16,
    digest: 'sha256:c3714c5a97256f3064f4a442f345a94d5ef92b2d08fe07bdb5fc00e55ddabfa5',
  },
  'agent, nonprod': {
    tools: 22,
    digest: 'sha256:1da7cb07ef9f832bfc554c7dc07f268d8ffc44b9818c938365984a137c5812e6',
  },
  'agent, both tiers': {
    tools: 23,
    digest: 'sha256:28f08d752ab22ed77cf392e561dfece544653c06b7fb166fe40a9d3b34816a74',
  },
  'data reader, nonprod': {
    tools: 16,
    digest: 'sha256:c3714c5a97256f3064f4a442f345a94d5ef92b2d08fe07bdb5fc00e55ddabfa5',
  },
}

function listFor(shape: { scopes: Scope[]; tiers: Tier[] }) {
  const delegation = {
    credential: {
      type: 'access_token' as const,
      grantId: newId('grt', 0),
      clientId: newId('cli', 0),
      grantKind: 'delegated' as const,
    },
    resource: 'mcp' as const,
    scopes: new Set(shape.scopes),
    restrictions: { targets: { kind: 'all' as const }, tiers: shape.tiers },
  }
  return [...MCP_SERVED_TOOL_LIST]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((t) => usable(t, delegation))
    .map(mcpToolDefinition)
}

describe('the tool list per grant shape', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(name, () => {
      const list = listFor(shape)
      const actual = { tools: list.length, digest: mcpCatalogDigest(list) }
      expect(actual, `${name}: ${list.map((d) => d.name).join(' ')}`).toEqual(PINNED[name])
    })
  }
})

describe('the served tool registration (Wave 7 order §19, C-9)', () => {
  it('binds every served tool to a use case and to a served REST route of the same action', () => {
    const routes = new Map(servedRoutes().map(({ route }) => [route.operationId, route]))
    for (const tool of MCP_SERVED_TOOL_LIST) {
      expect(Object.hasOwn(BINDINGS, tool.name), `${tool.name}: use case binding`).toBe(true)
      const route = routes.get(tool.restOperationId)
      expect(route, `${tool.name}: served route ${tool.restOperationId}`).toBeDefined()
      expect(HANDLERS[tool.restOperationId], tool.name).toBeDefined()
      // schema_inspect is the one tool whose route reads the object by another action id.
      expect(
        route?.action === tool.action ||
          (tool.name === 'schema_inspect' && route?.action === 'schema.object.get'),
        tool.name,
      ).toBe(true)
    }
  })

  it('binds nothing that is not a served tool (a planned tool has no binding yet)', () => {
    const served = new Set(MCP_SERVED_TOOL_LIST.map((t) => t.name))
    for (const name of Object.keys(BINDINGS)) {
      expect(served.has(name), name).toBe(true)
    }
  })
})
