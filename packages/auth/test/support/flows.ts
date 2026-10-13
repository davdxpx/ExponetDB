import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type Clock, newId, systemClock } from '@exponetdb/kernel'
import { generateKeyringText, type Keyring, parseKeyring } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import {
  type AuthDeps,
  bootstrapOwner,
  enrollment,
  InstallationKeys,
  type NotificationChannel,
  type OutboundNotification,
  type Outcome,
  parseAuthConfig,
  type RequestMeta,
  type SessionSecrets,
  totpCodeAt,
} from '../../src/index.ts'
import { SoftAuthenticator } from '../../src/testing/authenticator.ts'

export const ORIGIN = 'https://db.example.test'
export const RP_ID = 'db.example.test'
export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
export const PASSWORD = 'tangerine fjord radiator 42'

export function meta(clientIp = '192.0.2.10', userAgent: string = UA): RequestMeta {
  return { requestId: newId('req', Date.now()), clientIp, userAgent }
}

export function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.error.code}`)
  }
  return outcome.value
}

export function errorCode<T>(outcome: Outcome<T>): string | undefined {
  return outcome.ok ? undefined : outcome.error.code
}

export function ceremonyHandle<T>(outcome: Outcome<T>): string {
  const ceremony = outcome.cookies.ceremony
  if (ceremony === undefined || ceremony === 'clear') {
    throw new Error('no ceremony cookie')
  }
  return ceremony.handle
}

export function sessionSecrets<T>(outcome: Outcome<T>): SessionSecrets {
  const session = outcome.cookies.session
  if (session === undefined || session === 'clear') {
    throw new Error('no session cookie')
  }
  return session
}

export function tokenOf(link: string): string {
  const token = new URL(link).hash.replace(/^#token=/, '')
  if (token.length === 0) {
    throw new Error('no token in link')
  }
  return token
}

/** A channel that records what would have been sent (delivery truthfulness tests). */
export class RecordingChannel implements NotificationChannel {
  readonly name = 'email' as const
  readonly sent: OutboundNotification[] = []
  fail = false
  async deliver(notification: OutboundNotification) {
    if (this.fail) {
      return { ok: false as const, errorCode: 'smtp_refused' }
    }
    this.sent.push(notification)
    return { ok: true as const }
  }
}

export interface Harness {
  readonly db: MigratedTestDatabase
  readonly deps: AuthDeps
  readonly keyring: Keyring
  readonly clock: Clock
  /** Runs SQL as superuser with triggers off (`session_replication_role = replica`): fixtures that move time. */
  withoutGuards(fn: (client: SuperClient) => Promise<void>): Promise<void>
}

type SuperClient = Parameters<Parameters<MigratedTestDatabase['asSuperuser']>[0]>[0]

export async function harness(prefix: string, channel?: NotificationChannel): Promise<Harness> {
  const db = await migratedTestDatabase(prefix)
  const store = db.store('exdb_serve')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) {
    throw new Error('keyring')
  }
  const keyring = parsed.value
  const clock = systemClock
  const deps: AuthDeps = {
    store,
    keyring,
    clock,
    // The review policy (oauth.md §3): the existing suites test the administrator's approval;
    // open registration is tested by deriving deps with `clientRegistration: 'open'`.
    config: parseAuthConfig({ publicUrl: ORIGIN, clientRegistration: 'review' }),
    keys: new InstallationKeys(store, keyring, clock),
    channel,
  }
  return {
    db,
    deps,
    keyring,
    clock,
    withoutGuards: (fn) =>
      db.asSuperuser(async (client) => {
        await client.query('BEGIN')
        await client.query('SET LOCAL session_replication_role = replica')
        try {
          await fn(client)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }),
  }
}

/** Ages rows by moving their timestamps back (the database clock is never mocked). */
export async function age(h: Harness, sql: string, params: readonly unknown[]): Promise<void> {
  await h.withoutGuards(async (client) => {
    await client.query(sql, [...params])
  })
}

export interface Enrolled {
  readonly identityId: string
  readonly email: string
  readonly authenticator: SoftAuthenticator
  readonly totpSecret: Uint8Array
  readonly recoveryCodes: readonly string[]
  readonly session: SessionSecrets
  readonly sessionId: string
}

export function decodeBase32(base32: string): Uint8Array {
  return Secret.fromBase32(base32).bytes
}

/** Lets a further TOTP code be used now (tests only): the step guard is bypassed by the superuser. */
export async function resetTotpStep(h: Harness, identityId: string): Promise<void> {
  await age(
    h,
    `UPDATE auth.factors SET totp_last_step = NULL WHERE identity_id = $1 AND kind = 'totp'`,
    [identityId],
  )
}

export function totpNow(secret: Uint8Array): string {
  return totpCodeAt(secret, Date.now())
}

/** Runs the whole enrollment through a one-time link with a software authenticator. */
export async function enrollThroughLink(
  h: Harness,
  link: string,
  email: string,
  options: { readonly synced?: boolean; readonly ip?: string } = {},
): Promise<Enrolled> {
  const m = meta(options.ip)
  const redeemed = await enrollment.redeem(h.deps, m, tokenOf(link))
  const handle = ceremonyHandle(redeemed)
  const creation = value(await enrollment.passkeyOptions(h.deps, handle))
  const authenticator = new SoftAuthenticator(
    new Uint8Array(Buffer.from(creation.user.id, 'base64url')),
    { synced: options.synced ?? true },
  )
  value(
    await enrollment.passkey(
      h.deps,
      handle,
      authenticator.register({ challenge: creation.challenge, origin: ORIGIN, rpId: RP_ID }),
      'Laptop',
    ),
  )
  value(await enrollment.password(h.deps, handle, PASSWORD))
  const setup = value(await enrollment.totpOptions(h.deps, handle))
  const totpSecret = decodeBase32(setup.secret)
  value(await enrollment.totp(h.deps, m, handle, totpNow(totpSecret)))
  const done = await enrollment.complete(h.deps, m, handle)
  const completed = value(done)
  return {
    identityId: completed.signedIn.identityId,
    email,
    authenticator,
    totpSecret,
    recoveryCodes: completed.recoveryCodes,
    session: sessionSecrets(done),
    sessionId: completed.signedIn.sessionId,
  }
}

export async function enrollFirstOwner(
  h: Harness,
  email = 'owner@example.test',
): Promise<Enrolled> {
  const issued = await bootstrapOwner(
    { store: h.deps.store, clock: h.clock, config: h.deps.config, channel: undefined },
    { email, reissue: false },
  )
  return enrollThroughLink(h, issued.link, email)
}
