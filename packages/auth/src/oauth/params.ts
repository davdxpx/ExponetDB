import { isScope, OAUTH_LIMITS, type Scope } from '@exponetdb/contracts'

/**
 * Strict parsing of protocol parameters (RFC 6749 §3.1, §3.2: parameters
 * sent without a value are treated as omitted, and request and response
 * parameters must not be included more than once). The whole query or form
 * body is parsed by hand so that a repeated parameter is seen; a repeated
 * parameter is never resolved by picking one of the values.
 */
export interface ProtocolParams {
  /** The value of a parameter that occurs once with a non-empty value. */
  get(name: string): string | undefined
  /** Parameters that occur more than once. */
  readonly repeated: ReadonlySet<string>
  has(name: string): boolean
}

class Params implements ProtocolParams {
  readonly #values: Map<string, string>
  readonly repeated: ReadonlySet<string>
  constructor(values: Map<string, string>, repeated: Set<string>) {
    this.#values = values
    this.repeated = repeated
  }
  get(name: string): string | undefined {
    if (this.repeated.has(name)) {
      return undefined
    }
    const value = this.#values.get(name)
    return value === undefined || value.length === 0 ? undefined : value
  }
  has(name: string): boolean {
    return this.#values.has(name)
  }
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '))
  } catch {
    return undefined
  }
}

/**
 * Parses `application/x-www-form-urlencoded` text (a query string without
 * `?`, or a form body). Undefined when too long or not well-formed.
 */
export function parseProtocolParams(text: string, maxLength: number): ProtocolParams | undefined {
  if (text.length > maxLength) {
    return undefined
  }
  const values = new Map<string, string>()
  const repeated = new Set<string>()
  if (text.length === 0) {
    return new Params(values, repeated)
  }
  for (const pair of text.split('&')) {
    if (pair.length === 0) {
      continue
    }
    const index = pair.indexOf('=')
    const name = decode(index < 0 ? pair : pair.slice(0, index))
    const value = decode(index < 0 ? '' : pair.slice(index + 1))
    if (name === undefined || value === undefined || /\p{Cc}/u.test(name)) {
      return undefined
    }
    if (values.has(name)) {
      repeated.add(name)
    }
    values.set(name, value)
  }
  return new Params(values, repeated)
}

/**
 * A `scope` parameter: space-delimited catalog scopes (RFC 6749 §3.3), one
 * space between tokens, no repeats, no wildcard or prefix forms (only exact
 * catalog names exist). Undefined when malformed or unknown.
 */
export function parseScopeParam(value: string | undefined): Scope[] | undefined {
  if (value === undefined || value.length === 0 || value.length > 4096) {
    return undefined
  }
  const tokens = value.split(' ')
  const out: Scope[] = []
  for (const token of tokens) {
    if (!isScope(token) || out.includes(token)) {
      return undefined
    }
    out.push(token)
  }
  return out.length > OAUTH_LIMITS.maxScopes ? undefined : out
}

export function scopeParam(scopes: readonly Scope[]): string {
  return scopes.join(' ')
}

/** `state`: 1 to 512 visible ASCII characters (it is echoed back, never interpreted). */
export function isValidState(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length >= 1 &&
    value.length <= OAUTH_LIMITS.maxStateLength &&
    /^[\x20-\x7e]+$/.test(value)
  )
}

/** RFC 7636 §4.2: BASE64URL(SHA-256(verifier)) is 43 characters without padding. */
export function isValidCodeChallenge(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
export function isValidCodeVerifier(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}
