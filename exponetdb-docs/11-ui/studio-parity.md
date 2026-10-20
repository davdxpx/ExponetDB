# Studio parity

| | |
|---|---|
| Status | Audit **[OBSERVED]** 2026-10-20 (Wave 8 completion); the build state of each gap is kept in §3 and updated in the change that closes it |
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

State values: **planned** (being built in the Wave 8 completion), **built**
(merged, with its test), **open** (not scheduled), **owner** (waits for the
decision named), **Wave 9**, **non-goal**.

### 3.1 Shell and navigation

| Capability | Class | State |
|---|---|---|
| Go-to commands for every target section and schema kind in the command menu | UI gap | planned |
| Switch database (product and project switcher, a "Switch database…" command page, recent targets) | UI gap | planned |
| Breadcrumbs on detail pages | UI gap | planned |
| A crash page instead of the router's unstyled default | UI gap | planned |
| Health chip in the target header; open-findings badge on the Findings tab | UI gap | planned |
| A global findings page | UI gap | planned |
| Shortcut hints in the rail; scroll to top on navigation; remembered section menu width; app version in the account menu | UI gap | planned |
| Section chords with a third sequence leader | UI gap | open (the `g`/`e`-only rule is an accessibility decision) |
| The target in the page title | UI gap | open (titles take nothing from the address today) |
| Docs search, AI, feature previews, feedback, support | non-goal | non-goal |

### 3.2 Database objects and schema

