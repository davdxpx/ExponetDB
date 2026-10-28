# ExponetDB test campaign of 2026-10-27: findings and the fix session

You are the fix session of a test campaign. A test lead tested ExponetDB at
`origin/main` (`d0229550`, Wave 9 Part B, PR #43) end to end, without changing the
repository, to find out what still breaks or is unproven before REOSA's production
database is ever managed by it (Wave 11). This file is the result. Read it completely,
then fix the findings in section 4 in the order of section 5, in your own worktree, as
one pull request, under the rules of section 7 (they override anything you infer).

Everything claimed here has evidence under
`exponetdb-docs/14-roadmap/prompts/test-campaign-2026-10-27/` (folders `A` to `E`, `F`
for this prompt's sources). Findings carry the exact reproduction, the suspected root
cause with `file:line` at `d0229550` (lines may have moved: re-read before editing),
a proposed fix and an acceptance test. Where a finding says "owner decision", record an
open decision instead of deciding.

## 1. Summary

Findings: **75** (P0 0, P1 13, P2 34, P3 28). No P0 (no data loss, no secret exposure and no
outage was found or caused). The campaign's headline results:

- **The CI-equivalent suites are green on the pinned toolchain** (Node 24.22.1, Bun
  1.4.4, Go 1.26.10, Ubuntu 24.04, UTC): typecheck, unit (13 min), build, integration
  (PostgreSQL 16/17/18 targets, 18 min), browser end-to-end with the CI visual baselines,
  MCP conformance, `go vet`/`go test -race`, `pgit` and `pglab` Go suites, the
  agent-capabilities host test and all 11 host scenarios on a real systemd host.
  Static checks, golden checks, boundaries, secrets, third-party, licenses, ui-safety and
  `bun audit` pass.
- **The product still breaks where the tests do not look:** the backup and restore
  engine on a real host (all drills fail, `backup.verify` misses a corrupt WAL, logical
  restic backups cannot run, the offline-drill record returns 500), the migration engine
  under failure (an operation that blocks the target for ever, drift silently adopted),
  hostile legacy-import input (a single-quoted `DO` body and a quadratic regex), and the
  node plan views and CLI (no content for `postgres.*` plans, config and roles plans
  impossible from the CLI).
- **What is honestly unproven:** object locks on real buckets (T-S3), a real
  production-grade restore drill with a measured RTO, the real model evals, and the
  owner-only steps. See section 6.

### Verdict per block

| Block | Scope | Verdict | One line |
|---|---|---|---|
| A | automated suites | **PARTIAL** | green on the pinned toolchain; on the lead's non-pinned machine one time-zone test and the machine-specific visual baselines fail; `mcp:evals`, `test:install`, the labs, fuzzing and govulncheck NOT RUN |
| B | review and gate open items | **FAIL** | the three Part A P1s reproduce; Wave 9 Part B security fixes lack named regression tests; E16/E18 have no detection; E25 has no recovery; G10 criteria are unbuilt or unachievable as worded; T-S3 NOT RUN |
| C | live installation (read and scratch only) | **PARTIAL** | 76 CLI reads, every MCP tool read, every inspectable node capability and every node plan kind exercised, plus a Web audit of about 75 routes; live scratch migrations stopped at a planner error; no 1440/390 screenshots |
| D | engine, failure and recovery on disposable servers | **FAIL** | agent upgrade/downgrade, renewal, clock, disk full, hba and job keys behave; the backup/restore path has 5 P1 defects |
| E | the eleven findings from REOSA sessions | **11 of 11 verified** | E1, E2, E3, E4, E8, E9 REPRODUCED; E5, E6, E10, E11 PARTIAL/confirmed with corrections; E7 REPRODUCED (JSON names the capability, the text does not) |

Verdict meanings: PASS, FAIL, PARTIAL, NOT RUN (the block's own rows say which).

### Findings per block and severity

(Block = the block of the first test that found it.)

| Block | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| A | 0 | 0 | 0 | 4 | 4 |
| B | 0 | 6 | 9 | 4 | 19 |
| C | 0 | 2 | 16 | 11 | 29 |
| D | 0 | 5 | 7 | 6 | 18 |
| E | 0 | 0 | 2 | 3 | 5 |
| all | 0 | 13 | 34 | 28 | 75 |

### The eleven findings of section 1.E, verdicts

| # | Finding | Verdict | Where in this document |
|---|---|---|---|
| E1 | `enroll` fails before the units ever started | REPRODUCED, P2 | fresh-host enrollment finding |
| E2 | `node show` prints "No clusters reported" | REPRODUCED with a real agent, P2 | `node show` finding (the node view reads the heartbeat copy; the heartbeat sends none) |
| E3 | `sql_query` refuses `pg_stat_activity`, `pg_settings` and an unqualified table | REPRODUCED, P2, **reframed**: unqualified relation names are refused; `pg_catalog.`-qualified names work | sql_query finding |
| E4 | older CLI answers `RESPONSE_INVALID` | REPRODUCED, P2 (wider: no version negotiation at all) | older-CLI finding |
| E5 | `node job-keys` has no read form | PARTIAL, P3 (error reproduces; it is a plan command; a read exists only indirectly) | job keys entry |
| E6 | unused enrollment token stays open | PARTIAL, P3: it does expire (30 min after reveal, checked at redeem) but nothing sets `expired`, there is no list or revoke | enrollment token finding |
| E7 | node plans need an observation younger than 10 minutes, the CLI does not offer to inspect | REPRODUCED, P3 (JSON names the capability, text mode does not); the deeper problem is P1: config and roles basis observations cannot be made from the CLI | node plan CLI findings |
| E8 | `-- covers:` is 0-based, undocumented | REPRODUCED, P3 | covers finding |
| E9 | `migration lint` blocks on applied bundles | REPRODUCED, P2 | lint finding |
| E10 | enrollment needs two step-ups of about two minutes | CONFIRMED from code, P3 (receipts 120 s, one per action) | step-up finding |
| E11 | `node inspect` and node plans needed an explicit `nodes.plan` scope | PARTIAL, P3: `nodes.plan` is in `operator:*` but not in `admin`/`developer:*`/`read`; presets cannot be combined | presets finding |

## 2. Campaign facts

- **Tested commit:** `origin/main` `d02295503bcfb7a4a4baea860bd9fceebe80b8b4`; the
  campaign changed nothing in the repository.
- **Live installation** `https://db.exponet.cloud` reported server version 0.2.0 (REST v1).
  Reads only, plus plans that were never applied and advisor runs (see section 5, "owner").
  Nothing was applied to `reosa/platform/staging` or `reosa/platform/scratch`; Supabase and
  Coolify settings were not touched; no secret was printed.
- **Disposable infrastructure (all deleted, ids in `D/hetzner-resources.md`):** three
  Hetzner cx33 servers (Ubuntu 24.04, nbg1; ids 172883093, 172885262, 172885648) and two
  throwaway SSH keys (131861135, 131878058), all labelled
  `purpose=exponetdb-test-campaign`; local Docker containers and the `exponetdb:local` image
  of the lead were removed. Only the pre-existing `reos-db-01` (169416658) remains, untouched.
- **Method:** the lead ran Block A and the live reads; ten independent tester agents
  (static audit, gate map, Part A P1 reproductions, migration engine, E findings, CLI read
  sweep, node plans, Web audit, backup/restore on a real host, gap scenarios) each wrote a
  report under `B`, `C`, `D`, `E`. Findings were merged without dropping any.
- **Toolchains:** pinned replica Node 24.22.1, Bun 1.4.4, Go 1.26.10, pgBackRest 2.60.0,
  restic 0.16.4, PostgreSQL 16/17/18 from PGDG. The lead's own machine ran Node 26.5.0 and
  Bun 1.3.14 (outside `engines`), so its failures are labelled accordingly.
- **Severity:** P0 data loss, security, production outage; P1 wrong result or blocked core
  flow (or a DoS reachable by legitimate input); P2 degraded, workaround exists; P3 polish.


## 3. Index of findings

| Id | Sev | Title | Block |
|---|---|---|---|
| TC-001 | P1 | `plan show` returns no change content for the seven `postgres.*` node plan kinds | C (node-plans D1) |
| TC-002 | P1 | `node postgres config` and `node postgres roles` cannot be planned from the CLI | C (node-plans D2), E3/E7-related |
| TC-003 | P1 | A single-quoted `DO '...'` body bypasses the parser token bound (Part A P1 no. 1) | B (Part A P1 1, `gates/9-part-a.md:988-9 |
| TC-004 | P1 | The `search_path` strictness check is a quadratic regular expression (Part A P1 no. 3) | B (Part A P1 3) |
| TC-005 | P1 | An operation in `needs_attention` holds the target's schema domain and the documented recovery cannot start (MIG-01) | B (failure cases a, b, e; migration-engi |
| TC-006 | P1 | The next verified migration silently adopts an out-of-band schema change into the drift baseline (MIG-02) | B (failure case c) |
| TC-007 | P1 | A restored ledger blocks every schema plan and `ledger.reconcile` is not built (MIG-03, E25 waiver) | B (failure case g) |
| TC-008 | P1 | One stored bundle with an unknown dependency blocks planning for the whole project (MIG-04, seen on the live installation) | B/C (failure case j; `C/live-migration-a |
| TC-009 | P1 | `latest` and `older` restore drills always fail on a real host (D-01) | D (backup/restore end to end, M-6, T-NOD |
| TC-010 | P1 | `amcheck: not_run` fails every drill unless the extension exists in every restored database (D-02) | D |
| TC-011 | P1 | `backup.verify` never detects corruption (D-03) | D (M-4) |
| TC-012 | P1 | Logical backups to a local (posix) restic repository cannot run under the shipped sandbox (D-06) | D (M-5) |
| TC-013 | P1 | `POST /clusters/{id}/drills/offline` returns HTTP 500 (D-09) | D (T-C35-1) |
| TC-014 | P2 | sql_query refuses unqualified relation names and system views with a misleading construct error (E3) | C, E3 |
| TC-015 | P2 | query_stats is unavailable on every registered target and its error names the wrong cause | C |
| TC-016 | P2 | `node show` and the node view always say "No clusters reported" (E2) | C, E2 |
| TC-017 | P2 | Read-classified diagnostics and advisor actions persist data and flood the findings counters (OD-57 in practice) | C |
| TC-018 | P2 | A pg_hba block that rejects everything is planned and allowed; there is no plan-time protectedAccess check | C (node-plans D3) |
| TC-019 | P2 | `node revoke` and `node decommission` plans state no effect, no tier and no requirements | C (node-plans D4) |
| TC-020 | P2 | A user with `nodes.plan` cannot withdraw their own node plans | C (node-plans D5), E11-adjacent |
| TC-021 | P2 | `survivingExpectations` over a whole legacy chain is quadratic and blocks the worker; memory is linear but unbounded across files (Part A P1 no. 2) | B (Part A P1 2) |
| TC-022 | P2 | `MIGRATION_DEPENDENCY_UNKNOWN` carries no id (MIG-05) | B (failure case j) |
| TC-023 | P2 | E16 `hotfix_without_evidence` has no detection (MIG-06, G6 waiver) | B (failure case g) |
| TC-024 | P2 | E18 `applied_not_in_source` has no detection (MIG-07, G6 waiver) | B (failure case g) |
| TC-025 | P2 | The ledger comparison is shallow and only the apply planner runs it (MIG-08) | B (failure case i) |
| TC-026 | P2 | CI never compiles the `pglab` Go tests nor runs `runbook.lab.test.ts`; the real-engine proofs of Wave 9 Part B are manual | B (static audit defects 1 and 2; gate-ma |
| TC-027 | P2 | Regression artifacts missing or weak for Wave 9 Part B security fixes (review W9-04) | B (static audit defects 3 to 6; 6 ARTIFA |
| TC-028 | P2 | Local evidence the W9-02 matrix names does not exist (selection, 500-chain, PostgreSQL 16/18) | B (static audit defect 7; gate-map G9.3) |
| TC-029 | P2 | Silent partial coverage in the default test run (CI classes and conditionals) | B (static audit section 6) |
| TC-030 | P2 | A failed list read still prints an empty-list body on stdout and the JSON error envelope carries `data.items: []` | C (CLI sweep D1) |
| TC-031 | P2 | `node list --server` ignores its filter; `node enrollment status` treats an unknown server as "not enrolled" | C (CLI sweep D3) |
| TC-032 | P2 | `migration import scratch-check` and `scratch-copy-commands` accept a nonexistent scratch and give false reassurance | C (CLI sweep D4) |
| TC-033 | P2 | `access grants` cannot work with the CLI's OAuth token | C (CLI sweep D5) |
| TC-034 | P2 | An approval-gated erase operation stays `awaiting_approval` after its plan was consumed, approved 1 of 1 and expired (live data) | C (CLI sweep D6; the editor's check sugg |
| TC-035 | P2 | Rail tooltips stay open after keyboard focus leaves the rail (W-01) | C (Web audit W-01) |
| TC-036 | P2 | The Findings "Kind" filter cannot select advisor or statements findings (W-02) | C (Web audit W-02) |
| TC-037 | P2 | The headline "Critical findings 520 of 14,184" is 518 expected scratch drift rows, one roll-up and one real finding (W-03) | C (Web audit W-03) |
| TC-038 | P2 | Node page: the h1 is the raw id and the page scrolls sideways at 390 px (W-05) | C (Web audit W-05) |
| TC-039 | P2 | `exponetdb-node enroll` on a fresh host fails with `state directory: lstat /var/lib/exponetdb-node`; the literal runbook has two more blockers (E1, GAP-01 to GAP-03) | D/E (E1 reproduced on a real systemd hos |
| TC-040 | P2 | An older CLI answers `RESPONSE_INVALID` against a newer server; no version negotiation exists (E4) | E (E4 reproduced at unit level) |
| TC-041 | P2 | `migration lint` has no path, bundle or since filter, so a project with one old prod-blocking bundle can never get a green lint (E9) | E (E9 reproduced with a scratch project  |
| TC-042 | P2 | An expired node certificate is silent and indistinguishable, and nothing warns before the renewal window closes (GAP-11) | D (gap scenarios 4a to 4d; live node dea |
| TC-043 | P2 | A restore to the end of the archive reports success when the replay stops short (D-04) | D (M-4, M-7) |
| TC-044 | P2 | A refused backup start is reported as `OUTCOME_UNKNOWN` after about 100 seconds (D-05) | D (T-NODE-3, M-7) |
| TC-045 | P2 | The restic runbook neither restores globals nor stops without them (D-07) | D (M-5) |
| TC-046 | P2 | `restore.execute` does not re-check space and can fill the filesystem (D-08) | D (T-NODE-4) |
| TC-047 | P2 | M-4 and RB-06 describe backup flows the Control Plane cannot start (D-10) | D (M-4, W9-05 hand-over) |
| TC-048 | P3 | Enrollment tokens cannot be listed or revoked, and a dead token's state never becomes expired (E6) | C/D, E6 |
| TC-049 | P3 | A `time`-zone dependent unit test fails in a non-UTC shell (A) | A |
| TC-050 | P3 | `mcp:evals` counts a missing API key as 14 failed tests and sits outside `verify` | A |
| TC-051 | P3 | The pinned toolchain is not enforced by `bun install` and local runs silently use other versions | A |
| TC-052 | P3 | CLI lint table does not show which finding blocks; `project execution-roles` takes only an id | C |
| TC-053 | P3 | Two step-up receipts of 120 seconds each are needed to enroll a node (E10) | E10 |
| TC-054 | P3 | The default visual-regression baseline set `local` fails on any machine other than the one that recorded it | A |
| TC-055 | P3 | Permission-layer denial of the one allowed read-only check of the live control store | C |
| TC-056 | P3 | Node plan CLI errors drop the capability and the reason in text mode (E7) | C (node-plans D6, D7), E7 |
| TC-057 | P3 | Plan commands document `--wait` as "wait until applied and verified (the default)" although they only plan | C (node-plans D8) |
| TC-058 | P3 | No read form for job keys; `node job-keys` without changes is a usage error (E5) | C (node-plans D9), E5 |
| TC-059 | P3 | Node plan polish | C (node-plans) |
| TC-060 | P3 | Lock contention on catalog reads is reported as `PLAN_STALE` or `QUERY_TIMEOUT` (MIG-09) | B (failure case d) |
| TC-061 | P3 | A waiting operation writes two events per worker poll (MIG-10) and the "cleanup migration" alternative is unreachable (MIG-11) | B (failure case e) |
| TC-062 | P3 | G10.4 `exponetdb.missing_migrations` exists only in the documentation | B (gate map) |
| TC-063 | P3 | G10.3 as worded contradicts OD-7b; other gate-row gaps | B (gate map) |
| TC-064 | P3 | CLI read polish batch 1 (consistency of output and errors) | C (CLI sweep D7 to D15, D17, D18, D20, D |
| TC-065 | P3 | CLI read polish batch 2 (scopes, presets, import helper) | C (CLI sweep D16, D19; E11) |
| TC-066 | P3 | Web polish batch (W-04, W-06 to W-11, W-13 to W-15) | C (Web audit) |
| TC-067 | P3 | Web audit coverage gaps (not defects) | C |
| TC-068 | P3 | Downgrade rule in runbook §8 is imprecise; the real downgrade hazards are undocumented (GAP-04) | D (upgrade 0.6.0 to 0.7.0 PASS; downgrad |
| TC-069 | P3 | A refused clock reads as "job expired" on the control plane; `clockSkewMs` is not a clock-health signal (GAP-05) | D (clock scenario: agent PASS, helper PA |
| TC-070 | P3 | Disk full on the agent state or the helper ledger: silent stall, torn ledger record, undocumented restart (GAP-06, GAP-07) | D (disk full scenario: fail-closed PASS) |
| TC-071 | P3 | hba refusals carry `OUTCOME_UNKNOWN`; removing the managed block leaves an empty marker pair; job-key activation accepts a stale proof (GAP-08 to GAP-10, GAP-12) | D (hba PASS on markers and foreign lines |
| TC-072 | P3 | Hardening observations of the node units (GAP-13) | D |
| TC-073 | P3 | `-- covers:` in `verify.sql` counts statements from 0 and the documentation never says so (E8) | E (E8) |
| TC-074 | P3 | CLI presets and declared scopes do not match what the commands need (E11) | E (E11 PARTIAL: `nodes.plan` is in `oper |
| TC-075 | P3 | Reboot state reporting, unit hardening and polish of the backup runs (D-11, D-12, D-13) | D (T-NODE-1, T-NODE-2) |

## 4. Findings

Severity: **P0** data loss, security, production outage; **P1** wrong result or blocked core flow; **P2** degraded, workaround exists; **P3** polish. P0 first. Evidence paths are relative to `exponetdb-docs/14-roadmap/prompts/test-campaign-2026-10-27/`.

### P0 (0)

None found.

### P1 (13)

#### TC-001 [P1] `plan show` returns no change content for the seven `postgres.*` node plan kinds

- **Area:** application plan view (`packages/application/src/views.ts`), CLI `plan show`, REST `GET /plans/{id}`, Web plan page
- **Block:** C (node-plans D1)
- **Reproduction:** `exponetdb node postgres reload nod_01M5XZ84V768SYCHZKRNGJFQP2 --cluster cls_01M5J4RDBP52B715X5HDFKDN5F --no-wait --output json`, then `exponetdb plan show <pln> --output json`. Same for `restart`, `hba` (harmless and reject-all variants) and `extensions`. A `node.inspect` plan and a `node.revoke` plan do return `change`.
- **Expected:** `PlanView.change` (content and analysis) for every kind a person must judge before applying (`control-plane.md` §9.3: the hba plan shows foreign rules, the managed block before and after and the protected access; the restart plan shows what it would sever).
- **Actual:** no `change` key for `postgres.reload`, `postgres.restart`, `postgres.config.apply`, `postgres.hba.apply`, `postgres.roles.apply`, `postgres.extensions.apply`, `postgres.tls.rotate`. The approver cannot see the hba diff or `protectedAccess`, the extension steps, or that a restart would sever 9 live connections of the staging app role (visible only in the basis observation). The CLI table form never renders `change` for any non-migration kind.
- **Evidence:** `C/node-plans-report.md` (D1), `C/node-plans/raw-*.txt`.
- **Root cause:** `packages/application/src/views.ts:160-176`: the allowlist has `access.`, `registry.`, `target.`, `node.`, `migration.`, `drift.`, `backup.`, `restore.` and `postgres.roles.verifier.set`, not plain `postgres.*`; the CLI table is `apps/cli/src/output/views.ts:111-162` (`planBlocks`).
- **Proposed fix:** add `postgres.` to the allowlist with a per-kind redaction (host values stay out; names, rule lines, extension steps, disruption digests in). Render `change` in the CLI table form and the Web plan page.
- **Acceptance test:** `apps/server` integration test: for each of the seven kinds the plan view has `change.content` and, for hba, the managed block diff and `protectedAccess`; a contract test pins that no secret field (verifier, key) is present; a CLI view test renders the hba diff and the restart disruption.

#### TC-002 [P1] `node postgres config` and `node postgres roles` cannot be planned from the CLI

- **Area:** CLI `node inspect`/`node postgres *`, node plan basis observations
- **Block:** C (node-plans D2), E3/E7-related
- **Reproduction:** `exponetdb node postgres config nod_… --cluster cls_… --set work_mem=8MB --no-wait` -> `NODE_OBSERVATION_STALE`. The basis is `postgres.config.plan@2` with args `{cluster, changes: [...]}` (`packages/nodes/src/capability-plans.ts:71-125`, `basisArgs`), and `postgres.roles.inspect@2` with `{cluster, expectSettings: []}`. `exponetdb node inspect <node> --capability postgres.config.plan@2 --cluster <cls>` -> `VALIDATION_FAILED`; `--arg 'changes=[]'` arrives as the string `"[]"` and fails the contract; `--arg 'expectSettings=[]'` likewise. Credential rotation and role-verifier flows share the roles basis.
- **Expected:** the CLI offers a way to create the basis observation, or the plan command creates it itself (inspect, then plan).
- **Actual:** dead end for roles and config plans from the CLI (the REST contract accepts arrays, `packages/contracts/src/rest/nodes.ts:63`); the remediation text ("Inspect the cluster through the node, then plan again") sends the user into it. Together with the missing `pg_stat_statements` this means the performance feature cannot be enabled from the CLI.
- **Evidence:** `C/node-plans-report.md` (D2), `C/node-inspect/_summary.txt` (`postgres.roles.inspect@2` and `postgres.config.plan@2` end `VALIDATION_FAILED`).
- **Root cause:** `apps/cli/src/commands/node.ts:342-360` (`--arg` takes string values, `Object.fromEntries(pairs(...))`), `apps/cli/src/cli/planning.ts:198-205` (`pairs`), `apps/cli/src/cli/args.ts:143-147` (comma split).
- **Proposed fix:** make `node postgres config|roles|extensions|hba|reload|restart|tls` run the matching basis inspection first when none younger than 5 minutes exists (typed args built from the command's own flags/file), and add `--arg-json k=<json>` to `node inspect` for array and object values.
- **Acceptance test:** CLI process test against the fake server and a host scenario: `node postgres config --set work_mem=8MB --no-wait` against a node without a fresh observation succeeds and the plan binds a basis observation made by the command; `node inspect --capability postgres.roles.inspect@2 --arg-json 'expectSettings=[]'` returns `succeeded`.

#### TC-003 [P1] A single-quoted `DO '...'` body bypasses the parser token bound (Part A P1 no. 1)

- **Area:** `packages/postgres` parser, legacy import analysis (`serve` and worker)
- **Block:** B (Part A P1 1, `gates/9-part-a.md:988-993`)
- **Reproduction:** with `node --liftoff-only --conditions=@exponetdb/source` from the worktree root: build `DO '` + `BEGIN PERFORM 1; ... (70000 times) END` + `';` and the dollar form `DO $$ ... $$;`. `countTokens(sql, MAX_PARSE_TOKENS, 'standard', true)` is 200001 for the dollar form and **3** for `DO '...'`, **5** for `DO LANGUAGE plpgsql '...'` and `DO '...' LANGUAGE plpgsql`, **3** for `DO E'...'`; `exceedsParseWork` is false and `parsePlpgsql` returns a tree. A 4,190,016-byte `DO '...'` (below the 4 MiB per-file contract) passes `refuseOversizedLegacyFiles` and peaks at **1,114 MiB** (1,141,316 KiB maxrss, 3.0 s); the dollar form is refused at 160 MiB. In a 512 MiB cgroup (`systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0`) the single-quoted form is killed, exit 137, with no log line.
- **Expected:** the V-P1-1 bound (token budget of the body the PL/pgSQL parser reads) applies whatever the quoting; the early `422 too_large` triggers.
- **Actual:** only dollar tokens are unwrapped. One request from a caller who may run `migration import analyze` can make `serve` or the worker allocate over 1 GB (a DoS reachable by legitimate input).
- **Evidence:** `B/part-a-p1-reproductions.md` section 1 (tables, commands, scratch scripts `do-variants.mts`, `do-single.mts`).
- **Root cause:** `packages/postgres/src/parser/lexer.ts:73-92` (`countTokens`, bodies only for `dollar` tokens, line 83), `packages/postgres/src/parser/parse.ts:62-75` (`parsePlpgsql`) and `:115-125` (`exceedsParseWork`, line 119 descends only into dollar tokens); callers `packages/postgres/src/parser/cluster-global.ts:1018` and `legacy-references.ts:310`; the gate `packages/migrations-engine/src/legacy-files.ts:15`.
- **Proposed fix:** bound the decoded body: in `parsePlpgsql` take the `defname = 'as'` string value from the `DoStmt` node and count tokens on it; in `exceedsParseWork` treat the string token that follows `DO` (optionally `LANGUAGE <ident>`) or precedes `LANGUAGE` as a body, decode `''` and `E''` escapes, and recurse like for a dollar body. Do not count every string literal (a 1 MB JSON literal in an `INSERT` must stay legal).
- **Acceptance test:** in `packages/postgres/test/legacy-references.test.ts` beside the P1-1 test, for the four single-quoted shapes with a body of `ceil(MAX_PARSE_TOKENS/3)+1` times `PERFORM 1;`: `countTokens(...) > MAX_PARSE_TOKENS`, `exceedsParseWork(sql) === true`, `parsePlpgsql(sql) === undefined`, `legacyReferences(...).tooComplex === true`, `refuseOversizedLegacyFiles` throws `VALIDATION_FAILED` path `/files/0/text` code `too_large`. Negative cases: a 1,000-statement single-quoted `DO` is still parsed; a large ordinary string literal is not refused. Memory gate: the 4.19 MB `DO '...'` peaks below 200 MiB.

#### TC-004 [P1] The `search_path` strictness check is a quadratic regular expression (Part A P1 no. 3)

- **Area:** `packages/postgres` cluster-global guard, legacy import (`serve` and worker)
- **Block:** B (Part A P1 3)
- **Reproduction:** `node --conditions=@exponetdb/source regex.mts <family> <chars>` calling `guardStrictness`. Families (times in ms): `one_ws` = `SET search_path =,` + n spaces: 10,000 chars 226, 30,000 1,170, 60,000 4,394, **100,000 16,840, 200,000 35,233**, 4,194,304 TIMEOUT (>60 s); `rep_comma` = `search_path,` repeated: 100,000 808, 300,000 6,855, **1,000,000 58,979** (passes the 200,000-token gate with 166,667 tokens); `rep_noterm` and `rep_pad` similar; controls (`;`-terminated, no comma) are linear (4 ms at 1 MB). Growth is x54 to x122 for x10 (quadratic). Bun (JSC) behaves the same.
- **Expected:** linear time, an interruptible or bounded check.
- **Actual:** a 100 KB file blocks the synchronous event loop of `serve` (and of the worker on replay) for 17 s inside the request's open transaction; a 1 MB to 4 MiB file passes the contract and the token gate and blocks it for minutes to hours; recovery is a process restart. Needs a caller with the import analyze permission, hence not P0.
- **Evidence:** `B/part-a-p1-reproductions.md` section 3.
- **Root cause:** `packages/postgres/src/parser/cluster-global.ts:464`: `const CATALOG_LATER = /\bsearch_path\b[^;]*?,\s*["']?\s*pg_catalog\b/i`, used by `guardStrictness` (`:467-475`) on raw text; callers `packages/migrations-engine/src/legacy.ts:969-975` (`historyStrictness`, plan time at `:719`, worker at `:979`). Two mechanisms: lazy `[^;]*?` rescans per occurrence; two adjacent `\s*` around an optional quote.
- **Proposed fix:** (prototype validated: 0 differences in 300,000 fuzz cases; 4 MiB in 3 to 17 ms) replace by a linear scan per statement: for each `\bsearch_path\b` take the text up to the next `;`, test it once with `/,\s*(?:["']\s*)?pg_catalog\b/i`, continue after the `;`.
- **Acceptance test:** `packages/postgres/test/cluster-global.test.ts`: existing semantic cases stay; a property test (fast-check) of the new function against the old regex on short generated strings; a machine-independent scaling test per family: time(1 MiB)/time(256 KiB) below 8 and `guardStrictness([text])` at 1 MiB under 200 ms; texts with `;` after each `search_path` and one with a real `, pg_catalog` still return `'all'`.

#### TC-005 [P1] An operation in `needs_attention` holds the target's schema domain and the documented recovery cannot start (MIG-01)

- **Area:** operations engine, migration resume/verify/retry-verification
- **Block:** B (failure cases a, b, e; migration-engine report MIG-01)
- **Reproduction:** A (verify.sql that errors): apply a bundle whose `verify.sql` errors (`SELECT count(no_such_column) >= 0 AS ok FROM public.bv`): operation `needs_attention / applied / error` (`VERIFICATION_ERROR`); `retry-verification` -> `needs_attention` again (same digest); ingest a fixed verify revision, plan `migration.verify` with that revision, accept, run the worker six times: every poll answers `waiting`, the verify operation stays `queued`. B (non-transactional bundle killed): non-transactional bundle (`CREATE TABLE`, then `CREATE INDEX CONCURRENTLY` held by an older snapshot), `pg_terminate_backend` on the migrator backend: operation `needs_attention / unknown / OUTCOME_UNKNOWN`, INVALID index left, other plans refused `MIGRATION_INCOMPLETE`; `migration.resume` with cleanup is planned `allow` and accepted but stays `queued` for ever.
- **Expected:** `failure-and-recovery.md` E10 and section 2: a verify revision then `migration.verify`, or `resume`, runs and releases the target.
- **Actual:** the recovery operation waits for the domain `target:<id>:schema` held by the `needs_attention` operation. `needs_attention` leaves only to `verifying`; retry is claimable only for apply outcome `applied`/`partially_applied` and re-runs the operation's own digest; cancel covers `awaiting_approval` and `queued` only; `operation.force_release` is unbuilt. The target is blocked for every schema change (production hotfixes included) until someone edits the Control Store by hand. The existing suites miss it because their partial failure ends in `verification_failed`, which holds no domain.
- **Evidence:** `B/migration-engine-failure-cases.md` (MIG-01, items b, e; `migration-engine/evidence/b6`, `e1`..`e12`).
- **Root cause:** `packages/operations/src/states.ts:42`; `packages/operations/src/leases.ts:57-58`; `packages/application/src/views.ts:239-250`; `packages/application/src/application.ts:1983-1985` (cancel) and `:2046-2056` (retry); domain key in `kind.ts:117`, `reverify.ts:362`, `rollback.ts:362`; `exponetdb-docs/02-control-plane/operations-engine.md:356,710`.
- **Proposed fix:** (1) let a `migration.resume` or `migration.verify` plan that names the `needs_attention` operation of the same target adopt its domain, closing that operation terminally with an audit event and the same human re-authentication; or (2) build `operation.force_release` now with a `needs_attention -> failed|verification_failed` transition; (3) let `retry-verification` take an optional `revision` and cover apply outcome `unknown` for a non-transactional start through reconciliation.
- **Acceptance test:** integration (flip the evidence tests): the verify or resume operation reaches `succeeded` (index valid, `applied` event written, ledger row present), the original operation is terminal, `operations.operation_locks` holds nothing for the target and the next ordinary plan is admitted; state-machine unit test that `needs_attention` with apply `unknown` has an exit.

#### TC-006 [P1] The next verified migration silently adopts an out-of-band schema change into the drift baseline (MIG-02)

- **Area:** diagnostics drift baselines, migration apply
- **Block:** B (failure case c)
- **Reproduction:** apply a migration (baseline recorded); as superuser `GRANT ALL ON public.items TO PUBLIC` (or add a column); `runDriftCheck` -> `drifted`, finding open (ACL `critical`); plan and apply any unrelated bundle with the real kinds; `runDriftCheck` again. Plans made before the out-of-band change are `PLAN_STALE` (E23 holds); a plan made after it is `allow` with no signal.
- **Expected:** the finding stays open until `drift.accept` (security-relevant drift needs a reason; approval on production); the baseline is the old one plus the migration's change (`drift-detection.md` sections 5 and 7).
- **Actual:** `status: clean`, the finding is `resolved/cleared`, baseline `reason = migration`; `has_table_privilege('public', 'public.items', 'SELECT')` is still true.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-02 (`migration-engine/evidence/c2`, `c3`).
- **Root cause:** `packages/migrations-engine/src/executor.ts:381,398` records `fingerprintAfter` of the live schema; `kind.ts:785-795` `#recordExpected`; `packages/diagnostics/src/migration-baselines.ts:28-45` adopts a snapshot whose fingerprint equals that value without comparing the pre-migration fingerprint (`planner.ts:830` `expectedState.schemaFingerprint`) with the current baseline.
- **Proposed fix:** `MigrationBaselineStore.record` also takes the plan's pre-migration fingerprint and adopts the snapshot only when it equalled the current baseline's fingerprint, otherwise returns `drift_open` and keeps baseline and findings; optionally a plan fact `openDriftFindings` and a policy rule that asks for `drift.accept` (or an approval on prod) first.
- **Acceptance test:** drift integration: after the unrelated migration the status stays `drifted` and the finding open; without an out-of-band change it still ends `clean`.

#### TC-007 [P1] A restored ledger blocks every schema plan and `ledger.reconcile` is not built (MIG-03, E25 waiver)

- **Area:** migration engine ledger, G6 waiver E25
- **Block:** B (failure case g)
- **Reproduction:** after three migrations delete the last two from the target's ledger, events and runs and drop their tables (simulated restore); plan anything: `LEDGER_DIVERGENCE {missing: [m2, m3]}`; `migrationStatus.mirror.inSync` false; the drift check reports 4 removed objects; `ledger_state.divergent` stays `false` until a worker write.
- **Expected:** `failure-and-recovery.md` E25: the mirror is reconciled and the lost migrations show as pending again.
- **Actual:** detection works; nothing can unblock the target; the waiver "before Wave 9 closes" (`PRE-WAVE-11-REVIEW.md:635`) is not closed (the review notes the placement move to a restored cluster is also planned only).
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-03, item (g); `migration-engine/evidence/g/e25`.
- **Root cause:** `packages/migrations-engine/src/divergence.ts:110-125`; `ledger.reconcile` is planned (`gates/6.md:370`).
- **Proposed fix:** build `ledger.reconcile` (explicit operator plan, human re-authentication, audit) that rewrites the target's mirror rows from the live ledger when the identity marker and the cluster identity match, and re-runs the baseline verification; update the E25 row of `gates/6.md`.
- **Acceptance test:** integration: after the simulated restore, `ledger.reconcile` makes the lost migration plannable and appliable; a mismatching identity marker refuses it.

#### TC-008 [P1] One stored bundle with an unknown dependency blocks planning for the whole project (MIG-04, seen on the live installation)

- **Area:** migration bundle ingest and planner
- **Block:** B/C (failure case j; `C/live-migration-attempt.md`)
- **Reproduction:** ingest (`migration.bundle.ingest`, `packages/application/src/migrations.ts:99-108`) a bundle with `dependsOn: [<unknown ULID>]` (status `stored`), then plan an unrelated bundle on any target of the project: `MIGRATION_DEPENDENCY_UNKNOWN`, on every target. On the live installation `exponetdb migration plan --target reosa/platform/scratch` with a one-bundle project (own `dependsOn: []`) fails the same way.
- **Expected:** the unrelated plan works; a dangling edge is refused at ingest or confined to the bundle that has it.
- **Actual:** every plan of the project fails; the workaround is to ingest a corrected revision of the same id (`rewritten_unapplied`).
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-04 (`j3.unrelated_plan_after_poison`, `j3.other_target_same_project`); `C/live-migration-attempt.md`.
- **Root cause:** `packages/migrations-engine/src/store.ts:149` `ingestBundles` has no graph check; `planner.ts:295-298` puts every stored bundle's edges into the graph; `planner.ts:311-312` fails on the first dangling edge.
- **Proposed fix:** restrict the graph to the selected ids, their ancestors and the ledger, report dangling stored edges as a stream finding, and validate `dependsOn` against stream plus submission at ingest.
- **Acceptance test:** ingest a dangling bundle, then an unrelated plan succeeds; planning the dangling bundle itself names its missing ids.

#### TC-009 [P1] `latest` and `older` restore drills always fail on a real host (D-01)

- **Area:** restore drills, node helper `restore.execute`, Control Plane drill planning
- **Block:** D (backup/restore end to end, M-6, T-NODE-5)
- **Reproduction:** on a real systemd host with pgBackRest 2.60.0 (`D/backup-restore-e2e/host-tests/zz-backup-e2e.host.test.ts` B4, or `scripts/t10_target.sh`): adopt a repository, verify the newest backup, `POST /clusters/{id}/drills {selection:{kind:"latest"}}`, apply. Helper level: `restore.execute` with target `{label:"<newest>", time:null, lsn:null, timeline:1}`.
- **Expected:** the drill restores the newest backup, replays the WAL to the end of the archive, passes, is discarded, RTO is measured.
- **Actual:** `restore.execute` fails in 0.05 s: `ERROR: [031]: option 'target-timeline' not valid without option 'type' in ('default','lsn','name','standby','time','xid')`, exit 31; the operation ends `verification_failed`, the drill `failed`. Without the timeline (label only) the node builds `--type=immediate`, which stops at the end of the backup (reached `1/5C000208`, archive end `1/62...`), so the Control Plane's `replayShort` check (`kinds.ts:1358`) would fail it as well. Only `time` targets (`pitr_random`, `pitr`) get past this step. No drill passed in the campaign, so no RTO was measured through the Control Plane.
- **Evidence:** `D/backup-restore-e2e.md` D-01; `D/backup-restore-e2e/logs/b-evidence-run3.log`, `logs/t10-restore-target-semantics.log`.
- **Root cause:** `agent/node/internal/helper/restore.go:70-97` (`restoreTypeArgs`: a label alone means `--type=immediate` and `--target-timeline` is appended for any type) and `packages/backups/src/kinds.ts:1088-1101` (`restoreTarget` sends the backup label plus `timeline` for `latest` and `older`, so the node cannot tell "this backup, replay to the end").
- **Proposed fix:** for `latest` send no `time` and use `--type=default --set=<label>` (never `immediate` for a drill that must reach `walTo`); append `--target-timeline` only for `default`, `time` and `lsn`; keep `immediate` as an explicit selection.
- **Acceptance test:** a `pglab` test that runs the `restoreTypeArgs` outputs against real pgBackRest 2.60 for {default, label, label plus timeline, time, lsn} x {timeline set, unset}; a host scenario in which drills `latest`, `older` and `pitr_random` end `passed` with `measuredRtoSeconds` set. Add `-tags pglab` to CI (see the CI wiring finding).

#### TC-010 [P1] `amcheck: not_run` fails every drill unless the extension exists in every restored database (D-02)

- **Area:** drill verification (`packages/backups`), node `restore.verify`
- **Block:** D
- **Reproduction:** `zz-backup-e2e2.host.test.ts` / `zz-backup-e2e3.host.test.ts` C2: any drill whose restored cluster has a database without `amcheck` (a template database, an application database, or any backup older than the extension). Even after installing the extension everywhere, the scratch of an older backup lacks it.
- **Expected:** RB-08 says "amcheck where installed"; a missing extension is not a failed restore.
- **Actual:** the node returns `amcheck: not_run` ("497 indexes checked in 3 of 5 databases; amcheck is missing in the others"); the Control Plane requires every configured check to be `passed`, so the drill ends `VERIFICATION_FAILED` although `recovery_target_reached` and the probes passed.
- **Evidence:** `D/backup-restore-e2e.md` D-02; `D/backup-restore-e2e/logs/b2-evidence-run1.log`, `logs/b3-evidence.log`.
- **Root cause:** `packages/backups/src/plans.ts:536` always lists `amcheck`; `packages/backups/src/kinds.ts:1362-1367` (`allPassed`); node `agent/node/internal/helper/restore.go:711` returns `not_run` when any database lacks the extension.
- **Proposed fix:** list `amcheck` only when the cluster reports it installed everywhere, or treat `not_run` for a check the node reports unavailable as "not applicable" and surface a warning (drill `passed` with reduced assurance), or let the node create the extension in the disposable scratch cluster with the shipped binaries (owner decision on strictness).
- **Acceptance test:** a drill on a cluster with one database lacking the extension ends `passed` with an `amcheck` note (or, if policy wants it strict, the plan is refused up front with a named reason); an integration test with the real node check output.

#### TC-011 [P1] `backup.verify` never detects corruption (D-03)

- **Area:** backup verification (`pgbackrest verify`), `restore.source-verified`
- **Block:** D (M-4)
- **Reproduction:** flip bytes in one archived WAL segment (`scripts/t7_corrupt.sh`); run `backup.verify` (helper) or `POST /clusters/{id}/backups/{id}/verify` (REST).
- **Expected:** the run fails or reports `verifyErrors > 0`; a verified backup must not rest on a corrupt archive.
- **Actual:** the run `succeeded`, `verifyErrors 0`, the operation `succeeded / passed`, although the engine output says `invalid result ... Data corruption detected`, `status: error` (`pgbackrest verify` exits 0 even when it reports errors).
- **Evidence:** `D/backup-restore-e2e.md` D-03; `D/backup-restore-e2e/logs/b-evidence-run3.log` (B7).
- **Root cause:** `agent/node/internal/helper/engine.go:448-466` (`pgbrVerify`): `VerifyErrors = 0` whenever the exit code is 0.
- **Proposed fix:** parse the text output (`status: error`, `invalid result`, `missing`, per-backup `status`) and set `verifyErrors` to the count; fail the run when greater than 0.
- **Acceptance test:** a `pglab` test with a corrupted segment and one with a deleted segment: run state `failed` (or `verifyErrors > 0`) and the Control Plane verification `failed`; a clean repository still passes.

#### TC-012 [P1] Logical backups to a local (posix) restic repository cannot run under the shipped sandbox (D-06)

- **Area:** node helper backup runs (restic, `pg_dump`), units
- **Block:** D (M-5)
- **Reproduction:** provision `/etc/exponetdb-node/repositories/<id>/{repository,password,mode}` with a directory repository, `backup.run` `kind logical` (`scripts/t8_restic.sh`).
- **Expected:** dump and snapshot succeed (M-5 setup is a restic repository directory).
- **Actual:** after 234 s of lock retries the run fails with `open /var/lib/restic-repo/locks/..: read-only file system`; `restic check` (`backup.verify`) fails likewise. The lab test runs the engines unsandboxed, so it never saw this.
- **Evidence:** `D/backup-restore-e2e.md` D-06; `D/backup-restore-e2e/logs/t8-restic-logical.log`.
- **Root cause:** `agent/node/internal/helper/ops_backup.go:569-572` adds repository paths to `ReadWritePaths` only for pgBackRest; for restic `ProtectSystem=strict` makes a local repository read-only.
- **Proposed fix:** add the local repository path (from the `repository` file, when it is a path) to the unit's writable paths (`spec.Optional`) or refuse local restic repositories at start with a clear code; cut the lock retry (`--retry-lock` or a short timeout).
- **Acceptance test:** a host scenario: a logical run to a directory repository succeeds, the snapshot is listed and `restic check` passes.

#### TC-013 [P1] `POST /clusters/{id}/drills/offline` returns HTTP 500 (D-09)

- **Area:** REST drills offline record (C-35 attestation, PG-14)
- **Block:** D (T-C35-1)
- **Reproduction:** any valid request after downloading the runbook (`zz-backup-e2e3.host.test.ts` C3; request ids `req_01M5ZMQ3WT4Z5NJPXXJEVS1XDG`, `req_01M5ZMR5R6QNHF3RSABRFSA5CV`); the roles running and stopped; a wrong digest correctly gives 422.
- **Expected:** `201` with the attested drill (listed in `GET /drills` as `offline_runbook / attested`, audited).
- **Actual:** `500 INTERNAL`. The C-35 offline restore itself works (27 to 32 s, 370 of 370 rows, a non-empty `TARGET_DIR` is refused), so the attestation path is the only broken step.
- **Evidence:** `D/backup-restore-e2e.md` D-09 (cause traced, not confirmed by the Postgres error; the serve logger wrote nothing and the scenario database was dropped).
- **Root cause:** (suspected) `packages/application/src/backups.ts:614-630` inserts into `backups.drills` with the serve store, but `packages/control-store/migrations/01M5X840BK55NGFGQ5G3Z1C5NH_backup-catalog/up.sql:584-585` grants `INSERT` on `backups.drills` to `exdb_worker` only (serve has `SELECT`). The CLI/Web tests mock the call and `http-backups.int.test.ts` never calls it.
- **Proposed fix:** grant `INSERT` to `exdb_serve` through a guarded additive bundle (the backup-catalog bundle is frozen), or write the attestation as an operation through the worker; log the cause of every 5xx in serve.
- **Acceptance test:** a REST integration test with the real role set: record-offline returns 201, appears in `GET /drills` as `offline_runbook / attested`, the audit row exists; a unit test that a serve-side 5xx logs its cause.

### P2 (34)

#### TC-014 [P2] sql_query refuses unqualified relation names and system views with a misleading construct error (E3)

- **Area:** MCP/REST read lane, SQL admission (`sql_query`, `sql_explain`)
- **Block:** C, E3
- **Reproduction:** MCP `sql_query` on `reosa/platform/scratch`: `select count(*) from pg_stat_activity` and `select name, setting from pg_settings where name='max_connections'` and `select count(*) as n from tenants` and `select count(*) from pg_class` each answer `QUERY_CONSTRUCT_UNSUPPORTED` with `details.construct` set to the bare relation name. The same statements with a schema qualifier (`pg_catalog.pg_stat_activity`, `pg_catalog.pg_settings`, `public.tenants`) succeed (17 sessions, `max_connections` 150, 0 rows). `select current_user` alone also succeeds, so the earlier "tenants plus current_user" report is really "unqualified name".
- **Expected:** either unqualified names resolve against the target's fixed `search_path` (documented), or the refusal says "qualify the relation with its schema" and names the schema to use; connection counts must be readable (the health model has `connections_high`).
- **Actual:** the error calls an ordinary table "a construct the admission cannot classify as free of side effects". An agent cannot discover that a schema qualifier is the fix; it concludes `pg_stat_activity` is forbidden and that connection counts cannot be read.
- **Evidence:** `C/live-mcp-reads.md` (this campaign, section E3)
- **Root cause:** the admission in `packages/postgres/src/sql-admission*` (relation resolution rejects unqualified names) and the error mapping that puts the relation into `details.construct`; the catalog message is in `packages/contracts/src/errors.ts` (`QUERY_CONSTRUCT_UNSUPPORTED`). Locate with `grep -rn QUERY_CONSTRUCT_UNSUPPORTED packages`.
- **Proposed fix:** resolve unqualified names with the session's pinned `search_path` (`pg_catalog` first, then the project's managed schemas) before classification, or return a typed refusal with `reason: unqualified_relation` and `remediation: "write schema.name, for example pg_catalog.pg_stat_activity"`. Document that system views in `pg_catalog` are readable when qualified.
- **Acceptance test:** integration test against PostgreSQL 17: `select count(*) from pg_stat_activity` is either answered or refused with `reason: unqualified_relation` and a remediation that names the qualified form; `pg_catalog.pg_stat_activity` and `public.<table>` keep passing; a table named like a system view in another schema is not confused with it.

#### TC-015 [P2] query_stats is unavailable on every registered target and its error names the wrong cause

- **Area:** diagnostics (`query_stats`, `diagnose query-stats`), error catalog
- **Block:** C
- **Reproduction:** MCP `query_stats` on `reosa/platform/scratch` and on `reosa/platform/staging`, and `exponetdb diagnose query-stats` on both: `CAPABILITY_UNAVAILABLE` "The node does not report this capability version, or the cluster is external." `pg_catalog.pg_extension` on both targets lists only `pg_trgm`, `plpgsql`, `vector`: `pg_stat_statements` is not installed. The cluster is `management_mode=agent` with an active node, so the message is wrong.
- **Expected:** the refusal says the extension `pg_stat_statements` is missing (or not preloaded) and what to do (a `shared_preload_libraries` change plus extension create, planned through node plans).
- **Actual:** the message blames the node or an external cluster. Combined with TC "config and roles cannot be planned from the CLI" the operator has no path to enable the feature from the CLI.
- **Evidence:** `C/live-mcp-reads.md` (section query_stats); code path read in `packages/diagnostics/src/statements.ts:201-214` (outcome `extension_missing`) and `:787-789` (throws plain `CAPABILITY_UNAVAILABLE`).
- **Root cause:** `packages/diagnostics/src/statements.ts:787-789` maps `extension_missing` to the generic `CAPABILITY_UNAVAILABLE` without `details`; the generic message is in `packages/contracts/src/errors.ts`.
- **Proposed fix:** throw `CAPABILITY_UNAVAILABLE` with `details: { reason: 'extension_missing', extension: 'pg_stat_statements' }` and a catalog remediation that reads "install pg_stat_statements (shared_preload_libraries and CREATE EXTENSION) on the target, then wait for the next sample"; show the same in the Web performance page and CLI text output.
- **Acceptance test:** unit test of the `getQueryStats` read with a last sample `extension_missing`: the error carries `details.reason = 'extension_missing'`; CLI text output prints the remediation; REST contract test pins the shape.

#### TC-016 [P2] `node show` and the node view always say "No clusters reported" (E2)

- **Area:** node views (`packages/nodes`), CLI, REST `GET /nodes/{id}`, Web node page
- **Block:** C, E2
- **Reproduction:** on the live node: `exponetdb node show nod_01M5XZ84V768SYCHZKRNGJFQP2` prints "No clusters reported." and `--output json` has `clusters: []`; MCP `node_status` also `clusters: []`. Reproduced with a real agent on a disposable systemd host (`E/e2-e6-live-host-run.log`): `nodes.nodes.clusters` holds `[{"localName":"17/exdbnode","port":55417,"running":true,"version":"17.11","systemIdentifier":"7701448509665702082",...}]` while `nodes.nodes.heartbeat->'clusters'` is `[]`, and REST `GET /api/v1/nodes/{id}` returns `clusters: []`.
- **Expected:** the node view lists the clusters the node serves with running state, pending restart and the TLS certificate expiry (the CLI table has columns for them).
- **Actual:** never any cluster; the columns `RESTART PENDING` and `TLS UNTIL` can never show a value; `clusterId` is also hard-coded `null` in the view.
- **Evidence:** `E/e2-e6-live-host-run.log`; `C/node-plans-report.md` (D10).
- **Root cause:** `packages/nodes/src/views.ts:105` reads `heartbeat['clusters']`, but the agent's heartbeat sends an empty list by construction (`agent/node/internal/agent/agent.go:510`, `Clusters: []protocol.HeartbeatRequestCluster{}`); the clusters arrive in the hello and are stored in the `clusters` column (`packages/nodes/src/mapping.ts:77` reads that column for planning). `clusterId: null` is set at `views.ts:111-119`.
- **Proposed fix:** build the view from the stored `clusters` column (hello) merged with the heartbeat's per-cluster state, map `systemIdentifier` to the registry cluster id for `clusterId`, or have the agent send its clusters in the heartbeat (a protocol-minor, additive change with a contract test).
- **Acceptance test:** integration test in `packages/nodes` (or a host scenario): after enrollment, `GET /nodes/{id}` returns one cluster with `localName`, `running: true` and a mapped `clusterId`; CLI `node show` renders it; restart-pending toggles after a pending-restart parameter is set.

#### TC-017 [P2] Read-classified diagnostics and advisor actions persist data and flood the findings counters (OD-57 in practice)

- **Area:** diagnostics, findings, MCP `advisors_run`/`drift_check`, CLI `diagnose advisors`, Web overview
- **Block:** C
- **Reproduction:** `exponetdb diagnose advisors reosa/platform/staging` (catalogued `read`) raised the open findings of staging from 0 to 215; `advisors_run` on scratch added 228 (`rls_enabled_without_policy` 100, `unindexed_foreign_key` 100, ...) and wrote an `advisor.run` audit event; `drift_check` on scratch reports `drifted: 13741` with 500 findings returned (`truncated: true`) all `critical` `object_added` because the rehearsal copy has no ledger and an empty baseline. MCP responses were 131,395 and 229,168 characters.
- **Expected:** read-classified calls do not change counters that the owner reads as risk; a rehearsal copy without a baseline does not raise 13,741 critical findings; tool results are capped.
- **Actual:** the Overview shows 520 critical findings of 14,184 of which 518 are scratch drift noise, one is a roll-up that counts the others again, and exactly one is real; the owner cannot see real findings. Responses of 130 to 230 KB cannot be consumed by an agent.
- **Evidence:** `C/live-mcp-reads.md`, `C/cli-read-sweep.md` (D2), `C/web-audit.md` (W-03).
- **Root cause:** advisor and drift runs record findings under a read scope (OD-57 open); drift on a target without a baseline reports every object as `object_added` (`packages/diagnostics/src/drift*`); no output cap in the MCP tool results.
- **Proposed fix:** (owner decision OD-57) classify `advisors_run` and `drift_check` as record actions with their own scope and rate limit; do not run a drift comparison without a baseline (report `no_baseline` once); aggregate `drift_open` roll-ups out of severity counters; cap MCP results (for example 64 KB with a cursor) and group repeated finding codes.
- **Acceptance test:** drift on a target with an empty baseline yields one `no_baseline` finding, not N `object_added`; the fleet critical count excludes roll-ups; `advisors_run` output is below the cap with a `nextCursor`; scope test: a read-only grant is refused for the recording actions once OD-57 is decided.

#### TC-018 [P2] A pg_hba block that rejects everything is planned and allowed; there is no plan-time protectedAccess check

- **Area:** node plan `postgres.hba.apply`
- **Block:** C (node-plans D3)
- **Reproduction:** `exponetdb node postgres hba nod_… --cluster cls_… --file hba-cut.json --no-wait` with `managedRules` = `hostssl all all <all> reject` plus `local all all reject` and `protectedAccess: []` -> plan `class high, decision allow, requirements [], approvals 0/0`, "Next: plan apply … --wait".
- **Expected:** (brief and `acceptance-gates`) a plan that would cut ExponetDB off (the agent's `exponetdb_node` socket role and the control plane's own login) is refused at plan time.
- **Actual:** the lock-out protection exists at apply time inside the agent (`control-plane.md` §9.6; host scenario `hba.host.test.ts` "refuses a block that would lock the agent out, and puts the file back" passes); at plan time nothing simulates the rules against the derived access, and `protectedAccess: []` is accepted.
- **Evidence:** `C/node-plans-report.md` (D3); `D/ci-replica` host scenario `host-hba rc=0`.
- **Root cause:** `packages/nodes/src/capability-plans.ts:723-733` merges requested and derived protected access but never matches rules against it; the analysis (`:520-528`) records counts only.
- **Proposed fix:** evaluate the managed rules first-match against the derived access (`ownNetworkAccess`, `:618-655`) and refuse with a typed `HBA_WOULD_LOCK_OUT` naming the access; keep the agent-side check as the second line.
- **Acceptance test:** unit test of the planner: a reject-all block is refused with the named protected access; a block that keeps the access passes; a replayed stale plan still fails at apply (host scenario).

#### TC-019 [P2] `node revoke` and `node decommission` plans state no effect, no tier and no requirements

- **Area:** node lifecycle plans
- **Block:** C (node-plans D4)
- **Reproduction:** `exponetdb node revoke nod_… --no-wait --output json` (same for decommission).
- **Expected:** content/analysis state that the gateway refuses the node at its next request, waiting jobs are canceled, the server loses management, what depends on it (clusters served, open operations, other active plans); the tier of the node's server; a re-authentication requirement listed in `requirements`.
- **Actual:** `change.content = {nodeId}`, `change.analysis = null`, `subject.tier = null` ("Tier: unknown"), `decision allow`, `requirements []`; revoke and decommission share the same `contentChecksum`. The node is the only agent of a real staging host. The re-authentication they need (withdrawal gives `REAUTH_REQUIRED`) is not announced.
- **Evidence:** `C/node-plans-report.md` (D4).
- **Root cause:** `packages/nodes/src/plans.ts:28-58` (`store` passes `subject: {}` to the policy and no `analysis` to `createPlan`) and `:133-150` (`planStateChange`).
- **Proposed fix:** pass the server's tier into the subject, add an impact analysis (clusters, open jobs, open operations, active plans), list `reauthentication` in `requirements`, give revoke and decommission different content checksums.
- **Acceptance test:** integration test: the revoke plan has `subject.tier`, `analysis.impact` with counts, and `requirements` containing the re-auth requirement; the two kinds differ in `contentChecksum`.

#### TC-020 [P2] A user with `nodes.plan` cannot withdraw their own node plans

- **Area:** auth scopes, `plan withdraw`
- **Block:** C (node-plans D5), E11-adjacent
- **Reproduction:** `exponetdb plan withdraw pln_01M5ZF4EQW8F0GGEAV93NKAA98` (a node reload plan made by the same identity) -> `INSUFFICIENT_SCOPE` (needs `nodes.operate:nonprod`; the CLI prints a `login --scope` line); withdrawing a `node.revoke` plan -> `REAUTH_REQUIRED` ("A fresh passkey...").
- **Expected:** the person who made a plan can withdraw it with the scope that made it; withdrawing is the safe direction.
- **Actual:** plans stay active until expiry (15 or 30 minutes) and cannot be cleaned up; a destructive revoke plan needs a stronger proof to withdraw than to create.
- **Evidence:** `C/node-plans-report.md` (D5); lead check on two plans.
- **Root cause:** the scope of the `plan.withdraw` action versus `node.plan` (`packages/contracts/src/actions.ts`, node plan kinds use `nodes.operate`, `tieredScope` around `:1088-1170`).
- **Proposed fix:** let the plan's own creator withdraw under the scope that created it and without a fresh passkey (owner decision if policy wants otherwise).
- **Acceptance test:** auth integration test: an identity holding only `nodes.plan` withdraws its own `postgres.reload` and `node.revoke` plans (204) and cannot withdraw another identity's plan (403).

#### TC-021 [P2] `survivingExpectations` over a whole legacy chain is quadratic and blocks the worker; memory is linear but unbounded across files (Part A P1 no. 2)

- **Area:** `packages/migrations-engine/src/legacy.ts` chain analysis, `packages/postgres/src/parser/migration.ts`
- **Block:** B (Part A P1 2)
- **Reproduction:** `node --liftoff-only --expose-gc --conditions=@exponetdb/source mem.mts uniform <files>` (fixture shape `largeLegacyHistory`, about 1.3 KB per file). Peak RSS 120 / 191 / 310 / 507+ MiB for 100 / 1,000 / 5,000 / 20,000 files (retained heap about 14.7 KiB per file, about 11 times the SQL text; linear). `survivingExpectations` step: **50 ms, 3.1 s, 196 s** for 100, 1,000, 5,000 files (x62 for x10); 20,000 files not finished in 300 s (extrapolated about 31 minutes). At the legal contract maximum (9 files of 190,000 tokens, 6.87 MB) peak RSS is 565 MiB unconstrained and 387 MiB under a 512 MiB cgroup; the retained heap is 226 MiB against the 268 MiB V8 limit; the chain step is about 21 minutes extrapolated. The legacy ledger read (`legacy.ts:777-779`) has no `LIMIT`: 289 MiB at 26 MB of statements (linear).
- **Expected:** the record's P1: memory does not add up across files beyond a stated budget; the chain step is linear.
- **Actual:** no OOM was demonstrated inside the legal limits (I rate memory and CPU P2); the per-file token bound limits one parse, not the sum; the quadratic step runs synchronously in the worker (P1 if the operation lease cannot be renewed while the loop is blocked: not tested). 1,000 realistic files (inside the contract) take 5.5 s and 191 MiB.
- **Evidence:** `B/part-a-p1-reproductions.md` section 2.
- **Root cause:** `packages/postgres/src/parser/migration.ts:2333-2350` (`survivingExpectations`, `touched.slice(i + 1)` per expectation) and `legacy.ts:951` (`survivors.filter` per file); `analyzeChain` `legacy.ts:923-967` copies every statement into one chain; `replaysOf` (defined `legacy.ts:979`) keeps a `FileReplay` per file.
- **Proposed fix:** (1) a per-request total token budget in `refuseOversizedLegacyFiles` (for example 600,000 tokens over all files); (2) keep per-file compact facts only, drop `segments`/`statements` after replay; (3) make `survivingExpectations` O(E+S) with one reverse pass building `Map<key, lastStatementIndex>`; group survivors by file once; (4) a byte cap or cursor on the legacy ledger read, failing to `unreadable`.
- **Acceptance test:** unit: `survivingExpectations` on 30,000 generated statements finishes under 1 s and equals the old implementation on random small inputs (property test); engine test: 9 files of 190,000 tokens refused or analysed within a stated budget and a request over the total budget is `422 too_large`; measurement gate (extend `packages/migrations-engine/scripts/measure-analyze-memory.ts`, 9 dense files): peak RSS below 350 MiB in a 512 MiB cgroup, steps below 10 s.

#### TC-022 [P2] `MIGRATION_DEPENDENCY_UNKNOWN` carries no id (MIG-05)

- **Area:** migration planner errors
- **Block:** B (failure case j)
- **Reproduction:** `planMigrationApply` with `dependsOn: [<unknown ULID>]`; live: `exponetdb migration plan ... --output json` shows `error: {code, message}` only.
- **Expected:** the node and the missing ids, as `stream.ts:225-232` returns them.
- **Actual:** `details` undefined; message "dependsOn names an id that is not in the project stream." For a project with 12 stored bundles the operator cannot tell which one.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-05; `C/live-migration-attempt.md`.
- **Root cause:** `packages/migrations-engine/src/planner.ts:162-163` and the default branch `:178-179` drop `failure.from` / `failure.missing`.
- **Proposed fix:** `new MigrationError('MIGRATION_DEPENDENCY_UNKNOWN', { migrationId: failure.from, missing: failure.missing.slice(0, 256) })` with a schema-checked catalog entry; the CLI prints them.
- **Acceptance test:** unit test of `graphRefusal` and a planner integration test asserting the ghost id in `details`; CLI text test.

#### TC-023 [P2] E16 `hotfix_without_evidence` has no detection (MIG-06, G6 waiver)

- **Area:** migration engine findings, G6 waiver E16
- **Block:** B (failure case g)
- **Reproduction:** simulate the post-break-glass state (a migration applied on production that staging lacks, planned with only the registry rules): findings of both targets none; drift of both `clean`; `migrationStatus` lists it as applied on prod only with no marker; `grep -rn 'hotfix_without_evidence' packages apps agent` finds no source match.
- **Expected:** an open finding on the production target until the same migration is applied and verified on staging (`staging-production-policy.md:155`).
- **Actual:** nothing marks the hotfix. The review adds that E16 is reachable: a break-glass grant on `migration.staging-evidence` activates once a notification channel is set (`apps/server/test/http-migrations.int.test.ts:710-725`) and nothing marks the prod ledger row afterwards (`content.ts:96`). The live staging target already carries 555 `legacy_import` ledger rows; whether the OD-7a staging import counts as "real REOSA data" (waiver expiry "before the first import of real REOSA data (Wave 10)", `PRE-WAVE-11-REVIEW.md:636`) is an owner decision.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-06; `B/review-items-static-audit.md` (E16/E18 row).
- **Root cause:** not implemented; the drift check implements only kind C (`packages/diagnostics/src/drift.ts:329-343`).
- **Proposed fix:** at the ledger mirror write (`kind.ts` reconcile path, `records.ts` `writeMirror`) compare each production row with the evidence target's mirror and record `hotfix_without_evidence` (kind drift, severity warning) resolved when the evidence target has the same checksum with a passed verification.
- **Acceptance test:** integration: one open finding on prod after the simulated hotfix, cleared after the apply on staging; `gates/6.md` waiver table updated.

#### TC-024 [P2] E18 `applied_not_in_source` has no detection (MIG-07, G6 waiver)

- **Area:** migration engine findings, G6 waiver E18
- **Block:** B (failure case g)
- **Reproduction:** a plan whose submitted source omits an applied migration: `allow`, no lint entry or finding; with the bundle revisions deleted from the Control Store: status lists the row applied, verify plan `NOT_FOUND`, findings none, drift `clean`.
- **Expected:** finding `applied_not_in_source` (`failure-and-recovery.md`, `drift-detection.md:37`).
- **Actual:** none; the server never sees the repository except through a plan's `bundles`.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-07.
- **Root cause:** not implemented (no source match).
- **Proposed fix:** a lint or stream finding when the submitted source set (CLI `migration lint`, a plan's `bundles`) omits an id present in the target's ledger and not reverted.
- **Acceptance test:** a plan whose source omits `x` yields the finding; the full set yields none.

#### TC-025 [P2] The ledger comparison is shallow and only the apply planner runs it (MIG-08)

- **Area:** migration ledger guards
- **Block:** B (failure case i)
- **Reproduction:** as the target superuser with `session_replication_role = replica`: set `reverted_at` by hand -> apply plan `MIGRATION_DEPENDENCY_MISSING` (not divergence); change `fingerprint_after` -> apply plan created; checksum change or row deletion -> `LEDGER_DIVERGENCE` for apply but `NOT_FOUND`/`no_down_sql` for verify and rollback planners; a hand-written `nontx_started` event blocks every schema plan with `MIGRATION_INCOMPLETE` and `migration.resume` answers `NOT_FOUND`.
- **Expected:** any hand change of a ledger row or event is `LEDGER_DIVERGENCE` for every planner (`ledger.md` section 5).
- **Actual:** see table in the evidence; E-1 deferred-trigger chains (also at and past the bound) are correctly refused.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-08 and section (i).
- **Root cause:** `packages/migrations-engine/src/divergence.ts:35-55` (existence, checksum, operation id only); `planner.ts:368` (only caller besides `reads.ts:191`); `planner.ts:184-189`.
- **Proposed fix:** compare `reverted_at`/`reverted_by_op`, `fingerprint_after`, `transactional` and the event count per migration; call `assertLedgerAgrees` in `planMigrationVerify`, `planMigrationRollback`, `planMigrationResume`.
- **Acceptance test:** each tamper row yields `LEDGER_DIVERGENCE` in all four planners.

#### TC-026 [P2] CI never compiles the `pglab` Go tests nor runs `runbook.lab.test.ts`; the real-engine proofs of Wave 9 Part B are manual

- **Area:** CI, `agent/node/internal/helper`, `packages/backups`
- **Block:** B (static audit defects 1 and 2; gate-map G9.3/G9.4)
- **Reproduction:** `grep -n 'pglab' .github/workflows/ci.yml` finds nothing; `packages/backups/package.json:19-24` has no `test:lab` script; `vitest.shared.ts` excludes `*.lab.test.ts`; `packages/backups/test/runbook.lab.test.ts` throws instead of skipping (`:67-73`). On a disposable systemd host this campaign ran `go test -tags pglab -count=1 -run TestPglab -v ./internal/helper/` as root (PASS, 37.5 s, real pgBackRest 2.60.0, restic, PostgreSQL 17; `D/ci-replica` and the server summary `go-pglab rc=0`).
- **Expected:** every artifact that the W9-04 table and `gates/9.md` point the owner at runs in a CI job (or the exact manual command is wired into `verify` behind a flag) so a compile break is seen.
- **Actual:** `pglab_test.go` (the only proof of the C-2 publisher-slot neutralization `:468-651`, the `noWorkers` gate `restore.go:437-456`, T-NODE-5, M-4, M-5 local evidence) and `runbook.lab.test.ts` (the only artifact for A-2/C-1 and C-5, the C-35 offline restore) are never run by CI; `tlspair_pgit_test.go` is vet-only (`ci.yml:451`). Four of the five Go artifacts the W9-04 table labels "(pglab)" (B-2, B-3, A-9, C-2/B-4) are untagged fake-exec unit tests.
- **Evidence:** `B/review-items-static-audit.md` (defects 1, 2 and section 6); `D/ci-replica` and the server logs.
- **Root cause:** missing CI wiring (`.github/workflows/ci.yml:378-386` go job; no job for the lab).
- **Proposed fix:** add a CI job on `ubuntu-24.04` with root that installs PGDG PostgreSQL 17, pgBackRest >= 2.59.3 and restic and runs `go test -tags pglab ./internal/helper -run TestPglab` and `bunx vitest run --config vitest.lab.config.ts` in `packages/backups`; add `test:lab` to `packages/backups/package.json`; run `go vet -tags pglab ./...` in the go job; correct the "(pglab)" labels in W9-04.
- **Acceptance test:** the new CI job is green on the PR; removing a symbol used by `pglab_test.go` breaks `go vet -tags pglab`; `bun run --cwd packages/backups test:lab` exists.

#### TC-027 [P2] Regression artifacts missing or weak for Wave 9 Part B security fixes (review W9-04)

- **Area:** tests for backup/restore authorization and verification
- **Block:** B (static audit defects 3 to 6; 6 ARTIFACT-MISSING, 4 ARTIFACT-WEAK of 35 rows)
- **Reproduction:** read each row's cited artifact; all fixes are present in the code, none of the rows below is covered by a test that names it.
  - A-7/B-7 (restic/pg_dump verify refused): fix `packages/backups/src/plans.ts:749`; cited `http-backups.int.test.ts:489` covers the `owned` refusal only; no TypeScript test creates a restic or pg_dump repository; node side still has the 1/10 subset check (`agent/node/internal/helper/engine.go:680`).
  - F-1 (plan views without repository location): `packages/application/src/views.ts:46-57,173-177`. F-2 (declared prod tier): `packages/registry/src/subjects.ts:142-143`, `packages/backups/src/plans.ts:56-60`. A-10 (engine floor): `plans.ts:331`. A-11/F-3 (runbook needs the location permission): `packages/application/src/backups.ts:371` (the only runbook call in a test is made by the owner, `http-backups.int.test.ts:679`; `POST /clusters/{id}/drills/offline` has no server test). C-6/C-7/C-9/C-10/C-11 (apply re-checks WAL end, archived point, backup by id, target placement and generation, runbook digest, maintenance exclusivity): `kinds.ts:1144,1160,1484`, `selection.ts:135`, `plans.ts:437-505`, `application/src/backups.ts:597-600`.
  - ARTIFACT-WEAK: A-4 second half (`kinds.ts:1356-1374` `replayShort`; the simulated node always answers `0/9000000`, `http-backups.int.test.ts:185`), C-2/B-4 (the named `TestScratchStartNeutralizesTheRestoredServer` `backup_test.go:1424` is untagged fake-exec; "the run fails unless no worker runs" `restore.go:202,239,455` has no negative test), C-4, E-5.
- **Expected:** each Critical/High/Medium fix has a named regression test that fails without the fix (the repository's own rule).
- **Actual:** see list; a permission denial for the runbook or a stale WAL end is never exercised.
- **Evidence:** `B/review-items-static-audit.md` sections 2 to 4.
- **Root cause:** the review's "regression test pending" rows were never closed.
- **Proposed fix:** write the negative tests: read a backup plan as a holder of only `backups.read` (no location field); plan a drill on a cluster declared prod with only staging targets under a nonprod grant; plan a run on an engine below 2.59.3; request the runbook without `registry.manage`; replay a drill with a stale WAL end, a moved target and a runbook digest of another repository; a restore whose replay stops short fails `recovery_target_reached`; a restic repository verify is refused; a drill refused when a worker runs.
- **Acceptance test:** each listed case is a named test in `apps/server/test/http-backups.int.test.ts`, `packages/backups/test/*` or `agent/node/internal/helper/*_test.go`, shown to fail with the fix reverted; W9-04 "Regression artifact" column updated.

#### TC-028 [P2] Local evidence the W9-02 matrix names does not exist (selection, 500-chain, PostgreSQL 16/18)

- **Area:** test evidence claims in `PRE-WAVE-11-REVIEW.md`
- **Block:** B (static audit defect 7; gate-map G9.3)
- **Reproduction:** M-6 "oldest, latest, PITR random": the only server-side selection used is `{ kind: 'latest' }` (`apps/server/test/http-backups.int.test.ts:597,613`); `selectSource` (`packages/backups/src/selection.ts:111-165`, branches older, backup, pitr, pitr_random) has no direct test and `packages/backups/test/` has no selection test. M-1 "all suites green on the three majors": the E-1 and OD-55 tests run on PostgreSQL 17 only (`packages/migrations-engine/test/ledger-guard.int.test.ts:146` `if (!full) return`, `:379-381`) and the advisor integration tests on 17 only (`packages/diagnostics/test/performance.int.test.ts:266`; cancel/terminate `[17, 18]`). M-10 "500+ migration baseline chain": `legacy-large.int.test.ts` imports 600 files end to end but its own comment says memory is not measured (the audit's claim "longest chain 50" was a misreading of poll loops; corrected by the editor check).
- **Expected:** the matrix's "local" column is true.
- **Actual:** gaps as listed; also `coverageView` invents `fromLsn: '0/0'` for every WAL gap (`packages/backups/src/records.ts:336`; harmless today because nothing writes `wal_coverage.gaps`).
- **Evidence:** `B/review-items-static-audit.md` defect 7; `B/gates-g7-g10-evidence-map.md` (G9 row 3).
- **Root cause:** documentation overstates test coverage.
- **Proposed fix:** write `packages/backups/test/selection.test.ts` (all four selection kinds with a fixture catalog) and a drill integration per selection; run the E-1/OD-55 and advisor suites on 16/17/18 where the major allows (state which not); correct the matrix.
- **Acceptance test:** the selection test covers older, backup, pitr and pitr_random with expected sources and the refusals (`RESTORE_SOURCE_INVALID`); the ledger-guard suite registers all tests for majors 16, 17, 18.

#### TC-029 [P2] Silent partial coverage in the default test run (CI classes and conditionals)

- **Area:** test infrastructure
- **Block:** B (static audit section 6)
- **Reproduction:** read `vitest.shared.ts`: default `bun run test` runs 509 files; `*.host.test.ts` (12 files) are not in `verify` (CI only, `node-pg` and `node-host-scenarios`); `*.lab.test.ts` (5 files; `packages/backups` has no script); `*.install.test.ts`; `*.model.test.ts`. Conditionals: `ledger-guard.int.test.ts:146`, `performance.int.test.ts:266,531,799`, `agent-capabilities.host.test.ts:47,410,...` (`SYSTEMD`), `mcp-replay.int.test.ts:31,226`, `visual-regression.e2e.test.ts:39,224,235`, `EXDB_CLI_BIN` unset runs the CLI from source (`http-migrations.int.test.ts:992`, `cli-import.int.test.ts:46`). No host scenario covers backup or restore runs (T-NODE-1 to T-NODE-5 stay manual).
- **Expected:** `test-strategy.md` lists what `verify` does not run and who runs it.
- **Actual:** `bun run verify` is described as the full proof; it is not (host, lab, install, model, `pglab`).
- **Evidence:** `B/review-items-static-audit.md` section 6.
- **Root cause:** documentation.
- **Proposed fix:** add a table "what `verify` does not run" to `exponetdb-docs/14-roadmap/test-strategy.md` and a `verify:host` script that prints the exact commands; add a host scenario for backup runs under real systemd (see the backup/restore findings of this campaign).
- **Acceptance test:** docs link check; `bun run verify:host --list` prints the commands.

#### TC-030 [P2] A failed list read still prints an empty-list body on stdout and the JSON error envelope carries `data.items: []`

- **Area:** CLI output of list commands (principle 5, truthful reads)
- **Block:** C (CLI sweep D1)
- **Reproduction:** `exponetdb backup list cls_01M5J4RDBP52B715X5HDFKDN5F` with a session lacking `backups.read`: stderr has the typed `INSUFFICIENT_SCOPE`, exit 3, **stdout prints "No backups in the catalog mirror."** Same for `backup overview`, `backup runs`, `restore list`, `drill list`, `cluster findings`, `environment list prd_000...`, `target list --state bogus`, `cluster list --cursor garbage`, `plan list --target reosa/platform/nope`, `operation list --target reosa/platform/nope`, `finding list --target reosa/platform/nope`, `schema search reosa/platform/nope lead`, `audit list --target tgt_xyz`. `exponetdb cluster findings cls_... --output json` gives `"status":"error", ... "data":{"items":[]}`.
- **Expected:** nothing on stdout (as the `show` commands do) and no `data.items` in an error envelope.
- **Actual:** a script or agent that ignores the exit code reads "no backups", the worst false statement for backup commands.
- **Evidence:** `C/cli-read-sweep.md` section 3 (D1), raw outputs `C/raw/backup-list.txt` etc.
- **Root cause:** the shared list renderer prints the empty-state text before the error is raised (`apps/cli/src/cli/reads.ts` `listCommand`, empty-state path) and the envelope builder adds `data` from the default; locate with `grep -n "empty" apps/cli/src/cli/reads.ts`.
- **Proposed fix:** build output only from a successful response; on error emit the typed error alone (no `data` key).
- **Acceptance test:** CLI process test with a fake server answering 403 for each list command: stdout is empty, exit code non-zero, the JSON envelope has no `data` property.

#### TC-031 [P2] `node list --server` ignores its filter; `node enrollment status` treats an unknown server as "not enrolled"

- **Area:** CLI node commands
- **Block:** C (CLI sweep D3)
- **Reproduction:** `exponetdb node list --server srv_01M5FARNQDD4BSM9S62CPRTB3J` (REOS-01, which has no node), `exponetdb node list --server srv_xyz`, `exponetdb node enrollment status srv_xyz`, `exponetdb node enrollment status srv_00000000000000000000000000`.
- **Expected:** an empty list for REOS-01, a usage or `NOT_FOUND` error for a bad id.
- **Actual:** all four exit 0; the first two return the node of another server (`nod_01M5XZ84...` on `srv_01M4WGQ...`), the last two print "No node has enrolled for this server yet."
- **Evidence:** `C/cli-read-sweep.md` (D3).
- **Root cause:** `apps/cli/src/commands/node.ts` declares `name: 'server'` for `node list` but passes no query mapping; `node.ts:484-501` for enrollment status (not traced).
- **Proposed fix:** map `--server` to a `serverId` query on `GET /nodes` (add the filter to the contract; U8 lists `serverId` on `GET /nodes`) and validate the id on enrollment status.
- **Acceptance test:** CLI and REST test: the filter narrows; an unknown server id answers `NOT_FOUND`.

#### TC-032 [P2] `migration import scratch-check` and `scratch-copy-commands` accept a nonexistent scratch and give false reassurance

- **Area:** CLI import helpers
- **Block:** C (CLI sweep D4)
- **Reproduction:** `exponetdb migration import scratch-copy-commands --target reosa/platform/staging --scratch nope/nope/nope`; `exponetdb migration import scratch-check --target reosa/platform/staging --scratch nope/nope/nope`.
- **Expected:** `TARGET_NOT_FOUND`, exit 1.
- **Actual:** exit 0; the first prints "nothing to copy: The scratch target holds every object outside the managed scope the checks name." and `Next: ... --scratch ` with an empty value; the second prints `not ready` with `scratch_usable fail not_found`.
- **Evidence:** `C/cli-read-sweep.md` (D4).
- **Root cause:** traced in the CLI only (`apps/cli/src/commands/migration.ts` import helpers); the server path was not traced.
- **Proposed fix:** resolve the scratch target first and fail with `TARGET_NOT_FOUND`; make `scratch-check` exit non-zero when not ready.
- **Acceptance test:** CLI test with a fake server: unknown scratch exits 1 with the typed error and prints no "nothing to copy".

#### TC-033 [P2] `access grants` cannot work with the CLI's OAuth token

- **Area:** REST/CLI `GET /me/grants`
- **Block:** C (CLI sweep D5)
- **Reproduction:** `exponetdb access grants` signed in as the owner (global `owner` binding): exit 3 `PERMISSION_DENIED: The identity lacks the permission at this scope. Ask an administrator for a role...`
- **Expected:** the caller's own OAuth grants (or a clear "browser session only").
- **Actual:** the route `listMyGrants` declares only `SESSION_EXPIRED` (`packages/contracts/src/rest/routes.ts`): a browser-session endpoint; the command has no `Scopes:` line in its help and the message sends the owner to an administrator.
- **Evidence:** `C/cli-read-sweep.md` (D5).
- **Root cause:** the CLI exposes a browser-session-only route.
- **Proposed fix:** serve the route to bearer tokens with a `access.read` scope for the caller's own grants, or remove the command and say "use the Web App"; fix the message.
- **Acceptance test:** CLI integration test: the owner's token lists its own grants, or the command is absent from the catalog.

#### TC-034 [P2] An approval-gated erase operation stays `awaiting_approval` after its plan was consumed, approved 1 of 1 and expired (live data)

- **Area:** approvals/operations, access identity erase
- **Block:** C (CLI sweep D6; the editor's check suggests a designed cooling flow whose guidance is missing)
- **Reproduction:** `exponetdb approval list`; `exponetdb approval show op_01M5X74EJ0CD4BYGRZ9DM1KZYA --output json`; `exponetdb plan show pln_01M5X72JJMDT4ENZ3S73GWGEGA`. Operation `access.identity.erase` created 2026-10-26T23:01Z is `awaiting_approval`, apply `not_started`, `nextAction approve`, with a live `approvalUrl`; its plan is `consumed`, approvals `{required: 1, given: 1}`, `expiresAt 2026-10-26T23:15:07Z` (about 20 h ago); `approval show` prints "Approvals: 1 of 1" next to "Approve at: ...". The target identity `idn_01M4H5XZ12G122Q9MCZHT5QKMA` (service account #2 "Test") is still `active`.
- **Expected:** one coherent state (approved and running or done, canceled, or expired) and, for a self-approval cooling rule, text that says when it can run.
- **Actual:** the operation never expires and offers an approval URL for an already-given approval. It may be the designed critical-self-approval cooling flow (`packages/auth/src/approvals.ts:44-67,294-342`, `packages/application/src/application.ts:2392-2406`); not verified against the live row. An erasure left dangling is dangerous if it can be approved later.
- **Evidence:** `C/cli-read-sweep.md` (D6). **Owner: please look at this operation.**
- **Root cause:** missing guidance and no expiry for `awaiting_approval` operations whose plan expired.
- **Proposed fix:** an operation whose plan expired moves to `canceled` (reason `plan_expired`) with an audit event; the approval page and CLI state the cooling rule and the earliest apply time.
- **Acceptance test:** integration: a plan that expires while its operation awaits approval ends the operation `canceled`; the approval page for a consumed plan says so; an approve call after expiry is refused with a typed error.

#### TC-035 [P2] Rail tooltips stay open after keyboard focus leaves the rail (W-01)

- **Area:** Web App rail (`packages/ui` sidebar), keyboard accessibility
- **Block:** C (Web audit W-01)
- **Reproduction:** 1920x945, `/targets`, press Tab 15 times (skip link, mark, search, account, nine rail links, sidebar toggle, `main`, ...).
- **Expected:** a tooltip closes when its item loses focus.
- **Actual:** nine rail tooltips ("Overview G then H" ... "Settings G then S") plus "Sidebar" remain open over the page; the DOM shows ten `[role=tooltip]` with `data-state=instant-open`; Escape closes one per press.
- **Evidence:** `C/web-audit.md` W-01 (screenshot `mcp-claude-in-chrome-blob-1793133772582-63wa4e.png` in the session tool-results).
- **Root cause:** `packages/ui/src/sidebar.tsx:732` keeps `tooltipOpen` locally while `:776` passes `open={tooltipEnabled && tooltipOpen}`; while the rail is expanded (`tooltipEnabled` false) Radix has nothing to close, `onOpenChange(false)` never fires and the flag stays `true`; collapsing the rail opens every stuck tooltip at once.
- **Proposed fix:** reset `tooltipOpen` when `tooltipEnabled` turns false (or derive open state from focus/hover).
- **Acceptance test:** component test in `packages/ui`: focus each rail item with the rail expanded, then collapse it; no `[role=tooltip]` is open; a real-browser axe/keyboard case in `apps/server/test/web-axe.e2e.test.ts`.

#### TC-036 [P2] The Findings "Kind" filter cannot select advisor or statements findings (W-02)

- **Area:** Web App findings pages
- **Block:** C (Web audit W-02)
- **Reproduction:** `/t/reosa/platform/staging/findings` or `/findings`, open Kind.
- **Expected:** the kinds the server returns (CLI `finding list --kind drift|health|advisor|statements`).
- **Actual:** only Any / Drift / Health; all 215 staging findings are `advisor`, so the filter that would isolate them does not exist; rows print the raw prefix `advisor`.
- **Evidence:** `C/web-audit.md` W-02.
- **Root cause:** `apps/web/src/features/findings/search.ts:11` and `apps/web/src/features/global-findings/search.ts:13`: `KINDS = ['drift', 'health']`.
- **Proposed fix:** take the kind list from the contract enum (`advisor`, `statements`, `drift`, `health`), with readable labels.
- **Acceptance test:** web test: the select offers every kind of the contract enum and the URL search state round-trips `kind=advisor`.

#### TC-037 [P2] The headline "Critical findings 520 of 14,184" is 518 expected scratch drift rows, one roll-up and one real finding (W-03)

- **Area:** Web overview/findings aggregation (depends on the advisor/drift-recording entry and OD-57)
- **Block:** C (Web audit W-03)
- **Reproduction:** `/` (card "Critical findings 520, of 14,184 open") and `/findings`; compare with `exponetdb finding summary` (519 critical, 13,258 warning, 406 info).
- **Expected:** the number a person acts on separates expected drift of a rehearsal copy from real signals; a roll-up does not count as another critical.
- **Actual:** 13,741 of 14,184 (96.9 percent) are drift `object_added` on scratch (518 critical); the advisor `drift_open` roll-up ("13741 open drift findings (519 critical)") is itself an open critical; the newest-criticals list on `/` shows only `notification_push_subscriptions`/`floorplan_runs` policies; the one real critical (`object_changed`, "schema public changed: acl") is not on the first screen. Web numbers equal the CLI: presentation and aggregation only.
- **Evidence:** `C/web-audit.md` W-03; `C/cli-read-sweep.md` section 4.
- **Root cause:** the fleet read counts the `drift_open` advisor among findings; `apps/web/src/features/fleet/findings-triage.tsx` lists by recency only.
- **Proposed fix:** exclude roll-ups from severity counters, group findings by target and code, and show findings of targets whose baseline/ledger is absent separately ("rehearsal drift").
- **Acceptance test:** server read test: a fleet with one real critical and N drift rows on a baseline-less target returns `critical: 1` plus a separate group; web test renders the real critical first.

#### TC-038 [P2] Node page: the h1 is the raw id and the page scrolls sideways at 390 px (W-05)

- **Area:** Web infrastructure pages
- **Block:** C (Web audit W-05)
- **Reproduction:** viewport 390 wide, `/infrastructure/nodes/nod_01M5XZ84V768SYCHZKRNGJFQP2` (measured in a script-driven same-origin popup; no screenshot possible).
- **Expected:** a name or hostname as heading; no horizontal scroll.
- **Actual:** h1 "Node nod_01M5XZ84V768SYCHZKRNGJFQP2" (24 px, `overflow-wrap: normal`) is 454 px wide in a 327 px box; `main` scrollWidth 478 vs clientWidth 375.
- **Evidence:** `C/web-audit.md` W-05.
- **Root cause:** `apps/web/src/lib/i18n/messages/infrastructure.ts:491` (`'Node {id}'`) used at `apps/web/src/features/infrastructure/node-detail.tsx:71`.
- **Proposed fix:** heading uses the server name with `break-words`; the id moves to a copyable field.
- **Acceptance test:** web test at 390 px (jsdom width plus the existing phone tour in `web.e2e.test.ts`): the node detail page has no horizontal overflow; add the page to the phone tour.

#### TC-039 [P2] `exponetdb-node enroll` on a fresh host fails with `state directory: lstat /var/lib/exponetdb-node`; the literal runbook has two more blockers (E1, GAP-01 to GAP-03)

- **Area:** node agent packaging and `node-runbook.md` §2/§3
- **Block:** D/E (E1 reproduced on a real systemd host and locally)
- **Reproduction:** release 0.7.0 (`agent/node/packaging/build.sh`), runbook §2 literally (`install`, `systemd-sysusers`, `systemctl daemon-reload`), config at `/etc/exponetdb-node/config.json`, then §3.3 `sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file ...` before any unit started. Also: `--token-file /root/token` gives `open /root/token: permission denied` for the agent user (`/root` is 0700); `--token-file - < /root/token` works. §2 never installs `tmpfiles.d/exponetdb-node-engine.conf` nor creates `/etc/exponetdb-node`.
- **Expected:** the node enrolls (§3 runs before §3.5 "start").
- **Actual:** `state directory: lstat /var/lib/exponetdb-node: no such file or directory`, exit 1 (verbatim in `D/gap-scenarios/01-e1-install.txt`); exit 0 after `install -d -m 0700 -o exponetdb-node -g exponetdb-node /var/lib/exponetdb-node`. Without `tmpfiles` the backup engine directories `/var/lib/exponetdb-node-engine/{runs,scratch,reads}` do not exist after a literal install.
- **Evidence:** `E/e-findings-local.md` E1; `D/gap-scenarios.md` GAP-01 to GAP-03; `D/gap-scenarios/01-e1-install.txt`.
- **Root cause:** `agent/node/internal/state/state.go:103-122` (`Open` runs before the command switch in `cmd/exponetdb-node/main.go:126`; `fsutil.go:153-156` `CheckOwnedPrivate` starts with `Lstat`); `packaging/systemd/exponetdb-node.service:34-35` `StateDirectory=` creates it only at unit start; `packaging/sysusers.d/exponetdb-node.conf:2` names the home only; no tmpfiles line; runbook `node-runbook.md:34-46` (§2) and `:119` (§3.3 token path). The host test swaps `StateDirectory=` for a pre-created `ReadWritePaths` (`agent-capabilities.host.test.ts:352`), so CI never runs the fresh-host order.
- **Proposed fix:** ship `d /var/lib/exponetdb-node 0700 exponetdb-node exponetdb-node -` in a new `agent/node/packaging/tmpfiles.d/exponetdb-node.conf` (installed by `build.sh`); runbook §2 adds `install -m 0644 tmpfiles.d/*.conf /usr/lib/tmpfiles.d/`, `systemd-tmpfiles --create`, `install -d /etc/exponetdb-node`; §3.3 uses `--token-file - < /root/token`; `state.Open` answers an `ENOENT` with "state directory X does not exist: run systemd-tmpfiles --create, see node-runbook.md §2".
- **Acceptance test:** Go test `TestEnrollMissingStateDirectoryExplainsFix` (exit 1, stderr contains `does not exist` and `node-runbook.md`); extend `agent/node/packaging/verify-units.sh` to run `systemd-sysusers --root` plus `systemd-tmpfiles --root --create` and assert `stat -c %a` is `700`; a host scenario that follows the runbook text literally (install, enroll as the agent user before any unit, then start).

#### TC-040 [P2] An older CLI answers `RESPONSE_INVALID` against a newer server; no version negotiation exists (E4)

- **Area:** CLI/SDK/contracts versioning
- **Block:** E (E4 reproduced at unit level)
- **Reproduction:** in-process CLI against a fake server (scripts in the tester's scratch `e4/run.ts`): installation `version: '9.0.0'` with an added field or a new enum value in a list response -> exit 5 `RESPONSE_INVALID` (status and request id only, no remediation); `restApi: 'v2'` also gives `RESPONSE_INVALID` because `restApi: z.literal('v1')` fails first, so `incompatible_server` is dead code; list commands print the wrong text plus an empty-table block. 175 of 176 response enums are closed and 27 response objects are strict.
- **Expected:** "this CLI 0.6.0 is older than the server; update to >= X".
- **Actual:** every command of an older CLI breaks as soon as a newer server adds a value to one closed enum or a field to one strict object, with a contract error.
- **Evidence:** `E/e-findings-local.md` E4.
- **Root cause:** `apps/cli/src/cli/remote.ts:26` (`matchesContract` = strict `safeParse`) wired as `validate` at `:182`; `packages/sdk/src/transport.ts:205-226` returns `RESPONSE_INVALID`; `connect()` (`remote.ts:198-206`) validates the installation body strictly before the version check; no `x-exponetdb-api-version` header, no minimum-CLI field; `apps/cli/src/version.ts:11`; strict contract objects per `exponetdb-docs/06-rest-api/versioning.md` §2.
- **Proposed fix:** additive optional `Installation.minCliVersion`; send `X-Exponetdb-Api-Version`/`X-Exponetdb-Version` on every response; in `connect()` parse the installation tolerantly first (`contracts.restApi`, `version`), raise `incompatible_server` for another REST major and `cli_outdated` when `minCliVersion > CLI_VERSION`; attach "server X is newer than this CLI Y: update the CLI" to `RESPONSE_INVALID` when the server version is newer; make response objects non-strict (27 sites) and growing enums `x-extensible-enum` with a tolerant SDK parse; `listingFailure` must not render an empty table.
- **Acceptance test:** `apps/cli/test/cli.test.ts` with a fake server: `restApi: 'v2'` -> exit 5 `incompatible_server` naming both versions; `minCliVersion: '9.0.0'` -> `cli_outdated`; an extra field on a node list -> exit 0; an unknown `state` on a newer server -> exit 5 with an update hint and no "No nodes" block; a contract test that no response schema of `ROUTE_LIST` is strict and every response enum is extensible or allow-listed with a reason.

#### TC-041 [P2] `migration lint` has no path, bundle or since filter, so a project with one old prod-blocking bundle can never get a green lint (E9)

- **Area:** CLI migration lint
- **Block:** E (E9 reproduced with a scratch project and a copy of the real REOSA bundle)
- **Reproduction:** project with an old applied bundle containing `CREATE FUNCTION ... SECURITY DEFINER` without `search_path` and a clean new bundle depending on it: `exponetdb migration lint` -> exit 1 `MIGRATION_LINT_BLOCKED`; `migration lint <path>`, `--bundle`, `--since`, `--only` are rejected (exit 2); copying the new bundle alone gives `unknown_dependency`. A copy of `01M5X2X3ARA75KSKZPANYYEHHW_event-platform` from the REOSA checkout (copy only) gives 15 findings, 11 blocking, all level `warn` and blocking only in the prod tier: 5 `uncovered_statement`, 3 `create_index_without_concurrently`, 3 `table_without_grant`; `--tier nonprod` exits 0.
- **Expected:** a new clean bundle can get a green lint run; already applied bundles do not block.
- **Actual:** the red is permanent because applied bundles cannot change without a checksum mismatch; the CLI is stricter than the server gate that lints only the pending set (`planner.ts` around `:615`).
- **Evidence:** `E/e-findings-local.md` E9.
- **Root cause:** `apps/cli/src/commands/migration.ts:242-333`: no argument or filter, `readBundles(project)` -> `lintBundles(all)` (`:267`), exit code from all blocking findings (`:277-281`); `lintBundles` has no scope option.
- **Proposed fix:** `migration lint [<bundle dir|id>...]` plus `--since <id>` and `--exclude-applied`; build the graph over all bundles but count findings and the exit code only for the selected ones, listing the others as `skipped` (`scope?: ReadonlySet<string>` in `packages/migrations/src/lint/lint.ts`); alternatively a reviewed per-bundle waiver in `exponetdb.project.yaml` (`lint.accepted: [{migration, rule, reason}]`).
- **Acceptance test:** `apps/cli/test/local.test.ts`: old bundle with `security_definer_without_search_path` plus clean new bundle: `migration lint` -> exit 1 (unchanged); `migration lint <new>` -> exit 0 with the old listed as `skipped` and no `unknown_dependency`; `migration lint <old>` -> exit 1; unknown bundle -> exit 2.

#### TC-042 [P2] An expired node certificate is silent and indistinguishable, and nothing warns before the renewal window closes (GAP-11)

- **Area:** node agent certificate lifecycle, gateway refusal reasons, findings
- **Block:** D (gap scenarios 4a to 4d; live node deadline)
- **Reproduction:** on a real systemd host with the real 72 h certificate: with 24 h 43 min left nothing happens; with 23 h 13 min left the certificate renews in under 1 s (PASS) and the renewed one works on a fresh session; an agent brought back with 9 h left renews within 16 ms. With the host clock moved past `notAfter` the gateway answers a generic `403 NODE_CERTIFICATE_REFUSED` (the same text as revocation and wrong state), the node row stays `active`, no finding or warning is raised and the agent retries forever with 1 to 60 s backoff; `exponetdb-node status` prints only a date. Recovery by RB-13 re-enrollment works end to end.
- **Expected:** a distinct reason `certificate_expired`; `status` says "expires in 5h12m (renewal due)" or "EXPIRED"; a node finding or health condition when `now > certificateExpiresAt - 12 h` without a renewal.
- **Actual:** silence. The live node on `reos-db-01` has a certificate expiring 2026-10-30T05:57:35Z, its renewal window is 2026-10-29T05:57:35Z to 2026-10-30T05:57:35Z (a third of 72 h, `packages/nodes/src/gateway.ts:278-285`); an agent stopped for two days from now recovers without re-enrollment; only an outage spanning the whole window needs RB-13, and nothing warns before it closes.
- **Evidence:** `D/gap-scenarios.md` item 4 and GAP-11; `D/gap-scenarios/10-cert-renew.txt`; `C/live-mcp-reads.md`.
- **Root cause:** `packages/nodes/src/gateway.ts:265,497` throw `NODE_CERTIFICATE_REFUSED` for all causes; no health condition reads `certificate_expires_at`; `agent/node/cmd/exponetdb-node` `status` prints the date only.
- **Proposed fix:** distinct refusal detail `certificate_expired`; `exponetdb-node status` prints remaining time and "renewal due"/"EXPIRED"; a node finding `node_certificate_near_expiry` (warning from 12 h before expiry, critical after) and `node_certificate_expired`; document in runbook §6.
- **Acceptance test:** host scenario that moves the clock past `notAfter` asserts the refusal detail and the finding; unit test of the finding thresholds; `status` text test.

#### TC-043 [P2] A restore to the end of the archive reports success when the replay stops short (D-04)

- **Area:** node `restore.execute` verification
- **Block:** D (M-4, M-7)
- **Reproduction:** corrupt or remove a WAL segment after the newest backup and run a restore to the end of the archive (`scripts/t7c.sh`, `logs/t7c-corrupt-latest.log`). A corrupt segment inside a PITR range correctly fails the restore (PASS).
- **Expected:** never "good enough".
- **Actual:** the node reports `succeeded`, all checks passed, the replay ended before the archive end, 20 rows lost. The only guard is in the Control Plane (`kinds.ts:1358`), unobservable until the `latest` drill bug is fixed.
- **Evidence:** `D/backup-restore-e2e.md` D-04.
- **Root cause:** `agent/node/internal/helper/restore.go` `checkRecovery` default branch ("recovery ended and the cluster was promoted") compares nothing with the archive end.
- **Proposed fix:** pass the expected `walTo` to `restore.execute` (or return it from `restore.prepare`) and fail `recovery_target_reached` in the node when `pg_last_wal_replay_lsn` is below it.
- **Acceptance test:** a `pglab` corrupt-segment test expects the run `failed`; a clean restore to the end passes.

#### TC-044 [P2] A refused backup start is reported as `OUTCOME_UNKNOWN` after about 100 seconds (D-05)

- **Area:** node job executor, Control Plane reconciliation
- **Block:** D (T-NODE-3, M-7)
- **Reproduction:** host mode file absent; plan and apply `POST /clusters/{id}/backup-runs {kind:"incremental"}` on an `adopted_runs` record (`logs/b-evidence-run1.log`, `logs/b-refused-start-job.json`).
- **Expected:** `failed / not_applied` with a precondition code within seconds.
- **Actual:** the start job carries `helper refused (precondition_failed): ...` after 0.1 s, but the effect step is recorded `running`, the worker waits for reconciliation and ends `OUTCOME_UNKNOWN` after 99.5 s; the run row is `lost`.
- **Evidence:** `D/backup-restore-e2e.md` D-05.
- **Root cause:** (suspected) the agent marks the `start_run` step before the helper answers and maps a helper refusal on an `observable` capability to an unknown outcome instead of `not_applied` with the helper code (agent job executor).
- **Proposed fix:** map `precondition_failed` and `job_invalid` helper refusals to a definitive failed job with the code; reserve `outcome_unknown` for transport loss.
- **Acceptance test:** a host scenario with an absent mode file: the operation ends in under 15 s with the precondition code.

#### TC-045 [P2] The restic runbook neither restores globals nor stops without them (D-07)

- **Area:** `packages/backups/src/runbook.ts`
- **Block:** D (M-5)
- **Reproduction:** `scripts/t8b_restic_runbook.sh`: a dump with grants fails mid-restore at `pg_restore --exit-on-error` (`role "reader" does not exist`, rc 1) leaving a half-restored database; with no `globals.sql` in the snapshot the script does not stop on that fact.
- **Expected:** databases and globals restore; a missing globals file stops the runbook (M-5).
- **Actual:** `globals.sql` is only announced ("review ... before applying it").
- **Evidence:** `D/backup-restore-e2e.md` D-07.
- **Root cause:** `packages/backups/src/runbook.ts:337-345`.
- **Proposed fix:** stop with a clear message when no `globals*.sql` exists; apply it (or print an explicit manual step and exit before `pg_restore`) before restoring databases.
- **Acceptance test:** a runbook test with a snapshot lacking the globals file exits non-zero before touching the target; with globals the roles exist after the run.

#### TC-046 [P2] `restore.execute` does not re-check space and can fill the filesystem (D-08)

- **Area:** node helper restore preparation/execution
- **Block:** D (T-NODE-4)
- **Reproduction:** engine directory on a 512 MB tmpfs (`scripts/t11_space_wrongkey.sh`): `restore.prepare` says `space_insufficient`; `restore.execute` for the same run starts and writes until the filesystem is full (tmpfs 512M/512M).
- **Expected:** refusal at execute; nothing written.
- **Actual:** run accepted; on a normal host the scratch root and the data directory usually share a filesystem, so a stale prepare can fill the filesystem under the registered cluster.
- **Evidence:** `D/backup-restore-e2e.md` D-08.
- **Root cause:** `agent/node/internal/helper/ops_backup.go:876` (`restoreExecute`) does not repeat the checks of `restorePrepare` (space, `label_not_found`, `target_outside_window`).
- **Proposed fix:** run the prepare checks again at execute and refuse; consider a quota or `LimitFSIZE`.
- **Acceptance test:** a helper test: execute with insufficient space and with an expired label is refused with the named code, no run directory and no scratch directory are created.

#### TC-047 [P2] M-4 and RB-06 describe backup flows the Control Plane cannot start (D-10)

- **Area:** backup runs through the product, `backup.expire`, ownership
- **Block:** D (M-4, W9-05 hand-over)
- **Reproduction:** `POST /backup-repositories/{id}/ownership {to:"owned"}` -> `CAPABILITY_UNAVAILABLE`; `POST .../backup-runs {kind:"full"|"differential"}` on `adopted_runs` -> `deny`; no REST route for `backup.expire` in `apps/server/src/interfaces/http/api.ts`.
- **Expected:** M-4 ("a repository with mode `owned`", "runs through `exponetdb backup run`", "expire at the boundary") and RB-06 work end to end.
- **Actual:** full, differential and expire exist only at helper level with a host mode file `owned` (verified there: kept label never expired); through the Control Plane only incremental on `adopted_runs` works.
- **Evidence:** `D/backup-restore-e2e.md` D-10.
- **Root cause:** the hand-over to `owned` is not built (W9-05) and `backup.expire` has no route.
- **Proposed fix:** owner decision: build the `owned` path and the expire route, or rewrite M-4 and RB-06 to the adopted-only flow and mark expiry as a planned capability.
- **Acceptance test:** an updated test matrix whose rows are all executable; an integration test for whichever path is chosen.

### P3 (28)

#### TC-048 [P3] Enrollment tokens cannot be listed or revoked, and a dead token's state never becomes expired (E6)

- **Area:** nodes enrollment, REST, CLI, Web, retirement preflight
- **Block:** C/D, E6
- **Reproduction:** REST probes on a host-test control plane: `GET /api/v1/enrollment-tokens`, `GET /api/v1/enrollment-tokens/{id}`, `DELETE ...`, `POST .../revoke` all answer 404 (`E/e2-e6-live-host-run.log`); the only route is `POST /enrollment-tokens/{id}/reveal` (`packages/contracts/src/rest/routes.ts:2128`). `node enrollment status` lists nodes only, not tokens, so the live unused token `ent_01M5XZ0J5CTYJBGB9XSVCPZFRE` cannot be seen at all.
- **Expected:** an operator can see open tokens with their state and expiry and can revoke one; a token past its lifetime reads `expired`.
- **Actual:** a token does expire in practice (reveal window 30 min after creation, redeem window 30 min after reveal, checked in `nodes.enroll` with `clock_timestamp() < t.expires_at`, `packages/control-store/migrations/01M49K5NQ8ZB4W2T6Y3H7RXJMD_nodes/up.sql:578-580`), but nothing writes the state `expired` (the guard allows it, `up.sql:317`), no read lists tokens, and there is no revoke. The retirement preflight treats a token as open for 5 minutes past `expires_at`.
- **Evidence:** `E/e2-e6-live-host-run.log`; `B/review-items-static-audit.md` (U5 table row "Enrollment token").
- **Root cause:** missing read and revoke surfaces; no worker sweep sets `expired`.
- **Proposed fix:** additive Control Store bundle plus a worker sweep that sets `expired`; add `GET /servers/{id}/enrollment-tokens` (ids, state, times, never secrets) and `POST /enrollment-tokens/{id}/revoke` (a new state `revoked`, human only, audited); show them on the server page and in `node enrollment status`.
- **Acceptance test:** integration test: create a token, let `expires_at` pass (clock seam), the sweep sets `expired`; a token revoked before use refuses `nodes.enroll` with the one generic refusal and is audited; the CLI lists both.

#### TC-049 [P3] A `time`-zone dependent unit test fails in a non-UTC shell (A)

- **Area:** packages/ui-patterns tests
- **Block:** A
- **Reproduction:** `TZ=Europe/Berlin bun run --cwd packages/ui-patterns test` fails `test/metric-card/index.test.tsx > MetricCard > marks a stale value as stale and shows how old it is` ("Unable to find an element with the text: 13 Oct 2026 14:03") on 3 of 3 runs (the full `bun run test` aborts at this point and turbo kills `apps/web` and `apps/design-system`); with `TZ=UTC` all 90 files and 1,141 tests pass, and the full suite passes on a UTC host (server run).
- **Expected:** tests pass in any time zone (the PRE-WAVE-11 review noticed it and left it).
- **Actual:** developers outside UTC cannot get `bun run verify` green; the failure hides the later packages.
- **Evidence:** `A/test.log`, `A/rerun-ui-patterns-cet-1.log`, `A/rerun-ui-patterns-cet-2.log`, `A/rerun-ui-patterns-utc.log`.
- **Root cause:** `packages/ui-patterns/test/metric-card/index.test.tsx:83` expects UTC clock text from a component that formats in local time; the vitest config sets no `TZ`.
- **Proposed fix:** set `process.env.TZ = 'UTC'` in the shared vitest setup (`vitest.shared.ts`) or pass an explicit time zone to the formatter under test.
- **Acceptance test:** `TZ=Europe/Berlin bun run --cwd packages/ui-patterns test` and `TZ=America/Los_Angeles ...` pass.

#### TC-050 [P3] `mcp:evals` counts a missing API key as 14 failed tests and sits outside `verify`

- **Area:** apps/server evals, `package.json` scripts
- **Block:** A
- **Reproduction:** `bun run mcp:evals` without `EXDB_EVAL_ANTHROPIC_API_KEY`: 14 tests FAIL with "NOT RUN: set EXDB_EVAL_ANTHROPIC_API_KEY ..." and exit 1.
- **Expected:** a clearly reported skip (or an explicit `NOT RUN` state) that cannot be mistaken for a regression, and the evals documented as not part of `verify`.
- **Actual:** the suite exits 1; the root `verify` script does not call it, so a reader of "all suites" cannot tell it was never run.
- **Evidence:** `A/mcp-evals.log`.
- **Root cause:** `apps/server/test/mcp-evals.model.test.ts:83` throws instead of skipping.
- **Proposed fix:** report the missing key through the vitest skip mechanism with the exact reason, and list `mcp:evals` in `test-strategy.md` as an owner-run suite.
- **Acceptance test:** without the key the run reports 14 skipped, exit 0, and prints the reason; with a key the tests run unchanged.

#### TC-051 [P3] The pinned toolchain is not enforced by `bun install` and local runs silently use other versions

- **Area:** tooling, `package.json` `engines`
- **Block:** A
- **Reproduction:** on a machine with Node 26.5.0 and Bun 1.3.14 (outside `engines`: node `>=24.22.1 <25`, bun `>=1.4.4`) `bun install --frozen-lockfile` succeeds without a warning and the suites run; `apps/cli test:install` fails only because it needs Node 24 (`apps/cli/test/packed.install.test.ts:85`).
- **Expected:** a clear refusal or warning that the toolchain is outside the supported range.
- **Actual:** results from an unsupported toolchain look authoritative (this campaign re-ran the decisive suites on the pinned Node 24.22.1, Bun 1.4.4, Go 1.26.10).
- **Evidence:** `A/bun-install.log` (scratch), `A/cli-test-install.log`, `A/versions` run on server (`D/ci-replica/versions.log`).
- **Root cause:** `engines` is advisory in Bun; no preinstall check.
- **Proposed fix:** add a `scripts/check-toolchain.ts` run by `verify` and a `preinstall` that prints the mismatch and fails under `CI=true`.
- **Acceptance test:** running `bun run verify` under a Node outside the range exits non-zero with the named versions.

#### TC-052 [P3] CLI lint table does not show which finding blocks; `project execution-roles` takes only an id

- **Area:** CLI usability
- **Block:** C
- **Reproduction:** a bundle with `table_without_grant` under the default strict profile prints `LEVEL warn` yet "BLOCKED 1 findings, 1 blocking" and exit 1 (JSON shows `level: warn, blocking: true`); `exponetdb project execution-roles reosa/platform` answers `VALIDATION_FAILED /projectId: Expected the prefix prj_` while `target`, `migration` and `health` accept paths.
- **Expected:** a BLOCKING marker per row; paths accepted wherever a product/project path is natural.
- **Actual:** the table reads as if nothing blocks; the id-only command surprises.
- **Evidence:** `C/live-migration-attempt.md`.
- **Root cause:** `apps/cli/src/output/views.ts` lint table omits `blocking`; `apps/cli/src/commands/registry.ts` `project execution-roles` param is a raw `projectId`.
- **Proposed fix:** add a `BLOCKS` column; resolve a `product/project` path to the id in the CLI (one read) for every project command.
- **Acceptance test:** CLI unit tests for both outputs; `project execution-roles reosa/platform` works against the fake server.

#### TC-053 [P3] Two step-up receipts of 120 seconds each are needed to enroll a node (E10)

- **Area:** auth step-up, node enrollment
- **Block:** E10
- **Reproduction:** read from `packages/auth/src/stepup.ts:29-30,269`: `STEP_UP_SECONDS = 600`, `RECEIPT_SECONDS = 120`; the actions `plan.apply` (apply the `node.enroll` plan) and `node.enrollment_token.reveal` each need their own receipt (`STEP_UP_ACTIONS`, line 22). Host scenario `enrollment.host.test.ts` calls `w.reauth()` twice.
- **Expected:** one step-up covers the two consecutive steps of one enrollment, or the second receipt is bound to the first plan; the runbook says so.
- **Actual:** two passkey prompts within about two minutes each; reported as unfriendly from CLI sessions that cannot step up (R-CLI-1).
- **Evidence:** code reading; `E/e-findings-local.md` does not cover it; host run `D/ci-replica` shows two reauths in the scenario.
- **Root cause:** one action per receipt by design (ADR-0026).
- **Proposed fix:** (owner decision) a combined `node.enroll` step-up whose receipt is accepted for both actions of that plan, or raise `RECEIPT_SECONDS` for those two actions to 5 minutes; document in `node-runbook.md` §3.
- **Acceptance test:** integration test: one receipt of the combined action applies the plan and reveals the token for that plan only; a receipt for another plan is refused.

#### TC-054 [P3] The default visual-regression baseline set `local` fails on any machine other than the one that recorded it

- **Area:** `apps/server` visual regression e2e
- **Block:** A
- **Reproduction:** `bun run test:e2e` on a WSL2 Ubuntu host (Node 26.5, Bun 1.3.14): `visual-regression.e2e.test.ts` fails both tests (`matches the baselines at 1440x900`: e.g. `desktop/light/ui/button/states: 2057 of 81872 pixels differ`, 10 further frames; `390x844`: `1918 of 53694`); the 9 other files (50 tests) pass. On a disposable Ubuntu 24.04 host with the pinned toolchain and `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04` (what CI sets) `bun run test:e2e` passes (6 min, `D/ci-replica/summary`).
- **Expected:** a contributor's clean checkout gets a green `bun run test:e2e` or a clear statement that the default set is machine-specific.
- **Actual:** the default `local` set (`apps/server/test/visual-baselines/local`) only matches the machine that recorded it; fonts and rasterization differ elsewhere.
- **Evidence:** `A/test-e2e.clean.log`; `D/ci-replica/test-e2e2` (summary lines in `D/ci-replica/summary.txt`).
- **Root cause:** `apps/server/test/visual-regression.e2e.test.ts:34` default `EXDB_VISUAL_BASELINE_SET ?? 'local'`.
- **Proposed fix:** default to `ci-ubuntu-24.04` when `process.platform === 'linux'` and fonts match, or fail fast with "no baseline set for this platform: set EXDB_VISUAL_BASELINE_SET or run EXDB_UPDATE_VISUAL=1" when the platform has no recorded set; document in `local-development.md`.
- **Acceptance test:** the test run on a platform without a baseline set fails (or skips with the explicit message) before comparing pixels; CI keeps passing.

#### TC-055 [P3] Permission-layer denial of the one allowed read-only check of the live control store

- **Area:** campaign limitation (recorded for the owner, not a product defect)
- **Block:** C
- **Reproduction:** `ssh exponet-server "docker exec rsbn9zqgegt2wpebijlnrmm4 psql -U postgres -d exponetdb_control -At -c 'select ... from nodes.nodes'"` was blocked by the session's permission layer ("Production Reads"); the lead did not work around it.
- **Expected:** the brief allows read-only `psql` there.
- **Actual:** E2's `nodes.nodes.clusters` could not be read live; it was proved on a disposable host with a real agent and in code instead.
- **Evidence:** `C/live-mcp-reads.md`.
- **Root cause:** n/a.
- **Proposed fix:** owner: add a permission rule if live control-store reads are wanted in a later campaign.
- **Acceptance test:** none.

#### TC-056 [P3] Node plan CLI errors drop the capability and the reason in text mode (E7)

- **Area:** CLI error rendering, node plans
- **Block:** C (node-plans D6, D7), E7
- **Reproduction:** `exponetdb node postgres roles nod_… --cluster cls_… --file roles.json --no-wait` prints only "No node-signed observation of this cluster is recent enough to plan against (at most 10 minutes). Inspect the cluster through the node, then plan again." `--output json` carries `details.capability`. Also: `create pg_trgm` where it is installed gives `CONFLICT "The resource changed (If-Match did not match)."`; invalid inspect args give `VALIDATION_FAILED` with `path ""`, "The request is not valid."; the TLS refusal `REGISTRY_CONFLICT ca_bundle_lacks_postgres_ca` is generic in text.
- **Expected:** the text names the capability (and the args that must match, e.g. `--arg database=...`), the field of a validation failure, and the reason of a conflict, with a remediation.
- **Actual:** only `--output json` has the detail; `CONFLICT` talks about an If-Match no one sent.
- **Evidence:** `C/node-plans-report.md` (D6, D7).
- **Root cause:** `apps/cli/src/output/render.ts:151-166` (`detailLines` prints only `details.errors`); generic messages at `packages/contracts/src/errors.ts:1179-1190` and `:1361`; `capability-plans.ts:575-580` and `:336-337` throw without details.
- **Proposed fix:** print `details.capability`, `details.reason` and the validation `path`; give `NODE_OBSERVATION_STALE` a remediation that names the exact `node inspect` command; use a dedicated conflict reason instead of the generic `CONFLICT`.
- **Acceptance test:** CLI unit tests for `NODE_OBSERVATION_STALE`, `REGISTRY_CONFLICT` and `VALIDATION_FAILED` text output; contract test that a conflict raised by a node planner carries a `reason`.

#### TC-057 [P3] Plan commands document `--wait` as "wait until applied and verified (the default)" although they only plan

- **Area:** CLI help
- **Block:** C (node-plans D8)
- **Reproduction:** `exponetdb help node postgres reload`.
- **Expected:** help says the command waits for the plan, not for an apply, unless `--apply` is given.
- **Actual:** the text invites the reading that the default applies; the tester treated it as a risk. Without `--apply` nothing is applied (`apps/cli/src/cli/planning.ts`, the `input.flags['apply'] !== true` branch).
- **Evidence:** `C/node-plans-report.md` (D8).
- **Root cause:** `apps/cli/src/cli/watch.ts:16-17` shared flag text.
- **Proposed fix:** plan-specific flag text ("--apply applies the plan now and waits until applied and verified").
- **Acceptance test:** help snapshot test for a plan command.

#### TC-058 [P3] No read form for job keys; `node job-keys` without changes is a usage error (E5)

- **Area:** CLI/REST node job keys
- **Block:** C (node-plans D9), E5
- **Reproduction:** `exponetdb node job-keys nod_…` -> `Error ... a job-key change adds or removes at least one key` (exit 2, client side); `--add key_tc_campaign_probe` -> `REGISTRY_CONFLICT job_key_not_addable`.
- **Expected:** a read shows the keys a node trusts and the keys it could add.
- **Actual:** no command or route lists job keys; `node show` does not show them; no positive plan can be built without out-of-band knowledge of key ids. The only read is `node inspect --capability agent.diagnostics@2` then `node observations --output json` (needs `nodes.plan`; the table hides the keys).
- **Evidence:** `C/node-plans-report.md` (D9), `E/e-findings-local.md` (E5).
- **Root cause:** missing read (`packages/contracts/src/rest/routes.ts` has no job-key route); `apps/cli/src/commands/node.ts:455` usage check.
- **Proposed fix:** `GET /nodes/{id}/job-keys` (key ids, state, trusted-by-node) with `node job-keys <node> --show`; show the keys in `node show`.
- **Acceptance test:** integration test for the route; CLI test for `--show`; a plan with a listed key id succeeds.

#### TC-059 [P3] Node plan polish

- **Area:** CLI/UX
- **Block:** C (node-plans)
- **Reproduction:** (1) `--file` paths are resolved against the process cwd; relative paths fail when run through a wrapper that changes cwd (wrapper artifact, no defect); (2) the restart plan shows no disruption summary although the basis observation holds it (see the `plan show` P1); (3) revoke/decommission plans list tier as `-`.
- **Expected:** n/a (covered by the entries above).
- **Actual:** n/a.
- **Evidence:** `C/node-plans-report.md`.
- **Root cause:** see the entries above.
- **Proposed fix:** none beyond the entries above; drop this entry if they land.
- **Acceptance test:** none separate.

#### TC-060 [P3] Lock contention on catalog reads is reported as `PLAN_STALE` or `QUERY_TIMEOUT` (MIG-09)

- **Area:** migration planning under lock
- **Block:** B (failure case d)
- **Reproduction:** hold `ACCESS EXCLUSIVE` on a table; planning ends `QUERY_TIMEOUT` after 2 s; acceptance and dispatch end `PLAN_STALE` with `changedBindings: ["target"]` although the plan is not stale.
- **Expected:** a typed busy/lock failure naming the holders.
- **Actual:** nothing runs and nothing stays held, but the cause is not named.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-09 (`d1`..`d3b`).
- **Root cause:** `packages/migrations-engine/src/kind.ts:203` maps any observer-read error to a changed binding.
- **Proposed fix:** map target lock/timeout reasons to a `TARGET_BUSY`-style code; keep `PLAN_STALE` for real differences.
- **Acceptance test:** the lock scenario asserts the busy code at plan, accept and dispatch.

#### TC-061 [P3] A waiting operation writes two events per worker poll (MIG-10) and the "cleanup migration" alternative is unreachable (MIG-11)

- **Area:** operations locks, failure-and-recovery docs
- **Block:** B (failure case e)
- **Reproduction:** a stuck resume: events 1 -> 21 over 10 worker polls (`locks_waiting` plus `lease_acquired`); a cleanup bundle offered by `failure-and-recovery.md` section 2 is refused `MIGRATION_INCOMPLETE` like every plan.
- **Expected:** one `locks_waiting` event per blocking operation; the documented alternative works or is removed.
- **Actual:** unbounded event growth while waiting; dead documentation.
- **Evidence:** `B/migration-engine-failure-cases.md` MIG-10, MIG-11 (`e12`, `e3`).
- **Root cause:** `packages/operations/src/locks.ts:88-95` inserts `locks_waiting` on every conflict.
- **Proposed fix:** write once per blocking operation and release the lease silently, or back off; delete the cleanup-migration alternative or allow a bundle that only drops the named INVALID index while the start is open.
- **Acceptance test:** event count stays constant over 10 polls; docs test (link check) of the section.

#### TC-062 [P3] G10.4 `exponetdb.missing_migrations` exists only in the documentation

- **Area:** runtime schema contract (G10 criterion 4)
- **Block:** B (gate map)
- **Reproduction:** `grep -rn missing_migrations packages apps` finds nothing outside docs; `exponetdb-docs/04-migrations/authoring-and-ci.md:164-175` marks it **[PLANNED]**; `exponetdb-docs/04-migrations/ledger.md:148` grants `EXECUTE` on it; `packages/postgres/src/ledger.ts:231-267` creates only guard functions.
- **Expected:** the function exists before the Wave 10 criterion "runtime schema contract active in REOSA health checks" can be met.
- **Actual:** MISSING.
- **Evidence:** `B/gates-g7-g10-evidence-map.md` G10 row 4.
- **Root cause:** not built.
- **Proposed fix:** an additive target-side bundle (`exponetdb.missing_migrations(required text[]) returns text[]`, SECURITY DEFINER with a fixed `search_path`, executable by the application's health role only) installed by the engine's bootstrap; documentation updated from [PLANNED].
- **Acceptance test:** integration test on PG 16/17/18: the function returns the required ids absent from the ledger; unprivileged roles cannot call it; its checksum is part of the ledger-guard set.

#### TC-063 [P3] G10.3 as worded contradicts OD-7b; other gate-row gaps

- **Area:** acceptance gates documentation
- **Block:** B (gate map)
- **Reproduction:** `exponetdb-docs/14-roadmap/acceptance-gates.md:200` (G10 row 3) requires "at least five REOSA migrations applied staging-first, production with evidence", while `exponetdb-docs/13-integrations/reosa-integration.md:70` and `CLAUDE.md` (OD-7b) forbid production applies before Wave 11. Other gaps: G9 row 1 (scheduler) `packages/backups/src/cron.ts:88` `nextRun` is never called, so "backups run on schedule" has no ExponetDB scheduler (R-BKP-3); G8 row 5 `apps/server/test/web-axe.e2e.test.ts:37-69` has no `/t/**` page and omits 8 other routes, `visual-regression.e2e.test.ts:33` baselines only design-system frames (9 of 14 target sections never load in a real browser), root `package.json:21` `test:e2e` omits the design-system build that its own suites need (CI builds it separately); the bare `/infrastructure` redirect (to servers) has no test; G7 row 1 doc rot `05-mcp/protocol-baseline.md:18-24` names three non-existent test files; stale text `owner-test-package.md:193,196`, `information-architecture.md:191`; G10 row 5 the SDK has no `migrations`, `connections`, `backups` or `performance` namespaces although `reosa-integration.md:105-113` uses them.
- **Expected:** gate wording is achievable and the evidence it names exists.
- **Actual:** see Reproduction.
- **Evidence:** `B/gates-g7-g10-evidence-map.md` (G7 row 1, 8; G8 row 5 and routes; G9 rows 1, 3; G10 rows 3, 4, 5).
- **Root cause:** documentation drift and unbuilt pieces.
- **Proposed fix:** owner decision for G10.3 (wording: staging-first with production evidence checked by a plan only until Wave 11); add the missing tests/routes; fix the stale docs; add the SDK namespaces or correct `reosa-integration.md`; make `test:e2e` build the design-system app.
- **Acceptance test:** docs link/symbol check (a test that every test file named in a gate document exists); axe test over a `/t/<p>/<p>/<e>` page and the 8 missing routes; `bun run test:e2e` from a clean checkout passes without a prior design-system build.

#### TC-064 [P3] CLI read polish batch 1 (consistency of output and errors)

- **Area:** CLI usability
- **Block:** C (CLI sweep D7 to D15, D17, D18, D20, D21, D23)
- **Reproduction:** (1) `exponetdb target show reosa/platform/staging` prints `Ledger: unknown` (JSON `ledger: null`) while `migration status` reports 567 applied, mirror in sync; `health`: `Node: unknown`, `Backups: unknown`. (2) `--limit 0` and `server list --limit -1` return one item plus a `Next:` cursor; `target list --limit 10001` is accepted although help says "1 to 10000". (3) unknown filter or id values accepted silently with exit 0: `schema search ... --kinds bogus`, `project list --product nope`, `operation list --kind nope.kind`, `diagnose table-stats <t> --schema nope_schema`, `access bindings --identity idn_000...`, `migration show 01ZZ...` (State `unknown_to_target`), `migration evidence <unknown ULID>`. (4) table values cut with "..." at a fixed width regardless of `COLUMNS` and when piped: `whoami` Scope line, `operation list` TARGET `tgt_01M5J5G1P2QETPENWYHDJ...` (not copyable), `migration evidence` digests, `audit list` SUBJECT. (5) `migration status` lists `legacy:0009_status_rls` but `migration show legacy:0009_status_rls --target ...` fails (`/migrationId must match ^baseline:...`); `migration status` renders 567 vertical records (3,985 lines, unpaged) for staging and a table for scratch. (6) `exponetdb access identities` ends with "2 identitys". (7) `unknown` is used for absent, not-yet-known and not-applicable values (`Evidence from`, `Baseline`, `Applied/Operation/Plan`, `Comment`, `Resolution`, server `Tier`). (8) error typing: `product show prd_xyz` NOT_FOUND exit 1, `project show prj_xyz` VALIDATION_FAILED exit 2, `schema diff reosa/platform/staging fingerprint:sha256:abc` untyped `Error:` while its help promises `fingerprint:sha256:...`. (9) `plan show` of a denied plan prints the plan then exits 4 `PLAN_DENIED` although the read succeeded; wording `allowed/denied` vs `allow/deny`. (10) `target show --timeout 1ms` exits 5 "server could not be reached" (it is the client deadline); a 3,000-character id is echoed in full in the error. (11) timestamps have 6 fractional digits in some commands and 3 in others; relative and absolute forms alternate in `node show`. (12) `approval open|approve|reject` and `cluster credential submit` are catalogued `read` but are interactive flows that wait up to 15 minutes. (13) `finding show <unknown id> --target reosa/platform/scratch` takes 9.3 s (known id 0.5 s). (14) `dev` errors use the lower-case code `lab_not_found` and print twice.
- **Expected:** consistent typed errors, validated inputs, copyable ids, one "unknown" meaning.
- **Actual:** as listed.
- **Evidence:** `C/cli-read-sweep.md` section 3 (D7-D15, D17, D18, D20, D21, D23).
- **Root cause:** not individually traced (shared renderers in `apps/cli/src/output/views.ts`, `apps/cli/src/cli/reads.ts`, `apps/cli/src/cli/args.ts`); (13) probably a client-side page scan.
- **Proposed fix:** one change per numbered item in a "CLI consistency" commit series; add a `GET /findings/{id}` lookup for (13) (U8 follow-up).
- **Acceptance test:** one CLI test per numbered item (exit codes, typed errors, `--limit` bounds, no truncation when not a TTY).

#### TC-065 [P3] CLI read polish batch 2 (scopes, presets, import helper)

- **Area:** CLI presets and safety
- **Block:** C (CLI sweep D16, D19; E11)
- **Reproduction:** `exponetdb migration import scratch-reset-sql --scratch reosa/platform/staging` prints a full in-place reset script headed "reset the scratch target reosa/platform/staging" (only the script's own guard "the database has ledger rows" would stop it; staging has 567 ledger rows; a fresh nonprod target is not protected). `restore runbook` (effect read, generates a script) needs `restore.plan`, only in the `operator:*` presets; `cluster findings` is a diagnose command but needs `backups.read`; `access grants` states no scope; all six presets list `backups.read` as MISSING for the stored session (the session predates it).
- **Expected:** a script that resets a database is only offered for a target registered as scratch; commands name the scope they need; presets match what the commands need.
- **Actual:** as listed.
- **Evidence:** `C/cli-read-sweep.md` (D16, D19), `E/e-findings-local.md` (E11).
- **Root cause:** `apps/cli/src/commands/migration.ts` (scratch-reset-sql target check); `apps/cli/src/presets.ts:20-85`.
- **Proposed fix:** refuse `scratch-reset-sql` unless the target environment is declared scratch; align scopes and presets; print the missing scope on every `INSUFFICIENT_SCOPE`.
- **Acceptance test:** CLI test: `scratch-reset-sql --scratch <non-scratch>` is refused; a preset matrix test that every read command's declared scope is in at least one preset.

#### TC-066 [P3] Web polish batch (W-04, W-06 to W-11, W-13 to W-15)

- **Area:** Web App
- **Block:** C (Web audit)
- **Reproduction:** (W-04) `/t/reosa/platform/staging/migrations`: Applied 567, Verified 539, Not verified 0, Failed 0: 28 `superseded` rows appear in no counter (`apps/web/src/features/migrations/history-model.ts:152-156`, `migrations-page.tsx:165-206`). (W-06) focus `main`, Ctrl+K, Escape: `document.activeElement` is BODY, the dialog has no `aria-modal` (`packages/ui-patterns/src/command-menu` has no `onCloseAutoFocus`). (W-07) `/t/reosa/platform/staging?connect=app`: tab labels run together (".env fileNode.js (pg)Python (psycopg)Go (pgx)") and ".env file" is first visually but last in the DOM (`apps/web/src/features/connect/target-connect-sheet.tsx` `Templates`, about line 503; screenshot `mcp-claude-in-chrome-blob-1793133869911-kxsvq5.png`). (W-08) wrong plurals "1 projects", "1 clusters on this server are not retired", "1 nodes of this server are not decommissioned", "1 active endpoints" (`apps/web/src/lib/i18n/messages/projects.ts:31`, `.../infrastructure.ts:28,29,52`; no `Intl.PluralRules`). (W-09) raw identifiers as labels: `control_store`, `data_reads`, `audit_chain` (`features/fleet/control-plane.tsx:66-72`), finding kind/code (`features/findings/findings-page.tsx:216-217`), plan "Change" column `node.decommission`, `access.identity.erase`, `TARGETS.READ` on `/access/roles`. (W-10) document titles: unknown target and invalid slug "Overview · ExponetDB" over a "Page not found" body, all five account tabs "Your account", detail pages only the section (`apps/web/src/app/title.ts:28-31`, `routes/_app/account.tsx:6`). (W-11) `/access` and `/settings` render "Page not found" while `/infrastructure` redirects (no index routes). (W-13) `/audit` shows "2026-10-27 20:45 UTC" in the chain line and "27 Oct 2026 21:33:36" (browser-local, no zone) in events. (W-14) `/t/.../performance` says "pg_stat_statements is not installed or not preloaded" while the server answered 409 `CAPABILITY_UNAVAILABLE` with a different text (see the query_stats entry). (W-15) `/audit` at 1920x945: chain panel plus ten filter fields fill the first screen, the first event is below the fold.
- **Expected:** counters add up, focus returns, readable labels, correct plurals and titles, redirecting section roots, consistent time format.
- **Actual:** as listed.
- **Evidence:** `C/web-audit.md` section 6.
- **Root cause:** as cited per item.
- **Proposed fix:** one small change per item; add a plural helper over `Intl.PluralRules` to the message catalog and use it for every count message.
- **Acceptance test:** web unit tests per item (counter sum equals total, focus restored after Escape, plural catalog test, `title` test per route including not-found, redirect tests for `/access` and `/settings`).

#### TC-067 [P3] Web audit coverage gaps (not defects)

- **Area:** test evidence
- **Block:** C
- **Reproduction:** the owner's Chrome window was maximized, so `resize_window` had no effect (viewport stayed 1920x945); 1440 and 390 checks used a script-driven same-origin popup (DOM measurements only, no screenshots) and 390 visual layout is unverified; not reached: `/approvals#operation=`, `/targets/register` submit paths, `/credentials`, `/step-up`, OAuth consent/device, invite/recover/setup, migrations timeline/promote/import views, project Connect with `&environment=`, the 1,000-row promotion case; the "audit first page with cursor and no items" and "cut role-binding list" states could not be forced read-only.
- **Expected:** every rail page at 1440 and 390 px with screenshots.
- **Actual:** see Reproduction. The repository's own phone tour (`web.e2e.test.ts` "fits a phone at 390x844", PASS on the pinned toolchain) covers the shell only.
- **Evidence:** `C/web-audit.md` section 0 and 7.
- **Root cause:** tooling limit of this campaign.
- **Proposed fix:** extend the phone tour and axe tests to every rail page and the target sub-pages (see the gate-map G8.5 entry).
- **Acceptance test:** `web-axe.e2e.test.ts` and the phone tour list every route of `lib/navigation`.

#### TC-068 [P3] Downgrade rule in runbook §8 is imprecise; the real downgrade hazards are undocumented (GAP-04)

- **Area:** node-runbook.md §8/§9
- **Block:** D (upgrade 0.6.0 to 0.7.0 PASS; downgrade PASS)
- **Reproduction:** a node enrolled with a 0.6.0 build (commit `1819998e`), upgraded to 0.7.0 and used (12 journal jobs), downgraded to 0.6.0: the older agent accepts the journal and ledger unchanged (17 jobs, effects ledger prefix byte-identical, an effect succeeded). `git diff 1819998e d0229550 -- agent/node/internal/journal agent/node/internal/state agent/node/internal/clock` is empty. Real hazards: a `config.json` with the 0.7.0 field `pgbackrestConfig` makes the 0.6.0 agent and helper refuse to start (`configuration: json: unknown field "pgbackrestConfig"`, agent crash loop, node offline); 0.7.0-only capabilities (`backup.timers@1`) answer `CAPABILITY_UNAVAILABLE`. Upgrade: journal, nonce and ledger prefixes byte-identical, a job queued during the swap completed 2 s after the agent started.
- **Expected:** the runbook says which release introduced journal format 2 and what a downgrade really needs.
- **Actual:** "from the first job on, an older agent refuses every job with `journal_corrupt`" is true only for releases before the F7 correction (not tested: no pre-F7 binary).
- **Evidence:** `D/gap-scenarios.md` GAP-04; `D/gap-scenarios/03-upgrade-060-070.txt`, `04-downgrade-070-060.txt`.
- **Root cause:** documentation; config loader strictness.
- **Proposed fix:** runbook §8/§9 name the release that introduced format 2, state that 0.6.0 and 0.7.0 share it, and warn about `pgbackrestConfig`; or accept unknown config fields with a warning in the agent.
- **Acceptance test:** docs review; a Go test that a 0.7.0 config is either documented as not loadable by earlier releases or accepted with a warning.

#### TC-069 [P3] A refused clock reads as "job expired" on the control plane; `clockSkewMs` is not a clock-health signal (GAP-05)

- **Area:** node runner error mapping, heartbeat
- **Block:** D (clock scenario: agent PASS, helper PARTIAL)
- **Reproduction:** `timedatectl set-ntp false; date -s "+45 seconds"` (kernel maximum error 16 s), then any inspection: the node answers the signed rejection `clock_untrusted` (journal line `job rejected ... clock_untrusted`, no effect, helper ledger unchanged); recovery is immediate with `timedatectl set-ntp true`.
- **Expected:** the control plane shows the clock as the cause.
- **Actual:** the operation ends `failed / not_applied`, `errorCode JOB_EXPIRED` "The job was not claimed before it expired."; the node stays `active`, `clockSkewMs: 0` (control plane and node share one clock in the test), `lastErrors: []`.
- **Evidence:** `D/gap-scenarios.md` GAP-05; `D/gap-scenarios/05-clock.txt`.
- **Root cause:** `packages/nodes/src/runner.ts:400-416` maps `clock_untrusted` to `JOB_EXPIRED` (documented in `control-plane.md:363` but the message is wrong).
- **Proposed fix:** keep the code, add `detail.reason = clock_untrusted` and a message naming the host clock; put `clockSynchronized` in the heartbeat and show the node `degraded` while false.
- **Acceptance test:** host scenario step "unsynchronized clock": the operation's `detail.reason` is `clock_untrusted` and the node view shows the clock condition.

#### TC-070 [P3] Disk full on the agent state or the helper ledger: silent stall, torn ledger record, undocumented restart (GAP-06, GAP-07)

- **Area:** node agent and helper robustness, RB-13
- **Block:** D (disk full scenario: fail-closed PASS)
- **Reproduction:** 16 MB ext4 loop mounted on `/var/lib/exponetdb-node` and filled: the agent cannot store or sign the statement, the job stays `dispatched`, logs "job delivered again" every minute, every other operation of the node waits behind it and after the window (5 min for reads) fails `NODE_CAPABILITY_FAILED`; the node stays `active`, the only trace is free text in `heartbeat.agent.lastErrors`; recovery without restart once space is freed, journal prefix byte-identical. Helper ledger (3730 bytes, next 373-byte record crosses a 4 KiB block) with the filesystem full: the helper refuses (`the effect ledger is broken`, nothing applied) but `effects.log` grows to 4096 bytes with a torn partial record, and the helper refuses every effect until `systemctl restart exponetdb-node-helper` (which drops the torn tail); the refused operation spent minutes in `needs_reconciliation / OUTCOME_UNKNOWN` before `not_applied`.
- **Expected:** a typed answer, no latch, a documented recovery.
- **Actual:** see Reproduction; runbook §8 covers only a lost ledger.
- **Evidence:** `D/gap-scenarios.md` GAP-06, GAP-07; `D/gap-scenarios/06-diskfull.txt`.
- **Root cause:** `agent/node/internal/agent/statement.go:57-65` (`commit` leaves the job open by design); helper ledger append without truncation back to the last good offset.
- **Proposed fix:** report `agent_state_unwritable` in the heartbeat (node `degraded`) so the control plane fails the operation at once; helper `ftruncate` to the last good offset on a failed append (no latch); runbook RB-13 "disk full" paragraph (free space; restart the helper if it latched).
- **Acceptance test:** host scenario with a 16 MB loop mount: node `degraded` within one heartbeat, the next operation after freeing space succeeds; helper Go test on a size-limited filesystem: after ENOSPC and freeing space the next effect succeeds without restart and the ledger chain verifies.

#### TC-071 [P3] hba refusals carry `OUTCOME_UNKNOWN`; removing the managed block leaves an empty marker pair; job-key activation accepts a stale proof (GAP-08 to GAP-10, GAP-12)

- **Area:** node capabilities hba and job keys, agent hello
- **Block:** D (hba PASS on markers and foreign lines; job keys PASS on the unsafe half)
- **Reproduction:** (GAP-08) plans `local all all reject` (the agent's own access) and a `hostssl ... reject` above a requested `protectedAccess`: plan time 201 with no warning; apply time refused on the host, previous file restored (sha256 unchanged, `psql` still connects), operation `failed / not_applied` but `errorCode OUTCOME_UNKNOWN` (steps `execute failed`, `reconcile succeeded`). (GAP-09) `managedRules: []` leaves `# BEGIN EXPONETDB MANAGED BLOCK` and `# END EXPONETDB MANAGED BLOCK` at the top of `pg_hba.conf`. (GAP-10) K2 added to agent and helper (proof recorded), the helper's `helper-trust.json` replaced by the K1-only copy and the helper restarted, then `job-key activate` exits 0; every effect signed with K2 is then refused by the helper (`job_invalid ... unknown_signing_key`), nothing applied. (GAP-12) after fixing `pg_ident.conf` for an already running agent the node keeps `clusters: []` and every inspection fails `REGISTRY_CONFLICT cluster_unmapped` until `systemctl restart exponetdb-node` (the hello announces clusters once per agent start; the heartbeat sends none).
- **Expected:** refusals name the lockout (`hba_lockout`); an empty rule list removes the markers; activation requires a fresh proof; clusters refresh.
- **Actual:** see Reproduction. Stale and foreign-edit plans give `PLAN_STALE`, a replayed applied plan is idempotent, foreign lines are kept byte for byte (PASS).
- **Evidence:** `D/gap-scenarios.md` GAP-08 to GAP-10, GAP-12; `D/gap-scenarios/07-hba.txt`, `08-jobkeys.txt`.
- **Root cause:** `agent/node/internal/capabilities` hba apply error mapping; hba block writer; `job-key activate` uses a stored proof without an age bound; `agent/node/internal/agent/agent.go:417` (hello) and `:510` (heartbeat `Clusters: []`).
- **Proposed fix:** typed `hba_lockout` error code; drop the markers for an empty list (or document); require a proof younger than a few minutes or take a fresh `agent.diagnostics` inside `activate`; refresh the cluster list on a heartbeat interval (this also fixes the node view finding).
- **Acceptance test:** extend `hba.host.test.ts` (code `hba_lockout`, file equals the original after removal) and `job-keys.host.test.ts` (step "helper copy reverted after proof": activation refused); a host test that a new cluster appears in `GET /nodes/{id}` without an agent restart.

#### TC-072 [P3] Hardening observations of the node units (GAP-13)

- **Area:** systemd unit hardening
- **Block:** D
- **Reproduction:** `systemd-analyze security exponetdb-node.service exponetdb-node-helper.service`: agent 1.7 OK, helper 1.9 OK; capabilities of the running agent all zero, `NoNewPrivs 1`, `Seccomp 2`; the three private seeds do not appear in unit journals, `status`, `ps` or the environment; state files 0600 owner `exponetdb-node`, helper files 0600 root, helper socket 0660 `root:exponetdb-node`.
- **Expected:** n/a (no exposure found).
- **Actual:** remaining optional knobs: helper `UMask=0077`, `ProtectProc=invisible`/`ProcSubset=pid` where the process checks allow, `ProtectClock=yes` on both.
- **Evidence:** `D/gap-scenarios/09-hardening.txt`.
- **Root cause:** n/a.
- **Proposed fix:** add the knobs after a host scenario run proves nothing breaks; optional.
- **Acceptance test:** `verify-units.sh` asserts the added directives; host scenarios stay green.

#### TC-073 [P3] `-- covers:` in `verify.sql` counts statements from 0 and the documentation never says so (E8)

- **Area:** migration lint, verification docs
- **Block:** E (E8)
- **Reproduction:** project `acme/demo`, bundle with three `INSERT` statements (indexes 0, 1, 2); `-- covers: 0,1,2` -> no warning; `-- covers: 1,2,3` -> `uncovered_statement` (level `warn`, blocking at the default prod tier, exit 1) for statement 0; out-of-range indexes are silently accepted.
- **Expected:** the docs say "counted from 0"; the message names the index; out-of-range entries are flagged.
- **Actual:** none of these.
- **Evidence:** `E/e-findings-local.md` E8.
- **Root cause:** `packages/postgres/src/parser/verify-checks.ts:78-95` (entries as strings), `packages/migrations/src/lint/lint.ts:867-872` (`covered.has(String(s.index))`, 0-based, comments not counted); docs `04-migrations/verification.md:159,361` and `migration-bundles.md:440`; `rules.ts:272`.
- **Proposed fix:** docs "statement index = position of the top-level statement in `up.sql`, counted from 0, comments and empty statements not counted" with a self-contained example; put `statement index N (counted from 0)` and the line into the `uncovered_statement` message; add rule `covers_out_of_range` (warn).
- **Acceptance test:** `packages/migrations/test/lint.test.ts`: three-statement bundle: covers `0,1,2` -> no finding; `1,2,3` -> `uncovered_statement` containing `statement 0` and `from 0` plus `covers_out_of_range` for `3`; a docs test asserts `verification.md` contains "counted from 0".

#### TC-074 [P3] CLI presets and declared scopes do not match what the commands need (E11)

- **Area:** CLI presets, scope declarations
- **Block:** E (E11 PARTIAL: `nodes.plan` is in `operator:nonprod` and `operator:prod`)
- **Reproduction:** read `apps/cli/src/presets.ts:20-85`: `nodes.plan` is not in `read`, `developer:*` or `admin` (admin has `registry.manage` but not `nodes.plan`); `--preset` cannot be repeated; `auth presets` truncates the scope column; five `cluster` commands declare `nodes.read`/`nodes.plan` while the server needs `registry.manage` (`apps/cli/src/commands/registry.ts:933,968,1002,1318,1422`). The README preset table matches `presets.ts`.
- **Expected:** a preset exists for node operations and the declared scopes equal the server's.
- **Actual:** an operator who needs node plans and admin must pass an explicit `--scope` list.
- **Evidence:** `E/e-findings-local.md` E11 (matrix).
- **Root cause:** as cited.
- **Proposed fix:** add `nodes.plan` (and `restore.plan`, `backups.run` where admin operates backups) to `admin` or introduce `fleet:nonprod`; allow repeated `--preset` as a union (`auth.ts` `presetFrom`); wrap the SCOPES column; fix the five declared scopes.
- **Acceptance test:** `apps/cli/test/presets.test.ts`: for every remote `CommandSpec` with a fixed server scope `spec.scopes` equals the action's scope; node management (`node enrollment create` plus `node inspect`) is covered by at least one preset; `auth presets` at 120 columns prints `nodes.plan` in the operator row without truncation.

#### TC-075 [P3] Reboot state reporting, unit hardening and polish of the backup runs (D-11, D-12, D-13)

- **Area:** node helper supervision, units, messages
- **Block:** D (T-NODE-1, T-NODE-2)
- **Reproduction:** (D-11) `systemctl reboot` mid-run: the run ends `failed` with "stopped on a cancel request" although no cancel was made (`agent/node/internal/helper/engine.go:345`, `ops_backup.go:311`); the docs (ADR-0037 sections 2 and 4, T-NODE-2) say `lost`; a hard reset leaves `starting` for 121 s (`startGrace`, `ops_backup.go:305`) then `lost`; for `failed` the Control Plane does not take the `needs_attention` path the ADR table prescribes. (D-12) `ReadWritePaths` holds the repository, log and spool for every unit including restores and read-only `info`; no `IPAddressDeny` (documented residual R-NODE-3); `RestrictAddressFamilies` and `SystemCallFilter` unset; run records accumulate (99). (D-13) "does not allow a incremental backup run" (`ops_backup.go:794`); for about 30 s after boot the helper refuses every job as `job_invalid` while the clock is not yet synchronized (a distinct `clock_untrusted` would save an incident); control-plane polling makes a 3 s run cost about 35 s.
- **Expected:** documented states and tight units.
- **Actual:** as listed. Passing: cancel ends `failed` as documented, run records are root-owned, helper kill and agent plus helper kill recover, nothing restarts by itself.
- **Evidence:** `D/backup-restore-e2e.md` D-11 to D-13.
- **Root cause:** as cited.
- **Proposed fix:** write a distinct outcome text for a systemd stop ("host shutdown") and document it, or make shutdown `lost`, and shorten the grace when the boot id changed; read-only repository for reads and restores; `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`; record retention; fix the grammar.
- **Acceptance test:** a host test with `systemctl reboot` mid-run asserts the documented state; `verify-units.sh` asserts the tightened directives.


## 5. Suggested order of work

One branch, one pull request, but commit per finding (or per tight group) so the owner can review and revert pieces. Work in this order; stop and ask the owner (open decision) where a finding says "owner decision".

1. **Hostile-input and engine blockers (P1):** the single-quoted `DO` body bound, the quadratic `search_path` regex (both in `packages/postgres`), then the operations/migration engine P1s (a `needs_attention` operation that blocks the target for ever, the out-of-band change adopted into the drift baseline, a dangling stored bundle poisoning the project, `ledger.reconcile`). Each with its regression test first.
2. **Plan visibility and the CLI dead ends (P1):** `plan show` must return the change content for the `postgres.*` node plans; config and roles plans must be creatable from the CLI.
3. **Truthfulness of reads and errors (P2):** failed list reads print no empty body; typed errors that name the cause (`query_stats`, dependency ids, `sql_query` qualification, node plan errors); node view clusters; the findings/advisor/drift recording and counters (needs OD-57).
4. **Node agent and runbook (P2/P3):** fresh-host enrollment (tmpfiles, runbook steps, token path), certificate expiry visibility, clock and disk-full signalling, hba refusal codes, then the documentation of the downgrade rule.
5. **Test and CI wiring (P2/P3):** run `pglab` and `runbook.lab.test.ts` in CI, close the "regression test pending" rows, selection and 500-chain tests, time-zone-proof tests, toolchain check, platform-safe visual baselines.
6. **Web polish and CLI polish batches (P2/P3).**
7. **Docs and gates last:** update `PRE-WAVE-11-REVIEW.md` (new section), `gates/6.md` (E16/E18/E25 rows), `gates/9.md`, `acceptance-gates.md`, `test-strategy.md`, `open-decisions.md`.

### Owner decisions this campaign needs (do not decide them silently)

- **OD-57** (advisor and drift runs record data under a read scope): classify as record actions or keep read-only and stop recording. Affects the advisor/drift finding.
- **E16 and E18 waivers** (`gates/6.md`, expiry "before the first import of real REOSA data (Wave 10)"): the live staging target already carries 555 `legacy_import` ledger rows from the OD-7a import; is that "real data" and must detection exist before more imports?
- **G10.3 wording** versus OD-7b (production applies before Wave 11).
- **Step-up for enrollment**: one combined step-up for plan apply plus token reveal, or longer receipts.
- **Plan withdrawal scope** for node plans and whether withdrawing a revoke plan may need a fresh passkey.
- **Node certificate expiry warning thresholds** (proposed: warning 12 h before expiry without renewal).

### Things for the owner to look at now (not work for the fix session)

- Operation `op_01M5X74EJ0CD4BYGRZ9DM1KZYA` (`access.identity.erase`, target identity `idn_01M4H5XZ12G122Q9MCZHT5QKMA`) is `awaiting_approval` with a live approval URL although its plan was consumed and expired about 20 hours before the campaign. Decide whether it should be canceled.
- The live node certificate expires **2026-10-30T05:57:35Z**; the gateway asks for renewal from **2026-10-29T05:57:35Z**. Renewal was proven working on a disposable host with the real certificate (23 h left renews in under 1 s). An agent that is down for the whole window needs RB-13; nothing warns before the window closes.
- The campaign changed live state in two documented ways: advisor runs (`exponetdb diagnose advisors`, MCP `advisors_run`) recorded findings (staging 0 to 215 open advisor findings, scratch +228 to 13,968 total) and 10 node plans (reload x3, restart x2, hba x2, an extension no-op, revoke, decommission) were created and left to expire unapplied (withdrawing them was refused for scope reasons; the last one expired by 20:34 UTC on 2026-10-27; nothing was applied anywhere). One `auth.login` web event at 20:11:27Z coincides with the Web audit opening your signed-in Chrome.


## 6. What could not be run, and why

"NOT RUN" is an answer only with its reason and what it would take. Rows come from the
lead and from every tester's "not checked" list.

| Item | Reason | What it would take |
|---|---|---|
| T-S3-1 to T-S3-8 (object lock on Hetzner Object Storage and Cloudflare R2: delete and overwrite refused, expiry with locks, versioning, restore from each bucket, costs) | needs disposable buckets with Object Lock created in the providers' consoles and writer-shaped credentials; outside the campaign's allowed resources (only Hetzner servers) | the owner creates the buckets (`W9-03` experiment plan) or authorizes bucket creation; about half a day; findings feed OD-4-storage |
| A passing drill through the Control Plane with a measured RTO, and the Control-Plane level `RESTORE_TARGET_MISMATCH`, `scratch_exists`, `PLAN_STALE`, `RESTORE_SOURCE_INVALID` refusals | blocked by the P1 drill defects (`latest`/`older` fail, `amcheck not_run` fails every drill); the backup run was also cut by a session restart | after the drill fixes: rerun the scenarios `zz-backup-e2e*.host.test.ts` in `D/backup-restore-e2e/host-tests/` on a disposable systemd host (about 90 min) |
| Wrong-passphrase test of the pgBackRest runbook, S3 repositories, the owner's real pgBackRest setup (T-ADV-1), T-RET-1 (retirement blocked by a live repository, end to end) | needs the owner's real repository (read-only adoption) or provider buckets; T-RET-1 needs a disposable server plus cluster with a live repository | owner provides read access or accepts a disposable equivalent |
| `mcp:evals` model layers B to D | needs `EXDB_EVAL_ANTHROPIC_API_KEY` of the owner (14 tests report NOT RUN) | the owner's key; about 20 min and token cost |
| Three real MCP clients (G7 criterion 13), OAuth sign-in in a real client | owner steps | owner test package section C |
| `apps/cli test:install`, `test:lab` and `apps/server test:lab`, Go bounded fuzzing, `govulncheck` | the lab and install suites need Node 24 plus Docker lab and an owner browser; govulncheck needs the vulnerability database | one more disposable server run (about 40 min); not done to stay within the box |
| Web App at 1440 and 390 px with screenshots | the owner's Chrome window was maximized, so `resize_window` had no effect; 1440/390 checks were DOM measurements in a script-driven popup | a Playwright run with the owner's passkey session, or a dedicated browser profile |
| Web states: `/approvals#operation=`, register submit paths, OAuth consent and device pages, invite/recover/setup, migrations timeline/promote/import views, the 1,000-row promotion case, "audit first page with cursor and no items", "cut role-binding list" | not reachable read-only or need mutations | seed a lab with those states |
| Cross-browser (Firefox, Safari), Lighthouse, reduced-motion on the live installation | out of the live read-only reach of the tooling used | Playwright matrix in CI |
| Live control-store read (`nodes.nodes.clusters` on the live node) | the read-only SSH `psql` was denied by the session's permission layer; not worked around | an owner-added permission rule, or an owner-run query |
| Live migration lifecycle on `reosa/platform/scratch` (plan, apply, failing verify, revision, drift, lock timeout, nontransactional, rollback) | planning fails on the live project with `MIGRATION_DEPENDENCY_UNKNOWN` (finding), and applying the 12 stored REOSA bundles would consume the owner's rehearsal state | fix the planner finding; then rerun on scratch; the failure cases ran at engine level against disposable PostgreSQL instead |
| Real PITR for E25, real break-glass for E16, HTTP/CLI layers and PostgreSQL 16/17 targets of the migration failure cases | simulated at engine level (the tester said so) | rerun on a lab with a real restore and a configured notification channel |
| Apply-time behavior of live node plans (hba lock-out revert, restart, TLS name check) | applying anything to the live node is forbidden; the disposable-host scenarios cover the apply-time hba refusal | n/a (by rule) |
| Node: pre-F7 agent binary for the downgrade claim, the lab gateway's own 72 h certificate (4d), a skewed gateway clock for `clockSkewMs`, the end of the reboot reconciliation of an in-flight restart | no such binary available; time-travel limits; the tester's time box | one more disposable host session (about 60 min) |
| Approve/reject/open, `cluster credential submit`, every effect `plan`/`mutation`/`session` CLI command on the live installation | forbidden by the campaign rules | n/a |
| Staging-side statistics (`pg_stat_statements` reset deltas) and the live `connections.cancel`/`terminate` | the extension is not installed on the live targets and node plans for it cannot be made from the CLI (findings) | after those fixes |
| CI result at `d0229550` | no network call to GitHub Actions was made | read the run of PR #43 |

## 7. Rules for this fix session (they override anything you infer)

These come from the campaign brief (§0) and from `CLAUDE.md`; where they differ,
`CLAUDE.md` and the constitution win.

- Work in the repository `/home/david/Development/ExponetDB`. Start from
  `origin/main` (check `git fetch origin`; the campaign tested `d0229550`).
  Create **your own worktree and branch** (`git worktree add ../ExponetDB-testcampaign-fixes -b fix/test-campaign-2026-10-27 origin/main`);
  never work in the main checkout and never reuse another session's worktree.
  One branch, **one pull request**.
- **Commits** are authored as `𝕏0L0™ <davdxpx@gmail.com>`
  (`git -c user.name='𝕏0L0™' -c user.email='davdxpx@gmail.com' commit …`). Claude is
  never the author or co-author: **no** `Co-Authored-By` trailer, **no** session
  link, **no** "Generated with" line. At the end of a commit body or the PR
  description at most `Developed by @davdxpx`. Conventional Commits
  (`fix:`, `feat:`, `docs:`, `test:`), atomic: code, tests and docs of one
  fix in one commit. Commit and push after every finding; no "commit later".
- **Tests first for every fix** (red, then green). Never skip, disable or
  quarantine a test to get green. Tests that need PostgreSQL run against real
  PostgreSQL (`bun run dev:control-store`, `bun run dev:targets`; use your own
  container names and ports, other sessions share the machine).
- **Do not merge and do not redeploy.** The owner does both on request. Do not
  change Coolify settings or environment variables, do not touch the live
  installation `https://db.exponet.cloud` (reads only if a finding's
  acceptance test says so), never apply anything to `reosa/platform/staging`
  or `reosa/platform/scratch`, never touch Supabase (REOSA production
  `zmlegaporyathnfvnbrv` is out of scope), never change the REOSA repository.
- **Frozen things stay frozen**: `c1`, `ls1`, `fp1`, plan-hash construction,
  golden vectors (append-only), and every frozen Control Store bundle. A
  change of stored behavior is a new, additive bundle (and the next free ADR
  number if a decision is needed). `bun run golden:check` and
  `bun run golden:history origin/main` must stay green.
- **Documentation first**: every behavior change updates its document in the
  same commit. **Update the gate and review documents you touch**:
  `exponetdb-docs/14-roadmap/PRE-WAVE-11-REVIEW.md` (add a section
  `## Test campaign fixes – Parallel Session`, never edit another session's
  section), the gate records (`gates/6.md` waiver table for E16/E18, `gates/9.md`,
  `gates/9-part-a.md`), `acceptance-gates.md` where a criterion's evidence
  changed, and `exponetdb-docs/00-product/open-decisions.md` for every open
  owner question (never decide an owner question silently; use the
  existing OD numbers or add the next free one).
- **Secrets**: never print, log, commit or store a secret, token, password,
  verifier or connection string with a password. Fixtures use obviously fake
  values.
- **Scope**: fix what a finding says, in the smallest correct change, and
  nothing else. Findings marked *owner decision* get the decision recorded as
  an open decision with the options and your recommendation, and get no silent
  implementation. If a finding turns out to be wrong, say so with evidence in
  the finding's row of the PR description and the review document; do not
  "fix" it anyway.
- **Verification before the PR**: `bun run verify` (all parts), plus the
  finding-specific acceptance tests below, plus `bun run go:test` and, for the
  node agent, the host scenarios on a disposable systemd host (not on
  `reos-db-01`). Report what you could not run.
- English (US spelling) for code, identifiers, documentation and commit messages.
