# DDL hazard matrix (verification campaign B3)

What does the bundle system say about DDL that hurts a busy production database, before it
is applied, and what does it really do? The result table is
[`../ddl-hazard-matrix.md`](../ddl-hazard-matrix.md). This folder holds everything behind it.

Tree under test: `d51da5d0` (merge of fix PR #46). PostgreSQL 17.11 for every claim about
PostgreSQL behavior. Nothing here touches the product tree.

## Layout

| Path | What |
|---|---|
| `fixtures/hazard/` | One realistic bundle (`<ULID>_<id>-<slug>/` with `migration.yaml`, `up.sql`, `verify.sql`) per dangerous pattern, `h00` to `h46`, one linear `dependsOn` chain. Built with the product's own `exponetdb migration new`. |
| `fixtures/safe/` | The documented safe form of each pattern (`s01` to `s30`), same base schema. |
| `tools/specs.ts`, `tools/build-fixtures.ts` | The fixture source and the generator (`migration new` for ULID/`dependsOn`/manifest, then fills in the files). Regenerating creates new ULIDs. |
| `tools/run-cli-lint.sh` | The product's CLI, `exponetdb migration lint`, both projects, profiles `strict` and `standard`, PostgreSQL 17 grammar, prod rules, offline facts. Output: `evidence/cli-lint-*.txt`. |
| `tools/analyze.ts`, `tools/run-analysis.sh` | The same lint library plus the engine's `migrationAnalysis` and the `MIGRATION_RULES` policy engine, per bundle: lint findings, observed class, lock mode and severity, rewrite flag, transactional flag, policy decision. Modes: `offline` (what the CLI sees) and `plan-large` / `plan-small` (the context `planMigrationApply` builds: tier prod, live relation sizes, no `provenNotNull`). Output: `results/*.json`. |
| `tools/make-matrix.py` | Builds the table of the matrix from `results/` and `evidence/` (no rule id or lock mode typed by hand). |
| `pgcheck/` | Proof against PostgreSQL 17: `00-setup.sh` (schema from the fixture base bundle plus data), `01-checks.sh` (per statement: relfilenode changed = rewrite, sequential scans in the transaction, locks held), `02-more-checks.sh` (multi-session: lock queue, concurrent builds sampled in `pg_locks`, INVALID index, `VACUUM FULL`, `DETACH ... CONCURRENTLY`). Output: `evidence/pgcheck-*.txt`. |
| `pgbench/` | The load test (not run at scale yet): `run.sh`, `setup.sh`, `orders_rw.sql`, `scenarios/*.scn`, `summarize.py`. Dry run at 100k rows: `evidence/pgbench-dryrun-100k.csv`. |
| `evidence/` | Short text outputs (no raw logs, no dumps). |

## Reproduce (Part 1, no server needed except PostgreSQL 17 for `pgcheck`)

```sh
source /home/david/exdb-vc-tools/env-pinned.sh          # Node 24.22.1, Bun 1.4.4, UTC
export EXDB_TREE=/home/david/Development/ExponetDB-verify-b3   # worktree of d51da5d0, bun install --frozen-lockfile done
tools/run-cli-lint.sh                                   # the CLI, 4 runs -> evidence/cli-lint-*.txt
tools/run-analysis.sh                                   # lint + plan + policy -> results/*.json
python3 tools/make-matrix.py                            # the matrix table on stdout

# PostgreSQL ground truth (any PostgreSQL 17; libpq variables select it):
export PGHOST=127.0.0.1 PGPORT=56800 PGUSER=postgres PGPASSWORD=...   # from a file, not typed
pgcheck/00-setup.sh && pgcheck/01-checks.sh && pgcheck/02-more-checks.sh
```

How to read a cell of the matrix: `L:` lint rule and level, `BLOCKS` when the finding blocks
a production plan for that table (size unknown offline, so it blocks; in `plan-small`
mode, with a 1,000-row table, the size-dependent rules do not fire or do not block);
`P:` the plan's analysis (observed class, worst lock severity, lock mode, rewrite flag,
transactional or not); `Pol:` the production policy decision for a person using the CLI
with staging evidence present (`deny` = a blocking lint finding, `require` = approval, and
the rules that failed). **Advisors never warn before an apply:** every advisor in
`packages/diagnostics/src/advisors/catalog.ts` reads the live schema, none reads a pending
bundle.

