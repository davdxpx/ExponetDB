import { createHash } from 'node:crypto'
import {
  type ClientKind,
  type ClientRegistration,
  type ClientState,
  FIRST_PARTY_CLIENT_IDS,
  type OAuthClientView,
  type PublicJwk,
  PublicJwksSchema,
  type TokenEndpointAuthMethod,
} from '@exponetdb/contracts'
import type { Queryable, Row } from '@exponetdb/control-store'
import {
  canonicalize,
  type IdentityId,
  isId,
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type OAuthClientId,
} from '@exponetdb/kernel'
import { isLoopbackHost } from '../config.ts'

/**
 * OAuth clients (oauth.md §3, OD-5): the stored record, exact redirect URI
 * matching, the security fingerprint and the views. Display metadata (name,
 * client URI, software id) is untrusted presentation data: it is shown as
 * text and never decides anything.
 */
export interface OAuthClientRecord {
  readonly clientId: OAuthClientId
  /** The OAuth `client_id` on the wire. */
  readonly externalId: string
  readonly registration: ClientRegistration
  readonly kind: ClientKind
  readonly state: ClientState
  readonly displayName: string
  readonly redirectUris: readonly string[]
  readonly applicationType: 'web' | 'native' | null
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod
  readonly grantTypes: readonly string[]
  readonly metadata: JsonObject | null
  readonly metadataFingerprint: string
  readonly approvedFingerprint: string | null
  readonly approvedBy: IdentityId | null
  readonly approvedAt: string | null
  readonly serviceIdentityId: IdentityId | null
  readonly jwks: readonly PublicJwk[]
  readonly requesterHash: string | null
  readonly createdAt: string
  readonly stateChangedAt: string
  readonly pendingExpiresAt: string | null
  readonly metadataFetchedAt: string | null
  readonly metadataExpiresAt: string | null
  /** The cached metadata is past its freshness (database clock); a CIMD client is fetched again. */
  readonly metadataStale: boolean
}

const ts = (column: string) =>
  `to_char(c.${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`

export const CLIENT_COLUMNS = `c.client_id, c.external_id, c.registration, c.kind, c.state, c.display_name,
  c.redirect_uris, c.application_type, c.token_endpoint_auth_method, c.grant_types, c.metadata,
  c.metadata_fingerprint, c.approved_fingerprint, c.approved_by_identity_id, ${ts('approved_at')},
  c.service_identity_id, c.jwks, c.requester_hash, ${ts('created_at')}, ${ts('state_changed_at')},
  ${ts('pending_expires_at')}, ${ts('metadata_fetched_at')}, ${ts('metadata_expires_at')},
  (c.metadata_expires_at IS NOT NULL AND c.metadata_expires_at <= clock_timestamp()) AS metadata_stale`

const REGISTRATIONS: readonly ClientRegistration[] = [
  'first_party',
  'pre_registered',
  'cimd',
  'dcr',
]
const KINDS: readonly ClientKind[] = ['web', 'cli', 'mcp', 'ci']
const STATES: readonly ClientState[] = ['pending', 'active', 'rejected', 'disabled']

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((v) => v === value)
  if (found === undefined) {
    throw new Error('oauth client row has an unknown value')
  }
  return found
}

function identityOrNull(value: string | null): IdentityId | null {
  return value !== null && isId('idn', value) ? value : null
}

function jwksOf(value: unknown): readonly PublicJwk[] {
  if (value === null || value === undefined) {
    return []
  }
  const parsed = PublicJwksSchema.safeParse(value)
  return parsed.success ? parsed.data.keys : []
}

