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

Findings: **151** (P0 0, P1 17, P2 62, P3 72). **No P0 by the brief's definition** (no data loss, no secret exposure, no
way found to change production without the gates). Two P1s are outage-class and the owner may count them as P0:
a holder of the plain `migrations.plan` scope can fill the Control Store disk until PostgreSQL PANICs, with rows
that cannot be deleted (VC-001), and one allowlisted `sql_query` can make the kernel kill a backend and restart the
target PostgreSQL (VC-002).

The headline results:

- **The answer to the question is: not yet.** Of thirteen Wave 11 preconditions (`F/readiness.md`), three are
  PASS (verification order, secrets in the tested sinks, backups and ledger readable without ExponetDB), ten are
  FAIL; none is only UNPROVEN, but section 6 lists what was not run.
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

| Block | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| A | 0 | 0 | 2 | 3 | 5 |
| B | 0 | 4 | 26 | 21 | 51 |
| C | 0 | 7 | 18 | 15 | 40 |
| D | 0 | 2 | 7 | 15 | 24 |
| E | 0 | 2 | 7 | 10 | 19 |
| R | 0 | 2 | 2 | 8 | 12 |
| all | 0 | 17 | 62 | 72 | 151 |

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


## 3. Index of findings

| Id | Sev | Title | Block |
|---|---|---|---|
| VC-001 | P1 | A full Control Store disk is a PostgreSQL PANIC and a dead control plane, and any holder of `migrations.plan` can cause it with a few unaudited, undeletable requests | C |
| VC-002 | P1 | One allowlisted read crashes the target PostgreSQL: memory exhaustion restarts every session of the cluster | D |
| VC-003 | P1 | A clock step leaves the audit chain refusing every event: every audited mutation fails with INTERNAL, readiness stays ready, and there is no repair | B |
| VC-004 | P1 | A drill passes, and the restore succeeds, while committed data is missing when the newest archived WAL segment is deleted or corrupted | C |
| VC-005 | P1 | `backup.verify` passes a repository with a deleted WAL segment, and no component detects WAL gaps (residual of TC-011) | R |
| VC-006 | P1 | `needs_attention` has no exit for any operation kind outside four migration kinds, and it keeps the operation's locks for ever | E |
| VC-007 | P1 | `needs_attention` with apply outcome `unknown` has no exit when the migration turned out not to be applied | E |
| VC-008 | P1 | One lock-blocked operation starves every younger operation: the worker re-claims the oldest waiter on every tick | C |
| VC-009 | P1 | The documented rollback of an upgrade dies at once; the real way back (restore the dump) leaves every touched target blocked and every younger sign-in dead | C |
| VC-010 | P1 | RB-10 step 6 is empty for managed targets: after a restore into an older Control Store each touched target needs an undocumented reconcile (6 steps; production 10, with a step-up and an approval) | C |
| VC-011 | P1 | RB-14 (keyring lost) cannot be executed: roles refuse to start or stay not ready, and nothing resets the secrets | C |
| VC-012 | P1 | A data read never returns when its backend dies; two such reads wedge the cluster's reader slots | D |
| VC-013 | P1 | Nested block comments freeze the serving process: PostgreSQL's scanner is quadratic on `/*/*/*`, and comments are free in every bound | B |
| VC-014 | P1 | Memory is bounded per parse, not per request: six valid 660 KB bundles kill a serve process with the documented 259 MiB heap | B |
| VC-015 | P1 | Another quadratic regular expression over bundle text: the `-- check:` directive of `verify.sql` (neighbour of TC-004) | R |
| VC-016 | P1 | CREATE TABLE ... (id serial PRIMARY KEY ...) can never be applied: the engine's own structural verification fails and rolls back | C (found while building state; the bundl |
| VC-017 | P1 | ADD COLUMN serial/bigserial/identity rewrites the table under ACCESS EXCLUSIVE; lint and plan call it additive and brief | B |
| VC-018 | P2 | main has no branch protection or required checks, and cancel-in-progress cancels CI of commits on main | A |
| VC-019 | P2 | The agent-capabilities host test failed once in CI on the next main commit (NODE_OFFLINE after an injected crash); not reproduced | A |
| VC-020 | P2 | Evidence rule is weaker than documented: any operation id counts, no divergence check on the evidence target, verification rows not cross-checked with the mirror | B |
| VC-021 | P2 | The apply checksum depends on client-supplied project defaults: editing `defaults` after an apply makes applied bundles a non-overridable MIGRATION_CHECKSUM_MISMATCH | B |
| VC-022 | P2 | Default `migration plan` and `migration apply` submit every local bundle; the request accepts 50 | B |
| VC-023 | P2 | Ledger divergence is noticed only when someone plans: no periodic check, no finding, no suspension | B |
| VC-024 | P2 | `generation` never changes: documented restore protections are inert, and a future bump switches the divergence check off and re-adopts the restored ledger | B |
| VC-025 | P2 | Lint overrides, lint profile and invariants are taken from the plan request, not from an authoritative project record | B |
| VC-026 | P2 | Lint and plan over a dependency chain are cubic: 800 chained bundles take 61 s, a 1,000-deep chain plans in 53 s, 5,000 would take hours | B |
| VC-027 | P2 | `up.sql` can release the engine's own target lock: `SELECT pg_advisory_unlock_all();` is applied and the `EXDB` locks disappear while the migration runs | B (invariant I4, touches I8) |
| VC-028 | P2 | The bundle store decides "applied elsewhere" from the Control Store mirror only: in the commit-to-mirror window other bytes under an applied id are accepted | B (I13) |
| VC-029 | P2 | volatile_default_rewrite fires for stable and immutable defaults (now(), any unqualified function) and forces data_rewrite | B |
| VC-030 | P2 | type_change_rewrite blocks every ALTER COLUMN TYPE including the no-rewrite cases; no lint-clean form exists | B |
| VC-031 | P2 | The documented NOT NULL recipe cannot pass the planner: unsafe_not_null fires after the validated CHECK | B |
| VC-032 | P2 | ADD CONSTRAINT ... UNIQUE USING INDEX is flagged like a scanning constraint | B |
| VC-033 | P2 | A cheap statement's ACCESS EXCLUSIVE held through later slow statements of the same transactional bundle is reported as brief | B |
| VC-034 | P2 | DETACH PARTITION ... CONCURRENTLY cannot be authored | B |
| VC-035 | P2 | Lock-queue protections the docs promise are not delivered | B |
| VC-036 | P2 | A killed or crash-looping process counts as live for 45 s, so a restart loop shorter than that reads operational | C |
| VC-037 | P2 | A Control Store outage, a read-only store or a full disk is answered 500 INTERNAL, and pool exhaustion is reported as "unreachable" | C |
| VC-038 | P2 | The shipped metrics cannot alert on most failures: every API request is route="/unmatched" and the documented operational metrics do not exist | C |
| VC-039 | P2 | Backup and drill signals are not produced: the drill-finding generator is never run and the catalog is never refreshed on a schedule | C |
| VC-040 | P2 | No signal exists for an expiring certificate: certificate_expiring and tls_expiring are documented and typed but nothing produces them | C |
| VC-041 | P2 | Time-based checks mix the process clock with the database clock and there is no skew check | C |
| VC-042 | P2 | Documented retention classes have no pruning code, and every drift check rewrites every open finding | C |
| VC-043 | P2 | The audit gate is invisible to probes: a missing audit partition fails every mutation with a plain 500 while /healthz/ready stays ready | C |
| VC-044 | P2 | A redeploy interrupts a running apply although upgrades.md says workers stop at step boundaries; Docker's default stop time is shorter than the 25 s timeout | C |
| VC-045 | P2 | A refused recovery has already closed the needs_attention operation and released its lock domain | D |
| VC-046 | P2 | migrations.ledger_mirror is rewritable in place by the worker; "insert-and-revert-only" is code convention only | D |
| VC-047 | P2 | A request body of up to 32 MiB is read, parsed and validated before the permission check | D |
| VC-048 | P2 | A single read floods the target's disk with temp files; the row cap does not bound the work | D |
| VC-049 | P2 | The CLI prints most error `details` only with `--json`: `PLAN_STALE` does not say which binding changed | E |
| VC-050 | P2 | The CLI recommends `operation retry-verification` for operations the server refuses | E |
| VC-051 | P2 | A superseded `needs_attention` operation is recorded with verification outcome `failed` although verification never ran | E |
| VC-052 | P2 | The documented repair of a broken `verify.sql` cannot be completed with the CLI | E |
| VC-053 | P2 | RB-10 (Control Store down) leaves the ledger-mirror problem unaddressed | E |
| VC-054 | P2 | A plan from before an upgrade, or a lost race, answers HTTP 500 `INTERNAL` instead of a catalog code | E |
| VC-055 | P2 | A plan does not check that its own verification can run: a missing verifier credential parks the target after the commit | E |
| VC-056 | P2 | Recovery by naming exists for two migration kinds only; every other operation that ends `needs_attention` with an unknown outcome still keeps its domain for ever (TC-005 neighbour) | R |
| VC-057 | P2 | Planning a node revoke or decommission fails with 500 INTERNAL while any active plan body holds an escaped NUL (regression of the TC-019 fix) | R |
| VC-058 | P2 | An approval 15 minutes after the plan expired was accepted and the production change ran; awaiting_approval never ends (stack reproduction of TC-034 / OD-64 and of the B1 approval-window finding) | B |
| VC-059 | P2 | A lost COMMIT reply plus a target restart parks the operation as unknown with the change committed; it is never reconciled, and the only exit mislabels it | B |
| VC-060 | P2 | The restic runbook does not apply globals and does not stop without them (TC-045 / D-07 not fixed) | C |
| VC-061 | P2 | restore.execute does not re-check space (D-08 not fixed), and restore.prepare measures the engine directory, not the scratch directory | C |
| VC-062 | P2 | Wrong key or deleted repository: backup verify needs 102 s and ends OUTCOME_UNKNOWN although the helper refused at once; errors carry no code | C |
| VC-063 | P2 | pitr_random drills are refused until a wal.archive_status observation exists, and explicit pitr: plans stayed refused in one world | C |
| VC-064 | P2 | After a restore, a production target the store never mirrored is not blocked, `ledger reconcile` says "nothing to reconcile" while status says "out of sync", and the next apply adopts the unknown row | C |
| VC-065 | P2 | An old role keeps claiming and finishing operations after the schema moved ahead (503 not_ready, no log line) | C |
| VC-066 | P2 | The upgrade runbook omits eleven steps: no pre-upgrade backup, outage window, drain, preflight or post-checks | C |
| VC-067 | P2 | An unmet backup requirement on a production apply answers 500 INTERNAL, and nothing is logged | D |
| VC-068 | P2 | The first-party CLI fails with PERMISSION_DENIED for everyone whose role binding is on an environment | D |
| VC-069 | P2 | A sub-megabyte bundle can hold the server's CPU for 30 s or raise its memory by 620 MiB; the limits are not named | D |
| VC-070 | P2 | A plan that stops part-way leaves the drift baseline behind: every later verified bundle reads as drift (34 findings, 6 critical) until a person accepts all of it | B |
| VC-071 | P2 | ALTER COLUMN TYPE on a column a view reads: the plan is silent, the apply fails 0A000 after earlier bundles were applied, and the offered remedy does not fit | B |
| VC-072 | P2 | A clone that takes the registered name is healthy, drift-clean and plannable; apply is refused only as PLAN_STALE without a cause | B |
| VC-073 | P2 | A renamed or missing database turns `migration plan` into INTERNAL | B |
| VC-074 | P2 | A hot standby behind the registered endpoint is healthy and plannable; the apply fails as OUTCOME_UNKNOWN | B |
| VC-075 | P2 | Adding an endpoint of a different instance is applied without a check and suspends the affected targets within seconds; recovering a production target takes plan, approval and 50 s | B |
| VC-076 | P2 | The documented database move has no executable path: a copy of a registered target is refused in every environment and nothing re-stamps the marker | B |
| VC-077 | P2 | CREATE PUBLICATION (the standard supabase_realtime) in the legacy history makes the whole analysis incomplete; the operation ends verification_failed with a forward-fix remedy | B |
| VC-078 | P2 | After a failed write path clears, the roles stay not_ready until their pooled sessions die; a database-level read-only default stops nothing but the heartbeat | C |
| VC-079 | P2 | One MCP client can push serve far past its 512 MiB container limit: 1,000 concurrent requests, 98 percent rejected 429, RSS 156 to 583 MB | C |
| VC-080 | P3 | third-party, licenses and ui-safety are part of `bun run verify` but no CI job runs them | A |
| VC-081 | P3 | A local image build (smoke:image, docker build) needs BuildKit and no document says so | A |
| VC-082 | P3 | Tests depend on the order of tests inside their file, so a single test cannot be run alone | A |
| VC-083 | P3 | Edits that do not change the checksum are dropped by ingest, and three lints cannot fire on the server path | B |
| VC-084 | P3 | c1 summary sentences are looser than c1: spacing, adjacency, formatters and case change the checksum | B |
| VC-085 | P3 | The CLI reads a whole oversized bundle file into memory before cutting it | B |
| VC-086 | P3 | Hotfix follow-up is unbuilt: no hotfix_without_evidence finding, no evidence mark | B |
| VC-087 | P3 | The bundle store has no way to retire a bundle; `pending` lists every never-applied stored id forever | B |
| VC-088 | P3 | A later migration that fails to execute ends the operation as verification_failed with error code VERIFICATION_FAILED | B |
| VC-089 | P3 | Seven pinned settings are refused at top level but not guarded after each statement | B (I4) |
| VC-090 | P3 | A string literal continued across a line comment is valid PostgreSQL and c1 N4, but libpg_query refuses it | B (I5) |
| VC-091 | P3 | The lint report depends on the order the bundles are submitted in | B (I1) |
| VC-092 | P3 | The CLI loader turns a symbolic link or directory named `verify.sql`/`up.sql` into an empty file, and reads an oversized file whole | B (I14) |
| VC-093 | P3 | A deeply nested `migration.yaml` is refused with the YAML library's stack-overflow text, not a named limit | B (I14, I15) |
| VC-094 | P3 | The limits of bundles are not announced in one place, and two bite below the documented ones | B (I15) |
| VC-095 | P3 | The bundle store drops edits that do not change the checksum, although the documentation says it keeps them | B (I13; also reported statically by B1 a |
| VC-096 | P3 | Lock facts and rules missing for several heavy statements | B |
| VC-097 | P3 | Master-key rotation has no role order, and the wrong order takes serve out of service | C |
| VC-098 | P3 | A data read runs on the target before its audit event is written | C |
| VC-099 | P3 | The maintenance loop has no per-task deadline and tasks cannot renew their lease | C |
| VC-100 | P3 | An oversized JSON request body is refused without naming the limit | C |
| VC-101 | P3 | archive_mirror_rows binds neither generation, ids nor lease to the operation, and takes no row lock | D |
| VC-102 | P3 | The three verify.sql files of the new bundles pass on broken bundles and none checks ownership | D |
| VC-103 | P3 | POST /clusters/{id}/drills/offline with restoredAt ahead of the database clock is a 500 | D |
| VC-104 | P3 | 24 of 45 Control Store bundles are not pinned, the three new ones among them | D |
| VC-105 | P3 | migration.resume takes the operation it closes from the target's own ledger events (static reading only) | D |
| VC-106 | P3 | The existence of node, backup repository and registry-plan subject ids is visible to callers without access | D |
| VC-107 | P3 | Plan analysis text and advisor evidence reach agents and approvers without the `untrusted` marker | D |
| VC-108 | P3 | A database client decides, through `application_name`, that ExponetDB must not cancel its session | D |
| VC-109 | P3 | `packages.apply_update` is a node mutation outside the approval rule and outside the test that pins the catalog | D |
| VC-110 | P3 | identity.md says every `critical` plan needs a fresh re-authentication to apply; the code enforces it only where a kind or policy rule declares it | D |
| VC-111 | P3 | Six CLI commands declare scopes the API does not accept | D |
| VC-112 | P3 | Allowlisted functions and views disclose server details to every data.read caller | D |
| VC-113 | P3 | The Web editor's classifier calls EXPLAIN a read-only path that sql_query refuses | D |
| VC-114 | P3 | Thirteen catalog error codes are documented and exposed but never produced | E |
| VC-115 | P3 | 69 catalog codes carry no remedy; the operationally important ones are listed | E |
| VC-116 | P3 | `drift.accept` is documented for "the Web App or the CLI"; the CLI has no command | E |
| VC-117 | P3 | Break-glass cannot be activated from the CLI or, on this installation, at all; documents say otherwise | E |
| VC-118 | P3 | Documents name commands, flags, states and rule ids that do not exist | E |
| VC-119 | P3 | One program name for two programs with overlapping words (`exponetdb audit`, `exponetdb auth`, `exponetdb version`) | E |
| VC-120 | P3 | Enum values that no code writes, and a Web label for an unreachable state | E |
| VC-121 | P3 | Three documents give `operation.force_release` two different meanings, and building it as documented would not close the dead end | E |
| VC-122 | P3 | Plan acceptance holds the plan row lock and a Control Store connection while it reads the managed target, on a pool of 10 shared with all of `serve` | E |
| VC-123 | P3 | One word, several meanings across CLI, REST, Web App and docs: accept, apply, verify, reconcile, baseline, promote, recovery | E |
| VC-124 | P3 | `migration.bundle.ingest` still stores a bundle with an unknown `dependsOn` silently (TC-008 residual) | R |
| VC-125 | P3 | `HBA_WOULD_LOCK_OUT` tells the operator to "name it in protectedAccess", which cannot make the plan pass, and the CLI prints none of the details that name the access | R |
| VC-126 | P3 | The node view reports "no restart pending" and no certificate expiry for state the agent never reports, and the certificate overview stays empty | R (remainder of TC-016) |
| VC-127 | P3 | The total-budget refusal of a legacy import advises "import the history in several parts", a flow the import does not have | R (TC-021) |
| VC-128 | P3 | No shipped test covers the apply-time pg_hba safety net for a lock-out the plan cannot judge, and the Control Plane outcome of an agent-side refusal is no longer asserted anywhere | R (TC-018) |
| VC-129 | P3 | The new root-only check of `verify-units.sh` fails whenever it is run as root, and CI never runs it as root | R |
| VC-130 | P3 | The test-infrastructure fixes TC-049, TC-050 and TC-054 have no regression guard | R |
| VC-131 | P3 | Two statements about the model evals are stale after TC-050 | R |
| VC-132 | P3 | Forbidden-statement refusals have one generic remediation and mislabel RESET ROLE | B |
| VC-133 | P3 | Local `migration lint` and the server plan disagree, and a resume without --cleanup is denied with a generic rule | B |
| VC-134 | P3 | A verification with zero runtime checks passes, and finished operations keep a stale error code | B |
| VC-135 | P3 | A comment-only out-of-band change is not seen by the drift check | B |
| VC-136 | P3 | A drill record carries no recovery point for latest, older and backup: targets, and no data comparison | C |
| VC-137 | P3 | Latency: a drill's operation takes 2.1 times its RTO, and REST verify operations take 3.9 to 38 s for a 1 to 2 s engine run | C |
| VC-138 | P3 | The CLI cannot drive restore runbook or a drill apply with an API key, and the reference does not say so; logical backup and expire have no Control Plane path | C |
| VC-139 | P3 | S3 adoption refuses endpoint hosts under .test, .local, .internal, .example and .invalid with an unexplained VALIDATION_FAILED, and allows no port or http | C |
| VC-140 | P3 | A second recovery by the same RB-10 text fails: the temporary superuser restore_admin persists in the restored store | C |
| VC-141 | P3 | `plan apply --yes --json` waits silently for a step-up (no address, no code) | C |
| VC-142 | P3 | RB-10 step 3 says the exported checkpoints show the size of the lost gap; hourly checkpoints cannot | C |
| VC-143 | P3 | A restored awaiting_approval operation for a change that is already live is offered for approval | C |
| VC-144 | P3 | Session cancel and terminate without an operator credential answer "credential needs rotation or repair" | D |
| VC-145 | P3 | Lint allows server-file functions and untrusted-language functions; only database privileges stop them | D |
| VC-146 | P3 | The observer role cannot read schemas of the managed scope; scratch-check says ready and the analysis returns seven expectations_unreadable items that look like ambiguity | B |
| VC-147 | P3 | Refusal texts that name no id and no remedy | B |
| VC-148 | P3 | `schema diff` prints columns, constraints and triggers without their table | B |
| VC-149 | P3 | An established gateway session is never re-checked against the certificate's end, and a refused node leaves one info log line | C |
| VC-150 | P3 | The audit export failure never says why | C |
| VC-151 | P3 | Target TLS failures share one class, and a serve clock behind the certificates makes every target unreachable without naming the clock | C |

## 4. Findings

Severity: **P0** data loss, security, production outage; **P1** wrong result or blocked core flow; **P2** degraded, workaround exists; **P3** polish. P0 first. Evidence paths are relative to `exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/`.

### P0 (0)

None found.

### P1 (17)

#### VC-001 [P1] A full Control Store disk is a PostgreSQL PANIC and a dead control plane, and any holder of `migrations.plan` can cause it with a few unaudited, undeletable requests

- **Area:** `packages/application/src/migrations.ts:93-113` (bundle ingest), `packages/migrations-engine/src/store.ts`, Control Store operations
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc3-disk.sh` and `fc3b-disk-recovery.sh`. Control Store data directory on a 420 MB loop-mounted ext4 (74 MB used). With the CLI token (scope `migrations.plan` only): `POST /api/v1/projects/{id}/bundles`, once with 50 x 600 KB, then 8 x 3 MB per request. Then `DELETE FROM migrations.bundle_revisions` as the superuser and as `exdb_serve`.
- **Expected:** a bounded, audited, per-identity write; a full volume refuses writes and keeps reading; there is a way to free space; the operator is warned before.
- **Actual:** five successful ingests (29 MB, then 4 x 24 MB, about 1 s each) took free space from 296 MB to 53 MB, with no audit event (`max(seq)` 289 before and after) and no rate limit. The next request answered 500; the log shows `PANIC: could not write to file "pg_wal/xlogtemp.59": No space left on device` on COMMIT, `terminated by signal 6`, then `FATAL ... xlogtemp.119` in recovery and `shutting down due to startup process failure`, all within 9 s of the PANIC. The container exited and a plain restart fails again. The roles went `not_ready`, then ECONNREFUSED. Rows cannot be removed (`migrations.bundle_revisions is append-only (DELETE refused)` even for the superuser), so only more disk helps. After growing the volume PostgreSQL accepted connections 1.4 s after `docker start`, the roles were ready 2.4 s later without a restart, `audit verify` was ok with 415 events, and nothing committed was lost. No readiness, metric or finding watches Control Store disk. The lead classed it P1 because there is no data loss and the managed databases keep serving applications (control plane, not data plane); the actor needs only `migrations.plan`, so the owner may count it as an outage-by-low-privilege-actor (P0) on `reos-01`, where the Control Store shares a host with other services. This subsumes `F/findings-C1.md` "Bundle ingest is an unaudited, unthrottled, permanent write".
- **Evidence:** `C/stack/fail-closed-results.md` steps 3 and 6; logs `fc3.out`, `fc3b.out` on vc-1 (index in `C/stack/README.md`).
- **Root cause:** ingest sits outside the audit gate and any quota; revisions are immutable with no purge path; no disk watch; PostgreSQL PANICs on a failed WAL write.
- **Proposed fix:** audit every ingest in the same transaction; a per-identity daily byte quota plus a general REST rate limit; an audited human-only purge of never-planned revisions (the 90-day class of `data-retention.md`); a Control Store volume component in installation health (warn at 80 percent, refuse ingest at 90 percent); a separate WAL volume and restart policy in the deployment record; a "Control Store will not start: ENOSPC" runbook.
- **Acceptance test:** with a 50 MB free budget the quota answers before the volume is full; every ingest writes an audit row; a purge frees space; installation health shows the warning.

#### VC-002 [P1] One allowlisted read crashes the target PostgreSQL: memory exhaustion restarts every session of the cluster

- **Area:** `packages/postgres/src/parser/allowlist.ts` (`repeat`, `array_agg`, `string_agg`, `generate_series`, `lpad`, `rpad`, `array_fill`), `data.read`
- **Block:** D
- **Reproduction:** a container with a 3 GiB memory limit (`docker update --memory 3g --memory-swap 3g`); `bomb.ts --major 17`: `executeDataRead` (agent, 60 s timeout, the path of `sql_query`) of `SELECT array_agg(repeat('x', 100000000)) FROM generate_series(1, 100)`. Reproduced twice in each of two sessions (4 times in total).
- **Expected:** the read is refused, or fails with an error; other sessions of the cluster are unaffected.
- **Actual:** the kernel kills the backend (SIGKILL); the postmaster logs "terminating any other active server processes ... all server processes terminated; reinitializing"; a bystander session (another tenant) was dropped ("Connection terminated unexpectedly"); recovery takes about 4 s; the container OOMKilled flag is set; `statement_timeout` cannot help (the allocation takes under a second); the worker read then hangs (previous finding). This is a restart of the managed PostgreSQL by an authorised read: no data loss (WAL recovery) and no gate bypass, but a production outage of a few seconds per call; by the brief's own definition ("P0 ... production outage") the owner may count it as P0 (D2 open decision 1). Agent reads of production are `humans_only` by default (OD-13), so the reachable caller on production is a person with `data.read:prod`.
- **Evidence:** `D/sql-execution/data/bomb-pg17.jsonl` (label `aggregate-of-big-values`: peakContainerMb 3069, oomKills 1, bystanderSessionSurvived false); `results.md` section "Exhaustion of the target and a dead backend".
- **Root cause:** the allowlist admits functions "known not to have side effects" (`allowlist.ts`, lines 102-106, 193-194 checked by the lead) but treats memory as free; PostgreSQL has no per-query memory limit and `work_mem` does not bound aggregates or `repeat()`; `sql-execution-security.md` §2.2 bounds only the worker's memory.
- **Proposed fix:** no complete fix inside the guard. Layered: refuse constant size arguments above a cap and any non-constant size argument for `repeat`, `lpad`, `rpad`, `array_fill` and unbounded `generate_series`; record a memory limit (cgroup or `vm.overcommit_memory=2`) as a registry fact for a target that allows `data.read` and warn otherwise; fix the previous finding so the caller gets `TARGET_UNAVAILABLE` fast; the owner decides the residual risk.
- **Acceptance test:** on a cgroup-limited container, the statement above is refused by admission (`QUERY_CONSTRUCT_UNSUPPORTED`) and the postmaster log of the container contains no "signal 9" after a run of the memory corpus (`bomb.ts` scenario 3 turns into a refusal test).

#### VC-003 [P1] A clock step leaves the audit chain refusing every event: every audited mutation fails with INTERNAL, readiness stays ready, and there is no repair

- **Area:** Control Store `audit.chain_guard`, `apps/server` (login, plan, apply), readiness
- **Block:** B
- **Reproduction:** on the stack (`D/infra`), `source stack-env.sh; clock_jump 10800` while an apply runs (`B/failure/F-matrix.sh cell tx mid clock_fwd3h`), then `clock_restore`. Then `exdb migration plan --target lab/platform/staging` or the owner login. On a single host (as `reos-01` runs it, Control Store container and roles on one kernel clock) the step moves the database clock too, so the events written during the skew are accepted.
- **Expected:** fail closed with a named cause and a repair path; readiness not ready; a skew guard.
- **Actual:** the audit table received events up to 22:46:19 while the real time was 19:52. The Control Store raises `audit chain: the event time does not continue the chain` (`packages/control-store/migrations/01M46KJ06G9BHM1ZR7CDD2JZ2S_audit-chain/up.sql:76-77`: `NEW.occurred_at < head_at OR NEW.occurred_at > clock_timestamp() + interval '1 minute'`, checked by the lead). Login returns HTTP 500 `audit_append_failed`. The CLI prints only `Error INTERNAL: An unexpected error occurred` plus a request id. Serve and worker readiness are `ready` with `checks: []` (the lead found no audit check in `role.ts`). Reads still work. The block lasts as long as the skew (2 h 54 min here). The only way out on the stack was stack-down and stack-up (a fresh Control Store); no document or tool offers a repair of a live chain. A serve-only clock step forward is refused by the same guard (more than a minute ahead of the database clock) with the same opaque 500.
- **Evidence:** `B/failure/RESULTS.md` (not-run section and matrix); logs `fresh-target.log` and the serve journal on vc-3 (index in `B/failure/README.md`).
- **Root cause:** `audit.chain_guard` enforces monotonic event time against the chain head and the database clock; nothing detects or limits future-dated events when the clock is wrong, and `AuditWriteError` has no catalog code (see `F/findings-C1.md`, the audit-gate finding).
- **Proposed fix:** a readiness check on audit append; a typed error naming the chain (for example `AUDIT_CLOCK_SKEW`); a skew guard (refuse or clamp future events with a skew marker, ideally against a monotonic source); a documented, audited repair operation for a head that is ahead of real time.
- **Acceptance test:** step the clock +3 h, perform an audited action, step back: the next audited action succeeds, or fails with a typed `AUDIT_CLOCK_SKEW` while readiness is degraded and a repair operation exists.

#### VC-004 [P1] A drill passes, and the restore succeeds, while committed data is missing when the newest archived WAL segment is deleted or corrupted

- **Area:** `packages/backups` (`replayShort`, `selection.ts:98`, `kinds.ts:1356`), helper `restore.execute`, Control Plane drills
- **Block:** C
- **Reproduction:** on a 7.7 GB PostgreSQL 17 dataset with a 1 Hz marker table: `pg_switch_wal()`, wait for the archive, delete (or flip 16 bytes in) the newest archived segment, run `restore.execute` to the end of the archive, and `POST /clusters/{id}/drills {selection: {kind: "latest"}}` (scripts in `C/backup-restore/`, section 5 and 6 of `C/backup-restore.md`).
- **Expected:** the restore or the drill fails, because replay did not reach the end of the archive the plan counted on.
- **Actual:** the helper restore succeeded and all its checks passed with 12 rows missing (segment deleted) or 4 rows missing (segment corrupted). The Control Plane drill `latest` ended `passed` with `measuredRtoSeconds` 35, and the label-scoped `backup verify` also passed. The drill configures no data check (`fingerprint` and `ledger_head` are `not_run`). S2's caveat: the newest segment holds commits here because `archive_timeout=0`; with `archive_timeout=60` and background WAL noise it usually holds none, but a real workload can hit the same condition.
- **Evidence:** `C/backup-restore.md` §5, §6, §10; `C/backup-restore-numbers.md`; scripts and the log index in `C/backup-restore/`. Also R1 (static): the same comparison at `selection.ts:98` and `kinds.ts:1356` ("The restore drill's replay-reached-end check compares with the START of the newest segment").
- **Root cause:** `replayShort` compares the reached LSN with `walTo = segmentLsn(c.maxSegment)`, the START of the newest segment (`selection.ts:97-98`, `kinds.ts:1348-1356`, checked by the lead), not with the archive end the node reports; the drill adds no row-count or checksum comparison with the source. R1 found the same comparison statically.
- **Proposed fix:** compare with the archive end the node reports (`last_archived_wal`, or the end of the newest segment) and add a mandatory data check (count or checksum from the source) before a drill can be `passed`.
- **Acceptance test:** delete or flip the newest archived segment; the drill must end `failed` with a named reason, and the helper restore must not report success.

#### VC-005 [P1] `backup.verify` passes a repository with a deleted WAL segment, and no component detects WAL gaps (residual of TC-011)

- **Area:** node helper `backup.verify` (`agent/node/internal/helper/engine.go` `pgbrVerify`), backup catalog `backups.wal_coverage` (`packages/backups/src/reconcile.ts:367`), protection state `wal_gap`
- **Block:** R
- **Reproduction:** on a host with pgBackRest 2.60.0 and the released helper of `d51da5d0` (lab script `t11gap2.sh`, `t11gap3.sh`, `R/R1-notes/probes/`): take four full backups with WAL between them; delete the archived WAL segment named as the `stop` segment of the newest backup (`pgbackrest info --output=json` -> `.backup[-1].archive.stop`, here `000000010000000000000012`) from `/var/lib/pgbackrest/archive/<stanza>/17-1/0000000100000000/`; call `backup.verify` (whole repository); then `restore.execute` of that backup with target `{label:<newest>, time:null, lsn:null, timeline:null}`.
- **Expected:** the verification fails (a verified backup must not rest on an archive that cannot make it consistent); the catalog shows a `wal_gap` and `walContinuous` false; `restore.prepare` refuses or warns.
- **Actual:** `pgbackrest verify --verbose` itself prints `status: ok`, `backup: <label>, status: valid, total valid files: 1271` and exits 0 although its own DETAIL lines list two disjoint WAL ranges (`..01-..11` and `..13-..16`); the helper run is `succeeded`, `verifyErrors 0`; `restore.prepare` answers `engineCanRead true, walContinuous null, refusals []`; the restore then fails with `FATAL: WAL ends before end of online backup` (exit 1). The fix of TC-011 counts what pgBackRest reports (corrupt WAL: 3, truncated WAL: 3, corrupt backup file: 4, deleted backup file: 4 - all verified as `failed`; label-scoped verify of a backup whose own start or stop segment is corrupt: `failed`), but pgBackRest does not report a deleted WAL segment at all, so the "deleted segment" half of the finding's acceptance test (`failed or verifyErrors > 0`) cannot be met by parsing its output. The Control Plane only issues label-scoped verifications (`POST /clusters/{id}/backups/{id}/verify`), which do not read WAL after the backup's stop segment (a corrupt LAST segment: `succeeded`, 0), so corruption or a hole in the archive tail is found only when a `latest` drill replays it. Separately `backups.wal_coverage.gaps` is never written (the only INSERT, `reconcile.ts:367-381`, sets min/max only; the column default is `[]`), so `wal_gap` in the protection state (`protection.ts:188`) and `gapEnds` in `selection.ts:82` can never fire; `architecture.md:79` documents gaps as recorded.
- **Evidence:** `R/R1-notes/TC-011.md`, probes `t11r1.sh`, `t11gap.sh`, `t11gap2.sh`, `t11gap3.sh`; server logs `/srv/work/r1/lab` (`new-t11r1.log`, `new-t11gap*.log`). **Reproduced at 7.7 GB by S2:** a deleted WAL segment in the middle, the newest segment and the stop segment of the newest full backup all give `verifyErrors 0` and `passed`; for the stop segment the restore dies with `FATAL: WAL ends before end of online backup` while its verification is `passed`; the label-scoped Control Plane verify also passed with the newest segment deleted (`C/backup-restore.md` §5, §6).
- **Root cause:** `pgbrVerify` trusts `pgbackrest verify`; pgBackRest verifies the WAL a backup needs only as the ranges it finds, and reports a hole between two ranges only when a backup's start..stop falls into it (here it did not even for the newest stop segment); the catalog has no gap computation from the segment list.
- **Proposed fix:** have the node list the archive segment names (`pgbackrest info` gives min/max only; the directory listing gives all), compute the gap ends and write them into `wal_coverage.gaps`; make `backup.verify` fail (verifyErrors += gaps inside any backup's start..stop and between the newest backup and the archive end); make `restore.prepare` set `walContinuous` from it.
- **Acceptance test:** `pglab`: delete (a) a segment between two segments after the newest backup, (b) the newest backup's stop segment, and (c) the last segment: `backup.verify` ends `failed` or `verifyErrors > 0` for (b), the catalog reports `wal_gap` for (a) and (b), `walContinuous` is false; a clean repository still passes.

#### VC-006 [P1] `needs_attention` has no exit for any operation kind outside four migration kinds, and it keeps the operation's locks for ever

- **Area:** `packages/operations` (driver, supersede, locks), `packages/application` (`views.ts`), `apps/cli`
- **Block:** E
- **Reproduction:** (probe, run) `probe1.ts` calls `verificationRetryable({kind, state:'needs_attention', applyOutcome:'applied', verificationOutcome:'error'})`: true only for `migration.apply|resume|baseline|verify`; false for `migration.rollback`, `ledger.reconcile`, `drift.accept`, `backup.run`, `restore.drill`, `node.enroll`, `postgres.roles.apply`, `registry.cluster.register`, `credential.rotate`. (static) `driver.ts:372-406` turns any exception of a kind's `verify` into `needs_attention` for every kind; `supersedes()` exists only in `migrations-engine/src/kind.ts:131` and `reverify.ts:380`; `operation cancel` accepts only `awaiting_approval|queued` (`application.ts:1943-2000`); `operation.force_release` is registered (`contracts/src/actions.ts:1052`) with no kind, CLI command or page (`operations/README.md:44`). Stack step for block C: with `postgres.hba.apply` or `backup.run` make the verification step throw (cut the worker's Control Store connection during `verifying`, or make the node observation unreachable); then `exponetdb operation retry-verification <op>` (expect `OPERATION_NOT_RETRYABLE`), `operation cancel <op>` (expect `OPERATION_NOT_CANCELABLE`), and start a second operation in the same domain (`cluster:<id>:config`): it stays `queued` with `waitingFor` for ever.
- **Expected:** every non-terminal state has a documented exit for an authorised person (CLI or Web App), and a parked operation does not hold the domain of every later operation without a way to release it. The docs name the exit: `04-migrations/concurrency.md:131` ("a human with `operations.recover` runs `operation.force_release(op_…)` (Web App or CLI, re-authentication)").
- **Actual:** the exit exists for four migration kinds only. For every other kind the operation holds its exclusivity domains until someone edits the Control Store by hand, and the guards refuse that too (`operations-engine/up.sql:143-205`: no transition out of `needs_attention` except to `verifying` / `verification_failed`; locks of a live operation cannot be deleted).
- **Evidence:** `E/state-machines.md` §1, §8 (SM-1); `E/recoverability.md` R6; `E/docs-claims.md` DC-014. **Reproduced on the stack by S1** for `migration.rollback`, `ledger.reconcile`, `drift.accept` and an unknown apply outcome: `retryable=false`, `retry-verification` gives OPERATION_NOT_RETRYABLE, `cancel` gives OPERATION_NOT_CANCELABLE, `operation_locks` still holds `target:<id>:schema`, and a new plan queues with `waitingFor` naming the parked operation (`B/failure/I9-exits.sh rollback reconcile accept unknown_rolledback`). The same gap is `F/findings-B1.md` first P1. Also `B/contract.md` §2.2, §2.7 (I9), §3 DF-02, DF-19 (agent B1 filed the same gap with the claim predicate `leases.ts:56-60`, the missing `operation.force_release` route and kind, and the locks released only on a terminal transition `transitions.ts:177-198`).
- **Root cause:** TC-005's fix (`supersede.ts`) covered the migration recovery plans only; `operation.force_release` stayed planned (OD-58 option (b) not taken); `VERIFICATION_RETRY_KINDS` (`views.ts:270-275`) is a closed list.
- **Proposed fix:** a first-class close for `needs_attention`: `exponetdb operation close <op> --reason …` (human only, class `high`, fresh re-authentication, audit event, never re-executes, releases the domains). Or build `operation.force_release` as documented. In addition give the registry, node and backup kinds a verify retry or a `supersedes`.
- **Acceptance test:** an integration test over all registered kinds: put one operation of each kind in `needs_attention` (each outcome pair the kind can reach) and assert that an authorised action leaves the state and frees the domains; fails today for all but four kinds.

#### VC-007 [P1] `needs_attention` with apply outcome `unknown` has no exit when the migration turned out not to be applied

- **Area:** `packages/migrations-engine` (`kind.ts` reconcile, `reverify.ts`, `recovery.ts`), CLI
- **Block:** E
- **Reproduction:** (static; stack step for C) apply a transactional migration; cut the connection to the target during the commit and keep it down for more than 120 s so `reconcile` returns `unknown` (`kind.ts:861-880`: unreachable target or lock not taken) while the transaction rolled back; restore connectivity. The operation is `needs_attention` with apply `unknown`. Try `operation retry-verification` (refused, apply is not `applied|partially_applied`, `views.ts:285-297`), `migration verify <id> --target T` (`reverify.ts:131-134`: no ledger row → `NOT_FOUND`), `operation cancel` (`OPERATION_NOT_CANCELABLE`), `migration apply` (queues behind the parked operation's `target:<id>:schema`).
- **Expected:** a person can close an operation whose outcome the engine could not determine once the ledger shows the truth, without database surgery.
- **Actual:** the target's schema domain stays held; every later schema plan on the target waits behind it.
- **Evidence:** `E/recoverability.md` R5; `E/state-machines.md` §1.
- **Root cause:** the only closing paths (`migration.resume`, `migration.verify`) need a started non-transactional event log or an applied ledger row; a rolled-back transactional apply with an unreadable outcome is neither.
- **Proposed fix:** as the previous finding (a close action); in addition let the reconcile of `unknown` retry on a timer once the target answers instead of parking the operation after one attempt (the evidence needed, ledger row present or absent, is then readable).
- **Acceptance test:** simulate a rolled-back apply with an unreachable target during reconcile; assert that a human reaches `failed` (or an equivalent final state) with the domain released, through the CLI.

#### VC-008 [P1] One lock-blocked operation starves every younger operation: the worker re-claims the oldest waiter on every tick

- **Area:** `packages/operations` (`leases.ts`, `driver.ts`, `locks.ts`), `apps/server/src/composition/operations-loop.ts`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` §6 step 1; to be confirmed on the stack): park an operation on target A in `needs_attention` (recipes of `E/state-machines.md` SM-1); queue plan P1 on A, then P2 on target B; watch `operation list --state queued` for 5 minutes and count the `operation_events` of P1 by kind.
- **Expected:** an operation waiting for a busy exclusivity domain does not prevent unrelated operations (other targets, kinds) from starting.
- **Actual:** `claimNextOperation` takes the single oldest un-leased candidate (`ORDER BY created_at, operation_id LIMIT 1 FOR UPDATE SKIP LOCKED`, `leases.ts:52-65`). A queued operation whose locks are taken writes `lease_acquired` (`leases.ts:84-92`) and `locks_waiting` (`locks.ts:90-100`), releases the lease (`leases.ts:194-206`, `driver.ts:224-230`) and returns `waiting`; 2 s later it is the oldest un-leased row again, so P2 is never claimed. With the `needs_attention` dead end, one parked operation stops every later operation of the installation (a second worker only shifts the problem). Side effect: about 2 event rows and 2 operation-row updates per 2 s per waiter, 86,400 rows a day, 31.5 M a year.
- **Evidence:** `C/graceful-life.md` §4; `C/observability.md` row 10. **Reproduced on the stack by S1 (head-of-line blocking confirmed):** P2 on target B stayed `queued` for 73 s while P1 wrote 70 operation_events in 72 s (37 lease_acquired, 37 locks_waiting); after P1 was canceled P2 ran at once (`B/failure/C1-hypotheses.sh hol`, `B/failure/RESULTS.md` section 2).
- **Root cause:** the claim query has no notion of "recently found blocked"; one candidate per tick.
- **Proposed fix:** make blocked operations ineligible until their blocker ends (`blocked_until`/`waiting_for` on the row) or iterate candidates until one can take its locks; write `locks_waiting` only when the blocker changes.
- **Acceptance test:** two operations in disjoint domains, the older blocked by a parked `needs_attention` operation: the younger reaches `succeeded` within one poll, and the blocked one's events stay at most 3 over 60 simulated ticks.

