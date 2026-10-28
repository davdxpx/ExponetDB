### [P2] Rail tooltips stay open after keyboard focus leaves the rail (W-01)
- **Area:** Web App rail (`packages/ui` sidebar), keyboard accessibility
- **Block:** C (Web audit W-01)
- **Reproduction:** 1920x945, `/targets`, press Tab 15 times (skip link, mark, search, account, nine rail links, sidebar toggle, `main`, ...).
- **Expected:** a tooltip closes when its item loses focus.
- **Actual:** nine rail tooltips ("Overview G then H" ... "Settings G then S") plus "Sidebar" remain open over the page; the DOM shows ten `[role=tooltip]` with `data-state=instant-open`; Escape closes one per press.
- **Evidence:** `C/web-audit.md` W-01 (screenshot `mcp-claude-in-chrome-blob-1793133772582-63wa4e.png` in the session tool-results).
- **Root cause:** `packages/ui/src/sidebar.tsx:732` keeps `tooltipOpen` locally while `:776` passes `open={tooltipEnabled && tooltipOpen}`; while the rail is expanded (`tooltipEnabled` false) Radix has nothing to close, `onOpenChange(false)` never fires and the flag stays `true`; collapsing the rail opens every stuck tooltip at once.
- **Proposed fix:** reset `tooltipOpen` when `tooltipEnabled` turns false (or derive open state from focus/hover).
- **Acceptance test:** component test in `packages/ui`: focus each rail item with the rail expanded, then collapse it; no `[role=tooltip]` is open; a real-browser axe/keyboard case in `apps/server/test/web-axe.e2e.test.ts`.

### [P2] The Findings "Kind" filter cannot select advisor or statements findings (W-02)
- **Area:** Web App findings pages
- **Block:** C (Web audit W-02)
- **Reproduction:** `/t/reosa/platform/staging/findings` or `/findings`, open Kind.
- **Expected:** the kinds the server returns (CLI `finding list --kind drift|health|advisor|statements`).
- **Actual:** only Any / Drift / Health; all 215 staging findings are `advisor`, so the filter that would isolate them does not exist; rows print the raw prefix `advisor`.
- **Evidence:** `C/web-audit.md` W-02.
- **Root cause:** `apps/web/src/features/findings/search.ts:11` and `apps/web/src/features/global-findings/search.ts:13`: `KINDS = ['drift', 'health']`.
- **Proposed fix:** take the kind list from the contract enum (`advisor`, `statements`, `drift`, `health`), with readable labels.
- **Acceptance test:** web test: the select offers every kind of the contract enum and the URL search state round-trips `kind=advisor`.

### [P2] The headline "Critical findings 520 of 14,184" is 518 expected scratch drift rows, one roll-up and one real finding (W-03)
- **Area:** Web overview/findings aggregation (depends on the advisor/drift-recording entry and OD-57)
- **Block:** C (Web audit W-03)
- **Reproduction:** `/` (card "Critical findings 520, of 14,184 open") and `/findings`; compare with `exponetdb finding summary` (519 critical, 13,258 warning, 406 info).
- **Expected:** the number a person acts on separates expected drift of a rehearsal copy from real signals; a roll-up does not count as another critical.
- **Actual:** 13,741 of 14,184 (96.9 percent) are drift `object_added` on scratch (518 critical); the advisor `drift_open` roll-up ("13741 open drift findings (519 critical)") is itself an open critical; the newest-criticals list on `/` shows only `notification_push_subscriptions`/`floorplan_runs` policies; the one real critical (`object_changed`, "schema public changed: acl") is not on the first screen. Web numbers equal the CLI: presentation and aggregation only.
- **Evidence:** `C/web-audit.md` W-03; `C/cli-read-sweep.md` section 4.
- **Root cause:** the fleet read counts the `drift_open` advisor among findings; `apps/web/src/features/fleet/findings-triage.tsx` lists by recency only.
- **Proposed fix:** exclude roll-ups from severity counters, group findings by target and code, and show findings of targets whose baseline/ledger is absent separately ("rehearsal drift").
- **Acceptance test:** server read test: a fleet with one real critical and N drift rows on a baseline-less target returns `critical: 1` plus a separate group; web test renders the real critical first.

### [P2] Node page: the h1 is the raw id and the page scrolls sideways at 390 px (W-05)
- **Area:** Web infrastructure pages
- **Block:** C (Web audit W-05)
- **Reproduction:** viewport 390 wide, `/infrastructure/nodes/nod_01M5XZ84V768SYCHZKRNGJFQP2` (measured in a script-driven same-origin popup; no screenshot possible).
- **Expected:** a name or hostname as heading; no horizontal scroll.
- **Actual:** h1 "Node nod_01M5XZ84V768SYCHZKRNGJFQP2" (24 px, `overflow-wrap: normal`) is 454 px wide in a 327 px box; `main` scrollWidth 478 vs clientWidth 375.
- **Evidence:** `C/web-audit.md` W-05.
- **Root cause:** `apps/web/src/lib/i18n/messages/infrastructure.ts:491` (`'Node {id}'`) used at `apps/web/src/features/infrastructure/node-detail.tsx:71`.
- **Proposed fix:** heading uses the server name with `break-words`; the id moves to a copyable field.
- **Acceptance test:** web test at 390 px (jsdom width plus the existing phone tour in `web.e2e.test.ts`): the node detail page has no horizontal overflow; add the page to the phone tour.

