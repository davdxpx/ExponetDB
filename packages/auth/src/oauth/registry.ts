import { randomBytes } from 'node:crypto'
import { type ClientRegistrationResponse, OAUTH_LIMITS } from '@exponetdb/contracts'
import { EXDB_LOCK_NAMESPACE, lockKey2, type Tx } from '@exponetdb/control-store'
import {
  type IdentityId,
  type JsonObject,
  newId,
  type OAuthClientId,
  parseJson,
} from '@exponetdb/kernel'
import {
  type AuditActor,
  type AuditRequest,
  appendAudit,
  auditRequest,
  humanActor,
  SERVE_ACTOR,
  webClient,
} from '../audit.ts'
import type { AuthDeps } from '../deps.ts'
import { AuthError } from '../errors.ts'
import type { RequestMeta } from '../request.ts'
import type { SessionContext } from '../sessions.ts'
import type { DelegatedPrincipal } from './bearer.ts'
import { type ClientMetadata, validateClientMetadata } from './client-metadata.ts'
import {
  clientFingerprint,
  type OAuthClientRecord,
  readClient,
  readClientByExternalId,
} from './clients.ts'
import { OAuthError, rateLimited } from './errors.ts'
import {
  type FetchNetwork,
  fetchMetadataDocument,
  MetadataFetchError,
  parseMetadataUrl,
} from './fetch.ts'
import { addressBucket, GLOBAL_DCR_BUCKET, hit } from './limits.ts'

/**
 * The client registry (OD-5, oauth.md §3): CIMD clients added by an
 * administrator from an exact `client_id` URL, DCR registrations from the
 * deprecated compatibility endpoint, and the inline security decisions
 * (approve, reject, disable). Registration is never trust: every CIMD and
 * DCR client starts pending; an approval names the exact client and binds
 * the fingerprint that was reviewed; a changed fingerprint returns an
 * approved client to review and ends its grants.
 */
export interface RegistryDeps {
  readonly auth: AuthDeps
  readonly network: FetchNetwork
  readonly fetch?: { readonly timeoutMs?: number; readonly maxBytes?: number }
}

/** Who decides a registry change, as the audit records it. */
export interface Decider {
  readonly identityId: IdentityId
  readonly actor: AuditActor
  readonly client: NonNullable<Parameters<typeof appendAudit>[1]['client']>
}

export function sessionDecider(session: SessionContext): Decider {
  return {
    identityId: session.identityId,
    actor: humanActor(session, session.reauthAt),
    client: webClient(session.sessionId),
  }
}

/** A person through the first-party CLI (human-only registry actions without re-authentication). */
export function delegatedDecider(principal: DelegatedPrincipal): Decider {
  const credential = principal.delegation.credential
  return {
    identityId: principal.identityId,
    actor: { kind: 'human', identityId: principal.identityId, label: principal.label },
    client: {
      clientId: credential.type === 'access_token' ? credential.clientId : null,
      kind: 'cli',
      ...(credential.type === 'access_token' ? { grantId: credential.grantId } : {}),
    },
  }
}

interface FetchedClient {
  readonly metadata: ClientMetadata
  readonly fingerprint: string
  readonly cacheSeconds: number
}

function metadataInvalid(reason: string): AuthError {
  return new AuthError('CLIENT_METADATA_INVALID', { details: { reason } })
}

/** Fetches and validates the document of a CIMD `client_id` (throws `CLIENT_METADATA_INVALID`). */
export async function fetchClientMetadata(
  deps: RegistryDeps,
  clientId: string,
): Promise<FetchedClient> {
  const url = parseMetadataUrl(clientId)
  if (url === undefined) {
    throw metadataInvalid('url_invalid')
  }
  let text: string
  let maxAgeSeconds: number | undefined
  try {
    const fetched = await fetchMetadataDocument(clientId, deps.network, deps.fetch ?? {})
    text = fetched.text
    maxAgeSeconds = fetched.maxAgeSeconds
  } catch (error) {
    if (error instanceof MetadataFetchError) {
      throw metadataInvalid(error.reason)
    }
    throw error
  }
  const parsed = parseJson(text)
  if (!parsed.ok) {
    throw metadataInvalid('json_invalid')
  }
  const result = validateClientMetadata(parsed.value, clientId, url.hostname)
  if (!result.ok) {
    throw metadataInvalid(result.reason)
  }
  return {
    metadata: result.metadata,
    fingerprint: clientFingerprint({
      externalId: clientId,
      redirectUris: result.metadata.redirectUris,
      tokenEndpointAuthMethod: 'none',
      applicationType: result.metadata.applicationType,
      grantTypes: result.metadata.grantTypes,
      jwks: [],
    }),
    cacheSeconds: Math.min(
      Math.max(maxAgeSeconds ?? 3600, OAUTH_LIMITS.cimdCacheMinSeconds),
      OAUTH_LIMITS.cimdCacheMaxSeconds,
    ),
  }
}

