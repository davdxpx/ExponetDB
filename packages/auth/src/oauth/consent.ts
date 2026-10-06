import {
  type ClientKind,
  type ConsentView,
  type GrantRestrictions,
  isScopeGrantableTo,
  isWriteScope,
  OAUTH_LIMITS,
  type OAuthResource,
  type Scope,
  scopeDefinition,
  type Tier,
} from '@exponetdb/contracts'
import { ControlStoreError, type Queryable, type Tx } from '@exponetdb/control-store'
import { appendAudit, auditRequest, humanActor } from '../audit.ts'
import { freshProof } from '../authorization/engine.ts'
import { holds, loadGrants } from '../authorization/scope.ts'
import type { AuthDeps } from '../deps.ts'
import { AuthError } from '../errors.ts'
import type { RequestMeta } from '../request.ts'
import type { SessionContext } from '../sessions.ts'
import { newToken, parseToken, safeEqual, tokenHash } from '../tokens.ts'
import {
  CLIENT_COLUMNS,
  clientFromRow,
  clientSummary,
  isLookalike,
  type OAuthClientRecord,
  parseRedirectUri,
  redirectHost,
} from './clients.ts'
import { type GrantRecord, insertGrant, scopesOf } from './grants.ts'
import { resourceUri } from './metadata.ts'

/**
 * Consent (oauth.md §4): the person decides in a Web App session what a
 * client may do on their behalf. Everything is decided again when the
 * decision is submitted, in one transaction with the grant and the code:
 *
 * - the request is live, undecided and was started in this browser (the
 *   binding cookie); the client is still active with the fingerprint the
 *   request was made against;
 * - each chosen scope was requested, may ever be held by this client kind
 *   (MCP-ineligible and session-only scopes never), and its permission is
 *   held now by the person's live role bindings (an identity never
 *   delegates more than it holds);
 * - production (a `prod` tier in the restriction) needs an explicit
 *   acknowledgement, and production write or human-only change authority a
 *   passkey or TOTP re-authentication of this session at most 5 minutes old;
 *   which scopes write comes from the action contracts, never from names;
 * - the lifetime is at most 90 days (default 30); the target restriction is
 *   "all targets the bindings reach" until the registry exists (Wave 4).
 */
export const CONSENT_REAUTH_SECONDS = 300

export interface PendingAuthorization {
  readonly requestId: number
  readonly client: OAuthClientRecord
  readonly redirectUri: string
  readonly scopes: readonly Scope[]
  readonly resource: OAuthResource
  readonly codeChallenge: string
  readonly state: string
  readonly expiresAt: string
}

const invalid = () => new AuthError('AUTHORIZATION_REQUEST_INVALID')

