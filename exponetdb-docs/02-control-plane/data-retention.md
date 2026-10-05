# Data retention

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 audit retention mechanism (§2) awaiting G2 |
| Applies to | Wave 2 (mechanism), each wave that adds a data class |
| Read before | [`control-database.md`](./control-database.md), [`audit.md`](./audit.md) |

Nothing in the Control Store grows without a rule. Each data class has a
retention period with a reason; periods are configurable per installation within
the stated bounds. High-volume classes are partitioned by time and pruned by
dropping partitions (cheap, no bloat).

## 1. Rules

**[DECIDED]** Defaults:

| Data class | Retention | Reason | Bounds |
|---|---|---|---|
| Health samples, raw (every 15 s per target; node metrics with every heartbeat, every 15 s) | 14 days | Incident investigations look at hours to days; two weeks allow "same time last week" comparisons | 3-60 days |
| Health rollups (5-minute min/avg/max) | 400 days | Capacity planning and yearly comparisons with a margin | 90 days-5 years |
| Statement statistics samples (deltas of `pg_stat_statements` every 5 min, top 200 by total time) | 30 days | Regressions after deploys surface within weeks | 7-90 days |
| Statement statistics daily aggregates | 400 days | Trend per query fingerprint | 90 days-5 years |
| Node heartbeats | latest only; state transitions 400 days | Only changes are interesting historically | |
| Findings | open: until resolved; resolved: 400 days | Recurrence analysis | |
| Plans: denied, expired, withdrawn, invalidated | 90 days | Explaining recent refusals to humans and agents | 30-400 days |
| Plans: consumed | as long as their operation | A consumed plan is the evidence of what ran | |
| Operations that changed a target (any `applyOutcome` other than `not_applied`/`not_started`) | permanent | Linked from target ledgers | |
| Operations without effect (failed early, canceled) | 400 days | Debugging and pattern detection | 90 days-permanent |
| Job and operation event detail (progress lines, captured notices) | 90 days; summaries permanent | Detail is for debugging the recent past | |
| Migration bundles referenced by any plan or ledger | permanent | Content of applied history | |
| Migration bundles ingested but never planned | 90 days | Drafts | |
| Schema documents referenced by a ledger row, plan, evidence or restore | permanent | Needed for diffs of history | |
| Schema documents from periodic drift checks | 90 days (unless referenced) | Recent drift investigation | |
| Backup metadata | while the backup exists + 400 days | Reconstruct restore history | |
| Restore and drill records | permanent | Evidence of recoverability | |
| Audit events | **permanent by default**; never less than 400 days | Low volume; covers production data changes; final period decided in [OD-8](../00-product/open-decisions.md#od-8-audit-retention-and-personal-data) | 400 days-permanent |
| Idempotency keys | 24 h | Retry window | |
| OAuth authorization codes | 10 min after issue (codes are valid 60 s and single use; the record is kept briefly for replay detection) | RFC 6749 recommends short lifetimes | |
| OAuth access token records | until expiry + 1 day | Revocation checks and debugging | |
| OAuth refresh token records | until expiry or revocation + 30 days | Reuse detection after rotation | |
| Web sessions | until expiry + 30 days | Security investigations | |
| `data.read` result rows | **never stored** | C-1 | |
| ExponetDB's own logs | 30 days (log store) | Operational debugging; must not become a data store | 7-90 days |

## 2. Mechanism

- Partitioned tables: daily partitions for raw samples, monthly for rollups and
  audit; a maintenance job (worker, background lane) creates future partitions
  and drops expired ones.
- Non-partitioned classes: batched deletes by primary key ranges, at most 10,000
  rows per transaction, in the background lane.
- Audit partitions are dropped only after a covering checkpoint was exported
  ([`audit.md` §4.6](./audit.md#46-retention-purge)).
- Every retention run writes a summary event (`retention.pruned` with class,
  range and counts) to the audit log.

**[DECIDED]** (Wave 2) Audit retention is the setting `retention.audit` in
`control.settings`: the JSON string `"permanent"` (the default when the
setting is absent) or a whole number of days from 400 to 36,500. Any other
value is invalid and nothing is pruned (fail closed). Until a planned settings
operation exists (Wave 3A or later), the default applies. The purge is the
one-shot command `exponetdb audit prune` under the `exdb_audit_maint` login,
so no long-running process holds the right to drop audit partitions; each
dropped partition and its `retention.pruned` event commit in one transaction,
and a run ends with a `retention` checkpoint that the worker exports. The
worker creates future partitions (`audit.ensure_partitions`). Short periods
appear only in integration tests.

## 3. Consumers' data

ExponetDB does not store application rows of managed databases. Data that
ExponetDB handles transiently (query results, redacted statements in samples,
EXPLAIN plans) follows the redaction rules before it is stored, and statement
samples contain only normalized statements.
