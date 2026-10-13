# Diagnostics and performance

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (read-only diagnostics), Wave 9 (sessions actions, advisors) |
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

## 3. EXPLAIN

`EXPLAIN` and `EXPLAIN ANALYZE` follow
[`../03-database-model/sql-execution-security.md` §3](../03-database-model/sql-execution-security.md#3-explain).
For statements from `pg_stat_statements`, ExponetDB offers `EXPLAIN (GENERIC_PLAN)`
on PostgreSQL 16+ (planning with parameters, no guessed literals). The plan
visualizer is adapted from the Supabase reference
([`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md)).

## 4. Advisors

**[DECIDED]** shape, **[PLANNED]** catalog content (Wave 9).

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

## 6. Performance of ExponetDB's own diagnostics

- Diagnostic queries carry `statement_timeout` (default 5 s) and
  `lock_timeout` 1 s, run on the diagnostic connection, and avoid functions that
  take heavy locks.
- Expensive collections (bloat estimates, index duplication, sizes of all
  relations) run at most hourly and on demand with rate limits.
- Every collection records its own duration; a collection that regularly takes
  more than half its timeout raises a self-observability warning.
