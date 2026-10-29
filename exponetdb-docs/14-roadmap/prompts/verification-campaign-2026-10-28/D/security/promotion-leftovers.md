# I12 / I13 promotion and immutability, the leftovers of S4 (tester S7)

Tree `d51da5d0`, the disposable stack on `vc-3` (real `serve`, `worker`, Control Store, PostgreSQL 17 targets). Everything below ran against
lab targets (pairs `s7evi`/`s7prd`, `s7evib`/`s7prdb`, `s7evic`/`s7prdc`; each pair is an evidence environment and a production environment
with `evidenceFrom` set). Nothing touched another system. Scripts: `scripts/s7-promo-*.sh`; raw logs stay on the server in `/srv/work/logs-s7`.
S4's cases (`promotion.md`) are not repeated.

## Verdicts

| # | Case | Verdict | Result in one line |
|---|---|---|---|
| a1 | Swap the display names of the evidence and the production environment | PASS | applied (class `standard`, step-up); evidence is bound by environment **id**: the production plan is unchanged (`missing`, `deny`) |
| a2 | Re-point the production environment's `evidenceFrom` to another nonprod environment | PASS, **owner decision** | allowed by design: `registry.environment.update` is class `high`, needs `registry.manage` and a fresh passkey step-up, **no second approval** (`approvals.required` 0); afterwards a bundle applied and verified only on that other environment is `present` evidence (decision `require`, because the lineage is unknown) |
| a3 | Remove the evidence source (`--no-evidence-from`) | PASS | fails closed: evidence `missing`, plan `deny` |
| a4 | Flip the production environment to `nonprod` (which would make evidence `not_required`) | PASS | refused at planning: `REGISTRY_CONFLICT`, `details.reason: tier_in_use` (live targets carry the tier in their identity markers) |
| b1 | Evidence run applied, `verify.sql` returns false | PASS | operation `verification_failed` (apply `applied`, verify `failed`); the ledger row exists, the verification row says `failed`; production plan: evidence `unverified`, rule `migration.staging-evidence` fails, decision `deny` |
| b2 | Evidence run applied, `verify.sql` raises (`1/0`) | PASS | operation `needs_attention` (apply `applied`, verify `error`), evidence `unverified`, `deny`. Side effect, already known (B1 P1): this operation holds the evidence target's schema lock; the next apply on that target queued until I cancelled it |
| b3 | Applied and verified on the evidence target, then rolled back there (`down.sql`), then planned for production | PASS | before the rollback: evidence `present`, `allow`; after it: evidence `missing`, `deny` (a reverted row is not evidence) |
| c | **Forged evidence** (B1 second P2) | **FAIL** | see below: production accepts a bundle that was never applied on the evidence target, up to a successful apply on the lab production target |
| d1 | Same new id, different bytes, REST ingest and CLI plan at the same moment (3 rounds) | PASS (note) | both stored as revisions 1 and 2, no duplicate revision number, no 5xx; "exactly one wins" is not the model for an id that was never applied (`rewritten_unapplied`); each plan binds its own revision |
| d2 | Two byte-variants of one id planned for two targets, then applied **at the same moment** | **FAIL** | both operations `succeeded`; the target ledgers hold the **same migration id with two different checksums** |
| d3 | The same, applied one after the other (both plans made before the first apply) | **FAIL** | both `succeeded`; no re-check at apply; the window is the lifetime of the plans (their `expiresAt`, minutes after creation) |
| e1 | Applied content cannot change: REST ingest and CLI plan with other bytes after the apply | PASS | `409 MIGRATION_CHECKSUM_MISMATCH` on REST, `MIGRATION_CHECKSUM_MISMATCH` (`details.knownChecksum`) on the CLI, for the same and for another target; the identical bytes again are `unchanged`; one stored revision |
| e2 | The same through MCP (`migration_plan` with inline `bundles`) | NOT RUN | the MCP tool accepts inline bundles (`contracts/src/mcp/tools.ts:492-514`) and calls the same `planMigrations` and `ingestBundles`, so the REST result should hold; S4's MCP client was not re-driven (no time); static only |
| e3 | The dangling stored bundle (first campaign TC-008) | PASS (mitigated), residual P3 | see below |

## c. Forged evidence (FAIL, P2)

Setup (script `s7-promo-forged.sh`): on the evidence target `lab_s7evi`, a genuine bundle `real-a` was applied and verified (operation
`op_01M64WCZ…`). As the PostgreSQL superuser of that database (the "database owner" of the brief) I then inserted, for bundles that were
**never applied there**, a row into `exponetdb.schema_migrations` (checksum of the bundle as production will submit it, a real operation id,
`fingerprint_before` NULL or copied from the genuine row) and a `passed` row into `exponetdb.migration_verifications` (the bundle's verify
digest; well-formed `vfy_` id). Then `exponetdb migration plan --target lab/platform/s7prd <id>`.

