# `/api/v1`: GA readiness report (Wave 7)

| | |
|---|---|
| Status | **Report, not a declaration.** Owner decision 14 of the Wave 7 order: the owner decides GA at G7. |
| Date | 2026-10-13, on the Wave 7 branch (`davdxpx/ExponetDB#16`) |
| Related | [`architecture.md` §9](./architecture.md#9-versioning), [`../01-architecture/versioning.md`](../01-architecture/versioning.md), [`../13-integrations/sdk.md`](../13-integrations/sdk.md), [`../14-roadmap/gates/7.md`](../14-roadmap/gates/7.md) (criterion 18) |

`architecture.md` §9 says `/api/v1` becomes stable once declared GA at the end
of Wave 7: from then on additive changes only, a breaking change is
`/api/v2` with at least 12 months of parallel support. This report lists
what that promise would cover today, what is proven, and what stands in the
way. Every statement is **[OBSERVED]** on the branch unless marked.

## 1. What GA would cover

| Item | State |
|---|---|
| Documented operations (`packages/contracts/generated/openapi.json`, OpenAPI 3.1, `info.version` `v1`) | 132 |
| Served by `serve` (`servedRoutes()` in `apps/server/src/interfaces/http/api.ts`) | 126 |
| Documented but **not served** (answer `404`) | `GET /installation/health`, `GET /targets/{target}/query-stats`, `GET /targets/{target}/table-stats`, `POST /targets/{target}/advisor-runs`, `GET /clusters/{clusterId}/backups` (Wave 9), `POST /targets/{target}/ledger/reconcile-plans` |
| Operations by wave of origin | Wave 2: 8, 3A: 22, 3B: 20, 4: 41, 5: 11, 6: 23, 7: 3, 9: 4 |
| `/auth/*` (Web App ceremonies, 27 routes) | not part of `/api/v1`; a session-cookie surface of the Web App, not a public API |
| SDK | `@exponetdb/sdk` `1.0.0-alpha.1`, generated from the OpenAPI document; it follows the API |

## 2. Criteria

| # | Criterion | Evidence | State |
|---|---|---|---|
| 1 | One contract source; the document is generated and checked | `packages/contracts` → `generated/openapi.json`; `bun run verify:generated` fails on drift | met |
| 2 | Every operation names its action (and with it its permission) and its error codes in the contract | `x-exponetdb-action`, `x-exponetdb-action-class`, `x-exponetdb-errors` on all 132 operations | met |
| 3 | Stable error model | `error-model.md`; codes never renamed (`versioning.md`) | met; Wave 7 changed two answers (below) |
| 4 | Pagination, idempotency, rate limits documented and tested | `architecture.md` §4 to §7; integration suites | met |
| 5 | Authentication for programs | API keys of service accounts, OAuth for the CLI and CI (`private_key_jwt`), audience `api` distinct from `mcp` | met |
| 6 | Parity with the other interfaces | the MCP tools are bound to the same use cases with REST parity tests (`apps/server/test/mcp.int.test.ts`, `mcp-data.int.test.ts`); the CLI calls the same routes | met |
| 7 | The documented surface equals the served surface | 6 operations documented, not served | **not met** |
| 8 | A changelog that carries notice of changes | `architecture.md` §9 promises "notice in the changelog"; the repository has no changelog | **not met** |
| 9 | CI has run the matrix on the commit to be declared | no GitHub Actions runner has ever started for this repository | **not met** |
| 10 | Deployed and observed off-host | G2 off-host deployment evidence is still outstanding (`gates/2.md`) | **not met** |
| 11 | Open decisions that change the API | OD-22 (the declared-tier field on clusters is not implemented), OD-21 (notification channel; break-glass activation refused), OD-27 | open |

## 3. Changes Wave 7 made to existing answers

A client written against the Wave 6 API sees these differences; after GA
each would have needed `/api/v2` or an additive form:

- A target outside the caller's role scope answers `404 TARGET_NOT_FOUND`
  instead of `403 PERMISSION_DENIED` (`error-model.md` §4; the order's
  enumeration rule).
- Every `404` leaves no earlier than 50 ms after the request began (one time
  class for existence decisions).
- Applying a denied plan is `PLAN_DENIED` (G6 O5), no longer `PLAN_STALE`.
- Cancelling an operation also compares the registered client: another
  client of the person who applied the plan gets `403 PLAN_BINDING_ACTOR`
  (a defect fix, `gates/7.md` §5.2i).
- Additive only: the query routes (`runQuery`, `explainQuery`,
  `cancelQuery`), the audit filters `client` and `grant`, policy settings per
  target.

## 4. What the owner can decide

1. **GA for the served operations** after (a) the six unserved operations
   leave the GA document (marked planned, or moved to a `planned` list the
   generator keeps out of `/api/v1`), (b) a `CHANGELOG.md` for the API
   exists with the Wave 7 changes above, and (c) CI has run green once on
   the commit. Criterion 10 can stay a recorded limit.
2. **Postpone GA** to a later wave with the same conditions, and keep the
   pre-GA rule (breaking changes with notice).

Recommendation: option 2 until criteria 7 to 9 are met; they are small and
mechanical, and declaring GA while the document lists operations that
answer `404` would make the first `v1` promise one the server does not
keep.
