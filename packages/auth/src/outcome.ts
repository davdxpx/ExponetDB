import type { Queryable, Tx } from '@exponetdb/control-store'
import {
  type AuthFactorId,
  type Clock,
  type IdentityId,
  newId,
  type ReauthEventId,
  type SessionId,
} from '@exponetdb/kernel'
import { AuthError } from './errors.ts'
import type { PendingDelivery } from './notifications.ts'
import type { SessionSecrets } from './sessions.ts'

/**
 * What a ceremony tells the HTTP layer besides its body: which cookies to
 * set or clear. Secrets travel only here, never in a response body (except
 * the values a contract shows once: recovery codes, the TOTP setup).
 */
export interface CookieInstructions {
  readonly session?: SessionSecrets | 'clear'
  readonly ceremony?: { readonly handle: string; readonly maxAgeSeconds: number } | 'clear'
}

/**
 * The result of a ceremony. A refusal is a value, not an exception, so the
 * transaction that counted the failure, consumed the challenge and wrote
 * the audit commits; the interface turns it into the problem response.
 */
export type Outcome<T> =
  | {
      readonly ok: true
      readonly value: T
      readonly cookies: CookieInstructions
      readonly deliveries: readonly (PendingDelivery | undefined)[]
    }
  | {
      readonly ok: false
      readonly error: AuthError
      readonly cookies: CookieInstructions
      readonly retryAfterSeconds?: number
      readonly deliveries: readonly (PendingDelivery | undefined)[]
    }

export function success<T>(
  value: T,
  cookies: CookieInstructions = {},
  deliveries: readonly (PendingDelivery | undefined)[] = [],
): Outcome<T> {
  return { ok: true, value, cookies, deliveries }
}

export function refusal<T>(
  error: AuthError | ConstructorParameters<typeof AuthError>[0],
  cookies: CookieInstructions = {},
  deliveries: readonly (PendingDelivery | undefined)[] = [],
): Outcome<T> {
  return {
    ok: false,
    error: error instanceof AuthError ? error : new AuthError(error),
    cookies,
    deliveries,
  }
}

export function rateLimited<T>(
  retryAfterSeconds: number,
  cookies: CookieInstructions = {},
): Outcome<T> {
  return {
    ok: false,
    error: new AuthError('RATE_LIMITED'),
    cookies,
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
    deliveries: [],
  }
}

/** The database clock in milliseconds (TOTP steps and every lifetime use the database clock). */
export async function databaseNowMs(q: Queryable): Promise<number> {
  const { rows } = await q.query(
    'auth.clock',
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms',
  )
  const now = rows[0]?.int('now_ms')
  if (now === undefined) {
    throw new AuthError('INTERNAL')
  }
  return now
}

/**
 * Records a re-authentication proof (identity.md §4): a passkey assertion
 * with user verification, a TOTP code or a recovery code. Never a password.
 * A sign-in records one before its session exists (`sessionId` null).
 */
export async function recordReauthEvent(
  tx: Tx,
  clock: Clock,
  input: {
    readonly identityId: IdentityId
    readonly sessionId: SessionId | null
    readonly method: 'passkey' | 'totp' | 'recovery_code'
    readonly factorId: AuthFactorId
  },
): Promise<ReauthEventId> {
  const reauthEventId = newId('rau', clock.nowMs())
  await tx.query(
    'auth.reauth_event.insert',
    `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, session_id, method, factor_id, user_verified)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      reauthEventId,
      input.identityId,
      input.sessionId,
      input.method,
      input.factorId,
      input.method === 'passkey',
    ],
  )
  return reauthEventId
}
