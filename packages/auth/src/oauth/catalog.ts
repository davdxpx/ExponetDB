import { isWriteScope, SCOPE_IDS, scopeDefinition } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { AuthError } from '../errors.ts'

/**
 * The scope catalog a token or API key can hold, as this release derives
 * it from the contracts: every scope some non-Web client kind may hold,
 * with its permission, tier, MCP eligibility, client kinds, human-only flag,
 * whether an action needing it changes something and whether granting it
 * needs explicit consent (the device flow never carries such a scope). The
 * database guards decide with the stored copy (`oauth.scopes`), so the two
 * must agree.
 */
export function releaseScopeCatalog(): readonly string[] {
  return SCOPE_IDS.flatMap((scope) => {
    const d = scopeDefinition(scope)
    const kinds = d.clientKinds.filter((k) => k !== 'web')
    if (kinds.length === 0 || d.permission === null) {
      return []
    }
    return [
      [
        scope,
        d.permission,
        d.tier ?? '',
        String(d.mcpGrantable),
        [...kinds].sort().join(','),
        String(d.humanOnly),
        String(isWriteScope(scope)),
        String(d.explicitConsent),
      ].join('|'),
    ]
  }).sort()
}

/**
 * Readiness check `scope_catalog`: the stored scope catalog equals this
 * release's. A difference keeps the API unavailable, so no guard ever
 * decides with a catalog that was not reviewed with the code.
 */
export async function checkScopeCatalog(q: Queryable): Promise<void> {
  const { rows } = await q.query(
    'oauth.scopes.catalog',
    `SELECT scope, permission, coalesce(tier, '') AS tier, mcp_grantable::text AS mcp,
            array_to_string(ARRAY(SELECT unnest(client_kinds) ORDER BY 1), ',') AS kinds,
            human_only::text AS human_only, write::text AS write,
            explicit_consent::text AS explicit_consent
       FROM oauth.scopes`,
  )
  const stored = rows
    .map((r) =>
      [
        r.text('scope'),
        r.text('permission'),
        r.text('tier'),
        r.text('mcp'),
        r.text('kinds'),
        r.text('human_only'),
        r.text('write'),
        r.text('explicit_consent'),
      ].join('|'),
    )
    .sort()
  const expected = releaseScopeCatalog()
  if (stored.length !== expected.length || stored.some((v, i) => v !== expected[i])) {
    throw new AuthError('scope_catalog_mismatch')
  }
}
