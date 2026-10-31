# Block A: the automated suites again

Commit under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of fix PR #46), pre-fix
`d0229550`. Server `vc-1` only (Ubuntu 24.04, 4 vCPU, 8 GB, UTC), fresh clones of the public
repository at `/srv/work/new` and `/srv/work/old`. Commands are the ones of
`.github/workflows/ci.yml`, step by step; the scripts I ran are in `scripts/` (`queueN.sh`, one per
phase; `step.sh` wraps each command with a log, an exit code and a duration). Raw logs stay on the
server, see `logs-index.md`. Findings are in `../F/findings-A.md`.

## Toolchain (printed on the server, `/srv/work/toolchain.txt`)

| Tool | Version |
|---|---|
| Node | v24.22.1 |
| Bun | 1.4.4 |
| Go | go1.26.10 linux/amd64 |
| PostgreSQL for the host jobs (PGDG packages) | 16.15, 17.11, 18.6 |
| PostgreSQL for the Control Store and the managed targets | the CI images, pinned by digest (`postgres:17.11`, `pgvector/pgvector:pg16/17/18`), `versity/versitygw:v1.8.0` |
| pgBackRest / restic | 2.60.0 / 0.16.4 |
| Docker | 29.1.3 (Ubuntu package) plus `docker-buildx` 0.30.1 (added by me, see "Bootstrap changes") |
| Time zone | UTC |

## Bootstrap changes I made on vc-1 (the environment, not the product)

1. `apt-get install docker-buildx`. The Ubuntu `docker.io` package has no BuildKit and the image build
   (`COPY --chmod`) stops with "the --chmod option requires BuildKit". Not documented anywhere in the
   repository, see finding "image build needs BuildKit".
2. `/usr/bin/restic` as a **real file** (copy of the pinned 0.16.4 binary that the bootstrap had put in
   `/usr/local/bin`). `TestPglab` runs `/usr/bin/restic` and the helper refuses an engine that is not
   installed safely: first attempt "no such file", second (a symlink) "the engine restic is not
   installed safely", third (a real file, the same as CI's apt package) PASS.
3. A non-root user `runner` for the Go job (CI runs it unprivileged), see the verify-units finding.
4. `cloud-init-hotplugd.service` is failed on this image (`systemctl is-system-running` says
   `degraded`); it is unrelated and every systemd job below passed.

## Verdicts

PASS means the same command as CI exited 0 with no failed, skipped or todo test. Counts are from the
vitest JSON reports (`unit-*.summary.json`) and the logs.

