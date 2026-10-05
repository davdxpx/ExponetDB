import type { AuthenticationCredential, ReauthResult, RequestOptions } from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import type { AuthFactorId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, humanActor, webClient } from '../audit.ts'
import { consumeChallenge, createChallenge, latestChallenge, usable } from '../challenges.ts'
import { authenticationOptions, verifyAssertion } from '../credentials/webauthn.ts'
import type { AuthDeps, RequestMeta } from '../deps.ts'
import { readFactors } from '../factors.ts'
import { countFailure } from '../failures.ts'
import { readIdentity } from '../identities.ts'
import {
  databaseNowMs,
  type Outcome,
  rateLimited,
  recordReauthEvent,
  refusal,
  success,
} from '../outcome.ts'
import { activePasskey, descriptors, recordPasskeyUse, storedPasskey } from '../passkeys.ts'
import { blockedFor, clearBuckets, identityBucket } from '../ratelimit.ts'
import { totpFactor, useTotp } from '../second-factors.ts'
import { lockSession, revokeSession, rotateSession, type SessionContext } from '../sessions.ts'
import { requestOptionsView, toAuthenticationResponse } from './webauthn-json.ts'

/**
 * Sign-out and re-authentication (identity.md §4). A re-authentication is
 * a fresh passkey assertion with user verification or a TOTP code, never a
 * password; it is recorded as a `reauth_events` row and attached to the
 * session, whose secrets rotate in the same transaction. The time of the
 * proof is the database time of that row; windows are compared by the
 * central authorization engine, never here.
 */
export async function logout(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
): Promise<Outcome<{ readonly signedOut: true }>> {
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction('auth.logout', async (tx) => {
    await revokeSession(tx, session.sessionId, session.identityId, 'logout')
    await appendAudit(
      tx,
      {
        action: 'auth.logout',
        phase: 'completed',
        actor: humanActor(session),
        client: webClient(session.sessionId),
        request,
        result: { status: 'succeeded' },
      },
      deps.clock,
    )
    return success({ signedOut: true } as const, { session: 'clear', ceremony: 'clear' })
  })
}

export async function startPasskeyReauth(
  deps: AuthDeps,
  session: SessionContext,
): Promise<Outcome<RequestOptions>> {
  return deps.store.transaction('auth.reauth.passkey_options', async (tx) => {
    const live = await lockSession(tx, session.sessionId)
    if (live === undefined) {
      return refusal('SESSION_EXPIRED', { session: 'clear' })
    }
    const factors = (await readFactors(tx, session.identityId)).filter((f) => f.state === 'active')
    const options = await authenticationOptions(deps.config, descriptors(factors))
    await createChallenge(tx, deps.clock, {
      kind: 'passkey_reauth',
      withHandle: false,
      identityId: session.identityId,
      sessionId: session.sessionId,
      webauthnChallenge: options.challenge,
    })
    return success(requestOptionsView(options))
  })
}

async function completeReauth(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  method: 'passkey' | 'totp',
  factorId: AuthFactorId,
  tx: Tx,
): Promise<Outcome<ReauthResult>> {
  const reauthEventId = await recordReauthEvent(tx, deps.clock, {
    identityId: session.identityId,
    sessionId: session.sessionId,
    method,
    factorId,
  })
  const rotated = await rotateSession(tx, session.sessionId, { reauthEventId })
  await clearBuckets(tx, [identityBucket(session.identityId)])
  await appendAudit(
    tx,
    {
      action: 'auth.reauth',
      phase: 'completed',
      actor: humanActor(session, rotated.reauthAt),
      client: webClient(session.sessionId),
      request: await auditRequest(deps.keys, meta),
      changes: { method },
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
  if (rotated.reauthAt === null) {
    return refusal('INTERNAL')
  }
  return success(
    { reauthAt: rotated.reauthAt, method },
    { session: { token: rotated.token, csrfToken: rotated.csrfToken } },
  )
}

export async function finishPasskeyReauth(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  credential: AuthenticationCredential,
): Promise<Outcome<ReauthResult>> {
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction('auth.reauth.passkey', async (tx) => {
    const live = await lockSession(tx, session.sessionId)
    if (live === undefined) {
      return refusal('SESSION_EXPIRED', { session: 'clear' })
    }
    const bucket = identityBucket(session.identityId)
    const wait = await blockedFor(tx, [bucket])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const challenge = usable(
      await latestChallenge(tx, 'passkey_reauth', { sessionId: session.sessionId }),
    )
    if (!('challengeId' in challenge)) {
      return refusal(challenge)
    }
    await consumeChallenge(tx, challenge.challengeId)
    const identity = await readIdentity(tx, session.identityId)
    const factor = await activePasskey(tx, credential.id, session.identityId)
    const stored = factor === undefined ? undefined : storedPasskey(factor)
    const userHandle = identity?.webauthnUserHandle ?? null
    const verified =
      stored === undefined || userHandle === null || challenge.webauthnChallenge === null
        ? undefined
        : await verifyAssertion(
            deps.config,
            toAuthenticationResponse(credential),
            challenge.webauthnChallenge,
            stored,
            { userHandle, requireUserHandle: false },
          )
    if (factor === undefined || verified === undefined) {
      const deliveries = await countFailure(tx, deps, request, 'auth.reauth', [bucket], {
        identityId: session.identityId,
        email: identity?.email ?? null,
      })
      return refusal('AUTH_CHALLENGE_INVALID', {}, deliveries)
    }
    await recordPasskeyUse(tx, factor, verified)
    return completeReauth(deps, meta, session, 'passkey', factor.factorId, tx)
  })
}

export async function totpReauth(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  code: string,
): Promise<Outcome<ReauthResult>> {
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction('auth.reauth.totp', async (tx) => {
    const live = await lockSession(tx, session.sessionId)
    if (live === undefined) {
      return refusal('SESSION_EXPIRED', { session: 'clear' })
    }
    const bucket = identityBucket(session.identityId)
    const wait = await blockedFor(tx, [bucket])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const factor = await totpFactor(tx, session.identityId, 'active')
    const ok =
      factor !== undefined &&
      (await useTotp(tx, deps.keyring, factor, code, await databaseNowMs(tx)))
    if (factor === undefined || !ok) {
      const identity = await readIdentity(tx, session.identityId)
      const deliveries = await countFailure(tx, deps, request, 'auth.reauth', [bucket], {
        identityId: session.identityId,
        email: identity?.email ?? null,
      })
      return refusal('AUTHENTICATION_FAILED', {}, deliveries)
    }
    return completeReauth(deps, meta, session, 'totp', factor.factorId, tx)
  })
}
