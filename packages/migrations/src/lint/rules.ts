/**
 * The V1 lint catalog ([analysis.md §6](../../../../exponetdb-docs/04-migrations/analysis.md#6-linter),
 * [dependency-graph.md §2, §3](../../../../exponetdb-docs/04-migrations/dependency-graph.md),
 * [migration-bundles.md §3, §5](../../../../exponetdb-docs/04-migrations/migration-bundles.md)).
 *
 * Every rule has a stable id, a default level, when it blocks a plan and
 * whether a project may lower it. Rules the engine itself enforces (it
 * cannot run the bundle otherwise, or a constitution article forbids it)
 * are `fixed`: a project override never lowers them. The CLI, CI and the
 * server's planner run the same catalog.
 */
export type LintLevel = 'error' | 'warn' | 'info'

/**
 * When a finding of the rule blocks a plan:
 * - `always`: on every tier;
 * - `prod`: on a production (or unknown) tier;
 * - `prod_large`: on a production (or unknown) tier when the table is
 *   non-trivial, or its size is not known;
 * - `never`: advisory.
 */
export type Blocking = 'always' | 'prod' | 'prod_large' | 'never'

export interface LintRule {
  readonly id: string
  readonly level: LintLevel
  readonly blocking: Blocking
  /** Enforced by the engine; a project override never lowers it. */
  readonly fixed: boolean
  readonly summary: string
  readonly remediation: string
}

function rule(
  id: string,
  level: LintLevel,
  blocking: Blocking,
  summary: string,
  remediation: string,
  fixed = false,
): LintRule {
  return { id, level, blocking, fixed, summary, remediation }
}

