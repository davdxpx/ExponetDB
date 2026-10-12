# PostgreSQL adapter (`packages/postgres`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (core), Waves 6 and 9 (extensions of it) |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md) C-34, [`sql-execution-security.md`](./sql-execution-security.md), [`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md#postgresql-introspection-pg-meta) |
| Decision | [ADR-0003](../01-architecture/adr/0003-postgresql-only-v1.md), [ADR-0021](../01-architecture/adr/0021-libpg-query-parser.md) |

## 1. The boundary

**[DECIDED]** `packages/postgres` contains everything that knows PostgreSQL:
connections and protocol details, catalog queries, deparse functions, the SQL
parser, lock rules, privilege semantics, error codes, version differences,
extension knowledge (pgvector, pg_trgm, pg_stat_statements). Domain packages
(`migrations`, `diagnostics`, `backups`, `registry`) consume it through
interfaces shaped by **their** needs:

| Interface (consumer-shaped) | Used by | Provided operations |
|---|---|---|
| `TargetSession` | everyone | open a verified session for a target and an access role; identity guards |
| `SchemaSnapshotter` | migrations, drift, backups | canonical document + fingerprint for a managed scope; cluster fingerprint |
| `StatementAnalyzer` | migrations | split, classify, derive expectations, lock rules, compatibility flags |
| `MigrationExecutor` | migrations | execute statements in the transactional / non-transactional modes with pinned settings |
| `ReadQueryRunner` | data.read, verification | admission-checked read-only execution with caps (defense in depth, not a sandbox) |
| `DiagnosticsReader` | diagnostics | activity, locks, statements, sizes, vacuum, WAL, replication, settings |
| `BackendSignaler` | operations | cancel/terminate with precondition tokens |
| `Redactor` | everyone | statement and error redaction |
| `LiveAdvisors` | diagnostics, UI | generic lint rules on a live schema |

There is no generic `DatabaseEngine` interface. If another engine is ever added,
these consumer-shaped interfaces are the seam, and each will be re-examined:
a MySQL migration executor, for example, cannot offer transactional DDL at all,
so pretending today that the interfaces are engine-neutral would be false
abstraction (P-11).

## 2. Supported server versions

**[DECIDED]**

| Major | Status for managed targets | Reason |
|---|---|---|
| 17 | primary (REOSA target) | `reos-db-01` runs 17 |
| 18 | supported | current major (18.6); new features used where available (`uuidv7()`, NOT NULL `NOT VALID`, async I/O metrics) |
| 16 | supported | `INHERIT/SET` options on role grants (needed for the migrator model) exist since 16 |
| 15 and older | not supported | 14 reaches end of life on 2026-11-12; 15 lacks role grant options |
| 19 | added after general availability | 19 is in beta (Beta 4, 2026-09-24) |

**[OBSERVED]** versions and dates: postgresql.org versioning policy page, fetched
2026-10-04.

Every query module declares the majors it supports; version-specific columns
(for example `pg_stat_statements` and `pg_stat_checkpointer` changes in 17,
`pg_aios` in 18) are selected by `server_version_num`, compared numerically.
**[OBSERVED]** The Supabase reference compares versions as text in places
(`'… >= 15'`), which is wrong for `9` vs `10`-style comparisons; not repeated here.

## 3. Driver and connections

**[PLANNED]** Driver: `node-postgres` (`pg`) with `pg-cursor`, confirmed by a
spike in Wave 4. Reasons: explicit control over the extended protocol (no
implicit pipelining), server-side cursors for capped reads, query cancellation,
notices, `verify-full` TLS with custom CA and servername. **[OBSERVED]** REOSA's
2026-09-24 outage came from postgres.js pipelining interacting with a transaction
pooler (REOSA `database.md`); ExponetDB connects directly to clusters and never
through a transaction pooler for its own work, but the driver choice still favours
explicit protocol control.

**[DECIDED]** Connection rules:

