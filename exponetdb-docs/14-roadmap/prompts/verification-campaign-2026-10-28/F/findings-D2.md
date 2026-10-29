### [P1] A data read never returns when its backend dies; two such reads wedge the cluster's reader slots
- **Area:** `packages/postgres` (`TargetSession.runAdmittedRead`, `readCursor`, `runAdmittedCheck`), `apps/server/src/composition/data-read.ts`, `DataReadWorker`
- **Block:** D
- **Reproduction:** with `EXDB_TREE` and `EXDB_TEST_TARGETS` set (README of `D/sql-execution/`, "How to re-run"): `bun --conditions @exponetdb/source crash.ts --major 16 --mode sigterm` (and `--mode kill9`, which is what an OOM kill does): starts a 60 s read via `executeDataRead` and terminates its backend. Library level: `cursor-hang.ts`. Whole program: `mcp-sql-corpus.int.test.ts -t terminated`: two long `sql_query` reads, both backends terminated.
- **Expected:** `executeDataRead` ends within seconds with `TARGET_UNAVAILABLE`; the session is destroyed and the slot released; the next read works.
- **Actual:** no result 80 s after the kill in both modes (statement timeout 60 s). Through `/mcp` both callers get HTTP 504 after 91 s; the next `sql_query` on the cluster answers `TARGET_UNAVAILABLE` because the two reader slots (`DATA_READ_SLOTS_PER_CLUSTER = 2`) are held by the hung reads, so the cluster has no data reads until the worker restarts; the lane also counts the hung reads (`RATE_LIMITED` for the agent meanwhile). An earlier run: the harness `afterAll` (`w.stop`) hung 10 minutes.
- **Evidence:** `D/sql-execution/data/crash-pg16-sigterm.json`, `crash-pg16-kill9.json`, `cursor-hang.txt`, `mcp-wedge.json`, `vitest-mcp-summary.txt`; `D/sql-execution/results.md` section "Exhaustion of the target and a dead backend".
- **Root cause:** `await cursor.close().catch(() => undefined)` in the `finally` blocks of `packages/postgres/src/session.ts:850` (`runAdmittedRead`), `:753` (`runAdmittedCheck`), `:656` (`readCursor`), checked by the lead. `pg-cursor` 2.22.1 `close()` on a dead connection waits for a `readyForQuery` that never comes, so the promise never settles and the `catch` cannot help. `apps/server/src/composition/data-read.ts:40-52` releases the slot only after `executeDataRead` returns; `DataReadWorker` abort only sends a cancel (a no-op on a dead backend) and has no hard deadline.
- **Proposed fix:** never await `close()` on a broken or unqueryable client (mark broken, destroy the socket, skip close; or race close with 1 s and destroy); add a hard deadline around `executeDataRead` in `dataReadExecutor` (statement timeout plus grace, then destroy the session and release); the same for `readCursor` and `runAdmittedCheck` (the `verify.sql` path).
- **Acceptance test:** integration test on PostgreSQL 16/17/18: start a long read, `pg_terminate_backend` (and SIGKILL) its backend, assert `executeDataRead` resolves with `TARGET_UNAVAILABLE` within 5 s, the connection budget is free and the next read succeeds; plus the MCP test of `mcp-sql-corpus.int.test.ts` turning green.

### [P1] One allowlisted read crashes the target PostgreSQL: memory exhaustion restarts every session of the cluster
- **Area:** `packages/postgres/src/parser/allowlist.ts` (`repeat`, `array_agg`, `string_agg`, `generate_series`, `lpad`, `rpad`, `array_fill`), `data.read`
- **Block:** D
- **Reproduction:** a container with a 3 GiB memory limit (`docker update --memory 3g --memory-swap 3g`); `bomb.ts --major 17`: `executeDataRead` (agent, 60 s timeout, the path of `sql_query`) of `SELECT array_agg(repeat('x', 100000000)) FROM generate_series(1, 100)`. Reproduced twice in each of two sessions (4 times in total).
- **Expected:** the read is refused, or fails with an error; other sessions of the cluster are unaffected.
- **Actual:** the kernel kills the backend (SIGKILL); the postmaster logs "terminating any other active server processes ... all server processes terminated; reinitializing"; a bystander session (another tenant) was dropped ("Connection terminated unexpectedly"); recovery takes about 4 s; the container OOMKilled flag is set; `statement_timeout` cannot help (the allocation takes under a second); the worker read then hangs (previous finding). This is a restart of the managed PostgreSQL by an authorised read: no data loss (WAL recovery) and no gate bypass, but a production outage of a few seconds per call; by the brief's own definition ("P0 ... production outage") the owner may count it as P0 (D2 open decision 1). Agent reads of production are `humans_only` by default (OD-13), so the reachable caller on production is a person with `data.read:prod`.
- **Evidence:** `D/sql-execution/data/bomb-pg17.jsonl` (label `aggregate-of-big-values`: peakContainerMb 3069, oomKills 1, bystanderSessionSurvived false); `results.md` section "Exhaustion of the target and a dead backend".
- **Root cause:** the allowlist admits functions "known not to have side effects" (`allowlist.ts`, lines 102-106, 193-194 checked by the lead) but treats memory as free; PostgreSQL has no per-query memory limit and `work_mem` does not bound aggregates or `repeat()`; `sql-execution-security.md` §2.2 bounds only the worker's memory.
- **Proposed fix:** no complete fix inside the guard. Layered: refuse constant size arguments above a cap and any non-constant size argument for `repeat`, `lpad`, `rpad`, `array_fill` and unbounded `generate_series`; record a memory limit (cgroup or `vm.overcommit_memory=2`) as a registry fact for a target that allows `data.read` and warn otherwise; fix the previous finding so the caller gets `TARGET_UNAVAILABLE` fast; the owner decides the residual risk.
- **Acceptance test:** on a cgroup-limited container, the statement above is refused by admission (`QUERY_CONSTRUCT_UNSUPPORTED`) and the postmaster log of the container contains no "signal 9" after a run of the memory corpus (`bomb.ts` scenario 3 turns into a refusal test).

