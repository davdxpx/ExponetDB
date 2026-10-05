# Operations Engine

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 2 (framework), every later wave that adds an operation kind |
| Read before | [`../00-product/constitution.md`](../00-product/constitution.md) Part II, [`policy-engine.md`](./policy-engine.md), [`error-model.md`](./error-model.md) |
| Decision | [ADR-0011](../01-architecture/adr/0011-plan-apply-operations-engine.md) |

The Operations Engine is the single path through which every consequential
mutation happens, whichever interface requested it. It implements
Inspect → Plan → Validate → Authorize → Apply → Verify → Audit
([C-6](../00-product/constitution.md#c-6-consequential-mutations-follow-inspect-plan-validate-authorize-apply-verify-audit)).

**[DECIDED]** There is one engine with pluggable *operation kinds*, not one
plan/apply implementation per domain. Migrations, configuration changes, TLS
rotation, restores, restarts, package updates, terminations, credential
rotations and registry changes are all operation kinds. Reason: plan binding,
staleness, idempotency, approvals, break-glass, leases, reconciliation and audit
are the same problem every time; implementing them once is the only way they
stay correct.

## 1. Action classification

Every action exposed by any interface is registered in the contracts with one of
these classes. The class is a property of the action kind, not of the caller.

| Class | Meaning | Mechanism | Examples |
|---|---|---|---|
| `read` | No state change in any managed system | none (authorization + audit of sensitive reads only) | list targets, inspect schema, list locks, read migration status |
| `low` | Small, reversible or self-limiting effect on one object | **inline plan**: request carries precondition tokens; authorized, executed, verified, audited in one call | cancel one query, trigger a health re-sample, re-run verification |
| `standard` | Changes structure, configuration or availability of one target or cluster | **stored plan**, then apply | migration on a non-production target, `postgres.config.apply` reload-only, backup run |
| `high` | Production-tier structural change, restart, credential rotation, terminate backend on production | stored plan; policy may require approval and re-authentication | migration on production, restart, TLS rotation, terminate on production |
| `critical` | Replaces or destroys data or identity | stored plan, approval, re-authentication; human actor only in V1 | restore execute (recovery), target decommission, `down.sql` on production when the rollback is `lossy` or `unsafe`, placement move |

The registry of action kinds is code in `packages/contracts` (names, class, input
schema, required permission, scope per tier, exclusivity domain). A contract test
fails if an interface exposes a mutating handler that is not registered.

## 2. Operation kinds

**[DECIDED]** An operation kind is a module that provides:

```ts
interface OperationKind<Input, PlanContent, Result> {
  kind: string                     // "migration.apply", "postgres.config.apply"
  version: number                  // bumped when plan content shape changes
  actionClass: "low" | "standard" | "high" | "critical"
  subject(input): SubjectRef       // target | cluster | node | server | registry
  permission: Permission           // e.g. "migrations.apply"
  scope(tier): OAuthScope          // e.g. "migrations.apply:prod"
  exclusivity: ExclusivityDomain[] // see §7

  inspect(ctx, input): Promise<InspectedState>
  plan(ctx, input, state): Promise<PlanDraft<PlanContent>>   // content + analysis + bindings
  bindings(plan): BindingCheck[]   // re-validated at apply time and under lock
  execute(ctx, plan, op): Promise<ExecutionOutcome>          // may dispatch node jobs
  verify(ctx, plan, op): Promise<VerificationOutcome>
  reconcile(ctx, plan, op): Promise<ReconciliationOutcome>   // when outcome is unknown
}
```

Initial kinds (owning wave in brackets):

| Kind | Class | Wave |
|---|---|---|
| `target.register`, `target.suspend`, `target.resume`, `target.decommission` | standard / critical | 4 |
| `target.identity.stamp` | standard | 4 |
| `credential.rotate` | high | 4/5 |
| `migration.apply` (one or more bundles in DAG order) | standard / high | 6 |
| `migration.verify` (re-run verification only) | low | 6 |
| `migration.rollback` (execute `down.sql`) | high / critical | 6 |
| `migration.baseline` (legacy import) | high | 6 |
| `connections.cancel` | low | 9 |
| `connections.terminate` | standard / high | 9 |
| `postgres.config.apply`, `postgres.reload`, `postgres.restart` | standard / high | 5 |
| `postgres.tls.rotate` | high | 5 |
| `postgres.roles.apply`, `postgres.extensions.apply`, `postgres.hba.apply` | high | 5 |
| `packages.apply_update` | high | after 9 (Wave 5 ships audit and planning only) |
| `backup.run`, `backup.verify` | standard / low | 9 |
| `restore.execute` | standard (drill into scratch) / high (clone into a new nonprod target) / critical (recovery, unmasked production clone) | 9 |
| `node.enroll`, `node.revoke` | high | 5 |
| `access.*` (role bindings, clients, keys) | standard / high | 3 |
| `ledger.initialize` (part of `target.register`) | standard / high | 4 |
| `ledger.reconcile` | high | 6 |
| `migration.resume` (continue or clean up an incomplete non-transactional bundle) | high | 6 |
| `migration.rebaseline` (legacy import correction) | high | 6 |
| `drift.accept` | standard / high | 6 |
| `operation.force_release` (release a lock domain held by a lost worker) | high | 6 |
| `node.decommission` | high | 5 |

## 3. Plans

### 3.1 Content

**[DECIDED]** A plan is a row in the Control Store plus a canonical JSON body. It
contains everything needed to decide and everything that will be executed:

```yaml
id: pln_01JB…
kind: migration.apply
kindVersion: 1
createdAt: 2026-10-04T12:00:00Z
expiresAt: 2026-10-04T12:15:00Z          # server clock, see §3.3
actor:   { identityId: idn_…, kind: human|service, via: web|rest|mcp|cli }
client:  { clientId: cli_…, grantId: grt_… | sessionId: ses_… }
subject: { targetId: tgt_…, targetPath: reosa/platform/production, generation: 3, tier: prod }
content:                                   # what will be executed, exact bytes
  …                                        # kind-specific, e.g. bundles with SQL
contentChecksum: sha256:…
expectedState:                             # bindings to live state
  schemaFingerprint: fp1:17:…
  ledgerStateHash: sha256:ls1:…
  clusterSystemIdentifier: "7291…"
  pgVersionNum: 170006
analysis: { … }                            # kind-specific, e.g. compatibility, locks
evidence: [ { evidenceId: evd_…, kind: staging_verified, … } ]
policy:
  decision: allow | require | deny        # PolicyDecision, see policy-engine.md §3
  rules: [ { id: "migration.staging-evidence", result: pass, … }, … ]
  policyVersion: sha256:…                  # hash of rule code version + effective config
  requirements:                            # empty unless decision = require
    - { kind: approval, count: 1, permission: plans.approve }
    - { kind: reauth, withinSeconds: 300 }
    - { kind: backup, newerThan: "PT24H", verified: true }
planHash: sha256:…                         # hash of everything above (canonical JSON)
state: active
```

`planHash` is shown to humans (shortened) in approvals and returned to agents,
so that "the plan I reviewed" and "the plan that ran" are provably the same.

**[DECIDED]** Plan-hash construction (Wave 1 clarification; implemented in
`packages/kernel`, independently in the Go conformance implementation, and
pinned by golden vectors):

- The hashed object `B` has exactly the binding members listed above `planHash`:
  `id`, `kind`, `kindVersion`, `createdAt`, `expiresAt`, `actor`, `client`,
  `subject`, `content`, `contentChecksum`, `policy` (always present) and
  `expectedState`, `analysis`, `evidence` (present when the kind or the plan
  uses them). `planHash` itself and `state` are never part of `B`; neither are
  lifecycle, display or approval fields of the plan row.
- `planHash = "sha256:" + lowercase hex(SHA-256(UTF-8(JCS(B))))` with JCS as in
  RFC 8785.
- The function refuses an object with any other top-level member
  (`unknown_member`), a missing required member (`missing_member`) or an `id`
  that is not a canonical `pln_` id (`invalid_plan_id`), checked in this order,
  so a new binding field cannot silently stay outside the hash: adding one is a
  contract change.
- The construction itself is not versioned in the value; changing it would need
  a new prefix through an ADR. Plan *content* changes are versioned by
  `kindVersion`.

### 3.2 Bindings

**[DECIDED]** At apply time, and again under the exclusivity lock right before
execution, every binding is checked. A failing binding produces `PLAN_STALE`
with `details.changedBindings[]`, for example:

```json
{ "code": "PLAN_STALE",
  "message": "The plan no longer matches the target. Create a new plan.",
  "details": { "planId": "pln_…",
               "changedBindings": [
                 { "binding": "schemaFingerprint", "expected": "fp1:17:ab…", "actual": "fp1:17:9c…" },
                 { "binding": "ledgerStateHash", "expected": "…", "actual": "…",
                   "hint": "Migration 01JB… was applied at 12:07 by idn_…" } ] } }
```

Generic bindings checked for every kind:

| Binding | Fails when |
|---|---|
| `expiry` | server time > `expiresAt` (code `PLAN_EXPIRED`, a specialization of stale) |
| `state` | plan not `active` (consumed, withdrawn, invalidated) → `PLAN_ALREADY_USED` or `PLAN_STALE` |
| `actor` | caller identity ≠ plan actor |
| `client` | caller OAuth client ≠ plan client (or session-based plan applied with a token, and vice versa) |
| `authorization` | identity lost the permission, token lost the scope, grant revoked, target removed from grant |
| `subject` | target generation changed, target suspended/decommissioned, cluster `system_identifier` changed |
| `policy` | re-evaluated decision is stricter than the planned one, or policy version changed and the result differs |
| `content` | stored content no longer hashes to `contentChecksum` (storage corruption or tampering) |

Kind-specific bindings (examples): schema fingerprint and ledger state hash for
migrations; current configuration version and PostgreSQL version for config
changes; certificate fingerprint for TLS rotation; backup id and repository
state for restore; `pid` + `backend_start` for terminate.

**[DECIDED]** A stale plan is never refreshed, partially applied or
reinterpreted ([C-7](../00-product/constitution.md#c-7-plans-are-immutable-short-lived-single-use-and-bound)).

### 3.3 Expiry

**[DECIDED]** Default plan lifetimes, configurable per policy only downward
(stricter), with an absolute maximum:

| Class | Default | Maximum | Reason |
|---|---|---|---|
| standard | 30 min | 2 h | enough for an agent to show the plan and apply; short enough that state rarely drifts |
| high | 15 min | 1 h | narrower replay window for stolen plan ids |
| critical | 15 min | 1 h | same |

When a plan requires approval, the *apply request* may wait in
`awaiting_approval` for up to the **approval window** (default 4 h, maximum 24 h).
All live bindings are re-checked when execution actually starts, so a late
approval of a now-stale plan ends in `PLAN_STALE` without executing anything.

### 3.4 Plan states

```
active ──apply accepted──▶ consumed            (terminal)
active ──expiresAt passed──▶ expired           (terminal)
active ──binding failure detected──▶ invalidated (terminal; e.g. another migration applied)
active ──policy deny at plan time──▶ denied    (terminal, plan exists for audit)
active ──actor withdraws──▶ withdrawn          (terminal)
```

A plan is created even when the policy decision is `deny`: the caller gets the
full explanation and the denial is auditable. A denied plan can never be applied.

## 4. Operations

### 4.1 State machine

**[DECIDED]**

```mermaid
stateDiagram-v2
  [*] --> awaiting_approval: apply requested, approvals missing
  [*] --> queued: apply requested, requirements met
  awaiting_approval --> queued: approvals complete
  awaiting_approval --> canceled: rejected / window elapsed / withdrawn
  queued --> running: worker acquired lease and locks, bindings re-checked
  queued --> failed: binding check under lock failed (PLAN_STALE), nothing executed
  queued --> canceled: cancel requested
  running --> verifying: execution finished, outcome known
  running --> failed: execution failed, outcome known (rolled back or not started)
  running --> needs_reconciliation: outcome unknown (connection lost after COMMIT sent, agent lost)
  needs_reconciliation --> verifying: reconciliation shows applied
  needs_reconciliation --> failed: reconciliation shows not applied
  needs_reconciliation --> needs_attention: reconciliation inconclusive
  verifying --> succeeded: verification passed
  verifying --> verification_failed: verification failed or partial
  verifying --> needs_attention: verification could not run (timeout, target unreachable)
  needs_attention --> verifying: operator retries verification
  succeeded --> [*]
  failed --> [*]
  verification_failed --> [*]
  canceled --> [*]
```

Two outcome fields are recorded separately from the state
([C-13](../00-product/constitution.md#c-13-applied-is-not-verified)):

| Field | Values |
|---|---|
| `applyOutcome` | `not_started`, `applied`, `not_applied` (rolled back or refused), `partially_applied` (non-transactional work stopped mid-way), `unknown` |
| `verificationOutcome` | `not_applicable`, `pending`, `passed`, `failed`, `partial`, `error` |

`verification_failed` and `needs_attention` are terminal or semi-terminal states
that **never** trigger re-execution
([C-16](../00-product/constitution.md#c-16-failures-never-trigger-automatic-re-execution-or-rollback)).
From `verification_failed`, the only follow-ups are: a new `migration.verify`
(after fixing a broken `verify.sql`, see
[`../04-migrations/verification.md`](../04-migrations/verification.md#retrying-verification)),
a forward-fix plan, or a rollback plan.

### 4.2 Workers and leases

**[DECIDED]** Operations are executed by the `worker` process role. A worker
claims a queued operation with `SELECT … FOR UPDATE SKIP LOCKED` and writes a
lease (`lease_owner`, `lease_expires_at`, default 30 s, renewed every 10 s).
Each step is recorded as an `operation_event` row before and after it runs.

If a worker dies, its lease expires. Another worker takes the operation over and
**does not resume blindly**: it calls the kind's `reconcile` with the recorded
steps. For a migration, reconciliation reads the target ledger (was the ledger
row for this operation committed?) and the target's `pg_stat_activity` (is the
old session still running?). See
[`../04-migrations/failure-and-recovery.md`](../04-migrations/failure-and-recovery.md).

### 4.3 Node jobs

Operations that need host capabilities dispatch **jobs** to the node agent. A job
is a row with: `id`, `operation_id`, `node_id`, `capability`,
`capability_version`, canonical `args`, `args_hash`, `not_before`,
`expires_at`, `attempt`, `state`, and a detached signature by the worker's
job-signing key. Job execution, leases, acknowledgements and replay protection
are specified in [`../07-node-agent/protocol.md`](../07-node-agent/protocol.md).

## 5. Idempotency

**[DECIDED]** Three mechanisms, chosen by action class:

1. **Plan id** (stored plans). `apply(planId)` is idempotent: the first accepted
   request consumes the plan and creates the operation (`operations.plan_id` is
   unique). A repeated request with the same plan id by the same actor and client
   returns the existing operation with HTTP 200 / tool result `alreadyAccepted:
   true`. Any other caller gets `PLAN_ALREADY_USED`.
2. **Precondition tokens** (inline plans). The request carries the observed
   identity of the object (for a cancel: `pid` + `backend_start` + `query_start`, so
   that a newer query of the same backend is never canceled; or a backup id
   and its state). Repeating a completed request finds the object gone or changed
   and returns `result: already_done` or `PRECONDITION_FAILED`, never a second
   effect on a different object.
3. **Idempotency keys** (other REST mutations: registry writes, access
   management, plan creation). Header `Idempotency-Key` (1 to 255 visible ASCII
   characters). Stored per principal for 24 h with a hash of the request. Same
   key, same request hash: the stored response is replayed. Same key, different
   hash: `IDEMPOTENCY_KEY_REUSED`. MCP tools that create plans accept an optional
   `idempotencyKey` argument with the same semantics.

Node jobs are idempotent by job id; the agent keeps a local journal so that a
restarted agent never executes a job twice (see protocol document).

## 6. Approvals and re-authentication

**[DECIDED]**

- Policy can require `approvals: n` for a plan. An approval is given by a human
  identity holding `plans.approve` at the plan's scope, through the Web App, with
  re-authentication, after the plan content and analysis were displayed. An
  approval records `planHash`, so it approves exactly that plan.
- The approver must differ from the plan's actor **unless** the actor is an AI
  agent client acting for that human, in which case the human approving in the Web
  App *is* the intended second party (agent proposes, human approves: P-14).
  Plans whose actor is a human and that require an approval from a different
  human cannot be completed in a one-person organization; the policy for that
  case is [OPEN: OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization).
- Re-authentication (`reauthWithinSeconds`) means the human proved presence with
  a passkey or TOTP within the window. It is checked at approval time and, for
  `critical` kinds, at apply time.
- Approvals never override `deny`. They satisfy `approval` requirements of a
  `require` decision.

## 7. Exclusivity domains

**[DECIDED]** Operations declare which domains they hold exclusively while
`running`/`verifying`. The worker acquires them in a fixed global order to avoid
deadlocks, first as Control Store rows (`operation_locks`, unique on domain key),
then, for target domains, as PostgreSQL advisory locks in the target
([`../04-migrations/concurrency.md`](../04-migrations/concurrency.md)).

| Domain key | Held by | Conflicts with |
|---|---|---|
| `target:<id>:schema` | migration apply/rollback/baseline, any DDL operation | itself, `target:<id>:maintenance` |
| `target:<id>:maintenance` | restore, placement move, decommission | everything on that target |
| `cluster:<id>:config` | config apply, reload, restart, TLS rotate, roles, extensions, hba | itself, `node:<id>:packages`, cluster restart affects all targets: restart also takes `target:*:schema` of placed targets |
| `cluster:<id>:backup` | backup run on that cluster | itself |
| `node:<id>:packages` | package update | itself, `cluster:*:config` on that node |

Reads never take exclusivity domains.

## 8. Break-glass

**[DECIDED]** Break-glass is the only way to override a policy rule. It is
deliberately inconvenient.

- **Who:** a human identity with the `breakglass.activate` permission at the
  target's scope, in the Web App or CLI, never through MCP and never by a
  service account.
- **How:** re-authentication with a passkey or TOTP; a written reason (minimum 20
  characters, stored verbatim, shown in every related audit event); selection of
  the specific rule ids to override (no "override all"); the target(s); a
  duration (default 30 min, maximum 2 h); optionally a maximum number of uses.
- **What it can override:** staging evidence, fingerprint-match requirements,
  maintenance windows, backup-freshness requirements, compatibility gating,
  approval requirements.
- **What it can never override:** checksum mismatch (history immutability),
  dependency cycles or missing dependencies, target identity mismatch, cluster
  identity mismatch, plan staleness, authentication, tier separation for the
  token of an AI client, the node capability allowlist, secret handling.
- **Effects:** the grant is recorded (`bgl_`), an audit event
  `breakglass.activated` is written and an out-of-band notification is sent
  (Wave 3A decides channel; e-mail as minimum). Every plan created under the grant
  carries `policy.overriddenRules[]` and a banner in every interface. Every
  operation executed under it is flagged for post-incident review; the review
  (`breakglass.reviewed`, with a note) is listed as an open finding until done.
- **Expiry:** at expiry, unused plans created under the grant become invalid
  (their policy binding no longer holds).

## 9. Audit integration

Every transition of a plan, approval, operation and job writes an audit event
through the same transaction as the state change (or, for target-side effects,
immediately after with the outcome). See [`audit.md`](./audit.md) for event
shapes. The audit event of an apply contains the `planHash`, never the SQL text
of a migration in full (the plan holds it); it contains the migration ids and
checksums.

## 10. Edge cases

| Case | Behavior |
|---|---|
| Same plan applied twice concurrently by the same caller | One `UPDATE plans SET state='consumed' WHERE id=… AND state='active'` wins; the other returns the created operation (`alreadyAccepted`). |
| Apply request arrives 1 s before expiry, worker starts 5 s later | Expiry is checked at acceptance. Live bindings are checked again under lock. Expiry is not re-checked at execution (the plan was accepted in time). |
| Token expires between plan and apply | The apply request must carry a valid token; the client refreshes. Plan binding is to client and grant, not to the token. |
| Grant revoked while operation is `awaiting_approval` | Execution start re-checks authorization; operation is canceled with `GRANT_REVOKED`. |
| Grant revoked while operation is `running` | Running work is not interrupted mid-transaction (that could leave partial state). The audit event records the revocation; no further steps start. |
| Control Plane restarts during `running` | Lease expires, another worker reconciles (§4.2). |
| Policy configuration changed after plan creation | Policy binding re-evaluates; stricter result → `PLAN_STALE` (`policy`). |
| Approver approves an outdated plan view | Approval binds `planHash`; a different plan cannot be approved by that click. |
| Operation waits for a lock held by a long-running operation | `queued` with `waitingFor` details; the caller sees it. Lock wait has no automatic timeout in the queue; approval windows and operator cancellation bound it. |
