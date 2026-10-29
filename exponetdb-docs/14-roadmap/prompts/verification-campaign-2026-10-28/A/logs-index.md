# Index of the raw logs of Block A (nothing here is copied into the evidence folder)

Everything lives on **vc-1** under `/srv/work/` (a disposable server; deleted by the lead at the end of
the campaign, so quote what matters from here before that).

| What | Path on vc-1 | Notes |
|---|---|---|
| One log per command, `<name>.log`, exit code in `<name>.exit` | `/srv/work/logs/` | 3.4 MB in total; the table below. Prefix `n-` = commit under test, `o-` = pre-fix commit, `n-gor-` = the Go job as non-root user `runner`. `summary.txt` has one line per finished command with exit code and seconds. |
| Host scenario run records (state `passed`, failed tests, lab problems) | `/srv/work/logs/n-host-<scenario>.record.json` | one per scenario, 11 files |
| Per-test results (package, file, full name, status, ms), one row per test | `/srv/work/results/{unit,int}-{old,run1,run2,run3}.tsv` | about 1.5 MB (unit) and 0.3 MB (integration) each |
| The same as counts per package (small, copied here) | `unit-*.summary.json`, `int-*.summary.json` in this folder | |
| Go test streams (`go test -race -json ./...`) | `/srv/work/results/go-{old,new}.jsonl` and `.tsv`, `go-counts.txt` | 0.8 MB each |
| vitest JSON reports straight from the runs | `/srv/work/new/<apps|packages>/<pkg>/.vr-<label>.json`, `/srv/work/old/.../.vr-*-old.json` | git-ignored through `.git/info/exclude` |
| First, aborted attempt of run 3 (turbo stopped at the first failure) | `/srv/work/results/run3-first-attempt/` | superseded by the `--continue` run |
| Visual-regression actual screenshots of the e2e run | `/srv/work/visual-actual/` | 48 files, all matched the baselines |
| Generated credentials of the disposable containers | `/srv/work/infra.env` (mode 600) | regenerated per phase, never copied |
| The commands | `scripts/` in this folder | `queueN.sh` per phase, `step.sh`, `infra-up.sh`, `results.mjs`, `diffruns.mjs`, `counts.mjs` |

Other files in this folder: `int-run3-failing-files.tsv` (the 51 integration files that fail when the tests
inside a file are shuffled, with failed-test counts) and `run3-classification.txt` (each failing file
run in default order, shuffled, and a single test alone).

The queue scripts are the ones I actually ran, including the ones whose first attempt failed for an
environment reason (`queue4.sh` image steps: no BuildKit, repeated in `queue8.sh`; `queue5.sh`
`n-backuplab-pglab`: restic missing, repeated by hand after the fixes as `n-backuplab-pglab3`;
`queue9.sh` carries the non-root Go job and a pglab rerun that failed on a symlinked restic). The
first `queue3.sh` call of `test:integration` had a wrong argument form and failed in 0 s, it was
fixed and rerun (log names `n-int-run1`).

## Logs (name, size, exit code; `-` = no exit file)

