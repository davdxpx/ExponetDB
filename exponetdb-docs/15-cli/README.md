# The `exponetdb` CLI

| | |
|---|---|
| Status | **[DECIDED]** Wave 6 (owner order Part C, §39 to §62); part of the G6 evidence; §9 (the CLI and MCP) added on 2026-10-13 for Wave 7, G7 not yet accepted |
| Package | `apps/cli` (Node 24, built with Bun; talks to the REST API only) |
| Related | [`reference.md`](./reference.md) (generated from the command registry), [`install.md`](./install.md) (install, upgrade, uninstall), [`lab.md`](./lab.md) (the local test lab), [`quickstart.md`](./quickstart.md), [`../05-mcp/owner-test-package.md`](../05-mcp/owner-test-package.md) (the Wave 7 owner test package: the lab, the lab's MCP client, real clients), [ADR-0026](../01-architecture/adr/0026-cli-step-up-browser-handoff.md) (step-up), [`../05-mcp/oauth.md` §5](../05-mcp/oauth.md) (sign-in), [`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md) |

The CLI is one of the product's main interfaces: a person goes from
installation and sign-in through the registry and nodes to a verified
migration result without the Web App, except where a fresh proof of
presence or an approval needs a browser (ADR-0026). It holds no business
logic: every decision is the server's (C-1). It never connects to a
database, never runs SQL it was given, never opens a shell on a host.

## 1. Architecture

```text
src/main.ts                 process entry: streams, terminal, Ctrl-C (a second one exits 130), exit code
src/cli/types.ts            the shared types (command spec, io, run context, remote)
src/cli/usage.ts            usage errors (exit 2)
src/cli/spec.ts             group titles and command names of the registry
src/commands/index.ts       the command registry: the only list of commands
src/commands/*.ts           one module per group (general, auth, profile, tool, registry, node,
                            migration, plan, diagnose, access)
src/cli/args.ts             global and command flags (deterministic, suggestions by edit distance)
src/cli/dispatch.ts         parse, help, run the command, render, exit code
src/cli/run.ts              the run context of one invocation (progress, hints, the remote on demand)
src/cli/help.ts             root, group and command help from the registry
src/cli/reference.ts        reference.md and the agent help from the registry
src/cli/exit.ts             error code to exit code (§5)
src/cli/remote.ts           server and profile precedence (§3); the SDK with the token-store authenticator,
                            bounded and checked against the contracts' response schemas
src/cli/profiles.ts         profiles.json (0600)
src/cli/reads.ts, lists.ts  read commands over one route; complete paged listings, partial ones reported
src/cli/planning.ts         plan requests and the plan view (the server decides; the CLI shows)
src/cli/apply.ts            plan apply: local confirmation, the step-up hand-off, the operation
src/cli/watch.ts            watching an operation (§6)
src/cli/stepup.ts           the browser step-up of ADR-0026
src/output/*                result model, human renderer, JSON/NDJSON, sanitization, widths, views
src/local/*                 completion, project file and link, bundle loader, the parser per major (pure lint/checksum/graph, no server)
src/lab/*                   the local test lab: Docker on the local socket, lab state and runs, the stack, smoke
src/files.ts                new private files (0600, never overwritten) and their checks
src/oauth.ts, src/store.ts  the Wave 3B sign-in and token store, unchanged in their guarantees
```

- **Command registry.** Each command declares its name path, aliases,
  summary, arguments and flags (typed), examples, whether it is local or
  remote, whether it reads, plans or mutates, the action id and scopes it
  needs, its output schema name and its TTY behavior. Help, completion,
  [`reference.md`](./reference.md) and the agent help are generated from it;
  a test proves every listed command dispatches and has help.
- **No transport copies.** Remote commands use the SDK (`packages/sdk`) with
  an authenticator backed by the CLI's token store (refresh under the
  exclusive lock). Responses are read with a size bound and validated
  against the route's response schema from `packages/contracts`; a body
  that does not match is `RESPONSE_INVALID`, never rendered as a result.
- **Allowed dependencies:** `@exponetdb/contracts`, `@exponetdb/kernel`,
  `@exponetdb/sdk` and the pure subpaths of `@exponetdb/migrations`
  (`format`, `graph`, `lint`) with the parser assets
  (`tooling/boundaries/graph.json`). Never `control-store`, an executor, a
  secret store or a database driver. The CLI has no third-party runtime
  dependency of its own: YAML (`exponetdb.yaml`, plan request files) is read
  only through the strict reader of `@exponetdb/migrations/format` (the
  pinned `yaml` 2.9.1, ISC license; one document, no anchors, aliases, tags,
  merge keys or duplicate keys), which the packaged CLI bundles.
  **[DECIDED]**

## 2. Global flags

