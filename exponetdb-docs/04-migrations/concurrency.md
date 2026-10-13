# Concurrency: one schema change per target

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 7 note on MCP in §6 (2026-10-13, G7 not yet accepted) |
| Applies to | Wave 6 (and every later operation that runs DDL on a target) |
| Read before | [`planning-and-apply.md`](./planning-and-apply.md) |
| Sources | PostgreSQL 17 docs: explicit locking §13.3.5 (https://www.postgresql.org/docs/17/explicit-locking.html), admin functions §9.28.10, `pg_locks` view; behavior re-verified on PostgreSQL 16.14 during the 2026-10-04 standards research |

Collision-free ids solve *authoring* concurrency. They do nothing for *runtime*
concurrency: two agents can still try to change the same database at the same
moment. **[DECIDED]** ExponetDB serializes schema changes per target with two
independent mechanisms, and both must be held
([C-18](../00-product/constitution.md#c-18-one-schema-change-per-target-at-a-time)).

| Mechanism | Where | Protects against |
|---|---|---|
| **Operation lease** on exclusivity domain `target:<id>:schema` | Control Store (`operation_locks` row with holder and expiry) | Two operations of this installation being *scheduled* concurrently; gives visibility ("waiting for op_…") |
| **Advisory lock** on the target's schema-lock key | Inside the target database | Two *executors* actually running: a paused worker whose lease expired, a second control-plane instance, a misconfigured second installation, a cooperating external tool |

The Control Store lease alone is not enough: leases expire, and a worker that
was paused (GC pause, network partition) past its lease can resume and keep
executing while another worker has taken the lease. The advisory lock is held by
the executing database session itself, so the second executor cannot get it
until the first session is gone. This is the fencing mechanism.

## 1. Facts this design relies on

**[OBSERVED]** (PostgreSQL 17 documentation, behavior re-verified on 16.14 in
the standards research of 2026-10-04):

- Advisory locks live in the regular lock manager and are **per database**: the
  same key in two databases never conflicts.
- Two key forms exist: one `bigint`, or two `int4`. In `pg_locks` the int4-pair
  form shows `objsubid = 2`, the bigint form `objsubid = 1`, so the forms never
  collide with each other.
- **Session-level** locks (`pg_advisory_lock`, `pg_try_advisory_lock`) are held
  until explicitly released or until the session ends, and are **not** released
  by `ROLLBACK`. They are re-entrant (each acquisition needs one release).
  `pg_advisory_unlock_all()` runs implicitly at session end, including on
  ungraceful disconnect, once the server notices the disconnect.
- **Transaction-level** locks (`pg_advisory_xact_lock`) are released at commit or
  rollback and cannot be released earlier.
- A session-level and a transaction-level request on the same key conflict.
- A half-open TCP connection may not be noticed by the server until keepalives
  fire; `client_connection_check_interval` only helps while a query runs.
- Transaction-mode connection poolers (PgBouncer, Supavisor) do not support
  session-level advisory locks.

## 2. Lock scope and key derivation

**[DECIDED]**

- Form: int4 pair `(key1, key2)`.
- `key1 = 1163412546` (`0x45584442`, ASCII `EXDB`): the ExponetDB namespace.
  Fixed forever.
- `key2 = int4( first 4 bytes, big-endian, of SHA-256("exponetdb/lock/v1/" + lockClass + "/" + targetId) )`.
- Lock classes:

| Class | Taken by | Conflicts with |
|---|---|---|
| `schema` | `migration.apply`, `migration.rollback`, `migration.baseline`, `ledger.initialize`, `ledger.reconcile`, any DDL operation | `schema`, `maintenance` |
| `maintenance` | restore into this database, placement switch, decommission | everything |

**[DECIDED]** (Wave 6) Two different keys do not exclude each other by
themselves, so each class is built from both keys, always taken in the
same order (maintenance, then schema), which also excludes a deadlock
between two takers (`takeTargetLock` in `packages/postgres/src/ledger.ts`):

| Class | Maintenance key | Schema key |
|---|---|---|
| `schema` | shared (`pg_try_advisory_lock_shared`) | exclusive |
| `maintenance` | exclusive | not taken |

Two schema holders exclude each other on the schema key; a maintenance
holder waits for every schema holder (each holds the maintenance key
shared) and every schema taker waits for it; two maintenance holders
exclude each other. A refused attempt releases what it took before it
waits. The conflicts are proven by real acquisition on PostgreSQL 16, 17
and 18 (`packages/postgres/test/verify-locks.int.test.ts`).

Because locks are per database and a V1 target is a whole database, including
`targetId` in `key2` is not needed for correctness today. It is included so that
a future schema-level target model (several targets in one database) needs no
new key scheme. A 32-bit collision between two classes or targets *in the same
database* would only cause unnecessary serialization, never a missed exclusion.

**[DECIDED]** The key derivation is published (this document, and the CLI command
`exponetdb lock-key <target>`). Tools outside ExponetDB that change a managed
target's schema in an emergency can cooperate by taking the same lock. ExponetDB
cannot force them to.

## 3. Acquisition

**[DECIDED]** Session-level lock on the migrator's dedicated connection, acquired
before the bindings are re-checked and held until the operation's last
verification is written:

```
deadline = now + acquireTimeout          (default 30 s; per-plan override up to 10 min)
loop:
  if SELECT pg_try_advisory_lock(1163412546, key2): break
  if now > deadline: fail MIGRATION_LOCK_TIMEOUT (nothing applied)
  identify holder (§5) and record it on the operation as waitingFor
  sleep(backoff: 250 ms doubling to 5 s, with jitter)
```

Why `try` in a loop instead of a blocking `pg_advisory_lock` with
`lock_timeout`: the loop gives a deterministic, observable wait (the operation
shows who holds the lock while waiting) and does not depend on how
`lock_timeout` interacts with advisory-lock waits.

Why session-level and not transaction-level: a migration operation spans
several transactions (one per migration, the ledger write, verification) and,
for non-transactional bundles, autocommit statements. Only a session-level lock
covers all of that. Transaction-level advisory locks remain the right tool for
short critical sections inside one transaction (for example inside the Control
Store), and ExponetDB uses them there.

## 4. Release and crash behavior

**[DECIDED]**

| Situation | What happens |
|---|---|
| Normal end | `SELECT pg_advisory_unlock(1163412546, key2)`; result `false` is logged as an engine bug (lock was not held). Then the connection is closed. |
| Error inside a migration transaction | Transaction rolls back; the **session** lock is still held (by design) until the operation finishes its failure handling. |
| Worker process dies | The TCP connection breaks; with keepalives (idle 30 s, interval 10 s, count 3) and `tcp_user_timeout` the server notices within about a minute, ends the session, rolls back any open transaction and releases the lock. **[DECIDED]** (Wave 6) The keepalives are startup options of every migrator session; `tcp_user_timeout` (60 s) and `client_connection_check_interval` (10 s, effective only while a statement runs) are set after connecting and kept only where the server's platform supports them (it refuses a non-zero value elsewhere); the session reports what the server then shows (`TargetSession.disconnectDetection`), never a requested value. Without `tcp_user_timeout` the remaining window is the keepalive one: idle 30 s + 3 × 10 s, about 60 s after the last traffic; a statement that keeps sending data can take until its `statement_timeout`. |
| Network partition between worker and target | Same as above from the server's view. The worker, when it regains connectivity, finds its session gone and enters reconciliation; it never assumes it still holds the lock. |
| Target restarts | All sessions end; locks are gone; operations in flight reconcile. |
| Lock held by a stuck ExponetDB session (bug) | Visible in the target lock view. A human with permission `operations.recover` runs `operation.force_release(op_…)` (Web App or CLI, re-authentication): a `high` operation, at the tier of the owning operation, that terminates that exact backend (pid + backend_start), marks the owning operation `needs_reconciliation`, and audits. |

**[DECIDED]** The migrator connection must be a **direct** connection to the
cluster (endpoint kind `private`, `public` or `local_socket`), never a pooler
endpoint. The registry refuses to select a pooler endpoint for the migrator role.

## 5. Visibility

The lock holder is identifiable without a registry of keys:

```sql
SELECT a.pid, a.application_name, a.backend_start, a.state, a.xact_start
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory' AND l.classid = 1163412546 AND l.objsubid = 2
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND l.granted;
```

`application_name = 'exponetdb/op_<id>'` names the operation. The Web App's
target lock view and the `locks_list` MCP tool show ExponetDB advisory locks as
"ExponetDB schema lock held by op_…" rather than as anonymous advisory locks.

## 6. Migrations versus other DDL

**[DECIDED]**

- Every ExponetDB operation that issues DDL on a target takes the `schema` lock,
  including Web App actions such as "create index" (which are themselves
  migrations or migration-like operations, see
  [`../11-ui/information-architecture.md`](../11-ui/information-architecture.md)).
- Operations that do not change structure (cancel/terminate, `ANALYZE`,
  `VACUUM` without `FULL`, `REFRESH MATERIALIZED VIEW CONCURRENTLY`) do not take
  the schema lock. They take nothing or their own domain.
- **[OBSERVED]** (2026-10-13, Wave 7; G7 not yet accepted) The MCP tools change
  none of these rules. `plan_apply` is accepted by the same use case as the
  REST route and the worker takes the same Control Store domain and advisory
  lock, so an agent's apply waits for, or is refused by, the lock like any
  other (`MIGRATION_LOCK_TIMEOUT`, `waitingFor`). `operation_get` with
  `waitSeconds` only observes. An agent's data read (`sql_query`,
  `sql_explain`) runs in a read-only transaction under the `exponetdb_reader`
  role, takes no schema lock and no advisory lock, and the read allowlist
  refuses `pg_advisory_lock` and the like
  (`packages/postgres/src/parser/allowlist.ts`). `locks_list` shows the lock
  graph of a target to MCP clients (§5).
- DDL performed outside ExponetDB is not serialized by ExponetDB. It is detected
  afterwards: the next plan or the periodic drift check sees a fingerprint that
  no ledger entry explains ([`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md)).

## 7. Different targets and databases

- Different databases (for example `reosa_staging` and `reosa_production` on the
  same cluster) never block each other: locks are per database.
- Cluster-level operations (restart, config, roles) are serialized by the
  Control Store domain `cluster:<id>:config`, not by a target advisory lock,
  because they affect all databases of the cluster. A cluster restart also takes
  the `schema` domain of every target on the cluster so that it cannot interrupt
  a running migration ([`../02-control-plane/operations-engine.md` §7](../02-control-plane/operations-engine.md#7-exclusivity-domains)).

## 8. Tests

- Two workers race for the same target: exactly one acquires; the other reports
  `waitingFor` and times out or proceeds after release.
- Kill the holding worker (SIGKILL, network drop via proxy): the lock is released
  within the keepalive window; the waiting operation proceeds; the killed
  operation reconciles correctly.
- Paused worker past lease expiry: second worker cannot execute (advisory lock
  held); after the paused worker resumes, it detects lease loss and stops before
  starting a new migration.
- Pooler endpoint configured for migrator: refused by registry.
- Key derivation golden vectors.
