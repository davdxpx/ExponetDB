import type { SqlClassification } from '@exponetdb/contracts'
import { InvariantError } from '@exponetdb/kernel'
import {
  type Admission,
  admitReadSync,
  analyzeMigrationSql,
  GRAMMARS,
  loadParser,
  type StatementFacts,
  type SupportedMajor,
} from '@exponetdb/postgres/parser'

/**
 * Live statement classification (`POST /sql/classifications`, Wave 8;
 * [sql-execution-security.md §2.5](../../../exponetdb-docs/03-database-model/sql-execution-security.md#25-statement-classification-for-the-web-app-wave-8)).
 *
 * A pure parse of submitted text: the statement split, kinds and facts of
 * `analyzeMigrationSql` and the read-only verdict of `admitRead`, nothing
 * else. No rule of its own decides what is safe: a class is a mapping of a
 * fact the parser-based analysis already derives, and a statement the
 * analysis has no rule for gets no class it cannot show (never "safe by
 * default", C-30). No target is touched and no text leaves this function:
 * only positions, node kinds, closed-vocabulary labels and reason codes.
 */
export type SqlClass = SqlClassification['statements'][number]['classes'][number]
type Statement = SqlClassification['statements'][number]
type Position = Statement['start']
type ReadRefusal = NonNullable<Statement['readOnlyRefusal']>
export type SqlClassificationResult = Omit<SqlClassification, 'computedAt'>

export type SqlClassifyOutcome =
  | { readonly kind: 'classified'; readonly result: SqlClassificationResult }
  | { readonly kind: 'too_many_statements'; readonly count: number }

/** Statement node kinds the analysis maps to the `security` class by kind alone. */
const SECURITY_NODES: ReadonlySet<string> = new Set([
  'GrantStmt',
  'GrantRoleStmt',
  'AlterDefaultPrivilegesStmt',
  'CreatePolicyStmt',
  'AlterPolicyStmt',
  'AlterOwnerStmt',
])

/** Node kinds that are reads when they are admitted and otherwise carry no write fact. */
const READ_NODES_OF_STATEMENT: ReadonlySet<string> = new Set([
  'SelectStmt',
  'VariableShowStmt',
  'ExplainStmt',
])

/** The codes `admitRead` can answer; the `verify.sql` codes come only from `admitVerifySync`. */
const READ_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'QUERY_NOT_READ_ONLY',
  'QUERY_CONSTRUCT_UNSUPPORTED',
  'QUERY_PARSE_ERROR',
])

function isReadRefusalCode(code: string): code is ReadRefusal['code'] {
  return READ_REFUSAL_CODES.has(code)
}

function refusalOf(admission: Admission): ReadRefusal | null {
  if (admission.ok) {
    return null
  }
  if (!isReadRefusalCode(admission.code)) {
    throw new InvariantError(`read admission answered a verify.sql code: ${admission.code}`)
  }
  return { code: admission.code, reason: admission.reason }
}

/**
 * The classes of one statement from the analysis facts and the admission
 * verdict (the mapping is the table of §2.5):
 *
 * - `read_only`: `admitRead` admits the statement;
 * - `write`: it is refused as `QUERY_NOT_READ_ONLY`, or its node kind is none
 *   of SELECT, SHOW and EXPLAIN (every other statement may change data,
 *   schema or session state). A SELECT refused for an unsupported construct
 *   (an unqualified relation, a function outside the allowlist) carries
 *   neither: its effects are not derivable;
 * - `destructive`: the analysis flags `destructive` compatibility;
 * - `rewrite`: the analysis expects a table rewrite (`table`, `possible` or
 *   `unknown`);
 * - `non_transactional`: the statement runs only outside a transaction block;
 * - `security`: grants and revokes, default privileges, policies, row
 *   security, ownership by statement kind, a `SECURITY DEFINER` function, or
 *   a statement the migration engine refuses as role management.
 */
export function classesOf(facts: StatementFacts, admission: Admission): readonly SqlClass[] {
  const classes: SqlClass[] = []
  if (admission.ok) {
    classes.push('read_only')
  } else if (admission.code === 'QUERY_NOT_READ_ONLY' || !READ_NODES_OF_STATEMENT.has(facts.type)) {
    classes.push('write')
  }
  if (facts.compatibility.includes('destructive')) {
    classes.push('destructive')
  }
  if (facts.rewrite !== 'none') {
    classes.push('rewrite')
  }
  if (facts.autocommitOnly) {
    classes.push('non_transactional')
  }
  if (
    SECURITY_NODES.has(facts.type) ||
    facts.forbidden?.reason === 'role_management' ||
    facts.objects.some(
      (o) => o.action === 'grant' || o.action === 'revoke' || o.kind === 'policy',
    ) ||
    facts.expectations.some((e) => e.kind === 'row_security') ||
    facts.details.rlsEnabledOn !== undefined ||
    facts.details.securityDefiner === true
  ) {
    classes.push('security')
  }
  return classes
}

