# Schema fingerprints

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 4 (fingerprint), Wave 6 (plan binding, verification), Wave 9 (restore verification) |
| Read before | [`postgres-adapter.md`](./postgres-adapter.md) |
| Decision | [ADR-0010](../01-architecture/adr/0010-schema-fingerprint.md) |

A schema fingerprint is a deterministic hash of the structural state of a
database's managed scope. It is used to:

- bind plans to the state they were made for (`PLAN_STALE` when it changes);
- detect drift (state that no ledger entry explains);
- compare environments (lineage: is production where staging was?);
- verify restores (does the restored database have the structure the backup had?).

**[DECIDED]** The fingerprint is computed from a **canonical document** built from
catalog queries, never from `pg_dump` text. `pg_dump` output varies with dump
version, object ordering heuristics and options; it is a backup format, not an
identity.

## 1. Format

```
fp1:<pg_major>:<sha256 hex>
```

- `fp1`: canonicalizer version. A changed canonicalizer is `fp2`; history keeps
  `fp1` values; values of different versions are never compared, they are
  "not comparable".
- `<pg_major>`: the server major version. Some deparsed texts (`pg_get_expr`,
  `pg_get_viewdef`, `pg_get_triggerdef`) can render differently across majors;
  fingerprints of different majors are "not comparable" (the drift tool then
  compares canonical documents structurally and reports rendering differences
  separately).
- Hash: SHA-256 over the RFC 8785 (JCS) serialization of the canonical document.

The **canonical document** itself is stored (compressed) in the Control Store for
every fingerprint that a plan, ledger row or restore references, so that two
fingerprints can be diffed object by object later.

## 2. Managed scope

**[DECIDED]**

- Included schemas: the project's `managedScope.includeSchemas` (default: all
  non-system schemas) minus exclusions.
- Always excluded: `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp_*`,
  and `exponetdb` (the ledger changes on every migration; its state is bound
  separately by the ledger state hash).
- Project-configured exclusions, for example the hosted provider's schemas
  during REOSA's transition: `auth`, `storage`, `realtime`, `_realtime`,
  `extensions` (objects, not the extension list), `graphql`, `graphql_public`,
  `pgbouncer`, `vault`, `pgsodium`, `pgsodium_masks`, `supabase_functions`,
  `supabase_migrations`, `net`, `cron`, plus tool ledgers like `drizzle`.
- Objects owned by extensions (`pg_depend.deptype = 'e'`) are excluded
  individually and represented only by the extension entry (name, version,
  schema). Otherwise every pgvector operator would be part of the application
  schema.

## 3. What is in the document

**[DECIDED]** Object classes and the attributes that identify them. Identity keys
are **names**, never OIDs (OIDs differ between environments and after restores).

