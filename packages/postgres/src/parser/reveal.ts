import { SECRET_PATTERNS } from '@exponetdb/observability'
import { isLiteral, type LexMode, lex, type Token } from './lexer.ts'
import { loadParser } from './parse.ts'
import { type RedactOptions, redactStatementSync } from './redact.ts'

/**
 * The raw statement view (owner decision S2, Wave 8;
 * [statement-redaction.md §4](../../../../exponetdb-docs/03-database-model/statement-redaction.md#4-raw-text-access)):
 * the statement text with its literals, for a person with
 * `diagnostics.read_sensitive`, but with **secrets still removed**. This is
 * a clean-room secret remover, not the redactor: literals stay readable,
 * and only what is a credential (or carries one) becomes `<redacted>`.
 *
 * In this order:
 *
 * 1. The redactor runs first (its digest identifies the statement). When it
 *    reduced the text to a fixed summary (a sensitive command: role
 *    passwords, user mappings, foreign server options, settings named like
 *    secrets, `set_config` of such a setting, `COPY … PROGRAM`) or to the
 *    unparseable marker, that redacted text is the answer: nothing of the
 *    statement is revealed (`mode: 'summary'` / `'unparseable'`).
 * 2. Otherwise (`mode: 'literal'`) the original text is kept and these
 *    spans are replaced by `<redacted>`, wherever they appear (inside a
 *    literal, a comment or bare):
 *    - the patterns of the log denylist (`SECRET_PATTERNS` of
 *      `@exponetdb/observability`) except the IPv4 and IPv6 address
 *      patterns (addresses and clock times are statement data here):
 *      private key blocks, authorization and cookie headers, bearer/basic
 *      tokens, JWTs, every ExponetDB token kind, `otpauth:` URIs, TOTP
 *      secrets, recovery codes, cloud and vendor keys and `PASSWORD '…'`.
 *      Its URL and `key=value` patterns are replaced by the two below,
 *      whose repetitions are bounded (the log patterns are quadratic on
 *      long runs of name characters);
 *    - the password of a URL with user information (the part after
 *      `user:` and before `@host` becomes `<redacted>`);
 *    - a SQL-aware secret assignment: a key named like a credential
 *      (`password`, `passwd`, `passphrase`, `pwd`, `secret`, `token`,
 *      `api_key`, `access_key`, `private_key`, `credential`, `keyring`,
 *      `signature` inside any name, such as `sslpassword`, `client_secret`
 *      or `password_hash`; `session_id`, `sid`, `sig`, `otp`, `totp`,
 *      `code_verifier`, `user_code`, `device_code`, `client_assertion`,
 *      `recovery_code` as a whole name segment) followed by `=`, `:=`,
 *      `=>` or `:` (never the cast `::`) and its value: a conninfo value
 *      quoted with doubled quotes inside a SQL literal (`password=''p w''`),
 *      a SQL string with doubled quotes or backslash escapes, a
 *      double-quoted, a dollar-quoted or a bare value (everything up to
 *      white space or a quote); a JSON member (`"password": "…"`) the same
 *      way;
 *    - every literal inside the argument list of a function that takes a
 *      secret or hashes one (`SECRET_FUNCTIONS`: pgcrypto's `crypt`,
 *      `pgp_sym_*`, `pgp_pub_*`, `encrypt*`, `decrypt*`, `hmac`, `digest`,
 *      the hashes `md5`, `sha224` to `sha512`, and `dblink_connect*`),
 *      under both readings of `standard_conforming_strings`.
 * 3. A length cap with `truncated` (64 KiB of UTF-16 code units by default),
 *    never splitting a surrogate pair.
 *
 * It errs on the side of removing too much. What it does not know is not
 * removed: a secret in an ordinary literal that no key, prefix, pattern or
 * function marks (`WHERE api = 'hunter2'`) stays readable; that is what
 * the raw view is for, and why it is human only, re-authenticated and
 * audited.
 */
export type RevealMode = 'literal' | 'summary' | 'unparseable'

export interface RevealedStatement {
  readonly text: string
  readonly mode: RevealMode
  readonly truncated: boolean
  /** How many spans were replaced by `<redacted>` (0 in `summary` and `unparseable` mode). */
  readonly removed: number
  /** The digest of the statement's redacted form (`sha256:<hex>`), as every other surface shows it. */
  readonly digest: string
}

