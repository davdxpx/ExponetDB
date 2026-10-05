import { InvariantError } from './errors.ts'
import type { JsonError, JsonValue } from './json.ts'
import { isJsonArray, toJsonValue } from './json.ts'
import { err, ok, type Result } from './result.ts'
import { encodeUtf8 } from './utf8.ts'

/**
 * RFC 8785 JSON Canonicalization Scheme. This is a stored contract: plan
 * hashes, manifest projections, job argument hashes and signatures depend on
 * its exact bytes, which golden vectors pin in TypeScript and Go.
 *
 * - Members are sorted by the UTF-16 code units of their names. The output is
 *   built from the sorted entries, never by re-creating an object, because
 *   JavaScript enumerates integer-like keys ("1") before all others.
 * - Numbers use ECMAScript Number::toString (so -0 becomes 0).
 * - Strings use ECMAScript JSON string serialization: only `"`, `\` and
 *   U+0000 to U+001F are escaped.
 */
export function canonicalize(value: unknown): Result<string, JsonError> {
  const checked = toJsonValue(value)
  if (!checked.ok) {
    return checked
  }
  return ok(serialize(checked.value))
}

/** {@link canonicalize}, encoded as UTF-8. */
export function canonicalBytes(value: unknown): Result<Uint8Array, JsonError> {
  const text = canonicalize(value)
  return text.ok ? ok(encodeUtf8(text.value)) : err(text.error)
}

function serialize(value: JsonValue): string {
  if (value === null) {
    return 'null'
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      // Number::toString gives the JCS form; -0 prints as "0".
      return String(value)
    case 'string':
      return JSON.stringify(value)
    default:
      break
  }
  if (isJsonArray(value)) {
    return `[${value.map(serialize).join(',')}]`
  }
  // Default string ordering compares UTF-16 code units, which RFC 8785 requires.
  const names = Object.keys(value).sort()
  const members = names.map((name) => {
    const member = value[name]
    if (member === undefined) {
      throw new InvariantError(`canonical JSON member vanished: ${name}`)
    }
    return `${JSON.stringify(name)}:${serialize(member)}`
  })
  return `{${members.join(',')}}`
}
