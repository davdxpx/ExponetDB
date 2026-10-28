# Probes of tester R1

Run on the disposable cx33 `vc-2` (Node 24.22.1, Bun 1.4.4, Go 1.26.10, Ubuntu 24.04, UTC), in clones of `d51da5d0` (new) and `d0229550` (old). No file of the product was changed; probes are copied next to the tests they extend (untracked).

| file | what | where it ran |
|---|---|---|
| `tc003-repro.mts`, `tc003-timing.mts`, `tc003-nearbound.mts` | token counts, parse memory, decoder timing of single-quoted `DO` bodies | `packages/migrations-engine/.r1/`, `node --liftoff-only --conditions=@exponetdb/source` |
| `tc004-regex.mts`, `tc004-neighbour-verify-directive.mts` | `guardStrictness` families; the `verify.sql` directive regex | same |
| `r1-supersede-order.int.test.ts` | the lead's check on `driver.ts:178-186` | `packages/operations/test/`, PostgreSQL 17 |
| `r1-reconcile-drift.int.test.ts` | restore + `ledger.reconcile` + re-apply + drift | `packages/migrations-engine/test/` (uses the first campaign's `tc-world.ts`) |
| `r1-cli-node.host.test.ts` | TC-001/TC-002 on a real node with the real CLI process | `apps/server/test/host/`, container with systemd |
| `r1-cp-backup.host.test.ts` | TC-009/010/011/013 through the Control Plane with real pgBackRest | same (needs `patch-hostworld.py`: `backupExecution` on serve and worker, helper unit `ReadWritePaths`) |
| `t9*.sh`, `t11*.sh`, `t12r1.sh` | helper-level proofs through the shipped helper socket (`labctl`, first campaign's tool with inline JSON arguments) | container `r1-host` (privileged systemd container, `lab-*.sh` set it up) |
