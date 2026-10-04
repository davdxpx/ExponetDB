# Legacy history import and baseline

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 6 (engine), Wave 10 (REOSA import) |
| Read before | [`ledger.md`](./ledger.md), [`dependency-graph.md` §6](./dependency-graph.md#6-baselines-and-imported-history), [`../03-database-model/schema-fingerprints.md`](../03-database-model/schema-fingerprints.md), [`../13-integrations/reosa-current-state.md`](../13-integrations/reosa-current-state.md) |

Existing databases arrive with history ExponetDB did not write. That history is
**not rewritten** and **not trusted blindly**. The import establishes, per target,
what is provably true, records it in the canonical ledger as imported history,
and creates a **baseline** that new migrations depend on.

## 1. What REOSA brings (the design case)

**[OBSERVED]** (REOSA audit 2026-10-04, details in
[`../13-integrations/reosa-current-state.md`](../13-integrations/reosa-current-state.md)):

- 454 SQL files in one flat directory, 377 distinct number prefixes, **60
  prefixes used more than once (137 files)**.
- Three ledgers: `supabase_migrations.schema_migrations` (keyed by the name typed
  at apply time; production's starts at `0020`), `drizzle.__drizzle_migrations`
  (journal covers 233 of 454 files and cannot build a database), and
  `public.applied_migrations` (local builds).
- At least 14 documented cases where the applied name differs from today's file
  name (renumbering after merge collisions); one ledger entry that stands for
  five files (`0032_0036_…`); one entry without a number (`0023`); on 2026-09-13,
  55 of 294 files had no name match in production's ledger.
- Effects present without ledger entries (`0000`–`0019` on production) and a
  ledger-less missing effect (`0014` on production).
- Conditional DDL: 37 files branch on `pg_roles`, 17 on `to_regclass`; one file
  creates date-dependent partitions; policies exist only where an optional role
  exists.
- Comment headers edited after apply.

Name matching cannot work here. **[DECIDED]** The import decides by **content and
objects**, uses names only as hints, and turns every contradiction into an explicit
review item.

## 2. Process overview

```
1 discover ─▶ 2 replay ─▶ 3 compare ─▶ 4 classify ─▶ 5 review ─▶ 6 baseline (planned op) ─▶ 7 verify ─▶ 8 freeze
```

Import is a planned, audited operation (`migration.baseline`, class `high`) per
target. Steps 1-4 are read-only and repeatable (`migration.import.analyze`); they
produce an **import report**. Step 6 writes.

### Step 1: Discover

Read-only, observer role on the target, plus the legacy source directory
(submitted as a bundle of files with a source reference, like normal bundles):

- every legacy file: name, executable-text checksum (`c1`, comments stripped,
  [`migration-bundles.md` §3](./migration-bundles.md#3-checksum-semantics)),
  source digest, parsed statements;
- every known ledger on the target, if present:
  `supabase_migrations.schema_migrations (version, name, statements)`,
  `drizzle.__drizzle_migrations (id, hash, created_at)`,
  `public.applied_migrations (filename, applied_at)`, and others configured per
  project;
- the target's full fingerprint document (managed scope) and object inventory,
  including roles referenced, extensions and schemas;
- the project's import hints (`legacy` section of `exponetdb.project.yaml`):
  known renames (alias table), merged entries, files that belong to other
  projects (for example `status_*` files that target the status database).

### Step 2: Replay

The legacy chain is replayed on a **scratch database** (disposable cluster on
the same PostgreSQL major version and with the same extension versions as the
target), in the project's declared legacy order (filename order for REOSA,
because that is the only order that builds a database: measured 454/454 succeed,
while the journal order fails at its first entry).

Prerequisites for the replay are declared, not guessed: bootstrap roles (for
REOSA: `anon`, `authenticated`, `service_role`, `platform_admin` and the roles
created in migrations), extensions and their schemas, conditional-role choices
(for example whether `agent_role_admin` exists on this target, read from the
target itself), and the replay date for date-dependent DDL (pinned to the
target's actual partitions).

During replay the engine records, after each file `k`:

- the derived structural expectations of file `k`
  ([`verification.md` §3](./verification.md#3-automatic-structural-expectations));
- which of them **still hold at the end** of the full replay ("surviving
  expectations"); expectations later overwritten by another file are marked
  `superseded` rather than missing.

The replay ends with fingerprint `F_replay`.

### Step 3: Compare

- **Global**: diff `F_replay` against the target's fingerprint `F_target`
  ([`../03-database-model/drift-detection.md`](../03-database-model/drift-detection.md)).
  Every difference becomes a drift item: object only in replay, only in target,
  or different (with attribute-level detail: column type, policy expression,
  ACL entry, function body digest).
- **Per file**: evaluate each file's surviving expectations against the target.
- **Per ledger entry**: match entries to files with the strongest available
  evidence, in this order:

| Evidence | Strength | How |
|---|---|---|
| Drizzle `hash` equals SHA-256 of a file's bytes | strong (content) | hash comparison; independent of names |
| Supabase `statements[]` equal a file's statements | strong (content) | parse both, compare normalized statement texts |
| Alias table entry (`0252_task_sync_runs` → `0260_task_sync_runs`) | medium (curated) | project hints |
| Exact name match | weak | hint only |
| Numeric prefix match | none | never used alone (60 prefixes are ambiguous) |

### Step 4: Classify

Each legacy file gets exactly one state per target:

| State | Meaning | Default resolution |
|---|---|---|
| `recorded_present` | a ledger entry maps to the file by content or curated alias, and its surviving expectations hold | import as applied |
| `unrecorded_present` | no ledger entry, but surviving expectations hold (for example REOSA `0000`–`0019` on production) | import as applied, provenance `effect_observed` |
| `recorded_missing` | a ledger entry exists, expectations fail | **review item**; never imported as applied silently |
| `unrecorded_missing` | no entry, expectations fail | **review item** (was it never applied, or is it obsolete?) |
| `superseded` | all expectations were overwritten by later files in the replay; nothing file-specific to check | import as applied if a later file that supersedes it is `*_present`; otherwise review |
| `not_applicable` | file belongs to another project or target (hints) | not imported for this target |
| `ambiguous` | contradictory evidence (two files claim one entry, an entry maps to several files without a curated rule, expectations partly hold) | **review item** |

Ledger entries that map to no file (for example applied migrations whose files
were deleted or never merged) become review items `ledger_entry_without_file`.

**[OBSERVED]** Expected REOSA review items include: `0014` on production
(`recorded_missing` or `unrecorded_missing`: the `tenant_members_select_own`
policy still uses `auth.uid()`), the merged entry `0032_0036_…`, the unnumbered
`0023`, the status-database subset, and every `agent_role_admin`-conditional
policy.

### Step 5: Review

A human (role with `migrations.import` on the project) resolves every review item
in the Web App. Possible resolutions, each recorded with a note:

- **accept as applied** (with reason);
- **accept as not applied** (the file's effect is intentionally absent on this
  target, e.g. a staging-only experiment);
- **mark as divergence to fix after baseline**: imported as *not applied*, and a
  forward migration (first post-baseline bundle) will establish the intended
  state. For REOSA `0014`, the expected resolution is: divergence recorded, then a
  new bundle that replaces the policy, applied through the normal staging-first
  path (which, for production, requires owner approval because it changes RLS);
- **fix the import inputs** (wrong alias hint, missing bootstrap role) and re-run
  analysis.

Global drift items (objects present in the target that no legacy file creates,
such as REOSA's `rls_auto_enable()` event trigger that exists only in the
databases) are resolved the same way: accept into the baseline as
`unmanaged_but_present` (recorded, fingerprinted, flagged), or schedule removal.

The import cannot be applied while unresolved review items exist.

### Step 6: Baseline (writes)

`migration.baseline` plan → approval (prod tier) → apply:

1. Take the target schema lock.
2. Initialize the `exponetdb` schema if absent ([`ledger.md` §4](./ledger.md#4-lifecycle-of-the-exponetdb-schema-in-a-target)).
3. Insert one ledger row per imported legacy file:
   `migration_id = 'legacy:' || <file stem>`, `origin = 'legacy_import'`,
   `checksum = 'sha256:c1:…'` (executable text of the file **as imported**),
   `checksum_provenance` = `legacy_tool_hash` / `legacy_applied_statements` /
   `legacy_file_at_import` / `unknown` according to the evidence, `name` = file
   stem, `source` = the repository reference, `applied_at` = earliest known
   ledger timestamp if any, else the import time (with a flag in `source`).
4. Insert the baseline row: `migration_id = 'baseline:<slug>'`,
   `origin = 'baseline'`, checksum = hash of the import report, fingerprint
   before/after = `F_target`.
5. Record `imported` and `baselined` events; `ledger_meta.baseline_id` is set.
6. Store the import report (review decisions, aliases, divergences) in the
   Control Store, linked from the baseline.

Legacy ledgers on the target are **left in place**, untouched; they are history.
After cutover they can be dropped in a later, deliberate migration.

### Step 7: Verify

L1/L3 verification of the baseline: the target's fingerprint still equals the one
recorded; every `accept as applied` row's surviving expectations hold. The
baseline is `passed` only then.

### Step 8: Freeze

After baseline, the legacy directory is **frozen**:

- New migrations are bundles that depend on `baseline:<slug>` (or later bundles).
- Changing the executable text of a legacy file is `MIGRATION_CHECKSUM_MISMATCH`
  against its imported checksum. Comment edits are fine (the checksum ignores
  comments).
- Adding a new legacy-format file after the baseline is refused by the CLI lint
  (`legacy_file_after_baseline`) and by the engine (it is not a bundle).
- Renaming a legacy file is refused (identity is the imported stem; the alias
  table can record old names, not new ones).

## 3. Multiple targets of one project

Each target (staging, production) is imported separately, producing its own
report and its own baseline row; the **baseline id is the same** for all targets
of the project (`baseline:reosa-platform-2026-11`), because it names the
cut-over point of the stream. Their fingerprints at baseline may differ; that
difference is the starting value of lineage tracking
([`staging-production-policy.md` §1.3](./staging-production-policy.md#13-lineage-structural-sameness)).

## 4. Targets without history

A new target that should start at the baseline (for example a fresh preview
database, or a restore drill target) is **materialized**: either by restoring a
baseline dump of the evidence environment or by replaying the legacy chain, then
stamping the baseline row with the replay's fingerprint and the import report of
the materialization. It never receives legacy rows claiming history it did not
have; its rows record `checksum_provenance = 'legacy_file_at_import'` and
`origin = 'legacy_import'` with `source.materialized = true`.

## 5. Moving databases between providers

When a database moves (for REOSA: from the hosted provider to `reos-db-01`), the
`exponetdb` schema moves with the data **if it is included in the dump**.
**[DECIDED]** The move procedure dumps the `exponetdb` schema together with the
application schemas, and the restore operation re-stamps the identity marker with
a new generation; the ledger and baseline remain valid because the database
content did not change. If the import is done only after the move, it is done on
the new target directly. See
[`../13-integrations/reosa-integration.md`](../13-integrations/reosa-integration.md).

## 6. Edge cases

| Case | Handling |
|---|---|
| Two legacy files with the same number | Identity is the full file stem, which is unique; numbers are not used. |
| File renamed after apply (applied name differs) | Alias table maps the applied name to the stem; content evidence (drizzle hash, statements) confirms independently. |
| One ledger entry for several files | Curated rule in hints (`0032_0036_… → [0032_…, …, 0036_…]`) plus statement comparison. |
| File edited (comments only) after apply | Executable checksum unchanged; no issue. |
| File edited (executable text) after apply | The imported checksum is of today's text; the replay uses today's text; if the target's objects match, it imports as present. Divergence is still caught by object comparison. |
| Conditional DDL took a different branch on the target | Surviving expectations differ; review item with the evaluated branch shown. |
| Date-dependent partitions | Replay pins the date to match the target's partitions; partition sets are compared as a family. |
| Objects created by hand, never in a file | Global drift item → `unmanaged_but_present` or removal. |
| Provider-managed schemas (`auth`, `storage`, `realtime`, `extensions`, `supabase_migrations`, …) | Excluded from managed scope by the project's configuration; never imported. |
| Extension in `extensions` schema on the source, `public` on the replay | Replay declares extension schemas to match the target; otherwise every vector column differs. |
| Legacy ledger table missing on a target | Fine; evidence comes from objects. |
| Target unreachable mid-analysis | Report marked incomplete; cannot be applied. |
| Import run twice | Analysis is repeatable; the baseline operation refuses if a baseline row already exists (a second baseline is a separate, deliberate `migration.rebaseline`). |
