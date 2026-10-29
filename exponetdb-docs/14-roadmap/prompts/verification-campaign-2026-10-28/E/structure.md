# E2: structure and systems review (block E, items 1 to 5)

| | |
|---|---|
| Author | tester E2 (synthesis; no new runs. Four code facts were read by E2 and are marked **(E2 read)**) |
| Tree under test | `d51da5d0` (merge of fix PR #46), read only |
| Status | **Final for the evidence of 2026-10-30.** Parts that wait for tester S7 (SSRF review, promotion leftovers, CLI sweep, Web accessibility) are marked **pending S7**; nothing else is pending. |
| Companion | `E/proposals.md` (what is missing, each `[OPEN]`), `F/e2-notes.md` |
| Finding ids | `VC-nnn` of `../2026-10-28-verification-fixes.md` (section 3 "Index", 151 findings: P0 0, P1 17, P2 62, P3 72). `DF-nn` = `B/contract.md` §3, `DC-nnn` = `E/docs-claims.md`, `R-n` = `E/recoverability.md`, `I-n` = invariants of `B/invariants-matrix.md`, `C-n` = constitution articles. |

## 0. Evidence base

Block B: `B/contract.md`, `B/invariants-matrix.md`, `B/conformance/RESULTS.md` (817 cases, 48 fail), `B/ddl-hazard-matrix.md`, `B/failure/RESULTS.md` (S1, stack), `B/rehearsal/README.md` (S5, dress rehearsal). Block C: `C/backup-restore.md` and `C/backup-restore-numbers.md` (S2), `C/upgrade/README.md` and `C/control-store-loss/README.md` (S3), `C/stack/README.md` (S6). Block D: `D/new-bundles-security-review.md`, `D/authz/*`, `D/security/*` (S4). Block E: `E/{state-machines,vocabulary,errors,docs-claims,recoverability}.md`. Block R: `R/verdicts.md`. Block A: `A/README.md`. Product: constitution, `01-architecture/{overview,failure-model}.md`, `02-control-plane/operations-engine.md`, `04-migrations/README.md`.

## 1. Verdict

**What holds, on a stack and not only in unit tests.** No P0 and no way to change production without the gates was found. The data path is sound: 47 hostile cases on the stack end atomically or refused (I4: 0 fail), the truth ladder holds (I6: no sample says `succeeded` before `passed`), 9 of 10 out-of-band change classes stay open as drift after unrelated migrations (I7), two writers are serialised (I8, 5 of 5), and 31 failure-injection cells never re-executed a statement (`B/failure/RESULTS.md`). Roughly 136 canary secrets did not leak into 15 sinks, and 3,377 authorization requests produced no bypass (`D/security/README.md`). The dress rehearsal on a 4.4 GB, 306-table database ran import, baseline, plan, apply under load, drift, point-in-time restore, reconcile and promotion end to end; the refusals that matter held (`B/rehearsal/README.md`). All 18 CI jobs passed on the commit (`A/README.md`). The content contract of a bundle (c1, DAG, limits at the boundary) is the best-tested part of the product (I2 91 of 91, I5 810 generated cases, one disagreement: VC-091).

**What is wrong is operability around that sound core**, and it is structural: 17 P1 findings fall into five groups. (1) Installation wedges: a full Control Store disk is a PostgreSQL PANIC reachable with five unaudited requests (VC-001), a clock step leaves the audit chain refusing every event for as long as the skew lasts (VC-003), the keyring cannot be recovered (VC-011), one allowlisted read restarts the target PostgreSQL (VC-002) and one read never returns (VC-012). (2) Dead ends: `needs_attention` has no exit and one parked operation starves every younger operation of the installation (VC-006, VC-007, VC-008). (3) A recovery that lies or does not exist: a drill passes while committed data is missing (VC-004, VC-005), the documented rollback of an upgrade dies in 0.3 s and the real one loses everything after the dump (VC-009, VC-010). (4) Hostile input freezes or kills `serve` (VC-013, VC-014, VC-015). (5) The planner is wrong in both directions (VC-016, VC-017).

**Can REOSA's production database be managed without surprises?** Not yet, but the blockers are bounded and cheap compared with what they protect: `E/proposals.md` P-01, P-02, P-03, P-05, P-06 and P-07 close the 17 P1s' structural causes. Nothing found suggests the design is wrong; the weaknesses are things the design does not yet say (who frees a lock, who owns configuration, how much work one request may cause, what a restore proof compares).

## 2. Ranked structural weaknesses

Ranked by what they do to the question "can the production database be managed without surprises", then by the cost of the fix. "Seen" is what an operator observes.

| Rank | Weakness | Seen by the operator | Cheapest structural fix | Proposal |
|---:|---|---|---|---|
| **SW-1** | **A stuck operation has no exit, holds the target's lock, and starves everyone.** Retry exists for 4 migration kinds, closing for 2; `operation.force_release` is unbuilt (VC-006, VC-007, VC-055, VC-122); the one existing close runs before its own checks (VC-044), mislabels (VC-050) and is class `low` on production; the claim loop re-claims the oldest waiter every tick (VC-008); a committed change with a lost reply parks as `unknown` for ever (VC-058). Reproduced on the stack for rollback, reconcile, accept and unknown (`B/failure/RESULTS.md` §2). | `retryable: false`, `OPERATION_NOT_RETRYABLE`, `OPERATION_NOT_CANCELABLE`. A plan on another target stayed `queued` for 73 s while the blocked one wrote 70 events in 72 s. The CLI recommends the refused command (VC-049). | One human-only, audited, re-authenticated `operation close` that frees the domains and never re-executes; a `blocked_until` on the claim. | P-01 |
| **SW-2** | **The Control Plane's own foundations are unmetered and unrepairable: disk, clock, keyring, self-observation.** Ingest is outside the audit gate and any quota; revisions cannot be purged (VC-001). The audit chain's monotonic guard is coupled to the database clock (VC-003, VC-040, VC-152). The keyring has no recovery (VC-011). The roles cannot tell they are sick: readiness stays `ready` with the audit gate failing (VC-042), store errors are 500 `INTERNAL` (VC-036), every route is `/unmatched` in metrics (VC-037), roles stay `not_ready` after the cause clears (VC-077). | PANIC and a container that will not restart; every audited mutation `INTERNAL` for 2 h 54 min while `/healthz/ready` says ready and reads work; a lost keyring means a new installation. | A Control Store volume component with quota and an audited purge; a readiness check on audit append, a typed `AUDIT_CLOCK_SKEW` and a repair operation; keyring custody in the runbook. | P-02 |
| **SW-3** | **The risk the approver reads is a parser guess.** The analyzer sees text only: no column types, volatility, CHECKs, view dependencies, activity; lock lifetime to COMMIT is not modelled; hold time is never estimated (VC-017, VC-028 to VC-034, VC-070, VC-097, VC-016). The only escape from a false positive lowers the rule project-wide (`F/decisions-B3.md`). | S5 apply under load at 300 tps: p99 6 ms before, **8.75 s during a 16.6 s window**, 48 % of the transactions in it above 1 s, while the plan said severity `high/critical`, allowed. `ADD COLUMN bigserial` rewrote the table under ACCESS EXCLUSIVE and was "brief"; an `ALTER COLUMN TYPE` read by two views failed `0A000` after three bundles had applied. | Catalog facts in the planner, a size-based hold-time estimate with `basis`, lock lifetime to COMMIT, the serial/identity parser fix. | P-03 |
| **SW-4** | **Project configuration has no server-side home, and the identity function takes an input from the client** (`defaults`, lint overrides, profile, invariants, bundle list): VC-020, VC-021, VC-024, VC-085; S5-D1 (a bundle verified on staging can be lint-blocked at production, one hazardous bundle blocks every later one of the chain). | Editing `defaults.lockTimeout` refuses every default plan with a non-overridable `MIGRATION_CHECKSUM_MISMATCH`; 51 bundle directories cannot use the default `migration plan`; whoever plans lowers the production rules. | Settings in the versioned registry project record, changed by a planned operation; the request copy refused. | P-04 |
| **SW-5** | **Bounds are per unit, not per request or per process; the analysis runs in the internet-facing role inside a transaction; the target side has no memory bound.** VC-013, VC-014, VC-015, VC-025, VC-046, VC-068, VC-078, VC-123; on the target VC-002, VC-012, VC-047. | `serve` blocked 38 s by 160 KB of comments; six valid bundles exit 134; two inputs under 1 MB cost 31 s and 620 MiB; one MCP client takes `serve` from 156 to 583 MB; an allowlisted `array_agg(repeat(...))` restarts the target PostgreSQL and drops a bystander session. | Nesting cap, comment counting, one budget per request, authorization before large bodies; later the worker lane. | P-05 |
| **SW-6** | **ExponetDB's own upgrade and Control Store loss have no safe way back.** VC-009, VC-010, VC-011, VC-052, VC-053, VC-063, VC-064, VC-065, VC-043, VC-141, VC-143. | S3: the documented rollback exits 3 `schema_newer` in 0.3 s; the real one (restore the dump, 7.0 s) loses everything after it and blocks every touched target (6 steps per nonprod target, 10 on production); the runbook omits 11 steps; an old role keeps claiming after `migrate`. | "Roll forward or restore"; a verified dump as a numbered step; `migrate --plan`; a one-page card. | P-06 |
| **SW-7** | **A restore proof compares nothing the user cares about.** A drill passes while committed rows are missing; `backup.verify` is blind to deleted WAL segments; the drill record has no recovery point or data check. VC-004, VC-005, VC-137, VC-059, VC-060, VC-061, VC-062. | S2 (7.6 GB): newest WAL segment deleted, verify `succeeded`, restore `succeeded`, drill `passed` with RTO 35 s and **12 committed rows missing**. The measured RTO itself is real. | Compute continuity from the segment list; a drill compares a recovery point with the source; the replay must reach the end of the last segment. | P-07 |
| **SW-8** | **The single-writer protocol and the ledger/mirror/evidence chain rest on convention.** Content can release the engine's lock (VC-026, VC-090); the worker can rewrite the mirror (VC-045); the evidence rule trusts an operation id on a hand-writable row (VC-079, static); `generation` never changes (VC-023); nothing watches divergence (VC-022); a never-mirrored production target is not blocked and its unknown row is adopted by the next apply (VC-063); identity is checked late and reported as health (VC-071, VC-072, VC-073, VC-074). | The first sign of a restored or edited ledger is `LEDGER_DIVERGENCE` at the next plan (S5: `target show` healthy, no finding); a clone behind the registered name is healthy and drift-clean. | Re-assert the lock after each statement; cross-check the mirror in the evidence rule; a 10-minute watch task; identity in health. | P-08 |
| **SW-9** | **Nothing mechanical ties documents, tests and CI to the code.** VC-018, VC-019, VC-081, VC-083, VC-119, VC-129 to VC-132, VC-103, VC-105; 17 of 72 sampled claims violated; 13 of 29 lifecycle differences "neither decides". | All 18 CI jobs pass while 48 of 817 conformance cases fail; `main` is unprotected and its CI is cancelled by the next push; the repository measures no coverage; 265 integration tests fail when their in-file order changes. | Required checks; exit-coverage, catalog and command guards; adopt the suites and the stack kit as a nightly lane. | P-10 |
| **SW-10** | **The bundle store has no lifecycle** (no list, ingest, withdraw, doctor; edits dropped; dangling `dependsOn` silent): VC-084, VC-088, VC-096, VC-125, VC-051, VC-027. | `migration status` lists never-applied ids as pending for ever; the documented repair of a broken `verify.sql` cannot be finished from the CLI. | A read-only doctor, `migration ingest`, a withdrawn marker later. | P-11 |
| **SW-11** | **The error, exit-code and vocabulary contracts are partial.** VC-048, VC-053, VC-066, VC-072, VC-115, VC-116, VC-120, VC-124, VC-148. | `PLAN_STALE` without the binding; 500 `INTERNAL` for an unmet backup requirement and a renamed database; 96 of 129 codes exit 1. | A generated "code, emitter, remedy, exit" table, tested both ways. | P-10 |
| **SW-12** | **The product has no first-class promotion, replay or release object**; the default flow submits everything. VC-021, VC-069, VC-087, DF-24, DF-25. | A plan that stops part-way leaves the drift baseline behind: 34 findings, 6 critical (VC-069). | `migration promote`; an ordered release run that halts on failure. | P-13 |

## 3. State machines (item 1)

Diagrams: `E/state-machines.md` (operations §1, plans §2, approvals §3, bundles §4, ledger §5, drift §6, smaller §7).

| Machine | Dead end | Two meanings | Unreachable / not shown | Evidence |
|---|---|---|---|---|
| Operations | `needs_attention` for every kind but 4 (retry) and 2 (closing plan) of about 60; `unknown` that was committed is never reconciled | `canceled` (rejected or cancelled); `verification_failed` (failed, or "closed by a recovery" with an outcome that never ran); `failed` (four causes, told apart by `errorCode`) | `operation.force_release`; the closer of a superseded operation | VC-006, VC-007, VC-050, VC-058; S1 I9 FAIL on the stack |
| Approvals | `awaiting_approval` never ends. **Reproduced:** an approval 15 minutes after the plan expired was accepted and the production change ran | waiting for an approver, or approved and cooling | the documented 4 h window | VC-057 |
| Claim queue (not in any diagram) | one blocked operation is re-claimed on every tick and starves the rest | | no `waiting_for` on the row | VC-008 |
| Plans | none | `active` past `expiresAt` until the sweep | none | `E/state-machines.md` §2 |
| Bundles | no state column; a revision cannot be retired or stored from the CLI | applied, verified, reverted are derived | the first single diagram is `B/contract.md` §1.1, assembled from eight documents | VC-051, VC-088 |
| Ledger / mirror | none; divergence found only by a plan | "target suspended" is not a state | `ledger.mirror_healed`; `generation` never changes | VC-022, VC-023 |
| Drift | `not_comparable` after a major upgrade (untested); baseline falls behind after a part-way plan | "baseline" = ledger origin or drift reference | which operation accepted a finding | VC-069, VC-124 |
| Smaller | restore `needs_attention` exits only by `discard` | stored `pending` past its time | step-up and token `expired`, restore `promoted`, break-glass activation | VC-118, VC-121 |

**Structural cause.** The edges are tables in the database (good). *Who may use an edge* is decided by per-kind predicates outside the table: `VERIFICATION_RETRY_KINDS` (`views.ts:270-275`), the claim predicate (`leases.ts:56-60`) and the optional `supersedes()`. Nothing derives "every non-terminal state has an exit for an authorised person, per kind" from the tables, so the dead end was invisible until drawn.

## 4. Vocabulary (item 2)

`E/vocabulary.md`: 17 rows, six where the wrong word can send an operator the wrong way: **apply** (`migration apply` re-plans; the plan reviewed with `migration plan` is not the one it runs), **verify** (two actions, two CLI names, the hint offers the refused one), **baseline** (ledger origin and drift reference), **reconcile** (four automatic meanings and one manual command), **recovery** (restore, closing plan, permission, account) and **exponetdb** (two programs). Filed as VC-124, VC-120, VC-049. The cause is four hand-linked registries (265 actions, 178 CLI commands, 30 MCP tools, Web message keys); the generated authorization matrix finds the drift (VC-112: six CLI commands declare scopes the API does not accept). S4's authorization run adds a practical consequence: the first-party CLI fails with `PERMISSION_DENIED` for everyone whose role binding is on an environment (VC-067). **pending S7:** the CLI sweep.

## 5. Errors (item 3)

129 codes, all documented with a cause; 38 have a `remediation`; 13 are never produced (VC-115); 69 at most carry no remedy (VC-116); 96 fall to exit 1; the CLI prints five detail keys, so `PLAN_STALE` does not name the binding (VC-048). Stack runs add the 500s: an unmet backup requirement on a production apply answers 500 and logs nothing (VC-066), a renamed database turns `migration plan` into `INTERNAL` (VC-072), a Control Store outage or full disk is 500 `INTERNAL` (VC-036), a clock step is `INTERNAL` with a request id (VC-003). Refusals that name no id and no remedy: VC-148, VC-126. **Cause:** the catalog is a list of names, not a contract with an emitter, a remedy and an exit per row.

## 6. The bundle system as a product

| Element | Explicit? | Evidence | Implicit or missing |
|---|---|---|---|
| Identity (c1, digests, ULID) | **Yes**, frozen, golden | I2 91/91 | Summary sentences looser than c1 (VC-085). **An input of the identity is outside the bundle** (VC-020). |
| Immutability | Yes, trigger on `bundle_revisions` | I13 | "Applied elsewhere" from the mirror only (VC-027); non-checksum edits dropped (VC-084, VC-096). |
| Order | Yes, tested to 5,000 nodes | I3 | Lint over a chain is cubic: S5 500 bundles, diamond shape 45 s (VC-025); plan capped at 50 (VC-021). |
| **Promotion** | **No object** | DF-24 | Evidence recomputed per plan (VC-079); S5: the chain held, a never-verified checksum and an altered bundle were refused; the "staging order" rule is unbuilt (DC-045). |
| **Replay** | **No** | DF-25; S5 I10 | S5 ran one by hand: 149 legacy files plus 12 bundles into an empty database in 8.9 s, every difference explained (+7 -7 ~6 of 4,260). The product has no command. |
| **Store lifecycle** | **No** | DF-05 | VC-088, VC-051, VC-125. |
| **Project settings home** | **No** | DF-14, DF-15 | VC-020, VC-024. |
| What the engine cannot express | Not stated | `B/ddl-hazard-matrix.md` | Batched backfill (B3-D1); `DETACH ... CONCURRENTLY` (VC-033); `CREATE TABLE ... serial` cannot be applied at all (VC-016); `CREATE PUBLICATION` makes a legacy analysis incomplete (VC-076). |
| Hotfix follow-up | Documented | DF-26 | Unbuilt (VC-087); break-glass cannot be activated (VC-118). |

**Verdict.** The content contract is explicit and tested; the lifecycle around it is not a contract: 13 of the 29 documented-versus-built differences are UNDEFINED or IMPLICIT (`B/contract.md` §3), among them exactly promotion, replay, store lifecycle, settings and generation.

## 7. Single-writer and lock model (the `needs_attention` domain)

| Layer | Object | Held until | Released by | Gap |
|---|---|---|---|---|
| A. Control Store domain | `operation_locks` (`target:<id>:schema`, `cluster:<id>:config\|backup`, ...) | a **terminal** transition (`transitions.ts:177-198`) | the terminal transition; for a stuck operation only a closing plan | no operator action for 58 of about 60 kinds (VC-006); no queue discipline (VC-008) |
| B. Target session lock | advisory `(1163412546, hash)` on the migrator session | session end | disconnect, keepalives about 60 s | `up.sql` can call `pg_advisory_unlock_all()` (VC-026); the 13-value guard does not read the lock (VC-090) |
| C. Fencing | marker `FOR SHARE`, ledger `SHARE`, 30 s lease | one transaction | COMMIT | evidence not re-read under the lock (DF-28); `checkOrder` unused (DF-29) |

S1 confirms the model works when nothing goes wrong: two applies, one wins and the other ends `PLAN_STALE`; an outside holder of the lock makes the apply end `MIGRATION_LOCK_TIMEOUT` and it runs after the release (I8, 5 of 5). What it lacks is a way out: when an operation parks, layer B is already gone and layer A is still held, so the target is unlocked while the Control Plane refuses everything for it, and the oldest waiter keeps the single claim slot (VC-008). The documents give the exit two meanings (VC-122): `concurrency.md:131` frees layer B (terminate the backend, mark `needs_reconciliation`), `operations-engine.md` §4.1 means layer A; built the first way it would not close the dead end. **Redeploy:** a SIGTERM during a 90 s apply ends `failed not_applied` after 26 s (exit 1) and the target session keeps its transaction until its statement ends; nothing re-ran (S1, S3; VC-043). **Fix:** one named release per layer: `operation close` for A, a post-statement lock assertion plus a denylist for B.

## 8. The Control Plane's own foundations (new)

| Dependency | What the stack showed | Finding |
|---|---|---|
| Control Store disk | 5 ingests with a `migrations.plan` token took free space from 296 MB to 53 MB, no audit event; the next write PANICked; rows cannot be deleted (append-only); growing the volume recovered it in 1.4 s + 2.4 s | VC-001 |
| Database clock | +3 h then back: the audit chain (`NEW.occurred_at < head_at`) refused every event for 2 h 54 min; login, plan, apply all 500; readiness `ready`; the store had to be rebuilt | VC-003, VC-040, VC-042, VC-152 |
| Keyring | lost: all roles refuse to start or stay `not_ready`; plan and login answer 500; restored in 12 s when the keyring returns; the documented recovery (RB-14) cannot be executed | VC-011 |
| Control Store as a restore target | `pg_dumpall` 556 ms; RB-10 as written = 6 steps = 11 operator actions, 8 s; works, but a second recovery by the same text fails (VC-141) and the checkpoint cadence cannot show the gap (VC-143) | VC-010 |
| Read-only store | `default_transaction_read_only = on` does not stop writes: every write transaction opens `READ WRITE` (`store.ts:158`, S6) | VC-077 |
| Self-observation | metrics route label `/unmatched`; no drill findings, no certificate signal (a target certificate with 5 days left is `healthy` with no finding); a killed role counts live for 45 s; the maintenance loop has no per-task deadline | VC-035, VC-037, VC-038, VC-039, VC-100 |

**Cause.** C-5 says the Control Plane must not depend on what it manages; the converse is untested: it depends on three things it does not manage, meter or repair (disk, clock, keyring), and its health model reports none. **Cheapest fix:** a Control Store volume component in installation health, a readiness check on audit append, and keyring custody in the runbook (P-02).

## 9. Trust boundaries

C-26 says content from the target is data; no inventory of such reads exists. This is the first.

| # | Value | Source | Decision it feeds | Finding |
|---|---|---|---|---|
| 1 | `application_name` | any role that can connect | immunity from cancel and terminate | VC-109 |
| 2 | ledger `operation_id` | target ledger row | evidence for production; mirror healing | VC-079 (static; **pending S7**: the forged-evidence run S4 did not start) |
| 3 | ledger events | target ledger | the operation `migration.resume` closes; a hand-written `nontx_started` blocks all plans | VC-106 |
| 4 | `reverted_at`, `fingerprint_after` | target ledger | outside the divergence comparison | `R/verdicts.md` TC-025 |
| 5 | database oid, system identifier, `pg_is_in_recovery` | target | health, plan, drift: a clone behind the name and a hot standby read healthy and plannable; a foreign instance behind a new endpoint suspends targets within seconds | VC-071, VC-073, VC-074 |
| 6 | node heartbeat absent | agent | `pendingRestart: false` shown as fact | VC-127 |
| 7 | `pgbackrest verify` `status: ok` | backup engine | "verified" | VC-005 |
| 8 | plan request: `defaults`, `lint`, `lintProfile`, `invariants` | whoever plans | the checksum; lowered rules | VC-020, VC-024 |
| 9 | `-- check:` names, lint messages | bundle | the approver's page and MCP `plan_get`, unmarked | VC-108 |
| 10 | worker as sole witness of outcome and mirror | Control Store role | outcome pairs; `UPDATE` of the mirror | VC-045, VC-102 |
| 11 | outbound fetches (client metadata, registration URLs) | internet | OAuth client trust | **pending S7** (network review; S4 did not run it) |

What held: the secret boundary (no canary leaked). The one leak found is the existence of subject ids to unauthorised callers, wider than D1 expected (VC-107). Proposals that read more from the target (P-03) add rows; each is advisory input to an estimate, labelled with source and time (C-28), never to authorization.

## 10. Resource containment

| Input | Bound that exists | Measured effect | Finding |
|---|---|---|---|
| nested comments, 160 KB | 4 MiB file, 200,000 tokens (comments free) | 38 s of one blocked thread | VC-013 |
| 6 valid 660 KB bundles | 200,000 tokens per parse | V8 fatal at the 259 MiB heap | VC-014 |
| chain of n bundles | none per plan | lint 61 s at 800; S5 500 bundles diamond 45 s | VC-025 |
| `verify.sql` `-- check:` plus spaces | 32 MiB body | 1 MiB is about 20 minutes | VC-015 |
| inputs under 1 MB (S4) | named limits absent | 31 s CPU or +620 MiB | VC-068 |
| body 28 MiB, caller without permission | 32 MiB | parsed first, +118 MiB, then 403 | VC-046 |
| 1,000 concurrent MCP requests (S6) | limiter answers 429 | `serve` 156 to 583 MB before the limiter | VC-078 |
| Control Store ingest | none | PANIC | VC-001 |
| target: `array_agg(repeat(...))` | row cap, timeout | kernel kill, whole cluster restarts, about 4 s | VC-002 |
| target: read whose backend dies | deadline | never returns; two wedge the reader slots | VC-012 |
| target: temp files | row cap | the disk floods | VC-047 |

What held: 18 host-reaching bundles reached neither the host nor another target (S4); YAML bombs 13 ms; 5,000-node graph in milliseconds; S5's 150-file legacy analysis took 21.6 s with the worker at 173 to 265 MB. **Reading.** Every bound is attached to the unit its author thought about (a parse, a row count, a statement); none to the scarce thing: `serve`'s event loop and heap, the open Control Store transaction, the target's memory. `overview.md` §2 splits the roles for isolation, yet plan creation and lint run in `serve` inside one transaction, and acceptance holds the plan row lock while reading the target (VC-123; E2 read `accept.ts:150-190`, `kind.ts:184-210`, `runtime.ts:56-62`: pool 10). The right pattern exists (ADR-0028's lane).

