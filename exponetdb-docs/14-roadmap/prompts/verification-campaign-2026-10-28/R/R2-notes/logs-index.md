# R2: raw logs (kept on vc-3, not in this folder)

Server: vc-3 (Ubuntu 24.04, UTC; Node 24.22.1, Bun 1.4.4, Go 1.26.10, PostgreSQL 16/17/18, pgBackRest 2.60.0, restic 0.16.4).
Trees: `/srv/work/r2/new` = clone at `d51da5d0d8832ebc569f23985c7e5176e4d450ad`, `/srv/work/r2/old` = detached worktree at `d0229550`.
Control Store and managed targets: Docker (`tooling/dev/control-store.sh` and `targets.sh` images, pinned by digest, ports 55432 and 555xx).
A copy of all logs (328 KB, no secrets) was pulled to the lead's machine: `/tmp/exdb-campaign-R2-logs/logs/` (and `evid-new/`), outside the repository.
All logs: `/srv/work/r2/logs/<name>.log`, scripts: `/srv/work/r2/scripts/<name>.sh`, probe sources: `/srv/work/r2/probes/`
(copies in `R/R2-notes/probes/`). Every run holds `flock /tmp/heavy.lock` and runs under `nice`.

| Log | What it holds |
|---|---|
| `b1` | acceptance of the non-PostgreSQL suites on the new tree, then the same test files copied into the old tree (fails-before): contracts errors, nodes capability, policy node-rules, postgres admission and migration-analysis, migrations-engine legacy-files, backups selection, cli backups+foundation, ui sidebar, web findings and node pages, application views |
| `b2` | PostgreSQL-backed acceptance (nodes, diagnostics performance, migrations-engine recovery and ledger-guard on 16/17/18, server http-nodes and node-operations) and fails-before of the same files on the old tree |
| `t014-int-new`, `ft-t014` | diagnostics `data-read.int.test.ts` on PG 16/17/18 (new) and the TC-014 test on old |
| `cli-old` | CLI tests of TC-015, 022, 031, 032, 033 copied to the old tree |
| `go1` | Go tests of TC-039 and TC-042 on the new tree and the same test files on the old tree |
| `sweep` | R2 sweep: every remote read command of the CLI answered 403 and 404, old and new |
| `host1` | real agent + systemd host scenarios on vc-3: `hba.host.test.ts` (new; old with the new test), probe `r2-e2e6` (node view, enrollment token routes, step-up) on new and old |
| `p019`, `p019b`, `p019c`, `p019old`, `p019bulk` | NUL-in-plan-body probe for the node revoke plan (TC-019 neighbour) |
| `p034` | TC-034 local reproduction (plan expired while the operation awaits approval) |
| `p017` | TC-017 local reproduction (drift after 80 tables were added to a registered target) |
| `p020` | TC-020 local reproduction (CLI grant with `nodes.plan` only) |
| `tcmig` | the first campaign's own migration-engine tests (tc-1, tc-4, tc-5, tc-6) re-run on the new tree: TC-022, 023, 024, 025 |
| `adm` | admission probe (TC-014 neighbours) old and new |
| `hbaprobe` | `HBA_WOULD_LOCK_OUT` remediation probe |
| `t021` | `survivingExpectations` timing at 100 / 1,000 / 5,000 / 20,000 files, new and old |
| `e4`, `e9` | older-CLI probe (E4, TC-040) and `migration lint` filter probe (E9, TC-041), old and new |
| `lab-e1` | TC-039 / E1: runbook sections 2 and 3.3 followed literally on a clean host, old and new release builds |
| `misc` | `verify:host --list` (TC-029), `go vet -tags pglab` and its mutation (TC-026), selection mutation checks (TC-028), `golden:check` |
| `chain`, `chain3`, `chain4` | `chain`: apply-time hba safety-net tests (pgit; its lab part failed on a labctl argument bug); `chain3`: lab TC-043 (t7c), TC-045 (restic runbook), TC-046 at 512 MB; `chain4`: TC-046 at 120 MB |
| `pglab`, `pglab2`, `pglab3`, `pglab4` | the `backup-lab` CI job's two commands run on vc-3 (TC-026): the first three failed only because of the vc-3 layout of restic (missing at /usr/bin/restic, then a symlink the helper refuses), `pglab4` passes (81.7 s) and `test:lab` 3/3 |
| `vu`, `vu2` | `verify-units.sh` as root (fails) and the diagnosis of the owner name lookup (F6) |
| `evid-new/` | JSON lines of the re-run first-campaign migration tests |

## Probes that are patches

`probes/*.patch` are unified diffs against a test file of the commit under test. To rebuild a probe copy the original to
`<dir>/<probe name>.ts` and apply the patch to that copy (`patch <copy> < file.patch`), then run it as the finding says:
`r2-nul-http-nodes.int.test.patch` and `r2-nul-bulk-http-nodes.int.test.patch` against `apps/server/test/http-nodes.int.test.ts`
(probe names `r2-nul-http-nodes.int.test.ts`, `r2-nul-bulk-http-nodes.int.test.ts`), `r2-tc017-diagnostics.int.test.patch` against
`packages/diagnostics/test/diagnostics.int.test.ts`, `r2-tc020-node-operations.int.test.patch` against
`apps/server/test/node-operations.int.test.ts`, `r2-tc034-http-drift-accept.int.test.patch` against
`apps/server/test/http-drift-accept.int.test.ts`. The standalone probes (`r2-cli-sweep`, `r2-cli-e4`, `r2-cli-e9`, `r2-admission`,
`r2-hba`, `r2-tc021-timing`, `r2-e2e6.host`) are copied into the named test directory as they are. `scripts/` holds the shell
scripts that ran on vc-3 (`b1`, `b2`, `host1`, `tcmig`, `lab-*`, `chain*`, `pglab*`, ...); the wrappers that start them (`rrun`,
`rscript`, `rlog`: ssh, `nice`, `flock`) are not kept.
