# @exponetdb/diagnostics

Observation of registered targets in Wave 4
([`health.md`](../../exponetdb-docs/10-observability/health.md),
[`drift-detection.md`](../../exponetdb-docs/03-database-model/drift-detection.md),
[`schema-fingerprints.md`](../../exponetdb-docs/03-database-model/schema-fingerprints.md)).
It never writes to a target.

**Responsibility.** Schema snapshots on identity-checked observer sessions
and the canonical documents stored once per fingerprint (verified on every
read); schema reads (overview, live fingerprint, search, object detail,
diffs); the health sampler (both protocols on every endpoint, identity,
settings and activity reads), its pure reducer and the latest status plus
daily-partitioned samples; drift checks (kind C) against the registration
baseline with deduplicated findings; live session and lock reads with
redacted statements; the system suspension request on an identity
mismatch.

**Not its responsibility.** Connecting (it asks `@exponetdb/registry`'s
connector); SQL, introspection and redaction (`@exponetdb/postgres`);
authorization (`@exponetdb/application` decides before calling it);
acting on what it observes (no auto-fix of drift, no terminate, no
re-baseline from a check).

**Allowed dependencies:** `registry`, `postgres`, `postgres/parser`,
`control-store`, `audit` (and `nodes` once it exists).

**Security boundary.** Truthful observation: a failed read is an error or
a failed condition, never an empty list or zero sessions; a stale status
is `cached` and a lagging sampler `unknown`, never live or healthy; a
partial snapshot is `incomplete` and never becomes a baseline or a clean
drift result; simple-protocol success never makes a path healthy when the
extended protocol fails. Catalog text is data: names, comments, bodies and
statements are bounded, statements always redacted, and finding details
hold class, key and hashes, never values.

**Major interfaces.** `observeSchema`, `persistSnapshot`,
`currentBaseline`, `RegistrationSnapshotStore`, `loadDocument`; `schemaOverviewView`, `schemaFingerprintView`,
`searchSchemaView`, `schemaObject`, `schemaDiffView`; `sampleTarget`,
`reduceHealth`, `targetHealthView`, `readStatuses`,
`maintainSamplePartitions`; `runDriftCheck`, `dueDriftTargets`,
`listFindings`; `listSessions`, `lockGraph`.

**Tests.** `bun run test` (`reducer.test.ts`, table-tested; `drift.test.ts`)
and `bun run test:integration` (`diagnostics.int.test.ts`) against a real
Control Store and TLS PostgreSQL 17 with the testkit's fault proxy:
baselines, cached and live reads, drift and its resolution, a pooler that
answers `SELECT 1` but hangs parameterized queries, an unreadable activity
view, a removed marker (system suspension), stored-document tampering and
a gzip bomb.