#### VC-009 [P1] The documented rollback of an upgrade dies at once; the real way back (restore the dump) leaves every touched target blocked and every younger sign-in dead

- **Area:** `12-operations/upgrades.md` §1, `deployment.md` §6, `apps/server/src/composition/role.ts`, RB-10
- **Block:** C
- **Reproduction:** stack at `COMMIT=d0229550`; `C/upgrade/scripts/10-state.sh`, `20-dump.sh`, `40-upgrade.sh`, `60-rollback-documented.sh` (old build on the migrated store), `65-rollback-restore.sh` (RB-10 with the pre-upgrade dump), `68-divergence-old-release.sh`.
- **Expected:** `upgrades.md:14-16`: a one-release rollback works without a schema rollback.
- **Actual:** all three old roles exit 3 `process.start_refused reason=schema_newer` within 0.3 s; no listener (readiness is connection refused, the CLI answers `TRANSPORT_FAILED`); the old `control-store status` says `newer, expected 42, applied 45`; no remedy or dump hint. No pre-upgrade backup step exists in the runbook. Restoring the dump takes 7.0 s, then: (a) everything after the dump is gone (48 audit events, 6 operations, 6 plans, 66 operation events, 3 bundle revisions, 9 mirror rows); (b) staging, dev16 and dev18 answer `LEDGER_DIVERGENCE` (one sentence, no command) and the old release has no `ledger reconcile`; (c) a CLI sign-in rotated after the dump answers `UNAUTHENTICATED`; (d) the node is offline 74 s (agent backoff cap 60 s); (e) operations after the dump vanish while their ledger rows remain. This is the stack evidence for `F/findings-E1.md` third P1.
- **Evidence:** `C/upgrade/README.md` §5, §7, §8; `C/upgrade/timings.tsv`; `C/upgrade/counts-before-after.tsv`; logs `60-rollback-documented`, `65-rollback-restore`, `v6-after-restore`, `v9-divergence-old`, `90-policy-version` on vc-1 (index in `C/upgrade/logs-index.md`). Static side (agent E1): `E/docs-claims.md` DC-046, DC-047, DC-048; `E/recoverability.md` R20, R21; `upgrades.md:14-17`, `role.ts:229-233`.
- **Root cause:** the exact-match startup check `role.ts:229-233` versus a document that assumes expand/contract.
- **Proposed fix:** rewrite `upgrades.md` §1 ("roll forward, or restore the pre-upgrade dump"); make dump, `gzip -t` and a scratch restore a numbered step before `migrate`; make `schema_newer` print expected, applied and "restore the pre-upgrade dump (RB-10)"; list sign-in, node gap and per-target reconcile in RB-10; optionally an ADR for additive-compatible starts.
- **Acceptance test:** a runbook-lab test that follows the written upgrade and rollback with two real builds, then plans on every touched target after the documented reconcile.

#### VC-010 [P1] RB-10 step 6 is empty for managed targets: after a restore into an older Control Store each touched target needs an undocumented reconcile (6 steps; production 10, with a step-up and an approval)

