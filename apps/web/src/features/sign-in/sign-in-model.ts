import type { SecondFactorStep } from '@exponetdb/contracts'
import { DEFAULT_RETURN, safeReturnTo } from '../../lib/navigation/links.ts'

/**
 * The decisions of the sign-in page, as pure functions: where a sign-in
 * leads and which second-step forms the server's answer offers.
 */

/** What decides where a person goes after signing in (a `SignedIn` answer or the session of `Me`). */
export interface SessionKind {
  readonly assurance: 'full' | 'recovery'
  readonly recoveryRequired: boolean
}

/**
 * Where to go after signing in: a recovery session always to the account
 * page (it may only replace factors there); otherwise the requested
 * `returnTo` when it is on the exact allowlist (`safeReturnTo`), else the
 * account page. The server never sees or interprets `returnTo`.
 */
export function afterSignIn(session: SessionKind, returnTo: string | null): string {
  if (session.assurance === 'recovery' || session.recoveryRequired) return DEFAULT_RETURN
  return safeReturnTo(returnTo)
}

/** The `returnTo` of the sign-in page's query string, as typed (still untrusted). */
export function returnToOf(search: string): string | null {
  return new URLSearchParams(search).get('returnTo')
}

/** The second-step forms the answer to the password step offers. */
export function secondFactorForms(step: SecondFactorStep): {
  readonly totp: boolean
  readonly recoveryCode: boolean
} {
  return {
    totp: step.methods.includes('totp'),
    recoveryCode: step.methods.includes('recovery_code'),
  }
}
