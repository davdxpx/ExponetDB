# Legacy history import and baseline

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; corrected and extended in Wave 9 Part A (2026-10-21, [record](../14-roadmap/gates/9-part-a.md)): §2.2 CLI, §2.3 evidence strength, extensions and date pinning in §2 and §6 |
| Applies to | Wave 6 (engine), Wave 9 Part A (real Supabase-origin histories), Wave 10 (REOSA import) |
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

**[OBSERVED]** (owner's Wave 9 order §5.1 and §6, 2026-10-21; measured by the
owner on REOSA staging, `reos-db-01`; ExponetDB has not connected to it) The
history the first real import meets has grown and its ledgers have a known
shape:

| What | Shape |
|---|---|
| Files | about 530 flat files `NNNN_name.sql`, about 2.7 MB in all (within the request limits: 1 000 files, 4 MiB each, 32 MiB per body), with drizzle `--> statement-breakpoint` comments |
| `supabase_migrations.schema_migrations` | 391 rows; `version` a 14-digit timestamp (the apply time, e.g. `20261021180932`), `name` the file stem (e.g. `0445_account_service`), `statements` **one** element: the whole file with its comments stripped |
| `public.applied_migrations` | 187 rows; `filename text`, `applied_at timestamptz` (a name-only ledger) |
| Role DDL in files | some files contain role statements: at top level, `CREATE ROLE … EXCEPTION WHEN duplicate_object` inside `DO` blocks, and `GRANT role TO role` (§2.4) |
| Managed scope | `public`; `auth` is owned by the identity service's role and excluded; `supabase_migrations` holds the legacy ledger |

The Supabase ledger therefore names a file by its stem, not by
`<version>_<name>`, and holds one statement per file; §2.2 and §2.3 match
on that shape (Wave 9 Part A, A2).

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

**[DECIDED]** (Wave 9 Part A, A2) **Extensions** are declared by preparing the
scratch target, and checked, never guessed: before the first file runs, the
replay compares the installed extensions of both targets (name, schema,
version); any difference makes the report `incomplete` with
`extensions_differ:<name>` and replays nothing. **[DECIDED]** (Wave 9 Part A,
review round 1) The same holds for the **major version**: the replay runs and
parses on the scratch target's major, the baseline's verification on the
imported target's, so a scratch target on another major makes the report
`incomplete` with `major_differs:<target>/<scratch>` before any file runs. **Date pinning is not
implemented** **[NON-GOAL]** for now: PostgreSQL offers no way to fix `now()` or
`current_date` for one session, so date-dependent DDL replays at the replay
time; the partitions that differ appear as global drift items
(`only_in_target`, `only_in_replay`), which a person resolves like any other
drift (accept as `unmanaged_but_present`, or schedule the change).

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
  evidence, in this order (strength names as recorded per item, §2.3):

