### [P2] sql_query refuses unqualified relation names and system views with a misleading construct error (E3)
- **Area:** MCP/REST read lane, SQL admission (`sql_query`, `sql_explain`)
- **Block:** C, E3
- **Reproduction:** MCP `sql_query` on `reosa/platform/scratch`: `select count(*) from pg_stat_activity` and `select name, setting from pg_settings where name='max_connections'` and `select count(*) as n from tenants` and `select count(*) from pg_class` each answer `QUERY_CONSTRUCT_UNSUPPORTED` with `details.construct` set to the bare relation name. The same statements with a schema qualifier (`pg_catalog.pg_stat_activity`, `pg_catalog.pg_settings`, `public.tenants`) succeed (17 sessions, `max_connections` 150, 0 rows). `select current_user` alone also succeeds, so the earlier "tenants plus current_user" report is really "unqualified name".
- **Expected:** either unqualified names resolve against the target's fixed `search_path` (documented), or the refusal says "qualify the relation with its schema" and names the schema to use; connection counts must be readable (the health model has `connections_high`).
- **Actual:** the error calls an ordinary table "a construct the admission cannot classify as free of side effects". An agent cannot discover that a schema qualifier is the fix; it concludes `pg_stat_activity` is forbidden and that connection counts cannot be read.
- **Evidence:** `C/live-mcp-reads.md` (this campaign, section E3)
- **Root cause:** the admission in `packages/postgres/src/sql-admission*` (relation resolution rejects unqualified names) and the error mapping that puts the relation into `details.construct`; the catalog message is in `packages/contracts/src/errors.ts` (`QUERY_CONSTRUCT_UNSUPPORTED`). Locate with `grep -rn QUERY_CONSTRUCT_UNSUPPORTED packages`.
- **Proposed fix:** resolve unqualified names with the session's pinned `search_path` (`pg_catalog` first, then the project's managed schemas) before classification, or return a typed refusal with `reason: unqualified_relation` and `remediation: "write schema.name, for example pg_catalog.pg_stat_activity"`. Document that system views in `pg_catalog` are readable when qualified.
- **Acceptance test:** integration test against PostgreSQL 17: `select count(*) from pg_stat_activity` is either answered or refused with `reason: unqualified_relation` and a remediation that names the qualified form; `pg_catalog.pg_stat_activity` and `public.<table>` keep passing; a table named like a system view in another schema is not confused with it.

### [P2] query_stats is unavailable on every registered target and its error names the wrong cause
- **Area:** diagnostics (`query_stats`, `diagnose query-stats`), error catalog
- **Block:** C
- **Reproduction:** MCP `query_stats` on `reosa/platform/scratch` and on `reosa/platform/staging`, and `exponetdb diagnose query-stats` on both: `CAPABILITY_UNAVAILABLE` "The node does not report this capability version, or the cluster is external." `pg_catalog.pg_extension` on both targets lists only `pg_trgm`, `plpgsql`, `vector`: `pg_stat_statements` is not installed. The cluster is `management_mode=agent` with an active node, so the message is wrong.
- **Expected:** the refusal says the extension `pg_stat_statements` is missing (or not preloaded) and what to do (a `shared_preload_libraries` change plus extension create, planned through node plans).
- **Actual:** the message blames the node or an external cluster. Combined with TC "config and roles cannot be planned from the CLI" the operator has no path to enable the feature from the CLI.
- **Evidence:** `C/live-mcp-reads.md` (section query_stats); code path read in `packages/diagnostics/src/statements.ts:201-214` (outcome `extension_missing`) and `:787-789` (throws plain `CAPABILITY_UNAVAILABLE`).
- **Root cause:** `packages/diagnostics/src/statements.ts:787-789` maps `extension_missing` to the generic `CAPABILITY_UNAVAILABLE` without `details`; the generic message is in `packages/contracts/src/errors.ts`.
- **Proposed fix:** throw `CAPABILITY_UNAVAILABLE` with `details: { reason: 'extension_missing', extension: 'pg_stat_statements' }` and a catalog remediation that reads "install pg_stat_statements (shared_preload_libraries and CREATE EXTENSION) on the target, then wait for the next sample"; show the same in the Web performance page and CLI text output.
- **Acceptance test:** unit test of the `getQueryStats` read with a last sample `extension_missing`: the error carries `details.reason = 'extension_missing'`; CLI text output prints the remediation; REST contract test pins the shape.

