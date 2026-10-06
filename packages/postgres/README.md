# @exponetdb/postgres

Everything that knows PostgreSQL for managed targets
([`postgres-adapter.md`](../../exponetdb-docs/03-database-model/postgres-adapter.md)).
Domain packages use it through consumer-shaped functions; nothing else in
ExponetDB opens a connection to a managed database.

| Part | What it does |
|---|---|
| `session.ts` | `TargetSession`: TLS `verify-full` only (the endpoint's CA bundle, the registered server name, no plaintext fallback), pinned session settings, guards (TLS in use, `system_identifier`, database), statement and client deadlines, cancel by process id and secret key, per-cluster budget and circuit breaker |
| `sql.ts` | `TrustedSql` (a frozen, registered object from the `sql` template only), `quoteIdent`, `quoteLiteral`, `dollarQuote` |
| `errors.ts` | SQLSTATE and TLS mapping to the catalog; `DETAIL` is dropped |
| `parser/` | libpg_query per major (16.7.3, 17.7.4, 18.1.5): statement split, `data.read` and `verify.sql` admission, PostgreSQL lexer, statement redaction |
| `introspection/` | the `fp1` canonical document and fingerprint, the visibility report, the document diff, the cluster fingerprint (`cfp1`) |
| `ledger.ts` | the identity marker and the empty ledger in schema `exponetdb` (registration, target side), Control Store refusal, the schema lock |
| `probes.ts` | simple and extended protocol probes, identity, capacity, activity |
| `bootstrap.ts` | the role and database bootstrap SQL for a person (verifiers only, never a password) |

**Not its responsibility.** Knowing which target a database is (the
registry resolves targets and supplies the connection spec), deciding who
may do what (`@exponetdb/auth`, `@exponetdb/application`), storing
anything in the Control Store, observation scheduling
(`@exponetdb/diagnostics`).

**Allowed dependencies:** `kernel`, `contracts`, `observability` and its
own `postgres/parser`; runtime libraries `pg`, `pg-cursor` and
`libpg-query` per major (the only package that may name them, besides the
test kit for `pg`).

**Security boundary.** No plaintext and no unverified TLS, ever; no
superuser; a session refuses to run anything before its guards (TLS in use,
`system_identifier`, database; for writes the identity marker) pass; every
statement is a `TrustedSql` built from the `sql` template with
context-correct quoting, catalog text is data; `DETAIL` never leaves the
package; read sessions are `READ ONLY` with statement and lock deadlines.

**Major interfaces.** `TargetSession.open(spec, options)`, `query`,
`readOnly`, `cancel`, `close`; `sql`, `quoteIdent`, `quoteLiteral`;
`takeSnapshot`, `fingerprintOf`, `diffDocuments`, `securityRelevant`,
`documentJson`/`documentFromJson`, `clusterFingerprint`; `stampTarget`,
`readMarker`, `takeSchemaLock`, `controlStoreSigns`; `probeSimple`,
`probeExtended`, `probeIdentity`, `readCapacity`, `readActivity`;
`admitRead`, `admitVerify`, `redactStatement` (`postgres/parser`); the
bootstrap SQL builders.

Tests: `bun run test` (no database) and `bun run test:integration` against
PostgreSQL 16, 17 and 18 with TLS (`eval "$(bun run --silent dev:targets)"`):
sessions and TLS refusals, admission, escaping, the plan guard on a
2,000-table catalog, the fingerprint budget on a consumer-sized schema,
`fp1` determinism and sensitivity, and the `fp1` golden vectors
(`tooling/golden/fp1.json`, `schema-diff.json`).