| Class | Key | Attributes (canonicalized) |
|---|---|---|
| Schema | name | owner, ACL (sorted `aclexplode` entries); documentation digest stored beside the hashed attributes, not hashed (see §5) |
| Extension | name | version, schema |
| Type: enum | schema.name | labels in `enumsortorder` order, owner, ACL |
| Type: domain | schema.name | base type (`format_type` with typmod), not null, default expression (`pg_get_expr(typdefaultbin)`), check constraints (`pg_get_constraintdef`, sorted by name), collation, owner |
| Type: composite | schema.name | attributes in order (name, type with typmod, collation), owner |
| Type: range / multirange | schema.name | subtype, opclass, collation, canonical/subdiff functions |
| Sequence | schema.name | data type, start, increment, min, max, cycle, cache, owned-by column; **not** the current value |
| Table | schema.name | relkind (`r`, `p`), persistence (permanent/unlogged), partition key (`pg_get_partkeydef`), partition bound (`pg_get_expr(relpartbound)`), inheritance parents (sorted), RLS enabled, RLS forced, replica identity, access method, reloptions (sorted), owner, ACL |
| Column | table + name | position **relative order** among non-dropped columns, type (`format_type(atttypid, atttypmod)`), not null, default (`pg_get_expr`), identity (kind, sequence options), generated expression, collation (if not default), storage (if not default), compression (if set), statistics target (if set), column ACL |
| Constraint | table + name | type, definition (`pg_get_constraintdef(oid, true)`), deferrable, initially deferred, validated, `NOT ENFORCED` (PG18+), referenced table for FKs |
| Index | schema.name | table, definition (`pg_get_indexdef`), unique, primary, exclusion, nulls not distinct, valid, ready, predicate, include columns, opclasses, reloptions (e.g. HNSW `m`, `ef_construction`), tablespace (if not default) |
| View | schema.name | definition (`pg_get_viewdef(oid, true)`), reloptions (`security_invoker`, `security_barrier`, `check_option`), owner, ACL, column ACLs |
| Materialized view | schema.name | definition, reloptions, owner, ACL; **not** populated state |
| Function / procedure / aggregate | schema.name(identity args) | kind, return type, language, body digest (SHA-256 of `prosrc`, or of `probin`+`prosrc` for C), volatility, strict, leakproof, parallel, security definer, `proconfig` (sorted), cost, rows, owner, ACL |
| Trigger | table + name | definition (`pg_get_triggerdef(oid, true)`), enabled state (`O`, `D`, `R`, `A`), internal flag excluded, constraint trigger flag |
| Event trigger | name | event, tags, function, enabled state, owner |
| Policy | table + name | command, permissive/restrictive, roles (sorted; the PUBLIC pseudo-role `{0}` is JSON `null`, see below), `USING` (`pg_get_expr`), `WITH CHECK` |
| Rule (non-view) | table + name | definition (`pg_get_ruledef`) |
| Statistics object | schema.name | kinds, columns/expressions |
| Publication | name | all tables, publish flags, via root, tables (and row filters, column lists), schemas |
| Default privileges | (role, schema, object type) | ACL entries (sorted) |
| Collation (user-defined) | schema.name | provider, locale, deterministic |
| Cast, operator, operator class, text search config (user-defined only) | identity | definition fields |

**[DECIDED]** (Wave 4, corrected before G4) The PUBLIC pseudo-role is never
rendered as the text `PUBLIC`: a role may literally be named `"PUBLIC"`
(PostgreSQL reserves only the lowercase `public`), and `TO PUBLIC` and
`TO "PUBLIC"` must never hash the same. In a policy's role list PUBLIC is
`null` (sorted first); in an ACL entry (`aclexplode`) PUBLIC is the absence of
`to`. The `fp1` golden vectors pin both next to a real role named `"PUBLIC"`.

**Roles are not in the database fingerprint**: roles are cluster-wide. Roles
referenced by ACLs and policies appear by name. A separate **cluster
fingerprint** covers roles (attributes, memberships with `admin/inherit/set`
options, per-database settings from `pg_db_role_setting`) and is used by the
role desired-state capability ([`credentials-and-roles.md`](./credentials-and-roles.md))
and by restore verification.

**Excluded on purpose**: OIDs, sizes, row counts, statistics, `relpages`,
`reltuples`, populated state of materialized views, current sequence values,
`pg_class.relfilenode`, transaction ids, index build state other than
valid/ready, comments (see §5).

## 4. Determinism rules

**[DECIDED]**

1. The introspection session pins `search_path = ''`, `TimeZone = UTC`,
   `DateStyle = ISO, YMD`, `IntervalStyle = postgres`, `extra_float_digits = 1`,
   `bytea_output = hex`, `standard_conforming_strings = on`,
   `quote_all_identifiers = off`. With an empty `search_path`, every deparsed
   name is schema-qualified, so the result does not depend on the caller.
2. All collections are sorted by their key with byte-wise ordering of UTF-8
   (`COLLATE "C"` in SQL, and a re-sort in the engine).
3. Every aggregate in introspection SQL has an explicit `ORDER BY`.
4. Absent and default values are omitted rather than serialized as `null`, so
   that new nullable attributes in a later canonicalizer version do not change
   old documents (they would only appear when set).