| Flag | Meaning |
|---|---|
| `-h`, `--help` | help of the command (or the root help) |
| `--version` | the CLI version and build; no network |
| `--server <url>` | the server origin (https; http only on loopback) |
| `--profile <name>` | a named profile |
| `--workdir <dir>` | the directory the project file is searched from (default: the current one) |
| `-o`, `--output <table\|json\|ndjson>`, `--json` | output format (`--json` = `--output json`) |
| `--color <auto\|always\|never>`, `--no-color` | color; `NO_COLOR`, `TERM=dumb` and a non-TTY turn it off in `auto` |
| `--no-input` | never prompt and never open a browser; a missing input or proof ends with its exit code |
| `--yes` | skip local, non-security confirmations only; never replaces a permission, approval, re-authentication or evidence |
| `-q`, `--quiet` | results only, no hints |
| `-v`, `--verbose` | safe diagnostics on stderr (request ids, timings); never a secret |
| `--timeout <duration>` | per-request deadline (default 30s) |

Global flags may stand before or after the command. `--` ends flag parsing.
An unknown flag, a missing value, a repeated single-valued flag with a
different value and an unknown command are usage errors (exit 2) with a
concrete suggestion when one is close.

## 3. Profiles, context and precedence

A profile binds a normalized server origin, the installation id it saw
there, the authentication method (`oauth` for a person; `service-account`
with a key file; `api-key` with a key file) and non-secret defaults (output,
default target). It never holds a token; tokens stay in the token store
(`credentials.json`, 0600 in a 0700 directory). Profiles live in
`<config dir>/profiles.json` (0600).

Precedence, first wins: explicit flags → explicitly set environment
variables (`EXPONETDB_URL`, `EXPONETDB_PROFILE`, `EXPONETDB_OUTPUT`) → the
named or current profile → the validated project file
(`exponetdb.project.yaml`, its `server` and `defaults`) → safe defaults. A
`--server` that differs from the profile's origin uses no credential of the
profile (credentials are keyed by origin) and says so. When the server's
installation id differs from the one the profile recorded, remote commands
stop with exit 5 until `exponetdb profile add --force` records the new one.

A planned mutation always shows server, profile, target or cluster, tier
and plan id. `plan apply` applies the stored plan; current defaults never
change its target.

## 4. Output contract `exponetdb.cli-output/v1`

**JSON** (`--output json`) prints exactly one document:

```json
{
  "schema": "exponetdb.cli-output/v1",
  "command": "migration plan",
  "status": "ok | accepted | requires_action | failed | error",
  "context": { "server": "https://…", "profile": "local", "installationId": "ins_…" },
  "requestId": "req_…",
  "planId": "pln_…",
  "operationId": "op_…",
  "data": { },
  "error": { "code": "POLICY_DENIED", "message": "…", "remediation": "…", "details": { } },
  "next": ["exponetdb plan apply pln_… --wait"]
}
```

`requestId`, `planId`, `operationId`, `data`, `error` and `next` appear only
when known. **NDJSON** (`--output ndjson`) prints one typed record per line:
`{"schema":…,"type":"item","data":…}` for each list item,
`{"type":"progress",…}` while watching, and exactly one final
`{"type":"result",…}` or `{"type":"error",…}` record with the same fields as
the JSON document. A paged listing that fails part-way ends with an
`error` record (`"partial": true`) and a non-zero exit; items printed before
it are never a complete list. Dates are ISO 8601 UTC; ids are never
shortened; absent values are omitted, unknown values are `null` with a
reason field where the contract has one. Neither format carries a token, a
credential, a banner, a hint, color or progress noise; human hints go to
stderr. The human renderer and JSON render the same typed result: no
format decides differently.

A usage error (exit 2) is reported on stderr as text and, when the
invocation asked for JSON or NDJSON (`--json`, `--output`, `-o` or
`EXPONETDB_OUTPUT`, read from the raw arguments even when they did not
parse), also as the error document with `"code": "usage"`, the suggestion as
`remediation` and the help command in `next`.

A plan command takes its request from typed arguments and flags or, with
`--file <json|yaml>`, from a file that is the whole request body: then the
typed flags and body arguments must be left out (a usage error names them;
nothing is silently ignored). The file is bounded (256 KiB), read by the
strict YAML reader or as JSON, and checked against the route's request
schema before anything is sent.

## 5. Exit codes

| Code | Meaning |
|---:|---|
| 0 | the command's contract is met; for a waiting mutation: applied **and** verified |
| 1 | an operation, verification or domain failure (also `partially_applied`) |
| 2 | invalid arguments or input (usage) |
| 3 | sign-in, scope or re-authentication missing or refused |
| 4 | policy, approval or evidence blocks; a person must act |
| 5 | transport failure, server unavailable or incompatible contract |
| 6 | the observation timed out, or the outcome needs reconciliation |
| 130 | the person interrupted the local flow (Ctrl-C) |