| Evidence | Strength | How |
|---|---|---|
| Drizzle `hash` equals SHA-256 of a file's bytes | `strong` (content) | hash comparison; independent of names |
| Supabase `statements[]` equal a file's statements one by one | `strong` (content) | byte for byte, only the ends of each statement trimmed (review round 1; Wave 6 collapsed whitespace, which also made data and commented-out text equal) |
| Supabase `statements[]` equal a file as a normalized statement sequence | `medium` (content) | both sides joined and normalized lexically like `c1`: comments, drizzle breakpoints and whitespace do not matter (§2.3) |
| … equal only when comments and whitespace inside the code bodies of `DO` blocks and `plpgsql`/`sql` routines are ignored too | `medium` (content; `low` before follow-up 2) | the same code ran; the stored body text differs, as for every routine the hosted connector applied; dollar-quoted data and other languages are compared as written (§2.3) |
| Alias table entry (`0252_task_sync_runs` → `0260_task_sync_runs`, or one entry → several files) | `curated` | project hints; for several files, the entry's statements are compared with the files' statements joined in file order and the stronger result counts; statements that differ contradict the alias (`alias_contradicted`, `weak`, §2.3) |
| Exact name match (Supabase `name`, or `<version>_<name>` of older ledgers; a runner's file name) | `weak` | a hint only: **never makes a file `recorded`** |
| Numeric prefix match | none | never used alone (60 prefixes are ambiguous) |

### Step 4: Classify

Each legacy file gets exactly one state per target:

| State | Meaning | Default resolution |
|---|---|---|
| `recorded_present` | a ledger entry maps to the file by content or curated alias, and its surviving expectations hold | import as applied |
| `unrecorded_present` | no ledger entry, but surviving expectations hold (for example REOSA `0000`–`0019` on production) | import as applied with checksum provenance `legacy_file_at_import`; the `imported` event records `basis: effect_observed` |
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

**[DECIDED]** (Wave 9 Part A, follow-up 3, F1, 2026-10-23) **What an
acceptance excuses.** The analysis records, per file, the surviving
expectations that did not hold on the imported target (`ImportReport.items[]
.failing`: file, statement, kind, the object by name and the aspects that
differ, such as `enabled`, `body`, `order`, `missing`; never a value read from
the catalog; the first 20 and how many). A decision that accepts the file as
applied (`recorded_present`, `unrecorded_present`) accepts exactly these: the
baseline's verification excuses them while they fail **the same way** and
nothing else (Step 7). The failing list is bound into the report digest, so a
baseline plan binds it. The Web App's decision dialog says so before the
decision is recorded: how many failing expectations the acceptance excuses
and the first ones, or that it excuses nothing. The CLI lists each item's
failing count in `migration import show` (FAILING) and answers `migration
import resolve` with the same statement for the decision it recorded (a
decision is changed by recording another one while the report is open). A
file whose expectations could not be read on the imported target (a check
that raised, for example on a schema the observer may not use) carries that
as one failure with the aspect `unreadable`: an acceptance excuses it
explicitly, and the verification records it the same way instead of
erroring. Such an acceptance excuses what nobody saw (the checks of that
file never compared anything), and both interfaces say so at the decision.
The recommended path is to give the observer the reads it lacks
(`USAGE` on the schema) and analyze again. A baseline recorded with such an
acceptance and later read by an observer that can see the schema compares
the file's expectations for the first time: they may then fail, not
excused, and a baseline cannot be recorded twice. Only a failure that
cannot be read is `unreadable` (a privilege the observer lacks, a name the
server refuses, a row the engine cannot decode); a timeout, a lock wait, a
cancel or a lost connection errors the run, which can then be retried. A file decided
`superseded` is not checked by the verification at all (its effects were
replaced). **[OBSERVED]** The first real baseline (`reos-db-01`, 2026-10-23)
needed 454 such decisions (column positions after `ADD COLUMN`, row security
enabled later by an event trigger, function bodies changed outside the
history, default privileges, constraint names of an older generator) and
could never pass, because Step 7 required every surviving expectation of
every accepted file to hold.

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
baseline is `passed` only then. **[DECIDED]** (Wave 9 Part A, review round 1)
A chain the imported target's major cannot parse checks no expectation, so
the verification fails (`structural.unparsed`, the first file it could not
read) instead of passing on the fingerprint alone.

**[DECIDED]** (Wave 9 Part A, follow-up 3, 2026-10-23)

- **Excused, not ignored (F1).** The verification checks what the review did
  **not** excuse: a failing expectation of a file a person accepted as
  applied is `excused` when the analysis recorded it failing in the same way
  (the same file, statement, kind, object and aspects). One that now fails
  another way, or one the analysis did not show (it held then, or the file
  was accepted without a decision), fails the run. It passes when the
  fingerprint is the reviewed one, nothing is unparsed and every
  non-excused expectation holds. A file decided `superseded` is not checked.
  A report analyzed before failures were recorded (`failing` null on its
  items) excuses every failure of a file a person accepted, bound by the
  fingerprint of the managed scope; expectations outside that scope (roles,
  objects in other schemas) of such a file are then excused unverified, a
  residual of the reports made before this change.
- **What failed is kept (F2).** The run stores, per layer, the failing
  expectations (file, statement, kind, object, the aspects that differ,
  `excused`; the first 200 and `failuresTotal`), `failed` (the non-excused
  ones) and `excused`. It is written to the target's history and to the
  Control Store's mirror, like every migration verification. `operation show`
  (`Operation.verifications`, REST), `migration show baseline:<slug>` and the
  Web App's operation page list them. The same holds for every kind that
  verifies: a migration's structural layer, its `verify.sql` checks and its
  engine checks keep their failures too. The MCP tools return the operation
  without its verification runs (the tool list's token budget; their
  `toolVersion` is unchanged); an agent reads the failures through the REST
  API.
- **A planned re-verification (F3).** `exponetdb migration verify
  baseline:<slug> --target …` (`POST
  /targets/{target}/migrations/baseline:<slug>/verifications`, the
  `migration.verify` kind and action) runs the same check again as a new,
  audited operation, with the baseline plan's report and decisions. A
  baseline's operation keeps its outcome (an operation never changes once it
  ended; `verification_failed` is final), so a baseline whose verification
  failed, because an engine read it wrongly or because something outside the
  managed scope was missing, gets a new run this way after the fix. It is
  refused for a baseline the target's ledger does not hold (`NOT_FOUND`), a
  reverted one (`MIGRATION_REVERTED`) and a `revision`. A run without a
  change fails the same way again; one on a target whose managed schema
  changed since the baseline fails on the fingerprint.
