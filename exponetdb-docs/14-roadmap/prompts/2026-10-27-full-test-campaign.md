# ExponetDB: full test campaign before production use (27.10.2026)

You are a test lead. Your job is to find out, with evidence, everything that
still breaks or is unproven in ExponetDB before REOSA's production database is
ever managed by it (Wave 11). You do **not** fix product code. You test, you
measure, you write it all down, and at the end you start one fix session with
the result.

Run on Claude Sonnet 5.5 at effort extra high. Be thorough, not fast: the owner
wants every point that can be tested, tested. "Not run" is an acceptable answer
only with the exact reason and what it would take to run it.

## 0. Ground truth and rules (read first, they override anything you infer)

- Repo: `/home/david/Development/ExponetDB`, test against `origin/main`
  (currently `d0229550`, Wave 9 Part B, PR #43). The local checkout is on
  another branch: create your own worktree from `origin/main`
  (`git worktree add ../ExponetDB-testcampaign origin/main`) and work there.
- **Do not change the ExponetDB repo** (no commits, no branches pushed, no PR).
  You may write files only under the untracked folder
  `exponetdb-docs/14-roadmap/prompts/` (evidence folders and the final prompt).
- Read before testing: `CLAUDE.md`, `exponetdb-docs/14-roadmap/implementation-waves.md`,
  `acceptance-gates.md`, `test-strategy.md`, `PRE-WAVE-11-REVIEW.md`,
  `gates/7.md`, `gates/8.md`, `gates/9.md`, `gates/9-part-a.md`,
  `gates/9-part-b-gap-matrix.md`, `orders/wave-9-part-b-order.md`,
  `exponetdb-docs/12-operations/node-runbook.md`, `exponetdb-docs/07-node-agent/capabilities.md`,
  and the earlier prompts in `exponetdb-docs/14-roadmap/prompts/` (the G5
  evidence runs show how host tests were done: `g5-evidence-2026-10-26-rerun/`).
- **Secrets:** never print, log or commit a secret, token, password, verifier or
  connection string with a password. Pass them only via files or stdin
  (`curl -K -`). Tokens live in `~/.config/exponetdb/credentials.json`,
  `~/.config/reos-secrets/` (Coolify: `coolify-exponetdb-token`, Hetzner:
  `hcloud-auth-header`). Output only counts, hashes and ids.
- **The live installation** `https://db.exponet.cloud` (Coolify on
  `exponet-server`, apps worker `mmsijgm7j9mygrkxqybqo5gh`, gateway
  `t7ledbddql3g0fostpla3tpr`, serve `b1pqt6dy72kwezeemjh4majr`) manages REOSA
  staging. Allowed there: every read (CLI, REST, MCP), plans that you do not
  apply, `node inspect`, and applies **only** against the target
  `reosa/platform/scratch` (database `reosa_staging_scratch`, a rehearsal copy).
  Never apply anything against `reosa/platform/staging`, never change Coolify
  settings or env vars, never redeploy, never touch the control store except
  read-only `psql` (`ssh exponet-server "docker exec rsbn9zqgegt2wpebijlnrmm4 psql -U postgres -d exponetdb_control -At -c ..."`).
- **reos-db-01** (`root@<reos-db-01-public-ip>`, key `~/.ssh/claude_reos_db01`, private
  `10.8.1.1`) runs PostgreSQL 17 with REOSA staging and the node agent 0.7.0
  (node `nod_01M5XZ84V768SYCHZKRNGJFQP2`, cluster `cls_01M5J4RDBP52B715X5HDFKDN5F`,
  `management_mode=agent`). Read only: no package changes, no service restarts,
  no file edits, no SQL on `reosa_staging`.
- **Supabase** (REOSA production `zmlegaporyathnfvnbrv`): out of scope, do not
  connect.
- **Destructive and engine tests** (backup, restore, PITR, drills, crash,
  disk full, clock skew, helper stop, certificate expiry, journal corruption,
  upgrade and downgrade of the agent) run only on infrastructure you create and
  destroy yourself:
  - local Docker (Postgres 17, the dev control store `bun run dev:control-store`,
    `dev:targets`), and
  - disposable Hetzner Cloud servers (cx33, location nbg1 or fsn1, at most 3 at
    a time, labelled `purpose=exponetdb-test-campaign`), created with the API
    token from `~/.config/reos-secrets/hcloud-auth-header`, each with its own
    throwaway SSH key. Delete every server and key you created before you
    finish, and list their ids in the report as deleted. Prefer local Docker
    when it proves the same thing.
- Commits and authorship do not apply (you commit nothing). If you start the fix
  session, tell it the authorship rule below.
- zsh does not word-split variables; write ssh wrappers as functions. Long runs
  go to the background; do not poll with sleep loops.

## 1. What to test (every block gets a verdict: PASS, FAIL, PARTIAL, NOT RUN)

### A. The automated suites, all of them, on `origin/main`
Run `bun install --frozen-lockfile`, then each part of `bun run verify`
separately so one failure does not hide the next: `check`, `typecheck`, `test`,
`test:integration`, `test:e2e`, `apps/server test:conformance`, `build`,
`verify:generated`, `golden:check`, `golden:history origin/main`,
`boundaries`, `secrets`, `third-party`, `licenses`, `ui-safety`, `go:test`
(Go toolchain: install into your scratchpad if missing), `smoke:image`,
`mcp:conformance`, `mcp:inspect`, `mcp:evals`, and the host test of the agent
(`apps/server/test/agent-capabilities.host.test.ts`, CI job `node-pg`) on a
disposable cx33 if it needs real systemd. Record duration, counts, every
failure with its first error, and flaky tests (rerun failures twice).

### B. The open items of the reviews and gates
Work through, item by item, with your own evidence:
- `PRE-WAVE-11-REVIEW.md`: W9-01 (T-S3-1..6 lock tests, T-NODE-1/2 systemd runs,
  T-C35-1 offline drill, a passed drill per repository), W9-02 the manual
  matrix M-1..M-12 (all NOT EXECUTED so far: execute every one you can),
  W9-04 residuals R-BKP-1..9, R-NODE-3/4, R-VIEW-1, R-MCP-1, R-OD56-1, R-OD55,
  R-CLI-1, W9-05 (scheduler, placement move, hand-over to `owned`).
- The G6 waivers E16 and E18 (they must close before real REOSA data is
  imported in Wave 10; the review says "still no detection").
- `gates/9-part-a.md`: the three P1 findings (single-quoted `DO` body, memory
  over large histories, quadratic `search_path` regex): reproduce each with a
  minimal input and measure.
- G7, G8 (deep-link contract), G9 and G10 criteria in `acceptance-gates.md`:
  for each criterion say what evidence exists, what you produced, what is
  missing.

### C. End-to-end on the live installation (read and scratch only)
- Every CLI command group and every MCP tool: run each read, each plan without
  apply, and the applies allowed above against `reosa/platform/scratch`.
  Compare CLI, REST, MCP and Web for the same facts (counts, states).
- Migrations on scratch: a new bundle (lint, plan, apply, verify), a failing
  verify (verification_failed must not retry or roll back), a verify revision,
  drift after an out-of-band change on scratch (made through an ExponetDB-free
  path is NOT allowed on staging; on scratch only through a plan or on a
  disposable copy), lock timeouts, a nontransactional bundle, rollback plans.
- The node agent through the live control plane: `node inspect` for every
  inspectable capability on `nod_01M5XZ84V768SYCHZKRNGJFQP2`, plans for every
  node change kind **without applying them** (postgres.hba.apply,
  config.apply, roles.apply, extensions.apply, tls.rotate, reload, restart,
  config.update, job-keys), and judge each plan's content.
- The Web app (`https://db.exponet.cloud`) with Playwright: every page in the
  rail at 1440 and 390 px, the states the U4 audit lists as fixed, keyboard
  navigation, console errors. Sign-in needs the owner: if a step-up or login
  is needed, ask the owner in one short message with the link and wait.

### D. Engine, failure and recovery on disposable infrastructure
On a fresh cx33 (Ubuntu 24.04, PGDG PostgreSQL 17) with the agent built from
`origin/main` (`agent/node/packaging/build.sh`), enrolled against a **local**
control plane (not the live one), test at least: backup run, list, expire;
restore to scratch; PITR; a restore drill end to end; helper stopped and
started; agent killed mid-job (outcome_unknown and reconcile); gateway outage;
clock skew; certificate renewal and expiry (the live node's certificate
expires 2026-10-30T05:57:35Z; prove renewal works before that date, on the
disposable node with a shortened validity if the code allows); journal
corruption; disk full; upgrade 0.6.0 to 0.7.0 and the downgrade rule; the
`pg_hba` managed block (markers as the agent writes them, foreign lines kept,
protectedAccess refusing a plan that would cut ExponetDB off).

### E. Findings already seen in REOSA's sessions (verify, then keep or drop)
1. `exponetdb-node enroll` fails with `state directory: lstat /var/lib/exponetdb-node`
   when run before the units ever started (runbook gap: systemd creates
   StateDirectory only at unit start).
2. `exponetdb node show` prints "No clusters reported" while
   `nodes.nodes.clusters` holds `17/main` (systemIdentifier 7694369944861798500).
3. `sql_query` refuses `pg_stat_activity` and `pg_settings`
   (`QUERY_CONSTRUCT_UNSUPPORTED`), and refused a query that names `tenants`
   unqualified together with `current_user` while the same read with
   `public.tenants` passed. There is no way to see connection counts through
   ExponetDB although health has `connections_high`.
4. A CLI from an older commit answers `RESPONSE_INVALID` against the new
   contract instead of saying the CLI is too old.
5. `exponetdb node job-keys <node>` without changes errors with "adds or
   removes at least one key"; there is no read form.
6. An enrollment whose token was never used (`ent_01M5XZ0J5CTYJBGB9XSVCPZFRE`)
   stays open: does it expire, can it be revoked (the U5 table says "expires
   only")?
7. Node plans need a node-signed observation younger than 10 minutes
   (`NODE_OBSERVATION_STALE`); the CLI does not offer to inspect first.
8. `-- covers:` in `verify.sql` counts statements from 0; nothing in the docs
   says so, and 1-based numbers only produce `uncovered_statement` warnings.
9. `migration lint` over the whole bundle root blocks on findings of bundles
   that are already applied and verified (for example
   `01M5X2X3ARA75KSKZPANYYEHHW_event-platform`, 11 blocking), so a clean new
   bundle cannot get a green lint run.
10. Enrollment needs two step-ups that each expire after about two minutes.
11. The CLI login needed an explicit `--scope ... nodes.plan` for `node inspect`
    and node plans; presets did not include it.
For each: reproduce, give the exact command and output, severity, and the
fix area (file and function).

## 2. How to record

- One evidence folder: `exponetdb-docs/14-roadmap/prompts/test-campaign-2026-10-27/`
  with raw outputs (redacted), one file per block A to E.
- Severity: P0 (data loss, security, a production outage), P1 (wrong result or
  a blocked core flow), P2 (degraded, workaround exists), P3 (polish).
- Every finding: id (TC-NNN), title, severity, area, exact reproduction,
  expected, actual, evidence path, suspected root cause with file:line, a
  proposed fix, and an acceptance test that proves the fix.

## 3. The result: one large fix prompt, then one fix session

Write `exponetdb-docs/14-roadmap/prompts/2026-10-27-test-campaign-fixes.md`:
- a summary table (verdict per block A to E, counts per severity),
- every finding as above, P0 first,
- what could not be run and why,
- the rules from section 0 that the fix session must keep, plus: the fix
  session works on a branch from `origin/main` in its own worktree, one PR,
  commits as `𝕏0L0™ <davdxpx@gmail.com>`, never Claude as author or
  co-author, no `Co-Authored-By` trailer, no session links (at most
  "Developed by @davdxpx"), tests first for every fix, it does not merge and
  does not redeploy (the owner does both on request), and it updates the gate
  and review docs it touches.

Then start the fix session with that file as its prompt (use `start_session`
if you have it; otherwise create a task chip with `spawn_task` whose prompt
says: "Read and execute exponetdb-docs/14-roadmap/prompts/2026-10-27-test-campaign-fixes.md
in /home/david/Development/ExponetDB"), and tell the owner in a short closing
message: verdicts per block, the P0 and P1 findings in one line each, the cost
side (servers created and deleted), and the link to the fix session.
