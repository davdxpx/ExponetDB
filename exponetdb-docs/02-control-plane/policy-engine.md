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

**[DECIDED]** (Wave 6, `packages/policy/src/catalog/migrations.ts`) The rules
read `content.facts` of the stored plan, which the planner establishes from the
stored bundles, the live target and the live evidence target; a missing or
malformed fact is `unknown`. The structural conditions of the first two rows
(`checksum-consistent`, `dependencies-satisfied`) are refusals of the planner
and of the kind's bindings (`MIGRATION_CHECKSUM_MISMATCH`,
`MIGRATION_DEPENDENCY_MISSING`, `PLAN_STALE`), never a stored plan a break-glass
grant could override.

| Rule id | Applies to | Severity | Default |
|---|---|---|---|
| `migration.checksum-consistent` | all | deny, not overridable | id must not exist with another checksum in any ledger of the project or in the bundle store |
| `migration.dependencies-satisfied` | all | deny, not overridable | all `dependsOn` applied (and verified, see next) on the target or included earlier in the same plan |
| `migration.dependencies-verified` | prod tier | require (break-glass) | dependencies are verified, not only applied |
| `migration.staging-evidence` | prod tier | deny (break-glass overridable) | identical checksum applied **and verified** on the evidence environment's target |
| `migration.staging-verify-digest` | prod tier | require (break-glass) | staging verification used the same `verify.sql` digest the production run will use |
| `migration.fingerprint-lineage` | prod tier | warn for imported legacy projects, require approval after reconciliation (**[DECIDED]** [OD-14](../00-product/open-decisions.md#od-14-strictness-of-fingerprint-lineage-for-production) (a), 2026-10-12) | production's current fingerprint equals staging's `fingerprint_before` for this migration |
| `migration.compatibility` | prod tier | require approval when class ∈ {`potentially_breaking`, `data_rewrite`, `destructive`, `unknown`} | |
| `migration.destructive-backup` | prod tier, class `destructive`, `data_rewrite` or `unknown` | require backup | verified backup newer than 24 h, or a pre-migration backup taken as part of the plan |
| `migration.lock-risk` | prod tier | require approval when severity ∈ {`high`, `critical`, `unknown`} | |
| `migration.nontransactional` | prod tier, `transactional: false`; `migration.apply` and `migration.resume` | require approval + reauth | |
| `migration.lint-errors` | all | deny (not overridable for `error` level lints marked `blocking`) | see analysis.md |
| `migration.agent-production` | prod tier, actor client is an AI agent | require approval ([OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization), resolved: the human may approve the plan an agent proposed on their behalf) | default: approval required for every production apply initiated by an agent client, until the owner relaxes it to "only non-additive" |
| ~~`migration.no-evidence-environment`~~ | withdrawn (Wave 6) | — | **[DECIDED]** no evidence bypass (C-15): a production target without an evidence target has no evidence and `migration.staging-evidence` denies; see [`../04-migrations/staging-production-policy.md` §1.1](../04-migrations/staging-production-policy.md#11-which-staging-counts) |
| `migration.execution-role` | all | deny | every execution role alias maps (registry) to a usable `NOLOGIN` owner the migrator may `SET ROLE` into ([`../03-database-model/credentials-and-roles.md` §3](../03-database-model/credentials-and-roles.md#3-execution-roles-who-owns-application-objects)) |
| `migration.fingerprint-lineage-legacy` | prod tier, imported legacy project | warn | the OD-14 (a) warning for imported legacy histories (the require part is `migration.fingerprint-lineage`) |
| `migration.pg-version` | all | deny | `requires.postgres` satisfied by the target's server version |
| `migration.extensions` | all | deny | `requires.extensions` installed in the required versions |
| `migration.verify-consumer-code` | all tiers; `migration.apply` and `migration.verify` | require approval | `verify.sql` contains declared checks that call a consumer function or read a consumer view ([`../04-migrations/verification.md` §4.2](../04-migrations/verification.md#42-admission-plan-time)); the owner may relax it for nonprod |
| `migration.rollback-production` | prod tier, `migration.rollback` | require approval + reauth (300 s) | an explicit rollback plan runs `down.sql` on production only after a human approval; `lossy`/`unsafe` rollbacks are `critical` and also meet `migration.destructive-backup` ([`../04-migrations/failure-and-recovery.md` §3](../04-migrations/failure-and-recovery.md#3-downsql)) |
| `migration.baseline-production` | prod tier, `migration.baseline` | require approval + reauth (300 s) | recording reviewed legacy history as applied on production ([`../04-migrations/legacy-import.md` §2.2](../04-migrations/legacy-import.md#22-wave-6-implementation)) |

**[DECIDED]** Wave 6 scope of the rules: `migration.lint-errors`,
`migration.execution-role`, `migration.destructive-backup`,
`migration.lock-risk` and `migration.agent-production` apply to every kind that
runs reviewed bundle SQL (`migration.apply`, `migration.rollback`,
`migration.resume`); the
evidence, lineage, dependency and compatibility rules to `migration.apply`
only.

### Connections

| Rule id | Severity | Default |
|---|---|---|
| `connections.no-superuser-terminate` | deny, not overridable | ExponetDB never terminates superuser backends or its own ledger-holding sessions |
| `connections.prod-terminate-approval` | require | terminating a backend on prod tier from an agent client requires approval; human with re-auth may proceed |
| `connections.replication-protect` | deny (break-glass) | never terminate walsender / replication or backup sessions |

### Data reads

| Rule id | Applies to | Severity | Default |
|---|---|---|---|
| `data.read` | `query.run`, `query.explain` | deny, not overridable | `mode: by_tier`, `sensitiveColumns: []` |

**[DECIDED]** (Wave 7, [ADR-0028](../01-architecture/adr/0028-data-read-lane.md),
[OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production) option a; `packages/policy/src/catalog/data.ts`)
Who may read rows of a target, as a rule setting in `policy.rule_settings`
(installation → product → project → environment → target, the most
specific wins; changed by a policy settings plan, the frozen registry
untouched). `mode` is `by_tier` (people read every tier, agents only
`nonprod`; an unknown tier counts as production), `enabled`, `humans_only`
(agents read no rows) or `disabled` (nobody does). An agent is every caller
that is not a person through the Web App or the first-party CLI: an MCP
client, a service account, an API key, CI. No scope lifts the rule:
`data.read:prod` on a `humans_only` target is still refused
(`DATA_READ_NOT_PERMITTED`). `sensitiveColumns` lists patterns
`schema.table.column` (`*` matches a name part, at most 256) whose values
are masked for callers without `data.read_sensitive`, which no MCP client
holds; the rule reports the effective list in its facts, so the read path
masks with the setting the decision used. An invalid setting is `unknown`
and refuses (fail closed). EXPLAIN without ANALYZE is under the rule too,
because a plan can carry constants of rows; its expressions are redacted
before they are returned ([`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md)).

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

**[DECIDED]** (Wave 5 correction F2, `packages/policy/src/catalog/nodes.ts`)
`node.prod-apply-approval` as implemented: severity `require`, not
overridable, parameter `approvals` (default 1, 1 to 10), version 1. It
applies to every apply of the Wave 5 catalog on a node or cluster:
`postgres.config.apply`, `postgres.reload`, `postgres.restart`,
`postgres.hba.apply`, `postgres.roles.apply`, `postgres.extensions.apply`,
`postgres.tls.rotate`, `credential.rotate` and `node.config.update`
(`NODE_APPLY_KINDS`; a unit test checks it against the action catalog).
`prod` fails (an approval is required), `nonprod` is not applicable, an
unknown tier is `unknown` and requires the same approval. A class of `high`
or `critical` and a re-authentication are no substitute for it. The tier is
the derived tier of the affected cluster (for `node.config.update` and a
host `node.inspect`, of the node's server), read from the registry when the
plan is made, again at acceptance and again before the worker starts the
operation (`livePolicySubject`; operations-engine.md §4.2). Not under the
rule: `node.inspect` (a read) and the node lifecycle kinds `node.enroll`,
`node.revoke` and `node.decommission`, which change the registry's trust in
a node rather than the host, stay human-only with a fresh re-authentication,
and must stay fast when a node is compromised (revoke). `packages.apply_update`
is not in Wave 5. The other node rules of the table above are
**[PLANNED]** with their kinds' waves.

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

**[DECIDED]** (Wave 3A, `packages/policy/src/catalog/access.ts`.) The access
rules as implemented. They read the `access` fact, which `packages/auth`
computes from the Control Store for the change at hand (the policy package
queries nothing); a missing or malformed fact is `unknown` and denies.

| Rule id | Applies to | Severity | Rule |
|---|---|---|---|
| `access.no-self-escalation` | `access.role_binding.create` | deny, not overridable | no binding for oneself; every permission of the granted role must be held by the actor at a scope that covers the binding scope (without the registry, only `global` or the identical scope covers: conservative) |
| `access.owner-only` | role binding create and delete, identity disable, enable, erase | deny, not overridable | granting or removing `owner`, and disabling, enabling or erasing an owner, needs an owner |
| `access.last-owner` | role binding delete, identity disable, erase | deny, not overridable | never removes the last active owner (the Control Store enforces it too, under a lock, against concurrent requests); it replaces `access.last-admin`, whose intent it is: `owner` is the role that cannot run out |
| `access.policy-safety` | `access.policy_settings.update` | deny, not overridable | a non-owner may only tighten; a change whose direction is not known to be a tightening is treated as lowering safety (order §41: unknown is not safe to relax). Known directions exist only where a comparator is written (`approval.self-approval`: `allowed` true → false and a longer `criticalCoolingSeconds` tighten) |
| `access.erase-approval` | `access.identity.erase` | require approval (`approvals`, default 1) | erasure destroys data that cannot be restored |
| `approval.self-approval` | `approval.approve` | deny, not overridable | OD-9: a self-approval is allowed when `allowed` (default true); `criticalCoolingSeconds` (default 600) is the cooling period of a `critical` self-approval |

**[DECIDED]** (Wave 3B) `access.mcp-ineligible-scopes` is an invariant,
not a configurable rule in the `pv1` registry: it is never overridable and
granting delegated authority is an inline security change, not a plan, so
no policy evaluation would run on it. It holds in three places that agree:
the scope catalog (`mcpGrantable`, `clientKinds` in
`packages/contracts/src/scopes.ts`), the authorization server and the central
engine (an `mcp` client is never offered, consented, issued, refreshed or
authorized such a scope) and the database guard (`oauth.scopes_holdable`
refuses the grant row). The same holds for the delegation side of
`access.no-self-escalation`: consent and machine grants never exceed what
the creator holds now (`SCOPE_NOT_DELEGABLE`), checked by the application and
by the database.

**[DECIDED]** (G3B final hardening, 2026-10-06) Two further invariants of
the same kind, never configurable: a client of kind `mcp` holds the MCP
resource only (`RESOURCES_BY_CLIENT_KIND`, the engine, the bearer
authentication and the `oauth.grants` check), and the device authorization
grant never carries a scope whose contract says `explicitConsent`
(`isDeviceFlowScope`, the device endpoint and the device-code guard with
`oauth.scopes.explicit_consent`).

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

**[DECIDED]** (Wave 7, OD-13 (a)) A policy-settings plan
(`POST /policy-settings/plans`, kind `access.policy_settings.update`)
names the scope `installation` or, since Wave 7, `target` with a
registered target's id; product, project and environment settings are not
planned yet. For a target setting, the effective parameters before and
after include what the target inherits from the installation, so
`access.policy-safety` judges the change against what applies there. A
rule may check its parameters beyond their JSON types (`checkParams`):
`data.read` refuses an unknown mode or a malformed column pattern when the
plan is made. `access.policy-safety` knows the direction of
`approval.self-approval` and of `data.read` (`disabled` > `humans_only` >
`by_tier` > `enabled`; removing a masked column loosens); any other change
counts as lowering safety, which only an owner may plan.

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
| `access` | for one access change: whether the actor is an owner, the target identity, the role, permissions the actor does not hold at a covering scope, active owners, whether an owner is removed, whether a policy change lowers safety (Wave 3A) | auth |
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
