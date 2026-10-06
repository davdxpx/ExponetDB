import {
  type ApiKeyView,
  type GrantRestrictions,
  isScopeGrantableTo,
  isWriteScope,
  OAUTH_LIMITS,
  type OAuthClientView,
  type PublicJwk,
  type Scope,
  type ServiceAccountView,
  scopeDefinition,
} from '@exponetdb/contracts'
import { ControlStoreError, type Queryable, type Row, type Tx } from '@exponetdb/control-store'
import {
  type ApiKeyId,
  type GrantId,
  type IdentityId,
  isId,
  newId,
  type OAuthClientId,
} from '@exponetdb/kernel'
import { importJWK } from 'jose'
import { type AuditRequest, appendAudit, humanActor, labelOf, webClient } from '../audit.ts'
import { holds, loadGrants } from '../authorization/scope.ts'
import type { AuthDeps } from '../deps.ts'
import { AuthError } from '../errors.ts'
import type { SessionContext } from '../sessions.ts'
import { newToken, tokenHash } from '../tokens.ts'
import {
  CLIENT_COLUMNS,
  clientFingerprint,
  clientFromRow,
  clientView,
  type OAuthClientRecord,
  readClient,
} from './clients.ts'
import { OAuthError } from './errors.ts'
import {
  insertGrant,
  listGrantViews,
  readGrant,
  restrictionsOf,
  revokeGrant,
  scopesOf,
  textArrayOrNull,
} from './grants.ts'
import { resourceOf } from './metadata.ts'
import { type ProtocolParams, parseScopeParam } from './params.ts'
import { type GrantOutcome, issueTokens } from './token.ts'

/**
 * Service accounts (identity.md §5, oauth.md §6): a `service` identity with
 * a responsible person, created by an administrator (never self-registered),
 * with no password, factor, session or link and no role of its own (roles
 * come through the access plans like everyone's, never `owner`). It reaches
 * the REST API only, as client kind `ci`:
 *
 * - an OAuth client of its own (`private_key_jwt` with inline public keys,
 *   no `jwks_uri`, no secret) that obtains 10-minute access tokens with
 *   `client_credentials` from one active **machine grant** (scopes,
 *   restrictions, at most 365 days);
 * - or API keys (`exak_…`, shown once, stored as a hash, mandatory expiry of
 *   at most 365 days, revocable, last use recorded coarsely).
 *
 * Every change is an inline security change with a fresh re-authentication
 * (the engine requires it). A person grants only what they hold themselves
 * (non-escalation); a scope the client kind `ci` may not hold is refused;
 * production write authority needs an explicit acknowledgement.
 */
async function auditEvent(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  action: string,
  changes: Record<string, string | number | boolean | null | string[]>,
  reason?: string,
): Promise<void> {
  await appendAudit(
    tx,
    {
      action,
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      changes,
      result: { status: 'succeeded' },
      request,
      ...(reason === undefined ? {} : { reason }),
    },
    deps.clock,
  )
}

// ----- service accounts -----

async function readServiceIdentity(
  q: Queryable,
  identityId: IdentityId,
  options: { readonly forUpdate?: boolean } = {},
): Promise<
  | { readonly state: string; readonly labelNumber: number; readonly displayName: string | null }
  | undefined
