# Glossary

| | |
|---|---|
| Status | Baseline (Wave 0) |
| Rule | Code, API fields, MCP tools and UI use these terms with these meanings. A new domain term is added here in the same pull request that introduces it. |

Terms are grouped by domain. *Italic* words inside a definition are defined
elsewhere in this glossary.

## Product and architecture

**Control Plane.** ExponetDB itself: the services, the *Control Store* and the
interfaces that decide and record what happens to managed databases. Never in
the data path of applications.

**Data Plane.** The managed PostgreSQL clusters and the databases inside them.
Applications talk to the data plane directly.

**Control Store.** ExponetDB's own PostgreSQL database (`exponetdb_control`). Holds
the registry, identities, OAuth state, plans, operations, ledger mirrors,
samples and audit. Bootstrap infrastructure, never a *target* in V1.

**Interface.** A way to reach the application services: Web App, REST API, SDK,
CLI, MCP, node agent protocol. Interfaces contain no business logic.

**Application service.** The layer that all interfaces call. Combines
authentication context, authorization, the *Operations Engine* and the domain
packages.

**Operations Engine.** The component that turns requests for consequential
mutations into *plans*, authorizes them, executes them as *operations*, verifies
and audits them.

**Policy Engine.** Server-side rules that decide whether an authorized actor may
perform an operation under the current conditions (evidence, backups, tier,
windows). Produces a *policy decision*.

**Node Agent** (`exponetdb-node`). The daemon on a database host that executes
*capabilities* on behalf of the Control Plane. Connects outbound over mTLS.

**Agent Gateway.** The Control Plane process role that terminates node agent
mTLS connections and relays jobs. Holds no target credentials.

## Inventory

**Product.** A namespace that owns projects, for example `reosa`. RBAC can be
scoped to it.

**Project.** A line of databases that share one schema history, for example
`reosa/platform` or `reosa/status`. A project owns one *migration stream* and an
*evidence chain* across its environments.

**Environment.** A named stage of a project (`staging`, `production`, `preview`).
Each environment has a *tier*.

**Tier.** `prod` or `nonprod`. The authorization boundary between production and
everything else. A server, node or cluster takes the highest tier of anything it
hosts.

**Target** (logical target). The addressable unit of management:
`<product>/<project>/<environment>`, for example `reosa/platform/production`.
Has a stable id (`tgt_...`) and a *placement*. Clients only ever address targets.

**Target generation.** A counter on a target that increases when its placement
changes or its database is replaced (restore, recreate). Plans bind to it.

**Target identity marker.** A row in `exponetdb.target_identity` inside the
database, naming the target id, environment and generation. Verified before any
write (C-27).

**Placement.** The current binding of a target to a *cluster* and a database name
on it. Placements have history.

**Server.** A machine (virtual or physical), for example `reos-db-01`. Display
names are labels, not identities.

**Node.** An enrolled agent identity on a server. A server can be re-enrolled,
which creates a new node.

**Cluster.** One PostgreSQL instance (one data directory, one port, one
`system_identifier`), for example `postgres-main` on `reos-db-01`. *Agent-managed*
when a node runs on its server, *external* when ExponetDB only has network
access to it.

**Database.** A PostgreSQL database inside a cluster, for example
`reosa_production`.

**Endpoint.** A network path to a cluster: host, port, TLS mode, CA, network
(private, public). A cluster can have several.

**Credential.** Secret material for a PostgreSQL role, stored encrypted, never
returned to any client.