| Capability | Class | State |
|---|---|---|
| List every object of a kind without typing a filter | API gap | planned (`GET /targets/{id}/schema/objects`) |
| Browse a table's rows, read-only (sort, filter, page) | UI gap | planned on the query endpoint ([OD-42](../00-product/open-decisions.md#od-42-how-the-read-only-table-browser-reads-rows)) |
| Deep links to an object, copy name and link | UI gap | planned |
| Key tokens on columns, foreign-key jump | UI gap | planned |
| Open a definition in the SQL editor, "Query this table" (never run) | UI gap | planned |
| Searchable schema selector; ERD find and export | UI gap | planned |
| Function, trigger, enum, extension and publication details (language, security definer, enabled, labels, version, tables) | API gap | open (the canonical snapshot has them; an additive `details` object exposes them) |
| Roles inventory | API gap | owner ([OD-43](../00-product/open-decisions.md#od-43-a-read-of-a-clusters-postgresql-roles-and-its-permission)) |
| Table definition DDL, ERD "copy as SQL" | API gap | owner ([OD-44](../00-product/open-decisions.md#od-44-server-side-ddl-generated-for-display)) |
| Row estimates and table sizes in lists | API gap | Wave 9 (table statistics) |
| Row edits, table and column editors, policy editor, extension enable, realtime, webhooks, replication, impersonation, API docs | non-goal | non-goal |

### 3.3 SQL editor

| Capability | Class | State |
|---|---|---|
| Row limit selector | UI gap | planned |
| SQLSTATE of a failed run, copy error | UI gap | planned |
| Copy results as Markdown, CSV or JSON | UI gap | planned |
| Rename, share or unshare, save a copy of a saved query | UI gap | planned |
| Column completion | UI gap | planned |
| Run the selection or the statement at the cursor | UI gap | planned |
| Templates (read-only queries and change drafts; opened, never run) | UI gap | planned |
| Format SQL | UI gap | planned (a lazily loaded formatter) |
| Folders and favorites | API gap | open |
| Chart of results, column resize, editor preferences | UI gap | open |
| AI, run as another role, multi-statement scripts, warnings from client-side patterns | non-goal | non-goal (classification is server-side) |

### 3.4 Observability and the target overview

| Capability | Class | State |
|---|---|---|
| Connections summary (blocked, top blocker, longest active and idle in transaction) | UI gap | planned |
| Live and Pause, refresh, observed age | UI gap | planned |
| Session filters and sort | UI gap | planned |
| Lock tree with each blocker's session | UI gap | planned |
| Connection capacity (client backends of usable slots) | API gap | planned (`capacity` on target health) |
| Overview refresh, host row, more history ranges | UI gap | planned |
| Connections over time in the history | API gap | owner ([OD-46](../00-product/open-decisions.md#od-46-host-metrics-history-and-a-postgresql-log-tail) (b)) |
| CPU, memory and disk charts; PostgreSQL log tail | API gap | owner ([OD-46](../00-product/open-decisions.md#od-46-host-metrics-history-and-a-postgresql-log-tail)) |
| Cancel and terminate, query performance, table statistics, advisors | — | Wave 9 |
| AI summaries, Logs Explorer, usage, API request charts | non-goal | non-goal |

### 3.5 Access, account and audit

| Capability | Class | State |
|---|---|---|
| Audit time presets and a target picker | UI gap | planned |
| Audit filter by person | API gap | planned (`identity` on `GET /audit-events`) |
| Scope pickers by name for role bindings | UI gap | planned |
| Restrict an API key or machine grant to targets | UI gap | planned |
| Disable, enable and erase a service account; revoke its grants | UI gap | planned |
| People filter, "You", picture, assign a role after inviting | UI gap | planned |
| OAuth client state filter and last use | UI gap, API gap | planned (`lastUsedAt`, `activeGrantCount` on the client) |
| The installation's client registration mode | API gap | built (`oauthClientRegistration` on `GET /installation`) |
| All API keys in one view | UI gap | planned (on the service accounts page) |
| Client names in the audit | API gap | open |
| Invitation expiry on a person | API gap | open |
| Own activity without `audit.read` | — | owner ([OD-45](../00-product/open-decisions.md#od-45-a-persons-own-activity-without-auditread)) |
| Change of the sign-in address | — | owner ([OD-47](../00-product/open-decisions.md#od-47-changing-a-persons-sign-in-address)) |
| Organizations, billing, analytics opt-out, linked identities, client secrets, published app logos | non-goal | non-goal |

### 3.6 Fleet, targets, settings and infrastructure

| Capability | Class | State |
|---|---|---|
| Suspend, resume and decommission a target (plans; decommission with the typed path) | UI gap | planned |
| Projects page: list, create and change by plan | UI gap | planned |
| Register a cluster (with its bootstrap SQL), a database, add and retire endpoints, rotate an agent-managed credential | UI gap | planned |
| Connect panel without secrets | UI gap | planned for registry administrators; others owner ([OD-41](../00-product/open-decisions.md#od-41-connection-details-for-people-without-registrymanage)) |
| Product and project filters, copy path and id, remembered view | UI gap | planned |
| "Needs attention" on the fleet overview | UI gap | planned |
| Cluster, PostgreSQL version and findings in the targets list | API gap | open (fields on the target summary) |
| Target size, PostgreSQL settings read, CA download, `pg_hba` view, topology | API gap | open or owner |
| Region, compute, pause, transfer, custom domains, compliance add-ons, ORM snippets with secrets | non-goal | non-goal |

### 3.7 Migrations, changes and plan review

| Capability | Class | State |
|---|---|---|
| Plan an existing bundle on another environment (promotion from the Web App) | UI gap | planned |
| View a migration's SQL (bundle files per revision, revision diff); plan files for every reader | UI gap | planned |
| Compare two environments' schemas | UI gap | planned (`POST /schema-diffs`, read-only) |
| Plans list filters and paging; withdraw a plan | UI gap | planned |
| The last drift check without running one | API gap | planned (`GET /targets/{id}/drift-checks`) |
| Draft completeness (dependencies from the stream heads, `down.sql`, save without planning) | UI gap | open |
| Recovery plans from an operation (resume, reconcile, verify one migration, rollback plan with a typed confirmation) | UI gap | open |
| Approval history and a plan's decision timeline; an operation's event log | API gap | open |
| Merge by applying a diff, AI review, branches | non-goal | non-goal |