### [P2] A single read floods the target's disk with temp files; the row cap does not bound the work
- **Area:** `packages/postgres/src/bootstrap.ts` (`SETTINGS.reader`/`verifier`, `bootstrapScript`), `data.read`
- **Block:** D
- **Reproduction:** `bomb.ts` scenario `temp-files-15s` (PostgreSQL 17) or `limits.ts`: `SELECT g FROM generate_series(1, 1000000000) g` as agent (row cap 500, timeout 15 s); `tempfix.ts --major 16` shows the fix.
- **Expected:** 500 rows with `truncated: true` (`sql-execution-security.md` §2.2), bounded disk use.
- **Actual:** `QUERY_TIMEOUT`, no rows; the temp directory holds 2,262 MB after 14 s on PostgreSQL 17 (about 150 MB/s; 1.5 GB in 8.6 s on PostgreSQL 16), about 9 GB per read at the 60 s agent timeout, with 2 agent reads per target at once; `FunctionScan` materialises the set-returning function before the first row.
- **Evidence:** `D/sql-execution/data/bomb-pg17.jsonl`, `tempfix-pg16.json`, `limits-pg16/17/18.jsonl` (limit-001, human-rows).
- **Root cause:** `bootstrap.ts:48-51` (reader) and the matching lines in `bootstrapScript` set no `temp_file_limit` (the lead's grep finds none); admission allows set-returning functions in `FROM`.
- **Proposed fix:** add `temp_file_limit` (for example 1GB) to the reader and verifier role settings in both bootstrap generators and document it; existing clusters: `ALTER ROLE exponetdb_reader SET temp_file_limit = '1GB'`.
- **Acceptance test:** integration test on PostgreSQL 16/17/18: the read above fails with SQLSTATE 53400 (`QUERY_FAILED`) within a few seconds and the temp directory stays under the limit (observed with 256 MB: 53400 after 1.2 s, peak 239 MB, against 1,569 MB without).

### [P3] Allowlisted functions and views disclose server details to every data.read caller
- **Area:** `allowlist.ts` (`inet_server_addr`, `inet_server_port`, `current_setting`), admission (`information_schema._pg_foreign_*`)
- **Block:** D
- **Reproduction:** `sql_query` of `SELECT inet_server_addr(), inet_server_port(), version()`; `SELECT name, setting FROM pg_catalog.pg_settings WHERE name ~ '(file|command)$'`; `SELECT * FROM information_schema._pg_foreign_tables`.
- **Expected:** a data reader learns no server address, key file paths, archive/restore commands or FDW file paths.
- **Actual:** the server's address and port, `ssl_key_file`/`ssl_cert_file` paths, `archive_command`, `restore_command`, `cluster_name`, and the options (file names) of foreign tables come back; a plain login role gets zero rows for the foreign-table views (the `pg_read_all_data` effect, sweep delta).
- **Evidence:** `results.md` (catalog sweep, rows func-062, func-069, func-070); `data/sweep-pg17.json`.
- **Root cause:** `allowlist.ts` lists `inet_server_addr`, `inet_server_port` and `current_setting` without a name filter; `SECRET_CATALOG_RELATIONS` (`admission.ts:144`) lacks `information_schema._pg_foreign_*`.
- **Proposed fix:** remove `inet_server_addr` and `inet_server_port`, restrict `current_setting` to a name allowlist, add `_pg_foreign_data_wrappers`/`_pg_foreign_servers`/`_pg_foreign_table_columns`/`_pg_foreign_tables` to the refused list.
- **Acceptance test:** the four statements are refused with `QUERY_CONSTRUCT_UNSUPPORTED` on 16/17/18.

### [P3] The Web editor's classifier calls EXPLAIN a read-only path that sql_query refuses
- **Area:** `packages/diagnostics/src/sql-classification.ts`, `data.read`
- **Block:** D
- **Reproduction:** `classifySql(17, "EXPLAIN SELECT 1")` gives `readOnlyPath.admitted` true; `sql_query` with the same text answers `QUERY_CONSTRUCT_UNSUPPORTED` (`statement_class`). Corpus rows proc-038 to proc-041.
- **Expected:** consistent answers, or the classifier names the explain tool.
- **Actual:** the editor suggests a path that the query tool refuses; no safety impact (the guard is the server's).
- **Evidence:** `results.md` rows proc-038 to proc-041.
- **Root cause:** `classifySql` reuses `admitRead`, whose "explain" class is only valid for kind explain (`executor.ts:184`).
- **Proposed fix:** report `readOnlyPath` per tool (query or explain) or add `explain_only`.
- **Acceptance test:** `classifySql("EXPLAIN SELECT 1")` is not "admitted" for the query path.
