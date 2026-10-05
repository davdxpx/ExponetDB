# Audit

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 2 (writer, immutability), every later wave (events) |
| Read before | [`operations-engine.md`](./operations-engine.md), [`data-retention.md`](./data-retention.md) |

Every consequential mutation, every authorization decision that matters, and every
access to sensitive data is recorded as an **audit event**. Audit answers: who,
what, where, when, why, how, with what result, without containing secrets.

## 1. Event shape

**[DECIDED]**

```json
{
  "id": "aud_01JB…",
  "occurredAt": "2026-10-04T12:00:00.123456Z",
  "action": "migration.apply",
  "phase": "completed",                       // requested | denied | accepted | completed | failed | reconciled
  "actor": {
    "identityId": "idn_…",
    "kind": "human | service",
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
  "decision": { "decision": "allow", "rules": ["migration.staging-evidence:pass", "migration.agent-production:require→approved"], "policyVersion": "sha256:…" },
  "result": { "status": "succeeded | failed | denied", "errorCode": null, "applyOutcome": "applied", "verificationOutcome": "passed" },
  "request": { "requestId": "req_…", "traceId": "…", "ipHash": "sha256:…", "userAgentHash": "sha256:…" },
  "changes": { … },                           // redacted diff for registry/access changes; never secret values
  "prevHash": "sha256:…",
  "hash": "sha256:…"
}
```

Rules:

- **No secrets**: credentials, tokens, API keys, verifiers, private keys, OAuth
  codes, session ids in raw form never appear. Fields that reference secrets
  record their id and version only.
- **No raw SQL**: migration content is referenced by checksum and plan hash
  (the plan holds the content); query text is normalized and redacted
  ([`../03-database-model/statement-redaction.md`](../03-database-model/statement-redaction.md)).
- **Untrusted text is marked**: `reason` and client names are stored verbatim but
  are rendered escaped, length-capped and labeled as user-supplied everywhere.
- **IP and user agent are hashed** (keyed hash with a per-installation salt),
  following REOSA's practice of storing IPs only as SHA-256.

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

## 4. Immutability and integrity

**[DECIDED] V1:**

1. **Privileges**: application roles have `INSERT` and `SELECT` only on
   `audit_events`.
2. **Trigger**: `BEFORE UPDATE OR DELETE` raises for every role, including the
   table owner (superusers can disable triggers; see 4).
3. **Hash chain**: `hash = SHA-256(prevHash || JCS(event without hash))`.
   `seq` and `prevHash` are assigned under a transaction-level advisory lock in the
   Control Store so that the chain is linear.
4. **Off-host anchoring**: every hour, and at every retention purge, the current
   `(seq, hash)` is written to an `audit_chain_checkpoints` row and **exported**
   off-host (V1: appended to an object in the backup bucket with object lock /
   bucket lock, plus the daily Control Store backup). A superuser who rewrites
   history in the database cannot rewrite exported checkpoints.
5. **Verification**: `exponetdb audit verify` recomputes the chain from a given
   checkpoint and reports the first mismatch; the Web App shows "chain verified up
   to seq N at time T". A scheduled incremental verification runs hourly (with
   the checkpoint export) and a full verification daily.
6. **Retention purge**: old partitions are dropped only after a checkpoint that
   covers their last event has been exported; the purge itself is an audit event
   that records the range and the boundary hash, so that the remaining chain
   starts from a verified anchor.

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
