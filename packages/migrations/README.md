# @exponetdb/migrations

The migration domain. It grows by subpath across waves
([package architecture §1.1](../../exponetdb-docs/01-architecture/package-architecture.md#11-packagesmigrations-by-subpath-and-wave)):

| Subpath | Wave | Status |
|---|---|---|
| `format` | 1 | **this package today**: pure migration-format primitives, production code |
| `graph` | 2 | DAG validation and order (not yet created) |
| `lint` | 6 | lint rules on the PostgreSQL parser (not yet created) |
| `engine` | 6 | plan, apply, verify, ledger, locks, evidence, legacy import (not yet created) |

## `@exponetdb/migrations/format`

### Owns

| Module | What | Specification |
|---|---|---|
| `sql.ts` | `c1` executable-text canonicalization: input checks, line endings, the lexer (R1 to R11 as a state machine), output | [migration-bundles.md, N1 to N5](../../exponetdb-docs/04-migrations/migration-bundles.md#normative-definition-of-c1-frozen-at-g1) |
| `projection.ts` | manifest validation, the projections P, V, R with materialized defaults | N7 |
| `digests.ts` | frames, apply checksum, verify, rollback, bundle and source digests | N6 |
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

`c1` and `ls1` are stored contracts. From the Wave 1 gate on, their output for
any input never changes, not even for a bug fix: a fix is a new canonicalizer
(`c2`, `ls2`) through an ADR, and stored values keep the canonicalizer named in
them ([versioning](../../exponetdb-docs/01-architecture/versioning.md)). The
golden vectors in [`tooling/golden`](../../tooling/golden/README.md) are
append-only; this code and the independent Go implementation in
`agent/node/internal/conformance` must both pass every one of them. No other
checksum implementation exists in TypeScript.

### Public exports

`executableText`, `normalizeSqlSource`, `scanExecutableText`,
`computeBundleDigests`, `frame`, `projectManifest`, `parseMigrationManifest`,
`parseProjectDefaults`, `ledgerStateHash`, `parseStrictYaml`,
`validateBundle`, `findDuplicateMigrationId`, and their types.