## 11. Test architecture

| Fact | Evidence |
|---|---|
| Suites are large and green: 10,383 unit, 1,716 integration, 52 browser, 960 Go (+148, +43, +5 against `d0229550`); all 18 CI jobs passed, including the new `backup-lab` and the 11 host scenarios | `A/README.md` |
| The repository **measures no coverage** (no provider, no configuration) | `A/README.md` |
| Whole invariant classes have no test: 10 of 15 (runtime matrix, deep graphs, forbidden-statement matrix, differential fuzz, kill matrix, lease and clone, replay, `ls1` from psql, known-id evidence spoofing, per-input memory) | `B/invariants-matrix.md` |
| The conformance suite written for this campaign fails 48 of 817 times; each failure is a finding | `B/conformance/RESULTS.md` |
| The CI lab covers the helper's happy path and the offline runbook; `pglab_test.go` removes or corrupts no WAL segment (E2 read), so VC-004 and VC-005 were found only by hand (R1, S2) | `A/README.md`, `C/backup-restore-numbers.md` |
| Coverage moved without shrinking, but the network-rule case of the `pg_hba` apply-time net has no shipped test | `A/README.md`, VC-129 |
| Fixes without guards: TC-049/050/054 revert green (VC-131); `verify-units.sh` as root is skipped in CI (VC-130); the TC-004 regex class was fixed once and recurs (VC-015) | R-block |
| Tests depend on their in-file order: 265 integration tests in 51 of 105 files fail when shuffled; one golden test fails alone (VC-083) | `A/README.md` |
| `main` unprotected, no required checks, `cancel-in-progress` cancels `main` CI (VC-018); the commit after the fix failed one job on a test race (VC-019); three checks are outside CI (VC-081) | `A/README.md` |
| The product's own Control Store bundles: 24 of 45 unpinned, `verify.sql` passes 11 of 23 mutations | VC-105, VC-103 |
| What the campaign built and the tree lacks: the S1 stack kit (`D/infra`, a full stack in 4 min 15 s), 31 failure cells, the rehearsal scripts, the hazard oracle (PostgreSQL 17 only) | `B/failure/`, `B/rehearsal/` |

