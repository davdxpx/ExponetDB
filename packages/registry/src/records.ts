import { type AccessRole, SERVER_PROVIDERS, type ServerProvider } from '@exponetdb/contracts'
import type { Row } from '@exponetdb/control-store'
import { InvariantError } from '@exponetdb/kernel'

/**
 * The registry's read model: one record per row, with ids, slugs and
 * states as the Control Store checks them. Records stay inside the server;
 * interfaces get purpose-built views (`views.ts`) that never carry a CA
 * bundle, an address (except the administrative endpoint view), a secret
 * reference or anything else a response must not show.
 */
export type Tier = 'prod' | 'nonprod'

/** Timestamp columns as RFC 3339 UTC text with microseconds, formatted by the database. */
export const ts = (column: string, alias = column.replace(/^.*\./, '')): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

export function tierOf(value: string | null): Tier | null {
  if (value === null) return null
  if (value === 'prod' || value === 'nonprod') return value
  throw new InvariantError('a stored tier is prod or nonprod')
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((v) => v === value)
  if (found === undefined) {
    throw new InvariantError('a stored registry value is one the Control Store allows')
  }
  return found
}

export interface ProductRecord {
  readonly productId: string
  readonly slug: string
  readonly displayName: string
  readonly createdAt: string
}

export function productFrom(row: Row): ProductRecord {
  return {
    productId: row.text('product_id'),
    slug: row.text('slug'),
    displayName: row.text('display_name'),
    createdAt: row.text('created_at'),
  }
}

export interface EnvironmentRecord {
  readonly environmentId: string
  readonly productId: string
  readonly slug: string
  readonly displayName: string
  readonly tier: Tier
  readonly evidenceFrom: string | null
  readonly evidenceFromSlug: string | null
  readonly rank: number
  readonly revision: number
}

export function environmentFrom(row: Row): EnvironmentRecord {
  return {
    environmentId: row.text('environment_id'),
    productId: row.text('product_id'),
    slug: row.text('slug'),
    displayName: row.text('display_name'),
    tier: oneOf(['prod', 'nonprod'] as const, row.text('tier')),
    evidenceFrom: row.textOrNull('evidence_from'),
    evidenceFromSlug: row.textOrNull('evidence_from_slug'),
    rank: row.int('rank'),
    revision: row.int('revision'),
  }
}

export interface ManagedScopeRecord {
  readonly includeSchemas: readonly string[] | null
  readonly excludeSchemas: readonly string[]
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined
}

export function managedScopeFrom(value: unknown): ManagedScopeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantError('a stored managed scope is an object')
  }
  const record = value as Record<string, unknown>
  const exclude = strings(record['excludeSchemas'])
  const include = record['includeSchemas'] === undefined ? null : strings(record['includeSchemas'])
  if (exclude === undefined || include === undefined) {
    throw new InvariantError('a stored managed scope lists schema names')
  }
  return { includeSchemas: include, excludeSchemas: exclude }
}

export interface ProjectRecord {
  readonly projectId: string
  readonly productId: string
  readonly productSlug: string
  readonly slug: string
  readonly displayName: string
  readonly managedScope: ManagedScopeRecord
  readonly evidenceOverride: Readonly<Record<string, 'none'>>
  readonly revision: number
}

export function projectFrom(row: Row): ProjectRecord {
  const override = row.json('evidence_override')
  const evidenceOverride: Record<string, 'none'> = {}
  if (typeof override === 'object' && override !== null && !Array.isArray(override)) {
    for (const [slug, value] of Object.entries(override)) {
      if (value === 'none') evidenceOverride[slug] = 'none'
    }
  }
  return {
    projectId: row.text('project_id'),
    productId: row.text('product_id'),
    productSlug: row.text('product_slug'),
    slug: row.text('slug'),
    displayName: row.text('display_name'),
    managedScope: managedScopeFrom(row.json('managed_scope')),
    evidenceOverride,
    revision: row.int('revision'),
  }
}

/** The providers of the contract; the Control Store's CHECK on `registry.servers.provider` allows the same. */
export type Provider = ServerProvider

