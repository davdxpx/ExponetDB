# Pre-Wave-11 review

| | |
|---|---|
| Purpose | The **one** entry point for the owner's review before Wave 11: what the parallel sessions built, what is proven, what is not, and what waits for a decision |
| Status | Collecting. **This file accepts nothing**: no gate (G8, G9, G11 or any other) is passed by anything written here |
| Rule for parallel sessions | Each session adds exactly one marked section (`## <name> – Parallel Session`) and never edits another's. When branches merge, every section is kept; rows that say the same are merged once, findings are never dropped |

Labels used for every claim: **IMPLEMENTED** (code on the branch), **STATIC
CHECKED** (typecheck, lint, generators, golden and boundary checks ran),
**TESTED LOCALLY** (automated tests ran in the session, on the machine named),
**CI OBSERVED** (a CI run was seen), **NOT EXECUTED** (a test or check that was
not run), **NOT PROVEN** (a claim no test or run supports yet).

## UI/UX Overhaul – Parallel Session

Branch `feat/studio-ux-overhaul`, based on `main` at `a4f16e3f` (PR #40), the
owner's UI/UX order of 2026-10-26, run in parallel to Wave 9 Part B. No
deployment, no production or bucket change, no change to the REOSA repository,
no file under `apps/web/src/features/wave9/**` touched.
Pull request: `davdxpx/ExponetDB#42`. Every test and check in U10 ran on head
`c91d2d10`; the only later commit records this line (documentation only).

### U1. Commits

| Commit | What |
|---|---|
| `73564407` | `LinkCard` (whole-card link) and `Pager` in `packages/ui-patterns`; icons |
| `c667b982` | Fleet overview rebuilt; `UntrustedName`/`UntrustedText` gain `expandable={false}` |
| `04eccbac` | Project level (`/projects`, `/p/<product>/<project>`), the target Connect sheet |
| `42d018fc` | Target overview hero with the recorded placement |
| `109569dd` | Migration centre (views, paged history, windowed timeline, paged import report); search validators return every key |
| `7d90eeb0` | Backend: `registry.server.retire`, `registry.cluster.retire`, retirement preflight reads, Control Store bundle `registry-retirement` |
| `c55f5726` | ADR-0035 references; a fieldset for the import filters |
| `6a110e21` | Web: "Remove from ExponetDB" on server and cluster pages; "Retire record" for unplaced databases |
| `05d8f3ee` | Lists that stopped at their first page (audit, bindings, grants, OAuth clients) |
| `675090d7` | Documents: ADR-0035, this section, IA, design system, parity; button links on the Changes landing |
| `49694666` | Policies: a data-read setting for any target, not only the first 200 (P1 #9) |
| `2a03254d` | Documents: built, not planned (source review) |
| `a4a20879` … `fb33fc9c` | Web fixes of the independent reviews (U13) |
| `6c6d499a` | Registry: retirement hardening of the security review (U13) |

### U2. Routes: added, changed, kept

| Route | Change | Status |
|---|---|---|
| `/projects` | **new**: portfolio (`q`, `product`, `view=grid\|table`, `page`; every key validated, an invalid one dropped) | IMPLEMENTED, TESTED LOCALLY |
| `/p/<product>/<project>` | **new**: project home; slugs outside the grammar are "page not found" without a request; a project beyond the bounded read is named as partial | IMPLEMENTED, TESTED LOCALLY |
| `/t/<product>/<project>/<environment>[/…]?connect=<mode>` | **new parameter** on every target page: the Connect sheet (`direct`, `app`, `cli`, `mcp`, `api`; anything else ignored) | IMPLEMENTED, TESTED LOCALLY |
| `/p/<product>/<project>?connect=<mode>&environment=<slug>` | **new parameters**: the Connect sheet of a project | IMPLEMENTED, TESTED LOCALLY |
| `/t/…/migrations?view=…&q=…&origin=…&verification=…&sort=…&page=…&size=…&migration=…&report=imr_…` | **new parameters**; `?report=` alone still opens the legacy import (view `import`) | IMPLEMENTED, TESTED LOCALLY |
| `/`, `/targets`, `/t/…`, `/connect`, `/settings/projects`, `/infrastructure/**`, every Wave 8 order Appendix C URL | unchanged addresses; `/connect` remains the MCP client guide | kept |
| Sign-in return targets | `/projects` and `/p/<slug>/<slug>` added to the allowlist (`lib/navigation/links.ts`) | IMPLEMENTED, TESTED LOCALLY |
| Header Connect | was a link to `/t/…/configuration#connect`; now opens the sheet (the configuration page keeps its Connect section) | IMPLEMENTED, TESTED LOCALLY |
| Rail | new section **Projects** (`G` then `R`) between Overview and Databases | IMPLEMENTED, TESTED LOCALLY |

No redirect was added or removed. Information architecture:
[ADR-0035](../01-architecture/adr/0035-studio-information-architecture.md)
(**proposed**, for the owner), [`information-architecture.md` §2.5](../11-ui/information-architecture.md#25-uiux-overhaul-2026-10-26-proposed).

### U3. The owner's screenshots: before and after

| Screenshot / finding | Before (path) | After | Risk |
|---|---|---|---|
| A: fleet cards as boxes with small underlined links | `features/fleet/fleet-page.tsx` `Stat` | Key numbers are whole-card links (`kpi-cards.tsx`), loud only when non-zero work waits; unavailable parts are plain cards with their reason | low |
| A: "13,741 open findings" as a bare statistic | same | `findings-triage.tsx`: severity meter from the fleet counts with a link per severity, the newest critical findings as row links, an honest note that grouping needs a server read | low |
| A: "Backups at risk is not available yet" as a big empty card | same | `protection-slot.tsx`: a small "not observed yet" slot with a one-line Wave 9 integration point | low |
| A: health table with underlined numbers | `HealthGrid` | `health-strip.tsx`: proportional bar (an image with its counts as its name) plus a link per state | low |
| B: no project home | — | `/projects`, `/p/<product>/<project>`, target overview hero with a placement card | medium (new IA, ADR-0035 proposed) |
| C: Connect only as a page section | header link to `/configuration#connect` | `features/connect/target-connect-sheet.tsx`: wide right sheet, five modes, address state, permission split | medium (copyable text; reviewed below) |
| `/t/reosa/platform/staging/migrations` endless page (500+ imported rows) | `ledger-section.tsx` `status.applied.map`, six stacked sections | `migrations-page.tsx` counters + views; history paged 25/50/100 with filters; timeline windowed to 25 bundles | low |

### U4. Data-volume and interaction audit of every screen

A read-only audit of all 32 feature directories found **9 P1, 42 P2 and 63 P3**
findings (the full table with file and line, kept for the owner, is reproduced
in condensed form here; the numbers are the audit's).

| # | Severity | Where | Finding | State |
|---|---|---|---|---|
| 1 | P1 | `audit/audit-page.tsx` | a first page without items but with a cursor read as an empty log | **fixed** (`05d8f3ee`), tested |
| 2 | P1 | `access/person-card.tsx`, `roles-page.tsx` | a cut binding list showed "No role" / "Nobody holds this role" | **fixed** (says not all bindings were read), tested; a `role` filter on `listRoleBindings` would let the Roles page read exactly (backend read, U8) |
| 3 | P1 | `migrations/ledger-section.tsx` | whole ledger rendered | **fixed** (paged history); a server-paged ledger read remains (U8) |
| 4 | P1 | `ui-data/.../migration-timeline.tsx` | up to 1,000 rows, re-rendered every 10 s | **fixed on the migrations page** (window of 25, +100 on request); `/changes/promotion` still renders up to 1,000 (open, P2 #46) |
| 5 | P1 | `migrations/migrations-page.tsx` | six sections stacked | **fixed** (views) |
| 6 | P1 | `access/people-keys.ts`, `people-page.tsx` | first 200 identities, client search | **open**: needs `q` and `kind` on `listIdentities` (U8) |
| 7 | P1 | `access/connected-apps-page.tsx` | grants past 200 unreachable | **fixed** (Load more), tested by the existing suite; a person filter in the URL is open |
| 8 | P1 | `access/oauth-clients-page.tsx` | clients past 200 unreachable | **fixed** (Load more); a name search needs `q` (U8) |
| 9 | P1 | `settings/policies-page.tsx` | target select of the first 200 | **fixed**: the cut list says so, and any target can be chosen by its typed ID (also when the list read fails); an unlisted target's tier is said to be unknown, never non-production; tested. `q` on `listTargets` (U8) would make it a search |
| 10, 47 | P2 | fleet stat cards, Changes landing | small underline links as the only action | **fixed** (whole-card links; button links on the Changes landing) |
| 100 | P3 | `changes/operation-page.tsx` | a "Show all" button could render inside the target link | **fixed** (`expandable={false}`) |
| 11, 12–46, 48–51 | P2 | approvals cards, fleet attention reads 1,000 targets, server-side health and path filters, import report filters (#14 **fixed**), promote candidates, report list, polling of the full ledger, activity filters, audit details below `xl`, 200-option selects (audit, consent, access pickers), environments N+1, filters in `useState`, infrastructure lists without Load more (#33, #34), infrastructure name links (#35), schema detail placement, SQL tab eviction and `?sql=` duplication, global findings counts (#43), the approvals queue read per plan page (#44), operations `target` filter (#45), promotion timeline (#46), targets client filters (#48, #49), infinite queries refetching all pages (#51) | **open**, prioritized; each with its suggested fix and whether it needs a backend read in the audit table (see U8 for the reads) |
| 52–114 | P3 | polish: counts in pagers, labels for raw enums, URL state for small filters, focus moves, `scope="col"` | **open** |

The audit also confirmed what holds: every `Table` scrolls inside its own area,
the main reads go through `toReadable`, there is no click handler on a `div`.

### U5. Entity lifecycle: actions per entity (§8A)

Coverage before this branch, per layer (contract route, action catalog,
application, registry or nodes package, REST handler, CLI, MCP, Web); ✔ present,
✘ absent, **new** = added on this branch.

| Entity | List / detail | Create / register | Update | Suspend / resume | Move | Retire / decommission / revoke | Web entry for removal |
|---|---|---|---|---|---|---|---|
| Installation | ✔ | — | ✘ (operator commands) | ✘ | — | ✘ | — |
| Product | ✔ | ✔ plan | ✘ (guard EXG01: never changes) | ✘ | — | ✘ | ✘ |
| Environment | ✔ | ✔ plan | ✔ plan | ✘ | — | ✘ | ✘ |
| Project | ✔ | ✔ plan | ✔ plan | ✘ | — | ✘ | ✘ |
| Target (placement) | ✔ | ✔ register plan | settings only | ✔ plans | ✘ (placement reasons `move`, `restore`, `recreate` exist in the schema, unused) | ✔ `target.decommission` (critical, typed path) | ✔ configuration page |
| Server | ✔ | ✔ plan | ✘ (EXG06) | — | — | **new** `registry.server.retire` | **new** server page |
| Cluster | ✔ | ✔ register, confirm, declare tier | ✘ (rename, CA change) | — | ✘ (server is fixed) | **new** `registry.cluster.retire` | **new** cluster page |
| Registered database | ✔ | ✔ plan | — | — | — | ✔ `registry.database.retire` (CLI only before) | **new** "Retire record" on the cluster page |
| Endpoint | ✔ | ✔ plan | ✘ by design (a new address is a new endpoint) | — | — | ✔ retire plan | ✔ |
| Node agent | ✔ | ✔ enroll plan, token reveal | ✔ config update | — | — | ✔ revoke, decommission (typed confirm) | ✔ node page |
| Enrollment token | via plans | ✔ with enroll | — | — | — | expires only (no revoke) | — |
| Credential, role verifier | ✔ metadata | ✔ submit (write-only), rotate | — | — | — | implicit (rotation retires the old one); **new**: retired with its cluster | — |
| Execution roles | ✔ | ✔ set, declare and revoke exceptions | — | — | — | ✔ revoke exception | ✘ (CLI only) |
| Plans, operations | ✔ | ✔ | — | — | — | withdraw a plan, cancel an operation, retry verification | ✔ |
| Approvals | ✔ | — | — | — | — | approve, reject | ✔ |
| Findings, drift | ✔ | — | — | — | — | drift accept (plan); findings resolve by the system | ✔ |
| Saved queries | ✔ | ✔ | ✔ | — | — | delete (own) | ✔ |
| Audit events | ✔ search, chain, export | — | append-only | — | — | never (retention is an operator matter) | — |
| People | ✔ | ✔ invite, reissue | own profile only | ✔ disable, enable plan | — | ✔ erasure plan (critical) | ✔ |
| Role bindings | ✔ | ✔ plan | — | — | — | ✔ removal plan | ✔ |
| Service accounts, API keys, OAuth clients, grants, sessions | ✔ | ✔ | — | ✔ disable / approve / reject | — | ✔ revoke keys, grants, sessions; disable clients | ✔ |
| Backups (Wave 9 Part B) | catalog entries only; no handler | — | — | — | — | — | Wave 9 |

Gaps that stay open (each a decision or a later change, none faked in the UI):
product, environment and project retirement; server and cluster rename; moving
a target; registering an agent-managed cluster through an interface (only test
fixtures create one); a Web entry for execution roles; five contract routes
without a handler (`getQueryStats`, `getTableStats`, `runAdvisors`,
`listClusterBackups`, `planLedgerReconcile`, served as 404). Two defects found
and **not** changed here: the REST handlers of `planDatabaseRetirement` and
`planEndpointRetirement` drop the optional `reason` of the body (the CLI sends
it); registry kinds are not lease-fenced like node kinds.

### U6. Server and cluster removal (reference scenario)

[`registry.md` §4.4](../02-control-plane/registry.md#44-retiring-a-server-or-a-cluster)
holds the rules. What was built:

- **Contracts** (`packages/contracts`): actions `registry.server.retire(.plan)`,
  `registry.cluster.retire(.plan)` (`high`, human only, re-authentication),
  reads `registry.server.retirement.get`, `registry.cluster.retirement.get`;
  routes `POST /servers/{id}/retire`, `POST /clusters/{id}/retire`, `GET
  /servers/{id}/retirement`, `GET /clusters/{id}/retirement`; schema
  `RetirementPreflight`; conflict reasons `server_retired`, `server_in_use`,
  `cluster_in_use`; `Server.state`, `Server.retiredAt`, `Cluster.retiredAt`.
  Generated OpenAPI, catalog and SDK regenerated; MCP tool versions unchanged
  (no MCP tool exposes servers or clusters). IMPLEMENTED, STATIC CHECKED.
- **Control Store** bundle `01M5WT5NV9ZC8TYB9BMP3D0EZZ_registry-retirement`
  (additive, depends on `01M5PZFYDPT065MDFHG5G3WSG1`; frozen bundles
  byte-identical): server state and retirement columns; `server_guard`
  replaced (EXG06: one move, no live child); a cluster retirement guard
  (EXG07); the frozen "pending exactly when no identifier" check narrowed to
  unretired clusters so a never-confirmed registration can be retired; parent
  locks on new children. IMPLEMENTED, TESTED LOCALLY.
- **Registry and nodes**: `retirement.ts` (one set of queries for the read,
  the planner and the bindings), planners, kinds (lock, re-check, write, audit,
  verify by the row's operation id), `node.enroll` refuses a retired server.
  IMPLEMENTED, TESTED LOCALLY.
- **Application, REST, CLI** (`server retire`, `cluster retire`). IMPLEMENTED,
  STATIC CHECKED; the HTTP handlers TESTED LOCALLY through the served-route pin
  only.
- **Web**: "Remove from ExponetDB" on both pages, "Retire record" for an
  unplaced database. IMPLEMENTED, TESTED LOCALLY (component tests with a fake
  server).

**Steps the owner can check in the UI** (NOT EXECUTED in a browser):

1. Open a server with a cluster: the section lists "1 clusters on this server
   are not retired" with a link; "Plan removal" is disabled with "Resolve the
   items above first."
2. Open the cluster: databases registered on it are listed with a link to the
   placements table; for each placed one decommission its target
   (Configuration), then use "Retire record".
3. When the cluster's section says "Nothing blocks the removal now", plan its
   removal: the dialog asks for two statements (final; nothing deleted on the
   cluster) and an optional reason code; the plan page opens; apply it there
   (re-authentication). The cluster page then shows "Retired" and the history.
4. Revoke, then decommission the server's node (node page).
5. Back on the server, plan its removal the same way. The server list shows it
   as Retired. Nothing on the machine changed.

**Negative test plan** (automated where marked):

| Case | Expected | State |
|---|---|---|
| server without children | retire planned, applied, verified; record kept; second retire `server_retired`; a later cluster registration on it not applied (EXG06) | TESTED LOCALLY (PostgreSQL 17) |
| server with a pending cluster | `server_in_use`; preflight names the cluster; cluster retired with its endpoint; then server retired; history kept | TESTED LOCALLY |
| cluster with a registered database | `cluster_in_use`; after the database record is retired the cluster retires with 3 credentials; the PostgreSQL database still exists | TESTED LOCALLY |
| database registered after a cluster retirement was planned | apply refused `PLAN_STALE` | TESTED LOCALLY |
| cluster retirement and a new endpoint at the same time, both orders | the second waits on the row lock and is refused (EXG07) | TESTED LOCALLY (SQL level; the wait is checked on the blocked backend itself) |
| server retirement and a new cluster at the same time, both orders | the second waits and is refused (EXG06) | TESTED LOCALLY |
| server retirement and a new enrollment token at the same time, both orders | the second waits and is refused | TESTED LOCALLY (`packages/nodes`, the real `createEnrollmentToken`) |
| enroll plan, token creation and the enroll apply on a retired server | `server_retired` conflict; the token refused; the enroll plan stale | TESTED LOCALLY |
| an enrollment token that ran out less than five minutes ago | still blocks, in preflight, planner and guard alike | TESTED LOCALLY (`created` tokens; the `issued` side **NOT EXECUTED**) |
| an endpoint added after a cluster's removal was planned | apply refused `PLAN_STALE` (`retiredWith`) | TESTED LOCALLY |
| a cluster registration planned on a retired server | `server_retired` at plan time; stale at apply | TESTED LOCALLY |
| a queued plan whose body holds an escaped NUL | the preflight still reads (before the fix: 22P05) | TESTED LOCALLY |
| node `active`, `offline`, `revoked`; open node job; open operation naming the subject | blocks; preflight names it | covered by the queries and the guard; **NOT EXECUTED** as integration cases |
| shared server across products and tiers; cross-tier authority; a person without `registry.manage` on the production tier | refused by the authorization engine (production authority for servers) | **NOT EXECUTED** |
| unauthorized preflight | 403; the Web reads nothing and says blockers may exist | Web TESTED LOCALLY; server **NOT EXECUTED** |
| 0 / 1 / 10 / 1,000+ dependents | groups name 50 with the total | Web TESTED LOCALLY (120); server **NOT EXECUTED** at 1,000 |
| crash between effect and verification; worker restart | the kind's `applied` reads the row's operation id; reconciliation | **NOT EXECUTED** |
| backup bindings (Wave 9) | `blocking` and `unknown` refuse | **NOT PROVEN** (no provider yet) |

### U7. Supabase sources

The pinned commit `8b9af568` was **not** in the local clone when this review started
(`/home/david/Development/AttachmentRepos/Supabase` is 182 commits behind it;
`git fetch origin 8b9af5686750909eb594a4d5ff79e9217d07741a` brings it); the
audit read the files at the pin through the GitHub API. No `apps/studio` file
of ConnectSheet, ConnectButton, ProjectHome, OrganizationCard or the layouts is
on the ADR-0030 allowlist. **Nothing was copied**; everything above is native
code on existing primitives (`Sheet`, `Tabs`, `Card`, `Button`, state
components). The third-party register is unchanged (171 + 1 rows; `bun run
third-party` holds).

| Source (at `8b9af568`) | Visual function | Decision | Why |
|---|---|---|---|
| `ConnectSheet/ConnectSheet.tsx`, `ConnectStepsSection.tsx`, `ConnectConfigSection.tsx` | wide sheet, mode cards, steps | native rebuild (`target-connect-sheet.tsx`) | entangled: API keys read into the browser, `nuqs`, `common`, telemetry, its data hooks |
| `ConnectModeButton.tsx`, `ConnectSheetStep.tsx`, `ConnectionParameters.tsx` | mode buttons, numbered step | native rebuild | copyable after strips, but small; ExponetDB uses radio semantics (Studio's `aria-pressed` for one choice is weaker) |
| `ConnectButton.tsx` | header button | native | data and telemetry imports |
| `ProjectHome/Home.tsx`, `TopSection.tsx`, `ActivityStats.tsx`, `ServiceStatus.tsx` | project home, key facts, service status | native (`project-page.tsx`, `hero.tsx`) | `@dnd-kit`, platform data, usage and billing concepts that are non-goals |
| `ProjectHome/HomeCard.tsx` | card whose title link stretches | native (`LinkCard`) | only `next/link`; the native component also forbids nested controls |
| `ServerLightGrid.tsx` | blinking dot grid | **not used** | its dots blink at random, implying activity nobody observed (C-28) |
| `Organization/OrganizationCard.tsx`, `Home/ProjectList`, `ProjectCard.tsx` | project cards and list | native (`projects-page.tsx`) | data layer, remote logos (`react-inlinesvg`) |
| `layouts/{ProjectLayout,OrganizationLayout,Navigation}` | shell | not touched | the shell was rebuilt natively in Wave 8 |
| `ConnectionIcon.tsx`, `SecretRow.tsx`, `useConnectServerEnv.ts`, `content/**`, `CopyPromptAdmonition.tsx`, `LogoLoader` | logos, secrets in the browser, snippets built on Supabase keys | **never** | brand assets, secrets, Supabase SDK snippets |

CSP: no inline style attribute set through `setAttribute`, no remote asset, no
injected `<style>`; segment widths use React style objects (CSSOM), allowed by
`style-src 'self'` (`bun run ui-safety` holds). If the owner wants file
fidelity, the smallest allowlist extension worth asking for is three files
(`ConnectSheetStep.tsx`, `ConnectModeButton.tsx`, `HomeCard.tsx`), with an
amendment of the Wave 8 order §6.2 and ADR-0030 §1 and three register rows;
recommended: **no**.

### U8. Backend reads this UI needs later (contracts first, additive)

| Read | For | Notes |
|---|---|---|
| `GET /targets/{t}/migrations?limit&cursor&q&origin&verification&order` (or a mirror-backed ledger read) | the history at 10,000+ rows | seek on `(applied_at, migration_id)`; the live ledger hash stays a separate field |
| `GET /findings/summary` (counts by severity, kind, code, target) and `code` on `GET /findings` | grouping 13,000+ findings on the overview and the findings page | indexes on `(state, severity)` and `(state, code)` |
| `attention` on `GET /fleet` (worst N targets) | the overview reads 1,000 targets to show 10 | one query ordered by health rank and sample age |
| `q`, `health` on `GET /targets` | database switcher, pickers, targets list beyond 1,000 | trigram or prefix index on the path |
| `q`, `kind` on `GET /identities`; `q` on `GET /oauth/clients`; `role` on `GET /role-bindings` | people, OAuth clients, roles pages | |
| `serverId` on `GET /nodes`, `GET /clusters` | a server's nodes and clusters beyond 200 | |
| `GET /approvals/{operationId}` | the plan and operation pages read the whole queue every 30 s | |
| `GET /targets/{t}/import-reports` | open a report without pasting its id | |

None is built here; each is a small contracts → application → REST → SDK change
outside Wave 9's domains.

### U9. Wave 9 integration handoff and merge order

- **Files**: this branch changed no file in `features/wave9/**`,
  `packages/application` backup or performance flows, the node agent or
  backup contracts. Shared files it changed: `shell/navigation.ts` (a Projects
  section, `projectHref`), `shell/app-header.tsx` (Connect),
  `lib/i18n/en.ts` (two catalog parts), `lib/navigation/links.ts` (two return
  targets), `packages/contracts/src/{actions,errors}.ts`,
  `rest/{registry,resources,routes}.ts`, generated artifacts. Expect textual
  conflicts there only where Wave 9 adds entries next to these; resolve by
  keeping both, then `bun run generate`.
- **Control Store bundles**: `registry-retirement` depends on
  `01M5PZFYDPT065MDFHG5G3WSG1`. If Wave 9 Part B adds bundles on the same
  parent, the branch merged second re-points its first new bundle's
  `dependsOn` to the other branch's head (no bundle content changes) and adds
  its id to `registry-schema.int.test.ts`.
- **Backups on the overview**: Wave 9 provides
  `features/wave9/fleet-backup-health.tsx` exporting `FleetBackupHealth` (reads
  its own data, renders its own `Readable` states); the one change in
  `features/fleet/protection-slot.tsx` is to render it instead of
  `<NotObservedYet />`. The target hero's "Backups: Not observed yet" fact is
  the same kind of slot (`features/target-overview/hero.tsx`, `Facts`).
- **Backups and retirement**: Wave 9 provides a `BackupBindingsPort`
  (`packages/registry/src/retirement.ts`) through `RegistryKindDeps.backupBindings`
  and the application's preflight: `blocking` names the repositories and
  running restore jobs, `unknown` refuses. Until then the answer is
  `not_installed`.
- **ADR numbering**: this branch uses ADR-0035; a Wave 9 ADR merged first under
  that number makes this one ADR-0036 (rename the file, the index row and the
  references in `apps/web` comments).
- **Merge order**: either order works; merging Wave 9 Part B first lets the
  backup slot and the backup port be wired in the second PR.

### U10. Tests and checks (exact, on `/home/david` WSL2, Docker PostgreSQL 17.11)

Final runs after the review fixes (U13), on the branch head before this
document's last commit; earlier runs of the same suites are superseded.

| What | Result | Label |
|---|---|---|
| `apps/web` vitest (whole suite) | 164 files, 2,450 tests passed | TESTED LOCALLY |
| `packages/ui-patterns` vitest (whole suite) | 90 files, 1,141 tests passed with `TZ=UTC`; in this machine's CET shell 1 fails (`metric-card` expects UTC clock text; the file is untouched by this branch) | TESTED LOCALLY, **time-zone dependent test observed** |
| `packages/icons` vitest | 8 passed (before the review fixes, unchanged since) | TESTED LOCALLY |
| `bun run typecheck` (turbo, every package) | 28 of 28 tasks successful | STATIC CHECKED |
| `packages/contracts`, `application`, `registry` (unit), `apps/server` (unit) | 218, 68, 8, 189 passed | TESTED LOCALLY |
| `packages/sdk`, `apps/cli` (unit) | 89, 79 passed (before the review fixes; neither changed since) | TESTED LOCALLY |
| `packages/registry` integration: `registry-retirement.int.test.ts` | 10 of 10 passed (5 of them new; they failed before the fix) | TESTED LOCALLY |
| `packages/registry` integration: `registry.int.test.ts`; `apps/server` `http-registry.int.test.ts`, `http-auth.test.ts`; `control-store` `immutable-bundles.test.ts` | 25, 14, 18, 3 passed | TESTED LOCALLY (run by the implementing agent, U13) |
| `packages/nodes` integration: `retired-server.int.test.ts` (new) | 4 of 4 passed | TESTED LOCALLY |
| `packages/control-store` integration: `registry-schema.int.test.ts` | 13 of 13 passed | TESTED LOCALLY |
| `packages/migrations-engine` integration: `engine.int.test.ts`, `legacy-supabase.int.test.ts` | first run of `engine`: setup failed on `migration_verifications_check` (a verification finishing before it started; host and container clocks differ by ~0.05 s); rerun 28 of 28; `legacy-supabase` 7 of 7. The other migrations-engine integration files are typechecked only | TESTED LOCALLY, **flaky clock check observed, not caused by this branch**; rest **NOT EXECUTED** |
| `bun run verify:generated`, `golden:check`, `golden:history origin/main` (`02ed23ca`: 21 frozen bundles byte-identical, 30 MCP tool versions unchanged), `boundaries`, `secrets`, `third-party`, `ui-safety`, `check` (biome, 2,297 files) | all hold | STATIC CHECKED |
| `apps/web` build with bundle budgets | entry 280.8 of 308 kB, CSS 31.4 of 35 kB, largest lazy route 35.7 of 51 kB | STATIC CHECKED |
| Merge with `main` at `02ed23ca` | no conflict (`git merge-tree`) | STATIC CHECKED |
| `bun run verify` as a whole, `test:e2e`, `test:conformance`, `go:test`, `smoke:image` | not run | **NOT EXECUTED** |
| CI | no run observed for this branch | **NOT EXECUTED** |

### U11. Browser, keyboard, accessibility and responsive matrix (NOT EXECUTED)

Automated axe checks ran in jsdom for the new pages and the sheet (TESTED
LOCALLY); nothing below ran in a real browser.

| Check | Pages | Viewports | State |
|---|---|---|---|
| Visual review, light and dark | overview, projects (grid and table), project home, target overview, Connect sheet (5 modes), migration centre (7 views), server and cluster removal | 360, 768, 1280, 1920 px; 200 % zoom | NOT EXECUTED |
| Keyboard only: tab order, focus ring on whole-card links, the sheet's focus trap and return, Escape, radio arrows in the mode picker, pager | same | desktop | NOT EXECUTED |
| Screen reader: card names, severity meter and health bar names, live range of the pager, dialog titles | same | NVDA or VoiceOver | NOT EXECUTED |
| `prefers-reduced-motion`: card lift and arrow motion off | overview, projects | desktop | NOT EXECUTED |
| Touch targets and the full-screen sheet with safe areas | Connect sheet, pager, cards | phone | NOT EXECUTED |
| Real data: `/t/reosa/platform/staging/migrations` with the imported ledger | migration centre | desktop | NOT EXECUTED (needs the deployed staging) |
| Cross-browser: Chromium, Firefox, Safari | all | — | NOT EXECUTED |

### U12. Security, RBAC and CSP points (reviewed once, U13; NOT PROVEN beyond its tests)

- No new secret surface: the Connect sheet builds text from registry records
  (`registry.manage` only, OD-41) with placeholders for role and password;
  values that are not safe to paste are refused, never escaped (tested with
  hostile hosts and names). The independent security review found no secret
  in the sheet, the preflight or the URL (U13); a review is not a proof.
- Retirement is human only, re-authenticated, `registry.manage` at the cluster
  tier or production authority, `high`; **no approval rule** applies, as for
  database retirement today (gap, owner decision below).
- The preflight reads need `registry.manage`; a person without it gets a named
  state and no request. Names in the read are untrusted text, rendered as
  such; no secret, address or token value is in it.
- Search parameters of the new routes are validated with every key returned,
  so no unchecked parent value reaches a page (regression tests).
- CSP unchanged (`ui-safety` holds); no dependency added; no remote asset.

### U13. Independent reviews (P7) and what they changed

Four reviewers ran on the branch, each read-only and briefed with the code,
not with this document's conclusions; a fifth agent then implemented the
backend findings, reviewed by this session before its commit.

| Review | Verdict | Findings | Fixed | Left open (why) |
|---|---|---|---|---|
| Routing, URL state, IA | approve with notes | 0 P1, 1 P2, 6 P3 | the P2 (a project home said "not found" from a cached list: it reads again and waits); a stale "pushed" flag in the Connect sheet (a later link-opened sheet went back past the page; **reproduced** by a test first); search text dropped, never cut, with the targets rule; an unknown product filter stays visible; `?migration=` off the page says where it is; dead `reportSearch`; return-path tests | the sheet's URL built from the decoded path (only self-made invalid paths, which render "not found"); the legacy import's filter and page in local state |
| UX and accessibility (WCAG 2.2 AA) | 1 P1, 12 P2, 5 P3 | the P1 (project cards said "No database registered yet" while the target read loaded or failed: now "Environments not read", counts as floors when cut); all twelve P2: whole-card links named by their content, no button inside a link, focusable pager ends, focus kept when "Show all" / "Show earlier" / an import decision changes the list, one reason per cause on the disabled removal (reachable by Tab), safe names in labels, status lines for matches, the pending view paged, a visible mark on the chosen connect mode, decommissioned in words, the policies field (stale scope, error on every key) | duplicate accessible names ("Copy the command", "Decide", "View operation"); real-browser contrast, 320 px overflow and screen-reader speech (U11) |
| Source and license | nothing blocks release | 0 P1, 0 P2, 3 P3 (docs) | the three document points | — |
| Security (retirement, sheet, return paths) | no CRITICAL, no HIGH | 1 MEDIUM, 9 LOW | MEDIUM (race tests for server retirement against a new cluster and a new enrollment token, both orders, waiting on the blocked backend itself); LOW-1 (5-minute token margin in guard and preflight); LOW-2 (a plan body with an escaped NUL broke every preflight, **reproduced**: 22P05); LOW-3 (one required backup port); LOW-4 (the retired-with records bound in the plan); LOW-7 (a server's removal confirmed as production); LOW-8 (snippet quoting, safe option labels); LOW-9 (`search_path` with `pg_temp`, cluster registration on a retired server refused when planned, enrollment hidden until the server is read) | LOW-5 (a sealed `submitted` role verifier or rotation of a cluster is not a blocker: owner decision 7); LOW-6 (the preflight names node, job, token and operation ids to a `registry.manage` holder without `nodes.read`: owner decision 8); the same NUL hazard in the pre-existing fleet operations read (`application.ts`, Wave 8), flagged as its own task |

All fixes carry tests; the reproductions above failed before their fix. The
reviews are not acceptance and not a proof of absence (U11 still applies).

### U14. Decisions for the owner (none taken here)

1. **ADR-0035** (project level, Connect sheet, migration views): accept,
   change or reject.
2. **Backups and retirement before Wave 9**: retirement proceeds while no
   backup engine exists (`not_installed`), or waits for Wave 9 (refuse until a
   provider answers). Built: proceed. Recommendation: proceed (no backup record
   can exist), revisit with Wave 9.
3. **Approval for production retirements**: add a policy rule requiring
   approval for `registry.server.retire`, `registry.cluster.retire` and
   `registry.database.retire` on production (today: human, re-authentication,
   `high`). Recommendation: yes, together with target decommission.
4. **A never-confirmed cluster is retirable**: the frozen check was narrowed in
   the new bundle (not in the frozen one). Accept or ask for another shape.
5. **Supabase file fidelity**: keep the native rebuilds (recommended) or extend
   the allowlist by three files (U7).
6. **The open P1 item** 6 (`q` and `kind` on `GET /identities`) and the reads
   of U8: which to build before Wave 11. (P1 #9 is fixed.)
7. **Role verifiers and credential rotations of a retired cluster**: add them
   to the cluster's blockers, or close them with the retirement (U13, LOW-5).
8. **What the removal preflight names**: keep listing node, job, token and
   operation ids to a `registry.manage` holder, or strip them without
   `nodes.read` / the operations read (U13, LOW-6).

## Wave 9 Part B – Parallel Session

Branch `ccr-4bf70a3d-5p1q3c` (the platform's branch rule wins over
`feat/…`), draft pull request `davdxpx/ExponetDB#43`, owner approval: none
(awaiting review), CI: the PR's runs (W9-09 records them), based on `main` at `cad5ac1` (`#42` merged before this session's
first commit, so this section runs after the UI/UX section, not beside an
open branch). The owner's order of 2026-10-26 is recorded in
[`orders/wave-9-part-b-order.md`](./orders/wave-9-part-b-order.md). No
deployment, no real database, bucket or host, no enrollment, no change in
the REOSA repository, no production apply. **Nothing here accepts G9 or any
other gate.** The gap matrix on `cad5ac1` is
[`gates/9-part-b-gap-matrix.md`](./gates/9-part-b-gap-matrix.md); the gate
record is [`gates/9.md`](./gates/9.md).

Labels as above (IMPLEMENTED, STATIC CHECKED, TESTED LOCALLY, CI OBSERVED,
NOT EXECUTED, NOT PROVEN), plus **BLOCKED** (cannot proceed without an
owner decision or infrastructure) and **OWNER REVIEW REQUIRED**.

### W9-00. Decision registry

| Decision | State | What it means for Wave 9 | Recorded in |
|---|---|---|---|
| OD-8 technical default | **DECIDED 2026-10-26** (option (a)) | retention of new records follows `data-retention.md`; audit permanent and pseudonymous | [open-decisions OD-8](../00-product/open-decisions.md#od-8-audit-retention-and-personal-data) |
| OD-8 legal review | **EXTERNAL LEGAL REVIEW, NOT PROVEN** | blocks productive use with personal data, not development; nothing claims "permanent is always lawful" | same |
| OD-53 | **DECIDED** (a), fail closed | an approval per production plan with an owner-name lineage mismatch | OD-53 |
| OD-54 | **DECIDED** (a), `registry.cluster.adopt_agent` | the only path from `external` to `agent`; B4 | OD-54 |
| OD-55 | **DECIDED** (c) + (d) | approval on every tier for procedural agent plans; ledger/marker before/after guard; cross-project reach a residual; built in `9274d50` | OD-55 |
| OD-56 | **DECIDED** (a), HMAC | changed excused values fail closed; built in `9274d50` | OD-56 |
| OD-57 | **OPEN** (added 2026-10-27, review F-4) | `advisors_run` records a run under a read scope; the annotation stays read-only until decided (R-MCP-1) | [OD-57](../00-product/open-decisions.md#od-57-advisors_run-records-a-run-but-its-scope-is-a-read-scope) |
| **OD-4-storage** | **OPEN — BLOCKS G9 FULL ACCEPTANCE** | provider-neutral model built; no repository activated productively; choice after W9-03 | OD-4, [ADR-0036](../01-architecture/adr/0036-backup-repositories-and-providers.md) |
| OD-21 | open | break-glass activation stays refused; no notification shortcut | OD-21 |
| OD-10, OD-12, OD-27, OD-29, OD-41 to OD-50 | open, unchanged | OD-29 (c): no MCP node planning, no MCP restore apply | open-decisions |
| ADR-0036, ADR-0037, ADR-0038 | **proposed for the owner** (accepted for development) | repositories and providers; long-running node runs; restore plans, drills, runbook | ADR index |
| `#42` U14 item 2 (retirement before Wave 9) | owner decision open | the Wave 9 provider answers instead of `not_installed` once wired (W9-07) | U14 |

### W9-01. Gating dashboard

Gates as their records say them (no gate is changed by this branch, none is
`ACCEPTED` by it). Columns: what the owner decided, what is implemented,
what evidence exists.

| Gate | Decided | Implemented | Evidence | Status |
|---|---|---|---|---|
| G2 | accepted 2026-10-05 | yes | off-host deployment evidence outstanding | **NOT PROVEN** (deployment) |
| G5 | accepted 2026-10-12, items 2 and 4 waived (real systemd host) | yes; Wave 9 Part B adds 11 capabilities | waiver expiry "before a node agent is installed on, or enrolled for, any real host" | **OWNER REVIEW REQUIRED** before any real enrollment (T-NODE-1) |
| G6 | accepted 2026-10-12 with waivers | yes | E25 partial, E16/E18 open, eleven partial cases (W9-05) | **OWNER REVIEW REQUIRED** |
| G7 | awaits the owner | yes (Wave 7); Part B serves four more read tools | [`gates/7.md`](./gates/7.md) | **OWNER REVIEW REQUIRED** |
| G8 | awaits the owner | yes (Wave 8); Part B replaces the Wave 9 placeholders | [`gates/8.md`](./gates/8.md) | **OWNER REVIEW REQUIRED** |
| G9 | Part B ordered 2026-10-26 | this branch ([`gates/9.md`](./gates/9.md) §3) | none on real infrastructure | **BLOCKED** by `OD-4-storage`; criteria **NOT PROVEN** |
| G10 | Wave 10 | not started | — | **NOT PROVEN** |

Product gates touched by this wave (all others unchanged by it):

| Gate | What Part B adds | Status |
|---|---|---|
| PG-13 Backups | repositories, catalog mirror, measured RPO, runs behind activation | **NOT PROVEN** (needs the new cluster, WAL archive and T-S3) |
| PG-14 Restore test | drills into scratch, the C-35 runbook | **NOT PROVEN** (needs a drill on the new cluster and T-C35-1) |
| PG-16 Connection diagnostics | cancel and terminate plans with single-statement re-checks | **NOT PROVEN** on staging |
| PG-11 Audit | runbook downloads, offline drills, runs and advisor runs are audited | **NOT PROVEN** (rehearsal) |
| PG-1 to PG-10, PG-12, PG-15, PG-17 to PG-20 | not changed by Part B | as recorded in [`acceptance-gates.md`](./acceptance-gates.md#product-gates-before-reosa-production-moves) |

What stands between this branch and a G9 acceptance, in one place. A row is
closed only by the evidence named in its last column; nothing here is
closed by this session.

| Item | State | Closed by |
|---|---|---|
| OD-4-storage (provider choice for L1/L3) | **OPEN — BLOCKS G9 FULL ACCEPTANCE** | the owner's decision after the W9-03 experiments |
| Lock proven on a real bucket (T-S3-1 to T-S3-6) | **NOT PROVEN** | the owner's run on disposable buckets; until then every repository shows `lock_not_proven` |
| Real systemd run supervision (T-NODE-1, T-NODE-2) | **NOT PROVEN** | the owner's run on a disposable host (never `reos-db-01` before the evidence) |
| Offline restore without ExponetDB (T-C35-1) | **NOT PROVEN** | the owner's drill from the generated runbook, Control Plane stopped |
| A passed drill per repository | **NOT EXECUTED** | a drill on a disposable cluster with activation `scratch` |
| OD-8 legal review | **EXTERNAL LEGAL REVIEW, NOT PROVEN** | outside counsel; this repository gives no legal advice |
| Security reviews of Part B (six areas) | pending (B5) | the reviews recorded in W9-09 and their fixes |
| CI on the branch head | pending | a green run of the repository's workflow on the PR |
| G6 waivers E25 and the eleven partial cases (expiry "before Wave 9 closes"); E16, E18 (expiry Wave 10) | **open** (E25 partial) | W9-05 lists what each still lacks |
| G5 waiver items 2 and 4 (real systemd host) | open, expiry "before a node agent is installed on, or enrolled for, any real host" | T-NODE-1 |

### W9-02. Manual test matrix

**None of these ran on real infrastructure** (result `NOT EXECUTED` until
the owner fills the date and outcome). The order's minimum list (order
§10, items 1 to 12) is M-1 to M-12; the T- rows are their concrete steps.
A failed expectation is a defect, not a waiver. "Local" names the
development check that exists in the repository (run in this session on
local lab servers; not a proof).

| Id | Feature | Preconditions, disposable infrastructure | Steps | Expected | Negative variant | Result | Evidence | Reviewer |
|---|---|---|---|---|---|---|---|---|
| M-1 | new SQL on PostgreSQL 16/17/18 (statistics, advisors, cancel/terminate, ledger/marker guard) | disposable PG 16, 17, 18 with `pg_stat_statements` preloaded (`tooling/dev/targets.sh`) | `bun run test:integration` | all suites green on the three majors | a role without `pg_read_all_stats`: `not_permitted`, never empty | NOT EXECUTED (CI) | local: `packages/diagnostics/test/performance.int.test.ts`, `packages/backups/test/*.int.test.ts` | |
| M-2 | node agent on a real systemd host | T-NODE-1 to T-NODE-5 | below | below | below | NOT EXECUTED | local: `go test -race ./...`, pglab | |
| M-3 | object lock | T-S3-1 to T-S3-6 | below | below | below | NOT EXECUTED | — | |
| M-4 | full, differential, incremental, WAL PITR; corrupted archive or key; retention boundary; restarts | disposable host, pgBackRest ≥ 2.59.3, a repository with mode `owned` | runs through `exponetdb backup run`; corrupt one WAL segment and the passphrase file; expire at the boundary; restart helper and agent mid-run | runs succeed; the catalog lists each; PITR reaches the target | a corrupt segment fails the restore (never "good enough"); a wrong key fails `backup.list` with `BACKUP_REPOSITORY_UNAVAILABLE`; a kept label is never expired | NOT EXECUTED | local: pglab (posix repository, one cluster) | |
| M-5 | `pg_dump` and restic restore to a clean destination | restic repository directory provisioned (adoption.md §2) | logical run; restore with the runbook's restic variant | databases and globals restore | missing globals file: the runbook stops; an over- or under-privileged restore role is refused | NOT EXECUTED | local: pglab logical run and `restic check` | |
| M-6 | drills (oldest, latest, PITR random) and C-35 | T-C35-1; a passed verify | `exponetdb drill plan … --selection latest|older|pitr_random` | each passes, discarded, RTO measured | an unverified source: plan denied (`restore.source-verified`) | NOT EXECUTED | local: `http-backups.int.test.ts` (latest, simulated node) | |
| M-7 | wrong node, wrong cluster id, duplicate restore, unsafe path, concurrent job, stale source, WAL gap | disposable host | plan with another node; a stanza of another cluster; two drills at once; a scratch directory planted; verification changed after planning; a removed segment | — | each refused: `RESTORE_TARGET_MISMATCH`, `run_active`, `scratch_exists`, `PLAN_STALE`, `RESTORE_SOURCE_INVALID` | NOT EXECUTED | local: policy and kind tests; T-NODE-4 | |
| M-8 | REST, MCP, SDK, CLI contracts, permissions, tiers, scopes, client kinds | the deployed lab installation | an MCP client and an API key with `:nonprod` scopes try every Wave 9 action | reads within scope; plans where allowed | restore, drill, discard by an agent: denied; prod with a nonprod scope: refused | NOT EXECUTED | local: `http-auth.test.ts`, `mcp-*.test.ts`, `apps/cli/test/backups.test.ts` | |
| M-9 | cancel and terminate | staging target | cancel a long query; terminate an idle-in-transaction session | signaled once, audited | reused pid, stale backend start, a backup or replication session, a superuser: refused or `PLAN_STALE` | NOT EXECUTED | local: `performance.int.test.ts` (PG 17, 18) | |
| M-10 | statistics resets and deltas; advisor false positives; 500+ migration baseline chain; OD-55; OD-56 | disposable targets | reset `pg_stat_statements` between samples; run advisors on a clean schema; import a 500-migration history | no negative delta; no finding on a clean schema | a procedural agent plan without a person: requires approval; a changed excused value: verification fails | NOT EXECUTED | local: statements and advisor tests; OD-55/56 tests | |
| M-11 | Wave 9 Web pages: keyboard, responsive, light and dark, CSP, states | a browser against the lab installation | walk the four pages and the dialogs by keyboard; 360 px width; both themes | every state named; no CSP violation | a failed read never shows an empty list | NOT EXECUTED (jsdom only) | local: `apps/web/test/wave9/*` | |
| M-12 | frozen bundles and contracts; G6 cases; PG-13, PG-14, PG-16; older waves after merge | CI on the merged head | `bun run verify` | green | a changed frozen bundle or vector fails `golden:history` | NOT EXECUTED | local: `golden:check`, `golden:history origin/main` | |
| T-S3-1 | lock (Hetzner) | disposable Hetzner bucket created with Object Lock, `COMPLIANCE 1d`; writer-shaped credential | `stanza-create`, full backup, 30 min WAL, differential | all succeed (metadata rewrites as new versions) | — | NOT EXECUTED | | |
| T-S3-2 | lock (Hetzner) | same | writer: `DELETE` and overwrite `PUT` of a WAL segment and a backup file | — | both refused | NOT EXECUTED | | |
| T-S3-3 | lock (Hetzner) | same | writer: change or remove the lock configuration | — | refused | NOT EXECUTED | | |
| T-S3-4 | lock and expiry | same | `expire` with a retention shorter than the lock | locked sets reported; nothing locked disappears | — | NOT EXECUTED | | |
| T-S3-5 | versioning | same | overwrite `backup.info`; list versions | the old version is kept | — | NOT EXECUTED | | |
| T-S3-6 | lock (R2) | disposable R2 bucket, lock rule on WAL and backup-set prefixes only; token without bucket-configuration rights | T-S3-1 to T-S3-4 | backups and expiry work | delete and overwrite of covered objects refused; the token cannot change the rule | NOT EXECUTED | | |
| T-S3-7 | restore from each bucket | T-S3-1, T-S3-6 | runbook restore and PITR to a disposable cluster | starts at the target | — | NOT EXECUTED | | |
| T-S3-8 | costs | one week per provider | record per GiB-month and request class | recorded for OD-4 | — | NOT EXECUTED (optional) | | |
| T-NODE-1 | supervised runs | disposable host with the agent and helper of this branch | `backup.run@1`, `run.status@1` until done; `run.cancel@1` during a run | a transient unit runs and finishes; cancel stops it; the run record is root-owned | — | NOT EXECUTED | local: pglab (direct children, no systemd) | |
| T-NODE-2 | crash and reboot | same | kill helper and agent mid-run, restart; reboot mid-run | survives restarts; after a reboot `run.status@1` says `lost`; nothing restarts by itself | — | NOT EXECUTED | | |
| T-NODE-3 | host mode file | same | mode absent, `adopted_observed`, `adopted_runs`, unsafe owner or mode | incremental only with `adopted_runs` | runs refused otherwise (`PRECONDITION_FAILED`) | NOT EXECUTED | local: helper unit tests | |
| T-NODE-4 | restore preparation | same | an existing scratch directory, too little space, another cluster's stanza | — | refused with the named refusal; nothing written | NOT EXECUTED | local: helper unit tests | |
| T-NODE-5 | drill and discard | same | a drill end to end, then `restore.discard@1` | scratch removed only inside the scratch root; the registered cluster untouched | — | NOT EXECUTED | local: pglab | |
| T-C35-1 | offline restore | disposable host, Control Plane stopped, the offline key copy | run the downloaded runbook into an empty directory | the cluster starts; recorded with `exponetdb drill record-offline` (an attestation) | a non-empty `TARGET_DIR`: the script refuses | NOT EXECUTED | local: `runbook.lab.test.ts` (posix repository) | |
| T-ADV-1 | adopting the owner's existing setup | the existing pgBackRest setup, read-only | adopt (`adopted_observed`), refresh | catalog mirrored; nothing changed on the host (timers, configuration, keys); `backup_engine_advisory` open until the 2.59.3 subkey check is recorded | — | NOT EXECUTED | local: `http-backups.int.test.ts` (simulated) | |
| T-RET-1 | retirement blocked by backups (the negative integration proof of the lifecycle port) | disposable server and cluster with a live repository | retirement preflight; plan the retirement | `backups: blocking` with the repository id | the retirement is refused (`EXB07`); after the repository's retirement no backup byte is deleted | NOT EXECUTED | local: `backups.int.test.ts` (EXB07), `http-backups.int.test.ts` (preflight) | |

### W9-03. Storage choice spike

**Nothing below is measured.** It is the comparison and the experiment plan
the owner needs for `OD-4-storage`; every cell marked "spike" is unknown
until the experiment ran on disposable buckets.

| Question | Hetzner Object Storage (S3 Object Lock) | Cloudflare R2 (bucket lock rules) | Split (Hetzner L1, R2 L3) |
|---|---|---|---|
| Lock contract | per object version, `GOVERNANCE`/`COMPLIANCE`, default retention; must be enabled at bucket creation **[OBSERVED, docs 2026-10-26]** | per prefix rule; prevents delete **and overwrite**; age, date or indefinite **[OBSERVED, docs]** | both, per layer |
| pgBackRest metadata rewrites (`archive.info`, `backup.info`, `backup.manifest`) | expected to succeed as new versions (spike: confirm versioning/delete-marker behavior) | **blocked** if a rule covers them; rules must cover only WAL segment and backup-set prefixes (spike: prove a backup and an expire run with such rules) | per layer |
| Expiry vs lock | delete creates a marker, locked versions stay until retention (spike) | expiry of a locked object fails; retention ≥ lock duration required (spike) | — |
| Can the host's writer change or remove the lock? | `COMPLIANCE`: no one can shorten; `GOVERNANCE`: anyone with the bypass permission (spike: writer credential without it) | any token with bucket-configuration edit rights (spike: writer token without them) | separate credentials per provider |
| Failure domains | Hetzner account and region (same provider as the database host) | Cloudflare account (other provider) | survives the loss of either provider |
| Existing chain | none | **the owner's live pgBackRest repository**: adopt read-only, never migrate | R2 stays L1 of the existing chain until a planned hand-over |
| Costs | spike (no measured values recorded) | spike | spike |
| Recommendation (provisional, **not a decision**) | L1 candidate for new installations | L3 candidate; existing installation adopted read-only | the shape ADR-0036 is built for |

Experiment plan (owner, disposable buckets, writer-shaped credentials only;
expected results in W9-02 T-S3-1 to T-S3-8):

1. Create a disposable bucket per provider (Hetzner with `--with-lock`,
   default retention `COMPLIANCE 1d`; R2 with a rule on `archive/` and
   `backup/<stanza>/2*` prefixes, 1 day).
2. pgBackRest `stanza-create`, full backup, WAL archive for 30 minutes,
   differential, `expire` with retention shorter than the lock: record
   which calls succeed.
3. With the writer credential: `DELETE` and `PUT` (overwrite) a WAL segment
   and a backup file → both must be refused; `PUT` `backup.info` → must
   succeed (R2: only if outside the rules).
4. With the writer credential: try to change or remove the lock
   configuration → must be refused.
5. Restore and PITR from each bucket to a disposable cluster.
6. Record costs observed per GiB-month and per request class, if the owner
   wants them.

### W9-04. Security residuals

#### Security review findings (B5)

Six independent adversarial reviews by fresh reviewers, at `cb11137`
(reviews a to d and f) and on the OD-55/56 work before its commit
`9274d50` (review e): (a)
encrypted backups and the immutable object store, (b) long-run node
capabilities, (c) restore identity and recovery, (d) session cancel and
terminate and the advisor SQL, (e) cross-role migration escape and the
baseline HMAC, (f) OAuth, RBAC, CLI and MCP consistency. "Reproduced"
means the reviewer showed the defect in the local lab or against the
Control Store; "traced" means read through the code. Every Critical,
High and Medium finding is fixed on this branch; none is waived. A fix
is proven only as far as its regression artifact reaches; the last column
says what it does not prove. `pglab` tests need root and real pgBackRest
2.60, PostgreSQL and restic; they ran in the session's lab, not in CI.

| Id | Severity | Cause | Affected actions | Fix | Regression artifact | Proof gap |
|---|---|---|---|---|---|---|
| A-1 / B-1 | High (reproduced) | the host mode file was not tied to the stanza and repo index a job names; a compromised Control Plane could expire or back up an observed repository | `backup.run`, `backup.expire`, `backup.verify` (node) | `bd60378`: root-owned `repositories/<id>/pgbackrest` binds `stanza=` and `repo=`, required when the mode allows runs; any other job refused | `TestRepositoryBinding` (`agent/node/internal/helper/backup_test.go`) | not run on a real systemd host (G5 waiver items 2 and 4 still apply) |
| A-2 / C-1 | High (reproduced) | the C-35 runbook kept the pgBackRest config in a temporary directory deleted on exit; recovery promoted early with most archived WAL missing, exit 0 | offline restore (C-35), RB-08 | `0928c31`: config in a kept `TARGET_DIR.exponetdb`, the script waits until recovery has ended and prints the replayed LSN | `packages/backups/test/runbook.lab.test.ts` (200000 rows written after the backup, all restored) | the owner's offline drill on separate hardware (M-9) not run |
| C-2 / B-4 | High (reproduced) | a restored scratch server kept enabled subscriptions and preload libraries; a drill advanced a real publisher's slot | `restore.drill`, `restore.execute` (node) | `bd60378`: command-line settings with no preload library, no logical replication or background worker, no WAL sender, autovacuum or JIT; restored `auto.conf` kept aside; the run fails unless no worker runs; check sessions read-only with `search_path=pg_catalog` | `TestScratchStartNeutralizesTheRestoredServer` (pglab) | the scratch postmaster keeps network access (R-NODE-4) |
| B-2 | Medium (traced) | the stanza was not checked against the job's cluster for backup, verify and expire | `backup.run`, `backup.verify`, `backup.expire` (node) | `bd60378`: every run and restore checks the stanza's `db-system-id` first | `TestStartsCheckTheStanzasCluster` (pglab) | none beyond the lab |
| B-3 | Medium (traced) | keep-label check and expiry could disagree when a full backup finished between them | `backup.expire` (node) | `bd60378`: pgBackRest dry run first, catalog read again afterwards; a kept label gone fails the run | `TestEngineRunExpireRace` (pglab) | narrowed, not removed: the label is still lost in the race; the run reports it (R-BKP-6) |
| B-5 | Medium (traced) | the unit's `EnvironmentFile` sat in a directory the engine user owns | restic runs and reads (node) | `bd60378`: root-owned 0700 directory | `backup_test.go` (environment file placement) | not run under real systemd |
| A-3 / C-3 | Medium (reproduced) | a lagging repository took the archiver's newest time; the RPO and PITR window looked fresher than the repository | protection, `restore.plan` (PITR) | `c2eed29`: time only for exactly the repository's newest segment; future times refused | `reconcile.int.test.ts` "archive times of a repository"; `protection.test.ts` (A-3) | per-repository segment times from the node remain a later capability |
| A-4 | Medium (traced) | WAL gaps were never recorded, so continuity was assumed | protection, `restore.source-verified` | `c2eed29`: a WAL basis carries `wal_continuity_unproven` (at most `unproven`); a restore to the archive end fails `recovery_target_reached` if replay stops short | `protection.test.ts` (A-4) | gaps are still not listed segment by segment (R-BKP-1) |
| A-5 | Medium (traced) | a truncated listing disabled `missing_in_engine` and still counted as fresh | protection, restore sources | `c2eed29`: `partial` reconciliation is stale | `protection.test.ts` (A-5) | missing entries inside the listed window are not marked yet (R-BKP-7) |
| A-6 | Medium (reproduced) | bundle guards let the worker set `passed` from a failed run, flip a result under one run id, reuse an ownership operation for two repositories, and clear the advisory | Control Store guards (`backup-catalog` bundle) | `685bd52`: guards bound to new verify runs, one operation per repository change, declared facts fixed, no future drill times | `packages/backups/test/backups.int.test.ts` "bundle guards" (6 refusals as `exdb_worker`) | the worker is the reconciler: a forged observation that moves `reconciled_at` forward still passes (R-BKP-9) |
| A-7 / B-7 | Medium / Low (traced) | restic "verification" checked a 1/10 repository subset, not the named snapshot | `backup.verify` (restic, pg_dump) | `ac40e8b`: refused with `CAPABILITY_UNAVAILABLE` until a snapshot-scoped check exists | `http-backups.int.test.ts` | logical-backup verification does not exist (residual R-BKP-8) |
| C-4 | Medium (traced) | a lost worker left a run `starting` or `unknown` forever and blocked the cluster | `backup.run`, `restore.*` reconciliation | `c2eed29`: reconciliation binds the run row to its start job, fails a run never started, asks the node for a start whose statement was lost | `http-backups.int.test.ts` (C-4) | none beyond the simulated node |
| C-5 | Medium (traced) | the runbook could not start a Debian-style data directory | offline restore (C-35) | `0928c31`: own `postgresql.conf`, hba and ident files, every safety setting on the command line | `runbook.lab.test.ts` (config outside the data directory) | M-9 |
| D-1 | Medium (reproduced) | a healthy `COPY FROM STDIN` matched the `stalled` terminate condition | `connections.terminate` (condition `stalled`), health `stalled_sessions` | `685bd52`: a pid with a `COPY FROM` progress row is not stalled | `packages/diagnostics/test/performance.int.test.ts` | a COPY from a client that really stalls mid-stream is no longer `stalled` (fails safe) |
| D-2 | Medium (reproduced) | advisor `message` and `remediation` carried raw catalog names but were not marked untrusted | `advisor.run`, MCP `advisors_run` | `685bd52`: fields untrusted, names quoted, server prose message | `packages/diagnostics/test/advisors.test.ts` (a hostile column name) | none |
| F-1 | Medium (engine-level) | plan views showed the repository location to holders of `backups.read` | `plan.get`, `operation.list` (REST, MCP) | `c2eed29`: `backup.*` plan content without location fields | regression test pending | `registry.endpoint.add` plans readable with `nodes.read` predate Wave 9 (R-VIEW-1) |
| F-2 | Medium (engine-level) | the cluster tier ignored a declared `prod` | every backup and restore action on a cluster subject | `c2eed29`: prod if either derived or declared tier is prod | regression test pending | none |
| A-8 | Low | the declared cipher overrode the observed one | protection, runbook | `c2eed29` | `reconcile.int.test.ts` "cipher of a repository" | none |
| A-9 | Low (reproduced) | `conf.d` merged by the helper but not named to the engine | engine runs (node) | `bd60378` | `TestConfDIsNamedToTheEngine` (pglab) | none |
| A-10 | Low | the engine floor was not enforced for runs | `backup.run` | `c2eed29`: `repository_engine_below_floor` | regression test pending | none |
| A-11 / F-3 | Low | the runbook showed the location without `registry.manage` | `restore.runbook.get` | `c2eed29`: the location permission is required | regression test pending | none |
| B-6 | Low | engine-written `outcome.json` naming an older label passed | `backup.run` verify | `ac40e8b`: the label must be first seen after the run's row | `http-backups.int.test.ts` (B-6) | none |
| C-6, C-7, C-9, C-10, C-11 | Low | apply re-checks missing for the WAL end and archived point, a backup chosen by id, the target's placement and generation; any runbook digest accepted; `target.maintenance` exclusivity missing | `restore.execute`, `restore.drill`, `restore.drill.offline.record` | `c2eed29` | covered by the existing drill path only; specific regression tests pending | a stale WAL end, a moved target and a wrong digest are traced, not tested |
| C-8 | Low | discarding a recovered cluster needed no approval | `restore.discard` | `685bd52`: rule `restore.recovery-discard-approval` | `packages/policy/test/backup-rules.test.ts` | none |
| D-3 / F-4 | Low | `advisors_run` was annotated read-only but writes runs, findings and audit (audit in a later transaction) | `advisor.run`, MCP `advisors_run` | `685bd52`, in part: the run, its findings and its audit commit in one transaction, the description says it records; the classification as a record action is [OD-57](../00-product/open-decisions.md#od-57-advisors_run-records-a-run-but-its-scope-is-a-read-scope) (the frozen G3B scope catalog stores `diagnostics.read` as a read scope) | `performance.int.test.ts` (a failing audit rolls the run back), `interfaces.test.ts` | the tool is still annotated read-only (R-MCP-1) |
| D-4 | Low (reproduced) | a session after `SET ROLE` to a superuser, and some backup tools, were not protected from signals | `connections.cancel`, `connections.terminate` | `685bd52`: membership in a superuser role protects; `pg_probackup` added | `performance.int.test.ts` | backup tool names are best-effort (application names can be anything) |
| D-5 | Low | a statement re-entering the top 200 put days of calls in one delta | statistics windows, regression baseline | `685bd52`: no delta across a gap over 600 s; windows bind `from_at` and the generation | `statements.test.ts` | none |
| F-5 | Low | MCP pins broken by the advisor schema change | MCP catalog | `e05826f` | `mcp-catalog.test.ts` | none |
| F-6 | Low | the dispatch re-check missed `registry.cluster.adopt_agent`, `backup.verify`, `backup.catalog.refresh` | worker dispatch | `73d8387` | `http-backups.int.test.ts` "the worker's dispatch re-check" | none |
| F-7 | Low | rule and preset text said more than the code | `backup.run-agent-prod-approval`, CLI `operator:nonprod` | `685bd52` | none (text) | none |
| E-1 | Medium (mechanism reproduced) | a deferred trigger fired by `SET CONSTRAINTS ALL IMMEDIATE` could defer again and queue an event that ran at `COMMIT`, after the ledger guard's last comparison, as the migrator | `migration.apply`, `migration.rollback`, `migration.resume`, the legacy replay | `9274d50`: rounds of `SET CONSTRAINTS ALL IMMEDIATE` until one changes no row (`pg_stat_xact_all_tables`), at most 16, else fail closed | `packages/migrations-engine/test/ledger-guard.int.test.ts` (a chain of 4 that writes the ledger at its end; a chain beyond the bound), shown to fail without the fix | none known; a forged ledger row would also diverge from the Control Store mirror (C-19) |
| E-2 | Low | `CREATE TABLE … AS`, materialized views and `REFRESH` run a query but were not procedural | OD-55 (c) classification | `9274d50` | `packages/postgres/test/procedural.test.ts` | calls of existing routines from DDL or DML expressions stay the T38 residual |
| E-3 | Low | a rule was not procedural, unlike a trigger | OD-55 (c) classification | `9274d50` | `procedural.test.ts` | none |
| E-4 | Low (not reachable) | an excused value that turns unreadable might stay excused | OD-56 (a) | none needed: an excusal needs the same aspects, so `unreadable` is another, unexcused failure | `verification-failures.test.ts` (pinned) | none |
| E-5 | Informational | the HMAC input does not bind the report and item | OD-56 (a) | none: the digest rows are write-once, worker-only, never read by serve | none | defense in depth only (R-OD56-1) |

#### Residuals

Residual risks this branch knows of and does not remove. None is waived;
each stays until its condition is met or the owner decides.

| Id | Residual | Why it stays | Until |
|---|---|---|---|
| R-NODE-3 | an engine run's egress is not restricted beyond the host firewall (`IPAddressAllow=` needs addresses, not names) | the repository endpoint is the host's own configuration; the Control Plane never names it | a later capability pins egress by address |
| R-BKP-1 | WAL continuity is read from the engine's listing (oldest and newest segment per archive id), not proven segment by segment; a hole inside the range is found by `backup.verify@1` or a drill, not by the listing | pgBackRest `info` does not list gaps | a verify run that records gaps into `wal_coverage.gaps` |
| R-BKP-2 | a repository lock is never `proven`; the Control Store refuses the value | no operation records the deletion and overwrite experiment yet | T-S3-1 to T-S3-6 and an operation that records them |
| R-BKP-3 | the catalog is refreshed on request only | node jobs belong to operations; no worker-started operation exists | a system-actor plan path (W9-05) |
| R-BKP-4 | drills record `fingerprint` and `ledger_head` as `not_run` | the Control Plane does not read the scratch cluster in V1 | a read path to scratch over the node |
| R-BKP-5 | the subkey check of the 2026-10-04 advisory is the operator's; ExponetDB keeps the advisory open but cannot close it | subkeys are key material and are never read | a record field for the operator's attestation |
| R-NODE-4 | the scratch postmaster of a drill or recovery keeps network access: `restore_command` must reach the repository; logical replication, background workers, preload libraries and WAL senders are off (C-2), but a restored function a check session calls could still connect out | `PrivateNetwork=` would cut off the archive | a pinned-egress unit (with R-NODE-3) or WAL staged locally before start |
| R-BKP-6 | B-3 narrowed: a full backup that finishes between pgBackRest's dry run and the expiry can still remove a label the Control Plane asked to keep; the run then fails and names it | pgBackRest has no keep-label option and no lock that spans both commands | an engine option, or expiry only while the host's own timers are stopped |
| R-BKP-7 | a truncated listing marks no entry `missing_in_engine`; it only makes the reconciliation stale (A-5) | marking inside the listed window needs an ordered, complete page from the node | a paged `backup.list` |
| R-BKP-8 | logical backups (restic, pg_dump) cannot be verified: `backup.verify` refuses them (A-7/B-7), so they never reach `verified_backup` | restic cannot check one snapshot's data | a snapshot-scoped check or a restore-and-list verification |
| R-VIEW-1 | `registry.endpoint.add` plan views show the endpoint to holders of `nodes.read` (predates Wave 9; found by F-1) | outside Wave 9 Part B's scope | the same stripping as for `backup.*` plans |
| R-BKP-9 | the worker reconciles repositories, so a write by the worker that moves `reconciled_at` forward with forged observation columns passes the guard (A-6 residual) | the observation is the worker's own job | an observation signed by the node and checked by the guard |
| R-MCP-1 | `advisors_run` is annotated read-only and runs under the read rate limit although it records a run and findings (F-4) | OD-57 is the owner's | OD-57 |
| R-OD56-1 | the excused-value digest binds the failure, not the report or item it belongs to; replay is prevented by write-once storage only (E-5) | defense in depth | a digest domain v2 |
| R-OD55 | cross-project role reach on one cluster (OD-55) | decided as a residual by the owner | the owner's later decision |
| R-CLI-1 | `drill record-offline` needs re-authentication the CLI cannot give (step-ups bind `plan.apply` and token reveal only) | the step-up action list is a contract; extending it is a separate change | a step-up for `restore.drill.offline.record` |

### W9-05. Cutover blockers (before any REOSA production use, Wave 11)

| Blocker | State |
|---|---|
| OD-7b: no applies to REOSA production before Wave 11 | **in force**; nothing in this branch applies anything there |
| OD-4-storage open | blocks the full G9 acceptance |
| Backup and restore execution on production | `EXPONETDB_BACKUP_EXECUTION=all` and `EXPONETDB_RESTORE_EXECUTION=all` are the owner's switches; both default to `disabled` |
| Recovery switch of a target to a restored cluster | **[PLANNED]**: the placement move to a restored cluster is not built; RB-08 step 7 is a person's registration and placement change |
| Scheduled backups and catalog refreshes by ExponetDB | not built (R-BKP-3); the host's own timers keep running |
| Hand-over to `owned` | refused (`CAPABILITY_UNAVAILABLE`) until a configuration capability with fixed templates exists and passed a host scenario |

G6 waivers (gate record [`gates/6.md`](./gates/6.md) §5, §10):

| Case | Expiry | State in this branch |
|---|---|---|
| E25 (a restored ledger) | before Wave 9 closes | **partial**: a restore operation exists now (drill into scratch, recovery into a new cluster, never in place; RB-08). A restored ledger older than the Control Store mirror reads as `LEDGER_DIVERGENCE`, which the E24 tests (deleted ledger row) cover; nothing re-runs a lost migration. Not covered: the placement move to the restored cluster and the re-plan of the migrations the recovery point lost, because the placement move is **[PLANNED]** (W9-05). The waiver is therefore **not closed** |
| E16 (`hotfix_without_evidence`), E18 (`applied_not_in_source`) | before the first import of real REOSA data (Wave 10) | not touched by Part B; still no detection |
| the eleven partial cases (E4 to E28) | before Wave 9 closes | not extended by Part B; still partial as listed in `gates/6.md` §5 |

### W9-06. Operational checks before turning execution on

1. Engine version on every node at least pgBackRest **2.59.3**; for every
   encrypted stanza created before it, the operator ran the project's
   subkey check ([adoption.md §3](../09-backups-and-restore/adoption.md#3-encryption-and-the-2026-10-04-advisory)).
2. Host mode files under `/etc/exponetdb-node/repositories/<id>/mode`
   owned by `root`, not group- or world-writable, saying what the owner
   wants (`adopted_observed` by default).
3. The offline key copy exists and was used once (T-C35-1); the runbook of
   each repository was downloaded and stored with it.
4. `EXPONETDB_BACKUP_EXECUTION` and `EXPONETDB_RESTORE_EXECUTION` set to the
   same value on serve and worker.
5. A drill passed on nonprod before anything runs on production.

### W9-07. UI/UX handoff (this side)

The UI/UX section's U9 named two integration points; this branch fills
them only as U9 describes (see the commits listed in W9-09):

| U9 point | This branch |
|---|---|
| `features/fleet/protection-slot.tsx` renders `FleetBackupHealth` from `features/wave9/fleet-backup-health.tsx` | **IMPLEMENTED, TESTED LOCALLY** (`cb11137`; `apps/web/test/wave9/global-backups.test.tsx`); the hero's backup fact and the connections page's session actions likewise |
| `BackupBindingsPort` provided by Wave 9 | **IMPLEMENTED, TESTED LOCALLY**: `backupBindings` (`packages/backups/src/dependencies.ts`) answers `none`, `blocking` or `unknown` (never `not_installed`); the preflight lists the dependencies by id; the Control Store guard `EXB07` decides again (`packages/backups/test/backups.int.test.ts`, `apps/server/test/http-backups.int.test.ts`). The negative integration proof against the retirement path is the T-RET-1 manual test and the EXB07 test |
| ADR numbering | this branch uses ADR-0036 to ADR-0038; ADR-0035 stays the UI/UX one |

The lifecycle dependency port (the owner's requirement of 2026-10-26),
as built:

| Contract | Shape | Failure semantics |
|---|---|---|
| `BackupBindingsPort` (`packages/registry`, `kind-base.ts`) | `(q, { kind: 'server' \| 'cluster', id }) => 'none' \| 'blocking' \| 'unknown'` | the registry's preflight, planners and kinds share one instance (`BACKUP_BINDINGS`); `not_installed` is no longer answered |
| `backupDependencies` (`packages/backups/src/dependencies.ts`) | `{ state, dependencies: BackupDependency[] (≤ 50), total }` | records unreadable → `unknown` with one `unreadable` dependency, which blocks like `blocking`, never "nothing binds it" |
| `RetirementPreflight.providers[{ provider: 'backups', state, dependencies? }]` (REST `GET /servers/{id}/retirement`, `GET /clusters/{id}/retirement`) | `BackupDependency`: `kind` (`repository`, `engine_run`, `restore`, …), `id` (ExponetDB id), `state`, `reason` | listed when `blocking` or `unknown`; ids and states only, never a bucket, prefix, endpoint or key |
| Control Store guard `clusters_backup_obligations` (`EXB07`, bundle `backup-catalog`) | a cluster is not retired while a repository is live, a run is open or a restore is not discarded | decides again under the row lock, whatever the application answered |
| Retiring a repository record | `backup.repository.retire` | deletes nothing in storage or on the host; catalog, runs, restores, drills stay as history |

Still to prove at merge: T-RET-1 (a live repository blocks the UI/UX
session's server and cluster retirement end to end).
| Bundle `dependsOn` | this branch's first bundle depends on `01M5WT5NV9ZC8TYB9BMP3D0EZZ` (`registry-retirement`) |

### W9-08. Owner walkthrough

What to look at, in order, to judge this branch (each step names its
evidence; nothing here is a claim that it passed on real infrastructure):

1. Decisions: W9-00, then [`orders/wave-9-part-b-order.md`](./orders/wave-9-part-b-order.md).
2. Design: ADR-0036 (with its "Implementation in Wave 9 Part B" table),
   ADR-0037, ADR-0038.
3. Runbooks: [`../12-operations/backup-runbooks.md`](../12-operations/backup-runbooks.md)
   and [`../09-backups-and-restore/adoption.md`](../09-backups-and-restore/adoption.md).
4. The end-to-end test `apps/server/test/http-backups.int.test.ts`
   (REST, worker, simulated node, real PostgreSQL 17) and the lab test
   `packages/backups/test/runbook.lab.test.ts` (a real encrypted pgBackRest
   backup restored by the generated runbook).
5. The manual matrix W9-02 and the residuals W9-04: what still needs
   infrastructure.
6. The storage spike W9-03 and the OD-4 decision it prepares.

### W9-09. Review history (append-only)

| Date | Commit | Change |
|---|---|---|
| 2026-10-26 | (Phase 0) | section opened: decisions recorded, gap matrix, ADR-0036 to ADR-0038 proposed, storage comparison and experiment plan |
| 2026-10-27 | `bd60378`, `0928c31`, `ac40e8b`, `c2eed29`, `73d8387`, `685bd52` | security reviews a to d and f: every Critical, High and Medium finding fixed with a regression artifact (W9-04) |
| 2026-10-27 | `9274d50` | OD-55 (c)+(d) and OD-56 (a) built; review e: E-1 (Medium) fixed, E-2 and E-3 fixed, E-4 not reachable (pinned), E-5 a residual |
| 2026-10-27 | `c10417a` | CI: the phone tour of the pending view (red on `main` since #42), the unserved-route example, the secret scan |
| 2026-10-27 | (docs) | OD-57 opened (F-4) |
| 2026-10-27 | `f35319d`, `aac31cf` | MCP replay recordings recorded again (the Wave 9 read tools, the procedural facts), the role-start probe, the partition scenario waits for the node after the gateway outage; CI green on `aac31cf` (17 of 17 jobs, run 40437293860) |

## Test campaign fixes – Parallel Session

| | |
|---|---|
| Branch | `fix/test-campaign-2026-10-27`, one pull request, based on `origin/main` `92a416f4` (the campaign tested `d0229550`) |
| Source | [the fix prompt](./prompts/2026-10-27-test-campaign-fixes.md) and its [evidence](./prompts/test-campaign-2026-10-27/README.md): 75 findings (P0 0, P1 13, P2 34, P3 28) |
| Toolchain of the runs | Ubuntu 24.04 on WSL2, UTC, Node 24.22.1, Bun 1.4.4 (the CI pins) |
| Rule | One commit per finding or tight group, tests first (red, then green); nothing is merged or deployed by this session |

### TC-1. Findings fixed on this branch

| Finding | Status | Regression artifact | Document |
|---|---|---|---|
| TC-003 single-quoted `DO` body bypasses the token bound | IMPLEMENTED, TESTED LOCALLY (red without the fix, green with it) | `packages/postgres/test/legacy-references.test.ts` (four single-quoted shapes, the decoder, the negative cases), `packages/migrations-engine/test/legacy-files.test.ts` (the `422 too_large` and a 4 MiB `DO '…'` refused within 200 MiB of growth) | [deployment.md §2a](../12-operations/deployment.md#2a-memory), [9-part-a.md §9](./gates/9-part-a.md) |
| TC-004 `search_path` strictness check is a quadratic regular expression | IMPLEMENTED, TESTED LOCALLY (red on the old regex for all four families, green with the scan) | `packages/postgres/test/cluster-global.test.ts` (differential fast-check against the old regex, 30 000 cases; scaling `time(1 MiB) / time(256 KiB) < 8` and 1 MiB under 200 ms for `one_ws`, `rep_noterm`, `rep_comma`, `rep_pad`; the strictness results unchanged) | [9-part-a.md §9](./gates/9-part-a.md) |
| TC-005 an operation in `needs_attention` holds the target's schema domain and the documented recovery cannot start (MIG-01) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: the resume and the verify wait for ever; the Control Store bundle `operation-supersession`; owner confirms [OD-58](../00-product/open-decisions.md#od-58-how-an-operation-in-needs_attention-is-closed)) | `packages/operations/test/states.test.ts`, `engine.int.test.ts` (both transition functions against the code), `driver.int.test.ts` (closes the named operation, `unknown` becomes `partially_applied`, only one in `needs_attention` that holds a needed domain); `packages/migrations-engine/test/recovery.int.test.ts` (a verify.sql that errors, a killed `CREATE INDEX CONCURRENTLY`, an unrelated migration's verify closes nothing) | [operations-engine.md §4.1](../02-control-plane/operations-engine.md#41-state-machine), [control-database.md §5](../02-control-plane/control-database.md), [failure-and-recovery.md](../04-migrations/failure-and-recovery.md) |
| TC-006 the next verified migration silently adopts an out-of-band schema change into the drift baseline (MIG-02) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: `recorded` where `drift_open` is required) | `packages/diagnostics/test/diagnostics.int.test.ts` (adopts from the baseline, keeps baseline and critical finding after an out-of-band `GRANT`, a legacy baseline without a starting fingerprint unchanged), `packages/migrations-engine/test/recovery.int.test.ts` (apply and resume plans pass the right fingerprint); the existing `http-migrations.int.test.ts` flow is the control (clean after a migration without an out-of-band change). Residual: after `drift_open` the migration's own change shows as drift until `drift.accept` | [drift-detection.md §7](../03-database-model/drift-detection.md) |
| TC-008 one stored bundle with an unknown dependency blocks planning for the whole project (MIG-04); TC-022 the error carries no id | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: the unrelated plan was refused `MIGRATION_DEPENDENCY_UNKNOWN`; the lint stream was the second half) | `packages/migrations-engine/test/recovery.int.test.ts` (an unrelated plan succeeds; the dangling bundle, a child of it and an inline bundle are refused naming `migrationId` and `missing`), `apps/cli/test/foundation.test.ts` (the CLI prints them, long lists cut, hostile text inert); contract catalog `MIGRATION_DEPENDENCY_UNKNOWN` gets optional `details` (`catalog.json` regenerated). Not done: refusing the dangling edge at ingest and a stream finding for it (the lint reports it; the plan is confined) | [dependency-graph.md §3](../04-migrations/dependency-graph.md), [error-model.md](../02-control-plane/error-model.md) |
| TC-007 a restored ledger blocks every schema plan and `ledger.reconcile` is not built (MIG-03, E25 waiver) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (the new Control Store bundle `ledger-reconcile`, a policy rule, the planner and kind, the REST route that was the last contracted route not served, the CLI command `migration ledger reconcile`). Owner confirms [OD-59](../00-product/open-decisions.md#od-59-flagging-ledger-rows-as-untrusted) (`flag_untrusted` is `not_built`) | `packages/migrations-engine/test/reconcile.int.test.ts` (7 cases: the E25 restore end to end, a stale plan, a hand checksum and a hand row, identity marker and cluster refusals, nothing to reconcile, the unbuilt decision, the definer function refused for any other operation), `packages/policy/test/migration-rules.test.ts`, `apps/cli/test/backups.test.ts` (3 cases), `apps/server/test/server.int.test.ts` and `http-wave8.int.test.ts` (the route is served, no contracted route is left unserved). E25 row of [gates/6.md](./gates/6.md) updated | [ledger.md §5](../04-migrations/ledger.md#5-mirror-and-reconciliation), [control-database.md](../02-control-plane/control-database.md), [policy-engine.md](../02-control-plane/policy-engine.md) |
| TC-001 `plan show` returns no change content for the seven `postgres.*` node plan kinds | IMPLEMENTED, TESTED LOCALLY (red before: no `change` for any of them). The CLI table and the Web plan page render it. TC-002 below is the other half of this section-5 group | `packages/application/test/views.test.ts` (all seven kinds with realistic bodies: the change is there, no host file or directory, no verifier or key; the hba diff and the restart disruption; `credential.rotate` stays without), `apps/cli/test/foundation.test.ts` (the hba rules before and after with the protected access, the restart's connections per role, config, roles, extensions, tls; hostile text inert), `apps/web/test/plans/plan-page.test.tsx` (the analysis next to the change). Not done: an `apps/server` integration over a real node plan (the host scenarios cover the plans; the view is proven on the stored bodies); the contract's description sentence of `PlanView.change` is unchanged on purpose (it is part of every MCP tool's pinned definition digest, so a new sentence would be a new version of all of them for no behavior) | [control-plane.md §9.3](../07-node-agent/control-plane.md) |
| TC-002 `node postgres config` and `node postgres roles` cannot be planned from the CLI | IMPLEMENTED, TESTED LOCALLY (red before: no inspection was made, the plan failed `NODE_OBSERVATION_STALE`). The host scenario the finding asks for was NOT EXECUTED (it needs a disposable systemd host) | `apps/cli/test/backups.test.ts` (6 cases against the fake server: config with typed `changes`, roles with `expectSettings: []`, a fresh observation reused only for arguments that do not depend on the change, always inspected for config, `--no-inspect`, a failed inspection plans nothing, `--arg-json` repeatable with commas and refused when not JSON); a new repeatable flag type `repeat`. Not changed: a `list` flag (`--set`, `--reset`) still splits on commas, so a parameter value that contains one (`search_path=a,b`) cannot be given with `--set` yet | [control-plane.md §9.3](../07-node-agent/control-plane.md) |
| TC-009 `latest` and `older` restore drills always fail on a real host (D-01) | IMPLEMENTED in the node helper, TESTED LOCALLY by the Go unit test (red before: `--type=immediate`). **NOT EXECUTED**: the finding's `pglab` matrix against real pgBackRest 2.60 and the host scenario in which drills `latest`, `older` and `pitr_random` end `passed` with a measured RTO (no pgBackRest, no systemd host in this session) | `agent/node/internal/helper/backup_test.go` `TestRestoreTypeArgs` (8 cases and two invariants: no `immediate`, `--target-timeline` only after default, time or lsn); the whole helper package (26 s) passes | [restore.md §3](../09-backups-and-restore/restore.md) |
| TC-010 `amcheck: not_run` fails every drill unless the extension exists in every restored database (D-02) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 with the simulated node (red before: `not_run` ended `verification_failed`). Owner confirms [OD-60](../00-product/open-decisions.md#od-60-how-strict-a-drill-is-about-amcheck). NOT EXECUTED: the integration test with the real node check output | `apps/server/test/http-backups.int.test.ts` (a `not_run` amcheck: the drill succeeds and the check keeps its outcome and detail; a `failed` one: `verification_failed`) | [restore.md §3](../09-backups-and-restore/restore.md) |
| TC-011 `backup.verify` never detects corruption (D-03) | IMPLEMENTED in the node helper, TESTED LOCALLY by a Go test with realistic `pgbackrest verify` text (red before: a corrupt segment gave `verifyErrors 0` and `succeeded`). **NOT EXECUTED**: the finding's `pglab` corrupt-segment and deleted-segment cases against real pgBackRest 2.60 (the text format is reproduced from pgBackRest's documentation and the campaign's report, not captured from a real run here). The Control Plane needed no change (it already requires `succeeded` and `verifyErrors == 0`) | `agent/node/internal/helper/backup_test.go` `TestEngineRunVerifyReadsWhatPgBackRestReports` (5 shapes); the helper package passes | [architecture.md](../09-backups-and-restore/architecture.md) |
| TC-012 Logical backups to a local restic repository cannot run under the shipped sandbox (D-06) | IMPLEMENTED in the node helper, TESTED LOCALLY by a Go test of the unit's argv (red before: no writable path for the repository). **NOT EXECUTED**: the host scenario with a real directory repository (no restic, no systemd host here). Not done: cutting the lock retry (`--retry-lock`), which depends on the restic version and is moot once the repository is writable | `agent/node/internal/helper/backup_test.go` `TestLocalResticRepositoryIsWritableInTheUnit` (a local path and `local:` are listed; `s3:`, `sftp:`, `rest:`, a path that climbs, the root and a relative path are not); the helper package passes | [ADR-0037](../01-architecture/adr/0037-durable-long-running-node-capabilities.md) |
| TC-013 `POST /clusters/{id}/drills/offline` returns 500 because serve cannot insert into `backups.drills` (D-09) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 with the real role set (red before: a valid request answered `500 INTERNAL` and nothing was logged). The cause is confirmed, not suspected: `42501` (permission denied) for `exdb_serve`, which the new log line reports. The new Control Store bundle `offline-drill-record` adds `backups.record_offline_drill(...)` (`SECURITY DEFINER`, executable by serve) instead of a table grant, because the frozen backup-catalog `verify.sql` states that serve only reads. Serve now logs the class, code and cause code of every `500 INTERNAL`. NOT EXECUTED: the host scenario C3 on a systemd host (no host here). Not done: the `http.response_contract_violation` line at `api.ts` still passes the operation id as `route`, which the logger drops (a one-word fix outside this finding) | `apps/server/test/http-backups.int.test.ts` (201 and listed as `offline_runbook:attested` and `:failed`, a wrong digest `422`, two audit rows, then `EXECUTE` revoked: `500 INTERNAL` and one `http.request_failed` line with `causeCode 42501` and the route); `packages/control-store/test/registry-schema.int.test.ts` (upgrade through the new bundle) | [control-database.md](../02-control-plane/control-database.md), [restore.md](../09-backups-and-restore/restore.md) |
| TC-030 a failed list read still prints an empty-list body on stdout and `data.items: []` in the error envelope | IMPLEMENTED, TESTED LOCALLY (red before for all 22 paged lists: the empty-state text and count on stdout, `data.items: []` in JSON). One change in the shared `listingFailure` (`apps/cli/src/cli/lists.ts`), used by the three list builders and by `plan list`, `operation list` and `approval list`: an error with no item received is the typed error alone; a failure after some pages keeps the items and `partial: true` as documented. Not done: `--output ndjson` of a failed first page (it already ends in one error record) | `apps/cli/test/backups.test.ts` "a failed list read" (22 commands answered 403, human and JSON, plus a partial listing); the CLI package passes (165 tests) | [15-cli/README.md §4](../15-cli/README.md) |
| TC-031 `node list --server` ignores its filter; `node enrollment status` treats an unknown server as "not enrolled" | IMPLEMENTED, TESTED LOCALLY (red before: both nodes listed, exit 0 for an unknown server). The CLI filters every page by `serverId` before the limit counts and checks the server with `GET /servers/{id}` first (`NOT_FOUND`). The finding proposed adding `serverId` to `GET /nodes`; that would change the contract and the MCP `nodes_list` digest, so the server-side filter is left as an option | `apps/cli/test/backups.test.ts` "node reads name their server" | [15-cli/README.md §4](../15-cli/README.md) |
| TC-032 `migration import scratch-check` and `scratch-copy-commands` accept a nonexistent scratch | IMPLEMENTED, TESTED LOCALLY with a fake server that answers as the real one does (a 200 check result with `scratch_usable` failed; red before: exit 0 and "nothing to copy"). The scratch is resolved first (`TARGET_NOT_FOUND`, exit 1, nothing on stdout); `scratch-check` exits 1 with `SCRATCH_NOT_READY` and keeps its result in `data`; `scratch-copy-commands` stays exit 0 for a scratch that is not ready. The server path was not changed | `apps/cli/test/backups.test.ts` "the import scratch helpers need a scratch target that exists" | [15-cli/README.md §4](../15-cli/README.md) |
| TC-033 `access grants` cannot work with the CLI's OAuth token | IMPLEMENTED by removing the command (the finding's second option), TESTED LOCALLY (the new guard test was red with exactly this command). Serving the route to bearer tokens was rejected: `oauth.grant.list_own` is web-only by design and the delegation matrix test says a delegated principal never reaches own-session actions. The guard checks every command of the CLI against its action's client kinds. `15-cli/reference.md` was regenerated | `apps/cli/test/foundation.test.ts` "every command can be run by the CLI" | [15-cli/README.md §4](../15-cli/README.md) |
| TC-014 `sql_query` refuses unqualified relation names with a misleading construct error (E3) | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 16, 17 and 18 (red before: the construct was the bare relation name). The finding's second option was taken: the typed refusal now says what to write; resolving bare names through a `search_path` was not, because the empty `search_path` is a security property of the read lane. No contract change (the construct field stays free text, so no tool digest moved). Not done: the second `relation_unqualified` branch (a database-qualified name) still names only the relation | `packages/diagnostics/test/data-read.int.test.ts` (four bare names refused with the advice; the qualified forms answered; `lookalike.pg_stat_activity` is its own table); `packages/postgres/test/admission.test.ts` (the exact text on three grammars) | [sql-execution-security.md §2.1](../03-database-model/sql-execution-security.md) |
| TC-015 `query_stats` is unavailable on every registered target and its error names the wrong cause | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: no details, and the message blamed the node or an external cluster). The refusal now carries `details { reason: extension_missing, extension: pg_stat_statements }`, the catalog message names the missing extension as a third cause and the catalog remediation says how to install it; the CLI prints the two detail lines. Because the message and remediation are fixed per code, they could not be specific to `query_stats`; `details` is where the specific fact lives. Not done: the Web performance page already has its own missing-extension message and shows the catalog message below it, unchanged; enabling the extension from the CLI depends on TC-002 (done) and on a node plan, which was not exercised here | `packages/contracts/test/errors.test.ts` (the details accepted and refused, message and remediation); `packages/diagnostics/test/performance.int.test.ts` (a database without the extension); `apps/cli/test/backups.test.ts` (the text output) | [error-model.md](../02-control-plane/error-model.md), [tool-catalog.md](../05-mcp/tool-catalog.md) |
| TC-016 `node show` and the node view always say "No clusters reported" (E2) | PARTLY IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: `clusters: []` after a hello that listed two). The view is built from the stored hello merged with the heartbeat's per-cluster state, and `clusterId` is mapped from the system identifier to the live registry cluster (`null` when unknown). **Not done, an open limit:** the agent still sends no clusters in its heartbeat, so `pendingRestart` is always `false` and the certificate expiry `null` in the live view (they are not reported, and the REST shape has no unknown); the finding's second option (the agent sends its clusters, a protocol-minor change) and a nullable `pendingRestart` were not built because both change a contract and need the host to read the pending-restart flag. NOT EXECUTED: the finding's host scenario (a real agent on a systemd host) | `packages/nodes/test/nodes.int.test.ts` (a node with two hello clusters, one mapped to a registry cluster and one not; a heartbeat that turns one stopped with a pending restart and a certificate expiry) | [control-plane.md §7](../07-node-agent/control-plane.md) |
| TC-018 a pg_hba block that rejects everything is planned and allowed; no plan-time protected-access check | IMPLEMENTED, TESTED LOCALLY by unit tests (red before: no evaluator). New code `HBA_WOULD_LOCK_OUT` (409, `details` role, database, address, method and the deciding rule) answered by `POST /nodes/{id}/plans`; `packages/nodes/src/hba-lockout.ts` mirrors the agent's `matchAccess` for the managed rules, including IPv6 and the method check. What it does not judge (`samehost`, `samenet`, `samerole`, and a name the agent is configured with other than `exponetdb_node`) is left to the agent. NOT EXECUTED: the host scenario `hba.host.test.ts` (no systemd host here; it now asserts the plan-time refusal and keeps the agent-side refusal with a `samerole` rule the plan cannot judge), and a REST/plan integration test of the refusal through `planNodeOperation` (it needs a bound node, a basis observation and a registry cluster; the evaluator is unit-tested and the call site is one statement) | `packages/nodes/test/capability.test.ts` "a pg_hba block that would lock ExponetDB out" (five tests); `packages/contracts/test/errors.test.ts` (details shape) | [control-plane.md §9.6](../07-node-agent/control-plane.md), [error-model.md](../02-control-plane/error-model.md) |
| TC-019 `node revoke` and `node decommission` plans state no effect, no tier and no requirements | IMPLEMENTED, TESTED LOCALLY on PostgreSQL 17 (red before: `requirements []`). The plans now carry the server's derived tier in the subject, an analysis (`effect` and the `impact` counts), an `action` in the content (the two kinds no longer share a checksum) and, through the new policy rule `node.lifecycle-reauth` (version 1, on every tier), the re-authentication in `requirements`; the decision of these plans is now `require` (it was `allow` with no requirement). The policy catalog changed, so plans made before the deployment carry the old policy version. Not done: `node.enroll` still lists no re-authentication (not in the finding); the impact counts are a snapshot, not a binding (the apply re-checks the node's state only) | `packages/policy/test/node-rules.test.ts` (the rule); `apps/server/test/http-nodes.int.test.ts` (requirement, analysis, action, different checksums); `apps/server/test/node-operations.int.test.ts` (the tier, nonprod and prod) | [control-plane.md §6](../07-node-agent/control-plane.md), [policy-engine.md §4](../02-control-plane/policy-engine.md) |
| TC-021 `survivingExpectations` over a whole legacy chain is quadratic; memory is unbounded across files (Part A P1 no. 2) | PARTLY IMPLEMENTED, TESTED LOCALLY. (3) `survivingExpectations` is O(E+S): 30,000 statements in well under a second (2.4 s with the old code, red before), equal to the old definition on 200 random chains; the per-file survivor filter is a grouping. (1) A total token budget of 1,000,000 (the campaign suggested 600,000, which the 623,009-token fixture of the first real import's size would exceed). **Not done:** (2) compact per-file facts after the replay (a refactor of `FileReplay`), (4) a cap on the legacy ledger read, the cgroup measurement gate (`measure-analyze-memory.ts`, nine dense files, RSS below 350 MiB) and a test that the operation lease renews while the loop runs; the memory figure for the budget is an extrapolation | `packages/postgres/test/migration-analysis.test.ts` (property and timing); `packages/migrations-engine/test/legacy-files.test.ts` (the budget); `legacy-large.int.test.ts` still passes | [deployment.md §2a](../12-operations/deployment.md) |
| TC-039 `exponetdb-node enroll` on a fresh host fails with `state directory: lstat /var/lib/exponetdb-node`; the literal runbook has two more blockers | IMPLEMENTED, TESTED LOCALLY (red before: the bare `lstat` error). A packaged `tmpfiles.d/exponetdb-node.conf` creates the state directory (`0700`, the agent's user) and the runbook §2 installs both tmpfiles files, runs `systemd-tmpfiles --create` and creates `/etc/exponetdb-node`; §3.3 reads the token from standard input (the agent's user cannot open a file in `/root`); `state.Open` answers a missing directory with `does not exist: run systemd-tmpfiles --create … node-runbook.md`; `build.sh` ships and checksums the file; `verify-units.sh` checks the configuration through systemd (and, as root, the created owner and mode). **NOT EXECUTED:** the host scenario that follows the runbook text literally on a systemd host (install, enroll as the agent user before any unit, then start), and the root-only branch of `verify-units.sh` (run unprivileged here; a mutation of the mode made the configuration check fail) | `agent/node/internal/state/state_test.go` `TestOpenMissingDirectoryExplainsTheFix`; `agent/node/cmd/exponetdb-node/main_test.go` `TestEnrollMissingStateDirectoryExplainsFix`; `agent/node/packaging/verify-units.sh` | [node-runbook.md §2, §3](../12-operations/node-runbook.md) |
| TC-042 an expired node certificate is silent and indistinguishable; nothing warns before the renewal window closes (GAP-11) | PARTLY IMPLEMENTED, TESTED LOCALLY: `exponetdb-node status` prints the remaining certificate life or `EXPIRED … ago` with the runbook pointer (Go test, red before: the bare date). **Not done:** a distinct refusal reason `certificate_expired` (a catalog change to `NODE_CERTIFICATE_REFUSED`, which has no details, plus the gateway and the agent), and the node findings `node_certificate_near_expiry` and `node_certificate_expired` with a warning 12 h before the end: the thresholds are an owner decision recorded as OD-62 (options and a recommendation in `open-decisions.md`), and the host scenario that moves the clock past `notAfter` was not run | `agent/node/cmd/exponetdb-node/main_test.go` `TestStatusSaysHowLongTheCertificateLasts` | [node-runbook.md §6](../12-operations/node-runbook.md) |

### TC-2. Review history (append-only)

| Date | Commit | Change |
|---|---|---|
| 2026-10-28 | (this branch) | section opened; TC-003, TC-004, TC-005, TC-006, TC-008, TC-022, TC-007, TC-001, TC-002, TC-009, TC-010, TC-011, TC-012, TC-013, TC-030, TC-014, TC-015, TC-016, TC-018, TC-019, TC-021, TC-031, TC-032, TC-033, TC-039, TC-042 |
