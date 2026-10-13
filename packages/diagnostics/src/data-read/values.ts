import type { JsonValue } from '@exponetdb/kernel'

/**
 * Typed JSON values of a data read
 * ([sql-execution-security.md §2.2](../../../../exponetdb-docs/03-database-model/sql-execution-security.md#22-execution)):
 * the server's text output (pinned session settings: UTC, ISO dates, hex
 * `bytea`, shortest-exact floats) becomes JSON a client can use without a
 * PostgreSQL driver. Exact where JSON is not (`numeric`, `int8` beyond
 * 2^53, money): a string. Long values are cut visibly:
 *
 * - text longer than {@link TEXT_CAP} characters: `{ value, truncatedAt, length }`;
 * - `bytea`: `{ hex, bytes, truncatedAt? }` with at most {@link BYTEA_HEX_CAP} hex digits;
 * - `vector` (pgvector): `{ dimension, head }` with the first {@link VECTOR_HEAD} values;
 * - JSON values above {@link JSON_CAP} characters: as cut text.
 *
 * The values are data from a managed database: callers label them
 * untrusted and never log them.
 */
export const TEXT_CAP = 10_000
export const BYTEA_HEX_CAP = 2_048
export const VECTOR_HEAD = 8
export const JSON_CAP = 65_536

const BOOL = 16
const BYTEA = 17
const INT8 = 20
const INT2 = 21
const INT4 = 23
const OID = 26
const JSON_OID = 114
const FLOAT4 = 700
const FLOAT8 = 701
const DATE = 1082
const TIMESTAMP = 1114
const TIMESTAMPTZ = 1184
const JSONB = 3802

/** Caps a text value visibly. */
function text(value: string): JsonValue {
  if (value.length <= TEXT_CAP) return value
  return { value: value.slice(0, TEXT_CAP), truncatedAt: TEXT_CAP, length: value.length }
}

/** `2026-10-13 08:00:00.123+00` → `2026-10-13T08:00:00.123Z` (sessions run in UTC). */
function timestamptz(value: string): JsonValue {
  const m = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00$/.exec(value)
  return m === null ? text(value) : `${m[1]}T${m[2]}Z`
}

function timestamp(value: string): JsonValue {
  const m = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value)
  return m === null ? text(value) : `${m[1]}T${m[2]}`
}

function bytea(value: string): JsonValue {
  const hex = value.startsWith('\\x') ? value.slice(2) : value
  const bytes = Math.floor(hex.length / 2)
  return hex.length <= BYTEA_HEX_CAP
    ? { hex, bytes }
    : { hex: hex.slice(0, BYTEA_HEX_CAP), bytes, truncatedAt: BYTEA_HEX_CAP / 2 }
}

function vector(value: string): JsonValue {
  const inner = value.replace(/^\[|\]$/g, '')
  const parts = inner.length === 0 ? [] : inner.split(',')
  return {
    dimension: parts.length,
    head: parts.slice(0, VECTOR_HEAD).map((p) => {
      const n = Number(p)
      return Number.isFinite(n) ? n : p.trim()
    }),
  }
}

const JSON_NUMBER = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y

/**
 * Whether every number in a JSON text survives a JavaScript number: at most
 * 15 significant digits (a double keeps them exactly), an integer within
 * the safe range, and a finite result. Strings are skipped.
 */
function numbersExact(value: string): boolean {
  let inString = false
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]
    if (inString) {
      if (c === '\\') i += 1
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c !== '-' && (c === undefined || c < '0' || c > '9')) continue
    JSON_NUMBER.lastIndex = i
    const token = JSON_NUMBER.exec(value)?.[0] ?? c
    i += token.length - 1
    const n = Number(token)
    if (!Number.isFinite(n)) return false
    if (!/[.eE]/.test(token)) {
      if (!Number.isSafeInteger(n)) return false
      continue
    }
    const mantissa = token.replace(/^-/, '').replace(/[eE].*$/, '')
    const digits = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '')
    if (digits.length > 15) return false
    if (n === 0 && /[1-9]/.test(mantissa)) return false
  }
  return true
}

function json(value: string): JsonValue {
  if (value.length > JSON_CAP) return text(value)
  // A number a double cannot hold (a 19-digit id, 1e400) keeps the value as its exact text.
  if (!numbersExact(value)) return text(value)
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return text(value)
  }
}

/** One value of a column of type `typeOid` (`typeName` for types without a fixed oid, such as `vector`). */
export function typedValue(value: string | null, typeOid: number, typeName: string): JsonValue {
  if (value === null) return null
  switch (typeOid) {
    case BOOL:
      return value === 't'
    case INT2:
    case INT4:
    case OID:
      return Number(value)
    case INT8: {
      const n = Number(value)
      return Number.isSafeInteger(n) ? n : value
    }
    case FLOAT4:
    case FLOAT8: {
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    }
    case BYTEA:
      return bytea(value)
    case JSON_OID:
    case JSONB:
      return json(value)
    case DATE:
      return value
    case TIMESTAMP:
      return timestamp(value)
    case TIMESTAMPTZ:
      return timestamptz(value)
    default:
      return typeName === 'vector' ? vector(value) : text(value)
  }
}

/** The JSON size of a value, counted the way it will be sent. */
export function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
