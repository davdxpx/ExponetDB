import type { AccessRole, NodeHealthState, NodeRoleStep, PlanRead } from '@exponetdb/sdk/operations'
import type { HealthState } from '@exponetdb/ui-patterns'
import { isClusterId, isNodeId, isServerId, isTokenId } from './keys.ts'

/**
 * The read models of the infrastructure pages: pure functions, unit-tested,
 * no DOM. Nothing here decides what a person may do (the server does); it
 * only turns the server's answers into what a page shows and what a form
 * sends.
 */

// ----- paths -----

export function serverPath(id: string): string | undefined {
  return isServerId(id) ? `/infrastructure/servers/${id}` : undefined
}
export function clusterPath(id: string): string | undefined {
  return isClusterId(id) ? `/infrastructure/clusters/${id}` : undefined
}
export function nodePath(id: string): string | undefined {
  return isNodeId(id) ? `/infrastructure/nodes/${id}` : undefined
}

/**
 * The credentials hand-off for one of ExponetDB's roles on a cluster
 * (`/credentials#cluster=cls_…&role=…`, the grammar of `links.ts`): ids and
 * a fixed role only, never a secret.
 */
export function credentialsPath(clusterId: string, role: AccessRole): string | undefined {
  return isClusterId(clusterId) ? `/credentials#cluster=${clusterId}&role=${role}` : undefined
}

// ----- node health -----

/**
 * The badge of a node's lifecycle and health state. Only `active` is
 * healthy; `unknown` and `pending_enrollment` are unknown (never green);
 * `offline` and `binding_failed` are unhealthy; `revoked` and
 * `decommissioned` are unknown as health (the node no longer reports) and
 * named by their word beside the badge. A state this release does not know
 * is unknown.
 */
export function nodeHealth(state: NodeHealthState | string): HealthState {
  switch (state) {
    case 'active':
      return 'healthy'
    case 'degraded':
      return 'degraded'
    case 'offline':
    case 'binding_failed':
      return 'unhealthy'
    default:
      return 'unknown'
  }
}

/** Node states the page knows a word for (the message catalog's `infra.node.state.*`). */
export const NODE_STATES = [
  'active',
  'degraded',
  'offline',
  'revoked',
  'unknown',
  'pending_enrollment',
  'decommissioned',
  'binding_failed',
] as const
export type KnownNodeState = (typeof NODE_STATES)[number]

export function knownNodeState(state: string): KnownNodeState {
  return (NODE_STATES as readonly string[]).includes(state) ? (state as KnownNodeState) : 'unknown'
}

/** States a node no longer leaves (no revoke or decommission is offered on them). */
export function nodeIsTerminal(state: string): boolean {
  return state === 'revoked' || state === 'decommissioned' || state === 'binding_failed'
}

/** The clock skew the agent tolerates when it checks a job's validity window (protocol.md §6). */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000

export function skewBeyondTolerance(skewMs: number | null): boolean {
  return skewMs !== null && Math.abs(skewMs) > CLOCK_SKEW_TOLERANCE_MS
}

// ----- certificates -----

export type ExpiryState = 'expired' | 'soon' | 'valid' | 'not_yet' | 'unknown'

/** Days before expiry from which a certificate is shown with a warning. */
export const EXPIRY_WARNING_DAYS = 14
/** A node certificate lives 72 hours and renews at 48: below a day left it missed a renewal. */
export const NODE_CERT_WARNING_HOURS = 24

export function expiryState(
  notAfter: string,
  now: number,
  warnMs: number = EXPIRY_WARNING_DAYS * 86_400_000,
  notBefore?: string,
): ExpiryState {
  const end = Date.parse(notAfter)
  if (!Number.isFinite(end)) return 'unknown'
  if (notBefore !== undefined) {
    const start = Date.parse(notBefore)
    if (!Number.isFinite(start)) return 'unknown'
    if (now < start) return 'not_yet'
  }
  if (end <= now) return 'expired'
  if (end - now <= warnMs) return 'soon'
  return 'valid'
}