- **Area:** `control-store-runbook.md:129-130`, `04-migrations/ledger.md` §5, `15-cli/reference.md`
- **Block:** C
- **Reproduction:** `C/control-store-loss/scripts/00-prepare.sh`, `10-destroy-observe.sh`, `20-rb10-restore.sh` (`SUPER=restore_admin2`), then `C/upgrade/scripts/70-reconcile.sh lab/platform/staging lab/platform/dev18`, then `30-prod-cycle.sh prep|destroy` and `31-prod-reconcile-stepup.sh`.
- **Expected:** step 6 lists per-target commands, scope and approvals.
- **Actual:** the text says "in Wave 2 there are no managed targets". After steps 1 to 5 every target applied after the dump answers `Error LEDGER_DIVERGENCE: ... schema changes are blocked.` with no command named. The working path is `migration ledger reconcile --target T --note ...` then `plan apply --yes`: 6 steps, 6.2 s per nonprod target (scope `migrations.import`). Production requires `approval x1` plus `reauth within 300 s`: the CLI prints a step-up address and code and waits; a person confirms, the operation is `awaiting_approval`, a person approves: 10 steps. (Control Store restore as written otherwise works: RB-10's 6 steps are 11 operator actions, about 8 s of command time.)
- **Evidence:** `C/control-store-loss/README.md` §3, §4; `C/upgrade/README.md` §5.3; logs `70-reconcile-staging`, `loss-31-prod-reconcile` on vc-1.
- **Root cause:** the runbook predates managed targets; the divergence error carries no remedy.
- **Proposed fix:** rewrite step 6 as a per-target loop with commands, scope, production step-up and approval; add the command name to the `LEDGER_DIVERGENCE` remedy.
- **Acceptance test:** a runbook-lab RB-10 test with one nonprod and one production target using only documented commands.

#### VC-011 [P1] RB-14 (keyring lost) cannot be executed: roles refuse to start or stay not ready, and nothing resets the secrets

- **Area:** `incident-model.md:63`, `secrets.md` §5, `role.ts:68-72,142-149,238`
- **Block:** C
- **Reproduction:** `C/control-store-loss/scripts/40-keyring-lost.sh`: (a) no keyring, (b) `keyring generate --key-id k1`, (c) `--key-id k2`; start the roles; try `target list`, a plan, the owner's login, `keyring status`.
- **Expected:** `secrets.md:158-161`: rotate every PostgreSQL credential through the node agent, re-enroll nothing.
- **Actual:** (a) all roles exit 2; (b) exit 3 `keyring_mismatch`; (c) roles run `not_ready`, `keyring status` says `missing ["k1"]`, reads that need no secret work, a migration plan answers 500 `INTERNAL`, the owner's password login answers 500 (`secret_key_unavailable`). `cluster credential rotate` is a plan (500) and a node job needs the lost job-signing key. The 21 secret versions include 12 PostgreSQL credentials, the TOTP seed, the job key and the node CA key. The store is append-only and no command marks secrets lost.
- **Evidence:** `C/control-store-loss/README.md` §5; log `loss-40-keyring` on vc-1.
- **Root cause:** RB-14 describes an intent; there is no reset path and a missing key is fatal at start.
- **Proposed fix:** state that keyring loss without an offline copy means a new installation, and require custody, a second copy and a yearly restore test; or build an audited offline `keyring reset-secrets`.
- **Acceptance test:** destroy the keyring on a stack with a node and a target and follow RB-14 as written to a ready system with a working credential rotation.

#### VC-012 [P1] A data read never returns when its backend dies; two such reads wedge the cluster's reader slots

- **Area:** `packages/postgres` (`TargetSession.runAdmittedRead`, `readCursor`, `runAdmittedCheck`), `apps/server/src/composition/data-read.ts`, `DataReadWorker`
- **Block:** D
- **Reproduction:** with `EXDB_TREE` and `EXDB_TEST_TARGETS` set (README of `D/sql-execution/`, "How to re-run"): `bun --conditions @exponetdb/source crash.ts --major 16 --mode sigterm` (and `--mode kill9`, which is what an OOM kill does): starts a 60 s read via `executeDataRead` and terminates its backend. Library level: `cursor-hang.ts`. Whole program: `mcp-sql-corpus.int.test.ts -t terminated`: two long `sql_query` reads, both backends terminated.
- **Expected:** `executeDataRead` ends within seconds with `TARGET_UNAVAILABLE`; the session is destroyed and the slot released; the next read works.
- **Actual:** no result 80 s after the kill in both modes (statement timeout 60 s). Through `/mcp` both callers get HTTP 504 after 91 s; the next `sql_query` on the cluster answers `TARGET_UNAVAILABLE` because the two reader slots (`DATA_READ_SLOTS_PER_CLUSTER = 2`) are held by the hung reads, so the cluster has no data reads until the worker restarts; the lane also counts the hung reads (`RATE_LIMITED` for the agent meanwhile). An earlier run: the harness `afterAll` (`w.stop`) hung 10 minutes.
- **Evidence:** `D/sql-execution/data/crash-pg16-sigterm.json`, `crash-pg16-kill9.json`, `cursor-hang.txt`, `mcp-wedge.json`, `vitest-mcp-summary.txt`; `D/sql-execution/results.md` section "Exhaustion of the target and a dead backend".
- **Root cause:** `await cursor.close().catch(() => undefined)` in the `finally` blocks of `packages/postgres/src/session.ts:850` (`runAdmittedRead`), `:753` (`runAdmittedCheck`), `:656` (`readCursor`), checked by the lead. `pg-cursor` 2.22.1 `close()` on a dead connection waits for a `readyForQuery` that never comes, so the promise never settles and the `catch` cannot help. `apps/server/src/composition/data-read.ts:40-52` releases the slot only after `executeDataRead` returns; `DataReadWorker` abort only sends a cancel (a no-op on a dead backend) and has no hard deadline.
- **Proposed fix:** never await `close()` on a broken or unqueryable client (mark broken, destroy the socket, skip close; or race close with 1 s and destroy); add a hard deadline around `executeDataRead` in `dataReadExecutor` (statement timeout plus grace, then destroy the session and release); the same for `readCursor` and `runAdmittedCheck` (the `verify.sql` path).
- **Acceptance test:** integration test on PostgreSQL 16/17/18: start a long read, `pg_terminate_backend` (and SIGKILL) its backend, assert `executeDataRead` resolves with `TARGET_UNAVAILABLE` within 5 s, the connection budget is free and the next read succeeds; plus the MCP test of `mcp-sql-corpus.int.test.ts` turning green.

#### VC-013 [P1] Nested block comments freeze the serving process: PostgreSQL's scanner is quadratic on `/*/*/*`, and comments are free in every bound

- **Area:** packages/postgres parser (`parse.ts` `parseWith`, `lexer.ts` `countTokens`), packages/migrations/lint, `application/migrations.ts` `lint`/`plan` (in-process), `migrations-engine/reads.ts` `lintProject`
- **Block:** B
- **Reproduction:** `node fixtures/gen-nested-comments.mjs 40000 > nested.sql` (160 KB: `/*` x 40,000, `*/` x 40,000, `SELECT 1;`); put it in `up.sql` of a valid bundle; call `lintBundles` / `analyzeMigrationSql(17, text, {})` (what `POST /projects/{id}/migrations/lint` and `migration.plan` run). Test: `I14-containment.pure.test.ts` ("nested-comments 40000", "quadratic scaling of the PostgreSQL scanner"), probe `tools/probe.ts nested-comments <n>`.
- **Expected:** a hostile 160 KB file (4 % of the 4 MiB file limit) is refused or processed in well under a second; a bundle cannot block the process that serves every other request.
- **Actual:** `validateBundle` (c1, linear) accepts the file in 8 ms and `MAX_PARSE_TOKENS` ignores comments, so it reaches libpg_query, which takes 546 ms at depth 10,000, 2,128 ms at 20,000, 9,136 ms at 40,000 (x4 per doubling). `analyzeMigrationSql` 18 s plus `lintBundles` 20 s at depth 40,000 (the linter analyses the file again): 38 s of one blocked thread at 160 KB; depth 50,000 (200 KB) 28.7 s CPU. Extrapolated to the 4 MiB limit: about 3 hours per file, 50 files per request, 32 MiB body (`MIGRATION_REQUEST_LIMITS`, `MIGRATION_BODY_LIMIT_BYTES`). `serve` runs this synchronously (`lintProject`; `planMigrationApply` does it inside an open Control Store transaction). The server's own scanner is quadratic in the same way, but it runs in one backend, not in the event loop of the control plane. Not run against a live `serve` (the in-process calls are the ones the handlers make).
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`, `B/conformance/tools/probe.ts`, `B/conformance/fixtures/gen-nested-comments.mjs`, `B/conformance/RESULTS.md` (I14)
- **Root cause:** PostgreSQL `scan.l` rule `xcstart = \/\*{op_chars}*` re-reads the whole run of operator characters at every nested `/*` (then `yyless(2)`); nothing in `parse.ts:219-250` or `lexer.ts:73-93` counts comment characters or comment depth, and `lint.ts:456` parses `up.sql` a second time.
- **Proposed fix:** before handing text to libpg_query, refuse a file whose block-comment nesting exceeds a small depth (the c1 scanner `sql.ts:180-200` already walks it; 32 is plenty) with a named reason; count comment openers in the token bound; run parses in a worker thread with a deadline; reuse the first analysis in the linter.
- **Acceptance test:** `I14-containment.pure.test.ts` cases "nested-comments 40000" (wall <= 10 s) and "quadratic scaling ..." (t(20,000) / t(10,000) < 3).

#### VC-014 [P1] Memory is bounded per parse, not per request: six valid 660 KB bundles kill a serve process with the documented 259 MiB heap

- **Area:** packages/migrations/src/lint/lint.ts (`BundleReport.statements` kept for every bundle), migrations-engine/reads.ts `lintProject`, planner.ts, contracts `MIGRATION_REQUEST_LIMITS`
- **Block:** B
- **Reproduction:** `node --liftoff-only --max-old-space-size=259 --conditions=@exponetdb/source tools/densescale.ts 6` (6 bundles of `SELECT 1;` x 66,000 = 198,000 tokens, 660 KB each, 4 MB in all; this is what `POST /projects/{id}/migrations/lint` or `migration.plan` do with `bundles: [...]`). Test: `I14-containment.pure.test.ts` "6 dense bundles (4.0 MB) in one lint request ...".
- **Expected:** a request that respects every documented limit (4 MiB per file, 200,000 tokens per parse, 50 bundles, 32 MiB body) is processed or refused with a named error; it never kills the process. deployment.md section 2a: "one parse below about 160 MiB, whatever the text", container 512 MiB, heap 259 MiB.
- **Actual:** the bound is per parse. Each bundle's analysis is kept in the report, about 100 to 130 MB of heap and RSS per dense bundle: peak RSS 397 / 542 / 790 / 1,134 MiB for 1 / 2 / 4 / 8 bundles (default heap). With the container's heap limit (`--max-old-space-size=259`): 3 bundles 495 MiB RSS, 4 bundles 546 MiB (over the 512 MiB container), 6 bundles `FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript heap out of memory`, exit 134. The request limit is 50 bundles and 32 MiB, i.e. about 6 GB by extrapolation. The only per-request token budget in the code is `MAX_TOTAL_PARSE_TOKENS` of the legacy import. Measured on the library calls the handlers make, not on a live container.
- **Evidence:** `B/conformance/tools/densescale.ts`, `B/conformance/I14-containment.pure.test.ts`, `B/conformance/RESULTS.md`
- **Root cause:** `lint.ts:880-905` keeps `statements` and `rollbackStatements` (the full per-statement facts) of every bundle in `BundleReport`; the report is built for all submitted bundles before anything is returned; nothing sums the token counts of a request.
- **Proposed fix:** a total token budget per lint/plan request (the legacy value of 1,000,000 is a start) refused with a named `too_large`; keep a summary instead of the statement facts for bundles beyond the first N; lint bundles one at a time and release their facts.
- **Acceptance test:** the two `dense bundles` tests (3 and 6 bundles).

#### VC-015 [P1] Another quadratic regular expression over bundle text: the `-- check:` directive of `verify.sql` (neighbour of TC-004)

- **Area:** `packages/postgres/src/parser/verify-checks.ts:45` (`DIRECTIVE`), reached from `analyzeVerifyFile` in the planner (`planner.ts:230`, serve), `reverify.ts:156`, `verification.ts:289` (worker) and the lint
- **Block:** R
- **Reproduction:** `analyzeVerifyFile(17, '-- check: ok' + ' '.repeat(n) + 'x\nSELECT true AS ok;\n')`, probe `R/R1-notes/probes/tc004-neighbour-verify-directive.mts`, `node --conditions=@exponetdb/source`: n = 10,000: 128 ms; 20,000: 485 ms; 40,000: 1,785 ms; 80,000: 7,071 ms (x4 per x2, quadratic). The request body limit for bundle text is 32 MiB (`MIGRATION_BODY_LIMIT_BYTES`), so 1 MiB of white space is about twenty minutes on the synchronous event loop of serve (at ingest-and-plan) and of the worker (at verification), and the bundle stays stored in the project stream.
- **Expected:** linear time; the regular expression class that TC-004 removed from `guardStrictness` does not remain elsewhere in `packages/postgres`.
- **Actual:** `(.*?)\s*$` rescans the trailing white space from every position of the lazy group.
- **Evidence:** `R/R1-notes/TC-004.md`, probe output in the same file.
- **Root cause:** `DIRECTIVE = /^--\s*(check|covers|calls|reads-view):[ \t]*(.*?)\s*$/` (lazy group followed by `\s*$`).
- **Proposed fix:** match `^--\s*(check|covers|calls|reads-view):[ \t]*(.*)$` and `trimEnd()` the captured value (linear).
- **Acceptance test:** `packages/postgres/test/verify-checks.test.ts`: a directive line followed by 1 MiB of white space is analysed in under 200 ms and the ratio time(1 MiB)/time(256 KiB) is below 8; existing directive tests unchanged.

#### VC-016 [P1] CREATE TABLE ... (id serial PRIMARY KEY ...) can never be applied: the engine's own structural verification fails and rolls back

- **Area:** `packages/postgres/src/parser/migration.ts` (column expectations), `packages/migrations-engine`
- **Block:** C (found while building state; the bundle system is Block B's)
- **Reproduction:** `C/upgrade/scripts/95-serial-column.sh`: bundle `CREATE TABLE public.va (id serial PRIMARY KEY, name text NOT NULL);` on a fresh PostgreSQL 17 target, plan (allowed), `plan apply`; the same with `bigserial`. `GENERATED ALWAYS AS IDENTITY` and `int` succeed.
- **Expected:** a verified apply.
- **Actual:** `failed / not_applied / VERIFICATION_FAILED` after 0.1 s on both `d0229550` and `d51da5d0`; gate detail `{"first":"column \"public\".\"va\".\"id\"","layer":"L0","checks":4,"failed":1}`; nothing is created; the CLI says only `VERIFICATION_FAILED`. Supabase-origin schemas are full of `serial`/`bigserial`, so a replay of such a history onto an empty database (invariant I10) hits this. (`main` has since gained L0 fixes for named `ADD CONSTRAINT`, #47; the lead did not re-test `serial` on `main`.)
- **Evidence:** `C/upgrade/NOTES.md`; log `95-serial-column.out` on vc-1.
- **Root cause:** the column expectation takes the raw parse type name `serial` (`migration.ts:399-420`, used at `:1324-1352`, no `serial` handling anywhere in the file, checked by the lead) while the catalog holds `integer` with a `nextval` default; `hasDefault` is set only for DEFAULT, IDENTITY and GENERATED.
- **Proposed fix:** map `smallserial|serial|bigserial` (qualified and case variants) to `int2|int4|int8`, not null, has default; or mark such columns underived. Related: `F/findings-B3.md` first P1 (the same blind spot for ADD COLUMN).
- **Acceptance test:** a test on PostgreSQL 16, 17 and 18: `CREATE TABLE t (id serial PRIMARY KEY)` and `bigserial` bundles reach `succeeded / applied / passed`.

#### VC-017 [P1] ADD COLUMN serial/bigserial/identity rewrites the table under ACCESS EXCLUSIVE; lint and plan call it additive and brief

- **Area:** `packages/postgres/src/parser/migration.ts`, `packages/migrations/src/lint`
- **Block:** B
- **Reproduction:** `B/ddl-hazard/tools/run-analysis.sh` (needs `EXDB_TREE` and the pinned toolchain) and `tools/run-cli-lint.sh`; read bundles h08 (`ADD COLUMN seq bigserial`) and h09 (`ADD COLUMN line_no bigint GENERATED ALWAYS AS IDENTITY`) in `results/hazard-strict-plan-large.json`. Then `pgcheck/00-setup.sh && pgcheck/01-checks.sh` and read h08, h09 (PostgreSQL 17.11).
- **Expected:** `volatile_default_rewrite`, observed class `data_rewrite`, lock `critical`, rewrite `table`, a `rewriteRisk` with the table size.
- **Actual:** no lint finding, observed `additive`, lock `high` (brief), rewrite `none`. PostgreSQL: `rewritten=true seq_scans=3 size_x=1.09`, ACCESS EXCLUSIVE held. The production approver is told the change is brief; it holds the lock for up to 15 minutes (`statement_timeout`).
- **Evidence:** `B/ddl-hazard/evidence/pgcheck-01-rewrite-lock-scan.txt` (h08, h09); `B/ddl-hazard/results/hazard-strict-plan-large.json`; `B/ddl-hazard/evidence/cli-lint-hazard-strict.txt`
- **Root cause:** `migration.ts:760-772` inspects only `CONSTR_DEFAULT`. `serial` is a type name expanded after the raw parse, and `CONSTR_IDENTITY` sets no volatile flag (only `CONSTR_GENERATED` does).
- **Proposed fix:** treat serial types (smallserial, serial, bigserial, any schema qualification or case) and `CONSTR_IDENTITY` in ADD COLUMN as volatile: rewrite `table`, class `data_rewrite`, `volatile_default_rewrite`.
- **Acceptance test:** a lint unit test that `ADD COLUMN s bigserial` and `ADD COLUMN s bigint GENERATED ALWAYS AS IDENTITY` yield `volatile_default_rewrite`, `data_rewrite`, rewrite `table`; an integration test on PostgreSQL 16/17/18 that fails if the relfilenode changes without that classification.

### P2 (62)

#### VC-018 [P2] main has no branch protection or required checks, and cancel-in-progress cancels CI of commits on main

- **Area:** repository settings, `.github/workflows/ci.yml` (concurrency)
- **Block:** A
- **Reproduction:** `gh api repos/davdxpx/ExponetDB/branches/main/protection` gives 404 "Branch not protected" (checked by the lead); `gh api repos/davdxpx/ExponetDB/rulesets` gives `[]`; `gh run list --repo davdxpx/ExponetDB --branch main --limit 14`.
- **Expected:** required checks (the 18 jobs) on main, and a finished CI verdict for every commit on main.
- **Actual:** CI is advisory. `cancel-in-progress: true` also applies to pushes to main. `d0229550` (Wave 9 Part B), `4573c09a`, `92a416f4` and `a0fda7ca` are "cancelled"; `cad5ac15` failed; only `02ed23ca` and `d51da5d0` are green. The pre-fix commit never had a completed CI verdict. The run on `d51da5d0` (40750567758) passed all 18 jobs (checked by the lead).
- **Evidence:** `A/README.md`, section "GitHub Actions".
- **Root cause:** `ci.yml:23-25` (no event condition on `cancel-in-progress`); no branch protection configured.
- **Proposed fix:** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; a ruleset requiring the 18 checks, pull requests only, no force push; list the required checks in `authoring-and-ci.md`.
- **Acceptance test:** two pushes within a minute to a protected test branch both finish; a pull request with a red job cannot merge; the protection API lists the contexts.

#### VC-019 [P2] The agent-capabilities host test failed once in CI on the next main commit (NODE_OFFLINE after an injected crash); not reproduced

- **Area:** `apps/server/test/agent-capabilities.host.test.ts` (job `node-pg`)
- **Block:** A
- **Reproduction:** `gh run view 40761095455 --repo davdxpx/ExponetDB` (commit `c89bbe1a`, PR #47, which touches no node code): step "Capability operations end to end" failed after 523 s with `expected [503,'NODE_OFFLINE'] to deeply equal [202, undefined]` at test line 724 (the `inspect` helper), called from line 1540 right after the SIGKILL restarts. `d51da5d0` passed in CI; vc-1 passed 3 of 3 (568, 568, 567 s).
- **Expected:** the test waits until the restarted agent has a session before posting an inspection.
- **Actual:** `inspect` posts at once and requires 202; the route answers 503 NODE_OFFLINE while the agent is between restart and its next claim. 1 red of 5 observed runs.
- **Evidence:** `A/README.md`, "Flakiness" (the failing job log is on the lead's machine only).
- **Root cause:** suspected test race (not proven): `agent-capabilities.host.test.ts` about lines 715-727 and 1536-1545, no `eventually` on node liveness after `inject(..., 'crash')`.
- **Proposed fix:** `await eventually('node online', ...)` before the first post-crash inspection and keep 202 strict; split the 9-minute single test into steps.
- **Acceptance test:** 10 consecutive runs on a disposable systemd host all green, plus a helper test with a stub gateway reporting offline for 3 s.

#### VC-020 [P2] Evidence rule is weaker than documented: any operation id counts, no divergence check on the evidence target, verification rows not cross-checked with the mirror

- **Area:** packages/migrations-engine/src/evidence.ts, kind.ts (#evidenceBindings), policy migration.staging-evidence
- **Block:** B
- **Reproduction:** Static; needs superuser write on the staging database. Take a migration M that production wants and staging never applied. On staging insert a schema_migrations row for M with the checksum production will submit and `operation_id` = the id of any operation in the Control Store. Insert a `passed` migration_verifications row with M's verify digest. Plan M for production.
- **Expected:** Evidence `missing` or `unverified`. staging-production-policy.md §1.2 condition 3 needs a row produced by this installation and no LEDGER_DIVERGENCE on the evidence target. §6 lists "ledger row inserted by hand is not evidence".
- **Actual:** "Known" is `operations.operations` looked up by id only (evidence.ts:181-190, 209, checked by the lead): any kind, target or project. No ledger-vs-mirror comparison on the evidence target (readEvidenceTarget, evidence.ts:98-125). Verification is read from the target, never from migrations.verification_mirror. The same weak attribution heals a hand-written row with a real operation id into the mirror (divergence.ts:46-48, records.ts:188-191). Acceptance (kind.ts:225-260) does not repeat condition 3.
- **Evidence:** B/contract.md §2.5, §2.6, §3 DF-08, DF-09.
- **Root cause:** Attribution by operation id alone. The mirror, which exists to catch tampering, is not consulted.
- **Proposed fix:** An evidence row counts only if the mirror holds the same (target, generation, migration_id, checksum, operation_id). The operation must be a migration.apply or resume of that target whose plan lists the migration, and the verification id must be in verification_mirror. Add the live divergence check for the evidence target. Make operationsOfTarget require the plan to include the migration id.
- **Acceptance test:** B/conformance/I12-promotion.int.test.ts row "forged evidence with a known operation id" (fails today). I07-adoption.int.test.ts row "hand-written ledger row with a real operation id of this target" (expects LEDGER_DIVERGENCE unrecorded).

#### VC-021 [P2] The apply checksum depends on client-supplied project defaults: editing `defaults` after an apply makes applied bundles a non-overridable MIGRATION_CHECKSUM_MISMATCH

- **Area:** packages/migrations/src/format/projection.ts, migrations-engine/src/store.ts and planner.ts, CLI migration plan
- **Block:** B
- **Reproduction:** Exploratory (pure, B/conformance/exploratory/c1-pairs.ts, Bun 1.3.14 on the lead's machine, to be repeated on the pinned toolchain): same up.sql and migration.yaml (no lockTimeout), project default lockTimeout absent vs 10s, gives different checksums. The same holds for statementTimeout 30m and for searchPath. Stack: apply bundle B (manifest silent on timeouts, role, search path) on staging. Change defaults.lockTimeout in exponetdb.project.yaml. Run `exponetdb migration plan --target <staging>` (the CLI resubmits all local bundles, migration.ts:487-508).
- **Expected:** migration-bundles.md §3: a later change of the project default cannot change what an applied migration meant. An applied id keeps its identity.
- **Actual:** `defaults` come from the request (store.ts:150, planner.ts:597) and are hashed (projection.ts:129-155). The new checksum differs from the ledger's, so MIGRATION_CHECKSUM_MISMATCH (store.ts:197-207), not overridable, and the whole default CLI plan is refused. The server holds no authoritative copy of the defaults.
- **Evidence:** B/conformance/exploratory/c1-pairs.out rows "PROJECT default ..."; B/contract.md §3 DF-14, §6.
- **Root cause:** An input of the identity is neither part of the bundle nor stored per project.
- **Proposed fix:** Keep the project defaults in the registry, versioned and changed by a planned operation, and ignore or refuse the request's copy. Or materialize defaults into migration.yaml at `migration new` so the bundle is self-contained. No c2 needed.
- **Acceptance test:** B/conformance/I02-content-identity.test.ts (pure: a project-default change must not change the checksum of an unchanged bundle of the same project; fails today). Plus a stack test that a changed default is refused or ignored with a clear code.

#### VC-022 [P2] Default `migration plan` and `migration apply` submit every local bundle; the request accepts 50

- **Area:** apps/cli/src/commands/migration.ts, packages/contracts/src/rest/migrations.ts
- **Block:** B
- **Reproduction:** Exploratory (pure, B/conformance/exploratory/limits.ts): MigrationPlanRequestSchema accepts 50 bundles; 51 and 500 fail with `bundles: Too big: expected array to have <=50 items` (MIGRATION_REQUEST_LIMITS = { bundles: 50, migrationIds: 200 }, contracts/src/rest/migrations.ts:68, checked by the lead). CLI: a project with 51 bundle directories, `exponetdb migration plan --target <t>` without ids; submissions(ctx, []) returns all (migration.ts:487-493), checkedBody throws UsageError (cli/planning.ts:66-75).
- **Expected:** authoring-and-ci.md §4 and the CLI reference: ids "default: what is pending". The CLI reads up to 5,000 bundles (local/project.ts:25).
- **Actual:** The default flow stops at the 51st bundle of the stream, applied ones included. Naming ids is a workaround. The 50/200 limits are documented only in 06-rest-api/resources.md:103.
- **Evidence:** B/conformance/exploratory/limits.out; B/contract.md §3 DF-17. **Confirmed by S5 on a 500-bundle project:** `The request does not match the contract: bundles: Too big: expected array to have <=50 items` (exit 2); batches of 50 plan in 1.7 s in all three DAG shapes and 200 stored ids in 3.5 s; the limit appears in no 04-migrations or 15-cli document (`B/rehearsal/README.md` §5).
- **Root cause:** The CLI cannot know what is pending without the server, and submits everything.
- **Proposed fix:** Ask the server for the pending ids (`migration status` already knows them). Submit only those, plus stored ancestors by id. Document the limits in 04-migrations/.
- **Acceptance test:** apps/cli test: 60 local bundles, 55 applied, `migration plan` submits only the pending ones and succeeds. I15-limits.test.ts compares every limit with its document.

#### VC-023 [P2] Ledger divergence is noticed only when someone plans: no periodic check, no finding, no suspension

- **Area:** apps/server/src/composition/worker-tasks.ts, packages/migrations-engine/src/divergence.ts
- **Block:** B
- **Reproduction:** Static. Delete or insert a row in a production target's exponetdb.schema_migrations by hand. Wait 30 min. Read findings, target state, drift-check history.
- **Expected:** ledger.md §5: periodic reconciliation (default every 10 min per active target, and on every plan). The divergence table says target suspended for schema changes, finding raised.
- **Actual:** The comparison runs on migration.apply plans (planner.ts:145, 397), on `migration status` (reads.ts:191) and inside writeMirror. There is no worker task, no finding, and the target stays active. Drift kind B does not exist as a finding.
- **Evidence:** B/contract.md §2.5, §3 DF-11, DF-22. **Stack timings (S5, S3):** after a point-in-time restore to before the last bundle, `target show` read Health healthy with `Ledger: unknown`, `migration status` was the only place saying "Mirror: out of sync", and `migration plan` answered `LEDGER_DIVERGENCE` with no next step; the recovery `migration ledger reconcile` + `plan apply` took 3.9 s (nonprod: no approval, no step-up), consistent again after 72 s (planned PITR) or 4 min 24 s (crash, including re-pointing the endpoint). The error should name `migration ledger reconcile` (`B/rehearsal/results/pitr-restore.txt`, `crash-recovery.txt`). **Also (S6):** a hand-made ledger row on a stack target was planned over without `LEDGER_DIVERGENCE`: `migration status` said "Mirror: out of sync", `target show` said "Ledger: unknown" with 0 findings, `drift check` was clean, `migration plan` allowed, no log line; the row is permanent (append-only trigger) (`C/stack/observability-results.md` step 11).
- **Root cause:** Waived with E24/E25 ("no detection yet"), not revisited.
- **Proposed fix:** A worker task every 10 min per active target (observer read plus compareLedger). It opens a critical finding `ledger_divergence` naming the ids and resolves it when the ledger agrees. Optionally suspend schema operations.
- **Acceptance test:** Stack: hand-edit the ledger, wait one interval, expect a critical finding and an alertable audit or metric signal.

#### VC-024 [P2] `generation` never changes: documented restore protections are inert, and a future bump switches the divergence check off and re-adopts the restored ledger

- **Area:** packages/registry/src/register.ts:169, migrations-engine/src/divergence.ts:79, records.ts:170-210
- **Block:** B
- **Reproduction:** Static. The registry's only writer of registry.targets.generation is the insert with literal 1 (register.ts:166-170, checked by the lead; the other `SET generation` hits are the mirror table). Latent: set generation to 2 (what ledger.md §4.5 and backup-runbooks.md §3.1 step 7 describe), keep a generation-1 mirror that is ahead of the restored ledger, run a plan, then an apply.
- **Expected:** ledger.md §4.5/§5 and E25: a restore makes plans stale and a person reconciles the mirror. A divergence stays a divergence.
- **Actual:** Today nothing bumps it, so stale plans after a restore, evidence condition 4 and a marker-generation mismatch cannot trigger. If it is bumped, readMirrorFacts returns undefined for the new generation (divergence.ts:79) and ledgerDivergence returns null (no comparison). The next apply's writeMirror starts from an empty mirror and inserts every ledger row whose operation_id belongs to any operation of the target (records.ts:180-191; operationsOfTarget is not generation-scoped). The restored ledger is adopted with no human.
- **Evidence:** B/contract.md §2.5 "Latent hazard", §3 DF-10, DF-13.
- **Root cause:** "Never mirrored yet" and "new generation" are one code path.
- **Proposed fix:** A target with a mirror for an earlier generation and none for the current one is a divergence needing ledger.reconcile. Carry the mirror forward only through an explicit planned operation. Add the test before the bump is built.
- **Acceptance test:** A variant of packages/migrations-engine/test/reconcile.int.test.ts: bump the generation, expect LEDGER_DIVERGENCE on the next plan and no mirror row written by a following apply.

#### VC-025 [P2] Lint overrides, lint profile and invariants are taken from the plan request, not from an authoritative project record

- **Area:** migrations-engine/src/planner.ts:474-495, contracts/src/rest/migrations.ts:197-208, policy catalog
- **Block:** B
- **Reproduction:** Static. POST /targets/{production}/migrations/plans with lintProfile "standard" and lint.rules {unsafe_not_null: off, create_index_without_concurrently: off, ...} for a bundle `strict` would block. Compare blockingFindings and the decision with the same request without the overrides. (MCP cannot send them; REST, CLI and SDK can.)
- **Expected:** analysis.md §6: the project's reviewed exponetdb.project.yaml may lower a rule, shown in plans. Fixed rules are never lowered.
- **Actual:** The overrides come from whoever plans (the CLI sends its working-tree file; the server cannot tell it from the reviewed one). The plan shows `lowered` on the finding (lint.ts:305-330), but no policy rule treats a lowered production rule as a reason for approval or denial.
- **Evidence:** B/contract.md §3 DF-15.
- **Root cause:** Project configuration has no server-side home (same root as the defaults finding).
- **Proposed fix:** Keep lintProfile, lint and invariants in the registry project record. Ignore or refuse the request's copy for a production plan. Add a policy rule requiring approval when a blocking rule was lowered.
- **Acceptance test:** Stack: the request above on production is refused or yields `require`. A change of the registry record is audited.

#### VC-026 [P2] Lint and plan over a dependency chain are cubic: 800 chained bundles take 61 s, a 1,000-deep chain plans in 53 s, 5,000 would take hours

- **Area:** packages/migrations/src/lint/lint.ts (`parallel_object_overlap`), migrations-engine/planner.ts
- **Block:** B
- **Reproduction:** `node --liftoff-only --conditions=@exponetdb/source tools/lintscale.ts chain 100,200,400,800`; engine: `I3-order.int.test.ts` "a 1,000-deep chain plans in dependency order within a time and memory budget" (prints the plan time); control `tools/lintscale.ts indep 50,...,800` is linear (0.6 ms per bundle at 800). Tests: `I3-order-is-the-dag.pure.test.ts` "lint time over a chain of n bundles must not grow faster than quadratically".
- **Expected:** lint/plan time proportional to the number of bundles (the brief's scale target is 500 and 5,000 bundles in one project; `dependency-graph.md` section 7 says validation is O(V+E)).
- **Actual:** chain of 50 / 100 / 200 / 400 / 800 bundles: 234 ms, 268 ms, 1.1 s, 7.1 s, 61 s (x8.7 per doubling = cubic). Through the engine, 1,000 chained bundles in 20 batches of 50 plus one plan: 52.9 s (RSS +37 MiB) on a quiet machine, and `ControlStoreError: A Control Store statement or lock wait timed out` on a loaded one: the lint runs inside the plan's Control Store transaction, whose `idle_in_transaction_session_timeout` is 60 s (`store.ts:364`, `bootstrap-sql.ts:70`; the error is mapped to `control_store_timeout` for SQLSTATE 57014, 55P03 and 25P03), so a plan whose lint needs more than a minute (about 800 chained bundles) is expected to fail; the failure was observed once, under load, in `readPolicySettings` right after the lint. By extrapolation 5,000 take about 4 hours of one blocked thread. A fresh target that has every bundle pending (a new environment, a replay for I10) is exactly this shape.
- **Evidence:** `B/conformance/tools/lintscale.ts`, `B/conformance/I3-order.int.test.ts`, `B/conformance/I3-order-is-the-dag.pure.test.ts` **More shapes measured by S5 (client lint):** chain 250/500 take 3.2 s / 22 s, diamonds 250/500/1,000 take 5.5 s / 45 s / 344 s (RSS 244 MB) against 1.8 s for a 500-wide fan-out; 5,000 diamonds extrapolate to about 12 hours (`B/rehearsal/README.md` §5). The server side is bounded by the plan cap of 50 inline bundles.
- **Root cause:** `lint.ts` (block "unordered migrations touching the same object") loops over all pairs `i < j` and calls `g.ancestors(ia)` and `g.ancestors(ib)` for each pair; `graph.ts:137-159` `ancestors` walks the graph and sorts the result: O(n^2) pairs x O(n log n).
- **Proposed fix:** compute `sharedObject` first (cheap, index by object name), and compute reachability once (memoised ancestor sets or a topological-index bitset); only pairs that share an object need an ancestor test.
- **Acceptance test:** the ratio test above (t(400)/t(200) < 3.5) and a 5,000-bundle chain linted in under 30 s.

#### VC-027 [P2] `up.sql` can release the engine's own target lock: `SELECT pg_advisory_unlock_all();` is applied and the `EXDB` locks disappear while the migration runs

- **Area:** packages/postgres/src/parser/migration.ts (`settingsCall`, function handling), migrations-engine/executor.ts, concurrency
- **Block:** B (invariant I4, touches I8)
- **Reproduction:** `fixtures/unlock-engine-lock.sql` as `up.sql` (transactional) on a registered target; poll `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND classid = 1163412546` while it runs. Test: `I4-atomicity.int.test.ts` "up.sql cannot release the engine's own target lock".
- **Expected:** the single-writer lock (`concurrency.md`) is held from lock acquisition to the end of the operation whatever the bundle contains; content that touches advisory locks is refused or ineffective.
- **Actual:** lint passes, the plan is allowed, the statement runs, and the migrator session holds 2 `EXDB` advisory locks before and 0 after, on PostgreSQL 16, 17 and 18. The rest of the migration (here a 4 s `pg_sleep`) runs with no engine lock; a second operation could take the lock and start. The ledger SHARE lock and table locks still serialise the actual DDL, so this is a protocol bypass, not data loss.
- **Evidence:** `B/conformance/I4-atomicity.int.test.ts`, `B/conformance/fixtures/unlock-engine-lock.sql`
- **Root cause:** `migration.ts:700-725` `settingsCall` looks only at `set_config`; no function is denied, and `readEngineGuards` (`migration-facts.ts:240-290`) does not read the lock.
- **Proposed fix:** deny `pg_advisory_*` (all lock and unlock functions) in top-level statements and verify after every statement that the engine's lock is still held by the session (one `pg_locks` read, like the ledger guard).
- **Acceptance test:** the same int test: the lock count is unchanged during the migration, or the bundle is refused at lint time.

#### VC-028 [P2] The bundle store decides "applied elsewhere" from the Control Store mirror only: in the commit-to-mirror window other bytes under an applied id are accepted

- **Area:** packages/migrations-engine/src/store.ts (`appliedElsewhere`, `ingestBundles`)
- **Block:** B (I13)
- **Reproduction:** apply bundle X on target A; delete its row from `migrations.ledger_mirror` (the state between COMMIT on the target and the mirror write after a crash; `reconcile` repairs it later); submit X with other bytes in a plan for target B. Test: `I13-immutability.int.test.ts` "INVARIANT: after an apply, other bytes under the same id are refused even if the ledger mirror has not caught up".
- **Expected:** `MIGRATION_CHECKSUM_MISMATCH` ("same id, different checksum than the ledger of any target of the project", `migration-bundles.md` section 3, not overridable).
- **Actual:** the rewritten bytes are stored as the newest revision (`rewritten_unapplied`). A later `migrationIds: [X]` plan for target B then takes the NEWEST revision, so X can be applied on B with other bytes than on A (the planner compares only with the ledger of the target it plans for). With the mirror intact, the same flow is refused (test "after an apply on ANY target ... MIGRATION_CHECKSUM_MISMATCH" passes).
- **Evidence:** `B/conformance/I13-immutability.int.test.ts`
- **Root cause:** `store.ts:123-137` queries `migrations.ledger_mirror` only; the live ledgers are read per target at plan time (`planner.ts:309-320`).
- **Proposed fix:** treat an id with any pending or unreconciled operation, or any target whose `ledger_state` is not current, as applied; or read the evidence/ledger of the project's targets at ingest.
- **Acceptance test:** the failing int case above.

#### VC-029 [P2] volatile_default_rewrite fires for stable and immutable defaults (now(), any unqualified function) and forces data_rewrite

- **Area:** `packages/postgres/src/parser/migration.ts`, `packages/migrations/src/lint/lint.ts`
- **Block:** B
- **Reproduction:** lint bundles h06 (`DEFAULT now()`) and h07 (`DEFAULT lower('NEW')`) in the hazard project (CLI, offline); `pgcheck/01-checks.sh` shows h06, h07, h06b.
- **Expected:** no rewrite finding: PostgreSQL 11+ evaluates stable and immutable defaults once, without a rewrite.
- **Actual:** `volatile_default_rewrite` (BLOCKS on a large table) plus `compatibility_understated` (a fixed error unless the author declares `data_rewrite`); observed `data_rewrite`, lock critical, rewrite `table`; policy then asks for a verified backup and an approval. PostgreSQL: `rewritten=false seq_scans=0` for h06 and h07; `clock_timestamp()` (h06b) does rewrite.
- **Evidence:** `pgcheck-01-rewrite-lock-scan.txt` (h06, h06b, h07); `results/hazard-strict-plan-large.json`
- **Root cause:** `migration.ts:496-525`: `now`, `statement_timestamp`, `transaction_timestamp` are in `VOLATILE_DEFAULTS`, and any function not explicitly `pg_catalog` counts as volatile.
- **Proposed fix:** classify by `pg_proc.provolatile` from the target catalog (the planner already reads the catalog), or at least drop the stable names from the list and keep "unknown function = volatile" only offline.
- **Acceptance test:** lint test that `ADD COLUMN c timestamptz NOT NULL DEFAULT now()` has no `volatile_default_rewrite` and observed class `additive`, while `DEFAULT clock_timestamp()` and `gen_random_uuid()` still fire.

#### VC-030 [P2] type_change_rewrite blocks every ALTER COLUMN TYPE including the no-rewrite cases; no lint-clean form exists

- **Area:** `packages/postgres/src/parser/migration.ts`, lint rule `type_change_rewrite`
- **Block:** B
- **Reproduction:** lint h12 (varchar(200) to varchar(500)), h13 (timestamp to timestamptz) and safe fixture s30; `pgcheck/01-checks.sh`: h12, h12b, h13, h13b.
- **Expected:** analysis.md §3: a binary-coercible change is `high`, no rewrite.
- **Actual:** `type_change_rewrite` BLOCKS on production for a large table, class data_rewrite, lock critical, rewrite `possible`. PostgreSQL: varchar widening and varchar to text `rewritten=false seq_scans=0`; timestamp to timestamptz with the engine's pinned `TimeZone=UTC` `rewritten=false` (a Berlin session rewrites).
- **Evidence:** `pgcheck-01-rewrite-lock-scan.txt`; `results/safe-strict-plan-large.json` (s30)
- **Root cause:** `migration.ts:840-846` assumes a rewrite for every `AT_AlterColumnType` ("needs the old type"); the planner reads sizes from the target but not column types.
- **Proposed fix:** have the planner pass column types as catalog facts and classify the known no-rewrite changes, keeping `possible` as the fallback.
- **Acceptance test:** lint test with a catalog fact (varchar(200)) and `TYPE varchar(500)` yields no finding; an integration test that compares the classification with the relfilenode on PostgreSQL 16/17/18.

#### VC-031 [P2] The documented NOT NULL recipe cannot pass the planner: unsafe_not_null fires after the validated CHECK

- **Area:** `packages/migrations/src/lint/lint.ts`, `packages/migrations-engine/src/planner.ts`
- **Block:** B
- **Reproduction:** lint safe fixture s08 (`SET NOT NULL` after s06 and s07, the recipe of authoring-and-ci.md §6); `grep -rn provenNotNull packages apps` (only `lint.ts` reads it).
- **Expected:** with a validated `CHECK (col IS NOT NULL)` the rule does not fire (analysis.md §3: `high`, no scan).
- **Actual:** `unsafe_not_null` BLOCKS on a large table in the planner context (and offline). PostgreSQL: `SET NOT NULL` after a validated CHECK makes 0 scans. The only workaround is lowering the rule project-wide; `migration.lint-errors` is not break-glass overridable. On the PG 18 grammar `NOT NULL ... NOT VALID` lints clean.
- **Evidence:** `pgcheck-01` (h14, h14b); `results/safe-strict-plan-large.json` (s08); `results/*-lowered.json`
- **Root cause:** `lint.ts:555-562` needs `ctx.catalog.provenNotNull`; `planner.ts:668-677` builds the catalog with `relations` only and nothing in the tree populates `provenNotNull`.
- **Proposed fix:** read validated `CHECK (col IS NOT NULL)` constraints into `provenNotNull` at plan time; the check must also hold for a CHECK added by an earlier bundle of the same plan.
- **Acceptance test:** integration test: a target with a validated NOT NULL CHECK plus the bundle `SET NOT NULL` produces no blocking finding; without the CHECK it still blocks.

#### VC-032 [P2] ADD CONSTRAINT ... UNIQUE USING INDEX is flagged like a scanning constraint

- **Area:** `packages/postgres/src/parser/migration.ts:925-932`, lint rule `add_constraint_without_not_valid`
- **Block:** B
- **Reproduction:** lint safe fixture s15 (after s14); `pgcheck/01-checks.sh` h17b.
- **Expected:** no finding: the step is metadata only.
- **Actual:** `add_constraint_without_not_valid` BLOCKS, lock critical, duration scan; the remediation ("add it NOT VALID") does not exist for UNIQUE. PostgreSQL: the `USING INDEX` step makes 0 scans.
- **Evidence:** `pgcheck-01` (h17, h17b); `results/safe-strict-plan-large.json`
- **Root cause:** every `CONSTR_UNIQUE` and `CONSTR_PRIMARY` is treated as a validating scan; the raw node's `indexname` (USING INDEX) is ignored.
- **Proposed fix:** if `indexname` is set, severity `high`, duration `brief`, `constraintValidated = false`.
- **Acceptance test:** lint test: `ADD CONSTRAINT k UNIQUE USING INDEX i` has no finding; `ADD CONSTRAINT k UNIQUE (c)` still does.

#### VC-033 [P2] A cheap statement's ACCESS EXCLUSIVE held through later slow statements of the same transactional bundle is reported as brief

- **Area:** `packages/migrations/src/lint`, `packages/migrations-engine/src/analysis.ts`
- **Block:** B
- **Reproduction:** lint h24 (`ADD COLUMN` then `UPDATE ... WHERE created_at >= '2000-01-01'`) and h42 (the four NOT NULL steps in one bundle); `pgcheck/01-checks.sh` h24, h14b.
- **Expected:** a finding or a hold-time note; the engine's own safe recipe split exists to avoid exactly this.
- **Actual:** no finding; lock `high` (brief). PostgreSQL: ACCESS EXCLUSIVE still held after the UPDATE (table size x2.00) and after VALIDATE (both AEL and SUEL held). Hold time is bounded only per statement (15 min), not per bundle.
- **Evidence:** `pgcheck-01` (h24, h14b); `results/hazard-strict-plan-large.json`
- **Root cause:** lock facts are per statement and `lockSeverity` is the worst single statement; lock lifetime to COMMIT is not modeled.
- **Proposed fix:** in a transactional bundle, a lock of class ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE followed by a scanning or data-changing statement raises severity to `critical`, or add a rule like `lock_held_across_slow_statement`.
- **Acceptance test:** lint test for h24 and h42 expecting the new finding; the split bundles (s06, s07, s08) stay clean.

#### VC-034 [P2] DETACH PARTITION ... CONCURRENTLY cannot be authored

- **Area:** `packages/postgres/src/parser/migration.ts:1012-1019`, lint rules `needless_nontransactional`, `nontransactional_statement_in_transactional`
- **Block:** B
- **Reproduction:** lint h45 (transactional) and h46 (`transactional: false`); `pgcheck/02-more-checks.sh` (h45 part) and h45 in 01.
- **Expected:** h45 refused at lint with `nontransactional_statement_in_transactional`; h46 accepted.
- **Actual:** h45: no lint finding, policy `require`, then PostgreSQL fails at apply ("cannot run inside a transaction block"). h46: `needless_nontransactional` (fixed error, not lowerable). The statement works in autocommit, so the engine can never run it.
- **Evidence:** `results/hazard-strict-plan-large.json` (h45, h46); `pgcheck-01` (h45); `pgcheck-02` (h45) Also `F/findings-B2.md` (agent B2 found it as the only miss of a 40-statement server-oracle sweep: the plan is accepted and the server fails the apply atomically).
- **Root cause:** the `concurrent` field of the PartitionCmd is ignored, so the statement is never `autocommitOnly`.
- **Proposed fix:** set `autocommitOnly` for `AT_DetachPartition` with `concurrent`; lock severity `low`.
- **Acceptance test:** lint test: h45 gives the fixed error, h46 passes with no finding; an integration test applies h46 on a target.

#### VC-035 [P2] Lock-queue protections the docs promise are not delivered

- **Area:** `packages/migrations-engine/src/planner.ts`, `packages/migrations/src/lint/rules.ts`, `packages/postgres/src/session.ts`
- **Block:** B
- **Reproduction:** `grep -rniE "pg_stat_activity|xact_start|pg_blocking_pids|wait_event" packages/migrations-engine/src` returns nothing. Lint h43 (`lockTimeout: 2h`). `session.ts:100`. `pgcheck/02-more-checks.sh` shows the queue itself: a reader holds the table 9 s, the DDL gives up at 5 s, a SELECT behind it waits 4.1 s against a baseline of 0.08 s (PostgreSQL 17).
- **Expected:** analysis.md §3: for prod the plan shows the longest-running queries on the affected tables. planning-and-apply.md §6: `lock_timeout` maximum 60 s without a lint acknowledgement; §5: `idle_in_transaction_session_timeout` 120 s.
- **Actual:** the plan has no activity context. A 2 h lockTimeout lints as `long_lock_timeout` warn (never blocks) and plans with `require`. The migrator session gets 30 s.
- **Evidence:** `pgcheck-02-multi-session.txt`; `results/hazard-strict-plan-large.json` (h43)
- **Root cause:** not implemented (`rules.ts:210-216`; `session.ts:100`; no activity read in the planner).
- **Proposed fix:** implement or correct the documents. For an ACCESS EXCLUSIVE statement on prod, read `pg_stat_activity` (sessions with `xact_start` older than N seconds on the affected relations) into the plan.
- **Acceptance test:** an integration test with a long reader on the table: the plan carries the blocker; `lockTimeout > 60s` without an acknowledgement is a blocking finding.

#### VC-036 [P2] A killed or crash-looping process counts as live for 45 s, so a restart loop shorter than that reads operational

- **Area:** `packages/control-store/src/heartbeats.ts`, `packages/application/src/installation-health.ts`, `apps/server/src/composition/role.ts` (`liveWorkerCheck`), `roles/run-role.ts`
- **Block:** C
- **Reproduction:** static (`C/observability.md` step 8): `docker kill -s KILL worker; sleep 20; docker start worker` in a loop for 3 minutes while polling `GET /installation/health` and `/healthz/detail`; also `docker stop --time 5 worker` during an apply.
- **Expected:** a dead or restarting worker does not make "workers" operational; a crash loop is visible.
- **Actual:** `liveProcesses` counts rows with `stopped_at IS NULL AND heartbeat_at > now() - 45 s` (`heartbeats.ts:63-85`). `markStopped` runs only in `services.stop()`, which a worker blocked in `stopLoops()` by a running operation does not reach before the 25 s bound (`run-role.ts:101-108`, `operations-loop.ts:74-82`), and never after SIGKILL or OOM. Installation health `workers` stays operational and serve's `workers` check stays `pass` (`role.ts:268-279`). No restart counter exists.
- **Evidence:** `C/observability.md` §1.3 item 4, row 3.
- **Root cause:** liveness is heartbeat age only; no stop marker for a hard kill; no start-rate signal.
- **Proposed fix:** report instances started in the last 15 minutes in `workers.values` and degrade at 3 or more; add a process start-time gauge.
- **Acceptance test:** register three worker rows within a minute without `markStopped`; `readInstallationHealth(...).workers.state` is `degraded` with reason `restart_loop`.

#### VC-037 [P2] A Control Store outage, a read-only store or a full disk is answered 500 INTERNAL, and pool exhaustion is reported as "unreachable"

- **Area:** `packages/control-store/src/errors.ts`, `apps/server/src/interfaces/http/request.ts` (`errorCodeOf`), `packages/contracts/src/errors.ts`, `apps/server/src/composition/role.ts`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` steps 2-5): `ALTER DATABASE exponetdb_control SET default_transaction_read_only = on` and terminate backends; `docker pause cs`; fill the data volume; 200 concurrent reads against a slow store. Record status, problem code, log line, readiness.
- **Expected:** `503 CONTROL_PLANE_DEGRADED` (retryable, "ExponetDB itself is not ready") with a reason; read-only and full are classified.
- **Actual:** `errorCodeOf` returns only catalog codes (`request.ts:152-162`); every `ControlStoreError` code is outside the catalog, so the answer is 500 INTERNAL "An unexpected error occurred" (`errors.ts:1425-1430`). `CONTROL_PLANE_DEGRADED` is raised only for the role/scope catalog (`api.ts:2184`, `mcp/edge.ts:482`). SQLSTATE 25006, 53100, 53200, 53400 map to `control_store_query_failed` (`errors.ts:75-120`); only 08*, 57P01-03, 53300 map to unavailable. A pool connect timeout (5 s, `store.ts:365`) is reported as "The Control Store is unreachable" although the store is up. Readiness probes share the application pool, so saturation gives `check_timeout`, `not_ready`, an unhealthy container, and serve leaves Traefik: a spike becomes an outage. Readiness `control_store` is `SELECT 1` (`role.ts:88-93`) and passes on a read-only store; only the failed heartbeat write detects it, about 45-50 s late.
- **Evidence:** `C/fail-closed.md` §2-3; `C/observability.md` row 5.
- **Root cause:** the interface maps catalog codes only; a short SQLSTATE list; probes share the application pool.
- **Proposed fix:** map unavailable, timeout, read-only, full and pool errors to `CONTROL_PLANE_DEGRADED` with `reason`; classify the SQLSTATEs; give readiness its own connection and a write probe (`SHOW transaction_read_only`).
- **Acceptance test:** integration tests with a read-only, an unreachable and a pool-starved store assert 503 with the reason, `not_ready` within one evaluation for read-only, and `ready` again after a pool spike clears.

#### VC-038 [P2] The shipped metrics cannot alert on most failures: every API request is route="/unmatched" and the documented operational metrics do not exist

- **Area:** `apps/server/src/interfaces/http/app.ts`, `packages/observability`, `10-observability/self-observability.md` §3
- **Block:** C
- **Reproduction:** static (`C/observability.md` steps 1-2): scrape `/metrics` of serve, worker and gateway after calling `/api/v1/targets`, `/fleet`, `/nodes` ten times each.
- **Expected:** route-template series and the §3 metrics (`exdb_operations_total`, `exdb_operation_step_duration_seconds`, `exdb_policy_decisions_total`, `exdb_sampler_lag_seconds`, `exdb_sample_failures_total`, `exdb_agent_connected`, `exdb_agent_job_duration_seconds`, `exdb_lock_wait_seconds`).
- **Actual:** `base()` records `routes.includes(c.req.path) ? c.req.path : '/unmatched'` (`app.ts:107-110`) and the list holds only probes, `/mcp`, two schema URLs and the OpenAPI path (`app.ts:176-181`); the test pins `route="/unmatched"` (`apps/server/test/http.test.ts:91`). Eleven metrics exist in all. Nothing counts targets by health, nodes offline, certificate expiry, backup age, operations by state or age, approvals waiting, sampler lag or restarts. Registries are per role; `/metrics` is unauthenticated and loopback-bound by default with no runbook for scraping.
- **Evidence:** `C/observability.md` §1.1, §2.1.
- **Root cause:** Wave 2 foundation metrics were never extended; the route template is not used by the middleware.
- **Proposed fix:** record the matched route template after `next()`; register the §3 metrics; worker-refreshed gauges for targets and nodes by state, soonest certificate expiry, oldest waiting operation and last backup age; document the scrape set-up.
- **Acceptance test:** three API calls produce three route-template series; a coverage test that every metric named in §3 is registered by some role.

#### VC-039 [P2] Backup and drill signals are not produced: the drill-finding generator is never run and the catalog is never refreshed on a schedule

- **Area:** `packages/backups/src/findings.ts`, `apps/server/src/composition/worker-tasks.ts`, `packages/backups/src/protection.ts`, `09-backups-and-restore/{architecture,adoption}.md`
- **Block:** C
- **Reproduction:** static (`C/observability.md` steps 12-13): let a host-timer backup fail and a drill fail; wait 15 and 30 minutes; read `GET /clusters/{id}/backups` and `/findings?state=all`; then call `maintainDrillFindings` by hand.
- **Expected:** `findings.ts` says `backup_drill_never_run|overdue|failed` and `restore_scratch_left` are computed by "a worker task"; `architecture.md:123` and `protection.ts:12` say the mirror is refreshed every 10 minutes.
- **Actual:** `maintainDrillFindings` has no caller except `apps/server/test/http-backups.int.test.ts:368`; `WORKER_TASKS` (`worker-tasks.ts:176-314`) has no backup task. Catalog refresh is a person-started operation (`backup.catalog.refresh`; `adoption.md:69` "[PLANNED] a scheduled refresh"; `plans.ts:308` "ExponetDB starts no scheduled run"). After 30 minutes without a refresh the cluster reads `catalog_stale`/`at_risk`; host-timer failures are invisible until a refresh; a failed drill leaves no finding.
- **Evidence:** `C/observability.md` rows 8, 9.
- **Root cause:** Part B built the generator and the read model but not the scheduler.
- **Proposed fix:** worker tasks `backups.findings` (5 min) and `backups.catalog` (10 min per cluster with a live repository), or amend the documents; findings for `catalog_stale` and `wal_archive_failing`.
- **Acceptance test:** a failed drill record yields an open critical `backup_drill_failed` finding within one task interval; a stale catalog is refreshed without a person.

#### VC-040 [P2] No signal exists for an expiring certificate: certificate_expiring and tls_expiring are documented and typed but nothing produces them

- **Area:** `07-node-agent/enrollment.md:145-146`, `10-observability/health.md:121`, `packages/diagnostics/src/reducer.ts`, `packages/nodes`, `installation-health.ts`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` steps 5, 10, 11): advance the node host clock into the renewal window with the agent stopped; register a target whose server certificate expires in 5 days; read `GET /findings`, `/nodes/{id}`, `/targets/{id}/health`, `/installation/health`.
- **Expected:** a node whose renewal keeps failing is `degraded` with `certificate_expiring` and a finding (`enrollment.md:145-146`); a target certificate within 30/7 days gives `tls_expiring` (`health.md:121`; in the contract enum `resources.ts:177` and Web `health-model.ts:52`).
- **Actual:** no code produces either string (`node-runbook.md:233-237` and OD-62 say the node finding is "not built", contradicting `enrollment.md`). The reducer's only TLS condition is `plaintext_connections` (`reducer.ts:393`); the agent sends no `serverCertificateExpiresAt` (R2). The gateway certificate and the CAs (5 and 10 years, no rotation command; `node-pki` has only init, postgres-ca and job-key) are never warned about. A node down for the 24 h renewal window reads `offline` with the same `NODE_CERTIFICATE_REFUSED` as any refusal. Installation health `gateway` is operational unless all nodes are offline, so one expired node of ten is invisible. (The live node's certificate renewed itself on 2026-10-29, consistent with `enroll.go:303-312` and `agent.go:446-470`; the gap is the missing warning, not the renewal.)
- **Evidence:** `C/keys-certs-time.md` §1.
- **Root cause:** signals designed and left unbuilt; OD-62 covers only the node part.
- **Proposed fix:** worker task `certificates.check` opening subject findings for node certificates (24 h or less without renewal), gateway and CA expiry and target server certificates (30 and 7 days from the peer certificate); count offline nodes in the gateway component state; fix the contradicting document.
- **Acceptance test:** a node certificate expiring in 6 h with an agent that cannot renew gives an open finding; `tls_expiring` appears for a target certificate with 20 days left.

#### VC-041 [P2] Time-based checks mix the process clock with the database clock and there is no skew check

- **Area:** `packages/operations/src/plans.ts:166-176`, `accept.ts:179-184`, `packages/nodes/src/tokens.ts:79`, `views.ts:58-71`, `gateway.ts:119-125,279-285`, `packages/operations/src/driver.ts:96-110`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` steps 6-8): serve clock +2 h: create a `critical` plan, compare `expiresAt` with `SELECT clock_timestamp()`, apply 90 minutes later; read `GET /nodes` with +2 min; step the worker clock back 5 minutes after a failed lease renewal.
- **Expected:** a plan lives at most its class limit in one time base; node offline uses one clock; lease belief is monotonic.
- **Actual:** a plan's `created_at`/`expires_at` come from the creator's `nowMs()` and the database `CHECK (expires_at <= created_at + 2 hours)` is relative to the same wrong `created_at`; `acceptPlan` and `plans.expire` judge with the database clock. A serve ahead by delta gives delta extra lifetime in database time (a 15 minute critical plan lives a day at +1 day); behind, it expires early. The same pattern holds for the enrollment-token reveal window. `stateOf` compares serve's `Date.now()` with a heartbeat written by `clock_timestamp()` (`nodes/up.sql:620`), so a skewed serve flaps all nodes. The worker's lease belief uses `Date.now()` (`driver.ts:96-110`). `self-observability.md:91` lists a skew check; `:107` says it is not built.
- **Evidence:** `C/keys-certs-time.md` §3.
- **Root cause:** plan and token times are computed in the application and hashed into the plan body, but judged in database time.
- **Proposed fix:** read the database time before hashing, or refuse creation when the process clock differs from the database by more than a bound; use `performance.now()` for lease belief; add the skew check with a readiness warning above 5 s.
- **Acceptance test:** with a fake clock +1 day, creating a plan fails with a named error (or the stored `expires_at - clock_timestamp()` is at most the class limit); a stepped wall clock does not change the lease-abort decision.

#### VC-042 [P2] Documented retention classes have no pruning code, and every drift check rewrites every open finding

- **Area:** `02-control-plane/data-retention.md`, `packages/operations`, `packages/diagnostics/src/{drift,findings,snapshots}.ts`, `packages/auth/src/sessions.ts`, `worker-tasks.ts`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` step 8): after a week count rows and `min(created_at)` of `operations.operations/plans/plan_bodies/operation_events`, `auth.sessions`, `stepup.step_ups`, `nodes.enrollment_tokens`, `observation.drift_checks/schema_snapshots` and resolved `observation.findings`; import a 14k-object schema, run 10 drift checks, compare `n_tup_upd` and WAL of `observation.findings`.
- **Expected:** `data-retention.md` §1: plans 90 d, no-effect operations 400 d, event detail 90 d, resolved findings 400 d, drift documents 90 d, sessions expiry + 30 d; "nothing grows without a rule".
- **Actual:** the only deletions are auth challenges and rate limits, OAuth state, idempotency keys, process heartbeats, health and statement partitions and the manual audit prune (`rg "DELETE FROM|drop_expired"`). Plans, bodies, operations, events, approvals, step-ups, tokens, sessions, snapshots, drift checks and resolved findings are never deleted. `upsertFinding` does `ON CONFLICT DO UPDATE SET occurrences = occurrences + 1, last_seen_at = ...` for every open finding on every drift check (`findings.ts:143`; indexed column, so no HOT update): the first campaign's live target had 13,968 open findings, about 1.3 M updates a day for a prod target at the 15 minute cadence (`drift.ts:725`).
- **Evidence:** `C/graceful-life.md` §5.
- **Root cause:** the table was written as design; only the Wave 2-4 classes got tasks.
- **Proposed fix:** a `retention.prune` task per class with the documented bounds and audited summaries; update an open finding at most once a day or on state change.
- **Acceptance test:** per-class tests that old rows go and referenced rows stay; 1,000 open findings produce at most 1 write per finding per day.

#### VC-043 [P2] The audit gate is invisible to probes: a missing audit partition fails every mutation with a plain 500 while /healthz/ready stays ready

- **Area:** `packages/audit/src/writer.ts`, `apps/server/src/composition/role.ts`, worker task `audit.partitions`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` step 1): detach the current monthly partition of `audit.audit_events`; call any mutation; read `/healthz/ready`, `/installation/health`, the log.
- **Expected:** mutations stop (they do) and the operator is told: a readiness reason such as `audit_unwritable` and a named error.
- **Actual:** the append is in the mutation's transaction (`writer.ts:57-134`), so the gate works. No readiness check appends or inspects partitions; `AuditWriteError` is outside the catalog and becomes 500 INTERNAL; heartbeats, samples, drift checks and sessions keep writing. Partitions run 3 months ahead from a 6 h worker task (`lock_timeout 5s`), so it needs a long worker outage or a Control Store restored from an older dump into a later month.
- **Evidence:** `C/fail-closed.md` §1, §2 row "Audit append impossible".
- **Root cause:** audit health comes from export and verification outcomes, not appendability.
- **Proposed fix:** a readiness check requiring partitions for now and now + 7 d (warn under 30 days of margin); map `audit_append_failed` to `CONTROL_PLANE_DEGRADED` with reason `audit_unavailable`.
- **Acceptance test:** detaching the current partition makes readiness degraded or not_ready within one interval and a mutation returns 503 with the reason.

#### VC-044 [P2] A redeploy interrupts a running apply although upgrades.md says workers stop at step boundaries; Docker's default stop time is shorter than the 25 s timeout

- **Area:** `apps/server/src/composition/operations-loop.ts:74-82`, `roles/run-role.ts:101-108`, `12-operations/{upgrades,deployment}.md`
- **Block:** C
- **Reproduction:** static (`C/graceful-life.md` step 2; to be confirmed on the stack): run a 90 s `pg_sleep` migration (transactional and non-transactional); `docker stop --time 60 worker` after 10 s, then with the default 10 s; record exit code, `process.stopped{ok}`, the heartbeat row, the target session, the ledger and the operation events after restart.
- **Expected:** `upgrades.md:24-26` "workers stop at step boundaries and reconcile on start"; a documented way to redeploy without cutting an apply.
- **Actual:** `stop()` sets a flag and awaits the whole `drive()`; the abort signal exists only for a lost lease (`driver.ts:85-117`); an execute step is not interruptible. After 25 s the process exits 1 mid-execute (earlier under Docker's 10 s default, which no deploy file or runbook changes). The target session dies (a transactional bundle rolls back; a non-transactional one gives `MIGRATION_INCOMPLETE`); reconcile happens after the 30 s lease. `services.stop()` is skipped so the heartbeat is not marked stopped. No runbook step says to wait until nothing is `running` or `verifying`.
- **Evidence:** `C/graceful-life.md` §1. **Measured by S3 on the new release** (`C/upgrade/scripts/80-sigterm.sh`): with Docker's default stop time the worker was killed at 11.3 s, with `--time 60` it exited 1 at 26.2 s; both times the apply was lost, the operation ended `failed/not_applied` 19 to 26 s after restart (via `needs_reconciliation`), no half-apply for a transactional bundle, the heartbeat row kept `stopped_at IS NULL`, and the target session kept running after the worker died. S1 saw the same (`B/failure/RESULTS.md`). Non-transactional variant: NOT RUN (the plan is denied by lint).
- **Root cause:** graceful stop waits instead of draining; the document describes an intent.
- **Proposed fix:** on SIGTERM stop claiming, let the running step finish within a drain window while `not_ready`, set the stop grace period in the deployment record, add a drain step to `upgrades.md`.
- **Acceptance test:** SIGTERM during a 60 s apply with a 120 s drain window ends `succeeded` with exit code 0; with a 5 s window the operation reaches a reconciled state and the heartbeat row is marked stopped.

#### VC-045 [P2] A refused recovery has already closed the needs_attention operation and released its lock domain

- **Area:** packages/operations (supersede.ts, driver.ts), bundle operation-supersession (fix of TC-005)
- **Block:** D
- **Reproduction:** `D/d0/tests/supersede-order.int.test.ts`, run from `packages/operations` in a scratch copy of the tree under test with vitest and `--config vitest.integration.config.ts` (exploratory run on Node 26.5 / Bun 1.3.14 / PostgreSQL 17.11; to be repeated on the pinned toolchain). Case a: the recovery plan is refused with PLAN_STALE at dispatch. Case b: admit returns GRANT_REVOKED. Case c: the recovery then waits on another domain.
- **Expected:** a recovery that is refused or that has to wait leaves the operation it names in needs_attention with its lock, exactly as before.
- **Actual:** the named operation ends `verification_failed` with its lock released and committed, while the recovery did nothing. All three cases pass, so the defect is present (spot check by the lead: `driver.ts:178-186` calls `closeSuperseded` first, then `acquireLocks`, `checkBindings` and `admit`; the refusal paths `return` inside the transaction, so it commits).
- **Evidence:** D/new-bundles-security-review.md §3 (finding 1); D/d0/tests/supersede-order.int.test.ts; D/d0/logs/supersede-order.log. **Reproduced end to end on the stack by S1** (`B/failure/I9-exits.sh supersede`): V (`migration.verify` naming N) was refused (`failed`) after the CLI grant was revoked, while N (needs_attention) ended `verification_failed` with its lock released, although the recovery did nothing.
- **Root cause:** `packages/operations/src/driver.ts:178-186`: `closeSuperseded` (:179) runs before `acquireLocks` (:180), `checkBindings` (:184) and `admit` (:186).
- **Proposed fix:** perform the close after the locks, bindings and admission succeed, or wrap it in a savepoint and roll back to it on refusal or wait.
- **Acceptance test:** the same three cases with inverted assertions (the operation stays needs_attention and keeps its lock when the recovery is refused or waits).

#### VC-046 [P2] migrations.ledger_mirror is rewritable in place by the worker; "insert-and-revert-only" is code convention only

- **Area:** bundle migration-engine (frozen) and ledger-reconcile; `migrations.ledger_mirror`
- **Block:** D
- **Reproduction:** `D/d0/` exercise_archive.sql A10, as the worker role against a PostgreSQL 17.11 scratch database: `DELETE` gives 42501, but `UPDATE migrations.ledger_mirror SET checksum = 'FORGED'` and `UPDATE ... SET generation = 99` both succeed and leave no history row.
- **Expected:** ledger.md §5 and `ledger-reconcile/migration.yaml:10`: the mirror is insert-and-revert-only for the worker; a reconciliation deletes no row anywhere, and every change of a mirror row is kept.
- **Actual:** the worker holds table-wide UPDATE (`migration-engine/up.sql:142`: `GRANT INSERT, UPDATE ON migrations.ledger_mirror, ...`, checked by the lead) and no trigger limits the columns. A compromised or buggy worker can rewrite what the divergence check compares against, which is the control that catches a restored or hand-edited ledger.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 2); D/d0/ exercise_archive.sql and proposed_mirror_guard.sql.
- **Root cause:** a frozen bundle grants more than the documented contract; the new bundle added the history table but not the matching guard.
- **Proposed fix:** a new additive bundle with a BEFORE UPDATE trigger that allows only `reverted_at`, `reverted_by_op` and `mirrored_at` to change (D0 tested `proposed_mirror_guard.sql`: forged updates refused, the engine upsert still works, the archive still deletes).
- **Acceptance test:** worker UPDATE of checksum, generation or migration_id is refused; the three allowed columns pass; the engine's upsert and `archive_mirror_rows` still work.

#### VC-047 [P2] A request body of up to 32 MiB is read, parsed and validated before the permission check

- **Area:** `apps/server` REST layer (`interfaces/http/api.ts`), MCP edge for the bundle tools
- **Block:** D
- **Reproduction:** `cp D/authz/repro/ordering.repro.ts <tree>/apps/server/ && cd <tree>/apps/server && bun --conditions=@exponetdb/source ordering.repro.ts` (in process, stub use case that refuses like the engine for a caller without `migrations.plan`; a bearer holding only `targets.read`). Output at `d51da5d0`: `[1]` 3 bytes -> 422 VALIDATION_FAILED, use case not reached; valid-shaped 4 MiB -> 403 PERMISSION_DENIED after 115 ms, +29 MiB RSS; valid-shaped 28 MiB (limit 32 MiB) -> 403 after 1387 ms, +118 MiB RSS. Over HTTP with a database and proxy: NOT RUN.
- **Expected:** authorization.md section 1 (line 29): "Phase 1 ... Before input parsing: ... Cheap; rejects most unauthorized calls before untrusted input is parsed." A principal without `migrations.plan` is refused before its body is read and validated, or at least a large body is gated by concurrency.
- **Actual:** the body is read (`readLimitedText`), `JSON.parse`d and schema-validated first (`api.ts:2240`, `:2247-2275`), the handler and so the engine run last (`:2295`). Routes with `maxBodyBytes` above the default: `MIGRATION_BODY_LIMIT_BYTES` 32 MiB (`routes.ts:2334`, `:2413`; ingest, plan, lint), `LEGACY_BODY_LIMIT_BYTES` 16 MiB (`:2390`, `:2518`). Only the legacy lane has an in-flight cap (`api.ts` `LEGACY_REQUESTS_IN_FLIGHT`, applied inside the handler, after the parse). Any authenticated credential (a viewer API key, a nonprod read grant) can therefore make the process buffer, parse and validate 32 MiB per request, and sees schema validation detail (422) instead of 403.
- **Evidence:** `D/authz/repro/ordering.repro.ts`, run output above. **Confirmed over HTTP by S4:** a viewer bearer posting a valid-shaped 28.5 MiB body to a plan route gets 403 after 0.22 to 0.27 s while serve RSS rises by 130 to 210 MiB (8 in parallel peak at 838 MiB); an unauthenticated request is closed before the body is read (`D/security/authz-run.md`).
- **Root cause:** `mountApi` authenticates (cookie or bearer) and checks CSRF, then reads and validates input generically for every route; authorization lives inside the use cases (`application.ts` `#authorize`), after the handler is entered.
- **Proposed fix:** for routes whose `maxBodyBytes` exceeds the default, call `application.admit(caller, route.action)` (phase 1: client kind, human-only, scope, permission anywhere) before `readBody`; add a global in-flight cap or byte budget for large bodies; apply the same ordering in the MCP edge for `bundleBody` tools (the edge already rate-limits by tool class). Keep validation errors after authorization.
- **Acceptance test:** a stub-Application test as in the reproduction asserting that for a principal without the permission (a) the status is 403, (b) neither `JSON.parse` nor the route schema ran (spy), (c) a 30 MiB body does not raise RSS above a few MiB; fails before the fix.

#### VC-048 [P2] A single read floods the target's disk with temp files; the row cap does not bound the work

- **Area:** `packages/postgres/src/bootstrap.ts` (`SETTINGS.reader`/`verifier`, `bootstrapScript`), `data.read`
- **Block:** D
- **Reproduction:** `bomb.ts` scenario `temp-files-15s` (PostgreSQL 17) or `limits.ts`: `SELECT g FROM generate_series(1, 1000000000) g` as agent (row cap 500, timeout 15 s); `tempfix.ts --major 16` shows the fix.
- **Expected:** 500 rows with `truncated: true` (`sql-execution-security.md` §2.2), bounded disk use.
- **Actual:** `QUERY_TIMEOUT`, no rows; the temp directory holds 2,262 MB after 14 s on PostgreSQL 17 (about 150 MB/s; 1.5 GB in 8.6 s on PostgreSQL 16), about 9 GB per read at the 60 s agent timeout, with 2 agent reads per target at once; `FunctionScan` materialises the set-returning function before the first row.
- **Evidence:** `D/sql-execution/data/bomb-pg17.jsonl`, `tempfix-pg16.json`, `limits-pg16/17/18.jsonl` (limit-001, human-rows).
- **Root cause:** `bootstrap.ts:48-51` (reader) and the matching lines in `bootstrapScript` set no `temp_file_limit` (the lead's grep finds none); admission allows set-returning functions in `FROM`.
- **Proposed fix:** add `temp_file_limit` (for example 1GB) to the reader and verifier role settings in both bootstrap generators and document it; existing clusters: `ALTER ROLE exponetdb_reader SET temp_file_limit = '1GB'`.
- **Acceptance test:** integration test on PostgreSQL 16/17/18: the read above fails with SQLSTATE 53400 (`QUERY_FAILED`) within a few seconds and the temp directory stays under the limit (observed with 256 MB: 53400 after 1.2 s, peak 239 MB, against 1,569 MB without).

#### VC-049 [P2] The CLI prints most error `details` only with `--json`: `PLAN_STALE` does not say which binding changed

- **Area:** `apps/cli/src/output/render.ts:150-210`
- **Block:** E
- **Reproduction:** (probe, run) `probe2.ts` calls `renderHuman` with the catalog's real `details` for nine codes; the human lines after the message are empty for `PLAN_STALE`, `OPERATION_CONFLICT`, `MIGRATION_EXECUTION_FAILED`, `POLICY_DENIED`, `APPROVAL_COOLING_PERIOD`, `OPERATION_NOT_RETRYABLE`, `VERIFICATION_FAILED`, and show only `migrationId` / `missing` for `MIGRATION_CHECKSUM_MISMATCH` and `LEDGER_DIVERGENCE` (their `knownChecksum`, `where`, `checksumDiffers`, `unrecorded` are hidden). Stack step: `plan apply` a plan after changing the schema by hand.
- **Expected:** a refused command names what refused it (binding, blocking operation, rule, SQLSTATE and statement, time).
- **Actual:** "The plan no longer matches the target. Create a new plan." and a request id.
- **Evidence:** `E/errors.md` §5.1.
- **Root cause:** `NAMED_DETAILS` lists five keys only (`render.ts:150-157`).
- **Proposed fix:** a per-code detail renderer driven by the catalog's `details` schema (print every scalar and id list, capped), tested against the generated catalog so a new code cannot ship without a rendering.
- **Acceptance test:** for every catalog code with a `details` schema, `renderHuman` of a sample payload contains every id field of the payload (fails for nine or more codes today).

#### VC-050 [P2] The CLI recommends `operation retry-verification` for operations the server refuses

- **Area:** `apps/cli/src/output/views.ts:365-380` (`operationNext`)
- **Block:** E
- **Reproduction:** (probe, run) `probe4.ts`: `operationNext` of an operation in `needs_attention`, apply `applied`, verification `error` returns `exponetdb operation retry-verification <op>` for `backup.run`, `node.enroll` and `ledger.reconcile` although `retryable` is false; the Web App respects the server's flag (`apps/web/src/features/changes/operation-page.tsx:342`).
- **Expected:** the hint appears only when the server says `retryable`; otherwise the CLI says there is no automated recovery.
- **Actual:** the operator is sent to `OPERATION_NOT_RETRYABLE` (409) at the worst moment.
- **Evidence:** `E/vocabulary.md` row "verify"; `E/state-machines.md` §1.
- **Root cause:** the CLI re-implements the rule without the kind list.
- **Proposed fix:** use `OperationRead.retryable`.
- **Acceptance test:** a CLI unit test with `retryable:false` expects no `retry-verification` hint.

#### VC-051 [P2] A superseded `needs_attention` operation is recorded with verification outcome `failed` although verification never ran

- **Area:** `packages/operations/src/supersede.ts:49-66`
- **Block:** E
- **Reproduction:** (static; stack step for C) path R4 of `E/recoverability.md`: after `migration verify <id>` closes the stuck operation, `operation show <stuck>`.
- **Expected:** a final state that tells what happened: change applied or unknown, verification not run, closed by a recovery plan.
- **Actual:** `verification_failed` with `verificationOutcome: failed` (and `unknown` rewritten to `partially_applied`); no verification row exists; the Web App says "Verification failed". C-13 (truthful reads) is the rule.
- **Evidence:** `E/state-machines.md` §1 (row `verification_failed`).
- **Root cause:** the closing edge reuses the only terminal state that admits applied plus unfinished verification.
- **Proposed fix:** show `supersededBy` ("closed by <op>") in CLI and Web, or add a distinct terminal state (additive bundle, needs OD-58).
- **Acceptance test:** closing a stuck operation exposes its closer in `operation show --output json` and the human view does not say "verification failed".

#### VC-052 [P2] The documented repair of a broken `verify.sql` cannot be completed with the CLI

- **Area:** `apps/cli` (no `ingest` command), `04-migrations/verification.md:419-433`, `failure-and-recovery.md` E10
- **Block:** E
- **Reproduction:** (ran: command list) `exponetdb commands` has no command that stores a bundle revision. (static) `migration plan` ingests inside the plan transaction (`planner.ts:595`) and refuses with `MIGRATION_ALREADY_APPLIED` when nothing is pending (`planner.ts:350-352`), which rolls the ingest back. REST `migration.bundle.ingest` exists (`packages/application/src/migrations.ts:93-113`); CLI and MCP do not use it. Stack step: apply a migration, edit `verify.sql`, `migration plan --target T <id>`, then `migration verify <id> --revision 2`.
- **Expected:** "The new bundle revision is ingested" by a CLI step; then `migration verify` runs with the new digest.
- **Actual:** revision 2 never reaches the store through the CLI; `migration verify --revision 2` answers `NOT_FOUND`.
- **Evidence:** `E/recoverability.md` R8; `E/state-machines.md` §4.
- **Root cause:** `migration.bundle.ingest` was built for REST only.
- **Proposed fix:** `exponetdb migration ingest [paths…]` (class low, audited) listing the statuses `stored|unchanged|verify_revision|rewritten_unapplied`.
- **Acceptance test:** E10 end to end through the CLI only, including the ingest step.

#### VC-053 [P2] RB-10 (Control Store down) leaves the ledger-mirror problem unaddressed

- **Area:** `12-operations/control-store-runbook.md:129-130`
- **Block:** E
- **Reproduction:** (static; stack step for C) restore the Control Store from a dump older than the last apply of a staging target; `exponetdb migration status --target T`, then `migration plan`.
- **Expected:** step 6 gives the commands for each managed target.
- **Actual:** "Reconcile ledger mirrors against target ledgers (from Wave 4, F30); in Wave 2 there are no managed targets." After a restore the mirror lacks rows and the operations that explain the target's ledger rows, so `unrecorded` rows (`divergence.ts`) refuse every plan on every target until a `migration ledger reconcile` is applied per target, which needs scope `migrations.import` (the `admin` preset only) and, on production, a human approval and a fresh re-authentication.
- **Evidence:** `E/docs-claims.md` DC-057; `E/recoverability.md` R21.
- **Root cause:** the runbook predates managed targets.
- **Proposed fix:** rewrite step 6 as a per-target loop with commands, scopes and the expected `LEDGER_DIVERGENCE` sequence; reference it from the upgrade-rollback path.
- **Acceptance test:** a runbook-lab test of RB-10 on a stack with one staging target passes with only the documented commands.

#### VC-054 [P2] A plan from before an upgrade, or a lost race, answers HTTP 500 `INTERNAL` instead of a catalog code

- **Area:** `packages/operations/src/errors.ts`, `accept.ts:192`, `apps/server/src/interfaces/http/request.ts:152-162`
- **Block:** E
- **Reproduction:** (probe, run) `probe1.ts`: `isErrorCode('operation_kind_unknown') === false`, `isErrorCode('operation_state_changed') === false`; `errorCodeOf` maps both to `INTERNAL`. (static) `acceptPlan` returns `operation_kind_unknown` when `kind.version !== plan.kindVersion`; a concurrent second request with the same `Idempotency-Key` throws `idempotency_in_progress` (`idempotency.ts:72`). Stack step: create a plan, change a kind's `version` in a build, apply the old plan; send two requests with one key.
- **Expected:** `upgrades.md:29` (`[DECIDED]`): such plans "expire with `PLAN_STALE` (reason `engine_version`)"; a duplicate in-flight request gets a retryable 409.
- **Actual:** 500 with the generic message; only the log has the cause.
- **Evidence:** `E/errors.md` §4; `E/docs-claims.md` DC-049.
- **Root cause:** internal operation codes have no mapping to catalog codes.
- **Proposed fix:** map `operation_kind_unknown` to `PLAN_STALE` with binding `kindVersion`, `operation_state_changed` to `OPERATION_CONFLICT` / `PLAN_ALREADY_USED`, `idempotency_in_progress` to a 409.
- **Acceptance test:** a contract test that every `InternalOperationCode` reachable from a route maps to a catalog code.

#### VC-055 [P2] A plan does not check that its own verification can run: a missing verifier credential parks the target after the commit

- **Area:** `packages/migrations-engine/src/planner.ts`, `verification.ts`, registry credentials (role `verifier`)
- **Block:** E
- **Reproduction:** (static; stack step for C) Register a target in a cluster that has no `verifier` credential. `exponetdb migration plan --target <staging> <id>`, then `plan apply`. Static reading: `grep -in "verifier\|credential" packages/migrations-engine/src/planner.ts` finds nothing; `verification.ts:284-286` opens `connector.forTarget(target, 'verifier', ...)` only after the commit and returns `errorLayer('verifier connection')` when it cannot; `planning-and-apply.md` §4 (line 417) states the consequence: "without one, L2 is an `error` and the operation goes to `needs_attention`".
- **Expected:** a plan that promises verification either cannot be made without a usable verifier, or says so as a finding the approver sees; for a production target the policy refuses or requires approval (C-11: unknown safety state fails closed for writes; C-13).
- **Actual:** the plan is allowed, the change commits, verification ends `error`, and the operation sits in `needs_attention` holding `target:<id>:schema` until a person submits the credential in the Web App and retries. For any kind other than the four migration kinds that exit is missing altogether (see the P1 entries on `needs_attention`).
- **Evidence:** `E/docs-claims.md` DC-025 ("makes `needs_attention` a routine state"); `E/recoverability.md` R3; `E/structure.md` §3 and `E/proposals.md` P-07.
- **Root cause:** the preconditions of the verification are not facts of the plan; the registry knows which credentials exist (`ROLES` includes `verifier`, `packages/registry/src/records.ts:332`).
- **Proposed fix:** add `verifierReady` (credential present for the cluster, and the problems `verifierProblems` reports) to the planner's facts; a policy rule denies a production plan when it is false and shows a warning finding otherwise.
- **Acceptance test:** an engine integration test: a target without a verifier credential gives a plan with the finding (or a refusal on production); with the credential the plan is allowed. Fails before.

#### VC-056 [P2] Recovery by naming exists for two migration kinds only; every other operation that ends `needs_attention` with an unknown outcome still keeps its domain for ever (TC-005 neighbour)

- **Area:** `packages/operations/src/kinds.ts` (`supersedes` is optional), implemented only in `packages/migrations-engine/src/kind.ts` (`migration.apply`, by `resume`) and `reverify.ts` (`migration.verify`)
- **Block:** R
- **Reproduction:** read: `grep -rn "supersedes" packages/*/src` lists the two kinds. `restore.discard` (`packages/backups/src/kinds.ts:1572-1582`) answers `unknown` from `reconcile` whenever its job did not judge `succeeded` (also when the job failed definitively), the driver then moves the operation to `needs_attention` (`driver.ts:340-352`), and the operation keeps `cluster:<id>:backup` (`kinds.ts:1511`). `ledger.reconcile`, `migration.rollback`, `migration.baseline`, `drift.accept`, `backup.run`, `restore.execute` and the node config kinds have the same shape. The fix's own driver test (`driver.int.test.ts`, "is blocked for ever without the plan naming it") is the proof of the mechanism for a kind that does not name the operation.
- **Expected:** TC-005's acceptance "state-machine unit test that `needs_attention` with apply `unknown` has an exit" holds for the operation kinds that can be in that state, or the others are listed as an open item.
- **Actual:** the edge exists in the table; only two kinds can use it. Not reproduced end to end with a real `restore.discard` (it needs a failing discard job).
- **Evidence:** `R/R1-notes/TC-005.md`.
- **Root cause:** the fix is per kind, not an operator action (`operation.force_release` is still unbuilt).
- **Proposed fix:** an operator action (human, step-up, audited) that closes a named `needs_attention` operation for any kind, or a `supersedes` for each kind that holds a domain.
- **Acceptance test:** for each domain-holding kind a test that ends it `needs_attention` / `unknown` and then releases the domain through the action.

#### VC-057 [P2] Planning a node revoke or decommission fails with 500 INTERNAL while any active plan body holds an escaped NUL (regression of the TC-019 fix)

- **Area:** `packages/nodes/src/plans.ts` (`nodeImpact`, query `nodes.plan.impact_plans`), `POST /nodes/{id}/revoke`, `POST /nodes/{id}/decommission`, CLI `node revoke` and `node decommission`
- **Block:** R
- **Reproduction:** On vc-3, `R/R2-notes/probes/r2-nul-http-nodes.int.test.patch` (a patch of `apps/server/test/http-nodes.int.test.ts` that adds one step before the revoke plan: as superuser with `session_replication_role = replica`, insert an `operations.plans` row in state `active`, not expired, and its `operations.plan_bodies` row with a body that holds an escaped NUL, `{"reason":"nul \u0000 inside",...}`; then `POST /api/v1/nodes/{id}/revoke`). Run: `cd apps/server && bunx vitest run --config vitest.integration.config.ts test/r2-nul-http-nodes.int.test.ts` with `EXDB_TEST_PG_URL` set. Same file on `d0229550` for contrast.
- **Expected:** a `201` plan as at `d0229550` (the old planner did not read other plans' bodies); at worst a typed error.
- **Actual:** `d51da5d0`: `500 INTERNAL` (`R2-PROBE-NUL revoke plan with an escaped-NUL body stored: status 500`). `d0229550`: `201`, plan created. The same body in a plan that is already `consumed` does not trigger it, also not among 20,000 analysed bodies (`r2-nul-bulk-http-nodes.int.test.patch`, 201): only the planner's join order protects those. The REST layer refuses a NUL in a product `displayName` (422), so an ordinary request does not create such a body; the live installation does hold escaped-NUL bodies (the cause of #44 and of the OD-28 census fix), so the trigger is real but narrow.
- **Evidence:** `R/R2-notes/probes/r2-nul-http-nodes.int.test.patch`, `r2-nul-bulk-http-nodes.int.test.patch` (see `R/R2-notes/logs-index.md` for how to rebuild a probe); logs `p019b`, `p019c`, `p019old`, `p019bulk` (index in `R/R2-notes/logs-index.md`)
- **Root cause:** `packages/nodes/src/plans.ts` (`nodeImpact`): `... AND b.body::jsonb -> 'subject' ->> 'nodeId' = $1` casts a stored plan body to `jsonb` without the guard that #44 added everywhere else (`replace(b.body, '\u0000', '�')::jsonb` in `application.ts` fleet read, the retirement preflight and the OD-28 scripts). Revoking a node is the incident-response action, and one active plan of any kind with such a body blocks it for the plan's lifetime (15 to 30 minutes).
- **Proposed fix:** the same `replace(...)` guard (or read the node id from a column that is written at plan time instead of parsing every active body); add the NUL case to a shared helper so the next new query cannot forget it.
- **Acceptance test:** the probe above becomes `http-nodes.int.test.ts` "plans a revoke while an active plan body holds an escaped NUL" (201 with the fix, 500 without); plus a grep-style check in the repository that every `plan_bodies` `::jsonb` cast goes through the guard.

#### VC-058 [P2] An approval 15 minutes after the plan expired was accepted and the production change ran; awaiting_approval never ends (stack reproduction of TC-034 / OD-64 and of the B1 approval-window finding)

- **Area:** `packages/operations` accept and approvals, CLI `approval`
- **Block:** B
- **Reproduction:** `B/failure/I9-approval.sh create`, wait 16 minutes, `I9-approval.sh inspect`.
- **Expected:** a typed refusal and an expired or canceled operation.
- **Actual:** after the plan's expiry the operation was still `awaiting_approval` (nextAction approve). `approval show` printed an Expires time in the past and no warning. `human approve` returned 200, the operation went `queued`, then `succeeded applied/passed` on the production target. The 4 h approval window itself could not be tested (the Control Store refuses to age an operation row).
- **Evidence:** `B/failure/RESULTS.md` section 2. Static side (agent B1, `B/contract.md` §3 DF-01): nothing expires an `awaiting_approval` operation (`worker-tasks.ts:186-314` has `plans.expire` only); after 20 pending operations of one actor and client the next accept is `APPROVALS_PENDING_LIMIT` (`accept.ts:129-148`), so an agent client that left 20 plans unattended is locked out until a human rejects each; the exits are a human reject or the applying actor and client cancelling (`approvals.ts:562`, `application.ts:1960-2000`).
- **Root cause:** documented but unbuilt; OD-64 is open.
- **Proposed fix:** decide OD-64; at minimum refuse an approval after the plan's expiry and cancel the operation.
- **Acceptance test:** `I9-approval.sh inspect` prints PASS.

#### VC-059 [P2] A lost COMMIT reply plus a target restart parks the operation as unknown with the change committed; it is never reconciled, and the only exit mislabels it

- **Area:** `packages/migrations-engine` (`kind.ts` reconcile, `reverify.ts`)
- **Block:** B
- **Reproduction:** `B/failure/I9-exits.sh unknown`, or `F-matrix.sh cell tx incommit pg_immediate`: a missing synchronous standby makes the COMMIT durable but unanswered, then the cluster is restarted.
- **Expected:** `failure-and-recovery.md` E3 and E6: automatic reconciliation (a ledger row present means applied).
- **Actual:** `needs_attention apply=unknown OUTCOME_UNKNOWN` in under 1 s, with ledger 1 and both tables present. It is not reconciled after the target returns and it holds the schema domain, so the next plan queues. `migration verify <id>` closes it as `verification_failed apply=partially_applied` for a fully committed transactional migration. Killing the worker or terminating the session in the same window reconciles correctly.
- **Evidence:** `B/failure/RESULTS.md`, matrix row `tx:incommit:pg_immediate`.
- **Root cause:** a single reconcile attempt against an unreachable target; the supersede close writes a generic outcome.
- **Proposed fix:** retry the reconcile on a timer; close as succeeded once the ledger shows applied and verification passed.
- **Acceptance test:** after the restart the operation reaches `succeeded` without a human.

#### VC-060 [P2] The restic runbook does not apply globals and does not stop without them (TC-045 / D-07 not fixed)

- **Area:** `12-operations/backup-runbooks.md` (logical path), restic restore flow
- **Block:** C
- **Reproduction:** restore a restic logical snapshot whose dump contains `GRANT ... TO role` into a fresh cluster (tiny snapshot and the 7.7 GB snapshot).
- **Expected:** the runbook stops before `pg_restore` when no `globals*.sql` exists, creates the roles or prints the manual step.
- **Actual:** `pg_restore --exit-on-error` ends with exit 1 after 80.7 s (7.7 GB), leaving a running half-restored cluster (data loaded, roles missing); a snapshot without any globals file is not detected.
- **Evidence:** `C/backup-restore.md` §7.
- **Root cause:** the runbook steps do not include the globals dump and restore.
- **Proposed fix:** stop before `pg_restore` when no `globals*.sql` exists; create the roles first; refuse to start the restored cluster after a failed restore.
- **Acceptance test:** a runbook-lab test restoring a snapshot with a role grant ends `ok` with the roles present, and a snapshot without globals stops with a named message.

#### VC-061 [P2] restore.execute does not re-check space (D-08 not fixed), and restore.prepare measures the engine directory, not the scratch directory

- **Area:** `restore.prepare@1`, `restore.execute@1`
- **Block:** C
- **Reproduction:** 5.0 GB free, 7.74 GB needed: prepare answers `space_insufficient`; an execute is accepted anyway.
- **Expected:** execute repeats the prepare checks and measures the filesystem of the scratch directory.
- **Actual:** free space fell to 349 MB in 4 s (4.6 GB written); S2's guard stopped it.
- **Evidence:** `C/backup-restore.md` §8.
- **Root cause:** the space check is in prepare only, and it measures the wrong directory.
- **Proposed fix:** repeat the checks at execute; measure `scratch/`.
- **Acceptance test:** an execute with insufficient space is refused before any write.

#### VC-062 [P2] Wrong key or deleted repository: backup verify needs 102 s and ends OUTCOME_UNKNOWN although the helper refused at once; errors carry no code

- **Area:** Control Plane `backup verify` and `backup refresh`, helper `backup.list`
- **Block:** C
- **Reproduction:** `C/backup-restore.md` §6: configure a wrong cipher key, then delete the repository; run verify, refresh and `backup.list`.
- **Expected:** the helper's refusal reaches the operation immediately as a named failure; a deleted repository is reported as missing.
- **Actual:** verify takes 102 s and ends `OUTCOME_UNKNOWN` (run `lost`); `backup refresh` ends `failed` with `errorCode null`; a deleted repository shows as a foreign stanza (`RESTORE_TARGET_MISMATCH`, `system_identifier_mismatch`); the helper's `backup.list` returns `{"backups":0}` with no error.
- **Evidence:** `C/backup-restore.md` §6.
- **Root cause:** helper refusals are not mapped to operation outcomes; a missing repository is not distinguished from an empty one.
- **Proposed fix:** map the helper refusals (`failed`, with a code); report `repository_missing`.
- **Acceptance test:** a wrong key ends `failed` with a named code within seconds; a deleted repository reports `repository_missing`.

#### VC-063 [P2] pitr_random drills are refused until a wal.archive_status observation exists, and explicit pitr: plans stayed refused in one world

- **Area:** drill selection, `backup refresh`
- **Block:** C
- **Reproduction:** a cluster with verified backups and no `wal.archive_status@1` observation: plan a `pitr_random` drill; in a second world (all five backups verified, observation present) plan explicit `pitr:` targets.
- **Expected:** a plan, or a reason that says what to do.
- **Actual:** 409 `no_backup_selectable` until an observation exists, and `backup refresh` does not create it; in one world explicit `pitr:` plans stayed 409 `point_in_time_outside_window`. The reason text does not say what to do; the protection state shows no PITR window. S2 could not isolate the cause of the second case.
- **Evidence:** `C/backup-restore.md` §3, §6.
- **Root cause:** the window is derived from an observation that refresh does not record.
- **Proposed fix:** let the refresh record the archive's newest segment time, or name the missing observation in the reason.
- **Acceptance test:** after a refresh a `pitr_random` plan is selectable; the refusal names the missing observation.

#### VC-064 [P2] After a restore, a production target the store never mirrored is not blocked, `ledger reconcile` says "nothing to reconcile" while status says "out of sync", and the next apply adopts the unknown row

- **Area:** `packages/migrations-engine/src/divergence.ts:44-47`, `reconcile.ts:176-178`
- **Block:** C
- **Reproduction:** `00-prepare.sh` (a production change applied after the dump), `10-destroy-observe.sh`, `20-rb10-restore.sh`, then `migration status`, `migration plan` and `migration ledger reconcile --target lab/platform/production --note x`; then `30-prod-cycle.sh prep` and count the production mirror rows.
- **Expected:** a ledger row written by an operation the store never ran blocks planning until a reconcile decision; status and reconcile agree.
- **Actual:** the restored store still holds the operation (as `awaiting_approval`), so `known.has(operationId)` makes the row "known": no divergence; `ledger reconcile` fails `VALIDATION_FAILED nothing_to_reconcile`; `migration status` shows `Mirror: out of sync`. The next production apply mirrored two rows (live 2, mirror 2) after one bundle: the unknown row was adopted without a decision. Same root as `F/findings-B1.md` (evidence by operation id alone).
- **Evidence:** `C/control-store-loss/README.md` §4; logs `loss-v12-prod-reconcile`, `loss-30-prep` on vc-1.
- **Root cause:** `unrecorded = !mirrored.has(id) && !known.has(operationId)`, and "known" means any operation id in the store.
- **Proposed fix:** count a row as recorded only when `operation_migrations` says that operation applied it; one divergence function for status, plan and reconcile.
- **Acceptance test:** restore a store older than a production apply whose operation row is `awaiting_approval`: `plan` answers `LEDGER_DIVERGENCE` and `ledger reconcile` produces a plan.

#### VC-065 [P2] An old role keeps claiming and finishing operations after the schema moved ahead (503 not_ready, no log line)

- **Area:** `role.ts` (`compareSchema` at start and every 5 s), `operations-loop.ts`
- **Block:** C
- **Reproduction:** `C/upgrade/scripts/91-inflight-across-migrate.sh`: old release, a 45 s apply running, a second plan queued; `control-store migrate` of the new build at +8 s; old roles not redeployed for 70 s.
- **Expected:** a role whose schema is not its own stops claiming (or `upgrades.md` says it does not).
- **Actual:** all old roles answer 503, log nothing, and the old worker finishes the running apply (`succeeded/applied/passed`) and then claims the queued one (it ended `PLAN_STALE`, as expected). No harm in this release pair.
- **Evidence:** `C/upgrade/README.md` §6a; log `91-inflight.out` on vc-1.
- **Root cause:** readiness is evaluated, but the claim loop does not consult it.
- **Proposed fix:** stop claiming when the schema state is not `current`, and log it once; or document that additive releases rely on the old worker finishing.
- **Acceptance test:** after `migrate`, an old-build worker claims no new operation and logs `schema_not_current`.

#### VC-066 [P2] The upgrade runbook omits eleven steps: no pre-upgrade backup, outage window, drain, preflight or post-checks

- **Area:** `upgrades.md`, `deployment.md` §6, `deployments/2026-10-21-reos-01-studio-frame.md`
- **Block:** C
- **Reproduction:** `C/upgrade/scripts/40-upgrade.sh up1|up2|up3` with `sampler.mjs`, `downtime.mjs`.
- **Expected:** a runbook an operator can follow cold.
- **Actual:** `migrate` takes 0.8 to 1.0 s and leaves no audit event. Old roles go 503 about 1.9 s after the commit. Serve is down 16.0 / 17.3 / 17.5 s, gateway 14.6 / 15.6 / 15.8 s, worker 2.2 / 3.1 / 3.4 s (process-level lower bounds, no image pull). The eleven omissions are in `C/upgrade/README.md` §7. The pending plan from before the upgrade applied normally (no `PLAN_STALE`, no 500), and the policy version hash did change (apply re-checks decision and requirements, `accept.ts:198`): the fix PR's claim that older plans become stale is not confirmed.
- **Evidence:** `C/upgrade/README.md` §3, §7, §8; `C/upgrade/downtime.txt`; `C/upgrade/timings.tsv`.
- **Root cause:** the documents give the order, not the operation.
- **Proposed fix:** the one-page upgrade card from `README.md` §8 in `upgrades.md`; a `control-store status --against <build>` preflight; audit the migration.
- **Acceptance test:** the runbook-lab test of the first P1 follows the card end to end.

#### VC-067 [P2] An unmet backup requirement on a production apply answers 500 INTERNAL, and nothing is logged

- **Area:** `packages/operations` (apply gate), `packages/contracts` (errors), `apps/server` (problem mapping)
- **Block:** D
- **Reproduction:** on the stack, the owner plans a rollback of a production migration that has a `down.sql` (`POST /targets/{prod}/migrations/{id}/rollback-plans`; decision `require`, requirements approval + backup + reauth), then `POST /plans/{id}/apply` (CLI bearer, `exponetdb plan apply --yes`, or a fresh-proof web session). Same result each time.
- **Expected:** 409 `BACKUP_REQUIRED` naming `newerThan`; any 500 logged with its request id.
- **Actual:** 500 INTERNAL; the request id appears in no journal (serve and worker at info); the CLI prints "Error INTERNAL". The backup gate also hides the reauth requirement behind it.
- **Evidence:** `D/security/authz-run.md` (step-up section); `D/security/scripts/stepup-setup-plans.sh`, `stepup.sh`. **Same on a rehearsal stack (S5):** a destructive production plan (`DROP TABLE`) whose requirement is a verified backup newer than PT24H, applied twice, ended `Error INTERNAL` both times with no operation row and no line in the serve journal for the request id (`B/rehearsal/results/promote-destructive-plan.txt`).
- **Root cause:** suspected, read not instrumented: `packages/operations/src/accept.ts:209-210` throws `new OperationError('BACKUP_REQUIRED')` without details while `packages/contracts/src/errors.ts:701-710` requires `details.newerThan`; `apps/server/src/interfaces/http/request.ts:196-211` retries `buildProblem` without details, fails again and replaces the code with INTERNAL without logging.
- **Proposed fix:** pass `newerThan` into the error; log (warn) whenever `problemResponse` downgrades a catalog code to INTERNAL.
- **Acceptance test:** an operations test: an unmet backup requirement gives `BACKUP_REQUIRED` with `details.newerThan`; a server test: details that do not match the catalog are logged and not turned into INTERNAL.

#### VC-068 [P2] The first-party CLI fails with PERMISSION_DENIED for everyone whose role binding is on an environment

- **Area:** `apps/cli` (`src/cli/remote.ts`), `installation.get` authorization
- **Block:** D
- **Reproduction:** invite a person, bind `developer` to one environment, sign the CLI in (consent 200), run `whoami`, `target list`, `target show`, `schema overview`, `migration status`, `plan list`, `health`, `operation list` (table and `--json`); `curl` with the same bearer returns the target.
- **Expected:** a developer scoped to one environment can use the CLI there.
- **Actual:** every command (also `plan show`, `plan apply`, `migration plan`) exits `Error PERMISSION_DENIED`. A global viewer and the owner work.
- **Evidence:** `D/security/authz-run.md` (last section).
- **Root cause:** `apps/cli/src/cli/remote.ts:198` calls `sdk.installation.get()` before every remote command; `installation.get` needs a global binding (D1's matrix marks it D for an environment binding).
- **Proposed fix:** make the pre-flight optional or use a read the person always holds; or let any bound person read the installation.
- **Acceptance test:** a CLI test with a server whose `GET /installation` is 403 and target routes 200: `target list` exits 0.

#### VC-069 [P2] A sub-megabyte bundle can hold the server's CPU for 30 s or raise its memory by 620 MiB; the limits are not named

- **Area:** planning path (`packages/migrations-engine` analysis, `packages/postgres` parser), plan route
- **Block:** D
- **Reproduction:** `exponetdb migration plan --target <nonprod>` with `up.sql` of (a) 60,000 lines `SELECT n;` (829 KB) or (b) 50,000 `/*` then 50,000 `*/` then `SELECT 1;` (200 KB); sample serve and worker with `ps` at 50 ms (`D/security/scripts/containment2.sh`).
- **Expected:** a named limit error within about a second (I15), bounded CPU and memory.
- **Actual:** (a) INTERNAL after 4.7 s, 5 s CPU, serve RSS 256 to 878 MiB (still 660 to 705 MiB later); (b) 30.5 s CPU, then TRANSPORT_FAILED, no answer. Reachable by a developer, a service account or an MCP client with `migrations.plan`. Case (b) is `F/findings-B2.md` first P1 on a stack; case (a) is a second shape of its second P1 (the many-statements input).
- **Evidence:** `D/security/containment.md`.
- **Root cause:** unknown from outside; candidates are the statement splitter and analysis in `packages/migrations-engine/src/analysis.ts` and the parser wrapper in `packages/postgres/src/parser/`.
- **Proposed fix:** cap statements, comment depth and tokens before analysis with named `MIGRATION_LIMIT_*` errors; time-box the analysis; document the values.
- **Acceptance test:** one unit test per input class: a named limit error, under 2 s and 100 MiB.

#### VC-070 [P2] A plan that stops part-way leaves the drift baseline behind: every later verified bundle reads as drift (34 findings, 6 critical) until a person accepts all of it

- **Area:** `packages/diagnostics` (`MigrationBaselineStore.record`), drift baseline, `drift.accept`
- **Block:** B
- **Reproduction:** PostgreSQL 17 baselined target; plan 5 bundles in one plan where the 4th fails (see the `ALTER COLUMN TYPE` finding); apply the 3 remaining bundles in two later plans; `exdb drift check lab/platform/rhstg`. Scripts: `B/rehearsal/scripts/apply_under_load.sh`, `author_bundles.sh`, `steps/10-drift-check-clean.sh`.
- **Expected:** `drift-detection.md` §7: "ExponetDB's own migrations are never drift"; the baseline "never moves back; it catches up".
- **Actual:** `observation.schema_baselines` has 2 rows (registration, baseline import) after 8 applied and verified bundles. The part-way operation (`verification_failed`) records none; the next plan's pre-fingerprint differs from the stored baseline, so `record()` returns `drift_open` and never adopts. The drift check reports 34 drifted objects (6 critical: 2 policies, 3 views and a matview whose ACL "changed"), all effects of verified bundles. The only exit is `drift.accept`, which adopts everything open (REST `POST /findings/{id}/accept` and the Web App; no CLI command), including any real out-of-band change from the same period. PostgreSQL 16 and 18, where every plan succeeded, ended clean.
- **Evidence:** `B/rehearsal/results/drift-after-8-verified-bundles.txt`, `apply-first5-failed-at-bundle4.txt`, `pg18-part.txt`; code `packages/diagnostics/src/migration-baselines.ts` (`record`, lines 44-60).
- **Root cause:** suspected: the baseline advances only per successful operation and compares the pre-fingerprint with the stored baseline; a partially applied operation breaks the chain and nothing repairs it from the ledger's `fingerprint_after`.
- **Proposed fix:** advance the baseline per verified bundle (ledger rows carry `fingerprint_after`) or accept a pre-fingerprint equal to the ledger head's `fingerprint_after`; offer per-finding or per-operation accept.
- **Acceptance test:** integration: 3 bundles, the 3rd fails, the next plan applies: the drift check is clean; a GRANT made between the two plans is still reported.

#### VC-071 [P2] ALTER COLUMN TYPE on a column a view reads: the plan is silent, the apply fails 0A000 after earlier bundles were applied, and the offered remedy does not fit

- **Area:** `packages/migrations/src/lint`, plan analysis, CLI operation text
- **Block:** B
- **Reproduction:** bundle `ALTER TABLE public.crm_items ALTER COLUMN amount TYPE numeric(16,4);` (the views `crm_overview` and `mv_crm_pipeline` read `amount`) as the 4th of 5 bundles in one plan; `exdb migration plan`, `exdb plan apply --wait`. Working form: `scripts/b4-final-up.sql`.
- **Expected:** the plan names the dependent views (`pg_depend`/`pg_rewrite`), or lint marks it; the failure shows the PostgreSQL message.
- **Actual:** plan allowed, lock severity critical, `rewriteRisk` 182 MB, nothing about dependents. Apply: bundles 1-3 applied and passed, bundle 4 `not_applied` `MIGRATION_EXECUTION_FAILED` sqlstate 0A000, operation `verification_failed`, "Nothing was rolled back" and "Next: exponetdb migration resume <migration>" (resume is for non-transactional bundles; this one was transactional). The statement's error text is not shown.
- **Evidence:** `B/rehearsal/results/apply-first5-failed-at-bundle4.txt`, `plan-risk-first-5.txt`.
- **Root cause:** analysis is per statement and offline, with no dependent-object read; the next-step text is chosen from state, not from the bundle's mode.
- **Proposed fix:** a plan fact "objects depending on this column" with a blocking flag for views; show the failed statement's message; offer resume only for non-transactional bundles.
- **Acceptance test:** the plan lists `crm_overview` and `mv_crm_pipeline` as blocking dependents; the failed operation shows the PostgreSQL message and no resume hint.

#### VC-072 [P2] A clone that takes the registered name is healthy, drift-clean and plannable; apply is refused only as PLAN_STALE without a cause

- **Area:** registry identity check (database oid), plan, health, drift
- **Block:** B
- **Reproduction:** `scripts/traps_swap.sh`, `traps_swap2.sh` on `lab/platform/rh18`: `CREATE DATABASE c TEMPLATE lab_rh18`; rename the original away; rename `c` to `lab_rh18`; `target show`, `drift check`, `migration plan`, `plan apply`.
- **Expected:** the registry recorded oid 16517, the clone has 32766 and the same marker: `database_mismatch` in health or plan.
- **Actual:** target show healthy; drift clean; plan allowed; `plan apply`: `PLAN_STALE` "The plan no longer matches the target. Create a new plan." for the old plan and for a plan made against the clone; the plan is then invalidated; a new plan is allowed again (the operator loops). Nothing ran on the clone. `scratch-check` knows `database_mismatch`; the normal path does not surface it.
- **Evidence:** `B/rehearsal/results/traps-swap.txt`, `traps-swap2.txt`.
- **Root cause:** the oid is compared only in the apply binding; health, drift and plan do not compare it; `PLAN_STALE` carries no binding name.
- **Proposed fix:** compare the oid in the identity probe (condition, suspend) and refuse the plan; add `details.binding` to `PLAN_STALE`.
- **Acceptance test:** after the swap `target show` is not healthy and plan fails with a typed `DATABASE_MISMATCH` naming recorded and observed oid.

#### VC-073 [P2] A renamed or missing database turns `migration plan` into INTERNAL

- **Area:** `apps/server` error mapping of `TARGET_SQL_ERROR`
- **Block:** B
- **Reproduction:** `ALTER DATABASE lab_rh18 RENAME TO lab_rh18_renamed`; wait 5 s; `exdb target show` (unreachable); `exdb migration plan <id> --target lab/platform/rh18`.
- **Expected:** a typed `TARGET_UNREACHABLE` with the target id.
- **Actual:** `Error INTERNAL ... (request req_...)`; the serve journal logs `http.request_failed errorCode TARGET_SQL_ERROR droppedFields errorMessage` (the 3D000 cause is dropped).
- **Evidence:** `B/rehearsal/results/rename-plan-internal.txt`, `traps-swap.txt`.
- **Root cause:** `TARGET_SQL_ERROR` has no HTTP mapping on the plan route (same class as `F/findings-C1.md` Control Store errors and `F/findings-S4.md` backup requirement).
- **Proposed fix:** map connection and catalog errors on the plan route to the unreachable code and keep the SQLSTATE in details.
- **Acceptance test:** a plan against a renamed database returns the typed code, not 500.

#### VC-074 [P2] A hot standby behind the registered endpoint is healthy and plannable; the apply fails as OUTCOME_UNKNOWN

- **Area:** health probes, `migration.apply` error mapping
- **Block:** B
- **Reproduction:** `scripts/traps_replica.sh`: a streaming standby of the restored primary, endpoint added, the primary's retired; `exdb health`, `migration plan`, `plan apply --wait`.
- **Expected:** a read-only state is reported; the apply is refused up front or `TARGET_READ_ONLY`.
- **Actual:** health healthy, no condition; plan allowed; apply: execute failed, reconcile succeeded, migration `not_started`, "Nothing was applied", but `OUTCOME_UNKNOWN: The operation ended failed`. After `pg_ctl promote` the same apply passed.
- **Evidence:** `B/rehearsal/results/traps-replica.txt`.
- **Root cause:** probes do not read `pg_is_in_recovery()`; the 25006 refusal is not classified.
- **Proposed fix:** add `in_recovery` to the identity/activity probe and a `target_read_only` condition; classify 25006 before any statement.
- **Acceptance test:** with the endpoint on a standby, health has a critical condition and the apply ends `failed/not_applied` with `TARGET_READ_ONLY`.

#### VC-075 [P2] Adding an endpoint of a different instance is applied without a check and suspends the affected targets within seconds; recovering a production target takes plan, approval and 50 s

- **Area:** `registry.endpoint.add`, health identity probe, `target.resume`
- **Block:** B
- **Reproduction:** `scripts/traps_logical.sh` (a new instance filled by `pg_dumpall | psql`, another system identifier; `exdb cluster endpoint add <cluster> --port 55527 ...`; apply; wait 10 s), then `steps/33`, `steps/34`.
- **Expected:** the plan probes the endpoint (system identifier) and denies or warns before writing it.
- **Actual:** plan allowed (tier prod because the cluster hosts a production target; approval only), apply succeeds, probes give `identity_mismatch critical`; the targets whose database exists on the foreign instance (`rhprod`, `rhrep`) are `suspended` (`TARGET_SUSPENDED` reason `identity_mismatch`), every other target of the cluster `unhealthy` (the stack's production target too). Nothing was written to the wrong instance. Recovery: endpoint retire (plan, approval, apply), then `target resume --reason` per target (the production one: plan + approval, 50 s). A typo in a port can take all of a cluster's targets offline.
- **Evidence:** `B/rehearsal/results/traps-logical.txt`; timings `lg-*`, `prod-apply-resume-prod` in `timings.tsv`.
- **Root cause:** `cluster confirm` (system identifier) exists but is not part of `endpoint.add`.
- **Proposed fix:** probe the endpoint at plan time with the cluster credentials, show the identity in the plan, deny on a different system identifier.
- **Acceptance test:** planning an endpoint of an instance with another system identifier is denied with both identifiers named; no target changes state.

#### VC-076 [P2] The documented database move has no executable path: a copy of a registered target is refused in every environment and nothing re-stamps the marker

- **Area:** `legacy-import.md` §5, target register, registry
- **Block:** B
- **Reproduction:** `steps/35-*.sh`, `36-*.sh` (PostgreSQL 18): register a target, `pg_dump | pg_restore` into a new database, `target decommission` (step-up), register the new database in the same environment, then in a new one.
- **Expected:** §5: "the restore operation re-stamps the identity marker with a new generation; the ledger and baseline remain valid".
- **Actual:** same environment: `REGISTRY_CONFLICT` reason `path_taken` (the decommissioned target keeps its path); new environment: `TARGET_REGISTRATION_REFUSED` reason `other_target`. The CLI command list has nothing that re-stamps a marker. Only dropping the copied `exponetdb` schema works (tested on a clone), which discards ledger and baseline (a new import). The documented REOSA move cannot keep its history this way.
- **Evidence:** `B/rehearsal/results/traps-clone.txt`; server logs `mv-*.log` on vc-2.
- **Root cause:** §5 describes a re-stamp of the Wave 9 restore operation that does not exist for a logical move.
- **Proposed fix:** a `target.rehome` plan (human, step-up, approval on prod) that adopts a decommissioned target's marker and increments the generation; or remove the sentence and document import-after-move.
- **Acceptance test:** dump a baselined nonprod target into a new database, decommission the old target, run the documented command: the new database is the target with ledger and baseline kept, generation + 1.

#### VC-077 [P2] CREATE PUBLICATION (the standard supabase_realtime) in the legacy history makes the whole analysis incomplete; the operation ends verification_failed with a forward-fix remedy

- **Area:** `migration import analyze`, replay admission, operation texts
- **Block:** B
- **Reproduction:** `exdb migration import analyze --target lab/platform/rhstg --scratch lab/platform/rhscr --apply` with a legacy file `create publication supabase_realtime for table ...` (`steps/04-*.sh`, `05-*`).
- **Expected:** the report names the file and the way forward (a notApplicable hint, accept the publication as present); the operation reads "analysis incomplete".
- **Actual:** `replay_failed:20240417041947_realtime_publication:MIGRATION_STATEMENT_FORBIDDEN:0` is shown only by `migration import report`; the operation says `verification_failed` with "Next: ... create a forward-fix migration and plan" (which does not apply to an analysis). Files before it had already run, so the scratch target is consumed (reset in place, 2 s). With the hint the publication returns as drift `only_in_target` and its ledger entry as `ledger_entry_without_file` (two more items to decide).
- **Evidence:** server logs `import-analyze-plan.log`, `op-analysis.json`; `B/rehearsal/README.md` §2.
- **Root cause:** `CREATE PUBLICATION` is a forbidden statement and the replay uses the same admission.
- **Proposed fix:** allow plain table publications in the replay, or detect before replay in `scratch-check`; end an incomplete analysis in a state whose next step is "fix inputs and analyze again".
- **Acceptance test:** a history with `CREATE PUBLICATION p FOR TABLE t` analyses to `open`; an incomplete report ends the operation with that next step.

#### VC-078 [P2] After a failed write path clears, the roles stay not_ready until their pooled sessions die; a database-level read-only default stops nothing but the heartbeat

- **Area:** `packages/control-store/src/store.ts` (pool; `BEGIN ... READ WRITE` at line 158), heartbeat in `apps/server/src/composition/role.ts`
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc2-readonly.sh`: `ALTER DATABASE exponetdb_control SET default_transaction_read_only = on`, terminate the 23 backends, mutate and read for 130 s; then RESET it (from the `postgres` database; from the store database it fails with `cannot execute ALTER DATABASE in a read-only transaction`). Real read-only variant: `fc2b-standby.sh`.
- **Expected:** a freeze either stops mutations or is ignored consistently; the roles recover when the store is writable ("automatic once the store answers").
- **Actual:** (a) mutations kept succeeding (plans at 2, 21, 64, 127 s exist) because every write transaction starts with an explicit READ WRITE; only autocommit statements fail with 25006 (heartbeat, grant last-use, worker `dataread.tick_failed` at roughly 200 to 300 lines a minute). After 32 s serve, worker and gateway were all 503 (`heartbeat_stale`, `no_live_worker`) and installation health was `down`, while the worker loop still wrote. (b) After the RESET the roles stayed 503 for 4 min 36 s, until the backends were terminated (ready 9 s later): the failed heartbeat does not evict the pooled session. (c) On a real read-only store (an unpromoted standby): mutations 500, then after about 44 s every API call 503 `CONTROL_PLANE_DEGRADED`; the CLI cannot refresh its token (`oauth_server_error`), so reads turn 401 after the 10 minute token life. Promotion recovered everything in 8.4 s.
- **Evidence:** `C/stack/fail-closed-results.md` step 2; logs `fc2.out`, `fc2-undo2.out`, `fc2b.out`.
- **Root cause:** the pool keeps clients after session-state errors (25006); the heartbeat is a single autocommit statement while writes use explicit transactions.
- **Proposed fix:** destroy the client on 25006 and other class 25 and 57 errors; run the heartbeat in a `BEGIN READ WRITE` transaction like every other write; document that `default_transaction_read_only` is not a freeze.
- **Acceptance test:** set the default, terminate backends, reset it: all roles ready within one heartbeat interval without terminating backends; with the default on, a mutation fails closed or the roles stay ready (decide, then test).

#### VC-079 [P2] One MCP client can push serve far past its 512 MiB container limit: 1,000 concurrent requests, 98 percent rejected 429, RSS 156 to 583 MB

- **Area:** `apps/server/src/interfaces/mcp/edge.ts`, `interfaces/http/lifecycle.ts`, `12-operations/deployment.md` §2a
- **Block:** C
- **Reproduction:** `C/stack/scripts/gl-mcp.sh` (token from `mcp-token.sh`: a DCR public client, authorization code + PKCE, six read scopes), `load.mjs --c 1000 --seconds 30` of `POST /mcp tools/list` (99 KB answer).
- **Expected:** the per-grant limiter and a connection cap keep memory bounded; a request over the limit costs almost nothing.
- **Actual:** 31,953 requests in 30 s: 709 x 200 and 31,244 x `429 RATE_LIMITED` (named, `retryAfterSeconds`). RSS 156 to 583 MB, about 1,080 descriptors, `/healthz/live` 12 to 28 ms, RSS 229 MB ten seconds later. `deployment.md` gives serve 512 MiB (heap 259 MiB): the kernel would kill it here (the stack has no cgroup limit, so the kill itself was not observed). An unauthenticated flood (86,471 x 401 in 30 s) cost +143 MB and about 1,700 descriptors. A single 31 MiB bundle request costs +180 MB. The public listener has no connection cap.
- **Evidence:** `C/stack/graceful-life-results.md` steps 4 and 7; logs `gl-mcp.out`, `gl-limits.out`.
- **Root cause:** no cap on concurrent connections or in-flight requests per grant or IP; limiting runs after the request is accepted and read.
- **Proposed fix:** `maxConnections` plus a per-grant in-flight cap checked before the body is read; a global in-flight byte budget for bundle routes; document the container memory with the measured peak.
- **Acceptance test:** 1,000 concurrent `tools/list` from one grant keep serve RSS under 350 MB and `/healthz/live` under 100 ms; 429 answers carry `Retry-After`.

### P3 (72)

#### VC-080 [P3] third-party, licenses and ui-safety are part of `bun run verify` but no CI job runs them

- **Area:** `.github/workflows/ci.yml`, `package.json` (`verify`)
- **Block:** A
- **Reproduction:** `grep -nE 'third-party|licenses|ui-safety' .github/workflows/ci.yml` finds nothing; `verify` runs all three.
- **Expected:** every runner-capable check in `verify` is a CI step (they guard ADR-0030 and OD-38).
- **Actual:** all three pass here (171 registered copied files; 287 shipped and 339 dev packages; 1,087 files with 1 documented exception), but a PR with an unregistered copied file or a bad license is not stopped by CI.
- **Evidence:** `A/README.md`, row 11.
- **Root cause:** the `typescript` job in `ci.yml` ends at `bun audit`.
- **Proposed fix:** add the three scripts after "Secret scan" (each under 2 s).
- **Acceptance test:** a PR adding an unregistered copied file under `packages/ui` turns the `typescript` job red.

#### VC-081 [P3] A local image build (smoke:image, docker build) needs BuildKit and no document says so

- **Area:** `Dockerfile`, `package.json` (`smoke:image`), `local-development.md`, `deployment.md`
- **Block:** A
- **Reproduction:** Ubuntu 24.04 with distro docker.io 29.1.3 (no buildx): `docker build -t exponetdb:local .` stops at step 14 "the --chmod option requires BuildKit"; `smoke:image` and both `test:lab` suites then fail. After `apt-get install docker-buildx` all pass.
- **Expected:** the prerequisite is documented or pre-checked.
- **Actual:** `git grep -niE 'buildkit|buildx'` over md, Dockerfile and scripts finds nothing; the error arrives after a 97 s build stage.
- **Evidence:** `A/README.md`, "Bootstrap changes" 1; log `n-image-build.log` on vc-1.
- **Root cause:** `COPY --chmod=... --chown=...` in the Dockerfile is BuildKit-only.
- **Proposed fix:** one sentence in `local-development.md` and `deployment.md`, plus a `docker buildx version` pre-check in `smoke:image`.
- **Acceptance test:** `smoke:image` on a host without buildx fails within a second, naming the package.

#### VC-082 [P3] Tests depend on the order of tests inside their file, so a single test cannot be run alone

- **Area:** `packages/audit/test/golden.test.ts`, `packages/policy/test/version.test.ts`, `packages/secrets/test/envelope.test.ts` and `store.int.test.ts`, 51 integration files, `apps/design-system/test/patterns/ui-patterns.test.tsx`
- **Block:** A
- **Reproduction:** in a clone at `d51da5d0`: `cd packages/secrets && bunx vitest run test/envelope.test.ts -t se1-008` fails (the default order of the whole file passes). Likewise `-t pv1-003` (policy), `-t 'chain of ac1-001'` (audit), and `-t 're-wraps every data key'` (secrets integration, with `EXDB_TEST_PG_URL`). A full run with `--sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=20261029`: unit 5 tests in 4 files fail; integration 265 tests in 51 of 105 files fail. Shuffling file order alone changes nothing (0 differ).
- **Expected:** each test passes in any order and alone, or the dependence is explicit (`describe.sequential` plus a note) and the files are never run with `-t`.
- **Actual:** golden-vector tests read values written by earlier tests (for example `expected undefined not to be undefined`, `expected 2 to be greater than 5`); the design-system "Could not load suggestions" test passes alone but fails 1 of 3 package runs with the seed (a previous test's popover is still mounted in the failure DOM).
- **Evidence:** `A/run3-classification.txt`, `A/int-run3-failing-files.tsv`, `A/README.md` "Order dependence"; logs `n-unit-run3`, `n-int-run3` on vc-1.
- **Root cause:** shared module or database state across tests of one file; no per-test setup.
- **Proposed fix:** build the state inside each test or in a describe-level `beforeAll`; derive golden expectations from the vector file; mark true scenario files with `describe.sequential` and a header comment; fix the leak in `ui-patterns.test.tsx`.
- **Acceptance test:** the four `-t` commands above pass alone, and `vitest run --sequence.shuffle.tests` passes for `packages/audit`, `policy`, `secrets` and `design-system` with five seeds.

#### VC-083 [P3] Edits that do not change the checksum are dropped by ingest, and three lints cannot fire on the server path

- **Area:** migrations-engine/src/store.ts:184-190, migrations/src/lint/lint.ts:817-834, planner.ts:656-678
- **Block:** B
- **Reproduction:** Static. Ingest bundle B. Edit only description, the directory slug/name, or a comment of up.sql. Plan again. Read the stored revision.
- **Expected:** BundleIngestResultSchema: verify_revision also for "comment bytes". Lints comment_only_change, renamed_applied_migration, rewritten_unapplied_migration (migration-bundles.md §7, analysis.md §6).
- **Actual:** `same` compares checksum and bundleDigest only and returns the stored old bytes as `unchanged`. comment_only_change and renamed_applied_migration (stored revision vs ledger) cannot fire. `ingested` is never passed to lintBundles (lint.ts:70), so rewritten_unapplied_migration is dead on every path.
- **Evidence:** B/contract.md §3 DF-06, DF-07.
- **Root cause:** bundleDigest does not cover the source digest or the metadata.
- **Proposed fix:** Compare the submitted source digest and metadata with the newest revision and store a metadata revision, or document the drop. Pass `ingested` from the store.
- **Acceptance test:** Unit test of ingestBundles: a comment-only edit returns a distinct status or the documented `unchanged`. A lint test with `ingested` fed.

#### VC-084 [P3] c1 summary sentences are looser than c1: spacing, adjacency, formatters and case change the checksum

- **Area:** exponetdb-docs/04-migrations/migration-bundles.md §3, CLAUDE.md, 04-migrations/README.md
- **Block:** B
- **Reproduction:** Exploratory (to be repeated on the pinned toolchain), c1-pairs.out: `(a int,b text)` to `(a int,/*c*/b text)` differs. `;INSERT` to `;\nINSERT` differs. `( a int )` to `(a int)` differs. `select` to `SELECT` differs. `a  b` to `a b` equal.
- **Expected:** "comment-only edits are not drift" (CLAUDE.md). "collapse every run of whitespace" (§3 summary).
- **Actual:** N5 is exact and pinned by golden vectors c1-sql-016 and c1-sql-032. But a comment or space inserted between two adjacent tokens, a formatter run, or a case change after apply is a non-overridable MIGRATION_CHECKSUM_MISMATCH.
- **Evidence:** B/conformance/exploratory/c1-pairs.out; B/contract.md §6.
- **Root cause:** Documentation and tooling, not code (c1 is frozen).
- **Proposed fix:** One paragraph in §3 and the README: "where a separator already exists". A `migration lint` rule `checksum_sensitive_edit` comparing source digest with the ledger and naming the class. Recommend formatters off for applied files.
- **Acceptance test:** A doc test that the three sentences quote N5. A CLI test of the lint rule.

#### VC-085 [P3] The CLI reads a whole oversized bundle file into memory before cutting it

- **Area:** apps/cli/src/local/project.ts:127-131
- **Block:** B
- **Reproduction:** `truncate -s 8G up.sql` in a bundle directory; `exponetdb migration lint`.
- **Expected:** The code comment: an oversized file is read only up to limit + 1 byte.
- **Actual:** readFile reads everything, then subarray cuts it.
- **Evidence:** B/contract.md §3 DF-18.
- **Root cause:** lstat size is used for the cut, not for the read.
- **Proposed fix:** Open the file and read at most limit + 1 bytes.
- **Acceptance test:** CLI test with a sparse 2 GiB file: refused with file_too_large, peak RSS under 100 MiB.

#### VC-086 [P3] Hotfix follow-up is unbuilt: no hotfix_without_evidence finding, no evidence mark

- **Area:** staging-production-policy.md §3, break-glass apply
- **Block:** B
- **Reproduction:** Static. `grep -rn hotfix_without_evidence packages apps` finds nothing. Apply a bundle to production under break-glass and read findings and the ledger row.
- **Expected:** The ledger row is marked and a finding stays open until staging has the same migration.
- **Actual:** Neither exists, so "staging contains everything production contains" can break silently. (This is the first campaign's TC-023 / E16, which the fix left to an owner decision, OD-65.)
- **Evidence:** B/contract.md §3 DF-26.
- **Root cause:** Unbuilt.
- **Proposed fix:** Mark the ledger row source evidence break_glass, open the finding, resolve it from the evidence read.
- **Acceptance test:** Stack: after a break-glass apply the finding exists; after the same migration is applied and verified on staging it resolves.

#### VC-087 [P3] The bundle store has no way to retire a bundle; `pending` lists every never-applied stored id forever

- **Area:** migrations-engine/src/store.ts, reads.ts:178-185, migrations.bundle_revisions
- **Block:** B
- **Reproduction:** Static. Ingest bundles of an abandoned branch through a staging plan (planned, never applied). Read `migration status` for any target of the project.
- **Expected:** dependency-graph.md §7 names the orphaned case and a remedy. The pending list should be about the stream.
- **Actual:** The table is immutable with no tombstone and no listing of unreferenced revisions. getTargetMigrations reports every stored id not in the ledger as pending (reads.ts:178-185). There is no CLI command to ingest, list or retire bundles.
- **Evidence:** B/contract.md §3 DF-05.
- **Root cause:** A missing state.
- **Proposed fix:** An append-only `withdrawn` marker read by status and planning, plus a store doctor (dangling, orphaned, unreferenced). See E/proposals.md.
- **Acceptance test:** Stack: ingest, withdraw; status no longer lists it as pending; planning it by id is refused with a clear code.

#### VC-088 [P3] A later migration that fails to execute ends the operation as verification_failed with error code VERIFICATION_FAILED

- **Area:** migrations-engine/src/kind.ts:618-619, operations/src/driver.ts:412-422
- **Block:** B
- **Reproduction:** Plan two chained migrations, the second with a failing statement (`DO $$ BEGIN PERFORM 1/0; END $$`). Apply. Read the operation.
- **Expected:** planning-and-apply.md §9: "second rolled back; third not attempted; operation `failed` with per-migration outcomes".
- **Actual:** #run returns partially_applied and drops firstError. Verification aggregates `partial` and the driver ends verification_failed / VERIFICATION_FAILED. failures.int.test.ts:786 pins the state for the revoked-grant case, and failure-and-recovery.md E27 already says verification_failed. The cause (statement index, SQLSTATE) is only in the per-migration progress row.
- **Evidence:** B/contract.md §3 DF-20.
- **Root cause:** Two outcomes share one terminal state.
- **Proposed fix:** Carry firstError as the operation's error code and detail when the stop was an execution failure. Fix planning-and-apply.md §9.
- **Acceptance test:** engine.int.test.ts case: the second migration fails; the operation's errorCode is MIGRATION_EXECUTION_FAILED with migration id, statement index and SQLSTATE.

#### VC-089 [P3] Seven pinned settings are refused at top level but not guarded after each statement

- **Area:** packages/postgres/src/parser/migration.ts `ENGINE_SETTINGS` (line 116), `migration-facts.ts` `EngineGuards`
- **Block:** B (I4)
- **Reproduction:** `fixtures/unguarded-engine-settings.sql`; test `I4-atomicity.int.test.ts` "body hazard: DO that sets row_security off ..." and six siblings.
- **Expected:** `ENGINE_SETTINGS` says "reviewed SQL never changes them, not even with SET LOCAL"; the defense in depth behind a function body is the guard read after every statement (`executor.ts` `changedGuards`).
- **Actual:** the guard reads 13 values; `row_security`, `extra_float_digits`, `application_name`, `default_tablespace`, `temp_tablespaces`, `default_transaction_read_only` and (PostgreSQL 17 and 18) `transaction_timeout` are in `ENGINE_SETTINGS` but not in `EngineGuards`. A `DO` block that sets them with `set_config(..., true)` is applied and the value lives to the end of the transaction (`application_name` also decides whether the session is protected from `connections.terminate`; `default_tablespace` where later objects land; `transaction_timeout = 0` removes a transaction cap). The other pinned names, the role switches, the ledger forgeries, `COMMIT`/`ROLLBACK`/`SAVEPOINT` in `DO` and procedures, `pg_terminate_backend(pg_backend_pid())` and settings from functions are all caught: 34 hazards in function bodies and 16 host-reaching statements, each on three majors, all roll back whole.
- **Evidence:** `B/conformance/I4-atomicity.int.test.ts`, `B/conformance/fixtures/unguarded-engine-settings.sql`
- **Root cause:** `ENGINE_SETTINGS` (22 names) and `EngineGuards` (13 fields) are two lists maintained by hand.
- **Proposed fix:** derive both from one list and read every listed setting in the guard query.
- **Acceptance test:** the seven failing int cases.

#### VC-090 [P3] A string literal continued across a line comment is valid PostgreSQL and c1 N4, but libpg_query refuses it

- **Area:** packages/postgres parser (libpg_query 16.7.3, 17.7.4, 18.1.5), `lexer.ts` `continuation`
- **Block:** B (I5)
- **Reproduction:** `fixtures/string-continuation-across-line-comment.sql`. Test: `I5-edges.int.test.ts` "string continuation across a line comment ..." (3 majors).
- **Expected:** the repo splits what the server executes (`planning-and-apply.md` section 7).
- **Actual:** the three servers return `'ab'`; `analyzeMigrationSql` fails with a syntax error, lint reports `parse_error`. Three lexers disagree: the server and `format/sql.ts` (c1 N4) accept it, `lexer.ts continuation()` (redaction) and the libpg_query builds do not. The direction is safe (valid SQL refused, nothing wrong runs); 360 generated scripts (120 per major), 51 hand-picked cases and 450 single-edit mutants (150 per major) on PostgreSQL 16, 17 and 18 (model = server = repo ranges = c1 executable text) found no other divergence.
- **Evidence:** `B/conformance/fixtures/string-continuation-across-line-comment.sql`, `B/conformance/I5-edges.int.test.ts`, `B/conformance/I5-parser-equals-server.int.test.ts`
- **Root cause:** the WebAssembly scanner of the three pinned bindings.
- **Proposed fix:** document it in section 3 N4 and make the `parse_error` message say "string continuation across a comment is not supported"; or rebuild the bindings from a scanner that matches `scan.l`.
- **Acceptance test:** the I5-edges test, or a documented-limit test.

#### VC-091 [P3] The lint report depends on the order the bundles are submitted in

- **Area:** packages/migrations/src/lint/lint.ts (`parallel_object_overlap`)
- **Block:** B (I1)
- **Reproduction:** `lintBundles(A,B,C,D)` against `lintBundles(D,C,B,A)` for four bundles that alter one table without edges. Test: `I1-determinism.pure.test.ts` "FINDING: the lint report does not depend on the order ...". Digests, analysis, graph order and the plan hash over fixed content are identical across 4 runtimes, 3 time zones, 2 locales and 3 shuffles (28 runs).
- **Expected:** the same report for the same set of bundles (CI diffs, stored plan analysis).
- **Actual:** the order of findings and the partner named in each `parallel_object_overlap` message ("... also touches ...") follow input order.
- **Evidence:** `B/conformance/I1-determinism.pure.test.ts`, `B/conformance/tools/lintdiff.ts`, `B/conformance/fixtures/lint-order-dependence.md`
- **Root cause:** `lint.ts` pair loop emits in loop order and names the other bundle found first.
- **Proposed fix:** sort bundles by id before the pair loop and name all partners (sorted).
- **Acceptance test:** the I1 test.

#### VC-092 [P3] The CLI loader turns a symbolic link or directory named `verify.sql`/`up.sql` into an empty file, and reads an oversized file whole

- **Area:** apps/cli/src/local/project.ts `readBundles`
- **Block:** B (I14)
- **Reproduction:** `fixtures/make-symlink-bundle.sh <dir>` (a bundle whose `verify.sql` is a link to a file with a failing check). Tests: `I14-containment.pure.test.ts` "a symbolic link in place of verify.sql ...", "... in place of up.sql ...", "a 512 MiB up.sql ...".
- **Expected:** the header comment says a link is "passed on as it is, so the shared validation refuses it with its reason", and an oversized file is "read only up to the limit + 1 byte".
- **Actual:** for the names that are allowed, the entry is replaced by an empty buffer: a linked `verify.sql` validates as an empty verify file (the author sees a check that never runs), a linked `up.sql` is refused as `empty_migration`, never as a link. `readFile` reads the whole file before the cut: a 512 MiB sparse `up.sql` raised RSS by 520 MiB (B1 reports the second half statically as FB1-11).
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`, `B/conformance/fixtures/make-symlink-bundle.sh`
- **Root cause:** `project.ts:121-134`: `!file.isFile()` sets `new Uint8Array()`; `readFile` precedes the `subarray`.
- **Proposed fix:** reject non-regular entries with a named reason; open the file and read at most `limit + 1` bytes.
- **Acceptance test:** the three tests.

#### VC-093 [P3] A deeply nested `migration.yaml` is refused with the YAML library's stack-overflow text, not a named limit

- **Area:** packages/migrations/src/format/yaml.ts
- **Block:** B (I14, I15)
- **Reproduction:** `tools/probe.ts yaml-flow-depth 1000` (2 KB of `[`). Test: `I14-containment.pure.test.ts` "depth 1,000 is refused with a NAMED limit".
- **Expected:** a named reason for the nesting limit.
- **Actual:** `MIGRATION_MANIFEST_INVALID` with `yaml_syntax` "Maximum call stack size exceeded" from depth 1,000. No crash, no throw, 60 ms.
- **Evidence:** `B/conformance/I14-containment.pure.test.ts`
- **Root cause:** `yaml.ts:23-30` relies on the library's recursion.
- **Proposed fix:** reject a depth above 32 with `yaml_depth` before composing the document.
- **Acceptance test:** the named test.

#### VC-094 [P3] The limits of bundles are not announced in one place, and two bite below the documented ones

- **Area:** exponetdb-docs/04-migrations/migration-bundles.md section 1 and 2, authoring-and-ci.md, contracts `MIGRATION_REQUEST_LIMITS`, `BUNDLE_INVALID_REASONS`
- **Block:** B (I15)
- **Reproduction:** `I15-limits.pure.test.ts` (23 cases at the boundary), `I5-edges.int.test.ts` "100,000 tiny statements".
- **Expected:** every size/count/depth/time limit has a named error and a documented value.
- **Actual:** the four file sizes, name 64, description 2,000, durations 1 ms to 6 h and the 60 s lock warning match code and docs at the boundary (accepted at the limit, refused one past it, named `file_too_large` / `duration_out_of_range`). Not in `04-migrations/`: `dependsOn` 1,000, extensions 64, `searchPath` 32, authors 32 x 320, ticket 200, 50 bundles and 200 ids per request, 32 MiB body, 5,000 bundles for the CLI (the CLI error names it; the server has no count limit). The 200,000-token parse bound (deployment.md section 2a only) makes 100,000 `SELECT 1;` (1 MB, a quarter of the documented 4 MiB, which the server executes) a lint `parse_error` whose text says `too_large`; there is no reason code for it. A statement or request that crosses a time limit is `MIGRATION_EXECUTION_FAILED` + SQLSTATE 57014 (statement timeout), `MIGRATION_LOCK_TIMEOUT` (lock): both proven in `I15-time.int.test.ts`; the statement timeout has no code of its own.
- **Evidence:** `B/conformance/I15-limits.pure.test.ts`, `B/conformance/I15-time.int.test.ts`
- **Root cause:** limits were added with the code that needed them, not to the bundle contract.
- **Proposed fix:** one table in `migration-bundles.md` section 1; a reason `parse_budget_exceeded`; see decision B2-D6.
- **Acceptance test:** a docs test that parses the table and compares with the exported constants.

#### VC-095 [P3] The bundle store drops edits that do not change the checksum, although the documentation says it keeps them

- **Area:** packages/migrations-engine/src/store.ts (`ingestBundles`, "same" test), packages/migrations/src/lint/lint.ts (`comment_only_change`)
- **Block:** B (I13; also reported statically by B1 as FB1-9)
- **Reproduction:** ingest a bundle, then the same bundle with an extra comment line in `up.sql`, or with another `description`. Tests: `I13-immutability.int.test.ts` "a comment-only edit ... is stored as a new revision (verify_revision)" and "a changed description ...".
- **Expected:** `store.ts` header and `migration-bundles.md` section 3: "a new verify, rollback or comment content with the same apply checksum is a `verify_revision`"; the new bytes are stored and `comment_only_change` can report them.
- **Actual:** status `unchanged`, the earlier revision is returned, the new bytes are dropped (the bundle digest is derived from three digests, never from bytes). What the human approved and what the repository holds can differ in comments and descriptions with no trace; `comment_only_change` cannot fire on the server path because the planner lints the stored bytes.
- **Evidence:** `B/conformance/I13-immutability.int.test.ts`
- **Root cause:** `store.ts:184-190`: `existing.find((r) => r.checksum === ... && r.bundleDigest === ...)` ignores the bytes.
- **Proposed fix:** compare the source digest and the manifest/verify/down bytes as well, and store a `verify_revision` (or a `metadata_revision`) when they differ.
- **Acceptance test:** the two I13 cases above.

#### VC-096 [P3] Lock facts and rules missing for several heavy statements

- **Area:** `packages/postgres/src/parser/migration.ts`
- **Block:** B
- **Reproduction:** `results/hazard-strict-plan-large.json` (h32, h34, h37, h38, h39); `pgcheck/01-checks.sh`.
- **Expected:** lock facts matching PostgreSQL; non-concurrent REINDEX and DROP INDEX pointing to the CONCURRENTLY form.
- **Actual:** `ALTER SEQUENCE` and `CREATE OR REPLACE VIEW` have no lock fact (`lockSeverity none`), although PostgreSQL takes SHARE ROW EXCLUSIVE on the sequence and ACCESS EXCLUSIVE on the view. `ATTACH PARTITION` records only the parent's lock (the attached table is ACCESS EXCLUSIVE, with a scan unless a validated CHECK exists). `SET UNLOGGED` is a rewrite classified `unknown` with no `rewriteRisk`. `data_change_unbounded` fires only for a missing WHERE (`WHERE id > 0` is silent). PostgreSQL 18 virtual generated columns are flagged volatile (not run here).
- **Evidence:** `pgcheck-01` (h32, h32b, h37, h38, h39)
- **Root cause:** `migration.ts:1005-1011, 1764-1774, 1822-1826`, the default branch of `alterTable`.
- **Proposed fix:** add the lock facts; separate attach with and without CHECK; optionally rules for non-concurrent REINDEX and DROP INDEX.
- **Acceptance test:** statement-facts tests per statement kind; one assertion per lock mode proved in `pgcheck`.

#### VC-097 [P3] Master-key rotation has no role order, and the wrong order takes serve out of service

- **Area:** `08-auth-and-security/secrets.md` §3, `12-operations/deployment.md` §2, `composition/{role,commands}.ts`
- **Block:** C
- **Reproduction:** static (`C/keys-certs-time.md` step 2): restart the worker with the new keyring first, wait 11 minutes, then check serve readiness and a TOTP login.
- **Expected:** a runbook that cannot be followed in a damaging order.
- **Actual:** `keyring add-key` makes the new key active; the worker's `secrets.rewrap` (every 10 minutes, `worker-tasks.ts:226`) re-wraps as soon as the worker has the key; a serve on the old keyring fails readiness `keyring_missing_key` (critical) and `secret_key_unavailable` on `auth` secrets. No document gives the order or says the keyring has no age or expiry.
- **Evidence:** `C/keys-certs-time.md` §1.
- **Root cause:** rotation steps stop at the key file.
- **Proposed fix:** document the order (all roles hold both keys and are ready before the rewrap); make the rewrap wait until every live process reports the new key id.
- **Acceptance test:** a stack test of the rotation in the wrong order asserts the documented recovery.

#### VC-098 [P3] A data read runs on the target before its audit event is written

- **Area:** `packages/application/src/queries.ts:249-256,333-345`
- **Block:** C
- **Reproduction:** static (`C/fail-closed.md` step 7): make the append fail, run a query with a marker, read `pg_stat_statements` on the target.
- **Expected:** for customer data the audit precedes the read, or the read is refused while the append is impossible.
- **Actual:** `#audit` is written after the result exists; when it fails the caller gets 500 but the statement ran (in a read-only transaction), and that read has no audit trail.
- **Evidence:** `C/fail-closed.md` §1.1.
- **Root cause:** the event carries the outcome (rows, bytes).
- **Proposed fix:** write a `requested` event first and a `completed` event after (both phases exist).
- **Acceptance test:** with the append failing, the read is not executed on the target.

#### VC-099 [P3] The maintenance loop has no per-task deadline and tasks cannot renew their lease

- **Area:** `apps/server/src/composition/worker-tasks.ts:338-370`, `packages/control-store/src/maintenance.ts:30-76`
- **Block:** C
- **Reproduction:** static: hang `health.sample` on a blackholed target, or run `audit.verify_full` over a large chain with two workers.
- **Expected:** a slow task does not stop plan expiry, checkpoints or node binding; a long task keeps its lease or is bounded.
- **Actual:** a serial loop, `await task.run(ctx)`, a 300 s lease that is never renewed: a hung task blocks the others on that worker; with a second worker a task over 300 s runs twice. The only signal is `tasks_overdue` after 15 minutes in authenticated installation health.
- **Evidence:** `C/graceful-life.md` §5.
- **Root cause:** designed for short tasks.
- **Proposed fix:** a per-task deadline, lease renewal and a longest-running-task metric.
- **Acceptance test:** a task that never resolves is abandoned at its deadline and the next task runs.

#### VC-100 [P3] An oversized JSON request body is refused without naming the limit

- **Area:** `apps/server/src/interfaces/http/api.ts:2124-2145`, `request.ts:196-214`
- **Block:** C
- **Reproduction:** `C/graceful-life.md` step 7: send 100 MB and 100 KB JSON bodies.
- **Expected:** the detail names the limit as raw bodies do (`/body`, `too_large`, "At most N bytes.").
- **Actual:** `readBody` throws a bare `VALIDATION_FAILED`; the problem shows `{path: '', code: 'invalid', message: 'The request is not valid.'}`.
- **Evidence:** `C/graceful-life.md` §3.
- **Root cause:** two body readers written separately.
- **Proposed fix:** the same detail in `readBody`.
- **Acceptance test:** a 100 KB body to a 64 KiB route returns `errors[0] = {path: '/body', code: 'too_large'}`.

#### VC-101 [P3] archive_mirror_rows binds neither generation, ids nor lease to the operation, and takes no row lock

- **Area:** bundle ledger-reconcile (`migrations.archive_mirror_rows`, SECURITY DEFINER)
- **Block:** D
- **Reproduction:** `D/d0/` exercise_archive.sql A7/A8 move another generation and ids the plan never named, with a wrong reason label (every moved row is kept in history). exercise_race.sh e1: the check passes, the DELETE waits on a row lock, the operation leaves `running`, and the DELETE still moves 2 rows. With the engine's FOR SHARE fence (e2) the transition waits, so the engine path is safe and the function alone is not.
- **Expected:** the function moves only rows the named, still-running ledger.reconcile operation of that target is entitled to move.
- **Actual:** it checks the operation kind and target at call time only; a NULL reason gives 23502.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 3); D/d0/ exercise_archive.sql, exercise_race.sh.
- **Root cause:** `packages/control-store/migrations/01M61C90YHV706H2B8EW39TBAF_ledger-reconcile/up.sql:35-52`.
- **Proposed fix:** FOR SHARE on the operation row, a lease test, bind generation (and ids) to the plan, use `IS DISTINCT FROM` in the reason test.
- **Acceptance test:** a raw call for an operation that left `running` is refused; a call for ids or a generation outside the plan is refused.

#### VC-102 [P3] The three verify.sql files of the new bundles pass on broken bundles and none checks ownership

- **Area:** bundles operation-supersession, ledger-reconcile, offline-drill-record
- **Block:** D
- **Reproduction:** `D/d0/` mutate_verify.sh applies 23 mutations to the installed objects and re-runs each `verify.sql`: 11 of 23 still pass (guard replaced by a no-op that mentions the function name in a comment; guard with `OR true`; guard without the serve restriction; history trigger INSERT-only or disabled; archive_mirror_rows without search_path, as SECURITY INVOKER, with the check removed, or with another owner; record_offline_drill with a wrong body or another owner).
- **Expected:** control-database.md §5a: every verify.sql checks ownership and what the function does.
- **Actual:** operation-supersession/verify.sql:16 is a LIKE on the function text; ledger-reconcile/verify.sql:3-4 only counts triggers and :10-13 checks no prosecdef/proconfig/owner; offline-drill-record/verify.sql:10-12 has no owner or body check.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 4); D/d0/mutate_verify.sh.
- **Root cause:** weak verification assertions (the exact class the brief calls "verify.sql that passes on a broken change").
- **Proposed fix:** assert proowner, prosecdef, proconfig, trigger tgtype/tgenabled and a body digest in each verify.sql (in a new bundle revision; the files are not frozen yet).
- **Acceptance test:** the mutation script ends with every mutation failing the checks.

#### VC-103 [P3] POST /clusters/{id}/drills/offline with restoredAt ahead of the database clock is a 500

- **Area:** packages/application/src/backups.ts:587-630, bundle offline-drill-record, error mapping (fix of TC-013)
- **Block:** D
- **Reproduction:** `D/d0/` exercise_drill.sql C5: `drill_guard` raises EXB06. EXB06 and EXM01 are mapped nowhere (grep). The HTTP route itself was NOT RUN.
- **Expected:** a client error (400 VALIDATION_FAILED on /restoredAt), not an internal error.
- **Actual:** the application passes the value through and the database exception surfaces as a 5xx (the very class TC-013 fixed for the happy path).
- **Evidence:** D/new-bundles-security-review.md §3 (finding 5).
- **Root cause:** `packages/application/src/backups.ts:587-630` does not compare restoredAt with the clock; SQLSTATE EXB06/EXM01 have no mapping.
- **Proposed fix:** validate restoredAt against the clock and map EXB06/EXM01 to typed errors.
- **Acceptance test:** `http-backups.int.test.ts`: restoredAt one day ahead gives 400.

#### VC-104 [P3] 24 of 45 Control Store bundles are not pinned, the three new ones among them

- **Area:** packages/control-store/frozen-bundles.json, packages/control-store/test/immutable-bundles.test.ts
- **Block:** D
- **Reproduction:** `jq` over `frozen-bundles.json` and listing `packages/control-store/migrations/`: the freeze list stops at Wave 6 (21 entries for 45 bundle directories); PR #46 changed neither the list nor the test. (D0 first counted 27; E2 recounted: 45 directories, 21 pinned, 24 unpinned.)
- **Expected:** every bundle that can have been applied on an installation is pinned by checksum (an applied bundle changed in place is a `MIGRATION_CHECKSUM_MISMATCH` on every installation that applied it); the docs call the backup-catalog bundle "frozen".
- **Actual:** the backup-catalog bundle and everything after Wave 6, including the three new bundles, can be edited without a test failing.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 6); R/baseline.md.
- **Root cause:** the freeze list is maintained per wave by hand and was not extended for Wave 7 to 9 or for the fix.
- **Proposed fix:** pin all deployed bundles; pin the three new ones as soon as they are deployed (see decision D0-05); lint the Control Store bundles in CI.
- **Acceptance test:** the pin test lists the ids and fails on a one-byte edit of any of them.

#### VC-105 [P3] migration.resume takes the operation it closes from the target's own ledger events (static reading only)

- **Area:** packages/migrations-engine (resume.ts:123, kind.ts:131-139, recovery.ts:14-35)
- **Block:** D
- **Reproduction:** NOT RUN (static). A hostile event in the target's ledger naming another operation of the same target.
- **Expected:** the operation to close is derived from the Control Store (as `stuckOperationOf` does for migration.verify), never from data in the managed database.
- **Actual:** resume derives it from the target's ledger events. The blast radius is at most the single needs_attention operation holding that target's schema domain, and a production resume needs approval plus re-auth.
- **Evidence:** D/new-bundles-security-review.md §3 (finding 7).
- **Root cause:** two different derivations of "the stuck operation".
- **Proposed fix:** look it up with `stuckOperationOf`.
- **Acceptance test:** a hostile event naming another same-target operation closes nothing.

#### VC-106 [P3] The existence of node, backup repository and registry-plan subject ids is visible to callers without access

- **Area:** `packages/application` (`nodes.ts`, `backups.ts`, `registry.ts`, `application.ts` `#plan`/`#inline`); REST and MCP `node_status`
- **Block:** D
- **Reproduction:** static, generated: `authz-matrix.md` section 4 "lookup-before-authz" (25 candidates, 14 real). Live (NOT RUN, harness ready): with a credential that lacks the permission, e.g. `oauth-narrow` or `developer-nonprod`, `GET /api/v1/nodes/{real node id}` then `GET /api/v1/nodes/nod_<fabricated>`; same for `POST /nodes/{id}/revoke`, `/config-updates`, `/decommission`, `/inspections`, `GET /nodes/{id}/jobs`, `/observations`, `POST /backup-repositories/{id}/ownership`, `/retire`, `POST /products/{p}/environments/{e}/change-plans`, `POST /projects/{p}/environments/{e}/execution-role-plans` and `/execution-role-exceptions`, `POST /projects/{p}/execution-role-exceptions/{x}/revoke-plans`, `POST /targets` (planTargetRegistration, ids in the body), and MCP `node_status`. `run-matrix.ts` with `fixtures.foreign.nodeId` reports `EXISTENCE-LEAK`.
- **Expected:** error-model.md section 4 (lines 324-366): "To avoid leaking existence, a caller who may not see a resource receives NOT_FOUND-class codes" and, for targets, admission first, then lookup; the same status and code for an id that does not exist and one the caller may not see.
- **Actual:** the subject is looked up first: `nodes.ts:78-84` (`#nodeSubject` throws `NOT_FOUND`) runs before `authorize` in `node()` (`:426-428`), `jobs()` (`:382-388`), `observations()` (`:228-234`) and, as a subject thunk, before the engine in every node plan (`application.ts:2172-2181` evaluates `await subject(tx)` as an argument of `#authorize`); `backups.ts:128-135` with `planOwnership`/`planRetirement` (`:427-452`); `registry.ts:833-844` (`#projectEnvironment`), `:770-785`, `:1131-1155` and the product-by-slug thunk of `planProject`. A caller without the permission gets 404 for an unknown id and 403 for a real one. The ids are 80-bit random, so this is an oracle for ids the caller already holds (audit lines, URLs), not enumeration. `getTarget`, product/server/cluster reads, backup catalog, breakglass, raw statements and saved queries do it right (admit, then lookup).
- **Evidence:** `D/authz/authz-matrix.md` section 4; `D/authz/lib-ast.ts` event order; code lines above. **Wider on the stack (S4):** also clusters, servers, backups, plans and operations (and products for a narrow OAuth client): a fabricated id answers 404, a real one 403 (`D/security/authz-run.md`); D1 had marked clusters, servers and products uniform.
- **Root cause:** the Wave 4 rule (admit first) was implemented in `#authorizedTarget`/`#target` helpers of four classes but not in `#plan`/`#inline`, whose subject thunks may query before phase 1, and not in the node and backup-repository readers.
- **Proposed fix:** in `#plan` and `#inline` call `this.#admit(tx, action, caller)` before `await subject(tx)`; add the same `admit` before `#nodeSubject` in the node reads and before `#repositoryCluster` in the two repository plans.
- **Acceptance test:** integration: for each listed route, a credential without the permission gets the same status and code for a real and a fabricated id (the `foreign` check of `run-matrix.ts` as a test); fails before the fix.

#### VC-107 [P3] Plan analysis text and advisor evidence reach agents and approvers without the `untrusted` marker

- **Area:** `packages/contracts` (`PlanViewSchema`, `AdvisorFinding`), `packages/migrations-engine/src/analysis.ts`, MCP tools `plan_get`, `migration_plan`, `migration_rollback_plan`, `plan_withdraw`, `advisors_run`
- **Block:** D
- **Reproduction:** `bun --conditions=@exponetdb/source gen-matrix.ts` and read `authz-matrix.md` section 8 (column "unmarked free strings") and section 4 "mcp-unmarked-free-text"; then read `analysis.ts:189` (destructive object names), `:205-222` (`verify.checks[].name`, `.covers[]`, `consumer.identity` from `-- check:`, `-- covers:`, `-- calls:` comments of `verify.sql`, parser `verify-checks.ts:45`), `:55` (lint message). A plan with `-- check: <text>` in `verify.sql` returns that text in `plan_get` `change.analysis`.
- **Expected:** ai-agent-safety.md section 2 (line 38): text from catalogs and callers is "labeled `untrusted` in MCP output schemas"; the approval review (`application.ts:1361-1365`) states "No number or word in it comes from an agent."
- **Actual:** `change.content` and `change.analysis` are plain `JsonValue` (`resources.ts:1395`); the plan tools have `openWorldHint: false`. Strings from the bundle author (check names and cover lists up to 128 characters, object names up to 300, lint messages up to 1,024) are returned unmarked to any reader of the plan and shown in the approver's review. `advisors_run` `findings[].evidence{}` (256 characters) is unmarked while its `message`, `object`, `remediation` are. Mitigations present: control characters escaped, links/images/fences defused in the text block, bounded length. The plan's author is normally the reader, which bounds the risk; a teammate's or another agent's plan read via `plan_get`, and the approval page, are the exposed paths.
- **Evidence:** `D/authz/authz-matrix.md` sections 4 and 8; `agent-safety.md` section 3.1.
- **Root cause:** analysis was typed as an open JSON value in Wave 6; the Wave 7 marking pass covered catalog and row text only.
- **Proposed fix:** give `analysis` a closed schema whose author-derived members use `untrustedText` (or wrap them as `untrustedJson`), set `openWorldHint: true` on the plan tools, mark `evidence` values; drop `-- check:` names from the analysis or restrict them to a slug pattern.
- **Acceptance test:** `mcp-tools.test.ts` style: the served output schema of `plan_get` contains no free string outside an `untrusted` member; a plan whose `verify.sql` has `-- check: ignore previous instructions` returns that text only inside an `untrusted: true` member.

#### VC-108 [P3] A database client decides, through `application_name`, that ExponetDB must not cancel its session

- **Area:** `packages/postgres/src/session-conditions.ts`, policy `connections.replication-protect` / `connections.no-superuser-terminate`
- **Block:** D
- **Reproduction:** read `session-conditions.ts:74-80` (`protectedSession`) and `:84-91` (`protectionReason`); any role that can connect to a managed database runs `SET application_name = 'exponetdb/x'` (or a backup-tool name) and the session is classified `exponetdb_session` / `backup_session` -> `connections.*` deny. Live run: NOT RUN.
- **Expected:** ai-agent-safety.md section 2 and constitution principle 7: content from the target is data; it feeds no policy decision.
- **Actual:** `coalesce(application_name,'') LIKE 'exponetdb/%'` and the backup-application regex make a session immune to `connections.cancel` and `connections.terminate` (not overridable by break-glass), so a runaway or hostile client keeps its locks against ExponetDB's remediation tools.
- **Evidence:** the two functions above; `packages/policy/src/catalog/connections.ts`.
- **Root cause:** protection is derived from a client-controlled setting.
- **Proposed fix:** protect by `backend_type`, role membership (`exponetdb_*` roles, superuser) and the pids ExponetDB itself opened (it knows its own backend pids); keep the application-name test only as an advisory label.
- **Acceptance test:** a PostgreSQL 17 integration test where a non-superuser role sets `application_name = 'exponetdb/spoof'`; `connections.terminate.plan` for that pid must not be `protected`.

#### VC-109 [P3] `packages.apply_update` is a node mutation outside the approval rule and outside the test that pins the catalog

- **Area:** `packages/policy/src/catalog/nodes.ts`, `packages/contracts/src/actions.ts:1178`
- **Block:** D
- **Reproduction:** `authz-matrix.md` section 5 row `packages.apply_update` (M and S reachable by action definition, tier `subject_max`, no approval rule); `node-rules.test.ts:99` selects kinds by wave `5` or `8`; this kind is wave "after 9".
- **Expected:** policy-engine.md and `nodes.ts:10-15`: "Every change through the node agent on a production cluster or node needs a human approval, whatever its class"; authorization.md section 4: `nodes.operate:prod` "approval always".
- **Actual:** `NODE_APPLY_KINDS` (`nodes.ts:16`) lists ten kinds and not this one; the catalog test cannot notice it. No planner or executor exists yet, so it is not exploitable now (`plan.apply` answers `operation_kind_unknown`); the moment a kind is registered, a service account with `nodes.operate:prod` could apply it on production without the rule.
- **Evidence:** as above.
- **Root cause:** the kind list is explicit and the catalog test is filtered by wave.
- **Proposed fix:** derive the rule's `appliesTo` from the action registry (every `operationKind` with permission `nodes.operate` or subject node/cluster and class above low), and drop the wave filter from the test.
- **Acceptance test:** the test selects by action properties, not by wave; it fails today for `packages.apply_update` (and would for any future node kind).

#### VC-110 [P3] identity.md says every `critical` plan needs a fresh re-authentication to apply; the code enforces it only where a kind or policy rule declares it

- **Area:** `exponetdb-docs/08-auth-and-security/identity.md:83`, `authorization.md:458`, `packages/auth/src/authorization/engine.ts:382-408`
- **Block:** D
- **Reproduction:** read `governing()` (`engine.ts:401-408`): a stored `critical` plan makes the apply human-only and nothing else. `postgres.roles.apply` (`by_plan`, critical when it grants CREATEROLE, REPLICATION, BYPASSRLS or a predefined role, `actions.ts:1142`) declares no re-authentication; on nonprod no rule adds approval or re-auth, on prod `node.prod-apply-approval` adds approval only.
- **Expected:** identity.md section 4 table: "Applying `critical` plans | 5 min".
- **Actual:** authorization.md:458 says the opposite for by-plan kinds ("remain what the policy rules require", G5 record section 9 item 16: the owner may want a nonprod approval rule for critical classes). A person with a CLI token (nonprod grant) applies a critical roles plan on a nonprod cluster with neither approval nor a fresh proof.
- **Evidence:** the lines above; `authz-matrix.md` row `postgres.roles.apply`.
- **Root cause:** two documents disagree; the engine follows the second.
- **Proposed fix:** owner decision D-D1-1; then either add `reauthentication` to `governing()` when `planClass === 'critical'` or correct identity.md.
- **Acceptance test:** a delegation-matrix case: a CLI bearer applying a critical `postgres.roles.apply` plan on nonprod without a step-up receipt is refused `REAUTH_REQUIRED` (or the document is corrected and the test pins the documented behavior).

#### VC-111 [P3] Six CLI commands declare scopes the API does not accept

- **Area:** `apps/cli/src/commands/registry.ts`, `migration.ts` (command registry feeding help and the agent reference)
- **Block:** D
- **Reproduction:** `gen-matrix.ts`, `authz-matrix.md` section 4 "cli-scope-mismatch": `cluster endpoints` (`registry.ts:932-933`), `cluster databases`, `cluster credentials` declare `nodes.read`, their actions need `registry.manage`; `cluster credential submit` (`:1317-1318`) declares action `credential.list` although submission is web-only (`registry.credential.submit`); `cluster credential rotate` (`:1421`) declares `nodes.plan`, the action needs `registry.manage`; `migration verify` (`migration.ts:932-933`) declares `migrations.read`, `migration.verify` needs `migrations.apply:<tier>`.
- **Expected:** the declared scopes are what the command needs (help, completion and the generated reference come from them, cli/README.md section 1).
- **Actual:** a user or agent following the help requests a token without the needed scope and meets `INSUFFICIENT_SCOPE` (the server decides correctly; this is documentation and UX).
- **Evidence:** generator output.
- **Root cause:** declarations written by hand, no test compares them with the action registry.
- **Proposed fix:** a unit test over `COMMANDS` x `ACTIONS` (what the generator does) and corrected declarations.
- **Acceptance test:** that test; fails today with the six commands.

#### VC-112 [P3] Allowlisted functions and views disclose server details to every data.read caller

- **Area:** `allowlist.ts` (`inet_server_addr`, `inet_server_port`, `current_setting`), admission (`information_schema._pg_foreign_*`)
- **Block:** D
- **Reproduction:** `sql_query` of `SELECT inet_server_addr(), inet_server_port(), version()`; `SELECT name, setting FROM pg_catalog.pg_settings WHERE name ~ '(file|command)$'`; `SELECT * FROM information_schema._pg_foreign_tables`.
- **Expected:** a data reader learns no server address, key file paths, archive/restore commands or FDW file paths.
- **Actual:** the server's address and port, `ssl_key_file`/`ssl_cert_file` paths, `archive_command`, `restore_command`, `cluster_name`, and the options (file names) of foreign tables come back; a plain login role gets zero rows for the foreign-table views (the `pg_read_all_data` effect, sweep delta).
- **Evidence:** `results.md` (catalog sweep, rows func-062, func-069, func-070); `data/sweep-pg17.json`.
- **Root cause:** `allowlist.ts` lists `inet_server_addr`, `inet_server_port` and `current_setting` without a name filter; `SECRET_CATALOG_RELATIONS` (`admission.ts:144`) lacks `information_schema._pg_foreign_*`.
- **Proposed fix:** remove `inet_server_addr` and `inet_server_port`, restrict `current_setting` to a name allowlist, add `_pg_foreign_data_wrappers`/`_pg_foreign_servers`/`_pg_foreign_table_columns`/`_pg_foreign_tables` to the refused list.
- **Acceptance test:** the four statements are refused with `QUERY_CONSTRUCT_UNSUPPORTED` on 16/17/18.

#### VC-113 [P3] The Web editor's classifier calls EXPLAIN a read-only path that sql_query refuses

- **Area:** `packages/diagnostics/src/sql-classification.ts`, `data.read`
- **Block:** D
- **Reproduction:** `classifySql(17, "EXPLAIN SELECT 1")` gives `readOnlyPath.admitted` true; `sql_query` with the same text answers `QUERY_CONSTRUCT_UNSUPPORTED` (`statement_class`). Corpus rows proc-038 to proc-041.
- **Expected:** consistent answers, or the classifier names the explain tool.
- **Actual:** the editor suggests a path that the query tool refuses; no safety impact (the guard is the server's).
- **Evidence:** `results.md` rows proc-038 to proc-041.
- **Root cause:** `classifySql` reuses `admitRead`, whose "explain" class is only valid for kind explain (`executor.ts:184`).
- **Proposed fix:** report `readOnlyPath` per tool (query or explain) or add `explain_only`.
- **Acceptance test:** `classifySql("EXPLAIN SELECT 1")` is not "admitted" for the query path.

#### VC-114 [P3] Thirteen catalog error codes are documented and exposed but never produced

- **Area:** `packages/contracts/src/errors.ts`, `apps/cli/src/cli/exit.ts`, `apps/web/src/lib/i18n/messages/changes.ts`
- **Block:** E
- **Reproduction:** (static) token search of `packages/*/src` (without contracts, ui, sdk) and `apps/server/src`: no file names `ORDER_DIVERGES_FROM_EVIDENCE`, `OPERATION_CONFLICT`, `MIGRATION_DEPENDENCY_UNVERIFIED`, `MIGRATION_REQUIREMENT_UNMET`, `STAGING_EVIDENCE_MISSING`, `STAGING_VERIFICATION_FAILED`, `STAGING_EVIDENCE_UNREACHABLE`, `EVIDENCE_CHAIN_MISCONFIGURED`, `BACKUP_NOT_VERIFIED`, `TOKEN_EXPIRED`, `BACKUP_FAILED`, `RESTORE_FAILED`, `SAMPLE_STALE`.
- **Expected:** every documented code can occur, or is marked reserved.
- **Actual:** evidence and dependency refusals arrive as `POLICY_DENIED`; the CLI maps four of the codes to exit 4 and the Web App has message keys for at least two.
- **Evidence:** `E/errors.md` §2.
- **Root cause:** rules replaced the codes during Waves 6 and 7.
- **Proposed fix:** delete them or mark them reserved in `error-model.md`; point the CLI and Web mappings at `POLICY_DENIED` rule ids.
- **Acceptance test:** a test that fails when a catalog code has no emitter (with an allow-list of reserved codes).

#### VC-115 [P3] 69 catalog codes carry no remedy; the operationally important ones are listed

- **Area:** `packages/contracts/src/errors.ts` (`remediation`)
- **Block:** E
- **Reproduction:** (ran: script over `catalog.json`) 38 of 129 codes have `remediation`; a keyword search of the documented meaning leaves 69 without any remedy hint (an upper bound).
- **Expected:** each code says what to do next, with the CLI command where one exists.
- **Actual:** e.g. `LEDGER_NOT_INITIALIZED`, `TARGET_IDENTITY_MISMATCH`, `CLUSTER_IDENTITY_MISMATCH`, `SCHEMA_FINGERPRINT_MISMATCH`, `VERIFICATION_FAILED`, `POLICY_DENIED`, `RESTORE_SOURCE_INVALID`, `PLAN_ALREADY_USED` name no next step and no id.
- **Evidence:** `E/errors.md` §3, §5.2, §7.
- **Root cause:** remedies were added code by code.
- **Proposed fix:** fill `remediation` for the about 20 operational codes; add the missing ids to their `details` schemas (`PLAN_ALREADY_USED.operationId`, `SCHEMA_FINGERPRINT_MISMATCH.expected/actual`, `TARGET_IDENTITY_MISMATCH.targetId`).
- **Acceptance test:** a contract test listing codes without `remediation` and failing for any not on an allow-list.

#### VC-116 [P3] `drift.accept` is documented for "the Web App or the CLI"; the CLI has no command

- **Area:** `apps/cli`, `03-database-model/drift-detection.md` §5, `02-control-plane/operations-engine.md` §2
- **Block:** E
- **Reproduction:** (ran) `exponetdb commands` lists no `accept`; `drift.accept.plan` exists in the SDK and REST only.
- **Expected:** `exponetdb finding accept <finding> --reason …`.
- **Actual:** accepting drift needs the Web App.
- **Evidence:** `E/state-machines.md` §6 (SM-5).
- **Root cause:** Wave 8 added the plan route and the Web page only.
- **Proposed fix:** the command (plan plus `--apply`), or correct the two sentences.
- **Acceptance test:** the CLI reference lists `finding accept`; an e2e test accepts a drift finding.

#### VC-117 [P3] Break-glass cannot be activated from the CLI or, on this installation, at all; documents say otherwise

- **Area:** `04-migrations/staging-production-policy.md:179`, `02-control-plane/operations-engine.md` §8, `apps/cli`
- **Block:** E
- **Reproduction:** (ran) no command in `exponetdb commands` activates break-glass; `migration plan --break-glass <bgl_>` only consumes a grant. (static) `BREAK_GLASS_UNAVAILABLE` / `notification_channel_not_configured` (OD-21).
- **Expected:** "in the Web App or the CLI", or an honest statement that the production no-evidence hotfix path is closed.
- **Actual:** hotfix findings E16/E18 are waived, and the only escape for a no-evidence production change is unavailable.
- **Evidence:** `E/docs-claims.md` DC-028, DC-044; `E/recoverability.md` R16.
- **Root cause:** OD-21.
- **Proposed fix:** say in the docs that this installation has no break-glass, or build the channel (owner decision OD-21).
- **Acceptance test:** the command-existence check of the next finding.

#### VC-118 [P3] Documents name commands, flags, states and rule ids that do not exist

- **Area:** `04-migrations/concurrency.md:88-89`, `12-operations/bootstrap.md:136-140`, `12-operations/local-development.md:42`, `12-operations/backup-runbooks.md:24`, `04-migrations/verification.md:493`, `04-migrations/authoring-and-ci.md:80`, `02-control-plane/policy-engine.md` (rule table)
- **Block:** E
- **Reproduction:** (ran: `cmdcheck.py` over six document folders, 166 `exponetdb …` mentions) misses: `exponetdb lock-key`, `exponetdb ca init-root`, `exponetdb ca issue-intermediate`, `exponetdb dev seed`; also the protection reason `archive_stale` (not in `protection.ts`), the `migration checksum` output (JSON has `bundleDigest`, no source digest), `retry-verification` "only `migration.apply` and `migration.resume`" (four kinds in code), and four policy rule ids (`migration.checksum-consistent`, `migration.dependencies-satisfied`, `migration.pg-version`, `migration.execution-role`) that the 45-rule registry does not contain. 120 of the other mentions resolve, with every flag.
- **Expected:** every command and flag in a runbook exists with that spelling.
- **Actual:** see above; `bootstrap.md` §4 sends a Wave 5 owner to commands of a design that was never built (`node-pki init` is the real one).
- **Evidence:** `E/docs-claims.md` DC-007, 013, 042, 059, 068, 069.
- **Root cause:** documents written before the commands.
- **Proposed fix:** fix the places; add the check as a CI step.
- **Acceptance test:** a script (E1's `cmdcheck.py` is the prototype) exits 1 on any unresolved command or flag in `exponetdb-docs/12-operations` and `04-migrations`; passes after the fix.

#### VC-119 [P3] One program name for two programs with overlapping words (`exponetdb audit`, `exponetdb auth`, `exponetdb version`)

- **Area:** `apps/cli` (bin `exponetdb`), `apps/server/src/main.ts`, runbooks
- **Block:** E
- **Reproduction:** (ran) the CLI has `audit list|show` and `auth status|presets|scopes|reauth`; the image entrypoint has `audit verify|prune` and `auth recover-owner`; 36 mentions in `12-operations` / `04-migrations` do not say which binary.
- **Expected:** a runbook line tells where it runs.
- **Actual:** it does not.
- **Evidence:** `E/vocabulary.md` row "exponetdb".
- **Root cause:** the server image entrypoint predates the CLI.
- **Proposed fix:** prefix server commands in the docs with `docker exec … exponetdb`, or rename the image entrypoint.
- **Acceptance test:** the same CI check, with a table of which binary owns which word.

#### VC-120 [P3] Enum values that no code writes, and a Web label for an unreachable state

- **Area:** `stepup.step_ups.state` (`expired`), `nodes.enrollment_tokens.state` (`expired`), `backups.restores.state` (`promoted`), `apps/web/src/lib/i18n/messages/wave9.ts:529`
- **Block:** E
- **Reproduction:** (static) no `state = 'expired'` writer in `packages/auth/src/stepup.ts` or `packages/nodes/src/tokens.ts`; the `restore_guard` raises `no operation promotes a restore yet` (`01M5X840BK55NGFGQ5G3Z1C5NH_backup-catalog/up.sql:494-497`).
- **Expected:** the stored state is true, or the derived state is labelled derived.
- **Actual:** a past-deadline step-up or token reads `pending` / `confirmed` / `issued` in the table; `expired` is computed on read (`stepup.ts:92-93`); the Web catalog has "Promoted".
- **Evidence:** `E/state-machines.md` §7.
- **Root cause:** states declared ahead of the code.
- **Proposed fix:** drop unreachable values in an additive bundle, or add the sweeper; remove the label.
- **Acceptance test:** a test that every value of a state `CHECK` is writable or documented as derived.

#### VC-121 [P3] Three documents give `operation.force_release` two different meanings, and building it as documented would not close the dead end

- **Area:** `exponetdb-docs/04-migrations/concurrency.md:131`, `01-architecture/failure-model.md` (F11), `02-control-plane/operations-engine.md` §4.1
- **Block:** E
- **Reproduction:** read the three places. `concurrency.md:131` and F11: for "a lock held by a stuck ExponetDB session" a person with `operations.recover` runs `operation.force_release`, which "terminates that exact backend (pid + backend_start), marks the owning operation `needs_reconciliation`, and audits". `operations-engine.md` §4.1: "`operation.force_release`, for an operation no recovery plan covers, remains planned" (the exit for an operation in `needs_attention`).
- **Expected:** one action, one meaning, one lock layer.
- **Actual:** the first meaning releases the target session's advisory lock (layer B in `E/structure.md` §7); the second frees the Control Store exclusivity domain of a parked operation (layer A). A parked `needs_attention` operation has no backend left to terminate, and `needs_reconciliation` is the state whose reconcile already failed. Built as `concurrency.md` describes, the action would leave the P1 dead end open (`F/decisions-E1.md` D-E1-1, option b, says the same without naming the layers).
- **Evidence:** `E/structure.md` §7; `E/docs-claims.md` DC-014; `E/state-machines.md` SM-1.
- **Root cause:** two lock layers with different lifetimes share one release name; the layers are described nowhere together.
- **Proposed fix:** describe layers A, B and C once in `concurrency.md`; register one action per layer (`operation.close` for A, see `E/proposals.md` P-01; a layer-B release only if a stuck-session case is shown to exist); make the other two documents point to them.
- **Acceptance test:** a documents check (P-08 part d): every action id named in `04-migrations/` and `01-architecture/failure-model.md` exists in the action registry and the documents agree on its effect (the action's registered description is quoted by a generated table).

#### VC-122 [P3] Plan acceptance holds the plan row lock and a Control Store connection while it reads the managed target, on a pool of 10 shared with all of `serve`

- **Area:** `packages/operations/src/accept.ts:150-190` (`acceptPlan`), `packages/operations/src/plans.ts:331-340` (`readPlan ... FOR UPDATE OF p`), `packages/migrations-engine/src/kind.ts:184-210` (`#liveBindings`), `packages/migrations-engine/src/planner.ts:575-638`, `apps/server/src/composition/role.ts:75`, `runtime.ts:56-62` (`poolMax = 10`)
- **Block:** E
- **Reproduction:** (static; stack step for C; `B/contract.md` §4 recorded it as an observation "plausible, Block C") Make several targets stop answering after their plans exist (drop the packets, no reset). Send `plan apply` for ten of those plans at once. In parallel read `/healthz/ready` and an unrelated `GET /api/v1/targets`. Static reading: `acceptPlan(tx, ...)` runs `readPlan(tx, id, true)` (`FOR UPDATE OF p`), then `await kind.checkBindings(plan)`, which opens an observer session to the target (connect timeout 5 s, statement timeout 60 s at `kind.ts:210`) and to the evidence target, all before the transaction ends. `openStore(...)` gives `serve` the default `poolMax = 10`. An optional circuit breaker per endpoint (`registry/src/connect.ts:206`) shortens repeated failures; whether it covers this path was not shown.
- **Expected:** an unreachable managed target does not degrade the Control Plane (C-5, C-29); no Control Store connection waits for a target.
- **Actual:** (static) each such accept holds one of the ten connections and the plan row for up to the connect or statement timeout; ten at once could leave none for other requests of the `serve` role. Planning does the same for the whole of `planMigrationApply` (analysis included) inside one transaction (B2.3 shows the 60 s `idle_in_transaction_session_timeout` biting).
- **Evidence:** `B/contract.md` §4; `E/structure.md` §9; `F/findings-B2.md` (cubic lint, Control Store timeout).
- **Root cause:** the binding check is placed inside the acceptance transaction so that the check and the consumption look atomic; the dispatch step re-checks bindings under the lock anyway (`driver.ts`), so the early check is advisory.
- **Proposed fix:** read the live bindings before the transaction (with a deadline), then take the row lock and compare a cheap version token inside it; or give live reads their own small pool and a short deadline. Same for the planner: do the target reads first, then the Control Store work.
- **Acceptance test:** an integration test with a target that never answers: while ten accepts are pending, an unrelated request completes within a stated bound and the pool is not exhausted; fails before.

---

#### VC-123 [P3] One word, several meanings across CLI, REST, Web App and docs: accept, apply, verify, reconcile, baseline, promote, recovery

- **Area:** `apps/cli`, `packages/contracts` (action ids), Web App message keys, `exponetdb-docs/02-control-plane`, `04-migrations`
- **Block:** E
- **Reproduction:** read `E/vocabulary.md` rows `apply` (`migration apply` creates a new plan from the local bundles and applies it, `plan apply` accepts a stored plan, `applyOutcome: applied` is not verified), `verify` (`migration verify` is a new operation that can close a `needs_attention` operation, `operation retry-verification` re-runs the same operation's verification), `accept` (`drift.accept`, `acceptPlan`, approval, gate acceptance), `reconcile` (automatic `kind.reconcile` vs the operator's `ledger.reconcile` vs the mirror's heal), `baseline` (ledger baseline vs drift baseline), `promote` (a word for the evidence rule only: there is no promote command or state, and the restore state `promoted` is unreachable), `recovery` (data recovery, the TC-005 recovery plan, permission `operations.recover`).
- **Expected:** one word for one thing, or a table in the CLI help that tells which is meant (E block, item 2 of the brief).
- **Actual:** an operator reading "apply" or "verify" cannot tell from the word whether the command re-executes, adopts or closes something. E1's table marks which rows could make an operator do the wrong thing; the three highest-risk pairs are `migration apply` vs `plan apply` (the prompt on production shows a plan id, not the plan that was reviewed), `migration verify` (closes another operation at class `low`, see the D0 and R1 findings on the close) and `reconcile` (adopts the target's ledger as truth).
- **Evidence:** `E/vocabulary.md` (rows and the "could make an operator do the wrong thing" column; VOC-1 to VOC-9 are the Y rows).
- **Root cause:** names grew per wave; no vocabulary table is tested against the CLI help and the Web catalog.
- **Proposed fix:** rename or qualify the three risky pairs in CLI help, Web labels and the audit event names; add a generated glossary page and a test that every action id and message key is listed in it.
- **Acceptance test:** a test that fails when a CLI command, action id or Web message key uses a glossary term in a sense the glossary does not list.

#### VC-124 [P3] `migration.bundle.ingest` still stores a bundle with an unknown `dependsOn` silently (TC-008 residual)

- **Area:** `packages/migrations-engine/src/store.ts` (`ingestBundles`), local lint
- **Block:** R
- **Reproduction:** evidence test `tc-5.int.test.ts` j3 on `d51da5d0`: ingest with a ghost id returns `stored`; an unrelated plan now succeeds (fixed), planning the dangling bundle names `details.migrationId` and `details.missing[]` (fixed).
- **Expected:** the finding's proposal also validated `dependsOn` against stream plus submission at ingest and reported dangling stored edges; the fix recorded these as "not done".
- **Actual:** a dangling edge is accepted and only fails when something that depends on it is planned; the project stream view reports `graphErrors` (checked in `stream.ts:223`).
- **Evidence:** `R/R1-notes/TC-008.md`.
- **Root cause:** deliberate scope (commit message of `81b6b542`).
- **Proposed fix:** a warning finding at ingest naming the ghost ids.
- **Acceptance test:** ingest a dangling bundle and read the ingest answer: it names the ghost ids.

#### VC-125 [P3] `HBA_WOULD_LOCK_OUT` tells the operator to "name it in protectedAccess", which cannot make the plan pass, and the CLI prints none of the details that name the access

- **Area:** `packages/contracts/src/errors.ts` (`HBA_WOULD_LOCK_OUT` remediation), `apps/cli/src/output/render.ts` (`NAMED_DETAILS`)
- **Block:** R
- **Reproduction:** `R/R2-notes/probes/r2-hba.test.ts` (unit, `packages/nodes/test`): `hbaLockOut([reject-all hostssl rule], [access])` with the access listed (that is what naming it in `protectedAccess` does) still returns the lock-out with `rule: 1`. In `planNodeOperation` the requested `protectedAccess` is merged into the list that is evaluated, so a listed access can only add a check. For the CLI, `NAMED_DETAILS` holds `migrationId`, `reason`, `extension`, `missing`, `cycle`; the details of this error (`role`, `database`, `address`, `method`, `rule`) are not printed in text mode.
- **Expected:** a remediation that works ("put a rule that keeps the access before the reject"), and the text output names the access that would be lost.
- **Actual:** the remediation reads "Change the rules so that the named access is kept (a rule for it before any reject), or name it in protectedAccess; ..."; the second option never helps. The operator sees only the generic message (the named access is in `--output json` only), the same class as TC-056.
- **Evidence:** `R/R2-notes/probes/r2-hba.test.ts`; log `hbaprobe`
- **Root cause:** `packages/contracts/src/errors.ts` `HBA_WOULD_LOCK_OUT.remediation`; `packages/nodes/src/capability-plans.ts` merges `protectedAccess` before `hbaLockOut`; `apps/cli/src/output/render.ts:151-156`.
- **Proposed fix:** drop "or name it in protectedAccess" from the remediation; add the five detail keys to the text renderer (`role@database from address, rule N`).
- **Acceptance test:** contract test that the remediation does not mention `protectedAccess`; CLI text test that the refusal prints the access and the rule.

#### VC-126 [P3] The node view reports "no restart pending" and no certificate expiry for state the agent never reports, and the certificate overview stays empty

- **Area:** `packages/nodes/src/views.ts` (`clustersOf`), `packages/nodes/src/history.ts` (`reportedServerCertificates`), REST `GET /nodes/{id}`, CLI `node show`, MCP `node_status`
- **Block:** R (remainder of TC-016)
- **Reproduction:** on vc-3 (real agent under systemd, host scenario world), enroll a node and read `GET /api/v1/nodes/{id}`: `clusters: [{"clusterId":"cls_...","localName":"17/exdbnode","running":true,"pendingRestart":false,"serverCertificateExpiresAt":null}]` while `nodes.nodes.heartbeat->'clusters'` has 0 entries and the hello column 1 (`R/R2-notes/probes/r2-e2e6.host.test.ts`, lines `R2-E2`). Set a pending-restart parameter on the cluster: the view still says `false`.
- **Expected:** a value the agent has not reported is shown as unknown (the TC-016 fix text calls it "not reported"), never as `false`; the certificate overview lists the server certificate expiries.
- **Actual:** the REST shape has no unknown, so `pendingRestart: false` and `serverCertificateExpiresAt: null` read as facts (CLI columns `RESTART PENDING` and `TLS UNTIL`); `readCertificates` reads the same empty heartbeat list, so `serverCertificates` is empty for every node. The fix records the limit in `control-plane.md` and the review, which is why it is P3, but the wrong default is a truthful-reads (principle 5) gap.
- **Evidence:** `R/R2-notes/probes/r2-e2e6.host.test.ts`; log `host1`
- **Root cause:** `agent/node/internal/agent/agent.go:510` sends `Clusters: []protocol.HeartbeatRequestCluster{}` by construction; `views.ts` defaults `pendingRestart` to `false` and the expiry to `null` when the heartbeat has no entry.
- **Proposed fix:** the agent reports its clusters in the heartbeat (additive protocol minor with a contract test), or make `pendingRestart` nullable (`null` = not reported) in the view, the OpenAPI shape, the CLI and the Web page.
- **Acceptance test:** host scenario: after enrollment `GET /nodes/{id}` returns `pendingRestart` true after a pending-restart parameter is set and a non-null `serverCertificateExpiresAt`; a unit test that an unreported value is `null`, not `false`.

#### VC-127 [P3] The total-budget refusal of a legacy import advises "import the history in several parts", a flow the import does not have

- **Area:** `packages/migrations-engine/src/legacy-files.ts` (`MAX_TOTAL_PARSE_TOKENS` message), `exponetdb-docs/04-migrations/legacy-import.md`, `exponetdb-docs/12-operations/deployment.md` §2a
- **Block:** R (TC-021)
- **Reproduction:** read the refusal text (`The files together hold more than 1000000 tokens: import the history in several parts.`) and search `legacy-import.md` for a way to analyse one chain in parts: none. The chain analysis needs the whole history (a later file supersedes the expectations of an earlier one: `survivingExpectations` over the concatenated chain), so two partial analyses answer a different question. The first real import holds 623,009 such tokens against the new 1,000,000 budget (62 percent).
- **Expected:** a refusal that names a path that works (raise the budget by configuration after a measurement, or a documented staged import), or a budget that is configurable.
- **Actual:** the hint has no procedure behind it. REOSA's history can grow by about 60 percent before an import is refused with advice that cannot be followed.
- **Evidence:** `R/R2-notes/notes.md` (TC-021); `deployment.md` §2a records that the budget figure is an extrapolation, not a measurement
- **Root cause:** `legacy-files.ts` message text; the missing 512 MiB measurement that would justify the number.
- **Proposed fix:** word the refusal as a limit ("raise `MAX_TOTAL_PARSE_TOKENS` after measuring, or contact the operator") and document the staged import if one exists; run `measure-analyze-memory.ts` with nine dense files under a 512 MiB cgroup and record the result.
- **Acceptance test:** a docs test that every refusal text of `refuseOversizedLegacyFiles` names a documented action; the measurement gate of TC-021 (peak RSS below 350 MiB in a 512 MiB cgroup).

#### VC-128 [P3] No shipped test covers the apply-time pg_hba safety net for a lock-out the plan cannot judge, and the Control Plane outcome of an agent-side refusal is no longer asserted anywhere

- **Area:** `apps/server/test/host/hba.host.test.ts`, `apps/server/test/agent-capabilities.host.test.ts`, `agent/node/internal/capabilities/capabilities_pgit_test.go`
- **Block:** R (TC-018)
- **Reproduction:** compare `git diff d0229550 d51da5d0 -- apps/server/test/host/hba.host.test.ts apps/server/test/agent-capabilities.host.test.ts`: the host assertions `[lockout.state, lockout.applyOutcome] == ['failed','not_applied']`, "pg_hba.conf byte for byte after the refusal", `psql SELECT 1` and "the node still reads the cluster afterwards" are replaced by the plan-time refusal. What still covers the apply side: `TestHbaKeepsExponetDBsOwnAccess` (Go, build tag `pgit`, real PostgreSQL, CI job `node-pg`) for a `local ... reject` block, and the unit table `TestMatchAccessFirstRuleWins`. R2 ran the first on vc-3 (PASS) and disabled the agent's rule check in a scratch copy: the test then FAILS (the post-reload probe still restores the file, a second net), so it is not vacuous. The path that is still reachable through a plan is a rule the plan evaluator leaves to the agent (`samehost`, `samenet`, a host name) against a protected network access; R2's scratch test `r2-hba-unjudged.pgit_test.go.txt` (rule `hostssl all all samehost reject`, protected access `app_user@app from 10.1.0.5`) shows the agent refuses it ("ExponetDB's access app_user@app from 10.1.0.5 would be lost: a rule before the match cannot be judged") and restores the file. No shipped test does.
- **Expected:** one named test that a block the plan could not judge is refused at apply, the file is restored and the cluster stays reachable, and one host test that the operation ends `failed / not_applied` in that case (the old host assertion).
- **Actual:** the behavior is right today (R2's run), but nothing in CI would notice if the apply-time check for network accesses regressed, and the Control Plane's reporting of such a refusal is untested. The fix session wrote that the case "cannot be reached through a plan any more", which holds for the local socket access only.
- **Evidence:** `R/R2-notes/probes/r2-hba-unjudged.pgit_test.go.txt`, `r2-pgit-hba.sh`; log `chain` (sections 1 to 3)
- **Root cause:** the host scenario assertions were removed together with the code path they exercised; the remaining Go test uses only local-socket rules.
- **Proposed fix:** add the R2 pgit test to `capabilities_pgit_test.go`, and a host scenario that plans a `samehost` reject against a derived network access and expects `failed / not_applied` and a restored file.
- **Acceptance test:** the pgit test above (passes with the check, fails with `matchAccess` ignored for network accesses); the host scenario asserts `[state, applyOutcome] == ['failed','not_applied']` and an unchanged `pg_hba.conf`.

#### VC-129 [P3] The new root-only check of `verify-units.sh` fails whenever it is run as root, and CI never runs it as root

- **Area:** `agent/node/packaging/verify-units.sh` (TC-039)
- **Block:** R
- **Reproduction:** on vc-3 as root: `cd agent/node/packaging && bash verify-units.sh`. It prints `units verified`, creates the user `exponetdb-node` in a scratch root (`systemd-sysusers --root`), creates `/var/lib/exponetdb-node` there and then stops with `/var/lib/exponetdb-node is not owned by exponetdb-node`, rc 1. Diagnosis (`R/R2-notes/probes`, log `vu2`): the scratch root's passwd gives the account uid 999; `stat -c %U` resolves that uid through the HOST's passwd and prints `dnsmasq` (or a bare number on a host without uid 999).
- **Expected:** the owner check passes when the directory is owned by the scratch account; the fix session wrote that this branch could not be run unprivileged ("a mutation of the mode made the configuration check fail") and left it unrun.
- **Actual:** the branch can never pass unless the host's uid for that name equals the scratch uid. CI runs `bash packaging/verify-units.sh` unprivileged (`.github/workflows/ci.yml:411`), so the branch is skipped and the defect stays invisible; a person who runs it as root, as the script's comment invites, gets a false failure.
- **Evidence:** log `vu`, `vu2` (index in `R/R2-notes/logs-index.md`)
- **Root cause:** `verify-units.sh` compares `stat -c %U "$root/var/lib/exponetdb-node"` (host NSS) with a name from the scratch root.
- **Proposed fix:** compare numeric ids: `[ "$(stat -c %u "$dir")" = "$(awk -F: '$1=="exponetdb-node"{print $3}' "$root/etc/passwd")" ]`; run the script once as root in CI (the go job can use `sudo`).
- **Acceptance test:** `sudo bash agent/node/packaging/verify-units.sh` exits 0 on a clean Ubuntu 24.04 host and exits 1 when the tmpfiles line is changed to mode `0750`.

#### VC-130 [P3] The test-infrastructure fixes TC-049, TC-050 and TC-054 have no regression guard

- **Area:** `vitest.shared.ts`, `apps/server/test/mcp-evals.model.test.ts`, `apps/server/test/visual-regression.e2e.test.ts`
- **Block:** R
- **Reproduction:** in a `d51da5d0` tree delete `env: { TZ: 'UTC' },` from `vitest.shared.ts`; in `packages/ui-patterns` `TZ=UTC bunx vitest run test/metric-card` passes (14/14, what CI runs), `TZ=Europe/Berlin` fails (1/14).
- **Expected:** a test or CI step fails when the fix is removed.
- **Actual:** CI runs in UTC, so a revert is green; the evals skip (TC-050) and the visual hint (TC-054) are never exercised by any automatic run.
- **Evidence:** R/R3-notes/logs-index.md (tc049-guard-*.log); R/verdicts-R3.md rows TC-049, TC-050, TC-054.
- **Root cause:** configuration and message changes without a test; the only new test of the group is `toolchain.test.ts` (TC-051).
- **Proposed fix:** a tooling test that spawns vitest with `TZ=Europe/Berlin` on one date test (or asserts every config carries `TZ=UTC`); a test that runs the evals config without a key (14 skipped, exit 0); a unit test of `setHint()`.
- **Acceptance test:** deleting the TZ line, or restoring the throw in `mcp-evals.model.test.ts`, turns `bun run test` red in UTC.

#### VC-131 [P3] Two statements about the model evals are stale after TC-050

- **Area:** `tooling/checks/verify-host.ts`, `vitest.shared.ts`
- **Block:** R
- **Reproduction:** `bun run verify:host` says the evals need `ANTHROPIC_API_KEY`; the test reads `EXDB_EVAL_ANTHROPIC_API_KEY` (`mcp-evals.model.test.ts:26`). The comment above `modelEvalsConfig` still says tasks "fail as NOT RUN".
- **Expected:** the correct variable name and wording.
- **Actual:** an operator following the printed hint gets 14 skipped, exit 0 again.
- **Evidence:** `verify-host.ts` (MCP evals entry), `vitest.shared.ts` comment; R/verdicts-R3.md row TC-050.
- **Root cause:** text written for the old behaviour.
- **Proposed fix:** name `EXDB_EVAL_ANTHROPIC_API_KEY`, fix the comment, check the name in a tooling test.
- **Acceptance test:** a tooling test that the key name printed by `verify:host` appears in `mcp-evals.model.test.ts`.

#### VC-132 [P3] Forbidden-statement refusals have one generic remediation and mislabel RESET ROLE

- **Area:** `packages/migrations/src/lint` (forbidden statements), CLI output
- **Block:** B
- **Reproduction:** `B/failure/I4-atomicity-stack.sh`: plan bundles with `COMMIT`, `SAVEPOINT`, `SET LOCAL` and `RESET ROLE`.
- **Expected:** a remediation that fits the statement.
- **Actual:** one remediation ("cluster-level changes are node operations") for COMMIT, SAVEPOINT and SET LOCAL; `RESET ROLE` is reported as `SET ROLE`. The refusals themselves are correct (38 of 47 cases refused at lint and denied at plan).
- **Evidence:** `B/failure/RESULTS.md` section 1.
- **Root cause:** one rule id with one text.
- **Proposed fix:** per-statement remediation text and the right statement name.
- **Acceptance test:** a lint test per forbidden statement asserting its own remediation.

#### VC-133 [P3] Local `migration lint` and the server plan disagree, and a resume without --cleanup is denied with a generic rule

- **Area:** `apps/cli` (`migration lint`, `migration resume`), policy `migration.lint-errors`
- **Block:** B
- **Reproduction:** local `migration lint` on a bundle with `table_without_grant` (strict profile) exits 1; the server plans and applies it. `migration resume` without `--cleanup` after a stopped `CREATE INDEX CONCURRENTLY` is denied.
- **Expected:** one verdict for one bundle; a denial that names the missing flag.
- **Actual:** the CLI blocks on a `warn` that the server accepts; the resume denial is the generic `migration.lint-errors` with no hint; with `--cleanup` it works.
- **Evidence:** `B/failure/RESULTS.md` section 2.
- **Root cause:** different profiles and no hint in the denial.
- **Proposed fix:** align the CLI default with the server profile or print the profile; add a hint to the resume denial.
- **Acceptance test:** a CLI test that the same bundle gets the same blocking result locally and on the server; the resume denial names `--cleanup`.

#### VC-134 [P3] A verification with zero runtime checks passes, and finished operations keep a stale error code

- **Area:** `packages/migrations-engine` (verification), operations
- **Block:** B
- **Reproduction:** a bundle with `runtimeChecks: none` (I6); a worker kill, terminated session or Control Store restart inside the commit window (`F-matrix.sh`).
- **Expected:** a verification with nothing to verify says so; a finished operation carries no error code.
- **Actual:** `verify=passed` with zero runtime checks (reads as verified); operations that ended `succeeded` or `failed/not_applied` still carry `errorCode: OUTCOME_UNKNOWN`.
- **Evidence:** `B/failure/RESULTS.md` (I6 and the matrix).
- **Root cause:** the pass rule counts failures only; the error code is not cleared on reconcile.
- **Proposed fix:** report `verified (no runtime checks)` distinctly; clear the code on a final state.
- **Acceptance test:** a test that an operation with zero checks reads `unchecked`, and that a reconciled operation has no `errorCode`.

#### VC-135 [P3] A comment-only out-of-band change is not seen by the drift check

- **Area:** `packages/postgres` fingerprint `fp1`, drift
- **Block:** B
- **Reproduction:** `B/failure/I7-no-silent-adoption.sh`: `COMMENT ON TABLE ... IS '...'` on a target between two applies, then read the drift baseline.
- **Expected:** a change to the schema's observable state is either drift or documented as outside the fingerprint.
- **Actual:** not detected (the other nine change classes of I7 are detected and not adopted). Object comments are also the channel through which untrusted text reaches an agent, so an unseen comment change is invisible to the very check that would show it.
- **Evidence:** `B/failure/RESULTS.md` (I7 table).
- **Root cause:** `fp1` (frozen) does not cover comments.
- **Proposed fix:** document it in `drift-detection.md`; a `fp2` through an ADR if comments should count.
- **Acceptance test:** a docs test listing the object classes outside the fingerprint.

#### VC-136 [P3] A drill record carries no recovery point for latest, older and backup: targets, and no data comparison

- **Area:** drill records, `restore.execute` checks
- **Block:** C
- **Reproduction:** read the drill records of S2's drills.
- **Expected:** the RPO achieved is readable; a data comparison runs.
- **Actual:** only time targets name the last replayed commit; `fingerprint` and `ledger_head` are `not_run`; `amcheck` covers 1 of 3 to 7 databases.
- **Evidence:** `C/backup-restore.md` §3, §10.
- **Root cause:** the record keeps only what the node reports.
- **Proposed fix:** record the last replayed commit time for every selection and run a count or fingerprint check.
- **Acceptance test:** every drill record names the recovery point.

#### VC-137 [P3] Latency: a drill's operation takes 2.1 times its RTO, and REST verify operations take 3.9 to 38 s for a 1 to 2 s engine run

- **Area:** drill and verify operations (node job polling)
- **Block:** C
- **Reproduction:** `C/backup-restore-numbers.md`: operation time against the product-reported RTO.
- **Expected:** operation time close to the engine time.
- **Actual:** the scratch directory is discarded 60 to 108 s after the verification; verify operations wait on job polling.
- **Evidence:** `C/backup-restore-numbers.md`.
- **Root cause:** polling intervals and a discard delay.
- **Proposed fix:** push the result, shorten the discard delay.
- **Acceptance test:** verify operation time is under 2 times the engine run.

#### VC-138 [P3] The CLI cannot drive restore runbook or a drill apply with an API key, and the reference does not say so; logical backup and expire have no Control Plane path

- **Area:** `apps/cli`, `15-cli/reference.md`
- **Block:** C
- **Reproduction:** run `restore runbook` and a drill apply with an API key; run `backup run --kind logical` and `backup expire`.
- **Expected:** a clear refusal and documentation.
- **Actual:** `PERMISSION_DENIED` generic text with `SCOPE_NOT_DELEGABLE` (human only); the reference lists `restore.plan` for the runbook without saying human only; `backup run --kind logical` is denied and expire has no route. In S2's run the drills were applied through REST with the owner session.
- **Evidence:** `C/backup-restore.md` §3, §10.
- **Root cause:** human-only actions are not marked in the CLI reference.
- **Proposed fix:** mark human-only commands in the reference and in `--help`; decide whether drills can be driven from a headless CLI.
- **Acceptance test:** the reference lists the human-only commands.

#### VC-139 [P3] S3 adoption refuses endpoint hosts under .test, .local, .internal, .example and .invalid with an unexplained VALIDATION_FAILED, and allows no port or http

- **Area:** S3 repository adoption
- **Block:** C
- **Reproduction:** adopt a repository with an S3 endpoint such as `s3.lab.internal`.
- **Expected:** a named reason; lab and private endpoints possible.
- **Actual:** `VALIDATION_FAILED` without a reason; no port, no `http`, so lab or private S3 endpoints cannot be adopted or put into the runbook.
- **Evidence:** `C/backup-restore.md` §7.
- **Root cause:** hostname validation without a message.
- **Proposed fix:** name the rule in the error and document the allowed forms.
- **Acceptance test:** the refusal names the rule.

#### VC-140 [P3] A second recovery by the same RB-10 text fails: the temporary superuser restore_admin persists in the restored store

- **Area:** `control-store-runbook.md:106-110`
- **Block:** C
- **Reproduction:** restore once with `restore_admin`, `pg_dumpall` the restored store, lose it, restore again with `restore_admin` (`20-rb10-restore.sh` without `SUPER`).
- **Expected:** the text works every time.
- **Actual:** `ERROR: role "restore_admin" already exists` at step 3 (`ON_ERROR_STOP`), leaving a half-restored server to discard.
- **Evidence:** `C/control-store-loss/README.md` §3; log `loss-20-rb10-a-failed-first-attempt.out`.
- **Root cause:** the scratch resource becomes production and keeps its superuser.
- **Proposed fix:** a fresh name per recovery plus a step to drop or rename it.
- **Acceptance test:** two consecutive RB-10 restores in the lab succeed with the text as written.

#### VC-141 [P3] `plan apply --yes --json` waits silently for a step-up (no address, no code)

- **Area:** `apps/cli` `plan apply`
- **Block:** C
- **Reproduction:** `exdb_json plan apply <production ledger.reconcile plan> --no-wait --yes` (the first attempt of `30-prod-cycle.sh reconcile` hung 7 minutes).
- **Expected:** an error with the step-up id, or the address on stderr, as the text mode prints.
- **Actual:** no output until the step-up expires.
- **Evidence:** log `loss-30-reconcile.out`.
- **Root cause:** not examined.
- **Proposed fix:** as Expected, plus a `--timeout-wait` covering the step-up wait.
- **Acceptance test:** `plan apply --json` on a plan with a `reauth` requirement exits non-zero within 5 s with the step-up id.

#### VC-142 [P3] RB-10 step 3 says the exported checkpoints show the size of the lost gap; hourly checkpoints cannot

- **Area:** `control-store-runbook.md:114-120`, `worker-tasks.ts:194-199`
- **Block:** C
- **Reproduction:** `20-rb10-restore.sh` steps 7 and 8.
- **Expected:** the gap is sized from the checkpoints.
- **Actual:** `audit.checkpoint` runs every 3,600 s; the only exported checkpoint was seq 1 while the store held 571 events. `audit verify --from-checkpoint 1` passed.
- **Evidence:** `C/control-store-loss/README.md` §3.
- **Root cause:** cadence versus wording.
- **Proposed fix:** state the cadence in RB-10, or export a checkpoint per N events.
- **Acceptance test:** a doc check that RB-10 names the checkpoint interval and the resulting gap granularity.

#### VC-143 [P3] A restored awaiting_approval operation for a change that is already live is offered for approval

- **Area:** approvals list and page, `operations-engine.md`
- **Block:** C
- **Reproduction:** `00-prepare.sh`, RB-10, then `exdb approval list` and `human approve <op>`.
- **Expected:** it is recognised as applied or withdrawn.
- **Actual:** listed with an "Approve at" link although the production ledger holds the row; approving ends `failed / PLAN_STALE` (safe, nothing re-applied), with no explanation.
- **Evidence:** log `loss-v15-prod-approve.out`.
- **Root cause:** the store cannot know what happened after the dump.
- **Proposed fix:** an RB-10 step to cancel `awaiting_approval` operations older than the dump after the reconcile; show the binding state on the approval page.
- **Acceptance test:** after the documented step the approvals list is empty.

#### VC-144 [P3] Session cancel and terminate without an operator credential answer "credential needs rotation or repair"

- **Area:** `packages/diagnostics/src/connections.ts` (lines 225-228, 493-496)
- **Block:** D
- **Reproduction:** the stack has no `exponetdb_operator` credential; the owner POSTs `/targets/{id}/sessions/{pid}/cancel` or `/terminate` with a valid body.
- **Expected:** a code that says no operator credential is registered.
- **Actual:** 503 `TARGET_CREDENTIAL_INVALID` "needs rotation or repair"; this also hides the authorization decision of the allowed classes on the lab.
- **Evidence:** `D/security/authz-run.md` (residue list).
- **Root cause:** a missing credential is mapped to `TARGET_CREDENTIAL_INVALID` in both places.
- **Proposed fix:** a distinct code and message; register an operator credential in the lab bootstrap.
- **Acceptance test:** cancel on a cluster without the credential returns the new code.

#### VC-145 [P3] Lint allows server-file functions and untrusted-language functions; only database privileges stop them

- **Area:** `packages/migrations-engine` lint (`forbidden_statement`)
- **Block:** D
- **Reproduction:** `D/security/scripts/containment.sh` cases 03, 04 and 18: the plan decision is `allow` (warnings only); the apply ends `MIGRATION_EXECUTION_FAILED`, `not_applied` (the migrator lacks `pg_read_server_files`, superuser and the language). The other 15 host-reaching cases are `forbidden_statement` at plan time and audited.
- **Expected:** refused at plan time with a clear, audited reason; the failed operation shows the database reason class.
- **Actual:** contained only by the role's privileges; the operation view carries the code only. For a Supabase-origin schema whose migrator role is more privileged, the same bundle would run.
- **Evidence:** `D/security/containment.md`.
- **Root cause:** the forbidden list is by statement kind, not by called function or language.
- **Proposed fix:** forbid `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`, `lo_import`, `lo_export` and untrusted languages in lint.
- **Acceptance test:** a lint test per name.

#### VC-146 [P3] The observer role cannot read schemas of the managed scope; scratch-check says ready and the analysis returns seven expectations_unreadable items that look like ambiguity

- **Area:** `migration import scratch-check`, analysis
- **Block:** B
- **Reproduction:** scope `public, auth, storage, app_private`, the observer without USAGE on the last three: scratch-check ready; analysis: 23 ambiguous; after `GRANT USAGE ... TO exponetdb_observer` and a new analysis (21.6 s each): 16.
- **Expected:** a preflight line for the observer's visibility of the scope.
- **Actual:** only the decision-dialog text mentions the remedy.
- **Evidence:** `B/rehearsal/NOTES.md`; `B/rehearsal/README.md` §2.
- **Root cause:** scratch-check tests the scratch target and the execution role, not the imported target's observer.
- **Proposed fix:** an `observer_visibility` check listing schemas of the scope the observer cannot use.
- **Acceptance test:** with USAGE missing, scratch-check fails that check naming the three schemas.

#### VC-147 [P3] Refusal texts that name no id and no remedy

- **Area:** CLI errors `TARGET_REGISTRATION_REFUSED`, `cluster endpoint retire --reason`, `LEDGER_DIVERGENCE`, `PLAN_STALE`
- **Block:** B
- **Reproduction:** register a clone (`steps/26`); `exdb cluster endpoint retire <c> <e> --reason "primary lost"` (`steps/30`); `traps_swap2.sh`.
- **Expected:** cause, ids and remedy (the error catalog's promise).
- **Actual:** `other_target` without the other target's id (REST has only `details.reason`); the retire reason must match `^[a-z][a-z0-9_]{0,63}$` and a sentence gets a contract error quoting the pattern; `LEDGER_DIVERGENCE` and `PLAN_STALE` as in the other findings. Registering a clone after dropping its `exponetdb` schema works, but no text says so.
- **Evidence:** `B/rehearsal/results/traps-clone.txt`; `steps/25-28`, `steps/30`.
- **Root cause:** details are kept as machine reasons.
- **Proposed fix:** include the other target's id or path (when readable) and the documented next step; one reason format for all `--reason` flags.
- **Acceptance test:** a golden test of the CLI text for each code contains an id and a next step.

#### VC-148 [P3] `schema diff` prints columns, constraints and triggers without their table

- **Area:** CLI `schema diff` renderer
- **Block:** B
- **Reproduction:** `exdb schema diff lab/platform/rhrep lab/platform/rhstg` (`B/rehearsal/results/i10-replay-schema-diff.txt`).
- **Expected:** `public.crm_items.hotfix_note`.
- **Actual:** `+ column public.hotfix_note`, `- column public.id`, `- column public.token`, `- constraint public.legacy_sessions_pkey`; with 300 tables a row cannot be attributed (the JSON has `parent`).
- **Evidence:** `B/rehearsal/results/i10-replay-schema-diff.txt`.
- **Root cause:** the renderer prints `schema.name` only.
- **Proposed fix:** print `schema.parent.name` when `parent` is set.
- **Acceptance test:** a renderer test with a column name present in two tables shows both parents.

#### VC-149 [P3] An established gateway session is never re-checked against the certificate's end, and a refused node leaves one info log line

- **Area:** `apps/server/src/interfaces/gateway/agent-listener.ts`, `packages/nodes/src/gateway.ts:265,497`, RB-13
- **Block:** C
- **Reproduction:** `C/stack/scripts/kt0-faketime-setup.sh`, `kt-gw.sh`, `kt-gw2.sh`, `kt-rb13.sh` (libfaketime on the gateway only; the agent is a Go binary and ignores `LD_PRELOAD`; the VM clock was not touched).
- **Expected:** an expired certificate is refused and the operator is told why (`enrollment.md`, RB-13).
- **Actual:** with the gateway clock +125 h the connected node stayed active, heartbeated every 15 s and received another certificate (expiry is judged at the handshake only). A new handshake at +200 h is refused with `403 NODE_CERTIFICATE_REFUSED: The client certificate is not the node's current certificate, or the node's state does not allow the request.` (the same text for expired, replaced and revoked). The node reads `offline` after 60 s. The only server-side trace is `info agent.refused` (7 lines for 7 attempts): no audit event, finding or metric; `exponetdb-node status` on the host still says "in 2d23h". Back at real gateway time the node healed itself in about 90 s. RB-13 works: 37 s, 8 scripted actions, a new node active 18 s after the start. During renewal the node row flapped offline and active for about a minute.
- **Evidence:** `C/stack/keys-certs-time-results.md` step 5; logs `ktgw.out`, `ktgw2.out`, `ktrb13.out`.
- **Root cause:** TLS verification once per connection; the application-level check compares fingerprints, not validity; refusals are logged at info.
- **Proposed fix:** check `notAfter` per request; log `agent.refused` at warn with node id and reason (`expired`, `superseded`, `revoked`); count refusals in a metric.
- **Acceptance test:** a node past its certificate end is refused on an open session at its next request, with `reason=expired` in a warn log and a metric increment.

#### VC-150 [P3] The audit export failure never says why

- **Area:** `packages/audit/src/checkpoints.ts:96-100`, worker task `audit.export`
- **Block:** C
- **Reproduction:** `C/stack/scripts/afc-export.sh`: `chmod 000` on the export directory; S3 (versitygw) stopped, then restarted without its bucket.
- **Expected:** a log line naming the sink and the cause.
- **Actual:** the signals are right (task failed, worker `degraded` 200 with `audit_export_failing`, metric `outcome="failed"`, installation health `export_failing`, mutations still 200, recovery 25 s after the fix), but the only log is `audit.checkpoint_export_failed seq=372 count=0`. After S3 came back without its bucket the export stayed failing and nothing says `NoSuchBucket`.
- **Evidence:** `C/stack/observability-results.md` step 6; log `afc.out`.
- **Root cause:** `catch { return {exported, failed: seq} }` drops the error.
- **Proposed fix:** log the error class and message (no secrets) and the sink kind.
- **Acceptance test:** an export to a missing bucket logs `cause=NoSuchBucket sink=s3`.

#### VC-151 [P3] Target TLS failures share one class, and a serve clock behind the certificates makes every target unreachable without naming the clock

- **Area:** `packages/postgres/src/errors.ts`, diagnostics health reducer, clock handling
- **Block:** C
- **Reproduction:** `C/stack/scripts/fc9-target-tls.sh` (lab-CA certificates: expired, other name, 5 days left) and `kt1-serve-clock.sh` (serve at -2 h).
- **Expected:** classes `tls_expired`, hostname, untrusted CA; `tls_expiring` at 30 and 7 days (`health.md:121`).
- **Actual:** expired and wrong-name both give `unreachable`, probes `failed:target_tls_failed`, `migration plan` gives `TARGET_TLS_FAILED` (once `TARGET_UNAVAILABLE` on the second try), no finding, no worker log. The 5-day certificate is healthy with no condition. With serve 2 h behind, every plan fails `TARGET_TLS_FAILED` (fresh certificates are "not yet valid") with no hint of the clock.
- **Evidence:** `C/stack/fail-closed-results.md` step 9; `C/stack/keys-certs-time-results.md` steps 6 and 11; logs `fc9.out`, `kt1.out`.
- **Root cause:** one class for all TLS verify errors; no skew self-check.
- **Proposed fix:** keep the verify reason code in the probe; produce `tls_expiring`; add the process-versus-database clock-skew check.
- **Acceptance test:** an expired certificate shows `tlsReason=expired`; a serve clock 10 minutes off the database turns readiness degraded with `clock_skew`.


## 5. Suggested order of work

Several pull requests, one per group, in this order; commit per finding (or per tight group) so
the owner can review and revert pieces. Stop and ask (open decision) where a finding says "owner
decision". The order follows Wave 11's question ("can REOSA's production database be managed
without surprises?"): first what can take the whole installation down or make a recovery lie,
then the runbooks, then the planner's honesty.

1. **Group A: installation wedges and the two P0-borderline items.** The Control Store disk
   (audit and quota for bundle ingest, a purge path, a disk component in installation health, the
   `ENOSPC` runbook), the allowlisted read that crashes the target PostgreSQL (size-argument
   rules, a memory fact in the registry) together with the data read that never returns when its
   backend dies (hard deadline, never await `close()` on a dead client), the audit chain that
   refuses every event after a clock step (readiness, typed error, skew guard, repair
   operation).
2. **Group B: the engine's dead ends.** `operation close` / `operation.force_release`
   (human only, audited, never re-executes), the close that runs before its own checks, the
   reconcile of an unknown outcome, the claim loop that lets one blocked operation starve all
   others, the approval that is accepted after the plan expired, the old role that keeps
   claiming after `migrate`.
3. **Group C: backup and restore truth.** The drill that passes with data missing (replay end,
   a mandatory data check), `backup.verify` and WAL gaps, the restic globals, the space check at
   execute, helper refusals that surface as `OUTCOME_UNKNOWN`, the missing `pitr_random`
   observation.
4. **Group D: upgrade and recovery runbooks.** Rewrite `upgrades.md` (roll forward or restore,
   a mandatory verified dump, the eleven omitted steps, `schema_newer` with a remedy, a drain
   window for the worker), RB-10 step 6 as a per-target loop, RB-14 (custody of the keyring or an
   audited reset), the second RB-10 recovery, the checkpoint cadence.
5. **Group E: hostile input and containment.** Named limits and caps for nesting depth, statements
   and tokens per request, per-request memory, the second quadratic regular expression, the 32 MiB
   body read before authorization, connection and in-flight caps, forbidding server-file and
   untrusted-language functions in lint.
6. **Group F: the planner's honesty.** `serial`/identity in the parser (the CREATE TABLE that cannot
   be applied and the ADD COLUMN rewrite classified as brief), catalog facts for the lock and
   rewrite classes (`provolatile`, column types, validated CHECKs, `USING INDEX`, dependent
   views, lock held to COMMIT), `DETACH PARTITION CONCURRENTLY`, the per-finding lint
   acknowledgement (owner decision), the project settings that have no server-side home.
7. **Group G: evidence, ledger and drift integrity.** Evidence by operation id alone, the mirror
   guard, `generation`, the periodic ledger watch with a finding, the drift baseline after a
   part-way plan, the clone and standby and foreign-endpoint traps, the database move.
8. **Group H: errors, signals and tests.** 500 INTERNAL that should be typed (`BACKUP_REQUIRED`,
   Control Store errors, `TARGET_SQL_ERROR`, `AUDIT_*`), the `/unmatched` metrics route and the
   missing operational metrics, certificate and TLS signals, clock skew check, retention
   pruning, then the CI and test findings (branch protection, the three checks missing from CI,
   order-dependent tests, the regression guards for TC-049/050/054, the flaky host test).
9. **Group I: the 75 findings of the first campaign that are still open** (28 NOT FIXED, 11
   PARTIAL, 7 by decision): see `R/verdicts.md`; their text is in
   `2026-10-27-test-campaign-fixes.md` and is not repeated here.
10. **Docs and gates last:** `PRE-WAVE-11-REVIEW.md` (new section), `gates/*.md`,
    `acceptance-gates.md`, `test-strategy.md`, `open-decisions.md`.

### Owner decisions this campaign needs (do not decide them silently)

Each is described in the `F/decisions-*.md` file named in brackets.

- **P0 or P1?** A holder of `migrations.plan` can kill the Control Store with about six unaudited
  requests (`decisions-S6`), and one allowlisted read can restart the target PostgreSQL
  (`decisions-D2`). Count them as outages (P0) or accept the residual risk after the fixes.
- **OD-64 and the approval window** (`decisions-S4`, `decisions-R2`): how long may an operation wait
  for approval, and may an approval after the plan expired start it at all?
- **Closing a stuck operation** (`decisions-D0` D0-01, `decisions-B1`): approval and re-authentication for
  `migration.verify` that names a stuck operation on production; `operation.force_release` or per-kind
  retry.
- **Project settings home** (`decisions-B1` D-1): registry record or repository file, and what a lowered lint
  rule means on production.
- **Lint false positives** (`decisions-B3`, `decisions-S5` D1): a per-finding acknowledgement with a reason, or catalog
  facts that make the rules precise; and whether a bundle verified on staging may be lint-blocked at production.
- **The upgrade contract** (`decisions-S3`, `decisions-B1`): roll forward or restore only, or additive-compatible starts
  (an ADR); keyring custody or an audited reset.
- **Wave 11 prerequisites** (`decisions-S5` D6): destructive production bundles need a product-managed verified backup
  (node agent, adopted pgBackRest repository on `reos-db-01`; the storage part of OD-4 is open), or break-glass
  once OD-21 is decided.
- **Drills and data checks** (`decisions-S2`, OD-60): a drill carries a data check before `passed`.
- **Certificate and clock policy** (`decisions-C1`, `decisions-S6`, OD-62): warning thresholds, enforcing expiry on open
  gateway sessions, whether the audit chain tolerates or clamps clock skew.
- **E16/E18 waivers and G10.3** (OD-65, OD-66) and **step-up for enrollment** (OD-67): unchanged from the fix
  session; the staging import counts as real REOSA data or not.
- **Self-approval and CLI grants on production** (`decisions-S4`): a person with a production binding applies a verified
  production migration with no approval and no fresh proof when no rule fires; OD-9 lets the applying person approve.

### Things for the owner to look at now (not work for the fix session)

- The live node's certificate renewed itself on 2026-10-29 (new expiry 2026-11-01 05:52 UTC; read only,
  `D/ops/node-cert-watch.sh`). The warning for a missing renewal is still not built (OD-62).
- `main` has no branch protection and no required checks, and CI of commits on `main` is cancelled by the next
  push (`F/findings-A.md`). The commit after the fix (#47) failed the `node-pg` job once on a test race.
- The fix pull request was merged although its description said "Not merged, not deployed"; nothing of it is
  deployed. Do not deploy before the upgrade group is done: the documented rollback does not work.


## 6. What could not be run, and why

"NOT RUN" is an answer only with its reason and what it would take. Rows come from the lead and from
every tester's "not checked" list.

| Item | Reason | What it would take |
|---|---|---|
| SSRF through client-metadata-document, client registration and webhook URLs, redirects, DNS rebinding, TLS downgrade at the OAuth edge, a wrong CA (Block D "Network") | a safety classifier stopped the tester S4 after the hostile-input cases; the lead did not push around the stop. S7 reviewed the code and tested the validators as pure functions instead (`D/security/network-review.md`, if it landed) | a dedicated session with the owner's confirmation that these tests are wanted, on the disposable stack |
| Promotion attacks: alias swap, applied-but-not-verified evidence, verified-then-restored evidence target, concurrent uploads of one id | S4 ran out of its budget before them; S7 took part of them (`D/security/promotion-leftovers.md`) | the stack of `D/infra` and a second person for the approval cases |
| Product-managed backup, drills and a node agent inside the dress rehearsal; reconcile and PITR on a production-tier target | the rehearsal stack had no node agent; plain `pg_basebackup` + WAL archive was used (S2 covered the product path at 7.6 GB on another stack) | one stack with agent, adopted pgBackRest repository and a production-tier target |
| PostgreSQL 16 and 18 repeats of the backup, restore and drill numbers; the product-reported achievable RPO | the lab image has PostgreSQL 17 only; posix repositories are never counted off-host | an S3 pgBackRest repository and the other two majors in the lab image |
| A 7.7 GB restic restore from S3; Control Plane-level checks of the deleted-stop-segment case; applying a drill from the CLI | time; a drill apply needs a browser re-authentication | an hour and an owner browser |
| Under-load numbers of the DDL hazard matrix on 10 million rows and on PostgreSQL 16 and 18 | the 3 hour run was written (`B/ddl-hazard/pgbench/run.sh`) and dry-run at 100k rows only | `PG_VERSION=17 ROWS=10000000 ./run.sh` on a disposable server, per major |
| Web App: 1440/768/390 px screenshots in light and dark, keyboard and screen reader pass, the list at 10,000 rows | no passkey browser session on the stack; the screen-reader pass needs a person with assistive technology (S7 ran an automated axe pass if it could, see `C/ui/web-a11y.md`) | a Playwright matrix in CI and one hour of a person with a screen reader |
| Real-browser reproductions of TC-035 and TC-038 at 390 px; Chromium measurements for TC-066 and TC-067 | unit and code level only | the same Playwright matrix |
| Host scenarios for TC-069, TC-070 (agent half), TC-071 (GAP-08/10/12), TC-072 and TC-075 (clock change, reboot, disk-full on the agent state) | need a systemd host with a clock change and a reboot; the node agent's own clock cannot be moved with libfaketime (a Go binary) | a disposable VM where the clock may be stepped (and never the Control Store's: see the clock finding) |
| The 4 hour approval window itself | the Control Store refuses to age an operation row | a test hook or a real 4 hour wait |
| 5,000 bundles in one project; concurrent applies at scale; 1,000 distinct MCP grants; `audit verify` speed on a long valid chain | time and size: 800 chained bundles already take 61 s to lint; the synthetic audit rows broke the chain | the lint fix first, then the run |
| Non-transactional variants: redeploy during a non-transactional apply, disk-full on a non-transactional apply (the data statement is refused by lint), Control Store WAL-full beyond the PANIC | the plan is denied by lint or the volume setup was not isolated | a bundle shaped for each case and a separate WAL volume |
| A node job that was dispatched and then vanished; the agent's clock guard | no way to drop a dispatched job without touching the agent binary | an agent test hook |
| Traefik and Docker health effects, the kernel kill of serve at 512 MiB | the stack used systemd without a cgroup limit | containers with the production limits (deployment.md §2a) |
| A backup catalog entry and a pgBackRest chain inside the upgrade rehearsal; the Web App session after a restore; owner recovery codes after keyring loss; loss of the Coolify project together with the store | outside what one agent could build in the budget | a longer rehearsal on the owner's deployment layout |
| `mcp:evals` model layers B to D | needs `EXDB_EVAL_ANTHROPIC_API_KEY` of the owner (14 tests report NOT RUN by design) | the owner's key; about 20 minutes and token cost |
| Cross-browser (Firefox, Safari) and Lighthouse; `tr_TR.UTF-8` locale for the determinism test | not installed; the Turkish case rules were forced by patching `toLowerCase` | a Playwright matrix; `locale-gen tr_TR.UTF-8` |
| The plan hash on four runtimes at engine level (only the library level was compared on Node 24.22.1, Bun 1.4.4, Node 26.5.0, Bun 1.3.14) | the engine needs the pinned toolchain; the plan hash holds `id` and `createdAt` by design (B2-D1) | decide what invariant I1 means first |
| Anything against the live installation beyond three side-effect-free reads (`auth status`, `node list`, `node show`, to confirm the certificate renewal) | the brief forbids plans, advisors and applies there; no other read was needed | n/a |


## 7. Rules for this fix session (they override anything you infer)

These come from the campaign brief (§1) and from `CLAUDE.md`; where they differ,
`CLAUDE.md` and the constitution win.

- Work in the repository `/home/david/Development/ExponetDB`. Start from the latest
  `origin/main` (`git fetch origin --prune`; the campaign tested `d51da5d0`, and `main` has
  moved on, for example #47). Create **your own worktree and branch**
  (`git worktree add ../ExponetDB-verification-fixes -b fix/verification-campaign-2026-10-28 origin/main`);
  never work in the main checkout and never reuse another session's worktree. Split the
  work into **several pull requests** along the groups of section 5 (the first campaign's
  single pull request of 34 commits was hard to review); each group is one branch.
- **Commits** are authored as `𝕏0L0™ <davdxpx@gmail.com>`
  (`git -c user.name='𝕏0L0™' -c user.email='davdxpx@gmail.com' commit …`). Claude is
  never the author or co-author: **no** `Co-Authored-By` trailer, **no** session
  link, **no** "Generated with" line. At the end of a commit body or the pull request
  description at most `Developed by @davdxpx`. Conventional Commits
  (`fix:`, `feat:`, `docs:`, `test:`), atomic: code, tests and docs of one
  fix in one commit. Commit and push after every finding; no "commit later".
- **Tests first for every fix** (red, then green) and **prove the red**: run the new test
  against the unfixed source and keep the failing assertion in the commit body. A regression
  test that passes on the old code is a finding of this campaign's kind (VACUOUS TEST).
  Never skip, disable, quarantine or weaken a test to get green; never raise a timeout to
  get green. Tests that need PostgreSQL run against real PostgreSQL
  (`bun run dev:control-store`, `bun run dev:targets`; use your own container names and
  ports, other sessions share the machine).
- **Run the verification on the pinned toolchain** (Node 24.22.1, Bun 1.4.4, Go 1.26.10,
  Ubuntu 24.04, UTC, `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04`); `bun run toolchain` must pass.
  A local machine outside `engines` gives wrong verdicts (the first campaign lost time to that).
  `D/infra/bootstrap.sh` in the evidence folder builds a disposable replica (a `cx33` is enough).
- **Do not merge and do not redeploy.** The owner does both on request. Do not
  change Coolify settings or environment variables, do not touch the live
  installation `https://db.exponet.cloud` (reads only, and only if a finding's
  acceptance test says so), never apply anything to `reosa/platform/staging`
  or `reosa/platform/scratch`, never touch Supabase (REOSA production is out of scope),
  never change the REOSA repository, never touch `reos-db-01`. A redeploy is the
  riskiest operation the owner does: nothing in this fix session may be a reason to
  redeploy before the upgrade findings (section 4, the upgrade and recovery group) are closed.
- **Frozen things stay frozen**: `c1`, `ls1`, `fp1`, plan-hash construction,
  golden vectors (append-only), and every frozen Control Store bundle. A
  change of stored behavior is a new, additive bundle (and the next free ADR
  number if a decision is needed). `bun run golden:check` and
  `bun run golden:history origin/main` must stay green. **New Control Store bundles
  are pinned in `frozen-bundles.json` and `immutable-bundles.test.ts` as soon as they are
  merged and deployed** (24 of 45 are not pinned today).
- **Documentation first**: every behavior change updates its document in the
  same commit. **Update the gate and review documents you touch**:
  `exponetdb-docs/14-roadmap/PRE-WAVE-11-REVIEW.md` (add a section
  `## Verification campaign fixes – Parallel Session`, never edit another session's
  section), the gate records, `acceptance-gates.md` where a criterion's evidence
  changed, and `exponetdb-docs/00-product/open-decisions.md` for every open
  owner question (never decide an owner question silently; use the
  existing OD numbers or add the next free one).
- **Secrets**: never print, log, commit or store a secret, token, password,
  verifier or connection string with a password. Fixtures use obviously fake
  values. The repository is public: no raw dumps of the live installation, no IP
  addresses of real servers, no e-mail addresses, no raw logs in a pull request.
- **Scope**: fix what a finding says, in the smallest correct change, and
  nothing else. Findings marked *owner decision* get the decision recorded as
  an open decision with the options and your recommendation, and get no silent
  implementation. If a finding turns out to be wrong, say so with evidence in
  the finding's row of the pull request description and the review document; do not
  "fix" it anyway.
- **Verification before each pull request**: `bun run verify` (all parts), plus the
  finding-specific acceptance tests, plus `bun run go:test`, and for the node agent
  the host scenarios on a disposable systemd host (not on `reos-db-01`). Report
  what you could not run.
- **Do not start another campaign from inside the fix session.** If a finding's
  acceptance test needs a stack, use `D/infra/stack-up.sh` of the evidence folder.
- English (US spelling) for code, identifiers, documentation and commit messages.
