### [P1] A single-quoted `DO '...'` body bypasses the parser token bound (Part A P1 no. 1)
- **Area:** `packages/postgres` parser, legacy import analysis (`serve` and worker)
- **Block:** B (Part A P1 1, `gates/9-part-a.md:988-993`)
- **Reproduction:** with `node --liftoff-only --conditions=@exponetdb/source` from the worktree root: build `DO '` + `BEGIN PERFORM 1; ... (70000 times) END` + `';` and the dollar form `DO $$ ... $$;`. `countTokens(sql, MAX_PARSE_TOKENS, 'standard', true)` is 200001 for the dollar form and **3** for `DO '...'`, **5** for `DO LANGUAGE plpgsql '...'` and `DO '...' LANGUAGE plpgsql`, **3** for `DO E'...'`; `exceedsParseWork` is false and `parsePlpgsql` returns a tree. A 4,190,016-byte `DO '...'` (below the 4 MiB per-file contract) passes `refuseOversizedLegacyFiles` and peaks at **1,114 MiB** (1,141,316 KiB maxrss, 3.0 s); the dollar form is refused at 160 MiB. In a 512 MiB cgroup (`systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0`) the single-quoted form is killed, exit 137, with no log line.
- **Expected:** the V-P1-1 bound (token budget of the body the PL/pgSQL parser reads) applies whatever the quoting; the early `422 too_large` triggers.
- **Actual:** only dollar tokens are unwrapped. One request from a caller who may run `migration import analyze` can make `serve` or the worker allocate over 1 GB (a DoS reachable by legitimate input).
- **Evidence:** `B/part-a-p1-reproductions.md` section 1 (tables, commands, scratch scripts `do-variants.mts`, `do-single.mts`).
- **Root cause:** `packages/postgres/src/parser/lexer.ts:73-92` (`countTokens`, bodies only for `dollar` tokens, line 83), `packages/postgres/src/parser/parse.ts:62-75` (`parsePlpgsql`) and `:115-125` (`exceedsParseWork`, line 119 descends only into dollar tokens); callers `packages/postgres/src/parser/cluster-global.ts:1018` and `legacy-references.ts:310`; the gate `packages/migrations-engine/src/legacy-files.ts:15`.
- **Proposed fix:** bound the decoded body: in `parsePlpgsql` take the `defname = 'as'` string value from the `DoStmt` node and count tokens on it; in `exceedsParseWork` treat the string token that follows `DO` (optionally `LANGUAGE <ident>`) or precedes `LANGUAGE` as a body, decode `''` and `E''` escapes, and recurse like for a dollar body. Do not count every string literal (a 1 MB JSON literal in an `INSERT` must stay legal).
- **Acceptance test:** in `packages/postgres/test/legacy-references.test.ts` beside the P1-1 test, for the four single-quoted shapes with a body of `ceil(MAX_PARSE_TOKENS/3)+1` times `PERFORM 1;`: `countTokens(...) > MAX_PARSE_TOKENS`, `exceedsParseWork(sql) === true`, `parsePlpgsql(sql) === undefined`, `legacyReferences(...).tooComplex === true`, `refuseOversizedLegacyFiles` throws `VALIDATION_FAILED` path `/files/0/text` code `too_large`. Negative cases: a 1,000-statement single-quoted `DO` is still parsed; a large ordinary string literal is not refused. Memory gate: the 4.19 MB `DO '...'` peaks below 200 MiB.