export function clientFromRow(row: Row): OAuthClientRecord {
  const clientId = row.text('client_id')
  if (!isId('cli', clientId)) {
    throw new Error('oauth client row has an invalid id')
  }
  const applicationType = row.textOrNull('application_type')
  const method = row.text('token_endpoint_auth_method')
  const metadata = row.json('metadata')
  return {
    clientId,
    externalId: row.text('external_id'),
    registration: oneOf(REGISTRATIONS, row.text('registration')),
    kind: oneOf(KINDS, row.text('kind')),
    state: oneOf(STATES, row.text('state')),
    displayName: row.text('display_name'),
    redirectUris: row.textArray('redirect_uris'),
    applicationType:
      applicationType === 'web' || applicationType === 'native' ? applicationType : null,
    tokenEndpointAuthMethod: method === 'private_key_jwt' ? 'private_key_jwt' : 'none',
    grantTypes: row.textArray('grant_types'),
    metadata: isJsonValue(metadata) && isJsonObject(metadata) ? metadata : null,
    metadataFingerprint: row.text('metadata_fingerprint'),
    approvedFingerprint: row.textOrNull('approved_fingerprint'),
    approvedBy: identityOrNull(row.textOrNull('approved_by_identity_id')),
    approvedAt: row.textOrNull('approved_at'),
    serviceIdentityId: identityOrNull(row.textOrNull('service_identity_id')),
    jwks: jwksOf(row.json('jwks')),
    requesterHash: row.textOrNull('requester_hash'),
    createdAt: row.text('created_at'),
    stateChangedAt: row.text('state_changed_at'),
    pendingExpiresAt: row.textOrNull('pending_expires_at'),
    metadataFetchedAt: row.textOrNull('metadata_fetched_at'),
    metadataExpiresAt: row.textOrNull('metadata_expires_at'),
    metadataStale: row.bool('metadata_stale'),
  }
}

