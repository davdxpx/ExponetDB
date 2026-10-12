# @exponetdb/migrations-engine

The migration engine of Wave 6, the boundary component `migrations/engine`
([`planning-and-apply.md`](../../exponetdb-docs/04-migrations/planning-and-apply.md),
[`verification.md`](../../exponetdb-docs/04-migrations/verification.md),
[`package-architecture.md` §1.1](../../exponetdb-docs/01-architecture/package-architecture.md#11-packagesmigrations-by-subpath-and-wave)).

**Responsibility.** The immutable bundle store (the server validates and
hashes every submitted bundle itself; revisions, `rewritten_unapplied`,
`MIGRATION_CHECKSUM_MISMATCH` against every ledger of the project); planning
of `migration.apply` from the registry and the live target (identity marker,
ledger and `ls1`, fingerprint, extensions, execution role facts, the
verify.sql catalog resolution), the shared linter on the stored bytes, live
staging evidence, the policy facts and the stored plan; the operation kind:
bindings at acceptance and under the locks, the dedicated migrator session
with the target schema lock, one transaction per migration with the
pre-commit gate (L0) and the ledger row, verification L1 to L3 after commit,
reconciliation that reads and never re-executes, and the Control Store
records (progress, ledger mirror, verification mirror) fenced by the
operation's lease.

Also (Wave 6 acceptance and failure cases): the live comparison of the
target ledger with the mirror on every plan (`divergence.ts`,
`LEDGER_DIVERGENCE` with the rows named; the mirror never adopts a row no
operation of the target wrote); the authority re-check through the
worker's admission before each further migration (`GRANT_REVOKED`); the
verification of an operation in `needs_attention` again on an operator's
request (errored rows back to pending, `up.sql` never again); and, through
an injected recorder (`MigrationKindDeps.expected`, composed from
diagnostics), the verified schema as the target's expected state for
drift. The suite `test/failures.int.test.ts` causes the failure cases on
real PostgreSQL ([G6 record §5](../../exponetdb-docs/14-roadmap/gates/6.md#5-failure-cases-e1-to-e30)).

**Not its responsibility.** Bundle format, checksums and the graph
(`@exponetdb/migrations`, pure); PostgreSQL protocol, catalog SQL, the
parser and the reviewed-statement registry (`@exponetdb/postgres`);
authorization and approvals (`@exponetdb/auth`); HTTP (`apps/server`).

**Allowed dependencies** (`tooling/boundaries/graph.json`, component
`migrations/engine`): `migrations/format`, `migrations/graph`,
`migrations/lint`, `operations`, `registry`, `postgres`, `postgres/parser`,
`control-store`, `audit`, `policy`.

**Security boundary.**

- Bundle text is untrusted (C-26): it runs only as reviewed statements the
  parser of the target's major admitted, one protocol message each, on a
  migrator session, inside `SET LOCAL ROLE` of the execution role the
  registry maps (never a client's claim), with the engine guards read
  around each statement.
- Apply takes a plan id only; the plan binds the stored revision (bundle
  digest), the target's identity, generation, fingerprint and ledger hash,
  the execution roles, the extensions and the evidence; a difference is
  `PLAN_STALE`, never a repair.
- No Control Store write of a worker that lost its lease; no `COMMIT` after
  the lease is gone.
- No evidence bypass (C-15).

**Tests.** `test/engine.int.test.ts` (real PostgreSQL and Control Store).