// ----- enrollment -----

export interface EnrollmentToken {
  readonly planId: string
  readonly tokenId: string
  readonly serverId: string
  readonly createdAt: string
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The enrollment tokens the person's applied `node.enroll` plans created
 * (the plan's stored content names `tokenId` and `serverId`). A plan whose
 * content does not carry both ids in their grammar is left out.
 */
export function enrollmentTokensOf(plans: readonly PlanRead[]): EnrollmentToken[] {
  const tokens: EnrollmentToken[] = []
  for (const plan of plans) {
    if (plan.kind !== 'node.enroll' || plan.state !== 'consumed') continue
    const content = record(plan.change?.content)
    const tokenId = content?.['tokenId']
    const serverId = content?.['serverId']
    if (isTokenId(tokenId) && isServerId(serverId)) {
      tokens.push({ planId: plan.id, tokenId, serverId, createdAt: plan.createdAt })
    }
  }
  return tokens
}

/** The host commands of node-runbook.md §3, with the token in a file of mode 0600 (never on a command line). */
export const ENROLL_COMMANDS = [
  'install -m 0600 /dev/null /root/token',
  'sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file /root/token',
  'shred -u /root/token',
] as const

// ----- roles as cluster desired state -----

/** A role name the roles capability accepts (`ManagedNameSchema`). */
const ROLE_NAME = /^[a-z_][a-z0-9_$-]{0,62}$/

export function isRoleName(value: string): boolean {
  return ROLE_NAME.test(value)
}

/** A consumer role whose verifier may be submitted: never `pg_…` and never ExponetDB's own. */
export function isConsumerRoleName(value: string): boolean {
  return isRoleName(value) && !/^(pg_|exponetdb_)/.test(value)
}

export const ROLE_ATTRIBUTES = [
  'login',
  'inherit',
  'createdb',
  'createrole',
  'replication',
  'bypassrls',
] as const
export type RoleAttribute = (typeof ROLE_ATTRIBUTES)[number]

/** Attributes whose grant needs the typed cluster name (wave-8-order §7 Infrastructure). */
export const DANGEROUS_ATTRIBUTES: readonly RoleAttribute[] = [
  'bypassrls',
  'replication',
  'createrole',
]

/** One attribute in the form: leave it as it is, grant it, or revoke it. */
export type AttributeChoice = 'keep' | 'grant' | 'revoke'

export interface DesiredRole {
  /** A stable key of the row in the form (not sent). */
  readonly key: string
  readonly name: string
  readonly op: 'create_role' | 'alter_role'
  readonly attributes: Readonly<Record<RoleAttribute, AttributeChoice>>
  /** Empty: leave as it is; `-1`: no limit. */
  readonly connectionLimit: string
}

export function emptyRole(key: string): DesiredRole {
  return {
    key,
    name: '',
    op: 'create_role',
    attributes: {
      login: 'keep',
      inherit: 'keep',
      createdb: 'keep',
      createrole: 'keep',
      replication: 'keep',
      bypassrls: 'keep',
    },
    connectionLimit: '',
  }
}

export type RoleProblem =
  | { readonly kind: 'none' }
  | { readonly kind: 'name'; readonly index: number }
  | { readonly kind: 'duplicate'; readonly index: number }
  | { readonly kind: 'limit'; readonly index: number }

function choice(value: AttributeChoice): boolean | null {
  return value === 'keep' ? null : value === 'grant'
}

function limitOf(text: string): number | null | undefined {
  if (text.trim() === '') return null
  if (!/^-?[0-9]{1,6}$/.test(text.trim())) return undefined
  const n = Number(text.trim())
  return n >= -1 && n <= 100_000 ? n : undefined
}

/** The first thing wrong with the desired roles, checked before anything is sent. */
export function roleProblem(roles: readonly DesiredRole[]): RoleProblem {
  const seen = new Set<string>()
  for (const [index, role] of roles.entries()) {
    if (!isRoleName(role.name)) return { kind: 'name', index }
    if (seen.has(role.name)) return { kind: 'duplicate', index }
    seen.add(role.name)
    if (limitOf(role.connectionLimit) === undefined) return { kind: 'limit', index }
  }
  return { kind: 'none' }
}

/**
 * The `postgres.roles.apply` steps of the desired roles: one `create_role`
 * or `alter_role` step each, every member that does not belong to the op
 * null, and never `set_password` (a verifier is never in a plan).
 */
export function roleSteps(roles: readonly DesiredRole[]): NodeRoleStep[] {
  return roles.map((role) => ({
    op: role.op,
    role: role.name,
    attributes: {
      login: choice(role.attributes.login),
      inherit: choice(role.attributes.inherit),
      createdb: choice(role.attributes.createdb),
      createrole: choice(role.attributes.createrole),
      replication: choice(role.attributes.replication),
      bypassrls: choice(role.attributes.bypassrls),
      connectionLimit: limitOf(role.connectionLimit) ?? null,
    },
    verifier: null,
    member: null,
    admin: null,
    inherit: null,
    set: null,
    database: null,
    setting: null,
    value: null,
  }))
}

/** The dangerous attributes the desired roles grant (`BYPASSRLS`, `REPLICATION`, `CREATEROLE`). */
export function dangerousGrants(
  roles: readonly DesiredRole[],
): { readonly role: string; readonly attribute: RoleAttribute }[] {
  const grants: { role: string; attribute: RoleAttribute }[] = []
  for (const role of roles) {
    for (const attribute of DANGEROUS_ATTRIBUTES) {
      if (role.attributes[attribute] === 'grant') grants.push({ role: role.name, attribute })
    }
  }
  return grants
}

/** A role as the latest node-signed `postgres.roles.inspect` observation shows it. */
export interface ObservedRole {
  readonly name: string
  readonly login: boolean
  readonly superuser: boolean
  readonly createrole: boolean
  readonly replication: boolean
  readonly bypassrls: boolean
  readonly password: string
}

/**
 * The roles of an observation result, read defensively: the result is the
 * node's word (untrusted JSON), so anything that is not the expected shape
 * is left out and counted, never guessed.
 */
export function observedRoles(result: unknown): {
  readonly roles: ObservedRole[]
  readonly unreadable: number
} {
  const items = record(result)?.['roles']
  if (!Array.isArray(items)) return { roles: [], unreadable: 1 }
  const roles: ObservedRole[] = []
  let unreadable = 0
  for (const item of items) {
    const r = record(item)
    const flags = ['login', 'superuser', 'createrole', 'replication', 'bypassrls'] as const
    if (
      r === undefined ||
      typeof r['name'] !== 'string' ||
      flags.some((flag) => typeof r[flag] !== 'boolean')
    ) {
      unreadable += 1
      continue
    }
    roles.push({
      name: r['name'],
      login: r['login'] === true,
      superuser: r['superuser'] === true,
      createrole: r['createrole'] === true,
      replication: r['replication'] === true,
      bypassrls: r['bypassrls'] === true,
      password: typeof r['password'] === 'string' ? r['password'] : 'unknown',
    })
  }
  return { roles, unreadable }
}

/** The node that serves a cluster's server: the one that is not revoked, decommissioned or failed. */
export function servingNode<T extends { readonly serverId: string; readonly state: string }>(
  nodes: readonly T[],
  serverId: string | null,
): T | undefined {
  if (serverId === null) return undefined
  return nodes.find((node) => node.serverId === serverId && !nodeIsTerminal(node.state))
}

/** Job keys typed in a field, separated by commas or spaces. */
export function keyList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

const KEY_ID = /^[a-z][a-z0-9_]{0,63}$/
export function isKeyId(value: string): boolean {
  return KEY_ID.test(value)
}
