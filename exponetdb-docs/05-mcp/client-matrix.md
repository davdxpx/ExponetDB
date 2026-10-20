# MCP client matrix

| | |
|---|---|
| Status | Wave 7. Research state 2026-10-12 (Wave 7 order §35), re-checked against primary sources on 2026-10-13 |
| Related | [`clients/`](./clients/) (one guide per client), [`protocol-baseline.md`](./protocol-baseline.md), [`oauth.md`](./oauth.md), [`owner-test-package.md`](./owner-test-package.md) |

Marks: **C** seen in a primary source (documentation, changelog, source code,
the client's own metadata document; re-checked 2026-10-13 unless noted),
**R** reported (staff or user post), **U** not established. The specification
says what is allowed; the clients do what they do, and their behavior
changes weekly.

## 1. The five target clients

| | Claude Code | Claude (web, desktop, mobile) | Cursor | Codex (CLI, IDE) | VS Code (Copilot) |
|---|---|---|---|---|---|
| Version (2026-10-13) | 2.1.296 (npm `latest`; `stable` 2.1.287) (C) | service | 3.21.x (R) | 0.162.1 (npm `latest`) (C) | 1.141.0 (C) |
| Protocol revision | negotiates 2026-07-28; `MCP_PROTOCOL_NEGOTIATION=legacy` opts out (C) | auth specs up to 2025-11-25 documented; 2026-07-28 announced (C) | up to 2025-11-25 (R) | legacy by default (`initialize` with 2025-06-18); 2026-07-28 only behind `[features] mcp_2026_07_28 = true`, in source, off by default (C) | 2025-11-25 only; vscode#329848 open (C) |
| Registration | CIMD `https://claude.ai/oauth/claude-code-client-metadata`, DCR, `--client-id` (C) | CIMD when the AS advertises it and `none` (C; the URL `https://claude.ai/oauth/mcp-oauth-client-metadata` is live but not documented), DCR, own client (C) | **no CIMD** (C, staff 2026-09-22); DCR; static `auth.CLIENT_ID` (C) | CIMD `https://chatgpt.com/oauth/codex/client.json` when the AS sends `iss` (ExponetDB does), DCR, static `oauth.client_id` (C) | CIMD `https://vscode.dev/oauth/client-metadata.json` (C, since 1.106), DCR, static `oauth.clientId` (C) |
| Redirect URIs | `http://localhost/callback`, `http://127.0.0.1/callback`, any port (C) | `https://claude.ai/api/mcp/auth_callback` (C) | `http://localhost:8787/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` (C; the earlier `cursor://` scheme is no longer documented) | `http://127.0.0.1:<port>/callback` (C) | `http://127.0.0.1:33418/` and `https://vscode.dev/redirect` (C; the extension guide writes the loopback without the slash) |
| 401/403, step-up | step-up prompt from 2.1.288 (C) | 403 `insufficient_scope` leads to re-authentication (C) | no step-up (R) | no step-up (R) | re-authenticates on 401/403 and **replaces** scopes (C) |
| Annotations | not used for permissions (R): allow rules instead | `readOnlyHint` without a prompt, destructive always asks (C) | U | mode `writes` asks for non-read-only tools (C) | `readOnlyHint` skips the confirmation (C) |
| URL elicitation | form and URL; modern from 2.1.281 (C) | U | U | form; URL U (C) | declares `form` and `url` (C) |
| Results | `structuredContent` used; invalid schemas dropped silently (C) | parts may be lost (R) | drops a result with only `structuredContent` (R) | output schemas shared (C) | U |
| Limits | 25 000 output tokens; descriptions cut at 2 048 characters (C) | ~150 000 characters, 240 s per call (C) | server and tool name ≤ 60 characters (R) | start 10 s, tool 60 s by default (C) | 128 tools per request (C) |
| Network | local | Anthropic's cloud: IPv4 from `160.79.104.0/21`, public HTTPS URL, no redirect to another host (C) | local or Cursor's cloud for agents | local | local |
| Automation | `claude -p` (headless) | none | `agent -p --approve-mcps` | `codex exec --json` | none |

Other clients (not a G7 requirement): ChatGPT developer mode (CIMD, DCR,
static; `readOnlyHint` decides the confirmation; a loop after
`insufficient_scope` is reported), Gemini CLI (a `GET` without a token;
tool names cut at 63 characters), Windsurf (100 tools), Zed, JetBrains AI
Assistant (no documented OAuth), Goose (CIMD, DCR), Continue.

## 2. What the server does about it

Each line is a test or a recorded decision ([`protocol-baseline.md`](./protocol-baseline.md)).

1. Both eras on one URL; a request without a version header and without
   `_meta` that is not `initialize` is served as legacy (VS Code sends the
   header only to the metadata requests).
2. `GET` and `DELETE` are `405` with `Allow: POST` before authentication; no
   session header is issued or honored.
3. A refusal by permission, tier, policy or plan state is a tool error with
   a code and a remedy, never `403`; `403` is only `insufficient_scope` (with
   the challenge and a readable body) and a foreign `Origin`. An invalid
   token is `401`.
4. Step-up is not reliable across clients: every guide shows how to ask for
   the needed scopes from the start.
5. The authorization server advertises CIMD, `none`, DCR and the `iss`
   parameter; redirect URIs are `https` or loopback `http` with an exact
   match except the loopback port (RFC 8252). A custom scheme
   (`cursor://`, `vscode://`) is refused (order decision 7; no target
   client depends on one today).
6. Every result has a text block; an approval link is always in the text;
   an error has no `structuredContent`.
7. All tools fit one `tools/list` page (26); names `[a-z0-9_]`, at most 48
   characters; descriptions under 2 048 characters; flat object schemas
   that mean the same in Draft-07 and 2020-12 (Inspector `--strict`: no
   finding).
8. A call ends within the edge's 90 s request deadline (`504` with a
   message after it): `operation_get` waits at most 20 s (`waitSeconds`), a
   data read at most its 60 s statement timeout; approvals are never awaited
   in a call. A client with a shorter tool timeout (below 60 s) can give up
   on a slow read that still completes; `sql_cancel` ends it. The
   `toolCallMs` value (50 s) of `MCP_REQUEST_LIMITS` is not enforced
   [OBSERVED].
