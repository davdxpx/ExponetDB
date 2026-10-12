import {
  MCP_SERVED_TOOL_LIST,
  mcpCatalogDigest,
  mcpToolDefinition,
  type Scope,
  type Tier,
} from '@exponetdb/contracts'
import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { usable } from '../src/interfaces/mcp/registry.ts'

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

// Pinned 2026-10-12 (Wave 7 Phase 5). The data reader's list equals every read's
// until the data-read tools are served (Phase 8).
const PINNED: Record<string, { tools: number; digest: string }> = {
  'baseline, nonprod': {
    tools: 12,
    digest: 'sha256:5babf27b9814bf69e4811ea4a1306707d0475e371a1a5c921eba2e8454b9b72a',
  },
  'every read, nonprod': {
    tools: 16,
    digest: 'sha256:dac59cb8b5b4b27e9b891a0ce53d02910a11f993c2c597bc58f1f84fdad2ccc2',
  },
  'agent, nonprod': {
    tools: 22,
    digest: 'sha256:b0ac771e0e1c824d6320c8fabaf3a4f09e1dc0399d5fa93b5236f935c202399b',
  },
  'agent, both tiers': {
    tools: 23,
    digest: 'sha256:c114330f4a518b4cba1ec71f670ca853406c6c295b21698cd1b20d9413311c99',
  },
  'data reader, nonprod': {
    tools: 16,
    digest: 'sha256:dac59cb8b5b4b27e9b891a0ce53d02910a11f993c2c597bc58f1f84fdad2ccc2',
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
