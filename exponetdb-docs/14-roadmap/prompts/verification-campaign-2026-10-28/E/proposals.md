# E2: proposals, what is missing (block E, item 6)

| | |
|---|---|
| Author | tester E2 (static synthesis). Nothing here is implemented, and nothing was built or run to write it. |
| Tree under test | `d51da5d0` |
| Companion | `E/structure.md` (the weaknesses `SW-n` these proposals answer; labels `B1.n` ... as defined in its section 0), `F/e2-notes.md` (three new findings, `N-A` to `N-C`) |
| Status | Every proposal is `[OPEN]`: an owner decision, not a task. **Interim:** the cost of P-12 and the sizes in P-14 wait for the restore numbers of S2; the confirmation of the static evidence behind P-01, P-05 and P-06 waits for S1. Marked `TO BE UPDATED BY THE LEAD`. |
| Cost | A rough engineering estimate by E2 for the existing team, not a measurement: **S** up to about 3 days, **M** one to three weeks, **L** more than three weeks. |
| Ordering | By value for one question: can REOSA's production database be managed by this system without surprises (Wave 11)? Value is weighed against cost: a cheap fix of an unrecoverable state outranks an expensive fix of a likely-but-recoverable one. |

## Summary

| # | Proposal | Answers | Cost | Recommendation |
|---:|---|---|:-:|---|
| P-01 | A first-class recovery command for `needs_attention` (`operation close`) | SW-1 | S to M | **do first** |
| P-02 | Plan-time risk facts from the target catalog; a lock-risk preflight in three parts | SW-2 | M | **do first** (facts); **later** (activity read, lock retry) |
| P-03 | Project settings as a server-side, versioned record | SW-3 | M | **do first** |
| P-04 | One work budget per request and an isolated analysis lane | SW-4 | S (caps), M to L (lane) | **do first** (caps); **later** (lane) |
| P-05 | A Control Store upgrade and rollback story | SW-5 | S (words), M (tools) | **do first** |
| P-06 | A periodic ledger-divergence watch and a generation guard | SW-7 | S | **do first** |
| P-07 | An apply-readiness check per target (new, E2) | SW-1, SW-2 | S to M | **do first** (plan-time verifier check); **later** (aggregate command) |
| P-08 | Tests and generators that keep the structure true (new, E2) | SW-6, SW-8, SW-10 | M | **do first** |
| P-09 | A bundle store doctor, then a withdrawn marker | SW-9 | S (doctor), M (marker) | **do first** (doctor); **later** (marker) |
| P-10 | A machine-readable plan risk report | SW-2 | S to M | **later** (after P-02) |
| P-11 | A compatibility matrix: bundle, engine, PostgreSQL, node, Control Store | SW-8 | S (table), M (gate) | **do first** (table); **later** (gate) |
| P-12 | A rehearsal apply on a throwaway clone | SW-2 | L | **later**, after S2; practice now |
| P-13 | Release sets or channels, and a promotion record | SW-9 | S to M | **later** |
| P-14 | A batched data-migration operation kind (new, E2) | SW-2 | L | **later**, decide at the first real backfill |
| P-15 | Bundle signing and provenance | SW-7 | M to L | **not needed** now; build the cheap provenance record |

Candidates of the brief and where they landed: rehearsal apply = P-12; preflight = P-02 and P-07; signing and provenance = P-15; release sets = P-13; compatibility matrix = P-11; store doctor = P-09; recovery command = P-01; plan risk report = P-10; ledger divergence watch = P-06; Control Store upgrade and rollback = P-05. Missing items E2 found itself: P-03, P-04, P-07, P-08, P-14.

---

## P-01 A first-class recovery command for `needs_attention` `[OPEN]`

**Why.** Three P1 entries and four P2 entries describe one dead end: an operation that ends `needs_attention` keeps the target's schema domain, and the only exits are retry for 4 migration kinds and a closing plan for 2 (B1.1, E1.1, E1.2, R1.4; `E/recoverability.md` R5, R6; `E/state-machines.md` SM-1, SM-2). The one exit that exists closes the stuck operation before it checks the recovery (D0.1 = R1.3), is class `low` on production (D0-01, D-R1-1), and records a false `verification_failed` (E1.7). `needs_attention` is not rare: without the cluster's verifier credential, L2 is an `error` by design (`planning-and-apply.md` §4, DC-025), and the plan does not check that the credential exists (N-A). The documented exit, `operation.force_release`, is registered and unbuilt, and two documents give it two different meanings (N-B).

