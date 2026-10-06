import { randomInt } from 'node:crypto'
import {
  type ConsentView,
  type DeviceAuthorizationResponse,
  GRANT_TYPE_DEVICE_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  isDeviceFlowScope,
  isScopeGrantableTo,
  OAUTH_LIMITS,
  RESOURCES_BY_CLIENT_KIND,
} from '@exponetdb/contracts'
import { ControlStoreError, type Queryable, type Tx } from '@exponetdb/control-store'
import { isId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, humanActor } from '../audit.ts'
import { freshProof } from '../authorization/engine.ts'
import type { AuthDeps } from '../deps.ts'
import { AuthError } from '../errors.ts'
import type { RequestMeta } from '../request.ts'
import type { SessionContext } from '../sessions.ts'
import { newToken, parseToken, tokenHash } from '../tokens.ts'
import { CLIENT_COLUMNS, clientFromRow, type OAuthClientRecord } from './clients.ts'
import {
  auditClient,
  CONSENT_REAUTH_SECONDS,
  checkChoice,
  consentClient,
  DEFAULT_RESTRICTIONS,
  type DelegationChoice,
  delegationRefusal,
  scopeOffers,
} from './consent.ts'
import { OAuthError, rateLimited } from './errors.ts'
import { insertGrant, readGrant, scopesOf } from './grants.ts'
import { addressBucket, entityBucket, hit } from './limits.ts'
import { OAUTH_PATHS, resourceOf, resourceUri } from './metadata.ts'
import { type ProtocolParams, parseScopeParam } from './params.ts'
import {
  authenticateClient,
  type GrantOutcome,
  issueTokens,
  parseForm,
  type TokenEndpointDeps,
  type TokenRequest,
} from './token.ts'

/**
 * The device authorization grant (RFC 8628, oauth.md §5) for the
 * first-party CLI on machines without a browser. The device code and the
 * user code are stored as hashes; both live 10 minutes. The user code is 8
 * letters from an alphabet without vowels and look-alikes (20^8 ≈ 2.6·10^10
 * codes) and every verification attempt counts against the person (10 per
 * 10 minutes). There is no `verification_uri_complete`: the person types the
 * code shown on their own device, so a link sent by someone else cannot
 * carry an attacker's code. A poll faster than the interval is
 * `slow_down` and the interval grows by 5 seconds (at most 60).
 *
 * The device flow is a convenience flow, not an elevation ceremony: it
 * carries only scopes whose contract needs no explicit consent
 * (`isDeviceFlowScope`), so no production scope and no human-only scope
 * ever passes through it; a request naming one is refused whole with
 * `invalid_scope`. The loopback authorization code flow of the CLI keeps
 * offering them under the normal consent and re-authentication rules.
 */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export function newUserCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** The canonical user code (upper case, no dash or space), or undefined. */
export function normalizeUserCode(value: string): string | undefined {
  const compact = value.toUpperCase().replace(/[\s-]/g, '')
  return compact.length === 8 && [...compact].every((c) => USER_CODE_ALPHABET.includes(c))
    ? compact
    : undefined
}

/** POST /oauth/device_authorization. */
export async function startDeviceAuthorization(
  deps: TokenEndpointDeps,
  meta: RequestMeta,
  request: TokenRequest,
): Promise<DeviceAuthorizationResponse> {
  const auth = deps.auth
  const wait = await hit(auth.store, await addressBucket(auth.keys, 'device-ip', meta.clientIp))
  if (wait > 0) {
    throw rateLimited(wait)
  }
  const params = parseForm(request)
  // Only the public first-party CLI starts a device authorization: an
  // assertion is refused before it is verified (and its jti never recorded).
  if (params.has('client_assertion') || params.has('client_assertion_type')) {
    throw new OAuthError('invalid_client')
  }
  return auth.store.transaction('oauth.device.start', async (tx) => {
    const client = await authenticateClient(tx, deps, request, params)
    if (
      !client.grantTypes.includes(GRANT_TYPE_DEVICE_CODE) ||
      client.tokenEndpointAuthMethod !== 'none'
    ) {
      throw new OAuthError('unauthorized_client')
    }
    const resource = resourceOf(auth.config.publicOrigin, params.get('resource'))
    if (resource === undefined || !RESOURCES_BY_CLIENT_KIND[client.kind].includes(resource)) {
      throw new OAuthError('invalid_target')
    }
    const scopes = parseScopeParam(params.get('scope'))
    const kind = client.kind
    // The whole request is refused when one scope is not holdable, or needs
    // explicit consent (production, human-only): the device flow never
    // carries elevated authority (G3B final hardening).
    if (
      scopes === undefined ||
      !scopes.every((s) => isScopeGrantableTo(s, kind) && isDeviceFlowScope(s))
    ) {
      throw new OAuthError('invalid_scope')
    }
    for (let attempt = 0; ; attempt++) {
      const deviceCode = newToken('device')
      const userCode = newUserCode()
      const compact = normalizeUserCode(userCode) ?? ''
      try {
        return await tx.savepoint(async (inner) => {
          await inner.query(
            'oauth.device.insert',
            `INSERT INTO oauth.device_codes (device_code_hash, user_code_hash, client_id, scopes, resource,
                                             interval_seconds, created_at, expires_at, state)
             VALUES ($1, $2, $3, $4::text[], $5, $6, clock_timestamp(), clock_timestamp(), 'pending')`,
            [
              tokenHash('device', deviceCode),
              tokenHash('user_code', compact),
              client.clientId,
              scopes,
              resource,
              OAUTH_LIMITS.deviceIntervalSeconds,
            ],
          )
          return {
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: `${auth.config.publicOrigin}${OAUTH_PATHS.devicePage}`,
            expires_in: OAUTH_LIMITS.deviceCodeSeconds,
            interval: OAUTH_LIMITS.deviceIntervalSeconds,
          }
        })
      } catch (error) {
        // A user code collision (unique hash): draw again, a few times.
        if (error instanceof ControlStoreError && error.sqlstate === '23505' && attempt < 3) {
          continue
        }
        throw error
      }
    }
  })
}

