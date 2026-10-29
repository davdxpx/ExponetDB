# ExponetDB verification campaign of 2026-10-28: findings and the fix session

You are the fix session of a verification campaign. A test lead and twenty tester agents
tested ExponetDB at `origin/main` `d51da5d0` (the merge of the fix pull request #46 for the first
campaign of 2026-10-27), as an **independent second pair of eyes**, to answer one question for the
owner: **can REOSA's production database be managed by this system (Wave 11) without surprises, and
what stops that today?** This file is the result. Read it completely, then fix the findings in
section 4 in the order of section 5, in your own worktree, as several pull requests, under the rules
of section 7 (they override anything you infer). The campaign did not authorize Wave 11; it gives
the owner evidence.

Everything claimed here has evidence under
`exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/` (folders `R` fix verdicts, `A` suites,
`B` bundle system, `C` operations, `D` security, `E` structure, `F` sources of this prompt and the
readiness scorecard). Findings carry the exact reproduction, the suspected root cause with `file:line` at
`d51da5d0` (lines have moved since: `main` is at least at `c89bbe1a`; re-read before editing), a proposed fix
and an acceptance test. Where a finding says "owner decision", record an open decision instead of deciding.
Findings that other agents filed twice are merged (`F/merge-notes.md`); findings of the first campaign that are
still open are not repeated (see `R/verdicts.md`).

## 1. Summary

Findings: **{{TOTAL}}** ({{COUNTS}}). **No P0 by the brief's definition** (no data loss, no secret exposure, no
way found to change production without the gates). Two P1s are outage-class and the owner may count them as P0:
a holder of the plain `migrations.plan` scope can fill the Control Store disk until PostgreSQL PANICs, with rows
that cannot be deleted (VC-001), and one allowlisted `sql_query` can make the kernel kill a backend and restart the
target PostgreSQL (VC-002).

The headline results:

- **The answer to the question is: not yet.** Of thirteen Wave 11 preconditions (`F/readiness.md`), three are
  PASS (verification order, secrets in the tested sinks, backups and ledger readable without ExponetDB), ten are
  FAIL; none is UNPROVEN, but section 6 lists what was not run.
- **What is good, with evidence:** the single-writer lock, atomicity of a bundle (47 statement cases), the order of
  applied and verified, the audit chain, no secret in 15 sinks (136 canaries), containment of host-reaching
  statements, a fast and exact restore engine (7.6 GB: full 19 s, PITR 40 to 57 s, drills with a product RTO equal
  to the stopwatch within 1 s), an upgrade that loses nothing going forward (three runs of 18 to 19 s), all 18 CI jobs
  green on the commit under test, and a dress rehearsal on a 4.4 GB Supabase-like schema (306 tables, 150 hostile
  history files) through import, baseline, plan, apply under pgbench load, drift, PITR, reconcile, promotion and replay.
- **Where the proof can pass falsely:** a restore drill and `backup.verify` both pass while committed data is
  missing when the newest archived WAL segment is deleted or corrupted (VC-004, VC-005).
- **Where one operation can wedge the installation:** `needs_attention` has no exit outside four migration kinds and keeps the
  target's schema lock (VC-006, VC-007); one blocked operation starves every younger one (VC-008, confirmed on the stack);
  a clock step leaves the audit chain refusing every event (VC-003).
- **Where the runbooks promise what the code does not deliver:** the one-release upgrade rollback is impossible (VC-009), RB-10
  step 6 is empty for managed targets (VC-010), RB-14 cannot be executed (VC-011), and `CREATE TABLE ... (id serial ...)` can never
  be applied (VC-016).
- **The fix of the first campaign:** 86 rows verified (`R/verdicts.md`): 31 FIXED, 13 PARTIAL, 8 CHANGED BY DECISION, 34 NOT FIXED; all
  13 P1s of the first campaign are fixed or partly fixed (11 and 2), no regression test is vacuous, one fix introduced a
  regression (the TC-019 change makes planning a node revoke answer 500 while an active plan body holds an escaped NUL).

### Verdict per block