export interface RevealOptions extends Pick<RedactOptions, 'major'> {
  readonly maxLength?: number
}

/** 64 KiB of text (UTF-16 code units). */
export const RAW_MAX_LENGTH = 65_536
export const REDACTED = '<redacted>'

/** Functions whose arguments are, or carry, a secret (matched by their last name part). */
export const SECRET_FUNCTIONS: ReadonlySet<string> = new Set([
  'crypt',
  'pgp_sym_encrypt',
  'pgp_sym_encrypt_bytea',
  'pgp_sym_decrypt',
  'pgp_sym_decrypt_bytea',
  'pgp_pub_encrypt',
  'pgp_pub_encrypt_bytea',
  'pgp_pub_decrypt',
  'pgp_pub_decrypt_bytea',
  'pgp_key_id',
  'dearmor',
  'encrypt',
  'encrypt_iv',
  'decrypt',
  'decrypt_iv',
  'hmac',
  'digest',
  'md5',
  'sha224',
  'sha256',
  'sha384',
  'sha512',
  'dblink_connect',
  'dblink_connect_u',
])

/** Keys that name a secret wherever they appear in a name (`sslpassword`, `password_hash`). */
const STRONG_KEYS =
  'password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|keyring|signature'
/** Short keys that name a secret only as a whole name segment (`session_id`, never `inside`). */
const WEAK_KEYS =
  'session(?:[_-]?id)?|sid|sig|code[_-]?verifier|user[_-]?code|device[_-]?code|client[_-]?assertion|totp(?:[_-]?code)?|otp|one[_-]?time[_-]?code|recovery[_-]?codes?'
/** Every repetition is bounded, so a run of name characters is scanned in linear time. */
const KEY = `(?:[A-Za-z0-9_.-]{0,64}?(?:${STRONG_KEYS})[A-Za-z0-9_-]{0,64}|(?:[A-Za-z0-9]{1,32}[_.-]){0,4}(?:${WEAK_KEYS})(?![A-Za-z0-9]))`

/** A value after a secret key: most specific first; an unterminated quote runs to the end. */
const VALUE = [
  // A conninfo value quoted inside a SQL literal: the quotes are doubled.
  "''(?:[^']|'(?!'))*(?:''|$)",
  // A SQL string (doubled quotes and backslash escapes both read as part of it).
  "[EeNn]?'(?:[^'\\\\]|\\\\[\\s\\S]|'')*(?:'|$)",
  '"(?:[^"\\\\]|\\\\[\\s\\S])*(?:"|$)',
  '\\$(?<tag>[A-Za-z_][A-Za-z0-9_]*)?\\$[\\s\\S]*?(?:\\$\\k<tag>\\$|$)',
  // A bare value: everything up to white space or a quote (a password may hold any other character).
  '[^\\s\'"]+',
].join('|')

/** `<key> = <value>` (also `:=`, `=>`, `:` but never the cast `::`). */
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_])(?:${KEY})["']?\\s*(?:=>|:=|=|:(?!:))\\s*(?<value>${VALUE})`,
  'gid',
)
/** A JSON member named like a secret, its value a JSON string or a bare token. */
const JSON_MEMBER = new RegExp(
  `"(?:${KEY})"\\s*:\\s*(?<value>"(?:[^"\\\\]|\\\\[\\s\\S])*(?:"|$)|[^\\s,}\\]]+)`,
  'gid',
)
/**
 * The password of a URL with user information (after `user:`, before `@`),
 * bounded to 256 characters each so that many `://` stay linear.
 */
