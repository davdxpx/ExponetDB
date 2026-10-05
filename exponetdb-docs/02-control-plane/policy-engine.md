# Policy Engine

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 framework (§3, §5.1, §5.2, §6) accepted with G2 on 2026-10-05 |
| Applies to | Wave 2 (framework), Wave 3A (authorization integration), Wave 6 (migration rules), Wave 9 (backup/restore rules) |
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

**[DECIDED]** (Wave 2, `packages/policy`) Details of the implementation:

- Rules are evaluated in rule id order; the decision, the requirements (a
  deduplicated union in canonical order) and the policy version do not depend
  on registration order or on the order in which facts arrive (property
  tests).
- `unknown` comes from a missing, failing or malformed fact provider, an
  invalid configuration, a rule that throws, and a malformed rule result.
  A blocking `require` result whose requirements cannot be computed denies:
  a requirement can never be dropped by an error.
- Break-glass: a grant overrides exactly the rules it names that are
  `overridableByBreakGlass`, and only for a human actor through a non-agent
  client (an MCP client's request never overrides anything). An override is
  never silent: the overridden rules are listed and the decision requires
  `{kind: "break_glass", rules}`, so apply re-checks the grant. There is no
  other override and no force flag.
- Rule definitions are checked when the registry is built (id grammar,
  version ≥ 1, kinds, a `require` rule must state requirements and only a
  `require` rule may): a broken rule fails startup, not a decision.
- Re-check at apply (`recheckDecision`): a stricter decision or an added
  requirement is stale; otherwise apply proceeds with the plan's
  requirements.
- Wave 2 ships the framework and no catalog rules; each later wave registers
  the rules of the kinds it implements.

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
| `migration.destructive-backup` | prod tier, class `destructive`, `data_rewrite` or `unknown` | require backup | verified backup newer than 24 h, or a pre-migration backup taken as part of the plan |
| `migration.lock-risk` | prod tier | require approval when severity ∈ {`high`, `critical`, `unknown`} | |
| `migration.nontransactional` | prod tier, `transactional: false` | require approval + reauth | |
| `migration.lint-errors` | all | deny (not overridable for `error` level lints marked `blocking`) | see analysis.md |
| `migration.agent-production` | prod tier, actor client is an AI agent | require approval ([OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization), resolved: the human may approve the plan an agent proposed on their behalf) | default: approval required for every production apply initiated by an agent client, until the owner relaxes it to "only non-additive" |
| `migration.no-evidence-environment` | prod tier, project with `evidence_override: none` | require approval unless class `additive`; permanent warning | see [`../04-migrations/staging-production-policy.md` §1.1](../04-migrations/staging-production-policy.md#11-which-staging-counts) |
| `migration.pg-version` | all | deny | `requires.postgres` satisfied by the target's server version |
| `migration.extensions` | all | deny | `requires.extensions` installed in the required versions |
| `migration.verify-consumer-code` | all tiers | require approval | `verify.sql` contains declared checks that call a consumer function or read a consumer view ([`../04-migrations/verification.md` §4.2](../04-migrations/verification.md#42-admission-plan-time)); the owner may relax it for nonprod |

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
| `node.prod-apply-approval` | require approval | every node or cluster apply on a prod-tier node or cluster (configuration, roles, `pg_hba`, TLS, extensions, packages); reload-only configuration changes are class `standard` but still need this approval on prod tier |
| `node.packages-soak` | require (break-glass) | a PostgreSQL minor version or extension package version must have run on the evidence environment's cluster for at least 3 days before a prod-tier update; security releases go through break-glass |

### Registry and drift

| Rule id | Severity | Default |
|---|---|---|
| `target.register-prod-approval` | require approval + reauth | registering a prod-tier target (identity stamp and ledger initialization) |
| `drift.accept-prod` | require approval + reauth | accepting drift on a prod-tier target (`drift.accept`); security-relevant drift classes also require a reason |

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

### 5.1 Policy version `pv1`

**[DECIDED]** (Wave 2) A stored value (plans, approvals, audit `decision`
member); a change of the construction is `pv2`. Golden vectors:
`tooling/golden/policy-version.json`.

```
input = UTF8("exponetdb/policy-version/pv1") LF
      + frame("code",   UTF8(codeVersion))
      + frame("rules",  UTF8(JCS(rules sorted by id)))
      + frame("config", UTF8(JCS(config)))
frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
policyVersion = "sha256:pv1:" + lowercase hex(SHA-256(input))
```

- `codeVersion` is the server build, `<package version>+<commit>`
  (`[0-9A-Za-z.+-]`, 1 to 128 characters).
- `rules` lists `{"id", "version"}` of every rule that applied to the
  request; a rule's `version` is bumped when its semantics change.
- `config` has exactly one member per listed rule: its effective parameters
  (an object), after resolution (§5.2).
- Refusals, in this order: `invalid_code_version`, `invalid_rule`,
  `duplicate_rule`, `config_mismatch`.

### 5.2 Configuration storage

**[DECIDED]** (Wave 2) `policy.rule_settings` holds append-only revisions per
`(scope_kind, scope_id, rule_id)`: scope kinds `installation`, `product`,
`project`, `environment`, `target`, each with an id of its kind; revisions
follow each other (`EXP01`); the database records the writing login. Only
`exdb_worker` may insert (the planned operation that changes settings runs
there); `exdb_serve` and `exdb_worker` read; nobody updates or deletes.
Resolution: the latest revision per level; per parameter, the most specific
level wins; a setting may set only parameters the rule declares, with the JSON
type of the default, else the rule is `unknown` for that subject.
Maintenance windows (`windows` facts) are **[PLANNED]** with the first rule that
needs them.

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