| Block | Scope | Verdict | One line |
|---|---|---|---|
| R | the 75 findings and the eleven E findings against `d51da5d0` | **PARTIAL** | 31 fixed, 13 partial, 8 by decision, 34 not fixed; fails-before checked for every fixed finding; one regression introduced |
| A | automated suites on the pinned toolchain | **PASS** with findings | all 18 CI jobs green; unit 10,383 and integration 1,716 tests, no drop; the only new skip is the prescribed one; `main` has no branch protection; tests depend on in-file order; `mcp:evals` NOT RUN |
| B | the bundle system as a contract | **FAIL** | contract: 29 documented-versus-implemented differences; 817 executable cases (769 pass, 48 fail, each a finding); I2 and I15 PASS, I9 and I14 FAIL, the rest PARTIAL; I10 replay explained; failure matrix 31 cells (27 pass, 4 partial, 0 fail, nothing re-executed); the planner's risk text is wrong both ways |
| C | operating it every day | **FAIL** | forward upgrade PASS, rollback impossible; Control Store restore works but RB-10 step 6 and RB-14 do not; backups measured at 7.6 GB; fail-closed answers 500 INTERNAL instead of typed errors; observability cannot alert on most failures |
| D | security and abuse | **PARTIAL** | no P0: canaries clean, 3,377 authorization requests with no allow where deny expected, agents cannot approve, 15 of 18 hostile bundles denied at plan time; the SQL frame holds but two P1s surround it; SSRF/network NOT RUN or reviewed statically |
| E | structure and systems | **done** | `E/structure.md` (ranked weaknesses), `E/proposals.md` (15 proposals `[OPEN]`), state machines, vocabulary, error audit, 72 doc claims (17 violated), recoverability paths |
| F | readiness scorecard | **FAIL** | `F/readiness.md`: 3 PASS, 10 FAIL against the thirteen Wave 11 preconditions, and the list of what must be true before production |

Verdict meanings: PASS, FAIL, PARTIAL, NOT RUN (the block's own rows say which).

### Findings per block and severity

(Block = the block of the first test that found it.)

{{BLOCKTABLE}}

## 2. Campaign facts

- **Tested commit:** `origin/main` `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of #46 on 2026-10-28, parent of the later
  `c89bbe1a`); the pre-fix commit of the first campaign is `d02295503bcfb7a4a4baea860bd9fceebe80b8b4`. The campaign changed nothing in
  the repository; `R/baseline.md` records the diff, the three new additive Control Store bundles (two `SECURITY DEFINER` functions and a
  replaced guard function) and that no frozen file, golden vector or c1/ls1/fp1/plan-hash code changed.
- **Live installation** `https://db.exponet.cloud`: three side-effect-free reads only (`auth status`, `node list`, `node show`), to confirm that the live
  node's certificate renewed itself on 2026-10-29 (new expiry 2026-11-01). No plan, advisor run, apply or approval; nothing on
  `reosa/platform/staging` or `scratch`, `reos-db-01`, Supabase or Coolify; no secret printed. One agent's session token was refreshed by the CLI
  (normal use).
- **Disposable infrastructure (all deleted, ids in `D/hetzner-resources.md`):** three Hetzner `cx33` servers (Ubuntu 24.04, label
  `purpose=exponetdb-test-campaign`; ids 173160021, 173160183, 173160258) and one throwaway SSH key (131905335); local Docker containers
  and images were removed by the testers. Only the pre-existing `reos-db-01` (169416658) was left untouched.
- **Method:** the lead and twenty tester agents with narrow scopes (fix verdicts R1 to R3, suites A, bundle contract B1, conformance B2,
  DDL hazards B3, security review of the three new bundles D0, authorization D1, SQL execution D2, structure E1 and E2, static operations C1,
  stack S1 to S7). The lead re-checked the load-bearing claims in the code before filing them; where a sub-agent could not write its
  findings the lead filed them (`F/merge-notes.md`). Raw logs and large generated data are not in the repository.
- **Toolchains:** pinned replica Node 24.22.1, Bun 1.4.4, Go 1.26.10, Ubuntu 24.04, UTC, PostgreSQL 16.15/17.11/18.6, pgBackRest 2.60.0,
  restic 0.16.4 (`D/infra/bootstrap.sh`). Some explorations ran on Bun 1.3.14 / Node 26.5 on the lead's machine and are labelled exploratory.
- **Severity:** P0 data loss, security, production outage; P1 wrong result, blocked core flow, or anything that makes a production apply,
  restore or upgrade unsafe or unrecoverable; P2 degraded, workaround exists; P3 polish.
- **Disposable stack:** `D/infra/stack-up.sh` builds a complete ExponetDB (Control Store, serve, worker, gateway, a node agent, targets on
  PostgreSQL 16/17/18) from any commit in about 4 minutes; the fix session can use it for the stack steps of the acceptance tests.
