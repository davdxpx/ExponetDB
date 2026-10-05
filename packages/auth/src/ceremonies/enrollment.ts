import type {
  CreationOptions,
  EnrollmentComplete,
  EnrollmentState,
  RegistrationCredential,
  TotpSetup,
} from '@exponetdb/contracts'
import { ControlStoreError, type Tx } from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, humanActor, webClient } from '../audit.ts'
import {
  type ChallengeRecord,
  challengeByHandle,
  consumeChallenge,
  createChallenge,
  latestChallenge,
  usable,
} from '../challenges.ts'
import { checkPasswordPolicy, hashPassword } from '../credentials/password.ts'
import { qrMatrix, totpBase32, totpUri } from '../credentials/totp.ts'
import { registrationOptions, verifyRegistration } from '../credentials/webauthn.ts'
import type { AuthDeps, RequestMeta } from '../deps.ts'
import { AuthError } from '../errors.ts'
import { passkeyLabel, readFactors } from '../factors.ts'
import { countFailure } from '../failures.ts'
import { type IdentityRecord, readIdentity } from '../identities.ts'
import { type LinkKind, linkByToken, redeemLink } from '../links.ts'
import { type PendingDelivery, recordNotification } from '../notifications.ts'
import { databaseNowMs, type Outcome, rateLimited, refusal, success } from '../outcome.ts'
import { credentialIdBytes, descriptors } from '../passkeys.ts'
import { blockedFor, clientBucket, identityBucket } from '../ratelimit.ts'
import { newPendingTotp, newRecoveryCodeSet, totpFactor, useTotp } from '../second-factors.ts'
import { issueSession, revokeIdentitySessions } from '../sessions.ts'
import { creationOptionsView, toRegistrationResponse } from './webauthn-json.ts'

/**
 * Enrollment through a one-time link (identity.md §6, bootstrap.md §3):
 * the first owner (`setup`), an invited person (`invitation`) or the last
 * owner after out-of-band recovery (`recovery`).
 *
 * Redeeming consumes the link at once (single use) and opens a 30-minute
 * enrollment ceremony held by the ceremony cookie. The person registers a
 * passkey (user verification required), sets the fallback password and
 * confirms a TOTP authenticator; all three stay `pending` until
 * completion, which activates them together, creates ten recovery codes
 * (shown once) and opens a session. Nothing is active before everything
 * is in place. A first owner becomes the owner only through the Control
 * Store's `auth.activate_bootstrap_owner`, which re-checks every
 * precondition under the owner lock; an invited person gets no role.
 * A recovery replaces every factor of the identity: the old ones are
 * deleted and its sessions end when the link is redeemed.
 */
export const ENROLLMENT_COOKIE_SECONDS = 30 * 60

const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])

interface EnrollmentContext {
  readonly challenge: ChallengeRecord
  readonly identity: IdentityRecord
  readonly kind: LinkKind
  readonly email: string
}

async function enrollmentContext(
  tx: Tx,
  handle: string | undefined,
): Promise<EnrollmentContext | AuthError> {
  const challenge = usable(await challengeByHandle(tx, ['enrollment'], handle))
  if (challenge instanceof AuthError) {
    return challenge
  }
  if (challenge.identityId === null || challenge.capabilityId === null) {
    return new AuthError('AUTH_CHALLENGE_INVALID')
  }
  // Only the newest link of its kind may complete: a re-issue ends older ones.
  const { rows } = await tx.query(
    'auth.enrollment.link_kind',
    `SELECT c.kind FROM auth.capabilities c
      WHERE c.capability_id = $1
        AND NOT EXISTS (SELECT 1 FROM auth.capabilities n
                         WHERE n.identity_id = c.identity_id AND n.kind = c.kind
                           AND (n.created_at, n.capability_id) > (c.created_at, c.capability_id))`,
    [challenge.capabilityId],
  )
  const kindText = rows[0]?.text('kind')
  const kind = (['setup', 'invitation', 'recovery'] as const).find((k) => k === kindText)
  const identity = await readIdentity(tx, challenge.identityId, { forUpdate: true })
  if (
    kind === undefined ||
    identity === undefined ||
    identity.email === null ||
    identity.state !== (kind === 'recovery' ? 'active' : 'invited')
  ) {
    return new AuthError('LINK_INVALID')
  }
  return { challenge, identity, kind, email: identity.email }
}

