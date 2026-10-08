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
| `src/interfaces/http/` | `server/interfaces` | Hono apps: the public probes of `serve`, the `/auth` ceremonies and the `/api/v1` resources of Wave 3A (`api.ts`: one handler per contract operation, request and response validated against `packages/contracts`, exact `Origin`, CSRF, session cookie), the static Web App (`web.ts`, strict CSP, `no-store`) and the internal listener (per-check readiness, metrics). Calls `packages/application` only; never imports the Control Store or a domain package |

## Roles

| Role | Listeners | Work | Readiness |
|---|---|---|---|
| `serve` | public `EXPONETDB_LISTEN`: probes, `/auth/*`, `/api/v1/*` (the routes with a handler; every other path `NOT_FOUND`), the Web App pages and `/assets/*`; internal | heartbeat; reads and plans through `packages/application` | control store, own login, installation, schema, keyring, heartbeat, role catalog (the stored role matrix equals this release's; the API answers `CONTROL_PLANE_DEGRADED` until it does); degraded without a live worker |
| `worker` | internal | heartbeat, maintenance tasks (since Wave 5 also node binding, judging completions and sweeping jobs), operations loop with the access kinds of Wave 3A (role bindings, policy settings, identity enable and erase) | as serve, plus checkpoint export, chain verification, maintenance failures (degrading) |
| `gateway` | internal; with `EXPONETDB_GATEWAY_LISTEN` the agent listener (HTTP/2, TLS 1.3, client certificates; opened once the agent PKI exists) | heartbeat; the agent API through `packages/application`; its own TLS identity minted daily from the server CA | as serve, plus `agent_listener` (off, or listening; not ready while it waits for `node-pki init`) |

Startup is refused (exit 3) for a login that is not the role's own or is
privileged, another installation's Control Store, a schema newer than the
build, a checksum mismatch, and an invalid or mismatched keyring. An
unreachable, unmigrated or unverified Control Store keeps the process running
and not ready.

`serve` never writes a role binding, a policy setting or an identity's
enablement: it plans; the worker executes and verifies
([`operations-engine.md`](../../exponetdb-docs/02-control-plane/operations-engine.md)).
Without built Web App assets (`dist/bundle/web/` in the image,
`apps/web/dist` in a workspace) `serve` logs `web.assets_missing` and serves
the API only.

## Commands

`control-store migrate | status | bootstrap-sql`, `keyring generate |
add-key | status`, `audit verify | prune`, `bootstrap owner --email
[--display-name] [--reissue]`, `auth recover-owner --email --reason-file`,
`healthcheck`, `version`; see `exponetdb help`. Secrets are written only to
new files with mode 0600. The setup and recovery links of the two auth
commands go to standard output only, never to a log
([`bootstrap.md`](../../exponetdb-docs/12-operations/bootstrap.md)); a
refusal prints `refused (<code>): <message>` and exits 2.

## Allowed dependencies

By component, in `tooling/boundaries/graph.json`: interfaces see
`application`, `auth` (types and errors), contracts and observability;
roles see composition and interfaces; commands see composition and roles;
only the composition root sees `control-store`, `secrets`, `audit`,
`policy` and `operations`. `hono` and
`@hono/node-server` are allowed only here.

## Tests and build

`bun run test` (configuration, HTTP interfaces, served routes, client
address, cookies, problems, CSP), `bun run test:integration` (the three
roles, refusals, readiness, shutdown and the commands against PostgreSQL 17;
`http-auth.int.test.ts`: the `/auth` and `/api/v1` surface end to end with
cookie flags, `Origin`, CSRF, credential ambiguity, fixation, logout,
revocation, expiry, enumeration, re-authentication, plans, apply and stale
privileges), `bun run test:e2e` (`web.e2e.test.ts`: the built Web
App in Chromium with a virtual WebAuthn authenticator against the real
`serve` role: first-owner setup through the operator command, passkey
sign-in, logout, fixation, forged challenge, foreign origin, passkey
re-authentication with session rotation, password and TOTP, recovery code;
needs `apps/web` built and Chromium for the pinned `playwright-core`), `bun run bundle` (one ES module in `dist/bundle/bin/`, the
Control Store bundles in `dist/bundle/migrations/`, the native Argon2
bindings next to them, the built Web App in `dist/bundle/web/`; build
`apps/web` first; the image runs it with Node.js 24).
