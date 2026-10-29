# D2: SQL execution safety (`sql_query`, `sql_explain`)

Tree under test: `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of PR #46), in a private worktree
(`ExponetDB-verify-d2`); nothing in it was edited. Toolchain: Node 24.22.1, Bun 1.4.4, UTC.
Servers: the product's own `tooling/dev/targets.sh` (TLS only, `hostssl ... scram-sha-256`), prefix `d2`,
containers `d2-pg16` / `d2-pg17` / `d2-pg18` on ports 56716-56718 (PostgreSQL 16.15, 17.11, 18.6 on the pinned
`pgvector/pgvector` images), `d2-control` (Control Store, 56731) and `d2-s3` (56770) for the MCP/REST harness.
All containers are removed at the end. The roles are the product's bootstrap roles (`clusterBootstrapStatements`),
so `exponetdb_reader` is exactly what a managed cluster gets: `LOGIN NOSUPERUSER BYPASSRLS`, member of
`pg_read_all_data`, `default_transaction_read_only = on`, `idle_in_transaction_session_timeout = 30s`.

## What was run

| Path | How | Result file |
|---|---|---|
| Guard as a pure function | `admitRead(major, dataReadText(kind, sql, analyze))` and `classifySql` (what the Web SQL editor shows) for every corpus statement, 16/17/18 | `results.md` columns guard, `classify` is in the raw run |
| End to end through the worker's executor | `executeDataRead` on a real `exponetdb_reader` session (`TargetSession.open`, same startup options, read-only frame, cursor, caps), agent class, 16/17/18 | `results.md` columns outcome, layer, side effect |
| Server layers without the guard | the same text sent without admission: R reader in the product's frame (extended protocol), S superuser in the frame, Ss superuser in the frame over the simple protocol (multi-statement), R0 reader with no frame (simple protocol) | `results.md` column server |
| Real program: `/mcp` and REST | `mcp-sql-corpus.int.test.ts` runs the corpus through `sql_query` / `sql_explain` (agent) and `POST /targets/{id}/queries` / `/explain` (person) over the sealed lane and the worker, on PostgreSQL 17, and checks that nothing in the target changed | `results.md`, last section |
| Catalog sweep | all 209-213 relations of `pg_catalog` / `information_schema` as the reader and as a plain login role, with a planted canary in the server configuration | `results.md` |
| User code on reads | `usercode.ts`: 13 shapes (casts, index expressions, statistics, partition key, range type, PG18 virtual generated column, defaults, triggers, policies, domain and CHECK constraints, security_invoker view) with a function that raises when the reader runs it | `results.md` |
| Limits | row cap, byte cap, 100 MB value, `statement_timeout`, `lock_timeout`, cancel (mid-run, before start), temp files, memory, error texts | `results.md` |
| Resource exhaustion and a dead backend | `bomb.ts`, `crash.ts`, `cursor-hang.ts`, `tempfix.ts`, `role-depth.ts` | `results.md` |

Side effects were measured after every run by a superuser snapshot of the fixture: table rows, a log table that
every user function writes to, sequence state, large objects, catalog (relations, columns, functions, schemas),
roles, role settings, memberships, extensions, advisory locks, prepared transactions, notifications on a
`LISTEN`ing connection, and marker files in the container. A change starts the next run from a fresh database.

## Result in one paragraph

Verdict **PARTIAL**. The read-only frame held: 607 corpus statements x PostgreSQL 16, 17 and 18 (1,821 runs through the
worker's executor on a real `exponetdb_reader` session) produced no write, no lock that outlived the session, no file or
program access and no disclosure of a secret catalog; 1,387 runs were stopped by the guard, 42 by the reader role
(42501), 42 more were harmless server errors, 350 were legitimate reads (catalog rows name roles and FDW options: data, not errors); 157 statements through `/mcp` and REST changed
nothing either. Row cap, byte cap (5 MiB), `statement_timeout`, `lock_timeout` and cancel work on all three majors, the
session is gone afterwards, and no refusal or error text carried a host, path or connection string (the scan covers every outcome; the only hits are
catalog result rows). What fails is not the
read-only frame but the robustness of the read around it: (1) a read never returns when its backend dies, which wedges
the worker's two reader slots of the cluster; (2) one allowlisted statement makes the kernel kill a backend and PostgreSQL
restart every session of the cluster; (3) one `generate_series` read writes 100-160 MB/s of temp files with nothing to
stop it but the 60 s timeout. Details and reproductions are in `results.md` (last sections) and in the findings of the
final report.

## Files

| File | Content |
|---|---|
| `corpus.jsonl` | 622 statements (`id`, `class`, `kind`, `sql`, `expected`, optional `note`). Built by `build-corpus.mjs`. `expected` is what the documented design plus common sense require: `REFUSED_BY_GUARD`, `RUNS_READ_ONLY`, `BLOCKED_BY_SERVER_ROLE`. 27 expectations were corrected after the first run (my assumption was wrong, not the product); each carries a `note` |
| `run.ts` | corpus, limits and sweep runner (`--section corpus|limits|sweep|all`, `--majors`, `--filter`) |
| `limits.ts`, `sweep.ts`, `usercode.ts`, `bomb.ts`, `crash.ts`, `cursor-hang.ts`, `tempfix.ts`, `role-depth.ts` | the other scripts |
| `mcp-sql-corpus.int.test.ts` | the `/mcp` + REST harness (copy into `apps/server/test/` of a worktree) |
| `report.ts` | builds `results.md` from the raw run output (kept out of the repository: `scratchpad/d2-out`) |
| `results.md` | the table: id, class, statement, guard, server, outcome, layer, side effect, verdict; then the sections above |

## How to re-run

```
git -C <repo> worktree add --detach <dir> d51da5d0d8832ebc569f23985c7e5176e4d450ad
source <tools>/env-pinned.sh && (cd <dir> && bun install --frozen-lockfile)
EXDB_DEV_TARGET_PREFIX=d2 EXDB_DEV_TARGET_BASE_PORT=567 bash <dir>/tooling/dev/targets.sh <certs-dir>
export EXDB_TREE=<dir> EXDB_TEST_TARGETS=<certs-dir>/targets.json
nice bun --conditions @exponetdb/source run.ts --section corpus --out <out>
nice bun --conditions @exponetdb/source run.ts --section sweep --out <out>
nice bun --conditions @exponetdb/source run.ts --section limits --out <out>   # sets a 3 GiB memory limit on the containers
bun report.ts <out> > results.md
```

## NOT RUN

- Real servers (`reos-db-01`, `db.exponetdb.cloud`): out of scope by the rules; no real `pg_hba.conf`, no real extension set.
- HTTP `sql_cancel` / `POST .../queries/{id}/cancel`: the executor-level cancel was run (works on 16, 17, 18; it also
  works before the read starts); the HTTP route was not run (the product's own `mcp-data.int.test.ts` covers it).
- Browser run of the Web SQL editor: the editor's two calls (`runQuery`, `explainQuery`) and `classifySql` were tested
  as the REST routes and as a pure function; no Playwright session.
- Canary search over logs, audit and metrics for the SQL text of these statements: belongs to the canary block.
- The worker's graceful stop with a hung read: observed once (the harness `afterAll` timed out after 10 minutes in an
  earlier run; the log did not survive a session restart), not repeated.

## Caveats (what these results do not prove)

- The servers are disposable Docker containers on the product's test hba (`hostssl ... scram-sha-256`, `local ... trust`).
  `reos-db-01` and any other real server were not touched. A real cluster has its own `pg_hba.conf`, extensions,
  `shared_preload_libraries`, ownership and privilege history; extension/foreign-table cases (`dblink`, `postgres_fdw`,
  `file_fdw`) were tested with a foreign table owned by the superuser, the case that matters.
- The `dblink_connect` / `postgres_fdw` statements are refused by the guard before the server sees them; with the guard
  removed (R) the reader could not use them either way in this hba (`password is required`/privilege errors), which was
  not a property of the product.
- The worker (`DataReadWorker`) and `serve` were exercised through the repo's own integration world on PostgreSQL 17
  only (one target, two tiers), with every statement in the corpus at `D2_STRIDE=3` (every third statement of each
  class), because every MCP/REST call is audited and the machine was loaded. The statement-level code is the same
  function in the worker (`executeDataRead`), which was run over the whole corpus on 16, 17 and 18.
- Linux cgroup memory limits (3 GiB) were set on the containers for the limit and memory tests; without a limit the
  host's OOM killer decides which process dies.
- The CLI has no command that reaches `query.run` (`exponetdb dev sql` is the lab's own psql as a local superuser in the
  lab containers and never reaches a registered target); the Web SQL editor and the table browser call the same REST
  operations (`runQuery`, `explainQuery`) through the SDK. Neither has its own execution path.
- A comment on `expected`: where the design document says nothing (for example `pg_file_settings`), the expectation
  is the safe one; the cases are listed in the `note` fields.
