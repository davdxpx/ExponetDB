### [P1] ADD COLUMN serial/bigserial/identity rewrites the table under ACCESS EXCLUSIVE; lint and plan call it additive and brief
- **Area:** `packages/postgres/src/parser/migration.ts`, `packages/migrations/src/lint`
- **Block:** B
- **Reproduction:** `B/ddl-hazard/tools/run-analysis.sh` (needs `EXDB_TREE` and the pinned toolchain) and `tools/run-cli-lint.sh`; read bundles h08 (`ADD COLUMN seq bigserial`) and h09 (`ADD COLUMN line_no bigint GENERATED ALWAYS AS IDENTITY`) in `results/hazard-strict-plan-large.json`. Then `pgcheck/00-setup.sh && pgcheck/01-checks.sh` and read h08, h09 (PostgreSQL 17.11).
- **Expected:** `volatile_default_rewrite`, observed class `data_rewrite`, lock `critical`, rewrite `table`, a `rewriteRisk` with the table size.
- **Actual:** no lint finding, observed `additive`, lock `high` (brief), rewrite `none`. PostgreSQL: `rewritten=true seq_scans=3 size_x=1.09`, ACCESS EXCLUSIVE held. The production approver is told the change is brief; it holds the lock for up to 15 minutes (`statement_timeout`).
- **Evidence:** `B/ddl-hazard/evidence/pgcheck-01-rewrite-lock-scan.txt` (h08, h09); `B/ddl-hazard/results/hazard-strict-plan-large.json`; `B/ddl-hazard/evidence/cli-lint-hazard-strict.txt`
- **Root cause:** `migration.ts:760-772` inspects only `CONSTR_DEFAULT`. `serial` is a type name expanded after the raw parse, and `CONSTR_IDENTITY` sets no volatile flag (only `CONSTR_GENERATED` does).
- **Proposed fix:** treat serial types (smallserial, serial, bigserial, any schema qualification or case) and `CONSTR_IDENTITY` in ADD COLUMN as volatile: rewrite `table`, class `data_rewrite`, `volatile_default_rewrite`.
- **Acceptance test:** a lint unit test that `ADD COLUMN s bigserial` and `ADD COLUMN s bigint GENERATED ALWAYS AS IDENTITY` yield `volatile_default_rewrite`, `data_rewrite`, rewrite `table`; an integration test on PostgreSQL 16/17/18 that fails if the relfilenode changes without that classification.

### [P2] volatile_default_rewrite fires for stable and immutable defaults (now(), any unqualified function) and forces data_rewrite
- **Area:** `packages/postgres/src/parser/migration.ts`, `packages/migrations/src/lint/lint.ts`
- **Block:** B
- **Reproduction:** lint bundles h06 (`DEFAULT now()`) and h07 (`DEFAULT lower('NEW')`) in the hazard project (CLI, offline); `pgcheck/01-checks.sh` shows h06, h07, h06b.
- **Expected:** no rewrite finding: PostgreSQL 11+ evaluates stable and immutable defaults once, without a rewrite.
- **Actual:** `volatile_default_rewrite` (BLOCKS on a large table) plus `compatibility_understated` (a fixed error unless the author declares `data_rewrite`); observed `data_rewrite`, lock critical, rewrite `table`; policy then asks for a verified backup and an approval. PostgreSQL: `rewritten=false seq_scans=0` for h06 and h07; `clock_timestamp()` (h06b) does rewrite.
- **Evidence:** `pgcheck-01-rewrite-lock-scan.txt` (h06, h06b, h07); `results/hazard-strict-plan-large.json`
- **Root cause:** `migration.ts:496-525`: `now`, `statement_timestamp`, `transaction_timestamp` are in `VOLATILE_DEFAULTS`, and any function not explicitly `pg_catalog` counts as volatile.
- **Proposed fix:** classify by `pg_proc.provolatile` from the target catalog (the planner already reads the catalog), or at least drop the stable names from the list and keep "unknown function = volatile" only offline.
- **Acceptance test:** lint test that `ADD COLUMN c timestamptz NOT NULL DEFAULT now()` has no `volatile_default_rewrite` and observed class `additive`, while `DEFAULT clock_timestamp()` and `gen_random_uuid()` still fire.

