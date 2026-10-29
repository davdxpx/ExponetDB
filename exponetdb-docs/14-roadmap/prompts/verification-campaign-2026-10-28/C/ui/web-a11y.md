# Web App accessibility pass (Block C, tester S7)

Tree `d51da5d0`, the stack's `serve` on `vc-3`, Chromium Headless Shell 141 (Playwright 1.56.1 from the repo's `apps/server/node_modules`, browsers installed under
`/srv/work/s7/pw`), axe-core 4.13.0 from the repo's `node_modules` (default rules, including color contrast). The scripted owner's web session (software passkey) was
sent as a `Cookie` header; the owner's browser was not touched. **Note on method:** the product binds a web session to the User-Agent it was created with; another UA
lands on `/login` (security-positive, but a tester must reuse the UA). The `__Host-` cookies cannot be added through the cookie API (Domain is implied).
Scripts: `scripts/s7-webcookie.ts`, `s7-web-a11y.mjs`, `s7-a11y-render.py`. 19 pages x 3 widths (1440, 768, 390) x 2 schemes (light, dark; the app follows
`prefers-color-scheme`: body `oklch(0.965 ...)` against `oklch(0.18 ...)`) = 114 loads, no load error, no console error, no horizontal overflow. 114 screenshots stay on the server
(`/srv/work/logs-s7/a11y/shots`, not committed).

## Verdict

**PASS with P3 findings.** 0 serious or critical axe violations on any page in either scheme; no color-contrast violation; no horizontal page scroll at 390 px; focus is visible on every
Tab stop walked; the primary action is reachable by keyboard. Not done: a screen-reader pass (no screen reader on the server; NOT RUN) and the Approve button itself (it sits on the review
page behind "Review the plan", which I did not open; NOT RUN).

| Check | Result |
|---|---|
| axe, 114 page loads | 3 rules, all `moderate`: `region` (12 pages), `heading-order` (2), `landmark-unique` (1); everything else clean |
| Overflow at 390 px | 0 px on all 19 pages (and 768, 1440) |
| Console errors | 0 |
| Keyboard, plan page (`Apply`) | 28 visible controls; **`Apply` is Tab stop 25** (skip link, back link, logo, search, account, then the sidebar and the sub-navigation, about 18 links); focus indicator present on all 80 stops walked; no trap |
| Keyboard, production plan page | the same (stop 25) |
| Keyboard, approvals list | `Review the plan` at stop 23 |
| Keyboard, operation awaiting approval | `Cancel operation` and `Review the plan` are links/buttons in the first 17 controls; the Approve button is on the review page: NOT RUN |
| Reduced motion | no keyframe animation on the three pages tested; 32 to 50 elements carry a transition in **both** modes: the one `prefers-reduced-motion` rule of the style sheets does not remove them (short colour/opacity transitions; low risk, P3) |
| Dark scheme | follows `prefers-color-scheme`; axe contrast clean in both |

## Findings (P3)

1. `region`: content outside any landmark on 12 of 19 pages (overview, plans, plan, operation x3, approvals, findings, nodes, node, promotion, people). The offending node is the same generated
   id on every page (`#_r_h_`), probably a visually hidden live region or the toast container rendered next to `<main>`; wrap it in a landmark or give it `role="status"`.
2. `heading-order` on the target overview (`h4` under an `h2`) and twice on the node page.
3. `landmark-unique` on Access / People: every identity row has a `section.binding-form[aria-label="Plan a role ..."]` with the same name, so a screen-reader user hears one landmark name N times;
   put the person's name into the label.
4. The primary action sits behind 24 Tab stops of shell navigation on the plan page. A skip link exists ("Skip to content" is the first Tab stop; I did not follow it), so this is
   a note: it is the plan page where an operator wants `Apply` and `Copy plan hash` quickly; a landmark-level shortcut ("Skip to plan actions") would cut it.

## The table
### Load status and axe violations per page (union over 3 widths x 2 schemes; node counts are the maximum over the 6 combinations)

