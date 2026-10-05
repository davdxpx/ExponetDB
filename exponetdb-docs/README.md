# ExponetDB documentation

This directory is the architecture and specification baseline of ExponetDB. It
defines what is built, why, where the boundaries are and which invariants must
never be violated. Implementation follows these documents; when code and
documents disagree, that is a bug in one of them and is fixed in the same pull
request.

- Start here: [`00-product/constitution.md`](./00-product/constitution.md)
- Then: [`01-architecture/overview.md`](./01-architecture/overview.md)
- Decisions: [`01-architecture/adr/README.md`](./01-architecture/adr/README.md)
- Open questions: [`00-product/open-decisions.md`](./00-product/open-decisions.md)
- Roadmap: [`14-roadmap/implementation-waves.md`](./14-roadmap/implementation-waves.md)

## What this baseline does not contain

Wave 0 is documentation only. Deliberately **not** built yet, and not to be
started before the owner accepts the Wave 0 gate:

- no packages, apps, workspace tooling or CI configuration;
- no Control Plane server, REST API, MCP server or Web App;
- no authentication, OAuth authorization server or RBAC code;
- no migration engine, CLI, ledger schema or Control Store migrations;
- no node agent, gateway or certificate authority;
- no backup, restore or diagnostics code;
- no infrastructure changes (no servers, DNS, Coolify resources or databases);
- no changes to the REOSA or Supabase repositories;
- no code copied from the Supabase fork.

Schemas, YAML, SQL and TypeScript snippets in these documents are illustrations
of contracts and behavior, not implementations.

## Conventions

### Status markers

Every non-trivial statement in these documents is one of the following. The
marker is written in bold brackets at the start of the paragraph, list item or
table row it applies to, and it applies until the next marker or heading.

