/**
 * Secondary secret-pattern denylist ([self-observability.md §2](../../../exponetdb-docs/10-observability/self-observability.md#2-log-fields)).
 *
 * The first line of defense is the field allowlist of the logger: only
 * declared fields with typed values are written. This denylist is the second
 * line: every string that passes the allowlist is scanned, and a match is
 * replaced by `[REDACTED:<name>]`. It errs on the side of redacting too much:
 * a log line that loses a harmless value is a nuisance, a leaked credential
 * is an incident.
 */
export interface SecretPattern {
  readonly name: string
  readonly pattern: RegExp
  /** Group to keep before the redaction marker (for `key=value` forms). */
  readonly keepGroup?: number
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'private_key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  // A URL with user information: keep the scheme and the user, drop the password.
  // The password ends at a `/` as the authority does for every URL parser (libpq,
  // WHATWG): a raw `/` in a password is not a working URL. So no part can run over
  // the next `://`, the scans of consecutive URLs never overlap, and text with
  // many `://` is read in linear time; every repetition is bounded as well.
  {
    name: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@'"]{0,256}:)[^\s/@'"]{0,1024}(?=@)/gi,
    keepGroup: 1,
  },
  {
    name: 'authorization',
    pattern: /\b(?:authorization|proxy-authorization)\b\s*[:=]\s*[^\r\n]*/gi,
  },
  { name: 'cookie', pattern: /\b(?:set-cookie|cookie)\b\s*[:=]\s*[^\r\n]*/gi },
  { name: 'bearer', pattern: /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // A JWT starts a run of base64url characters (not after `-`, which would let
  // every `eyJ` inside one long run rescan it to its end).
  {
    name: 'jwt',
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  },
  // Every ExponetDB token kind: access, refresh, API key, authorization code,
  // device code, authorization-request handle, OAuth browser binding (Wave
  // 3B), session, CSRF, setup, invitation, recovery link, ceremony (Wave 3A).
  {
    name: 'exponetdb_token',
    pattern: /\bex(?:at|rt|ak|ac|dc|ar|ob|st|ck|su|iv|rc|ch)_[A-Za-z0-9_-]{8,}/g,
  },
  // A TOTP enrollment URI carries the shared secret (and the account name).
  { name: 'otpauth_uri', pattern: /\botpauth:\/\/[^\s'"<>]*/gi },
  // A bare RFC 4648 base32 TOTP secret (160 bits = 32 characters).
  { name: 'totp_secret', pattern: /\b[A-Z2-7]{32}\b/g },
  // Recovery codes: four groups of four Crockford base32 characters.
  {
    name: 'recovery_code',
    pattern: /\b[0-9A-HJKMNP-TV-Z]{4}(?:[- ]?[0-9A-HJKMNP-TV-Z]{4}){3}\b/g,
  },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'api_key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe_key', pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  // key=value and key: value forms, quoted or not, including query strings and conninfo.
  // A strong key names a secret wherever it appears in a name (`db_password`,
  // `password_hash`); a short key only as a whole name segment (`session_id`,
  // never `inside`). Name runs are bounded and an unterminated quote runs to
  // the end, so no failed attempt rescans the rest of the text (linear time).
  {
    name: 'secret_assignment',
    pattern:
      /((?:(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|signature|code_verifier|client[_-]?assertion|client[_-]?secret|keyring)[a-z0-9_-]{0,64}|(?<![a-z0-9])(?:[a-z0-9]{1,32}[_-]){0,8}(?:session(?:[_-]?id)?|sid|sig|user[_-]?code|device[_-]?code|totp(?:[_-]?code)?|otp|one[_-]?time[_-]?code|recovery[_-]?codes?)(?![a-z0-9]))"?\s{0,16}[:=]\s{0,16})(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s&,;)}\]]+)/gi,
    keepGroup: 1,
  },
  {
    name: 'ipv4',
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
  },
  {
    // Any run of hex digits and colons with at least two colons (compressed
    // forms like 2001:db8::1 included). Over-matches clock times such as
    // 12:00:00, which is acceptable for logs.
    name: 'ipv6',
    pattern:
      /(?<![\w:.])(?=[0-9a-f:]*:[0-9a-f:]*:)(?=[0-9a-f:]*[0-9a-f])[0-9a-f:]{3,}(?:%[A-Za-z0-9]+)?(?![\w:])/gi,
  },
  // SQL forms: ALTER ROLE … PASSWORD '…', CREATE USER … PASSWORD '…'.
  { name: 'sql_password', pattern: /\b(password\s+)'(?:[^']|'')*'?/gi, keepGroup: 1 },
]

/** Replaces every match of every pattern. Pure; never throws. */
export function redactText(text: string): string {
  let out = text
  for (const { name, pattern, keepGroup } of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      const kept = keepGroup === undefined ? '' : String(args[keepGroup] ?? '')
      return `${kept}[REDACTED:${name}]`
    })
  }
  return out
}

/** True when `text` contains anything the denylist would redact. */
export function containsSecretPattern(text: string): boolean {
  return redactText(text) !== text
}
