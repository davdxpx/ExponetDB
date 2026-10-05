# SQL execution security

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (introspection execution), Wave 7 (MCP `sql_query`), Wave 8 (SQL editor), Wave 9 (diagnostics) |
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
   reads (target setting `dataRead: enabled | humans_only | disabled`; default
   for prod tier: `humans_only`, see [OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production)).
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
   target's `dataRead` setting and the reader role's privileges.
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
  `serve` admits the query, forwards it on an internal request lane and waits up
  to the statement timeout.
- `application_name = 'exponetdb/query/<request id>'`; the request can be
  canceled by the caller (`sql_cancel`), which maps to `pg_cancel_backend` on
  that exact backend.

### 2.3 Audit

Every `data.read` call writes an audit event with: actor, client, target, the
**normalized** statement (constants replaced, see redaction), a statement digest,
row count, truncation, duration, and the masked-column list. Never the result
values.

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
