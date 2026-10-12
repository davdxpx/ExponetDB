# ADR-0028: Data reads run in the worker through a sealed lane; `dataRead` is a policy rule per target

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 7 order (§20, OD-13 option a); part of the G7 evidence the owner accepts or rejects with G7 |
| Date | 2026-10-12 |
| Related | [ADR-0019](./0019-process-roles-and-web-app.md) (process roles: `serve` holds no target credential), [ADR-0021](./0021-libpg-query-parser.md) (parser admission), [ADR-0024](./0024-node-trust-model.md) (HPKE in the kernel); [`../../03-database-model/sql-execution-security.md`](../../03-database-model/sql-execution-security.md) §2, §3, §5; [`../../02-control-plane/policy-engine.md`](../../02-control-plane/policy-engine.md); OD-13 |

## Context

`sql_query`, `sql_explain` and the REST routes `runQuery`, `explainQuery`
are the only place where an agent receives rows of a managed database.
Wave 4 built the pieces (`admitRead`, relation and user-code checks,
`redactStatement`, `TargetSession.readOnly()`, `readCursor`, `cancel()`,
the role `exponetdb_reader` with `pg_read_all_data` and `BYPASSRLS`) but no
caller. The reader credential is a worker secret: `serve` decrypts observer
secrets only, and that stays (ADR-0019, red line 5). The request arrives at
`serve`; the rows must come from the worker; nothing of the rows may land
in the Control Store, the audit, logs, metrics or traces. OD-13 (a)
requires a per-target setting with `humans_only` as the production
default, and the documents disagreed on whether it is a policy default or
a target field (Annex B d17).

## Decision

### 1. The lane

A small queue in the Control Store (additive Wave 7 bundle, table
`ops.data_reads`), with every payload sealed so the Control Store only
ever holds ciphertext for the waiting time:

1. Each worker process creates an X25519 key pair at start, keeps the
   private key in memory only, and registers the public key with its
   worker id and a heartbeat (`ops.data_read_workers`). A restart is a new
   key; nothing is stored that a backup could open later.
2. `serve` authorizes the request (engine, the `data.read` rule below),
   admits the statement with `admitRead` (parser, one statement, the
   allowlists), creates an X25519 key pair **for this one query** in
   memory, and inserts a row: query id (`qry_`), target, caller class
   (agent or human), the caps, the identity, client and grant, the
   chosen live worker, a deadline, the request id, and the statement and
   parameters **sealed with HPKE** (kernel `hpkeSeal`, RFC 9180 base mode,
   X25519/HKDF-SHA256/AES-256-GCM) to that worker's public key, with the
   query's own public key inside the sealed request. The associated data
   binds the query id, the target and the worker id.
3. The worker is woken by `NOTIFY` (and polls as a fallback), claims the
   rows addressed to it (`FOR UPDATE SKIP LOCKED`, a lease), opens the
   request, runs the target-side checks (relation kinds, user code, cost
   check where configured) and executes on a **fresh session per query**
   as `exponetdb_reader`: `BEGIN ISOLATION LEVEL REPEATABLE READ READ
   ONLY`, `SET LOCAL statement_timeout`, `lock_timeout`,
   `idle_in_transaction_session_timeout` (and `transaction_timeout` on
   PostgreSQL 17 and 18), `application_name = 'exponetdb/query/<request
   id>'`, a cursor, `FETCH FORWARD <cap + 1>`, `ROLLBACK`, close. The
   result (typed values, truncation, RLS annotation, masked columns,
   duration) is sealed with HPKE to the query's public key and written to
   the row; the worker never logs a value.
4. `serve` waits (woken by `NOTIFY`, polling as fallback) up to the
   deadline, opens the result with the private key it alone holds, and
   deletes the row. The worker's cleanup job deletes every row past its
   deadline; a row never outlives the request by more than one cleanup
   interval.