### [P1] The `search_path` strictness check is a quadratic regular expression (Part A P1 no. 3)
- **Area:** `packages/postgres` cluster-global guard, legacy import (`serve` and worker)
- **Block:** B (Part A P1 3)
- **Reproduction:** `node --conditions=@exponetdb/source regex.mts <family> <chars>` calling `guardStrictness`. Families (times in ms): `one_ws` = `SET search_path =,` + n spaces: 10,000 chars 226, 30,000 1,170, 60,000 4,394, **100,000 16,840, 200,000 35,233**, 4,194,304 TIMEOUT (>60 s); `rep_comma` = `search_path,` repeated: 100,000 808, 300,000 6,855, **1,000,000 58,979** (passes the 200,000-token gate with 166,667 tokens); `rep_noterm` and `rep_pad` similar; controls (`;`-terminated, no comma) are linear (4 ms at 1 MB). Growth is x54 to x122 for x10 (quadratic). Bun (JSC) behaves the same.
- **Expected:** linear time, an interruptible or bounded check.
- **Actual:** a 100 KB file blocks the synchronous event loop of `serve` (and of the worker on replay) for 17 s inside the request's open transaction; a 1 MB to 4 MiB file passes the contract and the token gate and blocks it for minutes to hours; recovery is a process restart. Needs a caller with the import analyze permission, hence not P0.
- **Evidence:** `B/part-a-p1-reproductions.md` section 3.
- **Root cause:** `packages/postgres/src/parser/cluster-global.ts:464`: `const CATALOG_LATER = /\bsearch_path\b[^;]*?,\s*["']?\s*pg_catalog\b/i`, used by `guardStrictness` (`:467-475`) on raw text; callers `packages/migrations-engine/src/legacy.ts:969-975` (`historyStrictness`, plan time at `:719`, worker at `:979`). Two mechanisms: lazy `[^;]*?` rescans per occurrence; two adjacent `\s*` around an optional quote.
- **Proposed fix:** (prototype validated: 0 differences in 300,000 fuzz cases; 4 MiB in 3 to 17 ms) replace by a linear scan per statement: for each `\bsearch_path\b` take the text up to the next `;`, test it once with `/,\s*(?:["']\s*)?pg_catalog\b/i`, continue after the `;`.
- **Acceptance test:** `packages/postgres/test/cluster-global.test.ts`: existing semantic cases stay; a property test (fast-check) of the new function against the old regex on short generated strings; a machine-independent scaling test per family: time(1 MiB)/time(256 KiB) below 8 and `guardStrictness([text])` at 1 MiB under 200 ms; texts with `;` after each `search_path` and one with a real `, pg_catalog` still return `'all'`.

### [P2] `survivingExpectations` over a whole legacy chain is quadratic and blocks the worker; memory is linear but unbounded across files (Part A P1 no. 2)
- **Area:** `packages/migrations-engine/src/legacy.ts` chain analysis, `packages/postgres/src/parser/migration.ts`
- **Block:** B (Part A P1 2)
- **Reproduction:** `node --liftoff-only --expose-gc --conditions=@exponetdb/source mem.mts uniform <files>` (fixture shape `largeLegacyHistory`, about 1.3 KB per file). Peak RSS 120 / 191 / 310 / 507+ MiB for 100 / 1,000 / 5,000 / 20,000 files (retained heap about 14.7 KiB per file, about 11 times the SQL text; linear). `survivingExpectations` step: **50 ms, 3.1 s, 196 s** for 100, 1,000, 5,000 files (x62 for x10); 20,000 files not finished in 300 s (extrapolated about 31 minutes). At the legal contract maximum (9 files of 190,000 tokens, 6.87 MB) peak RSS is 565 MiB unconstrained and 387 MiB under a 512 MiB cgroup; the retained heap is 226 MiB against the 268 MiB V8 limit; the chain step is about 21 minutes extrapolated. The legacy ledger read (`legacy.ts:777-779`) has no `LIMIT`: 289 MiB at 26 MB of statements (linear).
- **Expected:** the record's P1: memory does not add up across files beyond a stated budget; the chain step is linear.
- **Actual:** no OOM was demonstrated inside the legal limits (I rate memory and CPU P2); the per-file token bound limits one parse, not the sum; the quadratic step runs synchronously in the worker (P1 if the operation lease cannot be renewed while the loop is blocked: not tested). 1,000 realistic files (inside the contract) take 5.5 s and 191 MiB.
- **Evidence:** `B/part-a-p1-reproductions.md` section 2.
- **Root cause:** `packages/postgres/src/parser/migration.ts:2333-2350` (`survivingExpectations`, `touched.slice(i + 1)` per expectation) and `legacy.ts:951` (`survivors.filter` per file); `analyzeChain` `legacy.ts:923-967` copies every statement into one chain; `replaysOf` (defined `legacy.ts:979`) keeps a `FileReplay` per file.
- **Proposed fix:** (1) a per-request total token budget in `refuseOversizedLegacyFiles` (for example 600,000 tokens over all files); (2) keep per-file compact facts only, drop `segments`/`statements` after replay; (3) make `survivingExpectations` O(E+S) with one reverse pass building `Map<key, lastStatementIndex>`; group survivors by file once; (4) a byte cap or cursor on the legacy ledger read, failing to `unreadable`.
- **Acceptance test:** unit: `survivingExpectations` on 30,000 generated statements finishes under 1 s and equals the old implementation on random small inputs (property test); engine test: 9 files of 190,000 tokens refused or analysed within a stated budget and a request over the total budget is `422 too_large`; measurement gate (extend `packages/migrations-engine/scripts/measure-analyze-memory.ts`, 9 dense files): peak RSS below 350 MiB in a 512 MiB cgroup, steps below 10 s.

