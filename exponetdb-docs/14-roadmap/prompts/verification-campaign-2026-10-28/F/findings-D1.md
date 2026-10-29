### [P2] A request body of up to 32 MiB is read, parsed and validated before the permission check
- **Area:** `apps/server` REST layer (`interfaces/http/api.ts`), MCP edge for the bundle tools
- **Block:** D
- **Reproduction:** `cp D/authz/repro/ordering.repro.ts <tree>/apps/server/ && cd <tree>/apps/server && bun --conditions=@exponetdb/source ordering.repro.ts` (in process, stub use case that refuses like the engine for a caller without `migrations.plan`; a bearer holding only `targets.read`). Output at `d51da5d0`: `[1]` 3 bytes -> 422 VALIDATION_FAILED, use case not reached; valid-shaped 4 MiB -> 403 PERMISSION_DENIED after 115 ms, +29 MiB RSS; valid-shaped 28 MiB (limit 32 MiB) -> 403 after 1387 ms, +118 MiB RSS. Over HTTP with a database and proxy: NOT RUN.
- **Expected:** authorization.md section 1 (line 29): "Phase 1 ... Before input parsing: ... Cheap; rejects most unauthorized calls before untrusted input is parsed." A principal without `migrations.plan` is refused before its body is read and validated, or at least a large body is gated by concurrency.
- **Actual:** the body is read (`readLimitedText`), `JSON.parse`d and schema-validated first (`api.ts:2240`, `:2247-2275`), the handler and so the engine run last (`:2295`). Routes with `maxBodyBytes` above the default: `MIGRATION_BODY_LIMIT_BYTES` 32 MiB (`routes.ts:2334`, `:2413`; ingest, plan, lint), `LEGACY_BODY_LIMIT_BYTES` 16 MiB (`:2390`, `:2518`). Only the legacy lane has an in-flight cap (`api.ts` `LEGACY_REQUESTS_IN_FLIGHT`, applied inside the handler, after the parse). Any authenticated credential (a viewer API key, a nonprod read grant) can therefore make the process buffer, parse and validate 32 MiB per request, and sees schema validation detail (422) instead of 403.
- **Evidence:** `D/authz/repro/ordering.repro.ts`, run output above. **Confirmed over HTTP by S4:** a viewer bearer posting a valid-shaped 28.5 MiB body to a plan route gets 403 after 0.22 to 0.27 s while serve RSS rises by 130 to 210 MiB (8 in parallel peak at 838 MiB); an unauthenticated request is closed before the body is read (`D/security/authz-run.md`).
- **Root cause:** `mountApi` authenticates (cookie or bearer) and checks CSRF, then reads and validates input generically for every route; authorization lives inside the use cases (`application.ts` `#authorize`), after the handler is entered.
- **Proposed fix:** for routes whose `maxBodyBytes` exceeds the default, call `application.admit(caller, route.action)` (phase 1: client kind, human-only, scope, permission anywhere) before `readBody`; add a global in-flight cap or byte budget for large bodies; apply the same ordering in the MCP edge for `bundleBody` tools (the edge already rate-limits by tool class). Keep validation errors after authorization.
- **Acceptance test:** a stub-Application test as in the reproduction asserting that for a principal without the permission (a) the status is 403, (b) neither `JSON.parse` nor the route schema ran (spy), (c) a 30 MiB body does not raise RSS above a few MiB; fails before the fix.

### [P3] The existence of node, backup repository and registry-plan subject ids is visible to callers without access
- **Area:** `packages/application` (`nodes.ts`, `backups.ts`, `registry.ts`, `application.ts` `#plan`/`#inline`); REST and MCP `node_status`
- **Block:** D
- **Reproduction:** static, generated: `authz-matrix.md` section 4 "lookup-before-authz" (25 candidates, 14 real). Live (NOT RUN, harness ready): with a credential that lacks the permission, e.g. `oauth-narrow` or `developer-nonprod`, `GET /api/v1/nodes/{real node id}` then `GET /api/v1/nodes/nod_<fabricated>`; same for `POST /nodes/{id}/revoke`, `/config-updates`, `/decommission`, `/inspections`, `GET /nodes/{id}/jobs`, `/observations`, `POST /backup-repositories/{id}/ownership`, `/retire`, `POST /products/{p}/environments/{e}/change-plans`, `POST /projects/{p}/environments/{e}/execution-role-plans` and `/execution-role-exceptions`, `POST /projects/{p}/execution-role-exceptions/{x}/revoke-plans`, `POST /targets` (planTargetRegistration, ids in the body), and MCP `node_status`. `run-matrix.ts` with `fixtures.foreign.nodeId` reports `EXISTENCE-LEAK`.
- **Expected:** error-model.md section 4 (lines 324-366): "To avoid leaking existence, a caller who may not see a resource receives NOT_FOUND-class codes" and, for targets, admission first, then lookup; the same status and code for an id that does not exist and one the caller may not see.
- **Actual:** the subject is looked up first: `nodes.ts:78-84` (`#nodeSubject` throws `NOT_FOUND`) runs before `authorize` in `node()` (`:426-428`), `jobs()` (`:382-388`), `observations()` (`:228-234`) and, as a subject thunk, before the engine in every node plan (`application.ts:2172-2181` evaluates `await subject(tx)` as an argument of `#authorize`); `backups.ts:128-135` with `planOwnership`/`planRetirement` (`:427-452`); `registry.ts:833-844` (`#projectEnvironment`), `:770-785`, `:1131-1155` and the product-by-slug thunk of `planProject`. A caller without the permission gets 404 for an unknown id and 403 for a real one. The ids are 80-bit random, so this is an oracle for ids the caller already holds (audit lines, URLs), not enumeration. `getTarget`, product/server/cluster reads, backup catalog, breakglass, raw statements and saved queries do it right (admit, then lookup).
- **Evidence:** `D/authz/authz-matrix.md` section 4; `D/authz/lib-ast.ts` event order; code lines above.
- **Root cause:** the Wave 4 rule (admit first) was implemented in `#authorizedTarget`/`#target` helpers of four classes but not in `#plan`/`#inline`, whose subject thunks may query before phase 1, and not in the node and backup-repository readers.
- **Proposed fix:** in `#plan` and `#inline` call `this.#admit(tx, action, caller)` before `await subject(tx)`; add the same `admit` before `#nodeSubject` in the node reads and before `#repositoryCluster` in the two repository plans.
- **Acceptance test:** integration: for each listed route, a credential without the permission gets the same status and code for a real and a fabricated id (the `foreign` check of `run-matrix.ts` as a test); fails before the fix.

