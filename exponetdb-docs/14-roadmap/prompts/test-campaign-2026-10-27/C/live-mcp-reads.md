# Live MCP and CLI reads by the test lead (2026-10-27, read only)

Installation `https://db.exponet.cloud` (server version 0.2.0, REST v1), session of the owner's CLI login (profile `exponet`), MCP tools of the ExponetDB connector. Nothing applied. No secrets in any output below.

## E3 sql_query admission (target reosa/platform/scratch)

| statement | answer |
|---|---|
| `select count(*) as n from pg_stat_activity` | REFUSED `QUERY_CONSTRUCT_UNSUPPORTED`, `details.construct = "pg_stat_activity"` |
| `select name, setting from pg_settings where name = 'max_connections'` | REFUSED, construct `pg_settings` |
| `select count(*) as n, current_user as who from tenants` | REFUSED, construct `tenants` |
| `select count(*) as n from tenants` | REFUSED, construct `tenants` |
| `select count(*) as n from pg_class` | REFUSED, construct `pg_class` |
| `select current_user as who` | ok: `exponetdb_reader` |
| `select count(*) as n from pg_catalog.pg_stat_activity` | ok: 17 |
| `select name, setting from pg_catalog.pg_settings where name = 'max_connections'` | ok: 150 |
| `select count(*) as n, current_user as who from public.tenants` | ok: 0 rows counted, `rlsRelations: ["public.tenants"]` |
| `select extname from pg_catalog.pg_extension order by 1` (scratch and staging) | ok: pg_trgm, plpgsql, vector (no pg_stat_statements) |

Conclusion: the refusal is about unqualified relation names, not about `current_user` or the system views.

## query_stats

`query_stats` on scratch and on staging, and `exponetdb diagnose query-stats` on both: `CAPABILITY_UNAVAILABLE` "The node does not report this capability version, or the cluster is external." although the cluster is agent managed and `pg_stat_statements` is absent.

## E2 node view

`exponetdb node show nod_01M5XZ84V768SYCHZKRNGJFQP2` (table and JSON), MCP `node_status`: `clusters: []`, certificate `2026-10-30T05:57:35Z`. The control-store column `nodes.nodes.clusters` could not be read live: the permission layer denied the read-only SSH `psql` into the Coolify control-store container (reason "Production Reads"); I did not work around it. The mismatch is proved instead on a disposable host with a real agent (`E/e2-e6-live-host-run.log`) and in code (`packages/nodes/src/views.ts:105`, `agent/node/internal/agent/agent.go:510`).

## Other MCP reads (scratch)

`target_get`: `ledger: null`, `openFindingCount: 13968`. `locks_list`, `sessions_list`: empty, `source: live`. `table_stats` (limit 3): ok, `truncated: true`. `operation_list`, `audit_search`: ok (an `auth.login` web event at 20:11:27Z coincides with the Web audit starting in the owner's Chrome). `backups_list` for the cluster: `state unknown`, reasons `drill_never, no_repository, no_verified_backup, rpo_unknown` (honest). `advisors_run` (all four categories): 228 findings, 131,395 characters. `drift_check`: `status drifted`, counts `drifted 13741, matched 3, unmanaged 1`, 500 findings returned, `truncated: true`, 229,168 characters.

## Live deadlines worth knowing

The node certificate lives 72 h (`NODE_PROTOCOL_LIMITS.certificateHours`, `packages/contracts/src/node-protocol/messages.ts:72`). Renewal is requested by the gateway when a third of the lifetime or less remains (`packages/nodes/src/gateway.ts:278-285`), so the live node (expires 2026-10-30T05:57:35Z) is due from 2026-10-29T05:57:35Z at its next heartbeat. See `D/gap-scenarios.md` for what happens when the window is missed.