### [P2] `node show` and the node view always say "No clusters reported" (E2)
- **Area:** node views (`packages/nodes`), CLI, REST `GET /nodes/{id}`, Web node page
- **Block:** C, E2
- **Reproduction:** on the live node: `exponetdb node show nod_01M5XZ84V768SYCHZKRNGJFQP2` prints "No clusters reported." and `--output json` has `clusters: []`; MCP `node_status` also `clusters: []`. Reproduced with a real agent on a disposable systemd host (`E/e2-e6-live-host-run.log`): `nodes.nodes.clusters` holds `[{"localName":"17/exdbnode","port":55417,"running":true,"version":"17.11","systemIdentifier":"7701448509665702082",...}]` while `nodes.nodes.heartbeat->'clusters'` is `[]`, and REST `GET /api/v1/nodes/{id}` returns `clusters: []`.
- **Expected:** the node view lists the clusters the node serves with running state, pending restart and the TLS certificate expiry (the CLI table has columns for them).
- **Actual:** never any cluster; the columns `RESTART PENDING` and `TLS UNTIL` can never show a value; `clusterId` is also hard-coded `null` in the view.
- **Evidence:** `E/e2-e6-live-host-run.log`; `C/node-plans-report.md` (D10).
- **Root cause:** `packages/nodes/src/views.ts:105` reads `heartbeat['clusters']`, but the agent's heartbeat sends an empty list by construction (`agent/node/internal/agent/agent.go:510`, `Clusters: []protocol.HeartbeatRequestCluster{}`); the clusters arrive in the hello and are stored in the `clusters` column (`packages/nodes/src/mapping.ts:77` reads that column for planning). `clusterId: null` is set at `views.ts:111-119`.
- **Proposed fix:** build the view from the stored `clusters` column (hello) merged with the heartbeat's per-cluster state, map `systemIdentifier` to the registry cluster id for `clusterId`, or have the agent send its clusters in the heartbeat (a protocol-minor, additive change with a contract test).
- **Acceptance test:** integration test in `packages/nodes` (or a host scenario): after enrollment, `GET /nodes/{id}` returns one cluster with `localName`, `running: true` and a mapped `clusterId`; CLI `node show` renders it; restart-pending toggles after a pending-restart parameter is set.

### [P3] Enrollment tokens cannot be listed or revoked, and a dead token's state never becomes expired (E6)
- **Area:** nodes enrollment, REST, CLI, Web, retirement preflight
- **Block:** C/D, E6
- **Reproduction:** REST probes on a host-test control plane: `GET /api/v1/enrollment-tokens`, `GET /api/v1/enrollment-tokens/{id}`, `DELETE ...`, `POST .../revoke` all answer 404 (`E/e2-e6-live-host-run.log`); the only route is `POST /enrollment-tokens/{id}/reveal` (`packages/contracts/src/rest/routes.ts:2128`). `node enrollment status` lists nodes only, not tokens, so the live unused token `ent_01M5XZ0J5CTYJBGB9XSVCPZFRE` cannot be seen at all.
- **Expected:** an operator can see open tokens with their state and expiry and can revoke one; a token past its lifetime reads `expired`.
- **Actual:** a token does expire in practice (reveal window 30 min after creation, redeem window 30 min after reveal, checked in `nodes.enroll` with `clock_timestamp() < t.expires_at`, `packages/control-store/migrations/01M49K5NQ8ZB4W2T6Y3H7RXJMD_nodes/up.sql:578-580`), but nothing writes the state `expired` (the guard allows it, `up.sql:317`), no read lists tokens, and there is no revoke. The retirement preflight treats a token as open for 5 minutes past `expires_at`.
- **Evidence:** `E/e2-e6-live-host-run.log`; `B/review-items-static-audit.md` (U5 table row "Enrollment token").
- **Root cause:** missing read and revoke surfaces; no worker sweep sets `expired`.
- **Proposed fix:** additive Control Store bundle plus a worker sweep that sets `expired`; add `GET /servers/{id}/enrollment-tokens` (ids, state, times, never secrets) and `POST /enrollment-tokens/{id}/revoke` (a new state `revoked`, human only, audited); show them on the server page and in `node enrollment status`.
- **Acceptance test:** integration test: create a token, let `expires_at` pass (clock seam), the sweep sets `expired`; a token revoked before use refuses `nodes.enroll` with the one generic refusal and is audited; the CLI lists both.