function auditChanges(client: OAuthClientRecord, extra: JsonObject = {}): JsonObject {
  return {
    oauthClientId: client.clientId,
    registration: client.registration,
    kind: client.kind,
    fingerprint: client.metadataFingerprint,
    ...extra,
  }
}

async function auditClientEvent(
  tx: Tx,
  deps: AuthDeps,
  action: string,
  by: Decider | null,
  request: AuditRequest | undefined,
  client: OAuthClientRecord,
  extra: JsonObject = {},
  reason?: string,
): Promise<void> {
  await appendAudit(
    tx,
    {
      action,
      phase: 'completed',
      actor: by === null ? SERVE_ACTOR : by.actor,
      ...(by === null ? {} : { client: by.client }),
      changes: auditChanges(client, extra),
      result: { status: 'succeeded' },
      ...(request === undefined ? {} : { request }),
      ...(reason === undefined ? {} : { reason }),
    },
    deps.clock,
  )
}

/** An administrator adds a CIMD client by its exact URL: fetched, validated, recorded as pending. */
export async function registerCimdClient(
  deps: RegistryDeps,
  meta: RequestMeta,
  by: Decider,
  clientId: string,
): Promise<OAuthClientRecord> {
  if (parseMetadataUrl(clientId) === undefined) {
    throw metadataInvalid('url_invalid')
  }
  if ((await readClientByExternalId(deps.auth.store, clientId)) !== undefined) {
    throw new AuthError('CONFLICT')
  }
  const fetched = await fetchClientMetadata(deps, clientId)
  const request = await auditRequest(deps.auth.keys, meta)
  return deps.auth.store.transaction('oauth.client.register_cimd', async (tx) => {
    const id = newId('cli', deps.auth.clock.nowMs())
    await tx.query(
      'oauth.client.insert_cimd',
      `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                  application_type, token_endpoint_auth_method, grant_types, metadata,
                                  metadata_fingerprint, created_by_identity_id, created_at, state_changed_at,
                                  metadata_fetched_at, metadata_expires_at)
       VALUES ($1, $2, 'cimd', 'mcp', 'pending', $3, $4::text[], $5, 'none', $6::text[], $7::jsonb, $8, $9,
               clock_timestamp(), clock_timestamp(), clock_timestamp(),
               clock_timestamp() + make_interval(secs => $10::int))
       ON CONFLICT (external_id) DO NOTHING`,
      [
        id,
        clientId,
        fetched.metadata.clientName,
        fetched.metadata.redirectUris,
        fetched.metadata.applicationType,
        fetched.metadata.grantTypes,
        JSON.stringify(fetched.metadata.display),
        fetched.fingerprint,
        by.identityId,
        fetched.cacheSeconds,
      ],
    )
    const client = await readClient(tx, id)
    if (client === undefined) {
      throw new AuthError('CONFLICT')
    }
    await auditClientEvent(tx, deps.auth, 'oauth.client_registered', by, request, client)
    return client
  })
}

/**
 * Fetches a CIMD client's document again. A display change is applied in
 * place; a changed fingerprint returns an approved client to review (its
 * grants end in the same transaction) and is audited. `by` is null when
 * the authorization endpoint refreshes a stale cache.
 */