**Design sketch.**

* A human-only action `operation.close` (class `high`, fresh re-authentication, audited, scope `operations.recover`, reason required). It names the operation and every domain it frees, and shows the **live** ledger read of the target in the confirmation. It never re-executes (C-16).
* The closer states the observed outcome (`applied`, `not_applied`, `partially_applied`); the engine does not rewrite `unknown` or `error` on its own. Final state: D-E1-6 option (a), keep `verification_failed` and add `closedBy` plus a plain sentence to every view now; option (b), a distinct `closed` state, together with this action if the owner wants it.
* Fix the order in `driver.ts:178-186` so that bindings and admission are checked before any close; a refused recovery leaves the stuck operation as it was (D0.1).
* Decide D0-01 at the same time: a verify plan that names a stuck operation on production gets approval and re-authentication.
* Afterwards, per-kind verify retry or `supersedes` for the node, backup, registry and drift kinds, and a timer-driven retry of `reconcile` for outcome `unknown` once the target answers, so that most operations never need the close (D-E1-1 (c)).
* CLI: `exponetdb operation close <op> --reason ...`; the CLI hint (`operationNext`) uses the server's `retryable` flag (E1.6).

**Cost.** S for the core action and the ordering fix; M with the Web page, the CLI, one test per kind and the document changes.

**Risk.** Closing an operation whose change is really half-applied. Mitigation: the live ledger read and the stated outcome in the confirmation; the audit event keeps the outcome the engine had. A second risk is that an always-available close becomes the habit: keep it `high`, human, and counted in the audit summary.

**Recommendation: do first.** It is the only proposal whose absence leaves a production target unusable with no exit from any interface. Acceptance test: the `I09-exits` test of `B/invariants-matrix.md` (pure: for every kind with `verifies = true` and every reachable `needs_attention` outcome pair a terminal state is reachable by an authorised person through REST and CLI; fails today for 4 kinds and for `unknown`), plus the three stack reproductions of B1.1. `TO BE UPDATED BY THE LEAD` when S1 confirms R5/R6 on a stack.

## P-02 Plan-time risk facts from the target catalog, and a lock-risk preflight `[OPEN]`

**Why (and what the evidence says about `pg_stat`).** The brief asks for a preflight that estimates lock risk from `pg_stat` and table sizes. The evidence splits it into three parts of different value:

1. **Classification facts.** The analyzer decides from statement text alone. B3 measured on PostgreSQL 17.11 that this is wrong in both directions (`B/ddl-hazard-matrix.md`, rows A to J): `ADD COLUMN bigserial` and `GENERATED ALWAYS AS IDENTITY` rewrite the table under ACCESS EXCLUSIVE (3 scans, size x1.09) and are classed "additive, lock high (brief)" (B3.1, P1); `DEFAULT now()` and `varchar(200)` to `varchar(500)` do not rewrite and are classed `critical` and blocked (B3.2, B3.3); `SET NOT NULL` after a validated CHECK and `UNIQUE USING INDEX` make 0 scans and are blocked (B3.4, B3.5); a cheap lock held through a later slow statement is "brief" (B3.6). The planner already opens an observer snapshot (`planner.ts:656-678`); it reads sizes but not column types, `pg_proc.provolatile`, validated CHECKs, `indisvalid`. The false positives have no lint-clean form, and the only escape is lowering the rule for the whole project, which also unblocks the real hazards (B3-D2).
2. **Activity context** (`pg_stat_activity`, `pg_blocking_pids`, `pg_locks`): promised by `analysis.md` §3 and absent (B3.8). **But the measured cost of the lock queue is bounded by `lock_timeout`:** with the default 5 s, a DDL waiting behind a 9 s reader gave up after 5 s, and a SELECT queued behind it waited 4.1 s against 0.08 s (`B/ddl-hazard/evidence/pgcheck-02-multi-session.txt`). An activity read therefore mostly saves a failed attempt (`MIGRATION_LOCK_TIMEOUT`), and it is stale by apply time (plans live 15 to 30 minutes, approvals up to 4 hours). The harm B3 found comes from other places: misclassified rewrites held up to 15 minutes (B3.1), locks held across later statements (B3.6), and `lockTimeout` raised to 2 h with only a warning (h43; the docs promise 60 s without an acknowledgement).
3. **Lock timeout retry.** The engine never retries a lock timeout (`planning-and-apply.md` §6; DC-023 static). A bounded retry with backoff and a short `lock_timeout` is safe for a transactional bundle (a timeout rolls everything back, `not_applied`) and is the usual protection against the queue. It is a design decision against C-12's spirit and belongs to the owner.

