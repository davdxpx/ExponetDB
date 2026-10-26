# Studio parity

| | |
|---|---|
| Status | Audit and build **[OBSERVED]** 2026-10-20 (Wave 8 completion); the state of each gap is kept in §3 and updated in the change that closes it |
| Reference | Supabase Studio, `davdxpx/supabase` at `8b9af568` (the commit of [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md)), read-only |
| Applies to | the Web App (`apps/web`) and the additive server reads it needs |
| Read with | [`information-architecture.md`](./information-architecture.md), [`design-system.md`](./design-system.md), [`supabase-reference-audit.md`](./supabase-reference-audit.md), [G8 record](../14-roadmap/gates/8.md) |

The Wave 8 order asks for a Web App that makes the fleet as comfortable to
steer as Supabase Studio makes one database, within ExponetDB's own model.
After both Wave 8 pull requests merged, every screen of the information
architecture existed; this document records where Studio still does more,
what of that ExponetDB should do, and what it must not do.

## 1. Method and classes

Seven read-only audits compared Studio's user-visible capabilities with the
Web App, one per area: shell and navigation; database objects and schema;
SQL editor; observability and the target overview; access, account and
audit; fleet, targets, settings and infrastructure; migrations, changes and
plan review. Each capability was classified:

| Class | Meaning |
|---|---|
| Have | ExponetDB has it, often with more truth (source, age, refusals as states) |
| UI gap | missing, buildable on reads and plans that already exist |
| API gap | needs an additive server read (contracts first) |
| Non-goal | conflicts with the constitution or the product boundary: row editing, a "run this write now" path, an AI assistant, third-party telemetry, remote logos, billing, regions, compute sizes, pausing, branches as Supabase has them, edge functions, PostgREST features |
| Wave 9 | backups, restores, query and table statistics, advisors, cancel and terminate as plans: named "not available yet" pages until Wave 9 serves them |
| Owner | needs an owner decision ([OD-41](../00-product/open-decisions.md#od-41-connection-details-for-people-without-registrymanage) to [OD-47](../00-product/open-decisions.md#od-47-changing-a-persons-sign-in-address)) |

## 2. Where ExponetDB already does more

- **Truthful states.** Every list, card and chart renders a failed read as a
  failure, a stale one with its age, a partial one with what is missing.
- **Changes.** A plan is bound to its hash, generation, fingerprint and
  policy; approvals, typed confirmations, and applied and verified as two
  states have no Studio equivalent.
- **Locks and sessions.** A blocking tree with cycles, sessions grouped by
  role and application and attributed to ExponetDB operations, statements
  redacted, the raw text only after re-authentication.
- **SQL.** Live server-side classification, a draft mode that becomes a
  migration bundle, saved queries with revisions and conflict handling.
- **Fleet.** A fleet overview over many targets, environments and tiers;
  infrastructure (servers, clusters, nodes, certificates) and enrollment.
- **Audit.** A hash-chained audit with a verification indicator and an
  export that verifies offline.

## 3. Gaps and their state

State values: **built** (merged in the Wave 8 completion with its tests),
**open** (not scheduled), **owner** (waits for the decision named),
**Wave 9**, **non-goal**.

### 3.1 Shell and navigation

| Capability | Class | State |
|---|---|---|
| Go-to commands for every target section and schema kind in the command menu | UI gap | built |
| Switch database (product and project switcher, a "Switch database…" command page, recent targets) | UI gap | built (hidden below the tablet width; the command menu covers phones) |
| Breadcrumbs on detail pages | UI gap | built (drawn by the shell from the route) |
| A crash page instead of the router's unstyled default | UI gap | built |
| Health chip in the target header; open-findings badge on the Findings tab | UI gap | built |
| A global findings page | UI gap | built (`/findings`, under Overview) |
| Shortcut hints in the rail; scroll to top on navigation; remembered section menu width; app version in the account menu | UI gap | built |
| Section chords with a third sequence leader | UI gap | open (the `g`/`e`-only rule is an accessibility decision) |
| The target in the page title | UI gap | open (titles take nothing from the address today) |
| Docs search, AI, feature previews, feedback, support | non-goal | non-goal |

### 3.2 Database objects and schema

| Capability | Class | State |
|---|---|---|
| List every object of a kind without typing a filter | API gap | built (`GET /targets/{id}/schema/objects`); the diagram still waits for a schema or a filter |
| Browse a table's rows, read-only (sort, filter, page) | UI gap | built on the query endpoint ([OD-42](../00-product/open-decisions.md#od-42-how-the-read-only-table-browser-reads-rows)); no cancel of a running read yet (the statement timeout ends it) |
| Deep links to an object, copy name and link | UI gap | built |
| Key tokens on columns, foreign-key jump | UI gap | built ("referenced by" needs a read: open) |
| Open a definition in the SQL editor, "Query this table" (never run) | UI gap | built |
| Searchable schema selector; ERD find and export | UI gap | built (SVG and Markdown; find shows the table with its neighbors, it does not pan; no PNG) |
| Function, trigger, enum, extension and publication details (language, security definer, enabled, labels, version, tables) | API gap | open (the canonical snapshot has them; an additive `details` object exposes them) |
| Roles inventory | API gap | owner ([OD-43](../00-product/open-decisions.md#od-43-a-read-of-a-clusters-postgresql-roles-and-its-permission)) |
| Table definition DDL, ERD "copy as SQL" | API gap | owner ([OD-44](../00-product/open-decisions.md#od-44-server-side-ddl-generated-for-display)) |
| Row estimates and table sizes in lists | API gap | Wave 9 (table statistics) |
| Row edits, table and column editors, policy editor, extension enable, realtime, webhooks, replication, impersonation, API docs | non-goal | non-goal |

### 3.3 SQL editor

| Capability | Class | State |
|---|---|---|
| Row limit selector | UI gap | built |
| SQLSTATE of a failed run, copy error | UI gap | built |
| Copy results as Markdown, CSV or JSON | UI gap | built (no shortcuts: the registry takes Mod plus a letter only, and those are the browser's) |
| Rename, share or unshare, save a copy of a saved query | UI gap | built |
| Column completion | UI gap | built |
| Run the selection or the statement at the cursor | UI gap | built |
| Templates (read-only queries and change drafts; opened, never run) | UI gap | built |
| Format SQL | UI gap | owner ([OD-48](../00-product/open-decisions.md#od-48-a-sql-formatter-in-the-web-app-given-its-license-closure)) |
| Folders and favorites | API gap | open |
| Chart of results, column resize, editor preferences | UI gap | open |
| AI, run as another role, multi-statement scripts, warnings from client-side patterns | non-goal | non-goal (classification is server-side) |

### 3.4 Observability and the target overview

| Capability | Class | State |
|---|---|---|
| Connections summary (blocked, top blocker, longest active and idle in transaction) | UI gap | built |
| Live and Pause, refresh, observed age | UI gap | built |
| Session filters and sort | UI gap | built |
| Lock tree with each blocker's session | UI gap | built |
| Connection capacity (client backends of usable slots) | API gap | built (`capacity` on target health; the database size is not measured anywhere and is not added) |
| Overview refresh, host row, more history ranges | UI gap | built |
| Connections over time in the history | API gap | owner ([OD-46](../00-product/open-decisions.md#od-46-host-metrics-history-and-a-postgresql-log-tail) (b)) |
| CPU, memory and disk charts; PostgreSQL log tail | API gap | owner ([OD-46](../00-product/open-decisions.md#od-46-host-metrics-history-and-a-postgresql-log-tail)) |
| Cancel and terminate, query performance, table statistics, advisors | — | Wave 9 |
| AI summaries, Logs Explorer, usage, API request charts | non-goal | non-goal |

### 3.5 Access, account and audit

| Capability | Class | State |
|---|---|---|
| Audit time presets and a target picker | UI gap | built |
| Audit filter by person | API gap | built (`identity` on `GET /audit-events`) |
| Scope pickers by name for role bindings | UI gap | built |
| Restrict an API key or machine grant to targets | UI gap | built |
| Disable, enable and erase a service account; revoke its grants | UI gap | built |
| People filter, "You", picture, assign a role after inviting | UI gap | built |
| OAuth client state filter and last use | UI gap, API gap | built (`lastUsedAt`, `activeGrantCount` on the client) |
| The installation's client registration mode | API gap | built (`oauthClientRegistration` on `GET /installation`) |
| All API keys in one view | UI gap | built (on the service accounts page) |
| Client names in the audit | API gap | open |
| Invitation expiry on a person | API gap | open |
| Own activity without `audit.read` | — | owner ([OD-45](../00-product/open-decisions.md#od-45-a-persons-own-activity-without-auditread)) |
| Change of the sign-in address | — | owner ([OD-47](../00-product/open-decisions.md#od-47-changing-a-persons-sign-in-address)) |
| Organizations, billing, analytics opt-out, linked identities, client secrets, published app logos | non-goal | non-goal |

### 3.6 Fleet, targets, settings and infrastructure

| Capability | Class | State |
|---|---|---|
| Suspend, resume and decommission a target (plans; decommission with the typed path) | UI gap | built |
| Projects page: list, create and change by plan | UI gap | built (display name and managed scope; evidence override, execution roles and trusted extensions are shown, not edited: open) |
| Register a cluster (with its bootstrap SQL), a database, add and retire endpoints, rotate an agent-managed credential | UI gap | built |
| Connect panel without secrets | UI gap | built for registry administrators; others owner ([OD-41](../00-product/open-decisions.md#od-41-connection-details-for-people-without-registrymanage)); built on `feat/studio-ux-overhaul` (2026-10-26, not merged; awaits the owner's review): a Connect sheet from the target header and a project's home with direct, application, CLI, MCP and API modes ([ADR-0035](../01-architecture/adr/0035-studio-information-architecture.md), proposed) |
| A project home (Studio's project home in ExponetDB's model) | UI gap | built on `feat/studio-ux-overhaul` (2026-10-26, not merged): `/projects` and `/p/<product>/<project>` (ADR-0035, proposed) |
| Remove a server or a cluster from the registry | API gap, UI gap | built on `feat/studio-ux-overhaul` (2026-10-26, not merged): retirement bottom-up with a dependency read ([`registry.md` §4.4](../02-control-plane/registry.md#44-retiring-a-server-or-a-cluster)) |
| Product and project filters, copy path and id, remembered view | UI gap | built |
| "Needs attention" on the fleet overview | UI gap | built (reads the target list, up to five pages of 200; a server-side "worst first" read would be cheaper: open) |
| Cluster, PostgreSQL version and findings in the targets list | API gap | open (fields on the target summary) |
| Target size, PostgreSQL settings read, CA download, `pg_hba` view, topology | API gap | open or owner |
| Region, compute, pause, transfer, custom domains, compliance add-ons, ORM snippets with secrets | non-goal | non-goal |

### 3.7 Migrations, changes and plan review

| Capability | Class | State |
|---|---|---|
| Plan an existing bundle on another environment (promotion from the Web App) | UI gap | built |
| View a migration's SQL (bundle files per revision, revision diff); plan files for every reader | UI gap | built |
| Compare two environments' schemas | UI gap | built (`POST /schema-diffs`, read-only) |
| Plans list filters and paging; withdraw a plan | UI gap | built (withdraw on an own plan made in the Web App) |
| The last drift check without running one | API gap | built (`GET /targets/{id}/drift-checks`) |
| Draft completeness (dependencies from the stream heads, `down.sql`, save without planning) | UI gap | open |
| Recovery plans from an operation (resume, reconcile, verify one migration, rollback plan with a typed confirmation) | UI gap | open |
| Approval history and a plan's decision timeline; an operation's event log | API gap | open |
| Merge by applying a diff, AI review, branches | non-goal | non-goal |

## 4. Limits found while building

- The node read turns a host value it did not receive into 0 (`packages/nodes/src/views.ts`), and
  disk use is 0 when the agent reports no mounts; the Host row shows what the read says. Carrying
  "not reported" needs a nullable field in a schema MCP also uses (a `toolVersion` raise): open.
- `listSessions` measures `minAgeSeconds` from the query start, not from the time in its state, so
  the "running at least" filter is exact for running queries only.
- The configured health history retention is not in the API (only its 60-day maximum), so the
  custom range cannot refuse days a shorter retention no longer holds.
- The shortcut registry takes Mod plus a letter or Enter only, so "Copy as" and the row browser
  have no shortcuts of their own.
- The entry bundle carries every screen's copy (the message catalog, 62 kB gzip); splitting it by
  area is the next way to shrink the first load (budget in `apps/web/scripts/budgets.ts`).
