# MCP tool catalog (`exponetdb.mcp/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 7 state of 2026-10-12 (served and planned tools, §0) |
| Applies to | Wave 7; the Wave 9 tools are listed here and stay unlisted on the endpoint until Wave 9 |
| Read before | [`architecture.md`](./architecture.md), [`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md) |

Every tool maps to one application service that the REST API also exposes (column
"REST"). Scopes are listed per tier where the action is tier-dependent; the
policy engine can still require approval or deny. Input and output schemas are
defined in `packages/contracts/src/mcp/` and generated into the tool definitions
(`generated/jsonschema/mcp-tools.v1.json`, built by the same function that
serves `tools/list`). Output schemas announce no `maxLength`, no `pattern` and
no enumeration of more than 16 values: the server validates every result with the
full contract first and escapes invisible characters afterwards, which lengthens a
string, so a bound would reject valid output in a validating client. Input
schemas keep all of their bounds.

## 0. Served and planned

**[DECIDED]** (Wave 7 order §19, 2026-10-12) Each tool's contract carries its
wave and its state. `tools/list` offers only `served` tools a grant can use;
a `planned` tool is never listed and never callable. The Wave 7 part has 26
tools: §1 to §5, `sessions_list` and `locks_list` of §6, `nodes_list` and
`node_status` of §9, and §10; the three tools of §3 are served since Wave 7
Phase 8 with the data-read path ([ADR-0028](../01-architecture/adr/0028-data-read-lane.md)).
The Wave 9 tools (§6 `session_cancel`, `session_terminate`, §7, §8) stay
unlisted.
`node_plan` is not offered through MCP (OD-29, F9). The state of each tool on
the current commit is in the [G7 record](../14-roadmap/gates/7.md).

**[OBSERVED]** (2026-10-13, `packages/contracts/src/mcp/tools.ts`) The
contract `MCP_TOOL_LIST` holds 30 tools, each with `wave` and `status`: the
26 above are `served` with wave 7 (`MCP_SERVED_TOOL_LIST`); `query_stats`,
`table_stats`, `advisors_run` and `backups_list` are `planned` with wave 9.
`session_cancel`, `session_terminate`, `backup_run` and `restore_plan` are
designed here for Wave 9 and have no contract yet (they are added to the
catalog additively). The column **Wave** of every table below shows this:
`7, served`, `9, planned`, `9, no contract yet`, or `not offered`.

**[OBSERVED]** (2026-10-27, Wave 9 Part B) `query_stats`, `table_stats` and
`advisors_run` are `served` (toolVersion 1, pinned in
`packages/contracts/mcp-tool-versions.json`): each calls the use case of its
REST route (`apps/server/src/interfaces/mcp/registry.ts`,
`packages/application/src/performance.ts`), with `diagnostics.read` at the
target. `query_stats` reads the sampled deltas (never the target live) and
gives an MCP caller at most 500 characters of each redacted statement;
`table_stats` and `advisors_run` read the target live on the observer path
(statement timeout 5 s, lock timeout 1 s). `advisors_run` records its
findings (`observation.subject_findings`) and the run
(`observation.advisor_runs`) and is audited (`advisor.run`), the run, its
findings and the audit event in one transaction; it changes nothing on the
target ([`../10-observability/performance.md`](../10-observability/performance.md)).
Its description says so (review F-4, 2026-10-27; its version-1 digest was
replaced in place: the tool is new on this branch, not released). Its
`message` and `remediation` are marked untrusted: server prose that quotes
catalog names (review D-2).
**[OPEN: OD-57]** (review F-4) The tool keeps `readOnlyHint` and `advisor.run` the
effect `read`, although the run writes Control Store records like
`drift_check`: a `control_record` effect would make `diagnostics.read` a
write scope, which the frozen `oauth.scopes` catalog (G3B) stores as a read
scope; that change needs an owner decision and a new bundle
([OD-57](../00-product/open-decisions.md#od-57-advisors_run-records-a-run-but-its-scope-is-a-read-scope)).
**[OBSERVED]** (2026-10-28) The tools that return an operation carry the L0
`gate` of a rolled-back migration (`migrations[].gate`, see
[`verification.md` §2](../04-migrations/verification.md#l0-pre-commit-structural-gate-transactional-bundles-only)).
Its `first` is marked untrusted (object names from the bundle and the catalog),
so `operation_get`, `operation_list`, `operation_cancel`, `plan_apply` and
`migration_verify` are `openWorldHint: true` and say so in their descriptions;
their definitions changed, so their `toolVersion` is raised (`migration_verify`
3, the others 2) and the new digests are pinned.
`backups_list` is `served` as well (`backups.read` at the cluster; the backup catalog of `packages/application/src/backups.ts`, repository summaries without location or secret). The cancel and terminate actions are REST
only (`POST /targets/{t}/sessions/{pid}/cancel` and `/terminate`); no MCP
tool offers them.

Annotations: **RO** = `readOnlyHint: true`; **D** = `destructiveHint: true`;
**I** = `idempotentHint: true` (shown only for tools that are not RO, where MCP
gives it meaning); **—** = none of them. `openWorldHint` is true exactly for
the tools whose result carries text from outside ExponetDB (fields marked
`untrusted`); a contract test derives it from the output schema. **[DECIDED]** (pre-G1 correction,
2026-10-05) The annotations keep their MCP meaning: a tool is RO only when it
does not change its environment, which is the case exactly when its action has
effect `read` in the action registry. A tool that creates a persistent
ExponetDB record (a plan, findings) is **not** RO, even though the record
cannot change a database, a node or access state by itself and the tool is
not destructive (`readOnlyHint: false`, `destructiveHint: false`). A contract
test checks every tool against its action's effect. Annotations remain hints
for clients and never a security control (C-10).

**[DECIDED]** (2026-10-13, after the first real-client test) Every
`tools/call` result, a success or a tool error, ends its text with the server
line `Request req_…, N ms.` and carries the same facts in `_meta`
(`cloud.exponet.db/requestId`, `cloud.exponet.db/durationMs`): the request id
finds the call in the server log, also for a success. A "not there" answer
(`*_NOT_FOUND`) carries the request id only (`Request req_….`): an exact
server-side duration would be a finer clock than the existence floor's one
time class (Wave 7 order §30), and adversarial goal 18 proves the answer for
an unknown object and for one outside the grant byte-identical. Tools are listed by
the grant's scopes, never by what is registered; an empty `targets_list`
(no `nextCursor`) adds one server line that says no target is visible to
this grant and names the grant's scopes, the same line whether none is
registered or none is visible, so it reveals nothing about what exists
(the same rule as `TARGET_NOT_FOUND`, [`../02-control-plane/error-model.md` §4](../02-control-plane/error-model.md)).
The common refusals (`TARGET_NOT_FOUND`, `NOT_FOUND`, `PLAN_NOT_FOUND`,
`OPERATION_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_FAILED`,
`QUERY_NOT_READ_ONLY`, `DATA_READ_NOT_PERMITTED`) carry a remediation from the
error catalog (`Next step:` in the text;
[`../02-control-plane/error-model.md` §3](../02-control-plane/error-model.md)).

## 1. Inventory and health

| Tool | Scope | Ann. | Input (summary) | Output (summary) | REST | Wave |
|---|---|---|---|---|---|---|
| `targets_list` | `targets.read` | RO | filters: product, project, environment, tier, state | targets with path, tier, state, health summary, freshness | `GET /targets` | 7, served |
| `target_get` | `targets.read` | RO | `target` | target detail: environment, tier, generation, placement summary (server/cluster display names, PostgreSQL version; no addresses), ledger head, open findings | `GET /targets/{id}` | 7, served |
| `target_health` | `diagnostics.read` | RO | `target` | health state with sub-states (connectivity simple/extended, sessions, replication, disk, backups), each with source and timestamp. **[OBSERVED]** (Wave 8 completion) The REST route also carries an optional `capacity` (connections in use and usable slots); the tool's output does not (REST only) | `GET /targets/{id}/health` | 7, served |

## 2. Schema

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `schema_inspect` | `schema.read` | RO | `target`, optional `kind` and `object` (`schema.name`, a function with the arguments `schema_search` returns), optional `include` (`definition`, `policy_expressions`) | overview (schemas, counts) or object detail (columns, types, constraints, indexes, policies, grants, RLS, triggers, sizes); untrusted-text fields marked; function bodies, view definitions and policy expressions withheld unless included, then capped; `omitted` and `truncated` name what was withheld or cut ([schema-fingerprints.md §9](../03-database-model/schema-fingerprints.md#9-hostile-metadata)) | `GET /targets/{id}/schema[...]` | 7, served |
| `schema_search` | `schema.read` | RO | `target`, name pattern, kinds | matching objects. **[OBSERVED]** (Wave 8 completion) Listing objects without a search term is REST only (`GET /targets/{id}/schema/objects`); the tool still requires the pattern | `GET /targets/{id}/schema/search` | 7, served |
| `schema_diff` | `schema.read` | RO | `left` target (or fingerprint), `right` target (or fingerprint) | structural diff grouped by object class | `POST /schema-diffs` | 7, served |
| `drift_check` | `schema.read` | — | `target` | drift findings by kind (A-E) with triage buckets. It changes **no database** but writes records in the Control Store (a drift check, a schema snapshot and the findings, in one transaction) and is not an audit event today ([OD-34](../00-product/open-decisions.md)). **[OBSERVED]** (Wave 8 completion) Reading the history of past checks is REST only (`GET /targets/{id}/drift-checks`) | `POST /targets/{id}/drift-checks` | 7, served |

## 3. SQL (read path)

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `sql_query` | `data.read:nonprod` / `data.read:prod` | RO | `target`, `sql` (one read-only statement), `params[]`, `maxRows`, optional `queryId` (`qry_…`, to cancel it by) | rows (typed JSON, capped), columns, truncation flags, RLS annotation, masked columns, duration, statement digest | `POST /targets/{id}/queries` | 7, served |
| `sql_explain` | as `sql_query` | RO | `target`, `sql`, `params[]`, `analyze` (bool), optional `queryId` | JSON plan (redacted), summary (cost, rows, seq scans, misestimates) | `POST /targets/{id}/explain` | 7, served |
| `sql_cancel` | `data.read:nonprod` / `data.read:prod`, and the same identity, client and grant as the query | RO | `target`, `queryId` | `canceled` or `finished` | `POST /targets/{id}/queries/{queryId}/cancel` | 7, served |

Refusals: `QUERY_NOT_READ_ONLY`, `QUERY_CONSTRUCT_UNSUPPORTED`,
`QUERY_PARSE_ERROR`, `QUERY_FAILED` (the SQLSTATE only), `QUERY_CANCELED`,
`DATA_READ_NOT_PERMITTED`, `QUERY_TIMEOUT`, `QUERY_RESULT_TOO_LARGE`,
`RATE_LIMITED` (2 reads per grant, 3 per target, 8 per installation at
once; agents at most 2 of a target's and 6 of the installation's, so
agents alone never hold every slot), `CAPABILITY_UNAVAILABLE` (no data-read
worker runs). A result over
the row or byte cap is returned capped with `truncated: true` and its
reason; `QUERY_RESULT_TOO_LARGE` only when not even one row fits the byte
cap (or the sealed result exceeds the data-read lane's 16 MiB). For agents
`analyze` is refused (OD-13); on production targets the
`data.read` rule's default (`by_tier`, which is `humans_only` there) keeps
agents from rows whatever their scopes, as a tool error, never HTTP 403
(ADR-0028). Columns named in the rule's `sensitiveColumns` come back `null`
with `masked: true`. Closing the stream cancels a running read; `sql_cancel`
cancels one by the `queryId` the agent chose. Every read is audited as
`data.read` with the normalized statement, never a value
([`../03-database-model/sql-execution-security.md` §2.4](../03-database-model/sql-execution-security.md#24-wave-7-implementation)).

## 4. Migrations

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `migration_lint` | `migrations.read` | RO | bundle(s) (manifest + files), `project`: a registered project the caller can see (an unknown or hidden one is `NOT_FOUND`; the lint reads no target) | lint findings (a refused `verify.sql` carries `code`), checksums, DAG check | `POST /projects/{id}/migrations/lint` | 7, served |
| `migration_status` | `migrations.read` | RO | `target` | applied, pending, verification status, evidence, drift summary of the target | `GET /targets/{id}/migrations` | 7, served |
| `migration_plan` | `migrations.plan` | — | `target`, `bundles[]` or `migrationIds[]`, optional `defaults`, `source` (claimed), `lockWaitSeconds`, `idempotencyKey`; no break-glass reference, no lint or invariant override | plan (see planning-and-apply.md §2) with decision and requirements | `POST /targets/{id}/migrations/plans` | 7, served |
| `migration_rollback_plan` | `migrations.plan` | — | `target`, `migrationId`, optional `idempotencyKey` | rollback plan (rollback digest, analysis, dependants) | `POST /targets/{id}/migrations/{mid}/rollback-plans` | 7, served |
| `migration_verify` | `migrations.apply:nonprod` / `migrations.apply:prod` | I | `target`, `migrationId`, optional `revision`, `idempotencyKey` | the verification operation; on production it waits for a person's approval (`migration.agent-production`: `verify.sql` reads production data), with the approval link | `POST /targets/{id}/migrations/{mid}/verifications` | 7, served |

## 5. Plans and operations (generic)

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `plan_get` | the read scope of the plan's kind at a scope covering its subject (OD-26 (c); `plans.approve` admits only a Web App session, never an MCP token) | RO | `planId` | plan body, decision, state, requirements, approval status | `GET /plans/{id}` | 7, served |
| `plan_apply` | depends on plan kind and tier: `migrations.apply:nonprod` / `migrations.apply:prod` for the plans of `migration_plan` and `migration_rollback_plan`, the only plans an MCP client creates (a plan is bound to its creator and client; no node plans, OD-29) | D, I | `planId` | operation handle: state (`queued`, `awaiting_approval` + `approvalUrl`, …) | `POST /plans/{id}/apply` | 7, served |
| `plan_withdraw` | the identity and client that created the plan, with the plan kind's permission | I | `planId` | withdrawn plan | `POST /plans/{id}/withdraw` | 7, served |
| `operation_get` | read scope of the kind | RO | `operationId` | state, per-step outcomes (apply/verification), per-migration outcomes (with the L0 `gate` of a migration the pre-commit gate rolled back), events | `GET /operations/{id}` | 7, served |
| `operation_list` | read scope | RO | filters: target, kind, state, actor (`self` or `any`; absent = any, as REST) | the operations this grant can see, each decided by the engine | `GET /operations` | 7, served |
| `operation_cancel` | the identity that applied the plan, through the same client kind and the same registered client (another client of the same person is `PLAN_BINDING_ACTOR`), with the plan kind's apply permission (as REST) | I | `operationId` | canceled operation, or the refusal for one that started | `POST /operations/{id}/cancel` | 7, served |

`plan_apply` is idempotent with respect to `planId`. It never accepts parameters
that change what runs.

**[DECIDED]** (Wave 7 Phase 6) Attribution of an agent's plan: the plan and
operation views name the person (`actor.via: mcp`) and the registered
client (`clientId`); the grant appears in the audit (`client.grantId` on
`plan.created` and `operation.accepted`), not in the plan, because the
plan hash binds the person and the client only. A `critical` plan (for
example a `lossy` rollback on production) may be proposed by an agent but is
applied by a person (CLI, or a Web App session for a released cooling
operation) with a fresh re-authentication: the agent's `plan_apply` is
`HUMAN_APPLY_REQUIRED` with the plan id and the person's next step, and the
engine's refusal is audited as `authz.denied`. A plan is bound to its caller,
so the person cannot apply the agent's plan id (`PLAN_BINDING_ACTOR`): they
make the plan again with the CLI and apply their own. At most 20 operations
of one person through one client wait for an approval at a time; a further
`plan_apply` or `migration_verify` that would wait is
`APPROVALS_PENDING_LIMIT` and the plan stays active. `[OBSERVED]` in
`apps/server/test/mcp-plans.int.test.ts`.

## 6. Connections and locks

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `sessions_list` | `diagnostics.read` | RO | `target`, filters (state, min age, application) | sessions: pid, backend_start, role, application, state, wait event, ages, **redacted** statement (at most 500 characters for MCP, `truncated`, digest of the whole) | `GET /targets/{id}/sessions` | 7, served |
| `locks_list` | `diagnostics.read` | RO | `target` | lock graph: waiting → blocking chains (all blockers), lock modes, relations, ExponetDB lock holders named | `GET /targets/{id}/locks` | 7, served |
| `session_cancel` | `connections.operate:<tier>` | — | `target`, `pid`, `backendStart`, `queryStart` | canceled / already gone (precondition token; inline plan) | `POST /targets/{id}/sessions/{pid}/cancel` | 9, no contract yet |
| `session_terminate` | `connections.operate:<tier>` | — | `target`, `pid`, `backendStart`, `reason` | a terminate **plan** bound to `pid` + `backendStart` (stored plan, class `standard` or `high`); apply it with `plan_apply` (agents on prod: approval required). Creating the plan is not destructive; applying it is (Wave 9) | `POST /targets/{id}/sessions/{pid}/terminate` | 9, no contract yet |

## 7. Performance

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `query_stats` | `diagnostics.read` | RO | `target`, window, order (total time, mean, calls, I/O), limit | normalized statements with metrics and deltas; `CAPABILITY_UNAVAILABLE` with `details.reason = extension_missing` and `details.extension = pg_stat_statements` if the extension is absent | `GET /targets/{id}/query-stats` | 9, served |
| `table_stats` | `diagnostics.read` | RO | `target`, filters | table and index sizes, scans, dead tuples, last (auto)vacuum/analyze, bloat estimate, unused/duplicate/invalid indexes, xid age | `GET /targets/{id}/table-stats` | 9, served |
| `advisors_run` | `diagnostics.read` | RO | `target`, categories | live findings (security, performance, operations, change safety; default security and performance) with remediation, evidence, the recorded finding id and the skipped rules with their reason | `POST /targets/{id}/advisor-runs` | 9, served |

## 8. Backups and restore

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `backups_list` | `backups.read` | RO | `target` or cluster | backups, verification state, WAL/PITR window, RPO status, last drill | `GET /clusters/{id}/backups` | 9, served |
| `backup_run` | `backups.run` | I | cluster or target, kind | operation | `POST /clusters/{id}/backups` | 9, no contract yet |
| `restore_plan` | `restore.plan` | — | source (backup id or point in time), destination (target path, must be explicit) | restore plan; **execution is human-only in V1** (the plan is stored with decision `deny` by rule `restore.human-only`; `plan_apply` returns `PLAN_DENIED`; a human re-plans it in the Web App) | `POST /restores/plans` | 9, no contract yet |

## 9. Nodes and clusters

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `nodes_list` | `nodes.read` | RO | filters | nodes with state, versions, last heartbeat; a restricted grant sees the nodes whose server it covers ([authorization.md §1](../08-auth-and-security/authorization.md)) | `GET /nodes` | 7, served |
| `node_status` | `nodes.read` | RO | `node` | capabilities, host metrics, PostgreSQL service status, configuration summary, certificate expiry, pending restart | `GET /nodes/{id}` | 7, served |
| `node_plan` | `nodes.plan` | — | **not offered through MCP** (OD-29, 2026-10-12): node changes are planned through REST and the CLI only (`POST /nodes/{id}/plans`) | — | — | not offered |

## 10. Audit

| Tool | Scope | Ann. | Input | Output | REST | Wave |
|---|---|---|---|---|---|---|
| `audit_search` | `audit.read` | RO | filters (time, target, action, actor `self` or `any` (absent = any, as REST), result, `client` (`cli_…`), `grant` (`grt_…`), Wave 7 for runbook RB-11), cursor | audit events (pseudonymized actors; `denial` names the action, reason and tool of an `authz.denied`); a restricted grant without a target sees the events of the targets it covers, never installation-wide ones. **[OBSERVED]** (Wave 8 completion) The REST route also filters by `identity` (an `idn_…` id); the tool has no such input (REST only) | `GET /audit-events` | 7, served |

## 11. Resources

MCP **resources** expose reference material agents need to use the tools well
(read-only, `audit.read` not needed), and one summary per target
**[DECIDED]** (Wave 7 order §23; implemented in Phase 5):

| URI | Content | Who can read it | Cache (modern) |
|---|---|---|---|
| `exponetdb://guides/migration-authoring` | the authoring guide (expand/contract, concurrent indexes, NOT NULL pattern, `verify.sql` contract, the workflow; data is never an instruction). Text in the contracts (`MIGRATION_AUTHORING_GUIDE`), also generated into [`resources/migration-authoring.md`](./resources/migration-authoring.md) | every authenticated MCP client | `public`, 1 h |
| `exponetdb://schemas/migration-manifest/v1` | JSON Schema of `migration.yaml`; the same document is served without authentication at its `$id`, `https://db.exponet.cloud/schemas/migration-manifest/v1` (and the project schema at `/schemas/project-config/v1`) | every authenticated MCP client | `public`, 1 h |
| `exponetdb://guides/error-codes` | the error catalog: code, retryability, message, remediation | every authenticated MCP client | `public`, 1 h |
| `exponetdb://targets/<tgt_id>/summary` | target summary: the same data as `target_get`, through the same use case | whoever `target_get` allows; any other target is "not found" | `private`, 60 s |

`resources/list` lists the three static resources, then the summaries of the
targets the grant can see (50 per page, opaque cursor); without
`targets.read` it lists the static resources only. There are no resource
templates (`resources/templates/list` answers an empty list), no
subscriptions and no change notifications. A missing resource is `-32602`
with `data.uri` (modern) or `-32002` (legacy).

No **prompts** are offered in V1.

## 12. What is deliberately not a tool

| Not offered | Why |
|---|---|
| `execute_sql` with write capability | C-23; writes go through migrations |
| `apply_migration(sql)` in one step | plans are the confirmation (C-6, C-8) |
| `approve_plan` | approvals are human acts in the Web App (P-14) |
| `breakglass_*` | human-only, Web App/CLI |
| `restore_execute` (agent-applicable) | human-only in V1 |
| `credentials_*`, anything returning connection strings | C-20 |
| `registry_*` writes, `access_*` | admin-only, Web App/CLI/REST |
| `node_exec`, `shell`, `run_script` | C-22 |