5. Booleans, integers and strings use their JSON types; no floats (none needed).
6. Expressions are taken as PostgreSQL deparses them (`pg_get_expr` etc.), not
   re-formatted.
7. The document carries a header `{ canonicalizer: "fp1", pgMajor, scope }` that
   is part of the hash.

## 5. Comments

Comments (`COMMENT ON`) are not structural. **[DECIDED]** The fingerprint excludes
them; the canonical document stores a separate **documentation digest** per object
so that drift reports can show comment differences as informational.

## 6. Hierarchy for diffs

The document is a list of object entries, each with its own SHA-256 over its JCS
form. The fingerprint is computed over the sorted list of `(class, key, entry
hash)`. This makes diffs cheap: compare entry hashes, then compare attributes of
changed entries.

## 7. Performance

The fingerprint must be cheap enough to compute at plan time, at apply under the
advisory lock, and after each migration.

- One introspection query per object class, keyset-paginated where a class can
  be large; queries are designed to use catalog indexes.
- **[DECIDED]** Every introspection query is covered by a plan-guard test that
  runs `EXPLAIN (ANALYZE, FORMAT JSON)` against a synthetic catalog of at least
  2,000 tables (with partitions, policies, pgvector columns, many functions) and
  fails on unexpected sequential scans of large catalogs. This idea is adopted
  from the Supabase reference's pg-meta test suite
  ([`../11-ui/supabase-reference-audit.md`](../11-ui/supabase-reference-audit.md#postgresql-introspection-pg-meta)).
- Target budget for REOSA's size (about 400 tables, 380 policies, 1,400 indexes,
  110 functions): under 2 seconds.
- **[OBSERVED]** (Wave 4, 2026-10-06, `packages/postgres/test/budget.int.test.ts`,
  synthetic `consumerSizedStatements()` with exactly those counts plus 100
  foreign keys, 100 triggers, 20 views and grants; four-core development
  container, PostgreSQL in Docker on the same host; 15 runs after two warm-up
  runs, each on a fresh observer session): median 373 ms, p95 450 ms on
  PostgreSQL 16 (6,153 entries); median 362 ms, p95 420 ms on 17 (6,153);
  median 407 ms, p95 444 ms on 18 (8,153, catalogued `NOT NULL`
  constraints); 22 queries each. The test fails when the median exceeds
  2 seconds. The 2,000-table plan-guard catalog snapshots in about 1.4 to
  1.5 seconds (21,505 entries on 16 and 17, 25,745 on 18, 54 queries).

## 8. Visibility

The introspecting role (`exponetdb_observer`) must be able to see every object in
scope. PostgreSQL catalogs are readable by any role, but some deparse functions
and ACL views apply privilege filtering. **[DECIDED]** The fingerprint result
includes a **visibility report** (objects or attributes the role could not
read). A non-empty visibility report makes the fingerprint `incomplete`, and an
incomplete fingerprint cannot be used for plan binding or evidence (fail closed).

**[DECIDED]** (Wave 4, `packages/diagnostics`) Storage and use of documents:

- A canonical document is stored once per fingerprint in the Control Store
  (`observation.schema_documents`) and never changes. The stored bytes are the
  gzip of the document's JCS form; compression is storage only and never part
  of `fp1`. Beside them: `content_bytes` (the uncompressed length) and
  `document_digest` (SHA-256 of the uncompressed bytes).
- A document is used only after it verifies on read: it is never inflated past
  `content_bytes` (a stored gzip bomb stops at once), the digest must match,
  every entry hash is recomputed and the recomputed fingerprint must be the
  row's key. A document that fails any check is never used (`DocumentCorrupt`,
  reported as `INTERNAL`).
- Comments are not structure (§5): two snapshots with the same fingerprint may
  carry different documentation digests; the first stored document is kept.
