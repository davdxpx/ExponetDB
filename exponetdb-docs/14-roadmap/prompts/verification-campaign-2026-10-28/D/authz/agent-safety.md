# Agent safety, static pass (block D, tester D1)

Tree: `d51da5d0` (fix PR #46 merged). Method: reading the code paths named below plus the generated tables
(`authz-matrix.md` sections 5 and 8, `authz-matrix.json`). Nothing here ran against a server; where a
claim needs a live run it says NOT RUN. File:line are at `d51da5d0`.

## 1. Answers

| Question | Answer | Evidence |
|---|---|---|
| Does DB-derived text reach a tool result unmarked? | Mostly no. 24 of 30 tools return no foreign text or mark it. **One class does:** plan tools return `change.analysis` and `change.content` as plain JSON values (identifiers and `verify.sql` directive text from the bundle), and `advisors_run` returns `findings[].evidence{}` unmarked. See F-D1-3. | 3.1 below |
| Does any policy decision consume agent-supplied free text? | No agent text. Policy rules read server-computed facts only (`content.facts` of the planner, session classification, tier, principal). **One rule consumes target-side text:** `connections.*` protection treats a session as ExponetDB's or a backup tool's by its client-set `application_name`. See F-D1-4. | 3.2 below |
| Is every production change started through MCP routed to a human approval? | Yes for every action an MCP client can reach: the only MCP-reachable consequential kinds are the migration kinds, and `migration.agent-production` (require approval, prod only) covers all four. Not covered, but not reachable through MCP: service-account (`ci`) REST callers of `connections.cancel`, `backup.verify`, `backup.catalog.refresh`, `node.inspect` (class low, no approval rule, by design) and the unimplemented `packages.apply_update` (F-D1-5). | 3.3 below |
| Can an MCP client approve? | No. `approval.approve` and `approval.reject` admit client kind `web` only (`packages/contracts/src/actions.ts:842`); the engine denies any bearer for it (`engine.ts:536`); no tool, no forbidden-name loophole (`tools.ts:877`). An elicitation answer is not read as a decision (`request-state.ts:11-13`). | 3.3 |
| Can an MCP client apply a plan another actor created? | No. `acceptPlan` requires the same identity, client kind and registered client id (`packages/operations/src/accept.ts:159`, refusal `PLAN_BINDING_ACTOR` at :168); withdraw and cancel bind the same (`plans.ts:397`, `application.ts:1943`). | 3.4 |
| Replay of a plan, token or step-up receipt? | Plans are single-use (`consumed` state, `accept.ts:160-166`); a receipt is bound to installation, identity, client, grant, action, plan id and plan hash, locked `FOR UPDATE` and marked redeemed in the request's transaction (`stepup.ts:350`, `:376`); a `requestState` is sealed AES-GCM, bound to identity, client, grant, tool and argument digest, expires in 10 min and only re-reads an operation (`request-state.ts:30-60`). | 3.4 |
| Escalation through OAuth scope, DCR or CIMD? | Not found. CIMD and DCR clients are inserted with the fixed client kind `mcp` (`packages/auth/src/oauth/registry.ts:205`, `:648`); `mcp` never holds the `api` audience (`engine.ts:561-571`) nor an MCP-ineligible scope (`scopes.ts:169`, `isScopeGrantableTo`); production and human-only scopes need a fresh proof at consent (`consent.ts:207-262`). Residual by decision: OD-5 revised (2026-10-13) approves new DCR/CIMD clients automatically; the person still consents. | 3.5 |

## 2. How the MCP surface decides access

- `tools/list` is a convenience: `usable()` (`apps/server/src/interfaces/mcp/registry.ts:441`) hides tools the grant cannot use. `call` does not consult it; the use case asks the engine on every call (`registry.ts` BINDINGS, line 132; every binding calls the same use case as the REST route). The generated evidence column shows a full `authorize` (phase 1 and 2) reached for 29 of 30 tools; `targets_list` is phase 1 plus visibility filtering by design.
- The catalog has no tool named like an approval, break-glass, credential, registry or access write, and no input named `confirm`, `force`, `skip*`, `override*` or `dryRun` (`packages/contracts/src/mcp/tools.ts:877`, `:926`; a test pins both). No MCP input carries a `reason`, `intent` or `description`: the string inputs are `sql`, `params`, bundle files, `object`, `q`, `kind`, `application`, `action`, `schema` (checked on the served schemas).

## 3. Detail

### 3.1 Foreign text in results

Mechanisms, in the order a result passes them:

1. Output contract: fields that carry database, catalog or caller text are declared with `untrustedText` / `untrustedJson` (`packages/contracts/src/common.ts:208`, `:240`), which puts `untrusted: true` into the served output schema; `openWorldHint` is derived from it (`tools.ts` annotations).
2. Catalog text of one object is cut at MCP caps and the cut is named by a JSON pointer made by the server (`registry.ts:326-440`; the `truncated[]` strings are pointers with numeric indexes, so they are server-made).
3. Every string and object key is escaped for display: control, bidi, zero-width, tag characters become `\u{HEX}` (`apps/server/src/interfaces/mcp/results.ts:30-60`), applied to `structuredContent` (`registry.ts:717`, `escapeValue(output.data)`).
4. The text block a model reads starts with lines the server writes from its own facts (`serverLines`, `registry.ts:480`: ids, enum states, the plan hash, the approval link, the grant's scope names; verified that it interpolates no database string), then the JSON between random-tag markers with links, images, fences, `<` and `>` defused (`results.ts:65-90`).
5. Resources: static guides plus one target summary per target; the summary carries registry display names only and is escaped (`resources.ts:185`) but not defused like the tool text (cosmetic).

Gap (F-D1-3): `authz-matrix.md` section 8 lists, per tool, free strings not marked untrusted. After removing server prose (rule messages) and pointer lists, what remains is:

- `plan_get`, `migration_plan`, `migration_rollback_plan`, `plan_withdraw`: `change.content` and `change.analysis` (`PlanViewSchema`, `packages/contracts/src/rest/resources.ts:1395`) are `JsonValue`. For migration plans `analysis` holds, from the bundle's SQL: `destructive[]` (`kind schema.name`, up to 300 characters, `analysis.ts:189`), `statements[].lock.objects[]` (up to 300), `verify.checks[].name` and `covers[]` (the free text after `-- check:` / `-- covers:` comments of `verify.sql`, 128 characters each, `analysis.ts:205-215`; parser `packages/postgres/src/parser/verify-checks.ts:44`), `consumer.identity` (400), and lint `message` / `remediation` (`analysis.ts:55`). `openWorldHint` is `false` for these tools. The contract text says migration plan content "never carries SQL text" (true) and `application.ts:1361-1365` (the approval review) says "no number or word in it comes from an agent" (not true for the check names).
- `advisors_run`: `findings[].evidence{}` values (256 characters) are not marked; `message`, `object`, `remediation` are.
- Not a gap: `sql_query.rows`, `sql_explain.plan` (marked at container level), `schema_*`, `sessions_list`, `locks_list` (the unmarked members are PostgreSQL's fixed vocabularies: `state`, wait event type), `backups_list` LSNs.

Risk is bounded (escaped, defused, at most 300 characters per item, the reader normally authored the plan) but it is exactly the channel the safety document promises to label (`ai-agent-safety.md:38`): another actor's plan read by an agent, and the approval page.

### 3.2 Policy inputs

- Rules receive `PolicyRequest` = kind, principal (kind, client, identity), subject scope and tier, optional break-glass, `content` (`packages/policy/src/model.ts:50`). A search of `packages/policy/src/catalog/*` shows `content` members used: `facts` (planner output: enums, counts, booleans), `session.protected` (an enum computed by SQL), `purpose` / `source.verification` / `source.walContinuous` / `repository.ownership` / `kind` (enums validated by the contract), `selfApproval` (a boolean the approver sets). No rule reads `reason`, `intent`, `note` or `description`.
- The planner computes the migration facts from the stored bundles, the live target and the evidence target (`planner.ts:744-830`), never from manifest claims: `lockSeverity`, `compatibility`, `nontransactional`, `blockingFindings`, `consumerCode`, `procedural` all come from parsing and lint.
- `data.read` decides on principal, tier, mode and the effective setting; `agent` is "not a person through the Web App or the first-party CLI" (`data.ts:64`, `facts.ts:46`). The same definition is repeated in `backups.ts:310` and (differently written) `migrations.ts:487`: four copies.
- F-D1-4: `protectedSession` (`packages/postgres/src/session-conditions.ts:74-80`) treats a session as untouchable when the **client-set** `application_name` starts with `exponetdb/` or matches the backup-tool pattern. Any application can set that name, which makes its own sessions immune to `connections.cancel` / `terminate` by ExponetDB. Target-side text decides a policy outcome (a deny), against the principle "content is untrusted".

### 3.3 Production changes initiated by an agent

Generated list (`authz-matrix.md` section 5): the actions an MCP client (M) or a service account (S) can reach with effect other than read, and the policy rules that gate them.

| Reachable by MCP | Prod gate |
|---|---|
| `migration.apply`, `migration.rollback`, `migration.resume`, `migration.verify` (planned by `migration_plan`, `migration_rollback_plan`, `migration_verify`, applied by `plan_apply`) | `migration.agent-production` (approval, prod only, `migrations.ts:473-496`); `plan_apply` returns an `awaiting_approval` operation and the link; the person approves in the Web App (re-auth 300 s) |
| `drift.check`, `advisors_run` | Control Store records only (OD-34, OD-57); no target change |
| `plan.withdraw`, `operation.cancel` | own plans and operations only |
| `sql_query`, `sql_explain`, `sql_cancel` | `data.read` rule: prod `humans_only` by default; `analyze` refused to agents |

MCP cannot create node, backup, restore or connection plans (no tool; OD-29). Those kinds are reachable by service accounts through REST: `postgres.*`, `credential.rotate`, `node.config.update` are under `node.prod-apply-approval` (`nodes.ts:16-27`), `backup.run` under `backup.run-agent-prod-approval`, `connections.terminate` under `connections.prod-terminate-approval`.

Open points: F-D1-5 (`packages.apply_update` has no rule; the test that pins "every node mutation is under the rule" filters by wave `5` or `8`, `node-rules.test.ts:99`, so it cannot notice the kind); `connections.cancel`, `backup.verify`, `backup.catalog.refresh`, `node.inspect` are consequential, class low, with no approval requirement for a service account even on production. That matches the documented table (authorization.md section 4: only terminate needs approval) and is listed for the owner as a decision (D-D1-2).

### 3.4 Replay and cross-actor use

- `plan.apply` = `readPlan` (404 if absent) -> `#withStepUp` -> `#authorize('plan.apply', plan kind, plan subject)` -> `acceptPlan` (`application.ts:2364-2440`). `acceptPlan` rejects `consumed` plans unless the same caller repeats (it then gets the same operation), rejects other callers with `PLAN_BINDING_ACTOR`, then checks state, expiry, kind bindings (`checkBindings`), policy re-evaluation (`recheckPolicy`) and requirements (`accept.ts:148-217`).
- Idempotency keys are scoped to the principal (`idempotencyPrincipal` in `#plan` / `#inline`, `application.ts:2172`, `:2210`) and bound to a request hash.
- A step-up receipt for the CLI is created from server state (the plan's stored hash, the grant), confirmed in the Web App with a fresh passkey/TOTP proof, matched against a binding digest and redeemed once (`application.ts:1712-1770`, `stepup.ts:350-405`).

### 3.5 OAuth

- DCR and CIMD never choose the client kind (`registry.ts:205`, `:648`). Scopes offered at consent come from the identity's live bindings (`scopeOffers`); `checkChoice` refuses a scope not offered (`SCOPE_NOT_DELEGABLE`), requires an explicit production acknowledgement and a fresh proof (300 s) when a write scope is chosen for production or any human-only scope (`consent.ts:207-262`). Note this is enforced in the OAuth code, not through the `reauthentication` flag of the action registry (`oauth.consent` declares none).
- An MCP token is rejected at `/api/v1` and an API token at `/mcp` (`engine.ts:561-571`, `bearer.ts`).

## 4. Decisions and findings

Findings are in `d1-notes.md` (and in the tester's final message): F-D1-1 existence oracle through lookup before admission; F-D1-2 body parsed before permission (reproduced); F-D1-3 unmarked plan analysis and advisor evidence; F-D1-4 `application_name` decides protection; F-D1-5 `packages.apply_update` outside the approval rule and its test; F-D1-6 `critical` plan re-authentication is policy-driven while the identity document says it is generic; F-D1-7 CLI declares scopes that differ from the action's.

## 5. NOT RUN

- The adversarial suite (`apps/server/test/mcp-adversarial.int.test.ts`, 14 grant forms x 19 goals) and `mcp.int.test.ts`: need PostgreSQL 17; not run here (block D2/stack).
- Any live MCP call. `run-matrix.ts` covers REST; the MCP half is a stub that prints NOT RUN.
- Runtime effect of F-D1-2 over HTTP with a real database and proxy (the in-process reproduction uses a stub use case).