const URL_PASSWORD = /:\/\/[^\s/?#@:'"]{0,256}:(?<value>[^\s@'"]{0,256})@/dg

/**
 * The log denylist without the address patterns (statement data here, and
 * they eat clock times) and without its URL and assignment patterns, whose
 * unbounded name runs are quadratic on long statements: `URL_PASSWORD` and
 * `ASSIGNMENT` cover them with bounded repetitions.
 */
const LOG_PATTERNS = SECRET_PATTERNS.filter(
  (p) => !['ipv4', 'ipv6', 'url_credentials', 'secret_assignment'].includes(p.name),
)

type Span = readonly [start: number, end: number]

function patternSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const { pattern, keepGroup } of LOG_PATTERNS) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    )
    for (const m of text.matchAll(global)) {
      const kept = keepGroup === undefined ? 0 : (m[keepGroup]?.length ?? 0)
      const start = m.index + kept
      const end = m.index + m[0].length
      if (end > start) spans.push([start, end])
    }
  }
  for (const re of [ASSIGNMENT, JSON_MEMBER, URL_PASSWORD]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const range = m.indices?.groups?.['value']
      if (range !== undefined && range[1] > range[0]) spans.push([range[0], range[1]])
    }
  }
  return spans
}

/** The last part of a (possibly qualified) function name token, or undefined. */
function nameOf(token: Token, text: string): string | undefined {
  const raw = text.slice(token.start, token.end)
  if (token.kind === 'ident') return raw.toLowerCase()
  if (token.kind === 'qident' && raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll('""', '"')
  }
  return undefined
}

/** Every literal inside the parentheses of a call to a secret function, under one reading. */
function functionSpans(text: string, mode: LexMode): Span[] {
  const tokens = lex(text, mode)
  const spans: Span[] = []
  const significant = (k: number): number => {
    let j = k
    while (j < tokens.length) {
      const t = tokens[j] as Token
      if (t.kind !== 'space' && t.kind !== 'comment') return j
      j++
    }
    return j
  }
  let k = 0
  while (k < tokens.length) {
    const t = tokens[k] as Token
    const name = nameOf(t, text)
    const open = significant(k + 1)
    const paren = tokens[open]
    if (
      name !== undefined &&
      SECRET_FUNCTIONS.has(name) &&
      paren !== undefined &&
      paren.kind === 'op' &&
      text[paren.start] === '('
    ) {
      let depth = 0
      let j = open
      for (; j < tokens.length; j++) {
        const u = tokens[j] as Token
        if (u.kind === 'op' && text[u.start] === '(') depth++
        else if (u.kind === 'op' && text[u.start] === ')') {
          depth--
          if (depth === 0) break
        } else if (isLiteral(u) || u.kind === 'comment') {
          spans.push([u.start, u.end])
        }
      }
      k = j + 1
      continue
    }
    k++
  }
  return spans
}

function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: [number, number][] = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s <= last[1]) {
      last[1] = Math.max(last[1], e)
    } else {
      out.push([s, e])
    }
  }
  return out
}

function cap(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false }
  let end = maxLength
  const code = text.charCodeAt(end - 1)
  // Never end on the first half of a surrogate pair.
  if (code >= 0xd800 && code <= 0xdbff) end--
  return { text: text.slice(0, end), truncated: true }
}

/** The spans of `text` that would be removed (exposed for tests). */
export function secretSpans(text: string): readonly Span[] {
  return merge([
    ...patternSpans(text),
    ...functionSpans(text, 'standard'),
    ...functionSpans(text, 'conservative'),
  ])
}

/** Removes the secrets of one statement text (the parser of `options.major` must be loaded). */
export function revealStatementSync(text: string, options: RevealOptions): RevealedStatement {
  const maxLength = options.maxLength ?? RAW_MAX_LENGTH
  const redacted = redactStatementSync(text, {
    major: options.major,
    maxLength: Number.MAX_SAFE_INTEGER,
  })
  if (redacted.mode === 'summary' || redacted.mode === 'unparseable') {
    const capped = cap(redacted.text, maxLength)
    return { ...capped, mode: redacted.mode, removed: 0, digest: redacted.digest }
  }
  const spans = secretSpans(text)
  let out = ''
  let at = 0
  for (const [s, e] of spans) {
    out += text.slice(at, s) + REDACTED
    at = e
  }
  out += text.slice(at)
  const capped = cap(out.replaceAll('\u0000', ' '), maxLength)
  return { ...capped, mode: 'literal', removed: spans.length, digest: redacted.digest }
}

export async function revealStatement(
  text: string,
  options: RevealOptions,
): Promise<RevealedStatement> {
  await loadParser(options.major)
  return revealStatementSync(text, options)
}