export interface ServerRecord {
  readonly serverId: string
  readonly displayName: string
  readonly provider: Provider
  readonly location: string | null
  readonly derivedTier: Tier | null
}

export function serverFrom(row: Row): ServerRecord {
  return {
    serverId: row.text('server_id'),
    displayName: row.text('display_name'),
    provider: oneOf(SERVER_PROVIDERS, row.text('provider')),
    location: row.textOrNull('location'),
    derivedTier: tierOf(row.textOrNull('derived_tier')),
  }
}

export type ClusterState = 'pending' | 'active' | 'retired'

export interface ClusterRecord {
  readonly clusterId: string
  readonly serverId: string | null
  readonly managementMode: 'external' | 'agent'
  readonly displayName: string
  readonly state: ClusterState
  readonly systemIdentifier: string | null
  readonly serverVersionNum: number | null
  /** PEM of the CA certificates (public, but never part of an API response). */
  readonly caBundle: string
  readonly confirmedAt: string | null
  readonly derivedTier: Tier | null
  /** The intended tier a person declared (OD-22); null while undeclared, which counts as prod for registry authority. */
  readonly declaredTier: Tier | null
}

export function clusterFrom(row: Row): ClusterRecord {
  return {
    clusterId: row.text('cluster_id'),
    serverId: row.textOrNull('server_id'),
    managementMode: oneOf(['external', 'agent'] as const, row.text('management_mode')),
    displayName: row.text('display_name'),
    state: oneOf(['pending', 'active', 'retired'] as const, row.text('state')),
    systemIdentifier: row.textOrNull('system_identifier'),
    serverVersionNum: row.intOrNull('server_version_num'),
    caBundle: row.text('ca_bundle'),
    confirmedAt: row.textOrNull('confirmed_at'),
    derivedTier: tierOf(row.textOrNull('derived_tier')),
    declaredTier: tierOf(row.textOrNull('declared_tier')),
  }
}

export const ENDPOINT_KINDS = ['private', 'public', 'local_socket', 'pooler'] as const
export type EndpointKind = (typeof ENDPOINT_KINDS)[number]

export interface EndpointRecord {
  readonly endpointId: string
  readonly clusterId: string
  readonly kind: EndpointKind
  readonly poolerMode: 'session' | 'transaction' | null
  readonly host: string
  readonly port: number
  readonly tlsServerName: string
  readonly label: string
  readonly state: 'active' | 'retired'
  readonly createdAt: string
  readonly retiredAt: string | null
}

export function endpointFrom(row: Row): EndpointRecord {
  const pooler = row.textOrNull('pooler_mode')
  return {
    endpointId: row.text('endpoint_id'),
    clusterId: row.text('cluster_id'),
    kind: oneOf(ENDPOINT_KINDS, row.text('kind')),
    poolerMode: pooler === null ? null : oneOf(['session', 'transaction'] as const, pooler),
    host: row.text('host'),
    port: row.int('port'),
    tlsServerName: row.text('tls_server_name'),
    label: row.text('label'),
    state: oneOf(['active', 'retired'] as const, row.text('state')),
    createdAt: row.text('created_at'),
    retiredAt: row.textOrNull('retired_at'),
  }
}

export interface DatabaseRecord {
  readonly databaseId: string
  readonly clusterId: string
  readonly name: string
  readonly state: 'registered' | 'retired'
  readonly observedOid: string | null
  readonly observedOwner: string | null
  readonly observedEncoding: string | null
  readonly observedCollation: string | null
  readonly observedAt: string | null
  readonly createdAt: string
  readonly placedTargetId: string | null
  readonly placedGeneration: number | null
}

export function databaseFrom(row: Row): DatabaseRecord {
  return {
    databaseId: row.text('database_id'),
    clusterId: row.text('cluster_id'),
    name: row.text('name'),
    state: oneOf(['registered', 'retired'] as const, row.text('state')),
    observedOid: row.textOrNull('observed_oid'),
    observedOwner: row.textOrNull('observed_owner'),
    observedEncoding: row.textOrNull('observed_encoding'),
    observedCollation: row.textOrNull('observed_collation'),
    observedAt: row.textOrNull('observed_at'),
    createdAt: row.text('created_at'),
    placedTargetId: row.textOrNull('placed_target_id'),
    placedGeneration: row.intOrNull('placed_generation'),
  }
}