**Design sketch.**

* (a) Add the catalog facts to the planner's context: column types and typmods for `ALTER COLUMN TYPE`, `provolatile` for defaults, validated `CHECK (col IS NOT NULL)` into `provenNotNull`, the raw node's `indexname` for `USING INDEX`, `indisvalid`. Parser fixes: serial/identity as volatile; `concurrent` on DETACH (B2.5). Model "lock held until COMMIT": in a transactional bundle an ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE statement followed by a scanning or writing statement raises the severity (B3.6). Make `long_lock_timeout` blocking above 60 s without an acknowledgement. Fix the attached remedies (`add_constraint_without_not_valid` for `UNIQUE`).
* (b) Activity read at plan time, labelled with its source and time, advisory only (no policy rule consumes it); shown to the approver as "longest open transactions on the affected relations".
* (c) If the owner wants it: opt-in `lockRetry: {attempts, backoff}` in the manifest, bounded, visible in the plan.
* A per-finding acknowledgement (reason, shown to the approver, recorded in the manifest) only for what facts cannot decide; it needs the store to keep metadata edits first (B1.9), because the acknowledgement is metadata.

**Cost.** (a) M. (b) S to M. (c) S. Measurement of PostgreSQL 16 and 18 and of the "under load" cells (PENDING in `B/ddl-hazard-matrix.md`, about 3 hours on a disposable server) should precede any threshold.

**Risk.** Reading more from the target adds rows to the trust-boundary table (`E/structure.md` §8): catalog and activity data are untrusted input (C-26); use them to estimate risk and show source and time (C-28), never to authorize. A classifier that "knows" more can be wrong with more confidence; keep `unknown` explicit (C-30) and keep the PostgreSQL oracle test (P-08) beside it.

**Recommendation: do first for (a); later for (b) and (c).** (a) removes both the false negatives that mislead the approver and the false positives that train people to lower rules project-wide. Acceptance tests: B3's own (a lint test per item; an integration test on PostgreSQL 16, 17 and 18 comparing the classification with the relfilenode and `pg_locks`).

## P-03 Project settings as a server-side, versioned record `[OPEN]`

**Why.** `defaults` (timeouts, role alias, search path), `lintProfile`, `lint` overrides, `invariants` and the bundle list come from the plan request. `defaults` are hashed into the apply checksum (B1.3, DF-14); lint overrides come from whoever plans, with no policy rule on lowering (B1.8, DF-15); the default `migration plan` submits every local bundle against a request limit of 50 (B1.4, DF-17). Concretely: edit `defaults.lockTimeout` in `exponetdb.project.yaml`, the lever B3 recommends for most hazards, and every default plan is refused with a non-overridable `MIGRATION_CHECKSUM_MISMATCH`. This breaks C-10 (policy lives on the server) and C-32 (one source of truth).

