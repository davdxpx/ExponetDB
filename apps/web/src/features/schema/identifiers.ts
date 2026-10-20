/**
 * Quoting of PostgreSQL identifiers for the SQL text the schema browser builds
 * (the browse query, the "Query this table" text, the copied qualified name).
 *
 * Every identifier is quoted, always: a plain lower-case name is quoted too.
 * The SQL page's completion helper leaves plain names bare, which is right for
 * text a person edits and wrong here, where a name is data from the catalog
 * (C-26) and must never be read as anything but one identifier. Inside double
 * quotes only the quote itself is special, so doubling it is the whole rule;
 * a semicolon, `--`, `$$`, a space or a bidirectional character stays part of
 * the one identifier.
 */

/** `a"b` as `"a""b"`. Total: it quotes any text, see `isQuotableIdentifier` for what PostgreSQL can hold. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Whether PostgreSQL can hold the text as an identifier: it is not empty and
 * has no NUL character (a catalog never returns either, so one that shows up
 * is a corrupt read and no query is built from it).
 */
export function isQuotableIdentifier(name: string): boolean {
  return name.length > 0 && !name.includes('\u0000')
}

/** `"schema"."name"`. */
export function quotedRelation(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}
