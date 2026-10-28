/**
 * The EXPECTED side of the matrix: an independent re-implementation of the
 * formula in authorization.md section 1, written from the document and the
 * contract tables (ACTIONS, SCOPES, BUILT_IN_ROLES), NOT from the engine
 * (packages/auth/src/authorization/engine.ts). It is deliberately simple; where
 * the answer depends on stored objects (plan or operation kind, policy facts)
 * it says `N` (not decidable statically) and run-matrix.ts then only checks
 * that the response is not a 5xx.
 *
 * Output per credential class: a string of `A` (authorization passes; a later
 * domain or policy refusal is still possible), `D` (an authorization refusal:
 * 401/403, or the concealed 404 of a target/product/project), `N` (skip), one
 * character per subject-tier variant (`nonprod`, `prod`) where the row has a
 * tier-dependent subject, else one character.
 */

export type Variant = 'nonprod' | 'prod' | 'none'

export interface CredentialClass {
  readonly client: 'cli' | 'ci' | 'mcp'
  readonly identity: 'human' | 'service'
  /** Role bindings: `global`, or `nonprod`/`prod` = an environment binding that covers that tier only. */
  readonly bindings: readonly { readonly role: string; readonly scope: 'global' | 'nonprod' | 'prod' }[]
  /** `all` = every scope the client kind may hold; else the exact list. */
  readonly scopes: 'all' | readonly string[]
  readonly tiers: readonly ('nonprod' | 'prod')[]
  /** Restricted to the fixture target of this tier (an OAuth grant with a target list). */
  readonly targetList?: 'nonprod' | 'prod'
}

/** The eight credential classes the harness takes one credential file for. */
export const CREDENTIAL_CLASSES: Readonly<Record<string, CredentialClass>> = {
  owner: { client: 'cli', identity: 'human', bindings: [{ role: 'owner', scope: 'global' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  admin: { client: 'cli', identity: 'human', bindings: [{ role: 'admin', scope: 'global' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  'developer-nonprod': { client: 'cli', identity: 'human', bindings: [{ role: 'developer', scope: 'nonprod' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  'developer-prod': { client: 'cli', identity: 'human', bindings: [{ role: 'developer', scope: 'prod' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  viewer: { client: 'cli', identity: 'human', bindings: [{ role: 'viewer', scope: 'global' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  'service-account': { client: 'ci', identity: 'service', bindings: [{ role: 'developer', scope: 'nonprod' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
  'oauth-narrow': { client: 'cli', identity: 'human', bindings: [{ role: 'owner', scope: 'global' }], scopes: ['targets.read'], tiers: ['nonprod'], targetList: 'nonprod' },
  'mcp-client': { client: 'mcp', identity: 'human', bindings: [{ role: 'owner', scope: 'global' }], scopes: 'all', tiers: ['nonprod', 'prod'] },
}

/** The subset of the contract tables the oracle needs (passed in so this file stays import-free). */
export interface Tables {
  readonly roles: Readonly<Record<string, { readonly permissions: readonly string[] }>>
  readonly scopes: Readonly<
    Record<string, { readonly permission: string | null; readonly tier: string | null; readonly clientKinds: readonly string[]; readonly humanOnly: boolean; readonly mcpGrantable: boolean }>
  >
}

export interface OracleRow {
  readonly surface: 'rest' | 'mcp'
  readonly permission: { readonly kind: string; readonly permission?: string }
  readonly scope: { readonly kind: string; readonly scope?: string; readonly permission?: string }
  readonly clientKinds: readonly string[]
  readonly humanOnly: boolean
  readonly reauth: boolean
  readonly subject: string
  readonly tierSemantics: string
  readonly variants: readonly Variant[]
}

function ceilingHas(cred: CredentialClass, t: Tables, scope: string): boolean {
  const def = t.scopes[scope]
  if (def === undefined) return false
  if (!def.clientKinds.includes(cred.client)) return false
  if (cred.client === 'mcp' && !def.mcpGrantable) return false
  if (def.humanOnly && cred.identity !== 'human') return false
  return cred.scopes === 'all' || cred.scopes.includes(scope)
}

export function oracle(row: OracleRow, cred: CredentialClass, v: Variant, t: Tables): 'A' | 'D' | 'N' {
  const p = row.permission
  // the surface: a token is valid at exactly one resource (api for cli/ci, mcp for mcp)
  if ((row.surface === 'mcp') !== (cred.client === 'mcp')) return 'D'
  if (!row.clientKinds.includes(cred.client)) return 'D'
  if (p.kind === 'public') return 'D' // a bearer credential is refused at a public ceremony (UNAUTHENTICATED)
  if (p.kind === 'protocol') return 'N'
  if (p.kind === 'self') return 'D' // Web App session only
  if (p.kind === 'own_grant') return cred.client === 'cli' && cred.identity === 'human' ? 'A' : 'D'
  if (row.humanOnly && (cred.identity !== 'human' || cred.client === 'mcp')) return 'D'
  if (p.kind === 'read_of_kind' || p.kind === 'of_plan_kind') return 'N' // decided on the stored plan's kind and subject
  if (p.kind !== 'fixed' || p.permission === undefined) return 'D' // unsupported rule denies
  // Phase 1: the scope the client must hold (fixed scope), or the tiered scope of the subject (phase 2)
  const tier = v === 'none' ? undefined : v
  if (row.scope.kind === 'fixed' && row.scope.scope !== undefined && !ceilingHas(cred, t, row.scope.scope)) return 'D'
  if (row.scope.kind === 'tiered' && row.scope.permission !== undefined) {
    if (tier === undefined) return 'N'
    if (!ceilingHas(cred, t, `${row.scope.permission}:${tier}`)) return 'D'
  }
  // RBAC: a binding whose role lists the permission and whose scope covers the subject
  const production = row.tierSemantics === 'production' || row.tierSemantics === 'cluster_registry' // installation-wide or undeclared cluster: prod authority
  const noProductChain = ['installation', 'cluster', 'server', 'node', 'identity', 'access', 'audit', 'plan', 'operation', 'backup'].includes(row.subject)
  const covered = cred.bindings.some((b) => {
    if (!(t.roles[b.role]?.permissions ?? []).includes(p.permission as string)) return false
    if (b.scope === 'global') return true
    // an environment binding covers target-chain subjects of its tier only; never installation-wide or tier-raised subjects
    if (noProductChain || production || tier === undefined) return false
    return b.scope === tier
  })
  if (!covered) return 'D'
  // a grant's tier and target restrictions
  if (tier !== undefined && !cred.tiers.includes(tier)) return 'D'
  if (cred.targetList !== undefined && (tier === undefined || cred.targetList !== tier)) return 'D'
  if (cred.targetList !== undefined && noProductChain) return 'D'
  // a delegated principal never has a fresh re-authentication
  if (row.reauth) return 'D'
  return 'A'
}

export function expectString(row: OracleRow, t: Tables): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, cred] of Object.entries(CREDENTIAL_CLASSES)) {
    out[name] = row.variants.map((v) => oracle(row, cred, v, t)).join('')
  }
  return out
}