| Rule | Value |
|---|---|
| TLS | `verify-full`, CA bundle and servername from the endpoint |
| Pools | per (target, access role): observer max 2, reader max 4, operator max 1; migrator and verifier connections are dedicated and not pooled |
| Connection budget | at most 8 connections per cluster from one ExponetDB installation, so that ExponetDB is never the reason a cluster runs out of slots. **[DECIDED]** (Wave 4, G4 record §5 D4) A process cannot see another process's connections, so the 8 are split: `serve` 3, the worker 5, each one budget per process shared by every session, observation read and health probe it opens; a waiter without a slot fails with `TARGET_UNAVAILABLE` (`budget_exhausted`) at its deadline. Fixed in Wave 4 (configuration is **[PLANNED]** with the deployment settings) |
| Timeouts | connect 5 s; role-level and per-transaction `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` always set |
| Keepalives | TCP keepalives on (idle 30 s, interval 10 s, count 3), `tcp_user_timeout` 60 s. **[DECIDED]** (Wave 4, G4 record §5 D10) Node.js sets keepalives with the 30 s initial delay only (interval and count are the operating system's) and has no `tcp_user_timeout` socket option; every query instead has a client-side deadline (`query_timeout`) besides `statement_timeout`, and a session that missed one is destroyed, never reused, so a dead peer ends the caller's wait within the deadline |
| `application_name` | `exponetdb/<path>/<request-or-operation-id>` |
| Endpoint selection | registry rule: private before public; never a pooler endpoint for migrator, verifier or operator |
| Circuit breaker | after 3 consecutive connection failures within 60 s, the target is marked `unreachable` for 30 s; callers get `TARGET_UNAVAILABLE` immediately instead of piling up |

### Session guards (on every new connection)

1. `SELECT system_identifier FROM pg_control_system()` equals the cluster's
   pinned value, else `CLUSTER_IDENTITY_MISMATCH`. **[OBSERVED]** (G4
   review, 2026-10-07) Every role reads `pg_control_system()` directly: the
   function keeps PostgreSQL's default `EXECUTE` for PUBLIC on 16, 17 and
   18, so no privilege and no `SECURITY DEFINER` helper is needed.
2. `current_database()` equals the placement's database name.
3. `server_version_num` recorded; a change since the last connection invalidates
   cached capability information.
4. For write-capable roles (migrator, operator): `exponetdb.target_identity`
   matches `(installation_id, target_id, generation)`, else
   `TARGET_IDENTITY_MISMATCH`; the session is not handed out, and the health
   sampler, which reads the marker on its own schedule, suspends the target
   ([C-27](../00-product/constitution.md#c-27-identity-before-writes)).

**[DECIDED]** (Wave 4) Where each guard lives: every session checks TLS in
use (`pg_stat_ssl`), the pinned `system_identifier`, the database name and
its oid (recorded in the session facts), a supported major, and refuses a
login that is or belongs to a superuser (`superuser_login`), so a later
`ALTER ROLE … SUPERUSER` is noticed. Guard 4 is the registry connector's:
a migrator or operator session on a target is handed out only after the
marker names this installation, target and generation (`marker_missing`,
`marker_mismatch`). The one exemption is `target.register`, which opens its
migrator session by cluster and database and whose stamp preflight refuses
a Control Store, another cluster, another database oid and any foreign or
half-made marker before writing. A session without the pinned identifier
exists only for the observer of a cluster that is not confirmed yet, and a
pooler endpoint is never used for the migrator, the verifier or the
operator.

### Connectivity probe

**[DECIDED]** Health probes run **two** queries and report both:

- simple protocol: `SELECT 1`;
- extended protocol with a bind parameter: `SELECT $1::int` with `1`.

**[OBSERVED]** On 2026-09-24 REOSA's health endpoint (`select 1`) stayed green
while every parameterized query hung for up to an hour; the "simple ok, extended
failing" signature is a named state in ExponetDB's health model
([`../10-observability/health.md`](../10-observability/health.md)).

**[DECIDED]** (Wave 4) The guard query that opens every session has the connect
deadline (`connectTimeoutMs`, default 5 s): a path that accepts the connection
but never answers it (a hung pooler) fails the open with `TARGET_UNAVAILABLE`
(`connect_timeout`) instead of hanging the caller. The guard runs over the
extended protocol like every engine statement, except for health probe
sessions, which open with `guardProtocol: 'simple'`: on a path whose extended
protocol hangs from the first message the probe session still opens, `SELECT 1`
succeeds and `SELECT $1::int` times out, so the health model sees
`extended_protocol_failing` and not a path that is down. Both cases are tested
through the fault proxy on PostgreSQL 16, 17 and 18
(`packages/postgres/test/probes.int.test.ts`).

## 4. Introspection

**[DECIDED]**

- One query per object class, returning rows validated with the contracts'
  schemas. Queries read `pg_catalog` directly; `information_schema` is avoided
  (it filters by privileges and hides PostgreSQL-specific objects; for example its
  `triggers` view omits `TRUNCATE` triggers and internal triggers).
- Roles are read from `pg_roles`, never `pg_authid` (superuser-only).
- Name identity, not OID identity, for anything compared across databases.
- Keyset pagination by OID for classes that can be large; single-object reads
  scoped by OID passed as a parameter (not via materialized CTEs).
- Every query carries an explicit `ORDER BY` and runs with
  `search_path = ''` (deparse output fully qualified).
- **Plan guard**: every introspection query is tested with `EXPLAIN (ANALYZE,
  FORMAT JSON)` against a synthetic catalog (≥ 2,000 tables, partitions, policies,
  pgvector indexes, many functions). Unexpected sequential scans of catalogs fail
  the test; tolerated scans need a written reason.
- **Visibility report**: objects or attributes the role could not read are listed;
  consumers must treat an incomplete snapshot as such.

Two outputs share the same queries:

- the **canonical document** (identity attributes only) for fingerprints;
- the **inspection model** (canonical attributes plus sizes, statistics,
  comments, validity) for the Web App, REST and MCP schema views.

## 5. SQL parsing and analysis

**[DECIDED]** libpg_query (PostgreSQL's own parser, packaged for Node.js as WASM
or native bindings) pinned per supported major. Uses:

- statement splitting with source ranges (statement index ↔ text position);
- classification (DDL kind, DML, transaction control, utility, forbidden);
- derivation of structural expectations;
- lock and compatibility rules;
- normalization for redaction (constants → `$n`);
- admission of `verify.sql` and `data.read` statements (statement forms,
  output columns, function/operator/cast allowlist, relation kinds);
- PL/pgSQL parsing of `DO` blocks and function bodies in `up.sql` for analysis
  (`DO` is not admitted in `verify.sql` or `data.read`).

Grammar mismatch: a bundle for a 16 target parsed with the 17 grammar could accept
syntax the server rejects; the plan records the grammar version and the server
rejects at execution anyway (transactional rollback). The parser version is part
of the engine version recorded in the ledger.

### Migration execution surface (Wave 6)

**[DECIDED]** The `MigrationExecutor` interface above is a set of small,
separately tested pieces; the engine (`packages/migrations/engine`) composes
them, the adapter decides nothing about plans or policies:

- **Reviewed statements** (`reviewedStatements`): bundle text becomes
  executable only through the analyzer. A statement is a `ReviewedStatement`
  only when the whole text parsed (`analyzeMigrationSql` ok, no NUL) and no
  statement is forbidden; the object is registered in a module-private set,
  so a hand-built object with the same fields is refused (`TypeError`).
  `TargetSession.executeReviewed` runs one such statement over the extended
  protocol, only on a `migrator` session; driver errors map through §7 with
  the migration lock path.
- **Catalog reads in the open transaction** (`TargetSession.reader()`, the
  `CatalogReader` shape shared with read-only transactions): the structural
  expectations (`checkExpectations`, verification.md L0, resolved with
  `to_regclass`/`to_regprocedure`/`to_regtype`/`to_regnamespace` under the
  migration's `search_path` pinned with `pinSearchPath`), the in-transaction
  fp1 snapshot (`snapshotWithin`, the same code the observer's
  `takeSnapshot` runs) and the engine guards (`readEngineGuards`: current and
  session user, `search_path`, the timeouts, `standard_conforming_strings`,
  `TimeZone`, `DateStyle`, `IntervalStyle`, `client_encoding`,
  `check_function_bodies`, `transaction_read_only`), read before the first
  statement and after each; any difference (`changedGuards`) stops the
  migration. This is defense in depth behind the analyzer's refusal of
  `SET ROLE`, session `SET`, `RESET` and `set_config` text: a function
  called by a statement can still change a setting, and the guards notice.
  An identity column counts as having a default (`attidentity`), as the
  analyzer derives it.
- **Execution roles** (`executionRoleFacts`, `executionRoleProblem`): a
  declared owner is usable only when it exists, is `NOLOGIN`, has no
  privileged attribute, is neither an ExponetDB nor a predefined role, and
  the migrator is a direct member with `SET TRUE` and `INHERIT FALSE`, so
  the migrator gains no privilege implicitly.
- **Ledger history** (`lockMarker`, `insertLedgerRow`, `insertMigrationEvent`,
  `insertVerification`, `markReverted`, readers): the identity marker is
  locked `FOR SHARE` and compared in the migration's own transaction; the
  ledger row and its event are written in that transaction.
- **Migrator sessions** start with server-side TCP keepalives
  (`tcp_keepalives_idle=30`, `interval=10`, `count=3`) and set
  `tcp_user_timeout` and `client_connection_check_interval` where the
  server supports them, so a lost client connection ends the backend and
  releases its locks ([concurrency.md §4](../04-migrations/concurrency.md#4-release-and-crash-behavior)).
- **Target locks** (`takeTargetLock`): the `schema` and `maintenance`
  classes built from both advisory keys in a fixed order
  ([concurrency.md §2](../04-migrations/concurrency.md#2-lock-scope-and-key-derivation)),
  with the holders' `application_name` while waiting.
- **verify.sql** (`analyzeVerifyFile`, `resolveVerifyCatalog`,
  `admitChecks`, `TargetSession.runAdmittedCheck`, `verifierProblems`):
  [verification.md §4.2](../04-migrations/verification.md#42-admission-plan-time).

Proof: `packages/postgres/test/migration-exec.int.test.ts` and
`verify-locks.int.test.ts` on 16, 17 and 18
(owner, ownership, in-transaction fingerprint equal to the observer's after
commit, L0 failure of an `IF NOT EXISTS` that met another shape rolled back,
a guard changed by a function noticed, forged statements refused).

## 6. Safe SQL builder and escaping

**[DECIDED]**

- Values: always bind parameters.
- Identifiers: `quoteIdent` that always quotes (no "unquoted if safe" heuristic,
  so reserved-word lists cannot be wrong); rejects NUL; warns above 63 bytes
  (server truncation).
- Literals (only where a parameter is impossible, for example in `ALTER ROLE …
  PASSWORD` verifier statements executed by the agent): `quoteLiteral` producing
  `E'…'` with backslash and quote doubling.
- Nested contexts: there are none in engine SQL. Where PostgreSQL syntax forces
  text inside text (for example a function body), the engine generates a
  dollar-quote tag that does not occur in the body (random suffix) and refuses
  bodies containing NUL.
- Provenance: `TrustedSql` (engine-built), `UntrustedSql` (from users, agents,
  bundles, catalogs). The executor accepts only `TrustedSql` for engine paths; the
  read path accepts `UntrustedSql` only after admission (§ sql-execution-security);
  the migration path accepts bundle text only from a stored plan.

## 7. Error mapping

| SQLSTATE class / code | ExponetDB code |
|---|---|
| `08*` connection exceptions, `57P01`–`57P03` | `TARGET_UNAVAILABLE` |
| `28P01`, `28000` | `TARGET_CREDENTIAL_INVALID` |
| TLS handshake/verification failure (client side) | `TARGET_TLS_FAILED` |
| `55P03` lock not available, `57014` with lock_timeout | `MIGRATION_LOCK_TIMEOUT` (migrations) / `QUERY_TIMEOUT` (reads) |
| `57014` statement timeout | `QUERY_TIMEOUT` / `MIGRATION_EXECUTION_FAILED` with `details.timeout` |
| `25006` read-only transaction | `QUERY_NOT_READ_ONLY` |
| `42501` insufficient privilege | `PERMISSION_DENIED` on the database side (`details.databasePrivilege: true`), distinct from ExponetDB authorization |
| `42xxx` syntax/semantic | `QUERY_PARSE_ERROR` (read path) / `MIGRATION_EXECUTION_FAILED` (migration path) |
| others | wrapped with SQLSTATE, message, hint, position; `DETAIL` dropped |

## 8. Extensions knowledge

| Extension | Why ExponetDB cares | Notes |
|---|---|---|
| `vector` (pgvector) | REOSA uses `vector(1024)` columns and an HNSW cosine index | typmod rendering, index options (`m`, `ef_construction`), opclasses; version tracking (`ALTER EXTENSION vector UPDATE` via node capability) |
| `pg_trgm` | REOSA search indexes | trusted extension |
| `pg_stat_statements` | performance views | requires `shared_preload_libraries` → configuration change + **restart**; enabling it on `reos-db-01` is a planned node operation. **[OBSERVED]** REOSA's migrations never create it, but the hosted provider has it enabled: REOSA's performance measurements read it on `reosa-production`, cumulative since 2026-07-02 (`REOSA/reosa-docs/09-operations/build-performance.md`). A move to `reos-db-01` must enable it there to keep that visibility. |
| `amcheck` | restore drills (index/heap checks) | installed in drill clusters only |
| `dblink`, `postgres_fdw` | a security concern for read paths (a separate read-write session or a remote call) | presence checked; reader and verifier must not have `EXECUTE` |

## 9. Testing support

`packages/testkit` provides PostgreSQL containers for majors 16, 17, 18 with
pgvector and pg_trgm, a template-database cache keyed by a hash of the fixture
SQL, hostile-metadata fixtures, the synthetic plan-guard catalog generator, and
toxiproxy-style fault injection for connection drops and latency.