### [P1] An operation in `needs_attention` holds the target's schema domain and the documented recovery cannot start (MIG-01)
- **Area:** operations engine, migration resume/verify/retry-verification
- **Block:** B (failure cases a, b, e; migration-engine report MIG-01)
- **Reproduction:** A (verify.sql that errors): apply a bundle whose `verify.sql` errors (`SELECT count(no_such_column) >= 0 AS ok FROM public.bv`): operation `needs_attention / applied / error` (`VERIFICATION_ERROR`); `retry-verification` -> `needs_attention` again (same digest); ingest a fixed verify revision, plan `migration.verify` with that revision, accept, run the worker six times: every poll answers `waiting`, the verify operation stays `queued`. B (non-transactional bundle killed): non-transactional bundle (`CREATE TABLE`, then `CREATE INDEX CONCURRENTLY` held by an older snapshot), `pg_terminate_backend` on the migrator backend: operation `needs_attention / unknown / OUTCOME_UNKNOWN`, INVALID index left, other plans refused `MIGRATION_INCOMPLETE`; `migration.resume` with cleanup is planned `allow` and accepted but stays `queued` for ever.
- **Expected:** `failure-and-recovery.md` E10 and section 2: a verify revision then `migration.verify`, or `resume`, runs and releases the target.
- **Actual:** the recovery operation waits for the domain `target:<id>:schema` held by the `needs_attention` operation. `needs_attention` leaves only to `verifying`; retry is claimable only for apply outcome `applied`/`partially_applied` and re-runs the operation's own digest; cancel covers `awaiting_approval` and `queued` only; `operation.force_release` is unbuilt. The target is blocked for every schema change (production hotfixes included) until someone edits the Control Store by hand. The existing suites miss it because their partial failure ends in `verification_failed`, which holds no domain.
- **Evidence:** `B/migration-engine-failure-cases.md` (MIG-01, items b, e; `migration-engine/evidence/b6`, `e1`..`e12`).
- **Root cause:** `packages/operations/src/states.ts:42`; `packages/operations/src/leases.ts:57-58`; `packages/application/src/views.ts:239-250`; `packages/application/src/application.ts:1983-1985` (cancel) and `:2046-2056` (retry); domain key in `kind.ts:117`, `reverify.ts:362`, `rollback.ts:362`; `exponetdb-docs/02-control-plane/operations-engine.md:356,710`.
- **Proposed fix:** (1) let a `migration.resume` or `migration.verify` plan that names the `needs_attention` operation of the same target adopt its domain, closing that operation terminally with an audit event and the same human re-authentication; or (2) build `operation.force_release` now with a `needs_attention -> failed|verification_failed` transition; (3) let `retry-verification` take an optional `revision` and cover apply outcome `unknown` for a non-transactional start through reconciliation.
- **Acceptance test:** integration (flip the evidence tests): the verify or resume operation reaches `succeeded` (index valid, `applied` event written, ledger row present), the original operation is terminal, `operations.operation_locks` holds nothing for the target and the next ordinary plan is admitted; state-machine unit test that `needs_attention` with apply `unknown` has an exit.

