import type { SessionView } from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import {
  type Clock,
  type IdentityId,
  isId,
  newId,
  type ReauthEventId,
  type SessionId,
} from '@exponetdb/kernel'
import { identityLabel } from './audit.ts'
import { deviceLabel } from './credentials/device.ts'
import { AuthError } from './errors.ts'
import { newToken, parseToken, safeEqual, tokenHash } from './tokens.ts'

/**
 * Web sessions (identity.md §3, rest architecture §6).
 *
 * - The session cookie `__Host-exdb_session` (Secure, HttpOnly,
 *   SameSite=Strict, Path=/, no Domain) carries a 256-bit token; only its
 *   hash is stored. The public `ses_` id is what the UI and audit show.
 * - The CSRF token is a second 256-bit secret per session, stored hashed.
 *   The Web App reads it from the `__Host-exdb_csrf` cookie (not HttpOnly)
 *   and sends it as `X-CSRF-Token`; the server compares the header with
 *   the cookie and verifies it against the stored hash.
 * - Idle timeout 30 minutes and absolute lifetime 12 hours, both decided
 *   by the database clock in the lookup itself. A session dies with the
 *   identity's session epoch (disabling, erasure, recovery) and with any
 *   identity state other than `active`.
 * - A session is never created from a client-supplied value (no
 *   fixation): sign-in issues a new id and token. Re-authentication and
 *   the end of a recovery rotate both secrets.
 * - The session is bound to a coarse device label (browser and system
 *   family); a request from another family does not authenticate.
 * - Privileges are never stored in the session: every request evaluates
 *   the identity's live role bindings, so a removed binding has effect on
 *   the next request.
 */
export const SESSION_COOKIE = '__Host-exdb_session'
export const CSRF_COOKIE = '__Host-exdb_csrf'
export const CEREMONY_COOKIE = '__Host-exdb_ceremony'
export const CSRF_HEADER = 'x-csrf-token'
export const SESSION_IDLE_SECONDS = 30 * 60
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60
/** `last_seen_at` is written at most once a minute per session. */
export const SESSION_TOUCH_SECONDS = 60

export type SessionAssurance = 'full' | 'recovery'
export type RevokeReason =
  | 'logout'
  | 'self_revoked'
  | 'others_revoked'
  | 'identity_disabled'
  | 'identity_erased'
  | 'recovery'
  | 'factors_changed'
  | 'out_of_band_recovery'

export interface SessionSecrets {
  readonly token: string
  readonly csrfToken: string
}

export interface SessionContext {
  readonly sessionId: SessionId
  readonly identityId: IdentityId
  readonly labelNumber: number
  readonly label: string
  readonly assurance: SessionAssurance
  readonly recoveryRequired: boolean
  /** Time of the last re-authentication (database clock), or null. */
  readonly reauthAt: string | null
  /** Seconds since `reauthAt` on the database clock at lookup, rounded up; null without one. */
  readonly reauthAgeSeconds: number | null
  /**
   * How the last proof was made. A recovery code opens the window only for
   * setting up new factors in a recovery session; the authorization engine
   * never counts it for anything else.
   */
  readonly reauthMethod: 'passkey' | 'totp' | 'recovery_code' | null
  /** The recorded proof behind `reauthAt` (approvals reference it). */
  readonly reauthEventId: ReauthEventId | null
  readonly authzRevision: number
  readonly createdAt: string
  readonly lastSeenAt: string
  readonly idleExpiresAt: string
  readonly absoluteExpiresAt: string
  readonly deviceLabel: string
  /** Internal: the stored CSRF hash, compared by {@link verifyCsrf}; never serialized. */
  readonly csrfHash: string
}

const ts = (expr: string, alias: string) =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

const LIVE = `s.revoked_at IS NULL AND s.absolute_expires_at > clock_timestamp()
  AND s.last_seen_at > clock_timestamp() - make_interval(secs => ${SESSION_IDLE_SECONDS})
  AND s.session_epoch = i.session_epoch AND i.state = 'active'`

const SESSION_COLUMNS = `s.session_id, s.identity_id, s.csrf_hash, s.assurance, s.device_label,
  ${ts('s.created_at', 'created_at')}, ${ts('s.last_seen_at', 'last_seen_at')},
  ${ts(`s.last_seen_at + make_interval(secs => ${SESSION_IDLE_SECONDS})`, 'idle_expires_at')},
  ${ts('s.absolute_expires_at', 'absolute_expires_at')}, ${ts('s.reauth_at', 'reauth_at')},
  CASE WHEN s.reauth_at IS NULL THEN NULL
       ELSE greatest(0, ceil(extract(epoch FROM clock_timestamp() - s.reauth_at)))::int END AS reauth_age,
  (s.last_seen_at < clock_timestamp() - make_interval(secs => ${SESSION_TOUCH_SECONDS})) AS touch_due,
  r.method AS reauth_method, s.reauth_event_id, i.label_number, i.recovery_required, i.authz_revision`

