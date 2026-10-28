# Web App audit, test campaign 2026-10-27 (C)

Scope: https://db.exponet.cloud (read-only, signed-in owner session), source read from
`/home/david/Development/ExponetDB-testcampaign/apps/web/src` (origin/main d0229550). Nothing was
submitted, planned, applied or revealed. No secrets were copied.

## 0. Limits of this audit (read first)

1. **The window could not be resized.** `resize_window` returned success but the Chrome window is
   maximized: `innerWidth` stayed 1920 x 945 (screen 1920 x 1080). So there is no 1440x900 or
   390x844 *screenshot*. Workaround: a same-origin popup (`window.open` from a click on a temporary
   button I injected into my own tab) was sized to 1440x900 and 390x844 and driven by script; I ran
   a read-only DOM audit in it (title, h1 count, horizontal overflow, header overlap, unclipped or
   truncated text, `undefined`/`null`/`NaN`/`[object Object]`, `1 <plural>`, untranslated keys, raw
   snake_case, failed GET resources via `PerformanceResourceTiming.responseStatus`). A popup cannot
   be screenshotted by the tool, so **at 390 and at 1440 only DOM metrics exist, no visual
   judgement.** Screenshots (scale 0.5) were taken at 1920x945 for about 14 pages.
2. **Console:** `read_console_messages` was only usable on the main tab. Result: no error, warning,
   CSP or Content-Security message on any page visited there (/, /findings, /projects, /p/reosa/platform,
   /targets, staging overview, migrations, performance, scratch schema, sql, /backups, /connect,
   /settings/policies, /audit, server and cluster pages, Connect sheet in five modes). Popup pages
   have no console tracking. `read_network_requests` is dominated by static assets, so failed GETs
   were taken from resource timing instead (see section 3).
3. **Keyboard:** full 25-Tab run on /targets, about 20 Tabs on staging/migrations (entered at `main`),
   command menu (Ctrl+K) and Connect sheet: trap, wrap, Escape, focus return. /audit, /access/people
   and the scratch pages were **not** tabbed (time).
4. "Remove from ExponetDB" is an **inline section** on the server and cluster pages, not a dialog.
   Its button ("Plan removal of this ...") creates a plan, so it was not clicked; the preflight text
   was read from the DOM.
5. The tab id of the browser tab changed several times during the run (the extension recreated it
   on navigation) and one batch lost its connection; the lost batch was only navigation and
   screenshots. Temporary DOM I added to my own tab: one button (to open the popup) and one test
   `iframe` (see info I-1). Both tabs are closed; the popup is gone.

## 1. Route table

Legend: OK = single h1, no overflow, no header overlap, no placeholder strings, sane layout.
"1440" and "390" columns are DOM-metric verdicts from the popup (iw 1440 / iw 390); the 1920
screenshot verdict is in Notes where taken. Console column: n/a means not observable.