A failed verification, a parser, API or network error and an incomplete
list never exit 0. `--no-wait` may exit 0 for an accepted operation; its
output then says `accepted` with the state (`queued`,
`awaiting_approval`), never `succeeded`. CI gates use `--wait`. Wave 3B's
`login`/`logout`/`whoami` keep their flags and messages; their exit codes
follow this table (a refused or revoked sign-in is 3, an unreachable server
5; an unconfirmed revocation on `logout` stays 1).

## 6. Watching operations

`plan apply` and the commands that apply wait by default (deadline 15
minutes, `--timeout-wait`), polling `GET /operations/{id}` (1 s, growing by
half up to 5 s; the SDK honors `Retry-After`); each change of state or
event prints one progress line (state, apply and verification outcome, the
running step, the migration and statement in progress, the operation it
waits for). A lost connection marks the shown state as stale, never as
failed, and polling continues until the deadline.

| State while watching | What the CLI does | Exit |
|---|---|---|
| `succeeded` | ends: applied and verified | 0 |
| `failed`, `verification_failed`, `canceled` | ends with the error code and the inspect command | 1 |
| `needs_attention` | ends; a person decides (`operation show`, `migration resume`) | 6 |
| `awaiting_approval` | prints the bound approval URL once and waits; with `--no-input` ends at once | 4 |
| `queued`, `running`, `verifying`, `needs_reconciliation` | waits: reconciliation is the worker's job and ends in one of the states above | (deadline: 6, `WATCH_TIMEOUT`) |

Ctrl-C stops watching (the server operation continues), restores the
terminal, and prints the operation id and `exponetdb operation watch <id>`
(exit 130). `operation cancel` is a separate, authorized request that the
server admits only before apply starts (`OPERATION_NOT_CANCELABLE`
otherwise).

## 7. Terminal safety

Every remote string (names, notes, messages, error details, SQL, catalog
text) is untrusted. The renderer removes C0/C1 controls, ANSI CSI/OSC/DCS
sequences and bidirectional overrides before printing, measures display
width by grapheme, and marks truncation with `…`. Raw bundle bytes are
never printed unescaped; an export writes them to an explicit new file.
Without a TTY there is no spinner, cursor movement or color.

## 8. What the CLI does not do

No remote SQL, `exec`, `ssh`, `db reset --prod`, `migration apply --force`,
ledger repair or self-update; no approval endpoint of its own (ADR-0026 §6);
no Wave 9 diagnostics or backups. A command for a capability a node does
not offer is not offered.

`dev sql` and `dev shell` are the one local exception: they open the local
test lab's own containers through the local Docker socket, checked by
label and recorded ID, never a server or a registered target
([`lab.md`](./lab.md)).

## 9. The CLI and MCP (Wave 7)

**[OBSERVED]** (2026-10-13; `apps/cli/src/commands/dev.ts`, [`reference.md`](./reference.md),
[`lab.md`](./lab.md); G7 not yet accepted)

- The CLI does not speak MCP. It talks to the REST API only, as above. It
  is the first-party human client (client kind `cli`): a person using it is
  not an "agent" in the sense of OD-13, while the same person's token inside
  an MCP client is
  ([`../08-auth-and-security/identity.md`](../08-auth-and-security/identity.md) §11).
- `exponetdb dev mcp-client` registers the local test lab's MCP client
  through Dynamic Client Registration, as any MCP client would: a public
  client, PKCE, loopback redirect URIs on any port (Claude Code, Codex, VS
  Code, the MCP Inspector, the SDK harness). **[DECIDED]** (owner decision
  2026-10-13, OD-5 revised) The lab runs with
  `EXPONETDB_OAUTH_CLIENT_REGISTRATION=open`, so the registration is
  approved automatically: the output reports `state: active` and
  `clientsAt: <server>/admin/clients` (the client list, where an
  administrator can still disable it), and there is no approval step; you
  consent at sign-in. `exponetdb dev up` serves
  `/mcp` in the lab, and `exponetdb dev test smoke` checks that it answers
  `401` with its resource metadata.
- `exponetdb audit list --client <cli_…>` and `--grant <grt_…>` filter the
  audit by the client and the grant an agent acted through (runbook RB-11).
- What an agent cannot do, a person does here: a `critical` plan (for
  example a `lossy` rollback on production) an agent proposed is refused to
  the agent (`HUMAN_APPLY_REQUIRED`). A plan is bound to the caller who made
  it, so the agent's plan id cannot be applied by the person either
  (`PLAN_BINDING_ACTOR`): the person makes the plan again with the CLI (for
  a rollback `exponetdb migration rollback <migration> --target …`), reviews
  it with `exponetdb plan show <planId>` and applies it with
  `exponetdb plan apply <planId>` after a fresh re-authentication. A
  production plan that waits for approval is approved in the Web App, never
  by the CLI (ADR-0026 §6).
- To check Wave 7 yourself, with the lab and with real MCP clients, follow
  [`../05-mcp/owner-test-package.md`](../05-mcp/owner-test-package.md).
