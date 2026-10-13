# Claude Code

| | |
|---|---|
| Status | Wave 7 guide; facts re-checked 2026-10-13 ([`../client-matrix.md`](../client-matrix.md)) |
| Client version | 2.1.296 (2026-10-09); URL elicitation from 2.1.281, step-up prompt from 2.1.288 |
| Related | [`../client-matrix.md`](../client-matrix.md), [`../owner-test-package.md`](../owner-test-package.md), [`../oauth.md`](../oauth.md) |

Production: `https://db.exponet.cloud/mcp`. Lab: `http://localhost:8480/mcp`
(or the port of `exponetdb dev up --port`).

## Before you start

An administrator approves Claude Code once: on **Admin → Clients**, "Fetch
for review" with `https://claude.ai/oauth/claude-code-client-metadata`
(Claude Code's published identity, CIMD), check the name (*not verified*)
and the redirect hosts (`localhost`, `127.0.0.1`), then approve. In the lab,
`exponetdb dev mcp-client` registers a lab client instead; the lab's owner
approves it the same way and you pass its ID with `--client-id`.

## Configure

```bash
# Production, Claude Code's published identity (CIMD):
claude mcp add --transport http exponetdb https://db.exponet.cloud/mcp
# Lab, the lab client (any callback port):
claude mcp add --transport http --client-id <lab client id> --callback-port 8080 exponetdb-lab http://localhost:8480/mcp
```

Or in `.mcp.json` (project) with the scopes asked for at sign-in:

```json
{ "mcpServers": { "exponetdb": {
  "type": "http", "url": "https://db.exponet.cloud/mcp",
  "oauth": { "scopes": "targets.read schema.read diagnostics.read migrations.read migrations.plan" }
} } }
```

Lab and tests only, without OAuth: a short-lived token from the test
harness as a header (`"headers": { "Authorization": "Bearer ${EXPONETDB_TOKEN}" }`).
A configured `Authorization` header turns the OAuth flow off. Never for
production; CI uses the REST API.

## Sign in

`/mcp` in a session, or `claude mcp login exponetdb` (`--no-browser` prints
the link). The consent page lists each scope by area and tier; production
is a separate opt-in with a fresh passkey.

## Allow the read-only tools

Claude Code does not use tool annotations for permissions. Allow exactly the
read-only tools (this list equals the tools with `readOnlyHint`, checked by
`packages/contracts/test/mcp-tools.test.ts`); every other tool asks:

<!-- read-only-allow-list:start -->
```json
{ "permissions": { "allow": [
  "mcp__exponetdb__audit_search",
  "mcp__exponetdb__locks_list",
  "mcp__exponetdb__migration_lint",
  "mcp__exponetdb__migration_status",
  "mcp__exponetdb__node_status",
  "mcp__exponetdb__nodes_list",
  "mcp__exponetdb__operation_get",
  "mcp__exponetdb__operation_list",
  "mcp__exponetdb__plan_get",
  "mcp__exponetdb__schema_diff",
  "mcp__exponetdb__schema_inspect",
  "mcp__exponetdb__schema_search",
  "mcp__exponetdb__sessions_list",
  "mcp__exponetdb__sql_cancel",
  "mcp__exponetdb__sql_explain",
  "mcp__exponetdb__sql_query",
  "mcp__exponetdb__target_get",
  "mcp__exponetdb__target_health",
  "mcp__exponetdb__targets_list"
] } }
```
<!-- read-only-allow-list:end -->

`sql_query` reads rows: it is in the list because it changes nothing, and
whether it can read anything is the grant's `data.read` scope and the
target's policy.

## First check

`claude mcp get exponetdb` shows the server connected. Then, in a session:
"List the targets of the project and their PostgreSQL versions." The answer
names each target path; `exponetdb audit list --client <cli_…>` (the
internal client id on **Admin → Clients**) shows nothing new for a read.

Headless (uses your account): `claude -p "list the targets" --mcp-config ./mcp.json --strict-mcp-config --allowedTools "mcp__exponetdb__*" --output-format stream-json --verbose`.
`MCP_PROTOCOL_NEGOTIATION=legacy` keeps Claude Code on 2025-11-25.

Scope sets (ask for them at sign-in; step-up is not reliable in every client):

| Work | Scopes |
|---|---|
| read the registry, schemas, diagnostics, migrations | `targets.read schema.read diagnostics.read migrations.read` |
| plan and apply on nonprod | the above and `migrations.plan migrations.apply:nonprod` |
| plan for production (a person approves every apply) | the above and `migrations.apply:prod` (production tier at consent) |
| read rows of nonprod targets | the above and `data.read:nonprod` (production rows are for people by default, OD-13 (a)) |
| who did what | `audit.read` |

## When something fails

| Symptom | Cause | What to do |
|---|---|---|
| The browser shows ExponetDB's error page with `client_unknown` | the client's CIMD `client_id` URL was never fetched for review | an administrator opens **Admin → Clients**, "Fetch for review" with the exact URL, then approves it |
| `client_not_approved` | the client is registered (CIMD or DCR) and still pending, or was rejected or disabled | an administrator approves exactly this `client_id` on **Admin → Clients**: the name is shown as *not verified*; check the redirect hosts and the lookalike warning |
| A tool is missing from the list | the grant does not hold its scope or tier, the client cut the list, or it dropped a schema | sign in again with the scopes the work needs (below); compare with `tools/list` in the MCP Inspector |
| `403` with `insufficient_scope` | the called tool needs a scope the grant does not hold | sign in again with the named scope; not every client asks for it by itself |
| `401` after working before | the grant was revoked or expired, or the client was disabled | connect again; if the client was disabled, ask an administrator |
| `429` with `Retry-After` | the grant's rate limit | wait the named seconds; do not loop |
| A result says a person must approve, with a link | production apply waits for a human approval | give the link to the person; observe the operation with `operation_get` |
| `Refused: <CODE>.` with a remedy | permission, tier, policy or plan state (never a `403`) | follow the remedy; the code is in `error-model.md` |
| Calls fail with `401` every ten minutes | the access token lives 10 minutes (`expires_in` is always sent) and the client should use its refresh token (rotated on every use) | if the client asks to sign in again each time, it does not refresh: report it to the client's vendor |

## Revoke

The person ends the connection on **Account → Connected applications** in
the Web App; the next request answers `401`. An administrator can disable
the whole client on **Admin → Clients** (every grant of it ends at once).

## Evidence

| Date | Version | Era | What | Result |
|---|---|---|---|---|
| 2026-10-13 | 2.1.296 | both | the test composition over a real socket (`mcp-fixture-server.ts`), `claude mcp list` and `claude mcp get` with the fixture's token as a header, throwaway `HOME`, no model, no OAuth sign-in | see [`../../14-roadmap/gates/7.md`](../../14-roadmap/gates/7.md) §5.2i |
| | | | OAuth sign-in with CIMD and the lab client, a model run | **NOT RUN**: uses the owner's account; owner test package §C |
