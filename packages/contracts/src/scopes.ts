import * as z from 'zod'
import type { Permission } from './permissions.ts'

/**
 * Kinds of OAuth clients and sessions (policy-engine.md §6, authorization.md
 * §6): the first-party Web App session, the first-party CLI with a human
 * session, MCP clients acting for a human, and service accounts (CI and
 * machine integrations).
 */
export const CLIENT_KINDS = ['web', 'cli', 'mcp', 'ci'] as const
export const ClientKindSchema = z.enum(CLIENT_KINDS)
export type ClientKind = z.infer<typeof ClientKindSchema>

/** Client kinds that always carry a human session. */
export const HUMAN_SESSION_CLIENT_KINDS: readonly ClientKind[] = ['web', 'cli']

export interface ScopeDefinition {
  /** The RBAC permission the identity needs for a client to use this scope; null only for `api`. */
  readonly permission: Permission | null
  /** Tier this scope authorizes; null when the action is not tier-dependent. */
  readonly tier: 'prod' | 'nonprod' | null
  /** May be granted to an OAuth client of kind `mcp` (policy `access.mcp-ineligible-scopes`). */
  readonly mcpGrantable: boolean
  /** Client kinds that may ever hold the scope. */
  readonly clientKinds: readonly ClientKind[]
  /** Usable only with a human session (never a service account, never MCP). */
  readonly humanOnly: boolean
  /** Granting it needs an explicit opt-in on the consent screen (production writes). */
  readonly explicitConsent: boolean
  /** Advertised in the MCP protected resource metadata (minimal baseline, oauth.md §2). */
  readonly mcpBaseline: boolean
  readonly notes: string
}

const ALL: readonly ClientKind[] = CLIENT_KINDS
const HUMAN: readonly ClientKind[] = HUMAN_SESSION_CLIENT_KINDS

function delegable(
  permission: Permission,
  notes = '',
  extra: Partial<ScopeDefinition> = {},
): ScopeDefinition {
  return {
    permission,
    tier: null,
    mcpGrantable: true,
    clientKinds: ALL,
    humanOnly: false,
    explicitConsent: false,
    mcpBaseline: false,
    notes,
    ...extra,
  }
}

function tiered(permission: Permission, tier: 'prod' | 'nonprod', notes: string): ScopeDefinition {
  return delegable(permission, notes, { tier, explicitConsent: tier === 'prod' })
}

/** Never grantable to MCP clients; reachable only through the Web App or CLI with a human session. */
function humanSessionOnly(
  permission: Permission,
  notes: string,
  kinds: readonly ClientKind[] = HUMAN,
): ScopeDefinition {
  return {
    permission,
    tier: null,
    mcpGrantable: false,
    clientKinds: kinds,
    humanOnly: true,
    explicitConsent: true,
    mcpBaseline: false,
    notes,
  }
}

/**
 * OAuth scopes ([authorization.md §4](../../../exponetdb-docs/08-auth-and-security/authorization.md#4-oauth-scopes)).
 * Scope names are stable: never renamed, never reused. A `:prod` scope and a
 * `:nonprod` scope are distinct strings and never imply each other (C-24).
 */
