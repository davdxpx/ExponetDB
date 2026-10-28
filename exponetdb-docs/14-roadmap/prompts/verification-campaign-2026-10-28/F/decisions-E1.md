# Open decisions raised by tester E1 (Block E, static structure review)

These are owner questions, not findings. Each has the options as E1 sees them and a recommendation; the
evidence is in `../E/` and the findings in `findings-E1.md`. Existing decisions are named by their `OD-n`
and are not restated.

## D-E1-1. How an operation in `needs_attention` is closed when no recovery plan can name it

- **Why now.** OD-58 (open, "built with option (a)") decided only the recovery plan that names an operation, and that exists for
  `migration.resume` and `migration.verify` alone. `recoverability.md` R5 and R6 show two classes with no exit: any kind
  outside the four migration kinds, and a migration operation with apply outcome `unknown` whose migration is not in the
  ledger. The documents promise `operation.force_release` (`concurrency.md:131`), which is not built.
- **Options.**
  (a) A new human-only, class `high`, re-authenticated action `operation close` (CLI and Web App) that moves a
  `needs_attention` operation to a final state, releases its domains, records a reason and the closer, and never re-executes.
  (b) Build `operation.force_release` exactly as `concurrency.md:131` describes (terminate the exact backend, mark the
  operation `needs_reconciliation`, audit), which leaves the operation to the reconcile that already failed.
  (c) Per-kind `verify` retry for node, backup, registry and drift kinds, and a timer-driven retry of `reconcile` when the
  outcome is `unknown`.
- **Recommendation.** (a) first, because it is the smallest change that closes every dead end and it is the owner's own
  OD-58 (b) in a safer shape; (c) for the node and backup kinds afterwards, so that most operations never need (a).
- **Cost / risk.** (a) one additive bundle (a new transition and, optionally, a new final state, see D-E1-6), a plan kind or an
  inline `high` action, tests per kind. Risk: closing an operation whose change really is half-applied; mitigate by
  requiring the closer to name the observed ledger state and by showing the live ledger read in the confirmation.

## D-E1-2. What the product promises for the rollback of an ExponetDB upgrade

- **Why now.** `upgrades.md:14-16` promises a one-release rollback without a schema rollback; the binary refuses any
  newer Control Store schema (`role.ts:229-233`). No pre-upgrade backup step exists in the upgrade runbook.
- **Options.** (a) Say plainly: no rollback after `control-store migrate`; roll forward or restore the Control Store from a
  dump taken before it; add the dump (and its verification) to the runbook as a required step and to the deploy checklist.
  (b) Make rollback real: allow a release to start against a newer schema when every unknown bundle is declared additive with
  a `minimumRelease` it satisfies (an ADR; touches the frozen startup check).
  (c) Keep the sentence and accept the contradiction.
- **Recommendation.** (a) now (a documentation and runbook change, no code); (b) only if the owner wants zero-downtime
  rollbacks later. Wave 11 should not start without (a), since production's first upgrade will be the first rollback decision.
- **Cost / risk.** (a) none. (b) a new compatibility contract between releases; a wrong "additive" label would let an old
  binary run against a schema it misreads.

## D-E1-3. The approval deadline: documents say 4 hours, code says never

- **Why now.** `operations-engine.md` §3.3 and §4.1 (`[DECIDED]`) describe an approval window (default 4 h, maximum 24 h) and a
  "window elapsed" cancel; the code has neither; OD-64 (open) lists "no deadline (today)" as option (c).
- **Options.** As OD-64: (a) cancel on plan expiry, (b) a separate approval deadline, (c) none.
- **Recommendation.** Decide OD-64 and edit §3.3/§4.1 in the same change: until then the `[DECIDED]` text is false. E1's
  preference is OD-64 (b) with (a) as the floor.
- **Cost / risk.** A worker task and one audit action; the risk is a cancel racing an approval (the guard already serialises on the
  operation row).

## D-E1-4. Exit codes for "a person must act" and for retryable infrastructure refusals

- **Why now.** `15-cli/README.md` §5 defines 4 as "a person must act" and 5 as "transport failure, server unavailable". Of the
  catalog, 17 codes map to 4, but `HUMAN_APPLY_REQUIRED`, `APPROVALS_PENDING_LIMIT`, `FEATURE_NOT_ACTIVATED`, `MIGRATION_INCOMPLETE`,
  `LEDGER_DIVERGENCE`, `TARGET_SUSPENDED`, `MIGRATION_ROLLBACK_BLOCKED`, `LEGACY_IMPORT_TRUNCATED` and `RECOVERY_REQUIRED` fall through to 1,
  and retryable 503s (`TARGET_UNAVAILABLE`, `TARGET_TLS_FAILED`, `NODE_OFFLINE`, `BACKUP_REPOSITORY_UNAVAILABLE`) also exit 1.
  Five of the 17 mapped codes are never emitted.
- **Options.** (a) Move the nine person-must-act codes to 4 and the four 503s to 5. (b) Keep 1 for domain failures and document that CI cannot tell. (c) Define a new code (7) for "state of the target blocks you".
- **Recommendation.** (a). Exit codes are a CI contract: changing them later breaks scripts, so decide before Wave 11 scripts exist.
- **Cost / risk.** Low; breaking only for scripts that test `$? == 1`.

