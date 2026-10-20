# Statement redaction

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
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
   **[OBSERVED]** (Wave 8 completion, 2026-10-20, `packages/postgres/src/parser/redact.ts`)
   `ALTER SYSTEM`, `ALTER DATABASE … SET` and `ALTER ROLE … SET` of such a
   parameter give `ALTER … SET <setting> <redacted>` as well; before, the
   tree's untyped `setstmt` was missed, so their value was masked as a
   literal but no summary was given (G8 record §8).
3. **Lexer fallback.** If parsing fails (most often because PostgreSQL truncated
   the text at `track_activity_query_size`), a PostgreSQL-rules lexer replaces
   every literal token, including an unterminated trailing literal, with `$?`,
   removes comments and keeps keywords and identifiers. The result is marked
   `redaction: lexical` so that consumers know the guarantee is weaker.
   **[DECIDED]** (Wave 4, corrected after the G4 adversarial review) The text's
   `standard_conforming_strings` setting is unknown, and a backslash before a
   quote ends a literal under one setting and not under the other (`'C:\',
   'secret'` shifts every later literal). The lexer therefore reads the text
   both ways and masks every character that is inside a literal under either
   reading (and drops what is inside a comment under either). The parse-based
   path, which assumes the setting is on, falls back to this when the other
   reading finds a literal that the parse would print. Dollar-quote tags are
   matched without a length limit, as PostgreSQL does.
   **[DECIDED]** (G4 correction, 2026-10-07) A constant written as a bare or
   quoted word (`SET app.claims = hunter2`, `ALTER ROLE r SET x TO "v"`) is a
   value, not an identifier: the parse path hides every word the parse tree
   marks as a constant (other than `NULL`, `TRUE`, `FALSE`), and the lexer
   fallback hides every word after `SET … =` or `SET … TO` up to the end of
   the statement, except in the `SET` of an `UPDATE` (also `ON CONFLICT DO
   UPDATE` and `MERGE … UPDATE`), which keeps its column names: a `SET` with
   the command `UPDATE` between it and the previous `SET` or the start of
   the statement (`UPDATE` as the first word, or after `DO`, `THEN`, `ALSO`
   or `INSTEAD`, which only the command can follow; never a name such as
   `ALTER ROLE update SET …`). Anything else fails closed, a misspelled or
   quoted keyword, a missing `;`, and `WITH … UPDATE` or `EXPLAIN UPDATE`
   included (their column names are hidden too: a stray `update` after `)`,
   `AS` or `ANALYZE` must not print a value) (correction reviews). Redaction time is linear in the text: a statement with
   100,000 constants is redacted in well under a second (it was quadratic,
   about a minute, before the correction).
4. **Last resort.** If the lexer also fails (invalid encoding), the text is
   replaced by `<statement redacted: unparseable>` plus the statement digest.
5. **Length cap** after redaction (default 2,000 characters for UI, 500 for MCP),
   with a `truncated` flag.
   **[OBSERVED]** (Wave 7) The session list applies 500 to every MCP caller
   (the use case decides from the caller's audience, never from the
   request) and reports `truncated` with the digest of the whole redacted
   text; `apps/server/test/mcp.int.test.ts` checks both caps on one session.

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

