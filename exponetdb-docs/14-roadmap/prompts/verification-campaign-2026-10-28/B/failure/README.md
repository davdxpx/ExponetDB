# Stack-level invariants and failure injection (tester S1, verification campaign 2026-10-28)

These are bash + psql + CLI scripts that run against the **disposable stack** built by `D/infra/stack-up.sh` (real
`serve`, `worker`, `gateway`, a Control Store container, PostgreSQL 16, 17 and 18 targets and a node agent). They are
the stack-level counterpart of the in-process vitest suites in `B/conformance/` (which use the product's own test
world, not the running processes). Each script prints one line per case:

    VERDICT <id>: PASS|FAIL|PARTIAL|NOT_RUN - <what happened>

and appends it to `$S1_LOGS/verdicts.tsv` (default `/srv/work/logs-s1`; raw per-case logs sit next to it and are never
committed). The numbers and findings are in [`RESULTS.md`](./RESULTS.md) and `F/findings-S1.md`.

| Script | Invariant | What it does |
|---|---|---|
| `I4-atomicity-stack.sh` | I4 atomicity | about 50 bundles (COMMIT, ROLLBACK, END, ABORT, BEGIN, SAVEPOINT, SET ROLE, RESET ROLE, SET SESSION AUTHORIZATION, SET search_path, DO / PROCEDURE that commits, psql meta text, CIC, VACUUM, ALTER SYSTEM, CREATE DATABASE, ALTER TYPE ADD VALUE, non-transactional runs) planned and applied through the CLI on a fresh target each; classifies REFUSED / CLEAN_FAIL / APPLIED_OK / PARTIAL_DOCUMENTED / HALF_APPLIED / LYING_LEDGER |
| `I6-truth.sh` | I6 truth | state sampling every ~40 ms during a slow verification (Control Store and REST), verify.sql that returns false, errors, hangs on a lock, writes, has side effects, is missing or `none` |
| `I7-no-silent-adoption.sh` | I7 | out-of-band GRANT TO PUBLIC, trigger, policy, default privileges, extension upgrade, function body, owner, index, column; then two unrelated verified migrations; the drift baseline is read each time |
| `I8-single-writer.sh` | I8 | two applies at once (same target, two targets of one cluster), the target's `EXDB` advisory lock held by an outside session (held past the deadline and released early), a crashed apply session |
| `I9-exits.sh`, `I9-approval.sh` | I9 | parks operations in `needs_attention` (rollback, ledger.reconcile, drift.accept, unknown outcome) and tries every exit; the D0 supersede order; awaiting_approval with an expired plan and the approval window |
| `C1-hypotheses.sh` | C1 findings | head-of-line blocking behind a parked operation; the worker stopped like `docker stop --time N` in the middle of a 90 s apply |
| `F-matrix.sh` | failure injection | one cell = (bundle kind, phase, injection); the phases are before_plan, between, lock, mid, incommit, commit, verify; injections: kill -9 of worker, serve, gateway, agent; SIGTERM; Control Store restart; `pg_ctl restart -m immediate` and fast; `pg_terminate_backend`; packet DROP and netem delay/loss on the loopback; clock +3 h / -3 h; a client that retries with the same and with a new `Idempotency-Key` |
| `F-disk.sh` | disk full | target (loop-mounted tablespace) and Control Store (data directory on a loop filesystem, filled to the brim) |
| `render-results.sh` | | renders the matrix TSV as the Markdown table of `RESULTS.md` |

How a cell decides its verdict (F-matrix): the Control Store's operation state against the CLI/REST state; the ledger
row against the objects; a counter (`nextval` in the first statement of the bundle, which survives rollback) that
shows an automatic re-execution; an independent second plan on the same target (liveness); the product's own pointer
(`nextAction`, `retryable`). FAIL = a lie, a half-applied transactional bundle, a re-execution; PARTIAL = not at rest
after 5 minutes, or parked in `needs_attention`, or the next plan is blocked.

## Run (CI could do the same on a disposable VM)

```bash
# as root on a disposable Ubuntu 24.04 machine
/srv/work/infra/stack-up.sh                      # D/infra, about 5 minutes with a cached build
export INFRA=/srv/work/infra RUN_TAG=$(date +%d%H%M)
./I4-atomicity-stack.sh ; ./I6-truth.sh ; ./I7-no-silent-adoption.sh ; ./I8-single-writer.sh
./I9-exits.sh ; ./C1-hypotheses.sh
./F-matrix.sh run '^tx:mid'                      # a subset; `./F-matrix.sh list` shows all cells
./F-disk.sh target
./render-results.sh > matrix.md
```

Exit codes are not used: the verdict lines are the interface (grep `FAIL`). Destructive cells (kill, restart, clock,
netem, disk) must not run at the same time as anything else on the stack; `recover_all` at the start of each cell
puts the clock, the loopback rules, the Control Store, the target cluster and the services back.

## Safety

Everything is on the disposable stack: loopback firewall rules live in the chain `EXSTACK_FAIL`, loop mounts under
`$EXSTACK_ROOT/loop`, the clock step is undone from a recorded monotonic reference (`clock_restore`). `stack-down.sh`
removes all of it. Nothing here touches another installation; no secret is read or printed.
