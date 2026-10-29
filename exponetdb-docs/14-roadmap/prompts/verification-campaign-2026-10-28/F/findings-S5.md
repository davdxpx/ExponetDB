### [P2] A plan that stops part-way leaves the drift baseline behind: every later verified bundle reads as drift (34 findings, 6 critical) until a person accepts all of it
- **Area:** `packages/diagnostics` (`MigrationBaselineStore.record`), drift baseline, `drift.accept`
- **Block:** B
- **Reproduction:** PostgreSQL 17 baselined target; plan 5 bundles in one plan where the 4th fails (see the `ALTER COLUMN TYPE` finding); apply the 3 remaining bundles in two later plans; `exdb drift check lab/platform/rhstg`. Scripts: `B/rehearsal/scripts/apply_under_load.sh`, `author_bundles.sh`, `steps/10-drift-check-clean.sh`.
- **Expected:** `drift-detection.md` §7: "ExponetDB's own migrations are never drift"; the baseline "never moves back; it catches up".
- **Actual:** `observation.schema_baselines` has 2 rows (registration, baseline import) after 8 applied and verified bundles. The part-way operation (`verification_failed`) records none; the next plan's pre-fingerprint differs from the stored baseline, so `record()` returns `drift_open` and never adopts. The drift check reports 34 drifted objects (6 critical: 2 policies, 3 views and a matview whose ACL "changed"), all effects of verified bundles. The only exit is `drift.accept`, which adopts everything open (REST `POST /findings/{id}/accept` and the Web App; no CLI command), including any real out-of-band change from the same period. PostgreSQL 16 and 18, where every plan succeeded, ended clean.
- **Evidence:** `B/rehearsal/results/drift-after-8-verified-bundles.txt`, `apply-first5-failed-at-bundle4.txt`, `pg18-part.txt`; code `packages/diagnostics/src/migration-baselines.ts` (`record`, lines 44-60).
- **Root cause:** suspected: the baseline advances only per successful operation and compares the pre-fingerprint with the stored baseline; a partially applied operation breaks the chain and nothing repairs it from the ledger's `fingerprint_after`.
- **Proposed fix:** advance the baseline per verified bundle (ledger rows carry `fingerprint_after`) or accept a pre-fingerprint equal to the ledger head's `fingerprint_after`; offer per-finding or per-operation accept.
- **Acceptance test:** integration: 3 bundles, the 3rd fails, the next plan applies: the drift check is clean; a GRANT made between the two plans is still reported.

### [P2] ALTER COLUMN TYPE on a column a view reads: the plan is silent, the apply fails 0A000 after earlier bundles were applied, and the offered remedy does not fit
- **Area:** `packages/migrations/src/lint`, plan analysis, CLI operation text
- **Block:** B
- **Reproduction:** bundle `ALTER TABLE public.crm_items ALTER COLUMN amount TYPE numeric(16,4);` (the views `crm_overview` and `mv_crm_pipeline` read `amount`) as the 4th of 5 bundles in one plan; `exdb migration plan`, `exdb plan apply --wait`. Working form: `scripts/b4-final-up.sql`.
- **Expected:** the plan names the dependent views (`pg_depend`/`pg_rewrite`), or lint marks it; the failure shows the PostgreSQL message.
- **Actual:** plan allowed, lock severity critical, `rewriteRisk` 182 MB, nothing about dependents. Apply: bundles 1-3 applied and passed, bundle 4 `not_applied` `MIGRATION_EXECUTION_FAILED` sqlstate 0A000, operation `verification_failed`, "Nothing was rolled back" and "Next: exponetdb migration resume <migration>" (resume is for non-transactional bundles; this one was transactional). The statement's error text is not shown.
- **Evidence:** `B/rehearsal/results/apply-first5-failed-at-bundle4.txt`, `plan-risk-first-5.txt`.
- **Root cause:** analysis is per statement and offline, with no dependent-object read; the next-step text is chosen from state, not from the bundle's mode.
- **Proposed fix:** a plan fact "objects depending on this column" with a blocking flag for views; show the failed statement's message; offer resume only for non-transactional bundles.
- **Acceptance test:** the plan lists `crm_overview` and `mv_crm_pipeline` as blocking dependents; the failed operation shows the PostgreSQL message and no resume hint.