| # | Job / check (CI job) | Verdict | One line |
|---|---|---|---|
| 1 | biome ci (typescript) | PASS | 2,411 files, no fixes |
| 2 | typecheck (typescript) | PASS | 29/29 tasks, 129 s, `--concurrency=2` |
| 3 | unit, contract, golden, generator tests, run 1 normal order (typescript) | PASS | 512 files, 10,383 tests, 0 failed/skipped/todo, 855 s; CI's own log sums to 10,388 = mine + the 5 conformance tests |
| 4 | build (typescript) | PASS | 23/23 tasks, 44 s |
| 5 | MCP conformance + Inspector, both eras (typescript) | PASS | 2 files, 5 tests |
| 6 | `verify:generated` | PASS | 10 files, deterministic |
| 7 | `golden:check` | PASS | 16 files, all locked |
| 8 | `golden:history a0fda7ca` (the push `before`) and `golden:history 6e556f6b` (G4 freeze) | PASS | 453 vectors unchanged, 0 new, 21 frozen Control Store bundles byte-identical, 0 newly frozen; 34 MCP tool versions unchanged |
| 9 | `boundaries`, `secrets` | PASS | 44 components modeled; no secrets in 3,247 tracked files (12 patterns and canaries) |
| 10 | `bun audit` | PASS | 678 packages, no vulnerabilities |
| 11 | `third-party`, `licenses`, `ui-safety` (in `verify`, not in CI) | PASS | 171 copied files registered; 287 shipped + 339 dev packages; 1,087 files, 1 documented exception |
| 12 | `toolchain`, `verify:host --list` | PASS | the pinned versions hold; every file `verify:host` names exists |
| 13 | working tree unchanged after all of it (typescript) | PASS | `git status --porcelain --untracked-files=all` empty |
| 14 | integration, Control Store PG 17 + managed targets PG 16/17/18 TLS + S3 (postgres), run 1 | PASS | 105 files, 1,716 tests, 541 s; 228/251/235 tests carry PG 16/17/18 in their name |
| 15 | packed CLI installed outside the repository; CLI process suite on the installed artifact (postgres) | PASS | 5 + 16 tests (CI: 1,737 integration = 1,716 + 5 + 16, same) |
| 16 | browser e2e, Chromium + virtual WebAuthn, `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04` (browser) | PASS | 10 files, 52 tests, 301 s, incl. visual regression (3) and axe (4) |
| 17 | gofmt, `go vet` (plain, `e2e`, `pgit`, `pglab`), `go test -tags e2e -run E2E` (go) | PASS | as root and as non-root `runner` |
| 18 | `go test -race -count=1 ./...` (go) | PASS | 960 passed, 0 skipped, 0 failed (old: 955) |
| 19 | bounded fuzzing (journal, helper x2, pg_hba splice), govulncheck (go) | PASS | no crash, no reachable vulnerability |
| 20 | release build + `verify-units.sh` (go) | PASS as CI runs it (non-root); **FAIL as root** | the root-only branch of `verify-units.sh` is broken and never runs in CI (finding "verify-units.sh root") |
| 21 | node-pg: Go wire client and capabilities, tag `pgit`, race, PG 16/17/18 clusters under systemd | PASS | 88 s |
| 22 | node-pg: agent-capabilities host test (1 long test, real agent and helper, systemd restart) | PASS | 568 s here. It FAILED once in CI on the next main commit, see "Flakiness" |
| 23 | host scenarios, all 11, one fresh cluster and Control Store each (node-host-scenarios) | PASS | 11/11, 42 tests; every run record says `passed`, 0 failed tests, 0 lab problems |
| 24 | backup-lab: `TestPglab` (tag `pglab`, real pgBackRest, restic, PG 17) | PASS after the restic fix | 33 s; `pglab` is in CI now (`go vet -tags pglab` in go, the run in backup-lab) |
| 25 | backup-lab: offline restore from the generated runbook (C-35), `packages/backups test:lab` | PASS | 3 tests, 15 s |
| 26 | image: `docker build`, user is `node` (= `smoke:image` first half) | PASS after BuildKit | `exponetdb:ci` |
| 27 | image: role-start smoke test, `tooling/smoke/roles.sh` (= `smoke:image` second half) | PASS | serve, worker, gateway healthy, graceful shutdown, exit 0 |
| 28 | image: CLI local test lab (`apps/cli test:lab`) | PASS | 7 tests, 40 s |
| 29 | image: quickstart acceptance run (installed CLI, lab, browser; `apps/server test:lab`) | PASS | 3 files, 34 tests, 586 s |
| 30 | `mcp:evals` (owner-run, needs `EXDB_EVAL_ANTHROPIC_API_KEY`) | NOT RUN | needs the owner's own model key; not part of `verify` or CI by design; without a key the 14 tasks now skip with the reason (TC-050) |
| 31 | unit, run 2, files shuffled (`--sequence.shuffle.files --sequence.seed=20261028`) | PASS | 10,383 tests, **0 tests differ** from run 1 |
| 32 | integration, run 2, files shuffled (same flags) | PASS | 1,716 tests, **0 tests differ** from run 1 |
| 33 | EXTRA unit, files **and tests inside a file** shuffled (`--sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=20261029`) | FAIL (informational) | 5 tests in 4 files differ from run 1 (see "Order dependence") |
| 34 | EXTRA integration, same flags | FAIL (informational) | 265 tests in 51 of 105 files fail: the integration files are sequential scenarios |

