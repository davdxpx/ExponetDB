# Index of raw logs (kept on the server, not in this repository)

Server `vc-2`, tree `/srv/work/r1/` (`new` = `d51da5d0`, `old` = worktree of `d0229550`; probes under `/srv/work/r1/probes`, copies in `R/R1-notes/probes/`). Logs under `/srv/work/r1/logs/`; the lab container logs are copied to `/srv/work/r1/logs/lab-logs/` (originals under `/root/lab/logs/` inside the container `r1-host`). Server state left for the lead: containers `r1-pg17`, `r1-target-pg16/17/18/plain` (ports 56110, 56116-56118, 56199), `r1-host` (systemd lab, helper socket on the NEW release binaries), stopped `r1-host2`, `r1-host3`; networks `r1-net`; image `r1-host-img`.

| finding | log files |
|---|---|
| TC-003 | `tc003-new-postgres.log`, `tc003-new-engine.log`, `tc003-old-postgres.log`, `tc003-old-engine.log`, `tc003-timing.log` |
| TC-004 | `tc004-new.log`, `tc004-old-rep_pad.log`, `tc004-old-rep_noterm.log`, `tc004-old-rep_comma.log`, `tc004-old-sem.log`, `tc004-run.out` |
| TC-005/006/007/008 | `mig.status`, `new-ops-*.log`, `old-ops-*.log`, `new-mig-int.log`, `old-mig-int.log`, `new-diag-int.log`, `old-diag-int.log`, `new-policy.log`, `old-policy.log`, `ev-new-tc-*.log` (first campaign's recording tests on the new tree), `/srv/work/r1/evid-new/*.jsonl` |
| TC-001/002 | `tc001.status`, `new-views.log`, `old-views.log`, `new-cli.log`, `old-cli.log`, `new-web.log`, `old-web.log`, `cli-new.log`, `cli-new.vitest`, `cli-old.log`, `cli-old.vitest` (real planners, real node, real CLI process over HTTP) |
| TC-009/011/012 (helper level, shipped sandboxed helper under systemd, pgBackRest 2.60.0, restic 0.16.4) | container `r1-host`: `/root/lab/logs/new-t9r1.log`, `old-t9r1.log`, `new-t9lsn.log`, `new-t11r1.log`, `old-t11r1.log`, `new-t11gap*.log`, `new-t11scoped.log`, `new-t12r1.log`, `old-t12r1.log` |
| TC-009/010/011/013 (Control Plane level: serve, gateway, worker, agent and helper units, real engines) | `cp-new.log`, `cp-new.vitest`, `cp-old.log`, `cp-old.vitest` |
| TC-013 REST integration with the real role set | `tc013-new.log`, `tc013-old.log` |
| supersession order (lead's check) | output of `probes/r1-supersede-order.int.test.ts` (rerun: `cd /srv/work/r1/new/packages/operations && bunx vitest run --config vitest.integration.config.ts test/r1-supersede-order.int.test.ts`) |