| log (all in /srv/work/logs/) | bytes | exit |
|---|---:|---|
| infra-up-agentcaps-rep1.log | 154 | - |
| infra-up-agentcaps-rep2.log | 154 | - |
| infra-up-browser.log | 413 | - |
| infra-up-host-config.log | 154 | - |
| infra-up-host-crash-points.log | 154 | - |
| infra-up-host-enrollment.log | 154 | - |
| infra-up-host-hba.log | 154 | - |
| infra-up-host-identity.log | 154 | - |
| infra-up-host-job-keys.log | 154 | - |
| infra-up-host-journal.log | 154 | - |
| infra-up-host-partition.log | 154 | - |
| infra-up-host-production.log | 154 | - |
| infra-up-host-roles-tls-credentials.log | 154 | - |
| infra-up-host-secrets.log | 154 | - |
| infra-up-nodepg.log | 154 | - |
| infra-up-old.log | 413 | - |
| infra-up-postgres.log | 413 | - |
| infra-up-run2.log | 413 | - |
| infra-up-run3.log | 413 | - |
| n-agentcaps-rep1.log | 875 | 0 |
| n-agentcaps-rep2.log | 875 | 0 |
| n-audit.log | 140 | 0 |
| n-backuplab-pglab2.log | 16821 | 1 |
| n-backuplab-pglab3.log | 20895 | 0 |
| n-backuplab-pglab.log | 16949 | 1 |
| n-backuplab-runbook.log | 766 | 0 |
| n-biome.log | 157 | 0 |
| n-boundaries.log | 198 | 0 |
| n-build.log | 55440 | 0 |
| n-chromium.log | 35470 | 0 |
| n-cli-build.log | 1307 | 0 |
| n-cli-install.log | 1086 | 0 |
| n-cli-lab2.log | 1487 | 0 |
| n-cli-lab.log | 7425 | 1 |
| n-cli-process.log | 2402 | 0 |
| n-conformance.log | 1445 | 0 |
| n-ds-build.log | 9501 | 0 |
| n-e2e.log | 13309 | 0 |
| new-install.log | 224 | - |
| n-go-fuzz.log | 3175 | 0 |
| n-go-gofmt.log | 108 | 0 |
| n-go-govulncheck.log | 373 | 0 |
| n-go-json-new.log | 128 | 0 |
| n-golden-check.log | 174 | 0 |
| n-golden-history-before.log | 449 | 0 |
| n-golden-history-g4.log | 450 | 0 |
| n-go-race.log | 2013 | 0 |
| n-go-release.log | 1746 | 1 |
| n-gor-fuzz.log | 3201 | 0 |
| n-gor-gofmt.log | 132 | 0 |
| n-gor-govulncheck.log | 397 | 0 |
| n-gor-race.log | 2037 | 0 |
| n-gor-release.log | 1705 | 0 |
| n-gor-vet.log | 304 | 0 |
| n-go-vet.log | 280 | 0 |
| n-host-config.log | 1395 | 0 |
| n-host-crash-points.log | 2360 | 0 |
| n-host-enrollment.log | 1459 | 0 |
| n-host-hba.log | 1179 | 0 |
| n-host-identity.log | 1486 | 0 |
| n-host-job-keys.log | 1332 | 0 |
| n-host-journal.log | 1543 | 0 |
| n-host-partition.log | 1213 | 0 |
| n-host-production.log | 1170 | 0 |
| n-host-roles-tls-credentials.log | 1464 | 0 |
| n-host-secrets.log | 1020 | 0 |
| n-image-build2.log | 37706 | 0 |
| n-image-build.log | 36274 | 1 |
| n-image-roles2.log | 593 | 0 |
| n-image-roles.log | 373 | 125 |
| n-image-user2.log | 128 | 0 |
| n-image-user.log | 184 | 1 |
| n-int-run1.log | 162972 | 0 |
| n-int-run2.log | 170759 | 0 |
| n-int-run3.log | 729855 | 1 |
| n-licenses.log | 198 | 0 |
| n-nodepg-agentcaps.log | 1087 | 0 |
| n-nodepg-wire-caps.log | 310 | 0 |
| n-quickstart2.log | 5116 | 0 |
| n-quickstart.log | 31586 | 1 |
| n-secrets.log | 204 | 0 |
| n-third-party.log | 220 | 0 |
| n-toolchain.log | 93 | 0 |
| n-typecheck.log | 4763 | 0 |
| n-ui-safety.log | 186 | 0 |
| n-unit-run1.log | 594800 | 0 |
| n-unit-run2.log | 603199 | 0 |
| n-unit-run3.log | 685720 | 1 |
| n-verify-generated.log | 203 | 0 |
| n-verify-host.log | 1028 | 0 |
| n-web-build.log | 31443 | 0 |
| n-worktree-clean.log | 146 | 0 |
| o-go-json-old.log | 128 | 0 |
| o-install.log | 246 | 0 |
| o-int.log | 157161 | 0 |
| o-unit.log | 641132 | 0 |
| pull.log | 527 | - |