## Part 2: DDL under load (run later, on a disposable server)

```sh
cd pgbench
export PGHOST=... PGUSER=postgres PGPASSWORD=...          # the disposable server's PostgreSQL
PG_VERSION=17 ROWS=10000000 EXDB_TREE=/path/to/tree ./run.sh      # all 17 scenarios, hazard and safe
PG_VERSION=16 ROWS=10000000 SCENARIOS=01,06,16 FORMS=hazard ./run.sh   # a subset
```

* Needs `pgbench`, `psql`, `python3`, `timeout`; `PGBENCH_VIA=docker:<container>` runs
  pgbench from a container instead.
* `ROWS` (default 10,000,000) sizes `orders`; `order_items` gets twice as many; four
  indexes on `orders`. `PG_VERSION` (16, 17, 18) is the label in the CSV; the server decides
  the real version.
* Each (scenario, form): 10 s warm-up, 60 s steady state, the DDL with the engine's own
  `lock_timeout` (5 s) and `statement_timeout` (15 min) read from
  `packages/migrations/src/format/projection.ts` when `EXDB_TREE` is set, 30 s cooldown.
  Transactional bundles run as `BEGIN; SET LOCAL ...; <sql>; COMMIT;`, non-transactional
  ones as session `SET` plus the statement in autocommit, as `executor.ts` does.
* The workload (`orders_rw.sql`): 60% point read, 10% customer read, 10% matview read,
  15% update, 5% insert. 16 clients, simple protocol.
* Output: `out/<utc>-pg<ver>/results.csv`, one row per (scenario, form): `apply_ok`,
  `apply_error`, `apply_seconds`, `tps_baseline`/`tps_during`/`tps_after`, `p50`/`p99`
  before and during, `max_during_ms`, `over_1s`, `failed_queries`, `max_gap_s` (longest time
  with no completed transaction), `engine_expressible` (`no` where the safe form cannot be
  written as a bundle).
* `failed_queries` counts transactions of the apply window slower than `APP_TIMEOUT_MS`
  (default 5000): the bench sessions have no timeout, so a stalled query is counted as one an
  application with that timeout would have failed.
* Expected duration at 10M rows: about 3 minutes per run plus the apply, 34 runs.
  `APPLY_BUDGET_SECONDS` (default 1200) kills a step that runs longer.
* The script drops and recreates the database `ddl_bench`. Never point it at anything else.

Not covered by pgbench (stated, not hidden): `ATTACH PARTITION` (needs a partitioned hot
table), `ALTER EXTENSION UPDATE`, `ENABLE ROW LEVEL SECURITY` (the bench role owns the
table, so RLS does not apply), `TRUNCATE`, `SET UNLOGGED`, `CREATE OR REPLACE VIEW`. Their
lock modes and rewrite behavior are proved in `pgcheck`; the under-load column of the
matrix says so.

## Limits of this evidence

* The lint, plan-analysis and policy results come from the product's libraries driven with
  the context the server's planner builds (`planner.ts:656-678`); no server was started
  (no `plan` call). The claim about `provenNotNull` is also backed by a grep: nothing in the
  tree populates it.
* PostgreSQL facts: 17.11 only, 100,000 rows, on a shared and loaded machine; counts of
  rewrites, scans and locks do not depend on size, timings do. PostgreSQL 16 and 18 are
  `NOT RUN` (the PG 18 grammar was only used for lint: `NOT NULL ... NOT VALID` parses).
* The dry run of `pgbench/` (all 17 scenarios, both forms, 100k rows, 5 s steady state, a native
  pgbench 17 against the PG 17 container, shared and loaded machine) proves the scripts run,
  the stall of the lock-queue scenario shows (hazard: 13 failed queries, 5 s without a completed
  transaction; safe: none), and the CSV has the columns; its numbers are not results.
