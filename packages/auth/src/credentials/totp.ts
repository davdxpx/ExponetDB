import { randomBytes } from 'node:crypto'
import { Secret, TOTP } from 'otpauth'
import qrcode from 'qrcode-generator'

/**
 * TOTP (RFC 6238) for the password fallback and for re-authentication
 * (identity.md §2, §4), through the `otpauth` library: HMAC-SHA-1, six
 * digits, 30-second steps. SHA-1 is used only because authenticator apps
 * expect it for TOTP; it is not used anywhere else.
 *
 * - The secret is 160 random bits (RFC 4226 §4), stored only through the
 *   secrets store (`se1`, consumer auth).
 * - A code is accepted for the current step and one step either side (±30
 *   seconds of clock skew). Time comes from the database clock.
 * - Replay: a step at or before the last accepted step of the same factor
 *   is refused, so one code can never be used twice.
 * - The enrollment URI carries the secret: shown once, never logged; the QR
 *   matrix is computed locally (no QR service).
 */
export const TOTP_SETTINGS = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 } as const
export const TOTP_ISSUER = 'ExponetDB'

export function newTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(20))
}

export function totpBase32(secret: Uint8Array): string {
  return new Secret({ buffer: Uint8Array.from(secret).buffer }).base32
}

export function totpUri(secret: Uint8Array, accountName: string): string {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: accountName,
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
    algorithm: TOTP_SETTINGS.algorithm,
    digits: TOTP_SETTINGS.digits,
    period: TOTP_SETTINGS.period,
  }).toString()
}

export type TotpCheck =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'replayed' }

export function verifyTotp(
  secret: Uint8Array,
  code: string,
  atMs: number,
  lastStep: number | null,
): TotpCheck {
  if (!/^[0-9]{6}$/.test(code)) {
    return { ok: false, reason: 'invalid' }
  }
  const delta = TOTP.validate({
    token: code,
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
    algorithm: TOTP_SETTINGS.algorithm,
    digits: TOTP_SETTINGS.digits,
    period: TOTP_SETTINGS.period,
    timestamp: atMs,
    window: TOTP_SETTINGS.window,
  })
  if (delta === null) {
    return { ok: false, reason: 'invalid' }
  }
  const step = Math.floor(atMs / 1000 / TOTP_SETTINGS.period) + delta
  if (lastStep !== null && step <= lastStep) {
    return { ok: false, reason: 'replayed' }
  }
  return { ok: true, step }
}

/** The code of a step (tests and the development seed only). */
export function totpCodeAt(secret: Uint8Array, atMs: number): string {
  return TOTP.generate({
    secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
    algorithm: TOTP_SETTINGS.algorithm,
    digits: TOTP_SETTINGS.digits,
    period: TOTP_SETTINGS.period,
    timestamp: atMs,
  })
}

/** The QR code of a text as rows of `0` and `1` (rendered by the Web App, never by a service). */
export function qrMatrix(text: string): { size: number; rows: string[] } {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  const rows: string[] = []
  for (let r = 0; r < size; r++) {
    let row = ''
    for (let c = 0; c < size; c++) {
      row += qr.isDark(r, c) ? '1' : '0'
    }
    rows.push(row)
  }
  return { size, rows }
}