## 12. Documents against behavior (item 4)

`E/docs-claims.md` checked 72 claims: 8 hold (ran), 31 hold (static), 17 violated (24 %; 30 % of the 56 settled), 16 unclear. The stack has since confirmed four of the six that bite at 3 a.m.: DC-014 (`operation.force_release` in none of the four operation routes), DC-037 (S5: after a restore `target show` is healthy and only a plan says `LEDGER_DIVERGENCE`), DC-046 (S3: exit 3 in 0.3 s), DC-057 (S3: 10 steps on production). DC-049's upgrade case did not reproduce: an old plan applied normally across S3's upgrade (no kind version had changed), so VC-053 stays a static finding. `B/contract.md` §3 adds 29 differences (10 CODE-WRONG, 8 DOC-WRONG, 7 UNDEFINED, 6 IMPLICIT). **Limits of this measure.** The sample was chosen for what hurts at 3 a.m. (30 % overstates the average). The brief asked for tagged statements: the two folders hold 182 `[DECIDED]`, 66 `[OBSERVED]`, 9 `[PLANNED]` tags, but only 3 of E1's rows carry a literal `[DECIDED]` and 1 a literal `[OBSERVED]`; E2 checked only that the 63 `[OBSERVED]` paragraphs cite no missing path (13 cite one, 0 dangling). The behavior of the `[OBSERVED]` statements was not run: **the `[OBSERVED]` half of item 4 is thin.**