### [P2] type_change_rewrite blocks every ALTER COLUMN TYPE including the no-rewrite cases; no lint-clean form exists
- **Area:** `packages/postgres/src/parser/migration.ts`, lint rule `type_change_rewrite`
- **Block:** B
- **Reproduction:** lint h12 (varchar(200) to varchar(500)), h13 (timestamp to timestamptz) and safe fixture s30; `pgcheck/01-checks.sh`: h12, h12b, h13, h13b.
- **Expected:** analysis.md §3: a binary-coercible change is `high`, no rewrite.
- **Actual:** `type_change_rewrite` BLOCKS on production for a large table, class data_rewrite, lock critical, rewrite `possible`. PostgreSQL: varchar widening and varchar to text `rewritten=false seq_scans=0`; timestamp to timestamptz with the engine's pinned `TimeZone=UTC` `rewritten=false` (a Berlin session rewrites).
- **Evidence:** `pgcheck-01-rewrite-lock-scan.txt`; `results/safe-strict-plan-large.json` (s30)
- **Root cause:** `migration.ts:840-846` assumes a rewrite for every `AT_AlterColumnType` ("needs the old type"); the planner reads sizes from the target but not column types.
- **Proposed fix:** have the planner pass column types as catalog facts and classify the known no-rewrite changes, keeping `possible` as the fallback.
- **Acceptance test:** lint test with a catalog fact (varchar(200)) and `TYPE varchar(500)` yields no finding; an integration test that compares the classification with the relfilenode on PostgreSQL 16/17/18.

### [P2] The documented NOT NULL recipe cannot pass the planner: unsafe_not_null fires after the validated CHECK
- **Area:** `packages/migrations/src/lint/lint.ts`, `packages/migrations-engine/src/planner.ts`
- **Block:** B
- **Reproduction:** lint safe fixture s08 (`SET NOT NULL` after s06 and s07, the recipe of authoring-and-ci.md §6); `grep -rn provenNotNull packages apps` (only `lint.ts` reads it).
- **Expected:** with a validated `CHECK (col IS NOT NULL)` the rule does not fire (analysis.md §3: `high`, no scan).
- **Actual:** `unsafe_not_null` BLOCKS on a large table in the planner context (and offline). PostgreSQL: `SET NOT NULL` after a validated CHECK makes 0 scans. The only workaround is lowering the rule project-wide; `migration.lint-errors` is not break-glass overridable. On the PG 18 grammar `NOT NULL ... NOT VALID` lints clean.
- **Evidence:** `pgcheck-01` (h14, h14b); `results/safe-strict-plan-large.json` (s08); `results/*-lowered.json`
- **Root cause:** `lint.ts:555-562` needs `ctx.catalog.provenNotNull`; `planner.ts:668-677` builds the catalog with `relations` only and nothing in the tree populates `provenNotNull`.
- **Proposed fix:** read validated `CHECK (col IS NOT NULL)` constraints into `provenNotNull` at plan time; the check must also hold for a CHECK added by an earlier bundle of the same plan.
- **Acceptance test:** integration test: a target with a validated NOT NULL CHECK plus the bundle `SET NOT NULL` produces no blocking finding; without the CHECK it still blocks.

### [P2] ADD CONSTRAINT ... UNIQUE USING INDEX is flagged like a scanning constraint
- **Area:** `packages/postgres/src/parser/migration.ts:925-932`, lint rule `add_constraint_without_not_valid`
- **Block:** B
- **Reproduction:** lint safe fixture s15 (after s14); `pgcheck/01-checks.sh` h17b.
- **Expected:** no finding: the step is metadata only.
- **Actual:** `add_constraint_without_not_valid` BLOCKS, lock critical, duration scan; the remediation ("add it NOT VALID") does not exist for UNIQUE. PostgreSQL: the `USING INDEX` step makes 0 scans.
- **Evidence:** `pgcheck-01` (h17, h17b); `results/safe-strict-plan-large.json`
- **Root cause:** every `CONSTR_UNIQUE` and `CONSTR_PRIMARY` is treated as a validating scan; the raw node's `indexname` (USING INDEX) is ignored.
- **Proposed fix:** if `indexname` is set, severity `high`, duration `brief`, `constraintValidated = false`.
- **Acceptance test:** lint test: `ADD CONSTRAINT k UNIQUE USING INDEX i` has no finding; `ADD CONSTRAINT k UNIQUE (c)` still does.

### [P2] A cheap statement's ACCESS EXCLUSIVE held through later slow statements of the same transactional bundle is reported as brief
- **Area:** `packages/migrations/src/lint`, `packages/migrations-engine/src/analysis.ts`
- **Block:** B
- **Reproduction:** lint h24 (`ADD COLUMN` then `UPDATE ... WHERE created_at >= '2000-01-01'`) and h42 (the four NOT NULL steps in one bundle); `pgcheck/01-checks.sh` h24, h14b.
- **Expected:** a finding or a hold-time note; the engine's own safe recipe split exists to avoid exactly this.
- **Actual:** no finding; lock `high` (brief). PostgreSQL: ACCESS EXCLUSIVE still held after the UPDATE (table size x2.00) and after VALIDATE (both AEL and SUEL held). Hold time is bounded only per statement (15 min), not per bundle.
- **Evidence:** `pgcheck-01` (h24, h14b); `results/hazard-strict-plan-large.json`
- **Root cause:** lock facts are per statement and `lockSeverity` is the worst single statement; lock lifetime to COMMIT is not modeled.
- **Proposed fix:** in a transactional bundle, a lock of class ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE followed by a scanning or data-changing statement raises severity to `critical`, or add a rule like `lock_held_across_slow_statement`.
- **Acceptance test:** lint test for h24 and h42 expecting the new finding; the split bundles (s06, s07, s08) stay clean.