export async function refreshCimdClient(
  deps: RegistryDeps,
  clientId: OAuthClientId,
  by: Decider | null,
  meta?: RequestMeta,
): Promise<OAuthClientRecord> {
  const before = await readClient(deps.auth.store, clientId)
  if (before === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (before.registration !== 'cimd') {
    throw new AuthError('CONFLICT')
  }
  const fetched = await fetchClientMetadata(deps, before.externalId)
  const request = meta === undefined ? undefined : await auditRequest(deps.auth.keys, meta)
  return deps.auth.store.transaction('oauth.client.refresh', async (tx) => {
    const current = await readClient(tx, clientId, { forUpdate: true })
    if (current === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    const changed = fetched.fingerprint !== current.metadataFingerprint
    const backToReview = changed && current.state === 'active'
    await tx.query(
      'oauth.client.update_metadata',
      `UPDATE oauth.clients
          SET display_name = $2, redirect_uris = $3::text[], application_type = $4, grant_types = $5::text[],
              metadata = $6::jsonb, metadata_fingerprint = $7, metadata_fetched_at = clock_timestamp(),
              metadata_expires_at = clock_timestamp() + make_interval(secs => $8::int),
              state = CASE WHEN $9 THEN 'pending' ELSE state END
        WHERE client_id = $1`,
      [
        clientId,
        fetched.metadata.clientName,
        fetched.metadata.redirectUris,
        fetched.metadata.applicationType,
        fetched.metadata.grantTypes,
        JSON.stringify(fetched.metadata.display),
        fetched.fingerprint,
        fetched.cacheSeconds,
        backToReview,
      ],
    )
    const after = await readClient(tx, clientId)
    if (after === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    if (changed) {
      await auditClientEvent(tx, deps.auth, 'oauth.client_metadata_changed', by, request, after, {
        previousFingerprint: current.metadataFingerprint,
        returnedToReview: backToReview,
      })
    }
    return after
  })
}

/** The authorization endpoint's refresher of stale CIMD caches: refuses (undefined) when the fetch fails. */
export function cimdRefresher(deps: RegistryDeps) {
  return {
    async refresh(client: OAuthClientRecord): Promise<OAuthClientRecord | undefined> {
      try {
        return await refreshCimdClient(deps, client.clientId, null)
      } catch (error) {
        if (error instanceof AuthError && error.code === 'CLIENT_METADATA_INVALID') {
          return undefined
        }
        throw error
      }
    },
  }
}

/**
 * Approves exactly this client with the fingerprint the administrator
 * reviewed (`PLAN_STALE` when it changed meanwhile). An expired DCR
 * registration cannot be approved.
 */
export async function approveClient(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  by: Decider,
  clientId: OAuthClientId,
  fingerprint: string,
): Promise<OAuthClientRecord> {
  const client = await readClient(tx, clientId, { forUpdate: true })
  if (client === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (client.state === 'active') {
    throw new AuthError('CONFLICT')
  }
  if (client.metadataFingerprint !== fingerprint) {
    throw new AuthError('PLAN_STALE')
  }
  const { rows } = await tx.query(
    'oauth.client.approvable',
    `SELECT (pending_expires_at IS NULL OR pending_expires_at > clock_timestamp()) AS live
       FROM oauth.clients WHERE client_id = $1`,
    [clientId],
  )
  if (rows[0]?.bool('live') !== true) {
    throw new AuthError('CONFLICT')
  }
  await tx.query(
    'oauth.client.approve',
    `UPDATE oauth.clients SET state = 'active', approved_fingerprint = metadata_fingerprint,
            approved_by_identity_id = $2
      WHERE client_id = $1`,
    [clientId, by.identityId],
  )
  const after = await readClient(tx, clientId)
  if (after === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  await auditClientEvent(
    tx,
    deps,
    'oauth.client_approved',
    by,
    await auditRequest(deps.keys, meta),
    after,
    { previousState: client.state },
  )
  return after
}

async function changeState(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  by: Decider,
  clientId: OAuthClientId,
  from: OAuthClientRecord['state'],
  to: 'rejected' | 'disabled',
  reason: string | undefined,
): Promise<OAuthClientRecord> {
  const client = await readClient(tx, clientId, { forUpdate: true })
  if (client === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (client.state !== from) {
    throw new AuthError('CONFLICT')
  }
  await tx.query('oauth.client.state', 'UPDATE oauth.clients SET state = $2 WHERE client_id = $1', [
    clientId,
    to,
  ])
  const after = await readClient(tx, clientId)
  if (after === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  await auditClientEvent(
    tx,
    deps,
    to === 'rejected' ? 'oauth.client_rejected' : 'oauth.client_disabled',
    by,
    await auditRequest(deps.keys, meta),
    after,
    {},
    reason,
  )
  return after
}

export function rejectClient(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  by: Decider,
  clientId: OAuthClientId,
  reason: string | undefined,
): Promise<OAuthClientRecord> {
  return changeState(tx, deps, meta, by, clientId, 'pending', 'rejected', reason)
}

/** Disables an active client: every grant and token of it ends in the same transaction. */
export function disableClient(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  by: Decider,
  clientId: OAuthClientId,
  reason: string | undefined,
): Promise<OAuthClientRecord> {
  return changeState(tx, deps, meta, by, clientId, 'active', 'disabled', reason)
}

// ----- Dynamic Client Registration (RFC 7591, compatibility only) -----

const DCR_LOCK = { key1: EXDB_LOCK_NAMESPACE, key2: lockKey2('oauth/dcr') } as const

/**
 * POST /oauth/register. Deprecated by MCP 2026-07-28 and kept for older
 * clients: the registration is a **pending** public client (`none`, no
 * secret, no registration access token) that nothing can use until an
 * administrator approves exactly it. Bounded on every axis: 16 KiB of
 * JSON, strict metadata, 10 registrations per address and hour, 100 per
 * hour in total, at most 50 pending at a time, each pending one expires
 * after 7 days. The requester is kept only as a keyed pseudonym.
 */
export async function registerDcrClient(
  deps: AuthDeps,
  meta: RequestMeta,
  request: { readonly body: string | undefined; readonly contentType: string | undefined },
): Promise<ClientRegistrationResponse> {
  const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json' || request.body === undefined) {
    throw new OAuthError('invalid_client_metadata', {
      description: 'The registration must be a JSON object of at most 16 KiB.',
    })
  }
  for (const bucket of [
    await addressBucket(deps.keys, 'dcr-ip', meta.clientIp),
    GLOBAL_DCR_BUCKET,
  ]) {
    const wait = await hit(deps.store, bucket)
    if (wait > 0) {
      throw rateLimited(wait)
    }
  }
  const parsed = parseJson(request.body)
  if (!parsed.ok) {
    throw new OAuthError('invalid_client_metadata', { description: 'The body is not valid JSON.' })
  }
  const result = validateClientMetadata(parsed.value, undefined, 'Unnamed client')
  if (!result.ok) {
    throw new OAuthError(
      result.reason === 'redirect_uris_invalid'
        ? 'invalid_redirect_uri'
        : 'invalid_client_metadata',
      { description: `Refused: ${result.reason}.` },
    )
  }
  const metadata = result.metadata
  const externalId = `exdb-dcr-${randomBytes(32).toString('base64url')}`
  const pseudonymizer = await deps.keys.pseudonymizer()
  const requesterHash = pseudonymizer.pseudonym('ip', meta.clientIp ?? 'unknown')
  const audit = await auditRequest(deps.keys, meta)
  return deps.store.transaction('oauth.dcr.register', async (tx) => {
    await tx.query('oauth.dcr.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      DCR_LOCK.key1,
      DCR_LOCK.key2,
    ])
    const pending = await tx.query(
      'oauth.dcr.pending',
      `SELECT count(*)::int AS n FROM oauth.clients
        WHERE registration = 'dcr' AND state = 'pending' AND pending_expires_at > clock_timestamp()`,
    )
    if ((pending.rows[0]?.int('n') ?? 0) >= OAUTH_LIMITS.dcrMaxPending) {
      throw rateLimited(3600)
    }
    const id = newId('cli', deps.clock.nowMs())
    const fingerprint = clientFingerprint({
      externalId,
      redirectUris: metadata.redirectUris,
      tokenEndpointAuthMethod: 'none',
      applicationType: metadata.applicationType,
      grantTypes: metadata.grantTypes,
      jwks: [],
    })
    const { rows } = await tx.query(
      'oauth.dcr.insert',
      `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                  application_type, token_endpoint_auth_method, grant_types, metadata,
                                  metadata_fingerprint, requester_hash, created_at, state_changed_at)
       VALUES ($1, $2, 'dcr', 'mcp', 'pending', $3, $4::text[], $5, 'none', $6::text[], $7::jsonb, $8, $9,
               clock_timestamp(), clock_timestamp())
       RETURNING floor(extract(epoch FROM created_at))::bigint AS issued_at`,
      [
        id,
        externalId,
        metadata.clientName,
        metadata.redirectUris,
        metadata.applicationType,
        metadata.grantTypes,
        JSON.stringify(metadata.display),
        fingerprint,
        requesterHash,
      ],
    )
    const client = await readClient(tx, id)
    if (client === undefined) {
      throw new OAuthError('server_error')
    }
    await auditClientEvent(tx, deps, 'oauth.client_registered', null, audit, client)
    return {
      client_id: externalId,
      client_id_issued_at: rows[0]?.int('issued_at') ?? 0,
      client_name: metadata.clientName,
      redirect_uris: [...metadata.redirectUris],
      grant_types: [...metadata.grantTypes],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: metadata.applicationType,
    }
  })
}