**[DECIDED]** (Wave 8, owner decision S2,
[open-decisions.md](../00-product/open-decisions.md#owner-decisions-in-the-wave-8-session-2026-10-13))
The raw text is a **live lookup**, never a store: no Control Store table,
cache, log line or audit event keeps statement text, so the view can only
show what the target still holds at request time.

**[OBSERVED]** (Wave 8) `GET /api/v1/statements/{digest}/raw?target=…`
(`statement.raw.get`, `packages/diagnostics/src/raw-statement.ts`,
`packages/postgres/src/parser/reveal.ts`):

1. **Who.** `diagnostics.read_sensitive` at a scope covering the target, a
   person in the Web App only (client `web`, human; the first-party CLI, API
   keys, OAuth clients and MCP are refused by the action), with a passkey or
   TOTP re-authentication within **15 minutes** (`reauthWithinSeconds: 900`,
   [identity.md §4](../08-auth-and-security/identity.md#4-re-authentication-step-up)). One digest per
   request; there is no batch form. A refusal that names a missing
   permission is recorded as `authz.denied` (`isHighRiskAction`).
2. **What the digest names.** The digest every surface shows: `sha256:<hex>`
   of the statement's redacted form (§2, before the length cap). Today the
   sessions list (`pg_stat_activity`) shows it; the Wave 9 statement
   statistics will show the same digest of `pg_stat_statements` text.
3. **Where it looks.** Through serve's observer session, exactly as the
   sessions list reads (identity marker checked first, `pg_read_all_stats`
   required, never a write path, never a superuser): `pg_stat_activity` of
   the target's database (client backends, newest query first, at most
   1,000 rows), or, when the request names `pid` (and the `backendStart`
   the sessions list showed), that session only; then, without a named
   session and without a match, `pg_stat_statements` of the database (by
   calls, at most 5,000 rows) when the extension is installed and loaded.
   PostgreSQL normalizes that view's text itself, so a match there shows
   `$n` where the constants were.
4. **The check.** The redacted form's digest is recomputed from every text
   read; only a text whose digest equals the requested one is answered, and
   the answer's digest is checked once more.
5. **Secrets are still removed** (clean-room, `revealStatementSync`), and
   the redactor's guarantees are kept where it gives up the statement:
   - a sensitive command (§2 step 2: role passwords, user mappings, foreign
     server options, settings named like secrets, `set_config` of such a
     setting, `COPY … PROGRAM`), also in a text cut at
     `track_activity_query_size`, is shown only as its fixed summary
     (`mode: summary`); text that is not well-formed Unicode as the
     unparseable marker (`mode: unparseable`);
   - otherwise (`mode: literal`) the text keeps its literals and each of
     these spans becomes `<redacted>`, inside a literal, a comment or bare:
     the password of a URL with user information (what stands between the
     user name's colon and the `@`); the value after a key named like
     a credential (`password`, `passwd`, `passphrase`, `pwd`, `secret`,
     `token`, `api_key`, `access_key`, `private_key`, `credential`,
     `keyring`, `signature` anywhere in a name, so `sslpassword`,
     `client_secret` and `password_hash` too; `session_id`, `sid`, `sig`,
     `otp`, `totp`, `code_verifier`, `user_code`, `device_code`,
     `client_assertion`, `recovery_code` as a whole name segment) and `=`,
     `:=`, `=>` or `:` (never the cast `::`), whether the value is a conninfo
     value quoted with doubled quotes inside a SQL literal
     (`password=''p w''`), a SQL string, a double-quoted, a dollar-quoted or
     a bare value; JSON members with such a name; and the other patterns of
     the log denylist ([self-observability.md §2](../10-observability/self-observability.md#2-log-fields):
     private key blocks, authorization and cookie headers, bearer and basic
     tokens, JWTs, every ExponetDB token kind, `otpauth:` URIs, TOTP secrets,
     recovery codes, cloud and vendor keys, `PASSWORD '…'`), without its
     IPv4 and IPv6 patterns (addresses and clock times are statement data
     here); every literal (and comment) inside the argument list of a
     function that takes or hashes a secret: pgcrypto's `crypt`,
     `pgp_sym_*`, `pgp_pub_*`, `pgp_key_id`, `dearmor`, `encrypt*`,
     `decrypt*`, `hmac`, `digest`, the hashes `md5` and `sha224` to
     `sha512`, and `dblink_connect`/`dblink_connect_u`, under both readings
     of `standard_conforming_strings`;
   - every repetition is bounded, so a long statement is processed in linear
     time (the log denylist's URL and assignment patterns are quadratic on
     long runs of name characters and are replaced by bounded ones here).
   **[DECIDED]** What no key, prefix, pattern or function marks stays
   readable (`WHERE api = 'hunter2'`, a host name in a conninfo): that is
   the literal text the view exists for, and why it is human only,
   re-authenticated and audited. It errs on the side of removing too much.
6. **Answer.** The text as untrusted data (`untrusted: true`, at most
   65,536 UTF-16 code units, `truncated`, never split inside a surrogate
   pair), `redaction` (`mode`, `removed`), `origin` (`pg_stat_activity` with
   `pid`, `backendStart`, `queryStart`, or `pg_stat_statements` with
   `calls`, total and mean execution time and `rows`), `source: live`,
   `observedAt`.
7. **Not available.** `404 STATEMENT_NOT_AVAILABLE` with `details.reason`:
   `not_held` (no source holds the digest now; a named session that is gone
   or restarted), `digest_mismatch` (the named session runs another
   statement now), `extension_missing` (not in `pg_stat_activity`, and
   `pg_stat_statements` is not installed, or installed but not in
   `shared_preload_libraries`: SQLSTATE 55000), `target_unreachable` (the
   target is not active or suspended, or no connection, credential, TLS or
   time). An identity mismatch or a lost `pg_read_all_stats` keep their own
   errors: they are not an absent statement.
8. **Audit.** Every view, also a refused lookup, writes
   `diagnostics.raw_statement_viewed` before the answer leaves (no audit, no
   text): the target, the digest, the requested `pid`, where it was found
   (`view`, `pid`), `mode`, `removed`, `truncated`, or the reason; never
   the text.

`[OBSERVED]` in `packages/postgres/test/reveal.test.ts` (secret forms on
grammars 16, 17 and 18, untouched statements, bounds, linear time),
`packages/diagnostics/test/raw-statement.test.ts` (digest checks, the named
session, the `pg_stat_statements` source on a scripted session) and
`apps/server/test/http-raw-statement.int.test.ts` (real PostgreSQL 17).
**[OBSERVED]** None of the disposable test servers preloads
`pg_stat_statements`, so the real-PostgreSQL proof of that source ends at
`extension_missing` (not installed, and installed but not loaded); the
match on its rows is proven on a scripted session.

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
  capped), up to 100,000 constants in linear time;
- setting values written without quotes (`SET x = word`, `ALTER … SET x TO word`).

## 6. Logs of ExponetDB itself

ExponetDB's own structured logs follow the same rules: statements are logged only
as digest + normalized text; parameters are never logged; connection strings are
never logged (the logger has a hard denylist for `postgres://` URIs with
passwords, `password=` key-value pairs, bearer tokens, and the known secret
prefixes ExponetDB issues). See
[`../10-observability/self-observability.md`](../10-observability/self-observability.md).
