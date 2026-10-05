# Supabase reference audit

| | |
|---|---|
| Status | Audit result (Wave 0), 2026-10-04 |
| Source | read-only Supabase fork `davdxpx/supabase` at commit `cc31e2bd` |
| Applies to | Wave 4 (adapter, introspection), Wave 8 (Web App, design system), Wave 9 (diagnostics, advisors) |
| Decision | [ADR-0017](../01-architecture/adr/0017-supabase-reuse-strategy.md) |

The Supabase fork is a **reference**, not a dependency (C-2,
[`../01-architecture/repositories-and-boundaries.md`](../01-architecture/repositories-and-boundaries.md)).
This document records what ExponetDB learns from it, component by component,
and what it deliberately does not take.

## 1. Summary

**[OBSERVED]** across four audit passes (UI system, pg-meta and SQL layer, Studio
shell and editors, database surfaces and observability):

1. **`packages/ui` is the most reusable part** and is almost free of Supabase
   coupling: shadcn/ui-style primitives on Radix, Tailwind v4,
   `class-variance-authority`; no Next.js, telemetry or feature-flag imports.
2. **The OKLCH semantic token model** (a handful of inputs such as hue, chroma,
   surface, contrast and elevation step drive a full semantic palette) is the
   single most valuable design idea. ExponetDB rewrites it natively with its own
   hue and without Supabase's brand scale.
3. **`packages/pg-meta` has the right shape** (each module returns SQL plus a
   Zod schema; the caller executes) **but the wrong depth**: its introspection
   is UI-grade, not fingerprint-grade, and several generators are verifiably
   broken (context-unaware escaping inside `format()` strings and `DO $$` bodies;
   an index query that drops every index not starting at table column 1). It is
   a requirements and edge-case source, not code to copy.
4. **SQL provenance typing** (`SafeSqlFragment`, `UntrustedSqlFragment`,
   promotion only on a user gesture) is the best idea in the SQL layer. ExponetDB
   adopts the concept and adds runtime enforcement and a parser.
5. **Safety checks are client-side regexes** (destructive statements, `UPDATE`
   without `WHERE`, auto-`LIMIT`). With REST and MCP clients, ExponetDB classifies
   on the server with libpg_query ([ADR-0021](../01-architecture/adr/0021-libpg-query-parser.md)).
6. **The Studio shell is project-centric** (one project = one database). ExponetDB
   needs a fleet of logical targets with environments; it adapts the layout
   primitives and per-context state reset, not the IA.
7. **Heavy DB components** (Monaco SQL editor, `react-data-grid` grid, data table)
   live inside `apps/studio` and are deeply coupled. Learn, then rewrite. The grid
   library is a pinned 7.0 beta that Studio's own guidelines ban for new code.
