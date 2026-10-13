# Data retention

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 audit retention mechanism (§2) accepted with G2 on 2026-10-05; the Wave 7 data classes (MCP, data-read lane, grant last use) added on 2026-10-13, G7 not yet accepted ([G7 record](../14-roadmap/gates/7.md)) |
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
| OAuth authorization requests, codes and device codes (Wave 3B) | ended + 1 day, then pruned every 15 minutes by the worker (`oauth.prune`; the database refuses deletion earlier). **[DECIDED]** a day instead of the planned 10 minutes: a replayed code within that day is recognized and revokes its grant | Codes live 60 s, requests and device codes 10 min; replay detection needs the record | |
| OAuth access token records (Wave 3B) | expiry + 1 day, pruned by `oauth.prune` | Revocation checks and debugging; tokens are stored as hashes only | |
| OAuth refresh token records (Wave 3B) | until the grant ended (expiry or revocation) + 30 days; the database refuses earlier deletion, `oauth.prune` removes them a day later | Reuse detection after rotation | |
| OAuth grants, clients ever approved, service accounts, API key records (Wave 3B) | permanent (never deleted; state changes only) | Who could act on whose behalf is security history | |
| `private_key_jwt` assertion ids (Wave 3B) | expiry + 2 hours, pruned by `oauth.prune` | Replay detection lasts while the assertion is valid (at most 5 minutes) | |
| DCR registrations never approved (Wave 3B) | 8 days after the last change (a pending registration expires 7 days after it was made), pruned by `oauth.prune` | Bounded storage under registration flooding; approved clients are never removed | |
| OAuth rate-limit buckets (Wave 3B) | 1 day after the last change, pruned by `oauth.prune` | Windows last at most an hour; buckets are HMAC values, never addresses | |
| Web sessions | until expiry + 30 days | Security investigations | |
| Authentication ceremony challenges (Wave 3A) | ended + 2 days, then pruned hourly by the worker (`auth.prune`; the database refuses deletion before a day) | Only replay detection needs them; they carry no secret | |
| Rate-limit buckets (Wave 3A) | 1 day after the last change, then pruned by `auth.prune` | Windows and locks last 15 minutes; buckets are HMAC values, never addresses | |
| MCP rate-limit buckets and concurrency counters (Wave 7) | **never stored**: they live in the memory of `serve`; a restart resets them; a bucket idle for ten minutes is dropped. **[OBSERVED]** 2026-10-13, `apps/server/src/interfaces/mcp/rate-limit.ts` | A bucket is a counter, not a record; a durable limiter would need a table that grows with every grant | |
| MCP `requestState` and list cursors (Wave 7) | **never stored**: each is sealed (AES-256-GCM, installation keys `mcp.request_state_key` and `mcp.cursor_key`) and held only by the client; a `requestState` opens for ten minutes, a cursor for one hour. **[OBSERVED]** 2026-10-13, `apps/server/src/interfaces/mcp/request-state.ts`, `cursor.ts` | The server keeps no per-conversation state (stateless eras, [`../05-mcp/architecture.md`](../05-mcp/architecture.md)); the seal binds the state to its principal, so a store is not needed | |
| `data.read` result rows | **never stored** in the Control Store. **[OBSERVED]** 2026-10-13: while a read runs, the lane row `dataread.reads` holds the request and the result as ciphertext only (HPKE to the worker and to a per-read reply key); `serve` deletes the row as soon as it has the result, and the worker deletes any row 30 seconds after its deadline (a deadline is at most five minutes after the row was made); the worker's key lives in memory only, and a registration (`dataread.workers`) without a heartbeat for ten minutes is deleted. `packages/diagnostics/src/data-read/lane.ts`, bundle `data-read-lane` | C-1; the lane is a transport, not a store | |
| Last use of a grant (Wave 7) | one row per grant (`oauth.grant_last_use`): the minute and the use class (`read`, `plan`, `apply`, `data`, `rest`), written at most once a minute and overwritten, never a log of requests; the row lives as long as its grant (grants are never deleted). **[DECIDED]** Wave 7 order decision 10; **[OBSERVED]** 2026-10-13, bundle `grant-last-use`, `packages/auth/src/oauth/usage.ts` | The data basis of "last used" (Wave 8) and standing-access findings (Wave 9); never an input to a decision | |
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