### [P3] A `time`-zone dependent unit test fails in a non-UTC shell (A)
- **Area:** packages/ui-patterns tests
- **Block:** A
- **Reproduction:** `TZ=Europe/Berlin bun run --cwd packages/ui-patterns test` fails `test/metric-card/index.test.tsx > MetricCard > marks a stale value as stale and shows how old it is` ("Unable to find an element with the text: 13 Oct 2026 14:03") on 3 of 3 runs (the full `bun run test` aborts at this point and turbo kills `apps/web` and `apps/design-system`); with `TZ=UTC` all 90 files and 1,141 tests pass, and the full suite passes on a UTC host (server run).
- **Expected:** tests pass in any time zone (the PRE-WAVE-11 review noticed it and left it).
- **Actual:** developers outside UTC cannot get `bun run verify` green; the failure hides the later packages.
- **Evidence:** `A/test.log`, `A/rerun-ui-patterns-cet-1.log`, `A/rerun-ui-patterns-cet-2.log`, `A/rerun-ui-patterns-utc.log`.
- **Root cause:** `packages/ui-patterns/test/metric-card/index.test.tsx:83` expects UTC clock text from a component that formats in local time; the vitest config sets no `TZ`.
- **Proposed fix:** set `process.env.TZ = 'UTC'` in the shared vitest setup (`vitest.shared.ts`) or pass an explicit time zone to the formatter under test.
- **Acceptance test:** `TZ=Europe/Berlin bun run --cwd packages/ui-patterns test` and `TZ=America/Los_Angeles ...` pass.

### [P3] `mcp:evals` counts a missing API key as 14 failed tests and sits outside `verify`
- **Area:** apps/server evals, `package.json` scripts
- **Block:** A
- **Reproduction:** `bun run mcp:evals` without `EXDB_EVAL_ANTHROPIC_API_KEY`: 14 tests FAIL with "NOT RUN: set EXDB_EVAL_ANTHROPIC_API_KEY ..." and exit 1.
- **Expected:** a clearly reported skip (or an explicit `NOT RUN` state) that cannot be mistaken for a regression, and the evals documented as not part of `verify`.
- **Actual:** the suite exits 1; the root `verify` script does not call it, so a reader of "all suites" cannot tell it was never run.
- **Evidence:** `A/mcp-evals.log`.
- **Root cause:** `apps/server/test/mcp-evals.model.test.ts:83` throws instead of skipping.
- **Proposed fix:** report the missing key through the vitest skip mechanism with the exact reason, and list `mcp:evals` in `test-strategy.md` as an owner-run suite.
- **Acceptance test:** without the key the run reports 14 skipped, exit 0, and prints the reason; with a key the tests run unchanged.

