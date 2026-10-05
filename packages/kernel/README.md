# @exponetdb/kernel

The smallest foundation of ExponetDB. Deliberately tiny and free of domain
logic ([package architecture](../../exponetdb-docs/01-architecture/package-architecture.md)).

## Owns

| Module | What |
|---|---|
| `ids` | prefixed entity ids `<prefix>_<ULID>` with compile-time brands (`TargetId`, `PlanId`, …), bare migration ULIDs (`MigrationId`), validating parsers, generation from an injected time |
| `ulid` | canonical ULID text (26 uppercase Crockford characters, first `0`–`7`), generation |
| `result`, `errors` | `Result<T, E>`; the three failure kinds (thrown `InvariantError` for bugs, returned `Failure` for expected domain and boundary failures) |
| `json` | the `JsonValue` model, a strict I-JSON parser, in-memory JSON checks |
| `jcs` | RFC 8785 canonical JSON (a stored contract) |
| `utf8` | strict UTF-8 decoding, UTF-8 byte order comparison |
| `clock` | injectable `Clock`, RFC 3339 formatting |
| `hash` (subpath `@exponetdb/kernel/hash`) | SHA-256 (Node.js `crypto`) and the plan-hash construction |

## Does not own

Error codes, permissions, wire shapes (`@exponetdb/contracts`); migration
checksums and `ls1` (`@exponetdb/migrations/format`); anything that does I/O.

## Allowed dependencies

None at runtime besides the Node.js standard library (`node:crypto`, only in
the `hash` subpath). Kernel never imports `@exponetdb/contracts` or any other
workspace package (checked by the boundary checker).

## Public exports

- `@exponetdb/kernel`: everything above except hashing; safe for browser bundles.
- `@exponetdb/kernel/hash`: `sha256`, `sha256Hex`, `sha256HexOf`,
  `computePlanHash`, `PLAN_HASH_REQUIRED_MEMBERS`, `PLAN_HASH_OPTIONAL_MEMBERS`.

## Contracts pinned here

| Contract | Specification | Golden vectors |
|---|---|---|
| Entity ids, migration ids | [domain model §2](../../exponetdb-docs/01-architecture/domain-model.md#2-identifiers) | `tooling/golden/ids.json` |
| Canonical JSON (RFC 8785) | [versioning](../../exponetdb-docs/01-architecture/versioning.md) | `tooling/golden/jcs.json` |
| Plan hash | [operations engine §3.1](../../exponetdb-docs/02-control-plane/operations-engine.md#31-content) | `tooling/golden/plan-hash.json` |

The plan hash binds exactly `id, kind, kindVersion, createdAt, expiresAt,
actor, client, subject, content, contentChecksum, policy` and, when present,
`expectedState, analysis, evidence`. It never includes `planHash`, `state` or
display fields, and refuses unknown members.

## Stability

Canonical JSON and the plan-hash construction are frozen at G1; their golden
vectors are append-only. A change needs an ADR and a new value prefix. Other
exports are internal monorepo APIs and change with their callers.
