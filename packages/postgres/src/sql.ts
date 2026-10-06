import { randomBytes } from 'node:crypto'
import { encodeUtf8 } from '@exponetdb/kernel'

/**
 * Provenance of SQL text ([postgres-adapter.md §6](../../../exponetdb-docs/03-database-model/postgres-adapter.md#6-safe-sql-builder-and-escaping),
 * [sql-execution-security.md §1](../../../exponetdb-docs/03-database-model/sql-execution-security.md#1-engine-authored-sql-introspection-diagnostics-operator-actions)).
 *
 * `TrustedSql` is engine-built SQL. It is a frozen object that only this
 * module creates (a registry of instances, not a branded string), so a cast
 * cannot forge one: the session refuses every value that is not in the
 * registry. Values always travel as bind parameters; the only text that can
 * be spliced into engine SQL is another `TrustedSql` fragment or an
 * identifier through {@link ident}, which always quotes.
 *
 * Text from users, agents, bundles or catalogs is `UntrustedSql`: it can be
 * parsed, classified and redacted, never executed by an engine path.
 */
export interface TrustedSql {
  readonly kind: 'trusted_sql'
  readonly text: string
}

const TRUSTED = new WeakSet<object>()

function trusted(text: string): TrustedSql {
  if (text.includes('\u0000')) {
    throw new SqlBuildError('nul_in_sql')
  }
  const value = Object.freeze({ kind: 'trusted_sql' as const, text })
  TRUSTED.add(value)
  return value
}

export function isTrustedSql(value: unknown): value is TrustedSql {
  return typeof value === 'object' && value !== null && TRUSTED.has(value)
}

export type SqlBuildErrorCode =
  | 'not_a_template'
  | 'untrusted_fragment'
  | 'nul_in_sql'
  | 'empty_identifier'
  | 'identifier_too_long'

export class SqlBuildError extends Error {
  override readonly name = 'SqlBuildError'
  readonly code: SqlBuildErrorCode
  constructor(code: SqlBuildErrorCode) {
    super(`Engine SQL could not be built (${code}).`)
    this.code = code
  }
}

function isTemplate(strings: unknown): strings is TemplateStringsArray {
  return (
    Array.isArray(strings) &&
    Object.isFrozen(strings) &&
    'raw' in strings &&
    Array.isArray(strings.raw) &&
    strings.raw.length === strings.length &&
    strings.every((s) => typeof s === 'string')
  )
}

/**
 * Engine SQL from a template literal. The literal parts are code; every
 * interpolation must itself be a `TrustedSql` (another fragment, or an
 * identifier from {@link ident}). A value is never interpolated: pass it as
 * a bind parameter (`$1`) instead.
 */
export function sql(strings: TemplateStringsArray, ...parts: readonly TrustedSql[]): TrustedSql {
  if (!isTemplate(strings)) {
    throw new SqlBuildError('not_a_template')
  }
  let text = strings[0] ?? ''
  parts.forEach((part, i) => {
    if (!isTrustedSql(part)) {
      throw new SqlBuildError('untrusted_fragment')
    }
    text += part.text + (strings[i + 1] ?? '')
  })
  return trusted(text)
}

/** Joins trusted fragments with a trusted separator. */
export function join(parts: readonly TrustedSql[], separator: TrustedSql): TrustedSql {
  if (!parts.every(isTrustedSql) || !isTrustedSql(separator)) {
    throw new SqlBuildError('untrusted_fragment')
  }
  return trusted(parts.map((p) => p.text).join(separator.text))
}

/** PostgreSQL's identifier limit (`NAMEDATALEN - 1`); longer names are truncated by the server. */
export const MAX_IDENTIFIER_BYTES = 63

/**
 * Quotes an identifier, always (no "unquoted when safe" heuristic, so no
 * reserved-word list can be wrong). Refuses NUL and the empty name.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new SqlBuildError('empty_identifier')
  }
  if (name.includes('\u0000')) {
    throw new SqlBuildError('nul_in_sql')
  }
  return `"${name.replaceAll('"', '""')}"`
}

/** True when the server would truncate the name (more than 63 bytes in UTF-8). */
export function identifierTooLong(name: string): boolean {
  return encodeUtf8(name).length > MAX_IDENTIFIER_BYTES
}

/**
 * An identifier as a trusted fragment. Engine identifiers longer than the
 * server limit are refused rather than silently truncated into another name.
 */
export function ident(name: string): TrustedSql {
  if (identifierTooLong(name)) {
    throw new SqlBuildError('identifier_too_long')
  }
  return trusted(quoteIdent(name))
}

/** A schema-qualified name: `"schema"."name"`. */
export function qualified(schema: string, name: string): TrustedSql {
  return sql`${ident(schema)}.${ident(name)}`
}

/**
 * A string literal for the rare places where a bind parameter is
 * impossible (for example `ALTER ROLE … PASSWORD` with a SCRAM verifier in
 * human-run bootstrap SQL): an `E''` literal with backslashes and quotes
 * doubled, independent of `standard_conforming_strings`. Refuses NUL.
 */
export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) {
    throw new SqlBuildError('nul_in_sql')
  }
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

/** A literal as a trusted fragment (see {@link quoteLiteral}). */
export function literal(value: string): TrustedSql {
  return trusted(quoteLiteral(value))
}

/**
 * A dollar-quoted body whose tag does not occur in the body (random suffix,
 * re-drawn on collision). Refuses NUL.
 */
export function dollarQuote(body: string, random: () => string = defaultTag): string {
  if (body.includes('\u0000')) {
    throw new SqlBuildError('nul_in_sql')
  }
  for (;;) {
    const tag = `$exdb_${random()}$`
    if (!body.includes(tag)) {
      return `${tag}${body}${tag}`
    }
  }
}

function defaultTag(): string {
  return randomBytes(8).toString('hex')
}
