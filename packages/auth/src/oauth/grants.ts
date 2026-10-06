import {
  type GrantRestrictions,
  type GrantView,
  isScope,
  type OAuthResource,
  type Scope,
  type Tier,
} from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import {
  type GrantId,
  type IdentityId,
  isId,
  newId,
  type OAuthClientId,
  type TargetId,
} from '@exponetdb/kernel'
import { type AuditRequest, appendAudit, humanActor, webClient } from '../audit.ts'
import type { AuthDeps } from '../deps.ts'
import type { SessionContext } from '../sessions.ts'
import { CLIENT_COLUMNS, clientFromRow, clientSummary } from './clients.ts'
import { resourceUri } from './metadata.ts'

/**
 * Grants (oauth.md §4, §6): the maximum authority an identity delegated to
 * a client for one resource. A grant never holds a permission: the live
 * role bindings decide at every use, and the grant can only take away.
 */
export type RevokeReason =
  | 'owner'
  | 'administrator'
  | 'client_disabled'
  | 'client_review'
  | 'identity_disabled'
  | 'identity_erased'
  | 'refresh_reuse'
  | 'code_replay'
  | 'out_of_band_recovery'
  | 'token_revocation'
  | 'replaced'

export interface GrantRecord {
  readonly grantId: GrantId
  readonly kind: 'delegated' | 'machine'
  readonly identityId: IdentityId
  readonly clientId: OAuthClientId
  readonly resource: OAuthResource
  readonly scopes: readonly Scope[]
  readonly restrictions: GrantRestrictions
  /** Active and not expired (database clock). */
  readonly live: boolean
}

export function scopesOf(values: readonly string[]): Scope[] {
  return values.filter(isScope)
}

export function tiersOf(values: readonly string[]): Tier[] {
  return values.filter((t): t is Tier => t === 'prod' || t === 'nonprod')
}

export function restrictionsOf(
  tiers: readonly string[],
  targetIds: string[] | null,
): GrantRestrictions {
  const ids = (targetIds ?? []).filter((id): id is TargetId => isId('tgt', id))
  return {
    tiers: tiersOf(tiers),
    targets:
      targetIds === null || ids.length === 0 ? { kind: 'all' } : { kind: 'list', targetIds: ids },
  }
}

export function textArrayOrNull(row: Row, column: string): string[] | null {
  return row.json(column) === null ? null : row.textArray(column)
}

function resourceFrom(value: string): OAuthResource {
  return value === 'mcp' ? 'mcp' : 'api'
}

function grantFromRow(row: Row): GrantRecord {
  const grantId = row.text('grant_id')
  const identityId = row.text('identity_id')
  const clientId = row.text('client_id')
  if (!isId('grt', grantId) || !isId('idn', identityId) || !isId('cli', clientId)) {
    throw new Error('grant row has an invalid id')
  }
  return {
    grantId,
    kind: row.text('grant_kind') === 'machine' ? 'machine' : 'delegated',
    identityId,
    clientId,
    resource: resourceFrom(row.text('resource')),
    scopes: scopesOf(row.textArray('scopes')),
    restrictions: restrictionsOf(row.textArray('tiers'), textArrayOrNull(row, 'target_ids')),
    live: row.bool('live'),
  }
}

// Aliased where a joined client row has the same column name (`kind`).
const GRANT_COLUMNS = `g.grant_id, g.kind AS grant_kind, g.identity_id, g.client_id, g.resource, g.scopes, g.tiers, g.target_ids,
  (g.state = 'active' AND g.expires_at > clock_timestamp()) AS live`

export async function readGrant(
  q: Queryable,
  grantId: GrantId,
  options: { readonly forUpdate?: boolean } = {},
): Promise<GrantRecord | undefined> {
  const { rows } = await q.query(
    'oauth.grant.read',
    `SELECT ${GRANT_COLUMNS} FROM oauth.grants g WHERE g.grant_id = $1${options.forUpdate === true ? ' FOR UPDATE' : ''}`,
    [grantId],
  )
  const row = rows[0]
  return row === undefined ? undefined : grantFromRow(row)
}

const ts = (expr: string, alias: string) =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

