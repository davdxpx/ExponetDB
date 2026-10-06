import * as z from 'zod'
import { IdentityIdSchema, SessionIdSchema, TimestampSchema } from '../common.ts'
import type { ErrorCode } from '../errors.ts'
import {
  AuthFactorIdSchema,
  EmailSchema,
  FactorViewSchema,
  IdentityLabelSchema,
  SessionRevokeResultSchema,
} from '../rest/access.ts'
import type { RouteContract } from '../rest/routes.ts'

/*
 * Browser authentication ceremonies of the first-party Web App (Wave 3A,
 * identity.md). They live under `/auth`, outside `/api/v1`: they are Web App
 * only (client kind `web`), use the session cookie or a short-lived ceremony
 * cookie, and are not part of the SDK surface. Every route names a
 * registered action, like the REST routes.
 *
 * Secrets in bodies (passwords, TOTP codes, recovery codes, one-time link
 * tokens, WebAuthn responses) are never logged, audited or echoed; responses
 * that carry a secret shown once (recovery codes, the TOTP enrollment URI)
 * are `Cache-Control: no-store` like every auth response.
 */
export const AUTH_BASE_PATH = '/auth'

const base64url = (max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .min(1)
    .max(max)

const TransportSchema = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])

const ExtensionResultsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), z.unknown())
  .meta({ description: 'Client extension results; ignored by the server.' })

/** `RegistrationResponseJSON` (WebAuthn Level 3 JSON serialization). */
export const RegistrationCredentialSchema = z
  .strictObject({
    id: base64url(1366),
    rawId: base64url(1366),
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: base64url(8192),
      attestationObject: base64url(65536),
      authenticatorData: base64url(65536).optional(),
      transports: z.array(TransportSchema).max(8).optional(),
      publicKeyAlgorithm: z.int().optional(),
      publicKey: base64url(8192).optional(),
    }),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: ExtensionResultsSchema,
  })
  .meta({ id: 'RegistrationCredential' })

/** `AuthenticationResponseJSON`. */
export const AuthenticationCredentialSchema = z
  .strictObject({
    id: base64url(1366),
    rawId: base64url(1366),
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: base64url(8192),
      authenticatorData: base64url(65536),
      signature: base64url(4096),
      userHandle: base64url(128).optional(),
    }),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: ExtensionResultsSchema,
  })
  .meta({ id: 'AuthenticationCredential' })

const CredentialDescriptorSchema = z.object({
  id: base64url(1366),
  type: z.literal('public-key'),
  transports: z.array(TransportSchema).optional(),
})

/** `PublicKeyCredentialCreationOptionsJSON`; the RP id and origin come from trusted configuration. */
export const CreationOptionsSchema = z
  .object({
    challenge: base64url(128),
    rp: z.object({ id: z.string().max(253), name: z.string().max(64) }),
    user: z.object({ id: base64url(128), name: z.string().max(254), displayName: z.string() }),
    pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.int() })),
    timeout: z.int().min(1).optional(),
    excludeCredentials: z.array(CredentialDescriptorSchema).optional(),
    authenticatorSelection: z
      .object({
        residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
        requireResidentKey: z.boolean().optional(),
        userVerification: z.enum(['discouraged', 'preferred', 'required']).optional(),
        authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
      })
      .optional(),
    attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    hints: z.array(z.string()).optional(),
  })
  .meta({ id: 'CreationOptions' })

/** `PublicKeyCredentialRequestOptionsJSON`. */
export const RequestOptionsSchema = z
  .object({
    challenge: base64url(128),
    rpId: z.string().max(253).optional(),
    timeout: z.int().min(1).optional(),
    allowCredentials: z.array(CredentialDescriptorSchema).optional(),
    userVerification: z.enum(['discouraged', 'preferred', 'required']).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
    hints: z.array(z.string()).optional(),
  })
  .meta({ id: 'RequestOptions' })

/** A six-digit TOTP code (RFC 6238, SHA-1, 30-second step). */
export const TotpCodeSchema = z.string().regex(/^[0-9]{6}$/)

