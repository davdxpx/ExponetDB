# Claude (web, desktop, mobile)

| | |
|---|---|
| Status | Wave 7 guide; facts re-checked 2026-10-13 ([`../client-matrix.md`](../client-matrix.md)) |
| Client version | the service (2026-10-13) |
| Related | [`../client-matrix.md`](../client-matrix.md), [`../owner-test-package.md`](../owner-test-package.md), [`../oauth.md`](../oauth.md) |

Production: `https://db.exponet.cloud/mcp`. Lab: `http://localhost:8480/mcp`
(or the port of `exponetdb dev up --port`).

## Before you start

Claude calls the server from Anthropic's cloud: the URL must be public HTTPS
(IPv4 from `160.79.104.0/21` must reach port 443, a full certificate chain,
no redirect to another host). It cannot reach the lab. An administrator
approves Claude once on **Admin → Clients**: with "Use Claude's published
identity" Claude presents a CIMD `client_id` URL (observed 2026-10-13:
`https://claude.ai/oauth/mcp-oauth-client-metadata`, not documented by
Anthropic; use the URL shown in the pending request), "Fetch for review",
check the redirect `https://claude.ai/api/mcp/auth_callback`, approve. With
"Register automatically" (DCR) the registration arrives pending instead.

## Configure

**Customize → Connectors → Add custom connector**: name `ExponetDB`, URL
`https://db.exponet.cloud/mcp`, OAuth client "Use Claude's published
identity". Team and Enterprise: an owner adds it under **Organization
settings → Connectors → Add → Custom → Web**; members connect. The
connector's auth settings cannot be changed later (remove it and add it
again). Do not put a remote server into `claude_desktop_config.json`.

## Sign in

"Connect" opens ExponetDB's consent page; production is a separate opt-in.
Per tool, Claude offers *Always allow*, *Needs approval* or *Blocked*: the
read-only tools are marked as such (`readOnlyHint`); destructive ones always
ask.

## First check

"List the targets of the project." Errors carry an `ofid_` reference in
Claude; the server's log line carries the request id.

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
| | | | everything | **NOT RUN**: needs the public URL after the rollout; owner test package §F |