The execution order really changed in run 2 (first files by start time differ in every package I
compared, for example `packages/postgres` starts with `migration-analysis` in run 1 and with
`legacy-references` in run 2).

## Test counts old vs new, and coverage

The repository does not measure coverage (no coverage provider in the lockfile, no coverage
configuration anywhere), so the comparison is tests per package, each side run on the same server
with the same command (`turbo run test` and `turbo run test:integration`, forced, `--concurrency=2`).

| Suite | `d0229550` files / tests | `d51da5d0` files / tests | Delta |
|---|---:|---:|---:|
| unit (`turbo run test`) | 509 / 10,235 | 512 / 10,383 | **+148** |
| integration (`turbo run test:integration`) | 103 / 1,673 | 105 / 1,716 | **+43** |
| Go (`go test -race -json ./...`, tests and subtests that passed) | 955 | 960 | **+5** |
| Go skipped / failed | 0 / 0 | 0 / 0 | |
| host, e2e, lab, install, conformance (declarations in the files) | 39 / 45 / 37 / 5 / 3 | 39 / 45 / 37 / 5 / 3 | 0 (the host files changed inside, see below) |

No drop. Per package the unit side: `apps/cli` 105 to 173, `packages/postgres` 1,300 to 1,322,
`tooling` 164 to 176, `packages/migrations-engine` 59 to 70, `packages/backups` 26 to 36,
`packages/application` 68 to 77, `packages/nodes` 31 to 37, `packages/policy` 115 to 118,
`packages/contracts` 219 to 221, `apps/web` 2,498 to 2,501, `packages/ui` 520 to 521,
`packages/operations` 11 to 12, all others equal. Integration side: `packages/migrations-engine`
157 to 186 (two new files), `packages/diagnostics` 183 to 189, `apps/server` 400 to 404,
`packages/operations` 32 to 35, `packages/nodes` 23 to 24, all others equal.

Test by test (by file and full name, `scripts/diffruns.mjs`): of the old tests exactly **two names
are gone, and both are renames of the same test**:

- unit, `apps/server/test/http-auth.test.ts`: "leaves exactly the Wave 9 routes and the ledger
  reconciliation plan unserved" became "serves every contracted route (the ledger reconciliation plan
  since TC-007)" and now expects the unserved list `[]` (the route is served now);
- integration, `packages/operations/test/engine.int.test.ts`: "transition_allowed and state_admits
  agree with the code for every input" became "the transition functions and state_admits agree...",
  the SQL now accepts `transition_allowed OR recovery_transition_allowed` because the code gained
  the recovery edge (TC-005).

149 unit and 44 integration test names are new.

## Skips, weakened assertions, raised timeouts (diff `d0229550..d51da5d0`)

