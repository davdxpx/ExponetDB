# Statement redaction

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 4 onward (every surface that can show SQL text) |
| Read before | [`sql-execution-security.md`](./sql-execution-security.md) |

Query text in PostgreSQL's views and logs contains literals: passwords in `ALTER
ROLE`, e-mail addresses in `WHERE` clauses, tokens in `INSERT`s, personal data in
backfills. ExponetDB shows statements on many surfaces. **[DECIDED]** Every
statement text is redacted **before it leaves the component that read it**, and
the default everywhere is the redacted form.

## 1. Where statement text appears

| Source | Example | Surfaces |
|---|---|---|
| `pg_stat_activity.query` | currently running statements | connections/locks views, MCP `sessions_list`, health samples |
| `pg_stat_statements.query` | aggregated statements | performance views, MCP `query_stats` |
| PostgreSQL error messages | `DETAIL: Key (email)=(a@b.de) already exists.` | operation records, API errors |
| Migration statements | executed `up.sql` text | plan views, operation events |
| `data.read` queries | caller's SQL | audit events |
| Server logs read by the node agent | `log_min_duration_statement` lines | `log.inspect` capability |
| `EXPLAIN` output | `Filter: (email = 'a@b.de'::text)` | plan visualizer |

## 2. Algorithm

**[DECIDED]**

1. **Parse-based normalization (primary).** Run libpg_query's normalization on
   the text: every constant (string, number, bit string, typed literal, array
   literal, `E''`, `U&''`, dollar-quoted string *used as a value*) becomes `$n`.
   Comments are removed. Identifiers stay.
2. **Sensitive command handling.** Regardless of parse success, statements of
   these classes are reduced to a fixed summary: `ALTER ROLE … PASSWORD`,
   `CREATE ROLE/USER … PASSWORD`, `ALTER USER MAPPING`/`CREATE USER MAPPING`
   (options), `CREATE SERVER … OPTIONS`, `SET`/`set_config` of parameters whose
   name contains `password`, `secret`, `token`, `key`, `COPY … PROGRAM`.
   Example: `ALTER ROLE <name> PASSWORD <redacted>`.
3. **Lexer fallback.** If parsing fails (most often because PostgreSQL truncated
   the text at `track_activity_query_size`), a PostgreSQL-rules lexer replaces
   every literal token, including an unterminated trailing literal, with `$?`,
   removes comments and keeps keywords and identifiers. The result is marked
   `redaction: lexical` so that consumers know the guarantee is weaker.
4. **Last resort.** If the lexer also fails (invalid encoding), the text is
   replaced by `<statement redacted: unparseable>` plus the statement digest.
5. **Length cap** after redaction (default 2,000 characters for UI, 500 for MCP),
   with a `truncated` flag.

Function bodies inside `CREATE FUNCTION` statements are dollar-quoted *literals*
from the parser's point of view; they are replaced by `$n` too. Showing a
migration's full SQL is a different surface (plan content), governed by plan
permissions, not by statement redaction.

## 3. Errors

**[DECIDED]** PostgreSQL error `DETAIL` is dropped from every API response and log
line by default (it carries row values for unique, foreign-key and check
violations). `MESSAGE`, `SQLSTATE`, `HINT`, `POSITION`, schema/table/column/
constraint names are kept. This follows REOSA's `describeError`, which keeps
codes and names but never `detail` (`REOSA/packages/observability/src/describe.ts`).
The full error, still redacted, is stored in the operation record for identities
with `diagnostics.read_sensitive`.

## 4. Raw text access

Some incidents need the literal statement. **[DECIDED]** Raw text is available
only:

- to human identities with `diagnostics.read_sensitive` at the target's scope,
- through the Web App (never MCP), after re-authentication,
- per statement (no bulk export),
- with an audit event naming the statement digest.

## 5. Known weaknesses of simpler approaches (test corpus)

**[OBSERVED]** REOSA's current redaction (`redactStatement` in
`REOSA/packages/db/src/pooler-reaper.ts`) folds whitespace and replaces
single-quoted literals with a regular expression. It does not redact numeric
literals, dollar-quoted strings, comments, or `E''` strings with backslash escapes
(`E'it\'s secret'` leaks `s secret`), and its 80-character log prefix bypasses the
general scrubber (REOSA diagnostics audit). These cases form the minimum test
corpus for ExponetDB's redaction, plus:

- literals cut at `track_activity_query_size`;
- nested comments containing quotes;
- `U&'…' UESCAPE '!'`;
- `$tag$…$tag$` containing `$$`;
- identifiers that look like e-mail addresses (kept: identifiers are not data;
  the risk is documented);
- `IN (…)` lists with thousands of constants (normalized to `IN ($1, …)` and
  capped).

## 6. Logs of ExponetDB itself

ExponetDB's own structured logs follow the same rules: statements are logged only
as digest + normalized text; parameters are never logged; connection strings are
never logged (the logger has a hard denylist for `postgres://` URIs with
passwords, `password=` key-value pairs, bearer tokens, and the known secret
prefixes ExponetDB issues). See
[`../10-observability/self-observability.md`](../10-observability/self-observability.md).