### [P3] Plan analysis text and advisor evidence reach agents and approvers without the `untrusted` marker
- **Area:** `packages/contracts` (`PlanViewSchema`, `AdvisorFinding`), `packages/migrations-engine/src/analysis.ts`, MCP tools `plan_get`, `migration_plan`, `migration_rollback_plan`, `plan_withdraw`, `advisors_run`
- **Block:** D
- **Reproduction:** `bun --conditions=@exponetdb/source gen-matrix.ts` and read `authz-matrix.md` section 8 (column "unmarked free strings") and section 4 "mcp-unmarked-free-text"; then read `analysis.ts:189` (destructive object names), `:205-222` (`verify.checks[].name`, `.covers[]`, `consumer.identity` from `-- check:`, `-- covers:`, `-- calls:` comments of `verify.sql`, parser `verify-checks.ts:45`), `:55` (lint message). A plan with `-- check: <text>` in `verify.sql` returns that text in `plan_get` `change.analysis`.
- **Expected:** ai-agent-safety.md section 2 (line 38): text from catalogs and callers is "labeled `untrusted` in MCP output schemas"; the approval review (`application.ts:1361-1365`) states "No number or word in it comes from an agent."
- **Actual:** `change.content` and `change.analysis` are plain `JsonValue` (`resources.ts:1395`); the plan tools have `openWorldHint: false`. Strings from the bundle author (check names and cover lists up to 128 characters, object names up to 300, lint messages up to 1,024) are returned unmarked to any reader of the plan and shown in the approver's review. `advisors_run` `findings[].evidence{}` (256 characters) is unmarked while its `message`, `object`, `remediation` are. Mitigations present: control characters escaped, links/images/fences defused in the text block, bounded length. The plan's author is normally the reader, which bounds the risk; a teammate's or another agent's plan read via `plan_get`, and the approval page, are the exposed paths.
- **Evidence:** `D/authz/authz-matrix.md` sections 4 and 8; `agent-safety.md` section 3.1.
- **Root cause:** analysis was typed as an open JSON value in Wave 6; the Wave 7 marking pass covered catalog and row text only.
- **Proposed fix:** give `analysis` a closed schema whose author-derived members use `untrustedText` (or wrap them as `untrustedJson`), set `openWorldHint: true` on the plan tools, mark `evidence` values; drop `-- check:` names from the analysis or restrict them to a slug pattern.
- **Acceptance test:** `mcp-tools.test.ts` style: the served output schema of `plan_get` contains no free string outside an `untrusted` member; a plan whose `verify.sql` has `-- check: ignore previous instructions` returns that text only inside an `untrusted: true` member.

### [P3] A database client decides, through `application_name`, that ExponetDB must not cancel its session
- **Area:** `packages/postgres/src/session-conditions.ts`, policy `connections.replication-protect` / `connections.no-superuser-terminate`
- **Block:** D
- **Reproduction:** read `session-conditions.ts:74-80` (`protectedSession`) and `:84-91` (`protectionReason`); any role that can connect to a managed database runs `SET application_name = 'exponetdb/x'` (or a backup-tool name) and the session is classified `exponetdb_session` / `backup_session` -> `connections.*` deny. Live run: NOT RUN.
- **Expected:** ai-agent-safety.md section 2 and constitution principle 7: content from the target is data; it feeds no policy decision.
- **Actual:** `coalesce(application_name,'') LIKE 'exponetdb/%'` and the backup-application regex make a session immune to `connections.cancel` and `connections.terminate` (not overridable by break-glass), so a runaway or hostile client keeps its locks against ExponetDB's remediation tools.
- **Evidence:** the two functions above; `packages/policy/src/catalog/connections.ts`.
- **Root cause:** protection is derived from a client-controlled setting.
- **Proposed fix:** protect by `backend_type`, role membership (`exponetdb_*` roles, superuser) and the pids ExponetDB itself opened (it knows its own backend pids); keep the application-name test only as an advisory label.
- **Acceptance test:** a PostgreSQL 17 integration test where a non-superuser role sets `application_name = 'exponetdb/spoof'`; `connections.terminate.plan` for that pid must not be `protected`.