/** The token endpoint's `urn:ietf:params:oauth:grant-type:device_code` grant. */
export async function deviceCodeGrant(
  tx: Tx,
  client: OAuthClientRecord,
  params: ProtocolParams,
): Promise<GrantOutcome> {
  const deviceCode = parseToken('device', params.get('device_code'))
  const failed = (error: OAuthError): GrantOutcome => ({ ok: false, error })
  if (deviceCode === undefined) {
    return failed(new OAuthError('invalid_grant'))
  }
  const hash = tokenHash('device', deviceCode)
  // Lock order grant → device code, as a grant revocation takes it.
  const found = await tx.query(
    'oauth.device.find',
    'SELECT grant_id FROM oauth.device_codes WHERE device_code_hash = $1',
    [hash],
  )
  const foundRow = found.rows[0]
  if (foundRow === undefined) {
    return failed(new OAuthError('invalid_grant'))
  }
  const grantId = foundRow.textOrNull('grant_id')
  const grant =
    grantId !== null && isId('grt', grantId)
      ? await readGrant(tx, grantId, { forUpdate: true })
      : undefined
  const { rows } = await tx.query(
    'oauth.device.poll',
    `SELECT device_id, client_id, state, interval_seconds, grant_id,
            expires_at <= clock_timestamp() AS expired,
            (last_polled_at IS NOT NULL
             AND last_polled_at > clock_timestamp() - make_interval(secs => interval_seconds)) AS too_fast
       FROM oauth.device_codes WHERE device_code_hash = $1 FOR UPDATE`,
    [hash],
  )
  const row = rows[0]
  if (row === undefined || row.text('client_id') !== client.clientId) {
    return failed(new OAuthError('invalid_grant'))
  }
  const state = row.text('state')
  if (state === 'consumed') {
    return failed(new OAuthError('invalid_grant'))
  }
  if (row.bool('expired')) {
    return failed(new OAuthError('expired_token'))
  }
  if (state === 'denied') {
    return failed(new OAuthError('access_denied'))
  }
  if (state === 'pending') {
    if (row.bool('too_fast')) {
      await tx.query(
        'oauth.device.slow_down',
        `UPDATE oauth.device_codes
            SET interval_seconds = least(interval_seconds + $2::int, 60), last_polled_at = clock_timestamp()
          WHERE device_id = $1`,
        [row.int('device_id'), OAUTH_LIMITS.deviceSlowDownSeconds],
      )
      return failed(new OAuthError('slow_down'))
    }
    await tx.query(
      'oauth.device.polled',
      'UPDATE oauth.device_codes SET last_polled_at = clock_timestamp() WHERE device_id = $1',
      [row.int('device_id')],
    )
    return failed(new OAuthError('authorization_pending'))
  }
  if (grant === undefined && row.textOrNull('grant_id') !== null) {
    // Approved between the unlocked read and the lock: the next poll finds the grant.
    return failed(new OAuthError('authorization_pending'))
  }
  if (grant === undefined || !grant.live) {
    return failed(new OAuthError('invalid_grant'))
  }
  await tx.query(
    'oauth.device.consume',
    `UPDATE oauth.device_codes SET state = 'consumed' WHERE device_id = $1`,
    [row.int('device_id')],
  )
  return {
    ok: true,
    response: await issueTokens(tx, grant, client, grant.scopes, {
      issue: client.grantTypes.includes(GRANT_TYPE_REFRESH_TOKEN),
    }),
  }
}

// ----- verification in the Web App -----

interface PendingDevice {
  readonly deviceId: number
  readonly client: OAuthClientRecord
  readonly scopes: ReturnType<typeof scopesOf>
  readonly resource: 'api' | 'mcp'
  readonly expiresAt: string
}