async function enrollmentState(tx: Tx, context: EnrollmentContext): Promise<EnrollmentState> {
  const pending = (await readFactors(tx, context.identity.identityId)).filter(
    (f) => f.state === 'pending',
  )
  return {
    kind: context.kind,
    email: context.email,
    expiresAt: context.challenge.expiresAt,
    steps: {
      passkey: pending.some((f) => f.kind === 'passkey'),
      password: pending.some((f) => f.kind === 'password'),
      totp: pending.some((f) => f.kind === 'totp' && f.totpLastStep !== null),
    },
    complete: false,
  }
}

function inContext<T>(
  deps: AuthDeps,
  queryClass: string,
  handle: string | undefined,
  fn: (tx: Tx, context: EnrollmentContext) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  return deps.store.transaction(queryClass, async (tx) => {
    const context = await enrollmentContext(tx, handle)
    if (context instanceof AuthError) {
      return refusal(context, { ceremony: 'clear' })
    }
    return fn(tx, context)
  })
}

export async function redeem(
  deps: AuthDeps,
  meta: RequestMeta,
  token: string,
): Promise<Outcome<EnrollmentState>> {
  const ip = await clientBucket(deps.keys, meta.clientIp)
  const request = await auditRequest(deps.keys, meta)
  return deps.store.transaction('auth.enrollment.redeem', async (tx) => {
    const wait = await blockedFor(tx, [ip])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const invalid = async (): Promise<Outcome<EnrollmentState>> => {
      const deliveries = await countFailure(tx, deps, request, 'auth.enrollment', [ip])
      return refusal('LINK_INVALID', { ceremony: 'clear' }, deliveries)
    }
    const link = await linkByToken(tx, token)
    if (link === undefined || !link.live) {
      return invalid()
    }
    const identity = await readIdentity(tx, link.identityId, { forUpdate: true })
    if (
      identity === undefined ||
      identity.kind !== 'human' ||
      identity.email === null ||
      identity.state !== (link.kind === 'recovery' ? 'active' : 'invited') ||
      (link.kind === 'setup' && !identity.bootstrap)
    ) {
      return invalid()
    }
    if (!(await redeemLink(tx, link.capabilityId))) {
      return invalid()
    }
    await tx.query(
      'auth.enrollment.close_earlier',
      `UPDATE auth.challenges SET consumed_at = clock_timestamp()
        WHERE identity_id = $1 AND kind = 'enrollment' AND consumed_at IS NULL`,
      [identity.identityId],
    )
    if (link.kind === 'recovery') {
      await revokeIdentitySessions(tx, identity.identityId, 'out_of_band_recovery')
      await tx.query(
        'auth.identity.bump_epoch',
        'UPDATE auth.identities SET session_epoch = session_epoch + 1 WHERE identity_id = $1',
        [identity.identityId],
      )
      await tx.query('auth.factor.drop_all', 'DELETE FROM auth.factors WHERE identity_id = $1', [
        identity.identityId,
      ])
    } else {
      await tx.query(
        'auth.factor.drop_pending',
        `DELETE FROM auth.factors WHERE identity_id = $1 AND state = 'pending'`,
        [identity.identityId],
      )
    }
    const { challenge, handle } = await createChallenge(tx, deps.clock, {
      kind: 'enrollment',
      withHandle: true,
      identityId: identity.identityId,
      capabilityId: link.capabilityId,
    })
    if (handle === undefined) {
      return refusal('INTERNAL')
    }
    await appendAudit(
      tx,
      {
        action: 'auth.enrollment.redeem',
        phase: 'completed',
        actor: humanActor(identity),
        client: webClient(null),
        request,
        changes: { link: link.kind },
        result: { status: 'succeeded' },
      },
      deps.clock,
    )
    const state = await enrollmentState(tx, {
      challenge,
      identity,
      kind: link.kind,
      email: identity.email,
    })
    return success(state, { ceremony: { handle, maxAgeSeconds: ENROLLMENT_COOKIE_SECONDS } })
  })
}

export function passkeyOptions(
  deps: AuthDeps,
  handle: string | undefined,
): Promise<Outcome<CreationOptions>> {
  return inContext(deps, 'auth.enrollment.passkey_options', handle, async (tx, context) => {
    const handleBytes = context.identity.webauthnUserHandle
    if (handleBytes === null) {
      return refusal('LINK_INVALID', { ceremony: 'clear' })
    }
    const factors = await readFactors(tx, context.identity.identityId)
    const options = await registrationOptions(deps.config, {
      handle: handleBytes,
      name: context.email,
      displayName: context.identity.displayName ?? context.email,
      exclude: descriptors(factors),
    })
    await createChallenge(tx, deps.clock, {
      kind: 'passkey_registration',
      withHandle: false,
      identityId: context.identity.identityId,
      parentChallengeId: context.challenge.challengeId,
      webauthnChallenge: options.challenge,
    })
    return success(creationOptionsView(options))
  })
}

