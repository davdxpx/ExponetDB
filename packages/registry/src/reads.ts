import type { Queryable } from '@exponetdb/control-store'
import { RegistryError } from './errors.ts'
import {
  type ClusterRecord,
  type CredentialRecord,
  clusterFrom,
  credentialFrom,
  type DatabaseRecord,
  databaseFrom,
  type EndpointRecord,
  type EnvironmentRecord,
  endpointFrom,
  environmentFrom,
  type ProductRecord,
  type ProjectRecord,
  productFrom,
  projectFrom,
  type ServerRecord,
  serverFrom,
  type TargetRecord,
  type TargetState,
  type Tier,
  targetFrom,
  ts,
} from './records.ts'

/**
 * Registry reads ([registry.md](../../../exponetdb-docs/02-control-plane/registry.md)).
 * Collections are keyset-paginated by id (stable order, an opaque cursor
 * that is the last returned id); a page never names an object outside the
 * caller's visibility, so neither the items nor the cursor leak one.
 */
export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

export interface PageRequest {
  readonly limit: number
  readonly cursor?: string | undefined
}

/** A fixed-length prefix from the contract's cursor alphabet (`[A-Za-z0-9_-]`). */
const CURSOR_PREFIX = 'r1_'

/** Opaque cursor: a version prefix and the base64url of the last returned id. */
export function encodeCursor(id: string): string {
  return CURSOR_PREFIX + Buffer.from(id, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  const id = Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')
  if (!/^[a-z]{2,3}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return id
}

function page<T>(rows: readonly T[], limit: number, idOf: (t: T) => string): Page<T> {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(idOf(last)) : null,
  }
}

function limitOf(request: PageRequest): number {
  return Math.min(Math.max(1, Math.trunc(request.limit)), 1000)
}

// ----- products, environments, projects -----

const PRODUCT_COLUMNS = `p.product_id, p.slug, p.display_name, ${ts('p.created_at')}`

/**
 * The organization a caller may list: a global binding sees everything; a
 * product binding its product and projects; a project, environment or
 * target binding the product it lies in and the projects it reaches (an
 * environment reaches every project of its product). Applied in SQL, so no
 * page, count or cursor names anything else.
 */
export type OrganizationVisibility = Pick<
  TargetVisibility,
  'all' | 'productIds' | 'projectIds' | 'environmentIds' | 'targetIds'
>

function visibilityParams(v: OrganizationVisibility): unknown[] {
  return [v.all, [...v.productIds], [...v.projectIds], [...v.environmentIds], [...v.targetIds]]
}

export async function listProducts(
  q: Queryable,
  visibility: OrganizationVisibility,
  request: PageRequest,
): Promise<Page<ProductRecord>> {
  const limit = limitOf(request)
  const { rows } = await q.query(
    'registry.products.list',
    `SELECT ${PRODUCT_COLUMNS} FROM registry.products p
      WHERE ($1::boolean
             OR p.product_id = ANY($2::text[])
             OR EXISTS (SELECT 1 FROM registry.projects j
                         WHERE j.product_id = p.product_id AND j.project_id = ANY($3::text[]))
             OR EXISTS (SELECT 1 FROM registry.environments e
                         WHERE e.product_id = p.product_id AND e.environment_id = ANY($4::text[]))
             OR EXISTS (SELECT 1 FROM registry.targets t JOIN registry.projects j ON j.project_id = t.project_id
                         WHERE j.product_id = p.product_id AND t.target_id = ANY($5::text[])))
        AND ($6::text IS NULL OR p.product_id > $6)
      ORDER BY p.product_id LIMIT $7`,
    [...visibilityParams(visibility), decodeCursor(request.cursor), limit + 1],
  )
  return page(rows.map(productFrom), limit, (p) => p.productId)
}

export async function getProduct(
  q: Queryable,
  productId: string,
): Promise<ProductRecord | undefined> {
  const { rows } = await q.query(
    'registry.products.get',
    `SELECT ${PRODUCT_COLUMNS} FROM registry.products p WHERE p.product_id = $1`,
    [productId],
  )
  const row = rows[0]
  return row === undefined ? undefined : productFrom(row)
}

export async function productBySlug(
  q: Queryable,
  slug: string,
): Promise<ProductRecord | undefined> {
  const { rows } = await q.query(
    'registry.products.by_slug',
    `SELECT ${PRODUCT_COLUMNS} FROM registry.products p WHERE p.slug = $1`,
    [slug],
  )
  const row = rows[0]
  return row === undefined ? undefined : productFrom(row)
}

const ENVIRONMENT_COLUMNS = `e.environment_id, e.product_id, e.slug, e.display_name, e.tier, e.evidence_from,
  ev.slug AS evidence_from_slug, e.rank, e.revision`
const ENVIRONMENT_FROM = `registry.environments e
  LEFT JOIN registry.environments ev ON ev.environment_id = e.evidence_from`

export async function listEnvironments(
  q: Queryable,
  productId: string,
  request: PageRequest,
): Promise<Page<EnvironmentRecord>> {
  const limit = limitOf(request)
  const { rows } = await q.query(
    'registry.environments.list',
    `SELECT ${ENVIRONMENT_COLUMNS} FROM ${ENVIRONMENT_FROM}
      WHERE e.product_id = $1 AND ($2::text IS NULL OR e.environment_id > $2)
      ORDER BY e.environment_id LIMIT $3`,
    [productId, decodeCursor(request.cursor), limit + 1],
  )
  return page(rows.map(environmentFrom), limit, (e) => e.environmentId)
}

export async function getEnvironment(
  q: Queryable,
  environmentId: string,
): Promise<EnvironmentRecord | undefined> {
  const { rows } = await q.query(
    'registry.environments.get',
    `SELECT ${ENVIRONMENT_COLUMNS} FROM ${ENVIRONMENT_FROM} WHERE e.environment_id = $1`,
    [environmentId],
  )
  const row = rows[0]
  return row === undefined ? undefined : environmentFrom(row)
}

export async function environmentBySlug(
  q: Queryable,
  productId: string,
  slug: string,
): Promise<EnvironmentRecord | undefined> {
  const { rows } = await q.query(
    'registry.environments.by_slug',
    `SELECT ${ENVIRONMENT_COLUMNS} FROM ${ENVIRONMENT_FROM} WHERE e.product_id = $1 AND e.slug = $2`,
    [productId, slug],
  )
  const row = rows[0]
  return row === undefined ? undefined : environmentFrom(row)
}

const PROJECT_COLUMNS = `j.project_id, j.product_id, pr.slug AS product_slug, j.slug, j.display_name,
  j.managed_scope, j.evidence_override, j.revision`
const PROJECT_FROM = `registry.projects j JOIN registry.products pr ON pr.product_id = j.product_id`

export async function listProjects(
  q: Queryable,
  visibility: OrganizationVisibility,
  filter: { readonly productSlug?: string | undefined },
  request: PageRequest,
): Promise<Page<ProjectRecord>> {
  const limit = limitOf(request)
  const { rows } = await q.query(
    'registry.projects.list',
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM}
      WHERE ($1::boolean
             OR j.product_id = ANY($2::text[])
             OR j.project_id = ANY($3::text[])
             OR EXISTS (SELECT 1 FROM registry.environments e
                         WHERE e.product_id = j.product_id AND e.environment_id = ANY($4::text[]))
             OR EXISTS (SELECT 1 FROM registry.targets t
                         WHERE t.project_id = j.project_id AND t.target_id = ANY($5::text[])))
        AND ($6::text IS NULL OR pr.slug = $6) AND ($7::text IS NULL OR j.project_id > $7)
      ORDER BY j.project_id LIMIT $8`,
    [
      ...visibilityParams(visibility),
      filter.productSlug ?? null,
      decodeCursor(request.cursor),
      limit + 1,
    ],
  )
  return page(rows.map(projectFrom), limit, (p) => p.projectId)
}

export async function getProject(
  q: Queryable,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  const { rows } = await q.query(
    'registry.projects.get',
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE j.project_id = $1`,
    [projectId],
  )
  const row = rows[0]
  return row === undefined ? undefined : projectFrom(row)
}

