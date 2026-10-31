# DDL hazard matrix

| | |
|---|---|
| Block | B (bundle system), part B3 |
| Tree under test | `d51da5d0` (merge of fix PR #46), read-only |
| PostgreSQL used for claims | 17.11 only (16 and 18 are `NOT RUN`, except the PG 18 grammar in lint) |
| Evidence and scripts | [`ddl-hazard/`](./ddl-hazard/README.md) |
| Status | Part 1 done (lint, plan analysis, policy, PostgreSQL ground truth). Part 2 (DDL under pgbench at 10M rows) is scripted and dry-run at 100k rows; every "under load" cell is **PENDING** |

## What was run

Seventy-nine bundles, built with the product's own `exponetdb migration new`: 45 dangerous
forms (`h01` to `h46`; `h41` is a PostgreSQL-only check) and 30 safe forms (`s01` to `s30`), each
project with the same two base bundles (`h00`, `h00b`), over a small shop schema. For each bundle:

1. `exponetdb migration lint` (the CLI, offline) with the `strict` and the `standard` profile,
   PostgreSQL 17 grammar, prod rules: [`ddl-hazard/evidence/cli-lint-*.txt`](./ddl-hazard/evidence).
2. The same lint library in the context the server's planner builds
   (`packages/migrations-engine/src/planner.ts:656-678`: tier prod, live relation sizes, here a
   10M-row `orders`), then the engine's `migrationAnalysis` (lock mode and severity, rewrite
   flag, transactional flag) and the production policy (`MIGRATION_RULES`) with the facts the
   planner derives: [`ddl-hazard/results/*.json`](./ddl-hazard/results). No server was started.
3. PostgreSQL 17 itself, per statement: did the relfilenode change (rewrite), how many
   sequential scans did the transaction make, which relation locks does it hold:
   [`ddl-hazard/evidence/pgcheck-*.txt`](./ddl-hazard/evidence).

Counts (45 dangerous forms, `strict`, planner context with a large table): 25 have at least one
lint finding, 18 have a finding that blocks a production plan, 20 have none. The `standard` profile
only turns `drop_without_expand_contract`, `rename_in_place` and `function_search_path_mutable`
into information: the counts are identical. Of 30 safe forms, 4 have a finding and 3 of those
block a production plan although the statement is the documented safe one (**s08, s15, s30**).
No advisor looks at a pending bundle (all 17 advisors in `packages/diagnostics/src/advisors/catalog.ts`
read the live schema); the "advisor" answer is **none** for every row.

## How to read the table

* **L:** lint rule id and level (`warn`, `error`); `BLOCKS` = blocks a plan on a production
  target (rule `blocking`: always, prod, or prod_large with a non-trivial table, > 64 MiB or
  > 1M rows, or a size that is not known). A project can lower a rule except the fixed ones.
* **P:** the plan's analysis: observed compatibility class, worst lock severity with the lock
  mode and the statement's severity, rewrite flag (`table`, `possible`, `none`), `tx` or `non-tx`.
* **Pol:** the production decision for a person using the CLI with staging evidence present:
  `deny` (a blocking lint finding, not overridable by break-glass), `require` (approval; the
  rule ids that asked for it) or `allow`. `lock-risk` asks for an approval for every statement
  with severity `high` or worse, which includes every `ALTER TABLE`.
* **PostgreSQL column:** `rewritten` = relfilenode changed; `seq_scans` in the transaction;
  `size_x` = relation size after / before; `locks` = relation locks held (AEL ACCESS EXCLUSIVE,
  SUEL SHARE UPDATE EXCLUSIVE, SREL SHARE ROW EXCLUSIVE, SL SHARE, EL EXCLUSIVE, REL ROW
  EXCLUSIVE, RSL ROW SHARE; AccessShare omitted).
* **Under load:** PENDING until `pgbench/run.sh` runs on a disposable server; the scenario
  number is given.

