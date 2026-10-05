# Policy Engine

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 2 (framework), Wave 3 (authorization integration), Wave 6 (migration rules), Wave 9 (backup/restore rules) |
| Read before | [`operations-engine.md`](./operations-engine.md), [`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md) |

## 1. Why a central policy engine

**[DECIDED]** ExponetDB has a central, server-side Policy Engine. It answers one
question for a plan: *given who is asking, through which client, for what, on
which target, under the current facts, is this allowed, and under which
conditions?*

Reasons:

- Rules such as "production requires staging evidence" and "destructive
  production migrations require a recent verified backup" must apply identically
  to the Web App, REST, CLI and MCP (C-9, C-10). If they lived in handlers, each
  interface would have its own copy.
- Decisions must be explainable to agents (which rule, which fact) and recorded
  in plans (which version of which rules produced the decision).
- Agents read tool descriptions; they must never be the place where a rule
  lives (C-10).

**[DECIDED]** It is deliberately **not** a general policy language (no Rego, no
Cedar) in V1. Rules are TypeScript functions in `packages/policy`, reviewed like
code, tested like code, parameterized by configuration stored in the Control
Store. Reason: a handful of well-understood rules, one team, and the need to
evaluate facts that come from domain packages (evidence records, backup
catalog). A policy language adds a second system to secure and test without
adding expressiveness we need now. If ExponetDB later needs tenant-authored
policies, that is a new ADR.

## 2. Position in the request flow

```
request ─▶ authentication ─▶ RBAC + scope check ─▶ operation kind: inspect, plan ─▶ POLICY ─▶ plan stored
                 (identity)        (authorization.md)                                 │
                                                                                      ▼
                                                                  decision + rule results + requirements
apply(planId) ─▶ authentication ─▶ RBAC + scope re-check ─▶ POLICY re-evaluated ─▶ compare with plan ─▶ operation
```

Authorization (RBAC + scopes + grant restrictions) answers "may this principal
ever do this kind of thing here?". Policy answers "under the current facts, may
this specific change happen now, and what must happen first?". Both must pass.
A principal without `migrations.apply` never reaches the policy rules.

## 3. Decision model

```ts
type PolicyDecision = {
  decision: "allow" | "require" | "deny"
  requirements: Requirement[]           // empty unless decision = "require"
  rules: RuleResult[]                    // every evaluated rule, in order
  overriddenRules: string[]              // rule ids overridden by break-glass
  policyVersion: string                  // sha256 over rule code version + effective configuration
  evaluatedAt: string
}

type RuleResult = {
  id: string                             // "migration.staging-evidence"
  result: "pass" | "fail" | "not_applicable" | "unknown"
  severity: "deny" | "require" | "warn"
  message: string                        // human readable, no secrets
  facts: Record<string, unknown>         // the inputs used, e.g. evidence ids
  remediation?: string                   // what would make it pass
  overridableByBreakGlass: boolean
}

type Requirement =
  | { kind: "approval"; count: number; permission: "plans.approve" }
  | { kind: "reauth"; withinSeconds: number }
  | { kind: "backup"; newerThan: string /* ISO 8601 duration */; verified: true }
  | { kind: "maintenance_window"; windowId: string }
  | { kind: "break_glass"; rules: string[] }
```

Combination: any `fail` with severity `deny` and not overridden → `deny`. Else any
`fail` with severity `require` → `require` with the union of requirements. Else
`allow`. A rule that returns `unknown` is treated as `fail` at its severity
([C-11](../00-product/constitution.md#c-11-unknown-safety-state-fails-closed-for-writes)).
`warn` results never block; they are shown in the plan.

## 4. Rule catalog (V1)

**[DECIDED]** for structure, **[PLANNED]** for exact thresholds (set in the
wave that implements the kind; defaults below).

### Migrations ([`../04-migrations/staging-production-policy.md`](../04-migrations/staging-production-policy.md))

| Rule id | Applies to | Severity | Default |
|---|---|---|---|
| `migration.checksum-consistent` | all | deny, not overridable | id must not exist with another checksum in any ledger of the project or in the bundle store |
| `migration.dependencies-satisfied` | all | deny, not overridable | all `dependsOn` applied (and verified, see next) on the target or included earlier in the same plan |
| `migration.dependencies-verified` | prod tier | require (break-glass) | dependencies are verified, not only applied |
| `migration.staging-evidence` | prod tier | deny (break-glass overridable) | identical checksum applied **and verified** on the evidence environment's target |
| `migration.staging-verify-digest` | prod tier | require (break-glass) | staging verification used the same `verify.sql` digest the production run will use |
| `migration.fingerprint-lineage` | prod tier | warn → require ([OPEN: OD-14](../00-product/open-decisions.md#od-14-strictness-of-fingerprint-lineage-for-production)) | production's current fingerprint equals staging's `fingerprint_before` for this migration |
| `migration.compatibility` | prod tier | require approval when class ∈ {`potentially_breaking`, `data_rewrite`, `destructive`, `unknown`} | |
| `migration.destructive-backup` | prod tier, class `destructive` or `data_rewrite` | require backup | verified backup newer than 24 h, or a pre-migration backup taken as part of the plan |
| `migration.lock-risk` | prod tier | require approval when severity ∈ {`high`, `critical`, `unknown`} | |
| `migration.nontransactional` | prod tier, `transactional: false` | require approval + reauth | |
| `migration.lint-errors` | all | deny (not overridable for `error` level lints marked `blocking`) | see analysis.md |
| `migration.agent-production` | prod tier, actor client is an AI agent | require approval ([OPEN: OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization)) | default: approval required for every production apply initiated by an agent client, until the owner relaxes it to "only non-additive" |
| `migration.pg-version` | all | deny | `requires.postgres` satisfied by the target's server version |
| `migration.extensions` | all | deny | `requires.extensions` installed in the required versions |

### Connections

| Rule id | Severity | Default |
|---|---|---|
| `connections.no-superuser-terminate` | deny, not overridable | ExponetDB never terminates superuser backends or its own ledger-holding sessions |
| `connections.prod-terminate-approval` | require | terminating a backend on prod tier from an agent client requires approval; human with re-auth may proceed |
| `connections.replication-protect` | deny (break-glass) | never terminate walsender / replication or backup sessions |

### Node and cluster

| Rule id | Severity | Default |
|---|---|---|
| `cluster.restart-window` | require maintenance window or approval | restart of a prod-tier cluster outside a configured window |
| `cluster.restart-replication` | warn | restart while a backup is running |
| `cluster.config-restart-required` | require approval | config change needs restart on prod tier |
| `node.packages-postgres-major` | deny | package plans never change the PostgreSQL major version (major upgrade is its own future kind) |
| `node.agent-version` | deny | capability requires a newer agent than enrolled |

### Backup and restore

| Rule id | Severity | Default |
|---|---|---|
| `restore.target-identity` | deny, not overridable | the destination is explicit (scratch, or a named new target or cluster) with identity and tier in the plan; restoring over a running registered cluster is refused in V1; recovery reaches a prod target only through a `critical` placement move |
| `restore.source-verified` | require (break-glass) | the backup was verified |
| `restore.human-only` | deny | actor must be human in V1; the only exception is a scheduled drill into scratch, run by the system actor under the approved backup policy |
| `backup.repository-healthy` | deny | repository reachable and writable |
| `restore.clone-masking` | deny (break-glass) | a clone of prod-tier data into a nonprod target needs a masking profile or a recorded human decision with expiry |

### Access

| Rule id | Severity | Default |
|---|---|---|
| `access.no-self-escalation` | deny | an identity cannot grant itself a role or scope it does not hold |
| `access.mcp-ineligible-scopes` | deny | admin scopes cannot be granted to OAuth clients of kind `mcp` |
| `access.last-admin` | deny | the last active admin cannot be removed or demoted |

## 5. Policy configuration

**[DECIDED]** Configuration (thresholds, which environment is the evidence
environment, maintenance windows, whether agent production applies need
approval) lives in the Control Store, at product, project, environment or target
level, with the most specific level winning. Changing policy configuration is
itself an `access.*`-class operation: planned, admin-only, audited. Policy
configuration is never set by environment variables (P-12).

`policyVersion` is computed from the deployed rule code version (package version
+ git commit of the server build) and the hash of the effective configuration
for the subject. A plan records it. At apply, the engine re-evaluates and compares:

- same decision class and requirements met → proceed
- stricter result → `PLAN_STALE` (binding `policy`)
- more permissive result → proceed with the plan's (stricter) requirements; a
  plan never becomes more permissive after the fact

## 6. Hooks

**[DECIDED]** Rules obtain facts through typed fact providers, not by querying
arbitrary tables:

| Fact provider | Supplies | Owner package |
|---|---|---|
| `evidence` | verified applications of a migration on other targets | migrations |
| `ledger` | current ledger of the target, mismatches | migrations |
| `backups` | latest verified backup per cluster/target, repository health | backups |
| `windows` | maintenance windows | policy |
| `analysis` | compatibility, lock, lint results of the plan | migrations / kind |
| `principal` | identity kind, client kind (`web`, `cli`, `mcp`, `ci`), re-auth time | auth |
| `target` | tier, state, placement, cluster health | registry, diagnostics |

A rule declares which providers it needs; a missing provider result is
`unknown`, which fails closed.

## 7. Testing

- Each rule has table-driven unit tests for pass, fail, not applicable and
  unknown.
- A policy matrix test runs every operation kind through every interface
  (Web App session, REST token, MCP token, CLI) with the same fixture and asserts
  identical decisions (C-9).
- Adversarial tests: a plan created under permissive configuration, then
  configuration tightened, apply must be stale; break-glass for rule A must not
  satisfy rule B; an AI client token can never carry a break-glass override.