/**
 * Counts a verification attempt against the person, outside any transaction
 * that a wrong code rolls back, so the code space cannot be searched.
 */
export async function countDeviceAttempt(deps: AuthDeps, session: SessionContext): Promise<void> {
  const wait = await hit(deps.store, entityBucket('device-idn', session.identityId))
  if (wait > 0) {
    throw new AuthError('RATE_LIMITED')
  }
}

async function loadDevice(
  q: Queryable,
  userCode: string,
  forUpdate: boolean,
): Promise<PendingDevice> {
  const compact = normalizeUserCode(userCode)
  if (compact === undefined) {
    throw new AuthError('USER_CODE_INVALID')
  }
  const { rows } = await q.query(
    'oauth.device.verify',
    `SELECT d.device_id, d.scopes, d.resource, d.state AS device_state,
            d.expires_at > clock_timestamp() AS live,
            to_char(d.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS device_expires_at,
            ${CLIENT_COLUMNS}
       FROM oauth.device_codes d JOIN oauth.clients c ON c.client_id = d.client_id
      WHERE d.user_code_hash = $1${forUpdate ? ' FOR UPDATE OF d' : ''}`,
    [tokenHash('user_code', compact)],
  )
  const row = rows[0]
  if (row === undefined || row.text('device_state') !== 'pending' || !row.bool('live')) {
    throw new AuthError('USER_CODE_INVALID')
  }
  const client = clientFromRow(row)
  if (client.state !== 'active') {
    throw new AuthError('CLIENT_NOT_APPROVED')
  }
  return {
    deviceId: row.int('device_id'),
    client,
    scopes: scopesOf(row.textArray('scopes')),
    resource: row.text('resource') === 'mcp' ? 'mcp' : 'api',
    expiresAt: row.text('device_expires_at'),
  }
}

export async function deviceView(
  deps: AuthDeps,
  session: SessionContext,
  userCode: string,
): Promise<ConsentView> {
  const device = await loadDevice(deps.store, userCode, false)
  return {
    kind: 'device',
    client: consentClient(device.client, null),
    resource: device.resource,
    resourceUri: resourceUri(deps.config.publicOrigin, device.resource),
    scopes: await scopeOffers(deps.store, session, device.client.kind, device.scopes),
    defaults: DEFAULT_RESTRICTIONS,
    lifetimeDays: { default: OAUTH_LIMITS.grantDefaultDays, max: OAUTH_LIMITS.grantMaxDays },
    reauth: {
      fresh: freshProof(
        { kind: 'human', identityId: session.identityId, client: 'web', session },
        CONSENT_REAUTH_SECONDS,
      ),
      withinSeconds: CONSENT_REAUTH_SECONDS,
    },
    expiresAt: device.expiresAt,
  }
}

export async function decideDevice(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  body: DelegationChoice & { readonly userCode: string; readonly decision: 'allow' | 'deny' },
): Promise<{ readonly status: 'approved' | 'denied' }> {
  const device = await loadDevice(tx, body.userCode, true)
  if (body.decision === 'deny') {
    await tx.query(
      'oauth.device.deny',
      `UPDATE oauth.device_codes SET state = 'denied', identity_id = $2 WHERE device_id = $1`,
      [device.deviceId, session.identityId],
    )
    return { status: 'denied' }
  }
  // The start refused elevated scopes; a decision never adds one.
  if (!body.scopes.every(isDeviceFlowScope)) {
    throw new AuthError('SCOPE_NOT_DELEGABLE', { details: { scopes: [] } })
  }
  const { restrictions, reauthEventId } = await checkChoice(
    tx,
    session,
    device.client.kind,
    device.scopes,
    body,
  )
  const grantId = await insertGrant(tx, deps.clock.nowMs(), {
    kind: 'delegated',
    identityId: session.identityId,
    clientId: device.client.clientId,
    resource: device.resource,
    scopes: body.scopes,
    restrictions,
    createdBy: session.identityId,
    reauthEventId,
    lifetimeDays: body.lifetimeDays,
  }).catch(delegationRefusal)
  await tx.query(
    'oauth.device.approve',
    `UPDATE oauth.device_codes SET state = 'approved', identity_id = $2, grant_id = $3 WHERE device_id = $1`,
    [device.deviceId, session.identityId, grantId],
  )
  await appendAudit(
    tx,
    {
      action: 'oauth.grant_created',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: auditClient(device.client, { grantId }),
      changes: {
        kind: 'delegated',
        flow: 'device',
        resource: device.resource,
        scopes: [...body.scopes],
        tiers: [...restrictions.tiers],
        targets: 'all',
        lifetimeDays: body.lifetimeDays,
        registration: device.client.registration,
      },
      result: { status: 'succeeded' },
      request: await auditRequest(deps.keys, meta),
    },
    deps.clock,
  )
  return { status: 'approved' }
}