### [P3] The pinned toolchain is not enforced by `bun install` and local runs silently use other versions
- **Area:** tooling, `package.json` `engines`
- **Block:** A
- **Reproduction:** on a machine with Node 26.5.0 and Bun 1.3.14 (outside `engines`: node `>=24.22.1 <25`, bun `>=1.4.4`) `bun install --frozen-lockfile` succeeds without a warning and the suites run; `apps/cli test:install` fails only because it needs Node 24 (`apps/cli/test/packed.install.test.ts:85`).
- **Expected:** a clear refusal or warning that the toolchain is outside the supported range.
- **Actual:** results from an unsupported toolchain look authoritative (this campaign re-ran the decisive suites on the pinned Node 24.22.1, Bun 1.4.4, Go 1.26.10).
- **Evidence:** `A/bun-install.log` (scratch), `A/cli-test-install.log`, `A/versions` run on server (`D/ci-replica/versions.log`).
- **Root cause:** `engines` is advisory in Bun; no preinstall check.
- **Proposed fix:** add a `scripts/check-toolchain.ts` run by `verify` and a `preinstall` that prints the mismatch and fails under `CI=true`.
- **Acceptance test:** running `bun run verify` under a Node outside the range exits non-zero with the named versions.

### [P2] Read-classified diagnostics and advisor actions persist data and flood the findings counters (OD-57 in practice)
- **Area:** diagnostics, findings, MCP `advisors_run`/`drift_check`, CLI `diagnose advisors`, Web overview
- **Block:** C
- **Reproduction:** `exponetdb diagnose advisors reosa/platform/staging` (catalogued `read`) raised the open findings of staging from 0 to 215; `advisors_run` on scratch added 228 (`rls_enabled_without_policy` 100, `unindexed_foreign_key` 100, ...) and wrote an `advisor.run` audit event; `drift_check` on scratch reports `drifted: 13741` with 500 findings returned (`truncated: true`) all `critical` `object_added` because the rehearsal copy has no ledger and an empty baseline. MCP responses were 131,395 and 229,168 characters.
- **Expected:** read-classified calls do not change counters that the owner reads as risk; a rehearsal copy without a baseline does not raise 13,741 critical findings; tool results are capped.
- **Actual:** the Overview shows 520 critical findings of 14,184 of which 518 are scratch drift noise, one is a roll-up that counts the others again, and exactly one is real; the owner cannot see real findings. Responses of 130 to 230 KB cannot be consumed by an agent.
- **Evidence:** `C/live-mcp-reads.md`, `C/cli-read-sweep.md` (D2), `C/web-audit.md` (W-03).
- **Root cause:** advisor and drift runs record findings under a read scope (OD-57 open); drift on a target without a baseline reports every object as `object_added` (`packages/diagnostics/src/drift*`); no output cap in the MCP tool results.
- **Proposed fix:** (owner decision OD-57) classify `advisors_run` and `drift_check` as record actions with their own scope and rate limit; do not run a drift comparison without a baseline (report `no_baseline` once); aggregate `drift_open` roll-ups out of severity counters; cap MCP results (for example 64 KB with a cursor) and group repeated finding codes.
- **Acceptance test:** drift on a target with an empty baseline yields one `no_baseline` finding, not N `object_added`; the fleet critical count excludes roll-ups; `advisors_run` output is below the cap with a `nextCursor`; scope test: a read-only grant is refused for the recording actions once OD-57 is decided.

### [P3] CLI lint table does not show which finding blocks; `project execution-roles` takes only an id
- **Area:** CLI usability
- **Block:** C
- **Reproduction:** a bundle with `table_without_grant` under the default strict profile prints `LEVEL warn` yet "BLOCKED 1 findings, 1 blocking" and exit 1 (JSON shows `level: warn, blocking: true`); `exponetdb project execution-roles reosa/platform` answers `VALIDATION_FAILED /projectId: Expected the prefix prj_` while `target`, `migration` and `health` accept paths.
- **Expected:** a BLOCKING marker per row; paths accepted wherever a product/project path is natural.
- **Actual:** the table reads as if nothing blocks; the id-only command surprises.
- **Evidence:** `C/live-migration-attempt.md`.
- **Root cause:** `apps/cli/src/output/views.ts` lint table omits `blocking`; `apps/cli/src/commands/registry.ts` `project execution-roles` param is a raw `projectId`.
- **Proposed fix:** add a `BLOCKS` column; resolve a `product/project` path to the id in the CLI (one read) for every project command.
- **Acceptance test:** CLI unit tests for both outputs; `project execution-roles reosa/platform` works against the fake server.