- Every snapshot row records the target and generation, completeness, the
  visibility report, configured schemas that do not exist, the schemas that
  exist outside the managed scope (`excluded_schemas`, reported as
  `unmanaged`, never as matched), the server version, why it was taken
  (`registration`, `drift_check`, `read`) and how long it took.
- Every snapshot is taken on an observer session whose identity marker was
  checked first (installation, target, generation, cluster
  `system_identifier`); a snapshot of the wrong database is never stored.
- Schema reads reuse a stored document of the target's current generation
  that is younger than 30 seconds and has the project's current scope
  (`source: cached`); otherwise they take and store a live snapshot
  (`source: live`). The fingerprint read is always live.

## 9. Hostile metadata

Object names, comments, expressions and function bodies are attacker-controllable
by anyone who can create objects in the database. They are data: never
interpolated into SQL without context-correct escaping, never rendered as HTML or
Markdown without escaping, and length-capped in UI and MCP output. Fixtures with
names containing quotes, `$$`, newlines, Unicode confusables, very long names
(63-byte truncation) and reserved words are part of the test suite
([`../08-auth-and-security/threat-model.md`](../08-auth-and-security/threat-model.md)).

## 10. Tests

- **Determinism**: same database, fingerprint computed 100 times across sessions
  with different `search_path`, `TimeZone`, `DateStyle` settings → identical.
- **Independence from OIDs**: two databases built from the same SQL in
  different orders of unrelated objects → identical.
- **Sensitivity**: each attribute in §3 is mutated once in a fixture → fingerprint
  changes; mutations of excluded properties (sizes, comments, sequence values) →
  unchanged.
- **Restore**: dump/restore round trip → identical (given identical roles).
- **Version matrix**: fingerprints computed on 16, 17, 18 for the same schema; the
  test records which entries render differently across majors (expected small).
- **Golden vectors** (Wave 4, order §227 to §229): `tooling/golden/fp1.json`
  holds the fixture SQL, the canonical document and the fingerprint of a
  minimal, a complex, a security (grants, row security, policies, `SECURITY
  DEFINER`, default privileges, an event trigger) and a hostile-names schema
  on each of PostgreSQL 16, 17 and 18, plus a scoped variant and two changed
  variants; `tooling/golden/schema-diff.json` holds diffs between them (add,
  remove, change, documentation only, security changes, and the
  cross-major rendering differences: `MAINTAIN` in default relation ACLs and
  the catalogued domain `NOT NULL` from 17, catalogued column `NOT NULL`
  constraints from 18). `golden.int.test.ts` rebuilds every vector from its
  SQL on real PostgreSQL; `golden.test.ts` reproduces hashes and diffs without
  a database; the expected values were re-derived independently
  ([`tooling/golden/README.md`](../../tooling/golden/README.md)).

## 11. Corrections and `fp2`

**[DECIDED]** (Wave 4, order §228)

- Before the owner accepts G4, the `fp1` implementation may still be
  corrected: no fingerprint is referenced by a plan, a ledger row or a
  restore yet. A correction changes the golden vectors in the same pull
  request and is listed in the G4 gate record.
- From the G4 acceptance on, the meaning of `fp1` is immutable: the same
  catalog state on the same major always yields the same `fp1` value, and
  the golden vectors are append-only.
- A later semantic fix is a new canonicalizer, `fp2`, introduced by an ADR.
  History keeps its `fp1` values; `fp1` and `fp2` values are never compared
  (§1, "not comparable"), and nothing silently re-fingerprints old documents.

Corrections made before G4 (each is listed in the G4 gate record):

| Date | Correction | Golden vectors |
|---|---|---|
| 2026-10-06 | A domain's default is deparsed from its expression tree (`pg_get_expr(typdefaultbin, 0)` with the pinned empty `search_path`) instead of `typdefault`, the text kept from creation: that text depended on the creator's `search_path` and kept a renamed sequence's old name (adversarial review). | unchanged (no vector has a domain default); regression test in `fingerprint.int.test.ts` |

