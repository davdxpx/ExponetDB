# Staging-before-production policy and break-glass

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 6 |
| Read before | [`verification.md`](./verification.md), [`../02-control-plane/policy-engine.md`](../02-control-plane/policy-engine.md), [`../02-control-plane/operations-engine.md` §8](../02-control-plane/operations-engine.md#8-break-glass) |
| Decision | [ADR-0012](../01-architecture/adr/0012-staging-before-production.md) |

**[OBSERVED]** REOSA's rule today: every migration goes to staging immediately;
production immediately only if compatible with the running build, otherwise after
the deploy (`REOSA/.claude/rules/migrations.md`). It is enforced by nothing but
the discipline of whoever holds the hosted provider's MCP credentials: there is
no hook, CI step, PR-template item or script (REOSA migration audit 2026-10-04).

**[DECIDED]** ExponetDB turns the rule into an engine invariant
([C-15](../00-product/constitution.md#c-15-production-requires-verified-staging-evidence)).

## 1. The evidence chain

### 1.1 Which staging counts

**[DECIDED]** Evidence relationships are configuration in the registry, not
naming conventions:

- Each **environment** of a product may name an `evidence_from` environment of the
  same product (`production.evidence_from = staging`).
- For a project `P` and a prod-tier target `P/production`, the **evidence target**
  is `P/<evidence_from>` (for example `reosa/platform/staging`).
- A project can override per environment (`evidence_override`), including the
  value `none` for projects that have no staging database. `none` is an
  admin-only, audited registry change; production plans for such a project then
  carry the permanent warning "no staging evidence by configuration" and require
  approval for every migration that is not `additive` (policy rule
  `migration.no-evidence-environment`).
- Several non-production environments (for example `preview-*`) may exist; only
  the configured evidence environment counts. Evidence from a preview database
  is not evidence.
- Chains are allowed (`production ← staging ← dev`) but each link is checked only
  against its direct predecessor.
- **[DECIDED]** ExponetDB does not assume staging and production share a server.
  Evidence is about the *target*, wherever it is placed.

### 1.2 What counts as evidence

**[DECIDED]** For a prod-tier plan containing migration `M` with apply checksum
`C` and verify digest `V`, evidence exists when **all** hold on the evidence
target `S`:

1. `S`'s ledger contains `M` with checksum `C` (not reverted).
2. `S`'s latest verification of `M` is `passed` and was run with verify digest
   `V`.
3. The evidence was produced by this installation (the ledger row's
   `operation_id` is known in the Control Store) and `S`'s identity marker is
   intact (no `TARGET_IDENTITY_MISMATCH` or `LEDGER_DIVERGENCE` open on `S`).
4. `S` has not been restored to a state *before* `M` since (generation check:
   the ledger row exists in `S`'s current generation).

**Live confirmation.** At plan time and again at apply acceptance, ExponetDB
reads `S`'s ledger and verification rows directly (observer role). If `S` is
unreachable, evidence is `unknown` and the plan is denied with
`STAGING_EVIDENCE_UNREACHABLE` (fail closed, C-11). The Control Store's evidence
record is used for display and explanation, never as a substitute for the live
read. Break-glass can override `migration.staging-evidence` in each of its forms
(unreachable, missing, unverified; see §4), but it never turns a ledger row that
fails conditions 3 or 4 into evidence.

### 1.3 Lineage (structural sameness)

Evidence says "the same change worked on staging". It does not say "production is
in the same state staging was". **[DECIDED]** The plan therefore also reports
**lineage**: whether production's current fingerprint equals staging's
`fingerprint_before` for the first migration of the plan.

- `match`: strongest evidence; after apply, production's `fingerprint_after` is
  expected to equal staging's (checked by L3, see verification.md).
- `mismatch`: the plan shows the structural diff between the two (from stored
  canonical documents). Policy decides: default **warn** for projects with
  imported legacy history (REOSA's environments are known to differ), target
  **require approval** once environments are reconciled
  ([OPEN: OD-14](../00-product/open-decisions.md#od-14-strictness-of-fingerprint-lineage-for-production)).
- `unknown`: no stored `fingerprint_before` on staging (legacy) → like mismatch.

**[OBSERVED]** REOSA's staging and production already differ structurally
(2026-09-14: 286 vs 289 tables, 343 vs 345 policies; one production policy
still on `auth.uid()` while staging has the fix; `pg_default_acl` differed in
August). A strict lineage gate on day one would block every production
migration; hence the staged default.

## 2. The production gate

```
production plan for M (checksum C, verify digest V)
        │
        ▼
evidence target configured?  ── no ──▶ (evidence_override = none) → warn + approval unless additive
        │ yes
        ▼
S reachable?  ── no ──▶ STAGING_EVIDENCE_UNREACHABLE (break-glass only)
        │ yes
        ▼
M in S's ledger with checksum C?  ── no ──▶ STAGING_EVIDENCE_MISSING (break-glass only)
        │   (M with a different checksum → MIGRATION_CHECKSUM_MISMATCH, never overridable)
        ▼ yes
latest verification of M on S passed with digest V?  ── no ──▶ STAGING_VERIFICATION_FAILED (break-glass only)
        │ yes
        ▼
dependencies of M applied AND verified on production (or earlier in this plan)?  ── no ──▶ MIGRATION_DEPENDENCY_UNVERIFIED
        │ yes
        ▼
lineage check (warn / require per OD-14)
        ▼
compatibility, lock severity, destructive, non-transactional, agent-initiated → requirements (approval, re-auth, backup)
        ▼
policy decision recorded in the plan
```

### Compatibility and the running build

REOSA's "production only after deploy" rule for non-additive migrations depends
on a fact ExponetDB cannot observe: which application build is deployed.
**[DECIDED]** For prod-tier migrations classified `potentially_breaking`,
`data_rewrite`, `destructive` or `unknown`, the required approval includes an
explicit **compatibility attestation**: the approver confirms "the running
application is compatible with this change" (and may reference a build id). The
attestation is stored with the approval and audited. A future integration may
let a deployment pipeline report the deployed build so that the attestation can
be checked mechanically ([`authoring-and-ci.md`](./authoring-and-ci.md#8-runtime-schema-contract)).

### Destructive migrations and backups

**[DECIDED]** Policy hook `migration.destructive-backup`: a prod-tier migration
classified `destructive` or `data_rewrite` requires a **verified** backup of the
target's cluster newer than 24 h (configurable), or the plan includes a
pre-migration backup step (a `backup.run` job executed and verified before the
migration starts, part of the same operation). Without the backup subsystem
(before Wave 9) such migrations require break-glass on prod tier. Optional hooks,
configured per environment: maintenance window, approval count.

## 3. Hotfixes

A hotfix is a change applied to production without staging evidence.
**[DECIDED]** It is possible only through break-glass (§4). Afterwards:

- The production ledger row is marked (via the plan's overridden rules) as
  `evidence: break_glass`.
- A finding `hotfix_without_evidence` stays open until the same migration (same
  id and checksum) has been applied and verified on staging, restoring the
  invariant "staging contains everything production contains".
- If the hotfix cannot be applied to staging as-is (staging diverged), the
  resolution is a reconciling migration on staging plus an explicit
  resolution note on the finding.

## 4. Break-glass for migrations

General break-glass mechanics are in
[`../02-control-plane/operations-engine.md` §8](../02-control-plane/operations-engine.md#8-break-glass).
Migration-specific rules:

| Overridable by break-glass | Never overridable |
|---|---|
| `migration.staging-evidence` (missing, unverified, unreachable) | `migration.checksum-consistent` |
| `migration.staging-verify-digest` | `migration.dependencies-satisfied` (missing or cyclic dependencies) |
| `migration.dependencies-verified` | forbidden statement classes |
| `migration.fingerprint-lineage` | blocking lints of class `forbidden_statement`, `dependency_cycle` |
| `migration.compatibility`, `migration.lock-risk` (the approval requirement) | target or cluster identity mismatch, ledger divergence |
| `migration.destructive-backup` | plan staleness |
| `migration.agent-production` | tier separation for AI clients (an MCP token without `migrations.apply:prod` cannot apply to prod under any grant) |

**[DECIDED]** Break-glass for migrations is **human-only**: the plan must be
created and applied by the human who holds the grant, in the Web App or the CLI,
with re-authentication. An AI agent can prepare the bundle and even a
(denied) plan; the human re-plans under break-glass. Rationale: the moment the
normal safety net is removed is the moment the decision must be unambiguously a
person's.

Every break-glass migration produces: the `bgl_` grant record with reason,
overridden rule ids and expiry; a plan carrying `overriddenRules`; a visible
banner in every interface; out-of-band notification; a post-incident review
finding.

## 5. Agents and production

**[DECIDED]** Defaults (each a policy setting the owner can change):

- AI clients may plan production migrations if their grant includes
  `migrations.plan` (planning has no side effect and is how agents explain
  readiness).
- AI clients may apply to production only with `migrations.apply:prod` in their
  grant, and every production apply initiated by an AI client requires one human
  approval in the Web App (policy rule `migration.agent-production`). The owner
  may relax this to "only non-additive" later
  ([OPEN: OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization)).
- Non-production applies by AI clients need no approval unless the migration is
  `destructive` on a target marked `protected` (for example a staging database
  that is shared by a team).

This reproduces the developer experience REOSA has today ("Claude applies to
staging immediately, and to production immediately if additive") with one added
step for production: the human tap on "Approve" in the Web App, which is also
where the plan, its evidence and its analysis are shown.

## 6. Tests

- Matrix: {evidence present, missing, other checksum, unverified, verified with
  other digest, staging unreachable, staging restored to older generation} ×
  {human, agent} × {additive, destructive} → expected decisions.
- Hotfix flow: break-glass apply, finding raised, staging apply clears it.
- Evidence spoofing: ledger row on staging inserted by hand (unknown
  `operation_id`) is not evidence (and raises `LEDGER_DIVERGENCE`).
- Configuration change of `evidence_from` invalidates active plans (policy
  binding).
