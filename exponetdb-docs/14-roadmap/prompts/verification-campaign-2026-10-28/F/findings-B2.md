# Findings of agent B2 (executable bundle conformance tests), block B

Tree under test `d51da5d0` (fix PR #46). Tests: `B/conformance/` (run with `B/conformance/run.sh`, results in
`B/conformance/RESULTS.md`). Times were measured on a shared machine with a load average of 9 to 14 on 8 cores
(`node --liftoff-only`, Node 24.22.1); they are upper bounds, the shapes (quadratic, cubic) are what matters.
A "failing test" below is the acceptance test of the finding: it fails on `d51da5d0` and must pass after the fix.

### [P1] Nested block comments freeze the serving process: PostgreSQL's scanner is quadratic on `/*/*/*`, and comments are free in every bound
- **Area:** packages/postgres parser (`parse.ts` `parseWith`, `lexer.ts` `countTokens`), packages/migrations/lint, `application/migrations.ts` `lint`/`plan` (in-process), `migrations-engine/reads.ts` `lintProject`
- **Block:** B
- **Reproduction:** `node fixtures/gen-nested-comments.mjs 40000 > nested.sql` (160 KB: `/*` x 40,000, `*/` x 40,000, `SELECT 1;`); put it in `up.sql` of a valid bundle; call `lintBundles` / `analyzeMigrationSql(17, text, {})` (what `POST /projects/{id}/migrations/lint` and `migration.plan` run). Test: `I14-containment.pure.test.ts` ("nested-comments 40000", "quadratic scaling of the PostgreSQL scanner"), probe `tools/probe.ts nested-comments <n>`.
- **Expected:** a hostile 160 KB file (4 % of the 4 MiB file limit) is refused or processed in well under a second; a bundle cannot block the process that serves every other request.
- **Actual:** `validateBundle` (c1, linear) accepts the file in 8 ms and `MAX_PARSE_TOKENS` ignores comments, so it reaches libpg_query, which takes 546 ms at depth 10,000, 2,128 ms at 20,000, 9,136 ms at 40,000 (x4 per doubling). `analyzeMigrationSql` 18 s plus `lintBundles` 20 s at depth 40,000 (the linter analyses the file again): 38 s of one blocked thread at 160 KB; depth 50,000 (200 KB) 28.7 s CPU. Extrapolated to the 4 MiB limit: about 3 hours per file, 50 files per request, 32 MiB body (`MIGRATION_REQUEST_LIMITS`, `MIGRATION_BODY_LIMIT_BYTES`). `serve` runs this synchronously (`lintProject`; `planMigrationApply` does it inside an open Control Store transaction). The server's own scanner is quadratic in the same way, but it runs in one backend, not in the event loop of the control plane. Not run against a live `serve` (the in-process calls are the ones the handlers make).
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`, `B/conformance/tools/probe.ts`, `B/conformance/fixtures/gen-nested-comments.mjs`, `B/conformance/RESULTS.md` (I14)
- **Root cause:** PostgreSQL `scan.l` rule `xcstart = \/\*{op_chars}*` re-reads the whole run of operator characters at every nested `/*` (then `yyless(2)`); nothing in `parse.ts:219-250` or `lexer.ts:73-93` counts comment characters or comment depth, and `lint.ts:456` parses `up.sql` a second time.
- **Proposed fix:** before handing text to libpg_query, refuse a file whose block-comment nesting exceeds a small depth (the c1 scanner `sql.ts:180-200` already walks it; 32 is plenty) with a named reason; count comment openers in the token bound; run parses in a worker thread with a deadline; reuse the first analysis in the linter.
- **Acceptance test:** `I14-containment.pure.test.ts` cases "nested-comments 40000" (wall <= 10 s) and "quadratic scaling ..." (t(20,000) / t(10,000) < 3).

### [P1] Memory is bounded per parse, not per request: six valid 660 KB bundles kill a serve process with the documented 259 MiB heap
- **Area:** packages/migrations/src/lint/lint.ts (`BundleReport.statements` kept for every bundle), migrations-engine/reads.ts `lintProject`, planner.ts, contracts `MIGRATION_REQUEST_LIMITS`
- **Block:** B
- **Reproduction:** `node --liftoff-only --max-old-space-size=259 --conditions=@exponetdb/source tools/densescale.ts 6` (6 bundles of `SELECT 1;` x 66,000 = 198,000 tokens, 660 KB each, 4 MB in all; this is what `POST /projects/{id}/migrations/lint` or `migration.plan` do with `bundles: [...]`). Test: `I14-containment.pure.test.ts` "6 dense bundles (4.0 MB) in one lint request ...".
- **Expected:** a request that respects every documented limit (4 MiB per file, 200,000 tokens per parse, 50 bundles, 32 MiB body) is processed or refused with a named error; it never kills the process. deployment.md section 2a: "one parse below about 160 MiB, whatever the text", container 512 MiB, heap 259 MiB.
- **Actual:** the bound is per parse. Each bundle's analysis is kept in the report, about 100 to 130 MB of heap and RSS per dense bundle: peak RSS 397 / 542 / 790 / 1,134 MiB for 1 / 2 / 4 / 8 bundles (default heap). With the container's heap limit (`--max-old-space-size=259`): 3 bundles 495 MiB RSS, 4 bundles 546 MiB (over the 512 MiB container), 6 bundles `FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript heap out of memory`, exit 134. The request limit is 50 bundles and 32 MiB, i.e. about 6 GB by extrapolation. The only per-request token budget in the code is `MAX_TOTAL_PARSE_TOKENS` of the legacy import. Measured on the library calls the handlers make, not on a live container.
- **Evidence:** `B/conformance/tools/densescale.ts`, `B/conformance/I14-containment.pure.test.ts`, `B/conformance/RESULTS.md`
- **Root cause:** `lint.ts:880-905` keeps `statements` and `rollbackStatements` (the full per-statement facts) of every bundle in `BundleReport`; the report is built for all submitted bundles before anything is returned; nothing sums the token counts of a request.
- **Proposed fix:** a total token budget per lint/plan request (the legacy value of 1,000,000 is a start) refused with a named `too_large`; keep a summary instead of the statement facts for bundles beyond the first N; lint bundles one at a time and release their facts.
- **Acceptance test:** the two `dense bundles` tests (3 and 6 bundles).

### [P2] Lint and plan over a dependency chain are cubic: 800 chained bundles take 61 s, a 1,000-deep chain plans in 53 s, 5,000 would take hours
- **Area:** packages/migrations/src/lint/lint.ts (`parallel_object_overlap`), migrations-engine/planner.ts
- **Block:** B
- **Reproduction:** `node --liftoff-only --conditions=@exponetdb/source tools/lintscale.ts chain 100,200,400,800`; engine: `I3-order.int.test.ts` "a 1,000-deep chain plans in dependency order within a time and memory budget" (prints the plan time); control `tools/lintscale.ts indep 50,...,800` is linear (0.6 ms per bundle at 800). Tests: `I3-order-is-the-dag.pure.test.ts` "lint time over a chain of n bundles must not grow faster than quadratically".
- **Expected:** lint/plan time proportional to the number of bundles (the brief's scale target is 500 and 5,000 bundles in one project; `dependency-graph.md` section 7 says validation is O(V+E)).
- **Actual:** chain of 50 / 100 / 200 / 400 / 800 bundles: 234 ms, 268 ms, 1.1 s, 7.1 s, 61 s (x8.7 per doubling = cubic). Through the engine, 1,000 chained bundles in 20 batches of 50 plus one plan: 52.9 s (RSS +37 MiB) on a quiet machine, and `ControlStoreError: A Control Store statement or lock wait timed out` on a loaded one: the lint runs inside the plan's Control Store transaction, whose `idle_in_transaction_session_timeout` is 60 s (`store.ts:364`, `bootstrap-sql.ts:70`; the error is mapped to `control_store_timeout` for SQLSTATE 57014, 55P03 and 25P03), so a plan whose lint needs more than a minute (about 800 chained bundles) is expected to fail; the failure was observed once, under load, in `readPolicySettings` right after the lint. By extrapolation 5,000 take about 4 hours of one blocked thread. A fresh target that has every bundle pending (a new environment, a replay for I10) is exactly this shape.
- **Evidence:** `B/conformance/tools/lintscale.ts`, `B/conformance/I3-order.int.test.ts`, `B/conformance/I3-order-is-the-dag.pure.test.ts`
- **Root cause:** `lint.ts` (block "unordered migrations touching the same object") loops over all pairs `i < j` and calls `g.ancestors(ia)` and `g.ancestors(ib)` for each pair; `graph.ts:137-159` `ancestors` walks the graph and sorts the result: O(n^2) pairs x O(n log n).
- **Proposed fix:** compute `sharedObject` first (cheap, index by object name), and compute reachability once (memoised ancestor sets or a topological-index bitset); only pairs that share an object need an ancestor test.
- **Acceptance test:** the ratio test above (t(400)/t(200) < 3.5) and a 5,000-bundle chain linted in under 30 s.

### [P2] `up.sql` can release the engine's own target lock: `SELECT pg_advisory_unlock_all();` is applied and the `EXDB` locks disappear while the migration runs
- **Area:** packages/postgres/src/parser/migration.ts (`settingsCall`, function handling), migrations-engine/executor.ts, concurrency
- **Block:** B (invariant I4, touches I8)
- **Reproduction:** `fixtures/unlock-engine-lock.sql` as `up.sql` (transactional) on a registered target; poll `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND classid = 1163412546` while it runs. Test: `I4-atomicity.int.test.ts` "up.sql cannot release the engine's own target lock".
- **Expected:** the single-writer lock (`concurrency.md`) is held from lock acquisition to the end of the operation whatever the bundle contains; content that touches advisory locks is refused or ineffective.
- **Actual:** lint passes, the plan is allowed, the statement runs, and the migrator session holds 2 `EXDB` advisory locks before and 0 after, on PostgreSQL 16, 17 and 18. The rest of the migration (here a 4 s `pg_sleep`) runs with no engine lock; a second operation could take the lock and start. The ledger SHARE lock and table locks still serialise the actual DDL, so this is a protocol bypass, not data loss.
- **Evidence:** `B/conformance/I4-atomicity.int.test.ts`, `B/conformance/fixtures/unlock-engine-lock.sql`
- **Root cause:** `migration.ts:700-725` `settingsCall` looks only at `set_config`; no function is denied, and `readEngineGuards` (`migration-facts.ts:240-290`) does not read the lock.
- **Proposed fix:** deny `pg_advisory_*` (all lock and unlock functions) in top-level statements and verify after every statement that the engine's lock is still held by the session (one `pg_locks` read, like the ledger guard).
- **Acceptance test:** the same int test: the lock count is unchanged during the migration, or the bundle is refused at lint time.

### [P2] The classifier does not know `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`: it cannot run in a transaction block, and the engine cannot express it either way
- **Area:** packages/postgres/src/parser/migration.ts (`alterTable`, `autocommitOnly`), migrations/lint
- **Block:** B (I4)
- **Reproduction:** `fixtures/detach-partition-concurrently.sql`; `lintBundles` with `transactional: true` and `false`. Tests: `I4-atomicity.pure.test.ts` ("detach partition concurrently: refused in a transactional bundle", "... accepted in a non-transactional bundle as the only statement"), `I4-classifier-vs-server.int.test.ts` (server oracle), `I4-atomicity.int.test.ts` (DETACH ...).
- **Expected:** `migration-bundles.md` section 5: the parser classifies statements that cannot run in a transaction block; a transactional bundle holding one is `nontransactional_statement_in_transactional`, a non-transactional bundle may carry it alone.
- **Actual:** of 40 statements swept against PostgreSQL 16, 17 and 18 (each inside `BEGIN ... ROLLBACK` as oracle) this is the only one the server refuses in a transaction block (SQLSTATE 25001) that the classifier calls ordinary (`autocommit 0`). In a transactional bundle no `nontransactional_statement_in_transactional` fires: on a non-production target the plan is accepted and the apply fails on the server (`MIGRATION_EXECUTION_FAILED`, `not_applied`, atomic, all three majors). In a non-transactional bundle the blocking `needless_nontransactional` fires (plus `compatibility_understated` whatever is declared), so the statement cannot be run through the engine at all.
- **Evidence:** `B/conformance/I4-classifier-vs-server.int.test.ts`, `B/conformance/I4-atomicity.pure.test.ts`, `B/conformance/fixtures/detach-partition-concurrently.sql`
- **Root cause:** `migration.ts` sets `autocommitOnly` for CONCURRENTLY index statements (line 1102, 1580), VACUUM (2002), REINDEX/CLUSTER (2024, 2045); the `AlterTableCmd` subtypes `AT_DetachPartition` (with `concurrent`) and `AT_DetachPartitionFinalize` are not handled.
- **Proposed fix:** set `d.autocommitOnly = true` for a detach with `concurrent` and for finalize.
- **Acceptance test:** the three tests above.

### [P3] Seven pinned settings are refused at top level but not guarded after each statement
- **Area:** packages/postgres/src/parser/migration.ts `ENGINE_SETTINGS` (line 116), `migration-facts.ts` `EngineGuards`
- **Block:** B (I4)
- **Reproduction:** `fixtures/unguarded-engine-settings.sql`; test `I4-atomicity.int.test.ts` "body hazard: DO that sets row_security off ..." and six siblings.
- **Expected:** `ENGINE_SETTINGS` says "reviewed SQL never changes them, not even with SET LOCAL"; the defense in depth behind a function body is the guard read after every statement (`executor.ts` `changedGuards`).
- **Actual:** the guard reads 13 values; `row_security`, `extra_float_digits`, `application_name`, `default_tablespace`, `temp_tablespaces`, `default_transaction_read_only` and (PostgreSQL 17 and 18) `transaction_timeout` are in `ENGINE_SETTINGS` but not in `EngineGuards`. A `DO` block that sets them with `set_config(..., true)` is applied and the value lives to the end of the transaction (`application_name` also decides whether the session is protected from `connections.terminate`; `default_tablespace` where later objects land; `transaction_timeout = 0` removes a transaction cap). The other pinned names, the role switches, the ledger forgeries, `COMMIT`/`ROLLBACK`/`SAVEPOINT` in `DO` and procedures, `pg_terminate_backend(pg_backend_pid())` and settings from functions are all caught: 34 hazards in function bodies and 16 host-reaching statements, each on three majors, all roll back whole.
- **Evidence:** `B/conformance/I4-atomicity.int.test.ts`, `B/conformance/fixtures/unguarded-engine-settings.sql`
- **Root cause:** `ENGINE_SETTINGS` (22 names) and `EngineGuards` (13 fields) are two lists maintained by hand.
- **Proposed fix:** derive both from one list and read every listed setting in the guard query.
- **Acceptance test:** the seven failing int cases.

### [P2] The bundle store decides "applied elsewhere" from the Control Store mirror only: in the commit-to-mirror window other bytes under an applied id are accepted
- **Area:** packages/migrations-engine/src/store.ts (`appliedElsewhere`, `ingestBundles`)
- **Block:** B (I13)
- **Reproduction:** apply bundle X on target A; delete its row from `migrations.ledger_mirror` (the state between COMMIT on the target and the mirror write after a crash; `reconcile` repairs it later); submit X with other bytes in a plan for target B. Test: `I13-immutability.int.test.ts` "INVARIANT: after an apply, other bytes under the same id are refused even if the ledger mirror has not caught up".
- **Expected:** `MIGRATION_CHECKSUM_MISMATCH` ("same id, different checksum than the ledger of any target of the project", `migration-bundles.md` section 3, not overridable).
- **Actual:** the rewritten bytes are stored as the newest revision (`rewritten_unapplied`). A later `migrationIds: [X]` plan for target B then takes the NEWEST revision, so X can be applied on B with other bytes than on A (the planner compares only with the ledger of the target it plans for). With the mirror intact, the same flow is refused (test "after an apply on ANY target ... MIGRATION_CHECKSUM_MISMATCH" passes).
- **Evidence:** `B/conformance/I13-immutability.int.test.ts`
- **Root cause:** `store.ts:123-137` queries `migrations.ledger_mirror` only; the live ledgers are read per target at plan time (`planner.ts:309-320`).
- **Proposed fix:** treat an id with any pending or unreconciled operation, or any target whose `ledger_state` is not current, as applied; or read the evidence/ledger of the project's targets at ingest.
- **Acceptance test:** the failing int case above.

### [P3] A string literal continued across a line comment is valid PostgreSQL and c1 N4, but libpg_query refuses it
- **Area:** packages/postgres parser (libpg_query 16.7.3, 17.7.4, 18.1.5), `lexer.ts` `continuation`
- **Block:** B (I5)
- **Reproduction:** `fixtures/string-continuation-across-line-comment.sql`. Test: `I5-edges.int.test.ts` "string continuation across a line comment ..." (3 majors).
- **Expected:** the repo splits what the server executes (`planning-and-apply.md` section 7).
- **Actual:** the three servers return `'ab'`; `analyzeMigrationSql` fails with a syntax error, lint reports `parse_error`. Three lexers disagree: the server and `format/sql.ts` (c1 N4) accept it, `lexer.ts continuation()` (redaction) and the libpg_query builds do not. The direction is safe (valid SQL refused, nothing wrong runs); 360 generated scripts (120 per major), 51 hand-picked cases and 450 single-edit mutants (150 per major) on PostgreSQL 16, 17 and 18 (model = server = repo ranges = c1 executable text) found no other divergence.
- **Evidence:** `B/conformance/fixtures/string-continuation-across-line-comment.sql`, `B/conformance/I5-edges.int.test.ts`, `B/conformance/I5-parser-equals-server.int.test.ts`
- **Root cause:** the WebAssembly scanner of the three pinned bindings.
- **Proposed fix:** document it in section 3 N4 and make the `parse_error` message say "string continuation across a comment is not supported"; or rebuild the bindings from a scanner that matches `scan.l`.
- **Acceptance test:** the I5-edges test, or a documented-limit test.

### [P3] The lint report depends on the order the bundles are submitted in
- **Area:** packages/migrations/src/lint/lint.ts (`parallel_object_overlap`)
- **Block:** B (I1)
- **Reproduction:** `lintBundles(A,B,C,D)` against `lintBundles(D,C,B,A)` for four bundles that alter one table without edges. Test: `I1-determinism.pure.test.ts` "FINDING: the lint report does not depend on the order ...". Digests, analysis, graph order and the plan hash over fixed content are identical across 4 runtimes, 3 time zones, 2 locales and 3 shuffles (28 runs).
- **Expected:** the same report for the same set of bundles (CI diffs, stored plan analysis).
- **Actual:** the order of findings and the partner named in each `parallel_object_overlap` message ("... also touches ...") follow input order.
- **Evidence:** `B/conformance/I1-determinism.pure.test.ts`, `B/conformance/tools/lintdiff.ts`, `B/conformance/fixtures/lint-order-dependence.md`
- **Root cause:** `lint.ts` pair loop emits in loop order and names the other bundle found first.
- **Proposed fix:** sort bundles by id before the pair loop and name all partners (sorted).
- **Acceptance test:** the I1 test.

### [P3] The CLI loader turns a symbolic link or directory named `verify.sql`/`up.sql` into an empty file, and reads an oversized file whole
- **Area:** apps/cli/src/local/project.ts `readBundles`
- **Block:** B (I14)
- **Reproduction:** `fixtures/make-symlink-bundle.sh <dir>` (a bundle whose `verify.sql` is a link to a file with a failing check). Tests: `I14-containment.pure.test.ts` "a symbolic link in place of verify.sql ...", "... in place of up.sql ...", "a 512 MiB up.sql ...".
- **Expected:** the header comment says a link is "passed on as it is, so the shared validation refuses it with its reason", and an oversized file is "read only up to the limit + 1 byte".
- **Actual:** for the names that are allowed, the entry is replaced by an empty buffer: a linked `verify.sql` validates as an empty verify file (the author sees a check that never runs), a linked `up.sql` is refused as `empty_migration`, never as a link. `readFile` reads the whole file before the cut: a 512 MiB sparse `up.sql` raised RSS by 520 MiB (B1 reports the second half statically as FB1-11).
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`, `B/conformance/fixtures/make-symlink-bundle.sh`
- **Root cause:** `project.ts:121-134`: `!file.isFile()` sets `new Uint8Array()`; `readFile` precedes the `subarray`.
- **Proposed fix:** reject non-regular entries with a named reason; open the file and read at most `limit + 1` bytes.
- **Acceptance test:** the three tests.

### [P3] A deeply nested `migration.yaml` is refused with the YAML library's stack-overflow text, not a named limit
- **Area:** packages/migrations/src/format/yaml.ts
- **Block:** B (I14, I15)
- **Reproduction:** `tools/probe.ts yaml-flow-depth 1000` (2 KB of `[`). Test: `I14-containment.pure.test.ts` "depth 1,000 is refused with a NAMED limit".
- **Expected:** a named reason for the nesting limit.
- **Actual:** `MIGRATION_MANIFEST_INVALID` with `yaml_syntax` "Maximum call stack size exceeded" from depth 1,000. No crash, no throw, 60 ms.
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`
- **Root cause:** `yaml.ts:23-30` relies on the library's recursion.
- **Proposed fix:** reject a depth above 32 with `yaml_depth` before composing the document.
- **Acceptance test:** the named test.

### [P3] The limits of bundles are not announced in one place, and two bite below the documented ones
- **Area:** exponetdb-docs/04-migrations/migration-bundles.md section 1 and 2, authoring-and-ci.md, contracts `MIGRATION_REQUEST_LIMITS`, `BUNDLE_INVALID_REASONS`
- **Block:** B (I15)
- **Reproduction:** `I15-limits.pure.test.ts` (23 cases at the boundary), `I5-edges.int.test.ts` "100,000 tiny statements".
- **Expected:** every size/count/depth/time limit has a named error and a documented value.
- **Actual:** the four file sizes, name 64, description 2,000, durations 1 ms to 6 h and the 60 s lock warning match code and docs at the boundary (accepted at the limit, refused one past it, named `file_too_large` / `duration_out_of_range`). Not in `04-migrations/`: `dependsOn` 1,000, extensions 64, `searchPath` 32, authors 32 x 320, ticket 200, 50 bundles and 200 ids per request, 32 MiB body, 5,000 bundles for the CLI (the CLI error names it; the server has no count limit). The 200,000-token parse bound (deployment.md section 2a only) makes 100,000 `SELECT 1;` (1 MB, a quarter of the documented 4 MiB, which the server executes) a lint `parse_error` whose text says `too_large`; there is no reason code for it. A statement or request that crosses a time limit is `MIGRATION_EXECUTION_FAILED` + SQLSTATE 57014 (statement timeout), `MIGRATION_LOCK_TIMEOUT` (lock): both proven in `I15-time.int.test.ts`; the statement timeout has no code of its own.
- **Evidence:** `B/conformance/I15-limits.pure.test.ts`, `B/conformance/I15-time.int.test.ts`
- **Root cause:** limits were added with the code that needed them, not to the bundle contract.
- **Proposed fix:** one table in `migration-bundles.md` section 1; a reason `parse_budget_exceeded`; see decision B2-D6.
- **Acceptance test:** a docs test that parses the table and compares with the exported constants.

### [P3] The bundle store drops edits that do not change the checksum, although the documentation says it keeps them
- **Area:** packages/migrations-engine/src/store.ts (`ingestBundles`, "same" test), packages/migrations/src/lint/lint.ts (`comment_only_change`)
- **Block:** B (I13; also reported statically by B1 as FB1-9)
- **Reproduction:** ingest a bundle, then the same bundle with an extra comment line in `up.sql`, or with another `description`. Tests: `I13-immutability.int.test.ts` "a comment-only edit ... is stored as a new revision (verify_revision)" and "a changed description ...".
- **Expected:** `store.ts` header and `migration-bundles.md` section 3: "a new verify, rollback or comment content with the same apply checksum is a `verify_revision`"; the new bytes are stored and `comment_only_change` can report them.
- **Actual:** status `unchanged`, the earlier revision is returned, the new bytes are dropped (the bundle digest is derived from three digests, never from bytes). What the human approved and what the repository holds can differ in comments and descriptions with no trace; `comment_only_change` cannot fire on the server path because the planner lints the stored bytes.
- **Evidence:** `B/conformance/I13-immutability.int.test.ts`
- **Root cause:** `store.ts:184-190`: `existing.find((r) => r.checksum === ... && r.bundleDigest === ...)` ignores the bytes.
- **Proposed fix:** compare the source digest and the manifest/verify/down bytes as well, and store a `verify_revision` (or a `metadata_revision`) when they differ.
- **Acceptance test:** the two I13 cases above.
