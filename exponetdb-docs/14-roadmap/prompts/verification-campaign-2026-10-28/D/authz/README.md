# D/authz: generated authorization matrix, harness and agent safety (tester D1)

Tree under test: `d51da5d0d8832ebc569f23985c7e5176e4d450ad`. The generator ran in a private detached worktree
(`ExponetDB-verify-d1`, `bun install --frozen-lockfile`, Node 24.22.1, Bun 1.4.4); `ExponetDB-verify` was not touched.
Everything here is static or in-process: no server, no database, no network.

| File | What it is |
|---|---|
| `gen-matrix.ts` | The generator. `EXDB_TREE=<tree> bun --conditions=@exponetdb/source gen-matrix.ts [--out DIR]`. Deterministic (two runs, byte-identical output). |
| `lib-ast.ts` | Call-graph reachability from each REST handler (`HANDLERS`, `api.ts`) and MCP binding (`BINDINGS`, `mcp/registry.ts`) into the application layer, with string constant propagation, down to the engine calls (`authorize`, `admit`, `allowed`, `plan`, `inline`) and the lookups that run before them. Uses the tree's own `typescript`. |
| `lib-oracle.ts` | The EXPECTED side: authorization.md section 1 re-implemented from the contract tables, not from the engine. 8 credential classes (`owner admin developer-nonprod developer-prod viewer service-account oauth-narrow mcp-client`). |
| `lib-sample.ts` | Builds a valid-shaped request (params, query, body) from each route's JSON Schema; ids become `@id:xxx` placeholders. |
| `authz-matrix.md` | The compact matrix (one row per action; REST/MCP/CLI/Web bindings as columns), discrepancy lists, agent-reachable mutations, web operations per feature, MCP result-text table. 597 lines. |
| `authz-matrix.json` | Machine-readable: rows with expected `A`/`D` per credential class and tier, bindings, evidence, discrepancies. |
| `authz-samples.json` | Request samples for 204 of 220 REST routes and all MCP tools (16 routes need `bodies.json` overrides: email and `\p{Cc}` patterns). |
| `run-matrix.ts` | The harness. NOT RUN against a stack (see below). |
| `agent-safety.md` | Part 3 and 4 of the task with file:line. |
| `d1-notes.md` | The findings in the campaign format, decisions, triage of every discrepancy class. |
| `repro/ordering.repro.ts` | In-process reproduction for F-D1-2 (copy into `apps/server/` of a checkout and run with `bun --conditions=@exponetdb/source`). |

## What the generator reads (nothing by hand)

`ACTIONS` (265), `ROUTE_LIST` + `AUTH_ROUTES` (220 routes, all served: `servedRoutes()`), `MCP_TOOLS` (30, all served),
`COMMANDS` of the CLI (178, 138 remote), `SCOPES`, `BUILT_IN_ROLES`, the policy rule catalog (approval, deny, re-auth per
kind), the Web App sources (165 REST operations named, by feature), `authorization.md` (roles table section 3.1, scope table
section 4, permission table section 2) and `tool-catalog.md` (tool table). Code and documents agree on roles (6 x 27
permissions), scopes, permissions and tools: **0** documentation discrepancies.

## Limits of the static evidence (read before trusting a green cell)

- `Ev = S` means the action id reaches a call into the central engine from the handler, through the use case, with literal
  propagation. It does not prove the subject passed is the right one; the 15 id-taking routes were read by hand
  (d1-notes.md, section "IDOR read-through").
- Name collisions: a private `#target` and a public `target` share a name in `RegistryUseCases`; the walker visits both, so
  `getTarget` shows a "lookup before authorize" that is not on its path. Triage is in `d1-notes.md`.
- Fuzzy hops (receiver type unknown, at most 4 candidates) are flagged `w`; one route is left at `w` (`getRawStatement`,
  closed by reading `raw-statements.ts:64-67`).

