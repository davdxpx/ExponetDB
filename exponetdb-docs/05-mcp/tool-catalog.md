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
serves `tools/list`).

## 0. Served and planned

**[DECIDED]** (Wave 7 order §19, 2026-10-12) Each tool's contract carries its
wave and its state. `tools/list` offers only `served` tools a grant can use;
a `planned` tool is never listed and never callable. The Wave 7 part has 26
tools: §1 to §5, `sessions_list` and `locks_list` of §6, `nodes_list` and
`node_status` of §9, and §10; the three tools of §3 are served with the
data-read path ([ADR-0028](../01-architecture/adr/0028-data-read-lane.md)).
The Wave 9 tools (§6 `session_cancel`, `session_terminate`, §7, §8) stay
unlisted.
`node_plan` is not offered through MCP (OD-29, F9). The state of each tool on
the current commit is in the [G7 record](../14-roadmap/gates/7.md).

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

## 1. Inventory and health

| Tool | Scope | Ann. | Input (summary) | Output (summary) | REST |
|---|---|---|---|---|---|
| `targets_list` | `targets.read` | RO | filters: product, project, environment, tier, state | targets with path, tier, state, health summary, freshness | `GET /targets` |
| `target_get` | `targets.read` | RO | `target` | target detail: environment, tier, generation, placement summary (server/cluster display names, PostgreSQL version; no addresses), ledger head, open findings | `GET /targets/{id}` |
| `target_health` | `diagnostics.read` | RO | `target` | health state with sub-states (connectivity simple/extended, sessions, replication, disk, backups), each with source and timestamp | `GET /targets/{id}/health` |

## 2. Schema

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `schema_inspect` | `schema.read` | RO | `target`, optional `object` (schema, `schema.table`, function signature), `detail` level | overview (schemas, counts) or object detail (columns, types, constraints, indexes, policies, grants, RLS, triggers, sizes); untrusted-text fields marked | `GET /targets/{id}/schema[...]` |
| `schema_search` | `schema.read` | RO | `target`, name pattern, kinds | matching objects | `GET /targets/{id}/schema/search` |
| `schema_diff` | `schema.read` | RO | `left` target (or fingerprint), `right` target (or fingerprint) | structural diff grouped by object class | `POST /schema-diffs` |
| `drift_check` | `schema.read` | — | `target` | drift findings by kind (A-E) with triage buckets (recorded as findings) | `POST /targets/{id}/drift-checks` |

## 3. SQL (read path)

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `sql_query` | `data.read:nonprod` / `data.read:prod` | RO | `target`, `sql` (one read-only statement), `params[]`, `maxRows` | rows (typed JSON, capped), columns, truncation flags, RLS annotation, masked columns, duration, statement digest | `POST /targets/{id}/queries` |
| `sql_explain` | as `sql_query` | RO | `target`, `sql`, `params[]`, `analyze` (bool) | JSON plan (redacted), summary (cost, rows, seq scans, misestimates) | `POST /targets/{id}/explain` |
| `sql_cancel` | as the original query (same identity, client and grant) | I | `queryId` | canceled or already finished | `DELETE /queries/{id}` |

Refusals: `QUERY_NOT_READ_ONLY`, `QUERY_CONSTRUCT_UNSUPPORTED`,
`QUERY_PARSE_ERROR`, `DATA_READ_NOT_PERMITTED`, `QUERY_TIMEOUT`,
`QUERY_RESULT_TOO_LARGE`. A result over the row or byte cap is returned
capped with `truncated: true` and its reason; `QUERY_RESULT_TOO_LARGE` only
when not even one row fits the byte cap. For agents `analyze` is refused
(OD-13); on production targets with `dataRead: humans_only` (the default)
agents read no rows (ADR-0028).

## 4. Migrations

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `migration_lint` | `migrations.read` | RO | bundle(s) (manifest + files), `project` | lint findings, checksums, DAG check | `POST /projects/{id}/migrations/lint` |
| `migration_status` | `migrations.read` | RO | `target` | applied, pending, verification status, evidence, drift summary of the target | `GET /targets/{id}/migrations` |
| `migration_plan` | `migrations.plan` | — | `target`, `bundles[]` or `migrationIds[]`, optional `defaults`, `source` (claimed), `lockWaitSeconds`, `idempotencyKey`; no break-glass reference, no lint or invariant override | plan (see planning-and-apply.md §2) with decision and requirements | `POST /targets/{id}/migrations/plans` |
| `migration_rollback_plan` | `migrations.plan` | — | `target`, `migrationId`, optional `idempotencyKey` | rollback plan (rollback digest, analysis, dependants) | `POST /targets/{id}/migrations/{mid}/rollback-plans` |
| `migration_verify` | `migrations.apply:nonprod` / `migrations.apply:prod` | I | `target`, `migrationId`, optional `revision`, `idempotencyKey` | the verification operation | `POST /targets/{id}/migrations/{mid}/verifications` |

