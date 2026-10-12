# Web App information architecture

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; UI language is [OPEN: OD-1](../00-product/open-decisions.md#od-1-web-app-language) |
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
| **Access** | `/access/people`, `/roles`, `/service-accounts`, `/api-keys`, `/oauth-clients`, `/connected-apps` | identities, role bindings, service accounts, API keys, OAuth/MCP clients, grants per person ("connected applications") |
| **Audit** | `/audit` | audit search, chain verification status, export |
| **Settings** | `/settings/products`, `/environments`, `/policies`, `/notifications`, `/installation` | registry structure, environment tiers and evidence chain, policy settings, notification channels, installation info |

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

Production data reads follow the target's `dataRead` setting
(`humans_only` by default for prod,
[OD-13](../00-product/open-decisions.md#od-13-data-reads-by-ai-agents-on-production)).
Sensitive columns are masked unless the person has `data.read_sensitive`.

## 5. Plans, approvals and confirmations in the UI

| Step | UI pattern |
|---|---|
| Plan created | **Plan review page** (`/changes/plans/<id>`): what will run, analysis (classes, locks, rewrites, blast radius), evidence, policy decision with rule ids, required approvals, expiry countdown; before/after where meaningful (settings, grants, schema diff) |
| Approve | button only for eligible approvers; a plan created by an AI agent acting for a person can be approved by that person (agent proposes, human approves); a plan created by a person needs a different approver unless the self-approval rule of [OD-9](../00-product/open-decisions.md#od-9-approval-model-for-a-one-person-organization) applies; re-authentication; approval binds to the plan hash shown on the page |
| Apply | for `high`/`critical` plans: typed confirmation of the **target path** (not a generic word); for `critical` also the effect ("replaces placement of reosa/platform/production") |
| Running | operation page with steps, live state, `applied` and `verified` as separate indicators; cancel where the operation allows it |
| Outcome | success, failure with next actions (re-verify, plan recovery), `needs_attention` with a reconciliation checklist |

MCP approval links (URL elicitation and the link in the tool result) land
on the approvals page `/approvals#operation=op_…` until Wave 8 builds the
plan review page; that page shows the plan review content (server-computed
facts first, the plan's raw text as data) and keeps working as a redirect to
the plan review page afterwards ([ADR-0029](../01-architecture/adr/0029-approval-link-from-mcp.md),
owner decision 5 of the Wave 7 order). **[DECIDED]** 2026-10-12.

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