8. **Licensing needs care**: root license Apache-2.0 ("Copyright 2024
   Supabase"), several packages declare MIT in `package.json` without a license
   file, some files derive from third parties without notices, and the bundled
   UI font is commercially licensed with redistribution forbidden (§4).

**The months saved** come from: the token model, the primitive set, the page
layout family and its guidance, the confirmation-dialog family, the filter bar,
the command menu pattern, the catalog edge-case list, the plan-guard testing idea,
the staged privileges algorithm, the policy editor's structure, and the
connection/terminate guard. **None of these is copied as code into a runtime
path without the review in §4.**

## 2. Decision vocabulary

| Verdict | Meaning |
|---|---|
| **adopt** | take the concept and structure nearly unchanged, written natively in ExponetDB's code base (a direct copy only under the exception rule in §4) |
| **adapt** | take the concept, change it materially for ExponetDB's model |
| **rewrite** | solve the same problem natively; use Supabase only as an edge-case list |
| **not use** | Supabase-product-specific or not needed |

For every component the question from the owner brief applies: is the
complexity there because of **PostgreSQL** (take it), or because of **Supabase
Cloud, multi-tenancy, the hosted product or the browser-only architecture**
(leave it)?

## 3. Component cards

Each card: purpose, current structure and key dependencies, generic value,
Supabase-specific assumptions, reuse strategy, edge cases worth keeping, ExponetDB
target, effort (S < 3 days, M 1-2 weeks, L > 2 weeks for one developer), risks.

### UI primitives (`packages/ui`)

| | |
|---|---|
| Purpose | Buttons, inputs, selects, dialogs, sheets, popovers, tooltips, tabs, tables, badges, cards, toasts |
| Structure | shadcn/ui-derived components on the unified `radix-ui` package, Tailwind v4, `cva`; subpath exports; a legacy in-house `Button` plus raw shadcn variants named `*_Shadcn_` |
| Generic value | high; virtually no product coupling |
| Supabase-specific | logo loader, brand green, social/marketing icons, naming legacy (`Button_Shadcn_`) |
| Strategy | **adapt**: start from upstream shadcn/ui (MIT, explicit license) and re-apply the Supabase improvements worth having (`focusableWhenDisabled` buttons with tooltips, async-aware `AlertDialog`), written natively; one name per component |
| Edge cases | disabled buttons that still show a reason; async confirm that keeps the dialog open while pending and blocks dismissal |
| Defects to avoid | navigation menus using `role="menu"`; sortable table headers without `aria-sort`; unused dependencies; a clipboard helper that triggers toasts from inside a utility |
| Target | `packages/ui` |
| Effort / risk | L / keep one Radix version across packages |

### Design tokens and theming

| | |
|---|---|
| Purpose | semantic colors, surfaces, borders, text levels, charts, dark mode |
| Structure | OKLCH source CSS with a few inputs (`--hue`, `--chroma`, `--surface`, `--foreground-lightness`, `--contrast`, `--elevation-step`) → semantic variables → Tailwind v4 `@theme inline` mapping; Studio exposes four inputs as user appearance settings |
| Generic value | very high |
| Supabase-specific | brand scale, legacy alias layer, font stack (Circular) |
| Strategy | **rewrite** the model natively (§2 of [`design-system.md`](./design-system.md)) |
| Defects to avoid | `.dark` class selectors that are inert under `data-theme`; hard-coded hex colors in charts |
| Target | `packages/tokens` |
| Effort / risk | M / contrast at the extremes of the knobs; test with automated contrast checks |

### Composite patterns (`packages/ui-patterns`)

| | |
|---|---|
| Purpose | 54 modules; about 20 generic and valuable: confirmation and text-confirm dialogs, empty/error/loading states, page container/header/section/nav/breadcrumbs, form item layout, key-value and single-value field arrays, multi-selector, filter bar, command menu, chart composition, timestamp info, info tooltip, admonition |
| Supabase-specific | banners, promo toasts, tweet cards, MCP URL builder, SQL-to-REST, compute badge, consent and privacy, imports of `next/link`, `next/navigation`, `next-themes`, `common` |
| Strategy | **adapt** the generic ones behind framework seams (link provider, navigate injection, color-scheme hook, telemetry callbacks); **not use** the rest |
| Defects to avoid | text-confirm dialog whose confirm button is enabled before the text matches; default confirm label "Submit"; error display with a fixed DOM id and a hard-coded support URL; shimmer CSS that must be imported manually despite `sideEffects: false` |
| Target | `packages/ui-patterns` |
| Effort / risk | M per group / hidden Next.js coupling; enforce with a boundary check |

### Icons (`packages/icons`, `packages/build-icons`)

| | |
|---|---|
| Purpose | custom icon factory over Lucide, build tooling |
| Supabase-specific | third-party brand icons (trademarks), Supabase glyphs |
| Strategy | **rewrite**: depend on `lucide-react` (ISC) and add a tiny factory for a few database-specific glyphs (cluster, node, target, migration, plan); no brand icons |
| License note | the factory mirrors Lucide's tooling without carrying Lucide's notice; do not copy |
| Target | `packages/icons` |
| Effort | S |

### Design-system app (`apps/design-system`)

| | |
|---|---|
| Purpose | component docs, live previews, registry, guidance pages |
| Value | mostly the **guidance**: layout widths, form layouts, table pattern selection, modality and dirty-form dismissal, empty states, focus rings, copywriting |
| Strategy | **rewrite in own words** as ExponetDB guidance pages and agent-readable conventions; do not fork the docs-site architecture |
| Target | `apps/design-system` |
| Effort | M |

### Studio shell, layout and navigation

| | |
|---|---|
| Structure | navigation defined in code (generator functions, one menu hook per product, feature gates on items); per-project context provider that keys state by project ref; breadcrumbs; route sanitization when switching projects |
| Supabase-specific | project = database; replicas as a dropdown; entitlements and billing gates; platform-only routes |
| Strategy | **adapt** the patterns (code-defined nav with capability gates, keyed context reset, "switch environment, stay on the same page"); **rewrite** the IA ([`information-architecture.md`](./information-architecture.md)) |
| Target | `apps/web` shell |
| Effort / risk | M / state leaking across targets; key every store by target id |

### Command palette and shortcuts

| | |
|---|---|
| Structure | `cmdk` with hook-registered commands and section ordering; central shortcut ids; `G then X` chords; a reference sheet |
| Strategy | **adapt** (decouple from router and telemetry; commands come from route metadata and capabilities) |
| Target | `packages/ui-patterns/command-menu`, `apps/web` registry |
| Effort | M |

### Table editor (data grid)

| | |
|---|---|
| Structure | `react-data-grid@7.0.0-beta.47`, pg-meta row query builder, URL-state filters, side panels, an operation queue that saves in one transaction |
| Generic, valuable | truncation CTE for large values with on-demand full value; default ordering rules and a no-sort threshold for huge tables; keyset export; count estimation (`reltuples` + `EXPLAIN` estimate + heap-size gate); `EXPLAIN` cost preflight; type → editor mapping; foreign-key type-match validation; sensitive-column masking; protected-schema lock |
| Supabase-specific | PostgREST exposure toggles, `anon`/`authenticated` impersonation, realtime publication, vault/FDW errors |
| Strategy | **rewrite** the grid on TanStack Table + Virtual; **adapt** the SQL algorithms into the adapter (server side); **in V1 the grid is read-only**: row edits are not offered (C-1 scope; writes go through migrations). A later wave may add nonprod row edits with primary-key + old-value guards |
| Edge cases | bytea primary keys; tables without primary key (no edits); generated and identity columns; enum arrays; exact count with timeout fallback |
| Target | `packages/ui-data/data-grid`, `packages/postgres` (row reads) |
| Effort / risk | L / offset pagination on large tables (use keyset when a key exists) |

### SQL editor

| | |
|---|---|
| Structure | Monaco with completion provider, snippets (platform content API or files), session-only results, client-side safety analysis → warning modal → `acceptUntrustedSql` → `executeSql`; no query history; explain parser on TEXT format; no cancel in the editor |
| Generic, valuable | provenance brands at event sites; completion with statement and alias resolution; error-line highlighting with offset correction; auto-limit rules as requirements; pid + `backend_start` cancel guard; "run and enable RLS" remediation pattern |
| Supabase-specific | content API, CLI migration commands, PostgREST impersonation and JWT claims, AI endpoints, templates |
| Strategy | **rewrite**: the editor in ExponetDB is **read-only** for data (`data.read`, single statement, server-side admission, [`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md)); anything that changes schema becomes a **migration draft** ([`information-architecture.md` "SQL"](./information-architecture.md#4-sql)); add query history, cancel and EXPLAIN on `FORMAT JSON` |
| Edge cases | run selection only; comments and multiple statements disable auto-limit; deep links with SQL are untrusted until the user acts |
| Target | `packages/ui-data/sql-editor`, `apps/web/features/sql` |
| Effort / risk | L / sending the whole catalog to the browser for completion on large schemas (serve completion from the API, paginated) |

### PostgreSQL introspection (pg-meta)

| | |
|---|---|
| Structure | pure SQL-string builders (≈14k lines) returning `{ sql, zod }`; escaping primitives (`ident`, `literal`) and a branded `SafeSqlFragment`; DDL generators for UI forms; Studio-specific SQL; lints; a test harness on real PostgreSQL in Docker with one database per test and an **EXPLAIN-based plan-budget guard** over a synthetic 2,000-table catalog |
| Generic, valuable | the builder + schema shape; catalog edge-case knowledge (foreign-key ordinal pairing, `polroles '{0}'` as PUBLIC, domain NOT NULL, enum order, generated vs identity, `acldefault()` for NULL ACLs, PG17 `MAINTAIN` privilege); the plan guard |
| Gaps (fingerprint grade) | loses typmods, domain identity, collations, most ownership, non-relation ACLs, default ACLs, role memberships, sequences, rules, event triggers, statistics objects, TRUNCATE and internal triggers, function strictness/leakproof/parallel/cost; mixes runtime statistics into object rows; uses `information_schema` for triggers (hides TRUNCATE and internal ones) |
| Verified defects (regression tests for ExponetDB) | D1 index list drops expression indexes and indexes not starting at column 1; D2 unquoted reserved word in a policy lookup; D3 password literal inside a single-quoted `format()` string (syntax error); D4 grantee identifier inside a `format()` string evaluates as SQL (injection); D5 identifiers inside `DO $$` bodies break on `$$`; D7 TRUNCATE triggers invisible; D10 config values containing `=` truncated; D11 versions compared as text; D13 regclass from concatenated names |
| Strategy | **rewrite** (clean room) in `packages/postgres`: fingerprint-first catalog model, `pg_catalog` only, `pg_roles` never `pg_authid`, context-aware escaping, parser-based classification, explicit visibility report ([`../03-database-model/schema-fingerprints.md`](../03-database-model/schema-fingerprints.md), [`../03-database-model/postgres-adapter.md`](../03-database-model/postgres-adapter.md)); **adapt** the plan-guard test idea and the hostile-identifier fixtures |
| License | `package.json` says MIT, repository says Apache-2.0; three parts derive from third parties without notices (node-pg-format port, `pg_get_tabledef`, splinter). Clean-room rewrite avoids the question |
| Target | `packages/postgres/{sql,catalog,fingerprint,classify,diagnostics,lints,explain}`, `packages/testkit` |
| Effort / risk | L / catalog differences across PostgreSQL 16-18; test matrix |

### Query tooling and execution path

| | |
|---|---|
| Structure | one HTTP endpoint (`POST /platform/pg-meta/{ref}/query`), body `{query, disable_statement_timeout}`, connection string sent **encrypted from the browser**; inline literals instead of bind parameters; `EXPLAIN` text preflight with a cost threshold of 200,000 |
| Strategy | **rewrite**: the browser never sees connection material; the server resolves target → credentials; extended protocol with bind parameters; per-request `SET LOCAL` timeouts; row and byte caps by portal fetch size; application name `exponetdb/<surface>/<request id>` |
| Keep | the cost-preflight idea with a configurable threshold; transaction-local `set_config(..., true)` for pooler-safe settings; pid + `backend_start` guard |
| Not use | statement timeout disabled for editor queries; passphrase-encrypted connection strings |

### Schema browser and object surfaces

| Surface | Supabase approach | ExponetDB verdict |
|---|---|---|
| Tables, columns, constraints | list + side panels; multi-call DDL for some column changes ("TODO: refactor to single transaction") | **adapt** list and detail views; changes become migration drafts generated from the canonical catalog, one transaction or explicitly non-transactional steps |
| Indexes | list without `indisvalid`, size or usage; create/drop **not** `CONCURRENTLY` | **rewrite**: show validity, size, `idx_scan` with stats window; drafts default to `CREATE/DROP INDEX CONCURRENTLY` (non-transactional bundle); refuse drafts that drop constraint-backed indexes; keep the "consider before dropping" checklist copy |
| Functions | create/edit with a read-only signature and hidden security settings in edit mode; delete by typing the name | **adapt**: show security and `search_path`; drafts flag `SECURITY DEFINER` without `SET search_path` at analysis time (not only as a later lint) |
| Triggers, event triggers | four-state enable mode (`ORIGIN`, `REPLICA`, `ALWAYS`, `DISABLED`); event-trigger templates (auto-enable RLS) | **adopt** display and modes; offer the auto-RLS event trigger as an optional guardrail draft |
| Enumerated types | add value before/after, rename value; "existing values cannot be deleted or sorted" | **adopt**; analysis marks `ADD VALUE` as transaction-sensitive (unusable until commit) |
| Extensions | `default_version_schema` lock; per-extension disable warnings; **always `CASCADE` on create**; no upgrade UI | **adapt**: CASCADE only as an explicit, previewed choice; build the version upgrade flow (pgvector) with verification; extension installation and upgrades are planned node operations (`postgres.extensions.apply`); only extensions a project lists as trusted may appear in migration bundles |
| Schema visualizer | `@xyflow/react` + dagre layout, export to image | **adopt** the approach (libraries are MIT); read-only |

### Roles

| | |
|---|---|
| Supabase approach | list with connections per role; attribute toggles sent as change-only diffs; managed roles shown read-only with a badge; superuser not grantable; delete without owned-object handling; **password embedded as a literal in DDL** |
| ExponetDB verdict | **adapt** the change-only diff and the "managed roles are read-only" grouping. Roles are **cluster-wide** desired state applied by the node capability `postgres.roles.apply` with SCRAM verifiers computed client-side (never a password in SQL text, [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)); deletion plans include `REASSIGN OWNED`/`DROP OWNED` previews; `BYPASSRLS`, `REPLICATION`, `CREATEROLE` need typed confirmation |

### Policies and RLS

| | |
|---|---|
| Supabase approach | policy list per table with RLS state; editor with a locked SQL skeleton around user-editable `USING`/`WITH CHECK`; templates; exposure classification tied to PostgREST; edit-mode locking of attributes PostgreSQL cannot alter (command, permissive/restrictive) |
| ExponetDB verdict | **adapt** the list (with "RLS enabled but no policy → silent empty reads" highlighted), the locked skeleton and the edit-mode locking; output is a migration draft; the exposure model is configurable per consumer, not PostgREST-specific; policy testing in the editor follows [OD-15](../00-product/open-decisions.md#od-15-policy-probes-in-verification) |

### Privileges (table and column grants)

| | |
|---|---|
| Supabase approach | grid per role and column; **staged operations** that cancel out and normalize table vs column precedence; applied as four separate calls (not one transaction); `window.confirm` on unsaved changes |
| ExponetDB verdict | **adapt** the normalizer algorithm natively; emit **one** migration draft (one transaction) with a verification that re-reads privileges; keep the warnings (column revokes break `SELECT *` and `RETURNING *`) |

### Connections, cancel and terminate

| | |
|---|---|
| Supabase approach | activity rows with cancel/terminate; pid + `backend_start` guard; least-destructive alternative offered inside the dialog |
| ExponetDB verdict | **adopt** the guard and the dialog pattern; actions are planned operations ([`../10-observability/performance.md` §5](../10-observability/performance.md#5-actions-from-diagnostics)) |

### Query performance and EXPLAIN

| | |
|---|---|
| Supabase approach | `pg_stat_statements` reports, hit ratios, index advisor (Supabase extension on hypopg), explain visualizer parsing TEXT plans |
| ExponetDB verdict | **adapt** reports with `pg_roles`, version-aware columns and reset handling; **rewrite** EXPLAIN on `FORMAT JSON`; **not use** the index advisor in V1 (extension-bound) |

### Advisors and lints

| | |
|---|---|
| Supabase approach | 28 SQL lints pulled from splinter; result schema `name, level, categories, detail, remediation, metadata, cache_key`; per-entity exceptions; about half are generic PostgreSQL hygiene, the rest Supabase-specific (auth schema exposure, PostgREST roles); hard-coded Supabase schema and role exclusion lists; one lint's comment says 200 MB while its code uses 20 MB |
| ExponetDB verdict | **adapt** the result schema and exceptions (add owner, reason and expiry); **rewrite** the generic subset per rule with `search_path = ''`, numeric version checks and extension-owned object exclusion; add ExponetDB rules (invalid indexes, wraparound, sequence exhaustion, unvalidated constraints, missing `SET search_path` on `SECURITY DEFINER`); consumer-specific packs replace Supabase's hard-coded lists ([`../10-observability/performance.md` §4](../10-observability/performance.md#4-advisors)) |
| License | splinter-derived SQL: verify splinter's license before copying any rule text; default is clean-room rewrite |

### Migrations view

| | |
|---|---|
| Supabase approach | lists `supabase_migrations.schema_migrations`; no checksums; "inserted at" derived from the version string; migration files split on `;` in an integration utility |
| ExponetDB verdict | **rewrite** entirely ([`../04-migrations/README.md`](../04-migrations/README.md)); keep only the idea of showing applied statements per migration |

### Backups, PITR and restore UX

| | |
|---|---|
| Supabase approach | backup list, PITR picker, restore to new project; failed or archived states collapsed into "in progress"; restore confirmations that do not show target identity |
| ExponetDB verdict | **rewrite** with explicit destination identity, typed confirmation, verification and drill evidence ([`../09-backups-and-restore/restore.md`](../09-backups-and-restore/restore.md)) |

### Plan review and drift triage

| | |
|---|---|
| Supabase approach | disk-management "review and submit" dialog with before/after; config drift triage (drifted, matched, unmanaged) |
| ExponetDB verdict | **adopt** the before/after review layout for every plan; **adapt** the triage categories for schema, grants and configuration drift ([`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md)) |

### OAuth consent, MCP secret elicitation, audit viewer

| | |
|---|---|
| Supabase approach | consent screen with grouped scopes and lookalike checks; out-of-band secret entry for MCP; audit log list |
| ExponetDB verdict | **adapt** the consent layout ([`../05-mcp/oauth.md`](../05-mcp/oauth.md)); **adopt** the out-of-band pattern for approvals via URL elicitation; **adapt** the audit viewer with links to plans, operations and ledger rows |

### Not used

Storage, Auth (GoTrue) UI, Edge Functions, Realtime, PostgREST exposure
settings, replication ETL pipelines, database webhooks (`pg_net`), compute and
disk sizing, billing, branching as a Supabase-platform feature, AI assistant
endpoints, marketing components, Supabase-managed role lists.

## 4. License and attribution rules

**[DECIDED]** The verdicts above describe what ExponetDB *learns*; the
default outcome is native ExponetDB code written from that understanding. There
is no central Supabase provenance layer and no repository-wide notices file
kept only because the fork served as a reference.

| Item | Rule |
|---|---|
| Copying a specific file or function from the fork | a deliberate exception, never a default: direct third-party source reuse requires a file-specific license review and whatever attribution the actual source license requires. The review checks the concrete file (its header, the package's declaration and the repository license differ in this fork, §1) and records the result in the change |
| Clean-room areas: PostgreSQL introspection, pg-meta-style SQL builders, SQL safety, DDL generation, security-relevant server logic | no copying at all; native rewrite from catalog semantics and the edge-case list in §5 |
| shadcn/ui primitives | take from upstream shadcn/ui (MIT) rather than from the fork |
| Files that carry third-party headers (for example a Docusaurus code block, MIT) | keep the header or rewrite |
| Files derived from third parties **without** notices (pg-format port, `pg_get_tabledef`, splinter lints, Lucide-derived icon tooling) | **do not copy**; clean-room rewrite |
| Fonts in the fork (Circular, commercially licensed, redistribution forbidden by its own metadata) | **never copy**; ExponetDB uses OFL fonts ([`design-system.md`](./design-system.md)) |
| Supabase name, logo, brand colors | never used (Apache-2.0 §6 grants no trademark rights) |
| Third-party brand icons | not copied; if ever needed, from the owner's press kit under its terms |
| npm dependencies used by both projects | normal dependency license scan in CI |

When a copy is made under the exception rule, the change records the source
path and commit (the audit used `cc31e2bd`) so that reviewers can compare, and
adds exactly the notices the file's license requires. These rules are not
legal advice; unclear license questions go to the owner before merge.

## 5. Edge-case catalog to carry into ExponetDB tests

Collected from the fork; each becomes a fixture or test in `packages/testkit`:

- identifiers containing `'`, `"`, `$$`, `;`, newlines, Unicode, upper case,
  reserved words, 63-byte truncation;
- indexes on expressions, partial indexes, indexes not starting at column 1,
  `INCLUDE` columns, invalid indexes after a failed concurrent build;
- multi-column foreign keys (ordinal pairing), deferrable constraints, `NOT
  VALID` constraints;
- domains over domains, enum arrays, `vector(n)` columns with HNSW/IVFFlat
  operator classes;
- `polroles = '{0}'` (PUBLIC), restrictive policies, policies with
  `WITH CHECK` only;
- TRUNCATE triggers, constraint triggers, internal triggers, replica/always
  trigger modes;
- functions with `NULL` `proargmodes`/`proargnames`, procedures, aggregates,
  `SET` clauses with values containing `=`;
- extensions with a required schema; extension-owned objects excluded from
  fingerprints;
- tables without primary key; bytea primary keys; generated and identity
  columns;
- PG17 `MAINTAIN` privilege; `acldefault()` for `NULL` ACLs;
- catalogs with thousands of tables (plan-guard budget).