### [P3] Two step-up receipts of 120 seconds each are needed to enroll a node (E10)
- **Area:** auth step-up, node enrollment
- **Block:** E10
- **Reproduction:** read from `packages/auth/src/stepup.ts:29-30,269`: `STEP_UP_SECONDS = 600`, `RECEIPT_SECONDS = 120`; the actions `plan.apply` (apply the `node.enroll` plan) and `node.enrollment_token.reveal` each need their own receipt (`STEP_UP_ACTIONS`, line 22). Host scenario `enrollment.host.test.ts` calls `w.reauth()` twice.
- **Expected:** one step-up covers the two consecutive steps of one enrollment, or the second receipt is bound to the first plan; the runbook says so.
- **Actual:** two passkey prompts within about two minutes each; reported as unfriendly from CLI sessions that cannot step up (R-CLI-1).
- **Evidence:** code reading; `E/e-findings-local.md` does not cover it; host run `D/ci-replica` shows two reauths in the scenario.
- **Root cause:** one action per receipt by design (ADR-0026).
- **Proposed fix:** (owner decision) a combined `node.enroll` step-up whose receipt is accepted for both actions of that plan, or raise `RECEIPT_SECONDS` for those two actions to 5 minutes; document in `node-runbook.md` §3.
- **Acceptance test:** integration test: one receipt of the combined action applies the plan and reveals the token for that plan only; a receipt for another plan is refused.

### [P3] The default visual-regression baseline set `local` fails on any machine other than the one that recorded it
- **Area:** `apps/server` visual regression e2e
- **Block:** A
- **Reproduction:** `bun run test:e2e` on a WSL2 Ubuntu host (Node 26.5, Bun 1.3.14): `visual-regression.e2e.test.ts` fails both tests (`matches the baselines at 1440x900`: e.g. `desktop/light/ui/button/states: 2057 of 81872 pixels differ`, 10 further frames; `390x844`: `1918 of 53694`); the 9 other files (50 tests) pass. On a disposable Ubuntu 24.04 host with the pinned toolchain and `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04` (what CI sets) `bun run test:e2e` passes (6 min, `D/ci-replica/summary`).
- **Expected:** a contributor's clean checkout gets a green `bun run test:e2e` or a clear statement that the default set is machine-specific.
- **Actual:** the default `local` set (`apps/server/test/visual-baselines/local`) only matches the machine that recorded it; fonts and rasterization differ elsewhere.
- **Evidence:** `A/test-e2e.clean.log`; `D/ci-replica/test-e2e2` (summary lines in `D/ci-replica/summary.txt`).
- **Root cause:** `apps/server/test/visual-regression.e2e.test.ts:34` default `EXDB_VISUAL_BASELINE_SET ?? 'local'`.
- **Proposed fix:** default to `ci-ubuntu-24.04` when `process.platform === 'linux'` and fonts match, or fail fast with "no baseline set for this platform: set EXDB_VISUAL_BASELINE_SET or run EXDB_UPDATE_VISUAL=1" when the platform has no recorded set; document in `local-development.md`.
- **Acceptance test:** the test run on a platform without a baseline set fails (or skips with the explicit message) before comparing pixels; CI keeps passing.

### [P3] Permission-layer denial of the one allowed read-only check of the live control store
- **Area:** campaign limitation (recorded for the owner, not a product defect)
- **Block:** C
- **Reproduction:** `ssh exponet-server "docker exec rsbn9zqgegt2wpebijlnrmm4 psql -U postgres -d exponetdb_control -At -c 'select ... from nodes.nodes'"` was blocked by the session's permission layer ("Production Reads"); the lead did not work around it.
- **Expected:** the brief allows read-only `psql` there.
- **Actual:** E2's `nodes.nodes.clusters` could not be read live; it was proved on a disposable host with a real agent and in code instead.
- **Evidence:** `C/live-mcp-reads.md`.
- **Root cause:** n/a.
- **Proposed fix:** owner: add a permission rule if live control-store reads are wanted in a later campaign.
- **Acceptance test:** none.