### [P2] A clone that takes the registered name is healthy, drift-clean and plannable; apply is refused only as PLAN_STALE without a cause
- **Area:** registry identity check (database oid), plan, health, drift
- **Block:** B
- **Reproduction:** `scripts/traps_swap.sh`, `traps_swap2.sh` on `lab/platform/rh18`: `CREATE DATABASE c TEMPLATE lab_rh18`; rename the original away; rename `c` to `lab_rh18`; `target show`, `drift check`, `migration plan`, `plan apply`.
- **Expected:** the registry recorded oid 16517, the clone has 32766 and the same marker: `database_mismatch` in health or plan.
- **Actual:** target show healthy; drift clean; plan allowed; `plan apply`: `PLAN_STALE` "The plan no longer matches the target. Create a new plan." for the old plan and for a plan made against the clone; the plan is then invalidated; a new plan is allowed again (the operator loops). Nothing ran on the clone. `scratch-check` knows `database_mismatch`; the normal path does not surface it.
- **Evidence:** `B/rehearsal/results/traps-swap.txt`, `traps-swap2.txt`.
- **Root cause:** the oid is compared only in the apply binding; health, drift and plan do not compare it; `PLAN_STALE` carries no binding name.
- **Proposed fix:** compare the oid in the identity probe (condition, suspend) and refuse the plan; add `details.binding` to `PLAN_STALE`.
- **Acceptance test:** after the swap `target show` is not healthy and plan fails with a typed `DATABASE_MISMATCH` naming recorded and observed oid.

### [P2] A renamed or missing database turns `migration plan` into INTERNAL
- **Area:** `apps/server` error mapping of `TARGET_SQL_ERROR`
- **Block:** B
- **Reproduction:** `ALTER DATABASE lab_rh18 RENAME TO lab_rh18_renamed`; wait 5 s; `exdb target show` (unreachable); `exdb migration plan <id> --target lab/platform/rh18`.
- **Expected:** a typed `TARGET_UNREACHABLE` with the target id.
- **Actual:** `Error INTERNAL ... (request req_...)`; the serve journal logs `http.request_failed errorCode TARGET_SQL_ERROR droppedFields errorMessage` (the 3D000 cause is dropped).
- **Evidence:** `B/rehearsal/results/rename-plan-internal.txt`, `traps-swap.txt`.
- **Root cause:** `TARGET_SQL_ERROR` has no HTTP mapping on the plan route (same class as `F/findings-C1.md` Control Store errors and `F/findings-S4.md` backup requirement).
- **Proposed fix:** map connection and catalog errors on the plan route to the unreachable code and keep the SQLSTATE in details.
- **Acceptance test:** a plan against a renamed database returns the typed code, not 500.

### [P2] A hot standby behind the registered endpoint is healthy and plannable; the apply fails as OUTCOME_UNKNOWN
- **Area:** health probes, `migration.apply` error mapping
- **Block:** B
- **Reproduction:** `scripts/traps_replica.sh`: a streaming standby of the restored primary, endpoint added, the primary's retired; `exdb health`, `migration plan`, `plan apply --wait`.
- **Expected:** a read-only state is reported; the apply is refused up front or `TARGET_READ_ONLY`.
- **Actual:** health healthy, no condition; plan allowed; apply: execute failed, reconcile succeeded, migration `not_started`, "Nothing was applied", but `OUTCOME_UNKNOWN: The operation ended failed`. After `pg_ctl promote` the same apply passed.
- **Evidence:** `B/rehearsal/results/traps-replica.txt`.
- **Root cause:** probes do not read `pg_is_in_recovery()`; the 25006 refusal is not classified.
- **Proposed fix:** add `in_recovery` to the identity/activity probe and a `target_read_only` condition; classify 25006 before any statement.
- **Acceptance test:** with the endpoint on a standby, health has a critical condition and the apply ends `failed/not_applied` with `TARGET_READ_ONLY`.