## The harness (`run-matrix.ts`)

```
bun run-matrix.ts --self-test                         # the local-only guard: 10 refused, 6 accepted
bun run-matrix.ts --base http://10.0.0.5:8443 --creds ./creds --fixtures ./fixtures.json [--allow-mutations] [--only rest]
```
- Refuses any base URL that is not `localhost`, `127/8`, `::1` or an RFC 1918 IPv4 literal, any URL with credentials,
  any host containing `exponet`, link-local and public addresses; every request URL is re-checked; redirects are
  refused, never followed. Verified here: `https://db.exponetdb.cloud` -> "refused", exit 3.
- Credentials: one file per class, `<creds>/<class>.token` (one line, never printed). Fixtures: `{"targets":{"nonprod":"tgt_…","prod":"tgt_…"},"ids":{"planId":"pln_…"},"foreign":{"planId":"pln_… (a plan the credential may not see)","nodeId":"nod_…"}}`.
- For every REST row x class x tier it sends the sample and compares `A`/`D` with `exp`; a 400/422 is `BAD-SAMPLE` (validation runs
  before authorization, so it proves nothing); 5xx is `DEFECT-5xx`; `D` expected but `A` observed is `AUTHZ-BYPASS?`.
  Allowed mutations are skipped unless `--allow-mutations` (disposable stack only).
- Existence oracle: for each `foreign` id the answer must equal the answer for a fabricated id (status and code).
- Mechanics were tested against a local mock that answers 403/404 to everything (1,627 calls, expected-vs-observed table and
  existence differences produced). This tests the harness, not the product.
- NOT RUN: the live comparison; the MCP half (prints a NOT RUN line; drive `@exponetdb/testkit/mcp` with the `mcp` samples);
  Web-session-only actions (need a passkey session; the harness only proves every bearer is refused for them).

## Discrepancy triage (counts from `authz-matrix.md` section 2)

| Class | n | Verdict |
|---|---:|---|
| lookup-before-authz | 25 | 14 real (F-D1-1: nodes 7, backup repositories 2, registry plans and target registration 5); 4 documented residual (plan/operation ids at apply, withdraw, approve, reject: error-model.md:365); 6 benign (read then conceal: plan and operation reads and lists, retry, cancel); 1 name collision (`getTarget`) |
| mutation-inline | 28 | all `class low` inline plans, the documented exception; verification required on all |
| humanonly-consequential-no-reauth | 17 | no document promises re-auth for them; prod variants are under approval+re-auth policy rules where listed (`migration.baseline`, `ledger.reconcile`, `drift.accept`); see D-D1-1 |
| tier-target-mutation-untiered | 15 | plan/record kinds and `migrations.import` kinds (human-only, owner/admin); production gates are policy rules |
| authz-admit-only | 9 | visibility-filtered lists (products, projects, targets, fleet, finding summary, `targets_list`) and the three step-up actions (own_grant, bound inside the use case) |
| control-record-security-state | 7 | approvals, break-glass, CIMD registration: security state outside plan/apply by design |
| cli-scope-mismatch | 6 | real, F-D1-7 |
| agent-consequential-no-policy-rule | 5 | `plan.apply` (rules belong to the plan kind), `packages.apply_update` (F-D1-5), 3 class-low inline actions (D-D1-2) |
| action-no-surface / action-kind-no-planner | 5 / 5 | documented: `target.identity.stamp`, `ledger.initialize` are steps of `target.register` (operations-engine.md:68, :90), `migration.rebaseline` and `operation.force_release` are planned (G6 record), `migration.import.replay` comes from the import flow |
| authz-weak-evidence / reauth-declared-not-proven | 1 / 1 | `getRawStatement`: closed by hand (admit and authorize with the `ACTION` constant) |
| mcp-unmarked-free-text | 6 | F-D1-3 (plan tools, advisors_run); `migration_lint` echoes the caller's own input |
