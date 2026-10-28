# Open decisions raised by the DDL hazard matrix (agent B3)

- **B3-D1 (large backfills):** a bundle is one transaction and COMMIT is forbidden, so batched backfills cannot be bundles. Run them outside the engine (which breaks "no direct DDL outside the migration engine" for data changes), or add an operation kind for batched data migrations?
- **B3-D2 (false positives):** a false positive of the lint rules (volatile default, type change, NOT NULL recipe, UNIQUE USING INDEX) can only be bypassed by lowering the rule for the whole project, and `migration.lint-errors` is not break-glass overridable; lowering also unblocks the real hazards (h04, h11, h14). Should there be a per-finding acknowledgement with a reason, or should the planner use catalog facts (column types, constraints, `provolatile`) so these rules become precise?

Not measured by B3: every "under load" cell of `B/ddl-hazard-matrix.md` is PENDING (the large run `PG_VERSION=17 ROWS=10000000 ./run.sh` takes about 3 hours on a disposable server); PostgreSQL 16 and 18 behavior; a live `migration plan` (lint, plan analysis and policy were driven with the planner's context, `planner.ts:656-678`).
