# SQL execution security

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (introspection execution), Wave 7 (MCP `sql_query`, implemented: §2.4), Wave 8 (SQL editor), Wave 9 (diagnostics) |
| Read before | [`credentials-and-roles.md`](./credentials-and-roles.md), [`statement-redaction.md`](./statement-redaction.md), [`../08-auth-and-security/ai-agent-safety.md`](../08-auth-and-security/ai-agent-safety.md) |

ExponetDB runs SQL on managed databases on four paths. They are separate by role,
by permission and by code path, and none of them is "execute any SQL as
`postgres`" ([C-23](../00-product/constitution.md#c-23-least-privilege-per-path)).

| Path | Who writes the SQL | Role | Permission / scope | Can change state |
|---|---|---|---|---|
| Introspection and diagnostics | ExponetDB (engine code, trusted) | `exponetdb_observer` | `schema.read`, `diagnostics.read` | no |
| Data queries (`data.read`) | user or agent (untrusted) | `exponetdb_reader` | `data.read:<tier>` | no |
| Operator actions | ExponetDB (engine code) from typed requests | `exponetdb_operator` | `connections.operate:<tier>` | backend signals only |
| Migrations | author (untrusted, reviewed via plan) | `exponetdb_migrator` → execution role | `migrations.apply:<tier>` | yes, only through the migration engine |

There is no fifth path. A request to run a writing statement through `data.read`
is refused with `QUERY_NOT_READ_ONLY` and the hint to use a migration.

## 1. Engine-authored SQL (introspection, diagnostics, operator actions)

**[DECIDED]**

- All engine SQL is built with a **typed SQL builder** in `packages/postgres`
  whose fragments carry a provenance brand (`TrustedSql`). Values are passed as
  **bind parameters**; identifiers that must be inlined go through
  context-specific escapers. **[OBSERVED]** The Supabase reference's escaping
  inlines values and reuses identifier-escaped text inside other quoting
  contexts (single-quoted `format()` templates, `DO $$` bodies); a role name was
  shown to execute as an SQL expression, and `$$` in a table name broke a
  generated block (pg-meta audit, verified on PostgreSQL 16). ExponetDB does not
  copy that code; its builder never nests escaped text into a second quoting
  context, and avoids `DO` blocks with spliced identifiers entirely.
- The brand is enforced at runtime too: `TrustedSql` is a frozen object created
  only by the builder module, not a branded string that a cast could forge.
- Engine SQL that reads catalog text (function bodies, policy expressions,
  object names) treats that text as **hostile data**: it is returned as data,
  escaped for its display context, and never re-executed.

## 2. Data queries (`data.read`)

### 2.1 Admission

1. The caller has `data.read:<tier>` for the target and the target allows data
   reads (the setting of the policy rule `data.read`, mode `by_tier | enabled |
   humans_only | disabled`; `by_tier`, the default, is `humans_only` for the
   prod tier, see [OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production)
   and §2.4).
2. The text is parsed with libpg_query for the target major. Exactly **one**
   statement is allowed per request.
3. Allowed statement classes: `SELECT` (including `WITH` without data-modifying
   CTEs, `SELECT … FOR UPDATE/SHARE` is refused), `VALUES`, `TABLE`, `SHOW`,
   `EXPLAIN` (see §3). Refused: everything else, including `COPY`, `CALL`, `DO`,
   `SET`, `LISTEN`, `PREPARE`/`EXECUTE`, `DECLARE CURSOR`, transaction control.
