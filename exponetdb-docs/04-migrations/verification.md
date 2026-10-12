# Verification

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 6 |
| Read before | [`planning-and-apply.md`](./planning-and-apply.md), [`ledger.md`](./ledger.md), [`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md) |

> "Migration applied" must never mean "the SQL did not throw".
> ([C-13](../00-product/constitution.md#c-13-applied-is-not-verified))

Verification is a first-class phase of every migration. Its result is recorded
separately from the apply result, has its own history, and is the substance of
staging evidence.

## 1. Apply status versus verification status

**[DECIDED]**

| | Apply status | Verification status |
|---|---|---|
| Question | Did `up.sql` commit? | Does the database now have the intended structure and properties? |
| Values | `applied`, `partially_applied`, `not_applied`, `unknown` | `pending`, `passed`, `failed`, `partial`, `error` |
| Stored | Ledger row presence (`schema_migrations`) and `migration_events` | `migration_verifications` rows, append-only; latest row wins |
| Changes when | Never after `applied` (except a recorded revert) | Each verification run adds a row |

Status meanings:

- `passed`: every check that ran passed, every statement of `up.sql` is covered
  by at least one derived structural expectation or by a runtime check, and the
  engine checks passed.
- `failed`: at least one check failed.
- `partial`: no check failed, but coverage is incomplete (statements whose
  effect the engine could not derive and that no `verify.sql` check covers), or a
  check category was skipped by configuration. **`partial` is not evidence**: a
  production plan treats it like `failed` unless policy explicitly accepts it with
  an approval.
- `error`: verification could not run or finish (timeout, connection loss,
  permission problem). Not a statement about the database; the operation goes to
  `needs_attention`.
- `pending`: applied, no verification row yet.

**[DECIDED]** A verification that is not `passed` **never** causes `up.sql` to run
again and never triggers `down.sql`
([C-16](../00-product/constitution.md#c-16-failures-never-trigger-automatic-re-execution-or-rollback)).

## 2. The layers (L0 to L4)

```
 ┌───────────────────────────── inside the migration transaction ──────────────────────────────┐
 │ L0  pre-commit structural gate (engine-generated, trusted, read-only catalog assertions)   │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────── after COMMIT, new connection, READ ONLY ───────────────────────┐
 │ L1  structural verification   (same assertions, re-checked from outside the transaction)   │
 │ L2  runtime verification       (the bundle's reviewed verify.sql, defense in depth, §4)     │
 │ L3  engine verification        (fingerprint, invalid indexes, unvalidated constraints, …)   │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
 L4  staging evidence: the result of L1-L3 on the evidence environment, consumed by production plans
```

L0 to L3 run on the target itself. L4 is not a separate query: it is the
verification result of the same migration (same apply checksum, same verify
digest) on the evidence environment, which production plans require
([`staging-production-policy.md`](./staging-production-policy.md)).

### L0: Pre-commit structural gate (transactional bundles only)

Engine-generated assertions run inside the migration transaction, after the last
statement and before the ledger insert. They are derived from the parsed
statements (§3) and use only catalog reads. A failure rolls the transaction back:
nothing was applied (`applyOutcome = not_applied`).

**[DECIDED]** (Wave 6, G6 order §24) Where an L0 failure is recorded: the
target's `migration_verifications` references `schema_migrations`, and a
rolled-back migration has no ledger row, so the target holds **no** trace of
it; ExponetDB never writes a fake applied row to satisfy that reference. The
failure is recorded in the Control Store: the operation's per-migration
progress row (`migrations.operation_migrations`: `apply_outcome =
not_applied`, `verification_outcome = failed`, `error_code =
VERIFICATION_FAILED`, `gate` with the layer, the number of assertions, the
number that failed and the first failing one by object name, never target
data), the `migration.failed` audit event, and the operation itself
(`failed`, `VERIFICATION_FAILED`). Proof:
`packages/migrations-engine/test/engine.int.test.ts` and
`packages/postgres/test/migration-exec.int.test.ts`. L0 catches the classic "statement succeeded but
did something else" cases (a conditional `DO` block that took the wrong branch,
`IF NOT EXISTS` skipping a table that existed with a different shape).

**[OBSERVED]** This addresses a measured REOSA hazard: re-running "idempotent"
files against a newer schema silently re-created seven tables that a later
migration had renamed away (`REOSA` audit 2026-10-04, migration `0045`); and
`IF NOT EXISTS` makes a mismatched pre-existing object pass silently.

### L1: Structural verification

The same expectations re-checked from a fresh connection after commit, as the
reader role, in a `READ ONLY` transaction. This proves the committed state is
visible from outside (catches surprises such as a `COMMIT` that was really a
`ROLLBACK` of an aborted transaction) and is the layer that can be re-run later
(`migration.verify`).

### L2: Runtime verification (`verify.sql`)

The author's own checks, reviewed as part of the bundle: data-level and semantic
properties the engine cannot derive (backfill completeness, values of
configuration rows, the result of a declared consumer function). Trust model,
admission and contract in §4.

### L3: Engine verification

Checks the engine runs for every migration regardless of content:

| Check | Fails when |
|---|---|
| Fingerprint consistency | the post-commit fingerprint differs from the in-transaction `fingerprint_after` (something else changed the schema concurrently) |
| Invalid indexes | any index in managed scope has `indisvalid = false` or `indisready = false` that did not exist before the migration |
| Unvalidated constraints | a constraint created by the migration has `convalidated = false` without `NOT VALID` in the statement (warn) or remains unvalidated after a `VALIDATE CONSTRAINT` statement (fail) |
| RLS invariants | project-configured invariants still hold, e.g. "every table in schema `public` has RLS enabled" (fail) |
| Ownership | objects created by the migration are owned by the execution role (warn otherwise) |
| Extension state | extension versions unchanged unless the migration intended it |
| Unexpected drops | objects present before and absent after that the parsed statements did not drop (fail; catches `CASCADE` surprises) |
| Lineage (prod tier) | `fingerprint_after` equals staging's `fingerprint_after` for this migration when staging's `fingerprint_before` equalled production's (warn/require per [OD-14](../00-product/open-decisions.md#od-14-strictness-of-fingerprint-lineage-for-production)) |

## 3. Automatic structural expectations

**[DECIDED]** The analyzer derives expectations from the parse tree of each
`up.sql` statement. Each expectation is a small, engine-authored catalog query
with a boolean result and a description. Coverage is reported per statement.

| Statement | Derived expectations |
|---|---|
| `CREATE TABLE t (…)` | table exists in schema; relkind; columns in order with canonical type (incl. typmod), nullability, default expression, identity/generated; persistence; partitioning spec |
| `ALTER TABLE t ADD COLUMN c …` | column exists with type, nullability, default |
| `ALTER TABLE t ALTER COLUMN c TYPE …` | column type equals target type |
| `ALTER TABLE t ALTER COLUMN c SET/DROP NOT NULL` | `attnotnull` as stated |
| `ALTER TABLE t DROP COLUMN c` | column absent (`attisdropped`) |
| `ALTER TABLE t RENAME …` | old name absent, new name present, same OID |
| `ALTER TABLE t ENABLE/FORCE ROW LEVEL SECURITY` | `relrowsecurity` / `relforcerowsecurity` true |
| `CREATE POLICY p ON t …` | policy exists; command; permissive/restrictive; roles; `USING`/`WITH CHECK` expressions present (normalized via `pg_get_expr` comparison is informational only) |
| `DROP POLICY` | policy absent |
| `GRANT privs ON t TO r` / `REVOKE` | `has_table_privilege` / column privileges / function `EXECUTE` as stated, using `aclexplode` on the object ACL (not role inheritance) |
| `ALTER DEFAULT PRIVILEGES …` | matching `pg_default_acl` entry |
| `CREATE [UNIQUE] INDEX [CONCURRENTLY] i ON t …` | index exists on t; unique flag; access method; `indisvalid` and `indisready` true; key columns/expressions; predicate present if partial |
| `DROP INDEX` | index absent |
| `ALTER TABLE t ADD CONSTRAINT c … [NOT VALID]` | constraint exists, type, `convalidated` as stated |
| `ALTER TABLE t VALIDATE CONSTRAINT c` | `convalidated = true` |
| `CREATE [OR REPLACE] FUNCTION f(args)` | function with identity args exists; return type; language; volatility; `prosecdef`; `proconfig` contains `search_path` if specified; body digest equals the statement's body |
| `CREATE TRIGGER` | trigger exists on table with timing/events/level; function; enabled state |
| `CREATE VIEW` / `MATERIALIZED VIEW` | relation exists with relkind; `security_invoker`/`security_barrier` options as stated |
| `CREATE TYPE … AS ENUM` / `ALTER TYPE … ADD VALUE` | enum has labels in order |
| `CREATE SEQUENCE` / `ALTER SEQUENCE` | sequence exists with type and options |
| `CREATE SCHEMA` | schema exists with owner |
| `CREATE EXTENSION` (trusted only) | extension exists with version in schema |
| `COMMENT ON` | comment equals text |
| `INSERT`/`UPDATE`/`DELETE` (data changes) | **not derivable**: covered only by `verify.sql` checks; without them coverage is incomplete → `partial` |
| `DO $$ … $$` blocks | **not derivable** (procedural): coverage incomplete unless `verify.sql` covers it; lint `conditional_ddl` |

Statements that are not derivable and not covered make the result `partial`.
"Covered by verify.sql" is declared by the author with a `-- covers: <statement
index or object>` annotation above a check; the engine does not try to guess.
The annotation is part of the verify digest like every other line of
`verify.sql`, so changing what a check covers changes the digest.

## 4. Runtime verification: `verify.sql`

### 4.1 Trust model

**[DECIDED]** `verify.sql` is part of the **reviewed migration bundle**. Its
exact content is stored with the bundle, its verify digest is bound into the
plan, and the plan page shows it to approvers next to `up.sql`. An approval
covers the plan hash and therefore exactly this verification content. The
verify digest binds the complete file after line-ending normalization,
comments included, so the directives below (`-- check:`, `-- covers:`,
`-- calls:`, `-- reads-view:`) and any directive added later cannot change
without changing the digest
([`migration-bundles.md` §3](./migration-bundles.md#3-checksum-semantics)).

`verify.sql` is **not** "arbitrary hostile SQL made safe by PostgreSQL".
PostgreSQL is not a sandbox for hostile SQL: a `SELECT` can call functions;
functions can be `VOLATILE` or `SECURITY DEFINER`, can belong to extensions, can
run dynamic SQL and can have persistent or external side effects, and so can
views, operators and casts that a query touches. A function denylist cannot
prove that every present or future PostgreSQL expression is free of side
effects. The text is still treated as untrusted input in the sense of
[C-26](../00-product/constitution.md#c-26-content-is-untrusted-input): it is
parsed, bounded and displayed as data, and it is executed only because it was
reviewed as part of a plan.

ExponetDB therefore relies on three things, in this order:

1. **Review of the exact content**, bound by digest to the plan and the approval.
2. **Conservative admission** (§4.2): only constructs the engine can classify are
   accepted; anything it cannot classify is `unsupported` (refused at plan time)
   or an explicitly declared check that needs explicit approval. Never "safe" by
   default.
3. **Defense in depth during execution** (§4.3): a dedicated least-privilege
   role, a read-only transaction, pinned settings, timeouts, limits and a closed
   connection.

None of these layers, and not their sum, is described or tested as a complete
sandbox. The goals are that a verification run does not change persistent state,
does not hold locks that block the application, returns nothing beyond its result
contract, and does not outlive its connection; the layers make violations of
these goals hard and visible, and the residual risk is carried by review.

### 4.2 Admission (plan time)

**[DECIDED]** for V1, checked by the parser and the analyzer against the
target's catalog at plan time. The admission result is part of the plan.

| Rule | V1 |
|---|---|
| Statement forms | Every top-level statement is a `SELECT` (including `WITH` without data-modifying CTEs). `VALUES` lists may appear as subqueries or `FROM` items. `DO` blocks, `CALL`, `TABLE`, `SHOW`, `EXPLAIN`, DDL, DML, `SET`, `COPY`, `LISTEN`/`NOTIFY`, `PREPARE`/`EXECUTE`, cursors, transaction control, `SELECT … INTO` and locking clauses (`FOR UPDATE/SHARE`) are refused with `MIGRATION_STATEMENT_FORBIDDEN`. `TABLE` and `SHOW` are not needed: `SELECT current_setting('…') = '…' AS ok` covers settings, and `TABLE` would only dump rows. |
| Output columns | The target list of a top-level statement contains only `ok` (boolean) and optionally `detail` (text). No other output columns, so no other type's output function runs for the result. |
| Name resolution | The session runs with `search_path = ''`. Unqualified function, operator and type names therefore resolve only in `pg_catalog`. Relations must be schema-qualified. |
| Functions and operators | Every function, aggregate, operator and cast in the statement must resolve to an entry of the engine's **verification allowlist**: an explicit, versioned list (per PostgreSQL major) of `pg_catalog` built-ins that are known not to have side effects: comparison, arithmetic and boolean operators, common aggregates (`count`, `sum`, `min`, `max`, `bool_and`, `bool_or`, `array_agg`, `string_agg`), string, numeric, date/time and array functions, `jsonb` read functions, and catalog inspection functions (`to_regclass`, `to_regproc`, `format_type`, `pg_get_*def`, `pg_get_expr`, `has_*_privilege`, `pg_has_role`, `aclexplode`, `obj_description`, `col_description`, `current_setting`, `current_user`). The list is explicit, not derived from volatility labels: some `pg_catalog` functions execute dynamic SQL (for example `query_to_xml`) and are never on it. The list changes only with an engine release that adds tests for each entry. |
| Everything else | Schema-qualified functions outside `pg_catalog`, user-defined operators and casts, extension functions and types, functions that resolve differently on the target, `SECURITY DEFINER` functions, and functions not on the allowlist are **`unsupported`**: the plan refuses `verify.sql` with `VERIFY_CONSTRUCT_UNSUPPORTED`, naming the construct. |
| Relations | Tables, partitioned tables, materialized views and sequences may be read. `pg_catalog` and `information_schema` views may be read. Plain views and foreign tables execute code (or a remote call) on read and are `unsupported` unless declared (next row). |
| Declared consumer checks | A check may call one consumer function or read one consumer view only if it is declared above the statement: `-- calls: schema.function(argtypes)` or `-- reads-view: schema.view`. The declaration is bound by the verify digest; the plan also binds the function's or view's identity and definition digest, classifies the check as `consumer_code`, shows it prominently, and policy rule `migration.verify-consumer-code` requires an explicit approval for the plan (on every tier by default). A declared check is never treated as side-effect free; the approval records that a person accepted it. |
| Size | At most 200 checks; `verify.sql` at most 512 KiB. |

Admission results are bound to the target's fingerprint like the rest of the
plan: a changed function or view makes the plan stale.

**[DECIDED]** (Wave 6) How the rows above are enforced:

- **Checks and directives** (`analyzeVerifyFile` in
  `packages/postgres/src/parser/verify-checks.ts`): the parser of the
  target's major splits the file; a check's directives are the line
  comments between the previous statement and this one, found by the
  lexer, so directive-shaped text in a string, a dollar-quoted body, a
  block comment or the statement itself is never a directive. Each check is
  admitted on its own: a `-- calls:` function is allowed only in the check
  that declares it, and only as `schema.function(argtypes)` with lower-case
  identifiers.
- **Catalog resolution** (`resolveVerifyCatalog` in
  `packages/postgres/src/verify.ts`), at plan time with the observer and
  again before a run: every `pg_catalog` function a check calls exists
  there and every function of that name is from `initdb` (`oid < 16384`),
  so an extension installed into `pg_catalog` cannot shadow an allowlisted
  name; `pg_catalog` holds no operator, and no cast between built-in types
  exists, that was added after `initdb`; every relation is resolved by its
  catalog names (no `USAGE` is needed) and is a table, partitioned table,
  materialized view or sequence, a plain view only where the check declared
  it, a foreign table never; a declared function resolves to exactly the
  declared argument types, has no other overload of its name in its schema,
  is a plain function, not `SECURITY DEFINER` and not an extension's; a
  declared view is a plain view, not an extension's. The plan binds each
  consumer object's oid, owner and definition digest (SHA-256 of
  `pg_get_functiondef` and its settings, or of `pg_get_viewdef` and its
  options); a different digest at the run refuses it.
- **Execution**: only an `AdmittedCheck` runs (created after a passing
  resolution, in a module-private registry like reviewed statements), only
  on a verifier session inside its read-only transaction, each under a
  savepoint, through a cursor that fetches at most 1,001 rows, judged by
  the output types the server reported (`ok` boolean, `detail` `text` or
  `varchar`; anything else is `wrong_type`). Before the checks, the
  verifier role's drift is read on its own session (`verifierProblems`):
  superuser, a privileged attribute, membership in a write, signal,
  server-file or maintenance role, no `BYPASSRLS`, not read-only by default,
  a non-empty `search_path`, a write privilege on any table, or `EXECUTE`
  on a `dblink`/`postgres_fdw` function refuses the run.
- **Detail redaction** (`redactDetail`): control and bidirectional
  characters removed, e-mail addresses, runs of eight or more digits and
  long token-like runs containing a digit masked, at most 200 characters.


### 4.3 Execution (defense in depth)

**[DECIDED]** **[OBSERVED]** (Wave 0 standards research, measured on a
PostgreSQL 16.14 test cluster, 2026-10-04; the PostgreSQL 17 documentation and
source describe the same behavior): inside `BEGIN READ ONLY`,
`SET TRANSACTION READ WRITE` succeeds if issued before the first query;
`NOTIFY`, `set_config`, `pg_advisory_lock` (which survives rollback) and
`dblink_exec` (a separate read-write session) are not blocked; `nextval`,
`lo_create`, temp tables and DML inside volatile functions are blocked. `READ
ONLY` is therefore one layer among several, never the boundary.

| Layer | Mechanism |
|---|---|
| Role | A dedicated role, `exponetdb_verifier` ([`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)): `pg_read_all_data` and `BYPASSRLS` (so checks see RLS-protected rows instead of false empties), no write privileges, not superuser, no `pg_signal_*`, no `pg_read_server_files`, no `EXECUTE` on `dblink`/`postgres_fdw` functions (verification refuses to run on a target where they are executable by this role), role-level `default_transaction_read_only = on` and `search_path = ''`. It is separate from the `data.read` role so that its credentials and settings serve only this path. |
| Connection | A separate, dedicated connection per verification run, never pooled and never through a pooler endpoint; closed afterwards, which releases anything session-scoped. |
| Transaction | `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;`, then an engine `SELECT 1` as the first query (so `SET TRANSACTION READ WRITE` is no longer possible); always ends with `ROLLBACK`. |
| Pinned settings | `search_path = ''`, `standard_conforming_strings = on`, `TimeZone = UTC`, `DateStyle = ISO`, `default_transaction_read_only = on`, `constraint_exclusion = off` (G4 correction: constraint exclusion would fold a tenant's `CHECK` constraint calls while planning; every read-only session pins it), `application_name = 'exponetdb/verify/<operation id>'`. |
| Time and locks | `statement_timeout` default 60 s (maximum 10 min), `lock_timeout` 2 s (reads take `ACCESS SHARE` and must never queue behind DDL for long), `idle_in_transaction_session_timeout` 30 s. |
| Limits | at most 1,000 rows fetched per check (more rows: the check fails with `too_many_rows`), `detail` truncated to 200 characters. |
| No raw result persistence | Only the result contract (§4.4) is stored and returned; raw rows never leave the engine. PostgreSQL error `DETAIL` is dropped ([`../02-control-plane/error-model.md`](../02-control-plane/error-model.md)). |

### 4.4 Result contract

**[DECIDED]**

- Each top-level statement is one **check**. A check is named by a
  `-- check: <name>` comment on the line before it (like every comment in
  `verify.sql`, the name is bound by the verify digest); unnamed checks are
  named `check_<index>`.
- A check **passes** when the statement completes without error, at least one
  row is returned, and every `ok` is `true`. Zero rows is a failure (`no_rows`):
  "the thing I looked for is not there" must not pass vacuously. A statement
  without an `ok` column is refused at plan time (§4.2), so every check asserts
  something.
- The optional `detail` text column is captured for the **first failing row
  only**, truncated and passed through statement and value redaction. No other
  values are stored or returned.

Example:

```sql
-- check: inbox index exists and is valid
SELECT indisvalid AND indisready AS ok
FROM pg_catalog.pg_index WHERE indexrelid = to_regclass('public.leads_inbox_idx');

-- check: backfill complete
-- covers: 2
SELECT count(*) = 0 AS ok FROM public.leads WHERE source IS NULL;

-- check: tenant isolation function returns no rows for a foreign tenant
-- calls: public.visible_leads(uuid)
SELECT count(*) = 0 AS ok FROM public.visible_leads('00000000-0000-0000-0000-000000000000');

-- check: policy denies foreign tenant
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
END $$;
```

The first two checks are admitted. The third calls a consumer function: it is
admitted only because it is declared, and the plan then requires an explicit
approval (`migration.verify-consumer-code`). The last check is refused at plan
time (`DO` is not allowed in V1). Policy behavior tests that need settings or
role switches belong in the project's own test suite or in a future "policy
probe" capability with an engine-controlled role switch
([OD-15](../00-product/open-decisions.md#od-15-policy-probes-in-verification)),
not in `verify.sql`.

## 5. Verification runs and history

- Every run writes one `migration_verifications` row in the target (append-only)
  with: verify digest used, layer results (structural counts and failures,
  runtime check results per the contract, engine results), fingerprint at
  verification time, status, timestamps, operation id.
- The Control Store mirrors the rows and derives **evidence records** from
  `passed` rows.
- The latest row determines the current verification status. Earlier rows are
  never changed.

### Retrying verification

**[DECIDED]** `migration.verify(target, migrationId)` is a `low`-class operation
(inline plan, precondition: the ledger row exists with the expected checksum). It
re-runs L1-L3 with the **current** verify digest for that migration. It never runs
`up.sql`.

Fixing a broken `verify.sql` after the migration was applied:

1. The author edits `verify.sql` (the apply checksum is unaffected; the verify
   digest changes with any edit, a comment or directive edit included).
2. The new bundle revision is ingested; the bundle store records it as a
   **verify revision** of the same migration (same id, same apply checksum).
3. `migration.verify` runs with the new digest; the verification row records it.
4. For production evidence, staging must have a `passed` verification **with the
   same verify digest** that production will use
   ([`staging-production-policy.md`](./staging-production-policy.md)).

### Failure after commit

| Situation | State | Next steps |
|---|---|---|
| L1 fails (structure differs from intent) | applied, `failed` | Investigate. Remedy is a forward migration or a planned rollback. Target gets a finding. Schema plans on prod tier that depend on this migration require break-glass (rule `migration.dependencies-verified`, code `MIGRATION_DEPENDENCY_UNVERIFIED`). |
| L2 fails (verify.sql assertion false) | applied, `failed` | Either the data/logic is wrong (forward fix) or verify.sql is wrong (verify revision, then `migration.verify`). |
| L2 errors because verify.sql is broken (syntax, missing column it references) | applied, `error` | Verify revision, then `migration.verify`. |
| Verification timeout | applied, `error`; operation `needs_attention` | Re-run `migration.verify` later or with a raised timeout. |
| Target unreachable after commit | applied (if reconciliation confirms), `pending` | Verification runs when reachable; the operation stays `needs_attention` until then. |

## 6. Tests

- For each derivable statement kind: a positive test (expectation passes) and a
  negative test (object tampered between statement and gate → fails, rolls back).
- `verify.sql` admission: every refused form (`DO`, `CALL`, DDL, DML, `SET`,
  `SET TRANSACTION READ WRITE`, `COMMIT; INSERT …`, `NOTIFY`, `SELECT … INTO`,
  locking clauses, data-modifying CTEs) is refused at plan time; calls to
  `set_config`, `pg_advisory_lock`, `dblink_exec`, `query_to_xml`, `pg_sleep`,
  a schema-qualified user function, a user operator, a user cast, an extension
  function, a plain view and a foreign table are `unsupported` unless declared;
  declared consumer checks require an approval; output columns other than `ok`
  and `detail` are refused.
- `verify.sql` execution layers: the verifier role cannot write any table
  (privilege test on real PostgreSQL); the transaction is read-only and cannot
  be switched to read-write; timeouts and row limits stop runaway checks; the
  connection is closed after each run; `detail` is truncated and redacted.
- These tests prove the defined admission, role and read-only model. They do
  not claim, and no test claims, that arbitrary malicious SQL is contained.
- Zero-row `ok` check fails; vacuous truth is not accepted.
- Verification after a crash between commit and verification: reconciliation
  then verification produces exactly one `applied` row and one verification row.
