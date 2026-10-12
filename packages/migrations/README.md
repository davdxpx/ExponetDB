# @exponetdb/migrations

The migration domain. It grows by subpath across waves
([package architecture §1.1](../../exponetdb-docs/01-architecture/package-architecture.md#11-packagesmigrations-by-subpath-and-wave)):

| Subpath | Wave | Status |
|---|---|---|
| `format` | 1 | pure migration-format primitives, production code (frozen at G1) |
| `graph` | 2 | pure DAG validation, deterministic order, heads, ancestors, pending sets |
| `lint` | 6 | the V1 lint catalog over the parser's statement analysis; pure, shared by the CLI and the server |
| `engine` | 6 | plan, apply, verify, ledger, locks, evidence, legacy import (not yet created) |

## `@exponetdb/migrations/format`

### Owns

| Module | What | Specification |
|---|---|---|
| `sql.ts` | `c1` executable-text canonicalization: input checks, line endings, the lexer (R1 to R11 as a state machine), output | [migration-bundles.md, N1 to N5](../../exponetdb-docs/04-migrations/migration-bundles.md#normative-definition-of-c1-frozen-at-g1) |
| `projection.ts` | manifest validation, the projections P, V, R with materialized defaults | N7 |
| `digests.ts` | frames, apply checksum (executable text of `up.sql`), verify digest (full normalized `verify.sql` source, comments and directives included), rollback digest (executable text of `down.sql`), bundle and source digests | N6 |
| `ledger-state.ts` | `ls1` ledger state hash over ledger rows | [ledger.md §3](../../exponetdb-docs/04-migrations/ledger.md#3-derived-values) |
| `yaml.ts` | strict YAML (one document, core schema, unique keys, no anchors, aliases or tags) | migration-bundles.md §2 |
| `bundle.ts` | bundle validation: directory name, file set, sizes, encoding, manifest, file and manifest agreement, empty migrations, digests | migration-bundles.md §1, §2 |

### Does not own

Anything with I/O: no database, no network, no file system (callers pass
bytes). DAG order (`graph`, Wave 2), lint rules, planning and apply (Wave 6),
schemas (`@exponetdb/contracts`), canonical JSON and SHA-256
(`@exponetdb/kernel`).

### Allowed dependencies

`@exponetdb/kernel`, `@exponetdb/contracts`, `yaml`. Nothing else (checked by
the boundary checker).

### Frozen at G1

`c1` and `ls1` are stored contracts, frozen since the owner accepted G1 on
2026-10-05 (pre-acceptance corrections are listed in the
[G1 gate record](../../exponetdb-docs/14-roadmap/gates/1.md)). Their output for
any input never changes, not even for a bug fix: a fix is a new canonicalizer (`c2`, `ls2`)
through an ADR, and stored values keep the canonicalizer named in them
([versioning](../../exponetdb-docs/01-architecture/versioning.md)). The golden
vectors in [`tooling/golden`](../../tooling/golden/README.md) are
append-only; this code and the independent Go implementation in
`agent/node/internal/conformance` must both pass every one of them. No other
checksum implementation exists in TypeScript.

### Public exports

`executableText`, `normalizeSqlSource`, `scanExecutableText`,
`computeBundleDigests`, `frame`, `projectManifest`, `parseMigrationManifest`,
`parseProjectDefaults`, `ledgerStateHash`, `parseStrictYaml`,
`validateBundle`, `findDuplicateMigrationId`, and their types.

## `@exponetdb/migrations/graph`

### Purpose

The dependency graph of a migration stream
([dependency-graph.md](../../exponetdb-docs/04-migrations/dependency-graph.md)):
the only source of migration order (C-17). Used by the Control Store bootstrap
runner from Wave 2, by the engine and the CLI from Wave 6.

### Owns

`graph.ts`: validation (`buildGraph`), deterministic topological order (Kahn's
algorithm, smallest ULID first among ready nodes), `heads`, `roots`,
`ancestors`, `dependants`, `pendingOrder` (stream minus a target's applied
set), `selectionOrder` (selected migrations plus their pending ancestors) and
`checkOrder` (an externally supplied order respects every dependency).
`errors.ts`: the catalog code a failure surfaces as.

### Does not own

Reading bundles (callers pass id and `dependsOn` of already validated
bundles), checksums (`format`), ledgers, locks, lint (`parallel_object_overlap`
is Wave 6), evidence and the staging-order rule of §5.

### Allowed dependencies

`@exponetdb/kernel` (and `contracts`, `format` by the graph rules); nothing
else. Pure: no I/O.

### Failure behavior

Validation reports the first failing check, in a fixed order: `invalid_id`,
`duplicate_id`, `invalid_reference`, `unknown_dependency`, `cycle` (self
dependency included; the cycle is listed in dependency order from its
smallest id), `unanchored_root` (a migration without dependencies in a stream
that has a baseline). Pending sets refuse applied ids the stream does not know
(`unknown_applied`), a missing baseline (`baseline_missing`: a baseline is
never executed) and an applied migration whose dependency is not applied
(`dependency_missing`). Input order never changes a result.

## `@exponetdb/migrations/lint`

The linter of [analysis.md §6](../../exponetdb-docs/04-migrations/analysis.md#6-linter):
one implementation for the CLI (offline), CI and the server's planner, so a
local result and a plan cannot disagree on the same bytes and facts.

| Module | What |
|---|---|
| `rules.ts` | the rule catalog: stable id, default level, when a finding blocks (`always`, `prod`, `prod_large`, `never`), whether the engine enforces it (`fixed`: a project override never lowers it), summary and remediation |
| `lint.ts` | `lintBundles(bundles, context)`: bundle validation (`format`), the statement analysis of `up.sql` and `down.sql` (`@exponetdb/postgres/parser`, the grammar of the target's major), `verify.sql` admission and directives (`-- check:`, `-- covers:`, `-- calls:`, `-- reads-view:`), the graph (`graph`), unordered overlaps, history against ledger and bundle store facts, project invariants, profiles and overrides |

Pure: callers pass bytes and, at the server, live catalog facts
(`CatalogFacts`, marked `live`). A fact a rule needs that the caller did not
give (offline: table sizes, extension ownership) is reported with
`factsUnavailable: true` and the rule fails closed on production: a
`prod_large` finding of a table of unknown size blocks a production plan.
The tier decides blocking; offline linting uses `prod` unless the caller
names `nonprod`.

### Allowed dependencies

`format`, `graph`, `@exponetdb/kernel`, `@exponetdb/contracts` and the
parser subpath `@exponetdb/postgres/parser` only (no driver, no I/O).

