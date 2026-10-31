
## Where the product's classification differs from PostgreSQL (each proved)

| # | Pattern | The product says | PostgreSQL 17.11 did | Proof |
|---|---|---|---|---|
| A | `ADD COLUMN seq bigserial`, `ADD COLUMN ... GENERATED ALWAYS AS IDENTITY` | no finding; additive; lock `high` (brief); rewrite `none` | rewritten, 3 sequential scans, size x1.09, ACCESS EXCLUSIVE held | h08, h09; pgcheck h08, h09. Root cause: `parser/migration.ts:760-772` inspects only `CONSTR_DEFAULT`; `serial` is a type name expanded after the raw parse, `CONSTR_IDENTITY` sets no volatile flag |
| B | `ADD COLUMN ... DEFAULT now()`, `DEFAULT lower('NEW')` | `volatile_default_rewrite` + `compatibility_understated` (fixed error), critical, rewrite `table` | not rewritten, 0 scans (contrast h06b `clock_timestamp()`: rewritten) | h06, h07; pgcheck h06, h06b, h07. Root cause: `migration.ts:496-525`, `now`, `statement_timestamp`, `transaction_timestamp` are in `VOLATILE_DEFAULTS` and every unqualified function counts as volatile (`n.schema !== 'pg_catalog'`) |
| C | varchar(200) to varchar(500), varchar to text, timestamp to timestamptz (the engine pins `TimeZone=UTC`) | `type_change_rewrite` BLOCKS, critical, rewrite `possible` | not rewritten, 0 scans (timestamp to timestamptz with a Berlin session: rewritten) | h12, h13, s30; pgcheck h12, h12b, h13, h13b. Root cause: `migration.ts:840-846` assumes a rewrite for every `AT_AlterColumnType`; `analysis.md` section 3 promises `high` for binary-coercible changes |
| D | `ADD CONSTRAINT ... UNIQUE USING INDEX` | `add_constraint_without_not_valid` BLOCKS, critical, scan | the `USING INDEX` step made 0 scans | s15; pgcheck h17b. Root cause: `migration.ts:925-932` treats every UNIQUE/PRIMARY as a scan; the remediation text (add it NOT VALID) is impossible for UNIQUE |
| E | step 3 of the documented NOT NULL recipe (`SET NOT NULL` after a validated CHECK) | `unsafe_not_null` BLOCKS | with the validated CHECK `SET NOT NULL` made 0 scans (without: 1) | s08; pgcheck h14, h14b. Root cause: `lint.ts:555-562` needs `ctx.catalog.provenNotNull`; `planner.ts:668-677` passes none, and nothing in the tree builds it (grep) |
| F | cheap lock plus slow statement in one transactional bundle (`ADD COLUMN` then `UPDATE`; the NOT NULL recipe in one bundle) | lock `high` ("brief"), no finding | ACCESS EXCLUSIVE still held after the `UPDATE` and after `VALIDATE`; table size x2.00 | h24, h42; pgcheck h24, h14b |
| G | `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` | transactional bundle: no finding (PG refuses at apply); non-transactional bundle: `needless_nontransactional` (fixed, not lowerable) | "cannot run inside a transaction block"; works in autocommit | h45, h46; pgcheck h45 (both). Root cause: `migration.ts:1012-1019` ignores the `concurrent` flag, so the statement is never `autocommitOnly` |
| H | `ALTER SEQUENCE ... RESTART`, `CREATE OR REPLACE VIEW` | no lock fact, `lockSeverity none` | sequence: ROW EXCLUSIVE + SHARE ROW EXCLUSIVE; view: ACCESS EXCLUSIVE | h38, h39; pgcheck h38, h39 |
| I | `ATTACH PARTITION` | one lock fact, the parent's SHARE UPDATE EXCLUSIVE, severity `high` with and without a CHECK | attached table also ACCESS EXCLUSIVE; 1 scan without a validated CHECK, 0 with | h32, s22; pgcheck h32, h32b |
| J | `SET UNLOGGED` | class and severity `unknown`, rewrite `none`, no `rewriteRisk` | rewritten, 2 scans | h37; pgcheck h37 |

Not run: PG 18 `GENERATED ... VIRTUAL` columns need no rewrite while `migration.ts:768-771` flags every
`CONSTR_GENERATED` as volatile (PG 17 only here).

## What the lint cannot fix by authoring: lowering the rules lowers them for the dangerous forms too

B, C, D and E block a production plan for a large table and have no lint-clean form. A project
can lower the rule (`lint.rules`); break-glass cannot help (`migration.lint-errors` is
`overridableByBreakGlass: false`). Lowering `volatile_default_rewrite`, `type_change_rewrite`,
`unsafe_not_null` and `add_constraint_without_not_valid` to `info` (checked:
`results/*-strict-plan-large-lowered.json`) turns s08, s15 and s30 into `require`, and **also** h04
(a real volatile rewrite), h11 (a real type rewrite), h14 (a real full-scan NOT NULL), h15, h16 and
h17 into `require`. `compatibility_understated` (fixed) still denies h06 and h07 until the author
declares `data_rewrite`, which then also demands a verified backup.

