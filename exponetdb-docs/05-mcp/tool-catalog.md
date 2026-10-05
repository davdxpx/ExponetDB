# MCP tool catalog (`exponetdb.mcp/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 7 (read-only tools may ship earlier) |
| Read before | [`architecture.md`](./architecture.md), [`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md) |

Every tool maps to one application service that the REST API also exposes (column
"REST"). Scopes are listed per tier where the action is tier-dependent; the
policy engine can still require approval or deny. Input and output schemas are
defined in `packages/contracts/mcp/` and generated into the tool definitions.

Annotations: **RO** = `readOnlyHint: true`; **D** = `destructiveHint: true`;
**I** = `idempotentHint: true`. "Read-only" means *no change to any managed
system*. Tools that only create ExponetDB-internal records (plans, findings) are
marked RO because they cannot change a database, a node or access state; the plan
they create can only take effect through `plan_apply`, which is not RO.

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
| `drift_check` | `schema.read` | RO | `target` | drift findings by kind (A-E) with triage buckets | `POST /targets/{id}/drift-checks` |

## 3. SQL (read path)

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `sql_query` | `data.read:nonprod` / `data.read:prod` | RO | `target`, `sql` (one read-only statement), `params[]`, `maxRows` | rows (typed JSON, capped), columns, truncation flags, RLS annotation, masked columns, duration, statement digest | `POST /targets/{id}/queries` |
| `sql_explain` | as `sql_query` | RO | `target`, `sql`, `params[]`, `analyze` (bool) | JSON plan (redacted), summary (cost, rows, seq scans, misestimates) | `POST /targets/{id}/explain` |
| `sql_cancel` | as the original query | — | `queryId` | canceled or already finished | `DELETE /queries/{id}` |

Refusals: `QUERY_NOT_READ_ONLY`, `QUERY_PARSE_ERROR`, `DATA_READ_NOT_PERMITTED`,
`QUERY_TIMEOUT`, `QUERY_RESULT_TOO_LARGE`.

## 4. Migrations

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `migration_lint` | `migrations.read` | RO | bundle(s) (manifest + files), `project` | lint findings, checksums, DAG check | `POST /projects/{id}/migrations/lint` |
| `migration_status` | `migrations.read` | RO | `target` or `project` | per target: applied, pending, verification status, evidence, drift summary | `GET /targets/{id}/migrations` |
| `migration_plan` | `migrations.plan` | RO | `target`, `bundles[]` or `migrationIds[]`, `source`, optional `idempotencyKey` | plan (see planning-and-apply.md §2) with decision and requirements | `POST /targets/{id}/migrations/plans` |
| `migration_rollback_plan` | `migrations.plan` | RO | `target`, `migrationId` | rollback plan (rollback digest, analysis, dependants) | `POST /targets/{id}/migrations/{mid}/rollback-plans` |
| `migration_verify` | `migrations.apply:<tier>` | I | `target`, `migrationId` | verification result | `POST /targets/{id}/migrations/{mid}/verifications` |

## 5. Plans and operations (generic)

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `plan_get` | the scope that created it | RO | `planId` | plan body, decision, state, requirements, approval status | `GET /plans/{id}` |
| `plan_apply` | depends on plan kind and tier (e.g. `migrations.apply:prod`, `nodes.operate:prod`) | D, I | `planId` | operation handle: state (`queued`, `awaiting_approval` + `approvalUrl`, …) | `POST /plans/{id}/apply` |
| `plan_withdraw` | plan actor | I | `planId` | withdrawn | `POST /plans/{id}/withdraw` |
| `operation_get` | read scope of the kind | RO | `operationId` | state, per-step outcomes (apply/verification), events | `GET /operations/{id}` |
| `operation_list` | read scope | RO | filters: target, kind, state, actor=self | operations | `GET /operations` |
| `operation_cancel` | actor or admin | — | `operationId` | canceled / not cancellable (with reason) | `POST /operations/{id}/cancel` |

`plan_apply` is idempotent with respect to `planId`. It never accepts parameters
that change what runs.

## 6. Connections and locks

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `sessions_list` | `diagnostics.read` | RO | `target`, filters (state, min age, application) | sessions: pid, backend_start, role, application, state, wait event, ages, **redacted** statement | `GET /targets/{id}/sessions` |
| `locks_list` | `diagnostics.read` | RO | `target` | lock graph: waiting → blocking chains (all blockers), lock modes, relations, ExponetDB lock holders named | `GET /targets/{id}/locks` |
| `session_cancel` | `connections.operate:<tier>` | — | `target`, `pid`, `backendStart`, `queryStart` | canceled / already gone (precondition token; inline plan) | `POST /targets/{id}/sessions/{pid}/cancel` |
| `session_terminate` | `connections.operate:<tier>` | D | `target`, `pid`, `backendStart`, `reason` | a terminate **plan** bound to `pid` + `backendStart` (stored plan, class `standard` or `high`); apply it with `plan_apply` (agents on prod: approval required) | `POST /targets/{id}/sessions/{pid}/terminate` |

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
| `restore_plan` | `restore.plan` | RO | source (backup id or point in time), destination (target path, must be explicit) | restore plan; **execution is human-only in V1** (the plan is stored with decision `deny` by rule `restore.human-only`; `plan_apply` returns `PLAN_DENIED`; a human re-plans it in the Web App) | `POST /restores/plans` |

## 9. Nodes and clusters

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `nodes_list` | `nodes.read` | RO | filters | nodes with state, versions, last heartbeat | `GET /nodes` |
| `node_status` | `nodes.read` | RO | `node` | capabilities, host metrics, PostgreSQL service status, configuration summary, certificate expiry, pending restart | `GET /nodes/{id}` |
| `node_plan` | `nodes.plan` | RO | `node` or `cluster`, `kind` (`postgres.config.apply`, `postgres.reload`, `postgres.restart`, `postgres.tls.rotate`, `postgres.extensions.apply`, `postgres.roles.apply`, `postgres.hba.apply`, `packages.apply_update`), kind-specific input | plan with diff, restart/reload requirement, affected targets and tier | `POST /nodes/{id}/plans` |

## 10. Audit

| Tool | Scope | Ann. | Input | Output | REST |
|---|---|---|---|---|---|
| `audit_search` | `audit.read` | RO | filters (time, target, action, actor=self or any if permitted, result), cursor | audit events (pseudonymized actors) | `GET /audit-events` |

## 11. Resources

MCP **resources** expose reference material agents need to use the tools well
(read-only, `audit` not needed):

| URI | Content |
|---|---|
| `exponetdb://guides/migration-authoring` | the authoring guide (expand/contract, CIC, NOT NULL pattern, verify.sql contract) |
| `exponetdb://schemas/migration-manifest/v1` | JSON Schema of `migration.yaml` |
| `exponetdb://guides/error-codes` | error catalog with remediation |
| `exponetdb://targets/{path}/summary` | target summary (same as `target_get`) |

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