### [P3] Web polish batch (W-04, W-06 to W-11, W-13 to W-15)
- **Area:** Web App
- **Block:** C (Web audit)
- **Reproduction:** (W-04) `/t/reosa/platform/staging/migrations`: Applied 567, Verified 539, Not verified 0, Failed 0: 28 `superseded` rows appear in no counter (`apps/web/src/features/migrations/history-model.ts:152-156`, `migrations-page.tsx:165-206`). (W-06) focus `main`, Ctrl+K, Escape: `document.activeElement` is BODY, the dialog has no `aria-modal` (`packages/ui-patterns/src/command-menu` has no `onCloseAutoFocus`). (W-07) `/t/reosa/platform/staging?connect=app`: tab labels run together (".env fileNode.js (pg)Python (psycopg)Go (pgx)") and ".env file" is first visually but last in the DOM (`apps/web/src/features/connect/target-connect-sheet.tsx` `Templates`, about line 503; screenshot `mcp-claude-in-chrome-blob-1793133869911-kxsvq5.png`). (W-08) wrong plurals "1 projects", "1 clusters on this server are not retired", "1 nodes of this server are not decommissioned", "1 active endpoints" (`apps/web/src/lib/i18n/messages/projects.ts:31`, `.../infrastructure.ts:28,29,52`; no `Intl.PluralRules`). (W-09) raw identifiers as labels: `control_store`, `data_reads`, `audit_chain` (`features/fleet/control-plane.tsx:66-72`), finding kind/code (`features/findings/findings-page.tsx:216-217`), plan "Change" column `node.decommission`, `access.identity.erase`, `TARGETS.READ` on `/access/roles`. (W-10) document titles: unknown target and invalid slug "Overview · ExponetDB" over a "Page not found" body, all five account tabs "Your account", detail pages only the section (`apps/web/src/app/title.ts:28-31`, `routes/_app/account.tsx:6`). (W-11) `/access` and `/settings` render "Page not found" while `/infrastructure` redirects (no index routes). (W-13) `/audit` shows "2026-10-27 20:45 UTC" in the chain line and "27 Oct 2026 21:33:36" (browser-local, no zone) in events. (W-14) `/t/.../performance` says "pg_stat_statements is not installed or not preloaded" while the server answered 409 `CAPABILITY_UNAVAILABLE` with a different text (see the query_stats entry). (W-15) `/audit` at 1920x945: chain panel plus ten filter fields fill the first screen, the first event is below the fold.
- **Expected:** counters add up, focus returns, readable labels, correct plurals and titles, redirecting section roots, consistent time format.
- **Actual:** as listed.
- **Evidence:** `C/web-audit.md` section 6.
- **Root cause:** as cited per item.
- **Proposed fix:** one small change per item; add a plural helper over `Intl.PluralRules` to the message catalog and use it for every count message.
- **Acceptance test:** web unit tests per item (counter sum equals total, focus restored after Escape, plural catalog test, `title` test per route including not-found, redirect tests for `/access` and `/settings`).

### [P3] Web audit coverage gaps (not defects)
- **Area:** test evidence
- **Block:** C
- **Reproduction:** the owner's Chrome window was maximized, so `resize_window` had no effect (viewport stayed 1920x945); 1440 and 390 checks used a script-driven same-origin popup (DOM measurements only, no screenshots) and 390 visual layout is unverified; not reached: `/approvals#operation=`, `/targets/register` submit paths, `/credentials`, `/step-up`, OAuth consent/device, invite/recover/setup, migrations timeline/promote/import views, project Connect with `&environment=`, the 1,000-row promotion case; the "audit first page with cursor and no items" and "cut role-binding list" states could not be forced read-only.
- **Expected:** every rail page at 1440 and 390 px with screenshots.
- **Actual:** see Reproduction. The repository's own phone tour (`web.e2e.test.ts` "fits a phone at 390x844", PASS on the pinned toolchain) covers the shell only.
- **Evidence:** `C/web-audit.md` section 0 and 7.
- **Root cause:** tooling limit of this campaign.
- **Proposed fix:** extend the phone tour and axe tests to every rail page and the target sub-pages (see the gate-map G8.5 entry).
- **Acceptance test:** `web-axe.e2e.test.ts` and the phone tour list every route of `lib/navigation`.
