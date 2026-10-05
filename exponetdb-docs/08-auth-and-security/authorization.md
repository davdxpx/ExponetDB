# Authorization: RBAC, scopes, tiers

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 3A (permissions, roles, bindings, tiers, client kinds), Wave 3B (scopes, grants), every wave (permissions of new actions) |
| Read before | [`identity.md`](./identity.md), [`../02-control-plane/policy-engine.md`](../02-control-plane/policy-engine.md) |

## 1. The effective-permission formula

**[DECIDED]** An action on a subject is permitted only if **all** hold:

```
allowed(action, subject) =
      rbac(identity)           ∋ permission(action)          at a scope covering subject
  AND scopes(token or session) ∋ scope(action, tier(subject))           (sessions carry all scopes of the identity)
  AND grant.targets            ∋ subject                     (OAuth grants and API keys may restrict targets)
  AND grant.tiers              ∋ tier(subject)
  AND clientKind               ∈ allowedClientKinds(action)  (e.g. approvals: web session only)
  AND policy(action, subject, facts) = allow, or = require with every requirement satisfied
```

Then the Operations Engine applies the plan bindings. Every check fails closed:
an unknown permission, an unresolvable subject, a missing tier, an error while
loading a grant all deny.

Two phases (pattern adopted from REOSA's console resolver):

1. **Before input parsing**: is the identity allowed this *kind* of action at all
   (permission exists at any scope, scope present in the token)? Cheap; rejects
   most unauthorized calls before untrusted input is parsed.
2. **After the subject is resolved**: scope coverage, tier, grant restrictions,
   client kind, then policy.

### 1.1 The central engine (Wave 3A)

**[DECIDED]** (Wave 3A, `packages/auth/src/authorization/`.) One engine
decides for every interface; handlers never compare permissions, scopes or
times themselves.

- **Principal.** A Web App session authenticates a `human` principal with
  client kind `web`. `cli`, `mcp`, `ci` and `service` principals are
  modeled (the matrix tests cover them) but no credential authenticates
  them before Wave 3B. An anonymous caller reaches only `public` ceremony
  actions.
- **Phase 1** (before input is parsed): the action exists; the client kind
  is allowed for it; the human-only rule holds (`human` through `web` or
  `cli`); the action's scope is usable by this client kind; a recovery
  session (after a recovery code) only reaches `me.get`, its sessions and
  factors, sign-out, re-authentication and setting up factors; the identity
  holds the permission at some scope. Grants are read fresh from the
  Control Store for every request; nothing is cached in a session.
- **Phase 2** (after the server resolved the subject): the permission holds
  at a scope that structurally covers the subject; where the tier matters
  it is known (an unresolvable subject or tier denies, never "global"); a
  tiered scope `<permission>:<tier>` exists for that tier and client kind;
  a `self` action acts on the caller's own identity; the action's
  re-authentication window is met by a passkey or TOTP proof of this
  session on the database clock.
- **Policy** runs last and can only take away: `deny` or an evaluation
  error denies, a `reauth` requirement is met by a fresh proof of the
  session, anything else remains as `require` (an approval is then given
  through the approval flow). The result is structured `allow`,
  `require` or `deny` with a reason.
- **Sessions and scopes.** A Web App session is no OAuth grant: it has no
  target or tier restriction of its own and carries the session scope
  `api`, which is **not** a wildcard. It only admits the Web App to the
  self-service actions; every other action still needs its permission at a
  covering scope, so "session has `api`" never allows anything by itself.
- **Subject resolution** is a port (`AuthorizationSubjectResolver`): Wave 3A
  resolves installation-wide subjects (identities, roles, policy settings,
  the approval queue) and plans with the tier recorded at planning; targets
  need the registry and are refused until Wave 4 supplies it. Coverage:
  `global` ⊇ everything; `product:P`, `project:J`, `environment:E` and
  `target:T` cover subjects whose chain contains that id; installation-wide
  subjects are covered by `global` bindings only.
- **No owner bypass.** `owner` passes because its role lists every
  permission; client kind, human-only, re-authentication, policy, plan
  bindings and tier still apply to it.

## 2. Permissions

**[DECIDED]** Permissions are `<domain>.<verb>`, defined in
`packages/contracts/permissions`. There are no wildcards at runtime: a role lists
its permissions explicitly, and a new permission is never granted implicitly.

| Permission | Covers |
|---|---|
| `targets.read` | list/get targets, environments, projects |
| `schema.read` | inspect schema, fingerprints, diffs, drift checks |
| `schema.manage` | accept drift (`drift.accept`) |
| `diagnostics.read` | health, sessions (redacted), locks, statistics, advisors |
| `diagnostics.read_sensitive` | raw statements, error details (human only) |
| `data.read` | read-only queries |
| `data.read_sensitive` | unmasked sensitive columns |
| `migrations.read` | ledger, status, lint |
| `migrations.plan` | create migration plans, rollback plans |
| `migrations.apply` | apply migration plans, re-verify |
| `migrations.import` | legacy import analysis, review, baseline, ledger reconcile |
| `connections.operate` | cancel/terminate backends |
| `backups.read` | backup catalog, drills |
| `backups.run` | run/verify backups |
| `restore.plan` | plan restores and drills |
| `restore.execute` | apply restore plans (human only) |
| `nodes.read` | nodes, clusters, host metrics |
| `nodes.plan` | plan node/cluster operations |
| `nodes.operate` | apply node/cluster plans |
| `plans.approve` | approve plans (human only, Web App) |
| `operations.recover` | force recovery of the Operations Engine's own state: `operation.force_release` releases a lock domain held by a lost worker (human only, re-authentication) |
| `breakglass.activate` | activate break-glass (human only) |
| `audit.read` | audit events |
| `registry.manage` | registry writes, enrollment tokens, credentials submission |
| `access.read` | view identities, roles, clients, grants |
| `access.manage` | manage identities, role bindings, clients, API keys |
| `policy.manage` | change policy configuration |

## 3. Roles

**[DECIDED]** Built-in roles (V1); custom roles are **[PLANNED]** later with the
REOSA-proven rules (only catalog permissions, never more than the creator holds,
destructive/owner-only permissions excluded).

| Role | Permissions (summary) | Intended for |
|---|---|---|
| `owner` | everything, including `breakglass.activate`, `policy.manage`, `access.manage` | the product owner (at least one, at most a few) |
| `admin` | everything except `policy.manage` changes that lower safety and except removing owners | trusted platform engineers |
| `operator` | read all; `connections.operate`; `nodes.plan`/`nodes.operate`; `backups.*`; `restore.plan`; `plans.approve`; `migrations.*` except import | on-call |
| `developer` | read all except sensitive; `data.read` (nonprod by binding scope); `migrations.read/plan/apply` (bound to nonprod targets or projects) | engineers, and the identities behind AI agents |
| `viewer` | `targets.read`, `schema.read`, `diagnostics.read`, `migrations.read`, `backups.read`, `nodes.read` | read-only users |
| `auditor` | `audit.read`, `access.read`, all `*.read` without `data.read` | reviews |

**[DECIDED]** (pre-G1, 2026-10-05) `operations.recover` was added after this
table was written. It is assigned to roles in Wave 3A; none of the summaries
above grants it implicitly, and until then no role holds it.

### 3.1 The built-in role matrix (Wave 3A)

**[DECIDED]** (Wave 3A, `packages/contracts/src/roles.ts`, seeded into the
Control Store by the bundle `access-control`.) Each role lists its
permissions explicitly; nothing is derived from the catalog, there is no
wildcard, prefix or "all", and a permission added to the catalog is held by
no role until a reviewed change adds it here, in the code and in a new
Control Store bundle. The summaries above are resolved security-first:
`admin` lacks `breakglass.activate` (overriding safety policy stays an owner
power); `operator` gets the metadata reads and `audit.read` but no data or
sensitive reads and no access or policy management; `developer` reaches
production only through the scope of its bindings; `auditor` never holds
`data.read`. `operations.recover` goes to `owner`, `admin` and `operator`
(on-call force-release; human only, re-authentication). Owner-only
changes (granting or removing `owner`, disabling or erasing an owner,
safety-lowering policy changes) are refused by policy rules, not by a
missing permission ([`../02-control-plane/policy-engine.md`](../02-control-plane/policy-engine.md)).
A test keeps this table, the code and the seeded rows equal.

| Permission | owner | admin | operator | developer | viewer | auditor |
|---|---|---|---|---|---|---|
| `targets.read` | yes | yes | yes | yes | yes | yes |
| `schema.read` | yes | yes | yes | yes | yes | yes |
| `schema.manage` | yes | yes | — | — | — | — |
| `diagnostics.read` | yes | yes | yes | yes | yes | yes |
| `diagnostics.read_sensitive` | yes | yes | — | — | — | — |
| `data.read` | yes | yes | — | yes | — | — |
| `data.read_sensitive` | yes | yes | — | — | — | — |
| `migrations.read` | yes | yes | yes | yes | yes | yes |
| `migrations.plan` | yes | yes | yes | yes | — | — |
| `migrations.apply` | yes | yes | yes | yes | — | — |
| `migrations.import` | yes | yes | — | — | — | — |
| `connections.operate` | yes | yes | yes | — | — | — |
| `backups.read` | yes | yes | yes | yes | yes | yes |
| `backups.run` | yes | yes | yes | — | — | — |
| `restore.plan` | yes | yes | yes | — | — | — |
| `restore.execute` | yes | yes | — | — | — | — |
| `nodes.read` | yes | yes | yes | yes | yes | yes |
| `nodes.plan` | yes | yes | yes | — | — | — |
| `nodes.operate` | yes | yes | yes | — | — | — |
| `plans.approve` | yes | yes | yes | — | — | — |
| `operations.recover` | yes | yes | yes | — | — | — |
| `breakglass.activate` | yes | — | — | — | — | — |
| `audit.read` | yes | yes | yes | — | — | yes |
| `registry.manage` | yes | yes | — | — | — | — |
| `access.read` | yes | yes | — | — | — | yes |
| `access.manage` | yes | yes | — | — | — | — |
| `policy.manage` | yes | yes | — | — | — | — |

**Role bindings** attach a role to an identity at a **scope**: `global`,
`product:<id>`, `project:<id>`, `target:<id>`, or `environment:<product>/<env>`
(the last is how "developer on all non-production environments of reosa" is
expressed). Bindings are planned operations (`access.*`) with re-authentication.

## 4. OAuth scopes

**[DECIDED]** Scopes are what a **client** may do on the identity's behalf. They
are coarser than permissions and carry the **tier** for actions where production
matters ([C-24](../00-product/constitution.md#c-24-production-is-its-own-authorization-tier)).

| Scope | Needs permission | MCP-grantable | Notes |
|---|---|---|---|
| `targets.read` | `targets.read` | yes | baseline |
| `schema.read` | `schema.read` | yes | baseline |
| `diagnostics.read` | `diagnostics.read` | yes | baseline; statements redacted |
| `data.read:nonprod` | `data.read` | yes | |
| `data.read:prod` | `data.read` | yes, but policy default `humans_only` on prod targets ([OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production)) | |
| `migrations.read` | `migrations.read` | yes | |
| `migrations.plan` | `migrations.plan` | yes | |
| `migrations.apply:nonprod` | `migrations.apply` | yes | |
| `migrations.apply:prod` | `migrations.apply` | yes, explicit consent with re-auth; agent applies need human approval by default | |
| `connections.operate:nonprod` | `connections.operate` | yes | |
| `connections.operate:prod` | `connections.operate` | yes, explicit consent; terminate by agents needs approval | |
| `backups.read` | `backups.read` | yes | |
| `backups.run` | `backups.run` | yes | non-destructive |
| `restore.plan` | `restore.plan` | yes | planning only |
| `nodes.read` | `nodes.read` | yes | |
| `nodes.plan` | `nodes.plan` | yes | |
| `nodes.operate:nonprod` | `nodes.operate` | yes | rare: nodes hosting prod are prod |
| `nodes.operate:prod` | `nodes.operate` | yes, explicit consent; approval always | |
| `audit.read` | `audit.read` | yes | |
| `api` | (session-equivalent for first-party Web App) | **no** | only the first-party Web App client |

**Never grantable to OAuth clients of kind `mcp`** (enforced by policy
`access.mcp-ineligible-scopes`): `registry.manage`, `access.manage`,
`policy.manage`, `restore.execute`, `plans.approve`, `breakglass.activate`,
`diagnostics.read_sensitive`, `data.read_sensitive`, `migrations.import`,
`schema.manage`, `operations.recover`. These actions are reachable only through the Web App or CLI with
a human session (CLI uses the device flow or loopback authorization code flow
with the first-party CLI client).

**[DECIDED]** (Wave 1 clarification, `packages/contracts/src/scopes.ts`) Each
of these admin and human-only permissions is also a scope of the same name,
usable only by the client kinds `web` and `cli` with a human session
(`plans.approve`: `web` only). `access.read`, which this table does not list,
is such a scope too and is not MCP-grantable. A contract test keeps this list,
the scope catalog and the grant filter in agreement.

Compared to the owner brief's starting list:

| Brief | Here | Why |
|---|---|---|
| `query.read` | `data.read:<tier>` | "query" was ambiguous (metadata queries vs data); reading data is the sensitive part, and production data deserves its own tier |
| `migrations.apply.staging` / `.production` | `migrations.apply:nonprod` / `:prod` | environments are configurable; tiers are the authorization boundary; "staging" is one nonprod environment |
| `connections.operate` | `connections.operate:<tier>` | terminating production sessions is a production action |
| `nodes.operate` | `nodes.plan` + `nodes.operate:<tier>` | planning is harmless and useful for agents; applying is not |
| `restore.execute` | permission only, not grantable to MCP | human-only in V1 |
| `admin` | split into `registry.manage`, `access.manage`, `policy.manage`, none MCP-grantable | an omnipotent scope for a token is the opposite of least privilege |
| — | `diagnostics.read` added | separates "see sessions/locks/stats" from "read data" |
| — | `migrations.read` added | status/lint without planning rights |

## 5. Tier rules

- A subject's tier: target → environment tier; cluster/server/node → derived
  maximum (registry).
- A `:nonprod` scope never authorizes an action on a `prod` subject, even if the
  action "only" touches a staging database on a prod-tier cluster: database-level
  actions use the target's tier, cluster-level actions use the cluster's tier.
- Grants may additionally restrict tiers (default for MCP grants: nonprod only,
  unless the user explicitly opts in on the consent screen).
- **[DECIDED]** (Wave 1 clarification) An action on a plan or an operation uses
  the tier recorded in the plan's subject at planning time; an operation has
  the tier of the plan it executes. Approving, applying or force-releasing
  something that acts on production is therefore a production action, whatever
  the scope's own name.

## 6. Human-only and client-kind restrictions

| Action | Allowed client kinds |
|---|---|
| Approve plans | Web App session (with re-auth) |
| Activate break-glass, apply break-glass plans | Web App or first-party CLI with human session (re-auth) |
| Force-release a lock domain (`operation.force_release`, permission `operations.recover`) | Web App or first-party CLI with human session (re-auth); never MCP, never a service account |
| Apply `critical` plans (restore, decommission, placement move) | Web App or CLI, human |
| Raw statement view | Web App |
| Everything else | any client with the scope |

### 6.1 Approvals in a one-person organization

**[DECIDED]** ([OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization),
resolved 2026-10-05, option a.) Approving is `approval.approve`: a human
identity, a Web App session, `plans.approve` at a scope covering the plan's
subject (the plan's tier), and a fresh re-authentication. Agents propose,
humans approve; the same person may approve what an agent proposed for
them, and may self-approve their own plan when the policy allows it, with
an explicit acknowledgement. `critical` self-approvals add a cooling period
and a fresh re-authentication at apply
([`../02-control-plane/operations-engine.md` §6](../02-control-plane/operations-engine.md#6-approvals-and-re-authentication)).

**[DECIDED]** (Wave 3A, `packages/auth/src/approvals.ts`, schema `approvals`.)
How it is implemented:

- An approval is an append-only row bound to the operation, the plan and
  its plan hash, the approver, the approver's Web App session, the
  re-authentication event, the decision, `self_approval` (computed by the
  Control Store: the approver is the plan's human actor through `web` or
  `cli`), the cooling seconds and `not_before` (database clock).
- Approving needs the plan hash the person reviewed (another hash refuses
  with `PLAN_STALE`); a self-approval needs `acknowledgeSelfApproval: true`
  (`SELF_APPROVAL_UNACKNOWLEDGED`); `approval.self-approval` may forbid it.
- Enough live approvals queue the operation at once, unless one of them is
  a cooling `critical` self-approval: then the actor applies again after
  `not_before` (`APPROVAL_COOLING_PERIOD` before) with a passkey or TOTP
  proof of at most 5 minutes **given after `not_before`** (database clock;
  `REAUTH_REQUIRED` otherwise), so the proof behind the approval never
  serves the apply, whatever the cooling length. At that release the
  `approval.self-approval` rule is evaluated again: a self-approval the
  owner has forbidden since no longer counts.
- **Stale approvals.** When the operation is released, only approvals whose
  approver is still an active human holding `plans.approve` at a scope
  covering the plan's subject count; an approver who lost the role no
  longer counts. Approvals never override `deny`.
- A rejection cancels the operation; one decision per person and operation.

## 7. Tests

- Matrix tests per action: permission present/absent × scope present/absent ×
  tier × grant restriction × client kind → expected decision.
- Escalation tests: an identity cannot grant a client scopes it does not hold; a
  `developer` bound to nonprod cannot plan-then-apply on prod even with a stolen
  plan id (plan binding + scope).
- No-wildcard test: adding a new permission does not implicitly extend any role.