export const LINT_RULES = {
  // ----- content the engine refuses -----
  forbidden_statement: rule(
    'forbidden_statement',
    'error',
    'always',
    'A statement class the engine never runs (transaction control, roles, ALTER SYSTEM, server files, the exponetdb schema, settings the executor pins).',
    'Remove the statement; cluster-level changes are node operations (postgres.roles.apply, postgres.extensions.apply, postgres.config.apply).',
    true,
  ),
  parse_error: rule(
    'parse_error',
    'error',
    'always',
    'The file does not parse with the grammar of the target major.',
    'Fix the syntax at the reported position; check the PostgreSQL version the target runs.',
    true,
  ),
  nontransactional_statement_in_transactional: rule(
    'nontransactional_statement_in_transactional',
    'error',
    'always',
    'A statement PostgreSQL refuses inside a transaction block, in a bundle with transactional: true.',
    'Move the statement into its own bundle with execution.transactional: false.',
    true,
  ),
  needless_nontransactional: rule(
    'needless_nontransactional',
    'error',
    'always',
    'transactional: false without a statement that needs autocommit.',
    'Set execution.transactional: true; non-transactional mode is more dangerous and needs a reason in the content.',
    true,
  ),
  multiple_nontransactional_statements: rule(
    'multiple_nontransactional_statements',
    'warn',
    'never',
    'A non-transactional bundle with more than one statement.',
    'Keep one non-transactional statement per bundle, so a failure leaves a comprehensible state.',
  ),
  enum_value_used_in_same_tx: rule(
    'enum_value_used_in_same_tx',
    'error',
    'always',
    'ALTER TYPE … ADD VALUE followed by a use of the new value in the same transaction.',
    'Split the migration: add the value in one bundle, use it in a later one.',
    true,
  ),
  cic_on_partitioned_table: rule(
    'cic_on_partitioned_table',
    'error',
    'always',
    'CREATE INDEX CONCURRENTLY on a partitioned table (PostgreSQL does not support it).',
    'Build the index on each partition concurrently, then attach them to an index created ON ONLY the parent.',
    true,
  ),
  security_definer_without_search_path: rule(
    'security_definer_without_search_path',
    'error',
    'always',
    'A SECURITY DEFINER function without SET search_path.',
    "Add SET search_path = '' (and qualify every name in the body) or a fixed list of trusted schemas.",
    true,
  ),
  verify_statement_without_assertion: rule(
    'verify_statement_without_assertion',
    'error',
    'always',
    'A verify.sql statement that is not a SELECT with an ok column (and optionally detail).',
    'Write each check as SELECT … AS ok [, … AS detail]; see verification.md §4.',
    true,
  ),
  verify_admission: rule(
    'verify_admission',
    'error',
    'always',
    'verify.sql uses a construct admission refuses (a write, a locking clause, a function outside the allowlist, an unqualified relation, …).',
    'Rewrite the check with allowlisted built-ins and schema-qualified tables; declare consumer code with -- calls: or -- reads-view: (it then needs an approval).',
    true,
  ),
  // ----- the graph -----
  unknown_dependency: rule(
    'unknown_dependency',
    'error',
    'always',
    'dependsOn names a migration the stream does not know.',
    'Restore the missing bundle or correct dependsOn (only before the migration was applied).',
    true,
  ),
  dependency_cycle: rule(
    'dependency_cycle',
    'error',
    'always',
    'The dependsOn declarations form a cycle.',
    'Remove one edge of the cycle (only before any of the migrations was applied).',
    true,
  ),
  duplicate_migration_id: rule(
    'duplicate_migration_id',
    'error',
    'always',
    'Two bundles share a migration id.',
    'Give one of them a new ULID (exponetdb migration new).',
    true,
  ),
  unanchored_root: rule(
    'unanchored_root',
    'error',
    'always',
    'A migration without dependsOn in a stream that has a baseline.',
    'Depend on the baseline (baseline:<slug>) or on a later bundle.',
    true,
  ),
  duplicate_dependency: rule(
    'duplicate_dependency',
    'info',
    'never',
    'dependsOn lists an id twice (deduplicated).',
    'Remove the repeated entry.',
  ),
  parallel_object_overlap: rule(
    'parallel_object_overlap',
    'warn',
    'prod',
    'Two migrations without an order between them touch the same object.',
    'Add an explicit dependsOn edge between them before merging.',
  ),
  // ----- the manifest against the content -----
  missing_verify_sql: rule(
    'missing_verify_sql',
    'error',
    'prod',
    'No runtime checks (verification.runtimeChecks: none).',
    'Add verify.sql with checks that assert the intent, data post-conditions of backfills included.',
  ),
  missing_description: rule(
    'missing_description',
    'error',
    'prod',
    'The description does not say why the change exists.',
    'Describe the change and its reason in a sentence or two.',
  ),
  compatibility_understated: rule(
    'compatibility_understated',
    'error',
    'always',
    'compatibility.declared is less strict than the statements are.',
    'Declare the observed class (and notes); split expand and contract into separate migrations where possible.',
    true,
  ),
  compatibility_unknown: rule(
    'compatibility_unknown',
    'warn',
    'never',
    'The analyzer cannot classify a statement: the plan gates it like the most severe class.',
    'Prefer statements the analyzer classifies; a production plan needs an approval.',
  ),
  declared_stricter_than_needed: rule(
    'declared_stricter_than_needed',
    'info',
    'never',
    'compatibility.declared is stricter than the statements need.',
    'Nothing to do; a stricter class only asks for more review.',
  ),
  long_lock_timeout: rule(
    'long_lock_timeout',
    'warn',
    'never',
    'execution.lockTimeout above 60 s.',
    'Keep lock waits short (default 5 s) so a migration never queues the application behind it.',
  ),
  extension_not_declared: rule(
    'extension_not_declared',
    'error',
    'prod',
    'The SQL uses a type or function of an extension that requires.extensions does not list.',
    'Add the extension to requires.extensions (with a version range).',
  ),
  // ----- lock and rewrite risk -----
  create_index_without_concurrently: rule(
    'create_index_without_concurrently',
    'warn',
    'prod_large',
    'A blocking index build (CREATE INDEX without CONCURRENTLY).',
    'Use CREATE INDEX CONCURRENTLY IF NOT EXISTS in its own non-transactional bundle.',
  ),
  unsafe_not_null: rule(
    'unsafe_not_null',
    'warn',
    'prod_large',
    'SET NOT NULL without a validated CHECK (col IS NOT NULL) that proves it.',
    'Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL, then drop the check.',
  ),
  add_constraint_without_not_valid: rule(
    'add_constraint_without_not_valid',
    'warn',
    'prod_large',
    'A validated CHECK or FOREIGN KEY added to an existing table (full scan under lock).',
    'Add it NOT VALID, then VALIDATE CONSTRAINT in a separate migration.',
  ),
  volatile_default_rewrite: rule(
    'volatile_default_rewrite',
    'warn',
    'prod_large',
    'ADD COLUMN with a volatile default rewrites the table under ACCESS EXCLUSIVE.',
    'Add the column without a default (or a constant one), then backfill in bounded batches.',
  ),
  type_change_rewrite: rule(
    'type_change_rewrite',
    'warn',
    'prod_large',
    'ALTER COLUMN TYPE may rewrite the table under ACCESS EXCLUSIVE.',
    'Add a new column, backfill, switch reads, then drop the old column (expand and contract).',
  ),
  data_change_unbounded: rule(
    'data_change_unbounded',
    'warn',
    'prod',
    'UPDATE or DELETE without a WHERE clause.',
    'Bound the change, or run a batched data migration; the plan shows it as data_rewrite or destructive.',
  ),
  uncovered_statement: rule(
    'uncovered_statement',
    'warn',
    'prod',
    'A statement whose effect the engine cannot derive and that no verify.sql check covers: verification can only end partial, which is no production evidence.',
    "Add a verify.sql check with -- covers: <statement index> that asserts the statement's effect.",
  ),
  // ----- expand and contract -----
  drop_without_expand_contract: rule(
    'drop_without_expand_contract',
    'warn',
    'never',
    'A dropped column or table: the running build may still use it.',
    'Drop only after a deployed build stopped using it (a later contract migration).',
  ),
  rename_in_place: rule(
    'rename_in_place',
    'warn',
    'never',
    'A rename breaks running code.',
    'Prefer add, copy and drop across migrations.',
  ),
  // ----- security and grants -----
  function_search_path_mutable: rule(
    'function_search_path_mutable',
    'warn',
    'never',
    'A function without a pinned search_path.',
    "Add SET search_path = '' or a fixed schema list.",
  ),
  policy_always_true: rule(
    'policy_always_true',
    'warn',
    'never',
    'A non-SELECT policy whose USING or WITH CHECK is true.',
    'Restrict the policy, or document why every row is writable.',
  ),
  table_without_rls: rule(
    'table_without_rls',
    'error',
    'always',
    'A new table in a schema where the project requires row level security, without ENABLE ROW LEVEL SECURITY in the same migration.',
    'Enable row level security and add the policies in the same migration.',
  ),
  table_without_grant: rule(
    'table_without_grant',
    'warn',
    'prod',
    'A new table without an explicit GRANT in the same migration.',
    'Grant exactly the privileges the application roles need; do not rely on default privileges.',
  ),
  forbidden_schema: rule(
    'forbidden_schema',
    'error',
    'always',
    'The SQL names a schema the project forbids.',
    'Remove the reference; see the project configuration (lint.forbiddenSchemas).',
  ),
  forbidden_function: rule(
    'forbidden_function',
    'error',
    'always',
    'The SQL calls a function the project forbids.',
    'Remove the call; see the project configuration (lint.forbiddenFunctions).',
  ),
  conditional_ddl: rule(
    'conditional_ddl',
    'warn',
    'never',
    'A DO block that branches on catalog state: environments can diverge.',
    'Write the change unconditionally; staging evidence then holds for production.',
  ),
  // ----- history -----
  checksum_mismatch: rule(
    'checksum_mismatch',
    'error',
    'always',
    'The migration id is applied (or imported) with another apply checksum.',
    'Restore the applied bytes; put the change into a new migration (C-14).',
    true,
  ),
  comment_only_change: rule(
    'comment_only_change',
    'info',
    'never',
    'Only comments or whitespace of up.sql changed since it was applied.',
    'Nothing to do; the apply checksum is unchanged.',
  ),
  renamed_applied_migration: rule(
    'renamed_applied_migration',
    'info',
    'never',
    'The bundle name changed after the migration was applied.',
    'Nothing to do; the id and checksum decide.',
  ),
  rewritten_unapplied_migration: rule(
    'rewritten_unapplied_migration',
    'info',
    'never',
    'The content changed since it was last ingested, before any apply.',
    'Nothing to do; the earlier content stays in the bundle store for audit.',
  ),
} as const satisfies Record<string, LintRule>

export type LintRuleId = keyof typeof LINT_RULES

export function isLintRuleId(value: string): value is LintRuleId {
  return Object.hasOwn(LINT_RULES, value)
}