**Access tier role.** One of the PostgreSQL roles ExponetDB uses on a target:
observer, reader, operator, migrator. See
[`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md).

**Execution role.** The PostgreSQL role a project's migrations run as (usually
the schema owner role, for example `reosa_owner`), assumed by the migrator role
with `SET ROLE`.

## Change model

**Consequential mutation.** Any action that changes structure, data,
configuration, roles, privileges, availability, backups, restores, TLS
material, packages or access-control state.

**Plan.** An immutable, short-lived, single-use record of exactly what an
operation will do, with its bindings, analysis, evidence and policy decision.
Id prefix `pln_`.

**Inline plan.** A low-risk mutation whose request carries precondition tokens
that bind it to observed state, executed in one call.

**Binding.** A fact a plan depends on (actor, client, target generation,
checksum, schema fingerprint, ledger state, evidence, policy version, expiry).

**Stale plan.** A plan with at least one binding that no longer holds. Applying
it fails with `PLAN_STALE`.

**Operation.** The execution record of a plan (or of an inline plan). Id prefix
`op_`. Has a state machine.

**Job.** A unit of work dispatched to a node agent as part of an operation. Id
prefix `job_`.

**Approval.** A recorded decision by a human with the required permission that a
specific plan may be applied. Required by policy for some plans.

**Break-glass grant.** A time-boxed, reason-bound, audited elevation that lets a
specific human override a specific policy rule for a specific target.

**Idempotency key.** A client-chosen key that makes a mutation request safe to
retry.

## Migrations

**Migration bundle.** A directory `<id>_<name>/` with `migration.yaml`, `up.sql`,
`verify.sql` and optional `down.sql`.

**Migration id.** A ULID (26 characters, Crockford base32). The identity of a
migration. The name is a label.

**Manifest.** `migration.yaml`, schema `exponetdb.migration/v1`.

**Migration stream.** All migrations of one project, forming one *dependency
graph*.

**Dependency graph (DAG).** Directed acyclic graph of `dependsOn` edges between
migrations of one stream, plus *baseline* nodes.

**Head.** A migration in a stream with no dependants.

**Baseline.** A synthetic graph node that stands for "the database state at
import time". Imported legacy migrations hang below it, new migrations depend on
it.

**Migration checksum** (apply checksum). SHA-256 over the canonical form of
`up.sql` and the execution-relevant manifest fields. Binds the migration id.

**Verify digest / rollback digest.** SHA-256 of `verify.sql` / `down.sql`. Tracked
separately so that a verification script can be corrected without changing the
migration's identity.

**Ledger.** The table `exponetdb.schema_migrations` inside a target database:
the canonical record of applied migrations.

**Ledger mirror.** The Control Store copy of each target's ledger.

**Ledger state hash.** A hash (`sha256:ls1:…`) over the (id, checksum,
applied or reverted) entries of a ledger and its baseline
([`../04-migrations/ledger.md` §3](../04-migrations/ledger.md#3-derived-values)).
Plans bind to it.

**Apply status** (`applyOutcome`). Whether `up.sql` was committed:
`not_started`, `applied`, `not_applied`, `partially_applied`, `unknown`.

**Verification status** (`verificationOutcome`). Whether the outcome was
confirmed: `not_applicable`, `pending`, `passed`, `failed`, `partial`, `error`.

**Evidence.** Facts from another environment that a production plan requires,
mainly "the same id with the same checksum was applied and verified on the
evidence environment".

**Evidence environment.** The environment of the same project whose results count
as evidence for a production-tier environment, configured per project.

**Schema fingerprint.** A deterministic hash of the normalized structural catalog
state of a database's managed scope. Format `fp1:<pg major>:<sha256>`.

**Managed scope.** The set of schemas and object kinds a project's fingerprint
covers. Excludes system and provider-managed schemas and `exponetdb` itself.

**Drift.** Any difference between what the ledger says and what the database is,
between ledger and mirror, between environments that should match, or between
source and ledger.

**Legacy migration.** A migration applied before ExponetDB, imported into the
ledger with origin `legacy_import`.

**Compatibility class.** Analysis result: `additive`, `potentially_breaking`,
`data_rewrite`, `destructive`, `unknown`.

**Lock severity.** Analysis result: `none`, `low`, `medium`, `high`, `critical`,
`unknown`.

## Identity and access

**Identity.** A person or a service account known to ExponetDB. Id prefix `idn_`.

**Identity provider (IdP).** Who authenticates an identity: ExponetDB itself
(local) or an external OIDC provider (future `auth.exponet.cloud`).

**External subject.** The pair (issuer, `sub`) that links an external login to an
ExponetDB identity.

**Role (access role).** A named set of permissions, bound to an identity at a
scope (global, product, project, environment, target).

**Permission.** A verb on a resource type, for example `migrations.apply`.

**Scope (OAuth scope).** What a token may be used for, for example
`migrations.apply:prod`. Effective rights are the intersection of the identity's
permissions, the token's scopes, the grant's target restrictions and policy.

**OAuth client.** A registered application that obtains tokens (MCP client, CLI,
CI). Id prefix `cli_`.

**Client kind.** Two related sets. The client kinds of the authorization
model are `web` (a Web App session), `cli` (the first-party CLI with a
person's session), `mcp` (an MCP client acting for a person) and `ci` (a
service account's client or API key); they decide which scopes and actions
a caller may use (`CLIENT_KINDS` in `packages/contracts/src/scopes.ts`). The
client kind recorded in audit events, plans and operations admits six
values, `web`, `rest`, `mcp`, `cli`, `ci`, `system`: a caller is recorded
with its authorization client kind, `system` is the Control Plane's own
processes, and `rest` is admitted by the Wave 2 shape but recorded by no
code path ([`../02-control-plane/audit.md` §1](../02-control-plane/audit.md#1-event-shape)).

**Grant.** A consent record: identity X allowed client Y scopes Z, optionally
restricted to targets. Tokens belong to grants. Revoking a grant revokes its
tokens. A delegated grant comes from a person's consent; a machine grant is
the authority an admin gives a service account's client (Wave 3B).

**CIMD (Client ID Metadata Document).** A client whose `client_id` is an
`https` URL of a JSON document describing it. ExponetDB fetches it with the
hardened fetcher; an admin approves the exact URL bound to the document's
security fingerprint (OD-5).

**DCR (dynamic client registration, RFC 7591).** `POST /oauth/register`:
creates a pending public client without a secret that is usable only after an
admin approves it (OD-5).

**Connected applications.** The Web App's list of a person's active grants,
each revocable at once.

**Service account.** An identity of kind `service`, used by CI or consumer
backends, authenticated by client credentials or an API key.

**API key.** A long-lived secret for a service account (`exak_…`), shown once,
stored hashed, with scopes, tier and target restrictions and a mandatory
expiry (at most 365 days); REST only.

**Re-authentication (step-up).** A fresh proof of presence (passkey or TOTP)
required for high-risk actions and break-glass.

## Web App and design system

**Named state.** A page state such as "not available yet", "not permitted",
"target unreachable" or "node offline" that the Web App renders, with its
cause, instead of a broken or empty page. Wave 9 features and blocked
decisions get pages in a named "not available yet" state, never mock data.

**Parity oracle.** The existing browser suites, unit tests and smoke checks
(`web.e2e`, `web-review.e2e`, `mcp-approval.e2e`, `quickstart.lab`, the
`http-auth*` and `http` tests, the ports of the `safe` and `review` tests,
`tooling/smoke/roles.sh`) that the rebuilt Web App must keep green, with zero
CSP console violations, before the old Web App code is deleted (Wave 8).

**Provenance header.** The first line of a file copied from Supabase source:
`Derived from supabase/supabase <source path> @ 8b9af568. Apache-2.0
(Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.` It
is the license notice and the change notice of
[ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md); the
file is ExponetDB code afterwards.

**Readable.** The truthful-state union `loading | failed | stale | partial |
ready` that every UI data component takes instead of a bare list, so a failed
read cannot render as empty. The SDK's `{ ok: true, value } | { ok: false,
error }` results apply the same rule at the transport level
([`../13-integrations/sdk.md`](../13-integrations/sdk.md)).

**Third-party register.** The license-compliance register of files copied into
the Web App UI packages: one row per file with its source path, commit,
license basis, notices, changes and review status
([`../11-ui/third-party-register.md`](../11-ui/third-party-register.md),
ADR-0030). It is checked by `tooling/checks/third-party.ts`; it is not a
runtime provenance layer.

**Typed confirmation.** A confirmation in which the person types the exact
target path (or object name) before a high-risk action; the confirm button
stays disabled until the text matches exactly and dismissal is blocked while
the action is pending ([`../11-ui/design-system.md` §3](../11-ui/design-system.md#3-database-specific-patterns)).
For `high` and `critical` plans the typed text is the target path; for
`critical` also the effect.

## Status markers used in documentation

See [`../README.md`](../README.md#status-markers).
