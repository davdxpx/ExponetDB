# Canonical migration ledger

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 1 (`ls1` ledger state hash in `packages/migrations/format`), Wave 4 (identity marker), Wave 6 (ledger) |
| Read before | [`migration-bundles.md`](./migration-bundles.md), [`verification.md`](./verification.md) |
| Decision | [ADR-0013](../01-architecture/adr/0013-in-target-ledger.md) |

## 1. Where the truth lives

**[DECIDED]** The canonical record of what has been applied to a database lives
**inside that database**, in the schema `exponetdb`
([C-19](../00-product/constitution.md#c-19-the-ledger-lives-with-the-data)). The
Control Store keeps a **mirror** of every target's ledger plus everything that is
not about the database itself (plans, operations, approvals, audit).

Why inside the target:

- A restore brings back the database *and* its history in one consistent state.
  A ledger only in the Control Store would claim migrations that the restored
  database no longer has.
- The ledger insert can be part of the migration's own transaction: for
  transactional migrations "applied" and "recorded" are atomic.
- A database moved to another server, or inspected without ExponetDB, still says
  what it is and what was done to it.

Why also a mirror:

- Evidence lookups, dashboards and the REST API must work when a target is
  unreachable (marked stale, never as empty, C-28).
- **Tamper and drift detection**: the mirror is updated only by ExponetDB
  operations. A target ledger that differs from the mirror means someone wrote
  the ledger outside ExponetDB, or a restore rolled the target back. Both block
  schema changes on the target (`LEDGER_DIVERGENCE`) until an operator reconciles
  them through a planned `ledger.reconcile` operation.

**[OBSERVED]** REOSA today has three ledgers (`supabase_migrations.schema_migrations`
via the hosted provider's MCP, `drizzle.__drizzle_migrations` via
`bun db:migrate`, `public.applied_migrations` via `apply-migrations.sh`) and none
of them has a checksum; the provider ledger stores names that differ from file
names for about a quarter of the entries
(`REOSA/.claude/rules/migrations.md`). ExponetDB's ledger replaces all three for
new work and imports them once ([`legacy-import.md`](./legacy-import.md)). It
does not become a fourth ledger running in parallel.

## 2. Schema `exponetdb` in each target database

**[DECIDED]** Shape (DDL is illustrative; the authoritative DDL ships as the
target-side bootstrap migration set of the engine, versioned by
`ledger_schema_version`).

```sql
-- Owned by a NOLOGIN role; only ExponetDB's migrator can write, only via grants below.
CREATE SCHEMA exponetdb AUTHORIZATION exponetdb_ledger_owner;
REVOKE ALL ON SCHEMA exponetdb FROM PUBLIC;

-- 2.1 Identity marker (exactly one row). Verified before every write (C-27).
CREATE TABLE exponetdb.target_identity (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id     text    NOT NULL,   -- id of the ExponetDB installation that manages this DB
  target_id           text    NOT NULL,   -- tgt_…
  target_path         text    NOT NULL,   -- reosa/platform/production (informative)
  tier                text    NOT NULL CHECK (tier IN ('prod','nonprod')),
  generation          integer NOT NULL CHECK (generation > 0),
  stamped_at          timestamptz NOT NULL,
  stamped_by_op       text    NOT NULL,   -- op_…
  cluster_system_id   text    NOT NULL    -- system_identifier at stamping time
);

-- 2.2 Ledger metadata (exactly one row).
CREATE TABLE exponetdb.ledger_meta (
  singleton             boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_schema_version integer NOT NULL,
  project_id            text    NOT NULL,
  baseline_id           text,             -- baseline:<slug> or NULL for streams without legacy history
  created_at            timestamptz NOT NULL
);

-- 2.3 The ledger: one row per applied migration. Append-only except the revert columns.
CREATE TABLE exponetdb.schema_migrations (
  migration_id          text PRIMARY KEY,           -- ULID, or legacy:<identity>, or baseline:<slug>
  origin                text NOT NULL CHECK (origin IN ('exponetdb','legacy_import','baseline')),
  name                  text NOT NULL,
  checksum              text NOT NULL,              -- sha256:c1:<hex>, or legacy forms, see legacy-import.md
  checksum_provenance   text NOT NULL CHECK (checksum_provenance IN
                          ('computed_at_apply','legacy_file_at_import','legacy_tool_hash',
                           'legacy_applied_statements','unknown')),
  source_digest         text,                       -- raw-bytes digest of up.sql (informative, see migration-bundles.md §3)
  verify_digest         text,
  rollback_digest       text,
  manifest              jsonb,                      -- hashed execution fields, canonical form
  dependencies          text[] NOT NULL DEFAULT '{}',
  transactional         boolean,
  source                jsonb,                      -- source reference, see authoring-and-ci.md
  applied_seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  applied_at            timestamptz NOT NULL,
  apply_duration_ms     integer,
  plan_id               text,                       -- pln_…   (NULL for legacy imports)
  operation_id          text NOT NULL,              -- op_…
  actor_ref             text,                       -- idn_… opaque id, never e-mail or name
  client_ref            text,                       -- cli_… opaque id
  engine_version        text NOT NULL,
  pg_version_num        integer NOT NULL,
  fingerprint_before    text,                       -- fp1:…
  fingerprint_after     text,
  reverted_at           timestamptz,                -- set once by migration.rollback
  reverted_by_op        text
);

-- 2.4 Verification history: append-only, one row per verification run.
CREATE TABLE exponetdb.migration_verifications (
  verification_id   text PRIMARY KEY,               -- ULID
  migration_id      text NOT NULL REFERENCES exponetdb.schema_migrations,
  operation_id      text NOT NULL,
  verify_digest     text,                           -- which verify.sql ran (NULL if none)
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('passed','failed','partial','error')),
  structural        jsonb NOT NULL,                 -- summary: checks, passed, failed, underived statements
  runtime           jsonb,                          -- verify.sql results (redacted)
  engine            jsonb NOT NULL,                 -- fingerprint, invalid indexes, unvalidated constraints
  fingerprint       text NOT NULL
);

-- 2.5 Event log: append-only, records steps that matter for reconciliation.
CREATE TABLE exponetdb.migration_events (
  event_seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  migration_id  text NOT NULL,
  operation_id  text NOT NULL,
  event         text NOT NULL CHECK (event IN (
                  'nontx_started','nontx_statement_done','nontx_failed',
                  'applied','reverted','imported','baselined','ledger_reconciled')),
  detail        jsonb NOT NULL DEFAULT '{}'
);
```

### 2.6 Privileges and immutability

**[DECIDED]**

| Role | Privileges on `exponetdb` |
|---|---|
| `exponetdb_ledger_owner` (NOLOGIN) | owns schema and tables; nobody logs in as it |
| `exponetdb_migrator` | `USAGE`; `SELECT` and `INSERT` on all tables; `UPDATE (reverted_at, reverted_by_op)` on `schema_migrations` only; `UPDATE` on `target_identity` and `ledger_meta` |
| `exponetdb_observer`, `exponetdb_reader`, `exponetdb_verifier`, `exponetdb_operator` | `USAGE`; `SELECT` (the operator, like the migrator, reads the marker before a write-capable session is handed out, C-27; G4 correction 2026-10-07) |
| application roles listed in the project's runtime schema contract | `USAGE` on the schema and `EXECUTE` on `exponetdb.missing_migrations(text[])` only ([`authoring-and-ci.md` §8](./authoring-and-ci.md#8-runtime-schema-contract)); no table privileges |
| execution roles (e.g. `reosa_owner`) and every other role | nothing |

A trigger on `schema_migrations` rejects any `UPDATE` that changes a column other
than `reverted_at`/`reverted_by_op`, and any update of those two once they are
set. Triggers on `migration_verifications` and `migration_events` reject `UPDATE`
and `DELETE`. There is no `DELETE` grant on any ledger table.

A superuser can still alter the ledger. ExponetDB does not pretend otherwise; it
**detects** it through the mirror comparison (§1) and through the fact that the
mirror's last known `ledger_state_hash` no longer matches.

### 2.7 What is deliberately not in the target ledger

- Personal data: no names, no e-mail addresses. `actor_ref` and `client_ref` are
  opaque ids resolvable only in the Control Store (so that erasing a person in
  ExponetDB does not require rewriting every database's history).
- Plan content, policy decisions, approvals, break-glass details: Control Store.
- The SQL text of `up.sql`: the bundle store in the Control Store holds it,
  addressed by checksum. The ledger holds the checksum. (Storing large SQL in
  every target adds nothing the checksum does not already bind.)

## 3. Derived values

**[DECIDED]**

- **Applied set** of a target: rows with `reverted_at IS NULL`.
- **Ledger state hash**: `sha256:ls1:` + SHA-256 over the UTF-8 lines
  `migration_id SP checksum SP state LF`, sorted by `migration_id`, where `state`
  is `A` (applied) or `R` (reverted), followed by the line
  `baseline SP <baseline_id or ->`. Plans bind to it; it changes whenever any
  migration is applied or reverted.

  **[DECIDED]** Exact form (Wave 1 clarification, frozen at G1 together with
  `c1`; implemented in `packages/migrations/format` and independently in the Go
  conformance implementation, pinned by golden vectors):
  - one line per row of `schema_migrations` (every origin: bundles, legacy
    imports and the baseline row itself);
  - `migration_id` and `checksum` are non-empty and contain no code point up to
    U+0020 and no U+007F, so that the space and line separators cannot occur
    inside them; `migration_id` is unique; otherwise the hash is refused;
  - lines are sorted by `migration_id` in UTF-8 byte order (equal to code point
    order);
  - every line ends with LF, including the final baseline line;
  - `baseline_id` is `ledger_meta.baseline_id` (`baseline:<slug>`, slug rule
    as in [`migration-bundles.md` §2](./migration-bundles.md#2-manifest-migrationyaml))
    or `-` when it is NULL;
  - the value is `sha256:ls1:` followed by the lowercase hexadecimal SHA-256 of
    the UTF-8 bytes of all lines.

  An empty ledger without a baseline therefore hashes the single line
  `baseline -` LF. Checks run in this order and the first failure is the
  result: each row's `migration_id` then `checksum`, in input order
  (`invalid_migration_id`, `invalid_checksum`); duplicate ids
  (`duplicate_migration_id`); the baseline id (`invalid_baseline_id`).
- **Current verification status** of a migration on a target: the status of the
  latest `migration_verifications` row (by `finished_at`), or `pending` if none.
- **Evidence record** (Control Store): derived from a ledger row plus its latest
  passing verification row, see [`staging-production-policy.md`](./staging-production-policy.md).

## 4. Lifecycle of the `exponetdb` schema in a target

1. **Initialization** (`target.identity.stamp` + `ledger.initialize`, Wave 4/6):
   creates roles if missing (via node capability or by a human for external
   clusters), the schema, the tables, the identity row, `ledger_meta`. Planned
   operation; for prod tier it requires approval.
2. **Baseline** (`migration.baseline`, Wave 6): legacy import writes `imported`
   and `baselined` events and `origin = legacy_import|baseline` rows.
3. **Normal operation**: `migration.apply`, `migration.verify`,
   `migration.rollback` write rows as described in
   [`planning-and-apply.md`](./planning-and-apply.md).
4. **Ledger schema upgrades**: the engine ships target-side ledger migrations
   (`ledger_schema_version`). They are applied by the engine itself, in a
   transaction, under the target's schema lock, as part of the first operation
   that needs the new version; they are additive only (new nullable columns,
   new tables). A destructive ledger change would be a new ADR.
5. **Restore**: the restored database brings its own `exponetdb` schema. The
   restore operation re-stamps the identity (new `generation`) and reconciles the
   mirror to the restored ledger, recording a `ledger_reconciled` event. Plans
   bound to the old generation become stale.

## 5. Mirror and reconciliation

**[DECIDED]**

- After every operation that writes the target ledger, the worker reads the
  written rows back (from the target, on a new connection) and upserts them into
  the mirror together with the observed `ledger_state_hash`.
- A periodic reconciliation (default every 10 minutes per active target, and on
  every plan) compares `ledger_state_hash` of target and mirror.
- Divergence classes:

| Divergence | Typical cause | Effect |
|---|---|---|
| Target has rows the mirror lacks, written by ExponetDB (matching `operation_id` known in Control Store) | Crash between commit and mirror update | Auto-heal: mirror updated, audit event `ledger.mirror_healed` |
| Target has rows with unknown `operation_id` | Someone wrote the ledger by hand, or another installation manages this DB | `LEDGER_DIVERGENCE`, target suspended for schema changes, finding raised |
| Mirror has rows the target lacks | Restore to an older state, or manual deletion | `LEDGER_DIVERGENCE`; if a restore operation explains it, the restore's reconcile step resolves it |
| Same `migration_id`, different checksum | Tampering or a bug | `LEDGER_DIVERGENCE` + `MIGRATION_CHECKSUM_MISMATCH` finding (critical) |
| `installation_id` in target differs from this installation | Two ExponetDB installations, or a copied database | Target refused (`TARGET_IDENTITY_MISMATCH`) |

`ledger.reconcile` is a planned, audited operation that records the operator's
decision (adopt target as truth, or flag rows as untrusted) without deleting any
row anywhere.

## 6. Retention

The ledger is permanent history. Nothing is purged from `schema_migrations`.
`migration_verifications` and `migration_events` are kept with the ledger;
their volume is small (rows per migration, not per request). Squashing history
is done with a new baseline, never by deleting rows.