4. Function, operator, cast and relation admission as for `verify.sql`
   ([`../04-migrations/verification.md` §4.2](../04-migrations/verification.md#42-admission-plan-time)):
   with `search_path = ''`, only allowlisted `pg_catalog` built-ins may be
   called (`pg_sleep*` is not on the list); user functions, user operators and
   casts, extension functions, plain views whose definition does not pass the
   same admission, and foreign tables are refused with
   `QUERY_CONSTRUCT_UNSUPPORTED`. As for verification, these checks are defense
   in depth, not a sandbox: `data.read` rests on permission, scope, tier, the
   setting of the policy rule `data.read` for the target (ADR-0028 calls it
   `dataRead`) and the reader role's privileges.
   **[DECIDED]** (Wave 7 review, 2026-10-13) The reader and the verifier are
   members of `pg_read_all_data`, which PostgreSQL lets read every relation,
   system catalogs included (observed: such a member reads
   `pg_catalog.pg_authid` with its password verifiers). The parser therefore
   refuses, by name and in every spelling (qualified, `TABLE`, in a join,
   subquery, CTE or `EXPLAIN`; unqualified counts as `pg_catalog`), the
   catalogs that hold secrets or sampled column values: `pg_authid`,
   `pg_shadow`, `pg_user_mapping`, `pg_user_mappings`, `pg_subscription`,
   `pg_db_role_setting`, `pg_statistic`, `pg_statistic_ext_data`,
   `pg_stats`, `pg_stats_ext`, `pg_stats_ext_exprs`, and
   `information_schema.user_mapping_options`, `user_mappings`,
   `_pg_user_mappings` (`SECRET_CATALOG_RELATIONS` in
   `packages/postgres/src/parser/admission.ts`; for `data.read` and
   `verify.sql` alike).
   **[DECIDED]** (G4 correction, 2026-10-07) Calls and operators are also
   checked where the syntax hides them:
   - field selection `(expr).name` is refused as a whole: PostgreSQL turns it
     into the call `name(expr)` when `name` is no field of `expr`, so
     `(0.5::float8).pg_sleep` would sleep (refusal `field_selection`);
     `(expr).*` and array subscripts stay admitted;
   - a qualified column reference `t.name` (and `s.t.name`) is the call
     `name(t)` on the whole row when `t` has no column `name`; with the
     empty `search_path` only `pg_catalog` functions taking one `record`,
     `"any"`, polymorphic or composite argument can match, and a reference
     whose last part names such a function off the allowlist is refused
     (`function`). The list per major is checked against each real catalog
     (`session.int.test.ts`);
   - a function in `FROM` with a scalar result has that scalar as its whole
     row, so `q.name` could call any one-argument function `name(q)` of that
     type (`q.ts_stat` on a `text` result runs SQL text). A qualified
     reference into a function in `FROM` may therefore name only its declared
     columns (`AS q(a, b)`), or, without a column list, the default column
     that carries the reference's own name (and `ordinality`); any other
     `q.name` is refused (`function`). The columns of a function returning a
     row type are referenced unqualified or declared with alias column names
     (column definition lists such as `AS r(a integer)` are not admitted).
     Without an alias, PostgreSQL names a `FROM` item after its expression
     (`CAST(1 AS float8)` is `float8`, `COALESCE(…)` is `coalesce`), so a
     function item without an alias is admitted only as a single plain call
     (named after the function); and the qualifier of every two-part
     reference must name a `FROM` item of the statement (a table, CTE,
     subquery, join or function alias), never a name admission would have
     to guess (third correction review);
   - the operator of `x OPERATOR(s.op) ANY|ALL (subquery)` and of
     `ORDER BY … USING op` (also inside aggregates and window definitions)
     must be an allowlisted built-in, as for every other operator;
   - a table or partitioned table with a foreign table anywhere among its
     inheritance children or partitions reads through the foreign-data
     wrapper and is refused like a foreign table (`relation_kind`);
   - a read can run user code it does not name, and admission cannot see
     column types or the catalog. *User code* is a function created in the
     database (`oid >= 16384`) in a language other than C or `internal`
     (those need a superuser to create), or an operator whose function is
     such code. A read runs it through a cast (implicitly, or through `::`,
     on a column of a user type: a tenant's `CREATE CAST (public.e AS text)
     WITH FUNCTION public.e_text(public.e) AS IMPLICIT` runs from
     `lower(c)`); through an index expression or predicate, a partition key
     or an extended-statistics expression, whose constant calls the planner
     folds when it loads them for any statement on the table (an index
     `WHERE x > f(1)` runs `f` from `SELECT count(*) FROM t WHERE x = 1`);
     and through a range type's `subtype_diff`, which the planner calls to
     estimate `&&`. The target-side step refuses every read on a database
     that has such an object (refusal `user_code`, construct
     `<type> <identity>`, for example `cast (public.e AS pg_catalog.text)`).
     Table `CHECK` constraints run only under constraint exclusion, which
     every read-only session pins off (`constraint_exclusion = off`);
     column defaults, generated columns and domain constraints run on writes.
     Each refused path is proven to run as the reader on PostgreSQL 16, 17
     and 18 (`session.int.test.ts`). Extension objects in C (pgvector,
     hstore) stay admitted. **[ASSUMPTION]** The rule is deliberately
     coarse: an expression index whose user function takes a column
     (`lower_unaccent(email)`, never run by a read) or an extension with SQL
     casts also makes the database unreadable through `data.read`. A finer
     rule (only calls whose arguments are constants are folded) needs an ADR
     and its own adversarial tests; failing closed is the intended default
     until then.
5. Optional **cost preflight**: plain `EXPLAIN (FORMAT JSON)` first; if the
   root total cost exceeds the target's threshold (default 1,000,000 for prod,
   project-configurable), the query is refused with an explanation and the plan
   summary. **[OBSERVED]** The Supabase reference uses a 200,000-cost guard for
   dashboard queries; ExponetDB keeps the idea with a configurable threshold.

### 2.2 Execution

**[DECIDED]**

```sql
-- dedicated or pooled-per-target reader connection; pinned session settings
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '<target default, ≤ 60 s for agents, ≤ 5 min for humans>';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SELECT 1;                                       -- after this, READ WRITE can no longer be set
DECLARE exdb_cursor NO SCROLL CURSOR FOR <statement>;   -- statement sent with bind parameters
FETCH FORWARD <row cap + 1> FROM exdb_cursor;
ROLLBACK;
```

- Row cap: default 500 rows for agents, 5,000 for humans; byte cap 5 MiB per
  result. Exceeding a cap returns the capped rows with `truncated: true` and the
  reason, never silently.
- Values are returned as typed JSON with explicit handling for `bytea` (hex,
  capped), large text (capped with a `truncatedAt` marker), `vector` (dimension
  and first values only by default), timestamps (ISO 8601 UTC).
- **RLS annotation.** The reader has `BYPASSRLS`; results are complete. The
  result metadata names every relation in the statement that has RLS enabled, so
  that a human or agent understands that application users see less.
- **Sensitive columns.** A project can mark columns as sensitive (by name
  patterns and explicit lists). Values in such columns are masked in results for
  callers without `data.read_sensitive`. **[OBSERVED]** The Supabase reference
  masks columns whose comment contains `[SENSITIVE]` in its table grid; ExponetDB
  makes it a server-side policy instead of a client-side display rule.
- Execution happens in the `worker` (which alone holds the reader credential);
  `serve` admits the query, forwards it on an internal request lane (ADR-0028:
  sealed with HPKE in the Control Store) and waits up to the statement timeout
  plus 30 s.
- `application_name = 'exponetdb/query/<request id>'`; the request can be
  canceled by the caller (`sql_cancel`), which maps to `pg_cancel_backend` on
  that exact backend.

### 2.3 Audit

Every `data.read` call writes an audit event with: actor, client, target, the
**normalized** statement (constants replaced, see redaction), a statement digest,
row count, truncation, duration, and the masked-column list. Never the result
values.

### 2.4 Wave 7 implementation

**[DECIDED]** (Wave 7 Phase 8, [ADR-0028](../01-architecture/adr/0028-data-read-lane.md);
`packages/diagnostics/src/data-read/`, `packages/application/src/queries.ts`)

- **Order of checks.** The central engine on the target the registry
  resolved (`query.run`, `query.explain`, `query.cancel`; scope
  `data.read:<tier>`); the policy rule `data.read` for this caller on this
  target (an agent is every caller that is not a person in the Web App or
  the first-party CLI; a refusal is `DATA_READ_NOT_PERMITTED`, audited as
  `authz.denied` with reason `policy`); the caps of the caller class; the
  parser admission on the target's major and the normalized statement in
  `serve`; the lane to the worker; the admission again on the worker with
  the target's own catalog (relation kinds, user code); execution.
- **Caps.** Agents: 500 rows (default 100), 5 MiB, statement timeout 60 s,
  no `EXPLAIN ANALYZE` (`QUERY_NOT_READ_ONLY`, refused in `serve` and
  again in the worker). People: 5,000 rows (default 1,000), 5 MiB, 60 s.
  The worker checks the caps of the caller class again on the request it
  opened. The 5-minute human timeout of §2.2 is not offered yet.
- **Execution.** A fresh `exponetdb_reader` session per read from the
  worker's connector (`application_name` `exponetdb/query/<request id>`,
  set again inside the transaction), at most 2 per cluster at once within
  the worker's budget of 5; `BEGIN ISOLATION LEVEL REPEATABLE READ READ
  ONLY`, `SELECT 1`, `SET LOCAL` statement, lock (1 s) and idle (30 s)
  timeouts and, on PostgreSQL 17 and 18, `transaction_timeout`; a cursor
  with bind parameters, `FETCH FORWARD <cap + 1>`, `ROLLBACK`, close.
- **Values.** Typed by type oid (booleans, integers, `int8` as a number
  when exact and as a string beyond 2^53, floats, `numeric` and other
  exact types as strings, JSON parsed up to 64 KiB, `bytea` as
  `{ hex, bytes, truncatedAt? }`, `vector` as `{ dimension, head }`,
  timestamps as ISO 8601, text over 10,000 characters as
  `{ value, truncatedAt, length }`); column types are their `format_type`
  names (`bigint`, `uuid`).
- **Masking.** The rule's parameter `sensitiveColumns` (patterns
  `schema.table.column`, `*` within a part) names masked columns per
  installation or per target; a column whose origin is such a column is
  `null` with `masked: true`, and an expression column is masked whenever
  the statement reads a table with a masked column. Masking applies to
  every caller: an unmasked read (`data.read_sensitive`) has no action yet.
  **[DECIDED]** (Wave 7 review, 2026-10-13) Masking guards the output only,
  so a masked column may appear only as a bare column of the top-level
  target list of a plain `SELECT`. Any other use is refused with
  `QUERY_CONSTRUCT_UNSUPPORTED` before the statement runs, because the rows,
  their order, their count or an error would answer for the value: a
  predicate, an ordering (also by output name or position), a grouping, a
  join (also `USING` and `NATURAL`), an expression, a window, a subquery, a
  CTE, a set operation, `DISTINCT`, a whole-row reference, or `*` below the
  top level (`sensitiveReference` in
  `packages/postgres/src/parser/sensitive.ts`; the names of the masked
  columns come from the relations the statement reads).
  A comment-based marking (`[SENSITIVE]`) is not read.
- **Refusals** carry only the details the error catalog defines (a
  construct, a parse position, a SQLSTATE); a runtime error of the target
  is `QUERY_FAILED` with its SQLSTATE only, never the server's message.
- **Cancel.** A closed stream (MCP or HTTP) or `sql_cancel` /
  `POST /targets/{target}/queries/{queryId}/cancel` with the `queryId` the
  caller chose marks the read; the worker sends the protocol cancel of
  exactly the session it opened for that read. A cancel reaches only the
  same identity, client, grant and target; `finished` when none of the
  caller's reads with that id runs.
- **Audit.** The event `data.read` (phase `completed` or `failed`) carries
  the kind, the `queryId`, the redacted statement (at most 256
  characters) and the digest of the whole redacted text, the caller class,
  the tool, the rows, truncation, duration, masked column names and the
  number of RLS relations, or the error code and the admission's reason
  (`statement_class`, `data_modifying`, `explain_analyze`): attempted
  writes are recorded. It is written in its own transaction before the
  result is returned; when it cannot be written the caller gets an error
  and no rows. Refusals before the lane (bounds, no worker) are not
  reads and are not audited as such.
- **Not implemented in Wave 7:** the cost preflight of §2.1 item 5, the
  5-minute human timeout, `data.read_sensitive`, `EXPLAIN` with `BUFFERS`.

## 3. EXPLAIN

**[DECIDED]**

- `EXPLAIN` without `ANALYZE` is planning only, but planning can evaluate
  immutable/stable functions during constant folding. It therefore follows the
  same admission rules (single statement, read-only class, function and
  relation allowlist of §2 item 4).
- `EXPLAIN ANALYZE` executes the statement. It is allowed only for statements
  that pass the read-only admission, inside the same read-only, rolled-back
  transaction, with the same timeouts. Plans are requested as
  `FORMAT JSON` (with `BUFFERS`, `SETTINGS`, `WAL` off by default).
- Plans returned to callers are redacted (constants in `Filter`/`Index Cond`
  replaced by placeholders unless the caller has `data.read_sensitive`).
- `EXPLAIN` on a query text taken from `pg_stat_statements` (for performance
  advice) runs only for the normalized text with parameters, never by
  substituting guessed literals.

## 4. What ExponetDB never offers

- No tool, endpoint or UI action that runs arbitrary SQL with write capability
  outside the migration engine. (An "SQL editor with writes" in the Web App
  creates a **migration bundle draft**, not a direct execution; see
  [`../11-ui/information-architecture.md`](../11-ui/information-architecture.md#4-sql).)
- No impersonation of application roles in V1. Testing RLS as a tenant needs an
  engine-controlled role switch with explicit GUCs, designed as "policy probes"
  ([OD-15](../00-product/open-decisions.md#od-15-policy-probes-in-verification)).
- No multi-statement scripts on the read path.
- No fan-out writes across targets.

## 5. Tests

- Escape attempts on the read path: `SET TRANSACTION READ WRITE` first,
  `WITH x AS (DELETE …) SELECT …`, `SELECT pg_advisory_lock(…)`, `SELECT
  dblink_exec(…)`, `SELECT nextval(…)`, `SELECT f()` where `f` is a `SECURITY
  DEFINER` function that writes, `COPY … TO PROGRAM`, `SELECT pg_sleep(1e6)`,
  `; DROP TABLE` (second statement), comment and dollar-quote tricks: all refused
  or contained.
- Hostile identifiers in catalog data never break engine SQL (round-trip property
  tests of every escaper against `quote_ident`/`quote_literal` on a live server).
- Cancellation hits only the intended backend (pid + backend_start).