export async function readClient(
  q: Queryable,
  clientId: OAuthClientId,
  options: { readonly forUpdate?: boolean } = {},
): Promise<OAuthClientRecord | undefined> {
  const { rows } = await q.query(
    'oauth.client.read',
    `SELECT ${CLIENT_COLUMNS} FROM oauth.clients c WHERE c.client_id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
    [clientId],
  )
  const row = rows[0]
  return row === undefined ? undefined : clientFromRow(row)
}

/** The client with this OAuth `client_id`; exact, case-sensitive comparison. */
export async function readClientByExternalId(
  q: Queryable,
  externalId: string,
): Promise<OAuthClientRecord | undefined> {
  if (externalId.length === 0 || externalId.length > 512) {
    return undefined
  }
  const { rows } = await q.query(
    'oauth.client.read_external',
    `SELECT ${CLIENT_COLUMNS} FROM oauth.clients c WHERE c.external_id = $1`,
    [externalId],
  )
  const row = rows[0]
  return row === undefined ? undefined : clientFromRow(row)
}

/** Clients as views: pending first (they need a decision), then newest first. */
export async function listClientViews(
  q: Queryable,
  query: { readonly state?: ClientState | undefined; readonly limit: number },
): Promise<OAuthClientView[]> {
  const { rows } = await q.query(
    'oauth.client.list',
    `SELECT ${CLIENT_COLUMNS} FROM oauth.clients c
      WHERE ($1::text IS NULL OR c.state = $1)
      ORDER BY (c.state = 'pending') DESC, c.created_at DESC, c.client_id DESC
      LIMIT $2`,
    [query.state ?? null, query.limit],
  )
  return rows.map((row) => clientView(clientFromRow(row)))
}

// ----- redirect URIs (oauth.md §3, RFC 8252 §7.3, OAuth 2.1 §2.3.1) -----

interface ParsedRedirect {
  readonly loopback: boolean
  /** The URI without its port, for the loopback comparison. */
  readonly portless: string
}

/**
 * A redirect URI ExponetDB accepts: an absolute `https` URI, or `http` on a
 * loopback host (127.0.0.1, [::1], localhost); no user information, no
 * fragment, at most 512 characters, and already in its WHATWG serialization
 * (so there is exactly one spelling of each URI to compare).
 */
export function parseRedirectUri(uri: string): ParsedRedirect | undefined {
  if (uri.length === 0 || uri.length > 512 || /[\s\p{Cc}#]/u.test(uri)) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return undefined
  }
  if (url.href !== uri || url.username !== '' || url.password !== '' || url.hash !== '') {
    return undefined
  }
  const loopback = url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !loopback) {
    return undefined
  }
  // Host names only (no wildcard or other characters URL parsing would let through), as the Control Store checks.
  if (!loopback && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(url.hostname)) {
    return undefined
  }
  const portless = new URL(uri)
  portless.port = ''
  return { loopback, portless: portless.href }
}

/**
 * The redirect URI of a request when it matches a registered one: exact
 * string equality, except that a loopback redirect matches on any port (the
 * host, path and query still match exactly).
 */
export function matchRedirectUri(
  registered: readonly string[],
  requested: string,
): string | undefined {
  const asked = parseRedirectUri(requested)
  if (asked === undefined) {
    return undefined
  }
  for (const candidate of registered) {
    if (candidate === requested) {
      return requested
    }
    if (asked.loopback) {
      const known = parseRedirectUri(candidate)
      if (known?.loopback === true && known.portless === asked.portless) {
        return requested
      }
    }
  }
  return undefined
}

export function redirectHost(uri: string): string | null {
  try {
    return new URL(uri).host
  } catch {
    return null
  }
}

// ----- fingerprints -----

function sha256(domain: string, value: string): string {
  return `sha256:${createHash('sha256').update(`${domain}\n${value}`, 'utf8').digest('hex')}`
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of a public key. */
export function jwkThumbprint(key: PublicJwk): string {
  const members =
    key.kty === 'EC'
      ? { crv: key.crv, kty: key.kty, x: key.x, y: key.y }
      : key.kty === 'OKP'
        ? { crv: key.crv, kty: key.kty, x: key.x }
        : { e: key.e, kty: key.kty, n: key.n }
  return createHash('sha256').update(JSON.stringify(members), 'utf8').digest('base64url')
}

/**
 * The fingerprint of a client's security-relevant metadata (OD-5): its
 * `client_id`, redirect URIs, authentication method, application type,
 * grant types and keys. Display metadata is not part of it; any change of
 * these returns an approved client to review.
 */
export function clientFingerprint(input: {
  readonly externalId: string
  readonly redirectUris: readonly string[]
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod
  readonly applicationType: 'web' | 'native' | null
  readonly grantTypes: readonly string[]
  readonly jwks: readonly PublicJwk[]
}): string {
  const canonical = canonicalize({
    clientId: input.externalId,
    redirectUris: [...input.redirectUris].sort(),
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    applicationType: input.applicationType,
    grantTypes: [...input.grantTypes].sort(),
    keys: input.jwks.map(jwkThumbprint).sort(),
  })
  if (!canonical.ok) {
    throw new Error('client fingerprint input is not canonicalizable')
  }
  return sha256('exponetdb/oauth-client-fingerprint/v1', canonical.value)
}

// ----- views -----

function metadataText(metadata: JsonObject | null, key: string, max: number): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

const FIRST_PARTY_EXTERNAL_IDS: ReadonlySet<string> = new Set(Object.values(FIRST_PARTY_CLIENT_IDS))

export function clientSummary(record: OAuthClientRecord) {
  return {
    id: record.clientId,
    clientId: record.externalId,
    kind: record.kind,
    registration: record.registration,
    state: record.state,
    firstParty:
      record.registration === 'first_party' && FIRST_PARTY_EXTERNAL_IDS.has(record.externalId),
    name: record.displayName,
  }
}

export function clientView(record: OAuthClientRecord): OAuthClientView {
  return {
    ...clientSummary(record),
    redirectUris: [...record.redirectUris],
    applicationType: record.applicationType,
    tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
    grantTypes: [...record.grantTypes],
    metadataFingerprint: record.metadataFingerprint,
    approvedFingerprint: record.approvedFingerprint,
    createdAt: record.createdAt,
    stateChangedAt: record.stateChangedAt,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    pendingExpiresAt: record.pendingExpiresAt,
    requesterHash: record.requesterHash,
    metadataFetchedAt: record.metadataFetchedAt,
    metadataExpiresAt: record.metadataExpiresAt,
    serviceAccountId: record.serviceIdentityId,
    keys: record.jwks.map((key) => ({
      kid: key.kid,
      kty: key.kty,
      alg: key.alg ?? null,
      thumbprint: jwkThumbprint(key),
    })),
    clientUri: metadataText(record.metadata, 'client_uri', 512),
    softwareId: metadataText(record.metadata, 'software_id', 128),
    softwareVersion: metadataText(record.metadata, 'software_version', 64),
  }
}

/** Letters and digits only, lower case, common look-alike characters folded. */
function folded(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1|!]/g, 'l')
    .replace(/[3]/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * The untrusted name of a non-first-party client resembles ExponetDB's own
 * clients: the consent screen warns.
 */
export function isLookalike(record: OAuthClientRecord): boolean {
  if (record.registration === 'first_party') {
    return false
  }
  const name = folded(record.displayName)
  return name.includes('exponet') || name.includes('exp0net')
}
