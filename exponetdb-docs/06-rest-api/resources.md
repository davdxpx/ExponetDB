# REST resources (`/api/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; shapes are refined in the wave that implements each group |
| Read before | [`architecture.md`](./architecture.md) |

Permissions refer to RBAC permissions; scopes to OAuth scopes
([`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md)).
"Plan" in the last column means the endpoint creates a plan rather than changing
state directly.

## Registry

| Method & path | Purpose | Permission / scope | Notes |
|---|---|---|---|
| `GET /products`, `GET /products/{id}` | products | `targets.read` | |
| `POST /products` | create a product (slug, display name) | `registry.manage` | plan (Wave 4) |
| `GET /products/{id}/environments` | environments with tier, evidence chain and revision | `targets.read` | |
| `POST /products/{id}/environments` | define an environment | `registry.manage` | plan |
| `POST /products/{id}/environments/{env}/change-plans` | change an environment (display name, tier, evidence source, rank) | `registry.manage` | plan; class `high` when tier or evidence source changes; re-authentication; a tier change is refused while a live target uses the environment (Wave 4: a POST that creates a plan replaces the earlier `PATCH`) |
| `GET /projects`, `GET /projects/{id}` | projects (managed scope, evidence override, revision) | `targets.read` | |
| `POST /projects`, `POST /projects/{id}/change-plans` | create/configure a project (managed scope, evidence override); execution role aliases arrive with Wave 6 | `registry.manage` | plan |
| `GET /projects/{id}/execution-roles` | **[OBSERVED]** (Wave 9 Part A, `getProjectExecutionRoles`, `project.execution_roles.get`; REST only, no MCP tool) the project's execution roles ([ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md)): `defaults` (the project's alias map), per environment of the product its `bindings` (the aliases bound to another role for that environment) and `effective` map (bindings over defaults), and the declared `BYPASSRLS` `exceptions`, newest first, active and revoked, each with its scope, role, reason (untrusted), `reviewBy`, `expired` (active but past its review date: it excuses nothing), revision, who declared and revoked it and when | `migrations.read` |
| `POST /projects/{id}/environments/{env}/execution-role-plans` | **[OBSERVED]** (Wave 9 Part A, `planExecutionRoleBindings`) bind aliases of the project map to other roles for one environment, body `{ roles }` (an empty map removes the environment's bindings; every alias must exist in the project map; never a `pg_` or `exponetdb_` role) | `registry.manage` at the environment's tier | plan; class `high`; re-authentication; a binding change between plan and apply makes migration plans `PLAN_STALE` |
| `POST /projects/{id}/environments/{env}/execution-role-exceptions` | **[OBSERVED]** (Wave 9 Part A, `planExecutionRoleException`, OD-51) declare that one role may carry `BYPASSRLS` as an execution role of the project in that environment, body `{ role, reason, reviewBy? }` (reason 20 to 1000 characters); nothing else is ever excusable | `registry.manage` at the environment's tier; human only | plan; class `high`; re-authentication; production: one approval (`registry.execution-role-exception-production`) |
| `POST /projects/{id}/execution-role-exceptions/{exceptionId}/revoke-plans` | **[OBSERVED]** (Wave 9 Part A, `planExecutionRoleExceptionRevocation`) revoke a declared exception, body `{ reason }`; every plan that bound it becomes `PLAN_STALE` | `registry.manage` at the environment's tier; human only | plan; class `high`; re-authentication; production: one approval |
| `GET /targets` | list targets (filters: product, project, environment, tier, state) | `targets.read` | grant target restrictions applied: a restricted grant sees only its targets |
| `GET /fleet` | **[OBSERVED]** (Wave 8, `getFleet`, `fleet.get`; REST only, no MCP tool; [`../10-observability/health.md` §10](../10-observability/health.md#10-fleet-overview-and-findings-across-targets)) one request: `targets` (the targets the caller may list that are not decommissioned, by tier, by health state and by source; `unknown` is a state of its own and a never-sampled or lagging target is counted there, never healthy; `decommissioned` counted apart), `findings` (open findings by severity) and `operations` (`running`, `needs_attention`, `awaiting_approval`). Every part carries `source`, `observedAt`, `lowerBound` and `lowerBoundReason`; a part the caller may not see is `{available: false, reason: "permission_denied"}`, never zero. A failed read is an error for the whole request. Computed with a fixed number of queries whatever the number of targets | `targets.read` (the target list's permission and visibility); the findings part also needs `diagnostics.read`; the operations part is filtered by the operation read rule | |
| `GET /targets/{id}` | target detail with placement summary (cluster id and name, generation, version; never an address) | `targets.read` | `{id}` = `tgt_…` or URL-encoded path |
| `POST /targets` | register target (project, environment, database) | `registry.manage` | plan (stamps identity, initializes the empty ledger); prod tier: approval and re-authentication (`target.register-prod-approval`); **[DECIDED]** (OD-22, 2026-10-13) production authority when the database's cluster is declared `prod` or undeclared, whatever the environment (registry tier `placement`, authorization.md §5.1) |
| `POST /targets/{id}/suspend`, `POST /targets/{id}/resume` | stop / allow writes | `registry.manage` | plan |
| `POST /targets/{id}/decommission` | retire target | `registry.manage` | plan (`critical`) |
| `GET /servers`, `POST /servers`, `GET /servers/{id}` | servers | read: `nodes.read`; write: `registry.manage` | write: plan |
| `GET /clusters`, `GET /clusters/{id}` | clusters (state, observed facts, tier) | `nodes.read` | **[DECIDED]** (Wave 8, OD-22) `declaredTier` (`prod`, `nonprod` or `null` while undeclared) beside `derivedTier`; an additive optional member |
| `POST /clusters/{id}/declared-tier` | declare a cluster's intended tier (`prod` or `nonprod`; registry.md §4.1) | `registry.manage` at the production registry tier, whichever value | **[DECIDED]** (Wave 8, OD-22 extended 2026-10-13) plan `registry.cluster.declare_tier` (`201`, class `high`); re-authentication at apply; a retired cluster or the same value is refused; no MCP tool |
| `POST /clusters/{id}/confirm` | confirm a cluster (pins `system_identifier`; refuses the Control Store's own cluster) | `registry.manage` | plan; re-authentication |
| `POST /clusters` | register external cluster (CA bundle, endpoints) | `registry.manage` | plan; re-authentication |
| `GET /clusters/{id}/bootstrap-sql` | role bootstrap SQL for a person to run with psql (no password; idempotent). Query (Wave 9, A8): `database` (repeatable, before registration), `project` and `environment` (that project's execution roles; needs `project.execution_roles.get` on it too), `ledgers` (the legacy ledger read); the response adds `pendingDatabases`, `executionRoles` (with `bypassRlsExcused`) and `legacyLedgers` ([credentials-and-roles.md §8](../03-database-model/credentials-and-roles.md#8-external-clusters-no-node-agent)) | `registry.manage` | Wave 4; query Wave 9 |
| `GET /clusters/{id}/endpoints`, `POST /clusters/{id}/endpoints` | endpoints | `registry.manage` | addresses visible only to `registry.manage`; POST: plan, re-authentication |
| `POST /clusters/{id}/endpoints/{endpointId}/retire` | retire an endpoint (a changed address is a new endpoint) | `registry.manage` | plan; re-authentication |
| `POST /clusters/{id}/databases/{databaseId}/retire` | retire a registered database record that is no current placement (Wave 9; final; the name can be registered again; the cluster is not touched) | `registry.manage` | plan; re-authentication; `database_retired`, `database_in_use` |
| `GET /clusters/{id}/databases`, `POST /clusters/{id}/databases` | databases (external clusters: register an existing database; agent clusters: create via node capability, Wave 5) | `registry.manage` | plan |
| `GET /clusters/{id}/credentials` | credential metadata (role, state, times) | `registry.manage` | never a secret or a secret reference |
| `POST /clusters/{id}/credentials/{role}` | write-only credential submission (external clusters) | `registry.manage` | Web App, re-authentication; `202` with the pending metadata; never readable |
| `POST /clusters/{id}/role-verifiers` | **[OBSERVED]** (Wave 8, owner decision S3, `submitRoleVerifier`, `postgres.roles.verifier.plan`; REST only, Web App, no MCP tool) write-only submission of a consumer login role's SCRAM-SHA-256 verifier, never a password: body `role` (not `pg_…`, not `exponetdb_…`) and `verifier` (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, at least 4096 iterations, a salt of 16 to 64 bytes); sealed at once (`se1`), never readable through any interface; `201` with the plan of `postgres.roles.verifier.set` (its content names the role and the stored verifier's `rvf_…` id only), which `plan.apply` runs through the node. A validation error names the field, never the value. Refused: a role the node's latest roles observation (at most 10 minutes old) does not show (`REGISTRY_CONFLICT` `role_missing`) or a superuser role (`role_superuser`); an external cluster (`CAPABILITY_UNAVAILABLE`). No idempotency key (its request hash would cover the verifier) ([`../03-database-model/credentials-and-roles.md` §4.1](../03-database-model/credentials-and-roles.md#41-role-verifiers-wave-8-owner-decision-s3)) | `nodes.operate` (human), tiered `nodes.operate:<tier>` | re-authentication; plan; apply: re-authentication, and a human approval on a production cluster (`node.prod-apply-approval`) |

## Schema and drift

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/schema` | overview: schemas, object counts, fingerprint | `schema.read` |
| `GET /targets/{id}/schema/objects/{kind}/{qualifiedName}` | object detail | `schema.read` |
| `GET /targets/{id}/schema/search?q=` | search objects | `schema.read` |
| `GET /targets/{id}/schema/objects?kinds&schema&parent&q&limit&cursor` | **[OBSERVED]** (Wave 8 completion, additive; `listSchemaObjects`, action `schema.search`; REST only, the MCP tool `schema_search` keeps its input) the objects of the current schema snapshot **without a search term**, so a browser can list a schema before anyone types a filter. Every filter is optional and they combine with AND: `kinds` (repeat the parameter, at most 16 of the kinds `SchemaObjectRef.kind` shows), `schema` (exact `SchemaObjectRef.schema`), `parent` (the exact name `SchemaObjectRef.parent` shows: the owning table, view or type of a column, constraint, index, trigger, policy or rule; combine with `schema` to name one relation) and `q` (1 to 128 characters, a case-insensitive substring of the name, the rule of the search). `limit` 1 to 200 (default 100), `cursor`. Answer: `items` (`SchemaObjectRef`), `nextCursor`, `total` (how many objects of the snapshot match, before paging; exact), `fingerprint` (the snapshot every page is read from), `complete` (`false` when anything in scope could not be read: the list may then miss objects), `source` and `observedAt` (the snapshot's own: `live` or `cached`, and the time it was taken). Read from the same snapshot as the search and the overview (reused for 30 seconds, else taken live and stored); a failed read is an error, never an empty list. Order within a snapshot is total and deterministic: schema, kind, name, signature (UTF-8 byte order), then parent and canonical key. The cursor is bound to the snapshot's fingerprint and to the filters: one made from another fingerprint (the schema changed while a person paged) is `409 SCHEMA_FINGERPRINT_MISMATCH`, so the client starts again without a cursor; one made for other filters, or not ours, is `422 VALIDATION_FAILED` naming `/cursor`. Names are untrusted catalog text, as in the search. An invisible or unknown target reads as `TARGET_NOT_FOUND` | `schema.read` |
| `GET /targets/{id}/schema/fingerprint` | current fingerprint + document reference | `schema.read` |
| `POST /schema-diffs` | diff two targets or fingerprints | `schema.read` |
| `POST /targets/{id}/drift-checks` | run drift check | `schema.read` |
| `GET /targets/{id}/drift-checks?limit&cursor` | **[OBSERVED]** (Wave 8 completion, additive; `listDriftChecks`, action `target.finding.list`; REST only, no MCP tool) the past drift checks of a target, scheduled and requested, newest first, from the Control Store's append-only `observation.drift_checks`: no database is touched. Keyset pages (`finished_at`, then the check id; `limit` 1 to 200, default 50; a cursor that is not ours is `VALIDATION_FAILED`). Per check: `id` (`smp_`), `targetId`, `generation` (the target generation it ran against; checks of earlier generations are listed too), `requestedBy` (`{kind: schedule}` for the worker, or `{kind: identity, identityId}` for the identity that ran it on demand; a delegated client acts as the identity that delegated, and the client the call came through is not recorded with the check), `status` (`clean`, `drifted`, `incomplete`, `no_baseline`, `not_comparable`, `failed`), `baselineFingerprint`, `currentFingerprint`, `counts` (`drifted`, `matched`, `unmanaged`, `opened`, `updated`, `resolved`: all six are stored per check), `errorCode` (set exactly when `status` is `failed`), `startedAt` and `finishedAt`. **Not stored, so not returned:** the findings a check saw (a finding keeps the checks that opened and resolved it; `GET /targets/{id}/findings` lists them). An empty list means no check was ever recorded for the target; a failed read is an error. An invisible or unknown target reads as `TARGET_NOT_FOUND` | `diagnostics.read` (the findings' permission, not `schema.read` of the POST: the list names who asked, and carries no schema text) |
| `GET /findings?severity&state&kind&target&cursor&limit` | **[OBSERVED]** (Wave 8, `listFindings`, `finding.list`; REST only) findings across the targets the caller may read with `diagnostics.read` (the visibility of `GET /targets/{id}/findings`: grant scopes narrowed by a delegation), newest first (finding ids are ULIDs), keyset pages by an opaque cursor, `limit` 1 to 200 (default 50; above 200 is `VALIDATION_FAILED`, `422`). `severity` (`info`, `warning`, `critical`), `state` (`open` by default, `resolved`, `all`), `kind` (`drift`, `health`) and `target` (`tgt_` id or URL-encoded path; unknown or invisible is `TARGET_NOT_FOUND`); any other value or parameter is `VALIDATION_FAILED`. Each item is the per-target `Finding` plus `targetId` and `targetPath` | `diagnostics.read` |
| `GET /targets/{id}/findings` | findings (drift, advisors, health) | `diagnostics.read` |
| `POST /findings/{id}/accept` | `drift.accept`: adopt the target's current complete schema as its baseline and resolve its open drift findings `accepted`; no DDL. **[OBSERVED]** (Wave 8, `planDriftAcceptance`, action `drift.accept.plan`) `201` with the plan, applied through `POST /plans/{id}/apply`; body `{reason?}` (10 to 1,000 characters, required when a covered finding is critical or security-relevant). A finding that is not a drift finding is `422 VALIDATION_FAILED`, a resolved one `409 REGISTRY_CONFLICT` (`finding_resolved`), an unknown one `404`; a changed schema, baseline, set of open drift findings or scope makes the plan `PLAN_STALE` at apply. Prod tier: approval and re-authentication (`drift.accept-prod`) | `schema.manage` (admin, a person through the Web App or CLI only) — plan |

## Queries

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /targets/{id}/queries` | run a read-only query | `data.read:<tier>` |
| `POST /sql/classifications` | **[OBSERVED]** (Wave 8, `classifySql`, `sql.classify`; REST only, no MCP tool) classify submitted SQL statement by statement with the parser: no target is touched, nothing is executed, stored, logged or audited, and the text is never echoed. Body `{ sql, postgresMajor? }` (at most 64 KiB of UTF-8 bytes and 200 statements, else `422 VALIDATION_FAILED` naming `/sql` and the bound; grammar 16, 17 or 18, default 17). Answer: `status` (`parsed`, `empty`, `parse_error`), per statement the `start` and `end` (`line`, `column` in code points, `offset` in UTF-16 code units), the parser's node `kind`, a `label`, the `classes` (`read_only`, `write`, `destructive`, `rewrite`, `non_transactional`, `security`), `procedural`, `readOnlyPath` with the admission's refusal code and reason, and the migration engine's refusal reason; the whole-text `readOnlyPath`; a syntax error as a result with its `parseError.position`. Installation-level `migrations.read` (a tier-restricted delegation reads it: it names no target). The mapping from facts to classes and the position units: [`sql-execution-security.md` §2.5](../03-database-model/sql-execution-security.md#25-statement-classification-for-the-web-app-wave-8) | `migrations.read` |
| `POST /targets/{id}/explain` | EXPLAIN / EXPLAIN ANALYZE (read-only) | `data.read:<tier>` |
| `POST /targets/{id}/queries/{queryId}/cancel` | cancel own running query (Wave 7: the caller names the query by the `qry_` id it chose; another caller's query reads as not found) | `data.read:<tier>`, same identity, client and grant as the query |
| `GET /targets/{id}/queries/history?cursor&limit` | **[OBSERVED]** (Wave 8, `listQueryHistory`, `query.history.list`; REST only, no MCP tool) the caller's **own** data reads on this target, newest first, read from the audit's `data.read` events (`source: audit`) and nothing else: "own" is the audit's actor, the caller's identity, through whichever client it read (a person also sees what an MCP client read in their name, `client: mcp`; a service account only its own); another identity's reads never appear. Per entry the `qry_` id, `kind` (`query` or `explain`), the time the audit recorded it, the **redacted** statement exactly as the audit holds it (constants replaced, at most its first 256 characters; the text the caller sent is never stored and never returned), its digest, `rows`, `truncated`, `durationMs`, `outcome` (`succeeded` or `failed`), `errorCode`, `client` and `callerClass`. `rows` and `truncated` are `null` for an EXPLAIN and for a failed or refused read, `durationMs` for a failed or refused read: the audit records none for them. Keyset paging by audit sequence (`limit` 1 to 200, default 50; an unknown cursor is `VALIDATION_FAILED`). An invisible or unknown target reads as `TARGET_NOT_FOUND` | `data.read:<tier>` |
| `GET /saved-queries?target&cursor&limit` | **[OBSERVED]** (Wave 8, `listSavedQueries`, `saved_query.list`; REST only, no MCP tool) the saved queries the caller may read, newest first: their own, and every `project` query of a scope where they may read data (see below); with `target`, only that target's and its project's. Nothing else is counted or hinted at. At most 1000 rows are examined per call; the cursor continues the scan, so a page may hold fewer than `limit` items before the last one | `data.read:<tier>` of each query's scope |
| `POST /saved-queries` | **[OBSERVED]** (Wave 8, `createSavedQuery`, `saved_query.create`; Web App only) save a query of your own: `name` (1 to 120 characters, one line, no control or bidirectional formatting characters; untrusted), `sql` (1 to 65,536 characters; untrusted, **never run, admitted or classified by saving**), `visibility` (`personal`, the default, or `project`) and a `scope` that never changes afterwards: `{kind: target, target}` (a `tgt_` id or path; the caller must read data on it at its tier) or `{kind: project, projectId}` (the caller must read data on the **whole project**, see below; a project they cannot see is `NOT_FOUND`). Body limit 320 KiB. The audit records `saved_query.create` with the id, the scope, the visibility, the revision and the **digest** of the redacted text, never the text or the name. `201` with the saved query (`revision` 1) | session (`api`), self; `data.read` in the scope |
| `GET /saved-queries/{id}` | **[OBSERVED]** (Wave 8, `getSavedQuery`, `saved_query.get`) one saved query: id, name, text, digest, visibility, scope, `ownerIdentityId`, `ownedByCaller`, revision, created and updated time. A `personal` query of someone else, a query whose scope the caller may not read and an id that does not exist all answer `NOT_FOUND` alike | `data.read:<tier>` of its scope |
| `PUT /saved-queries/{id}` | **[OBSERVED]** (Wave 8, `updateSavedQuery`, `saved_query.update`; Web App only) the owner replaces `name`, `sql` and `visibility` at the `revision` they read; another revision is `CONFLICT` (409) and nothing changes; the scope and the owner never change. A query the caller cannot see is `NOT_FOUND`; a visible `project` query of someone else is `PERMISSION_DENIED`. The Control Store enforces the owner and the revision as well (`savedq.update_saved_query`). Audited like a creation (digest only) | session (`api`), self, owner only; `data.read` in the scope |
| `DELETE /saved-queries/{id}` | **[OBSERVED]** (Wave 8, `deleteSavedQuery`, `saved_query.delete`; Web App only) the owner deletes it (`savedq.delete_saved_query` checks the owner); `NOT_FOUND` and `PERMISSION_DENIED` as for a change. Audited with the digest of what it held | session (`api`), self, owner only; `data.read` in the scope |

**[DECIDED]** (Wave 8, order §9) Who may read a saved query: its owner or, for a
`project` query, anyone, provided the caller may read data in its scope. For a
target scope that is `data.read` on the target at its tier, decided by the
central engine like a data read (a restricted grant only on its targets and
tiers). For a project scope it is the safe reading of "covering the scope":
`data.read` through a binding that covers the **project itself** (global, its
product or the project; a binding on one environment or one target does not),
decided like a production subject of that project, so a delegated caller also
needs `data.read:prod` and an unrestricted grant (a project's queries may run
on its production targets). Creating, changing and deleting are a person's own
records, made in the Web App (self-service actions with the session scope
`api`): a `data.read` scope stays a read scope (G3B), and a CLI or a service
account reads saved queries but does not write them.

## Migrations

**[DECIDED]** (Wave 6.) Request bodies that carry bundle text inline are
limited to 32 MiB of JSON, counted while the body arrives and before it is
parsed; every other route keeps 64 KiB. Each file's limit is in UTF-8 bytes
(`migration.yaml` 64 KiB, `up.sql` and `down.sql` 4 MiB, `verify.sql`
512 KiB); at most 50 bundles and 200 migration ids per request. Source
references are stored as claims (`provenance: claimed`, OD-6 (a)); the server
never fetches a repository.

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /projects/{id}/migrations/lint` | lint bundles | `migrations.read` |
| `POST /projects/{id}/bundles` | ingest bundles without planning (validated and hashed again on the server) | `migrations.plan` |
| `GET /projects/{id}/bundles/{migrationId}` | bundle metadata, revisions, earlier never-applied rewrites | `migrations.read` |
| `GET /projects/{id}/bundles/{migrationId}/revisions/{revision}/files/{file}` | exact stored text of one file of a revision | `migrations.read` |
| `GET /projects/{id}/migrations` | stream: DAG, heads, per-target state matrix ("promotion board"). **[OBSERVED]** (Wave 8, `getMigrationStream`, `migration.stream.get`) The newest stored revision of every bundle in dependency order (`dependsOn`; the last 1000 with `truncated`), the product's environments in evidence order, and per bundle and environment the state the Control Store **mirrors** hold for the project's live target there: `not_applied`, `applied`, `verified` (the latest mirrored verification passed), `failed` (it failed, was partial or errored), `reverted`, `divergent` (the ledger differs from the mirror in a way no operation explains), `unknown` (the mirror holds nothing for the target at its current generation: written by the worker after each operation, so a target no operation has touched reads `unknown`, never `not_applied`). The answer says `source: cached` and carries the time of each mirror; it is not a live read of the targets (`GET /targets/{id}/migrations` is). A target the caller may not see is left out without a count; its environment reads like one without a target. A restricted delegation (a target list or one tier) is refused at the project, as for every project read | `migrations.read` |
| `GET /targets/{id}/migrations` | ledger (mirror + live check), pending, verification states | `migrations.read` |
| `GET /targets/{id}/migrations/{migrationId}` | ledger row, events, verification runs | `migrations.read` |
| `POST /targets/{id}/migrations/plans` | plan apply of bundles / ids | `migrations.plan` |
| `POST /targets/{id}/migrations/{migrationId}/verifications` | re-run verification (an operation, `202`) | `migrations.apply:<tier>` |
| `POST /targets/{id}/migrations/{migrationId}/rollback-plans` | plan rollback | `migrations.plan` |
| `POST /targets/{id}/migrations/{migrationId}/resume-plans` | plan resuming a non-transactional bundle | `migrations.plan` |
| `POST /targets/{id}/break-glass-grants` | activate break-glass on one target: named overridable rules, a reason (≥ 20 characters), at most 2 h; a Web App session re-authenticated within 120 s; the owners are notified, and without a notification channel the activation is refused (`BREAK_GLASS_UNAVAILABLE`, OD-21) | `breakglass.activate` (human only) |
| `GET /targets/{id}/migrations/scratch-check?scratchTarget=…` | read only: whether a scratch target can take this target's legacy replay (usable, identity marker and database oid, empty, extensions, objects outside the managed scope it needs, the execution role; Wave 9, [`legacy-import.md` §2.5](../04-migrations/legacy-import.md#25-scratch-targets)) | `migrations.import` on both targets |
| `POST /targets/{id}/migrations/scratch-check` | **[OBSERVED]** (follow-up 2, F3, `checkScratchTargetForFiles`, same action) the same read-only preflight with the legacy files in the body (`{ scratchTarget, role?, files, notApplicable? }`, the analysis's file limits: 4 MiB per file, 8 MiB in all, a body of at most 16 MiB): also `legacy_references`, what the files name in schemas outside the managed scope that the scratch target lacks (each with the first file that names it), and `copySchemas`, the schemas to copy schema-only (`exponetdb migration import scratch-copy-commands`). Nothing is stored, replayed or written | `migrations.import` on both targets |
| `POST /targets/{id}/migrations/import-analyses` | plan a legacy import analysis: replay on an explicit, empty scratch target of the same project, compare, classify into an import report (`migration.import.replay`). **[DECIDED]** (follow-up 2, F4) at most 1 000 files, 4 MiB each and 8 MiB of SQL in all, in a body of at most 16 MiB (`422 VALIDATION_FAILED`, `/files`, `too_large`) ([deployment.md §2a](../12-operations/deployment.md#2a-memory)) | `migrations.import` |
| `GET /targets/{id}/import-reports/{importReportId}`, `POST /targets/{id}/import-reports/{importReportId}/items/{itemId}/decision` | review and resolve import items (a POST that records a decision replaces the earlier `PATCH`) | `migrations.import` |
| `POST /targets/{id}/migrations/baseline-plans` | plan baseline | `migrations.import` |
| `POST /targets/{id}/ledger/reconcile-plans` | plan ledger reconciliation | `migrations.import` |

## CLI step-up (Wave 6, ADR-0026)

| Method & path | Purpose | Who |
|---|---|---|
| `POST /step-ups` | request a step-up for one action of the person's first-party CLI | the person's CLI access token |
| `GET /step-ups/{stepUpId}` | read one's own step-up | the person (CLI or Web App) |
| `POST /step-ups/{stepUpId}/confirm` | confirm with the CLI's code and a fresh re-authentication | the person's Web App session |
| `POST /step-ups/{stepUpId}/cancel` | cancel one's own step-up | the person (CLI or Web App) |

**[DECIDED]** A step-up exists for `plan.apply` (an active plan the person
made through the CLI whose kind or policy needs a fresh proof; otherwise
`CONFLICT`) and for `node.enrollment_token.reveal` (a token this person may
reveal now); anything else is `NOT_FOUND` or `VALIDATION_FAILED`. The
answer to the request carries the `userCode` once; a read never repeats
it. A wrong code counts as an attempt (`VALIDATION_FAILED`); the fifth ends
the step-up (`CONFLICT`), as does a grant revoked meanwhile. The CLI then
repeats the bound request with `ExponetDB-Step-Up: <stu_…>`; a receipt that
is not confirmed, expired, already redeemed or bound to anything else
answers `REAUTH_REQUIRED`. A Web App session never names a receipt
(`VALIDATION_FAILED`). The confirmation page is `/step-up#id=<stu_…>`.

## Plans, approvals, operations

| Method & path | Purpose | Permission / scope |
|---|---|---|
| `GET /plans`, `GET /plans/{id}` | plans, newest first; filters `target`, `kind`, `state`, `actor=self`; cursor pages (the list: Wave 6). **[OBSERVED]** (Wave 8) A plan read carries `operationId`: the operation that applied it (at most one per plan), `null` while it was not applied; the MCP plan tools do not carry it | read permission of the kind, or `plans.approve` (Web App session), at a scope covering the subject (OD-26 (c), see below) |
| `POST /plans/{id}/apply` | apply (idempotent); repeating it on an operation that waits after a `critical` self-approval releases it once the cooling period passed and the actor re-authenticated (OD-9, Wave 3A) | kind/tier scope |
| `POST /plans/{id}/withdraw` | withdraw | plan actor |
| `GET /approvals?state=pending` | approval queue: operations awaiting approval (Wave 3A) | `plans.approve` (human) |
| `POST /approvals/{id}/approve`, `POST /approvals/{id}/reject` | decide the plan of the operation `{id}` awaiting approval (requires recent re-auth; body includes `planHash`, the acknowledgement of a self-approval and, from Wave 6 when required, the compatibility attestation) | `plans.approve` (Web App session only) |
| `GET /operations`, `GET /operations/{id}` | operations, newest first; filters `target`, `kind`, `state`, `actor=self`; cursor pages. **[DECIDED]** Wave 6: an operation carries its `steps` (from the driver's events), `waitingFor` (a lock wait), `observedAt`, the monotonic `lastEventId` and the server's `nextAction`; a watcher polls this read (no SSE in V1). **[OBSERVED]** (Wave 8) An operation read carries `retryable`: true exactly when `POST /operations/{id}/retry-verification` passes the rules about the operation itself (`needs_attention` after a `migration.apply` or `migration.resume` that is applied or partly applied and whose verification errored or never finished; one function serves the flag and the route, `verificationRetryable`); the plan kind's apply permission is still checked by that call. The MCP operation tools do not carry it | same as `GET /plans/{id}` |
| `GET /operations/{id}/events` | step events **[PLANNED]** (not served in Wave 6: `lastEventId` and `steps` on the operation carry what a watcher needs) | same |
| `POST /operations/{id}/cancel` | cancel an operation that has not started (`awaiting_approval`, `queued`); `OPERATION_NOT_CANCELABLE` otherwise; a running operation is never interrupted (Wave 6) | the actor that applied the plan (same identity, client kind and registered client; otherwise `PLAN_BINDING_ACTOR`), with the plan kind's apply permission |
| `POST /operations/{id}/retry-verification` | verify again an operation that needs attention after an applied change whose verification errored or never finished (`needs_attention` to `verifying` by the worker; the change is never run again); `OPERATION_NOT_RETRYABLE` otherwise (Wave 6) | anyone with the plan kind's apply permission on the plan's subject |
| `POST /break-glass-grants` | not served: activation is per target, `POST /targets/{id}/break-glass-grants` (Wave 6, see "Migrations"), and stays refused while [OD-21](../00-product/open-decisions.md#od-21-delivery-channel-for-invitations-and-security-notifications) is open | `breakglass.activate` (human only) |
| `GET /break-glass-grants?state&review&target&cursor&limit` | **[OBSERVED]** (Wave 8, `listBreakGlassGrants`, `breakglass.list`; no MCP tool) every grant of the installation, newest first (keyset on the grant id; `limit` 1 to 200, default 50): the grant id, the target (`targetId`, `path`, `tier`), `state`, `activatedBy` (the identity id of the person who activated it; the frozen bundle records a grant at activation, so there is no requester or approver), `rules`, `reason` (untrusted text, data only), `createdAt`, `expiresAt`, `maxUses`, `uses`, `revokedAt`, and `review` (`reviewedBy`, `reviewedAt`, `note`) or `null` while the review is an open finding. `state` is derived on every read from the stored columns at one database clock reading, returned as `observedAt` with `source: live`: `revoked` (a revocation is recorded), else `expired` (the time box ended), else `used_up` (the maximum of uses is counted), else `active`. Filters `state` (those four), `review` (`open`, `done`) and `target` (id or path; an unknown one is `TARGET_NOT_FOUND`); any other value or parameter is `VALIDATION_FAILED` (422) | `policy.manage` at the installation (a global binding; held by exactly `owner` and `admin`), human session (Web App or CLI) |
| `POST /break-glass-grants/{id}/review` | **[OBSERVED]** (Wave 8, `reviewBreakGlassGrant`, `breakglass.review`; no MCP tool) record the post-incident review of a grant that is no longer active, body `{ note }` (1 to 2,000 characters, not blank, no control character except the line feed, no bidirectional override; else `VALIDATION_FAILED`). Once per grant: the write matches only an unreviewed grant and the bundle's guard trigger refuses any later change, so a second review, also a concurrent one, is `CONFLICT` (409), and so is a review of a grant that is still `active`; an unknown grant is `NOT_FOUND`. Writes only `reviewed_at`, `reviewed_by` and `review_note` of the frozen `breakglass` bundle and the audit event `breakglass.reviewed` in one transaction; answers the grant as the list shows it. **The note is permanent**: it can never be changed or erased, so it must not contain personal data. Nothing here activates, extends or uses a grant | `policy.manage` at the installation, Web App session only, re-authenticated within 300 s (`REAUTH_REQUIRED`) |

**[DECIDED]** Reading a plan or an operation (`read_of_kind`;
[OD-26 (c)](../00-product/open-decisions.md#od-26-who-may-read-a-plan-or-an-operation-read_of_kind),
resolved 2026-10-12). The kind's domain decides the read permission
(`readPermissionOfKind` in `packages/contracts`): `migrations.read` for
`migration.*` and `ledger.*`; `nodes.read` for `node.*`, `postgres.*`,
`credential.*`, `packages.*` and registry kinds about a server or a cluster;
`access.read` for `access.*`; `backups.read` for `backup.*` and `restore.*`;
`diagnostics.read` for `connections.*`; `schema.read` for `drift.*`;
`targets.read` for every other kind. The permission must cover the plan's
subject (an operation without a plan has the installation as subject), a
delegated caller also needs the permission's scope and stays inside its
grant restrictions, and a Web App session holding `plans.approve` at a
covering scope reads what it could approve (`plans.approve` is no delegated
scope). Each candidate is tried at the subject. An id alone grants nothing:
an unreadable plan or operation answers exactly like an unknown one
(`PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`). `GET /plans` and `GET /operations` filter by the
same rule before the page is cut, examines at most 2000 candidates per call
and continues with an opaque keyset cursor over the operation id (ULID,
newest first), so neither the items, the cursor nor the page length reveals
an operation of another subject.

## Sessions, locks, performance

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/sessions` | sessions (redacted statements) | `diagnostics.read` |
| `GET /targets/{id}/locks` | lock graph | `diagnostics.read` |
| `POST /targets/{id}/sessions/{pid}/cancel` | cancel (body: `backendStart`, `queryStart`) | `connections.operate:<tier>` |
| `POST /targets/{id}/sessions/{pid}/terminate` | create a terminate plan (body: `backendStart`, `reason`); `201` plan, applied via `POST /plans/{id}/apply` | `connections.operate:<tier>` |
| `GET /targets/{id}/health` | health with sub-states. **[OBSERVED]** (Wave 8 completion, additive) an optional `capacity` `{clientBackends, usableSlots, source, observedAt}`: the client backends and the usable connection slots (`max_connections` minus `superuser_reserved_connections` and `reserved_connections`) that **the latest sample measured**, both from the one sample, with that sample's time and its source (`sampled`, or `cached` once the sample is older than two intervals). Absent when that sample did not measure them (never sampled, an unreachable target, a read that failed, a row written before this member existed): never `0` as a stand-in, and `usableSlots: 0` is a measured value. REST only: the MCP tool `target_health` answers with the schema it had and does not carry the member. The database size is **not sampled** today, so it is not part of the view; adding it needs a probe of its own ([`../10-observability/health.md` §2](../10-observability/health.md#2-probes)) | `diagnostics.read` |
| `GET /targets/{id}/health/history?from&to` | **[OBSERVED]** (Wave 8, `getTargetHealthHistory`, `target.health.history.get`; REST only, no MCP tool) the sampled history of one target from `observation.health_samples` (one sample about every 15 seconds, daily partitions, kept 3 to 60 days, 14 by default). `from` and `to` (RFC 3339 UTC; default the last 24 hours; at most 60 days, none in the future, else `VALIDATION_FAILED`). Downsampled to at most 501 buckets whose size the answer returns (`bucketSeconds`, aligned to multiples of itself; a bucket exists only if a sample landed in it): per bucket the `worst` state (order unreachable, unhealthy, degraded, suspended, unknown, healthy: a bucket holding an `unknown` sample is never `healthy`) and the count of every state. **Gaps**: intervals between two samples longer than 30 seconds (twice the period), clipped to the range, at most 200 (`gapsTruncated`), each with a derived `cause`: `control_plane_down` (no worker heartbeat covered the interval; `reason` `no_live_process` or `no_live_worker`), `sampler_lagging` (a worker was alive and wrote no sample), `unknown` with `heartbeats_pruned` (heartbeat rows are kept a day after a process stopped, so older intervals without a live worker cannot be explained). Nothing before the first retained sample (`firstSampleAt`) and nothing after a decommissioned target stopped being sampled is a gap; `node_offline` cannot be derived (a node keeps only its current state) and a failed sample is a sample. An invisible or unknown target reads as `TARGET_NOT_FOUND` | `diagnostics.read` |
| `GET /targets/{id}/query-stats` | statement statistics | `diagnostics.read` |
| `GET /targets/{id}/table-stats` | tables, indexes, vacuum, bloat | `diagnostics.read` |
| `POST /targets/{id}/advisor-runs` | live advisors | `diagnostics.read` |
| `GET /statements/{digest}/raw?target=…[&pid=…&backendStart=…]` | **[OBSERVED]** (Wave 8, owner decision S2, `getRawStatement`, `statement.raw.get`; no MCP tool) the text of **one** statement, read **live** from the target at request time through serve's observer session (identity checked first, `pg_read_all_stats` required; never a write path, never a superuser) and **checked against the digest**: the digest is the one the sessions list shows (`sha256` of the statement's redacted form), recomputed from the text read; only a match is answered. Searched: `pg_stat_activity` of the target's database (or only the session `pid` names, with its `backendStart` from the sessions list), then `pg_stat_statements` when installed and loaded. Secrets are still removed (role passwords and the other sensitive commands as their summary; passwords in conninfo strings and URLs, secret assignments, JSON members, key blocks, tokens, the arguments of pgcrypto, hash and `dblink_connect` calls: [`statement-redaction.md` §4](../03-database-model/statement-redaction.md#4-raw-text-access)). Answer: `text` (untrusted data, at most 64 KiB, `truncated`), `redaction` (`mode` `literal`, `summary` or `unparseable`; `removed`), `origin` (the session: `pid`, `backendStart`, `queryStart`; or the statistics row: `calls`, total and mean time, `rows`), `source: live`, `observedAt`. A statement the target does not hold now, or a target that cannot be read, is `404 STATEMENT_NOT_AVAILABLE` with `reason` `not_held`, `digest_mismatch`, `extension_missing` or `target_unreachable`, never stored or invented text. **Nothing is stored**: no Control Store table, cache, log line or audit event holds the text; each view (also a refused lookup) writes `diagnostics.raw_statement_viewed` with target, digest, where it was found and the outcome before the answer leaves. `backendStart` without `pid`, or a digest that is not `sha256:<64 hex>`, is `VALIDATION_FAILED` | `diagnostics.read_sensitive` at a scope covering the target; a person in the Web App only (`web`, human; the CLI, API keys, OAuth and MCP clients are refused), re-authenticated within 900 s (`REAUTH_REQUIRED`); a denial is `authz.denied` |

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
| `GET /nodes`, `GET /nodes/{id}` | nodes, capabilities, health (the lifecycle state, and what the agent last reported with its source and time; `offline` after four missed heartbeats) | `nodes.read` |
| `POST /servers/{id}/nodes/enroll` | plan `node.enroll` (high, re-authentication at apply): applied, it creates the server's enrollment token record without a secret | `registry.manage` (human) — plan |
| `POST /enrollment-tokens/{id}/reveal` | reveal the token once, for the identity that applied `node.enroll`, within 30 minutes (Web App, re-authentication); the secret exists only in this response | `registry.manage` (human) |
| `POST /nodes/{id}/revoke` | plan `node.revoke` (high, re-authentication at apply) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/decommission` | plan `node.decommission` (high, re-authentication at apply) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/config-updates` | plan `node.config.update` (high, re-authentication at apply): body `addJobKeys` (staged or active keys the node does not trust yet) and `retireJobKeys` (retiring or retired keys it still trusts); verified by a read the added key signs ([`../07-node-agent/control-plane.md` §9.8](../07-node-agent/control-plane.md#98-job-key-rotation-nodeconfigupdate)) | `registry.manage` (human) — plan |
| `POST /nodes/{id}/inspections` | run one read or plan capability through the node (`node.inspect`, low: planned and accepted in one call, run by the worker); `202` with the operation; the node-signed result becomes an observation | `nodes.plan` |
| `GET /nodes/{id}/observations` | the latest node-signed observations per capability, cluster and arguments, with source (`agent_reported`, `nr1` verified) and time; `capability` and `clusterId` filter | `nodes.read` |
| `POST /nodes/{id}/plans` | plan a PostgreSQL operation through the node (`node.plan`): body `clusterId` and `change` (`kind` and its fields), bound to an observation at most 10 minutes old ([`../07-node-agent/control-plane.md` §9.3](../07-node-agent/control-plane.md#93-plans-nodeplan)) | `nodes.plan`; apply: `nodes.operate:<tier>` — plan |
| `POST /clusters/{id}/credentials/{role}/rotate` | plan `credential.rotate` on an agent-managed cluster: the worker generates the password, sets its verifier through the node and logs in with it | `registry.manage` (human) — plan |
| `GET /nodes/{id}/jobs` | **[OBSERVED]** (Wave 8, `listNodeJobs`, `node.job.list`; REST only) recent jobs of a node, newest first, keyset pages (`limit` up to 200): job id, operation id, capability and major version, state, created, started and finished times, the reported `outcome` and `resultVerified` (whether the worker verified the node's signature on the result; `null` while it has not judged). Never the envelope, the arguments or their hash, the node's completion or any signature | `nodes.read` |
| `GET /nodes/certificates` | **[OBSERVED]** (Wave 8, `listNodeCertificates`, `node.certificate.list`; REST only, installation-wide: a restricted delegation is refused) the agent PKI's root, issuing and gateway server CA and the PostgreSQL CA the Control Store holds, each with role, subject common name, `notBefore`, `notAfter` and the SHA-256 fingerprint of its DER encoding (parsed with `node:crypto` `X509Certificate`), and for every node that can still connect its client certificate's expiry and the server certificate expiries its agent last reported. Never a key, a secret reference or a certificate itself. **Not known, and stated in the answer (`notKnown`)**: the gateway's TLS certificate (minted in memory for 72 hours and recorded nowhere) and the server certificates of external clusters (ExponetDB does not connect to read them). An authority the store does not hold yet is listed in `notRecorded` | `nodes.read` |

**[DECIDED]** (Wave 5 Phase 3) Enrollment tokens are created by the
`node.enroll` operation and revealed by a separate call, so the token secret
never sits in a plan, an operation or a log
([`../07-node-agent/control-plane.md` §4](../07-node-agent/control-plane.md#4-enrollment-tokens)).
The earlier `POST /servers/{id}/enrollment-tokens` is replaced by these two
steps.

## Access

**[DECIDED]** (Wave 3A, Wave 3B) Every route accepts exactly one credential:
a Web App session (mutating routes then need the session's CSRF token and
exact `Origin`), an OAuth access token for the audience
`https://db.exponet.cloud/api`, or an API key. Whether a credential may use a
route is decided by the action's client kinds, the delegated scope, the
grant's restrictions and the identity's live role bindings, centrally
([`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md));
there are no separate machine routes. Actions that need a re-authentication
can only be completed in a Web App session.

**[DECIDED]** (Wave 3B, `apps/server/src/interfaces/http/api.ts`.) The
credential mode is settled before the handler: a session cookie together
with an `Authorization` header is `AMBIGUOUS_CREDENTIALS`; two
`Authorization` headers, another scheme, or a token that is not live for
`api` is `401 UNAUTHENTICATED` with `WWW-Authenticate: Bearer
error="invalid_token", resource_metadata="…/.well-known/oauth-protected-resource/api"`;
no credential at all is `401` with the `resource_metadata` challenge. A
bearer credential is no ambient authority, so bearer requests need neither
`Origin` nor the CSRF token, and `/api/v1` does not check an `Origin` a
bearer request sends. **[DECIDED]** (Wave 7) `/mcp` differs: it checks a
present `Origin` before authentication and refuses one outside its
allowlist with `403`; a request without `Origin` (a native client) passes
and still needs a token
([`../05-mcp/architecture.md` §3](../05-mcp/architecture.md#3-transport)).
When the identity holds the permission but the
token lacks the scope, the answer is `403 INSUFFICIENT_SCOPE` with
`details.requiredScope` and `WWW-Authenticate: Bearer
error="insufficient_scope", scope="…", resource_metadata="…"` (step-up). The
`/auth` ceremonies never take a bearer credential.

| Method & path | Purpose | Permission |
|---|---|---|
| `GET /me` | current identity, its bindings, the effective permissions per scope (a projection of the live bindings, never a token), the session. **[OBSERVED]** (Wave 8, owner decision S10) the own profile as optional fields: `displayName` (the name the person chose, `null` while unset; the name an admin gave at invitation stays `identity.displayName`), `avatar` (`{ url, sha256, width, height }` or `null`) and `profileRevision` (0 while never set) | self |
| `PUT /me/profile` | **[OBSERVED]** (Wave 8, owner decision S10, `updateMyProfile`, `me.profile.update`; no MCP tool) set or clear the own display name, body `{ displayName \| null, revision }` (strict): one line of 1 to 64 characters, no control, line-separator, zero-width or bidirectional formatting character, no leading or trailing white space (else `422 VALIDATION_FAILED`); `revision` is the `profileRevision` the change is based on (0 for the first), a stale one is `409 CONFLICT`. Answers the profile (`identityId`, `displayName`, `avatar`, `revision`, `updatedAt`). Audited as `me.profile.update` with the revision and whether a name is set, never the name ([`identity.md` §12](../08-auth-and-security/identity.md#12-profile-wave-8-owner-decision-s10)) | self: a person in the Web App (`web`, human; no re-authentication; not in a recovery session) |
| `PUT /me/avatar` | **[OBSERVED]** (Wave 8, owner decision S10, `setMyAvatar`, `me.avatar.set`; no MCP tool) upload the own profile picture as the **raw body** with `Content-Type` `image/png`, `image/jpeg` or `image/webp` (any other type, SVG and GIF included, is `422 VALIDATION_FAILED` naming `/headers/content-type`), at most 256 KiB counted as it arrives (more is `422` naming `/body`, `too_large`; the REST API answers every body bound with `422`, never `413`). The server reads the format from the bytes, without an image library: a complete PNG (valid chunk CRCs, IHDR first, IDAT, IEND), JPEG (SOI, one SOF0 or SOF2 frame, a scan, EOI) or WebP (an exact RIFF size, one VP8 or VP8L image, VP8X only with ICCP, ALPH, EXIF, XMP); width and height 32 to 1024 pixels each; refused (`422`, `/body` with the reason as `code`): another format (`unsupported_format`), a format that is not the declared type (`type_mismatch`), animation (APNG `acTL`/`fcTL`/`fdAT`, the WebP animation flag, `ANIM`, `ANMF`: `animated`), a truncated or ill-formed file (`malformed`), more than 16 bytes after the end of the image (`trailing_data`), other sizes (`dimensions`). Replaces any earlier picture and answers the profile. Audited as `me.avatar.set` with revision, hash, size, type and dimensions, never the bytes | self: a person in the Web App (`web`, human; no re-authentication) |
| `DELETE /me/avatar` | **[OBSERVED]** (Wave 8, owner decision S10, `deleteMyAvatar`, `me.avatar.delete`) remove the own picture and answer the profile; no picture is not an error (nothing changes, nothing is audited); else audited as `me.avatar.delete` with the revision and the removed picture's hash | self: a person in the Web App |
| `GET /me/sessions` | own Web App sessions: public `ses_` ids, times, coarse device label, current marker; never addresses or user agents | self |
| `POST /me/sessions/{sessionId}/revoke`, `POST /me/sessions/revoke-others` | revoke one own session, or every own session except the current one | self |
| `GET /me/factors` | own factors (passkeys with label and last use, password, TOTP, remaining recovery codes); never keys, hashes or secrets | self |
| `GET /identities`, `GET /identities/{identityId}` | identities (humans; service accounts from Wave 3B). **[OBSERVED]** (Wave 8, owner decision S10) each with the optional `profileDisplayName` and `avatar` (`null` when none) | `access.read` |
| `GET /identities/{identityId}/avatar?v=<sha256>` | **[OBSERVED]** (Wave 8, owner decision S10, `getIdentityAvatar`, `identity.avatar.get`; no MCP tool) a person's picture: the stored bytes with exactly the stored media type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-cache` (revalidated on every use, so access that ends or a removed picture stops showing at once; adversarial review of Wave 8 part 2) with a strong `ETag` (the hex of the stored hash): an `If-None-Match` naming it is `304 Not Modified` without the bytes, only after the caller was authorized, `Content-Disposition: inline`, `Cross-Origin-Resource-Policy: same-origin`. The bytes are the picture as stored, without its metadata (`PUT /me/avatar`). `v` (required, `sha256:<64 hex>`) must be the hash of the current picture, so a cached address never names other bytes; the address is the `avatar.url` of `GET /me` and the identity reads. The own picture (decided as `me.get`), or anyone's with `access.read`; a caller who may read neither, an identity without a picture and an old or unknown hash are all `404 NOT_FOUND` | self, or `access.read` (a person through the Web App or the CLI) |
| `POST /identities` | invite a person: an `invited` identity without any role, and a one-time link shown once to the inviting human (inline plan, re-authentication) | `access.manage` |
| `POST /identities/{identityId}/invitation` | issue a new invitation link for an `invited` identity; the old link stops working | `access.manage` |
| `POST /identities/{identityId}/disable` | disable: sessions, ceremonies and links end in the same transaction (inline plan, re-authentication; never the last active owner; only an owner disables an owner) | `access.manage` |
| `POST /identities/{identityId}/enable-plans` | plan enabling a disabled identity | `access.manage` — plan |
| `POST /identities/{identityId}/erasure-plans` | plan the erasure of an identity (`critical`: approval, re-authentication; OD-9 self-approval with cooling period) | `access.manage` — plan |
| `GET /roles`, `GET /roles/{roleId}` | built-in roles with their explicit permissions | `access.read` |
| `GET /role-bindings` | role bindings, filter by identity and state | `access.read` |
| `POST /role-bindings`, `DELETE /role-bindings/{bindingId}` | bind or unbind a role at a scope; the response is the plan with before, after and risk analysis | `access.manage` — plan |
| `GET /policy-settings` | policy rules, defaults and configured revisions | `access.read` |
| `POST /policy-settings/plans` | plan a rule parameter change for the installation or, since Wave 7, one target (analysis tighter, weaker or unknown per parameter) | `policy.manage` — plan |
| `GET /me/grants` | connected applications of the caller: client (registration, trust), resource, scopes, restrictions, consent time, expiry, last token (Wave 3B). **[OBSERVED]** (Wave 8) `lastUsedAt` and `lastUseClass`: the minute and the class (`read`, `plan`, `apply`, `data`, `rest`) of the last request the grant authenticated, from `oauth.grant_last_use` (written at most once a minute); `null` means none is recorded, not that the grant was never used (the record began with its deployment and a background write can be lost). A data basis for "last used", never an input to a decision | self |
| `POST /me/grants/{grantId}/revoke` | revoke an own grant: every access and refresh token of it stops at once (inline plan) | self |
| `GET /grants` | grants of every identity, filter by identity and state; `lastUsedAt` and `lastUseClass` as above | `access.read` |
| `POST /grants/{grantId}/revoke` | revoke another identity's grant (inline plan, re-authentication) | `access.manage` |
| `GET /oauth-clients`, `GET /oauth-clients/{oauthClientId}` | OAuth clients with registration method, state, redirect URIs, metadata fingerprint and approval; display data is untrusted. **[OBSERVED]** (Wave 8 completion, additive) both reads also carry `lastUsedAt` (the latest recorded minute any grant of the client authenticated a request, over all of its grants, also revoked and expired ones; from `oauth.grant_last_use`, the record `GET /me/grants` shows per grant) and `activeGrantCount` (the client's grants that are neither revoked nor expired now). The list computes both in the one statement that reads the page, not per client. `lastUsedAt: null` means no use is recorded, not that the client was never used (the record began with its deployment and a background write can be lost); a data basis, never an input to a decision. The answers of the decisions (register, refresh, approve, reject, disable) leave both members out | `access.read` |
| `POST /oauth-clients/cimd` | fetch the Client ID Metadata Document of an exact `client_id` URL (SSRF-hardened) and record the client as pending review | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/refresh-metadata` | fetch a CIMD client's metadata again; a changed security fingerprint returns the client to review | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/approve` | approve exactly this client and the fingerprint that was reviewed (inline plan, re-authentication) | `access.manage` |
| `POST /oauth-clients/{oauthClientId}/reject`, `POST /oauth-clients/{oauthClientId}/disable` | reject a pending client; disable a client, ending its grants and tokens (inline plan, re-authentication) | `access.manage` |
| `GET /service-accounts`, `GET /service-accounts/{identityId}` | service accounts with their client, API keys and machine grants | `access.read` |
| `POST /service-accounts` | create a service account: a service identity with a responsible person, no role, no credential (inline plan, re-authentication); roles are bound through `POST /role-bindings` | `access.manage` |
| `POST /service-accounts/{identityId}/oauth-client` | register the service account's OAuth client with public keys (`private_key_jwt`; no secret, no private key) | `access.manage` |
| `POST /service-accounts/{identityId}/oauth-client/keys` | replace the client's public keys (rotation: add before remove) | `access.manage` |
| `POST /service-accounts/{identityId}/grants` | grant the client a bounded machine authority for the REST API: scopes, restrictions, expiry; production writes need an explicit confirmation | `access.manage` |
| `GET /api-keys` | API keys (metadata only), filter by service account | `access.read` |
| `POST /service-accounts/{identityId}/api-keys` | create an API key: shown once to the creating human, only its hash is stored; mandatory expiry (default 90, max 365 days) | `access.manage` |
| `POST /api-keys/{keyId}/revoke` | revoke an API key at once (inline plan, re-authentication) | `access.manage` |

## Audit

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /audit-events` | search, newest first; filters `from`, `to`, `target`, `action`, `actor` (`self` or `any`), `result`, and since Wave 7 `client` (a `cli_` id) and `grant` (a `grt_` id), and **[OBSERVED]** (Wave 8 completion, additive; REST only, `audit_search` has no such input) `identity` (an `idn_` id: only events whose actor is that identity; combined with `actor=self` both must hold); no plan or operation filter (an event names them in `refs`); opaque cursor. **[DECIDED]** (served from Wave 6) actors stay pseudonymous; a change description, the request pseudonyms and the decision are not part of the read view; a stored event the view cannot vouch for answers `CONTROL_PLANE_DEGRADED`, never an invented row | `audit.read` at the installation, or covering the `target` for its events only |
| `GET /audit-events/chain` | **[OBSERVED]** (Wave 8, `getAuditChain`, `audit.chain.get`; REST only, installation-wide: a restricted delegation is refused) the chain `head` (sequence, time, hash), the newest 10 `checkpoints` (sequence, hash, time, reason), the `exports` per exporter (`kind` `file`, `s3` or `other`, `up_to_date` or `behind`, last exported sequence and time, pending checkpoints; never a bucket, path or endpoint, and an exporter that was replaced stays and reads `behind`) with the worker task `audit.export`, and a `verification` **computed on this request**: incrementally from the latest checkpoint (which must match its event) to the head, read-only in one repeatable-read transaction, like `exponetdb audit verify --from-checkpoint`. `verified` (through sequence N at time T), `broken` (the failing sequence and the reason: `sequence_gap`, `prev_hash_mismatch`, `not_canonical`, `invalid_event`, `columns_mismatch`, `hash_mismatch`, `checkpoint_mismatch`, `anchor_missing`) or `not_verified` (`too_many_events`: more than 10,000 events since the latest checkpoint, or since the oldest event when there is none, so nothing is walked; or `empty_chain`). A repeat at the same head and checkpoint within 15 seconds returns the result already computed with its original time; concurrent requests share one run. **A full verification runs in the worker (daily; the incremental one hourly) and its result is not persisted**: the answer says so (`workerVerification.resultPersisted: false`) and shows only what the maintenance table keeps, the outcome, reason code and time of each task | `audit.read` |
| `GET /audit-events/export` | **[DECIDED]** (Wave 8, `exportAuditEvents`, `audit.export`; owner decision 2026-10-13, [`audit.md` §5.1](../02-control-plane/audit.md#51-export-for-offline-verification)) the stored audit events **verbatim** as `application/x-ndjson` for offline `ac1` verification: a header line (`format`, `chain`, `from`, `to`, `firstSeq`, `lastSeq`, `count`, `more`, `nextCursor`, the `checkpoints` in the range, `generatedAt`), then `{type: event, seq, prevHash, hash, event}` lines by ascending `seq`; at most 10,000 events per response, cursor; `from` (inclusive) and `to` (exclusive) are times or sequence numbers, 422 on bad input. Full events (personal data per OD-8); `Cache-Control: no-store`; audited as `audit.export` (range and count). Web App session only, owners and admins, re-authenticated within 300 s; no MCP tool, no CLI, no API key | `policy.manage` (owner, admin; not `audit.read`) |

## Installation

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /installation/health` | Control Plane health: Control Store, workers, samplers, gateway, keyring, self-check findings ([`../10-observability/self-observability.md`](../10-observability/self-observability.md)). **[OBSERVED]** (Wave 8, `getInstallationHealth`, `installation.health.get`) `components`, each with `state` (`operational`, `degraded`, `down`), `source`, `observedAt`, `reasons` (machine codes) and `values` (counts and ages): `control_store` (serve's own readiness checks), `workers` (worker heartbeats), `maintenance` and `samplers` (the task table: failing, overdue, lagging), `data_reads` (data-read worker heartbeats; without one a data read is `CAPABILITY_UNAVAILABLE`), `gateway` (gateway heartbeat and the nodes' heartbeats), `keyring` (the loaded keyring against the store) and `audit_chain` (head, checkpoints, export progress, outcome of the verification tasks). `state` is the worst of them. What this release cannot observe is in `unobserved` with a reason, never counted as operational: `gateway` with `not_applicable` while no node is enrolled and no gateway runs, `maintenance` or `samplers` with `never_registered`; the gateway's certificate is not known (see `GET /nodes/certificates`). **Limit:** the installation findings that `self-observability.md` §5 and the schema once promised are not stored (a finding needs a target), so the reasons and values of the components carry what a self-check found. No host name, build or commit is returned | `nodes.read` |
| `GET /installation` | installation id, version, contract versions, enabled features; **[OBSERVED]** (Wave 8 completion, additive) `oauthClientRegistration` (`open` or `review`, OD-5), how this installation admits a new OAuth client, so the Web App states the mode instead of guessing it | `targets.read` |

## Service endpoints (outside `/api/v1`)

| Path | Purpose | Auth |
|---|---|---|
| `/healthz/live` | process liveness | none |
| `/healthz/ready` | readiness (Control Store, migrations at expected version, keys loaded for the role) | none; returns no details publicly |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource/api`, `/.well-known/oauth-authorization-server` | discovery (RFC 9728, RFC 8414). **[DECIDED]** (G3B, D2) Not served: `/.well-known/openid-configuration` (ExponetDB issues no ID tokens) and a root `/.well-known/oauth-protected-resource` | none |
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register`, `/oauth/device_authorization` | OAuth AS (the device endpoint: RFC 8628, first-party CLI only) | per spec |
| `/mcp` | MCP | bearer |
| `GET /api/v1/openapi.json` | **[OBSERVED]** (Wave 8) the generated OpenAPI 3.1 document of `packages/contracts` (`application/vnd.oai.openapi+json;version=3.1.1`, `Cache-Control: no-store`, as for the public JSON Schemas of the manifests, which the listener serves the same way); public, it describes shapes and no data. It lists every contracted operation: one the release does not serve yet answers `404 NOT_FOUND` (`application/problem+json`) until it does, whatever its `x-exponetdb-wave` says | none |

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
