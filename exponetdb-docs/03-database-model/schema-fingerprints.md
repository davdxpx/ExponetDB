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
  schema. **[DECIDED]** (owner decision R1, 2026-10-07) The extension entry
  also lists its **members**: the `pg_identify_object` identities (type,
  identity) of every member created in this database (`oid >= 16384`),
  sorted, without implicit types (an array type follows its element type, a
  row type its relation; PostgreSQL 17 began to record them, 16 does not).
  `ALTER EXTENSION … ADD TABLE` (possible for any role that may create a
  trusted extension such as `hstore`) therefore changes the fingerprint
  instead of making the table disappear silently. An extension created at
  `initdb` (`plpgsql`) has no such members, so its entry is unchanged. The
  structure of a member is still not hashed: a table moved into an extension
  shows as moved (critical drift, [`drift-detection.md` §6](./drift-detection.md#6-security-relevant-drift)),
  and later changes inside it are not seen (residual).

## 3. What is in the document

**[DECIDED]** Object classes and the attributes that identify them. Identity keys
are **names**, never OIDs (OIDs differ between environments and after restores).

| Class | Key | Attributes (canonicalized) |
|---|---|---|
| Schema | name | owner, ACL (sorted `aclexplode` entries); documentation digest stored beside the hashed attributes, not hashed (see §5) |
| Extension | name | version, schema, members (since the G4 correction: identities of the members created in this database, see §2) |
| Type: enum | schema.name | labels in `enumsortorder` order, owner, ACL |
| Type: domain | schema.name | base type (`format_type` with typmod), not null, default expression (`pg_get_expr(typdefaultbin)`), check constraints (`pg_get_constraintdef`, sorted by name), collation, owner |
| Type: composite | schema.name | attributes in order (name, type with typmod, collation as `[schema, name]`), owner |
| Type: range / multirange | schema.name | subtype, opclass and collation (each `[schema, name]`), canonical/subdiff functions |
| Sequence | schema.name | data type, start, increment, min, max, cycle, cache, owned-by column; **not** the current value |
| Table | schema.name | relkind (`r`, `p`), persistence (permanent/unlogged), partition key (`pg_get_partkeydef`), partition bound (`pg_get_expr(relpartbound)`), inheritance parents (sorted), RLS enabled, RLS forced, replica identity and, for `USING INDEX`, the index name, access method, reloptions (sorted), owner, ACL |
| Column | table + name | position **relative order** among non-dropped columns, type (`format_type(atttypid, atttypmod)`), not null, default (`pg_get_expr`), identity (kind, sequence options, the ACL of the identity sequence when it differs from the owner's default: a `GRANT` then `REVOKE` leaves `relacl` spelled out as the default, which is omitted like `NULL`), generated expression, collation (if not default), storage (if not default), compression (if set), statistics target (if set), column ACL |
| Constraint | table + name | type, definition (`pg_get_constraintdef(oid, true)`), deferrable, initially deferred, validated, `NOT ENFORCED` (PG18+), referenced table for FKs |
| Index | schema.name | table, definition (`pg_get_indexdef`), unique, primary, exclusion, nulls not distinct, valid, ready, predicate, include columns, opclasses, reloptions (e.g. HNSW `m`, `ef_construction`), tablespace (if not default) |
| View | schema.name | definition (`pg_get_viewdef(oid, true)`), reloptions (`security_invoker`, `security_barrier`, `check_option`), owner, ACL, column ACLs |
| Materialized view | schema.name | definition, reloptions, owner, ACL; **not** populated state |
| Function / procedure / aggregate | schema.name(identity args) | kind, return type, language, body digest (SHA-256 of `prosrc`, or of `probin`+`prosrc` for C, or of `sql_body` and the SQL-standard body), a `sqlBody` flag for a SQL-standard body, argument defaults (`pg_get_expr(proargdefaults)`), volatility, strict, leakproof, parallel, security definer, `proconfig` (sorted), cost, rows, owner, ACL; for an aggregate its transition, final (with extra and modify), combine, serial, deserial, moving-aggregate and sort-operator definitions, state types, spaces and initial values |
| Trigger | table + name | definition (`pg_get_triggerdef(oid, true)`), enabled state (`O`, `D`, `R`, `A`), internal flag excluded, constraint trigger flag |
| Event trigger | name | event, tags, function, enabled state, owner |
| Policy | table + name | command, permissive/restrictive, roles (sorted; the PUBLIC pseudo-role `{0}` is JSON `null`, see below), `USING` (`pg_get_expr`), `WITH CHECK` |
| Rule (non-view) | table + name | definition (`pg_get_ruledef`) |
| Statistics object | schema.name | kinds, columns/expressions |
| Publication | name | all tables, publish flags, via root, tables (and row filters, column lists), schemas, published generated columns (PostgreSQL 18, when not `none`) |
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
   `quote_all_identifiers = off` and (G4 correction) `lc_monetary = C`:
   `money` constants deparse through `lc_monetary` (`'$12.34'::money` under
   C, `'12,34 €'::money` under `de_DE`, observed on PostgreSQL 17). With an empty `search_path`, every deparsed
   name is schema-qualified, so the result does not depend on the caller.
2. All collections are sorted by their key with byte-wise ordering of UTF-8
   (`COLLATE "C"` in SQL, and a re-sort in the engine). A list of name
   tuples (a table's inheritance parents `[schema, name]`, an extension's
   members `[type, identity]`) is sorted by the UTF-8 bytes of each tuple's
   JSON serialization (`JSON.stringify`, no whitespace), not tuple by tuple:
   `["operator class",…]` sorts before `["operator",…]` because `"` is
   `0x22` and space `0x20`, and a `"` or `\` inside a name sorts by its
   escaped form. The SQL order of such a list is for stability only; the
   engine's re-sort decides.
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
  exist outside the managed scope or belong to an extension
  (`excluded_schemas`, reported as `unmanaged`, never as matched), the server version, why it was taken
  (`registration`, `drift_check`, `read`; since Wave 6 `migration`; since
  Wave 8 `drift_accept`, bundle `01M4V4DA2W7HK9QB5NZ3XT6RME_drift-acceptance`)
  and how long it took.
- **[DECIDED]** (Wave 8, order §9, `drift.accept`) An incomplete snapshot is
  never a baseline, also for a drift acceptance: its planner refuses one
  (`REGISTRY_CONFLICT`, reason `snapshot_incomplete`), its plan binds the
  `fp1` fingerprint of the complete snapshot it will record, and the worker
  records only a new complete snapshot with exactly that fingerprint
  ([`drift-detection.md` §5](./drift-detection.md#5-resolutions)).
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

**[DECIDED]** (Wave 7, order §22) The caps of catalog text. The REST
contract caps each field (comments 8 192 characters, definitions 256 KiB,
policy, constraint and index expressions 8 192, column expressions 4 096,
names 63). An MCP client gets less, and every cut is named
(`schema_inspect` lists the JSON pointers of the cut fields in
`truncated`; contracts `MCP_CATALOG_TEXT_CAPS`):

| Field | MCP cap |
|---|---|
| object comment | 2 000 characters |
| deparsed definition (function bodies, views) | withheld unless `include` names `definition`; then 16 384 |
| policy `USING` and `WITH CHECK` | withheld unless `include` names `policy_expressions`; then 4 096 each |
| column default and generation expressions | 1 024 |
| constraint and index definitions | 2 048 |

What is withheld is named in `omitted`. A redacted statement in a session
list is capped at 500 characters for an MCP client (2 000 for people),
with `truncated` and the digest of the whole redacted text
([`statement-redaction.md`](./statement-redaction.md), step 5).
Every string an agent receives is also escaped (control, bidirectional,
zero-width and tag characters become a visible `\u{...}`), and in the text
block links, images and fences are defused ([`../05-mcp/architecture.md`](../05-mcp/architecture.md)).

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
  the golden vectors are append-only. **[DECIDED]** G4 was accepted on
  2026-10-07 under the owner's conditional delegation, on the baseline
  `04b2e7705df8047aa89f4c28670cfb75a4e11bea`: `fp1` is frozen as this
  document describes it on that baseline (with the corrections listed
  below), and the vectors `fp1-001` to `fp1-018` (`tooling/golden/fp1.json`)
  and `diff-001` to `diff-007` (`schema-diff.json`) are its locked baseline.
- A later semantic fix is a new canonicalizer, `fp2`, introduced by an ADR.
  History keeps its `fp1` values; `fp1` and `fp2` values are never compared
  (§1, "not comparable"), and nothing silently re-fingerprints old documents.

Corrections made before G4 (each is listed in the G4 gate record):

| Date | Correction | Golden vectors |
|---|---|---|
| 2026-10-06 | A domain's default is deparsed from its expression tree (`pg_get_expr(typdefaultbin, 0)` with the pinned empty `search_path`) instead of `typdefault`, the text kept from creation: that text depended on the creator's `search_path` and kept a renamed sequence's old name (adversarial review). | unchanged (no vector has a domain default); regression test in `fingerprint.int.test.ts` |
| 2026-10-07 | Owner decision R1: an extension entry lists the identities of its members created in the database (§2); before, `ALTER EXTENSION … ADD` took an object, its policies and row security included, out of the fingerprint without a trace (G4 review; reproduced for a role that is not a superuser through the trusted `hstore`). | the 22 locked vectors unchanged (their only extension, `plpgsql`, has no such members); `fp1-016` to `fp1-018` appended |
| 2026-10-07 | `lc_monetary = C` pinned (§4): `money` constants deparsed by the session's `lc_monetary`, so equal schemas had different fingerprints under different database settings. | unchanged (no vector has a `money` constant); `fp1-016` to `fp1-018` pin it |
| 2026-10-07 | Blind spots closed (G4 review; owner decision to close every gap that changes no locked vector): function argument defaults (a `CREATE OR REPLACE` that changes a default was invisible), a `sqlBody` flag (a string body spelling `sql_body` and the text of a SQL-standard body had the same digest), aggregate support functions (combine, serial, deserial, moving aggregate, sort operator, final modify, spaces), the explicit ACL of an identity sequence, the index of `REPLICA IDENTITY USING INDEX`, schema-qualified collations of composite attributes and ranges and the range opclass, and PostgreSQL 18's published generated columns. | unchanged (absent attributes are omitted and no locked vector has these objects); `fp1-016` to `fp1-018` pin them |
| 2026-10-07 | The identity-sequence ACL is canonical (second G4 correction review): it was emitted whenever `relacl` was not `NULL`, but a `GRANT` then `REVOKE` leaves the owner's default spelled out, so equal privileges gave different fingerprints and a drift warning that never cleared. It is now emitted only when it differs from `acldefault('s', owner)`. Members and parents are documented as sorted by their JSON serialization (§4 rule 2), as the engine always did. | unchanged (no vector has a grant on an identity sequence); regression test in `fingerprint.int.test.ts` |

