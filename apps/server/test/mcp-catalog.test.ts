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
// client and grant; an audit event names a denial) and in Phase 8 (a relaxed output
// enumeration names no count, so an added action no longer changes every tool that
// returns one); the data reader's list gained sql_query, sql_explain and sql_cancel
// when the data-read path was served (Phase 8). Re-pinned in Phase 9: wire schemas
// are single-typed (`anyOf` instead of `type` arrays) and a recursive JSON value names
// its six types, the portability findings of Inspector 2.10.1 `--strict`. Re-pinned
// after the Wave 7 review: output maxLength relaxed: escaping can lengthen a value.
// Re-pinned 2026-10-13: drift_check, migration_verify and audit_search at toolVersion 2
// (descriptions say what each records, enforces and audits). Re-pinned 2026-10-27
// (Wave 9 Part B): query_stats, table_stats and advisors_run are served (diagnostics.read).
// Re-pinned after the Wave 9 Part B reviews: advisors_run says it records its run and
// findings (F-4) and marks message and remediation untrusted (D-2); backups_list names
// wal_continuity_unproven (A-4). Both version-1 digests are new on this branch, not released.
// Re-pinned 2026-10-28: the tools that return an operation carry the L0 gate of a rolled-back
// migration (untrusted `first`, so openWorldHint and a description note); toolVersion raised.
// Re-pinned 2026-11-02 (OD-68 (b)): sql_query at toolVersion 2, its result names the warning
// target_memory_unlimited; only the data reader's list holds it.
// Re-pinned 2026-11-03 (ADR-0039): target_get at toolVersion 2, its result names the target's mode
// (managed or observed) and its description the refusal TARGET_OBSERVED_ONLY; every list holds it.
const PINNED: Record<string, { tools: number; digest: string }> = {
  'baseline, nonprod': {
    tools: 15,
    digest: 'sha256:46d575f7544a053a5b993f9dcc56d855dde3affdbcd1911637c92361f53b95af',
  },
  'every read, nonprod': {
    tools: 19,
    digest: 'sha256:046d87995fc3cdfcf99fe6c053ebc9ce8eefdebd8bad0f9ad87371e36841e385',
  },
  'agent, nonprod': {
    tools: 25,
    digest: 'sha256:0847a9ef57c7bd07d582cd062508ffdf8e0a21f73de274cfc626898fc36d35e8',
  },
  'agent, both tiers': {
    tools: 26,
    digest: 'sha256:50fcbdcc122c6adba192d0eb97fff2ce0098a2d935bb50ce6abb7e0596132ffa',
  },
  'data reader, nonprod': {
    tools: 22,
    digest: 'sha256:d57c35b6d210680a88b9537c8e5ea60d0b3430f4a7cc5b7be7388dba048c65b1',
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
