# REST resources (`/api/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; shapes are refined in the wave that implements each group |
| Read before | [`architecture.md`](./architecture.md) |

Permissions refer to RBAC permissions; scopes to OAuth scopes
([`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md)).
"Plan" in the last column means the endpoint creates a plan rather than changing
state directly.

## Registry

| Method & path | Purpose | Permission / scope | Notes |
|---|---|---|---|
| `GET /products`, `GET /products/{id}` | products | `targets.read` | |
| `GET /products/{id}/environments` | environments with tier and evidence chain | `targets.read` | |
| `POST /products/{id}/environments`, `PATCH …/{env}` | define/change environments | `registry.manage` | plan (tier and evidence changes are consequential) |
| `GET /projects`, `GET /projects/{id}` | projects | `targets.read` | |
| `POST /projects`, `PATCH /projects/{id}` | create/configure project (managed scope, execution role aliases, evidence override) | `registry.manage` | plan |
| `GET /targets` | list targets (filters: product, project, environment, tier, state) | `targets.read` | grant target restrictions applied |
| `GET /targets/{id}` | target detail | `targets.read` | `{id}` = `tgt_…` or URL-encoded path |
| `POST /targets` | register target (project, environment, database) | `registry.manage` | plan (stamps identity, initializes ledger) |
| `POST /targets/{id}/suspend`, `…/resume` | stop / allow writes | `registry.manage` | plan |
| `POST /targets/{id}/decommission` | retire target | `registry.manage` | plan (`critical`) |
| `GET /servers`, `POST /servers`, `GET /servers/{id}` | servers | read: `nodes.read`; write: `registry.manage` | |
| `GET /clusters`, `GET /clusters/{id}` | clusters (observed facts, tier) | `nodes.read` | |
| `POST /clusters/{id}/confirm` | confirm a cluster reported by an agent (pins `system_identifier`) | `registry.manage` | plan |
| `POST /clusters` | register external cluster | `registry.manage` | plan |
| `GET /clusters/{id}/endpoints`, `POST …` | endpoints | `registry.manage` | addresses visible only to `registry.manage` |
| `GET /clusters/{id}/databases`, `POST …` | databases (create via node capability) | `registry.manage` | plan |
| `POST /clusters/{id}/credentials/{role}` | write-only credential submission (external clusters) | `registry.manage` | never readable |
| `POST /clusters/{id}/role-verifiers` | write-only SCRAM verifier submission for consumer login roles | `registry.manage` | |

## Schema and drift

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/schema` | overview: schemas, object counts, fingerprint | `schema.read` |
| `GET /targets/{id}/schema/objects/{kind}/{qualifiedName}` | object detail | `schema.read` |
| `GET /targets/{id}/schema/search?q=` | search objects | `schema.read` |
| `GET /targets/{id}/schema/fingerprint` | current fingerprint + document reference | `schema.read` |
| `POST /schema-diffs` | diff two targets or fingerprints | `schema.read` |
| `POST /targets/{id}/drift-checks` | run drift check | `schema.read` |
| `GET /targets/{id}/findings` | findings (drift, advisors, health) | `diagnostics.read` |
| `POST /findings/{id}/accept` | `drift.accept` | `schema.manage` (admin) — plan |

## Queries

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /targets/{id}/queries` | run a read-only query | `data.read:<tier>` |
| `POST /targets/{id}/explain` | EXPLAIN / EXPLAIN ANALYZE (read-only) | `data.read:<tier>` |
| `DELETE /queries/{queryId}` | cancel own query | same as the query |

## Migrations

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /projects/{id}/migrations/lint` | lint bundles | `migrations.read` |
| `POST /projects/{id}/bundles` | ingest bundles without planning | `migrations.plan` |
| `GET /projects/{id}/bundles/{migrationId}` | bundle metadata, revisions | `migrations.read` |
| `GET /projects/{id}/migrations` | stream: DAG, heads, per-target state matrix ("promotion board") | `migrations.read` |
| `GET /targets/{id}/migrations` | ledger (mirror + live check), pending, verification states | `migrations.read` |
| `GET /targets/{id}/migrations/{migrationId}` | ledger row, verifications, evidence | `migrations.read` |
| `POST /targets/{id}/migrations/plans` | plan apply of bundles / ids | `migrations.plan` |
| `POST /targets/{id}/migrations/{migrationId}/verifications` | re-run verification | `migrations.apply:<tier>` |
| `POST /targets/{id}/migrations/{migrationId}/rollback-plans` | plan rollback | `migrations.plan` |
| `POST /targets/{id}/migrations/import-analyses` | legacy import analysis (report) | `migrations.import` |
| `GET /import-reports/{id}`, `PATCH …/items/{itemId}` | review and resolve import items | `migrations.import` |
| `POST /targets/{id}/migrations/baseline-plans` | plan baseline | `migrations.import` |
| `POST /targets/{id}/ledger/reconcile-plans` | plan ledger reconciliation | `migrations.import` |

## Plans, approvals, operations

| Method & path | Purpose | Permission / scope |
|---|---|---|
| `GET /plans/{id}` | plan | creator's scope or `plans.approve` |
| `POST /plans/{id}/apply` | apply (idempotent) | kind/tier scope |
| `POST /plans/{id}/withdraw` | withdraw | plan actor |
| `GET /approvals?state=pending` | approval queue | `plans.approve` (human) |
| `POST /approvals/{id}/approve`, `…/reject` | decide (requires recent re-auth; body includes `planHash` and, when required, the compatibility attestation) | `plans.approve` (Web App session only) |
| `GET /operations`, `GET /operations/{id}` | operations | read scope of the kind |
| `GET /operations/{id}/events` | step events (stream via SSE optional) | same |
| `POST /operations/{id}/cancel` | cancel if possible | actor or admin |
| `POST /break-glass-grants` | activate break-glass (human, re-auth, reason, rules, targets, duration) | `breakglass.activate` (Web App/CLI session only) |
| `POST /break-glass-grants/{id}/review` | post-incident review | admin |

## Sessions, locks, performance

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/sessions` | sessions (redacted statements) | `diagnostics.read` |
| `GET /targets/{id}/locks` | lock graph | `diagnostics.read` |
| `POST /targets/{id}/sessions/{pid}/cancel` | cancel (body: `backendStart`) | `connections.operate:<tier>` |
| `POST /targets/{id}/sessions/{pid}/terminate` | terminate (body: `backendStart`, `reason`) | `connections.operate:<tier>` |
| `GET /targets/{id}/health` | health with sub-states | `diagnostics.read` |
| `GET /targets/{id}/health/history?window=` | samples / rollups | `diagnostics.read` |
| `GET /targets/{id}/query-stats` | statement statistics | `diagnostics.read` |
| `GET /targets/{id}/table-stats` | tables, indexes, vacuum, bloat | `diagnostics.read` |
| `POST /targets/{id}/advisor-runs` | live advisors | `diagnostics.read` |
| `GET /statements/{digest}/raw` | raw statement (human, re-auth) | `diagnostics.read_sensitive` |

## Backups and restore

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /clusters/{id}/backup-repositories`, `POST …` | repositories (engine, location, encryption key reference) | read `backups.read`; write `registry.manage` (plan) |
| `GET /clusters/{id}/backup-policies`, `PUT …` | schedules, retention | read `backups.read`; write `registry.manage` (plan) |
| `GET /clusters/{id}/backups` | backups, WAL window, RPO status | `backups.read` |
| `POST /clusters/{id}/backups` | run a backup | `backups.run` |
| `POST /backups/{id}/verifications` | verify a backup | `backups.run` |
| `POST /restores/plans` | plan a restore (source, explicit destination) | `restore.plan` |
| `GET /restores`, `GET /restores/{id}` | restore records | `backups.read` |
| `GET /restore-drills`, `POST /restore-drills/plans` | drills | read `backups.read`; plan `restore.plan` |

## Nodes

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /nodes`, `GET /nodes/{id}` | nodes, capabilities, health | `nodes.read` |
| `POST /servers/{id}/enrollment-tokens` | create a one-time enrollment token | `registry.manage` (human) |
| `POST /nodes/{id}/plans` | plan a node/cluster operation (`kind` in body) | `nodes.plan` |
| `POST /nodes/{id}/revoke` | revoke node identity | `registry.manage` — plan |
| `GET /nodes/{id}/jobs` | job history | `nodes.read` |

## Access

| Method & path | Purpose | Permission |
|---|---|---|
| `GET /me` | current identity, roles, scopes of this token, grant restrictions | any |
| `GET /identities`, `POST /identities`, `PATCH …` | identities (humans, service accounts) | `access.manage` |
| `GET /roles`, `GET /roles/{id}` | built-in and custom roles | `access.read` |
| `POST /role-bindings`, `DELETE /role-bindings/{id}` | bind roles at scopes | `access.manage` — plan |
| `GET /oauth-clients`, `PATCH /oauth-clients/{id}` | registered clients, approve/disable DCR and CIMD clients | `access.manage` |
| `GET /me/grants`, `DELETE /me/grants/{id}` | connected applications of the caller | self |
| `GET /grants`, `DELETE /grants/{id}` | all grants | `access.manage` |
| `POST /service-accounts/{id}/api-keys`, `DELETE …/{keyId}` | API keys (secret shown once at creation to the creating human, never again) | `access.manage` |
| `GET /policy-settings`, `PUT /policy-settings/{scope}` | policy configuration | read `access.read`; write `policy.manage` — plan |

## Audit

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /audit-events` | search | `audit.read` |
| `GET /audit-events/chain` | chain head, last verified checkpoint | `audit.read` |

## Service endpoints (outside `/api/v1`)

| Path | Purpose | Auth |
|---|---|---|
| `/healthz/live` | process liveness | none |
| `/healthz/ready` | readiness (Control Store, migrations at expected version, keys loaded for the role) | none; returns no details publicly |
| `/.well-known/oauth-protected-resource[/mcp|/api]`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | discovery | none |
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register` | OAuth AS | per spec |
| `/mcp` | MCP | bearer |

## Example: plan a migration (OpenAPI fragment, documentation only)

```yaml
/targets/{targetId}/migrations/plans:
  post:
    operationId: createMigrationPlan
    security: [{ bearer: [migrations.plan] }, { session: [] }]
    parameters:
      - { name: targetId, in: path, required: true, schema: { type: string } }
      - { name: Idempotency-Key, in: header, required: false, schema: { type: string, maxLength: 255 } }
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            additionalProperties: false
            properties:
              bundles:
                type: array
                maxItems: 50
                items: { $ref: '#/components/schemas/MigrationBundleSubmission' }
              migrationIds:
                type: array
                items: { type: string, pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' }
              source: { $ref: '#/components/schemas/SourceReference' }
    responses:
      '201': { description: Plan created (decision may be deny), content: { application/json: { schema: { $ref: '#/components/schemas/MigrationPlan' } } } }
      '409': { $ref: '#/components/responses/Problem' }   # e.g. MIGRATION_CHECKSUM_MISMATCH
      '422': { $ref: '#/components/responses/Problem' }   # e.g. MIGRATION_MANIFEST_INVALID
```