/** Stores a verified registration as a factor; false when the credential is already registered. */
export async function insertPasskey(
  tx: Tx,
  deps: AuthDeps,
  input: {
    readonly identityId: IdentityRecord['identityId']
    readonly state: 'pending' | 'active'
    readonly label: string
    readonly registered: NonNullable<Awaited<ReturnType<typeof verifyRegistration>>>
  },
): Promise<boolean> {
  const credentialId = Buffer.from(input.registered.credentialId)
  if (credentialIdBytes(credentialId.toString('base64url')) === undefined) {
    return false
  }
  const taken = await tx.query(
    'auth.passkey.taken',
    'SELECT 1 FROM auth.factors WHERE credential_id = $1',
    [credentialId],
  )
  if (taken.rows.length > 0) {
    return false
  }
  const factorId = newId('fac', deps.clock.nowMs())
  await tx.query(
    'auth.passkey.insert',
    `INSERT INTO auth.factors (factor_id, identity_id, kind, state, label, credential_id, public_key,
                               sign_count, transports, backed_up, device_type)
     VALUES ($1, $2, 'passkey', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      factorId,
      input.identityId,
      input.state,
      input.label,
      credentialId,
      Buffer.from(input.registered.publicKey),
      input.registered.counter,
      input.registered.transports.filter((t) => TRANSPORTS.has(t)).slice(0, 8),
      input.registered.backedUp,
      input.registered.deviceType,
    ],
  )
  return true
}

export function passkey(
  deps: AuthDeps,
  handle: string | undefined,
  credential: RegistrationCredential,
  label: string | undefined,
): Promise<Outcome<EnrollmentState>> {
  return inContext(deps, 'auth.enrollment.passkey', handle, async (tx, context) => {
    const registration = usable(
      await latestChallenge(tx, 'passkey_registration', {
        parentChallengeId: context.challenge.challengeId,
      }),
    )
    if (registration instanceof AuthError) {
      return refusal(registration)
    }
    await consumeChallenge(tx, registration.challengeId)
    const registered =
      registration.webauthnChallenge === null
        ? undefined
        : await verifyRegistration(
            deps.config,
            toRegistrationResponse(credential),
            registration.webauthnChallenge,
          )
    if (
      registered === undefined ||
      !(await insertPasskey(tx, deps, {
        identityId: context.identity.identityId,
        state: 'pending',
        label: passkeyLabel(label, 'Passkey'),
        registered,
      }))
    ) {
      return refusal('AUTH_CHALLENGE_INVALID')
    }
    return success(await enrollmentState(tx, context))
  })
}

export async function password(
  deps: AuthDeps,
  handle: string | undefined,
  newPassword: string,
): Promise<Outcome<EnrollmentState>> {
  // Policy and Argon2id run outside a transaction; the second transaction re-checks the ceremony.
  const email = await deps.store.transaction('auth.enrollment.password_check', async (tx) => {
    const context = await enrollmentContext(tx, handle)
    return context instanceof AuthError ? context : context.email
  })
  if (email instanceof AuthError) {
    return refusal(email, { ceremony: 'clear' })
  }
  const policy = checkPasswordPolicy(newPassword, email)
  if (!policy.ok) {
    return refusal(new AuthError('PASSWORD_REJECTED', { details: { reason: policy.reason } }))
  }
  const hash = await hashPassword(newPassword)
  return inContext(deps, 'auth.enrollment.password', handle, async (tx, context) => {
    await tx.query(
      'auth.password.drop_pending',
      `DELETE FROM auth.factors WHERE identity_id = $1 AND kind = 'password' AND state = 'pending'`,
      [context.identity.identityId],
    )
    await tx.query(
      'auth.password.insert',
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state, password_hash)
       VALUES ($1, $2, 'password', 'pending', $3)`,
      [newId('fac', deps.clock.nowMs()), context.identity.identityId, hash],
    )
    return success(await enrollmentState(tx, context))
  })
}

/** A TOTP setup: the secret-bearing URI and the QR matrix, shown once. */
export function totpSetupView(secret: Uint8Array, accountName: string): TotpSetup {
  const uri = totpUri(secret, accountName)
  return { otpauthUri: uri, secret: totpBase32(secret), qr: qrMatrix(uri) }
}

export function totpOptions(
  deps: AuthDeps,
  handle: string | undefined,
): Promise<Outcome<TotpSetup>> {
  return inContext(deps, 'auth.enrollment.totp_options', handle, async (tx, context) => {
    const { secret } = await newPendingTotp(
      tx,
      deps.keyring,
      deps.clock,
      context.identity.identityId,
    )
    const view = totpSetupView(secret, context.email)
    secret.fill(0)
    return success(view)
  })
}