- **Skips.** One `.skip`/`context.skip` is new in the whole tree: `apps/server/test/mcp-evals.model.test.ts:90`
  (the 14 model evals, only when `EXDB_EVAL_ANTHROPIC_API_KEY` is absent, with the reason in the
  message). That is exactly the prescribed fix of TC-050 ("report the missing key through the vitest
  skip mechanism"), the evals are outside `verify` and CI, and it is the only conditional skip. The
  other `t.Skip` (`pglab_test.go:64`, "only as a lab run's child") exists at both commits and runs as
  the child. No `.todo`, `.only`, `.fails`, `skipIf`, `runIf`, `xit`, `xdescribe`, retry or
  suppression comment was added. My runs report 0 skipped and 0 todo in every suite above (Go: 0
  skip). `runbook.lab.test.ts` still throws when its prerequisites are missing ("never skipped").
- **Removed or weakened assertions.** I read every removed line in the 45 modified test files
  (`git diff -U0`) and compared assertion and test-declaration counts per file: none went down.
  Deliberate changes, each with a stated reason in the diff:
  1. `packages/operations/test/states.test.ts`: the property "verification_failed implies a
     verification happened" is relaxed to "or the previous state was needs_attention" because the fix
     adds the edge `needs_attention -> verification_failed` (OD-58, TC-005); a new test pins that this
     is the only extra way in and that `unknown` is never kept as the apply outcome.
  2. `packages/policy/test/node-rules.test.ts`: the broad `decision === 'allow'` for node reads and
     lifecycle kinds became "rule `node.prod-apply-approval` does not apply" plus explicit
     `allow` checks for `node.inspect` and `node.enroll` (needed because `node.revoke` and
     `node.decommission` now require re-authentication, TC-019, with their own new describe block).
  3. `apps/server/test/host/hba.host.test.ts` and the same block of `agent-capabilities.host.test.ts`:
     the host-level proof "the agent's own refusal of a lockout block, file put back byte for byte" is
     replaced by a plan-time refusal (`409 HBA_WOULD_LOCK_OUT`, TC-018); the host scenario no longer
     reaches the agent's refusal, which is now only proven by `capabilities_pgit_test.go:465-472`
     (job node-pg, on real clusters). It passed here (item 21). Coverage moved, did not shrink.
  4. `visual-regression.e2e.test.ts`: the assertion is the same, only its message gained a hint (TC-054).
  5. `ledger-guard.int.test.ts` is **stronger**: `suite(16, false)` and `suite(18, false)` became `true`.
- **Timeouts.** No test or hook timeout was raised; the vitest configs differ only by `env: { TZ: 'UTC' }`
  (TC-049). The only raised limit is the CI `timeout-minutes` of the typescript job, 20 to 30,
  with a comment. My replica of that job takes 4 + 129 + 22 + 855 + 44 + 42 s = about 18 min; the
  GitHub run took 21.5 min (unit step 17 min), so the 30-minute limit leaves 8 minutes.

## GitHub Actions (run on the lead's machine with `gh`)

`gh run list --repo davdxpx/ExponetDB --commit d51da5d0d8832ebc569f23985c7e5176e4d450ad`: one run,
workflow `ci`, event `push` to `main`, run id 40750567758, 2026-10-28 19:01 to 19:23 UTC,
**completed, success, attempt 1**. All 18 jobs ran and passed: TypeScript, PostgreSQL integration,
Browser end-to-end, Image, Go, Node agent on PostgreSQL 16/17/18, Backup and restore lab (new in this
commit), and the 11 host scenarios. The only non-success step of the run is the conditional "Visual
regression screenshots of a failed run" (skipped because nothing failed). No job never ran.

Which are required: **none**. `gh api repos/davdxpx/ExponetDB/branches/main/protection` answers 404
"Branch not protected", `repos/.../rulesets` is `[]`, `branches/main` says
`required_status_checks: {contexts: [], enforcement_level: off}`. CI is advisory (finding "main unprotected").

History of `main` (last 14 runs): `d51da5d0` success; `a0fda7ca`, `92a416f4`, `4573c09a`,
`d0229550` **cancelled** (the next push cancelled them: `concurrency: cancel-in-progress: true`
applies to pushes to `main` too); `cad5ac15` failure; `02ed23ca` success; four earlier failures and
one cancelled. So the pre-fix commit `d0229550` never had a completed CI verdict, and the commit
under test is the first green one since 2026-10-26. The next main commit `c89bbe1a` (PR #47)
**failed** in the job "Node agent on PostgreSQL 16, 17, 18 (systemd)", see "Flakiness".

Not run by CI at all (all passed here): `third-party`, `licenses`, `ui-safety` (they sit in `verify`
only), `mcp:evals`.

## Order dependence (item 2)

**What was asked** (file order shuffled, `--sequence.shuffle.files --sequence.seed=20261028`, unit and
integration against the normal-order run 1): **0 tests differ** in both suites (10,376 distinct names
each in the unit suite, 1,716 in the integration suite; every status `passed`). No order dependence
between files, and nothing to re-run alone.

**Extra, because the file level proved nothing is hiding** (run 3, `--sequence.shuffle.tests` added,
seed `20261029`, turbo `--continue`). The tests inside a file run in declaration order by default, and
a number of them rely on that. Classification by re-running each failing file alone (default order,
the same seed shuffled, and the single test with `-t`; `run3-classification.txt`):

| Test (file) | Default order | Same seed shuffled | Alone (`-t`) | Class |
|---|---|---|---|---|
| `packages/audit/test/golden.test.ts`: "relations: sameHashAs and differsFrom hold as stated" and "the chain of ac1-001 and ac1-002 links" | 30/30 pass | 2 fail | fails | test bug: a golden-vector test reads values stored by earlier tests |
| `packages/policy/test/version.test.ts`: "pv1-003: same rules listed in the other order..." | 18/18 pass | 1 fails | fails | same |
| `packages/secrets/test/envelope.test.ts`: "se1-008: the data key of se1-001 rewrapped..." | 31/31 pass | 1 fails | fails | same |
| `packages/secrets/test/store.int.test.ts`: "re-wraps every data key under the new key..." (`expected 2 to be greater than 5`) | 11/11 pass | 1 fails | fails | test bug: counts data keys that earlier tests created |
| `apps/design-system/test/patterns/ui-patterns.test.tsx`: "says \"Could not load suggestions\"..." | 32/32 pass (3 runs) | passes alone; **fails 1 of 3** package runs with the seed | passes | flaky under shuffle/load (typed key sequence with `waitFor` 3 s; a previous test's popover is still mounted in the failure DOM) |
| 50 further integration files (22 in `apps/server`, 7 in `packages/auth`, 6 in `packages/migrations-engine`, 4 in `packages/audit`, 3 each in `packages/registry` and `packages/control-store`, 2 each in `packages/diagnostics` and `packages/operations`, 1 in `packages/nodes`) | pass | 264 tests fail | n/a | by design these files are one scenario after another (tests share the database state of their predecessors); the list is `int-run3-failing-files.tsv` |

Consequence for people: the default order is the contract. A test cannot be run alone with `-t` for
these files (one golden-vector test fails when run alone), `--sequence.shuffle.tests`, `test.concurrent` and
retries cannot be used, and the failing-test rerun that this block recommends does not work for them.
Finding "tests depend on in-file order" (severity P3).

## Flakiness (commit under test and its successor)

- `agent-capabilities.host.test.ts` (one 9-minute test, real agent and helper under systemd, repeated
  SIGKILL restarts): passed in CI on `d51da5d0`, passed on vc-1 three times (568, 568, 567 s), and
  **failed once in CI on the next commit `c89bbe1a`** (run 40761095455, job "Node agent on PostgreSQL
  16, 17, 18 (systemd)") with `expected [503, 'NODE_OFFLINE'] to deeply equal [202, undefined]` at
  `agent-capabilities.host.test.ts:724`, the first `inspect()` after the crash-injection restarts. That
  commit changes nothing of the node agent (CLI views, parser, contracts, docs), so I classify it as a
  test race, not reproduced here (3 passes of 3). Finding "agent-capabilities host test flake".
- Nothing else failed in two normal and one shuffled-files run of unit and integration, in the
  eleven host scenarios, the lab jobs or the e2e run.
- The design-system "Could not load suggestions" test above is the only unit test I saw fail without a
  code change (1 of 3 with the shuffle seed).

## Deliberately not committed

Raw logs (3.4 MB in `/srv/work/logs`), per-test result tables (`/srv/work/results/*.tsv`, 1.5 MB
each), Go `-json` streams (0.8 MB each), the vitest JSON reports in `/srv/work/new/*/.vr-*.json`, the
48 visual-regression actual screenshots in `/srv/work/visual-actual`, the downloaded GitHub job logs
(on the lead's machine only), Docker images and containers, the `runner` home copy, and the generated
credentials of the disposable containers (`/srv/work/infra.env`, mode 600, regenerated per phase).
