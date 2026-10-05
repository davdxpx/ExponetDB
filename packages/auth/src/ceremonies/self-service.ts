import type {
  CreationOptions,
  FactorView,
  RecoveryCodesView,
  RegistrationCredential,
  SessionView,
  TotpSetup,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { type AuthFactorId, newId, type SessionId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, humanActor, webClient } from '../audit.ts'
import { consumeChallenge, createChallenge, latestChallenge, usable } from '../challenges.ts'
import { checkPasswordPolicy, hashPassword } from '../credentials/password.ts'
import { registrationOptions, verifyRegistration } from '../credentials/webauthn.ts'
import type { AuthDeps, RequestMeta } from '../deps.ts'
import { AuthError } from '../errors.ts'
import { type FactorRecord, factorView, passkeyLabel, readFactors } from '../factors.ts'
import { type IdentityRecord, readIdentity } from '../identities.ts'
import { type PendingDelivery, recordNotification } from '../notifications.ts'
import { databaseNowMs, type Outcome, refusal, success } from '../outcome.ts'
import { descriptors } from '../passkeys.ts'
import { newPendingTotp, newRecoveryCodeSet, totpFactor, useTotp } from '../second-factors.ts'
import {
  listSessions,
  lockSession,
  revokeIdentitySessions,
  revokeSession,
  rotateSession,
  type SessionContext,
  type SessionSecrets,
} from '../sessions.ts'
import { insertPasskey, totpSetupView } from './enrollment.ts'
import { creationOptionsView, toRegistrationResponse } from './webauthn-json.ts'

/**
 * Self-service changes of the signed-in person's own factors and sessions
 * (identity.md §2, §3). Authorization (permission `self`, Web App only,
 * the 5-minute re-authentication window of consequential changes, the
 * restrictions of a recovery session) is decided by the central engine
 * before these run; each one re-locks the session and fails with
 * `SESSION_EXPIRED` if it ended meanwhile.
 *
 * - Removing a passkey, changing the password and replacing the TOTP
 *   authenticator end every other session of the person.
 * - A recovery (after a recovery-code sign-in) ends when the person has
 *   registered a new passkey and confirmed a new authenticator in this
 *   session: the session becomes a full one with new secrets, and every
 *   other session ends.
 * - Every change is audited and the person is notified.
 */
interface Change<T> {
  readonly value: T
  readonly rotated?: SessionSecrets
  readonly deliveries: readonly (PendingDelivery | undefined)[]
}

function withSession<T>(
  deps: AuthDeps,
  queryClass: string,
  session: SessionContext,
  fn: (tx: Tx, live: SessionContext, identity: IdentityRecord) => Promise<Change<T> | AuthError>,
): Promise<Outcome<T>> {
  return deps.store.transaction(queryClass, async (tx) => {
    const live = await lockSession(tx, session.sessionId)
    const identity =
      live === undefined ? undefined : await readIdentity(tx, live.identityId, { forUpdate: true })
    if (live === undefined || identity === undefined) {
      return refusal('SESSION_EXPIRED', { session: 'clear' })
    }
    const result = await fn(tx, live, identity)
    if (result instanceof AuthError) {
      return refusal(result)
    }
    return success(
      result.value,
      result.rotated === undefined ? {} : { session: result.rotated },
      result.deliveries,
    )
  })
}

async function audit(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  action: string,
  changes: Record<string, string | number | boolean>,
): Promise<void> {
  await appendAudit(
    tx,
    {
      action,
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      request: await auditRequest(deps.keys, meta),
      changes,
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
}

function notifyChange(
  tx: Tx,
  deps: AuthDeps,
  identity: IdentityRecord,
): Promise<PendingDelivery | undefined> {
  return recordNotification(tx, deps.channel, {
    kind: 'auth.factors_changed',
    recipientIdentityId: identity.identityId,
    to: identity.email,
  })
}

/**
 * Ends a recovery when this session has added a passkey and confirmed a
 * new authenticator since it began; returns the rotated secrets.
 */
async function finishRecovery(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  identity: IdentityRecord,
): Promise<SessionSecrets | undefined> {
  if (session.assurance !== 'recovery' && !identity.recoveryRequired) {
    return undefined
  }
  const { rows } = await tx.query(
    'auth.recovery.done',
    `SELECT EXISTS (SELECT FROM auth.factors f WHERE f.identity_id = s.identity_id AND f.kind = 'passkey'
                     AND f.state = 'active' AND f.created_at >= s.created_at)
        AND EXISTS (SELECT FROM auth.factors f WHERE f.identity_id = s.identity_id AND f.kind = 'totp'
                     AND f.state = 'active' AND f.created_at >= s.created_at) AS done
       FROM auth.web_sessions s WHERE s.session_id = $1`,
    [session.sessionId],
  )
  if (rows[0]?.bool('done') !== true) {
    return undefined
  }
  await tx.query(
    'auth.identity.recovered',
    'UPDATE auth.identities SET recovery_required = false WHERE identity_id = $1',
    [identity.identityId],
  )
  const rotated = await rotateSession(tx, session.sessionId, { assurance: 'full' })
  await revokeIdentitySessions(tx, identity.identityId, 'recovery', session.sessionId)
  await audit(tx, deps, meta, session, 'auth.recovery.complete', { assurance: 'full' })
  return { token: rotated.token, csrfToken: rotated.csrfToken }
}

export function passkeyOptions(
  deps: AuthDeps,
  session: SessionContext,
): Promise<Outcome<CreationOptions>> {
  return withSession(deps, 'auth.passkey.options', session, async (tx, live, identity) => {
    if (identity.webauthnUserHandle === null || identity.email === null) {
      return new AuthError('INTERNAL')
    }
    const options = await registrationOptions(deps.config, {
      handle: identity.webauthnUserHandle,
      name: identity.email,
      displayName: identity.displayName ?? identity.email,
      exclude: descriptors(await readFactors(tx, identity.identityId)),
    })
    await createChallenge(tx, deps.clock, {
      kind: 'passkey_registration',
      withHandle: false,
      identityId: identity.identityId,
      sessionId: live.sessionId,
      webauthnChallenge: options.challenge,
    })
    return { value: creationOptionsView(options), deliveries: [] }
  })
}

async function activeFactor(
  tx: Tx,
  identity: IdentityRecord,
  predicate: (f: FactorRecord) => boolean,
): Promise<FactorRecord | undefined> {
  return (await readFactors(tx, identity.identityId)).find(
    (f) => f.state === 'active' && predicate(f),
  )
}

export function addPasskey(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  credential: RegistrationCredential,
  label: string | undefined,
): Promise<Outcome<FactorView>> {
  return withSession(deps, 'auth.passkey.add', session, async (tx, live, identity) => {
    const challenge = usable(
      await latestChallenge(tx, 'passkey_registration', { sessionId: live.sessionId }),
    )
    if (challenge instanceof AuthError) {
      return challenge
    }
    await consumeChallenge(tx, challenge.challengeId)
    const registered =
      challenge.webauthnChallenge === null
        ? undefined
        : await verifyRegistration(
            deps.config,
            toRegistrationResponse(credential),
            challenge.webauthnChallenge,
          )
    const credentialId =
      registered === undefined
        ? undefined
        : Buffer.from(registered.credentialId).toString('base64url')
    if (
      registered === undefined ||
      credentialId === undefined ||
      !(await insertPasskey(tx, deps, {
        identityId: identity.identityId,
        state: 'active',
        label: passkeyLabel(label, live.deviceLabel),
        registered,
      }))
    ) {
      return new AuthError('AUTH_CHALLENGE_INVALID')
    }
    const factor = await activeFactor(
      tx,
      identity,
      (f) =>
        f.kind === 'passkey' &&
        f.credentialId !== null &&
        Buffer.from(f.credentialId).toString('base64url') === credentialId,
    )
    if (factor === undefined) {
      return new AuthError('INTERNAL')
    }
    await audit(tx, deps, meta, live, 'auth.passkey.add', { factorId: factor.factorId })
    const deliveries = [await notifyChange(tx, deps, identity)]
    const rotated = await finishRecovery(tx, deps, meta, live, identity)
    return { value: factorView(factor), deliveries, ...(rotated === undefined ? {} : { rotated }) }
  })
}

export function removePasskey(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  factorId: AuthFactorId,
): Promise<Outcome<{ readonly removed: true }>> {
  return withSession(deps, 'auth.passkey.remove', session, async (tx, live, identity) => {
    const passkeys = (await readFactors(tx, identity.identityId, { forUpdate: true })).filter(
      (f) => f.kind === 'passkey' && f.state === 'active',
    )
    if (!passkeys.some((f) => f.factorId === factorId)) {
      return new AuthError('NOT_FOUND')
    }
    if (passkeys.length <= 1) {
      return new AuthError('LAST_FACTOR')
    }
    await tx.query(
      'auth.passkey.remove',
      `DELETE FROM auth.factors WHERE factor_id = $1 AND identity_id = $2 AND kind = 'passkey'`,
      [factorId, identity.identityId],
    )
    const ended = await revokeIdentitySessions(
      tx,
      identity.identityId,
      'factors_changed',
      live.sessionId,
    )
    await audit(tx, deps, meta, live, 'auth.passkey.remove', { factorId, sessionsEnded: ended })
    return {
      value: { removed: true } as const,
      deliveries: [await notifyChange(tx, deps, identity)],
    }
  })
}

export async function changePassword(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  password: string,
): Promise<Outcome<FactorView>> {
  const email = await deps.store.query(
    'auth.identity.email',
    'SELECT email FROM auth.identities WHERE identity_id = $1',
    [session.identityId],
  )
  const policy = checkPasswordPolicy(password, email.rows[0]?.textOrNull('email') ?? undefined)
  if (!policy.ok) {
    return refusal(new AuthError('PASSWORD_REJECTED', { details: { reason: policy.reason } }))
  }
  // Argon2id outside the transaction: no connection is held while hashing.
  const hash = await hashPassword(password)
  return withSession(deps, 'auth.password.change', session, async (tx, live, identity) => {
    await tx.query(
      'auth.password.drop',
      `DELETE FROM auth.factors WHERE identity_id = $1 AND kind = 'password'`,
      [identity.identityId],
    )
    const factorId = newId('fac', deps.clock.nowMs())
    await tx.query(
      'auth.password.insert',
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state, password_hash)
       VALUES ($1, $2, 'password', 'active', $3)`,
      [factorId, identity.identityId, hash],
    )
    const factor = await activeFactor(tx, identity, (f) => f.factorId === factorId)
    if (factor === undefined) {
      return new AuthError('INTERNAL')
    }
    const ended = await revokeIdentitySessions(
      tx,
      identity.identityId,
      'factors_changed',
      live.sessionId,
    )
    await audit(tx, deps, meta, live, 'auth.password.change', { factorId, sessionsEnded: ended })
    return { value: factorView(factor), deliveries: [await notifyChange(tx, deps, identity)] }
  })
}

export function totpOptions(deps: AuthDeps, session: SessionContext): Promise<Outcome<TotpSetup>> {
  return withSession(deps, 'auth.totp.options', session, async (tx, _live, identity) => {
    if (identity.email === null) {
      return new AuthError('INTERNAL')
    }
    const { secret } = await newPendingTotp(tx, deps.keyring, deps.clock, identity.identityId)
    const view = totpSetupView(secret, identity.email)
    secret.fill(0)
    return { value: view, deliveries: [] }
  })
}

export function replaceTotp(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  code: string,
): Promise<Outcome<FactorView>> {
  return withSession(deps, 'auth.totp.replace', session, async (tx, live, identity) => {
    const pending = await totpFactor(tx, identity.identityId, 'pending')
    if (
      pending === undefined ||
      !(await useTotp(tx, deps.keyring, pending, code, await databaseNowMs(tx)))
    ) {
      return new AuthError('AUTH_CHALLENGE_INVALID')
    }
    await tx.query(
      'auth.totp.drop_active',
      `DELETE FROM auth.factors WHERE identity_id = $1 AND kind = 'totp' AND state = 'active'`,
      [identity.identityId],
    )
    await tx.query(
      'auth.totp.activate',
      `UPDATE auth.factors SET state = 'active' WHERE factor_id = $1 AND state = 'pending'`,
      [pending.factorId],
    )
    const factor = await activeFactor(tx, identity, (f) => f.factorId === pending.factorId)
    if (factor === undefined) {
      return new AuthError('INTERNAL')
    }
    const ended = await revokeIdentitySessions(
      tx,
      identity.identityId,
      'factors_changed',
      live.sessionId,
    )
    await audit(tx, deps, meta, live, 'auth.totp.replace', {
      factorId: factor.factorId,
      sessionsEnded: ended,
    })
    const deliveries = [await notifyChange(tx, deps, identity)]
    const rotated = await finishRecovery(tx, deps, meta, live, identity)
    return { value: factorView(factor), deliveries, ...(rotated === undefined ? {} : { rotated }) }
  })
}

export function regenerateRecoveryCodes(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
): Promise<Outcome<RecoveryCodesView>> {
  return withSession(
    deps,
    'auth.recovery_codes.regenerate',
    session,
    async (tx, live, identity) => {
      const recoveryCodes = await newRecoveryCodeSet(tx, deps.clock, identity.identityId)
      await audit(tx, deps, meta, live, 'auth.recovery_codes.regenerate', {
        codes: recoveryCodes.length,
      })
      return { value: { recoveryCodes }, deliveries: [await notifyChange(tx, deps, identity)] }
    },
  )
}

export function ownSessions(deps: AuthDeps, session: SessionContext): Promise<SessionView[]> {
  return listSessions(deps.store, session.identityId, session.sessionId)
}

export async function ownFactors(deps: AuthDeps, session: SessionContext): Promise<FactorView[]> {
  return (await readFactors(deps.store, session.identityId))
    .filter((f) => f.state === 'active')
    .map(factorView)
}

/** Revokes one own session; revoking the current one also clears the cookies. */
export function revokeOwnSession(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
  target: SessionId,
): Promise<Outcome<{ readonly revoked: number }>> {
  return deps.store.transaction('auth.session.revoke_own', async (tx) => {
    const revoked = await revokeSession(tx, target, session.identityId, 'self_revoked')
    if (!revoked) {
      return refusal('NOT_FOUND')
    }
    await audit(tx, deps, meta, session, 'auth.session.revoke', { sessionId: target })
    return success({ revoked: 1 }, target === session.sessionId ? { session: 'clear' } : {})
  })
}

export function revokeOtherSessions(
  deps: AuthDeps,
  meta: RequestMeta,
  session: SessionContext,
): Promise<Outcome<{ readonly revoked: number }>> {
  return deps.store.transaction('auth.session.revoke_others', async (tx) => {
    const revoked = await revokeIdentitySessions(
      tx,
      session.identityId,
      'others_revoked',
      session.sessionId,
    )
    await audit(tx, deps, meta, session, 'auth.session.revoke_others', { revoked })
    return success({ revoked })
  })
}
