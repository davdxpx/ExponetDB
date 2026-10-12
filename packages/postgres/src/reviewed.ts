import type { MigrationAnalysis } from './parser/migration.ts'

/**
 * A statement of reviewed bundle content
 * ([planning-and-apply.md §7](../../../exponetdb-docs/04-migrations/planning-and-apply.md#7-statement-execution),
 * [sql-execution-security.md](../../../exponetdb-docs/03-database-model/sql-execution-security.md)).
 *
 * Bundle text is untrusted (C-26): it never runs on an engine path as
 * {@link TrustedSql}. It runs only as a `ReviewedStatement`, which this
 * module alone creates, from a migration's `up.sql` (or `down.sql`) that
 * the parser of the target's major split by its own statement ranges and
 * that has no forbidden statement. Each statement is sent as its own
 * protocol message (extended protocol: the server refuses a second command
 * in it), and only on a migrator session (`TargetSession.executeReviewed`).
 * Like `TrustedSql`, the objects live in a registry; a cast cannot forge one.
 */
export interface ReviewedStatement {
  readonly kind: 'reviewed_sql'
  readonly index: number
  readonly text: string
  /** Runs only outside a transaction block (CONCURRENTLY, VACUUM, …). */
  readonly autocommitOnly: boolean
  readonly line: number
}

const REVIEWED = new WeakSet<object>()

export function isReviewedStatement(value: unknown): value is ReviewedStatement {
  return typeof value === 'object' && value !== null && REVIEWED.has(value)
}

export class ReviewRefused extends Error {
  override readonly name = 'ReviewRefused'
  readonly reason: 'parse_failed' | 'forbidden_statement' | 'no_statements' | 'nul'
  readonly statementIndex: number | null
  constructor(
    reason: 'parse_failed' | 'forbidden_statement' | 'no_statements' | 'nul',
    statementIndex: number | null = null,
  ) {
    super(`The migration text cannot run (${reason}).`)
    this.reason = reason
    this.statementIndex = statementIndex
  }
}

/**
 * The statements of `text` as the analysis of the same text split them,
 * in order. Refuses a failed parse, a forbidden statement, an empty
 * migration and a NUL character.
 */
export function reviewedStatements(text: string, analysis: MigrationAnalysis): ReviewedStatement[] {
  if (!analysis.ok) {
    throw new ReviewRefused('parse_failed')
  }
  if (text.includes('\u0000')) {
    throw new ReviewRefused('nul')
  }
  if (analysis.statements.length === 0) {
    throw new ReviewRefused('no_statements')
  }
  return analysis.statements.map((st) => {
    if (st.forbidden !== null) {
      throw new ReviewRefused('forbidden_statement', st.index)
    }
    const value = Object.freeze({
      kind: 'reviewed_sql' as const,
      index: st.index,
      text: text.slice(st.start, st.end),
      autocommitOnly: st.autocommitOnly,
      line: st.line,
    })
    REVIEWED.add(value)
    return value
  })
}