const SESSION_FROM = `auth.web_sessions s JOIN auth.identities i USING (identity_id)
  LEFT JOIN auth.reauth_events r ON r.reauth_event_id = s.reauth_event_id`

function contextFromRow(row: Row): SessionContext {
  const sessionId = row.text('session_id')
  const identityId = row.text('identity_id')
  const assurance = row.text('assurance')
  const event = row.textOrNull('reauth_event_id')
  const reauthEventId = isId('rau', event) ? event : null
  if (
    !isId('ses', sessionId) ||
    !isId('idn', identityId) ||
    (assurance !== 'full' && assurance !== 'recovery') ||
    (event !== null && reauthEventId === null)
  ) {
    throw new AuthError('INTERNAL')
  }
  const labelNumber = row.int('label_number')
  const method = row.textOrNull('reauth_method')
  const reauthMethod =
    method === 'passkey' || method === 'totp' || method === 'recovery_code' ? method : null
  return {
    sessionId,
    identityId,
    labelNumber,
    label: identityLabel(labelNumber),
    assurance,
    recoveryRequired: row.bool('recovery_required'),
    reauthAt: row.textOrNull('reauth_at'),
    reauthAgeSeconds: row.intOrNull('reauth_age'),
    reauthMethod,
    reauthEventId,
    authzRevision: row.int('authz_revision'),
    createdAt: row.text('created_at'),
    lastSeenAt: row.text('last_seen_at'),
    idleExpiresAt: row.text('idle_expires_at'),
    absoluteExpiresAt: row.text('absolute_expires_at'),
    deviceLabel: row.textOrNull('device_label') ?? deviceLabel(undefined),
    csrfHash: row.text('csrf_hash'),
  }
}

function newSecrets(): SessionSecrets & { readonly tokenHash: string; readonly csrfHash: string } {
  const token = newToken('session')
  const csrfToken = newToken('csrf')
  return {
    token,
    csrfToken,
    tokenHash: tokenHash('session', token),
    csrfHash: tokenHash('csrf', csrfToken),
  }
}

/**
 * Issues a new session for an active identity in the caller's transaction.
 * `reauthEventId` is the sign-in's own proof (passkey or TOTP), which also
 * opens the first re-authentication window.
 */
export async function issueSession(
  tx: Tx,
  clock: Clock,
  input: {
    readonly identityId: IdentityId
    readonly assurance: SessionAssurance
    readonly reauthEventId: ReauthEventId | null
    readonly userAgent: string | undefined
  },
): Promise<{ readonly sessionId: SessionId; readonly secrets: SessionSecrets }> {
  const sessionId = newId('ses', clock.nowMs())
  const secrets = newSecrets()
  await tx.query(
    'auth.session.insert',
    `INSERT INTO auth.web_sessions
       (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance, device_label,
        created_at, absolute_expires_at, last_seen_at, reauth_event_id)
     VALUES ($1, $2, $3, $4, 1, $5, $6, clock_timestamp(), clock_timestamp(), clock_timestamp(), $7)`,
    [
      sessionId,
      input.identityId,
      secrets.tokenHash,
      secrets.csrfHash,
      input.assurance,
      deviceLabel(input.userAgent),
      input.reauthEventId,
    ],
  )
  return { sessionId, secrets: { token: secrets.token, csrfToken: secrets.csrfToken } }
}

/**
 * The live session for a cookie value, or undefined (unknown, revoked,
 * idle, expired, other device family, identity not active, older session
 * epoch). The caller cannot tell these apart, by design.
 */