### [P2] Adding an endpoint of a different instance is applied without a check and suspends the affected targets within seconds; recovering a production target takes plan, approval and 50 s
- **Area:** `registry.endpoint.add`, health identity probe, `target.resume`
- **Block:** B
- **Reproduction:** `scripts/traps_logical.sh` (a new instance filled by `pg_dumpall | psql`, another system identifier; `exdb cluster endpoint add <cluster> --port 55527 ...`; apply; wait 10 s), then `steps/33`, `steps/34`.
- **Expected:** the plan probes the endpoint (system identifier) and denies or warns before writing it.
- **Actual:** plan allowed (tier prod because the cluster hosts a production target; approval only), apply succeeds, probes give `identity_mismatch critical`; the targets whose database exists on the foreign instance (`rhprod`, `rhrep`) are `suspended` (`TARGET_SUSPENDED` reason `identity_mismatch`), every other target of the cluster `unhealthy` (the stack's production target too). Nothing was written to the wrong instance. Recovery: endpoint retire (plan, approval, apply), then `target resume --reason` per target (the production one: plan + approval, 50 s). A typo in a port can take all of a cluster's targets offline.
- **Evidence:** `B/rehearsal/results/traps-logical.txt`; timings `lg-*`, `prod-apply-resume-prod` in `timings.tsv`.
- **Root cause:** `cluster confirm` (system identifier) exists but is not part of `endpoint.add`.
- **Proposed fix:** probe the endpoint at plan time with the cluster credentials, show the identity in the plan, deny on a different system identifier.
- **Acceptance test:** planning an endpoint of an instance with another system identifier is denied with both identifiers named; no target changes state.

### [P2] The documented database move has no executable path: a copy of a registered target is refused in every environment and nothing re-stamps the marker
- **Area:** `legacy-import.md` §5, target register, registry
- **Block:** B
- **Reproduction:** `steps/35-*.sh`, `36-*.sh` (PostgreSQL 18): register a target, `pg_dump | pg_restore` into a new database, `target decommission` (step-up), register the new database in the same environment, then in a new one.
- **Expected:** §5: "the restore operation re-stamps the identity marker with a new generation; the ledger and baseline remain valid".
- **Actual:** same environment: `REGISTRY_CONFLICT` reason `path_taken` (the decommissioned target keeps its path); new environment: `TARGET_REGISTRATION_REFUSED` reason `other_target`. The CLI command list has nothing that re-stamps a marker. Only dropping the copied `exponetdb` schema works (tested on a clone), which discards ledger and baseline (a new import). The documented REOSA move cannot keep its history this way.
- **Evidence:** `B/rehearsal/results/traps-clone.txt`; server logs `mv-*.log` on vc-2.
- **Root cause:** §5 describes a re-stamp of the Wave 9 restore operation that does not exist for a logical move.
- **Proposed fix:** a `target.rehome` plan (human, step-up, approval on prod) that adopts a decommissioned target's marker and increments the generation; or remove the sentence and document import-after-move.
- **Acceptance test:** dump a baselined nonprod target into a new database, decommission the old target, run the documented command: the new database is the target with ledger and baseline kept, generation + 1.

### [P2] CREATE PUBLICATION (the standard supabase_realtime) in the legacy history makes the whole analysis incomplete; the operation ends verification_failed with a forward-fix remedy
- **Area:** `migration import analyze`, replay admission, operation texts
- **Block:** B
- **Reproduction:** `exdb migration import analyze --target lab/platform/rhstg --scratch lab/platform/rhscr --apply` with a legacy file `create publication supabase_realtime for table ...` (`steps/04-*.sh`, `05-*`).
- **Expected:** the report names the file and the way forward (a notApplicable hint, accept the publication as present); the operation reads "analysis incomplete".
- **Actual:** `replay_failed:20240417041947_realtime_publication:MIGRATION_STATEMENT_FORBIDDEN:0` is shown only by `migration import report`; the operation says `verification_failed` with "Next: ... create a forward-fix migration and plan" (which does not apply to an analysis). Files before it had already run, so the scratch target is consumed (reset in place, 2 s). With the hint the publication returns as drift `only_in_target` and its ledger entry as `ledger_entry_without_file` (two more items to decide).
- **Evidence:** server logs `import-analyze-plan.log`, `op-analysis.json`; `B/rehearsal/README.md` §2.
- **Root cause:** `CREATE PUBLICATION` is a forbidden statement and the replay uses the same admission.
- **Proposed fix:** allow plain table publications in the replay, or detect before replay in `scratch-check`; end an incomplete analysis in a state whose next step is "fix inputs and analyze again".
- **Acceptance test:** a history with `CREATE PUBLICATION p FOR TABLE t` analyses to `open`; an incomplete report ends the operation with that next step.

### [P3] The observer role cannot read schemas of the managed scope; scratch-check says ready and the analysis returns seven expectations_unreadable items that look like ambiguity
- **Area:** `migration import scratch-check`, analysis
- **Block:** B
- **Reproduction:** scope `public, auth, storage, app_private`, the observer without USAGE on the last three: scratch-check ready; analysis: 23 ambiguous; after `GRANT USAGE ... TO exponetdb_observer` and a new analysis (21.6 s each): 16.
- **Expected:** a preflight line for the observer's visibility of the scope.
- **Actual:** only the decision-dialog text mentions the remedy.
- **Evidence:** `B/rehearsal/NOTES.md`; `B/rehearsal/README.md` §2.
- **Root cause:** scratch-check tests the scratch target and the execution role, not the imported target's observer.
- **Proposed fix:** an `observer_visibility` check listing schemas of the scope the observer cannot use.
- **Acceptance test:** with USAGE missing, scratch-check fails that check naming the three schemas.

### [P3] Refusal texts that name no id and no remedy
- **Area:** CLI errors `TARGET_REGISTRATION_REFUSED`, `cluster endpoint retire --reason`, `LEDGER_DIVERGENCE`, `PLAN_STALE`
- **Block:** B
- **Reproduction:** register a clone (`steps/26`); `exdb cluster endpoint retire <c> <e> --reason "primary lost"` (`steps/30`); `traps_swap2.sh`.
- **Expected:** cause, ids and remedy (the error catalog's promise).
- **Actual:** `other_target` without the other target's id (REST has only `details.reason`); the retire reason must match `^[a-z][a-z0-9_]{0,63}$` and a sentence gets a contract error quoting the pattern; `LEDGER_DIVERGENCE` and `PLAN_STALE` as in the other findings. Registering a clone after dropping its `exponetdb` schema works, but no text says so.
- **Evidence:** `B/rehearsal/results/traps-clone.txt`; `steps/25-28`, `steps/30`.
- **Root cause:** details are kept as machine reasons.
- **Proposed fix:** include the other target's id or path (when readable) and the documented next step; one reason format for all `--reason` flags.
- **Acceptance test:** a golden test of the CLI text for each code contains an id and a next step.

### [P3] `schema diff` prints columns, constraints and triggers without their table
- **Area:** CLI `schema diff` renderer
- **Block:** B
- **Reproduction:** `exdb schema diff lab/platform/rhrep lab/platform/rhstg` (`B/rehearsal/results/i10-replay-schema-diff.txt`).
- **Expected:** `public.crm_items.hotfix_note`.
- **Actual:** `+ column public.hotfix_note`, `- column public.id`, `- column public.token`, `- constraint public.legacy_sessions_pkey`; with 300 tables a row cannot be attributed (the JSON has `parent`).
- **Evidence:** `B/rehearsal/results/i10-replay-schema-diff.txt`.
- **Root cause:** the renderer prints `schema.name` only.
- **Proposed fix:** print `schema.parent.name` when `parent` is set.
- **Acceptance test:** a renderer test with a column name present in two tables shows both parents.
