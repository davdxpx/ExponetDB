# Audit

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 implementation (§1, §3, §4) awaiting G2 |
| Applies to | Wave 2 (writer, immutability), every later wave (events) |
| Read before | [`operations-engine.md`](./operations-engine.md), [`data-retention.md`](./data-retention.md) |

Every consequential mutation, every authorization decision that matters, and every
access to sensitive data is recorded as an **audit event**. Audit answers: who,
what, where, when, why, how, with what result, without containing secrets.

## 1. Event shape

**[DECIDED]**

```json
{
  "schema": "exponetdb.audit/v1",
  "seq": 4711,                                // position in the chain, assigned by the writer
  "id": "aud_01JB…",
  "occurredAt": "2026-10-04T12:00:00.123456Z", // database clock, microseconds, UTC
  "action": "migration.apply",
  "phase": "completed",                       // requested | denied | accepted | completed | failed | reconciled
  "actor": {
    "kind": "human",                          // human | service | system
    "identityId": "idn_…",                    // null for system actors
    "label": "human #3",                      // pseudonymous label; names are resolved at read time, see §6
    "viaBreakGlass": "bgl_… | null",
    "reauthAt": "…"                           // when step-up was proven, if relevant
  },
  "client": {
    "clientId": "cli_…",
    "kind": "web | rest | mcp | cli | ci | system",
    "name": "Claude Code",                    // registered/metadata name, untrusted for decisions
    "grantId": "grt_… | null",
    "sessionId": "ses_… | null"
  },
  "subject": {                                // where
    "targetId": "tgt_…", "targetPath": "reosa/platform/production", "tier": "prod",
    "clusterId": "cls_…", "serverId": "srv_…", "nodeId": "nod_…"
  },
  "refs": { "planId": "pln_…", "planHash": "sha256:…", "operationId": "op_…", "jobId": null,
            "migrationIds": ["01JB…"], "checksums": ["sha256:c1:…"], "approvalIds": ["apr_…"] },
  "reason": "Inbox query slow; adds partial index",   // why: caller-supplied, untrusted text, length-capped
  "decision": { "decision": "allow", "rules": ["migration.staging-evidence:pass", "migration.agent-production:require→approved"], "policyVersion": "sha256:pv1:…" },
  "result": { "status": "succeeded | failed | denied", "errorCode": null, "applyOutcome": "applied", "verificationOutcome": "passed" },
  "request": { "requestId": "req_…", "traceId": "…", "ipHash": "hmac-sha256:…", "userAgentHash": "hmac-sha256:…" },
  "changes": { … }                            // redacted diff for registry/access changes; never secret values
}
```

**[DECIDED]** (Wave 2) The contract is `StoredAuditEventSchema` in
`packages/contracts/src/audit.ts` (`exponetdb.audit/v1`), strict at every
level: unknown members are refused, and a change of shape is a new schema
version because every event is hashed as it is shaped. `prevHash` and `hash`
are not members of the event: they are stored beside it (§4.1). Labels are
`human #<n>`, `service #<n>` or `system:<process>` (`serve`, `worker`,
`gateway`, `migrate`, `maintenance`). `reason` is at most 1,000 characters.

Rules:

- **No secrets**: credentials, tokens, API keys, verifiers, private keys, OAuth
  codes, session ids in raw form never appear. Fields that reference secrets
  record their id and version only.
