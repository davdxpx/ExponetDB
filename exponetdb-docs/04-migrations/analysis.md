# Migration analysis: compatibility, locks, rewrites, lint

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 6 |
| Read before | [`planning-and-apply.md`](./planning-and-apply.md) |
| Sources | PostgreSQL 17 docs: `ALTER TABLE` (lock levels per subcommand), explicit locking, `CREATE INDEX`, `ALTER TYPE` |

Analysis turns parsed statements into facts a human, an agent and the Policy
Engine can act on. Its first rule is honesty:

> **[DECIDED]** When a property cannot be established, the result is `unknown`,
> never `safe`. `unknown` gates like the most severe class
> ([C-30](../00-product/constitution.md#c-30-no-claimed-safety-without-proof), [C-11](../00-product/constitution.md#c-11-unknown-safety-state-fails-closed-for-writes)).

## 1. Inputs

- The parse tree of every statement (libpg_query for the target major version).
- Catalog facts read at plan time with the observer role: relation kinds, sizes
  (`pg_relation_size`, `reltuples`, `relpages`), existing indexes and
  constraints, column types, dependent objects (`pg_depend`) for drops, current
  privileges.
- The manifest's declared compatibility class.

Analysis does **not** execute anything on the target. Shadow execution (applying
on a scratch copy to observe effects) is a planned extension
([OD-16](../00-product/open-decisions.md#od-16-shadow-apply-before-production)); in V1 the
staging application *is* the shadow, and staging evidence is how its result is
carried to production.

## 2. Compatibility classes

**[DECIDED]** The question compatibility answers: *can the application version
currently running against this database keep working while and after this
migration is applied?* This is REOSA's existing owner rule ("production
immediately only if compatible with the still running build") made
machine-readable.

| Class | Meaning | Typical statements |
|---|---|---|
| `additive` | Adds things old code does not see or tolerates. | `CREATE TABLE`, `ADD COLUMN` nullable or with a non-volatile default, `CREATE INDEX`, new function, new policy that only *grants* access (permissive, new role), `GRANT` |
| `potentially_breaking` | Old code may fail or behave differently. | `RENAME` (table, column), `SET NOT NULL`, type narrowing, CHECK added or narrowed (`DROP CONSTRAINT` + `ADD CONSTRAINT` with a different expression), `REVOKE`, policy change or restrictive policy, `ENABLE`/`FORCE ROW LEVEL SECURITY` on a table that had none, function signature or return type change, dropping a default |
| `data_rewrite` | Rewrites or bulk-modifies existing rows. | `ALTER COLUMN TYPE` with rewrite, `ADD COLUMN` with a volatile default, `UPDATE`/`DELETE` without a selective predicate, `VACUUM FULL`, `CLUSTER` |
| `destructive` | Removes data or objects irreversibly. | `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE`, `DROP SCHEMA … CASCADE`, `DROP` of a type in use |
| `unknown` | Not derivable. | `DO` blocks, dynamic SQL, statements the analyzer has no rule for |

A migration's **observed class** is the most severe class over its statements,
ordered `additive < potentially_breaking < data_rewrite < destructive`, with
`unknown` treated as at least `destructive` for gating while being reported as
`unknown`. A migration can carry several flags (for example both `data_rewrite`
and `potentially_breaking`); the plan lists all flags.

The manifest's `compatibility.declared` is compared with the observed class:

| Declared vs observed | Result |
|---|---|
| equal | ok |
| declared stricter than observed | ok (lint info `declared_stricter_than_needed`) |
| declared less strict than observed | blocking lint `compatibility_understated` |
| observed `unknown` | the declared class stands for display, but gating uses `unknown`; prod tier requires approval |

The engine does **not** know the consumer's application code. It cannot prove
that a new `NOT NULL` column with a default is harmless to a particular build; it
can only classify the SQL. The policy decision combines the class with
environment rules (see [`staging-production-policy.md`](./staging-production-policy.md)).
Expand/contract discipline (add new, migrate, remove old in a later migration) is
the recommended authoring pattern and is described in
[`authoring-and-ci.md`](./authoring-and-ci.md).

## 3. Lock analysis

**[DECIDED]** For each statement the analyzer determines the lock mode taken on
each affected relation, from a rule table that encodes the PostgreSQL
documentation for the target major version, and a severity:

| Severity | Lock modes | Meaning for a live system |
|---|---|---|
| `none` | no relation lock beyond `ACCESS SHARE` | invisible |
| `low` | `SHARE UPDATE EXCLUSIVE`, `ROW EXCLUSIVE` | reads and writes continue; conflicts with other DDL/VACUUM |
| `medium` | `SHARE ROW EXCLUSIVE`, `SHARE` held briefly | writes blocked for the duration |
| `high` | `SHARE` for a scan-length operation, `ACCESS EXCLUSIVE` held briefly (metadata-only change) | writes, or all access, blocked briefly; dangerous behind long-running queries (lock queue) |
| `critical` | `ACCESS EXCLUSIVE` for a scan or rewrite of a non-trivial table | all access blocked for a duration proportional to table size |
| `unknown` | no rule | gates like `critical` |

Rule table excerpt (PostgreSQL 17):

| Statement | Lock | Duration driver | Severity rule |
|---|---|---|---|
| `CREATE INDEX` | `SHARE` | table scan | `high` (`critical` above size threshold) |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | two scans, waits for old transactions | `low`; non-transactional |
| `DROP INDEX` | `ACCESS EXCLUSIVE` on table | brief | `high` |
| `DROP INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | waits for transactions | `low`; non-transactional |
| `ADD COLUMN` (no default or non-volatile default) | `ACCESS EXCLUSIVE` | metadata only | `high` (brief, but queues) |
| `ADD COLUMN … DEFAULT volatile()` | `ACCESS EXCLUSIVE` | full rewrite | `critical` |
| `ALTER COLUMN TYPE` (binary coercible, no `USING` content change) | `ACCESS EXCLUSIVE` | no rewrite; indexes may rebuild | `high` |
| `ALTER COLUMN TYPE` (otherwise) | `ACCESS EXCLUSIVE` | rewrite + index rebuild | `critical` |
| `SET NOT NULL` without a valid `CHECK (col IS NOT NULL)` | `ACCESS EXCLUSIVE` | full scan | `critical` above size threshold |
| `SET NOT NULL` with a valid proving CHECK | `ACCESS EXCLUSIVE` | no scan | `high` |
| `ADD CONSTRAINT CHECK … NOT VALID` | `ACCESS EXCLUSIVE` | no scan | `high` |
| `ADD CONSTRAINT CHECK` (validated) | `ACCESS EXCLUSIVE` | full scan | `critical` above threshold |
| `ADD FOREIGN KEY … [NOT VALID]` | `SHARE ROW EXCLUSIVE` on both tables | scan unless `NOT VALID` | `medium` / `high` |
| `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` (+ `ROW SHARE` on referenced table for FKs) | scan | `low` |
| `CREATE TRIGGER`, `ENABLE/DISABLE TRIGGER` | `SHARE ROW EXCLUSIVE` | brief | `medium` |
| `CREATE POLICY`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY` | `ACCESS EXCLUSIVE` | brief | `high` |
| `ALTER TYPE … ADD VALUE` | lock on the type | brief; new value unusable until commit | `low`; lint if the same migration uses the value |
| `ATTACH PARTITION` | `SHARE UPDATE EXCLUSIVE` on parent, `ACCESS EXCLUSIVE` on partition and default partition | scan of partition unless a CHECK proves bounds | `high` |
| `VACUUM FULL`, `CLUSTER` | `ACCESS EXCLUSIVE` | full rewrite | `critical` |
| `REFRESH MATERIALIZED VIEW` | `ACCESS EXCLUSIVE` on the view | query duration | `high` |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `EXCLUSIVE` | query duration | `medium` |
| `GRANT`/`REVOKE` | none on data (catalog) | brief | `none` |
| `CREATE TABLE`, `CREATE FUNCTION`, `CREATE VIEW` | none on existing relations (for views: `ACCESS SHARE` on referenced) | brief | `none` |

**Size threshold**: a table counts as "non-trivial" when its heap is larger than
64 MiB or `reltuples` exceeds 1 million (project-configurable). Below that,
scan- and rewrite-bound statements are downgraded one severity level, because the
operation completes in well under a typical `lock_timeout`. Sizes come from the
target at plan time and are shown in the plan; if statistics are missing
(`reltuples = -1`), the size is `unknown` and the severity is not downgraded.

**[DECIDED]** No duration guarantees. The plan may show "rewrites ~1.2 GB" as an
input for human judgement; it never says "takes 40 s".

**Lock-queue note.** Even a `high` statement that holds its lock for
milliseconds can stall the application if it waits behind a long-running query,
because every later query queues behind it. This is why every statement runs with
`lock_timeout` ([`planning-and-apply.md` §6](./planning-and-apply.md#6-lock-queue-safety))
and why the plan shows, for prod tier, the currently longest-running queries on
the affected tables (from `pg_stat_activity`, redacted) as context.

## 4. Destructive operations and dependent objects

For `DROP … CASCADE`, `DROP COLUMN`, `DROP TABLE`, `DROP FUNCTION`, `DROP TYPE`,
the analyzer lists dependent objects from `pg_depend` (views, policies,
constraints, triggers, default expressions) and row estimates for dropped
tables. The plan shows "this also removes: …". A `CASCADE` whose dependent set
is not empty is flagged `destructive` even if the primary object is empty.

## 5. Rollback availability

The analysis records `rollback.available` (a `down.sql` exists) and the author's
declared `rollback.safety` (`safe`, `lossy`, `unsafe`). The engine adds an
observation: a `down.sql` paired with a `destructive` or `data_rewrite` `up.sql`
is at best `lossy`; the plan shows the lower of declared and observed. See
[`failure-and-recovery.md`](./failure-and-recovery.md#3-downsql).

## 6. Linter

**[DECIDED]** The linter runs in the CLI (local, pre-commit, CI) and at planning.
Each rule has an id, a level (`error`, `warn`, `info`), a message, and a
`blocking` flag. A rule's level can be configured per project
(`exponetdb.project.yaml`, `lintProfile` + overrides); a lowered level for a
prod-tier project is recorded and shown in plans. Not every warning is a
blocker.

| Rule | Default | Blocking (prod tier) | What it catches |
|---|---|---|---|
| `missing_verify_sql` | error | yes | no runtime checks |
| `missing_description` | error | yes | |
| `compatibility_understated` | error | yes | declared class weaker than observed |
| `nontransactional_statement_in_transactional` | error | yes | `CONCURRENTLY`, `VACUUM` etc. with `transactional: true` |
| `needless_nontransactional` | error | yes | `transactional: false` without a statement that needs it |
| `forbidden_statement` | error | yes | transaction control, roles, `ALTER SYSTEM`, psql meta-commands, `exponetdb` schema |
| `unknown_dependency` / `dependency_cycle` | error | yes | DAG errors |
| `parallel_object_overlap` | warn | yes | two unordered migrations touch the same object |
| `create_index_without_concurrently` | warn | no (yes above size threshold) | blocking index build on a non-trivial table |
| `unsafe_not_null` | warn | yes above size threshold | `SET NOT NULL` without a validated proving CHECK |
| `add_constraint_without_not_valid` | warn | yes above size threshold | validated constraint added to a non-trivial table |
| `volatile_default_rewrite` | warn | yes above size threshold | |
| `type_change_rewrite` | warn | yes above size threshold | |
| `drop_without_expand_contract` | warn | no | `DROP COLUMN` in the same migration that stops using it, or without a prior deprecation migration |
| `rename_in_place` | warn | no | rename breaks running code; prefer add+copy+drop |
| `security_definer_without_search_path` | error | yes | `SECURITY DEFINER` function without `SET search_path` |
| `function_search_path_mutable` | warn | no | functions without pinned `search_path` |
| `table_without_rls` | per project invariant | per project | new table in a schema where the project requires RLS |
| `table_without_grant` | warn | per project | new table without an explicit `GRANT` (REOSA's rule since 0172) |
| `policy_always_true` | warn | no | `USING (true)` on non-SELECT policies |
| `conditional_ddl` | warn | no | `DO` blocks branching on `pg_roles`, `to_regclass`, catalog lookups (makes environments diverge) |
| `enum_value_used_in_same_tx` | error | yes | `ADD VALUE` followed by use of the value in the same transaction |
| `cic_on_partitioned_table` | error | yes | unsupported by PostgreSQL |
| `long_lock_timeout` | warn | no | `lockTimeout` above 60 s |
| `extension_not_declared` | error | yes | uses an extension type/function not listed in `requires.extensions` |
| `verify_statement_without_assertion` | error | yes | verify statement without an `ok` column (refused by admission, see [`verification.md` §4.2](./verification.md#42-admission-plan-time)) |
| `comment_only_change` | info | no | source digest changed, checksum did not |
| `renamed_applied_migration` | info | no | slug changed after apply |
| `rewritten_unapplied_migration` | info | no | content changed before any apply |

**[OBSERVED]** Several rules restate REOSA's own written rules that are today
enforced by reading SQL (`.claude/rules/migrations.md`,
`.claude/rules/portability.md`): explicit grants per table, no reliance on
provider default privileges, idempotency guards, no `auth.uid()`. Project-level
custom rules (for example "no reference to schema `auth`") are expressed as
configurable rule parameters (forbidden schemas, forbidden functions), not as
plugin code, in V1.

The generic subset of the Supabase reference linter ("splinter") informs the
live-schema advisors more than the migration linter; see
[`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md#advisors-and-lints).