**Design sketch.** The registry already has a versioned project record changed by a planned operation: `registry.projects` carries `managed_scope`, `evidence_override`, `revision`, `updated_by_operation_id` (E2 read, `01M48WRFNFYAY62E1146END05N_registry/up.sql:60-80`). Add a `settings` member (defaults, lint profile and overrides, invariants), changed by the existing `project update` plan, with production approval when a blocking rule is lowered. The server ignores or refuses the request copy (a named code). For an id that already has a stored revision the server uses the **stored** materialized defaults, so a later change affects new ids only. The alternative, equally valid: materialize the defaults into `migration.yaml` at `migration new`, so the bundle is self-contained (B1.3's second fix); the checksum already treats explicit values equal to defaults as equal (`B/conformance/RESULTS.md`, edit-class table). In both: the CLI asks the server for the pending ids instead of submitting everything (`migration status` already knows them).

**Cost.** M. **Risk.** It moves authority from a reviewed repository file to a registry record: keep the repository file as the proposal and add `project settings diff` and `apply`, so the review still happens in a pull request (owner decision B1-D1). A mistake in the stored-defaults rule could re-introduce a mismatch for old ids; the pure test of B1.3 pins it.

**Recommendation: do first.** The refusal is likely to be hit in normal tuning, it blocks the whole default flow, and a lowered production rule is a safety setting that today anyone who plans can choose.

## P-04 One work budget per request and an isolated analysis lane `[OPEN]`

**Why.** Every bound is per parse, per file or per statement; none is per request or per process (`E/structure.md` §9). Measured: 38 s of one blocked thread for 160 KB of nested comments (B2.1, P1); six valid bundles kill a 259 MiB heap (B2.2, P1); 800 chained bundles lint for 61 s (B2.3); one 1 MiB run of spaces costs about 20 minutes (R1.2, P1); a 28 MiB body is parsed before the permission check (D1.1). Plan creation and lint run in `serve`, the role that faces the internet and answers approvals and MCP, inside a Control Store transaction (N-C), against the stated purpose of the role split (`overview.md` §2).

**Design sketch.**

* Caps (S): refuse block-comment nesting above 32 with a named reason; count comment openers in the token bound; one total token budget per request (the legacy import already has 1,000,000, `MAX_TOTAL_PARSE_TOKENS`) refused as a named `parse_budget_exceeded`; the linear regex of R1.2; memoised ancestor sets in `parallel_object_overlap`; `admit` before the body of any route over the default limit is read (D1.1); read at most limit + 1 bytes in the CLI (B1.11).
* Budget (M): one object per request that counts bytes, tokens and CPU milliseconds across every bundle; lint bundles one at a time and release their statement facts (B2.2's fix).
* Lane (M to L): `serve` admits, seals the request into the Control Store lane, the worker analyses in a worker thread with a deadline and seals the result back, exactly the shape of ADR-0028 for data reads. The Control Store transaction no longer spans the analysis or the live reads.

**Cost.** S, M, M to L as above. **Risk.** The lane adds a second failure mode ("no live worker", F31 in `failure-model.md`) and latency to every plan; keep the client's view synchronous. Caps change behavior for large legitimate files (the token bound already makes 100,000 tiny statements impossible, B2.12): publish the limits (P-11).

**Recommendation: do first for the caps; later for the lane,** only if the measurements of S1/A show that the caps leave a P1-scale freeze. The caps close the two P1 entries on their own. `TO BE UPDATED BY THE LEAD` with the serve-level freeze demonstration if S1 runs one (B2 measured the library calls the handlers make, not a live container).

## P-05 A Control Store upgrade and rollback story `[OPEN]`

**Why.** `upgrades.md:15` ([DECIDED]-level text in a "Baseline accepted" document) promises that rolling back by one release works without a schema rollback; the binary refuses any newer schema (`role.ts:229-233`), so the promise cannot hold whenever the new release added a bundle (E1.3, P1; DC-046, DC-047). The runbook has no pre-upgrade backup step. A restore of the Control Store (RB-10) leaves every target's ledger mirror unexplained: every plan on every target is refused until a per-target `ledger.reconcile`, which needs the `admin` preset, approval and re-authentication on production, and which RB-10 does not mention (E1.9, R21). A plan made before an upgrade is a 500 (E1.10). The product's own Control Store bundles are held to a lower standard than the bundles it sells: 24 of 45 are not pinned and none is linted in CI (D0.6); the three new `verify.sql` files pass 11 of 23 mutations (D0.4).

**Design sketch.**

1. State it (S): `upgrades.md` says "roll forward or restore"; a verified Control Store dump is a required step before `control-store migrate`; RB-10 step 6 becomes a per-target loop with commands, scopes and the expected `LEDGER_DIVERGENCE` sequence.
2. Tools (M): `control-store migrate --plan` (lists the bundles that would run, their dependencies and a declared `additive` flag, without changing anything); `control-store backup --verify` or a documented pair of commands that produce and test a dump, and a record of it that `migrate` can require.
3. Map the internal operation codes to catalog codes (`operation_kind_unknown` to `PLAN_STALE` with binding `kindVersion`, E1.10).
4. Pin every deployed bundle at deployment; lint Control Store bundles in CI; assert owner, `prosecdef`, `proconfig` and a body digest in each `verify.sql` (D0.4, D0.6).
5. Not now: allowing an older binary to start against a newer schema when each unknown bundle is declared additive with a `minimumRelease` (E1.3 option c, D-E1-2 option b). It needs an ADR and a wrong "additive" label would let an old binary misread a schema.

**Cost.** S for 1 and 3; M for 2 and 4. **Risk.** 1 to 4 are low. Option 5 creates a compatibility contract between releases; not needed for a single installation that can accept downtime.

**Recommendation: do first.** Wave 11's first production upgrade will be its first rollback decision (D-E1-2). Acceptance: a runbook-lab test of the upgrade and the documented way back with two real images (E1.3), and of RB-10 on a stack with one staging target (E1.9).

## P-06 A periodic ledger-divergence watch and a generation guard `[OPEN]`

**Why.** `ledger.md:236` documents a reconciliation every 10 minutes per active target and a finding; the worker has no such task (B1.6 = E1.4; DC-037; `worker-tasks.ts:186-314`). Divergence is found when a plan is made, i.e. at the moment of the change. The comparison covers existence, checksum and operation id only: a hand-set `reverted_at` reads as `MIGRATION_DEPENDENCY_MISSING` and a changed `fingerprint_after` plans normally (`R/verdicts-R2.md` TC-025, NOT FIXED). `generation` never changes, and "never mirrored" and "new generation" are one code path, so a future bump would switch the check off and re-adopt a restored ledger (B1.7). C-19 says divergence blocks schema changes and is reported as drift. F30 in `failure-model.md` assumes a "startup reconciliation" after a Control Store restore.

**Design sketch.** A worker task `ledger.compare` per active target (observer read through the existing drift schedule and breaker, then `compareLedger`), extended to every mirrored column; a critical finding `ledger_divergence` naming the three lists, resolved when the ledger agrees; an audit event and a metric; optionally suspend schema plans while open. Skip a target while an operation holds its schema domain (the crash-to-mirror window heals itself). Add the rule "a mirror for an earlier generation and none for the current one is a divergence" and its test **before** any code bumps the generation.

**Cost.** S. **Risk.** One more connection per target every 10 minutes; false findings during an apply if the skip rule is wrong; alert noise after a deliberate restore (the finding is exactly what the operator wants then).

**Recommendation: do first.** Cheapest of the "notice before the 3 a.m. change" items; closes DC-037 and the inert generation protections.

## P-07 An apply-readiness check per target `[OPEN]` (new, E2)

**Why.** Several preconditions of a safe production apply are known to the system but surface late, as a failure after the commit:

* the verifier credential: absent or unusable, the apply commits and verification ends `error`, `needs_attention`, holding the schema domain (DC-025; the planner never mentions the verifier: N-A, E2 read of `planner.ts`);
* a verified backup newer than 24 h for destructive or rewriting plans (policy `migration.destructive-backup`), WAL continuity (R1.1) and the amcheck coverage (D-R1-3);
* the node's certificate window (decision 7 of `F/decisions-R2.md`: the live node's window closes on 2026-10-30) and node online state;
* an evidence environment and its freshness, the execution role, a stamped ledger (`LEDGER_NOT_INITIALIZED`), no open critical drift (DF-23), no `needs_attention` operation on the target, no `LEDGER_DIVERGENCE`;
* whether the emergency path exists at all: break-glass cannot be activated on this installation (OD-21, E1.14).

**Design sketch.** (1) At plan time, refuse or warn when a verification the plan promises cannot run (the verifier credential is a registry fact, `ROLES` includes `verifier`, E2 read of `registry/src/records.ts:332`). (2) Later, `exponetdb target check <target> --for apply`: one list of pass / fail / unknown per check, each with its source, its time and the command that fixes it; `unknown` is never green (C-30).

**Cost.** S for (1); S to M for (2), because every fact already exists in a health or backup read model. **Risk.** A stale green. Mitigation: timestamps and `unknown`. It must not become a second policy engine: it reports, the policy engine decides.

**Recommendation: do first for (1); later for (2).** (1) removes the routine entry into the dead end of P-01.

## P-08 Tests and generators that keep the structure true `[OPEN]` (new, E2)

**Why.** `E/structure.md` §10 and §11: 17 of 72 sampled claims violated, 13 of 29 lifecycle differences are "neither decides", the suites are green on a tree where 48 of 817 conformance cases fail, and fixes remove one instance of a class without guarding the class (R1.2).

**Parts, each independent:**

| Part | What | Evidence | Cost |
|---|---|---|:-:|
| a | Exit coverage: for every kind and state, a path to a terminal state through an authorised action (the `I09` pure test) | SW-1, `B/invariants-matrix.md` I9 | S |
| b | Catalog code to emitter to remedy to exit, tested in both directions; `details` rendered from the catalog schema; internal codes mapped | E1.5, E1.10, E1.11, E1.12 | S |
| c | CLI declared scopes against the action registry; one generated "concept to action id to name per surface" table | D1.7, `E/vocabulary.md` | S |
| d | Documents' commands and flags resolve (E1's `cmdcheck.py`); the limits table in `04-migrations/` equals the exported constants; a rule that a `[DECIDED]` sentence about behavior names its test or becomes `[PLANNED]` | E1.15, B2.12, `E/structure.md` §11 | S |
| e | Every value of a state `CHECK` is writable or marked derived | E1.17 | S |
| f | Adopt the B2 and B3 suites into the tree as a package: pure part in CI (about 6 minutes, most of it the nested-comment cases), integration part nightly on 16, 17, 18, DDL under load as a manual job on a disposable server; keep the ratio-style timing assertions | `B/conformance/`, `B/ddl-hazard/` | M |
| g | A classifier-versus-PostgreSQL oracle (relfilenode, scans, `pg_locks`) on 16, 17 and 18 | B3.1 to B3.6; B2.5 | M |
| h | A guard against a lazy quantifier before `\s*$` in `packages/postgres` (the TC-004 class) | R1.2 | S |
| i | A trust-boundary inventory: every read of managed-database data names the decision it feeds, and a test fails if one feeds an authorization decision | `E/structure.md` §8 | M |
| j | Pin every deployed Control Store bundle; lint them in CI; mutation-test the `verify.sql` of each | D0.4, D0.6 | S |
| k | A regression guard for each test-infrastructure fix; run `verify-units.sh` as root once | R3.1, R2.6 | S |

