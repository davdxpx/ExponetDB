# @exponetdb/server

The ExponetDB Control Plane program: one build, run as three process roles
(`exponetdb serve | worker | gateway`) and the operator's one-shot commands
([ADR-0019](../../exponetdb-docs/01-architecture/adr/0019-process-roles-and-web-app.md),
[deployment.md](../../exponetdb-docs/12-operations/deployment.md)). Runtime
Node.js 24; Bun builds the bundle.

## Layout

| Path | Component | What |
|---|---|---|
| `src/main.ts`, `src/commands/` | `server`, `server/commands` | argument parsing and dispatch; results as JSON on stdout, logs of one-shot commands on stderr; exit codes 0, 1 (negative result), 2 (usage or configuration), 3 (refused to start) |
| `src/config/` | `server/config` | strict environment parsing per role and per command (unknown or foreign `EXPONETDB_*` variables fail startup; problems name variables, never values); build identity |
| `src/composition/` | `server/composition` | the composition root: logger, metrics, tracing, the role's Control Store pool, keyring, readiness checks, startup gate, worker tasks, operations loop, command implementations |
| `src/roles/` | `server/roles` | lifecycle: listeners, signals, ordered graceful shutdown |
| `src/interfaces/http/` | `server/interfaces` | Hono apps: the public probes of `serve` and the internal listener (per-check readiness, metrics). Never imports the Control Store or a domain package |

## Roles in Wave 2

| Role | Listeners | Work | Readiness |
|---|---|---|---|
| `serve` | public `EXPONETDB_LISTEN` (probes only, every other path `NOT_FOUND`), internal | heartbeat | control store, own login, installation, schema, keyring, heartbeat; degraded without a live worker |
| `worker` | internal | heartbeat, maintenance tasks, operations loop (no product kinds yet) | as serve, plus checkpoint export, chain verification, maintenance failures (degrading) |
| `gateway` | internal | heartbeat | as serve; no agent listener and no CA or mTLS claim before Wave 5 |

Startup is refused (exit 3) for a login that is not the role's own or is
privileged, another installation's Control Store, a schema newer than the
build, a checksum mismatch, and an invalid or mismatched keyring. An
unreachable, unmigrated or unverified Control Store keeps the process running
and not ready.

## Commands

`control-store migrate | status | bootstrap-sql`, `keyring generate |
add-key | status`, `audit verify | prune`, `healthcheck`, `version`; see
`exponetdb help`. Secrets are written only to new files with mode 0600.

## Allowed dependencies

By component, in `tooling/boundaries/graph.json`: interfaces see contracts
and observability only; roles see composition and interfaces; commands see
composition and roles; only the composition root sees `control-store`,
`secrets`, `audit`, `policy` and `operations`. `hono` and
`@hono/node-server` are allowed only here.

## Tests and build

`bun run test` (configuration, HTTP interfaces), `bun run test:integration`
(the three roles, refusals, readiness, shutdown and the commands against
PostgreSQL 17), `bun run bundle` (one ES module in `dist/bundle/bin/`, the
Control Store bundles in `dist/bundle/migrations/`; the image runs it with
Node.js 24).