## 5. Plans and operations (generic)

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `plan_get` | the read scope of the plan's kind at a scope covering its subject, or `plans.approve` there (OD-26) | RO | `planId` | plan body, decision, state, requirements, approval status | `GET /plans/{id}` |
| `plan_apply` | depends on plan kind and tier (e.g. `migrations.apply:prod`, `nodes.operate:prod`) | D, I | `planId` | operation handle: state (`queued`, `awaiting_approval` + `approvalUrl`, …) | `POST /plans/{id}/apply` |
| `plan_withdraw` | the identity and client that created the plan, with the plan kind's permission | I | `planId` | withdrawn plan | `POST /plans/{id}/withdraw` |
| `operation_get` | read scope of the kind | RO | `operationId` | state, per-step outcomes (apply/verification), events | `GET /operations/{id}` |
| `operation_list` | read scope | RO | filters: target, kind, state, actor=self | operations | `GET /operations` |
| `operation_cancel` | the identity and client that applied the plan, with the plan kind's apply permission (as REST) | I | `operationId` | canceled operation, or the refusal for one that started | `POST /operations/{id}/cancel` |

`plan_apply` is idempotent with respect to `planId`. It never accepts parameters
that change what runs.

## 6. Connections and locks

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `sessions_list` | `diagnostics.read` | RO | `target`, filters (state, min age, application) | sessions: pid, backend_start, role, application, state, wait event, ages, **redacted** statement | `GET /targets/{id}/sessions` |
| `locks_list` | `diagnostics.read` | RO | `target` | lock graph: waiting → blocking chains (all blockers), lock modes, relations, ExponetDB lock holders named | `GET /targets/{id}/locks` |
| `session_cancel` | `connections.operate:<tier>` | — | `target`, `pid`, `backendStart`, `queryStart` | canceled / already gone (precondition token; inline plan) | `POST /targets/{id}/sessions/{pid}/cancel` |
| `session_terminate` | `connections.operate:<tier>` | — | `target`, `pid`, `backendStart`, `reason` | a terminate **plan** bound to `pid` + `backendStart` (stored plan, class `standard` or `high`); apply it with `plan_apply` (agents on prod: approval required). Creating the plan is not destructive; applying it is (Wave 9) | `POST /targets/{id}/sessions/{pid}/terminate` |

## 7. Performance

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `query_stats` | `diagnostics.read` | RO | `target`, window, order (total time, mean, calls, I/O), limit | normalized statements with metrics and deltas; `CAPABILITY_UNAVAILABLE` if `pg_stat_statements` is absent | `GET /targets/{id}/query-stats` |
| `table_stats` | `diagnostics.read` | RO | `target`, filters | table and index sizes, scans, dead tuples, last (auto)vacuum/analyze, bloat estimate, unused/duplicate/invalid indexes, xid age | `GET /targets/{id}/table-stats` |
| `advisors_run` | `diagnostics.read` | RO | `target`, categories | live findings (security, performance) with remediation | `POST /targets/{id}/advisor-runs` |

## 8. Backups and restore

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `backups_list` | `backups.read` | RO | `target` or cluster | backups, verification state, WAL/PITR window, RPO status, last drill | `GET /clusters/{id}/backups` |
| `backup_run` | `backups.run` | I | cluster or target, kind | operation | `POST /clusters/{id}/backups` |
| `restore_plan` | `restore.plan` | — | source (backup id or point in time), destination (target path, must be explicit) | restore plan; **execution is human-only in V1** (the plan is stored with decision `deny` by rule `restore.human-only`; `plan_apply` returns `PLAN_DENIED`; a human re-plans it in the Web App) | `POST /restores/plans` |

## 9. Nodes and clusters

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `nodes_list` | `nodes.read` | RO | filters | nodes with state, versions, last heartbeat | `GET /nodes` |
| `node_status` | `nodes.read` | RO | `node` | capabilities, host metrics, PostgreSQL service status, configuration summary, certificate expiry, pending restart | `GET /nodes/{id}` |
| `node_plan` | `nodes.plan` | — | **not offered through MCP** (OD-29, 2026-10-12): node changes are planned through REST and the CLI only (`POST /nodes/{id}/plans`) | — | — |

## 10. Audit

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `audit_search` | `audit.read` | RO | filters (time, target, action, actor=self or any if permitted, result), cursor | audit events (pseudonymized actors) | `GET /audit-events` |

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