### [P2] DETACH PARTITION ... CONCURRENTLY cannot be authored
- **Area:** `packages/postgres/src/parser/migration.ts:1012-1019`, lint rules `needless_nontransactional`, `nontransactional_statement_in_transactional`
- **Block:** B
- **Reproduction:** lint h45 (transactional) and h46 (`transactional: false`); `pgcheck/02-more-checks.sh` (h45 part) and h45 in 01.
- **Expected:** h45 refused at lint with `nontransactional_statement_in_transactional`; h46 accepted.
- **Actual:** h45: no lint finding, policy `require`, then PostgreSQL fails at apply ("cannot run inside a transaction block"). h46: `needless_nontransactional` (fixed error, not lowerable). The statement works in autocommit, so the engine can never run it.
- **Evidence:** `results/hazard-strict-plan-large.json` (h45, h46); `pgcheck-01` (h45); `pgcheck-02` (h45)
- **Root cause:** the `concurrent` field of the PartitionCmd is ignored, so the statement is never `autocommitOnly`.
- **Proposed fix:** set `autocommitOnly` for `AT_DetachPartition` with `concurrent`; lock severity `low`.
- **Acceptance test:** lint test: h45 gives the fixed error, h46 passes with no finding; an integration test applies h46 on a target.

### [P2] Lock-queue protections the docs promise are not delivered
- **Area:** `packages/migrations-engine/src/planner.ts`, `packages/migrations/src/lint/rules.ts`, `packages/postgres/src/session.ts`
- **Block:** B
- **Reproduction:** `grep -rniE "pg_stat_activity|xact_start|pg_blocking_pids|wait_event" packages/migrations-engine/src` returns nothing. Lint h43 (`lockTimeout: 2h`). `session.ts:100`. `pgcheck/02-more-checks.sh` shows the queue itself: a reader holds the table 9 s, the DDL gives up at 5 s, a SELECT behind it waits 4.1 s against a baseline of 0.08 s (PostgreSQL 17).
- **Expected:** analysis.md §3: for prod the plan shows the longest-running queries on the affected tables. planning-and-apply.md §6: `lock_timeout` maximum 60 s without a lint acknowledgement; §5: `idle_in_transaction_session_timeout` 120 s.
- **Actual:** the plan has no activity context. A 2 h lockTimeout lints as `long_lock_timeout` warn (never blocks) and plans with `require`. The migrator session gets 30 s.
- **Evidence:** `pgcheck-02-multi-session.txt`; `results/hazard-strict-plan-large.json` (h43)
- **Root cause:** not implemented (`rules.ts:210-216`; `session.ts:100`; no activity read in the planner).
- **Proposed fix:** implement or correct the documents. For an ACCESS EXCLUSIVE statement on prod, read `pg_stat_activity` (sessions with `xact_start` older than N seconds on the affected relations) into the plan.
- **Acceptance test:** an integration test with a long reader on the table: the plan carries the blocker; `lockTimeout > 60s` without an acknowledgement is a blocking finding.

### [P3] Lock facts and rules missing for several heavy statements
- **Area:** `packages/postgres/src/parser/migration.ts`
- **Block:** B
- **Reproduction:** `results/hazard-strict-plan-large.json` (h32, h34, h37, h38, h39); `pgcheck/01-checks.sh`.
- **Expected:** lock facts matching PostgreSQL; non-concurrent REINDEX and DROP INDEX pointing to the CONCURRENTLY form.
- **Actual:** `ALTER SEQUENCE` and `CREATE OR REPLACE VIEW` have no lock fact (`lockSeverity none`), although PostgreSQL takes SHARE ROW EXCLUSIVE on the sequence and ACCESS EXCLUSIVE on the view. `ATTACH PARTITION` records only the parent's lock (the attached table is ACCESS EXCLUSIVE, with a scan unless a validated CHECK exists). `SET UNLOGGED` is a rewrite classified `unknown` with no `rewriteRisk`. `data_change_unbounded` fires only for a missing WHERE (`WHERE id > 0` is silent). PostgreSQL 18 virtual generated columns are flagged volatile (not run here).
- **Evidence:** `pgcheck-01` (h32, h32b, h37, h38, h39)
- **Root cause:** `migration.ts:1005-1011, 1764-1774, 1822-1826`, the default branch of `alterTable`.
- **Proposed fix:** add the lock facts; separate attach with and without CHECK; optionally rules for non-concurrent REINDEX and DROP INDEX.
- **Acceptance test:** statement-facts tests per statement kind; one assertion per lock mode proved in `pgcheck`.