### [P1] The next verified migration silently adopts an out-of-band schema change into the drift baseline (MIG-02)
- **Area:** diagnostics drift baselines, migration apply
- **Block:** B (failure case c)
- **Reproduction:** apply a migration (baseline recorded); as superuser `GRANT ALL ON public.items TO PUBLIC` (or add a column); `runDriftCheck` -> `drifted`, finding open (ACL `critical`); plan and apply any unrelated bundle with the real kinds; `runDriftCheck` again. Plans made before the out-of-band change are `PLAN_STALE` (E23 holds); a plan made after it is `allow` with no signal.
- **Expected:** the finding stays open until `drift.accept` (security-relevant drift needs a reason; approval on production); the baseline is the old one plus the migration's change (`drift-detection.md` sections 5 and 7).
- **Actual:** `status: clean`, the finding is `resolved/cleared`, baseline `reason = migration`; `has_table_privilege('public', 'public.items', 'SELECT')` is still true.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-02 (`migration-engine/evidence/c2`, `c3`).
- **Root cause:** `packages/migrations-engine/src/executor.ts:381,398` records `fingerprintAfter` of the live schema; `kind.ts:785-795` `#recordExpected`; `packages/diagnostics/src/migration-baselines.ts:28-45` adopts a snapshot whose fingerprint equals that value without comparing the pre-migration fingerprint (`planner.ts:830` `expectedState.schemaFingerprint`) with the current baseline.
- **Proposed fix:** `MigrationBaselineStore.record` also takes the plan's pre-migration fingerprint and adopts the snapshot only when it equalled the current baseline's fingerprint, otherwise returns `drift_open` and keeps baseline and findings; optionally a plan fact `openDriftFindings` and a policy rule that asks for `drift.accept` (or an approval on prod) first.
- **Acceptance test:** drift integration: after the unrelated migration the status stays `drifted` and the finding open; without an out-of-band change it still ends `clean`.

### [P1] A restored ledger blocks every schema plan and `ledger.reconcile` is not built (MIG-03, E25 waiver)
- **Area:** migration engine ledger, G6 waiver E25
- **Block:** B (failure case g)
- **Reproduction:** after three migrations delete the last two from the target's ledger, events and runs and drop their tables (simulated restore); plan anything: `LEDGER_DIVERGENCE {missing: [m2, m3]}`; `migrationStatus.mirror.inSync` false; the drift check reports 4 removed objects; `ledger_state.divergent` stays `false` until a worker write.
- **Expected:** `failure-and-recovery.md` E25: the mirror is reconciled and the lost migrations show as pending again.
- **Actual:** detection works; nothing can unblock the target; the waiver "before Wave 9 closes" (`PRE-WAVE-11-REVIEW.md:635`) is not closed (the review notes the placement move to a restored cluster is also planned only).
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-03, item (g); `migration-engine/evidence/g/e25`.
- **Root cause:** `packages/migrations-engine/src/divergence.ts:110-125`; `ledger.reconcile` is planned (`gates/6.md:370`).
- **Proposed fix:** build `ledger.reconcile` (explicit operator plan, human re-authentication, audit) that rewrites the target's mirror rows from the live ledger when the identity marker and the cluster identity match, and re-runs the baseline verification; update the E25 row of `gates/6.md`.
- **Acceptance test:** integration: after the simulated restore, `ledger.reconcile` makes the lost migration plannable and appliable; a mismatching identity marker refuses it.