So rows exist in the Control Store only as ciphertext that no stored key
opens, for at most the waiting time; the private key of the result dies
with the request.

### 2. Bounds, cancel, failure

- Concurrency: at most 2 data reads per grant, 3 per target, 8 per
  installation (owner decision 9); the worker's connection budget is 5 per
  cluster, so migrations and observation never starve. Over a bound the
  call is refused at once (`RATE_LIMITED` with `Retry-After`), never
  queued without limit.
- Cancel: a closed stream, the deadline or `sql_cancel(queryId)` marks the
  row; the worker cancels exactly its own backend of that query
  (`pg_cancel_backend` on the pid and backend start it holds), never
  another. `sql_cancel` is authorized like the query (same identity,
  client and grant, and `data.read` at the target's tier).
- Failure: no live worker, an expired deadline or a lost lease is a
  visible error (`CAPABILITY_UNAVAILABLE` or `QUERY_TIMEOUT`), never an
  empty result (C-28).

### 3. `dataRead` is the setting of the policy rule `data.read`

A new rule `data.read` in the policy catalog, evaluated by the query use
case for `query.run` and `query.explain` with the fact "the caller is an
agent". Its setting lives in `policy.rule_settings` like every rule
setting (scope chain installation → product → project → environment →
target; no change to the frozen registry bundle). Parameter `mode`:
`by_tier` (default: `humans_only` on production targets, `enabled` on
nonprod), `enabled`, `humans_only`, `disabled`. An administrator changes
it per target with a policy settings plan. On `humans_only` an agent gets
`DATA_READ_NOT_PERMITTED` whatever its scopes (`data.read:prod`
included); on `disabled` nobody reads rows. **Agent** is every caller that
is not a person through the Web App or the first-party CLI: client kind
`mcp`, service accounts, API keys, CI (OD-13).

### 4. Caps by caller class

| | Agent | Human |
|---|---|---|
| Rows | 500 (default 100 for `sql_query`) | 5 000 |
| Bytes of a result | 5 MiB | 5 MiB |
| Statement timeout | 60 s | 60 s (the documented maximum) |
| `EXPLAIN ANALYZE` | refused (`QUERY_NOT_READ_ONLY`) | only for an admitted read, inside the rolled-back read-only transaction |

Over a cap the call returns the capped rows with `truncated: true` and the
reason; `QUERY_RESULT_TOO_LARGE` is used only when not even one row fits
the byte cap.

### 5. Audit, never values

Each data read writes one audit event `data.read` in the request's
transaction before the result is returned: actor, client and grant,
target, the normalized statement (constants replaced, `redactStatement`),
the statement digest, row count, truncation, duration, masked columns.
If the audit cannot be written, no result is returned (data reads stop
with mutations).

## Rejected options

- **`serve` executes with the reader credential**: breaks ADR-0019 and red
  line 5.
- **An HTTP channel from `serve` to the worker**: a new network surface,
  mutual authentication and a second protocol to secure; the Control
  Store already connects both, and the queue keeps the operations
  engine's leasing and fencing patterns.
- **Plaintext request and result rows deleted after pickup**: values
  would sit in tables, WAL and backups.
- **A target field `dataRead` in the registry**: needs a change of a
  frozen bundle's table and a second settings mechanism; the policy
  settings already scope to targets and are audited plans.

## Consequences

- One additive bundle (lane tables, worker key registry, the
  `mcp.request_state_key` purpose of ADR-0027, the last-use field per
  grant), with `PUBLIC` revoked and a verify step; frozen bundles stay
  unchanged.
- The executor for untrusted reads lives in a package that may use
  `packages/postgres` (not `packages/application`, which the boundaries
  forbid); the use case lives in `packages/application`.
- The tests run on PostgreSQL 16, 17 and 18, including every escape case
  of `sql-execution-security.md` §5 and the published incidents
  (`COMMIT;` plus a second statement, a leaking `statement_timeout`).