## 13. Recoverability from the CLI alone (item 5)

21 failure states (`E/recoverability.md`): 11 recoverable with the CLI alone, 5 need the Web App or REST, 3 have no exit (R5, R6, R16), 1 cannot be rolled back (R20), 1 has an unaddressed blast radius (R21). The stack settled the static ones: R5 and R6 are real (S1 I9: four dead ends); R20 (documented rollback impossible, restore 7.0 s) and R21 (reconcile 6 steps nonprod, 10 on production, a never-mirrored production target silently adopted) are real (S3); a lost keyring is a new installation (S3). Added by the stack: the PITR in place took 13.4 s to accepting connections and 72 s from the decision to a consistent ledger, with no approval on nonprod (S5); an unplanned loss cost 12.0 s of commits and a bundle applied 11 s earlier, and 4 min 24 s of registry steps (S5). Presets matter: `operator:prod` lacks `migrations.import` (needed by `ledger reconcile`). **pending S7:** the CLI sweep may add commands to the "cannot do" list.

## 14. Open items

* **pending S7:** SSRF and network review (trust-boundary row 11), the promotion leftovers (the forged-evidence case behind VC-079), the CLI sweep, Web accessibility.
* The proposals' cost estimates for P-12 and P-14 now use S2's and S5's numbers; REOSA's own table sizes are not in the evidence.