/** A recovery code as typed: Crockford base32, separators and case tolerated. */
export const RecoveryCodeInputSchema = z.string().regex(/^[0-9A-Za-z -]{16,40}$/)

/** A one-time link token (`exsu_` setup, `exiv_` invitation, `exrc_` recovery). */
export const LinkTokenSchema = z.string().regex(/^ex(?:su|iv|rc)_[A-Za-z0-9_-]{43}$/)

/** Bounded transport size only; the password policy decides acceptance. */
export const PasswordInputSchema = z.string().min(1).max(4096)

export const SignedInSchema = z
  .object({
    identityId: IdentityIdSchema,
    label: IdentityLabelSchema,
    sessionId: SessionIdSchema,
    assurance: z.enum(['full', 'recovery']),
    recoveryRequired: z.boolean(),
  })
  .meta({ id: 'SignedIn' })

export const SecondFactorStepSchema = z
  .object({ next: z.literal('second_factor'), methods: z.array(z.enum(['totp', 'recovery_code'])) })
  .meta({ id: 'SecondFactorStep' })

export const EnrollmentStateSchema = z
  .object({
    kind: z.enum(['setup', 'invitation', 'recovery']),
    email: EmailSchema,
    expiresAt: TimestampSchema,
    steps: z.object({ passkey: z.boolean(), password: z.boolean(), totp: z.boolean() }),
    complete: z.boolean(),
  })
  .meta({ id: 'EnrollmentState' })

export const TotpSetupSchema = z
  .object({
    otpauthUri: z.string().max(512).meta({
      description: 'Secret-bearing URI, shown once for enrollment; never logged.',
    }),
    secret: z.string().regex(/^[A-Z2-7]{32}$/),
    qr: z.object({ size: z.int().min(21).max(177), rows: z.array(z.string().regex(/^[01]+$/)) }),
  })
  .meta({ id: 'TotpSetup' })

export const RecoveryCodesSchema = z
  .object({
    recoveryCodes: z
      .array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/))
      .length(10),
  })
  .meta({ id: 'RecoveryCodes', description: 'Shown exactly once; only hashes are stored.' })

export const EnrollmentCompleteSchema = z
  .object({ signedIn: SignedInSchema, recoveryCodes: RecoveryCodesSchema.shape.recoveryCodes })
  .meta({ id: 'EnrollmentComplete' })

export const ReauthResultSchema = z
  .object({ reauthAt: TimestampSchema, method: z.enum(['passkey', 'totp']) })
  .meta({ id: 'ReauthResult' })

const empty = z.strictObject({})
const noParams = z.strictObject({})
const factorParams = z.strictObject({ factorId: AuthFactorIdSchema })
const LOGIN_ERRORS: readonly ErrorCode[] = ['AUTHENTICATION_FAILED', 'RATE_LIMITED', 'CSRF_FAILED']
const CEREMONY_ERRORS: readonly ErrorCode[] = [
  'AUTH_CHALLENGE_EXPIRED',
  'AUTH_CHALLENGE_INVALID',
  'CSRF_FAILED',
  'SESSION_EXPIRED',
]
const ENROLLMENT_ERRORS: readonly ErrorCode[] = [
  'LINK_INVALID',
  'AUTHENTICATION_FAILED',
  'AUTH_CHALLENGE_EXPIRED',
  'AUTH_CHALLENGE_INVALID',
  'PASSWORD_REJECTED',
  'RATE_LIMITED',
  'CSRF_FAILED',
]
const SELF_ERRORS: readonly ErrorCode[] = [
  'SESSION_EXPIRED',
  'CSRF_FAILED',
  'REAUTH_REQUIRED',
  'RECOVERY_REQUIRED',
]

const post = (
  operationId: string,
  path: string,
  summary: string,
  action: RouteContract['action'],
  body: z.ZodType,
  response: z.ZodType,
  errors: readonly ErrorCode[],
  pathParams: z.ZodObject = noParams,
): RouteContract => ({
  operationId,
  method: 'post',
  path,
  summary,
  action,
  pathParams,
  body,
  response: { status: 200, schema: response },
  errors,
})