## What the engine does when it applies (code read, `executor.ts`, `projection.ts`, `session.ts`)

* **Timeouts.** `lock_timeout` 5 s and `statement_timeout` 15 min unless the manifest or the
  project says otherwise (`projection.ts:24-25`); range 1 ms to 6 h. Transactional: `BEGIN`,
  then `set_config(..., is_local = true)` for both (`executor.ts:243-252`), one SQL statement per
  protocol message, client timeout = statement timeout + 5 s. Non-transactional: the same values at
  session level (`executor.ts:461-466`).
* **`lock_timeout` bounds the wait, not the hold.** A statement that got its lock keeps it for its
  own duration (up to 15 min by default for a rewrite) and, in a transactional bundle, until
  COMMIT, whatever the later statements do (F above). A lock timeout is `MIGRATION_LOCK_TIMEOUT`,
  rolls the transaction back, is never retried by the engine.
* **Non-transactional is declared by the author and enforced three ways.** Lint: a statement
  PostgreSQL refuses in a transaction in a `transactional: true` bundle is the fixed error
  `nontransactional_statement_in_transactional` (h02); `transactional: false` without such a
  statement is the fixed error `needless_nontransactional` (h44); more than one statement is
  the warning `multiple_nontransactional_statements` that never blocks (h03). Plan: a
  non-transactional bundle is planned alone (`planner.ts:641`), production needs an approval and a
  fresh re-authentication (`migration.nontransactional`). Executor: `runTransactional` refuses any
  statement flagged `autocommitOnly` with `MIGRATION_STATEMENT_FORBIDDEN` (`executor.ts:238`).
  Gap: `DETACH ... CONCURRENTLY` is not flagged (G).
* **Invalid index after a failed `CREATE INDEX CONCURRENTLY`.** PostgreSQL leaves it
  (`indisvalid=false`) and `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the same name then skips it
  silently (proved, `pgcheck-02`). The engine has an `invalid_index` state in `resume.ts:60,151,204,284`
  with an explicit `cleanup` request and an L3 verification check `no invalid index in the managed
  scope` (`verification.ts:154-202`); neither was run here (no server).
* **Policy for production** (`packages/policy/src/catalog/migrations.ts`): `migration.lint-errors`
  denies on any blocking finding; `migration.lock-risk` requires one approval for severity `high`,
  `critical` or `unknown`; `migration.destructive-backup` requires a verified backup newer than
  24 h for `destructive`, `data_rewrite` and `unknown`; `migration.nontransactional` requires an
  approval and a re-authentication.
* **Documented but not delivered.** (1) `analysis.md` section 3, "the plan shows, for prod tier, the
  currently longest-running queries on the affected tables (from `pg_stat_activity`)": nothing in
  `packages/migrations-engine/src` reads activity. (2) `planning-and-apply.md` section 6,
  `lock_timeout` "maximum 60 s without a lint acknowledgement": `long_lock_timeout` is a warning that
  never blocks and no acknowledgement exists; a two hour `lockTimeout` plans with `require` (h43).
  (3) `planning-and-apply.md` section 5 says `idle_in_transaction_session_timeout` 120 s; the
  migrator session gets 30 s (`session.ts:100`).

## No safe form inside the engine

* **Large backfills.** A transactional bundle is one transaction and `COMMIT`/`ROLLBACK` are forbidden
  statements (`forbidden_statement`), so batches with intermediate commits cannot be written as bundles. The safe form
  of scenario 15 is a job outside the engine; the matrix marks it `engine_expressible=no`.
* **Lock-free forms do not exist** for `CREATE TRIGGER`, `CREATE POLICY`, `ENABLE ROW LEVEL
  SECURITY`, `DROP COLUMN`, `RENAME`, `ADD COLUMN` (even the fast path takes ACCESS EXCLUSIVE
  briefly and queues behind a long reader). The only mitigation is a short `lockTimeout` and
  planning again at a quiet moment.

## PENDING and NOT RUN

| Item | State |
|---|---|
| Every "Under load" cell (p50/p99, TPS, failed queries, apply seconds at 10M rows) | **PENDING**: `ddl-hazard/pgbench/run.sh`, 17 scenarios, written and dry-run at 100k rows (`evidence/pgbench-dryrun-100k.csv`, not a result) |
| PostgreSQL 16 and 18 | NOT RUN (PG 17.11 container only; parameter `PG_VERSION` exists in the load script) |
| Real planner run (`migration plan` against a target) | NOT RUN: no server in Part 1; lint and policy were driven with the planner's context |
| Resume / cleanup of an invalid index by the engine, executor refusal of an autocommit statement | code read only |
| Partition attach, extension update, RLS, TRUNCATE, SET UNLOGGED, CREATE OR REPLACE VIEW under load | not in the pgbench scenarios (stated in `ddl-hazard/README.md`); lock modes and rewrite proved on PG 17 |
| PG 18 virtual generated columns | NOT RUN |
