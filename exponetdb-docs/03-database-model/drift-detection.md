# Drift detection

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (fingerprints), Wave 6 (ledger drift), Wave 8 (UI), Wave 10 (REOSA) |
| Read before | [`schema-fingerprints.md`](./schema-fingerprints.md), [`../04-migrations/ledger.md`](../04-migrations/ledger.md) |

Drift is any difference between two things that should agree. ExponetDB detects
it; it never "fixes" drift automatically. Each drift item becomes a **finding**
with a suggested resolution that is itself a planned operation.

**[DECIDED]** Drift detection is framework-agnostic: it works on PostgreSQL
catalogs, ledgers and bundles. It does not assume Drizzle or any ORM; an ORM
schema is an optional additional reference
([`../04-migrations/authoring-and-ci.md` §7](../04-migrations/authoring-and-ci.md#7-framework-adapters-orm-neutrality)).

## 1. References and the drift kinds between them

```
   source (bundles in the repository)
            │  (A) source ↔ ledger
            ▼
   ledger (what was applied, per target)  ◀── (B) ledger ↔ mirror ──▶  Control Store mirror
            │  (C) expected ↔ actual
            ▼
   actual schema (fingerprint of the target)
            │  (D) environment ↔ environment
            ▼
   actual schema of the evidence environment
            (E) desired cluster state ↔ actual cluster state (roles, settings, extensions)
            (F) ORM schema ↔ expected schema (optional adapter)
```

| Kind | Compares | Finding examples | Severity |
|---|---|---|---|
| **A** source ↔ ledger | bundles in the submitted source vs the target ledger | `pending_in_source` (normal), `applied_not_in_source` (bundle deleted or on an abandoned branch), `checksum_differs_from_source` | info / warn / critical |
| **B** ledger ↔ mirror | target ledger vs Control Store mirror | rows written outside ExponetDB, rows missing after restore, checksum change | critical (blocks schema changes) |
| **C** expected ↔ actual | the target's current fingerprint vs the `fingerprint_after` of its last applied migration (or the baseline) | out-of-band DDL: object added, dropped, altered (incl. ACLs, policies, function bodies) | warn; critical for security-relevant classes (ACL, RLS, policy, security definer, `search_path`) |
| **D** environment ↔ environment | target vs its evidence target (both fingerprints) | staging has an index production lacks; production policy differs (REOSA: `tenant_members_select_own`) | info / warn |
| **E** cluster desired ↔ actual | declared roles, role settings, memberships, extensions, `pg_hba`, configuration vs node/cluster observation | role missing, role attribute changed (`BYPASSRLS`), role setting lost after a move | warn / critical |
| **F** ORM ↔ expected | ORM shape vs fingerprint document of baseline+bundles | column in ORM not in DB (future `42703`) | warn (CI) |

## 2. How C works without a "desired schema file"

ExponetDB does not need a declarative target schema to detect structural drift:
every applied migration records `fingerprint_after`, and the canonical document
for it is stored. **The last recorded document is the expected state.** If the
current fingerprint differs and no ExponetDB operation explains it, something
changed out of band. The diff of the two documents names the objects and
attributes.

## 3. Schedule and triggers

- On every plan (implicit: plans bind to the current fingerprint and ledger).
- After every operation (verification L3).
- Periodically per target (default every 15 minutes for prod tier, 60 minutes for
  nonprod; computing a fingerprint is cheap, see fingerprint doc §7).
- On demand (`drift_check` tool, REST, Web App).
- After restores and placement changes.

## 4. Triage (adopted from the Supabase reference's config-drift UX)

**[DECIDED]** Each compared item lands in exactly one bucket:

| Bucket | Meaning |
|---|---|
| `drifted` | the references disagree |
| `matched` | they agree |
| `unmanaged` | outside managed scope, or present but intentionally not tracked (e.g. `unmanaged_but_present` objects accepted during legacy import) |

The Web App shows drifted items first, with "expected" and "actual" side by side,
the time window in which the change happened (between two fingerprints), and
whether an operation explains it. **[OBSERVED]** The Supabase reference's
`ConfigDrift` surface uses the same three-way triage for configuration and
distinguishes "declared in the file" from "equal to a default"; ExponetDB applies
the idea to schema, ACLs and cluster state.

## 5. Resolutions

| Resolution | Operation | Effect |
|---|---|---|
| Adopt actual as expected | `drift.accept` (Wave 8; records the current document as expected, with a reason when the drift is security-relevant) | findings resolved `accepted`; no DDL |
| Restore expected | authored forward migration (bundle) | normal migration path |
| Explain | link to an operation or external change record | finding annotated |
| Ignore class | project configuration (e.g. exclude a schema) | scope change, audited |

`drift.accept` on prod tier requires approval, because it turns an unreviewed
change into the baseline future plans bind to.

**[DECIDED]** (Wave 8, order §9 endpoint 3; `packages/diagnostics/src/drift-accept.ts`)
`drift.accept` as built:

- **Plan.** `POST /api/v1/findings/{finding}/accept` (action
  `drift.accept.plan`, permission and scope `schema.manage`, a person through
  the Web App or the CLI only; an agent, an MCP client or a service account
  is refused, and `schema.manage` is never delegable) answers `201` with a
  plan of kind `drift.accept`, applied through `POST /plans/{id}/apply`. The
  finding must be an open drift finding of an active target: another kind is
  `422 VALIDATION_FAILED` (`/finding`, `not_drift_finding`), a resolved one
  `409 REGISTRY_CONFLICT` (reason `finding_resolved`), an unknown one
  `404 NOT_FOUND`, a target that is not active `REGISTRY_CONFLICT`
  (`target_state`). `serve` takes a live snapshot with the project's managed
  scope on an observer session whose identity marker it checks first; an
  incomplete one is refused (`snapshot_incomplete`). The plan **covers every
  open drift finding of the target** (the new baseline is the whole schema,
  so all of them are absorbed; at most 2,000), whichever one was named.
  When a covered finding is `critical` or security-relevant (§6), the body
  must carry a `reason` (10 to 1,000 characters, stored verbatim in the plan
  and the audit, untrusted); without one the request is `422`
  (`/reason`, `reason_required`). Class `standard` on nonprod, `high` on
  prod.
- **Bindings.** The plan binds the target (id, generation, and the
  installation through the identity marker read with each snapshot), the
  project's managed scope, the target's current baseline, the open drift
  findings it covers and the `fp1` fingerprint it will record. At
  acceptance and again under the locks (the target's schema domain, so no
  migration records a baseline at the same time) a live snapshot is taken:
  a changed fingerprint, an incomplete snapshot, another baseline, a drift
  finding opened since planning, another scope, generation or state is
  `PLAN_STALE` (bindings `schemaFingerprint`, `baseline`, `findings`,
  `scope`, `generation`, `target`). A covered finding resolved meanwhile
  changes nothing.
- **Apply.** The worker takes a new complete snapshot with the plan's scope
  and requires exactly the planned fingerprint; then one Control Store
  transaction, under the drift check's lock and while the worker still holds
  the operation's lease, re-checks the bindings, stores the snapshot
  (purpose `drift_accept`), records it as the baseline (reason
  `drift_accept`, the operation id), resolves the covered findings that are
  still open as `accepted` and appends the `drift.accept` audit event (ids,
  counts, fingerprints, the reason; never object names). Nothing is written
  to the target.
- **Verify** re-reads: the operation's baseline has the planned fingerprint,
  the target's live fingerprint equals it, and every covered finding is
  resolved. **Reconcile** reads the operation's baseline row. The next drift
  check compares with the accepted schema.
- Production: policy rule `drift.accept-prod` (approval and re-authentication,
  [`../02-control-plane/policy-engine.md`](../02-control-plane/policy-engine.md)),
  re-checked by the worker before it starts. Proven by
  `apps/server/test/http-drift-accept.int.test.ts` (PostgreSQL 17) and
  `packages/diagnostics/test/drift-accept.test.ts`.

## 6. Security-relevant drift

**[DECIDED]** Drift in these classes is `critical` and pages the owner (when
alerting exists, Wave 9): ACL changes on tables, columns, functions, schemas;
default privileges; RLS disabled or no longer forced; policy added, removed or
changed; function `SECURITY DEFINER` or `proconfig` changes; role attribute
changes (`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`); new login roles; `pg_hba`
changes.

**[DECIDED]** (G4 correction, 2026-10-07) Also `critical`: an extension's
member set (an object moved into or out of an extension with `ALTER
EXTENSION … ADD/DROP`, which takes it out of or back into the fingerprint),
a view's options (`security_invoker`, `security_barrier`, `check_option`),
and the body (`bodyDigest`, `sqlBody`) or argument defaults of a function
that is `SECURITY DEFINER` before or after the change (`criticalDrift` in
`packages/postgres`). The `securityRelevant` flag of a diff keeps the
classification frozen in `tooling/golden/schema-diff.json`; the severity of a
drift finding follows this section, so such a finding is `critical` with
`securityRelevant: false`.

**[OBSERVED]** REOSA's August 2026 incident (same migrations, different effective
privileges on staging and production due to `pg_default_acl`) and the missing
`0014` policy fix on production are exactly class C/D security drift that went
unnoticed for weeks.

## 7. Wave 4 implementation (kind C)

**[DECIDED]** (Wave 4, `packages/diagnostics`; order §137 to §142) Until the
migration engine exists (Wave 6), the expected schema of a target is its
latest **baseline**: the registration snapshot (taken by `target.register`
after the identity read-back, stored as the baseline only when it is
complete) or an accepted drift (`drift.accept`, Wave 8, §5). The provenance is
recorded (`reason`, operation). Wave 6 supersedes it with the last verified
`fingerprint_after`. The current schema is never taken as expected.

- A check takes the current snapshot with the **baseline's** managed scope,
  so the two fingerprints are comparable; schemas outside that scope are
  counted as `unmanaged`, never as matched. A project scope change takes
  effect for drift with the next baseline.
- Statuses: `clean`, `drifted`, `no_baseline` (no complete registration
  snapshot), `incomplete` (the snapshot has a visibility gap),
  `not_comparable` (another canonicalizer or PostgreSQL major: the structure
  is still diffed, nothing is called drift) and `failed` (the read failed;
  the check records the error code). Only `clean` and `drifted` change
  findings; a failed or partial view is never "clean".

**[DECIDED]** (Wave 6, `MigrationBaselineStore` in `packages/diagnostics`,
recorded by the migration kinds) Once a migration operation's verification
passed (or a rollback's), the worker takes a snapshot with the project's
managed scope and, when it is complete and has exactly the fingerprint the
verification saw (the last migration's `fingerprint_after`, or the
rollback's verified fingerprint), stores it and records it as the target's
baseline (reason `migration`). A drift check compares with that baseline, so
ExponetDB's own migrations are never drift and a change outside them is. A
snapshot that differs or is incomplete is not adopted: the earlier baseline
stays and the next check reports the difference; the operation's outcome
never depends on it. Proven by `apps/server/test/http-migrations.int.test.ts`
(clean after the migration, one drifted object after an out-of-band
column, clean again once it is undone; the assertion fails without the
baseline).

**[DECIDED]** (Wave 9 Part A, follow-up 3, F4, 2026-10-23) The baseline of a
legacy import is recorded the same way once its verification passes, in the
baseline operation itself or in a planned re-verification of
`baseline:<slug>` ([`legacy-import.md` Step
7](../04-migrations/legacy-import.md#step-7-verify)): the snapshot the
verification saw becomes the target's baseline (reason `migration`, the
operation that verified it). **[OBSERVED]** Before this change the baseline
kind never recorded one, so every migration applied between the
registration and the import analysis stayed a drift finding although the
import reviewed it (348 open findings, 17 critical, on `reos-db-01`). Once a
baseline's verification passes, the next drift check compares with the
reviewed schema and those findings resolve `cleared`, by that check. The
operation that explains them is the one the new baseline names
(`schema_baselines.operation_id`, shown with the check's
`baselineFingerprint`); a finding's `explainedByOperationId` stays `null`
(nothing sets it yet, here or for a verified migration). **[DECIDED]**
(follow-up 4, 2026-10-24) After migrations applied on top of the baseline,
a baseline verification that passes (through the chain of those verified
migrations) records the end of that chain, the newest verified schema, so
the reference never moves back to an older state; it catches up a
migration verified later through `migration.verify`, which records none.
- Each drifted object is one finding (`object_added`, `object_removed`,
  `object_changed`), deduplicated by kind, code and object (`C:<code>:<class>:`
  SHA-256 of the canonical key): seen again it counts one more occurrence on
  the same row; gone, it is resolved `cleared`, or `superseded` when the same
  object now drifts another way. Resolved findings stay as history.
- Severity follows §6, conservatively: a changed `acl` or `owner` of any
  object; default privileges, policies and event triggers added, removed or
  changed; a table's row security flags changed (disabled or no longer
  forced, and also enabled or forced, which is equally unexplained); a
  function's `securityDefiner` or `config` changed; a `SECURITY DEFINER`
  function added or removed. These are `critical`; other drift is `warning`
  (pinned by `tooling/golden/schema-diff.json`). Role attributes are cluster state (kind E) and are not part of
  a target fingerprint; they are not checked in Wave 4.
- Finding details hold the object's class, canonical key, label, the changed
  attribute names and the entry hashes, never attribute values (function
  bodies, settings text); the drift check response, which needs `schema.read`,
  shows the expected and actual values of the changed attributes.
- At most 500 new findings per check; the rest is one `drift_overflow`
  finding with the count, and nothing open is resolved because it was left
  out. The overflow is `critical` when any item it leaves out is critical
  (§6, also critical only by severity, such as a view's options); its
  details' `securityRelevant` keeps the diff contract's classification
  (G4 correction review, 2026-10-07).
- Schedule: every 15 minutes for production targets and every 60 minutes for
  nonprod (§3), plus on demand (`POST /targets/{id}/drift-checks`). Drift
  never changes the database.
- **[OBSERVED]** (Wave 8 completion) The history of the checks is readable:
  `GET /targets/{id}/drift-checks` lists the rows of `observation.drift_checks`
  of the target, newest first (`finished_at`, then the check id, on the index
  `drift_checks_latest`), whatever started them (the worker's schedule or an
  identity), with the status, both fingerprints, the six counts, the error
  code of a failed check and the start and end times
  ([`../06-rest-api/resources.md`](../06-rest-api/resources.md#schema-and-drift)).
  The findings a check saw are not stored per check, so the list has none; a
  finding names the checks that opened and resolved it. It needs
  `diagnostics.read` at the target, like the findings. No MCP tool.