export const SCOPES = {
  'targets.read': delegable('targets.read', 'baseline', { mcpBaseline: true }),
  'schema.read': delegable('schema.read', 'baseline', { mcpBaseline: true }),
  'diagnostics.read': delegable('diagnostics.read', 'baseline; statements redacted', {
    mcpBaseline: true,
  }),
  'data.read:nonprod': tiered('data.read', 'nonprod', ''),
  'data.read:prod': tiered(
    'data.read',
    'prod',
    'policy default humans_only on production targets (OD-13)',
  ),
  'migrations.read': delegable('migrations.read'),
  'migrations.plan': delegable('migrations.plan'),
  'migrations.apply:nonprod': tiered('migrations.apply', 'nonprod', ''),
  'migrations.apply:prod': tiered(
    'migrations.apply',
    'prod',
    'explicit consent with re-auth; agent applies need human approval by default',
  ),
  'connections.operate:nonprod': tiered('connections.operate', 'nonprod', ''),
  'connections.operate:prod': tiered(
    'connections.operate',
    'prod',
    'explicit consent; terminate by agents needs approval',
  ),
  'backups.read': delegable('backups.read'),
  'backups.run': delegable('backups.run', 'non-destructive'),
  'restore.plan': delegable('restore.plan', 'planning only'),
  'nodes.read': delegable('nodes.read'),
  'nodes.plan': delegable('nodes.plan'),
  'nodes.operate:nonprod': tiered('nodes.operate', 'nonprod', 'rare: nodes hosting prod are prod'),
  'nodes.operate:prod': tiered('nodes.operate', 'prod', 'explicit consent; approval always'),
  'audit.read': delegable('audit.read'),
  api: {
    permission: null,
    tier: null,
    mcpGrantable: false,
    clientKinds: ['web'],
    humanOnly: true,
    explicitConsent: false,
    mcpBaseline: false,
    notes: 'session-equivalent scope of the first-party Web App only',
  },
  'registry.manage': humanSessionOnly('registry.manage', 'admin'),
  'access.read': humanSessionOnly(
    'access.read',
    'admin read; Wave 1 clarification (not MCP-grantable)',
  ),
  'access.manage': humanSessionOnly('access.manage', 'admin'),
  'policy.manage': humanSessionOnly('policy.manage', 'admin'),
  'restore.execute': humanSessionOnly('restore.execute', 'human-only in V1'),
  'plans.approve': humanSessionOnly('plans.approve', 'Web App session with re-auth only', ['web']),
  'operations.recover': humanSessionOnly(
    'operations.recover',
    'force-release a stuck lock domain; Web App or first-party CLI with a human session and re-auth',
  ),
  'breakglass.activate': humanSessionOnly(
    'breakglass.activate',
    'Web App or first-party CLI with re-auth',
  ),
  'diagnostics.read_sensitive': humanSessionOnly(
    'diagnostics.read_sensitive',
    'raw statements and error details',
  ),
  'data.read_sensitive': humanSessionOnly('data.read_sensitive', 'unmasked sensitive columns'),
  'migrations.import': humanSessionOnly(
    'migrations.import',
    'legacy import, baseline, ledger reconcile',
  ),
  'schema.manage': humanSessionOnly('schema.manage', 'accept drift'),
} as const satisfies Record<string, ScopeDefinition>

export type Scope = keyof typeof SCOPES

export function isScope(value: string): value is Scope {
  return Object.hasOwn(SCOPES, value)
}

export const SCOPE_IDS: readonly Scope[] = Object.keys(SCOPES).filter(isScope)

export function scopeDefinition(scope: Scope): ScopeDefinition {
  return SCOPES[scope]
}

/** Scopes that the contract forbids for MCP clients (G1 security item). */
export const MCP_INELIGIBLE_SCOPES: readonly Scope[] = SCOPE_IDS.filter(
  (s) => !SCOPES[s].mcpGrantable,
)

/** The minimal scope set advertised in the MCP protected resource metadata. */
export const MCP_BASELINE_SCOPES: readonly Scope[] = SCOPE_IDS.filter((s) => SCOPES[s].mcpBaseline)

/** The tiered scope for a permission, e.g. `migrations.apply` + `prod` → `migrations.apply:prod`. */
export function tieredScope(permission: Permission, tier: 'prod' | 'nonprod'): Scope | undefined {
  const candidate = `${permission}:${tier}`
  return isScope(candidate) ? candidate : undefined
}

/**
 * Whether the contract allows a client of `kind` to receive `scope`. This is
 * the contract-level filter; the authorization server (Wave 3B) adds consent,
 * delegation and policy on top and never widens it.
 */
export function isScopeGrantableTo(scope: Scope, kind: ClientKind): boolean {
  const def: ScopeDefinition = SCOPES[scope]
  if (kind === 'mcp' && !def.mcpGrantable) {
    return false
  }
  return def.clientKinds.includes(kind)
}

export const ScopeSchema = z
  .enum(SCOPE_IDS)
  .meta({ description: 'OAuth scope; tiered scopes end in :prod or :nonprod.' })
