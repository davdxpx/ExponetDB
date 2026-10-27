# Diagnostics and performance

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (read-only diagnostics), Wave 9 (sessions actions, advisors; built in Part B, 2026-10-27, §7) |
| Read before | [`health.md`](./health.md), [`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md), [`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md) |

All diagnostics are **engine-authored, read-only SQL** run with the observer
role (C-23). No diagnostic surface accepts SQL from callers.
[`../03-database-model/sql-execution-security.md` §1](../03-database-model/sql-execution-security.md#1-engine-authored-sql-introspection-diagnostics-operator-actions)
covers how these queries are written and reviewed.

## 1. Diagnostic areas

**[DECIDED]** for V1; each row is one adapter query family with a contract.

| Area | Sources | Shown as | Notes |
|---|---|---|---|
| Sessions | `pg_stat_activity` (client backends) | list with conditions from [`health.md` §3](./health.md#3-named-conditions), grouped by role/application | statement text redacted; raw text only for `diagnostics.read_sensitive` in the Web App: **[OBSERVED]** (Wave 8, owner decision S2) a live lookup by digest, secrets removed, audited, never stored ([`statement-redaction.md` §4](../03-database-model/statement-redaction.md#4-raw-text-access)) |
| Locks and blocking | `pg_locks`, `pg_blocking_pids()` | blocking trees (root blocker first), lock mode, relation, wait time | the root blocker is the actionable item |
| Statement statistics | `pg_stat_statements` (deltas every 5 min) | top by total time, mean time, calls, rows, shared blocks read; per-query history | requires the extension (see §2); query text is already normalized by PostgreSQL and is passed through ExponetDB's redaction again |
| Table health | `pg_stat_user_tables`, `pg_class` | dead tuples, last (auto)vacuum/analyze, seq vs idx scans, size | bloat is an **estimate** and labeled as such |
| Index health | `pg_stat_user_indexes`, `pg_index` | unused indexes (since stats reset, with reset time), duplicate/overlapping indexes, invalid indexes | "unused" is only meaningful with a known stats window; shown with it |
| Wraparound | `age(datfrozenxid)`, `age(relfrozenxid)` per table | oldest tables, distance to autovacuum freeze and to the hard limit | |
| I/O | `pg_stat_io` (PG16+), `pg_statio_user_tables` | reads/writes/hits by backend type and context | |
| Checkpoints and WAL | `pg_stat_checkpointer` (PG17+), `pg_stat_bgwriter`, `pg_stat_wal` | requested vs timed checkpoints, WAL volume, full-page images | |
| Replication | `pg_stat_replication`, `pg_replication_slots` | lag (write/flush/replay), slot retained WAL, inactive slots | |
| Sizes | `pg_database_size`, `pg_total_relation_size` | database, schema, top tables/indexes, TOAST | |
| Settings | `pg_settings`, `pg_file_settings` | non-default values, source, `pending_restart`, errors in config files | |
| Connections security | `pg_stat_ssl`, `pg_hba_file_rules` (via agent for agent-managed clusters) | TLS per connection, hba rules | `pg_hba_file_rules` needs elevated rights; read through the node capability |
| Host | node capabilities `disk/memory/cpu.stats`, `log.inspect` | host metrics, redacted log lines | agent-managed clusters only |

PostgreSQL-version differences (for example `pg_stat_checkpointer` only from 17)
are handled inside the adapter; callers see one contract with
`unsupported` for fields a version does not offer (C-34).

**[OBSERVED]** (Wave 9 Part B, `packages/diagnostics/src/table-stats.ts`)
`GET /targets/{id}/table-stats` (`table_stats.list`, MCP `table_stats`)
reads live on the observer path of §6. The tables (`relkind` `r`, `m`;
partitioned parents left out, their leaves listed; ExponetDB's ledger and the
system schemas never) are chosen by the catalog's page count before any size
is computed, so `pg_table_size` and `pg_indexes_size` run for at most `limit`
tables (default 200, at most 1,000); the indexes are those of the chosen
tables, at most four per table, `truncated` when either list was cut.
`xidAge` is the larger of `age(relfrozenxid)` of the table and of its TOAST
table. **Duplicate indexes**: two indexes of one table with the same access
method, key columns (`indkey`), operator classes, collations, per-column
options, expression text and predicate text (`pg_get_expr`); uniqueness does
not count. Of a group the primary key is kept, else a unique index, else the
oldest (lowest oid); every other member names it in `duplicateOf`. **Bloat**
(`estimateMethod: heuristic_page_estimate`): `table bytes × n_dead_tup /
(n_live_tup + n_dead_tup)`, the space dead row versions take until a vacuum;
`null` when nothing was counted. The free space a vacuum leaves is not
measured: the observer reads neither `pg_stats` widths (they need column
privileges) nor `pgstattuple`. `statsSince` is
`pg_stat_database.stats_reset` of the database, else the server start.

## 2. `pg_stat_statements`

- Needs `shared_preload_libraries` (restart) and `CREATE EXTENSION` in each
  database where it should be queried; both are planned node/extension
  operations in Wave 5.
- Sampling stores **deltas** per `(dbid, userid, queryid)` every 5 minutes for
  the top 200 by total time, plus daily aggregates (retention in
  [`../02-control-plane/data-retention.md`](../02-control-plane/data-retention.md)).
- A stats reset (`pg_stat_statements_reset`, server restart) is detected via
  `pg_stat_statements_info.stats_reset` and recorded as a discontinuity, so
  deltas never go negative and charts show the reset.
- Regressions: a query whose mean time over 24 h exceeds its 7-day baseline by
  a configurable factor (default 2×, with a minimum call count) becomes a
  finding linked to the migrations applied in between (from the ledger). This
  connects "what changed" to "what got slower", which neither reference
  product offers.

**[OBSERVED]** (Wave 9 Part B, `packages/diagnostics/src/statements.ts`,
`statement-math.ts`; bundle `statement-statistics`)

- **Sampler.** The worker task `statements.sample` (every 300 s, at most four
  targets at once) samples every active or suspended target with a
  placement, on an identity-checked observer session (statement timeout 5 s,
  lock timeout 1 s, §6). Outcomes: `not_permitted` when the observer lacks
  `pg_read_all_stats` (error code `PERMISSION_DENIED`), `extension_missing`
  when `pg_stat_statements` is not installed in the target's database or not
  loaded (SQLSTATE 55000; `CAPABILITY_UNAVAILABLE`), `failed` with the
  code of anything else (a target that cannot be reached is a failed sample,
  never an empty one), else `ok` with the top 200 statements **of the
  target's database** by `total_exec_time`. Each sample is one Control
  Store transaction (per-target advisory lock): the sample, its reset event,
  the deltas and the new cumulative counters (`statement_latest`).
- **Versions.** The columns are taken from the view's own catalog entry, not
  from the server version, because the installed extension version decides
  them: `toplevel` (1.9+) restricts the read to top-level statements, which
  share the statement key with nested ones; `stats_since` (1.11+, the
  PostgreSQL 17 version, also on 18) says when an entry was (re)created. The
  I/O timing columns renamed in 1.11 (`blk_read_time` → `shared_blk_read_time`)
  are not read: the contract has no field for them. An extension older than
  1.8 is `failed` / `CAPABILITY_UNAVAILABLE`. Proven on PostgreSQL 16, 17
  and 18 (`packages/diagnostics/test/performance.int.test.ts`).
- **Statement key** `sha256:<hex of dbid:userid:queryid>`.
- **Discontinuities** against the previous successful sample: `first`,
  `server_restart` (`pg_postmaster_start_time()` changed), `stats_reset`
  (`pg_stat_statements_info.stats_reset` changed, or `dealloc` went back),
  `entries_deallocated` (`dealloc` grew). A reset or restart has one event in
  `stats_reset_events`; deltas are written only for `none` and
  `entries_deallocated` (the bundle's guard refuses others).
- **Deltas** (`deltaOf`): none without a previous value of the statement,
  none across another `stats_reset` or server start than the previous
  value's, none for an entry whose `stats_since` is newer than the previous
  value (PostgreSQL 17+: it was evicted or reset and added again), none
  when any counter went down, none when the statement did not run, and
  none when the previous value is older than a gap (more than 600 s, two
  periods: a statement that left the top 200 and came back, or samples that
  failed in between, would put the whole difference into one delta stamped
  now; review D-5); never negative. **[ASSUMPTION]** On PostgreSQL 16 an entry evicted and added
  again whose new count already exceeds the old one gives a wrong positive
  delta: 1.10 has no `stats_since`, and the sample with the eviction shows
  only that some entries were deallocated.
- **Texts** go through the redactor (`statement-redaction.md` §2) before
  they are stored (at most 16,384 characters); a statement the redactor
  replaces with a fixed summary (`ALTER/CREATE ROLE … PASSWORD`, user
  mappings, `CREATE/ALTER SERVER … OPTIONS`, secret-like settings,
  `COPY … PROGRAM`) or cannot read is stored as that summary with
  `text_redacted`. The answer's `digest` is the `sha256` of the redacted text,
  the digest the raw statement view looks up.
- **Reads** (`GET /targets/{id}/query-stats`, `query_stats.list`, MCP
  `query_stats`): the deltas of the target's current generation (by their
  sample) whose interval lies in the window, sampled in `(from, to]` and
  measured from `from` or later (`from_at`; default the
  last 24 hours, at most 7 days, `limit` at most 500), summed per statement
  and ordered by `total_time`, `mean_time`, `calls` or `io` (shared blocks
  read); the newest text, query id, database and role of each; `source:
  sampled`, never a live read. People see 2,000 characters of a text, MCP
  callers 500. `sampling` names the state of the latest sample (`active`,
  `extension_missing`, `not_permitted`, `failing`, `not_sampled_yet`), the
  last successful sample, the last error code, the resets of the window and
  its gaps (intervals over 600 s, two periods, without a successful sample;
  a sample shortly before the window covers its start). A target whose latest
  sample was `extension_missing` is `CAPABILITY_UNAVAILABLE`.
- **Regression** (constants `REGRESSION` in `statement-math.ts`): the mean of
  the window's last 24 hours against the mean of the 7 days before them,
  `regressed` at factor ≥ 2 with at least 50 calls in both windows, else
  `none`, or `insufficient_data`. `migrationsBetween` counts the migrations
  of the target's current generation applied (origin `exponetdb`) inside the
  24-hour window according to the ledger mirror; `null` when the mirror never
  observed the target's ledger (`ledger_state`). A time coincidence, never a
  cause. Once an hour per target (the first successful sample of each UTC
  hour) the sampler opens or counts one finding per regressed statement
  (`observation.subject_findings`, kind `statements`, code
  `statement_regression`, deduplicated by statement key) and resolves it as
  `cleared` when the statement is no longer regressed or has not run.
- **Maintenance.** `statements.partitions` (every 6 h, also at the start of
  each sampling round) keeps the delta partitions of today and the next two
  days and drops those older than the retention (30 days, 7 to 90);
  `statements.rollup` (daily) recomputes the daily aggregates of the last
  three finished UTC days from the deltas (idempotent upserts).
  **[OPEN]** The 400-day retention of `statement_daily` is not enforced: the
  bundle forbids deletes, so a pruning needs a new bundle.

## 3. EXPLAIN

`EXPLAIN` and `EXPLAIN ANALYZE` follow
[`../03-database-model/sql-execution-security.md` §3](../03-database-model/sql-execution-security.md#3-explain).
For statements from `pg_stat_statements`, ExponetDB offers `EXPLAIN (GENERIC_PLAN)`
on PostgreSQL 16+ (planning with parameters, no guessed literals). The plan
visualizer is adapted from the Supabase reference
([`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md)).

## 4. Advisors

**[DECIDED]** shape; catalog version 1 **[OBSERVED]** (Wave 9 Part B, see below).

An advisor is a rule over introspection and statistics that produces
**findings** (`fnd_`) with severity, subject, evidence, remediation and, where
possible, a **planned fix** (for example a migration draft to add a missing
index on a foreign key). Advisors never change anything themselves.

Initial catalog, informed by the PostgreSQL-generic Supabase splinter lints and
rewritten clean-room per rule (rules in
[`../11-ui/supabase-reference-audit.md` "Advisors and lints"](../11-ui/supabase-reference-audit.md#advisors-and-lints)),
plus ExponetDB-specific rules:

| Group | Examples |
|---|---|
| Security | table in an exposed schema without RLS; RLS enabled without policies (silent empty reads); `SECURITY DEFINER` function without fixed `search_path`; extension in `public`; role with `BYPASSRLS` used by an application; plaintext client connections |
| Performance | unindexed foreign keys; duplicate indexes; unused indexes (with stats window); tables without primary key; multiple permissive policies per role/action |
| Operations | XID age; inactive replication slots; WAL archive failing; settings `pending_restart`; `idle_in_transaction_session_timeout` unset for application roles |
| Change safety | migrations applied outside ExponetDB (drift); unmanaged objects; staging behind production |

Supabase-platform-specific lints (for example about `auth` schema exposure via
PostgREST) are not copied; where a consumer needs them, they become
consumer-specific advisor packs registered for that consumer's targets.

**[OBSERVED]** (Wave 9 Part B, `packages/diagnostics/src/advisors/`) Catalog
version 1, written clean-room from the PostgreSQL documentation of the
catalogs it reads (no third-party lint SQL). `POST /targets/{id}/advisor-runs`
(`advisor.run`, MCP `advisors_run`; default categories security and
performance) runs the rules of the requested categories on one observer
session (§6) or from the Control Store; "managed schemas" are the project's
managed scope without ExponetDB's and the system schemas.

| Rule | Category | Level | Facts |
|---|---|---|---|
| `rls_disabled_with_grants` | security | warning | table without RLS where a role other than the owner and not `exponetdb_*` (or `PUBLIC`) holds SELECT, INSERT, UPDATE or DELETE (`aclexplode(relacl)`) |
| `rls_enabled_without_policy` | security | info | RLS enabled, no `pg_policy` row |
| `security_definer_without_search_path` | security | warning | `prosecdef` and no `search_path=` in `proconfig`; extension members left out; draft |
| `bypassrls_login_role` | security | warning | `rolcanlogin`, `rolbypassrls`, not a superuser, not `exponetdb_*` |
| `extension_in_public` | security | warning | extension in schema `public` |
| `plaintext_client_connections` | security | warning (info if only loopback) | client backends over TCP without TLS (`pg_stat_ssl`), whole cluster, counted; skipped `not_permitted` without `pg_read_all_stats` |
| `unindexed_foreign_key` | performance | info | no valid, non-partial index whose leading columns are the key's columns (any order); draft |
| `duplicate_index` | performance | warning | the duplicate rule of §1; draft |
| `unused_index` | performance | info | `idx_scan = 0`, valid, not unique, not primary, no constraint uses it, and the statistics count for at least 7 days; draft |
| `table_without_primary_key` | performance | info | ordinary or partitioned table (not a partition) without a primary key; draft |
| `multiple_permissive_policies` | performance | warning | more than one permissive policy for the same table, role (`PUBLIC` included) and command (`ALL` counts for each) |
| `xid_age_high` | operations | warning at 1.5 × `autovacuum_freeze_max_age`, critical at 1.5 billion | `age(datfrozenxid)` of the database, the oldest table as evidence |
| `inactive_replication_slot` | operations | warning | slot without consumer, retained WAL bytes on a primary |
| `wal_archive_failing` | operations | warning | `archive_mode` not off and `pg_stat_archiver` failed after the last success |
| `settings_pending_restart` | operations | info | `pg_settings.pending_restart` (names only, never values) |
| `drift_open` | change_safety | warning (critical with a critical drift finding) | open drift findings of the target (Control Store) |
| `staging_behind_production` | change_safety | warning | production target only: migrations of its ledger mirror (origin `exponetdb`, not reverted) that the evidence environment's mirror lacks; skipped `error` when either mirror is missing or divergent |

A rule whose read fails is **skipped** with its reason (`timeout` for a
statement timeout, `not_permitted` for a privilege error,
`version_unsupported` for a missing catalog object, `error` otherwise) and
its open findings stay as they are; it is never a pass. `unused_index` before
the statistics count 7 days is recorded as `stats_window_short` in
`advisor_runs.skipped` and answered as `error`, the contract having no closer
reason **[OPEN: contract]**. A run is one Control Store transaction:
`observation.advisor_runs` (who asked, the catalog version, the categories,
the skipped rules), one finding per rule and object
(`observation.subject_findings`, kind `advisor`, code the rule, deduplication
key `rule:object`, `securityRelevant` for the security category, evidence and
draft in `details`), and the open advisor findings of the rules that ran
completely and did not see them again resolved as `cleared`. At most 100
findings per rule and run; a cut rule clears nothing. A target that cannot be
read records a `failed` run with the code and the read's error is answered.
Each run is audited (`advisor.run`: run id, categories, counts; no catalog
text). No rule executes a fix.

**[OBSERVED]** Findings reads: `GET /findings` and
`GET /targets/{id}/findings` list `observation.findings` (drift, health)
and the targets' subject findings (advisor, statements) as one list, newest
first (descending finding id, ULIDs of one generator), with the `kind` and
`code` filters; `GET /findings/summary` (`finding.summary`) counts the open
ones over the targets the caller may read, by severity, kind and the 50 most
frequent codes; `GET /clusters/{id}/findings` (`cluster.finding.list`,
`backups.read`) lists the subject findings of a cluster. The fleet overview
and a target's `openFindingCount` count both tables.

## 5. Actions from diagnostics

| Action | Class | Notes |
|---|---|---|
| Cancel a query (`pg_cancel_backend`) | `low` (nonprod and prod), inline plan with precondition token (`pid`, `backend_start`, `query_start`) | preferred over terminate |
| Terminate a session | `standard` (nonprod) / `high` (prod, agents need approval) | binding `pid + backend_start`; the precondition re-checks the condition in the same statement that terminates (closing the gap REOSA's audit found) |
| Run `ANALYZE` on a table | `standard` | |
| Create a missing index | not a diagnostic action: becomes a **migration draft** (`CREATE INDEX CONCURRENTLY` bundle) | keeps schema changes in the ledger |
| Reset statistics | `standard`, recorded as a discontinuity | |

Replication and backup sessions are never terminable (policy
`connections.replication-protect`).

**[OBSERVED]** (Wave 9 Part B, `packages/diagnostics/src/connections.ts`,
`packages/postgres/src/session-conditions.ts`)

- `POST /targets/{t}/sessions/{pid}/cancel` (`connections.cancel`, an
  inline `low` plan) and `POST /targets/{t}/sessions/{pid}/terminate`
  (`connections.terminate.plan`, a stored plan of kind
  `connections.terminate`, `standard` on nonprod and `high` on prod, applied
  through `plan.apply`), both with `connections.operate` at the target's tier.
  REST only; no MCP tool offers them.
- **Planning** (serve, observer) reads the session by pid: backend type,
  role, application name, state, `backend_start`, `query_start` (UTC,
  milliseconds, the form the session list shows), whether it is in the
  target's database, the conditions and why it is protected. The plan binds
  target id and generation, pid and `backend_start`, for a cancel the
  `query_start`, for a terminate the condition; the session facts go into
  the content for the policy.
- **Protected sessions** (one SQL expression for planning, policy and the
  signaling statement): not a client backend (walsenders, autovacuum,
  background workers), `exponetdb_*` roles or `exponetdb/…` application
  names, superuser sessions (the login role is a superuser or a member of
  one, directly or through other roles, so `SET ROLE` would make it one:
  `pg_stat_activity` shows the login role only), backup tools by
  application name (pgBackRest, pg_basebackup, pg_dump, pg_dumpall,
  pg_restore, pg_probackup, barman, wal-g, pg_receivewal). **[DECIDED]**
  (review D-4, 2026-10-27) The application-name match is best effort: a
  backup tool that does not set its name is not recognized, and a client
  that names itself like one is protected. Policy: `connections.replication-protect` (deny,
  break-glass) for non-client and backup sessions,
  `connections.no-superuser-terminate` (deny, not overridable) for
  superuser and ExponetDB sessions; `connections.prod-terminate-approval`
  (require one approval) for a production termination planned by an agent
  (anything but a person through the Web App or the first-party CLI; an
  unknown tier counts as production). A denied cancel is `POLICY_DENIED`; a
  denied termination plan is stored as `denied`.
- **Who signals.** Only `exponetdb_operator` holds `pg_signal_backend`; the
  worker opens it with the identity marker checked (C-27). A cluster without
  an active operator credential cannot be signaled: planning is refused with
  `TARGET_CREDENTIAL_INVALID` (fail closed), and so is an execution whose
  credential went away.
- **Bindings** are read again at acceptance and before the worker starts:
  another backend at the pid (`session`), another query or no longer active
  (`query`, cancel), the condition no longer holds (`condition`, terminate),
  protected now (`session`) are `PLAN_STALE`.
- **Execution** is one statement that re-checks pid, `backend_start`, the
  database, client backend and not protected, and the query start and
  `state = active` (cancel) or the condition (terminate) in its `WHERE`, and
  calls `pg_cancel_backend` / `pg_terminate_backend` only on a row it found.
  A signaled row is `applied`; no row is `not_applied` with `PLAN_STALE` and
  `outcome: not_matched` (gone, pid reused, another query, condition gone),
  never a success. A privilege error is `PERMISSION_DENIED`; an error during
  the statement is an unknown outcome. The kind audits `connections.cancel`
  / `connections.terminate` with pid, backend start, condition and outcome.
- **Conditions** of a termination, as in the contract: `stalled` (the
  `stalled_sessions` predicate of health.md §3, the same function),
  `idle_in_transaction` (state age ≥ 60 s), `long_running` (active, query
  age ≥ 300 s), `any`.
- **Verification** reads the session for up to 3 seconds: a cancel passed
  when the backend no longer runs that query (gone, not active, or another
  `query_start`), a termination when the backend with that pid and start is
  gone; still there is `failed`, unreadable is `error`. After a lost worker,
  reconciliation says `not_applied` when nothing changed and `unknown`
  otherwise (the change cannot be attributed).

## 6. Performance of ExponetDB's own diagnostics

**[OBSERVED]** (Wave 9 Part B, `packages/diagnostics/src/live.ts`) The
statement sampler, the table statistics, the advisors and the session reads
of cancel and terminate open an identity-checked observer session and set
`statement_timeout = 5000ms` and `lock_timeout = 1000ms` on it before any
read; the operator session of a signal gets the same limits.

- Diagnostic queries carry `statement_timeout` (default 5 s) and
  `lock_timeout` 1 s, run on the diagnostic connection, and avoid functions that
  take heavy locks.
- Expensive collections (bloat estimates, index duplication, sizes of all
  relations) run at most hourly and on demand with rate limits.
- Every collection records its own duration; a collection that regularly takes
  more than half its timeout raises a self-observability warning.
