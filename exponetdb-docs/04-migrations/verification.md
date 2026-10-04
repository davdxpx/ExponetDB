# Verification

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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

## 2. The four layers

```
 ┌───────────────────────────── inside the migration transaction ──────────────────────────────┐
 │ L0  pre-commit structural gate (engine-generated, trusted, read-only catalog assertions)   │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────── after COMMIT, new connection, READ ONLY ───────────────────────┐
 │ L1  structural verification   (same assertions, re-checked from outside the transaction)   │
 │ L2  runtime verification       (the bundle's verify.sql, untrusted code, sandboxed)         │
 │ L3  engine verification        (fingerprint, invalid indexes, unvalidated constraints, …)   │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
 L4  staging evidence: the result of L1-L3 on the evidence environment, consumed by production plans
```

### L0: Pre-commit structural gate (transactional bundles only)

Engine-generated assertions run inside the migration transaction, after the last
statement and before the ledger insert. They are derived from the parsed
statements (§3) and use only catalog reads. A failure rolls the transaction back:
nothing was applied, the verification row records `failed` with
`applyOutcome = not_applied`. L0 catches the classic "statement succeeded but
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

The author's own checks: data-level and semantic properties the engine cannot
derive (backfill completeness, policy behaviour for a sample tenant, function
results). Security model and contract in §4.

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

## 4. Runtime verification: `verify.sql`

### 4.1 Threat model