export const TARGET_STATES = ['registered', 'active', 'suspended', 'decommissioned'] as const
export type TargetState = (typeof TARGET_STATES)[number]

export interface PlacementRecord {
  readonly placementId: string
  readonly generation: number
  readonly validFrom: string
  readonly databaseId: string
  readonly databaseName: string
  readonly databaseOid: string | null
  readonly clusterId: string
  readonly clusterName: string
  readonly clusterState: ClusterState
  readonly systemIdentifier: string | null
  readonly serverVersionNum: number | null
  readonly managementMode: 'external' | 'agent'
  readonly serverName: string | null
}

export interface TargetRecord {
  readonly targetId: string
  readonly path: string
  readonly productId: string
  readonly projectId: string
  readonly environmentId: string
  readonly environmentSlug: string
  readonly tier: Tier
  readonly generation: number
  readonly state: TargetState
  readonly stateReason: string | null
  readonly stateChangedAt: string
  readonly createdAt: string
  readonly placement: PlacementRecord | null
}

export function targetFrom(row: Row): TargetRecord {
  const placementId = row.textOrNull('placement_id')
  return {
    targetId: row.text('target_id'),
    path: row.text('path'),
    productId: row.text('product_id'),
    projectId: row.text('project_id'),
    environmentId: row.text('environment_id'),
    environmentSlug: row.text('environment_slug'),
    tier: oneOf(['prod', 'nonprod'] as const, row.text('tier')),
    generation: row.int('generation'),
    state: oneOf(TARGET_STATES, row.text('state')),
    stateReason: row.textOrNull('state_reason'),
    stateChangedAt: row.text('state_changed_at'),
    createdAt: row.text('created_at'),
    placement:
      placementId === null
        ? null
        : {
            placementId,
            generation: row.int('placement_generation'),
            validFrom: row.text('valid_from'),
            databaseId: row.text('database_id'),
            databaseName: row.text('database_name'),
            databaseOid: row.textOrNull('database_oid'),
            clusterId: row.text('cluster_id'),
            clusterName: row.text('cluster_name'),
            clusterState: oneOf(
              ['pending', 'active', 'retired'] as const,
              row.text('cluster_state'),
            ),
            systemIdentifier: row.textOrNull('system_identifier'),
            serverVersionNum: row.intOrNull('server_version_num'),
            managementMode: oneOf(['external', 'agent'] as const, row.text('management_mode')),
            serverName: row.textOrNull('server_name'),
          },
  }
}

export const CREDENTIAL_STATES = ['pending', 'active', 'retired', 'failed'] as const
export type CredentialState = (typeof CREDENTIAL_STATES)[number]
const ROLES = ['observer', 'reader', 'verifier', 'operator', 'migrator'] as const

export interface CredentialRecord {
  readonly credentialId: string
  readonly clusterId: string
  readonly accessRole: AccessRole
  readonly roleName: string
  readonly secretId: string
  readonly secretVersion: number
  readonly state: CredentialState
  readonly submittedAt: string
  readonly submittedBy: string
  readonly verifiedAt: string | null
  readonly failureCode: string | null
  readonly stateChangedAt: string
}

export function credentialFrom(row: Row): CredentialRecord {
  return {
    credentialId: row.text('credential_id'),
    clusterId: row.text('cluster_id'),
    accessRole: oneOf(ROLES, row.text('access_role')),
    roleName: row.text('role_name'),
    secretId: row.text('secret_id'),
    secretVersion: row.int('secret_version'),
    state: oneOf(CREDENTIAL_STATES, row.text('state')),
    submittedAt: row.text('submitted_at'),
    submittedBy: row.text('submitted_by'),
    verifiedAt: row.textOrNull('verified_at'),
    failureCode: row.textOrNull('failure_code'),
    stateChangedAt: row.text('state_changed_at'),
  }
}