### [P1] One stored bundle with an unknown dependency blocks planning for the whole project (MIG-04, seen on the live installation)
- **Area:** migration bundle ingest and planner
- **Block:** B/C (failure case j; `C/live-migration-attempt.md`)
- **Reproduction:** ingest (`migration.bundle.ingest`, `packages/application/src/migrations.ts:99-108`) a bundle with `dependsOn: [<unknown ULID>]` (status `stored`), then plan an unrelated bundle on any target of the project: `MIGRATION_DEPENDENCY_UNKNOWN`, on every target. On the live installation `exponetdb migration plan --target reosa/platform/scratch` with a one-bundle project (own `dependsOn: []`) fails the same way.
- **Expected:** the unrelated plan works; a dangling edge is refused at ingest or confined to the bundle that has it.
- **Actual:** every plan of the project fails; the workaround is to ingest a corrected revision of the same id (`rewritten_unapplied`).
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-04 (`j3.unrelated_plan_after_poison`, `j3.other_target_same_project`); `C/live-migration-attempt.md`.
- **Root cause:** `packages/migrations-engine/src/store.ts:149` `ingestBundles` has no graph check; `planner.ts:295-298` puts every stored bundle's edges into the graph; `planner.ts:311-312` fails on the first dangling edge.
- **Proposed fix:** restrict the graph to the selected ids, their ancestors and the ledger, report dangling stored edges as a stream finding, and validate `dependsOn` against stream plus submission at ingest.
- **Acceptance test:** ingest a dangling bundle, then an unrelated plan succeeds; planning the dangling bundle itself names its missing ids.

### [P2] `MIGRATION_DEPENDENCY_UNKNOWN` carries no id (MIG-05)
- **Area:** migration planner errors
- **Block:** B (failure case j)
- **Reproduction:** `planMigrationApply` with `dependsOn: [<unknown ULID>]`; live: `exponetdb migration plan ... --output json` shows `error: {code, message}` only.
- **Expected:** the node and the missing ids, as `stream.ts:225-232` returns them.
- **Actual:** `details` undefined; message "dependsOn names an id that is not in the project stream." For a project with 12 stored bundles the operator cannot tell which one.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-05; `C/live-migration-attempt.md`.
- **Root cause:** `packages/migrations-engine/src/planner.ts:162-163` and the default branch `:178-179` drop `failure.from` / `failure.missing`.
- **Proposed fix:** `new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', { migrationId: failure.from, missing: failure.missing.slice(0, 256) })` with a schema-checked catalog entry; the CLI prints them.
- **Acceptance test:** unit test of `graphRefusal` and a planner integration test asserting the ghost id in `details`; CLI text test.

### [P2] E16 `hotfix_without_evidence` has no detection (MIG-06, G6 waiver)
- **Area:** migration engine findings, G6 waiver E16
- **Block:** B (failure case g)
- **Reproduction:** simulate the post-break-glass state (a migration applied on production that staging lacks, planned with only the registry rules): findings of both targets none; drift of both `clean`; `migrationStatus` lists it as applied on prod only with no marker; `grep -rn 'hotfix_without_evidence' packages apps agent` finds no source match.
- **Expected:** an open finding on the production target until the same migration is applied and verified on staging (`staging-production-policy.md:155`).
- **Actual:** nothing marks the hotfix. The review adds that E16 is reachable: a break-glass grant on `migration.staging-evidence` activates once a notification channel is set (`apps/server/test/http-migrations.int.test.ts:710-725`) and nothing marks the prod ledger row afterwards (`content.ts:96`). The live staging target already carries 555 `legacy_import` ledger rows; whether the OD-7a staging import counts as "real REOSA data" (waiver expiry "before the first import of real REOSA data (Wave 10)", `PRE-WAVE-11-REVIEW.md:636`) is an owner decision.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-06; `B/review-items-static-audit.md` (E16/E18 row).
- **Root cause:** not implemented; the drift check implements only kind C (`packages/diagnostics/src/drift.ts:329-343`).
- **Proposed fix:** at the ledger mirror write (`kind.ts` reconcile path, `records.ts` `writeMirror`) compare each production row with the evidence target's mirror and record `hotfix_without_evidence` (kind drift, severity warning) resolved when the evidence target has the same checksum with a passed verification.
- **Acceptance test:** integration: one open finding on prod after the simulated hotfix, cleared after the apply on staging; `gates/6.md` waiver table updated.

