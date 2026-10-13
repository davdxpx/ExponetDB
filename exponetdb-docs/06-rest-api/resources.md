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
| `GET /targets` | list targets (filters: product, project, environment, tier, state) | `targets.read` | grant target restrictions applied: a restricted grant sees only its targets |
| `GET /fleet` | **[OBSERVED]** (Wave 8, `getFleet`, `fleet.get`; REST only, no MCP tool; [`../10-observability/health.md` §10](../10-observability/health.md#10-fleet-overview-and-findings-across-targets)) one request: `targets` (the targets the caller may list that are not decommissioned, by tier, by health state and by source; `unknown` is a state of its own and a never-sampled or lagging target is counted there, never healthy; `decommissioned` counted apart), `findings` (open findings by severity) and `operations` (`running`, `needs_attention`, `awaiting_approval`). Every part carries `source`, `observedAt`, `lowerBound` and `lowerBoundReason`; a part the caller may not see is `{available: false, reason: "permission_denied"}`, never zero. A failed read is an error for the whole request. Computed with a fixed number of queries whatever the number of targets | `targets.read` (the target list's permission and visibility); the findings part also needs `diagnostics.read`; the operations part is filtered by the operation read rule | |
| `GET /targets/{id}` | target detail with placement summary (cluster id and name, generation, version; never an address) | `targets.read` | `{id}` = `tgt_…` or URL-encoded path |
| `POST /targets` | register target (project, environment, database) | `registry.manage` | plan (stamps identity, initializes the empty ledger); prod tier: approval and re-authentication (`target.register-prod-approval`) |
| `POST /targets/{id}/suspend`, `POST /targets/{id}/resume` | stop / allow writes | `registry.manage` | plan |
| `POST /targets/{id}/decommission` | retire target | `registry.manage` | plan (`critical`) |
| `GET /servers`, `POST /servers`, `GET /servers/{id}` | servers | read: `nodes.read`; write: `registry.manage` | write: plan |
| `GET /clusters`, `GET /clusters/{id}` | clusters (state, observed facts, tier) | `nodes.read` | |
| `POST /clusters/{id}/confirm` | confirm a cluster (pins `system_identifier`; refuses the Control Store's own cluster) | `registry.manage` | plan; re-authentication |
| `POST /clusters` | register external cluster (CA bundle, endpoints) | `registry.manage` | plan; re-authentication |
| `GET /clusters/{id}/bootstrap-sql` | role bootstrap SQL for a person to run (no password) | `registry.manage` | Wave 4 |
| `GET /clusters/{id}/endpoints`, `POST /clusters/{id}/endpoints` | endpoints | `registry.manage` | addresses visible only to `registry.manage`; POST: plan, re-authentication |
| `POST /clusters/{id}/endpoints/{endpointId}/retire` | retire an endpoint (a changed address is a new endpoint) | `registry.manage` | plan; re-authentication |
| `GET /clusters/{id}/databases`, `POST /clusters/{id}/databases` | databases (external clusters: register an existing database; agent clusters: create via node capability, Wave 5) | `registry.manage` | plan |
| `GET /clusters/{id}/credentials` | credential metadata (role, state, times) | `registry.manage` | never a secret or a secret reference |
| `POST /clusters/{id}/credentials/{role}` | write-only credential submission (external clusters) | `registry.manage` | Web App, re-authentication; `202` with the pending metadata; never readable |
| `POST /clusters/{id}/role-verifiers` | write-only SCRAM verifier submission for consumer login roles | `registry.manage` | Wave 5 (roles capability) |

## Schema and drift

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /targets/{id}/schema` | overview: schemas, object counts, fingerprint | `schema.read` |
| `GET /targets/{id}/schema/objects/{kind}/{qualifiedName}` | object detail | `schema.read` |
| `GET /targets/{id}/schema/search?q=` | search objects | `schema.read` |
| `GET /targets/{id}/schema/fingerprint` | current fingerprint + document reference | `schema.read` |
| `POST /schema-diffs` | diff two targets or fingerprints | `schema.read` |
| `POST /targets/{id}/drift-checks` | run drift check | `schema.read` |
| `GET /findings?severity&state&kind&target&cursor&limit` | **[OBSERVED]** (Wave 8, `listFindings`, `finding.list`; REST only) findings across the targets the caller may read with `diagnostics.read` (the visibility of `GET /targets/{id}/findings`: grant scopes narrowed by a delegation), newest first (finding ids are ULIDs), keyset pages by an opaque cursor, `limit` 1 to 200 (default 50; above 200 is `VALIDATION_FAILED`, `422`). `severity` (`info`, `warning`, `critical`), `state` (`open` by default, `resolved`, `all`), `kind` (`drift`, `health`) and `target` (`tgt_` id or URL-encoded path; unknown or invisible is `TARGET_NOT_FOUND`); any other value or parameter is `VALIDATION_FAILED`. Each item is the per-target `Finding` plus `targetId` and `targetPath` | `diagnostics.read` |
| `GET /targets/{id}/findings` | findings (drift, advisors, health) | `diagnostics.read` |
| `POST /findings/{id}/accept` | `drift.accept` | `schema.manage` (admin) — plan |

## Queries

| Method & path | Purpose | Scope |
|---|---|---|
| `POST /targets/{id}/queries` | run a read-only query | `data.read:<tier>` |
| `POST /sql/classifications` | **[OBSERVED]** (Wave 8, `classifySql`, `sql.classify`; REST only, no MCP tool) classify submitted SQL statement by statement with the parser: no target is touched, nothing is executed, stored, logged or audited, and the text is never echoed. Body `{ sql, postgresMajor? }` (at most 64 KiB of UTF-8 bytes and 200 statements, else `422 VALIDATION_FAILED` naming `/sql` and the bound; grammar 16, 17 or 18, default 17). Answer: `status` (`parsed`, `empty`, `parse_error`), per statement the `start` and `end` (`line`, `column` in code points, `offset` in UTF-16 code units), the parser's node `kind`, a `label`, the `classes` (`read_only`, `write`, `destructive`, `rewrite`, `non_transactional`, `security`), `procedural`, `readOnlyPath` with the admission's refusal code and reason, and the migration engine's refusal reason; the whole-text `readOnlyPath`; a syntax error as a result with its `parseError.position`. Installation-level `migrations.read` (a tier-restricted delegation reads it: it names no target). The mapping from facts to classes and the position units: [`sql-execution-security.md` §2.5](../03-database-model/sql-execution-security.md#25-statement-classification-for-the-web-app-wave-8) | `migrations.read` |
| `POST /targets/{id}/explain` | EXPLAIN / EXPLAIN ANALYZE (read-only) | `data.read:<tier>` |
| `POST /targets/{id}/queries/{queryId}/cancel` | cancel own running query (Wave 7: the caller names the query by the `qry_` id it chose; another caller's query reads as not found) | `data.read:<tier>`, same identity, client and grant as the query |

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
| `POST /targets/{id}/migrations/import-analyses` | plan a legacy import analysis: replay on an explicit, empty scratch target of the same project, compare, classify into an import report (`migration.import.replay`) | `migrations.import` |
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
| `POST /break-glass-grants` | activate break-glass (human, re-auth, reason, rules, targets, duration) | `breakglass.activate` (Web App/CLI session only) |
| `POST /break-glass-grants/{id}/review` | post-incident review | admin |

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
| `GET /targets/{id}/health` | health with sub-states | `diagnostics.read` |
| `GET /targets/{id}/health/history?from&to` | **[OBSERVED]** (Wave 8, `getTargetHealthHistory`, `target.health.history.get`; REST only, no MCP tool) the sampled history of one target from `observation.health_samples` (one sample about every 15 seconds, daily partitions, kept 3 to 60 days, 14 by default). `from` and `to` (RFC 3339 UTC; default the last 24 hours; at most 60 days, none in the future, else `VALIDATION_FAILED`). Downsampled to at most 501 buckets whose size the answer returns (`bucketSeconds`, aligned to multiples of itself; a bucket exists only if a sample landed in it): per bucket the `worst` state (order unreachable, unhealthy, degraded, suspended, unknown, healthy: a bucket holding an `unknown` sample is never `healthy`) and the count of every state. **Gaps**: intervals between two samples longer than 30 seconds (twice the period), clipped to the range, at most 200 (`gapsTruncated`), each with a derived `cause`: `control_plane_down` (no worker heartbeat covered the interval; `reason` `no_live_process` or `no_live_worker`), `sampler_lagging` (a worker was alive and wrote no sample), `unknown` with `heartbeats_pruned` (heartbeat rows are kept a day after a process stopped, so older intervals without a live worker cannot be explained). Nothing before the first retained sample (`firstSampleAt`) and nothing after a decommissioned target stopped being sampled is a gap; `node_offline` cannot be derived (a node keeps only its current state) and a failed sample is a sample. An invisible or unknown target reads as `TARGET_NOT_FOUND` | `diagnostics.read` |
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
| `GET /me` | current identity, its bindings, the effective permissions per scope (a projection of the live bindings, never a token), the session | self |
| `GET /me/sessions` | own Web App sessions: public `ses_` ids, times, coarse device label, current marker; never addresses or user agents | self |
| `POST /me/sessions/{sessionId}/revoke`, `POST /me/sessions/revoke-others` | revoke one own session, or every own session except the current one | self |
| `GET /me/factors` | own factors (passkeys with label and last use, password, TOTP, remaining recovery codes); never keys, hashes or secrets | self |
| `GET /identities`, `GET /identities/{identityId}` | identities (humans; service accounts from Wave 3B) | `access.read` |
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
| `GET /oauth-clients`, `GET /oauth-clients/{oauthClientId}` | OAuth clients with registration method, state, redirect URIs, metadata fingerprint and approval; display data is untrusted | `access.read` |
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
| `GET /audit-events` | search, newest first; filters `from`, `to`, `target`, `action`, `actor` (`self` or `any`), `result`, and since Wave 7 `client` (a `cli_` id) and `grant` (a `grt_` id); no plan or operation filter (an event names them in `refs`); opaque cursor. **[DECIDED]** (served from Wave 6) actors stay pseudonymous; a change description, the request pseudonyms and the decision are not part of the read view; a stored event the view cannot vouch for answers `CONTROL_PLANE_DEGRADED`, never an invented row | `audit.read` at the installation, or covering the `target` for its events only |
| `GET /audit-events/chain` | **[OBSERVED]** (Wave 8, `getAuditChain`, `audit.chain.get`; REST only, installation-wide: a restricted delegation is refused) the chain `head` (sequence, time, hash), the newest 10 `checkpoints` (sequence, hash, time, reason), the `exports` per exporter (`kind` `file`, `s3` or `other`, `up_to_date` or `behind`, last exported sequence and time, pending checkpoints; never a bucket, path or endpoint, and an exporter that was replaced stays and reads `behind`) with the worker task `audit.export`, and a `verification` **computed on this request**: incrementally from the latest checkpoint (which must match its event) to the head, read-only in one repeatable-read transaction, like `exponetdb audit verify --from-checkpoint`. `verified` (through sequence N at time T), `broken` (the failing sequence and the reason: `sequence_gap`, `prev_hash_mismatch`, `not_canonical`, `invalid_event`, `columns_mismatch`, `hash_mismatch`, `checkpoint_mismatch`, `anchor_missing`) or `not_verified` (`too_many_events`: more than 10,000 events since the latest checkpoint, or since the oldest event when there is none, so nothing is walked; or `empty_chain`). A repeat at the same head and checkpoint within 15 seconds returns the result already computed with its original time; concurrent requests share one run. **A full verification runs in the worker (daily; the incremental one hourly) and its result is not persisted**: the answer says so (`workerVerification.resultPersisted: false`) and shows only what the maintenance table keeps, the outcome, reason code and time of each task | `audit.read` |

## Installation

| Method & path | Purpose | Scope |
|---|---|---|
| `GET /installation/health` | Control Plane health: Control Store, workers, samplers, gateway, keyring, self-check findings ([`../10-observability/self-observability.md`](../10-observability/self-observability.md)). **[OBSERVED]** (Wave 8, `getInstallationHealth`, `installation.health.get`) `components`, each with `state` (`operational`, `degraded`, `down`), `source`, `observedAt`, `reasons` (machine codes) and `values` (counts and ages): `control_store` (serve's own readiness checks), `workers` (worker heartbeats), `maintenance` and `samplers` (the task table: failing, overdue, lagging), `data_reads` (data-read worker heartbeats; without one a data read is `CAPABILITY_UNAVAILABLE`), `gateway` (gateway heartbeat and the nodes' heartbeats), `keyring` (the loaded keyring against the store) and `audit_chain` (head, checkpoints, export progress, outcome of the verification tasks). `state` is the worst of them. What this release cannot observe is in `unobserved` with a reason, never counted as operational: `gateway` with `not_applicable` while no node is enrolled and no gateway runs, `maintenance` or `samplers` with `never_registered`; the gateway's certificate is not known (see `GET /nodes/certificates`). **Limit:** the installation findings that `self-observability.md` §5 and the schema once promised are not stored (a finding needs a target), so the reasons and values of the components carry what a self-check found. No host name, build or commit is returned | `nodes.read` |
| `GET /installation` | installation id, version, contract versions, enabled features | `targets.read` |

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