## D-E1-5. Is ledger divergence watched, or checked at plan time only?

- **Why now.** `ledger.md` §5 documents a 10-minute reconciliation and a finding; no worker task exists (`docs-claims.md` DC-037).
- **Options.** (a) Build `ledger.compare` (per active target, observer read, raises `ledger_divergence` with the three lists, feeds `finding list` and the health roll-up). (b) Change the text: "checked when a plan is made".
- **Recommendation.** (a). A restore or a hand edit is exactly what an operator wants to hear about before the 3 a.m. change.
- **Cost / risk.** One more connection per target every 10 minutes; reuse the drift schedule's connector and backoff.

## D-E1-6. What a closed-by-recovery operation is called

- **Why now.** TC-005 closes a stuck operation as `verification_failed` with verification outcome `failed`, though nothing was verified and
  nothing failed (`supersede.ts:49-66`). OD-58 option (c) adjusted the state check but not the label.
- **Options.** (a) Keep `verification_failed` and add `closedBy` plus a plain sentence to every view. (b) A new final state `closed`
  (additive bundle: state CHECK, `state_admits`, `recovery_transition_allowed`; the operations bundle itself is frozen). (c) Leave it.
- **Recommendation.** (a) now (no schema change, fixes the truthfulness complaint in the views); (b) together with D-E1-1 (a) if the
  owner wants the close action to have its own state.
- **Cost / risk.** (b) touches a frozen bundle's neighbours and the Web/CLI/MCP state catalogs (10 states today).

## D-E1-7. Which human-proof actions may be CLI-only, Web-only or both

- **Why now.** Several documents say "the Web App or the CLI" for actions the CLI cannot do: `drift.accept` (`drift-detection.md` §5),
  break-glass activation (`staging-production-policy.md:179`), `operation.force_release`, bundle ingest, agent adoption
  (`onboard-external-cluster.md`: REST with a bearer token the CLI never shows). `approval approve` is browser-only by design (ADR-0026).
- **Options.** (a) Declare a table "action × interface" (CLI-complete except approvals and break-glass activation) and add the missing CLI
  commands via the existing browser step-up (`--step-up`). (b) Declare that those actions are Web App only and fix the documents.
- **Recommendation.** (a): the brief's own question (can a person with the CLI and the runbook get out) is a product requirement for Wave 11.
  Break-glass activation may stay browser-only (its channel is OD-21).
- **Cost / risk.** Each command reuses the plan + apply pipeline; low.

## D-E1-8. Naming: "baseline", "recovery", and the program name `exponetdb`

- **Why now.** `vocabulary.md` shows "baseline" for a ledger origin and for a drift reference (and a CLI help text that makes one write the
  other); "recovery" for four things; two programs called `exponetdb`.
- **Options.** (a) Rename in docs and help only: *ledger baseline* / *drift reference*; *recovery plan* → *closing plan*; server entrypoint documented as
  `docker exec … exponetdb`. (b) Rename the identifiers too (`schema_baselines` → `drift_references`, the entrypoint to `exponetdb-server`).
  (c) Leave.
- **Recommendation.** (a) now; (b) only where a rename is additive (a new CLI alias). Identifiers in frozen bundles cannot change.
- **Cost / risk.** (a) none; (b) frozen-bundle and golden-vector constraints.

## D-E1-9. Documented-but-unbuilt behaviours: implement, delete or mark reserved

- **Why now.** `ORDER_DIVERGES_FROM_EVIDENCE` and the "production applies unordered overlapping migrations in staging's order" rule
  (`dependency-graph.md:114`, `[DECIDED]`); 12 further catalog codes with no emitter (`errors.md` §2); `hotfix_without_evidence` and
  `applied_not_in_source` findings (waived at G6, OD-65); `ledger.mirror_healed` (documented as not built).
- **Options.** (a) Implement the staging-order rule before Wave 11 (it protects exactly the first production apply of two independent migrations);
  delete or reserve the codes. (b) Mark them `[PLANNED]` and keep. (c) Remove the rule from the design.
- **Recommendation.** Decide per item; E1 would implement the staging-order rule only if REOSA's stream really has unordered overlapping
  migrations (the brief's lint `parallel_object_overlap` already forces an explicit edge on prod), otherwise (c), and always reserve or delete the codes.
- **Cost / risk.** (a) is a planner feature with its own PostgreSQL tests.

## D-E1-10. A lifecycle for stored bundle revisions

- **Why now.** `migrations.bundle_revisions` is immutable and there is no way to list, withdraw or archive a revision; a denied plan keeps
  the revisions it ingested (`state-machines.md` §4). Only the owner can say whether withdrawal should exist (it would be an additive
  `withdrawn_at` on a new table, not an update).
- **Options.** (a) Keep immutable, add read-only listing and a doctor (find revisions never referenced by a plan or a ledger row).
  (b) Add withdrawal of never-applied revisions. (c) Nothing.
- **Recommendation.** (a); (b) only if abandoned revisions turn out to clutter `migration status`.
- **Cost / risk.** (a) read-only; (b) a new table and a rule that a withdrawn id may still never be reused for other bytes.