- **Drift reference (F4).** A passed run (the baseline's own or a planned
  re-verification) records the target's schema as its expected state for
  drift, as a verified migration does ([`drift-detection.md`
  §7](../03-database-model/drift-detection.md#7-wave-4-implementation-kind-c)).
  Before this change the baseline kind never did, so drift kept comparing
  with the registration snapshot.

**[DECIDED]** (Wave 9 Part A, follow-up 4, 2026-10-24) **A baseline after
later migrations.** Once a migration was applied on top of the baseline, the
live schema is no longer the reviewed one, so a re-verification compared
with the reviewed fingerprint alone could never pass again (observed on
`reos-db-01`: 0 of 13 349 failed, 234 excused, the engine layer failed on the
fingerprint).

- **Engine layer.** It accepts the live schema when it is the reviewed one,
  or when every ledger row after the baseline is a migration of ExponetDB,
  not reverted, whose latest verification passed, the first of them started
  at the reviewed schema (`fingerprint_before`), each next one where the one
  before ended, and the live schema is where the last one ended. A passed
  run says so (`engine.acceptedThrough`: how many migrations, the last one);
  anything else fails it, named (`schema after the baseline: <migration>`:
  never verified, its latest verification failed, the chain breaks, it was
  reverted, its bundle is not stored, or the live schema is not the one the
  last verified migration left). A reverted migration after the baseline
  ends the chain **[DECIDED]**: the baseline then verifies only again once
  the history after it is straight (a limit, as rollbacks of migrations
  on a baseline are rare).
- **Structural layer: the later migration counts.** The history's files are
  analyzed followed by the `up.sql` of every later migration (from the
  bundle store, by its applied checksum), the same supersede analysis as
  within the history: an expectation of a legacy file that a later
  migration superseded on purpose (a bundle that alters a table the history
  created, for example a column added) is not checked, because that
  migration's own verification checked what it left and the engine layer
  requires it verified. Everything else of the history is still checked and
  excused as reviewed.
- **Drift reference.** After later migrations the drift reference already is
  the newest verified schema (the last migration's); a passed baseline run
  then never moves it back to the baseline's state. Without later
  migrations a passed run records it as before.
- **A bundle on an unverified baseline.** On nonprod a bundle may be planned
  and applied on top of a baseline whose verification failed **[DECIDED]**:
  the baseline's state is visible in its runs, staging is where the history
  is brought straight, and the baseline is verified again afterwards as
  above. On production it is refused: rule `migration.dependencies-verified`
  (version 2) counts the target's baseline as a dependency of every plan, so
  a production plan on a target whose baseline has no passing latest
  verification fails it (`MIGRATION_DEPENDENCY_UNVERIFIED`; break-glass
  overridable like an unverified dependency).
- **An imported row's verification** **[DECIDED]** (follow-up 4 addendum).
  An imported row (`legacy:<stem>`) never has a verification run of its
  own; the baseline's verification checks it. `migration status` (REST, the
  CLI, the Web App's migrations page) therefore reads its verification from
  the baseline's latest run, marked `via: baseline:<slug>`: `failed` when one
  of its expectations is open there, `passed` when none is and the run kept
  every failure (with `excused`, how many of its failures a decision
  excused), the run's own status when the run did not keep every failure
  (more than 200, or a run of the release before follow-up 3, which kept
  two counts), `error` when the run could not read the history, and
  `pending` only while the baseline has no run. A row whose file was decided
  superseded is not checked and says so (`superseded`). **[OBSERVED]**
  Before, all 555 imported rows on `reos-db-01` read *verification pending*
  for good, also after a verified baseline (C-5). The MCP tool
  `migration_status` returns the same status without the additive fields
  (its definition and `toolVersion` stay pinned).

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

### 2.1 The legacy checksum

**[DECIDED]** (Wave 6) A legacy file has no manifest, so its checksum is a
construction of its own beside the frozen `c1` digests (no existing output
changes): the same canonicalization N1 to N5 as `up.sql`, framed under its
own prefix,

```
sha256:c1:hex( "exponetdb/legacy-checksum/c1" LF  frame("legacy.sql", X) )
```

with `X` the executable text. Comment edits never change it; any
executable change does. The source digest (`sha256:` of the text after N1
and N2) and the bytes digest (`sha256:` of the exact bytes, what a hash
ledger such as drizzle's compares) are kept beside it. Golden vectors:
`tooling/golden/legacy-checksum.json` (append-only).

### 2.2 Wave 6 implementation

**[DECIDED]**

- **Analysis** `POST /targets/{target}/migrations/import-analyses`
  (`migration.import.analyze`, human-only, `migrations.import` on the
  imported **and** the scratch target) stores the submitted files exactly
  (`migrations.import_files`, immutable) and a pending report, and plans
  `migration.import.replay` (class `standard`; the hints, the files' stems and
  checksums and both targets' generations are bound). The scratch target is
  a **registered** nonprod target of the same project, named in the request
  by id or path; no endpoint a client names is ever contacted, and a
  production clone is never made. The imported target must have no baseline
  (`CONFLICT`; a second one is `migration.rebaseline`).
- **Replay** (worker): under the scratch target's schema lock and only if it
  is empty (no object besides schemas, extensions and default privileges in
  the managed scope, no ledger row; otherwise the report is `incomplete`
  with `scratch_not_empty`), each file except the `notApplicable` ones runs
  in its own transaction as the project's execution role, through the same
  statement admission and engine guards as a bundle, without an L0 gate and
  without a ledger row. **[DECIDED]** (Wave 9 Part A, A3; a Wave 6 defect
  corrected) The execution role is checked exactly like an apply's: the
  planner reads its facts on the scratch target for the migrator and binds
  them (`executionRoleCheck`; rule `migration.import-execution-role` denies
  an unusable role, no override); acceptance refuses the plan when the alias
  now names another role (`PLAN_STALE`, `execution_roles`); and the worker
  reads the facts again on the migrator session under the scratch target's
  lock: a role that became unusable stops the replay before any file runs
  (report `incomplete`, `execution_role:<problem>`, `PLAN_STALE`).
  **[DECIDED]** (Wave 9 Part A, A4, A5; ADR-0034 §3, §5) The replay's role
  is the alias resolved for the **scratch** target's environment, and only
  that environment's declared exceptions excuse its `BYPASSRLS` (a
  declaration for the imported target's environment does not); the plan
  binds the declaration it relies on (`executionRoleExceptions`), shows it
  (`migration.execution-role-exception`), and a revocation before the
  replay is `PLAN_STALE`. A file that fails makes the report `incomplete`
  with the file, error and SQLSTATE; the scratch target is then consumed
  (re-create it for the next analysis).
- **Compare and classify** (worker, imported target read as the observer
  only): the replay's and the target's fingerprint documents; the legacy
  ledgers the request names (`supabase`, `drizzle`, `applied_migrations`);
  each file's surviving expectations over the whole chain, under the
  replay's search path. A read the observer is not allowed to make is
  reported (`ledger_unreadable:<ledger>`, `expectations_unreadable`), never
  read as empty. Evidence per file, strongest first: a hash ledger equal to
  the bytes digest (`legacy_tool_hash`), applied statements equal to the
  file's statements (`legacy_applied_statements`), a curated alias, an equal
  name (`name_hint`, weak; since Wave 9 it never records a file, §2.3). A
  numeric prefix is never evidence. States as in
  step 4; a file without derivable expectations is `ambiguous` unless content
  or curated evidence recorded it; ledger entries without a file and every
  global drift entry (`only_in_target`, `only_in_replay`, `differs`) are
  review items. A report holds at most 500 drift items; **[DECIDED]** (Wave 9
  Part A, A3) it records the true number (`driftTotal`) and whether it holds
  fewer (`driftTruncated`), and a truncated report is never baselined
  (`LEGACY_IMPORT_TRUNCATED`): narrow the managed scope or correct the inputs
  and analyze again. Nothing in the import path is cut silently.
- **Review** `POST …/import-reports/{id}/items/{itemId}/decision` records a
  state and a note per item (an open report only; the classification never
  changes). The report reads `resolved` when no item that needs a decision
  is undecided and it can become a baseline: **[DECIDED]** (Wave 9 Part A,
  review round 1) a truncated report, or one analyzed before drift totals
  were kept (no `driftTotal`), stays `open`. Planning a baseline refuses
  both (`LEGACY_IMPORT_TRUNCATED`, `driftTotal` null for the older report,
  which may have been cut at 500 items without a mark), and lists at most
  1 000 undecided items with their `total` (`LEGACY_IMPORT_AMBIGUOUS`).
- **Baseline** `POST /targets/{target}/migrations/baseline-plans` with a
  resolved report: the live fingerprint must equal the analyzed one
  (`SCHEMA_FINGERPRINT_MISMATCH` otherwise: analyze again). The plan binds
  the report digest (files, items, decisions), the rows to import and the
  target's fingerprint and ledger hash; production needs an approval and a
  re-authentication (rule `migration.baseline-production`). Execution: one
  transaction with the marker check, `legacy:<stem>` rows (origin
  `legacy_import`, the legacy checksum, the provenance of the evidence, the
  report id and the applied time when a ledger knew it) and their
  `imported` events, the `baseline:<slug>` row (checksum = report digest)
  and its `baselined` event, `ledger_meta.baseline_id`; the fingerprint must
  be unchanged before `COMMIT`. Verification records a run for the baseline:
  the fingerprint still equals the reviewed one and every accepted file's
  surviving expectations hold. The report becomes `baselined`.
- **CLI** (corrected in Wave 9 Part A, A1): `exponetdb migration import
  analyze` submits every `*.sql` file of the project's `legacy.directory`
  in file name order. `--baseline` and the project file's
  `legacy.baseline` take `baseline:<slug>` or the bare `<slug>` (the
  request carries the slug; Wave 6 refused the project's own
  `baseline:<slug>` locally). `--hints <file>` (JSON or YAML, at most
  256 KiB, data only) carries `aliases`, `notApplicable`, `role`,
  `searchPath` and `ledgers`; an unknown field, a wrong shape or a field
  given both in the file and as a flag (`--ledger`, `--not-applicable`) is a
  usage error before anything is sent.
- **Not in Wave 6:** `migration.rebaseline`, `ledger.reconcile`, the
  materialization of targets without history (§4) and the CLI lint
  `legacy_file_after_baseline`; a legacy file that needs a statement the
  admission refuses (for example `CREATE ROLE`) or `CONCURRENTLY` cannot be
  replayed and makes the report `incomplete` (declare such prerequisites on
  the cluster first). Corrected in Wave 9 Part A (A6), §2.4.

### 2.3 Evidence strength

**[DECIDED]** (Wave 9 Part A, A2; Wave 6 defect corrected) Measured on a real
Supabase ledger on 2026-10-21: every entry's `version` is a 14-digit
timestamp, its `name` is the file stem, and `statements` holds **one
element: the whole file with its comments stripped**. Wave 6 built the
entry's name as `<version>_<name>` and compared statements one by one, so no
real entry ever matched, and it let a name match make a file `recorded`.
The engine (`packages/migrations-engine/src/legacy-evidence.ts`) now:

- matches the Supabase `name` with the file stem and keeps `<version>_<name>`
  only as a fallback name hint; the version, read as a UTC time
  `YYYYMMDDHHMMSS` **[ASSUMPTION]** (the Supabase tooling writes UTC), is the
  entry's applied time; drizzle's `created_at` (milliseconds) and a
  runner's `applied_at` are applied times too;
- compares the **joined executable statement sequence** of both sides: each
  ledger element, and each file as a whole, passes the lexical
  normalization of `c1` (`scanExecutableText`, unchanged), then the
  whitespace next to a top-level `;` is removed and trailing semicolons are
  dropped; the parts are joined with `;`. Comments outside and inside
  statements, drizzle `--> statement-breakpoint` comments, line breaks and
  indentation do not matter; a `;` or a comment marker inside a literal, a
  quoted name or a dollar-quoted body is data;
- grades the comparison **[DECIDED]** (Wave 9 Part A, review round 1):
  `strong` is a tool's hash of the file's bytes, or the statements equal
  one by one **byte for byte** with only their ends trimmed (whitespace
  inside a literal, or a line a comment ended, can change what a statement
  means); `medium` is the normalized joined sequence above, and
  **[DECIDED]** (follow-up 2, F5, 2026-10-22) also that sequence with the
  code bodies of `DO` blocks and of `plpgsql` or `sql` functions and
  procedures normalized the same way: their comments removed, their
  whitespace collapsed to one separator, literals and quoted names as
  written (`statements_bodies`), and nowhere else (a dollar-quoted literal
  is data, and a body in another language, such as Python, keeps its
  whitespace). **[OBSERVED]** The hosted connector strips comments inside
  dollar-quoted bodies too: ten functions applied through it differed from
  the files byte for byte and were equal after that normalization, so it
  is the normal case for a routine applied that way, not an edge case.
  Before this change the tier was `low`; `low` is no longer given, and a
  report made earlier may still show it;
- gives one entry's content to **one file only**, and each ledger records
  a file once: content proves that a file ran, not which of several files
  with the same content. **[DECIDED]** (Wave 9 Part A, review rounds 1
  and 2) An entry whose name is a file's stem stands for that file only:
  its content records it when it matches, and never another file of the
  same content (a copy, or the text the named file had when it ran: that
  file is `ambiguous` with `content_names_other_file`). The unnamed entries
  of one ledger whose content equals the same files (at any tier) pair up
  with them in file and ledger order when there are at least as many
  entries as files, and an entry beyond them stays a ledger item without a
  file; with fewer entries than files none is recorded by that content,
  and each is `ambiguous` with `content_matches_files:<n>`;
- treats a **contradicted alias** as no evidence: when an alias says one
  entry stands for several files and the entry holds statements that are
  not the files' joined content, each file gets `<ledger>:alias_contradicted`
  (`weak`) and is `ambiguous` unless content records it by itself;
- records per item the **strength** of the strongest evidence
  (`evidenceStrength` in the report): `strong`, `medium`, `curated`,
  `weak`, or none (`low` only in reports made before follow-up 2). Content
  (`strong`, `medium`, an earlier `low`) and `curated` make a
  file `recorded`; `weak` never does: a file with only a name match is
  `unrecorded_present` when its effects hold (imported with
  `checksum_provenance = legacy_file_at_import`, basis "effect observed")
  and `unrecorded_missing` or `ambiguous` otherwise;
- takes the applied time of a baseline row from the earliest ledger that
  records the file (never from a name-only match; the row then says
  `appliedAtUnknown`).

The provenance stored in the target ledger keeps its frozen values: a hash is
`legacy_tool_hash`, any statement tier is `legacy_applied_statements`, a
curated alias or an observed effect is `legacy_file_at_import`. Evidence lists
are never cut silently: an item with more than 16 entries ends with
`evidence_truncated:<n>`.

### 2.4 Files with cluster-global effects

**[DECIDED]** (Wave 9 Part A, A6) Supabase-origin histories create and
change roles in their files, often inside `DO` blocks that swallow
`duplicate_object`. The replay runs as the execution role, which never has
`CREATEROLE`: **[OBSERVED]** on PostgreSQL 16, 17 and 18 (measured
2026-10-21, and asserted by `legacy-cluster-global.int.test.ts`) `CREATE
ROLE`, `GRANT <role> TO <role>` and `ALTER ROLE … SET` fail with `42501`
for a new and for an existing role alike, and a `WHEN duplicate_object`
handler does not catch it; only a guard such as `IF NOT EXISTS (… pg_roles
…)` passes, and only when the role already exists. Role effects are
cluster-wide, so a replay on a scratch target could not prove them anyway.
For the **legacy replay only, never for a real migration** (bundles keep
refusing role statements):

- **Elision.** A top-level role statement (`CREATE ROLE`, `CREATE USER`,
  `CREATE GROUP`, `ALTER ROLE`, `ALTER ROLE … SET`, `ALTER ROLE … RENAME`,
  `DROP ROLE`, `GRANT <role> TO <role>`, `REVOKE <role> FROM <role>`,
  `COMMENT ON ROLE`), and a `DO` block whose PL/pgSQL body holds nothing but
  such statements, in nested blocks, with exception handlers whose actions
  are `NULL` or a `RAISE` below `EXCEPTION` (with at most `SQLERRM` or
  `SQLSTATE` as parameters), and no declared variable, is **not run** on
  the scratch target. **[DECIDED]** (follow-up 2, F1, 2026-10-22) Such a
  block may also hold **guards**: `IF [NOT] EXISTS (SELECT … FROM pg_roles
  WHERE rolname = '<role>')` or `IF [NOT] EXISTS (SELECT … FROM
  pg_auth_members WHERE roleid = '<role>'::regrole AND member =
  '<member>'::regrole)` (unqualified or in `pg_catalog`, with an alias or
  not, `=` written either way round, several joined by `AND`, a `LIMIT` of
  a positive constant), nested, around such statements, with a `THEN`
  branch and at most an `ELSE` branch that only raises notices; a `RAISE`
  below `EXCEPTION` without parameters may stand anywhere, and one with
  `SQLERRM` or `SQLSTATE` in a handler (outside a handler they are no
  variables and the `RAISE` fails at run time; the verification review of
  follow-up 2, P3-2). Anything else in a guard (a
  function, a subquery, a variable, `OR`, `LIKE`, an oid, another
  relation), an `ELSIF` branch, an `ELSE` branch that does more, or a
  `RETURN` before the end of the block makes it mixed, and so does a block
  nested more than 64 blocks and IF statements deep. So does any datum but
  the PL/pgSQL parser's own (`found`, then `sqlstate` and `sqlerrm`, `text`
  constants, of each exception block): a declared variable, also a
  constant named like them, runs code at block entry through its default
  or a domain's check (the verification review of follow-up 2, P2-1). A
  name in a guard is cut to 63 bytes, as PostgreSQL cuts it, except a
  `::text` constant, which compares as text and is then no guard (P3-4).
  **[DECIDED]** (the verification review of follow-up 2, P2-2 and P3-3) A
  guard reads the system catalog only if nothing else answers to its
  names, so the **whole history** is read first, string literals included
  (a dynamic `EXECUTE` too): if any file creates or renames a relation
  named `pg_roles` or `pg_auth_members` (`CREATE`, `SELECT … INTO`, `ALTER
  … RENAME TO`; a temporary one is found before `pg_catalog`'s), only
  guards on `pg_catalog.pg_roles` and `pg_catalog.pg_auth_members` count;
  if any file creates or alters an operator named `=`, or sets a
  `search_path` that names `pg_catalog` after another schema, a guard
  counts only when the relation, every cast (`::pg_catalog.regrole`) and
  the operator (`OPERATOR(pg_catalog.=)`) name `pg_catalog`; any other
  guard makes the block mixed. `set_config('search_path', '', false)`, as
  `pg_dump` writes it, keeps `pg_catalog` first. **[ASSUMPTION]** A name
  built at run time (`format('%I', …)`) is not seen; a guard it fools only
  makes a guarded statement wrongly checked, never runs one.
  **[OBSERVED]** The first real import (2026-10-22) failed with `42501` on a
  `GRANT <role> TO <role>` behind `IF EXISTS (… pg_roles …)`: the guard
  held, so the grant ran as the execution role. A `DO` block that holds role
  statements and also does
  anything else (a query, a `PERFORM`, a dynamic `EXECUTE`, a
  declared variable, any other statement) is **mixed**: it runs unchanged,
  and its file is `ambiguous` (`do_block_mixed:<statement>`), a human
  decision. A `DO` block without role statements is ordinary procedural SQL,
  as before. A `DO` body is read with the PL/pgSQL parser of
  `libpg_query` 18, the only binding that has one; its SQL statements are
  then parsed with the scratch target's own major, and a body either parser
  cannot read is mixed. `REASSIGN OWNED` and every other refused statement
  still make the report `incomplete`.
- **Cluster-global expectations.** Each elided statement becomes
  expectations, listed per file in the replay plan's analysis
  (`replay.elided`): a role exists or not and the attributes the statement
  states (`LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`,
  `BYPASSRLS`, `INHERIT`, `CONNECTION LIMIT`; never a password), a
  membership exists or not with the options it states (`ADMIN`, `INHERIT`,
  `SET`), a role setting (`pg_db_role_setting`, per database or for all) has
  the value or is reset, a role's comment. Inside a block with an exception
  handler only what holds whether the statement created something or found
  it is kept: that the role or the membership exists. Behind a `NOT EXISTS`
  guard the same holds: the branch ran only when the role or membership was
  missing, so only its presence is kept, and only the presence of the
  guard's own subject unconditionally, when it is the only thing the branch
  waited to be missing; anything else there (`GRANT x TO y` after `CREATE
  ROLE x`, or `CREATE ROLE a` behind `NOT EXISTS (a) AND NOT EXISTS (b)`;
  the verification review of follow-up 2, P2-5) is checked but never
  supersedes. Behind an `EXISTS`
  guard the expectations are **conditional**: the observer checks one only
  while every guard around it holds on the imported target (`IF EXISTS
  (role) THEN GRANT … TO role` is checked while that role exists), else it
  is not checked (`cluster_global_guard_unmet:<n>`); a file whose every
  expectation sat behind an unmet guard proves nothing and is `ambiguous`
  unless a ledger records it. A block runs top to bottom: a later statement
  of the same block about the same thing (or a later `DROP ROLE` of a role
  an earlier one names) supersedes the earlier one when it stands in no IF
  statement the earlier one is outside of (`DROP ROLE x; CREATE ROLE x
  LOGIN` behind one `IF EXISTS (x)` states that `x` exists with `LOGIN`;
  review of follow-up 2). Two IF statements with the same guard are two
  decisions, each made after what ran before it, so neither supersedes the
  other (`IF EXISTS (a) THEN DROP ROLE a; END IF; IF EXISTS (a) THEN CREATE
  ROLE a; END IF;` states that `a` is absent, and that it exists while it
  exists; the verification review of follow-up 2, P3-1). A surviving statement that undoes what its own guard asked (`IF
  EXISTS (role) THEN DROP ROLE`, `REVOKE` behind a membership guard) leaves
  the same state either way, so that guard does not apply to it. A
  conditional expectation **never supersedes** another one, since its
  guard may have been false when the file ran; it is superseded like any
  other. Over the whole chain the last
  statement about the same thing wins (the others are superseded). The
  observer checks the surviving ones against the **imported** target's
  catalog: evidence `cluster_global_held:<n>/<m>`. A file whose cluster-global
  expectations do not all hold, or cannot be read, is `ambiguous` (never
  present nor missing: roles are cluster-wide and another database's history
  may have changed them), a person decides. A statement whose subject depends on who runs it
  (`CURRENT_USER`, `SESSION_USER`, `CURRENT_ROLE`, `PUBLIC`) or whose value
  comes from the session (`SET … FROM CURRENT`, `RESET ALL`) yields no
  expectation and makes the file `ambiguous` (`cluster_global_unknown`),
  also when later files superseded its other effects: no later statement
  can supersede what was never known (review round 1).
  A setting value is compared as PostgreSQL stores it after the statement's
  own rendering (list settings such as `search_path` quoted like
  `quote_ident`); a value PostgreSQL would render differently does not hold,
  which is fail-closed: a person decides.
- **`CONCURRENTLY`.** A statement only allowed outside a transaction
  (`CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX …
  CONCURRENTLY`) is replayed **non-transactionally**: the file runs in
  segments, the statements before it in one transaction, the statement
  alone in autocommit as the execution role with the same guards, the rest
  in another transaction; no ledger or event is written on the scratch
  target. A failure stops the replay like any other (`replay_failed`, the
  statement's index in the file).
- **Comment-only files.** A file without statements is not replayed and
  not refused: evidence `no_statements`, `recorded_present` when a ledger
  records it, else `unrecorded_present` (it has no effect to miss).

### 2.5 Scratch targets

**[DECIDED]** (Wave 9 Part A, A7) A scratch target is an active nonprod
target of the same project with its own environment, emptied for each
analysis; nothing marks it "consumed", the replay's emptiness check does.

- **Preflight** (read only): `GET /targets/{id}/migrations/scratch-check?scratchTarget=…`
  (`migrations.import` on both targets; CLI `migration import scratch-check
  --target … --scratch …`; not an MCP tool) reports, with what differs:
  `scratch_usable` (the registry rules above), `identity` (the scratch
  database carries its identity marker and the oid the registry recorded),
  `empty` (no object in the managed scope, no ledger row), `extensions`
  (the imported target's extensions with the same schema and version),
  `outside_scope` (every object outside the managed scope that the imported
  schema depends on, a foreign key to an identity service's table, a policy
  calling its function, read from `pg_depend` on the imported target, must
  exist on the scratch target as a schema-only copy; at most 1 000 are
  read, more is `unknown`), and `execution_role` (the role resolved for the
  scratch environment, for the migrator, with that environment's declared
  exceptions). `ready` is all of them passing. **[DECIDED]** (Wave 9 Part A,
  review round 1) `extensions` also compares the PostgreSQL major
  (`major_differs`, item `postgresql: target <n>, scratch <m>`), and
  `execution_role` fails with `differs_from_target` (items: the scratch
  role, the imported target's role) when the scratch environment resolves
  the alias to another role than the imported target's environment does:
  the replayed objects would be owned by another role and every one would
  drift. The alias is `owner` unless `role` (CLI `--role`) names the one the
  hints use. The preflight changes
  nothing; the replay checks again under its own lock.
- **What the history references** **[DECIDED]** (follow-up 2, F3,
  2026-10-22). `outside_scope` reads what the imported target's **current**
  schema depends on; an old file can need more. **[OBSERVED]** The first
  real import passed the preflight and its replay stopped at a policy
  calling `auth.uid()` (`3F000`): the scratch target had no `auth` schema,
  and no current object depended on it any more. With the legacy files
  (`POST /targets/{id}/migrations/scratch-check`, body `{ scratchTarget,
  role?, files }`; the CLI sends the project's legacy directory when there
  is one), the preflight adds `legacy_references`: every schema-qualified
  relation, function and type in a schema outside the managed scope that a
  file names, read from the parse trees with the scratch target's major (a
  `LANGUAGE sql` function body, which PostgreSQL checks at `CREATE
  FUNCTION`, and every statement and expression of a PL/pgSQL `DO` block
  count; a PL/pgSQL function body runs only when called and does not; a
  `DROP` needs nothing; an unqualified name resolves through the replay's
  search path and is not counted; an object an **earlier** statement of
  the history creates is not a reference; `CALL`, `COMMENT ON` and a
  schema an object is created in, granted on (`GRANT … ON SCHEMA`) or given
  default privileges in count; review of follow-up 2), must exist on the
  scratch target (a function in any overload: a call site names no
  argument types). It fails with `missing:<n>` and names each object with
  the first file that names it, an extension's member with its extension;
  it is `unknown` with `unparsed:<n>` when a file cannot be parsed, and with
  `too_complex` when bodies nest more than two levels deep (**[DECIDED]**,
  security review of follow-up 2: deeper nesting exhausted the process; the
  scan stops there), and when a tree is more than 1 000 levels deep or a
  body cannot be given to its parser (**[DECIDED]**, the verification
  review of follow-up 2, P2-4: such a reference was dropped and the check
  passed). A file, or a body in it, of more than 200 000 tokens is refused
  before the check runs, as by the analysis (`422`, `/files/<i>/text`,
  `too_large`: split it; [deployment.md §2a](../12-operations/deployment.md#2a-memory)). The files the hints call not applicable are left out,
  as the replay skips them (`notApplicable`; CLI `--hints` or
  `--not-applicable`). Both checks give `copySchemas`, the schemas outside
  the scope the scratch target lacks objects of; never the schema of an
  extension's member, which comes with the extension (install the
  extensions first, the `extensions` check names them). Operator classes
  and qualified operators are not read.
- **Schema-only copies.** `exponetdb migration import
  scratch-copy-commands --target … --scratch …` runs the preflight and
  prints the shell commands (read only, nothing is run; **[OBSERVED]**
  verified on PostgreSQL 17 on 2026-10-22): `pg_dump --schema-only` of
  exactly the `copySchemas` (each written as a literal pattern) from
  `$IMPORTED_URL`, a TOC filter that leaves out every trigger and row
  security policy and their comments (a trigger on `auth.users` calling a
  function in the managed scope, the `on_auth_user_created` pattern, or a
  policy on `storage.objects` calling one, would need that function before
  the replay creates it; the history creates them again if it does; review
  of follow-up 2: such a policy failed the whole restore before), and
  `pg_restore --single-transaction --exit-on-error` into
  `$SCRATCH_URL`. No data, no credential: the person sets both connection
  strings. Owners and grants are kept, so the roles must exist where the
  copy goes (the same cluster does). The copies are outside the managed
  scope, so an in-place reset keeps them. After a replay the history's own
  triggers and policies on them (on `auth.users`, on `storage.objects`)
  depend on the managed scope, so the reset refuses and names them; drop
  them on the scratch target first, the next replay creates them again.
- **In-place reset.** A used scratch target is reset without re-creating
  its database (which would change the oid the registry recorded and fail
  `database_mismatch`): `exponetdb migration import scratch-reset-sql
  --scratch …` prints a script built from registry values (installation,
  target id, generation, the project's managed scope) that a person runs
  with `psql -v ON_ERROR_STOP=1` as a superuser connected to that database.
  It stops unless the database carries the scratch target's marker and has
  no ledger row (**[DECIDED]**, review round 3: it reads both only once the
  catalog shows them as ExponetDB made them, plain tables of the ledger
  owner with built-in column types, without children or row security, and
  with qualified operators; a replay's procedural code can act as the
  ledger owner, [OD-55](../00-product/open-decisions.md#od-55-procedural-code-in-a-migration-session-can-act-as-any-role-the-migrator-holds),
  and could otherwise have left a view there whose code runs as the
  superuser; a refused script says to re-create the scratch database), and **[DECIDED]** (Wave 9 Part A, review round 1) when an
  object outside the managed scope depends on one inside it (a view, a
  column's type, a default, a trigger, a policy, a cast): `DROP SCHEMA …
  CASCADE` would drop it too, so the script refuses and names them (from
  `pg_depend`, normal and automatic dependencies). **[DECIDED]**
  (follow-up 2, F2, 2026-10-22) The members of an extension that lives in
  the scope go with it and are re-created with it: an object of such an
  extension without a schema of its own (the casts and access methods of
  `vector`, **[OBSERVED]** 25 of them refused the first real reset) is no
  reason to refuse. A member of such an extension in a schema **outside**
  the scope refuses (the drop would take it, and a replay that owns an
  extension can add its own objects to it). **[DECIDED]** (security
  review of follow-up 2) Dependencies do not show everything a cascade
  reaches (a server of a wrapper an extension of the scope holds, and a
  foreign table of it elsewhere; an extension outside the scope that holds
  an object inside it). So the script also lists, by identity, every
  object outside the managed scope before it drops anything, and again
  once the extensions are re-created; if any is missing it refuses (`the
  reset would drop objects outside the managed scope …, nothing was
  changed`, naming them) and the transaction rolls back. Then, in one
  transaction, it drops and re-creates each schema of the managed scope with
  its owner and grants (read from the catalog before the drop) and
  re-creates the extensions that lived there in their versions, each after
  the extensions it requires (`pg_depend`; the catalog's row order is not
  that order once an extension was updated: `cube` updated after
  `earthdistance` made the reset fail, the verification review of
  follow-up 2, P3-5). A
  publication's membership of a table or schema is no reason to refuse
  (the drop ends the membership, the publication stays); a refusal names
  how many objects depend and marks a list cut at 2 000 characters. The
  script is one `DO` block whose dollar-quote tag occurs nowhere in its body (a
  schema name may hold `$`), so no registry value leaves its literal, and
  **[DECIDED]** (review round 2) it first sets `search_path = pg_catalog,
  pg_temp` for its transaction: an operator or function a replay left in a
  managed schema (an exact-type `public.=(oid, regclass)`, say) would
  otherwise win over the built-in one and run as the superuser. It also
  writes every value as an `E''` string and pins `standard_conforming_strings
  = on`: a database's owner may turn that setting off for the database, and
  a backslash in a schema name would then end a plain literal. The
  database, its oid, the `exponetdb` schema with the marker and every
  schema outside the scope stay; default privileges set inside a dropped
  schema go with it. Run the preflight afterwards.
- **What the preflight and the reset do not see** **[DECIDED]** (review
  round 2). `ready` means the six checks above passed, nothing more. A
  history that also creates objects **outside** the managed scope (a
  trigger on the identity service's `auth.users` calling a `public`
  function, the Supabase `on_auth_user_created` pattern; tables in another
  schema) leaves them on the scratch target: the reset refuses while such a
  dependent exists (it names it) and keeps every other object outside the
  scope, so the next replay would fail on them (`42P07`). Drop what the
  replay created outside the scope before the reset, or widen the scope.
  References inside function bodies (`LANGUAGE sql AS $$ … auth.uid() … $$`)
  are not in `pg_depend` (only `BEGIN ATOMIC` bodies are), so
  `outside_scope` does not list what such a body needs; the replay names it
  when it fails.
- **A wrong registration** is corrected by decommissioning the target and
  retiring the database record (`registry.database.retire`,
  [`../02-control-plane/registry.md` §4.3](../02-control-plane/registry.md#43-correcting-a-wrong-registration-wave-9)).
- **Freeze out-of-band DDL** on the imported target from the analysis to
  the baseline. The report records the imported target's fingerprint the
  analysis compared with; planning the baseline refuses when the live
  fingerprint differs (`SCHEMA_FINGERPRINT_MISMATCH`), and so does its
  execution under the lock (`PLAN_STALE`, `schemaFingerprint`): a change in
  between means a new analysis.
  `exponetdb target show <target>` and the report (`fingerprint`) show both
  values.

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
| One ledger entry for several files | Curated rule in hints (`"0032_0036_…": ["0032_…", …, "0036_…"]`, Wave 9) plus statement comparison against the files joined in file order (§2.3). |
| Two files with the same content (a fix run twice, a copied file) | One entry's content records one file only: an entry that names a file stands for it alone (a copy of its content is `ambiguous`, `content_names_other_file`), as many unnamed entries as files pair up, fewer leave each file `ambiguous` (`content_matches_files:<n>`, §2.3). |
| File edited (comments only) after apply | Executable checksum unchanged; no issue. |
| File edited (executable text) after apply | The imported checksum is of today's text; the replay uses today's text; if the target's objects match, it imports as present. Divergence is still caught by object comparison. |
| Conditional DDL took a different branch on the target | Surviving expectations differ; review item with the evaluated branch shown. |
| Date-dependent partitions | **Not pinned** (Wave 9 Part A, §2 step 2): the replay runs at its own time; differing partitions are drift items a person resolves. |
| Objects created by hand, never in a file | Global drift item → `unmanaged_but_present` or removal. |
| Provider-managed schemas (`auth`, `storage`, `realtime`, `extensions`, `supabase_migrations`, …) | Excluded from managed scope by the project's configuration; never imported. |
| Extension in `extensions` schema on the source, `public` on the replay | The scratch target is prepared with the target's extensions in the same schemas and versions; the replay refuses otherwise (`extensions_differ:<name>`, §2 step 2). |
| Scratch target on another PostgreSQL major | The preflight fails `extensions` (`major_differs`), the replay refuses (`major_differs:<target>/<scratch>`, §2 step 2). |
| A view or column outside the managed scope depends on a scratch object | The in-place reset refuses and names it; drop or move it first (§2.5). |
| Legacy ledger table missing on a target | Fine; evidence comes from objects. |
| A file creates or grants roles (top level, or in a `DO` block that swallows `duplicate_object` or guards with `IF [NOT] EXISTS` on `pg_roles` or `pg_auth_members`) | Elided from the replay, checked as cluster-global expectations on the imported target (`cluster_global_held:<n>/<m>`; behind an `EXISTS` guard only while the guard holds, `cluster_global_guard_unmet:<n>`; §2.4); a mixed `DO` block runs and makes the file `ambiguous`. |
| `CREATE INDEX CONCURRENTLY` in a file | Replayed alone in autocommit between transactional segments (§2.4). |
| A file with comments only | Not replayed; `no_statements` (§2.4). |
| Target unreachable mid-analysis | Report marked `incomplete` (`target_unavailable`, review round 2: it stayed `pending` before); cannot be applied. |
| Import run twice | Analysis is repeatable; the baseline operation refuses if a baseline row already exists (a second baseline is a separate, deliberate `migration.rebaseline`). |