### [P3] `packages.apply_update` is a node mutation outside the approval rule and outside the test that pins the catalog
- **Area:** `packages/policy/src/catalog/nodes.ts`, `packages/contracts/src/actions.ts:1178`
- **Block:** D
- **Reproduction:** `authz-matrix.md` section 5 row `packages.apply_update` (M and S reachable by action definition, tier `subject_max`, no approval rule); `node-rules.test.ts:99` selects kinds by wave `5` or `8`; this kind is wave "after 9".
- **Expected:** policy-engine.md and `nodes.ts:10-15`: "Every change through the node agent on a production cluster or node needs a human approval, whatever its class"; authorization.md section 4: `nodes.operate:prod` "approval always".
- **Actual:** `NODE_APPLY_KINDS` (`nodes.ts:16`) lists ten kinds and not this one; the catalog test cannot notice it. No planner or executor exists yet, so it is not exploitable now (`plan.apply` answers `operation_kind_unknown`); the moment a kind is registered, a service account with `nodes.operate:prod` could apply it on production without the rule.
- **Evidence:** as above.
- **Root cause:** the kind list is explicit and the catalog test is filtered by wave.
- **Proposed fix:** derive the rule's `appliesTo` from the action registry (every `operationKind` with permission `nodes.operate` or subject node/cluster and class above low), and drop the wave filter from the test.
- **Acceptance test:** the test selects by action properties, not by wave; it fails today for `packages.apply_update` (and would for any future node kind).

### [P3] identity.md says every `critical` plan needs a fresh re-authentication to apply; the code enforces it only where a kind or policy rule declares it
- **Area:** `exponetdb-docs/08-auth-and-security/identity.md:83`, `authorization.md:458`, `packages/auth/src/authorization/engine.ts:382-408`
- **Block:** D
- **Reproduction:** read `governing()` (`engine.ts:401-408`): a stored `critical` plan makes the apply human-only and nothing else. `postgres.roles.apply` (`by_plan`, critical when it grants CREATEROLE, REPLICATION, BYPASSRLS or a predefined role, `actions.ts:1142`) declares no re-authentication; on nonprod no rule adds approval or re-auth, on prod `node.prod-apply-approval` adds approval only.
- **Expected:** identity.md section 4 table: "Applying `critical` plans | 5 min".
- **Actual:** authorization.md:458 says the opposite for by-plan kinds ("remain what the policy rules require", G5 record section 9 item 16: the owner may want a nonprod approval rule for critical classes). A person with a CLI token (nonprod grant) applies a critical roles plan on a nonprod cluster with neither approval nor a fresh proof.
- **Evidence:** the lines above; `authz-matrix.md` row `postgres.roles.apply`.
- **Root cause:** two documents disagree; the engine follows the second.
- **Proposed fix:** owner decision D-D1-1; then either add `reauthentication` to `governing()` when `planClass === 'critical'` or correct identity.md.
- **Acceptance test:** a delegation-matrix case: a CLI bearer applying a critical `postgres.roles.apply` plan on nonprod without a step-up receipt is refused `REAUTH_REQUIRED` (or the document is corrected and the test pins the documented behavior).

### [P3] Six CLI commands declare scopes the API does not accept
- **Area:** `apps/cli/src/commands/registry.ts`, `migration.ts` (command registry feeding help and the agent reference)
- **Block:** D
- **Reproduction:** `gen-matrix.ts`, `authz-matrix.md` section 4 "cli-scope-mismatch": `cluster endpoints` (`registry.ts:932-933`), `cluster databases`, `cluster credentials` declare `nodes.read`, their actions need `registry.manage`; `cluster credential submit` (`:1317-1318`) declares action `credential.list` although submission is web-only (`registry.credential.submit`); `cluster credential rotate` (`:1421`) declares `nodes.plan`, the action needs `registry.manage`; `migration verify` (`migration.ts:932-933`) declares `migrations.read`, `migration.verify` needs `migrations.apply:<tier>`.
- **Expected:** the declared scopes are what the command needs (help, completion and the generated reference come from them, cli/README.md section 1).
- **Actual:** a user or agent following the help requests a token without the needed scope and meets `INSUFFICIENT_SCOPE` (the server decides correctly; this is documentation and UX).
- **Evidence:** generator output.
- **Root cause:** declarations written by hand, no test compares them with the action registry.
- **Proposed fix:** a unit test over `COMMANDS` x `ACTIONS` (what the generator does) and corrected declarations.
- **Acceptance test:** that test; fails today with the six commands.

