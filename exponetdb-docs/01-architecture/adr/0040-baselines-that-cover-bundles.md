# ADR-0040: A baseline that covers bundles applied outside ExponetDB

| | |
|---|---|
| Status | **Accepted for development** (owner decision OD-72 (a), 2026-11-04) |
| Date | 2026-11-04 |
| Builds on | [`../../04-migrations/legacy-import.md`](../../04-migrations/legacy-import.md) Steps 6 and 7, [`../../04-migrations/staging-production-policy.md`](../../04-migrations/staging-production-policy.md), [ADR-0039](./0039-observed-targets-on-hosted-providers.md) |
| Related | [OD-72](../../00-product/open-decisions.md#od-72-a-production-baseline-that-covers-bundles-applied-outside-exponetdb), [G10 record](../../14-roadmap/gates/10.md) §1a |

## Context

**[OBSERVED]** (code at `6a9c840c`) A project's bundle stream is shared by its targets, and
planning decides what is pending from the target's own ledger: only rows of origin
`exponetdb` count as applied bundles; `legacy_import` rows are skipped
(`planOrder`, `packages/migrations-engine/src/planner.ts`).

A target can receive the effect of stream bundles before ExponetDB manages it. The case is
REOSA production: its staging got 40 bundles through ExponetDB, while production received the
same SQL as plain legacy files (outside ExponetDB) and was then moved to a host ExponetDB
manages. Imported with the project's baseline id, production would list all 40 as pending and
every new bundle would pull them into its plan. A different baseline id breaks every bundle
that depends on the shared one (`MIGRATION_DEPENDENCY_UNKNOWN`). A second baseline
(`migration.rebaseline`) and materialization are not built, and the baseline operation refuses
a target that already has one: the coverage has to be part of the **first** baseline.
Hand-written ledger rows are not an option (they bypass the engine and the mirror).

## Decision

**[DECIDED]** The baseline plan request takes an optional list `covers` of stream bundle ids.
Each covered bundle becomes a ledger row of its own in the same transaction as the baseline,
and planning counts it as applied.

1. **What may be covered (plan time).** Every id is a stored bundle of the target's project
   (its newest revision). The set is closed under `dependsOn`: each dependency is another
   covered id or the baseline itself; anything else is `MIGRATION_DEPENDENCY_UNKNOWN`. A
   covered bundle without dependencies is refused (`MIGRATION_DEPENDENCY_MISSING`): in a stream
   with a baseline only baselines are roots (`unanchored_root`), so every later plan would fail. On a
   production target each covered revision has staging evidence, read live with the same
   function as a migration plan (`collectEvidence`: the same id and apply checksum on the
   evidence target, not reverted, trusted, its latest trusted verification passed with the same
   verify digest); anything but `present` refuses the plan (`STAGING_EVIDENCE_MISSING`, or
   `STAGING_EVIDENCE_UNREACHABLE`). There is no break-glass. A nonprod target needs no evidence.
   On production a covered bundle must have a `verify.sql` (`MIGRATION_BUNDLE_INVALID`,
   `missing_file`): without one nothing would ever check its effect there. Each `verify.sql` is
   admitted and resolved on the target as the observer, and the consumer code its checks call
   is bound into the plan, as a migration plan binds it (a verification fails on code that
   changed since). The apply re-reads the staging evidence (binding `evidence`).
2. **No dry run at plan time.** **[OBSERVED]** `serve` opens observer sessions only
   (`packages/registry/src/connect.ts`), so a covered bundle's `verify.sql` cannot run as the
   verifier while planning. It runs in the worker with the baseline's verification (point 5).
   An operator who wants certainty before the irreversible baseline runs the checks read-only
   on the target by other means first (for REOSA production: the plan's pre-check step).
3. **The rows (apply).** Before the `baseline:<slug>` row (so they are part of the history, not
   the chain after it), one row per covered bundle: `migration_id` = the bundle id, origin
   `legacy_import`, the revision's name, apply checksum, source and verify digests and
   dependencies, provenance `legacy_applied_statements` (its statements reached the target
   outside ExponetDB), `source` naming the report, `covered: true` and the evidence target. One
   `imported` event each, with `covered: true`. The target ledger's schema does not change (no
   new origin, so existing targets need no ledger upgrade).
4. **Planning.** A `legacy_import` row whose id is a bundle id (a ULID, never `legacy:<stem>`)
   counts as an applied bundle with its recorded dependencies. A later plan of that id is a
   no-op on the same checksum and `MIGRATION_CHECKSUM_MISMATCH` on another, as for any applied
   bundle. `migration.dependencies-verified` needs nothing more: a covered row is checked by the
   baseline, whose latest run must pass on production.
5. **Verification.** The baseline's run gains a runtime layer: each covered bundle's
   `verify.sql` as the verifier, from the newest stored revision with the recorded apply
   checksum. A failed or erroring check fails the run. A corrected `verify.sql` is a new
   revision of the same checksum, so `migration verify baseline:<slug>` afterwards runs it: the
   way out of a check that was wrong for this target. The structural layer is unchanged: it
   checks the history's files, which on the design case carry the same statements. A covered
   bundle's derived expectations are **not** checked one by one **[DECIDED]**: they held where
   the bundle was applied and verified (the evidence), later bundles may have superseded some
   of them, and the history's own structural check plus the reviewed fingerprint already say
   what the schema is.
6. **Watches.** The hotfix watch (E16) and the source comparison (E18) read `exponetdb` rows
   only; covered rows are not hotfixes and not claims of a source.

## Consequences

- A target whose history holds the effect of stream bundles starts at the stream's real head:
  its next plan contains only what it really lacks.
- The evidence for a covered bundle is weaker than an apply on that target: the same bundle was
  verified elsewhere, its `verify.sql` holds here and the history's structure matches. That is
  stated in the plan (`analysis.covered`) and in the ledger rows (`covered: true`).
- A wrong cover cannot be undone: like the baseline, it is reviewed before it is approved.
- `migration status` lists covered rows as imported, each with its own share of the
  baseline's run: the runtime layer keeps one failure per covered bundle that did not hold.

## Alternatives

- **Bundles depend on the baseline only, production plans name ids.** No code, but the covered
  bundles stay pending on production for good and the graph loses its order. Rejected.
- **A new origin `covered` in the target ledger.** Clearer in the ledger, but the origin check
  is part of every existing target's ledger schema; a ledger upgrade for every target for one
  label. Rejected for `legacy_import` plus `covered: true` in `source`.
- **Check each covered bundle's derived expectations.** Fails where a later bundle superseded
  an expectation, with no reviewed excuse to fall back on. Rejected (point 5).
