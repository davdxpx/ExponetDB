# Planning and applying migrations

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 6 |
| Read before | [`README.md`](./README.md), [`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md), [`migration-bundles.md`](./migration-bundles.md), [`dependency-graph.md`](./dependency-graph.md) |
| Related | [`analysis.md`](./analysis.md), [`concurrency.md`](./concurrency.md), [`verification.md`](./verification.md), [`staging-production-policy.md`](./staging-production-policy.md) |

`migration.apply` is an operation kind of the Operations Engine. This document
specifies its plan content, its bindings and its execution algorithm.

## 1. The two calls

```
migration_plan(target, bundles | migrationIds, source?)  ──▶  plan (pln_…, planHash, analysis, evidence, decision)
plan_apply(planId)                                   ──▶  operation (op_…) → applied/verified/failed
```

**[DECIDED]** The plan is the *only* input to apply. `plan_apply` takes a plan
id and nothing else that could change what runs
([C-8](../00-product/constitution.md#c-8-only-the-reviewed-content-is-executed)).
Bundles enter ExponetDB in the plan call (submitted bytes) or are referenced by id
from the bundle store (previously ingested, for example from staging); either way
the plan stores the exact bytes it will execute.

## 2. Plan content

**[DECIDED]** The plan body for `migration.apply` (in addition to the generic
fields in [`operations-engine.md` §3.1](../02-control-plane/operations-engine.md#31-content)).
Fields marked *(cond.)* appear only when relevant; the plan is not padded.

```yaml
content:
  migrations:                            # in execution order (topological, see dependency-graph.md)
    - id: 01JB2Z6G8M4Q7R9T1V3W5X7Y9Z
      name: add-lead-index
      checksum: sha256:c1:…              # apply checksum
      verifyDigest: sha256:…
      rollbackDigest: sha256:… | null
      sourceDigest: sha256:…
      manifest: { … }                    # hashed execution fields, defaults materialized
      dependsOn: [ … ]
      source:                            # see authoring-and-ci.md
        repository: github.com/davdxpx/REOSA
        commit: 3f9c…  (40 hex)
        path: packages/db/exponetdb/migrations/01JB…_add-lead-index
        provenance: claimed | verified
      bundleRef: bundle store key        # exact bytes of up.sql / verify.sql / down.sql
  execution:
    mode: transactional | nontransactional
    sessionSettings: { … }               # see §5, materialized
    stopOnVerificationFailure: true

target:
  targetId: tgt_…
  path: reosa/platform/production
  tier: prod
  generation: 3
  clusterSystemIdentifier: "7291…"
  serverVersionNum: 170011
  managedScope: { includeSchemas: [...], excludeSchemas: [...] }

expectedState:                           # bindings, re-checked at apply and under lock
  schemaFingerprint: fp1:17:…
  ledgerStateHash: sha256:ls1:…
  extensions: { vector: "0.8.1", pg_trgm: "1.6" }

analysis:                                # see analysis.md
  perMigration:
    - id: 01JB…
      statements:
        - index: 0
          kind: CREATE INDEX CONCURRENTLY
          objects: [ { kind: index, name: public.leads_inbox_idx, action: create } ]
          lock: { mode: SHARE UPDATE EXCLUSIVE, on: public.leads, severity: low }
          rewrite: none
          transactionalSafe: false
      compatibility: { declared: additive, observed: additive, agreement: true }
      destructive: []
      rewriteRisk: { tables: [] }                                   # (cond.) with sizes when non-empty
      lockSeverity: low                                             # max over statements
      rollback: { available: true, declaredSafety: safe }
      conditionalDdl: false                                         # DO blocks branching on catalog state
      lint: [ { rule: …, level: warn, message: … } ]
      structuralExpectations: 4                                     # count; details in verification.md
      underivedStatements: 0
  summary:
    compatibility: additive
    lockSeverity: low
    destructive: false
    estimatedImpact: "Builds one index concurrently on public.leads (~1.2 GB, ~4.1 M rows)."

evidence:                                # (cond.) required for prod tier, see staging-production-policy.md
  - kind: staging_verified
    migrationId: 01JB…
    checksum: sha256:c1:…                # must equal content
    verifyDigest: sha256:…               # must equal content
    targetId: tgt_… (reosa/platform/staging)
    appliedAt: …
    verifiedAt: …
    verificationId: …
    fingerprintBefore: fp1:17:…
    fingerprintAfter: fp1:17:…
    lineage: { productionFingerprintMatchesStagingBefore: true | false | unknown }

requirements:                            # from policy
  approvals: 1
  reauthWithinSeconds: 300
  backupNewerThan: PT24H                 # (cond.)
```

### Fields considered and deliberately left out

| Candidate | Decision | Reason |
|---|---|---|
| Predicted duration | Not a field. A rewrite-risk entry may carry a size-based estimate labeled as estimate. | Duration depends on load, I/O and locks; a number would read as a promise (C-30). |
| "Online safe: yes/no" | Not a field. | Derived from lock severity and compatibility; a separate boolean invites contradiction. |
| Retry semantics | In the operation kind, not per plan. | Uniform: lock-timeout failures are retryable by re-planning; nothing else is retried automatically. |
| Required maintenance window | As a policy requirement, not plan analysis. | Windows are policy, not a property of SQL. |
| Engine version | Generic plan field (`kindVersion` + server build). | Same for all kinds. |
| Full statement text in analysis | Not duplicated. | The bundle bytes are in `content`; analysis references statement indexes. |

## 3. Planning algorithm

**[DECIDED]**

1. **Resolve** the target (path → `tgt_`), its placement, cluster, endpoint and
   observer credential. Refuse if the target is `suspended`.
2. **Ingest** submitted bundles: validate layout and manifest, compute digests,
   store bytes content-addressed. Reject `MIGRATION_CHECKSUM_MISMATCH` cases
   immediately ([`migration-bundles.md` §3](./migration-bundles.md#what-a-mismatch-means)).
3. **Inspect** the target with the observer role over a fresh connection:
   identity marker, `system_identifier`, server version, extensions, ledger rows
   and ledger state hash, schema fingerprint of the managed scope, relation sizes
   needed by analysis.
4. **Order**: compute the pending set and the topological order
   ([`dependency-graph.md` §4](./dependency-graph.md#4-ordering)).
5. **Analyze** each statement ([`analysis.md`](./analysis.md)) and run the linter.
6. **Collect evidence** for prod-tier targets
   ([`staging-production-policy.md`](./staging-production-policy.md)).
7. **Authorize**: RBAC + scope (`migrations.plan`), then the Policy Engine.
8. **Store** the plan (always, even if denied) and return it.

Planning never takes a lock on the target and never writes to it. Planning is
cheap enough to repeat; re-planning is the answer to every staleness.

## 4. Apply algorithm

### 4.1 Acceptance (synchronous, in the API call)

1. Authenticate; verify plan exists, `state = active`, not expired; caller is the
   plan's actor and client.
2. Re-check authorization for `migrations.apply:<tier>` and grant restrictions.
3. **Fast staleness check**: read ledger state hash and fingerprint with the
   observer role. If either differs from `expectedState`, invalidate the plan
   and return `PLAN_STALE` immediately (most stale plans fail here, before any
   queueing).
4. Re-evaluate policy; compare with the plan's decision.
5. Atomically consume the plan and create the operation (`queued`, or
   `awaiting_approval` if approvals are missing).
6. Return `202 Accepted` with the operation id (REST) or an operation handle
   (MCP).

### 4.2 Execution (worker)

```
lease(target:<id>:schema) ─▶ connect(migrator) ─▶ verify identity ─▶ advisory lock
   ─▶ re-check bindings under lock ─▶ for each migration: execute ▸ gate ▸ record ▸ commit ▸ verify
   ─▶ mirror ─▶ unlock ─▶ release lease ─▶ audit
```

1. **Lease** the exclusivity domain `target:<id>:schema` in the Control Store.
2. **Connect** as `exponetdb_migrator` on a dedicated, non-pooled connection:
   TLS `verify-full`, `application_name = 'exponetdb/op_<id>'`, TCP keepalives
   (idle 30 s, interval 10 s, count 3) and `tcp_user_timeout` set, so that a
   vanished worker releases its server session (and with it the advisory lock)
   within about a minute.
3. **Verify identity**: `system_identifier` equals the pinned value;
   `exponetdb.target_identity` row equals `(installation_id, target_id,
   generation)`. Mismatch: `TARGET_IDENTITY_MISMATCH` or
   `CLUSTER_IDENTITY_MISMATCH`, target suspended, operation failed.
4. **Advisory lock**: acquire the target schema lock
   ([`concurrency.md`](./concurrency.md)). Timeout → `MIGRATION_LOCK_TIMEOUT`,
   operation failed, nothing applied, plan consumed (re-plan to retry).
5. **Re-check bindings under the lock** on the same session: ledger state hash,
   schema fingerprint, server version, extension versions. Any difference →
   `PLAN_STALE`, nothing applied.
6. **For each migration in order**: run §4.3 (transactional) or §4.4
   (non-transactional). After a successful commit, run post-commit verification
   ([`verification.md`](./verification.md)). If verification is not `passed`
   and `stopOnVerificationFailure` (always true in V1), stop: remaining
   migrations are not applied.
7. **Mirror**: read back the ledger rows written and update the Control Store
   mirror.
8. **Unlock and release** the advisory lock and the lease (also on every error
   path; a crashed worker relies on server-side session end and lease expiry).
9. **Audit** `migration.apply` (with its apply outcome) or `migration.failed` per
   migration, `migration.verification` per verification run, and
   `operation.completed` for the whole operation.

### 4.3 Transactional migration

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
  SET LOCAL lock_timeout = '<manifest>';
  SET LOCAL statement_timeout = '<manifest>';
  SET LOCAL search_path = <manifest searchPath>;
  SELECT … FROM exponetdb.target_identity FOR SHARE;      -- identity bound inside the tx
  SET LOCAL ROLE <execution role>;                        -- e.g. reosa_owner
    <statement 0> … <statement n>                         -- one protocol message per statement
  RESET ROLE;
  <pre-commit structural gate>                            -- engine-generated catalog assertions
  <fingerprint after (computed in-transaction)>
  INSERT INTO exponetdb.schema_migrations (…);
  INSERT INTO exponetdb.migration_events (event='applied', …);
COMMIT;
```

- Any error before `COMMIT` → `ROLLBACK`; `applyOutcome = not_applied`;
  `MIGRATION_EXECUTION_FAILED` with SQLSTATE, statement index and position
  (redacted per [`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)).
- A failed **pre-commit structural gate** also rolls back. This gate contains
  only engine-generated, read-only catalog assertions derived from the parsed
  statements (for example "index X exists", "column Y has type Z"). It never
  runs `verify.sql` (reviewed bundle content that runs post-commit on its own
  connection in a read-only transaction, see [`verification.md`](./verification.md#4-runtime-verification-verifysql)).
- If the connection fails **after `COMMIT` was sent and before the reply**, the
  outcome is unknown: the operation enters `needs_reconciliation`. Reconciliation
  opens a new connection and looks for the ledger row with this `operation_id`.
  Present → applied (continue with verification). Absent → not applied (fail).
  The row's presence is decisive because it was written in the same transaction
  ([C-12](../00-product/constitution.md#c-12-retries-never-execute-twice)).

### 4.4 Non-transactional migration

**[DECIDED]** A plan that contains a non-transactional bundle contains exactly
that one bundle (it cannot be combined with others), because partial failure
semantics must stay comprehensible.

1. `INSERT … migration_events (event='nontx_started')`, committed.
2. For each statement `k`: run it in autocommit mode with
   `SET lock_timeout/statement_timeout` at session level (reset afterwards); on
   success insert `nontx_statement_done(k)`, committed.
3. After the last statement: one transaction with the structural gate, the
   fingerprint, the ledger row and the `applied` event.
4. On failure at statement `k`: record `nontx_failed(k, sqlstate)`;
   `applyOutcome = partially_applied` if `k > 0` or if the failed statement can
   leave artifacts (for example `CREATE INDEX CONCURRENTLY` leaves an **INVALID**
   index); otherwise `not_applied`. The target receives a blocking finding
   `nontransactional_migration_incomplete`; further schema plans on the target
   are denied until an operator resolves it through `migration.resume` or a
   cleanup plan ([`failure-and-recovery.md`](./failure-and-recovery.md#2-non-transactional-migrations)).

Non-transactional bundles on prod tier always require approval and
re-authentication (policy rule `migration.nontransactional`).

## 5. Session settings

**[DECIDED]** The migrator session pins every setting that changes how SQL is
parsed or how values are rendered, so that staging and production execute the
same text with the same meaning:

| Setting | Value | Why |
|---|---|---|
| `standard_conforming_strings` | `on` | The checksum lexer assumes it; backslashes in `''` are literal. |
| `client_encoding` | `UTF8` | Bundles are UTF-8. |
| `TimeZone` | `UTC` | Defaults and casts of timestamps. |
| `DateStyle`, `IntervalStyle` | `ISO, YMD`, `postgres` | Deterministic rendering in defaults and verification output. |
| `extra_float_digits` | `1` | Deterministic float rendering. |
| `check_function_bodies` | `on` | Function bodies are validated at creation. |
| `search_path` | from manifest (materialized) | Name resolution is part of the migration's meaning. |
| `lock_timeout` | from manifest; default 5 s | Avoid lock-queue pileups (§6). |
| `statement_timeout` | from manifest; default 15 min | Bound runaway statements. |
| `idle_in_transaction_session_timeout` | 120 s | A stuck worker must not hold a transaction open forever. |
| `application_name` | `exponetdb/op_<id>` | Visible in `pg_stat_activity` and locks views. |
| `pg_stat_statements.track` | unchanged | ExponetDB does not hide its own statements. |

## 6. Lock-queue safety

A DDL statement that waits for a strong lock blocks every later query on that
table while it waits. **[DECIDED]** Every migration statement runs with a
`lock_timeout` (default 5 s, maximum 60 s without a lint acknowledgement). A
timeout rolls back the transaction cleanly (`MIGRATION_LOCK_TIMEOUT`,
retryable by re-planning). The engine never retries automatically: a busy table
is information for the human or agent, who may choose a quieter time.

**[OBSERVED]** None of REOSA's 454 migrations sets `lock_timeout`
(`REOSA/packages/db/migrations/`, audit 2026-10-04); none uses `CONCURRENTLY`.
The default here is therefore a behavior change for REOSA and is called out in
[`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md).

## 7. Statement execution

**[DECIDED]**

- `up.sql` is split into statements by the PostgreSQL parser (libpg_query for
  the target's major version), never by `;` or by `--> statement-breakpoint`
  markers. **[OBSERVED]** REOSA files contain 4,148 breakpoint markers in 307
  files; they are SQL comments and are ignored by the splitter.
- Each statement is sent as its own protocol message. The engine never sends the
  whole file as one multi-statement string, so that transaction-control
  statements cannot be smuggled in and errors map to a statement index.
- Statements are classified before execution; forbidden classes are rejected at
  plan time ([`migration-bundles.md` §4](./migration-bundles.md#upsql)).
- Notices and warnings raised during execution are captured (redacted) into the
  operation record.

## 8. What the caller sees

| Moment | REST | MCP |
|---|---|---|
| plan | `201` with plan body | `migration_plan` result: structured plan + short summary text |
| apply accepted | `202` + `Location: /api/v1/operations/op_…` | `plan_apply` returns operation handle (`op_…`), state, and either "awaiting approval" with the approval URL or "queued" |
| progress | `GET /operations/{id}` (events, current migration, statement index) | `operation_get(op_…)` tool; Tasks extension when the client declares it |
| outcome | operation with `applyOutcome`, `verificationOutcome` per migration | same structure |

## 9. Edge cases

| Case | Behavior |
|---|---|
| Same plan applied twice (network retry) | Second call returns the existing operation (`alreadyAccepted`). |
| Another migration applied between plan and apply | Ledger hash differs → `PLAN_STALE` at acceptance or under lock. |
| Out-of-band DDL (someone ran SQL by hand) between plan and apply | Fingerprint differs → `PLAN_STALE`; drift finding raised. |
| Target restarted during execution | Connection error; if before COMMIT: rolled back by the server; if commit outcome unknown: reconciliation by ledger row. |
| Worker crashes mid-transaction | Server rolls back when the session ends; lease expires; new worker reconciles (no ledger row → not applied). |
| Lock holder (another session) crashes | Its locks are released by the server; our `lock_timeout` may already have fired → retry by re-planning. |
| Extension required but missing | Plan denied (`MIGRATION_REQUIREMENT_UNMET`); remedy is a `postgres.extensions.apply` operation first. |
| PostgreSQL minor version changed between plan and apply | Server version binding → `PLAN_STALE` (conservative: minor versions can change catalog rendering). |
| Plan includes three migrations, second fails | First stays applied and verified; second rolled back; third not attempted; operation `failed` with per-migration outcomes. |
| Verification of the first of three fails | Stop; second and third not applied (`stopOnVerificationFailure`). |
| Execution role lacks a privilege the SQL needs | SQL error, rollback; analysis cannot always predict this. |
| `CREATE INDEX CONCURRENTLY` on a partitioned table | Rejected at plan time by analysis (PostgreSQL does not support it; build per partition). |