| Page | final URL | h1 | 1440 L | 1440 D | 768 L | 768 D | 390 L | 390 D | rules (impact, max nodes) | overflow-x at 390 (px) | console errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| overview | `/` | Overview | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| targets | `/targets` | Databases | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |
| target | `/t/lab/platform/staging` | Overview | 1 | 1 | 1 | 1 | 1 | 1 | heading-order (moderate, 1) | 0 | 0 |
| target-migrations | `/t/lab/platform/staging/migrations` | Migrations | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |
| target-drift | `/t/lab/platform/staging/drift` | Drift | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |
| target-findings | `/t/lab/platform/staging/findings` | Findings | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |
| plan | `/changes/plans/pln_…` | Apply 1 migration to lab/pla | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| plans | `/changes/plans` | Plans | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| operation | `/changes/operations/op_…` | Apply 1 migration to lab/pla | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| operation-attention | `/changes/operations/op_…` | Apply 1 migration to lab/pla | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| approvals | `/approvals` | Approvals | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| approval-operation | `/changes/operations/op_…` | Apply migrations to lab/plat | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| findings | `/findings` | Findings | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| backups | `/backups` | Backups | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |
| nodes | `/infrastructure/nodes` | Nodes | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| node | `/infrastructure/nodes/nod_…` | Node nod_01M64KTMAN8SYQ5KC3Q | 3 | 3 | 3 | 3 | 2 | 2 | heading-order (moderate, 2), region (moderate, 1) | 0 | 0 |
| promotion | `/changes/promotion` | Promotion | 1 | 1 | 1 | 1 | 0 | 0 | region (moderate, 1) | 0 | 0 |
| access-people | `/access/people` | People | 2 | 2 | 2 | 2 | 1 | 1 | landmark-unique (moderate, 1), region (moderate, 1) | 0 | 0 |
| audit | `/audit` | Audit | 0 | 0 | 0 | 0 | 0 | 0 | - | 0 | 0 |

### Rules over all pages

| Rule | Impact | What | Pages |
|---|---|---|---|
| region | moderate | All page content should be contained by landmarks | 12 of 19: access-people, approval-operation, approvals, findings, node, nodes, operation, operation-attention, overview, plan, plans, promotion |
| heading-order | moderate | Heading levels should only increase by one | 2 of 19: node, target |
| landmark-unique | moderate | Landmarks should have a unique role or role/label/title (i.e. accessible name) combination | 1 of 19: access-people |

sample selectors: region: `#_r_h_`; heading-order: `.gap-1.flex-col:nth-child(2) > h4`; landmark-unique: `li[data-identity="idn_01M64KME8GDHZ8CDV7Y4TFPCC9"] > section > .binding-form[aria-label="Plan a role`

### Keyboard walk at 1440 light

| Page | visible controls | Tab stops walked | focus indicator missing on | primary action | reached at Tab # | first stops |
|---|---|---|---|---|---|---|
| plan | 28 | 80 | 0 | Apply | 25 | A:Skip to conten, A:Back to the fl, A:ExponetDB, BUTTON:Search or jump, BUTTON:Account, A:Overview |
| plan-prod | 28 | 80 | 0 | Apply | 25 | A:Skip to conten, A:Back to the fl, A:ExponetDB, BUTTON:Search or jump, BUTTON:Account, A:Overview |
| approval | 25 | 80 | 0 | not reached | None | A:Skip to conten, A:Back to the fl, A:ExponetDB, BUTTON:Search or jump, BUTTON:Account, A:Overview |
| approvals-list | 21 | 80 | 0 | Review the plan | 23 | A:Skip to conten, A:Back to the fl, A:ExponetDB, BUTTON:Search or jump, BUTTON:Account, A:Overview |

### Reduced motion

| Preference | Page | animated elements | elements with a transition | longest animation (s) | `prefers-reduced-motion` rules in the style sheets |
|---|---|---|---|---|---|
| no-preference | overview | 0 | 42 | 0 | 1 |
| no-preference | plan | 0 | 50 | 0 | 1 |
| no-preference | operation | 0 | 32 | 0 | 1 |
| reduce | overview | 0 | 42 | 0 | 1 |
| reduce | plan | 0 | 50 | 0 | 1 |
| reduce | operation | 0 | 32 | 0 | 1 |

### Pages with a different final URL than requested (redirects, 404 pages)

