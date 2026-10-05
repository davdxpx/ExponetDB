# Migration dependency graph

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 2 (`packages/migrations/graph`, used by the Control Store runner), Wave 6 (engine) |
| Read before | [`migration-bundles.md`](./migration-bundles.md) |
| Decision | [ADR-0008](../01-architecture/adr/0008-migration-dag.md) |

## 1. Model

**[DECIDED]** Each project has one migration **stream**. The stream is a directed
acyclic graph:

- **Nodes**: migrations (ULID ids) and **baseline nodes** (`baseline:<slug>`).
- **Edges**: `dependsOn` declarations. An edge `B → A` (B depends on A) means A
  must be applied, on the same target, before B.
- **Roots**: baseline nodes, or migrations with an empty `dependsOn` (allowed
  only in a stream without a baseline, i.e. a project that started on
  ExponetDB).
- **Heads**: nodes without dependants.

The graph is the *only* source of ordering
([C-17](../00-product/constitution.md#c-17-order-comes-from-the-dependency-graph)).
File names, directory order, ULID timestamps and submission order never imply
dependencies.

```
 baseline:reosa-platform-2026-11
          │            │
          ▼            ▼
   01JB…add-lead   01JB…add-vault-index          (independent, parallel branches)
          │            │
          ▼            │
   01JC…backfill       │
          └─────┬──────┘
                ▼
         01JD…drop-legacy-col                     (depends on both)
```

## 2. Authoring rule: dependencies default to the heads

**[DECIDED]** The CLI command that creates a bundle
(`exponetdb migration new <name>`) fills `dependsOn` with the **current heads of
the stream in the author's working tree**. The author may remove edges they are
certain are unnecessary, with a lint (`removed_default_dependency`, info) that
asks for a sentence in `description`.

Why: missing edges are the dangerous failure. Two migrations without an edge may
be applied in different orders on staging and production. Default-to-heads makes
"I depend on everything I could see" the norm, and parallel work by different
sessions or developers naturally produces *independent* heads (each depends on
the heads before the fork), which is correct: they did not see each other.

What this does **not** solve: two parallel migrations that *should* be ordered
(for example both touch the same table) but were written without seeing each
other. That is detected, not prevented:

- **Conflict lint** (`parallel_object_overlap`, warn; blocking for prod tier):
  when two migrations are mutually unordered (neither is an ancestor of the
  other) and their parsed statements touch the same object (same table, same
  function signature, same policy), the lint asks for an explicit edge.
- **Staging order evidence**: the production gate checks that the *relative
  order in which unordered migrations were applied on staging* is either
  irrelevant (no overlap) or reproduced on production (the plan orders them the
  same way). See §5.

## 3. Validation

**[DECIDED]** Validation runs in the CLI (local lint), at bundle ingestion and at
every plan. All checks are deterministic and produce stable error codes.

| Check | Error | Notes |
|---|---|---|
| Every `dependsOn` id exists in the stream (submitted bundles + bundle store + target ledger + baseline) | `MIGRATION_DEPENDENCY_UNKNOWN` | A dependency that exists only on another branch is unknown here. |
| No cycles | `MIGRATION_DEPENDENCY_CYCLE` | Detected with iterative DFS (Tarjan's SCC for the cycle path). `details.cycle` lists ids in order. |
| No self-dependency | `MIGRATION_DEPENDENCY_CYCLE` | |
| No duplicate edges | lint `duplicate_dependency` (info) | Deduplicated, not an error. |
| Dependencies are in the same project | `MIGRATION_DEPENDENCY_UNKNOWN` | Cross-project dependencies are not supported (see §7). |
| At most one baseline per stream lineage root | `MIGRATION_BUNDLE_INVALID` | A second baseline is an import event, see legacy-import.md. |
| Baseline nodes have no dependencies | structural | |
| Applied dependency has the expected checksum | `MIGRATION_CHECKSUM_MISMATCH` | The dependency's checksum in the target ledger must equal the checksum the stream knows for that id. |

## 4. Ordering

**[DECIDED]** The application order for a set of pending migrations on a target
is a **topological sort** with a deterministic tie-breaker:

1. Restrict the graph to `pending = stream − applied(target)`.
2. Kahn's algorithm. When more than one node is ready, choose the one with the
   smallest ULID (lexicographic). This makes the order a pure function of the
   graph, so every planner (and the CLI's local preview) computes the same
   order.
3. Every dependency of a pending node must be either applied on the target (with
   matching checksum) or itself pending and therefore earlier in the order.
   Otherwise `MIGRATION_DEPENDENCY_MISSING`.

A plan can include one migration or a contiguous prefix of this order. A plan
may **not** skip a ready node to apply a later independent one *unless* the
caller selects specific migrations; then the plan contains exactly the selected
migrations plus their pending ancestors, in topological order. Selecting a
migration never silently pulls in unrelated migrations.

## 5. Target-specific state

**[DECIDED]** "Applied" is per target. The stream is shared; each target's
ledger says which nodes are applied there and in which order (`applied_seq`).

Consequences:

- Staging may have applied `A, B` and production `B, A` if A and B are unordered.
  This is allowed only when the conflict lint found no overlap between A and B.
  If overlap exists and no edge was added, the production plan mirrors staging's
  order and fails with `PLAN_STALE`-class error `ORDER_DIVERGES_FROM_EVIDENCE`
  if production's state makes that impossible.
- A target may lag behind (production usually does). The pending set is always
  computed per target.
- A **hotfix applied to production** that never reached staging is a ledger entry
  on production without evidence. It is only possible via break-glass
  ([`staging-production-policy.md`](./staging-production-policy.md#3-hotfixes)), and
  staging must then receive the same migration (same checksum) to restore the
  invariant "staging is a superset of production". The project overview shows
  this as a finding until it holds.

## 6. Baselines and imported history

**[DECIDED]** A baseline node `baseline:<slug>` stands for "the database state
captured and verified at import time". It is created by the legacy import
([`legacy-import.md`](./legacy-import.md)). Properties:

- It has a recorded schema fingerprint (per target at import time) and the list
  of legacy migration identities it subsumes.
- Imported legacy migrations are recorded in the ledger with
  `origin = legacy_import`; they are **not** graph nodes that new migrations
  depend on individually. New migrations depend on the baseline (or on later
  bundles). Reason: legacy ordering comes from file names and was never
  validated as a DAG; turning 454 files into graph nodes would encode dubious
  edges as truth.
- A target "has the baseline" when its ledger contains the baseline record. A
  target without it (for example a fresh preview database) must first be brought
  to the baseline state by a **baseline materialization** operation (replaying
  the legacy history or restoring a baseline dump), then stamped.
- A stream can receive a *second* baseline later (squashing history), which is a
  deliberate, planned operation; old bundles stay in the store and ledgers.

## 7. Cross-branch and cross-project cases

| Case | Behavior |
|---|---|
| Branch X adds A, branch Y adds B, both merged | Two heads; independent unless overlap lint fires. |
| A migration on an unmerged branch was applied to staging (agent experiment) | Allowed on nonprod. It is in staging's ledger and in the bundle store. If the branch is abandoned, the migration is **orphaned**: present in staging, absent in source. Shown as drift (`applied_not_in_source`). Remedy: a forward migration that undoes it, or rebuilding staging. Never deleting the ledger row. |
| Migration removed from the source repository after application | Same as orphaned. The ledger is history; source removal does not change it. |
| Branch rebased; `dependsOn` changed on an unapplied migration | Fine; new checksum, old content stays in the store (lint `rewritten_unapplied_migration`). |
| Branch rebased; `dependsOn` changed on an applied migration | `MIGRATION_CHECKSUM_MISMATCH`. The author must restore the original bundle and add a new migration. |
| Two projects need ordering (for example `reosa/platform` before `reosa/status`) | Not supported in V1. Projects are independent streams. Cross-project coordination is a human/CI concern. Revisit only with a real case. |

## 8. Performance

Streams grow monotonically. For V1 scale (hundreds to low thousands of nodes) the
full graph is loaded and validated in memory per plan; validation is O(V+E). The
bundle store indexes `(project_id, migration_id)`; ledgers are indexed by
`migration_id`. No incremental graph cache in V1.

## 8a. Implementation (Wave 2)

**[DECIDED]** (Wave 2) `packages/migrations/graph` implements §1 to §4 as pure
functions ([README](../../packages/migrations/README.md#exponetdbmigrationsgraph)).
Details that the sections above leave open:

- Validation reports the first failing check in this order: invalid node id,
  duplicate id, invalid `dependsOn` entry, unknown dependency, cycle (a
  self-dependency is a cycle of one), and a migration without dependencies in
  a stream that has a baseline (`unanchored_root`, the root rule of §1).
- The cycle is reported as the shortest cycle through the smallest id on any
  cycle, listed in `dependsOn` direction, ties broken by smaller ids, so the
  same stream always reports the same cycle.
- Baselines are roots and never executed: a pending set that would contain a
  baseline is refused (`baseline_missing`); the target must first be brought
  to the baseline state (§6). The rule "at most one baseline per stream
  lineage root" belongs to the legacy import and ingestion (Wave 6).
- A pending set is refused when the applied set names an id the stream does
  not know (`unknown_applied`) or when an applied migration's dependency is
  not applied (`dependency_missing`): an inconsistent history is never
  silently ordered around.
- Duplicate edges are deduplicated (the `duplicate_dependency` lint is Wave 6).

## 9. Tests (minimum)

- Golden tests for topological order with ties.
- Property test: random DAGs, random application orders consistent with the DAG,
  `pending` computation is correct; the order is identical across runs and
  machines.
- Cycle detection reports the exact cycle.
- Unknown dependency, cross-project dependency, applied-dependency checksum
  mismatch.
- Overlap lint on parsed statements (same table, same function signature, same
  policy, same index name).
