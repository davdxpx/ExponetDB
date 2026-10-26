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
| last commit of the PR | Documents: ADR-0035, this section, IA, design system, parity; button links on the Changes landing |

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
| retirement and new child at the same time, both orders | the second waits on the row lock and is refused (EXG07) | TESTED LOCALLY (SQL level) |
| node `active`, `offline`, `revoked`; open node job; open enrollment token; open operation naming the subject | blocks; preflight names it | covered by the queries and the guard; **NOT EXECUTED** as integration cases |
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

| What | Result | Label |
|---|---|---|
| `apps/web` vitest | 164 files, 2,441 tests passed | TESTED LOCALLY |
| `packages/ui-patterns` vitest | 90 files, 1,141 tests; 1 fails in this machine's CET shell (`metric-card` expects UTC clock text; passes with `TZ=UTC`; the file is untouched by this branch) | TESTED LOCALLY, **time-zone dependent test observed** |
| `packages/icons` vitest | 8 passed | TESTED LOCALLY |
| `bun run typecheck` (turbo, every package) | 28 of 28 tasks successful | STATIC CHECKED |
| `packages/contracts`, `application`, `sdk`, `registry` (unit), `apps/cli`, `apps/server` (unit) | 218, 68, 89, 8, 79, 189 passed | TESTED LOCALLY |
| `packages/registry` integration (incl. `registry-retirement.int.test.ts`, 5 cases) | 42 passed | TESTED LOCALLY |
| `packages/control-store` integration | first run: one failure in `registry-schema.int.test.ts` (`migration_verifications_check`, a verification finishing before it started; host and container clocks differ by ~0.1 s); rerun: 13 of 13 passed; full suite 104 passed, 13 skipped | TESTED LOCALLY, **flaky clock check observed, not caused by this branch** |
| `packages/nodes` integration | 19 passed | TESTED LOCALLY |
| `bun run verify:generated`, `golden:check`, `golden:history origin/main` (21 frozen bundles byte-identical, 30 MCP tool versions unchanged), `boundaries`, `secrets`, `third-party`, `ui-safety`, `check` (biome) | all hold | STATIC CHECKED |
| `apps/web` build with bundle budgets | entry 277.2 of 308 kB, CSS 31.3 of 35 kB, largest lazy route 35.7 of 51 kB | STATIC CHECKED |
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

### U12. Security, RBAC and CSP points (NOT PROVEN until reviewed)

- No new secret surface: the Connect sheet builds text from registry records
  (`registry.manage` only, OD-41) with placeholders for role and password;
  values that are not safe to paste are refused, never escaped (tested with
  hostile hosts and names). NOT PROVEN by an independent review.
- Retirement is human only, re-authenticated, `registry.manage` at the cluster
  tier or production authority, `high`; **no approval rule** applies, as for
  database retirement today (gap, owner decision below).
- The preflight reads need `registry.manage`; a person without it gets a named
  state and no request. Names in the read are untrusted text, rendered as
  such; no secret, address or token value is in it.
- Search parameters of the new routes are validated with every key returned,
  so no unchecked parent value reaches a page (regression tests).
- CSP unchanged (`ui-safety` holds); no dependency added; no remote asset.

### U13. Decisions for the owner (none taken here)

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
6. **The open P1 items** 6 and 9 and the reads of U8: which to build before
   Wave 11.
