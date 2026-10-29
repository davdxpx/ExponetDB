# E2: structure and systems review (block E, items 1 to 5)

| | |
|---|---|
| Author | tester E2 (static synthesis, no server) |
| Tree under test | `T` = `d51da5d0` (merge of fix PR #46), read only |
| Method | Synthesis of the campaign evidence listed in section 0. No new reproduction. Three code facts were read directly by E2 and are marked **(E2 read)**; they are the only claims that do not come from an evidence file. Nothing was run. |
| Status | **Interim.** Sections marked `TO BE UPDATED BY THE LEAD` wait for S1 (stack runs), S2 (backup numbers) and A (suites). Every claim below stands on the evidence that existed on 2026-10-29. |
| Companion | `E/proposals.md` (what is missing, each `[OPEN]`), `F/e2-notes.md` (three new findings) |

## 0. Evidence base and reference labels

Read in full: `B/contract.md`, `B/invariants-matrix.md`, `B/conformance/RESULTS.md`, `B/ddl-hazard-matrix.md`, `E/{state-machines,vocabulary,errors,docs-claims,recoverability}.md`,
`D/new-bundles-security-review.md`, `D/authz/{README,d1-notes,agent-safety}.md`, `R/{baseline,verdicts-R1,verdicts-R2,verdicts-R3}.md`, `A/README.md` (interim), every `F/findings-*.md` and `F/decisions-*.md`.
Product documents read: `00-product/constitution.md`, `01-architecture/{overview,failure-model}.md`, `02-control-plane/operations-engine.md` (§3, §4), `04-migrations/README.md`.

The findings drafts carry no ids yet. This file refers to them as `<part>.<n>`, the n-th entry of `F/findings-<part>.md` in file order (`B2.x` and `B3.x` are both in `findings-B2.md`: the B2 entries come first, then the B3 entries). The lead replaces them with `VC-nnn` after numbering.

| Label | File | Entries | P1 / P2 / P3 |
|---|---|---:|---|
| B1.1 to B1.14 | `F/findings-B1.md` | 14 | 1 / 7 / 6 |
| B2.1 to B2.13 | `F/findings-B2.md` (first 13) | 13 | 2 / 4 / 7 |
| B3.1 to B3.9 | `F/findings-B2.md` (last 9) | 9 | 1 / 7 / 1 |
| D0.1 to D0.7 | `F/findings-D0.md` | 7 | 0 / 2 / 5 |
| D1.1 to D1.7 | `F/findings-D1.md` | 7 | 0 / 1 / 6 |
| E1.1 to E1.17 | `F/findings-E1.md` | 17 | 3 / 7 / 7 |
| R1.1 to R1.6 | `F/findings-R1.md` | 6 | 2 / 3 / 1 |
| R2.1 to R2.6 | `F/findings-R2.md` | 6 | 0 / 1 / 5 |
| R3.1 to R3.2 | `F/findings-R3.md` | 2 | 0 / 0 / 2 |
| **Total** | | **81** | **9 / 32 / 40** |

About seven of the 81 are duplicates (`F/merge-notes.md`: B1.1 = E1.1 + E1.2, B1.6 = E1.4, D0.1 = R1.3, B1.9 = B2.13, B2.5 = B3.7; B1.11 and B2.10 overlap). Other labels: `DF-nn` = difference in `B/contract.md` §3; `DC-nnn` = claim in `E/docs-claims.md`; `SM-n`, `R-n` = `E/state-machines.md` §8 and `E/recoverability.md`; `I-n` = invariant of `B/invariants-matrix.md`; `C-n` = constitution article.

## 1. Verdict

**What is structurally good (evidence says so, it should be kept).**

* The constitution (`00-product/constitution.md`) is checkable article by article, and the engine follows its shape: one transition function (`B/contract.md` §2.2), the same state tables in TypeScript and as database triggers (`E/state-machines.md` §1), plan binding and `PLAN_STALE`, applied separate from verified.
* The *content* contract of a bundle is the strongest part of the product: 91 of 91 edit-class cases of c1 behave as documented (I2), 360 generated scripts plus 450 single-edit mutants per major show server, libpg_query and c1 agreeing on lexical validity (I5), every function-body hazard that reaches the server (34 hazards, 16 host-reaching statements) is atomic on PostgreSQL 16, 17 and 18 (I4), and digests, graph order and the plan-content hash are byte-identical across 4 runtimes x 7 environments (`B/conformance/RESULTS.md`).
* Every one of the 13 P1 fixes of the first campaign has a test that fails on the old code (`R/verdicts-R1.md`, counts), and the three new Control Store bundles are additive and transactional (`D/new-bundles-security-review.md` §1).

**What is structurally wrong.** The engine is good at the thing in front of it (parse this text, run this transaction) and weak at the things around it: what happens when the thing in front of it does not finish, who owns the configuration it depends on, what it may assume about the database it manages, how much work one request may cause, and whether the documents and tests describe the code that exists. 81 drafted findings reduce to ten structural weaknesses (section 2); eight of them can each surprise a production operation, and two of them (SW-1, SW-5) have no way back for an operator.

**Does the structure let REOSA's production database be managed without surprises?** Not yet. The blocking items are structural, not cosmetic: a parked `needs_attention` operation holds a production target's schema domain with no exit for any kind outside four migration kinds (SW-1); the risk the approver reads is a parser guess that is wrong in both directions (SW-2); a harmless-looking edit of a project default makes every default plan refuse (SW-3); the upgrade of ExponetDB itself has no rollback (SW-5). All four are cheap to close compared with what they protect (`E/proposals.md`, P-01, P-02, P-03, P-05).

## 2. Ranked structural weaknesses

Ranked by what they do to the question "can the production database be managed without surprises", then by cost of the fix. "Seen" is what an operator observes, not what the code does inside.

| Rank | Weakness | Evidence (files, labels) | Seen by the operator | Cheapest structural fix | Proposal |
|---:|---|---|---|---|---|
| **SW-1** | **A stuck operation has no exit and keeps the target's lock.** `needs_attention` holds its exclusivity domains; retry exists for 4 migration kinds, closing by a named recovery plan for 2; `operation.force_release` is registered and unbuilt; the recovery that exists closes the stuck operation before it checks itself. | `E/state-machines.md` §1, §8 (SM-1, SM-2); `E/recoverability.md` R5, R6; `B/contract.md` §3 DF-02, DF-19; B1.1, E1.1, E1.2, R1.4, R1.3 = D0.1, E1.6, E1.7; `F/decisions-R1.md` D-R1-1; `F/decisions-D0.md` D0-01 | `operation show`: `retryable: false`. `retry-verification`: `OPERATION_NOT_RETRYABLE`. `cancel`: `OPERATION_NOT_CANCELABLE`. Every later plan on the target waits behind it with `waitingFor` for ever. The CLI even recommends the refused command (E1.6). | One human-only, audited, re-authenticated action that closes a named `needs_attention` operation of any kind, frees its domains, never re-executes. Fix the order in `driver.ts:178-186` (checks before the close). | P-01 |
| **SW-2** | **The risk the approver reads is a parser guess, wrong both ways.** The analyzer sees statement text only: no column types, no volatility, no existing CHECKs, no activity, and lock lifetime to COMMIT is not modelled. A false negative is told as "brief"; a false positive has no lint-clean form, so the only escape is lowering the rule for the whole project, which also unblocks the real hazards. | `B/ddl-hazard-matrix.md` (rows A to J, "Where the product's classification differs from PostgreSQL"); B3.1 to B3.9, B2.5, B2.6; `F/decisions-B3.md` B3-D1, B3-D2 | "additive, lock high (brief)" for `ADD COLUMN bigserial`, which rewrote the table under ACCESS EXCLUSIVE (3 scans, size x1.09, held up to 15 min). "BLOCKS" for `varchar(200)` to `varchar(500)` (0 scans). The documented NOT NULL recipe (s08), the `UNIQUE USING INDEX` step (s15) and s30 block a production plan; lowering the rules turns h04, h11, h14, h15, h16, h17 into `require` as well. | Give the planner the catalog facts it can already read (column types, `provolatile`, validated CHECKs, `USING INDEX`) and model lock lifetime to COMMIT; parser fix for serial and identity. A per-finding acknowledgement only for what facts cannot decide. | P-02, P-10 |
| **SW-3** | **Project configuration has no server-side home, and the identity function takes an input from the client.** `defaults`, `lintProfile`, `lint` overrides, `invariants` and the bundle list travel in the plan request; `defaults` are hashed into the apply checksum. | `B/contract.md` §3 DF-14, DF-15, DF-17, §6; B1.3, B1.4, B1.8, B1.10; constitution C-10 (policy lives on the server) and C-32 (one source of truth) | Edit `defaults.lockTimeout` in `exponetdb.project.yaml` (the lever B3 recommends for most hazards): the next `migration plan` is refused with `MIGRATION_CHECKSUM_MISMATCH`, not overridable, for every applied bundle whose manifest is silent. A project with 51 bundle directories cannot use the default `migration plan`. Whoever plans chooses which production rules are lowered. | Store the settings in the registry project record (it is already versioned and changed by a planned operation, E2 read, `registry.projects.revision`, `updated_by_operation_id`); ignore or refuse the request copy. | P-03 |
| **SW-4** | **Resource bounds are per unit, not per request or per process, and the untrusted-input work runs in the internet-facing role, inside a database transaction.** | `B/conformance/RESULTS.md` (I14 and measurements); B2.1, B2.2, B2.3, R1.2, D1.1, B1.11 = B2.10, B2.11, R2.4, B2.12; `01-architecture/overview.md` §2; `B/contract.md` §4 | `serve` stops answering (approvals, MCP, REST) for 38 s on a 160 KB comment file; six valid 660 KB bundles kill a 259 MiB heap (exit 134); 800 chained bundles lint for 61 s and a 1,000-deep chain plans for 53 s or fails with `control_store_timeout`; one 1 MiB run of spaces in `verify.sql` costs about 20 minutes of event loop; a 28 MiB body is parsed for a caller who lacks the permission. | Nesting-depth cap and comment counting in the token bound; one token/byte budget per request; then move analysis into the existing admit-in-serve, run-in-worker lane (ADR-0028). | P-04 |
| **SW-5** | **ExponetDB's own upgrade has no way back, and its own bundle system is held to a weaker standard than the one it sells.** | E1.3, E1.9, E1.10; DC-046, DC-047, DC-049, DC-057; `E/recoverability.md` R20, R21; D0.4, D0.6; `F/decisions-E1.md` D-E1-2 | An older image refuses the migrated Control Store (`schema_newer`) although `upgrades.md:15` promises a one-release rollback; the runbook has no pre-upgrade backup step; a restore of the Control Store (RB-10) refuses every plan on every target until a `ledger.reconcile` per target, which RB-10 does not mention. 24 of the 45 Control Store bundles are not pinned (E2 read: 45 directories, 21 entries in `frozen-bundles.json`; D0.6 says 27, which counts the three new bundles twice); the three new `verify.sql` files pass 11 of 23 mutations. | Say "roll forward or restore" in `upgrades.md`; make a verified Control Store dump a required step; a `control-store migrate --plan` that lists what will run; pin deployed bundles. | P-05 |
| **SW-6** | **The single-writer protocol is convention, not invariant.** Content that runs inside the protocol can release it; state that the protocol relies on can be rewritten by roles inside it; decisions are fed by values the managed database controls. | B2.4, B2.6, D0.2, D0.3, D0.7, D1.4; `B/contract.md` §3 DF-28, DF-29; `B/invariants-matrix.md` I8 | `SELECT pg_advisory_unlock_all();` in `up.sql` is applied and the engine's `EXDB` locks vanish while the migration runs (PostgreSQL 16, 17, 18). A session that sets `application_name = 'exponetdb/x'` cannot be cancelled or terminated by ExponetDB. The worker can `UPDATE` the mirror it is compared against. | Re-assert the lock after every statement (the `pg_locks` read the ledger guard already does), deny `pg_advisory_*`, a column-level guard trigger on the mirror, protect sessions by backend identity not by name. | P-08 (trust-boundary guard) and the findings themselves |
| **SW-7** | **The ledger, mirror and evidence chain is incomplete.** Attribution is by operation id alone, the mirror that exists to catch tampering is not consulted for evidence, `generation` never changes, and "never mirrored" and "new generation" are one code path. Nothing watches for divergence between plans. | B1.2, B1.6 = E1.4, B1.7, B2.7, D0-04 (`F/decisions-D0.md`); `B/contract.md` §2.5, §3 DF-08 to DF-13; DC-037; `R/verdicts-R2.md` TC-025 | Divergence is discovered when a plan is made, i.e. at the moment of the change. A hand-written ledger row carrying a real operation id counts as staging evidence for production. A hand-set `reverted_at` is `MIGRATION_DEPENDENCY_MISSING`, not divergence. | Cross-check the mirror in the evidence rule; a worker task every 10 minutes; "mirror of an older generation and none for the current one" is a divergence. | P-06 |
| **SW-8** | **Nothing mechanical ties documents, state tables and tests to the code.** 17 of 72 sampled document claims are violated; 29 differences between the bundle lifecycle as documented and as built, 13 of them "neither decides" or "no document names it"; the suite is large and green but lacks a test class for 10 of 15 invariants. | `E/docs-claims.md`; `B/contract.md` §3; `B/invariants-matrix.md`; R2.5, R3.1, R3.2, R2.6, D1.5, D1.7, E1.15; `A/README.md` | A runbook command that does not exist (`ca init-root`, `lock-key`, `dev seed`); a rollback promised that cannot happen; a deadline documented and absent. 10,383 unit tests, 1,716 integration tests and 52 browser tests pass on the same tree on which 48 of 817 conformance cases fail. | Generate the state and exit tables and the command lists from the code tables; run E1's `cmdcheck.py` in CI; adopt the B2/B3 suites; add exit-coverage and catalog-emitter tests. | P-08 |
| **SW-9** | **The bundle store has no lifecycle.** It is immutable and unlistable: no list, no CLI ingest, no withdraw, no doctor; edits that do not change the checksum are dropped; dangling `dependsOn` is accepted silently; promotion and replay are not objects. | B1.9 = B2.13, B1.13, R1.6, E1.8; `B/contract.md` §3 DF-05, DF-06, DF-24, DF-25; `E/state-machines.md` §4; `F/decisions-B1.md` B1-D8, B1-D14 | `migration status` lists every never-applied stored id as pending for ever. The documented repair of a broken `verify.sql` cannot be finished with the CLI. A bundle ingested by a denied plan stays in the stream. | A read-only store doctor first; a withdrawn marker later; `migration ingest` in the CLI. | P-09, P-13 |
| **SW-10** | **The error, exit-code and vocabulary contracts are partial.** 13 catalog codes are never produced; 69 carry no remedy; 96 of 129 fall to exit 1; the human CLI output hides the details that name the object (`PLAN_STALE` does not say which binding changed); six of 17 vocabulary rows can send an operator the wrong way. | `E/errors.md` §1 to §5; `E/vocabulary.md` §1, §2; E1.5, E1.10, E1.11, E1.12, E1.16, D1.7; `F/decisions-E1.md` D-E1-4, D-E1-8 | "The plan no longer matches the target. Create a new plan." and a request id. HTTP 500 `INTERNAL` for a plan made before an upgrade. A CI script cannot tell "a person must act" from "the tool failed". | A generated table "code to emitter to remedy to exit" tested in both directions; render `details` from the catalog schema. | P-08 |

## 3. State machines (item 1)

The six diagrams are in `E/state-machines.md` (operations §1, plans §2, approvals §3, bundles §4, ledger §5, drift §6) and the smaller machines in §7. This section states only what the evidence says about them.

| Machine | Dead end | Two meanings | Unreachable value | Not shown by a UI | Evidence |
|---|---|---|---|---|---|
| Operations | `needs_attention` for every kind except 4 (retry) and 2 (closing plan) of about 60 kinds; `needs_reconciliation` if no worker runs | `canceled` = rejected by an approver or cancelled by the applier; `verification_failed` = verification failed, or "closed by a recovery plan" with a verification outcome rewritten to `failed` although nothing ran; `failed` = four causes told apart only by `errorCode` | `operation.force_release` (action registered, no kind, route, command or page) | the closer of a superseded operation; the cooling case of `awaiting_approval` | SM-1, SM-2, SM-7; E1.1, E1.2, E1.7 |
| Plans | none | `active` in the table but past `expiresAt` until the worker sweeps (the apply path checks the clock) | none | none | `E/state-machines.md` §2 |
| Approvals | `awaiting_approval` never expires (documented: 4 h default, 24 h maximum) | `awaiting_approval` = waiting for an approver, or approved and waiting for the applier to apply again (cooling) | the "window elapsed" edge | the wait itself: the plan is already `consumed` | SM-3; B1.5; DF-01 |
| Bundles | no state column at all; stored revisions cannot be retired; a verify revision cannot be stored with the CLI | "applied" (committed) vs "verified" is two facts, but `applied` + `verified` + `reverted` are derived, never stored as a bundle state | none | stored revisions: no CLI listing | SM-4; B1.13; E1.8; `B/contract.md` §1.1 (the first consolidated diagram: no document draws it) |
| Ledger / mirror | none in the machine; divergence is found only by a plan | `LEDGER_DIVERGENCE` "target suspended" is not a target state (the gate is the live comparison) | `ledger.mirror_healed`; `generation` never changes | which operation healed the mirror | `E/state-machines.md` §5; DF-10, DF-12; B1.6, B1.7 |
| Drift | `not_comparable` after a PostgreSQL major upgrade: no exit tested | "baseline" names a ledger origin and a drift reference | none | which operation accepted a finding | SM-5, SM-6; E1.13 |
| Step-up, enrollment token, restore, break-glass | restore `needs_attention` exits only by `discard` | stored `pending` can be past its time (`expired` is derived) | step-up `expired`, token `expired`, restore `promoted` (guard raises), break-glass activation (refused without a notification channel, OD-21) | the Web App has a label for `promoted` | SM-8; E1.14; E1.17 |

**Structural cause.** The edges are tables in the database (good), but *who may use an edge* is decided by three independent per-kind predicates outside the table: the retry list (`VERIFICATION_RETRY_KINDS`, `views.ts:270-275`), the worker's claim predicate (`leases.ts:56-60`) and the optional `supersedes()` of a kind. The table says the edge `needs_attention -> verifying` exists; the predicates decide that it exists for four kinds. Nothing derives "every non-terminal state has an exit for an authorised person, per kind" from the tables, so the dead end was invisible until a person drew it (`B/invariants-matrix.md` I9; the test `I09-exits` is proposed there, not built).

## 4. Vocabulary (item 2)

`E/vocabulary.md` has 17 rows. Six are marked "wrong action possible": **apply** (`migration apply` re-plans from the working directory, so the plan a person reviewed with `migration plan` is not the one it runs, and the production prompt shows a plan id only), **verify** (two server actions, two CLI names, one Web button, and the CLI hint offers the refused one), **baseline** (a ledger origin and a drift reference, overlapping in the help of `migration verify`), **reconcile** (four automatic meanings and one manual command; "wait for reconciliation" can send an operator to `ledger reconcile` early), **recovery** (restore from backup, a closing plan, a permission, an account recovery path) and **exponetdb** (two programs, 36 runbook mentions that do not say which one). One further row (`plan` as an "effect" column) can mislead agents that gate on it.

The word table is a symptom. The cause is that there are four independent registries with hand-maintained links between them: 265 actions, 178 CLI commands, 30 MCP tools, and the Web App message keys. They are compared by hand, and the generated authorization matrix finds the drift: six CLI commands declare scopes the API does not accept (D1.7), 17 human-only consequential actions with no declared re-authentication, 25 lookup-before-authorization candidates (`D/authz/authz-matrix.md` §2). **Cheapest structural fix:** one generated table "concept to action id to name per surface", checked in CI (E1's and D1's generators are the prototypes), plus the renames of `E/vocabulary.md` (D-E1-8, option a: documents and help text only).

## 5. Errors (item 3)

| Question | Answer (all from `E/errors.md`) |
|---|---|
| Is every code documented with a cause? | Yes, 129 of 129; the documents and `errors.ts` are in sync. |
| A remedy? | 38 of 129 have `remediation`; at most 69 have none at all (keyword upper bound). The operational ones lack it: `LEDGER_NOT_INITIALIZED`, `TARGET_IDENTITY_MISMATCH`, `VERIFICATION_FAILED`, `POLICY_DENIED`, `PLAN_ALREADY_USED`. |
| Can every code occur? | No: 13 are named by no server source file (the `STAGING_*` family, `ORDER_DIVERGES_FROM_EVIDENCE`, `OPERATION_CONFLICT`, `BACKUP_FAILED`, `RESTORE_FAILED`, `TOKEN_EXPIRED`, `SAMPLE_STALE`, ...). The CLI maps four of them to exit 4 and the Web App has message keys for two. |
| An exit per code? | 33 codes have one. 96 fall to exit 1, including nine "a person must act" codes and four retryable 503s. Five of the 17 codes mapped to exit 4 are never emitted. CI cannot tell "blocked" from "tool failed". |
| Errors that hide the ids | The CLI prints five detail keys only; `PLAN_STALE` does not name the changed binding, `POLICY_DENIED` not the rule, `MIGRATION_EXECUTION_FAILED` not the statement or SQLSTATE, `LEDGER_DIVERGENCE` not `checksumDiffers` or `unrecorded` (E1.5). `PLAN_ALREADY_USED` carries no operation id. |
| Errors that name the wrong thing | `VERIFICATION_FAILED` is the end state of a later migration that failed to *execute* (B1.14). A statement timeout is `MIGRATION_EXECUTION_FAILED` + SQLSTATE 57014 with no code of its own, and the token bound shows as `parse_error` text saying `too_large` (B2.12). A plan across an upgrade (`operation_kind_unknown`), a lost race (`operation_state_changed`) and a duplicate in-flight key (`idempotency_in_progress`) are HTTP 500 `INTERNAL` with `retryable` true (E1.10). The remedy of `HBA_WOULD_LOCK_OUT` names an option that cannot work (R2.2). |

**Structural cause:** the catalog is a list of names, not a contract that has an emitter, a remedy and an exit per row; nothing fails when one of the three is missing. The 135 string-literal codes outside the catalog are internal by design but nothing separates them from the ones that reach a client (`E/errors.md` §4).

## 6. The bundle system as a product (item "bundle system")

The brief asks whether the contract is explicit and where the structure is implicit or missing. The honest split:

| Element | Explicit? | Evidence | Where it is implicit or missing |
|---|---|---|---|
| Identity: apply checksum c1, bundle digest, ULID | **Yes**, frozen, golden-pinned | I2 91/91; `tooling/golden` | The summary sentences ("comment-only edits are not drift") are looser than c1 (B1.10). **An input of the identity is outside the bundle**: project `defaults` come from the request (B1.3, DF-14). |
| Content binding / immutability | Yes, trigger on `bundle_revisions` holds for serve, worker, superuser | I13 PASS items | "Applied elsewhere" is decided from the Control Store mirror only, so in the commit-to-mirror window other bytes under an applied id are accepted (B2.7). Edits that do not change the checksum are dropped as `unchanged` (B1.9). |
| Order | Yes (DAG, ULID tie-break), tested up to 5,000 nodes | I3 PASS items | `checkOrder` is not applied at execution (DF-29); the constitution's "ULIDs never order" and `dependency-graph.md`'s ULID tie-break disagree (`F/decisions-B2.md` B2-D3); lint and plan over a chain are cubic (B2.3). |
| **Promotion** | **No object.** The production gate is a rule evaluation at plan time. | DF-17, DF-24; `B/contract.md` §2.6 | Evidence is recomputed per plan and trusts operation ids (B1.2). The documented "production follows staging order" rule is unbuilt (DC-045, `ORDER_DIVERGES_FROM_EVIDENCE`). The default CLI plan cannot express "promote what is verified on staging" for more than 50 bundles (B1.4). |
| **Replay** | **No.** Only the legacy import replays, on a scratch target. | DF-25; I10 | No bundle replay on an empty database; the "fresh replay on a disposable PostgreSQL" in CI is `[PLANNED]`. |
| **Bundle store lifecycle** | **No.** Keyed `(project, id, revision)`, not "content-addressed" as the docs and the constitution's source-of-truth map say. | DF-05 | No list, ingest, withdraw or doctor in the CLI; pending-forever; a dangling `dependsOn` is stored silently (R1.6). |
| **Project settings home** | **No.** | DF-14, DF-15 | `defaults`, `lintProfile`, `lint`, `invariants` are fields of the plan request. The reviewed project file and the server cannot be told apart; no policy rule treats a lowered production rule as a reason for approval (B1.8). |
| Lint overrides | Documented ("a project may lower a rule") | `analysis.md` §6 | Per project, not per finding; lowering also lowers the real hazards (`F/decisions-B3.md` B3-D2). |
| Checksum depending on request-supplied defaults | Documented as "materialized at ingest" | DF-14 | Materialized from the client's copy at every request, so the same bytes can hash two ways. |
| Limits | Sizes yes; counts and bounds no | B2.12; I15 | 50 bundles / 200 ids / 32 MiB are in `06-rest-api/resources.md:103` only; the token bound is in `deployment.md` §2a only. |
| What the engine cannot express | Not stated | `B/ddl-hazard-matrix.md` | A batched backfill (COMMIT is forbidden, one transaction per bundle: B3-D1); `DETACH PARTITION ... CONCURRENTLY` (B2.5); one non-transactional bundle per plan *and* its ancestors planned first (DF-21). |
| Hotfix follow-up | Documented | DF-26 | No `hotfix_without_evidence` finding, no ledger mark (B1.12); break-glass cannot be activated at all on this installation (E1.14). |

**Verdict.** The *content* contract is explicit and well tested. The *lifecycle* contract around it is not a contract: 13 of the 29 differences between documents and code (`B/contract.md` §3) are tagged UNDEFINED or IMPLICIT, meaning no document and no code decide the case, and they are the cases the brief names: promotion, replay, store lifecycle, project settings, lint overrides, the generation. `B/contract.md` §1.1 is the first single diagram of the lifecycle; it had to be assembled from eight documents. **Cheapest fix:** put that diagram, generated from the transition tables, at the head of `04-migrations/README.md`, and give each UNDEFINED row an owner decision (`F/decisions-B1.md` B1-D1, B1-D8, B1-D14 already ask them).

## 7. Single-writer and lock model (the `needs_attention` lock domain)

The invariant (C-18) is realised in three layers with different lifetimes and *no named release operation per layer*:

| Layer | Object | Held from / until | Released by | Gap |
|---|---|---|---|---|
| A. Control Store exclusivity domain | `operations.operation_locks` rows (`target:<id>:schema`, `cluster:<id>:config`, `cluster:<id>:backup`, `target:<id>:maintenance`, `node:<id>:packages`) | `running` until a **terminal** transition (`transitions.ts:177-198`); `needs_attention` keeps them; row-level security lets the worker delete a lock only when its operation has finished (`D/new-bundles-security-review.md` §2.2) | the terminal transition only; for a stuck operation: the closing edge of a recovery plan (2 kinds) | no operator action for the other kinds (SW-1) |
| B. Target session advisory lock | key `(1163412546 'EXDB', hash(class, target))` on the migrator session (`concurrency.md`) | lock acquisition until the session ends | session end; dead worker: keepalives, about 60 s | `up.sql` can call `pg_advisory_unlock_all()` (B2.4); the guard that reads 13 settings does not read the lock (B2.6) |
| C. Fencing in the transaction | marker `FOR SHARE`, ledger `SHARE` lock, lease re-check before COMMIT, lease 30 s | one transaction | COMMIT / ROLLBACK | evidence is not re-read under the lock (DF-28); `checkOrder` unused (DF-29); no SIGSTOP/lease test and no clone test (I8) |

**The `needs_attention` domain.** When an operation parks, layer B is already gone (the migrator session ended) and layer A is still held. The target itself is unlocked while the Control Plane refuses to admit anything: every later plan queues with `waitingFor`. This is by design (C-16: nothing re-runs by itself), and the design does not say who frees layer A. The documents give the answer twice and differently:

* `operations-engine.md` §4.1 (E2 read): "`operation.force_release`, for an operation no recovery plan covers, remains planned" (a close of layer A).
* `concurrency.md:131` and `failure-model.md` F11: `operation.force_release` "terminates that exact backend (pid + backend_start), marks the owning operation `needs_reconciliation`, and audits" (a release of layer B).

Building it "as documented" in the second sense would not close the dead end: a parked operation has no backend to terminate, and `needs_reconciliation` is the state that already failed to resolve (`F/decisions-E1.md` D-E1-1 option b says the same). See `F/e2-notes.md`, N-B.

**The one release that exists** closes before it checks (D0.1 = R1.3), is classed `low` on production for a person (no approval, no re-authentication, `F/decisions-D0.md` D0-01, `F/decisions-R1.md` D-R1-1) and records the closed operation as `verification_failed` with a verification outcome that never ran (E1.7). **What holds:** layer A/C fencing is exercised by `verify-locks.int.test.ts` and the E5/E6 failure tests; ledger forgeries, role switches and pinned settings that are guarded roll back whole.

**Structural fix.** Name one release operation per layer: `operation close` for A (P-01); for B, a post-statement assertion that the engine's lock is still held (the `pg_locks` read the ledger guard already does) and a denylist for `pg_advisory_*` (B2-D9).

## 8. Trust boundaries (what the registry trusts from the managed database, and from a bundle)

C-26 says content from the target is data. The evidence finds eleven places where a value controlled by the managed database, by a bundle, or by the client feeds a decision. There is no inventory of such reads; this table is the first one.

| # | Value | Source | Decision it feeds | Evidence | Safe design |
|---|---|---|---|---|---|
| 1 | `application_name` | any role that can connect to the target | a session named `exponetdb/...` or a backup tool cannot be cancelled or terminated, not even by break-glass | D1.4 | protect by `backend_type`, role, and the backend pids ExponetDB itself opened |
| 2 | ledger `operation_id` | target ledger row | evidence for production; healing of the mirror ("this row was written by an operation of this target") | B1.2; `B/contract.md` §2.5; DF-08 | evidence only from the mirror and the Control Store's verification record |
| 3 | ledger events (`nontx_started`, `ledger_reconciled`) | target ledger | the operation `migration.resume` closes; a hand-written `nontx_started` blocks all plans (`MIGRATION_INCOMPLETE`) | D0.7; `R/verdicts-R2.md` TC-025 | derive the stuck operation from the Control Store (`stuckOperationOf`) |
| 4 | `reverted_at`, `fingerprint_after` | target ledger | not in the divergence comparison: a hand-set `reverted_at` is `MIGRATION_DEPENDENCY_MISSING`, a changed `fingerprint_after` plans normally | `R/verdicts-R2.md` TC-025 (NOT FIXED) | compare every ledger column the mirror holds |
| 5 | `migration_verifications` rows | target | evidence (never cross-checked with `verification_mirror`) | B1.2 | read verification from the Control Store |
| 6 | identity marker | target | clone and restore detection | `B/contract.md` §7 | marker copies by `CREATE DATABASE ... TEMPLATE` are caught by the database oid binding; a physical restore with the same system identifier is not distinguishable |
| 7 | node heartbeat absent | agent | `pendingRestart: false`, `serverCertificateExpiresAt: null` shown as facts | R2.3 | a nullable "not reported" |
| 8 | `pgbackrest verify` `status: ok` | backup engine | "verified" backup; the catalog has no gap computation | R1.1 | compute continuity from the segment list |
| 9 | client plan request: `defaults`, `lint`, `lintProfile`, `invariants`, `source` | whoever plans | the checksum; which production rules are lowered | B1.3, B1.8 | server-side project record |
| 10 | author text in `verify.sql` comments (`-- check:`), lint messages, object names | bundle | the plan view, the approver's review, MCP `plan_get` without the `untrusted` marker | D1.3 | closed schema, `untrusted` members |
| 11 | worker as sole witness of outcome truth and of mirror rows | Control Store role | outcome pairs (`unknown` to `applied`), `UPDATE` of the mirror | `D/new-bundles-security-review.md` §2.2; D0.2 | column-level guard trigger (D0 tested one) |

Rows 2 to 5 are one weakness (SW-7): the ledger is the single source of truth for "what is applied" (C-19), the mirror is the check on it, and the evidence rule uses the first and not the second. Rows 1, 3 and 11 are SW-6. **Proposals that read more from the target** (catalog facts, `pg_stat_activity` for a preflight, P-02) add rows to this table; each must be advisory input to a risk estimate, marked with its source and time (C-28), never an input to an authorization decision.

## 9. Resource containment

| Input | Bound that exists | Measured effect | Evidence |
|---|---|---|---|
| nested block comments, 160 KB (depth 40,000) | 4 MiB file; 200,000 tokens (comments are not counted) | 9.1 s in libpg_query, 38 s for analyze + lint, one blocked thread; x4 per doubling; extrapolated about 3 h at the 4 MiB limit | B2.1; `RESULTS.md` |
| 6 valid bundles of 660 KB (198,000 tokens each) | 200,000 tokens per **parse** | 6 bundles: V8 fatal, exit 134, at the documented 259 MiB heap; 4 bundles 546 MiB RSS in a 512 MiB container; the request allows 50 bundles and 32 MiB | B2.2 |
| chain of n bundles | none per plan | lint 0.23 / 0.27 / 1.1 / 7.1 / 61 s for 50 / 100 / 200 / 400 / 800; plan of 1,000: 53 s, or `control_store_timeout` (idle-in-transaction 60 s) under load | B2.3 |
| `-- check:` line plus spaces in `verify.sql` | 32 MiB body | 80,000 spaces 7.1 s (x4 per x2); 1 MiB is about 20 minutes, on `serve` and on the worker | R1.2 |
| 28 MiB body, caller without the permission | 32 MiB body limit | read, parsed and validated first: 1,387 ms, +118 MiB RSS, then 403 | D1.1 |
| 512 MiB sparse `up.sql`, CLI | 4 MiB file limit | `readFile` reads it all: +520 MiB RSS | B2.10, B1.11 |
| legacy import | 1,000,000 tokens per request | the figure is an extrapolation, no 512 MiB measurement; the first real import uses 62 percent | R2.4 |

What held: 20 hostile SQL shapes finished within 10 s and 512 MiB with `--liftoff-only`; YAML alias bombs 13 ms; the graph library orders 5,000 nodes in milliseconds (`RESULTS.md`).

**Structural reading.** Every bound is attached to the unit the author of the guard was thinking about (a parse, a file, a statement). None is attached to the thing that is scarce: the event loop and heap of `serve`, or the open Control Store transaction. `overview.md` §2 says the role split exists for "isolation of long-running database work from request handling" and that `serve` "faces the internet"; plan creation and lint nevertheless run synchronously in `serve`, and the plan runs inside one Control Store transaction. The same shape appears at acceptance: `acceptPlan` takes the plan row `FOR UPDATE` and then awaits `kind.checkBindings`, a live TLS read of the target and of the evidence target with a 60 s statement timeout, inside that transaction, on a pool of 10 connections shared with every other request (E2 read: `accept.ts:150-190`, `plans.ts:331-340`, `kind.ts:184-210`, `runtime.ts:56-62`; `B/contract.md` §4 lists this as an observation for block C). The product already has the right pattern for the first problem: ADR-0028's data-read lane, where `serve` admits and the worker runs. See `F/e2-notes.md`, N-C.

**Cheapest fix.** In one afternoon: a nesting-depth limit and comment counting in the token bound (B2.1), a total token budget per request (B2.2), the linear regex (R1.2), and authorization before the large-body parse (D1.1). Structurally: one per-request work budget object, and analysis moved to the lane.

## 10. Test architecture

*Facts.* At the tree under test the suites pass: 10,383 unit tests, 1,716 integration tests, 52 browser tests, biome, typecheck, build, boundaries, secrets (`A/README.md`, **interim**). The 817 conformance cases written for this campaign fail 48 times, each failing case being a finding (`B/conformance/RESULTS.md`).

| Weakness | Evidence |
|---|---|
| **Whole invariant classes have no test.** B1's static matrix names a missing class for 10 of 15 invariants: no TZ/LANG/runtime matrix (I1), no deep or wide graph (I3), no forbidden-statement matrix (I4), no differential fuzz against the server (I5), no kill matrix over the phases (I6), no SIGSTOP/lease or clone test (I8), no replay (I10), no `ls1` recomputation from `psql` (I11), no test for known-id evidence spoofing although `staging-production-policy.md` §6 lists it (I12), no memory/CPU measurement per hostile input (I14). | `B/invariants-matrix.md` "Gap" column |
| **No oracle for lock and rewrite facts.** The classifier is never compared with PostgreSQL's catalog (relfilenode, `pg_locks`). B2 built one oracle for "cannot run in a transaction block" (40 statements: 1 miss, B2.5); B3 built the rewrite/lock oracle by hand on PostgreSQL 17 only, 16 and 18 NOT RUN. | `B/conformance/I4-classifier-vs-server.int.test.ts`; `B/ddl-hazard-matrix.md` NOT RUN |
| **A fix removes one instance of a class and nothing guards the class.** The quadratic regex of TC-004 was removed from `guardStrictness`; the identical class sits in `verify-checks.ts:45` (R1.2). | R1.2 |
| **Assertions removed or weakened with the code they exercised.** The host assertions for an agent-side `pg_hba` refusal were replaced by the plan-time refusal; nothing in the shipped tests covers the apply-time net for a rule the plan cannot judge (R2.5). `states.test.ts` `expect(verified).toBe(true)` became `verified \|\| previous === 'needs_attention'` (the new edge; still asserted in four other places, `R/verdicts-R1.md` TC-005). | R2.5; R1 TC-005 |
| **Fixes with no regression guard.** TC-049 (TZ), TC-050 (evals skip), TC-054 (visual hint): deleting the fix leaves CI green. | R3.1, R3.2 |
| **A check that CI cannot reach.** `verify-units.sh` fails whenever it is run as root and CI never runs it as root. | R2.6 |
| **The product's own bundles are tested more loosely than user bundles.** 24 of 45 Control Store bundles are not pinned (21 are; E2 read), none is linted in CI, and 11 of 23 mutations of the three new bundles still pass their `verify.sql`. | D0.4, D0.6 |
| **What the lab jobs cover.** The fix added a CI job `backup-lab` (the `pglab` test of the helper against real pgBackRest/restic, and the offline-runbook lab; `ci.yml`, E2 read). The fix's commit messages say these were not run on real engines; R1 ran them by hand and found the WAL-gap residual and the neighbouring defects (R1.1, R1.5). The job's own header says it does not cover the transient systemd units of the engine runs, the area of TC-012. **TO BE UPDATED BY THE LEAD:** the first GitHub result of `backup-lab` and of the 11 host scenarios on `d51da5d0` is not in the evidence; `A/` and S2 should state it. | `R/verdicts-R1.md` last paragraph; `.github/workflows/ci.yml` |
| **Environment-dependent defaults.** `bun run verify` aborted on the fix author's machine in `postgres#test` on absolute timing assertions under load (`R/baseline.md`); the default visual baseline set `local` matches no machine R3 tried (`F/decisions-R3.md` R3-D1). | |

*What is good and should stay:* fail-before runs for the fixes, golden vectors and the Go/TypeScript conformance mirror, integration against three PostgreSQL majors, and the ratio-style timing tests B2 wrote (they are robust on a loaded machine).

**Structural fix.** Adopt the B2 and B3 suites into the tree as a package (pure part in CI, about 6 minutes; integration part nightly; DDL-under-load as a manual job on a disposable server), and add four mechanical guards derived from code tables: exit coverage per kind and state, catalog code to emitter, CLI scopes to action registry, documents' commands to the registry (P-08).

## 11. Documents against behavior (item 4)

`E/docs-claims.md` checked 72 claims: 45 from `04-migrations/`, 27 from `12-operations/`.

| Verdict | Count | Share of 72 |
|---|---:|---:|
| HOLDS (ran) | 8 | 11 % |
| HOLDS (static: read from code with file:line, a lead and not a reproduction) | 31 | 43 % |
| VIOLATED | 17 | 24 % |
| UNCLEAR (needs the stack) | 16 | 22 % |

Of 56 settled claims, 17 are violated (30 %). Seven of the 17 were violated by a run (DC-007, 013, 014, 044, 049, 068, 069), ten statically. The six that bite at 3 a.m.: DC-046 (no rollback of an ExponetDB upgrade), DC-014 (the documented way out of a stuck lock does not exist), DC-037 (ledger divergence is not watched), DC-057 (RB-10 leaves the ledger mirror unaddressed), DC-049 (a plan across an upgrade is a 500), DC-044 (break-glass cannot be used). B1 adds 29 differences between the bundle lifecycle as documented and as built (`B/contract.md` §3): 10 CODE-WRONG, 8 DOC-WRONG, 7 UNDEFINED, 6 IMPLICIT (two rows have two tags). `[DECIDED]` text that is false today includes the approval window (DF-01, `operations-engine.md` §3.3 and §4.1) and the periodic reconciliation (DF-11).

**Two honest limits of this measure.**

1. *The sample was chosen for what hurts at 3 a.m., not at random*, so 30 % overstates the rate over all documents and understates it for runbooks.
2. *The audit is not of tagged statements.* The brief asked for 60 `[DECIDED]` and `[OBSERVED]` statements. The two folders carry 182 `[DECIDED]`, 66 `[OBSERVED]` and 9 `[PLANNED]` literal tags (E2 count). E1's table of 72 names a literal `[DECIDED]` on 3 rows and a literal `[OBSERVED]` on 1 (DC-058, UNCLEAR); the other 68 are normative sentences in documents whose status header says "Baseline ... accepted", with no tag on the sentence. E2 checked mechanically that the 63 paragraphs tagged `[OBSERVED]` cite only paths that exist (13 of them cite a code path, 0 dangling); the behavior of the 66 `[OBSERVED]` statements was **not** run. **NOT DONE: the `[OBSERVED]` half of item 4 is thin.**

**Structural cause.** A reader cannot tell from the document which sentences are true of the code today: `[DECIDED]` has no date and no check; `[OBSERVED]` has a date and rarely a path. Nothing links a sentence to a test. **Cheapest fix:** E1's `cmdcheck.py` as a CI step over the two folders (it finds `lock-key`, `ca init-root`, `dev seed`, four policy rule ids), and a rule that every `[DECIDED]` sentence about behavior names the test that pins it or is marked `[PLANNED]`.

## 12. Recoverability from the CLI alone (item 5), counts

`E/recoverability.md` examined 21 failure states: 11 recoverable with the CLI alone given the right scope (R2 partly, R3, R4, R7, R9, R11, R13, R15, R17, R18, R19); 5 need the Web App or REST (R1, R8c, R10b, R12, R14); 3 have no exit from any interface (R5, R6, R16); 1 cannot be rolled back (R20); 1 has an unaddressed blast radius (R21). The three dead ends are one defect (SW-1). A preset detail matters in an incident: `operator:prod` holds `migrations.apply:prod` but not `migrations.import` (needed by `ledger reconcile`), `restore.execute`, `operations.recover` or `breakglass.activate`, so the operator meets `INSUFFICIENT_SCOPE` mid-incident and must log in again with `admin`. **TO BE UPDATED BY THE LEAD when S1 reports:** every path marked static in `E/recoverability.md` has a stack step; the count of steps for R5, R6, R20 and R21 stays "infinite" or "restore" until then.

## 13. Open items for the lead

* Replace the labels of section 0 by `VC-nnn` after numbering.
* `TO BE UPDATED` when S1/S2/A report: section 10 (CI results of `backup-lab`, host scenarios, the unit/integration counts), section 12 (stack confirmation of the static recovery paths), section 2 SW-1/SW-5 "Seen" columns (confirmed or not), and the restore numbers behind P-12 in `E/proposals.md`.
* Three new findings are in `F/e2-notes.md`. Nine vocabulary findings, `VOC-1` to `VOC-9`, are announced by `E/vocabulary.md` ("a Y that is a code or doc fix is a finding (VOC-n in F/findings-E1.md)") but only one (`VOC-10`, the program name) is in `F/findings-E1.md` as E1.16; the lead should confirm whether the other nine are wanted as P3 entries.