| Marker | Meaning | Obligation |
|---|---|---|
| **[OBSERVED]** | Measured in a repository, a system or a primary source at a stated date. | Cites the path (for example `REOSA/packages/db/migrations/`) or URL. Never extrapolated. |
| **[DECIDED]** | Binding decision of this architecture baseline. | Implementations follow it. Changing it needs an ADR or ADR amendment. |
| **[PLANNED]** | Committed direction whose details are refined in the named wave. | The wave that implements it may refine details without an ADR, but not reverse the direction. |
| **[ASSUMPTION]** | Believed true, not verified. | States how and when it will be verified. Nothing safety-relevant may rest on an unverified assumption at implementation time. |
| **[OPEN: OD-n]** | An open decision listed in [`open-decisions.md`](./00-product/open-decisions.md). | The text states the recommendation; implementation of the affected part waits for the decision. |
| **[NON-GOAL]** | Explicitly out of scope. | Building it needs an ADR amending [C-3](./00-product/constitution.md#c-3-the-scope-boundary-is-fixed). |

A whole document in Wave 0 is "Baseline, awaiting owner approval": the owner
reviews and accepts the baseline at the Wave 0 gate. Until then, **[DECIDED]**
means "decided by this baseline, subject to that acceptance".

### Normative language

MUST, MUST NOT, SHOULD, SHOULD NOT, MAY follow RFC 2119. Lower-case "must" in
prose is descriptive.

### Language

**[DECIDED]** Documentation, code, identifiers, API fields, error codes and
commit messages are in English (US spelling). Reasons: the domain vocabulary
(PostgreSQL, OAuth, MCP) is English, the documents are read by AI agents and by
future contributors outside REOSA, and the owner's brief defined the
constitution sentences in English. The language of the Web App's user-facing
strings is [OPEN: OD-1](./00-product/open-decisions.md#od-1-web-app-language).

### References to other repositories

Paths prefixed with `REOSA/` or `supabase/` refer to the read-only reference
repositories as audited on 2026-10-04 (REOSA at commit `f09a302e`, Supabase fork
at commit `cc31e2bd`). They are references for humans and agents reading these
documents. **Code in this repository never references them** (C-2).

### Diagrams

Diagrams are Mermaid or plain-text box drawings inside Markdown, so that they are
diffable and readable by agents.

### Document header

Each document starts with a small table: status, what it applies to, what to
read before it. Each document ends where its content ends; there is no
boilerplate footer.

---

## Reading paths: "I am building X. What must I read?"

Read the constitution once per session. Then read the documents listed for your
task in order. "Must" means the implementation will be reviewed against it.

| Task | Must read | Should read |
|---|---|---|
| **Anything** | [`00-product/constitution.md`](./00-product/constitution.md), [`../CLAUDE.md`](../CLAUDE.md) | [`00-product/glossary.md`](./00-product/glossary.md) |
| Repository scaffolding, packages, CI | [`01-architecture/package-architecture.md`](./01-architecture/package-architecture.md), [`01-architecture/repositories-and-boundaries.md`](./01-architecture/repositories-and-boundaries.md), [`01-architecture/versioning.md`](./01-architecture/versioning.md) | [`12-operations/local-development.md`](./12-operations/local-development.md), [`14-roadmap/test-strategy.md`](./14-roadmap/test-strategy.md) |
| Control Store schema, internal migrator | [`02-control-plane/control-database.md`](./02-control-plane/control-database.md), [`02-control-plane/data-retention.md`](./02-control-plane/data-retention.md) | [`01-architecture/domain-model.md`](./01-architecture/domain-model.md) |
| Operations Engine, plans, jobs, idempotency | [`02-control-plane/operations-engine.md`](./02-control-plane/operations-engine.md), [`02-control-plane/policy-engine.md`](./02-control-plane/policy-engine.md), [`02-control-plane/error-model.md`](./02-control-plane/error-model.md) | [`01-architecture/failure-model.md`](./01-architecture/failure-model.md) |
| Audit | [`02-control-plane/audit.md`](./02-control-plane/audit.md) | [`08-auth-and-security/threat-model.md`](./08-auth-and-security/threat-model.md) |
| Registry: targets, servers, clusters, placements | [`01-architecture/domain-model.md`](./01-architecture/domain-model.md), [`02-control-plane/registry.md`](./02-control-plane/registry.md) | [`03-database-model/credentials-and-roles.md`](./03-database-model/credentials-and-roles.md) |
| PostgreSQL adapter, introspection | [`03-database-model/postgres-adapter.md`](./03-database-model/postgres-adapter.md), [`11-ui/supabase-reference-audit.md`](./11-ui/supabase-reference-audit.md) (pg-meta part) | [`03-database-model/schema-fingerprints.md`](./03-database-model/schema-fingerprints.md) |
| Query execution (`data.read`), EXPLAIN | [`03-database-model/sql-execution-security.md`](./03-database-model/sql-execution-security.md), [`03-database-model/statement-redaction.md`](./03-database-model/statement-redaction.md) | [`08-auth-and-security/ai-agent-safety.md`](./08-auth-and-security/ai-agent-safety.md) |
| Credentials, DB roles, secrets | [`03-database-model/credentials-and-roles.md`](./03-database-model/credentials-and-roles.md), [`08-auth-and-security/secrets.md`](./08-auth-and-security/secrets.md) | [`08-auth-and-security/threat-model.md`](./08-auth-and-security/threat-model.md) |
| Schema fingerprint, drift | [`03-database-model/schema-fingerprints.md`](./03-database-model/schema-fingerprints.md), [`03-database-model/drift-detection.md`](./03-database-model/drift-detection.md) | [`04-migrations/legacy-import.md`](./04-migrations/legacy-import.md) |
| **Migration engine** (any part) | [`04-migrations/README.md`](./04-migrations/README.md), then the part below | [`04-migrations/failure-and-recovery.md`](./04-migrations/failure-and-recovery.md) |
| ... bundle format, checksum, linter, CLI | [`04-migrations/migration-bundles.md`](./04-migrations/migration-bundles.md), [`04-migrations/authoring-and-ci.md`](./04-migrations/authoring-and-ci.md) | [`04-migrations/analysis.md`](./04-migrations/analysis.md) |
| ... dependency graph | [`04-migrations/dependency-graph.md`](./04-migrations/dependency-graph.md) | [`04-migrations/legacy-import.md`](./04-migrations/legacy-import.md) |
| ... planning and apply | [`04-migrations/planning-and-apply.md`](./04-migrations/planning-and-apply.md), [`04-migrations/concurrency.md`](./04-migrations/concurrency.md), [`04-migrations/analysis.md`](./04-migrations/analysis.md) | [`02-control-plane/operations-engine.md`](./02-control-plane/operations-engine.md) |
| ... verification | [`04-migrations/verification.md`](./04-migrations/verification.md), [`04-migrations/ledger.md`](./04-migrations/ledger.md) | [`03-database-model/sql-execution-security.md`](./03-database-model/sql-execution-security.md) |
| ... staging/production policy, break-glass | [`04-migrations/staging-production-policy.md`](./04-migrations/staging-production-policy.md), [`02-control-plane/policy-engine.md`](./02-control-plane/policy-engine.md) | [`08-auth-and-security/authorization.md`](./08-auth-and-security/authorization.md) |
| ... ledger | [`04-migrations/ledger.md`](./04-migrations/ledger.md) | [`02-control-plane/control-database.md`](./02-control-plane/control-database.md) |
| ... legacy import | [`04-migrations/legacy-import.md`](./04-migrations/legacy-import.md), [`13-integrations/reosa-current-state.md`](./13-integrations/reosa-current-state.md) | [`03-database-model/schema-fingerprints.md`](./03-database-model/schema-fingerprints.md) |
| **MCP** | [`05-mcp/architecture.md`](./05-mcp/architecture.md), [`05-mcp/tool-catalog.md`](./05-mcp/tool-catalog.md), [`05-mcp/oauth.md`](./05-mcp/oauth.md), [`08-auth-and-security/ai-agent-safety.md`](./08-auth-and-security/ai-agent-safety.md) | [`08-auth-and-security/authorization.md`](./08-auth-and-security/authorization.md) |
| **REST API, SDK** | [`06-rest-api/architecture.md`](./06-rest-api/architecture.md), [`06-rest-api/resources.md`](./06-rest-api/resources.md), [`02-control-plane/error-model.md`](./02-control-plane/error-model.md) | [`13-integrations/sdk.md`](./13-integrations/sdk.md) |
| **Node agent** | [`07-node-agent/architecture.md`](./07-node-agent/architecture.md), [`07-node-agent/protocol.md`](./07-node-agent/protocol.md), [`07-node-agent/capabilities.md`](./07-node-agent/capabilities.md), [`07-node-agent/security.md`](./07-node-agent/security.md) | [`07-node-agent/enrollment.md`](./07-node-agent/enrollment.md) |
| **Auth, OAuth, RBAC** | [`08-auth-and-security/identity.md`](./08-auth-and-security/identity.md), [`08-auth-and-security/authorization.md`](./08-auth-and-security/authorization.md), [`05-mcp/oauth.md`](./05-mcp/oauth.md) | [`08-auth-and-security/federation.md`](./08-auth-and-security/federation.md) |
| Security review of anything | [`08-auth-and-security/threat-model.md`](./08-auth-and-security/threat-model.md), [`08-auth-and-security/ai-agent-safety.md`](./08-auth-and-security/ai-agent-safety.md) | [`01-architecture/failure-model.md`](./01-architecture/failure-model.md) |
| **Backups and restore** | [`09-backups-and-restore/architecture.md`](./09-backups-and-restore/architecture.md), [`09-backups-and-restore/backup-engines.md`](./09-backups-and-restore/backup-engines.md), [`09-backups-and-restore/restore.md`](./09-backups-and-restore/restore.md) | [`07-node-agent/capabilities.md`](./07-node-agent/capabilities.md) |
| Health, diagnostics, performance | [`10-observability/health.md`](./10-observability/health.md), [`10-observability/performance.md`](./10-observability/performance.md), [`03-database-model/statement-redaction.md`](./03-database-model/statement-redaction.md) | [`11-ui/supabase-reference-audit.md`](./11-ui/supabase-reference-audit.md) |
| ExponetDB's own logs, metrics, tracing | [`10-observability/self-observability.md`](./10-observability/self-observability.md) | [`12-operations/incident-model.md`](./12-operations/incident-model.md) |
| **Web App, design system** | [`11-ui/information-architecture.md`](./11-ui/information-architecture.md), [`11-ui/design-system.md`](./11-ui/design-system.md), [`11-ui/supabase-reference-audit.md`](./11-ui/supabase-reference-audit.md) | [`06-rest-api/resources.md`](./06-rest-api/resources.md) |
| Deployment, bootstrap, upgrades | [`12-operations/deployment.md`](./12-operations/deployment.md), [`12-operations/bootstrap.md`](./12-operations/bootstrap.md), [`12-operations/upgrades.md`](./12-operations/upgrades.md) | [`12-operations/incident-model.md`](./12-operations/incident-model.md) |
| REOSA integration | [`13-integrations/reosa-current-state.md`](./13-integrations/reosa-current-state.md), [`13-integrations/reosa-integration.md`](./13-integrations/reosa-integration.md), [`13-integrations/sdk.md`](./13-integrations/sdk.md) | [`04-migrations/legacy-import.md`](./04-migrations/legacy-import.md) |
| Planning a wave | [`14-roadmap/implementation-waves.md`](./14-roadmap/implementation-waves.md), [`14-roadmap/acceptance-gates.md`](./14-roadmap/acceptance-gates.md), [`14-roadmap/test-strategy.md`](./14-roadmap/test-strategy.md) | [`00-product/open-decisions.md`](./00-product/open-decisions.md) |

## Full index

### 00-product
- [`constitution.md`](./00-product/constitution.md): the articles every change is measured against, source-of-truth map
- [`vision-and-scope.md`](./00-product/vision-and-scope.md): what ExponetDB is, goals, managed scope, non-goals
- [`principles.md`](./00-product/principles.md): engineering principles with the incidents behind them
- [`glossary.md`](./00-product/glossary.md): domain vocabulary
- [`open-decisions.md`](./00-product/open-decisions.md): decisions the owner still has to take

### 01-architecture
- [`overview.md`](./01-architecture/overview.md): system context, containers, main flows
- [`control-plane-and-data-plane.md`](./01-architecture/control-plane-and-data-plane.md): separation, network paths, self-management boundary
- [`domain-model.md`](./01-architecture/domain-model.md): entities, identifiers, relations, invariants
- [`repositories-and-boundaries.md`](./01-architecture/repositories-and-boundaries.md): the three repositories, reuse and license policy
- [`package-architecture.md`](./01-architecture/package-architecture.md): target repository layout and dependency graph
- [`versioning.md`](./01-architecture/versioning.md): versioning of every contract
- [`failure-model.md`](./01-architecture/failure-model.md): failure modes per component
- [`adr/`](./01-architecture/adr/README.md): architecture decision records

### 02-control-plane
- [`registry.md`](./02-control-plane/registry.md): products, projects, environments, targets, placements, resolution
- [`control-database.md`](./02-control-plane/control-database.md): Control Store schema and its own migrations
- [`operations-engine.md`](./02-control-plane/operations-engine.md): plans, operations, jobs, state machine, idempotency, approvals, break-glass
- [`policy-engine.md`](./02-control-plane/policy-engine.md): rules, decisions, hooks
- [`error-model.md`](./02-control-plane/error-model.md): stable error codes for every interface
- [`audit.md`](./02-control-plane/audit.md): audit events, immutability
- [`data-retention.md`](./02-control-plane/data-retention.md): what is kept how long and why

### 03-database-model
- [`postgres-adapter.md`](./03-database-model/postgres-adapter.md): the engine boundary, connections, introspection, parser
- [`credentials-and-roles.md`](./03-database-model/credentials-and-roles.md): PostgreSQL roles per path, credential lifecycle
- [`sql-execution-security.md`](./03-database-model/sql-execution-security.md): read-only queries, EXPLAIN, limits
- [`statement-redaction.md`](./03-database-model/statement-redaction.md): keeping literals out of every surface
- [`schema-fingerprints.md`](./03-database-model/schema-fingerprints.md): canonical structural fingerprint
- [`drift-detection.md`](./03-database-model/drift-detection.md): kinds of drift and how each is detected

### 04-migrations
- [`README.md`](./04-migrations/README.md): the engine in one page
- [`migration-bundles.md`](./04-migrations/migration-bundles.md): bundle layout, manifest schema, checksum semantics
- [`dependency-graph.md`](./04-migrations/dependency-graph.md): DAG rules and validation
- [`analysis.md`](./04-migrations/analysis.md): compatibility, lock and rewrite analysis, linter
- [`planning-and-apply.md`](./04-migrations/planning-and-apply.md): plan content, binding, apply algorithm
- [`concurrency.md`](./04-migrations/concurrency.md): advisory lock and operation lease
- [`verification.md`](./04-migrations/verification.md): structural, runtime and engine verification
- [`ledger.md`](./04-migrations/ledger.md): canonical ledger schema
- [`staging-production-policy.md`](./04-migrations/staging-production-policy.md): evidence chain, break-glass
- [`legacy-import.md`](./04-migrations/legacy-import.md): baseline and import of existing histories
- [`failure-and-recovery.md`](./04-migrations/failure-and-recovery.md): edge cases, non-transactional migrations, `down.sql`
- [`authoring-and-ci.md`](./04-migrations/authoring-and-ci.md): source references, bundle submission, CLI, CI

### 05-mcp
- [`architecture.md`](./05-mcp/architecture.md): transport, sessions, mapping to services
- [`oauth.md`](./05-mcp/oauth.md): authorization per the MCP specification
- [`tool-catalog.md`](./05-mcp/tool-catalog.md): every tool, its scope, schema and annotations

### 06-rest-api
- [`architecture.md`](./06-rest-api/architecture.md): conventions, versioning, pagination, idempotency, errors
- [`resources.md`](./06-rest-api/resources.md): resource catalog of `/api/v1`

### 07-node-agent
- [`architecture.md`](./07-node-agent/architecture.md): processes, privilege separation, packaging
- [`enrollment.md`](./07-node-agent/enrollment.md): enrollment, certificates, rotation
- [`protocol.md`](./07-node-agent/protocol.md): messages, leases, replay protection
- [`capabilities.md`](./07-node-agent/capabilities.md): capability catalog
- [`security.md`](./07-node-agent/security.md): threat-specific controls

### 08-auth-and-security
- [`identity.md`](./08-auth-and-security/identity.md): identities, credentials, sessions, service accounts
- [`authorization.md`](./08-auth-and-security/authorization.md): RBAC, scopes, tiers, effective permission
- [`federation.md`](./08-auth-and-security/federation.md): future `auth.exponet.cloud`
- [`secrets.md`](./08-auth-and-security/secrets.md): envelope encryption, key management, rotation
- [`threat-model.md`](./08-auth-and-security/threat-model.md): trust boundaries, threats, mitigations
- [`ai-agent-safety.md`](./08-auth-and-security/ai-agent-safety.md): safety model for AI clients

### 09-backups-and-restore
- [`architecture.md`](./09-backups-and-restore/architecture.md): layers, catalog, policies
- [`backup-engines.md`](./09-backups-and-restore/backup-engines.md): engine options and V1 recommendation
- [`restore.md`](./09-backups-and-restore/restore.md): restore planning, execution, drills

### 10-observability
- [`health.md`](./10-observability/health.md): health state model for targets, nodes, the Control Plane
- [`performance.md`](./10-observability/performance.md): diagnostics and performance data
- [`self-observability.md`](./10-observability/self-observability.md): ExponetDB's own telemetry

### 11-ui
- [`information-architecture.md`](./11-ui/information-architecture.md): navigation and screens
- [`design-system.md`](./11-ui/design-system.md): packages, tokens, patterns
- [`supabase-reference-audit.md`](./11-ui/supabase-reference-audit.md): what to adopt, adapt, rewrite or ignore from the Supabase reference

### 12-operations
- [`deployment.md`](./12-operations/deployment.md): V1 deployment on `reos-01` and `reos-db-01`
- [`bootstrap.md`](./12-operations/bootstrap.md): from nothing to the first managed target
- [`local-development.md`](./12-operations/local-development.md): developer environment
- [`upgrades.md`](./12-operations/upgrades.md): upgrading ExponetDB, the agent, PostgreSQL
- [`incident-model.md`](./12-operations/incident-model.md): runbooks and incident classes

### 13-integrations
- [`sdk.md`](./13-integrations/sdk.md): `@exponetdb/sdk`
- [`reosa-current-state.md`](./13-integrations/reosa-current-state.md): measured state of the first consumer
- [`reosa-integration.md`](./13-integrations/reosa-integration.md): how REOSA consumes ExponetDB and moves onto it

### 14-roadmap
- [`implementation-waves.md`](./14-roadmap/implementation-waves.md): waves 0 to 11
- [`acceptance-gates.md`](./14-roadmap/acceptance-gates.md): gate catalog
- [`test-strategy.md`](./14-roadmap/test-strategy.md): test layers and matrix