export async function loadSession(
  q: Queryable,
  cookieValue: string | undefined,
  input: { readonly userAgent: string | undefined; readonly forUpdate?: boolean },
): Promise<(SessionContext & { readonly touchDue: boolean }) | undefined> {
  const token = parseToken('session', cookieValue)
  if (token === undefined) {
    return undefined
  }
  const { rows } = await q.query(
    input.forUpdate === true ? 'auth.session.load_for_update' : 'auth.session.load',
    `SELECT ${SESSION_COLUMNS}
       FROM ${SESSION_FROM}
      WHERE s.token_hash = $1 AND ${LIVE}${input.forUpdate === true ? ' FOR UPDATE OF s' : ''}`,
    [tokenHash('session', token)],
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  const context = contextFromRow(row)
  if (context.deviceLabel !== deviceLabel(input.userAgent)) {
    return undefined
  }
  return { ...context, touchDue: row.bool('touch_due') }
}

/** Re-reads a session by id inside a transaction (locks it), for changes that follow an earlier lookup. */
export async function lockSession(
  tx: Tx,
  sessionId: SessionId,
): Promise<SessionContext | undefined> {
  const { rows } = await tx.query(
    'auth.session.lock',
    `SELECT ${SESSION_COLUMNS}
       FROM ${SESSION_FROM}
      WHERE s.session_id = $1 AND ${LIVE} FOR UPDATE OF s`,
    [sessionId],
  )
  const row = rows[0]
  return row === undefined ? undefined : contextFromRow(row)
}

export async function touchSession(q: Queryable, sessionId: SessionId): Promise<void> {
  await q.query(
    'auth.session.touch',
    `UPDATE auth.web_sessions SET last_seen_at = clock_timestamp()
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  )
}

/**
 * Double submit with server verification: the header must equal the CSRF
 * cookie and hash to the session's stored CSRF hash. Compared in constant
 * time.
 */
export function verifyCsrf(
  session: Pick<SessionContext, 'csrfHash'>,
  header: string | undefined,
  cookie: string | undefined,
): boolean {
  const token = parseToken('csrf', header)
  if (token === undefined || cookie === undefined || !safeEqual(token, cookie)) {
    return false
  }
  return safeEqual(tokenHash('csrf', token), session.csrfHash)
}

/**
 * Replaces both secrets of a live session (re-authentication, end of a
 * recovery). Optionally attaches a re-authentication event and raises the
 * assurance from `recovery` to `full`.
 */
export async function rotateSession(
  tx: Tx,
  sessionId: SessionId,
  input: { readonly reauthEventId?: ReauthEventId; readonly assurance?: 'full' } = {},
): Promise<SessionSecrets & { readonly reauthAt: string | null }> {
  const secrets = newSecrets()
  const { rows } = await tx.query(
    'auth.session.rotate',
    `UPDATE auth.web_sessions
        SET token_hash = $2, csrf_hash = $3, secret_generation = secret_generation + 1,
            reauth_event_id = coalesce($4, reauth_event_id), assurance = coalesce($5, assurance)
      WHERE session_id = $1 AND revoked_at IS NULL
      RETURNING ${ts('reauth_at', 'reauth_at')}`,
    [
      sessionId,
      secrets.tokenHash,
      secrets.csrfHash,
      input.reauthEventId ?? null,
      input.assurance ?? null,
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new AuthError('SESSION_EXPIRED')
  }
  return {
    token: secrets.token,
    csrfToken: secrets.csrfToken,
    reauthAt: row.textOrNull('reauth_at'),
  }
}

export async function revokeSession(
  tx: Tx,
  sessionId: SessionId,
  identityId: IdentityId,
  reason: RevokeReason,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    'auth.session.revoke',
    `UPDATE auth.web_sessions SET revoked_at = clock_timestamp(), revoke_reason = $3
      WHERE session_id = $1 AND identity_id = $2 AND revoked_at IS NULL`,
    [sessionId, identityId, reason],
  )
  return rowCount === 1
}

/** Revokes every unrevoked session of an identity, except `keep`. Returns how many. */
export async function revokeIdentitySessions(
  tx: Tx,
  identityId: IdentityId,
  reason: RevokeReason,
  keep?: SessionId,
): Promise<number> {
  const { rowCount } = await tx.query(
    'auth.session.revoke_all',
    `UPDATE auth.web_sessions SET revoked_at = clock_timestamp(), revoke_reason = $2
      WHERE identity_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR session_id <> $3)`,
    [identityId, reason, keep ?? null],
  )
  return rowCount
}

/** Live sessions of an identity, newest first, as the person sees them. */
export async function listSessions(
  q: Queryable,
  identityId: IdentityId,
  current: SessionId,
): Promise<SessionView[]> {
  const { rows } = await q.query(
    'auth.session.list',
    `SELECT ${SESSION_COLUMNS}
       FROM ${SESSION_FROM}
      WHERE s.identity_id = $1 AND ${LIVE}
      ORDER BY s.created_at DESC, s.session_id`,
    [identityId],
  )
  return rows.map((row) => sessionView(contextFromRow(row), current))
}

export function sessionView(session: SessionContext, current: SessionId): SessionView {
  return {
    id: session.sessionId,
    current: session.sessionId === current,
    clientKind: 'web',
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    expiresAt: session.absoluteExpiresAt,
    device: session.deviceLabel,
    reauthAt: session.reauthAt,
    assurance: session.assurance,
  }
}
