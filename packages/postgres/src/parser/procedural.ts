import type { StatementFacts } from './migration.ts'

/**
 * Whether a migration file's statements are procedural (OD-55 (c),
 * [policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md#4-rule-catalog-v1),
 * [planning-and-apply.md §2](../../../../exponetdb-docs/04-migrations/planning-and-apply.md#2-plan-content)):
 * code whose effects the analyzer cannot read from the statement text,
 * because it runs a body (a `DO` block, a procedure, a function called by a
 * top-level `SELECT`, by `CREATE TABLE … AS`, a materialized view or its
 * `REFRESH`), creates code a later statement or trigger can run (a routine,
 * a trigger, a rule), or builds SQL at run time (dynamic SQL, where the
 * text shows it). Pure; the honesty rule applies (C-30): a file whose
 * statements are not known counts as procedural (`unclassified`).
 *
 * Not procedural by this classification: calls of routines that exist
 * before the migration from a DDL or DML expression (a default, an index
 * expression, `INSERT … SELECT f()`). The executor's ledger guard covers
 * what such code does to the `exponetdb` schema; what it does elsewhere is
 * the residual risk T38 records.
 */
export const PROCEDURAL_REASONS = [
  'do_block',
  'call',
  'function_call',
  'routine_created',
  'trigger_created',
  'dynamic_sql',
  'unclassified',
] as const
export type ProceduralReason = (typeof PROCEDURAL_REASONS)[number]

/** Built-in functions that run SQL text they receive (dynamic SQL without PL/pgSQL). */
const SQL_TEXT_FUNCTIONS: ReadonlySet<string> = new Set([
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'dblink',
  'dblink_exec',
  'dblink_open',
  'dblink_send_query',
])

function lastPart(name: string): string {
  const at = name.lastIndexOf('.')
  return (at < 0 ? name : name.slice(at + 1)).replaceAll('"', '').toLowerCase()
}

/**
 * The reasons a file's statements are procedural, sorted and without
 * repeats; empty when none is. `null` (the file did not parse, or there is
 * no analysis) and an empty list both count as `unclassified`.
 */
export function proceduralReasons(
  statements: readonly StatementFacts[] | null,
): ProceduralReason[] {
  if (statements === null || statements.length === 0) return ['unclassified']
  const out = new Set<ProceduralReason>()
  for (const s of statements) {
    switch (s.type) {
      case 'DoStmt':
        out.add('do_block')
        break
      case 'CallStmt':
        out.add('call')
        break
      case 'CreateFunctionStmt':
        out.add('routine_created')
        break
      case 'CreateTrigStmt':
      case 'CreateEventTrigStmt':
      // A rule rewrites a later statement into its actions, as a trigger runs code (review E-3).
      case 'RuleStmt':
        out.add('trigger_created')
        break
      // These run a query, which can call any function, as a top-level SELECT does (review E-2).
      case 'CreateTableAsStmt':
      case 'RefreshMatViewStmt':
        out.add('function_call')
        break
      default:
        // A top-level SELECT (or any other statement the analyzer marks procedural).
        if (s.procedural) out.add('function_call')
    }
    if (s.details.dynamicSql === true) out.add('dynamic_sql')
    if (s.details.referencedNames.some((n) => SQL_TEXT_FUNCTIONS.has(lastPart(n)))) {
      out.add('dynamic_sql')
    }
  }
  return PROCEDURAL_REASONS.filter((r) => out.has(r))
}

/** The reasons of several files together (a plan's bundles). */
export function mergeProceduralReasons(
  lists: readonly (readonly ProceduralReason[])[],
): ProceduralReason[] {
  const all = new Set(lists.flat())
  return PROCEDURAL_REASONS.filter((r) => all.has(r))
}
