import type {
  AuthenticationCredential,
  RequestOptions,
  SecondFactorStep,
  SignedIn,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { type AuthFactorId, newId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, humanActor, webClient } from '../audit.ts'
import { challengeByHandle, consumeChallenge, createChallenge } from '../challenges.ts'
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '../credentials/password.ts'
import { authenticationOptions, verifyAssertion } from '../credentials/webauthn.ts'
import type { AuthDeps, RequestMeta } from '../deps.ts'
import { countFailure } from '../failures.ts'
import {
  IDENTITY_COLUMNS,
  type IdentityRecord,
  identityFromRow,
  normalizeEmail,
  readIdentity,
} from '../identities.ts'
import { type PendingDelivery, recordNotification } from '../notifications.ts'
import {
  databaseNowMs,
  type Outcome,
  rateLimited,
  recordReauthEvent,
  refusal,
  success,
} from '../outcome.ts'
import { activePasskey, recordPasskeyUse, storedPasskey } from '../passkeys.ts'
import {
  accountBucket,
  blockedFor,
  clearBuckets,
  clientBucket,
  identityBucket,
} from '../ratelimit.ts'
import { totpFactor, useRecoveryCode, useTotp } from '../second-factors.ts'
import { issueSession, revokeIdentitySessions, type SessionAssurance } from '../sessions.ts'
import { newToken } from '../tokens.ts'
import { requestOptionsView, toAuthenticationResponse } from './webauthn-json.ts'

/**
 * Sign-in ceremonies (identity.md §2, §8).
 *
 * Passkey: discoverable credentials and no account in the options, so the
 * options reveal nothing; the assertion must carry the owning identity's
 * user handle. Password: the first step answers identically for an
 * unknown address, a wrong password, a disabled identity and a correct
 * password (a decoy ceremony handle that is never stored stands in), and
 * spends the same Argon2id work; only the second step (TOTP or recovery
 * code) can succeed, and every second-step failure, including an expired
 * or decoy ceremony and a locked identity, is the same
 * `AUTHENTICATION_FAILED`. Every failure is counted per account address,
 * client address and, once known, identity.
 */
export const CEREMONY_COOKIE_SECONDS = 300

function signedIn(
  identity: IdentityRecord,
  sessionId: SignedIn['sessionId'],
  assurance: SessionAssurance,
  recoveryRequired: boolean,
): SignedIn {
  return {
    identityId: identity.identityId,
    label: identity.label,
    sessionId,
    assurance,
    recoveryRequired,
  }
}

async function auditSignIn(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  identity: IdentityRecord,
  sessionId: SignedIn['sessionId'],
  method: 'passkey' | 'totp' | 'recovery_code',
): Promise<void> {
  await appendAudit(
    tx,
    {
      action: 'auth.login',
      phase: 'completed',
      actor: humanActor(identity),
      client: webClient(sessionId),
      request: await auditRequest(deps.keys, meta),
      changes: { method },
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
}

export async function startPasskeyLogin(
  deps: AuthDeps,
  meta: RequestMeta,
): Promise<Outcome<RequestOptions>> {
  const ip = await clientBucket(deps.keys, meta.clientIp)
  return deps.store.transaction('auth.login.passkey_options', async (tx) => {
    const wait = await blockedFor(tx, [ip])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const options = await authenticationOptions(deps.config)
    const { handle } = await createChallenge(tx, deps.clock, {
      kind: 'passkey_login',
      withHandle: true,
      webauthnChallenge: options.challenge,
    })
    if (handle === undefined) {
      return refusal('INTERNAL')
    }
    return success(requestOptionsView(options), {
      ceremony: { handle, maxAgeSeconds: CEREMONY_COOKIE_SECONDS },
    })
  })
}

export async function finishPasskeyLogin(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
  credential: AuthenticationCredential,
): Promise<Outcome<SignedIn>> {
  const ip = await clientBucket(deps.keys, meta.clientIp)
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction('auth.login.passkey', async (tx) => {
    const wait = await blockedFor(tx, [ip])
    if (wait > 0) {
      return rateLimited(wait, { ceremony: 'clear' })
    }
    const fail = async (
      code: 'AUTHENTICATION_FAILED' | 'AUTH_CHALLENGE_EXPIRED' | 'AUTH_CHALLENGE_INVALID',
      identity?: IdentityRecord,
    ): Promise<Outcome<SignedIn>> => {
      const deliveries = await countFailure(
        tx,
        deps,
        request,
        'auth.login',
        identity === undefined ? [ip] : [ip, identityBucket(identity.identityId)],
        identity,
      )
      return refusal(code, { ceremony: 'clear' }, deliveries)
    }
    const challenge = await challengeByHandle(tx, ['passkey_login'], handle)
    if (challenge === undefined || challenge.consumed) {
      return fail('AUTH_CHALLENGE_INVALID')
    }
    await consumeChallenge(tx, challenge.challengeId)
    if (challenge.expired || challenge.webauthnChallenge === null) {
      return fail('AUTH_CHALLENGE_EXPIRED')
    }
    const factor = await activePasskey(tx, credential.id)
    const identity =
      factor === undefined
        ? undefined
        : await readIdentity(tx, factor.identityId, { forUpdate: true })
    const stored = factor === undefined ? undefined : storedPasskey(factor)
    if (
      factor === undefined ||
      stored === undefined ||
      identity === undefined ||
      identity.state !== 'active' ||
      identity.webauthnUserHandle === null
    ) {
      return fail('AUTHENTICATION_FAILED')
    }
    if ((await blockedFor(tx, [identityBucket(identity.identityId)])) > 0) {
      return fail('AUTHENTICATION_FAILED')
    }
    const verified = await verifyAssertion(
      deps.config,
      toAuthenticationResponse(credential),
      challenge.webauthnChallenge,
      stored,
      { userHandle: identity.webauthnUserHandle, requireUserHandle: true },
    )
    if (verified === undefined) {
      return fail('AUTHENTICATION_FAILED', identity)
    }
    await recordPasskeyUse(tx, factor, verified)
    const reauthEventId = await recordReauthEvent(tx, deps.clock, {
      identityId: identity.identityId,
      sessionId: null,
      method: 'passkey',
      factorId: factor.factorId,
    })
    const session = await issueSession(tx, deps.clock, {
      identityId: identity.identityId,
      assurance: 'full',
      reauthEventId,
      userAgent: meta.userAgent,
    })
    await clearBuckets(tx, [identityBucket(identity.identityId)])
    await auditSignIn(tx, deps, meta, identity, session.sessionId, 'passkey')
    return success(signedIn(identity, session.sessionId, 'full', identity.recoveryRequired), {
      session: session.secrets,
      ceremony: 'clear',
    })
  })
}

/**
 * First step of the fallback. The response is the same in every case; the
 * ceremony cookie holds a real handle only when the address belongs to an
 * active person with a password and TOTP and the password is right.
 */
export async function passwordLogin(
  deps: AuthDeps,
  meta: RequestMeta,
  email: string,
  password: string,
): Promise<Outcome<SecondFactorStep>> {
  const normalized = normalizeEmail(email)
  const account = await accountBucket(deps.keys, normalized)
  const ip = await clientBucket(deps.keys, meta.clientIp)
  const request = await auditRequest(deps.keys, meta)
  const wait = await blockedFor(deps.store, [account, ip])
  if (wait > 0) {
    return rateLimited(wait)
  }
  const { rows } = await deps.store.query(
    'auth.login.password_candidate',
    `SELECT ${IDENTITY_COLUMNS}, p.factor_id AS password_factor_id, p.password_hash
       FROM auth.identities i
       JOIN auth.factors p ON p.identity_id = i.identity_id AND p.kind = 'password' AND p.state = 'active'
      WHERE i.email_normalized = $1 AND i.state = 'active' AND i.kind = 'human'
        AND EXISTS (SELECT FROM auth.factors t WHERE t.identity_id = i.identity_id
                     AND t.kind = 'totp' AND t.state = 'active')`,
    [normalized],
  )
  const row = rows[0]
  const candidate =
    row === undefined
      ? undefined
      : {
          identity: identityFromRow(row),
          factorId: row.text('password_factor_id'),
          hash: row.text('password_hash'),
        }
  // Argon2id runs outside any transaction: no connection is held while hashing.
  const correct =
    candidate === undefined
      ? await dummyVerify(password)
      : await verifyPassword(candidate.hash, password)
  const rehash = correct && candidate !== undefined && needsRehash(candidate.hash)
  const newHash = rehash ? await hashPassword(password) : undefined
  const step: SecondFactorStep = { next: 'second_factor', methods: ['totp', 'recovery_code'] }
  return deps.store.transaction('auth.login.password', async (tx) => {
    if (!correct || candidate === undefined) {
      const deliveries = await countFailure(tx, deps, request, 'auth.login', [account, ip])
      return success(
        step,
        {
          ceremony: { handle: newToken('ceremony'), maxAgeSeconds: CEREMONY_COOKIE_SECONDS },
        },
        deliveries,
      )
    }
    const still = await tx.query(
      'auth.login.password_recheck',
      `SELECT 1 FROM auth.factors f JOIN auth.identities i USING (identity_id)
        WHERE f.factor_id = $1 AND f.state = 'active' AND i.state = 'active' FOR UPDATE OF f`,
      [candidate.factorId],
    )
    if (still.rows.length === 0) {
      return success(step, {
        ceremony: { handle: newToken('ceremony'), maxAgeSeconds: CEREMONY_COOKIE_SECONDS },
      })
    }
    if (newHash !== undefined) {
      await tx.query('auth.password.rehash_drop', 'DELETE FROM auth.factors WHERE factor_id = $1', [
        candidate.factorId,
      ])
      await tx.query(
        'auth.password.rehash_insert',
        `INSERT INTO auth.factors (factor_id, identity_id, kind, state, password_hash)
         VALUES ($1, $2, 'password', 'active', $3)`,
        [newId('fac', deps.clock.nowMs()), candidate.identity.identityId, newHash],
      )
    }
    const { handle } = await createChallenge(tx, deps.clock, {
      kind: 'second_factor',
      withHandle: true,
      identityId: candidate.identity.identityId,
    })
    return success(step, {
      ceremony: {
        handle: handle ?? newToken('ceremony'),
        maxAgeSeconds: CEREMONY_COOKIE_SECONDS,
      },
    })
  })
}

async function secondFactor(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
  method: 'totp' | 'recovery_code',
  code: string,
): Promise<Outcome<SignedIn>> {
  const ip = await clientBucket(deps.keys, meta.clientIp)
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction(`auth.login.${method}`, async (tx) => {
    const wait = await blockedFor(tx, [ip])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const challenge = await challengeByHandle(tx, ['second_factor'], handle)
    const identity =
      challenge?.identityId === null || challenge === undefined
        ? undefined
        : await readIdentity(tx, challenge.identityId, { forUpdate: true })
    const fail = async (known?: IdentityRecord): Promise<Outcome<SignedIn>> => {
      const deliveries = await countFailure(
        tx,
        deps,
        request,
        'auth.login',
        known === undefined ? [ip] : [ip, identityBucket(known.identityId)],
        known,
      )
      return refusal('AUTHENTICATION_FAILED', {}, deliveries)
    }
    if (
      challenge === undefined ||
      challenge.consumed ||
      challenge.expired ||
      identity === undefined ||
      identity.state !== 'active'
    ) {
      return fail()
    }
    // A locked identity fails like a wrong code: a distinct answer would confirm the password.
    if ((await blockedFor(tx, [identityBucket(identity.identityId)])) > 0) {
      return fail()
    }
    let factorId: AuthFactorId | undefined
    if (method === 'totp') {
      const totp = await totpFactor(tx, identity.identityId, 'active')
      const nowMs = await databaseNowMs(tx)
      factorId =
        totp !== undefined && (await useTotp(tx, deps.keyring, totp, code, nowMs))
          ? totp.factorId
          : undefined
    } else {
      factorId = await useRecoveryCode(tx, identity.identityId, code)
    }
    if (factorId === undefined) {
      return fail(identity)
    }
    await consumeChallenge(tx, challenge.challengeId)
    const recovery = method === 'recovery_code'
    const deliveries: (PendingDelivery | undefined)[] = []
    if (recovery) {
      await tx.query(
        'auth.identity.recovery_required',
        'UPDATE auth.identities SET recovery_required = true WHERE identity_id = $1',
        [identity.identityId],
      )
      await revokeIdentitySessions(tx, identity.identityId, 'recovery')
      deliveries.push(
        await recordNotification(tx, deps.channel, {
          kind: 'auth.recovery_code_used',
          recipientIdentityId: identity.identityId,
          to: identity.email,
        }),
      )
    }
    const reauthEventId = await recordReauthEvent(tx, deps.clock, {
      identityId: identity.identityId,
      sessionId: null,
      method,
      factorId,
    })
    const assurance: SessionAssurance = recovery ? 'recovery' : 'full'
    const session = await issueSession(tx, deps.clock, {
      identityId: identity.identityId,
      assurance,
      // A recovery session's proof is the recovery code: the authorization engine
      // counts it only for setting up new factors (sessions.ts, reauthMethod).
      reauthEventId,
      userAgent: meta.userAgent,
    })
    const buckets = [identityBucket(identity.identityId)]
    if (identity.email !== null) {
      buckets.push(await accountBucket(deps.keys, normalizeEmail(identity.email)))
    }
    await clearBuckets(tx, buckets)
    await auditSignIn(tx, deps, meta, identity, session.sessionId, method)
    return success(
      signedIn(identity, session.sessionId, assurance, recovery || identity.recoveryRequired),
      { session: session.secrets, ceremony: 'clear' },
      deliveries,
    )
  })
}

export function totpLogin(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
  code: string,
): Promise<Outcome<SignedIn>> {
  return secondFactor(deps, meta, handle, 'totp', code)
}

export function recoveryCodeLogin(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
  code: string,
): Promise<Outcome<SignedIn>> {
  return secondFactor(deps, meta, handle, 'recovery_code', code)
}