> {
  const { rows } = await q.query(
    'oauth.service.identity',
    `SELECT i.state, i.label_number, i.display_name FROM auth.identities i
       JOIN oauth.service_accounts s ON s.identity_id = i.identity_id
      WHERE i.identity_id = $1 AND i.kind = 'service'${options.forUpdate === true ? ' FOR SHARE OF i' : ''}`,
    [identityId],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : {
        state: row.text('state'),
        labelNumber: row.int('label_number'),
        displayName: row.textOrNull('display_name'),
      }
}

async function activeServiceIdentity(q: Queryable, identityId: IdentityId) {
  const identity = await readServiceIdentity(q, identityId, { forUpdate: true })
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (identity.state !== 'active') {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  return identity
}

export async function createServiceAccount(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  input: { readonly displayName: string; readonly responsibleIdentityId?: IdentityId | undefined },
): Promise<IdentityId> {
  const responsible = input.responsibleIdentityId ?? session.identityId
  const { rows } = await tx.query(
    'oauth.service.responsible',
    `SELECT 1 FROM auth.identities WHERE identity_id = $1 AND kind = 'human' AND state = 'active' FOR SHARE`,
    [responsible],
  )
  if (rows.length === 0) {
    throw new AuthError('NOT_FOUND')
  }
  const identityId = newId('idn', deps.clock.nowMs())
  await tx.query(
    'oauth.service.identity_insert',
    `INSERT INTO auth.identities (identity_id, kind, state, display_name) VALUES ($1, 'service', 'invited', $2)`,
    [identityId, input.displayName],
  )
  // No enrollment: a service identity is active from the start and has no factor.
  await tx.query(
    'oauth.service.identity_activate',
    `UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`,
    [identityId],
  )
  await tx.query(
    'oauth.service.insert',
    `INSERT INTO oauth.service_accounts (identity_id, responsible_identity_id, created_by_identity_id, created_at)
     VALUES ($1, $2, $3, clock_timestamp())`,
    [identityId, responsible, session.identityId],
  )
  await auditEvent(tx, deps, session, request, 'service_account.created', {
    identityId,
    responsibleIdentityId: responsible,
  })
  return identityId
}

// ----- the service-account client and its keys -----

function modulusBits(n: string): number {
  const bytes = Buffer.from(n, 'base64url')
  let first = 0
  while (first < bytes.length && bytes[first] === 0) first++
  const top = bytes[first] ?? 0
  return (bytes.length - first - 1) * 8 + (top === 0 ? 0 : Math.floor(Math.log2(top)) + 1)
}

/** Public keys that `jose` can import for an allowed algorithm; RSA of at least 2048 bits. */
export async function checkKeys(keys: readonly PublicJwk[]): Promise<void> {
  if (
    keys.length === 0 ||
    keys.length > OAUTH_LIMITS.maxJwksKeys ||
    new Set(keys.map((k) => k.kid)).size !== keys.length
  ) {
    throw new AuthError('VALIDATION_FAILED')
  }
  for (const key of keys) {
    const alg =
      key.alg ??
      (key.kty === 'EC'
        ? key.crv === 'P-256'
          ? 'ES256'
          : 'ES384'
        : key.kty === 'OKP'
          ? 'EdDSA'
          : 'PS256')
    if (key.kty === 'RSA' && modulusBits(key.n) < 2048) {
      throw new AuthError('VALIDATION_FAILED')
    }
    try {
      const { kid: _kid, alg: _alg, use: _use, ...material } = key
      await importJWK({ ...material }, alg)
    } catch {
      throw new AuthError('VALIDATION_FAILED')
    }
  }
}

function serviceFingerprint(clientId: OAuthClientId, keys: readonly PublicJwk[]): string {
  return clientFingerprint({
    externalId: clientId,
    redirectUris: [],
    tokenEndpointAuthMethod: 'private_key_jwt',
    applicationType: null,
    grantTypes: ['client_credentials'],
    jwks: keys,
  })
}

export async function registerServiceClient(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
  keys: readonly PublicJwk[],
): Promise<OAuthClientRecord> {
  const identity = await activeServiceIdentity(tx, identityId)
  await checkKeys(keys)
  const clientId = newId('cli', deps.clock.nowMs())
  const fingerprint = serviceFingerprint(clientId, keys)
  try {
    await tx.savepoint((inner) =>
      inner.query(
        'oauth.service.client_insert',
        `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                    token_endpoint_auth_method, grant_types, metadata_fingerprint,
                                    approved_fingerprint, approved_by_identity_id, service_identity_id, jwks,
                                    created_by_identity_id, created_at, state_changed_at)
         VALUES ($1, $1, 'pre_registered', 'ci', 'active', $2, '{}', 'private_key_jwt', ARRAY['client_credentials'],
                 $3, $3, $4, $5, $6::jsonb, $4, clock_timestamp(), clock_timestamp())`,
        [
          clientId,
          (identity.displayName ?? labelOf('service', identity.labelNumber)).slice(0, 100),
          fingerprint,
          session.identityId,
          identityId,
          JSON.stringify({ keys }),
        ],
      ),
    )
  } catch (error) {
    // One client per service account.
    if (error instanceof ControlStoreError && error.sqlstate === '23505') {
      throw new AuthError('CONFLICT')
    }
    throw error
  }
  const client = await readClient(tx, clientId)
  if (client === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  await auditEvent(tx, deps, session, request, 'oauth.client_registered', {
    oauthClientId: clientId,
    registration: 'pre_registered',
    kind: 'ci',
    fingerprint,
    serviceAccountId: identityId,
  })
  return client
}

async function serviceClientOf(q: Queryable, identityId: IdentityId, forUpdate = false) {
  const { rows } = await q.query(
    'oauth.service.client',
    `SELECT ${CLIENT_COLUMNS} FROM oauth.clients c WHERE c.service_identity_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [identityId],
  )
  const row = rows[0]
  return row === undefined ? undefined : clientFromRow(row)
}

/** Replaces the client's keys; the new fingerprint is approved in the same change (no grant ends). */
export async function replaceServiceClientKeys(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
  keys: readonly PublicJwk[],
): Promise<OAuthClientRecord> {
  await activeServiceIdentity(tx, identityId)
  await checkKeys(keys)
  const client = await serviceClientOf(tx, identityId, true)
  if (client === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (client.state !== 'active') {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  const fingerprint = serviceFingerprint(client.clientId, keys)
  if (fingerprint !== client.metadataFingerprint) {
    await tx.query(
      'oauth.service.keys',
      `UPDATE oauth.clients SET jwks = $2::jsonb, metadata_fingerprint = $3, approved_fingerprint = $3,
              approved_by_identity_id = $4
        WHERE client_id = $1`,
      [client.clientId, JSON.stringify({ keys }), fingerprint, session.identityId],
    )
    await auditEvent(tx, deps, session, request, 'oauth.client_keys_replaced', {
      oauthClientId: client.clientId,
      previousFingerprint: client.metadataFingerprint,
      fingerprint,
      serviceAccountId: identityId,
    })
  }
  const after = await readClient(tx, client.clientId)
  if (after === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  return after
}

// ----- machine authority: grants and API keys -----

export interface MachineAuthority {
  readonly scopes: readonly Scope[]
  readonly restrictions: GrantRestrictions
  readonly acknowledgeProductionWrite?: true | undefined
}

/**
 * The authority a person may give a service account: scopes a `ci` client
 * may hold, whose permissions the person holds now (non-escalation), tiered
 * scopes within the tier restriction, and an explicit acknowledgement for
 * production write authority.
 */
async function checkMachineAuthority(
  q: Queryable,
  session: SessionContext,
  authority: MachineAuthority,
): Promise<void> {
  const { scopes, restrictions } = authority
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw new AuthError('VALIDATION_FAILED')
  }
  const grants = await loadGrants(q, session.identityId)
  const refused = scopes.filter((scope) => {
    const permission = scopeDefinition(scope).permission
    return !isScopeGrantableTo(scope, 'ci') || permission === null || !holds(grants, permission)
  })
  if (refused.length > 0) {
    throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: refused.slice(0, 64) } })
  }
  for (const scope of scopes) {
    const tier = scopeDefinition(scope).tier
    if (tier !== null && !restrictions.tiers.includes(tier)) {
      throw new AuthError('VALIDATION_FAILED')
    }
  }
  const productionWrite =
    restrictions.tiers.includes('prod') &&
    scopes.some((s) => isWriteScope(s) && scopeDefinition(s).tier !== 'nonprod')
  if (productionWrite && authority.acknowledgeProductionWrite !== true) {
    throw new AuthError('PRODUCTION_CONFIRMATION_REQUIRED')
  }
}

function authorityChanges(authority: MachineAuthority, days: number) {
  return {
    scopes: [...authority.scopes],
    tiers: [...authority.restrictions.tiers],
    targets:
      authority.restrictions.targets.kind === 'all'
        ? 'all'
        : `list:${authority.restrictions.targets.targetIds.length}`,
    lifetimeDays: days,
  }
}

/** The single active machine grant of the service client; an existing one is replaced. */
export async function createMachineGrant(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
  authority: MachineAuthority & { readonly lifetimeDays: number },
): Promise<GrantId> {
  await activeServiceIdentity(tx, identityId)
  const client = await serviceClientOf(tx, identityId, true)
  if (client === undefined || client.state !== 'active') {
    throw new AuthError('NOT_FOUND')
  }
  await checkMachineAuthority(tx, session, authority)
  const { rows } = await tx.query(
    'oauth.service.active_grant',
    `SELECT grant_id FROM oauth.grants WHERE client_id = $1 AND kind = 'machine' AND state = 'active' FOR UPDATE`,
    [client.clientId],
  )
  for (const row of rows) {
    const old = row.text('grant_id')
    if (isId('grt', old)) {
      await revokeGrant(tx, old, 'replaced', session.identityId)
    }
  }
  const grantId = await insertGrant(tx, deps.clock.nowMs(), {
    kind: 'machine',
    identityId,
    clientId: client.clientId,
    resource: 'api',
    scopes: authority.scopes,
    restrictions: authority.restrictions,
    createdBy: session.identityId,
    reauthEventId: session.reauthEventId,
    lifetimeDays: authority.lifetimeDays,
  }).catch((error: unknown) => {
    if (error instanceof ControlStoreError && error.sqlstate === 'EXO03') {
      throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: [] } })
    }
    throw error
  })
  await appendAudit(
    tx,
    {
      action: 'oauth.grant_created',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      changes: {
        kind: 'machine',
        grantId,
        oauthClientId: client.clientId,
        serviceAccountId: identityId,
        resource: 'api',
        ...authorityChanges(authority, authority.lifetimeDays),
      },
      result: { status: 'succeeded' },
      request,
    },
    deps.clock,
  )
  return grantId
}

export async function createApiKey(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
  authority: MachineAuthority & {
    readonly lifetimeDays: number
    readonly label?: string | undefined
  },
): Promise<{ readonly keyId: ApiKeyId; readonly secret: string }> {
  await activeServiceIdentity(tx, identityId)
  await checkMachineAuthority(tx, session, authority)
  const keyId = newId('key', deps.clock.nowMs())
  const secret = newToken('apiKey')
  try {
    await tx.savepoint((inner) =>
      inner.query(
        'oauth.api_key.insert',
        `INSERT INTO oauth.api_keys (key_id, identity_id, key_hash, label, scopes, tiers, target_ids,
                                     created_by_identity_id, reauth_event_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::text[], $8, $9, clock_timestamp(),
                 clock_timestamp() + make_interval(days => $10::int))`,
        [
          keyId,
          identityId,
          tokenHash('apiKey', secret),
          authority.label ?? null,
          authority.scopes,
          authority.restrictions.tiers,
          authority.restrictions.targets.kind === 'all'
            ? null
            : authority.restrictions.targets.targetIds,
          session.identityId,
          session.reauthEventId,
          authority.lifetimeDays,
        ],
      ),
    )
  } catch (error) {
    if (error instanceof ControlStoreError && error.sqlstate === 'EXO09') {
      throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: [] } })
    }
    throw error
  }
  await auditEvent(tx, deps, session, request, 'api_key.created', {
    apiKeyId: keyId,
    serviceAccountId: identityId,
    ...authorityChanges(authority, authority.lifetimeDays),
  })
  return { keyId, secret }
}

export async function revokeApiKey(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  keyId: ApiKeyId,
  reason: string | undefined,
): Promise<boolean> {
  const { rows } = await tx.query(
    'oauth.api_key.revoke',
    `UPDATE oauth.api_keys SET revoked_at = clock_timestamp(), revoke_reason = 'administrator',
            revoked_by_identity_id = $2
      WHERE key_id = $1 AND revoked_at IS NULL
      RETURNING identity_id`,
    [keyId, session.identityId],
  )
  const exists = await tx.query(
    'oauth.api_key.exists',
    'SELECT 1 FROM oauth.api_keys WHERE key_id = $1',
    [keyId],
  )
  if (exists.rows.length === 0) {
    throw new AuthError('NOT_FOUND')
  }
  const row = rows[0]
  if (row === undefined) {
    return false
  }
  await auditEvent(
    tx,
    deps,
    session,
    request,
    'api_key.revoked',
    { apiKeyId: keyId, serviceAccountId: row.text('identity_id') },
    reason,
  )
  return true
}

// ----- client credentials (RFC 6749 §4.4, REST API only) -----

/** The token endpoint's `client_credentials` grant: an access token from the client's one active machine grant. */
export async function clientCredentialsGrant(
  tx: Tx,
  client: OAuthClientRecord,
  params: ProtocolParams,
  issuer: string,
): Promise<GrantOutcome> {
  const failed = (error: OAuthError): GrantOutcome => ({ ok: false, error })
  if (
    client.registration !== 'pre_registered' ||
    client.kind !== 'ci' ||
    client.tokenEndpointAuthMethod !== 'private_key_jwt'
  ) {
    return failed(new OAuthError('unauthorized_client'))
  }
  if (params.has('resource') && resourceOf(issuer, params.get('resource')) !== 'api') {
    return failed(new OAuthError('invalid_target'))
  }
  const { rows } = await tx.query(
    'oauth.client_credentials.grant',
    `SELECT grant_id FROM oauth.grants
      WHERE client_id = $1 AND kind = 'machine' AND state = 'active' AND expires_at > clock_timestamp()`,
    [client.clientId],
  )
  const grantId = rows[0]?.text('grant_id')
  const grant =
    grantId !== undefined && isId('grt', grantId)
      ? await readGrant(tx, grantId, { forUpdate: true })
      : undefined
  if (grant === undefined || !grant.live) {
    return failed(
      new OAuthError('unauthorized_client', {
        description: 'The service account has no active grant.',
      }),
    )
  }
  let scopes: readonly Scope[] = grant.scopes
  if (params.has('scope')) {
    const narrowed = parseScopeParam(params.get('scope'))
    if (narrowed === undefined || !narrowed.every((s) => grant.scopes.includes(s))) {
      return failed(new OAuthError('invalid_scope'))
    }
    scopes = narrowed
  }
  return { ok: true, response: await issueTokens(tx, grant, client, scopes, { issue: false }) }
}

// ----- views -----

function apiKeyFromRow(row: Row): ApiKeyView {
  const keyId = row.text('key_id')
  const identityId = row.text('identity_id')
  const createdBy = row.text('created_by_identity_id')
  if (!isId('key', keyId) || !isId('idn', identityId) || !isId('idn', createdBy)) {
    throw new Error('api key row has an invalid id')
  }
  const state = row.text('key_state')
  return {
    id: keyId,
    serviceAccountId: identityId,
    label: row.textOrNull('label'),
    scopes: scopesOf(row.textArray('scopes')),
    restrictions: restrictionsOf(row.textArray('tiers'), textArrayOrNull(row, 'target_ids')),
    createdAt: row.text('key_created_at'),
    createdBy,
    expiresAt: row.text('key_expires_at'),
    lastUsedAt: row.textOrNull('key_last_used_at'),
    revokedAt: row.textOrNull('key_revoked_at'),
    state: state === 'revoked' ? 'revoked' : state === 'expired' ? 'expired' : 'active',
  }
}

const ts = (expr: string, alias: string) =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

/** API keys as views, newest first; never the key or its hash. */
export async function listApiKeys(
  q: Queryable,
  filter: { readonly identityId?: IdentityId; readonly limit: number },
): Promise<ApiKeyView[]> {
  const { rows } = await q.query(
    'oauth.api_key.list',
    `SELECT k.key_id, k.identity_id, k.label, k.scopes, k.tiers, k.target_ids, k.created_by_identity_id,
            ${ts('k.created_at', 'key_created_at')}, ${ts('k.expires_at', 'key_expires_at')},
            ${ts('k.last_used_at', 'key_last_used_at')}, ${ts('k.revoked_at', 'key_revoked_at')},
            CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN k.expires_at <= clock_timestamp() THEN 'expired' ELSE 'active' END AS key_state
       FROM oauth.api_keys k
      WHERE ($1::text IS NULL OR k.identity_id = $1)
      ORDER BY k.created_at DESC, k.key_id DESC
      LIMIT $2`,
    [filter.identityId ?? null, filter.limit],
  )
  return rows.map(apiKeyFromRow)
}

export async function serviceAccountViews(
  q: Queryable,
  issuer: string,
  filter: { readonly identityId?: IdentityId; readonly limit: number },
): Promise<ServiceAccountView[]> {
  const { rows } = await q.query(
    'oauth.service.list',
    `SELECT i.identity_id, i.label_number, i.display_name, i.state, s.responsible_identity_id,
            s.created_by_identity_id, ${ts('s.created_at', 'service_created_at')}
       FROM oauth.service_accounts s JOIN auth.identities i ON i.identity_id = s.identity_id
      WHERE ($1::text IS NULL OR s.identity_id = $1)
      ORDER BY s.created_at DESC, s.identity_id DESC
      LIMIT $2`,
    [filter.identityId ?? null, filter.limit],
  )
  const out: ServiceAccountView[] = []
  for (const row of rows) {
    const identityId = row.text('identity_id')
    const responsible = row.text('responsible_identity_id')
    const createdBy = row.text('created_by_identity_id')
    const state = row.text('state')
    if (!isId('idn', identityId) || !isId('idn', responsible) || !isId('idn', createdBy)) {
      continue
    }
    const client = await serviceClientOf(q, identityId)
    const clientViewValue: OAuthClientView | null = client === undefined ? null : clientView(client)
    out.push({
      id: identityId,
      label: labelOf('service', row.int('label_number')),
      displayName: row.textOrNull('display_name'),
      state: state === 'active' || state === 'disabled' || state === 'erased' ? state : 'invited',
      responsibleIdentityId: responsible,
      createdBy,
      createdAt: row.text('service_created_at'),
      client: clientViewValue,
      apiKeys: await listApiKeys(q, { identityId, limit: 100 }),
      grants: await listGrantViews(q, issuer, { identityId, limit: 100 }),
    })
  }
  return out
}
