import type { ClientKind, OAuthResource } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isId } from '@exponetdb/kernel'
import { identityLabel } from '../audit.ts'
import type { Principal } from '../authorization/engine.ts'
import { parseToken, tokenHash } from '../tokens.ts'
import { restrictionsOf, scopesOf, textArrayOrNull } from './grants.ts'

/**
 * Bearer authentication of the protected resources (oauth.md §5, RFC 6750).
 * Every request looks the credential up by its hash, with no cache: the
 * token or key is live, the grant is active and not expired, the client is
 * active, the identity is active, and the credential's audience is the
 * resource the request arrived at. Revoking any of them ends the
 * credential for the next request. The result is a delegated principal for
 * the central engine; it never carries a permission.
 */
export type DelegatedPrincipal = Extract<Principal, { kind: 'delegated' }>

export type BearerResult =
  | { readonly ok: true; readonly principal: DelegatedPrincipal }
  | { readonly ok: false }

const INVALID: BearerResult = { ok: false }

/** API key last-use times are written at most this often (identity.md §5). */
export const API_KEY_TOUCH_SECONDS = 300

function serviceLabel(labelNumber: number): string {
  return `service #${labelNumber}`
}

/**
 * The value of the one `Authorization: Bearer` header, or undefined when
 * there is none, several, or another scheme (RFC 6750 §2.1: exactly one
 * method; the token is case-sensitive, the scheme is not).
 */
export function bearerValue(headers: readonly string[]): string | undefined | 'invalid' {
  if (headers.length === 0) {
    return undefined
  }
  if (headers.length > 1) {
    return 'invalid'
  }
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headers[0] ?? '')
  return match?.[1] ?? 'invalid'
}

export async function authenticateBearer(
  q: Queryable,
  token: string,
  resource: OAuthResource,
): Promise<BearerResult> {
  const access = parseToken('access', token)
  if (access !== undefined) {
    const { rows } = await q.query(
      'oauth.bearer.access',
      `SELECT t.identity_id, t.grant_id, t.client_id, t.resource, t.scopes, g.kind AS grant_kind, g.tiers,
              g.target_ids, c.kind AS client_kind, i.kind AS identity_kind, i.label_number
         FROM oauth.tokens t
         JOIN oauth.grants g ON g.grant_id = t.grant_id
         JOIN oauth.clients c ON c.client_id = t.client_id
         JOIN auth.identities i ON i.identity_id = t.identity_id
        WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()
          AND g.state = 'active' AND g.expires_at > clock_timestamp()
          AND c.state = 'active' AND i.state = 'active'`,
      [tokenHash('access', access)],
    )
    const row = rows[0]
    if (row === undefined || row.text('resource') !== resource) {
      return INVALID
    }
    const identityId = row.text('identity_id')
    const grantId = row.text('grant_id')
    const clientId = row.text('client_id')
    const clientKind = row.text('client_kind')
    const identityKind = row.text('identity_kind')
    if (
      !isId('idn', identityId) ||
      !isId('grt', grantId) ||
      !isId('cli', clientId) ||
      (clientKind !== 'cli' && clientKind !== 'mcp' && clientKind !== 'ci') ||
      (identityKind !== 'human' && identityKind !== 'service')
    ) {
      return INVALID
    }
    const kind: ClientKind = clientKind
    const labelNumber = row.int('label_number')
    return {
      ok: true,
      principal: {
        kind: 'delegated',
        identityId,
        identityKind,
        label: identityKind === 'human' ? identityLabel(labelNumber) : serviceLabel(labelNumber),
        client: kind,
        delegation: {
          credential: {
            type: 'access_token',
            grantId,
            clientId,
            grantKind: row.text('grant_kind') === 'machine' ? 'machine' : 'delegated',
          },
          resource,
          scopes: new Set(scopesOf(row.textArray('scopes'))),
          restrictions: restrictionsOf(row.textArray('tiers'), textArrayOrNull(row, 'target_ids')),
        },
      },
    }
  }
  const apiKey = parseToken('apiKey', token)
  if (apiKey !== undefined) {
    // An API key is a REST credential of a service account only.
    if (resource !== 'api') {
      return INVALID
    }
    const { rows } = await q.query(
      'oauth.bearer.api_key',
      `SELECT k.key_id, k.identity_id, k.scopes, k.tiers, k.target_ids, i.label_number,
              (k.last_used_at IS NULL
               OR k.last_used_at < clock_timestamp() - make_interval(secs => $2::int)) AS touch_due
         FROM oauth.api_keys k JOIN auth.identities i ON i.identity_id = k.identity_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND k.expires_at > clock_timestamp()
          AND i.state = 'active' AND i.kind = 'service'`,
      [tokenHash('apiKey', apiKey), API_KEY_TOUCH_SECONDS],
    )
    const row = rows[0]
    const keyId = row?.text('key_id')
    const identityId = row?.text('identity_id')
    if (row === undefined || !isId('key', keyId) || !isId('idn', identityId)) {
      return INVALID
    }
    if (row.bool('touch_due')) {
      await q.query(
        'oauth.bearer.api_key_touch',
        'UPDATE oauth.api_keys SET last_used_at = clock_timestamp() WHERE key_id = $1 AND revoked_at IS NULL',
        [keyId],
      )
    }
    return {
      ok: true,
      principal: {
        kind: 'delegated',
        identityId,
        identityKind: 'service',
        label: serviceLabel(row.int('label_number')),
        client: 'ci',
        delegation: {
          credential: { type: 'api_key', keyId },
          resource: 'api',
          scopes: new Set(scopesOf(row.textArray('scopes'))),
          restrictions: restrictionsOf(row.textArray('tiers'), textArrayOrNull(row, 'target_ids')),
        },
      },
    }
  }
  return INVALID
}
