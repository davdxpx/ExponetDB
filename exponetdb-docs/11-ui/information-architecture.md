# Web App information architecture

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; UI language **[DECIDED]** 2026-10-13: English strings behind typed message keys ([OD-1](../00-product/open-decisions.md#od-1-web-app-language), resolved) |
| Applies to | Wave 8 (Web App), every wave that adds a surface |
| Read before | [`supabase-reference-audit.md`](./supabase-reference-audit.md), [`design-system.md`](./design-system.md), [`../06-rest-api/resources.md`](../06-rest-api/resources.md) |

The Web App is one **interface** over the same application layer as REST and MCP
(C-9). It contains no business logic: everything it shows comes from
`/api/v1`, and everything it changes is a plan applied through the Operations
Engine.

## 1. Design premise

Supabase Studio has one level that matters: organization → project, where a
project is one database. ExponetDB manages a **fleet of logical targets**
(`reosa/platform/production`) with environments, placed on clusters and servers
through node agents. Three things must be visible everywhere:

1. **Which target, which environment, which tier.** Production is always
   visually distinct.
2. **Whether what you see is fresh** (live, cached, stale, unknown; C-28).
3. **What would change and what is pending** (plans, operations, approvals).

## 2. Levels and routes

### 2.1 Global level

| Section | Route | Purpose |
|---|---|---|
| **Overview** | `/` | fleet health grid (targets × state), open critical findings, operations running and awaiting approval, backups at risk, Control Plane health |
| **Databases** | `/targets` | all targets, filterable by product, project, environment, tier, cluster, state; register target |
| **Changes** | `/changes` | plans (awaiting approval, approved, expired), operations (running, failed, needs attention), migration streams per project with environment promotion view (staging ahead of production) |
| **Infrastructure** | `/infrastructure/servers`, `/clusters`, `/nodes`, `/certificates` | servers, PostgreSQL clusters with placements, node agents (version, capabilities, heartbeat, clock skew), certificates (agent, PostgreSQL server, gateway) with expiry |
| **Backups** | `/backups` | per cluster: protection state, RPO measured vs objective, last verified backup, PITR window, drills and their evidence |
| **Access** | `/access/people`, `/roles`, `/service-accounts`, `/oauth-clients`, `/connected-apps`, `/connect` | identities, role bindings, service accounts with their API keys, OAuth/MCP clients, grants per person ("connected applications"), how to connect an MCP client (`/connect`) |
| **Audit** | `/audit` | audit search, chain verification status, export |
| **Settings** | `/settings/products`, `/environments`, `/policies`, `/notifications`, `/installation` | registry structure, environment tiers and evidence chain, policy settings, notification channels, installation info |

**[OBSERVED]** (2026-10-13, Wave 8 Phase 8, `apps/web/src/shell/navigation.ts`,
`apps/web/src/routes/_app/admin/`) OAuth and MCP clients are administered on
**Access → OAuth clients** (`/access/oauth-clients`) and service accounts,
with their API keys, on **Access → Service accounts**
(`/access/service-accounts`); API keys have no page of their own (no
`/access/api-keys`, and it is no sign-in return target). The old paths
`/admin/clients` and `/admin/service-accounts` redirect to the new ones (the
server, the CLI and earlier documents link them). **Access → Connect a
client** (`/connect[?client=<id>]`) explains how to connect an MCP client to
this installation; it belongs to the Access section menu.

**[OBSERVED]** (Wave 8, `apps/web/src/shell/`) The shell's icon rail lists the
eight sections above (Overview, Databases, Changes, Infrastructure, Backups,
Access, Audit, Settings), each with an icon, a tooltip while collapsed and a
`G` sequence (`G` then `H`, `T`, `C`, `I`, `B`, `A`, `U`, `S`). A section with
more than one page shows its pages in a resizable section menu (256 px) beside
the page. Changes has the pages All changes (`/changes`), Plans
(`/changes/plans`, `G` then `P`), Operations (`/changes/operations`, `G` then
`O`) and Approvals (`/approvals`). The rail expands on hover (the default),
stays open or stays collapsed, kept per browser; small screens get it as a
sheet with the section pages listed under each section. An unknown path below
the shell renders "page not found" inside the shell.

**[OBSERVED]** (Wave 8 Phase 14, `apps/web/src/features/{access,audit,settings}/`)
**Access:** People (`/access/people`, identities of kind `human` with their
active role bindings; invite with the one-time link shown once and never
cached; a new invitation link; disable inline with an optional audit reason;
binding, unbinding, enabling and erasure are plans whose review page opens),
Roles (`/access/roles`, the catalog and who holds each role where) and
Connected applications (`/access/connected-apps`, `GET /grants` with client,
person, resource, scopes, tiers, expiry and `lastUsedAt`/`lastUseClass`,
revoke after a confirmation and re-authentication). The OAuth clients page
states both OD-5 rules (`open`, `review`) and that
`EXPONETDB_OAUTH_CLIENT_REGISTRATION` sets the mode; no read reports the
current mode, so the page does not claim one. **Audit** (`/audit`): the
chain indicator over `GET /audit-events/chain` (verified through sequence N
at time T, broken with sequence and reason, "not verified yet" with the
reason, a failed read never shown as intact), the search with its filters as
validated URL parameters, event details with links to plan, operation and
migrations ledger only through the return-path allowlist, and the NDJSON
export for `policy.manage` (re-authentication, a `Blob` download, the next
part through the cursor; the personal-data warning and the offline
procedure of `audit.md` §5.1 as text). **Settings:** products, environments
(tier from the contract with the production chip, evidence chain; changes
are plans), policies (the `data.read` mode per tier first; changes through
`POST /policy-settings/plans` for the installation or one target),
installation and its health (unobserved components listed as not observed),
notifications as the OD-21 named state, and `/settings/break-glass` for
`policy.manage` (grants with reason and review as untrusted text; the
permanent review note after a confirmation and re-authentication; 409 shown
in the dialog). Every settings page shows a banner while grants wait for
their review. Break-glass activation is offered nowhere (OD-21).

**[DECIDED]** (Wave 8 order D6) Every earlier URL stays valid with the
behavior it has today, because the server, the CLI and MCP emit links to them
([order Appendix C](../14-roadmap/orders/wave-8-order.md#appendix-c--what-the-rebuild-must-preserve-parity-oracle)):
`/login`, `/setup#token=`, `/invite#token=`, `/recover#token=`, `/account`,
`/approvals#operation=`, `/step-up#id=`, `/credentials#cluster=`,
`/oauth/consent#request=`, `/oauth/device` and `/oauth/error?reason=`.
**[OBSERVED]** (Wave 8, owner decision S10) The account area is a set of tabs
under `/account`, opened from the avatar menu in the header (the picture or the
initials, the name and e-mail, the theme switch, the links below, sign out):
Profile (`/account`: display name, profile picture), Preferences
(`/account/preferences`: theme, sidebar, shortcuts, kept in this browser),
Security (`/account/security`: passkeys, password, authenticator app, recovery
codes, sessions), Connected applications (`/account/applications`) and Your
activity (`/account/activity`: `GET /audit-events?actor=self`, which needs
`audit.read`; without it the tab says so). A recovery session shows Security on
every path of the area and no tab navigation. The five paths are exact
`returnTo` targets.

**[PLANNED]** `/approvals#operation=op_…` redirects to the plan review page
`/changes/plans/<id>` (§5).

### 2.2 Target level

Route: `/t/<product>/<project>/<environment>/<section>` (target paths are
immutable, so URLs are stable; ids are used for API calls).

| Section | Route suffix | Content |
|---|---|---|
| **Overview** | `` | health in incident order (path, answers, stuck; [`../10-observability/health.md`](../10-observability/health.md)), version, size, placement, migration head vs other environments, recent operations, open findings |
| **Schema** | `/schema/...` | schemas, tables, views, materialized views, functions, triggers, types, sequences, extensions, indexes, policies, privileges, visualizer; fingerprint and drift status |
| **Migrations** | `/migrations` | ledger (applied, verified, by whom, checksum), pending bundles, plans, evidence from the evidence environment, drift findings, legacy import status |
| **SQL** | `/sql` | read-only query workspace and migration drafting (§4) |
| **Performance** | `/performance` | statement statistics, regressions linked to migrations, table and index health, wraparound, I/O, checkpoints |
| **Connections** | `/connections` | sessions grouped by role/application, conditions, cancel/terminate plans, endpoints (direct, pooler) with probe results |
| **Locks** | `/locks` | blocking trees, waiting sessions, lock modes |
| **Backups** | `/backups` | cluster backups relevant to this target, PITR window, restore plans and drills |
| **Configuration** | `/configuration` | target settings (data reads, maintenance windows, lock timeout defaults), PostgreSQL settings (read; changes are cluster plans), roles relevant to this database |
| **Advisors** | `/advisors` | findings with remediation and draft fixes |
| **Activity** | `/activity` | audit and operations filtered to this target |

The section order follows the owner brief's list (overview, schema, migrations,
queries, connections, locks, backups, restore, configuration). Restore lives
inside Backups because a restore always starts from a backup and its
destination is never the current target in place
([`../09-backups-and-restore/restore.md`](../09-backups-and-restore/restore.md)).
Logs are part of Connections and Performance (redacted PostgreSQL log lines via
the node capability), not a separate section, because they are only useful in
context.

### 2.3 Cluster and node level

`/infrastructure/clusters/<id>`: placements (which targets live here), PostgreSQL
version and settings, roles (cluster-wide desired state), extensions available,
WAL and archive status, replication, backups, restart and configuration plans.

`/infrastructure/nodes/<id>`: agent status, capabilities, host metrics,
packages (installed vs available), jobs history, enrollment and certificate.

## 3. Context bar and switching

- Header chain: `Product ▾ / Project ▾ / Environment ▾` on target pages, with
  the environment chip coloured by tier (production uses the reserved
  production color and label everywhere, including dialogs and toasts).
- **Switching environment keeps the page**: from
  `/t/reosa/platform/staging/schema/indexes` to the same page for production
  (pattern from Studio's route sanitization). Keyboard: `E` then the first
  letter of the environment.
- Every target-scoped client state (tabs, filters, SQL tabs, grid state) is
  keyed by target id; switching remounts the target outlet.
- Route metadata declares requirements (`requires: ['target.reachable']`,
  `requires: ['capability:backup.list']`); the shell renders a named state
  (unreachable, suspended, node offline, not supported on this version) instead
  of a broken page.

**[OBSERVED]** (Wave 8, `apps/web/src/features/target/`) Target pages live
under `/_app/t/$product/$project/$environment`. Each parameter must match the
slug grammar exactly, else "page not found" without a request and without
showing the parameter. The header shows `Product / Project / Environment ▾`;
the environment menu lists the other targets of the project with a tier chip
taken from the contract's `tier` (never the slug), and its loading, failed,
stale, partial and empty states are distinct. `E` then `P`, `S` or `D` switch
to the environment named `production`, `staging` or `development` (`P` falls
back to the single `prod`-tier sibling). A production target carries the
reserved production frame around its pages. `ContentWrapper` renders the first
state that holds: the target read loading or failed; a suspended or
decommissioned target for pages that show live target data (pages of stored
data stay readable under a notice); Wave 9 and OD-21 pages "not available
yet"; a permission the person lacks; target unreachable or "cannot tell"; node
offline, absent or "cannot tell". Target, health and environments are read
every 30 seconds; the target outlet is keyed by the target id.

## 4. SQL

**[DECIDED]** The SQL section has two modes and no third.

| Mode | What it does | Path |
|---|---|---|
| **Query** | one read-only statement against the target; results, EXPLAIN, history | `data.read:<tier>` admission on the server ([`../03-database-model/sql-execution-security.md` §2](../03-database-model/sql-execution-security.md#2-data-queries-dataread)) |
| **Draft a change** | write DDL or data-migration SQL in the editor; the server lints and classifies it live; "Create migration" turns it into a bundle draft (`up.sql`, generated `verify.sql` skeleton, manifest); the draft enters the normal plan → apply → verify path | migrations ([`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md)) |

There is **no "run this write now" button**, on any environment. The editor
shows, while typing, how the statement would be classified (read, schema
change, destructive, non-transactional, rewrite) and which path it would take.
A user who pastes `DROP TABLE` into Query mode gets an explanation and a "Draft
as migration" action, not an error alone.

Query mode features: tabs per target, history (per person, per target, with
duration, rows, redacted text), saved queries (personal and shared per
project), cancel (pid + `backend_start`), EXPLAIN (`FORMAT JSON`) with a plan
viewer, result export with caps, untrusted-content handling for deep links
(`?sql=` opens the editor but never runs).

**[DECIDED]** (Wave 8, order §9) The server side of history and saved
queries: the history is the person's own `data.read` audit events on the
target (`GET /targets/{id}/queries/history`, the redacted statement the
audit holds, at most 256 characters; never another person's reads); saved
queries are kept in the Control Store with a scope (one project or one
target) and a visibility (`personal`, `project`): a project query is seen
by whoever may read data in its scope, a personal one only by its owner,
and only the owner changes or deletes it, in the Web App
([`../03-database-model/sql-execution-security.md` §2.6 and §2.7](../03-database-model/sql-execution-security.md#26-query-history-wave-8)).

Production data reads follow the setting of the policy rule `data.read`
for the target (its default `by_tier` is `humans_only` for prod,
[OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production),
[`../02-control-plane/policy-engine.md`](../02-control-plane/policy-engine.md)); there is no separate target field.
Sensitive columns are masked unless the person has `data.read_sensitive`.

**[OBSERVED]** (Wave 8 Phase 11, `apps/web/src/features/sql/`) The SQL
section is built as decided above, in Studio's layout: a side panel (saved
queries, own history), query tabs per target, the lazy CodeMirror editor
(OD-40) and, below it, the result or the classification. The tabs' unsent
text (never a result) is kept in this browser's `localStorage` per target id.
Query mode sends one statement (the selection, if any) to
`POST /targets/{t}/queries` or `/explain` with a `qry_` id the page chooses;
cancel is `POST /targets/{t}/queries/{qry}/cancel` (the Wave 7 contract names
the query by that id, not by pid and `backend_start`). Before sending, the
page asks `POST /sql/classifications` for exactly that text: a text the
server classifies as a write is not sent; the page explains and offers
"Draft as migration" (same text, Draft mode). A classification that failed
or is pending does not block: the data-read endpoint decides, and its
refusal is shown with its code. Draft mode shows the classification live
(per statement its lines, kind, classes as badges and gutter marks; a
statement without a class and a failed classification are said to be not
safe); "Create migration" builds `migration.yaml` from the person's input,
`up.sql` from the editor and a `verify.sql` skeleton whose checks are
`SELECT false AS ok` until replaced, lints it (`POST
/projects/{p}/migrations/lint`) and creates a plan (`POST
/targets/{t}/migrations/plans`) that opens on the plan page. `?sql=` (at most
16,384 characters, read as a plain string) and `?mode=draft` open text in a
new tab with an "opened from a link, not run" note that counts hidden and
direction characters; history entries and saved queries open the same way.
Completion asks the schema search endpoint for one page of names per word
(no columns: the API has no column search). There is no formatter (no SQL
formatter exists in the repository). `Mod+Enter` (run) and `Mod+S` (save)
are registered shortcuts (group "SQL editor") and appear in the shortcut sheet.

## 5. Plans, approvals and confirmations in the UI

| Step | UI pattern |
|---|---|
| Plan created | **Plan review page** (`/changes/plans/<id>`): what will run, analysis (classes, locks, rewrites, blast radius), evidence, policy decision with rule ids, required approvals, expiry countdown; before/after where meaningful (settings, grants, schema diff) |
| Approve | button only for eligible approvers; a plan created by an AI agent acting for a person can be approved by that person (agent proposes, human approves); a plan created by a person needs a different approver unless the self-approval rule of [OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization) applies; re-authentication; approval binds to the plan hash shown on the page |
| Apply | for `high`/`critical` plans: typed confirmation of the **target path** (not a generic word); for `critical` also the effect ("replaces placement of reosa/platform/production"), typed as well (**[DECIDED]** by the Wave 8 order §8) |
| Running | operation page with steps, live state, `applied` and `verified` as separate indicators; cancel where the operation allows it |
| Outcome | success, failure with next actions (re-verify, plan recovery), `needs_attention` with a reconciliation checklist |

MCP approval links (URL elicitation and the link in the tool result) land
on the approvals page `/approvals#operation=op_…` until Wave 8 builds the
plan review page; that page shows the plan review content (server-computed
facts first, the plan's raw text as data) and keeps working as a redirect to
the plan review page afterwards ([ADR-0029](../01-architecture/adr/0029-approval-link-from-mcp.md),
owner decision 5 of the Wave 7 order). **[DECIDED]** 2026-10-12.
**[OBSERVED]** (Wave 7 Phase 7) Built as decided: each card shows the
review the server computed (`ApprovalQueueItem.review`): "What ExponetDB
computed" (target and tier, kind and class, creator and client with the
client's own name marked *name not verified*, policy decision with rules
and requirements, staging evidence, the bound schema fingerprint, newest
backup "not known" until Wave 9, expiry, the full plan hash with a copy
button, and per migration compatibility, every statement with its line,
lock and compatibility, drops, rewrite estimates, rollback, checksum), then
"What the plan runs" (the stored files verbatim, numbered, as text only,
with invisible and direction characters shown by code point and non-ASCII
characters marked). A card for a plan an agent made carries a note that an
agent proposed it and cannot approve. No new design system or navigation
(Wave 8).

**[DECIDED]** (Wave 6, [ADR-0026](../01-architecture/adr/0026-cli-step-up-browser-handoff.md))
The **step-up page** (`/step-up#id=<stu_…>`) confirms a command a person
started in the CLI: it shows the client's registered name, the action, the
plan hash (for a plan) and the expiry, asks for the code the terminal shows
and a fresh passkey or authenticator proof, and offers to cancel. It
survives a sign-in (a safe return target with its id) and shows nothing
for anybody but the person whose CLI asked.

**[DECIDED]** (Wave 6) The **credentials page**
(`/credentials#cluster=<cls_…>&role=<role>`) is the write-only form for
the password of one of ExponetDB's roles on an external cluster
([`credentials-and-roles.md` §5](../03-database-model/credentials-and-roles.md#5-exponetdbs-own-credentials-lifecycle)):
it shows the cluster, the role (selectable) and the state of its latest
submission, takes the password twice, clears both fields when sending,
needs a fresh re-authentication and never shows a password. The CLI opens
it (`exponetdb cluster credential submit <cluster> <role>`) and watches the
credential until the worker verified it. It survives a sign-in (a safe
return target with the cluster and role only).

## 6. States every page must render

Loading (skeleton matching the final layout), **failed read** ("could not read
X: reason; this does not mean there is no X"), empty (only after a successful
read), stale (age shown, refresh), partial (with what is missing and why),
not supported (PostgreSQL version or missing capability), not permitted (which
permission or scope is missing). Render tests assert that a failed read never
shows the empty state.

## 7. REOSA Admin and other consumers

ExponetDB's Web App is the place for database management. Consumers integrate
read-only views through `@exponetdb/sdk` ([`../13-integrations/sdk.md`](../13-integrations/sdk.md)):

- REOSA Admin's `/database` route shows ExponetDB data for REOSA's targets
  (health, migration status, connections summary, backup protection) and links
  into ExponetDB for anything beyond.
- REOSA's `/status/database` remains an **incident view** ("what is happening
  with the production database right now"); it may read ExponetDB health and
  link to ExponetDB, but it does not grow into a management surface
  ([`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md)).