| Route | 1440 | 390 | Console | Notes |
|---|---|---|---|---|
| `/` | OK | OK | clean | 1920 shot sane. Raw `control_store`, `data_reads`, `audit_chain` (W-09). Criticals 520 of 14,184 = CLI (W-03) |
| `/findings` | OK | OK | clean | Kind filter lacks Advisor/Statements (W-02); raw `advisor:drift_open` codes (W-09) |
| `/projects` | `1 projects` (W-08) | same | clean | grid/table switch present, paging in URL |
| `/p/reosa/platform` | OK | OK | clean | title "Projects" (W-10). Streams: scratch 12 unknown, staging 11 verified + 1 not applied, "12 bundles, 5 heads" |
| `/targets`, `/targets/register` | OK | OK | clean | 2 targets = CLI. Full 25-Tab run: focus ring on every stop (W-01 side effect) |
| `/changes` | OK | OK | n/a | entry page |
| `/changes/plans` | raw action ids (W-09) | same | n/a | "Showing part of Plans" is stated honestly |
| `/changes/plans/<id>` | OK | OK | n/a | unknown id: not found, title "Plan review" (W-10) |
| `/changes/operations`, `/<id>` | raw ids (W-09) | same | n/a | title "Operations" for detail |
| `/changes/promotion` | OK | OK | n/a | no data to judge the 1,000-row case (P2 #46 not exercisable) |
| `/approvals` | OK | OK | n/a | `access.identity.erase` shown raw |
| `/infrastructure` | redirects to `/servers` | same | n/a | |
| `/infrastructure/servers`, `/<id>` x2 | `1 clusters`, `1 nodes` (W-08) | same | clean | "Remove from ExponetDB" preflight present; titles "Servers" |
| `/infrastructure/clusters`, `/<id>` | `1 active endpoints` (W-08) | OK | clean | preflight lists 2 registered databases, 1 endpoint, 5 credentials |
| `/infrastructure/nodes` | OK | OK | n/a | 1 node = lead's count |
| `/infrastructure/nodes/<id>` | OK | **main scrolls horizontally** (W-05) | n/a | h1 is the raw id |
| `/infrastructure/certificates` | OK | OK | n/a | |
| `/backups` | OK | table scrolls inside its box (342 of 583 px), acceptable | clean | honest: 1 cluster UNKNOWN, "No backup repository is registered", "Not measured", "Never drilled" |
| `/access` | **404 page** (W-11) | same | n/a | |
| `/access/people`, `roles`, `service-accounts`, `oauth-clients`, `connected-apps` | OK | OK | n/a | `/admin/clients` and `/admin/service-accounts` redirect correctly |
| `/connect` | OK | OK | clean | |
| `/audit` | OK | OK | clean | chain indicator + events; long filter form above events (W-15); mixed time formats (W-13) |
| `/settings` | **404 page** (W-11) | same | n/a | |
| `/settings/products`, `projects`, `environments`, `policies`, `notifications`, `installation`, `break-glass` | OK | `products` table scrolls inside its box | clean (`policies`) | notifications is the OD-21 named state |
| `/account`, `/preferences`, `/security`, `/applications`, `/activity` | OK | OK | n/a | all five titled "Your account" (W-10) |
| `/t/<p>/<pr>/staging` and `/scratch` overview | OK | OK | clean | 1920 shot (staging) not retrieved, see limits |
| `.../schema`, `.../schema/tables`, `/schema/visualizer`, `/schema/policies` | OK | OK | clean | |
| `.../sql` | OK | OK | clean | |
| `.../migrations` | OK | OK | clean | staging: paged (51 `tr` = 50 rows + header), "567 of 567 migrations match", counters (W-04); scratch: 0 applied, 12 pending, "The Control Store mirror differs from the ledger" |
| `.../compare?to=<other>` | OK | OK | n/a | |
| `.../drift` | table scrolls inside box (scratch) | OK | n/a | |
| `.../connections`, `.../locks` | OK | OK | n/a | `null` seen at 1440 is SQL text of a session, not a defect |
| `.../performance` | OK | OK | n/a | GET query-stats answers **409** (named state; W-14) |
| `.../activity`, `.../findings`, `.../advisors`, `.../backups`, `.../configuration` | OK | OK | clean (findings, backups) | staging findings: 215 open = CLI |
| unknown path, unknown target, invalid slug, unknown plan/server id | "Page not found" inside the shell | same | n/a | titles wrong (W-10); 404s on the API GET are expected |

## 2. Comparison with the CLI (`xdb`, read-only)

| Fact | Web | CLI | Verdict |
|---|---|---|---|
| Targets | 2 (staging, scratch), both healthy | `target list`: 2, healthy | match |
| Nodes | 1 | 1 | match |
| Open findings | 14,184 (520 critical, 13,258 warning, 406 info) | `finding summary`: identical | match (it was 14,183 / 519 at the first read and grew by one within minutes) |
| staging ledger | Applied 567 (555 imported), pending 1 | `migration status`: 567 applied, 1 pending, mirror in sync | match |
| scratch ledger | Applied 0, Not applied 12, mirror differs | 0 applied, 12 pending, mirror out of sync | match |
| staging verification | Verified 539, not verified 0, failed 0 | all 567 `passed`, of which 28 flagged `superseded` | counters do not add up (W-04) |
| staging findings | 215 | 215 (all `advisor`: 100 unindexed_foreign_key, 100 rls_enabled_without_policy, 15 others; no drift, no critical) | match |

Findings breakdown (CLI, whole fleet): `drift/object_added` 13,222 warning + 518 critical, `advisor` 443
(`drift_open` 1 critical, rest warning/info), `drift/object_changed` 1 critical. Staging has 215 of
14,184 (1.5 percent); scratch carries the other 13,969. **Of the 520 criticals, 518 are
`object_added` on scratch (policies "exists but is not in the expected schema", because scratch has
no ledger), 1 is the advisor roll-up `drift_open` that restates them, and exactly 1 is a real
signal (`object_changed`: "schema public changed: acl", scratch).** Yes, this is noise that hides
real findings (W-03).

## 3. Failed GETs seen (resource timing)

Only 404 for deliberately invalid ids (unknown target/plan/server) and **409** on
`GET /api/v1/targets/<path>/query-stats` for both targets (CAPABILITY_UNAVAILABLE, rendered as a
named state). No 5xx anywhere.

## 4. U4 states (PRE-WAVE-11-REVIEW.md section U4)

| U4 item | Result |
|---|---|
| #1 audit first page with cursor, no items | `/audit` lists events; chain verified through sequence 611/616 with checkpoint detail. Cannot force the no-item-with-cursor case read-only |
| #2 cut binding list says so instead of "No role" | `/access/people`, `/access/roles` show real bindings (Owner, Installation); the cut case is not reproducible with one person |
| #3/#5 migrations paged, views | staging: 50 rows per page default, "567 of 567 migrations match", search, origin, verification and sort filters, seven view links (History, Pending, Timeline, Promotion, Plans, Drift, Legacy import), "Show all (75 characters)" on the ledger hash. Page sizes 25/50/100 only checked in source (`history-model.ts`). Timeline window not opened |
| Connect sheet, five modes | `?connect=direct|app|cli|mcp|api` all open; each text scanned for secret-like strings: none. Placeholders only (`<role>`, `[YOUR-PASSWORD]`, `PGPASSWORD=[YOUR-PASSWORD]`, `$EXPONETDB_API_KEY`, `process.env.EXPONETDB_API_KEY`). Focus is trapped (radio, Copy, Copy, Close, wraps), Escape closes, `?connect` removed from the URL, focus returns to the header Connect button. Defect W-07 in the Application mode |
| Project page, projects grid/table | present, honest states |
| Server/cluster "Remove from ExponetDB" | preflight lists blockers with links bottom-up, says what removal never does; button is `aria-disabled=true` and "Resolve the items above first." (not clicked) |
| Backups (Wave 9 B) | honest: UNKNOWN, "No backup repository is registered", "No backup is verified", "The recovery point could not be measured", "Never drilled" |

## 5. Keyboard and landmarks

- "Skip to content" is the first Tab stop and becomes visible. Landmarks: 1 `main`, 2 `nav`, 1 `header`.
- /targets, 25 Tabs: skip link, mark, search, account, nine rail links, Sidebar toggle, `main`
  (scroll container, as documented), then the page; every stop has a visible ring (box-shadow);
  no trap. After the rail, **stuck tooltips** (W-01).
- migrations, 20 Tabs from `main`: counters (5 links), view links (7), Show-all, search, three
  selects; ring visible on each (screenshot shows the Sort select ringed).
- Ctrl+K menu: focus enters the search field, Tab alternates field and Close (trapped), Escape
  closes, **focus ends on BODY** (W-06). The dialog has no `aria-modal`.

## 6. Defects

Counts: P0 0, P1 0, P2 4, P3 11.

### W-01 P2 Rail tooltips stay open after keyboard focus leaves the rail
- Repro: 1920x945, `/targets`, press Tab 15 times (skip link, mark, search, account, nine rail
  links, Sidebar toggle, main, ...).
- Expected: a tooltip closes when its item loses focus.
- Actual: nine rail tooltips ("Overview G then H" ... "Settings G then S") plus "Sidebar" remain
  open over the page; DOM shows ten `[role=tooltip]` with `data-state=instant-open`; Escape closes one per press.
- Evidence: `/home/david/.claude/projects/-home-david-Development/57931673-29c9-4061-9f45-326970092611/tool-results/mcp-claude-in-chrome-blob-1793133772582-63wa4e.png`
- Suspected cause: `packages/ui/src/sidebar.tsx:732` keeps `tooltipOpen` locally while `:776` passes
  `open={tooltipEnabled && tooltipOpen}`. While the rail is expanded (`tooltipEnabled` false) Radix has
  nothing to close, so `onOpenChange(false)` never fires and `tooltipOpen` stays `true`; when the rail
  collapses again every tooltip whose flag stuck opens at once. Reset `tooltipOpen` when `tooltipEnabled` turns false.

### W-02 P2 Findings Kind filter cannot select advisor or statements
- Repro: `/t/reosa/platform/staging/findings` (or `/findings`), open Kind.
- Expected: kinds the server returns (CLI `finding list --kind drift|health|advisor|statements`).
- Actual: options Any / Drift / Health only; all 215 staging findings are `advisor`, so the only
  filter that would isolate them does not exist. Rows print the kind as a raw prefix `advisor`.
- Evidence: `.../tool-results/mcp-claude-in-chrome-blob-1793133250739-kp74gm.jpg` (fleet findings, Kind/State/Severity row).
- Suspected cause: `apps/web/src/features/findings/search.ts:11` and
  `apps/web/src/features/global-findings/search.ts:13`: `KINDS = ['drift', 'health']`.

### W-03 P2 "Critical findings 520" is 518 expected scratch drift rows, one roll-up, one real finding
- Repro: `/` (card "Critical findings 520, of 14,184 open") and `/findings`; compare with `xdb finding summary`.
- Expected: the headline number a person acts on separates expected drift of a rehearsal copy from real signals; a roll-up
  does not count as another critical.
- Actual: 13,741 of 14,184 (96.9 percent) are drift `object_added` on scratch (518 critical); the advisor
  `drift_open` roll-up ("13741 open drift findings (519 critical)") is itself an open critical; the newest-criticals
  list on `/` is all `notification_push_subscriptions` / `floorplan_runs` policies. The one real critical
  (`object_changed`, "schema public changed: acl") is not on the first screen. Web numbers equal the CLI, so this is
  presentation and aggregation, not a read bug.
- Evidence: CLI `finding summary` (section 2); `.../tool-results/mcp-claude-in-chrome-blob-1793131970852-zkobgg.jpg`.
- Suspected cause: counting in the fleet read (server: `drift_open` advisor counted among findings); UI
  `features/fleet/findings-triage.tsx` lists by recency only. Group by target and code, or hide drift of targets whose
  ledger is absent from the criticals.

### W-05 P2 Node page: h1 is the raw id and overflows at 390
- Repro: 390 wide, `/infrastructure/nodes/nod_01M5XZ84V768SYCHZKRNGJFQP2`.
- Expected: a name or hostname as heading; no horizontal scroll.
- Actual: h1 "Node nod_01M5XZ84V768SYCHZKRNGJFQP2" (24 px, `overflow-wrap: normal`) is 454 px wide in a 327 px box;
  `main` scrollWidth 478 vs clientWidth 375, so the whole page scrolls sideways.
- Evidence: DOM measure (no 390 screenshot possible, limit 1).
- Suspected cause: `apps/web/src/lib/i18n/messages/infrastructure.ts:491` (`'Node {id}'`) used at
  `apps/web/src/features/infrastructure/node-detail.tsx:71`; the heading needs `break-words`/the server's name.

### W-04 P3 Migration counters do not add up
- Repro: `/t/reosa/platform/staging/migrations`: Applied 567, Verified 539, Not verified yet 0, Verification failed 0.
- Expected: 28 rows accounted for. Actual: 28 `superseded` rows are in no counter (CLI: all 567 `passed`, 28 superseded).
- Suspected cause: `apps/web/src/features/migrations/history-model.ts:152-156` counts `superseded`;
  `apps/web/src/features/migrations/migrations-page.tsx:165-206` has no card for it.

### W-06 P3 Command menu does not restore focus
- Repro: focus `main`, Ctrl+K, Escape. Expected focus on `main`; actual `document.activeElement` is BODY. Dialog has no `aria-modal`.
- Evidence: `.../tool-results/mcp-claude-in-chrome-blob-1793133822101-am6adj.jpg` (menu open).
- Suspected cause: no stored previous focus when opened by shortcut (no trigger);
  `packages/ui-patterns/src/command-menu` has no `onCloseAutoFocus`.

### W-07 P3 Connect sheet, Application mode: tab labels run together and reorder
- Repro: `/t/reosa/platform/staging?connect=app`, 1920 wide.
- Expected: spaced tabs in reading order (Node.js, Python, Go, .env). Actual: ".env fileNode.js (pg)Python (psycopg)Go (pgx)"
  with no gap, ".env file" first visually but last in the DOM.
- Evidence: `.../tool-results/mcp-claude-in-chrome-blob-1793133869911-kxsvq5.png`.
- Suspected cause: `apps/web/src/features/connect/target-connect-sheet.tsx` `Templates` (`<Tabs defaultValue="env">` /
  `TabsList`, about line 503): trigger styling lacks padding and the env trigger is rendered outside the mapped list.

### W-08 P3 Wrong plurals (no plural support in the message catalog)
- `1 projects` (`/projects`), `1 clusters on this server are not retired`, `1 nodes of this server are not decommissioned`,
  `1 active endpoints` (server and cluster "Remove from ExponetDB"), `1 clusters`/`1 nodes` on the server page.
- Cause: `apps/web/src/lib/i18n/messages/projects.ts:31`, `.../infrastructure.ts:28,29,52`; `lib/i18n` has no `Intl.PluralRules`.

### W-09 P3 Raw identifiers shown as labels
- Control Plane components `control_store`, `data_reads`, `audit_chain` (`/`, `/settings/installation`):
  `apps/web/src/features/fleet/control-plane.tsx:66-72`.
- Finding kind and code (`advisor`, `multiple_permissive_policies`, `drift_open`): `apps/web/src/features/findings/findings-page.tsx:216-217`.
- Plans and operations "Change" column: `node.decommission`, `access.identity.erase`, `adopt_agent`, `policy_settings`
  while the plan page uses sentences. Permissions on `/access/roles` appear as `TARGETS.READ`.

### W-10 P3 Document titles
- Unknown target (`/t/reosa/platform/nonexist`) and invalid slug (`/t/BAD_slug/x/y`): title "Overview · ExponetDB" over a
  "Page not found" body; unknown plan "Plan review", unknown server "Servers"; the target not-found has no "ExponetDB" mark in the header.
- All five account pages "Your account"; detail pages carry only the section ("Servers", "Clusters", "Nodes", "Operations"); `/p/reosa/platform` is "Projects".
- Cause: `apps/web/src/app/title.ts:28-31` derives the title from the path, never from the not-found state;
  `apps/web/src/routes/_app/account.tsx:6` gives every tab the same key.

### W-11 P3 Bare section paths 404
- `/access` and `/settings` render "Page not found" while `/infrastructure` redirects. The rail items go to `/access/people` and
  `/settings/products`, so this only hurts hand-typed URLs. Cause: no index routes under `routes/_app/access/` and `.../settings/`.

### W-13 P3 Two time formats on one page
- `/audit`: "Chain verified ... (2026-10-27 20:45 UTC)" vs events "27 Oct 2026 21:33:36" (browser-local, no zone label); the
  plans list shows "36 min ago (2026-10-27 20:09 UTC)".

### W-14 P3 Performance: stated cause is not what the server said
- `/t/.../performance` (staging and scratch): headline "The pg_stat_statements extension is not available ... not installed or
  not preloaded" while the response is 409 CAPABILITY_UNAVAILABLE ("The node does not report this capability version, or the
  cluster is external"). The page asserts a cause it did not establish.

### W-15 P3 Audit: the filter form is taller than a screen
- `/audit` at 1920x945: chain panel plus ten filter fields fill the first screen; the first event row is below the fold.

## 7. Info (not defects)

- I-1: The app refuses to be framed (an `iframe` of `/targets` from the same origin rendered the blocked-frame icon): good.
- I-2: Every `Table` scrolls inside its own container at 390 (`/backups`, `/settings/products`, scratch drift at 1440).
- I-3: Not covered: `/approvals#operation=`, `/targets/register` submit paths, `/credentials`, `/step-up`, OAuth consent/device,
  invite/recover/setup, migrations `?view=timeline|promote|import`, project Connect (`&environment=`), the 1,000-row promotion case.