| Variant | `operation_id` in the forged row | `fingerprint_before` | Evidence | Decision |
|---|---|---|---|---|
| baseline (no forged row) | - | - | `missing` | `deny` (`migration.staging-evidence`) |
| F | the genuine apply operation of the evidence target | NULL | `present`, lineage `unknown` | `require` (an approval; rule `migration.fingerprint-lineage` unknown) |
| F2 | the same | copied from the genuine row | `present`, lineage `match` | **`allow`**, no failing rule |
| F3 | id of a **`registry.environment.create`** operation (not a migration, no target) | copied | `present`, lineage `match` | **`allow`** |
| F4 (valid ids) | the genuine apply operation | copied | `present`, `match` | **`allow`, then `plan apply --yes` on the lab production target: operation `succeeded`, apply `applied`, verify `passed`**, ledger row on production |

So production accepted a migration that staging never ran, on the strength of two hand-written rows and any operation id of the installation.
The product has a signal for it: after the forgery `exponetdb migration status --target <evidence>` shows `Mirror: out of sync`, and the next
**apply plan on the evidence target itself** is refused with `LEDGER_DIVERGENCE`. The evidence read does not consult either (B1: attribution by
operation id alone, `evidence.ts:181-190`, verification read from the target and never from `migrations.verification_mirror`).
The precondition is write access to the evidence database (a database owner or superuser there), not a Control Store credential or an
ExponetDB role; the severity stays P2 as in B1, but the consequence is now shown end to end.

Smaller observation (P3): the first try used a verification id that is not a `vfy_` plus ULID. The plan was stored with decision `allow`, and
the **apply** then answered `PLAN_STALE` with `changedBindings: [{binding: "content", actual: "invalid"}]`. The CLI prints only "Create a new plan"
(ER-6 of E1: the details are JSON only). A plan whose content cannot be applied should not be created as `allow`.

## d. The ingest race and the id that lands twice (FAIL, P2)

`ingestBundles` (`store.ts:151-252`) refuses an id whose other checksum is **already in the ledger mirror** (`appliedElsewhere`), but only at
ingest and plan time. The apply does not repeat it. Script `s7-promo-immutability.sh` (d2) and `s7-promo-immutability2.sh` (d3):

```
variant A planned for t1, variant B planned for t2 (same id), both plans active
apply A and apply B at the same moment  ->  succeeded / succeeded
ledger t1: 01M64ZDY44ZFZ1G3FP1987CQWC s7-imm-z sha256:c1:b1c46e86...
ledger t2: 01M64ZDY44ZFZ1G3FP1987CQWC s7-imm-z sha256:c1:5841ee62...
next plan of variant A for t2 -> MIGRATION_CHECKSUM_MISMATCH
the sequential variant (apply A, then apply B, plans made before) gave the same
```

Invariant I13 ("the same id with other bytes is refused everywhere") is therefore a plan-time check with a window of one plan lifetime, not a
property of the applied history. Promotion is **not** affected: the production plan compares the checksum with the evidence ledger row and
throws `MIGRATION_CHECKSUM_MISMATCH` on a difference, so production cannot receive bytes the evidence environment did not run. The harm is
two nonprod targets with a different meaning for one id, found only by the next plan.

## e3. The dangling stored bundle (TC-008, mitigated)

- A bundle whose `dependsOn` names an id that exists nowhere, planned from the CLI: `MIGRATION_DEPENDENCY_UNKNOWN` with `details.missing`;
  **nothing is stored** (the ingestion is rolled back with the failed plan). After removing the directory, the default plan of the other
  bundles works for the same and for a second target.
- The same bundle stored through `POST /projects/{id}/bundles` (no planning): `200 stored`. Planning the stored id or a set that contains it:
  `MIGRATION_DEPENDENCY_UNKNOWN` naming the missing id; planning another stored id of the project: `allow`. So it no longer poisons the project.
- Residual (B1 P3 / DF-05): the dangling id is listed as `pending` by `migration status` for every target of the project, forever, and the
  store has no way to retire it.

## Open decisions for the owner (copied to `F/decisions-S7.md`)

1. **Who may change `evidenceFrom`.** Today one person with `registry.manage` plus a passkey step-up can re-point production's evidence source
   to any nonprod environment, with no second approval and no cooling period; the audit event lists the field name only (`changes: ["evidenceFrom"]`),
   not the old and new environment (the plan keeps them). Options: two-person approval for `evidenceFrom`/`tier`; allow only environments of a
   lower `rank`; record before/after in the audit event.
2. **Where the "one id, one checksum" rule is enforced.** Plan time (today), or also at apply under a project-level unique claim.

## Not run

- MCP wire run of the immutability case (e2).
- A verified-then-restored evidence target and an old plan after a policy change (S4's NOT RUN list); the restore path is in `C/backup-restore`.