### [P2] E18 `applied_not_in_source` has no detection (MIG-07, G6 waiver)
- **Area:** migration engine findings, G6 waiver E18
- **Block:** B (failure case g)
- **Reproduction:** a plan whose submitted source omits an applied migration: `allow`, no lint entry or finding; with the bundle revisions deleted from the Control Store: status lists the row applied, verify plan `NOT_FOUND`, findings none, drift `clean`.
- **Expected:** finding `applied_not_in_source` (`failure-and-recovery.md`, `drift-detection.md:37`).
- **Actual:** none; the server never sees the repository except through a plan's `bundles`.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-07.
- **Root cause:** not implemented (no source match).
- **Proposed fix:** a lint or stream finding when the submitted source set (CLI `migration lint`, a plan's `bundles`) omits an id present in the target's ledger and not reverted.
- **Acceptance test:** a plan whose source omits `x` yields the finding; the full set yields none.

### [P2] The ledger comparison is shallow and only the apply planner runs it (MIG-08)
- **Area:** migration ledger guards
- **Block:** B (failure case i)
- **Reproduction:** as the target superuser with `session_replication_role = replica`: set `reverted_at` by hand -> apply plan `MIGRATION_DEPENDENCY_MISSING` (not divergence); change `fingerprint_after` -> apply plan created; checksum change or row deletion -> `LEDGER_DIVERGENCE` for apply but `NOT_FOUND`/`no_down_sql` for verify and rollback planners; a hand-written `nontx_started` event blocks every schema plan with `MIGRATION_INCOMPLETE` and `migration.resume` answers `NOT_FOUND`.
- **Expected:** any hand change of a ledger row or event is `LEDGER_DIVERGENCE` for every planner (`ledger.md` section 5).
- **Actual:** see table in the evidence; E-1 deferred-trigger chains (also at and past the bound) are correctly refused.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-08 and section (i).
- **Root cause:** `packages/migrations-engine/src/divergence.ts:35-55` (existence, checksum, operation id only); `planner.ts:368` (only caller besides `reads.ts:191`); `planner.ts:184-189`.
- **Proposed fix:** compare `reverted_at`/`reverted_by_op`, `fingerprint_after`, `transactional` and the event count per migration; call `assertLedgerAgrees` in `planMigrationVerify`, `planMigrationRollback`, `planMigrationResume`.
- **Acceptance test:** each tamper row yields `LEDGER_DIVERGENCE` in all four planners.

### [P3] Lock contention on catalog reads is reported as `PLAN_STALE` or `QUERY_TIMEOUT` (MIG-09)
- **Area:** migration planning under lock
- **Block:** B (failure case d)
- **Reproduction:** hold `ACCESS EXCLUSIVE` on a table; planning ends `QUERY_TIMEOUT` after 2 s; acceptance and dispatch end `PLAN_STALE` with `changedBindings: ["target"]` although the plan is not stale.
- **Expected:** a typed busy/lock failure naming the holders.
- **Actual:** nothing runs and nothing stays held, but the cause is not named.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-09 (`d1`..`d3b`).
- **Root cause:** `packages/migrations-engine/src/kind.ts:203` maps any observer-read error to a changed binding.
- **Proposed fix:** map target lock/timeout reasons to a `TARGET_BUSY`-style code; keep `PLAN_STALE` for real differences.
- **Acceptance test:** the lock scenario asserts the busy code at plan, accept and dispatch.

### [P3] A waiting operation writes two events per worker poll (MIG-10) and the "cleanup migration" alternative is unreachable (MIG-11)
- **Area:** operations locks, failure-and-recovery docs
- **Block:** B (failure case e)
- **Reproduction:** a stuck resume: events 1 -> 21 over 10 worker polls (`locks_waiting` plus `lease_acquired`); a cleanup bundle offered by `failure-and-recovery.md` section 2 is refused `MIGRATION_INCOMPLETE` like every plan.
- **Expected:** one `locks_waiting` event per blocking operation; the documented alternative works or is removed.
- **Actual:** unbounded event growth while waiting; dead documentation.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-10, MIG-11 (`e12`, `e3`).
- **Root cause:** `packages/operations/src/locks.ts:88-95` inserts `locks_waiting` on every conflict.
- **Proposed fix:** write once per blocking operation and release the lease silently, or back off; delete the cleanup-migration alternative or allow a bundle that only drops the named INVALID index while the start is open.
- **Acceptance test:** event count stays constant over 10 polls; docs test (link check) of the section.
