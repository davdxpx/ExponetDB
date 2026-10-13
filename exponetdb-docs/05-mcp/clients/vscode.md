# VS Code (GitHub Copilot)

| | |
|---|---|
| Status | Wave 7 guide; facts re-checked 2026-10-13 ([`../client-matrix.md`](../client-matrix.md)) |
| Client version | 1.141.0 |
| Related | [`../client-matrix.md`](../client-matrix.md), [`../owner-test-package.md`](../owner-test-package.md), [`../oauth.md`](../oauth.md) |

Production: `https://db.exponet.cloud/mcp`. Lab: `http://localhost:8480/mcp`
(or the port of `exponetdb dev up --port`).

## Before you start

VS Code uses CIMD: `https://vscode.dev/oauth/client-metadata.json`, redirects
`http://127.0.0.1:33418/` and `https://vscode.dev/redirect`.

**[DECIDED]** (owner decision 2026-10-13, OD-5 revised) By default
(`EXPONETDB_OAUTH_CLIENT_REGISTRATION=open`) no administrator step is needed:
ExponetDB fetches and records that URL when VS Code first reaches
`/oauth/authorize` and approves it automatically. You still sign in with your
passkey and consent to the client, the scopes and the tiers. See
[oauth.md §3](../oauth.md#3-client-registration) and
[OD-5](../../00-product/open-decisions.md). Under
`EXPONETDB_OAUTH_CLIENT_REGISTRATION=review` an administrator fetches that URL
for review on **Admin → Clients** and approves it once. VS Code speaks
2025-11-25 (served on the same URL).

## Configure

`.vscode/mcp.json`:

```json
{ "servers": { "exponetdb": { "type": "http", "url": "https://db.exponet.cloud/mcp" } } }
```

Lab and tests only, a token instead of OAuth:
`"headers": { "Authorization": "Bearer ${input:exo-token}" }` with
`"inputs": [{ "type": "promptString", "id": "exo-token", "description": "ExponetDB token", "password": true }]`.
`code --add-mcp '{…}'` adds a server from the command line.

## Sign in

VS Code asks to trust the server, then opens the consent page. On a `401` or
`403` with a token it signs in again once and **replaces** the scopes rather
than adding to them: ask for every scope you need at the first sign-in.

## First check

**MCP: List Servers → Show Output**, then ask Copilot to list the targets.
VS Code skips the confirmation for `readOnlyHint` tools; for the others its
dialog lets you edit the arguments before they are sent.

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
| The browser shows ExponetDB's error page with `client_unknown` | the `client_id` is neither registered nor a valid CIMD URL whose document validates, or the registration rate limit was hit (10 new clients per address and hour, 100 per hour in total) | check the `client_id` URL and that its metadata document validates; wait for the rate limit; under `review` an administrator first opens **Admin → Clients**, "Fetch for review" with the exact URL, then approves it |
| `client_not_approved` | an administrator rejected or disabled the client (it is never approved automatically again); under `review` the client is also refused while it is pending | an administrator checks the client on **Admin → Clients**: the name is shown as *not verified*; check the redirect hosts and the lookalike warning; under `review` approve exactly this `client_id` |
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
| | | | everything | **NOT RUN**: VS Code is not installed in this environment; owner test package §F |
