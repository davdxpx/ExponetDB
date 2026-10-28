# Block A: automated suites at origin/main d0229550

Two environments, because the first one is outside the repository's declared toolchain:

1. **Local lead machine** (WSL2 Ubuntu, Node 26.5.0, Bun 1.3.14, timezone Europe/Berlin; `engines` says Node `>=24.22.1 <25`, Bun `>=1.4.4`; Go 1.26.10 from the scratchpad). Logs in this folder.
2. **Replica of the CI jobs on a disposable Hetzner cx33** (Ubuntu 24.04, 4 vCPU, 8 GB, UTC, Node 24.22.1, Bun 1.4.4, Go 1.26.10, PostgreSQL 16/17/18 from PGDG, pgBackRest 2.60.0). Logs in `D/ci-replica/` and `D/host-scenarios/`. Turbo was limited to two parallel tasks because the default run was OOM-killed on 8 GB (a limit of the test machine, not a finding).

| Suite | Local lead machine | Pinned replica | Notes |
|---|---|---|---|
| `bun install --frozen-lockfile` | PASS (1,252 packages, no engine warning, see finding "toolchain not enforced") | PASS | |
| `check` (biome) / `biome ci` | PASS | n/a | `check.log`, `biome-ci.log` |
| `typecheck` | PASS 84 s | PASS 122 s | |
| `test` | **FAIL**: 1 test of 6,074+ (`ui-patterns` `metric-card`, time zone) and turbo aborted `web` and `design-system`; reruns: `ui-patterns` CET x2 FAIL, UTC PASS (90 files, 1,141 tests); `web` PASS 168 files / 2,498 tests; `design-system` PASS 16 files / 1,662 tests | **PASS** (13 min, UTC) | first run `test.clean.log`; reruns `rerun-*.log` |
| `build` | PASS 30 s | PASS 44 s | |
| `test:integration` | PASS 103 files, 1,673 tests (11.5 min) | PASS (18 min, with an S3-compatible test server; the first replica run failed only because I had not started it: `D/ci-replica/test-integration2.log` vs `test-integration3.log`) | |
| `test:e2e` | **FAIL**: only `visual-regression` (2 tests, pixel differences, machine-specific default baseline set); 9 files, 50 tests PASS | **PASS** (6 min, `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04`) | `test-e2e.clean.log`, `D/ci-replica/test-e2e2.log` |
| `apps/server test:conformance` | PASS 5 tests | PASS after the `bunx` symlink missing on my server (first replica run: setup gap) | |
| `mcp:conformance`, `mcp:inspect` | PASS 2 + 3 tests | (covered by conformance) | |
| `mcp:evals` | **NOT RUN** (14 tests fail "NOT RUN: set EXDB_EVAL_ANTHROPIC_API_KEY"; needs the owner's key) | n/a | `mcp-evals.log` |
| `verify:generated`, `golden:check`, `golden:history origin/main`, `golden:history 6e556f6b...` | PASS | n/a | |
| `boundaries`, `secrets`, `third-party`, `licenses`, `ui-safety` | PASS | n/a | |
| `bun audit` | PASS ("No vulnerabilities found") | n/a | |
| working tree unchanged after the runs | PASS (`git status` clean) | n/a | `git-clean.log` |
| `go:test` (vet + `-race`) | PASS (110 s) | PASS (`go vet`, `go test -race ./...` 148 s) | |
| Go `pgit` tags (`./internal/pgwire ./internal/capabilities`) | n/a | PASS (118 s, real PostgreSQL 16/17/18 clusters) | |
| Go `pglab` (`TestPglab`, real pgBackRest 2.60.0 + restic, root) | n/a | PASS (37.5 s) | CI never compiles this tag: finding |
| `smoke:image` | PASS (57 s, three roles from one image) | n/a | |
| host test `agent-capabilities.host.test.ts` (systemd, CI job `node-pg`) | n/a | **PASS** (677 s) | `D/host-scenarios/` |
| the 11 host scenarios (CI job `node-host-scenarios`: config, enrollment, hba, roles-tls-credentials, job-keys, crash-points, partition, journal, identity, production, secrets) | n/a | **PASS** (all 11) | `D/host-scenarios/summary.txt` |
| `apps/cli test:install` | NOT RUN locally (needs Node 24: `EXDB_CLI_NODE`) | not run | cost: one more server run |
| `apps/cli test:lab`, `apps/server test:lab` (lab from the image) | NOT RUN | not run | would need Docker lab + owner browser; cost: about 30 min on a disposable host |
| Go bounded fuzzing, `govulncheck` | NOT RUN | not run | would need network to the Go vuln DB; cost: 10 min |

Flaky tests: none observed (the one failing test fails deterministically in a non-UTC shell: three of three runs).
