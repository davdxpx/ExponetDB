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

Findings: **{{TOTAL}}** ({{COUNTS}}). No P0 (no data loss, no secret exposure and no
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

{{BLOCKTABLE}}

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