/** Grants as views, newest first; with an identity, only that identity's. */
export async function listGrantViews(
  q: Queryable,
  issuer: string,
  filter: {
    readonly identityId?: IdentityId
    readonly grantId?: GrantId
    readonly state?: 'active' | 'revoked' | 'expired'
    readonly limit: number
  },
): Promise<GrantView[]> {
  const { rows } = await q.query(
    'oauth.grant.list',
    `SELECT ${GRANT_COLUMNS}, ${CLIENT_COLUMNS},
            ${ts('g.created_at', 'grant_created_at')}, ${ts('g.consent_at', 'grant_consent_at')},
            ${ts('g.expires_at', 'grant_expires_at')}, ${ts('g.revoked_at', 'grant_revoked_at')},
            g.revoke_reason,
            CASE WHEN g.state = 'revoked' THEN 'revoked'
                 WHEN g.expires_at <= clock_timestamp() THEN 'expired' ELSE 'active' END AS grant_state,
            ${ts('(SELECT max(t.issued_at) FROM oauth.tokens t WHERE t.grant_id = g.grant_id)', 'last_token_at')}
       FROM oauth.grants g JOIN oauth.clients c ON c.client_id = g.client_id
      WHERE ($1::text IS NULL OR g.identity_id = $1)
        AND ($2::text IS NULL OR g.grant_id = $2)
      ORDER BY g.created_at DESC, g.grant_id DESC`,
    [filter.identityId ?? null, filter.grantId ?? null],
  )
  const out: GrantView[] = []
  for (const row of rows) {
    const state = row.text('grant_state')
    if (filter.state !== undefined && state !== filter.state) {
      continue
    }
    const grant = grantFromRow(row)
    out.push({
      id: grant.grantId,
      kind: grant.kind,
      identityId: grant.identityId,
      client: clientSummary(clientFromRow(row)),
      resource: grant.resource,
      resourceUri: resourceUri(issuer, grant.resource),
      scopes: [...grant.scopes],
      restrictions: grant.restrictions,
      createdAt: row.text('grant_created_at'),
      consentAt: row.textOrNull('grant_consent_at'),
      expiresAt: row.text('grant_expires_at'),
      state: state === 'revoked' ? 'revoked' : state === 'expired' ? 'expired' : 'active',
      revokedAt: row.textOrNull('grant_revoked_at'),
      revokeReason: row.textOrNull('revoke_reason'),
      lastTokenAt: row.textOrNull('last_token_at'),
    })
    if (out.length >= filter.limit) {
      break
    }
  }
  return out
}

/**
 * Revokes an active grant; its tokens and device codes end in the same
 * transaction (Control Store trigger). False when it was not active.
 */
export async function revokeGrant(
  tx: Tx,
  grantId: GrantId,
  reason: RevokeReason,
  by: IdentityId | null,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    'oauth.grant.revoke',
    `UPDATE oauth.grants SET state = 'revoked', revoke_reason = $2, revoked_by_identity_id = $3
      WHERE grant_id = $1 AND state = 'active'`,
    [grantId, reason, by],
  )
  return rowCount === 1
}

export interface NewGrant {
  readonly kind: 'delegated' | 'machine'
  readonly identityId: IdentityId
  readonly clientId: OAuthClientId
  readonly resource: OAuthResource
  readonly scopes: readonly Scope[]
  readonly restrictions: GrantRestrictions
  readonly createdBy: IdentityId
  readonly reauthEventId: string | null
  readonly lifetimeDays: number
}

/** Inserts a grant; the Control Store re-checks client, identity, scopes, tiers, re-authentication and lifetime. */
export async function insertGrant(tx: Tx, nowMs: number, grant: NewGrant): Promise<GrantId> {
  const grantId = newId('grt', nowMs)
  await tx.query(
    'oauth.grant.insert',
    `INSERT INTO oauth.grants (grant_id, kind, identity_id, client_id, client_kind, resource, scopes, tiers,
                               target_ids, created_by_identity_id, reauth_event_id, created_at, expires_at, state)
     VALUES ($1, $2, $3, $4, 'cli', $5, $6::text[], $7::text[], $8::text[], $9, $10, clock_timestamp(),
             clock_timestamp() + make_interval(days => $11::int), 'active')`,
    [
      grantId,
      grant.kind,
      grant.identityId,
      grant.clientId,
      grant.resource,
      grant.scopes,
      grant.restrictions.tiers,
      grant.restrictions.targets.kind === 'all' ? null : grant.restrictions.targets.targetIds,
      grant.createdBy,
      grant.reauthEventId,
      grant.lifetimeDays,
    ],
  )
  return grantId
}

/** `oauth.grant_revoked` by a person (the grant's owner or an administrator). */
export async function auditGrantRevoked(
  tx: Tx,
  deps: Pick<AuthDeps, 'clock'>,
  session: SessionContext,
  request: AuditRequest,
  grant: GrantRecord,
  reason: 'owner' | 'administrator',
): Promise<void> {
  await appendAudit(
    tx,
    {
      action: 'oauth.grant_revoked',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      changes: {
        reason,
        grantId: grant.grantId,
        oauthClientId: grant.clientId,
        grantKind: grant.kind,
        resource: grant.resource,
        identityId: grant.identityId,
      },
      result: { status: 'succeeded' },
      request,
    },
    deps.clock,
  )
}
