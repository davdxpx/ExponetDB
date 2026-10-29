### [P2] main has no branch protection or required checks, and cancel-in-progress cancels CI of commits on main
- **Area:** repository settings, `.github/workflows/ci.yml` (concurrency)
- **Block:** A
- **Reproduction:** `gh api repos/davdxpx/ExponetDB/branches/main/protection` gives 404 "Branch not protected" (checked by the lead); `gh api repos/davdxpx/ExponetDB/rulesets` gives `[]`; `gh run list --repo davdxpx/ExponetDB --branch main --limit 14`.
- **Expected:** required checks (the 18 jobs) on main, and a finished CI verdict for every commit on main.
- **Actual:** CI is advisory. `cancel-in-progress: true` also applies to pushes to main. `d0229550` (Wave 9 Part B), `4573c09a`, `92a416f4` and `a0fda7ca` are "cancelled"; `cad5ac15` failed; only `02ed23ca` and `d51da5d0` are green. The pre-fix commit never had a completed CI verdict. The run on `d51da5d0` (40750567758) passed all 18 jobs (checked by the lead).
- **Evidence:** `A/README.md`, section "GitHub Actions".
- **Root cause:** `ci.yml:23-25` (no event condition on `cancel-in-progress`); no branch protection configured.
- **Proposed fix:** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; a ruleset requiring the 18 checks, pull requests only, no force push; list the required checks in `authoring-and-ci.md`.
- **Acceptance test:** two pushes within a minute to a protected test branch both finish; a pull request with a red job cannot merge; the protection API lists the contexts.

### [P2] The agent-capabilities host test failed once in CI on the next main commit (NODE_OFFLINE after an injected crash); not reproduced
- **Area:** `apps/server/test/agent-capabilities.host.test.ts` (job `node-pg`)
- **Block:** A
- **Reproduction:** `gh run view 40761095455 --repo davdxpx/ExponetDB` (commit `c89bbe1a`, PR #47, which touches no node code): step "Capability operations end to end" failed after 523 s with `expected [503,'NODE_OFFLINE'] to deeply equal [202, undefined]` at test line 724 (the `inspect` helper), called from line 1540 right after the SIGKILL restarts. `d51da5d0` passed in CI; vc-1 passed 3 of 3 (568, 568, 567 s).
- **Expected:** the test waits until the restarted agent has a session before posting an inspection.
- **Actual:** `inspect` posts at once and requires 202; the route answers 503 NODE_OFFLINE while the agent is between restart and its next claim. 1 red of 5 observed runs.
- **Evidence:** `A/README.md`, "Flakiness" (the failing job log is on the lead's machine only).
- **Root cause:** suspected test race (not proven): `agent-capabilities.host.test.ts` about lines 715-727 and 1536-1545, no `eventually` on node liveness after `inject(..., 'crash')`.
- **Proposed fix:** `await eventually('node online', ...)` before the first post-crash inspection and keep 202 strict; split the 9-minute single test into steps.
- **Acceptance test:** 10 consecutive runs on a disposable systemd host all green, plus a helper test with a stub gateway reporting offline for 3 s.

### [P3] third-party, licenses and ui-safety are part of `bun run verify` but no CI job runs them
- **Area:** `.github/workflows/ci.yml`, `package.json` (`verify`)
- **Block:** A
- **Reproduction:** `grep -nE 'third-party|licenses|ui-safety' .github/workflows/ci.yml` finds nothing; `verify` runs all three.
- **Expected:** every runner-capable check in `verify` is a CI step (they guard ADR-0030 and OD-38).
- **Actual:** all three pass here (171 registered copied files; 287 shipped and 339 dev packages; 1,087 files with 1 documented exception), but a PR with an unregistered copied file or a bad license is not stopped by CI.
- **Evidence:** `A/README.md`, row 11.
- **Root cause:** the `typescript` job in `ci.yml` ends at `bun audit`.
- **Proposed fix:** add the three scripts after "Secret scan" (each under 2 s).
- **Acceptance test:** a PR adding an unregistered copied file under `packages/ui` turns the `typescript` job red.

### [P3] A local image build (smoke:image, docker build) needs BuildKit and no document says so
- **Area:** `Dockerfile`, `package.json` (`smoke:image`), `local-development.md`, `deployment.md`
- **Block:** A
- **Reproduction:** Ubuntu 24.04 with distro docker.io 29.1.3 (no buildx): `docker build -t exponetdb:local .` stops at step 14 "the --chmod option requires BuildKit"; `smoke:image` and both `test:lab` suites then fail. After `apt-get install docker-buildx` all pass.
- **Expected:** the prerequisite is documented or pre-checked.
- **Actual:** `git grep -niE 'buildkit|buildx'` over md, Dockerfile and scripts finds nothing; the error arrives after a 97 s build stage.
- **Evidence:** `A/README.md`, "Bootstrap changes" 1; log `n-image-build.log` on vc-1.
- **Root cause:** `COPY --chmod=... --chown=...` in the Dockerfile is BuildKit-only.
- **Proposed fix:** one sentence in `local-development.md` and `deployment.md`, plus a `docker buildx version` pre-check in `smoke:image`.
- **Acceptance test:** `smoke:image` on a host without buildx fails within a second, naming the package.

### [P3] Tests depend on the order of tests inside their file, so a single test cannot be run alone
- **Area:** `packages/audit/test/golden.test.ts`, `packages/policy/test/version.test.ts`, `packages/secrets/test/envelope.test.ts` and `store.int.test.ts`, 51 integration files, `apps/design-system/test/patterns/ui-patterns.test.tsx`
- **Block:** A
- **Reproduction:** in a clone at `d51da5d0`: `cd packages/secrets && bunx vitest run test/envelope.test.ts -t se1-008` fails (the default order of the whole file passes). Likewise `-t pv1-003` (policy), `-t 'chain of ac1-001'` (audit), and `-t 're-wraps every data key'` (secrets integration, with `EXDB_TEST_PG_URL`). A full run with `--sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=20261029`: unit 5 tests in 4 files fail; integration 265 tests in 51 of 105 files fail. Shuffling file order alone changes nothing (0 differ).
- **Expected:** each test passes in any order and alone, or the dependence is explicit (`describe.sequential` plus a note) and the files are never run with `-t`.
- **Actual:** golden-vector tests read values written by earlier tests (for example `expected undefined not to be undefined`, `expected 2 to be greater than 5`); the design-system "Could not load suggestions" test passes alone but fails 1 of 3 package runs with the seed (a previous test's popover is still mounted in the failure DOM).
- **Evidence:** `A/run3-classification.txt`, `A/int-run3-failing-files.tsv`, `A/README.md` "Order dependence"; logs `n-unit-run3`, `n-int-run3` on vc-1.
- **Root cause:** shared module or database state across tests of one file; no per-test setup.
- **Proposed fix:** build the state inside each test or in a describe-level `beforeAll`; derive golden expectations from the vector file; mark true scenario files with `describe.sequential` and a header comment; fix the leak in `ui-patterns.test.tsx`.
- **Acceptance test:** the four `-t` commands above pass alone, and `vitest run --sequence.shuffle.tests` passes for `packages/audit`, `policy`, `secrets` and `design-system` with five seeds.