export async function loadPendingAuthorization(
  q: Queryable,
  handle: string,
  bindingCookie: string | undefined,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PendingAuthorization> {
  const token = parseToken('request', handle)
  const binding = parseToken('binding', bindingCookie)
  if (token === undefined || binding === undefined) {
    throw invalid()
  }
  const { rows } = await q.query(
    'oauth.consent.request',
    `SELECT r.request_id, r.binding_hash, r.client_fingerprint, r.redirect_uri, r.scopes, r.resource,
            r.code_challenge, r.state AS request_state, r.decision,
            to_char(r.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS request_expires_at,
            (r.expires_at > clock_timestamp()) AS request_live, ${CLIENT_COLUMNS}
       FROM oauth.authorization_requests r JOIN oauth.clients c ON c.client_id = r.client_id
      WHERE r.handle_hash = $1${options.forUpdate === true ? ' FOR UPDATE OF r' : ''}`,
    [tokenHash('request', token)],
  )
  const row = rows[0]
  if (
    row === undefined ||
    !safeEqual(row.text('binding_hash'), tokenHash('binding', binding)) ||
    row.textOrNull('decision') !== null ||
    !row.bool('request_live')
  ) {
    throw invalid()
  }
  const client = clientFromRow(row)
  if (client.state !== 'active' || client.metadataFingerprint !== row.text('client_fingerprint')) {
    throw new AuthError('CLIENT_NOT_APPROVED')
  }
  return {
    requestId: row.int('request_id'),
    client,
    redirectUri: row.text('redirect_uri'),
    scopes: scopesOf(row.textArray('scopes')),
    resource: row.text('resource') === 'mcp' ? 'mcp' : 'api',
    codeChallenge: row.text('code_challenge'),
    state: row.text('request_state'),
    expiresAt: row.text('request_expires_at'),
  }
}

/** Whether each scope can be delegated by this person to this client kind now. */
export async function scopeOffers(
  q: Queryable,
  session: SessionContext,
  kind: ClientKind,
  scopes: readonly Scope[],
): Promise<ConsentView['scopes']> {
  const grants = await loadGrants(q, session.identityId)
  return scopes.map((scope) => {
    const def = scopeDefinition(scope)
    const grantable = isScopeGrantableTo(scope, kind)
    const held = def.permission !== null && holds(grants, def.permission)
    return {
      scope,
      available: grantable && held,
      reason: !grantable ? 'not_grantable' : !held ? 'not_held' : null,
      write: isWriteScope(scope),
      tier: def.tier,
      explicitConsent: def.explicitConsent,
      humanOnly: def.humanOnly,
    }
  })
}

/** Third-party (MCP) clients start at non-production; the first-party CLI at both tiers. */
export function defaultRestrictions(kind: ClientKind): GrantRestrictions {
  return { tiers: kind === 'mcp' ? ['nonprod'] : ['nonprod', 'prod'], targets: { kind: 'all' } }
}

export function consentClient(client: OAuthClientRecord, redirectUri: string | null) {
  return {
    ...clientSummary(client),
    redirectHost: redirectUri === null ? null : redirectHost(redirectUri),
    loopbackRedirect: redirectUri !== null && parseRedirectUri(redirectUri)?.loopback === true,
    lookalike: isLookalike(client),
  }
}

export async function consentView(
  deps: AuthDeps,
  session: SessionContext,
  handle: string,
  bindingCookie: string | undefined,
): Promise<ConsentView> {
  const pending = await loadPendingAuthorization(deps.store, handle, bindingCookie)
  return {
    kind: 'authorization_code',
    client: consentClient(pending.client, pending.redirectUri),
    resource: pending.resource,
    resourceUri: resourceUri(deps.config.publicOrigin, pending.resource),
    scopes: await scopeOffers(deps.store, session, pending.client.kind, pending.scopes),
    defaults: defaultRestrictions(pending.client.kind),
    lifetimeDays: { default: OAUTH_LIMITS.grantDefaultDays, max: OAUTH_LIMITS.grantMaxDays },
    reauth: {
      fresh: freshProof(
        { kind: 'human', identityId: session.identityId, client: 'web', session },
        CONSENT_REAUTH_SECONDS,
      ),
      withinSeconds: CONSENT_REAUTH_SECONDS,
    },
    expiresAt: pending.expiresAt,
  }
}

export interface DelegationChoice {
  readonly scopes: readonly Scope[]
  readonly tiers: readonly Tier[]
  readonly lifetimeDays: number
  readonly acknowledgeProduction?: true | undefined
}

/**
 * Checks a person's choice against what was requested and what they hold
 * now; returns the restrictions and the re-authentication event the grant
 * records (null when none is needed). Throws the catalog refusal.
 */
export async function checkChoice(
  q: Queryable,
  session: SessionContext,
  kind: ClientKind,
  requested: readonly Scope[],
  choice: DelegationChoice,
): Promise<{ readonly restrictions: GrantRestrictions; readonly reauthEventId: string | null }> {
  const chosen = choice.scopes
  if (
    chosen.length === 0 ||
    new Set(chosen).size !== chosen.length ||
    !chosen.every((s) => requested.includes(s)) ||
    choice.tiers.length === 0 ||
    choice.lifetimeDays < 1 ||
    choice.lifetimeDays > OAUTH_LIMITS.grantMaxDays
  ) {
    throw new AuthError('VALIDATION_FAILED')
  }
  const tiers = [...new Set(choice.tiers)]
  for (const scope of chosen) {
    const tier = scopeDefinition(scope).tier
    if (tier !== null && !tiers.includes(tier)) {
      throw new AuthError('VALIDATION_FAILED')
    }
  }
  const offers = await scopeOffers(q, session, kind, chosen)
  const refused = offers.filter((o) => !o.available).map((o) => o.scope)
  if (refused.length > 0) {
    throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: refused.slice(0, 64) } })
  }
  const production = tiers.includes('prod')
  if (production && choice.acknowledgeProduction !== true) {
    throw new AuthError('PRODUCTION_CONFIRMATION_REQUIRED')
  }
  const elevated = offers.some(
    (o) => o.write && ((production && o.tier !== 'nonprod') || o.humanOnly),
  )
  const fresh = freshProof(
    { kind: 'human', identityId: session.identityId, client: 'web', session },
    CONSENT_REAUTH_SECONDS,
  )
  if (elevated && !fresh) {
    throw new AuthError('REAUTH_REQUIRED')
  }
  return {
    restrictions: { tiers, targets: { kind: 'all' } },
    reauthEventId: fresh ? session.reauthEventId : null,
  }
}