/**
 * Positions of increasing text indices, one forward pass: line (LF-separated,
 * 1-based), column (Unicode code points from the line start, 1-based) and the
 * UTF-16 offset.
 */
function locate(text: string, indices: readonly number[]): Map<number, Position> {
  const wanted = [...new Set(indices)].sort((a, b) => a - b)
  const out = new Map<number, Position>()
  let line = 1
  let column = 1
  let i = 0
  for (const target of wanted) {
    for (; i < target && i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === 10) {
        line++
        column = 1
      } else if (c < 0xdc00 || c > 0xdfff) {
        // A low surrogate completes a pair already counted by its high surrogate.
        column++
      }
    }
    out.set(target, { line, column, offset: Math.min(target, text.length) })
  }
  return out
}

function trimmedEnd(text: string, start: number, end: number): number {
  let e = end
  while (e > start && /\s/.test(text[e - 1] ?? '')) {
    e--
  }
  return e
}

export interface ClassifyOptions {
  readonly maxStatements: number
}

/** Classifies `text` with the grammar of `major`; loads the parser on first use. */
export async function classifySql(
  major: SupportedMajor,
  text: string,
  options: ClassifyOptions,
): Promise<SqlClassifyOutcome> {
  await loadParser(major)
  const bytes = new TextEncoder().encode(text).length
  const base = {
    postgresMajor: major,
    grammar: GRAMMARS[major],
    bytes,
    source: 'parser' as const,
  }
  const analysis = analyzeMigrationSql(major, text)
  if (!analysis.ok) {
    const failure = analysis.failure
    if (failure.kind === 'empty') {
      return {
        kind: 'classified',
        result: {
          ...base,
          status: 'empty',
          statementCount: 0,
          statements: [],
          readOnlyPath: {
            admitted: false,
            refusal: { code: 'QUERY_PARSE_ERROR', reason: 'empty' },
          },
          parseError: null,
        },
      }
    }
    const position =
      failure.kind === 'syntax' && failure.position !== null
        ? (locate(text, [failure.position]).get(failure.position) ?? null)
        : null
    return {
      kind: 'classified',
      result: {
        ...base,
        status: 'parse_error',
        statementCount: 0,
        statements: [],
        readOnlyPath: {
          admitted: false,
          refusal: {
            code: failure.kind === 'syntax' ? 'QUERY_PARSE_ERROR' : 'QUERY_CONSTRUCT_UNSUPPORTED',
            reason:
              failure.kind === 'syntax'
                ? failure.resource
                  ? 'parser_limit'
                  : 'syntax'
                : failure.kind,
          },
        },
        parseError: {
          reason:
            failure.kind === 'syntax'
              ? failure.resource
                ? 'parser_limit'
                : 'syntax'
              : failure.kind,
          position,
        },
      },
    }
  }
  if (analysis.statements.length > options.maxStatements) {
    return { kind: 'too_many_statements', count: analysis.statements.length }
  }
  const ends = analysis.statements.map((s) => trimmedEnd(text, s.start, s.end))
  const positions = locate(text, [...analysis.statements.map((s) => s.start), ...ends])
  const at = (index: number): Position => positions.get(index) as Position
  const statements: Statement[] = analysis.statements.map((facts, n) => {
    const end = ends[n] as number
    // The read-only verdict is of the statement on its own, as the data path takes exactly one.
    const admission = admitReadSync(major, text.slice(facts.start, end))
    return {
      index: facts.index,
      kind: facts.type,
      label: /^[A-Z][A-Z ]{0,63}$/.test(facts.kind)
        ? facts.kind
        : facts.type.toUpperCase().slice(0, 64),
      start: at(facts.start),
      end: at(end),
      classes: [...classesOf(facts, admission)],
      procedural: facts.procedural,
      readOnlyPath: admission.ok,
      readOnlyRefusal: refusalOf(admission),
      migrationRefusal: facts.forbidden?.reason ?? null,
    }
  })
  const only = statements.length === 1 ? (statements[0] as Statement) : undefined
  return {
    kind: 'classified',
    result: {
      ...base,
      status: 'parsed',
      statementCount: statements.length,
      statements,
      readOnlyPath:
        only === undefined
          ? {
              admitted: false,
              refusal: { code: 'QUERY_CONSTRUCT_UNSUPPORTED', reason: 'multiple_statements' },
            }
          : { admitted: only.readOnlyPath, refusal: only.readOnlyRefusal },
      parseError: null,
    },
  }
}