**Risk.** Timing tests are flaky on a loaded runner (use ratios, as B2 did); CI minutes grow (nightly lane). Generators that rewrite documents can hide a disagreement: generate the tables, review the prose.

**Recommendation: do first** for a, b, c, f (pure part), j and k; the rest later. These are the acceptance tests of findings that must live in the tree anyway.

## P-09 A bundle store doctor, then a withdrawn marker `[OPEN]`

**Why.** The store is immutable and unlistable: no CLI lists, ingests or retires a revision; `migration status` shows every never-applied stored id as pending for ever (B1.13); a dangling `dependsOn` is accepted silently and only fails when something depends on it (R1.6, the first campaign's MIG-04 reduced to a slice); the documented repair of a broken `verify.sql` cannot be finished from the CLI (E1.8); the store decides "applied elsewhere" from the Control Store mirror only (B2.7); edits that do not change the checksum are dropped (B1.9); `applied_not_in_source` (E18) has no detection (DF-22).

**Design sketch (the doctor is read-only SQL over tables that exist):**

1. dangling `dependsOn` edges; 2. revisions never referenced by a plan or a ledger row (orphans), with the plan that ingested them; 3. ids with several revisions and which plan used which; 4. ids applied on a target whose newest stored revision has other bytes than the ledger checksum (the B2.7 window and D0-04); 5. ledger rows with no stored bundle (`applied_not_in_source`); 6. never-applied ids that `status` lists as pending, with age. REST `migration.store.doctor`, CLI `migration doctor`, machine-readable. Add `migration ingest` and `migration bundles` (E1.8). A `withdrawn` marker (an append-only table read by status and planning; a withdrawn id may never be reused for other bytes) only if abandoned revisions clutter `migration status` (D-E1-10, B1-D8).

**Cost.** S for the doctor and the CLI commands; M for the marker. **Risk.** The doctor is read-only; the marker adds a state to planning.

**Recommendation: do first for the doctor and `ingest`; later for the marker.**

## P-10 A machine-readable plan risk report `[OPEN]`

**Why.** The plan's `change.analysis` is an open `JsonValue` (D1.3): author-derived strings (`-- check:` names, object names, lint messages) reach agents and approvers without the `untrusted` marker, and an agent or a CI job cannot depend on its shape. B3's results are the proof that the information exists as structured data (`B/ddl-hazard/results/*.json`: lock mode, severity, rewrite flag, transactional flag, policy decision), and the approver's page is where the wrong "brief" was read (B3.1).

**Design sketch.** A closed schema `PlanRiskReport@1`: per statement the lock mode, the severity, **hold-until** (`statement` or `commit`), rewrite (`none`, `table`, `possible`, `unknown`), scans, duration class, and **basis** (`parser`, `catalog`, `measured`, `unknown`); relation sizes with their time; lowered rules; blocking findings; policy rules and decision. Author-derived strings in `untrusted` members; `openWorldHint: true` on the plan tools (D1.3). Served by `plan_get`, REST, `--output json`; a `migration plan --check` exit code for CI.

**Cost.** S to M. **Risk.** It becomes a contract (C-33) while the classifier is still wrong in places; the `basis` field lets the contract say what each fact rests on. Publishing it before P-02 pins today's misclassifications.

**Recommendation: later,** right after P-02(a); do the closed schema and the `untrusted` marking (D1.3) with the first release that touches the plan view.

## P-11 A compatibility matrix `[OPEN]`

**Why.** Four things already differ between PostgreSQL majors and nothing records them in one place: U+000B is whitespace on 17 and 18 only; `transaction_timeout` exists from 17; the three libpg_query builds (16.7.3, 17.7.4, 18.1.5) disagree with the server on string continuation across a comment (B2.8); `NOT NULL ... NOT VALID` lints clean on the PG 18 grammar and is a `parse_error` on the PG 17 grammar (B3); B3 ran PostgreSQL 17 only for the lock and rewrite claims. `requires.postgres` is hashed "as written", so `>=16 <19` and `<19 >=16` are two identities (`B/conformance/RESULTS.md`). The agent-version promise has no constant in the code (DC-050, UNCLEAR). A plan made by another engine version is a 500 (E1.10). The Control Store schema is exact-match (E1.3). A PostgreSQL major upgrade leaves drift `not_comparable` and its runbook is `[PLANNED]` (`E/state-machines.md` §6).

**Design sketch.** One published table: engine release by target PostgreSQL major (16, 17, 18) by manifest schema version and c1 by node protocol by Control Store schema ids, each cell naming the CI job that proves it (the B2 suite already runs the three majors). `exponetdb version --compat`; a plan whose engine or kind version differs becomes `PLAN_STALE` with the binding named (P-05 item 3).

**Cost.** S for the table and the CI cells; M for gating on it. **Risk.** A table that nobody maintains; tie each cell to a CI job so a stale cell fails.

**Recommendation: do first for the table; later for the gate.**

## P-12 A rehearsal apply on a throwaway clone `[OPEN]`

**Why for.** The planner's prediction is wrong in places (B3), and a rehearsal measures instead of predicting: rewrite and its duration, size growth, the data-dependent failures that staging data may not have (unique build, `NOT NULL`, FK validation), `verify.sql` on real data. Nothing replays bundles today (I10, DF-25); only the legacy import replays on a scratch target. The building blocks exist: the restore drill builds a scratch cluster and measures time (R1 TC-009: drills `latest`, `older` and `pitr_random` passed in 3 to 4 s on a small database), and the registry has a scratch environment.

**Why not yet.** (1) It rests on a restore that is not proven at scale: S2's numbers are pending; the archive can lose a WAL segment and `backup.verify` still passes (R1.1, P1); `restore.execute` is accepted when `restore.prepare` already reported `space_insufficient` (R2 TC-046, NOT FIXED); the amcheck check is partial (D-R1-3). (2) A drill's scratch restore cannot be registered as a target: the placement move and `restores.promoted` are unbuilt (R12, DC-066). (3) It cannot show the lock queue behind live traffic (`pgcheck-02`) or application compatibility, which B3 shows to be the production-specific risk. (4) It copies production data into a scratch cluster: access and retention need a rule. **TO BE UPDATED BY THE LEAD** with S2's restore time and size at REOSA scale.

**Design sketch (later).** A `migration.rehearse` kind: restore the latest verified backup into a drill scratch cluster, register it as an ephemeral target in a `rehearsal` environment, plan and apply the same bundles with the production plan's ids and checksums, record durations, rewrites (relfilenode before and after), the lock hold and the verification, attach the result to the production plan as advisory evidence, discard the scratch.

**Cost.** L. **Risk.** Time and disk for a production-size clone; a false sense of safety (it proves the data side only); data governance.

**Recommendation: later.** Practice now, no engineering: refresh staging from the latest verified production backup before a release, so that the existing staging-evidence rule becomes a rehearsal on production-sized data.

## P-13 Release sets or channels, and a promotion record `[OPEN]`

**Why.** There is no promotion object (DF-24): the production gate is a rule evaluated at plan time and bound into the plan, which already fixes the list, the order, the evidence and the approval by hash. The default CLI flow cannot express "promote what is verified on staging" beyond 50 bundles (B1.4). The documented "production follows staging order" rule is unbuilt (DC-045). A non-transactional bundle runs alone in its plan, so a release with a `CREATE INDEX CONCURRENTLY` is several plans with no object that holds them together or stops the rest when one fails. The hotfix follow-up is unbuilt (B1.12, DF-26).

**Judgement.** A named, immutable list of (id, checksum, verify digest) would mostly add a name. The two real gaps are smaller and cheaper: (1) a `migration promote --from <env> --to <env>` that asks the server for the ids verified on the evidence environment and pending on the target and plans exactly those (also removes the 50 limit); (2) an ordered **release run** that applies several plans in sequence and halts on the first failure. A promotion record is then a read model joining the plan, the evidence, the operation and the verification ids.

**Cost.** S for `promote`; M for the record and the run. **Risk.** A new object that duplicates plan semantics and approvals (each plan still needs its own approval); app compatibility (expand/contract against the running build) is not something a release set can know.

**Recommendation: later** (`promote` can ride with P-03).

## P-14 A batched data-migration operation kind `[OPEN]` (new, E2)

**Why.** A transactional bundle is one transaction and `COMMIT` is forbidden, so the safe form of an `UPDATE` backfill, and of the documented NOT NULL recipe on a large table, cannot be written as a bundle (`engine_expressible=no`, `B/ddl-hazard-matrix.md`, B3-D1). `data_change_unbounded` fires only for a missing `WHERE` (`WHERE id > 0` is silent, h26). The alternative, a job outside the engine, breaks "no direct DDL outside the migration engine" for data changes and leaves no ledger or audit.

**Design sketch.** A kind `data.backfill` planned with predicate, key, batch size and maximum rate; resumable by watermark; throttled on lock waits and replication lag; one operation with progress events; verification by count or checksum; a ledger row per backfill. Its hard part is keeping C-6, C-12, C-16 and C-18 with intermediate commits.

**Cost.** L. **Risk.** A new write path with its own failure modes (half-done at a watermark, replication lag, autovacuum). **TO BE UPDATED BY THE LEAD** with REOSA's largest table sizes (S2).

**Recommendation: later; decide at REOSA's first real backfill.** Until then document an out-of-band procedure with an audit note.

## P-15 Bundle signing and provenance `[OPEN]`

**Why the question comes up.** The evidence rule trusts operation ids that a hand-written ledger row can carry (B1.2); `migration.resume` takes the operation to close from the target's ledger events (D0.7).

**What the evidence says.** These are holes of **attribution**, not of **authenticity**. The plan already binds the exact bytes (C-8), a human approves production plans, the checksum is immutable once applied, and staging evidence is required. A signature over `bundleDigest` proves "these bytes came from a reviewed commit or CI key"; it adds assurance only if a policy demands it (for instance "an agent may not submit inline bundles to production"), and `migration.agent-production` already requires a human approval there. Signing the **ledger rows** (an HMAC with an installation key) would defend against a hand-written row, but the mirror cross-check of B1.2's fix gives the same protection at no key custody, and neither helps against a restore replaying valid old rows (that is the mirror and the generation, P-06).

**Cost.** M to L (key custody under C-20, rotation, CI integration, an envelope outside c1, policy rule). **Risk.** Another secret to hold and lose.

**Recommendation: not needed now.** Instead: (1) fix B1.2 (evidence only from the mirror and the Control Store's verification record); (2) store the manifest's `source` claim (commit, CI run, author) as attributed, untrusted metadata per revision and show it to the approver, which first needs the store to keep metadata edits (B1.9); (3) revisit signing, using a CI OIDC attestation rather than a key ExponetDB holds, if agents gain inline-bundle rights on production or more than one team authors bundles.

---

## Order of work (suggested)

1. Before anything else touches production: P-01, P-05 (words and the dump step), P-06, and the caps of P-04. All small, all close an unrecoverable or undetected state.
2. Then the two changes that remove daily friction and wrong information: P-03 and P-02(a), with P-07(1) and the first guards of P-08 (a, b, c, j, k) and the pure conformance suite (P-08 f).
3. In parallel, cheap and read-only: P-09 (doctor), P-11 (table).
4. After S2 and the first real staging runs: P-12, P-10, P-13, P-14 as the owner's experience asks. P-15 only on the conditions stated.

## What is deliberately not proposed

* A new break-glass design: the closed emergency path is owner decision OD-21 (`F/decisions-E1.md`), not a missing mechanism.
* Renaming identifiers in frozen bundles (D-E1-8 option b).
* A `c2` checksum (B1-D9, B2-D4): the evidence shows documentation and tooling gaps (B1.10), not a defect of c1.