/** The project with this product and project slug (`<product>/<project>`), if any. */
export async function getProjectByPath(
  q: Queryable,
  productSlug: string,
  projectSlug: string,
): Promise<ProjectRecord | undefined> {
  const { rows } = await q.query(
    'registry.projects.get_by_path',
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE pr.slug = $1 AND j.slug = $2`,
    [productSlug, projectSlug],
  )
  const row = rows[0]
  return row === undefined ? undefined : projectFrom(row)
}

// ----- servers and clusters -----

const SERVER_COLUMNS = `s.server_id, s.display_name, s.provider, s.location, st.derived_tier`
const SERVER_FROM = `registry.servers s JOIN registry.server_tiers st ON st.server_id = s.server_id`

export async function listServers(q: Queryable, request: PageRequest): Promise<Page<ServerRecord>> {
  const limit = limitOf(request)
  const { rows } = await q.query(
    'registry.servers.list',
    `SELECT ${SERVER_COLUMNS} FROM ${SERVER_FROM}
      WHERE ($1::text IS NULL OR s.server_id > $1) ORDER BY s.server_id LIMIT $2`,
    [decodeCursor(request.cursor), limit + 1],
  )
  return page(rows.map(serverFrom), limit, (s) => s.serverId)
}

export async function getServer(q: Queryable, serverId: string): Promise<ServerRecord | undefined> {
  const { rows } = await q.query(
    'registry.servers.get',
    `SELECT ${SERVER_COLUMNS} FROM ${SERVER_FROM} WHERE s.server_id = $1`,
    [serverId],
  )
  const row = rows[0]
  return row === undefined ? undefined : serverFrom(row)
}

const CLUSTER_COLUMNS = `c.cluster_id, c.server_id, c.management_mode, c.display_name, c.state, c.system_identifier,
  c.server_version_num, c.ca_bundle, ${ts('c.confirmed_at')}, ct.derived_tier, c.declared_tier`
const CLUSTER_FROM = `registry.clusters c JOIN registry.cluster_tiers ct ON ct.cluster_id = c.cluster_id`

export async function listClusters(
  q: Queryable,
  request: PageRequest,
): Promise<Page<ClusterRecord>> {
  const limit = limitOf(request)
  const { rows } = await q.query(
    'registry.clusters.list',
    `SELECT ${CLUSTER_COLUMNS} FROM ${CLUSTER_FROM}
      WHERE ($1::text IS NULL OR c.cluster_id > $1) ORDER BY c.cluster_id LIMIT $2`,
    [decodeCursor(request.cursor), limit + 1],
  )
  return page(rows.map(clusterFrom), limit, (c) => c.clusterId)
}

export async function getCluster(
  q: Queryable,
  clusterId: string,
): Promise<ClusterRecord | undefined> {
  const { rows } = await q.query(
    'registry.clusters.get',
    `SELECT ${CLUSTER_COLUMNS} FROM ${CLUSTER_FROM} WHERE c.cluster_id = $1`,
    [clusterId],
  )
  const row = rows[0]
  return row === undefined ? undefined : clusterFrom(row)
}

export async function clusterBySystemIdentifier(
  q: Queryable,
  systemIdentifier: string,
): Promise<ClusterRecord | undefined> {
  const { rows } = await q.query(
    'registry.clusters.by_system_identifier',
    `SELECT ${CLUSTER_COLUMNS} FROM ${CLUSTER_FROM}
      WHERE c.system_identifier = $1 AND c.state <> 'retired' ORDER BY c.cluster_id LIMIT 1`,
    [systemIdentifier],
  )
  const row = rows[0]
  return row === undefined ? undefined : clusterFrom(row)
}

// ----- endpoints, databases, credentials -----

/**
 * Bounded administrative lists: each read returns at most one row more
 * than its limit, so a view can say it was cut (`truncated`) instead of
 * silently showing part of the list.
 */
export const ENDPOINT_LIST_LIMIT = 200
export const DATABASE_LIST_LIMIT = 1000
export const CREDENTIAL_LIST_LIMIT = 500

const ENDPOINT_COLUMNS = `e.endpoint_id, e.cluster_id, e.kind, e.pooler_mode, e.host, e.port, e.tls_server_name,
  e.label, e.state, ${ts('e.created_at')}, ${ts('e.retired_at')}`

export async function listEndpoints(
  q: Queryable,
  clusterId: string,
  state?: 'active' | 'retired',
): Promise<EndpointRecord[]> {
  const { rows } = await q.query(
    'registry.endpoints.list',
    `SELECT ${ENDPOINT_COLUMNS} FROM registry.endpoints e
      WHERE e.cluster_id = $1 AND ($2::text IS NULL OR e.state = $2)
      ORDER BY e.endpoint_id LIMIT ${ENDPOINT_LIST_LIMIT + 1}`,
    [clusterId, state ?? null],
  )
  return rows.map(endpointFrom)
}

export async function getEndpoint(
  q: Queryable,
  endpointId: string,
): Promise<EndpointRecord | undefined> {
  const { rows } = await q.query(
    'registry.endpoints.get',
    `SELECT ${ENDPOINT_COLUMNS} FROM registry.endpoints e WHERE e.endpoint_id = $1`,
    [endpointId],
  )
  const row = rows[0]
  return row === undefined ? undefined : endpointFrom(row)
}

/** An active endpoint at this address anywhere in the registry (an address names one cluster). */
export async function activeEndpointAt(
  q: Queryable,
  host: string,
  port: number,
): Promise<EndpointRecord | undefined> {
  const { rows } = await q.query(
    'registry.endpoints.by_address',
    `SELECT ${ENDPOINT_COLUMNS} FROM registry.endpoints e
      WHERE lower(e.host) = lower($1) AND e.port = $2 AND e.state = 'active' LIMIT 1`,
    [host, port],
  )
  const row = rows[0]
  return row === undefined ? undefined : endpointFrom(row)
}

const DATABASE_COLUMNS = `d.database_id, d.cluster_id, d.name, d.state, d.observed_oid::text AS observed_oid,
  d.observed_owner, d.observed_encoding, d.observed_collation, ${ts('d.observed_at')}, ${ts('d.created_at')},
  pl.target_id AS placed_target_id, pl.generation AS placed_generation`
const DATABASE_FROM = `registry.databases d
  LEFT JOIN registry.placements pl ON pl.database_id = d.database_id AND pl.valid_to IS NULL`

export async function listDatabases(q: Queryable, clusterId: string): Promise<DatabaseRecord[]> {
  const { rows } = await q.query(
    'registry.databases.list',
    `SELECT ${DATABASE_COLUMNS} FROM ${DATABASE_FROM}
      WHERE d.cluster_id = $1 ORDER BY d.database_id LIMIT ${DATABASE_LIST_LIMIT + 1}`,
    [clusterId],
  )
  return rows.map(databaseFrom)
}

export async function getDatabase(
  q: Queryable,
  databaseId: string,
): Promise<DatabaseRecord | undefined> {
  const { rows } = await q.query(
    'registry.databases.get',
    `SELECT ${DATABASE_COLUMNS} FROM ${DATABASE_FROM} WHERE d.database_id = $1`,
    [databaseId],
  )
  const row = rows[0]
  return row === undefined ? undefined : databaseFrom(row)
}

export async function registeredDatabaseNamed(
  q: Queryable,
  clusterId: string,
  name: string,
): Promise<DatabaseRecord | undefined> {
  const { rows } = await q.query(
    'registry.databases.by_name',
    `SELECT ${DATABASE_COLUMNS} FROM ${DATABASE_FROM}
      WHERE d.cluster_id = $1 AND d.name = $2 AND d.state = 'registered'`,
    [clusterId, name],
  )
  const row = rows[0]
  return row === undefined ? undefined : databaseFrom(row)
}

const CREDENTIAL_COLUMNS = `c.credential_id, c.cluster_id, c.access_role, c.role_name, c.secret_id, c.secret_version,
  c.state, ${ts('c.submitted_at')}, c.submitted_by, ${ts('c.verified_at')}, c.failure_code, ${ts('c.state_changed_at')}`

export async function listCredentials(
  q: Queryable,
  clusterId: string,
): Promise<CredentialRecord[]> {
  const { rows } = await q.query(
    'registry.credentials.list',
    `SELECT ${CREDENTIAL_COLUMNS} FROM registry.credentials c
      WHERE c.cluster_id = $1 ORDER BY c.access_role, c.secret_version DESC, c.credential_id LIMIT ${CREDENTIAL_LIST_LIMIT + 1}`,
    [clusterId],
  )
  return rows.map(credentialFrom)
}

/** The active credential of a role on a cluster, if any. */
export async function activeCredential(
  q: Queryable,
  clusterId: string,
  role: string,
): Promise<CredentialRecord | undefined> {
  const { rows } = await q.query(
    'registry.credentials.active',
    `SELECT ${CREDENTIAL_COLUMNS} FROM registry.credentials c
      WHERE c.cluster_id = $1 AND c.access_role = $2 AND c.state = 'active'`,
    [clusterId, role],
  )
  const row = rows[0]
  return row === undefined ? undefined : credentialFrom(row)
}

/** One credential row by its id. */
export async function getCredential(
  q: Queryable,
  credentialId: string,
): Promise<CredentialRecord | undefined> {
  const { rows } = await q.query(
    'registry.credentials.get',
    `SELECT ${CREDENTIAL_COLUMNS} FROM registry.credentials c WHERE c.credential_id = $1`,
    [credentialId],
  )
  const row = rows[0]
  return row === undefined ? undefined : credentialFrom(row)
}

/** The most recent credential row of a role on a cluster (its secret continues). */
export async function latestCredential(
  q: Queryable,
  clusterId: string,
  role: string,
): Promise<CredentialRecord | undefined> {
  const { rows } = await q.query(
    'registry.credentials.latest',
    `SELECT ${CREDENTIAL_COLUMNS} FROM registry.credentials c
      WHERE c.cluster_id = $1 AND c.access_role = $2
      ORDER BY c.secret_version DESC, c.submitted_at DESC LIMIT 1`,
    [clusterId, role],
  )
  const row = rows[0]
  return row === undefined ? undefined : credentialFrom(row)
}

// ----- targets -----

/**
 * What the caller may see of the target list, computed from the covering
 * role bindings and, for a delegated credential, the grant's restrictions
 * (authorization.md §3, oauth.md §4). Applied in SQL, so a restricted
 * caller never learns the name or state of another target, not even
 * through a cursor.
 */
export interface TargetVisibility {
  /** A global binding covers every target. */
  readonly all: boolean
  readonly productIds: readonly string[]
  readonly projectIds: readonly string[]
  readonly environmentIds: readonly string[]
  readonly targetIds: readonly string[]
  /** A delegated grant's target list; undefined means no list restriction. */
  readonly onlyTargetIds?: readonly string[]
  /** A delegated grant's tiers; undefined means both. */
  readonly onlyTiers?: readonly Tier[]
}

export interface TargetFilter {
  readonly product?: string | undefined
  readonly project?: string | undefined
  readonly environment?: string | undefined
  readonly tier?: Tier | undefined
  readonly state?: TargetState | undefined
}

const TARGET_COLUMNS = `t.target_id, t.path, j.product_id, t.project_id, t.environment_id, e.slug AS environment_slug,
  t.tier, t.generation, t.state, t.state_reason, ${ts('t.state_changed_at')}, ${ts('t.created_at')},
  pl.placement_id, pl.generation AS placement_generation, ${ts('pl.valid_from')},
  d.database_id, d.name AS database_name, d.observed_oid::text AS database_oid,
  c.cluster_id, c.display_name AS cluster_name, c.state AS cluster_state, c.system_identifier,
  c.server_version_num, c.management_mode, s.display_name AS server_name`
const TARGET_FROM = `registry.targets t
  JOIN registry.projects j ON j.project_id = t.project_id
  JOIN registry.products pr ON pr.product_id = j.product_id
  JOIN registry.environments e ON e.environment_id = t.environment_id
  LEFT JOIN registry.placements pl ON pl.target_id = t.target_id AND pl.valid_to IS NULL
  LEFT JOIN registry.databases d ON d.database_id = pl.database_id
  LEFT JOIN registry.clusters c ON c.cluster_id = d.cluster_id
  LEFT JOIN registry.servers s ON s.server_id = c.server_id`

/**
 * The one rule for which targets a caller may read, as SQL over the aliases
 * `t` (registry.targets) and `j` (registry.projects): the scopes of its
 * grants, then the restrictions of a delegation (a target list, tiers). The
 * target list and every Wave 8 aggregate over targets (the fleet overview,
 * the cross-target findings) use this clause, so none of them has a rule of
 * its own. Seven parameters starting at `first`.
 */
export function targetVisibilitySql(
  visibility: TargetVisibility,
  first: number,
): { readonly sql: string; readonly params: unknown[] } {
  const p = (n: number) => `$${first + n}`
  return {
    sql: `(${p(0)}::boolean OR j.product_id = ANY(${p(1)}::text[]) OR t.project_id = ANY(${p(2)}::text[])
             OR t.environment_id = ANY(${p(3)}::text[]) OR t.target_id = ANY(${p(4)}::text[]))
        AND (${p(5)}::text[] IS NULL OR t.target_id = ANY(${p(5)}::text[]))
        AND t.tier = ANY(${p(6)}::text[])`,
    params: [
      visibility.all,
      [...visibility.productIds],
      [...visibility.projectIds],
      [...visibility.environmentIds],
      [...visibility.targetIds],
      visibility.onlyTargetIds === undefined ? null : [...visibility.onlyTargetIds],
      [...(visibility.onlyTiers ?? ['prod', 'nonprod'])],
    ],
  }
}

export async function listTargets(
  q: Queryable,
  visibility: TargetVisibility,
  filter: TargetFilter,
  request: PageRequest,
): Promise<Page<TargetRecord>> {
  const limit = limitOf(request)
  const visible = targetVisibilitySql(visibility, 1)
  const { rows } = await q.query(
    'registry.targets.list',
    `SELECT ${TARGET_COLUMNS} FROM ${TARGET_FROM}
      WHERE ${visible.sql}
        AND ($8::text IS NULL OR pr.slug = $8)
        AND ($9::text IS NULL OR j.slug = $9)
        AND ($10::text IS NULL OR e.slug = $10)
        AND ($11::text IS NULL OR t.tier = $11)
        AND ($12::text IS NULL OR t.state = $12)
        AND ($13::text IS NULL OR t.target_id > $13)
      ORDER BY t.target_id LIMIT $14`,
    [
      ...visible.params,
      filter.product ?? null,
      filter.project ?? null,
      filter.environment ?? null,
      filter.tier ?? null,
      filter.state ?? null,
      decodeCursor(request.cursor),
      limit + 1,
    ],
  )
  return page(rows.map(targetFrom), limit, (t) => t.targetId)
}

/** A target by `tgt_` id or by path; a path names the live target (never a decommissioned one). */
export async function findTarget(q: Queryable, ref: string): Promise<TargetRecord | undefined> {
  const byId = /^tgt_/.test(ref)
  const { rows } = await q.query(
    byId ? 'registry.targets.get' : 'registry.targets.by_path',
    `SELECT ${TARGET_COLUMNS} FROM ${TARGET_FROM}
      WHERE ${byId ? 't.target_id = $1' : `t.path = $1 AND t.state <> 'decommissioned'`}`,
    [ref],
  )
  const row = rows[0]
  return row === undefined ? undefined : targetFrom(row)
}

/** Whether any target, live or decommissioned, holds a path (a path is never reused). */
export async function pathHeld(q: Queryable, path: string): Promise<boolean> {
  const { rows } = await q.query(
    'registry.targets.path_held',
    'SELECT 1 FROM registry.targets WHERE path = $1 LIMIT 1',
    [path],
  )
  return rows.length > 0
}

/** The live target of a project and environment, if one exists. */
export async function liveTargetOf(
  q: Queryable,
  projectId: string,
  environmentId: string,
): Promise<TargetRecord | undefined> {
  const { rows } = await q.query(
    'registry.targets.live_pair',
    `SELECT ${TARGET_COLUMNS} FROM ${TARGET_FROM}
      WHERE t.project_id = $1 AND t.environment_id = $2 AND t.state <> 'decommissioned'`,
    [projectId, environmentId],
  )
  const row = rows[0]
  return row === undefined ? undefined : targetFrom(row)
}

/** Live targets of an environment with their generations (an environment change binds them). */
export async function liveTargetsOfEnvironment(
  q: Queryable,
  environmentId: string,
): Promise<{ readonly targetId: string; readonly generation: number }[]> {
  const { rows } = await q.query(
    'registry.targets.of_environment',
    `SELECT target_id, generation FROM registry.targets
      WHERE environment_id = $1 AND state <> 'decommissioned' ORDER BY target_id`,
    [environmentId],
  )
  return rows.map((r) => ({ targetId: r.text('target_id'), generation: r.int('generation') }))
}