9. `clientInfo.name` decides nothing; only the `client_id` and the client
   kind do, and a display name is shown as not verified.

**[DECIDED]** (owner decision 2026-10-13, OD-5 revised) By default
(`EXPONETDB_OAUTH_CLIENT_REGISTRATION=open`) a client needs no administrator
step: a CIMD client is fetched and recorded when it first reaches
`/oauth/authorize` and is approved automatically, a DCR registration is active
at once. Every person still signs in and consents to the client, the scopes
and the tiers. An administrator can **disable** a client or **reject** a
pending one on **Access → OAuth clients** (`/access/oauth-clients`); such a client is never
approved automatically and stays refused (`client_not_approved`). Under
`EXPONETDB_OAUTH_CLIENT_REGISTRATION=review` (the previous behavior, OD-5
(a), "no silent pre-trust") every client needs one administrator approval of
its exact `client_id` before a person can connect it: a CIMD client after
"Fetch for review" of its metadata URL, a DCR client after its registration
arrives pending. See [oauth.md §3](./oauth.md#3-client-registration) and
[OD-5](../00-product/open-decisions.md).

## 3. Evidence

| Client | Version | Era | What ran | Where | Result |
|---|---|---|---|---|---|
| `@modelcontextprotocol/client` (SDK) | 2.3.1 | both | list, calls, URL elicitation, replay | test composition, integration world, lab | see [`../14-roadmap/gates/7.md`](../14-roadmap/gates/7.md) §5.2g and §5.2i |
| MCP Inspector CLI | 2.10.1 | both | `tools/list --strict`, a call, a refused token | test composition, lab | see the record |
| Claude Code | 2.1.296 | both | connection and tool list with the fixture's token as a header (`claude mcp add --header`, `claude mcp list`, `claude mcp get`; throwaway `HOME`, no model, no OAuth sign-in) | test composition over a real socket (`apps/server/test/support/mcp-fixture-server.ts`) | see the record §5.2i |
| Claude Code (OAuth sign-in, a model run) | | | **NOT RUN**: it uses the owner's account and quota; the owner runs it (owner test package §C) | | |
| Claude (web, desktop, mobile) | | | **NOT RUN**: needs the public HTTPS URL; the owner runs it after the rollout (§F) | | |
| Cursor, Codex, VS Code | | | **NOT RUN**: not installed in this environment; the owner runs them (§F) | | |

Watch list (re-check before the acceptance): Claude Code #84263 (CIMD fetch
`403`), Claude apps dropping MRTR elicitations and cutting results, Cursor
(no CIMD, no step-up, `[::1]` loopback, `structuredContent`), Codex #50857,
#20518, #41600, VS Code #329848, #308766, #321834, ChatGPT #244.