`verify.sql` is code written by a developer or an AI agent. It is untrusted
input ([C-26](../00-product/constitution.md#c-26-content-is-untrusted-input)).
It runs against production. It must not be able to change persistent state, hold
locks that block the application, exfiltrate data beyond pass/fail, or escape
its session.

### 4.2 Enforcement

**[DECIDED]** Defence in depth, because PostgreSQL's `READ ONLY` transaction mode
alone is not a security boundary. **[OBSERVED]** (standards research 2026-10-04,
verified on 16.14): inside `BEGIN READ ONLY`, `SET TRANSACTION READ WRITE`
succeeds if issued before the first query; `NOTIFY`, `set_config`,
`pg_advisory_lock` (which survives rollback) and `dblink_exec` (a separate
read-write session) are not blocked; `nextval`, `lo_create`, temp tables and DML
inside volatile functions are blocked.

| Layer | Mechanism |
|---|---|
| Parser allowlist | Each statement must parse as `SELECT` (including `WITH` without data-modifying CTEs), `VALUES`, `TABLE`, `SHOW`, or `DO` (PL/pgSQL only). Anything else: `MIGRATION_STATEMENT_FORBIDDEN` at plan time. |
| Function denylist | AST walk rejects calls to: `pg_advisory_*`, `pg_try_advisory_*`, `pg_notify`, `set_config`, `dblink*`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_rotate_logfile`, `pg_switch_wal`, `pg_stat_reset*`, `lo_*`, `pg_read_file`, `pg_read_binary_file`, `pg_ls_*`, `pg_sleep*` (timeouts cover the rest), `txid_current`/`pg_current_xact_id` (they assign an xid), `nextval`/`setval`. `DO` bodies are parsed (PL/pgSQL) and the same denylist applies to embedded SQL; `EXECUTE` of dynamic SQL inside `DO` is forbidden in verify.sql. |
| Role | Runs as `exponetdb_reader`: `pg_read_all_data` plus `BYPASSRLS` (so that checks see RLS-protected rows), no write privileges, not superuser, no `pg_signal_*`, no `pg_read_server_files`, and no `EXECUTE` on `dblink`/`postgres_fdw` functions (the engine refuses to run verification on a target where these are installed and executable by the reader). |
| Transaction | `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;` then an engine `SELECT 1` as first query (so that `SET TRANSACTION READ WRITE` is no longer possible); always ends with `ROLLBACK`. |
| Session | Dedicated connection, closed after the run (releases anything session-scoped). Session settings pinned as for migrations; `default_transaction_read_only = on` set at session level as an extra layer. |
| Time and locks | `statement_timeout` default 60 s (maximum 10 min), `lock_timeout` 2 s (reads take `ACCESS SHARE` and must never queue behind DDL for long), `idle_in_transaction_session_timeout` 30 s. |
| Output | Only the result contract below is stored and returned; raw rows never leave the engine. |

### 4.3 Result contract

**[DECIDED]**

- Each top-level statement is one **check**. A check is named by a
  `-- check: <name>` comment on the line before it (comments do not affect the
  verify digest); unnamed checks are named `check_<index>`.
- A check **passes** when:
  - the statement completes without error, **and**
  - if the result has a boolean column named `ok`: at least one row is returned
    and every `ok` is `true`. Zero rows with an `ok` column is a failure
    (`no_rows`): "the thing I looked for is not there" must not pass vacuously.
- A statement without an `ok` column passes when it completes without error
  (useful for `DO $$ BEGIN ASSERT …; END $$`). Lint
  `verify_statement_without_assertion` (warn) flags a `SELECT` without `ok`.
- An optional `detail` text column is captured for the **first failing row
  only**, truncated to 200 characters and passed through statement/value
  redaction. No other column values are stored or returned.
- Limits: at most 200 checks; at most 1,000 rows fetched per check (more rows:
  the check fails with `too_many_rows`, because a verification should assert,
  not dump).

Example:

```sql
-- check: inbox index exists and is valid
SELECT indisvalid AND indisready AS ok
FROM pg_index WHERE indexrelid = 'public.leads_inbox_idx'::regclass;

-- check: backfill complete
-- covers: 2
SELECT count(*) = 0 AS ok FROM public.leads WHERE source IS NULL;

-- check: policy denies foreign tenant
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);  -- forbidden: set_config
END $$;
```

The last check is rejected at plan time (`set_config` is denied). Policy
behaviour tests that need GUCs or role switches belong in the project's own test
suite or in a future "policy probe" capability with an engine-controlled role
switch ([OD-15](../00-product/open-decisions.md#od-15-policy-probes-in-verification)),
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
   digest changes).
2. The new bundle revision is ingested; the bundle store records it as a
   **verify revision** of the same migration (same id, same apply checksum).
3. `migration.verify` runs with the new digest; the verification row records it.
4. For production evidence, staging must have a `passed` verification **with the
   same verify digest** that production will use
   ([`staging-production-policy.md`](./staging-production-policy.md)).

### Failure after commit

| Situation | State | Next steps |
|---|---|---|
| L1 fails (structure differs from intent) | applied, `failed` | Investigate. Remedy is a forward migration or a planned rollback. Target gets a finding. Schema plans that depend on this migration are denied (`MIGRATION_DEPENDENCY_UNVERIFIED` on prod tier). |
| L2 fails (verify.sql assertion false) | applied, `failed` | Either the data/logic is wrong (forward fix) or verify.sql is wrong (verify revision, then `migration.verify`). |
| L2 errors because verify.sql is broken (syntax, missing column it references) | applied, `error` | Verify revision, then `migration.verify`. |
| Verification timeout | applied, `error`; operation `needs_attention` | Re-run `migration.verify` later or with a raised timeout. |
| Target unreachable after commit | applied (if reconciliation confirms), `pending` | Verification runs when reachable; the operation stays `needs_attention` until then. |

## 6. Tests

- For each derivable statement kind: a positive test (expectation passes) and a
  negative test (object tampered between statement and gate → fails, rolls back).
- `verify.sql` sandbox escape attempts: `SET TRANSACTION READ WRITE` as first
  statement, `COMMIT; INSERT …`, `dblink_exec`, `pg_advisory_lock`, `NOTIFY`,
  `set_config`, writes inside `SECURITY DEFINER` functions, `pg_sleep(3600)`,
  huge result sets, data in `detail`: all rejected or contained.
- Zero-row `ok` check fails; vacuous truth is not accepted.
- Verification after a crash between commit and verification: reconciliation
  then verification produces exactly one `applied` row and one verification row.