/** Maps a guard refusal of the Control Store to the catalog: it re-checked what this code checked. */
export function delegationRefusal(error: unknown): never {
  if (error instanceof ControlStoreError && error.sqlstate === 'EXO03') {
    throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: [] } })
  }
  throw error
}

function codeRedirect(
  redirectUri: string,
  issuer: string,
  params: { readonly code?: string; readonly error?: 'access_denied'; readonly state: string },
): string {
  const url = new URL(redirectUri)
  if (params.code !== undefined) {
    url.searchParams.append('code', params.code)
  }
  if (params.error !== undefined) {
    url.searchParams.append('error', params.error)
  }
  url.searchParams.append('state', params.state)
  url.searchParams.append('iss', issuer)
  return url.href
}

export function auditClient(client: OAuthClientRecord, grant?: Pick<GrantRecord, 'grantId'>) {
  return {
    clientId: client.clientId,
    kind:
      client.kind === 'cli' || client.kind === 'mcp' || client.kind === 'ci' ? client.kind : 'web',
    name: client.displayName,
    ...(grant === undefined ? {} : { grantId: grant.grantId }),
  } as const
}

export async function decideConsent(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  body: DelegationChoice & { readonly request: string; readonly decision: 'allow' | 'deny' },
  bindingCookie: string | undefined,
): Promise<{ readonly redirectTo: string }> {
  const issuer = deps.config.publicOrigin
  const pending = await loadPendingAuthorization(tx, body.request, bindingCookie, {
    forUpdate: true,
  })
  if (body.decision === 'deny') {
    await tx.query(
      'oauth.consent.deny',
      `UPDATE oauth.authorization_requests SET decision = 'denied', identity_id = $2 WHERE request_id = $1`,
      [pending.requestId, session.identityId],
    )
    return {
      redirectTo: codeRedirect(pending.redirectUri, issuer, {
        error: 'access_denied',
        state: pending.state,
      }),
    }
  }
  const { restrictions, reauthEventId } = await checkChoice(
    tx,
    session,
    pending.client.kind,
    pending.scopes,
    body,
  )
  const grantId = await insertGrant(tx, deps.clock.nowMs(), {
    kind: 'delegated',
    identityId: session.identityId,
    clientId: pending.client.clientId,
    resource: pending.resource,
    scopes: body.scopes,
    restrictions,
    createdBy: session.identityId,
    reauthEventId,
    lifetimeDays: body.lifetimeDays,
  }).catch(delegationRefusal)
  const code = newToken('code')
  await tx.query(
    'oauth.code.insert',
    `INSERT INTO oauth.authorization_codes (code_hash, grant_id, client_id, identity_id, redirect_uri,
                                            code_challenge, resource, scopes, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], clock_timestamp(), clock_timestamp())`,
    [
      tokenHash('code', code),
      grantId,
      pending.client.clientId,
      session.identityId,
      pending.redirectUri,
      pending.codeChallenge,
      pending.resource,
      body.scopes,
    ],
  )
  await tx.query(
    'oauth.consent.allow',
    `UPDATE oauth.authorization_requests SET decision = 'allowed', identity_id = $2 WHERE request_id = $1`,
    [pending.requestId, session.identityId],
  )
  await appendAudit(
    tx,
    {
      action: 'oauth.grant_created',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: auditClient(pending.client, { grantId }),
      changes: {
        kind: 'delegated',
        resource: pending.resource,
        scopes: [...body.scopes],
        tiers: [...restrictions.tiers],
        targets: 'all',
        lifetimeDays: body.lifetimeDays,
        registration: pending.client.registration,
      },
      result: { status: 'succeeded' },
      request: await auditRequest(deps.keys, meta),
    },
    deps.clock,
  )
  return {
    redirectTo: codeRedirect(pending.redirectUri, issuer, { code, state: pending.state }),
  }
}