export async function totp(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
  code: string,
): Promise<Outcome<EnrollmentState>> {
  const request = await auditRequest(deps.keys, meta)
  return inContext(deps, 'auth.enrollment.totp', handle, async (tx, context) => {
    const bucket = identityBucket(context.identity.identityId)
    const wait = await blockedFor(tx, [bucket])
    if (wait > 0) {
      return rateLimited(wait)
    }
    const factor = await totpFactor(tx, context.identity.identityId, 'pending')
    if (factor === undefined) {
      return refusal('ENROLLMENT_INCOMPLETE')
    }
    if (!(await useTotp(tx, deps.keyring, factor, code, await databaseNowMs(tx)))) {
      const deliveries = await countFailure(tx, deps, request, 'auth.enrollment', [bucket], {
        identityId: context.identity.identityId,
        email: context.email,
      })
      return refusal('AUTHENTICATION_FAILED', {}, deliveries)
    }
    return success(await enrollmentState(tx, context))
  })
}

function sqlstate(error: unknown): string | undefined {
  return error instanceof ControlStoreError ? error.sqlstate : undefined
}

export async function complete(
  deps: AuthDeps,
  meta: RequestMeta,
  handle: string | undefined,
): Promise<Outcome<EnrollmentComplete>> {
  const request = await auditRequest(deps.keys, meta)
  return inContext(deps, 'auth.enrollment.complete', handle, async (tx, context) => {
    const state = await enrollmentState(tx, context)
    if (!state.steps.passkey || !state.steps.password || !state.steps.totp) {
      return refusal('ENROLLMENT_INCOMPLETE')
    }
    const identityId = context.identity.identityId
    const passkeys = (await readFactors(tx, identityId)).filter(
      (f) => f.kind === 'passkey' && f.state === 'pending',
    ).length
    await tx.query(
      'auth.factor.activate',
      `UPDATE auth.factors SET state = 'active' WHERE identity_id = $1 AND state = 'pending'`,
      [identityId],
    )
    const recoveryCodes = await newRecoveryCodeSet(tx, deps.clock, identityId)
    const deliveries: (PendingDelivery | undefined)[] = []
    const actor = humanActor(context.identity)
    if (context.kind === 'setup') {
      const bindingId = newId('rlb', deps.clock.nowMs())
      try {
        await tx.savepoint((sp) =>
          sp.query('auth.bootstrap.activate', 'SELECT auth.activate_bootstrap_owner($1, $2)', [
            identityId,
            bindingId,
          ]),
        )
      } catch (error) {
        if (sqlstate(error) === 'EXU07') {
          return refusal('LINK_INVALID', { ceremony: 'clear' })
        }
        throw error
      }
      await appendAudit(
        tx,
        {
          action: 'auth.bootstrap.owner_activated',
          phase: 'completed',
          actor,
          client: webClient(null),
          request,
          changes: { bindingId, roleId: 'owner', scope: 'global', origin: 'bootstrap' },
          result: { status: 'succeeded' },
        },
        deps.clock,
      )
    } else if (context.kind === 'invitation') {
      await tx.query(
        'auth.identity.activate',
        `UPDATE auth.identities SET state = 'active' WHERE identity_id = $1 AND state = 'invited'`,
        [identityId],
      )
    } else {
      await tx.query(
        'auth.identity.recovered',
        'UPDATE auth.identities SET recovery_required = false WHERE identity_id = $1',
        [identityId],
      )
      deliveries.push(
        await recordNotification(tx, deps.channel, {
          kind: 'auth.factors_changed',
          recipientIdentityId: identityId,
          to: context.email,
        }),
      )
    }
    await consumeChallenge(tx, context.challenge.challengeId)
    const session = await issueSession(tx, deps.clock, {
      identityId,
      assurance: 'full',
      reauthEventId: null,
      userAgent: meta.userAgent,
    })
    await appendAudit(
      tx,
      {
        action: 'auth.enrollment.complete',
        phase: 'completed',
        actor,
        client: webClient(session.sessionId),
        request,
        changes: { link: context.kind, passkeys, password: true, totp: true, recoveryCodes: 10 },
        result: { status: 'succeeded' },
      },
      deps.clock,
    )
    return success(
      {
        signedIn: {
          identityId,
          label: context.identity.label,
          sessionId: session.sessionId,
          assurance: 'full',
          recoveryRequired: false,
        },
        recoveryCodes,
      },
      { session: session.secrets, ceremony: 'clear' },
      deliveries,
    )
  })
}