/** The ceremony routes below {@link AUTH_BASE_PATH}. */
export const AUTH_ROUTES: readonly RouteContract[] = [
  post(
    'loginPasskeyOptions',
    '/login/passkey/options',
    'Start a passkey sign-in (discoverable credentials: no account is named, so nothing can be enumerated).',
    'auth.login',
    empty,
    RequestOptionsSchema,
    LOGIN_ERRORS,
  ),
  post(
    'loginPasskey',
    '/login/passkey',
    'Finish a passkey sign-in with user verification; a new session is issued.',
    'auth.login',
    z.strictObject({ credential: AuthenticationCredentialSchema }),
    SignedInSchema,
    LOGIN_ERRORS,
  ),
  post(
    'loginPassword',
    '/login/password',
    'First step of the fallback sign-in. The answer is the same whether or not the account exists or the password is right.',
    'auth.login',
    z.strictObject({ email: EmailSchema, password: PasswordInputSchema }),
    SecondFactorStepSchema,
    LOGIN_ERRORS,
  ),
  post(
    'loginTotp',
    '/login/totp',
    'Second step of the fallback sign-in with a TOTP code; a new session is issued.',
    'auth.login',
    z.strictObject({ code: TotpCodeSchema }),
    SignedInSchema,
    LOGIN_ERRORS,
  ),
  post(
    'loginRecoveryCode',
    '/login/recovery-code',
    'Second step with a recovery code: a restricted session that may only set up new factors.',
    'auth.login',
    z.strictObject({ code: RecoveryCodeInputSchema }),
    SignedInSchema,
    LOGIN_ERRORS,
  ),
  post(
    'logout',
    '/logout',
    'Revoke the current session and clear its cookies.',
    'auth.logout',
    empty,
    z.object({ signedOut: z.literal(true) }),
    ['SESSION_EXPIRED', 'CSRF_FAILED'],
  ),
  post(
    'reauthPasskeyOptions',
    '/reauth/passkey/options',
    'Start a re-authentication with a passkey of the signed-in person.',
    'auth.reauth',
    empty,
    RequestOptionsSchema,
    CEREMONY_ERRORS,
  ),
  post(
    'reauthPasskey',
    '/reauth/passkey',
    'Finish a passkey re-authentication; the session secret is rotated.',
    'auth.reauth',
    z.strictObject({ credential: AuthenticationCredentialSchema }),
    ReauthResultSchema,
    [...CEREMONY_ERRORS, 'RATE_LIMITED'],
  ),
  post(
    'reauthTotp',
    '/reauth/totp',
    'Re-authenticate with a TOTP code; the session secret is rotated.',
    'auth.reauth',
    z.strictObject({ code: TotpCodeSchema }),
    ReauthResultSchema,
    [...CEREMONY_ERRORS, 'AUTHENTICATION_FAILED', 'RATE_LIMITED'],
  ),
  post(
    'enrollmentRedeem',
    '/enrollment/redeem',
    'Redeem a one-time link (first owner, invitation or recovery). The token comes from the URL fragment, in the body.',
    'auth.enrollment',
    z.strictObject({ token: LinkTokenSchema }),
    EnrollmentStateSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentPasskeyOptions',
    '/enrollment/passkey/options',
    'Passkey registration options for the identity being enrolled.',
    'auth.enrollment',
    empty,
    CreationOptionsSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentPasskey',
    '/enrollment/passkey',
    'Register the passkey of the identity being enrolled.',
    'auth.enrollment',
    z.strictObject({
      credential: RegistrationCredentialSchema,
      label: z.string().min(1).max(64).optional(),
    }),
    EnrollmentStateSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentPassword',
    '/enrollment/password',
    'Set the fallback password of the identity being enrolled.',
    'auth.enrollment',
    z.strictObject({ password: PasswordInputSchema }),
    EnrollmentStateSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentTotpOptions',
    '/enrollment/totp/options',
    'A new TOTP secret for the identity being enrolled (shown once).',
    'auth.enrollment',
    empty,
    TotpSetupSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentTotp',
    '/enrollment/totp',
    'Confirm the TOTP authenticator with a valid code.',
    'auth.enrollment',
    z.strictObject({ code: TotpCodeSchema }),
    EnrollmentStateSchema,
    ENROLLMENT_ERRORS,
  ),
  post(
    'enrollmentComplete',
    '/enrollment/complete',
    'Activate the identity once passkey, password and TOTP are set; returns the recovery codes once and a new session.',
    'auth.enrollment',
    empty,
    EnrollmentCompleteSchema,
    [...ENROLLMENT_ERRORS, 'ENROLLMENT_INCOMPLETE'],
  ),
  post(
    'passkeyOptions',
    '/passkeys/options',
    'Registration options for an additional passkey of the signed-in person.',
    'auth.passkey.add',
    empty,
    CreationOptionsSchema,
    SELF_ERRORS,
  ),
  post(
    'addPasskey',
    '/passkeys',
    'Register an additional passkey.',
    'auth.passkey.add',
    z.strictObject({
      credential: RegistrationCredentialSchema,
      label: z.string().min(1).max(64).optional(),
    }),
    FactorViewSchema,
    [...SELF_ERRORS, 'AUTH_CHALLENGE_EXPIRED', 'AUTH_CHALLENGE_INVALID'],
  ),
  post(
    'removePasskey',
    '/passkeys/{factorId}/remove',
    'Remove a passkey; the last passkey cannot be removed.',
    'auth.passkey.remove',
    empty,
    z.object({ removed: z.literal(true) }),
    [...SELF_ERRORS, 'LAST_FACTOR', 'NOT_FOUND'],
    factorParams,
  ),
  post(
    'changePassword',
    '/password',
    'Set a new fallback password.',
    'auth.password.change',
    z.strictObject({ password: PasswordInputSchema }),
    FactorViewSchema,
    [...SELF_ERRORS, 'PASSWORD_REJECTED'],
  ),
  post(
    'totpOptions',
    '/totp/options',
    'A new TOTP secret replacing the current authenticator once confirmed (shown once).',
    'auth.totp.replace',
    empty,
    TotpSetupSchema,
    SELF_ERRORS,
  ),
  post(
    'replaceTotp',
    '/totp',
    'Confirm the new TOTP authenticator with a valid code.',
    'auth.totp.replace',
    z.strictObject({ code: TotpCodeSchema }),
    FactorViewSchema,
    [...SELF_ERRORS, 'AUTH_CHALLENGE_INVALID'],
  ),
  post(
    'regenerateRecoveryCodes',
    '/recovery-codes',
    'Replace all recovery codes with ten new ones (shown once).',
    'auth.recovery_codes.regenerate',
    empty,
    RecoveryCodesSchema,
    SELF_ERRORS,
  ),
]

export type RegistrationCredential = z.infer<typeof RegistrationCredentialSchema>
export type AuthenticationCredential = z.infer<typeof AuthenticationCredentialSchema>
export type CreationOptions = z.infer<typeof CreationOptionsSchema>
export type RequestOptions = z.infer<typeof RequestOptionsSchema>
export type SignedIn = z.infer<typeof SignedInSchema>
export type SecondFactorStep = z.infer<typeof SecondFactorStepSchema>
export type EnrollmentState = z.infer<typeof EnrollmentStateSchema>
export type TotpSetup = z.infer<typeof TotpSetupSchema>
export type RecoveryCodesView = z.infer<typeof RecoveryCodesSchema>
export type EnrollmentComplete = z.infer<typeof EnrollmentCompleteSchema>
export type ReauthResult = z.infer<typeof ReauthResultSchema>

/** Result type of the session revoke routes, shared with REST. */
export const AuthSessionRevokeResultSchema = SessionRevokeResultSchema