- **No raw SQL**: migration content is referenced by checksum and plan hash
  (the plan holds the content); query text is normalized and redacted
  ([`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)).
- **Untrusted text is marked**: `reason` and client names are stored verbatim but
  are rendered escaped, length-capped and labeled as user-supplied everywhere.
- **IP and user agent are pseudonymized** with a keyed hash
  (`hmac-sha256:<hex>`, HMAC-SHA-256 over
  `"exponetdb/audit-pseudonym/v1" LF kind LF value` under an
  installation-specific 256-bit key that lives outside the audit rows,
  envelope-encrypted under the keyring). A plain SHA-256 over IPv4 addresses
  could be reversed by enumeration, so it is not used
  ([OD-8](../00-product/open-decisions.md#od-8-audit-retention-and-personal-data)).

## 2. What is audited

**[DECIDED]** Minimum catalog (each with `requested/denied/accepted/completed/failed`
phases as applicable):

| Domain | Actions |
|---|---|
| Migrations | `migration.planned`, `migration.plan_denied`, `migration.apply` (per migration), `migration.verification` (per run), `migration.failed`, `migration.rollback`, `migration.baseline`, `migration.verify_revision`, `ledger.reconcile`, `ledger.mirror_healed` |
| Plans / approvals | `plan.created`, `plan.invalidated`, `plan.withdrawn`, `approval.granted`, `approval.rejected`, `operation.completed`, `operation.reconciled`, `operation.force_release` |
| Break-glass | `breakglass.activated`, `breakglass.used`, `breakglass.expired`, `breakglass.reviewed` |
| Connections | `connections.cancel`, `connections.terminate` |
| Data access | `data.read` (normalized statement, digest, rows, duration), `diagnostics.raw_statement_viewed` |
| Backups / restore | `backup.started`, `backup.completed`, `backup.verified`, `backup.failed`, `restore.planned`, `restore.executed`, `restore.verified`, `restore_drill.*` |
| Node / cluster | `node.enrolled`, `node.revoked`, `node.certificate_renewed`, `postgres.config.planned/applied`, `postgres.restart.*`, `postgres.reload`, `postgres.tls.rotated`, `postgres.roles.applied`, `postgres.hba.applied`, `postgres.extensions.applied`, `packages.update.*` |
| Registry | `target.registered`, `target.suspended`, `target.resumed`, `target.decommissioned`, `target.identity_stamped`, `placement.changed`, `cluster.confirmed`, `credential.rotated`, `credential.verified_failed` |
| Access | `identity.created`, `identity.disabled`, `login.succeeded/failed` (rate-limited aggregation for failures), `reauth.succeeded/failed`, `role_binding.changed`, `oauth.client_registered`, `oauth.client_approved`, `oauth.grant_created`, `oauth.grant_revoked`, `oauth.token_refresh_reuse_detected`, `api_key.created`, `api_key.revoked`, `policy.settings_changed` |
| Maintenance | `retention.pruned` (per dropped partition: class, range, row count, boundary) |
| Security signals | `target.identity_mismatch`, `cluster.identity_mismatch`, `ledger.divergence_detected`, `authz.denied` for high-risk actions (sampled for low-risk) |

Read-only requests (listing targets, schema inspection, diagnostics) are **not**
audited individually; they are covered by request logs with shorter retention.
`data.read` and raw-statement views are the exceptions because they reveal data.

## 3. Writing

**[DECIDED]**

- Audit events for state transitions are written **in the same transaction** as
  the state change in the Control Store. If the audit insert fails, the state
  change fails.
- For effects outside the Control Store (target DDL, node actions), a
  `requested`/`accepted` event is written **before** the effect and a
  `completed`/`failed` event after it. This mirrors REOSA's kernel ("blocking
  initiated audit row, then completed/failed row"), which ensures that an effect
  never happens without a prior record.
- Writers are serialized through a single sequence for the hash chain (§4); the
  chain is per installation, with a monotonically increasing `seq`.

**[DECIDED]** (Wave 2) `appendAuditEvent(tx, input)` in `packages/audit`
appends in the caller's transaction: it validates the input against the
contract, takes the transaction-level chain lock (`EXDB` namespace,
`audit-chain`), reads the head and the database clock (never earlier than the
head's time), assigns `seq`, `id` and `occurredAt`, computes `ac1` and inserts.
The lock is held until the caller commits, so the append is the last step of
a transaction. Any failure is `audit_append_failed` and the transaction rolls
back with the change it audits; an event that does not match the contract is
`audit_event_invalid` before the database is touched. Every runtime login
(`exdb_serve`, `exdb_worker`, `exdb_gateway`, `exdb_audit_maint`) may append.

## 4. Immutability and integrity

**[DECIDED] V1**, implemented in Wave 2 by the Control Store bundle
`01M46KJ06G9BHM1ZR7CDD2JZ2S_audit-chain` and `packages/audit`
([ADR-0023](../01-architecture/adr/0023-audit-chain-hash-ac1.md)).

### 4.1 Chain hash `ac1`

A stored contract from the first persisted event on: its output for an input
never changes; a change is `ac2` with its own vectors
([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).

```
input = UTF8("exponetdb/audit-chain/ac1") LF
      + frame("prevHash", UTF8(prevHash))
      + frame("event",    UTF8(JCS(E)))
frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
hash  = "sha256:ac1:" + lowercase hex(SHA-256(input))
```

- `E` is the event of §1, exactly the members of `exponetdb.audit/v1`
  (`schema`, `seq`, `id`, `occurredAt`, `action`, `phase`, `actor` required;
  `client`, `subject`, `refs`, `reason`, `decision`, `result`, `request`,
  `changes` optional), canonicalized with RFC 8785 (JCS). `JCS(E)` is also the
  stored text of the event.
- `prevHash` is the previous event's hash. For `seq` 1 it is the genesis value
  `ac1:genesis:<installation id>`, which binds the chain to its installation.
- Checks, in this order, the first failing one being the refusal:
  `invalid_prev_hash` (neither a genesis value nor an `ac1` hash),
  `not_object`, `unknown_member`, `missing_member`, `unsupported_schema`,
  `invalid_seq` (not a safe integer ≥ 1), `genesis_mismatch` (genesis value
  if and only if `seq` is 1), `invalid_event_id`, `invalid_timestamp`
  (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), then the JCS refusals.
- Golden vectors: `tooling/golden/audit-chain.json`. Implementations:
  TypeScript (`auditChainHash` in `packages/audit`) and SQL (`audit.ac1` in
  the Control Store); both reproduce every vector.

### 4.2 Privileges and triggers

1. **Privileges**: runtime roles have `INSERT` and `SELECT` only on
   `audit.audit_events`, `SELECT` on checkpoints and exports, and nothing on
   the monthly partitions themselves; `PUBLIC` has nothing.
2. **Triggers**: `BEFORE UPDATE OR DELETE` (per row) and `BEFORE TRUNCATE`
   (on the parent and on every partition) raise `EXA01` for every role,
   including the owner `exdb_migrate`. Runtime roles cannot disable triggers,
   alter, detach or drop tables, replace functions or set
   `session_replication_role` (`42501`). The owner and a superuser can
   disable triggers; the owner credential is used only by the one-shot
   `control-store migrate` and is never held by a running process, and
   exported checkpoints (§4.4) detect a rewrite by either.

Tests attempt every forbidden statement as every role
(`packages/audit/test/chain.int.test.ts`).

### 4.3 Sequence and the database chain guard

`seq` and `prevHash` are assigned under a transaction-level advisory lock so
that the chain is linear. A `BEFORE INSERT` trigger (`audit.chain_guard`)
takes the same lock and refuses, whatever the writer did:

| SQLSTATE | Refusal |
|---|---|
| `EXA02` | the row does not continue the chain: not the next `seq`, a `prev_hash` that is not the head's hash (or the genesis value of this installation for `seq` 1), a time before the head's or more than one minute ahead of the database clock |
| `EXA03` | `hash` is not `audit.ac1(prev_hash, event)` |
| `EXA04` | a query column (`seq`, `event_id`, `action`, `phase`, `occurred_at`, actor, operation and plan ids) differs from the event |

Monthly range partitions on `occurred_at` (`audit.audit_events_yYYYYmMM`) hold
contiguous ranges of `seq`, because time never runs backwards along the chain.
`audit.ensure_partitions(n)` (worker, maintenance role) creates the current and
the next `n` months (1 to 24); bounds come from the database clock.

### 4.4 Checkpoints and off-host export

Every hour, and at every retention purge, the current `(seq, hash)` is written
to `audit.audit_chain_checkpoints` (the database refuses a pair that is not an
event of the chain: `EXA06`) and **exported** off-host as one object per
checkpoint (`<prefix>/<installation id>/audit-checkpoints/<seq, 20 digits>.json`,
canonical JSON `exponetdb.audit-checkpoint/v1`; no event content, no secrets).
V1 sink: the backup bucket (S3-compatible, Signature Version 4, conditional
`If-None-Match: *` writes that never overwrite, optional object lock), plus
the daily Control Store backup. A superuser who rewrites history in the
database cannot rewrite exported checkpoints. Each export is recorded in
`audit.checkpoint_exports` (append-only, one row per checkpoint and sink).

An export failure never blocks audit writes: the worker retries with backoff
on its next run, the self-health turns `degraded`, and retention stops,
because a partition is dropped only when an exported checkpoint covers it.
An audit insert failure, by contrast, fails the mutation (§3).

**[OBSERVED]** (Wave 2) The export protocol is proven against an
S3-compatible test server (versitygw) in CI; export to the production bucket
is a deployment fact, recorded separately in the G2 gate record.

### 4.5 Verification

`exponetdb audit verify` recomputes the chain from the genesis value, from a
checkpoint (`--from-checkpoint <seq>`, which must match the stored event) or,
after a purge, from the boundary recorded in the `retention.pruned` event, and
reports the first failing `seq` with one of `sequence_gap`,
`prev_hash_mismatch`, `not_canonical`, `invalid_event`, `columns_mismatch`,
`hash_mismatch`, `checkpoint_mismatch`, `anchor_missing`. It is read-only;
there is no repair mode. The Web App shows "chain verified up to seq N at
time T". A scheduled incremental verification runs hourly (with the
checkpoint export) and a full verification daily.

### 4.6 Retention purge

Old partitions are dropped only after a checkpoint that covers their last
event has been exported; the purge itself is an audit event
(`retention.pruned`) that records the range, the row count and the boundary
`(droppedThroughSeq, boundaryHash)`, so that the remaining chain starts from a
verified anchor. `audit.drop_expired_partition` runs as the owner, may be
called only by `exdb_audit_maint`, and refuses (`EXA05`) a retention below 400
days, a name that is not an audit partition, a partition inside the period,
the partition that holds the chain head, a partition that is not the oldest,
and a partition no exported checkpoint covers. The default retention is
`permanent`, under which nothing is ever dropped
([`data-retention.md`](./data-retention.md#2-mechanism)).

**[PLANNED] later:** append-only external sink (WORM storage or a transparency log)
and signed checkpoints with a key held outside the Control Plane.

## 5. Reading

- `audit.read` permission/scope; filters by time, actor, client, target, action,
  result, plan/operation ids.
- Audit is readable by agents with `audit.read` (useful for "what happened on
  production yesterday"), with personal fields minimized (§6).
- Every audit view is paginated; no bulk export via MCP.

## 6. Personal data

**[DECIDED]** Audit rows are immutable and hash-chained, so they must not contain
data that may later have to be erased. Events therefore store identity **ids**
and a pseudonymous `label` (`human #3`), never names or e-mail addresses; IPs and
user agents are stored as keyed hashes. The mapping from identity id to name lives
in the `identities` table and is resolved at read time; erasing or pseudonymizing
a person in `identities` does not touch the chain, and the events then show only
the pseudonym. Free-text `reason` fields are the remaining risk: the Web App warns
that reasons are permanent and must not contain personal data. Retention periods:
[`data-retention.md`](./data-retention.md), with the legal retention question in
[OD-8](../00-product/open-decisions.md#od-8-audit-retention-and-personal-data).
