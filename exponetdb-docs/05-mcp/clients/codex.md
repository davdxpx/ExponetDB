# Codex (CLI, IDE extension, app)

| | |
|---|---|
| Status | Wave 7 guide; facts re-checked 2026-10-13 ([`../client-matrix.md`](../client-matrix.md)) |
| Client version | 0.162.1 (2026-10-09) |
| Related | [`../client-matrix.md`](../client-matrix.md), [`../owner-test-package.md`](../owner-test-package.md), [`../oauth.md`](../oauth.md) |

Production: `https://db.exponet.cloud/mcp`. Lab: `http://localhost:8480/mcp`
(or the port of `exponetdb dev up --port`).

## Before you start

Codex uses CIMD when the authorization server advertises it and the `iss`
response parameter (ExponetDB does both): its `client_id` is
`https://chatgpt.com/oauth/codex/client.json` with a loopback redirect
`http://127.0.0.1:<port>/callback`. An administrator fetches that URL for
review on **Admin → Clients** and approves it once.

## Configure

`~/.codex/config.toml` (CLI, IDE extension and app share it):

```toml
[mcp_servers.exponetdb]
url = "https://db.exponet.cloud/mcp"
oauth_resource = "https://db.exponet.cloud/mcp"   # without it Codex sends no `resource`
scopes = ["targets.read", "schema.read", "diagnostics.read"]
startup_timeout_sec = 10
tool_timeout_sec = 120
required = true
default_tools_approval_mode = "writes"
# Lab and tests only: bearer_token_env_var = "EXPONETDB_TOKEN"
```

Codex speaks 2025-06-18 by default; the 2026-07-28 revision is behind
`[features] mcp_2026_07_28 = true` (in the source, off by default). Both are
served on the same URL.

## Sign in

`codex mcp login exponetdb --scopes targets.read,schema.read,diagnostics.read`
(`--oauth-client-registration cimd|dcr` to choose). Codex does not ask for
more scopes by itself: put them in `scopes`.

## First check

`codex mcp list --json` and `codex mcp get exponetdb --json`; then
`codex exec --json "list the targets"`. With `default_tools_approval_mode =
"writes"` Codex asks before every tool that is not read-only. In full
access mode Codex confirms elicitations by itself: the approval link is
still only a link, and nothing approves a production apply but a person on
the approvals page.

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
| | | | everything | **NOT RUN**: Codex is not installed in this environment; owner test package §F |
