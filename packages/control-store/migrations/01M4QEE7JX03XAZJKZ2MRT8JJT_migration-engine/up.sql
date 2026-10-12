-- The migration engine's records (Wave 6; ledger.md §1 and §5,
-- migration-bundles.md §3, planning-and-apply.md §2). Owner: exdb_migrate.
-- serve ingests bundles (a control record of a person) and reads; the worker
-- reads bundles, writes the mirrors and the operation progress. The target's
-- own ledger stays the truth; these tables never decide an outcome alone.

-- ----- registry: execution roles and trusted extensions of a project -----
-- alias → PostgreSQL role the migrator may SET ROLE into for this project's
-- migrations; a project file may name aliases, only the registry maps them.
ALTER TABLE registry.projects
  ADD COLUMN execution_roles jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(execution_roles) = 'object'),
  ADD COLUMN trusted_extensions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(trusted_extensions) = 'array');
GRANT UPDATE (execution_roles, trusted_extensions) ON registry.projects TO exdb_worker;

CREATE SCHEMA migrations AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA migrations FROM PUBLIC;
GRANT USAGE ON SCHEMA migrations TO exdb_serve, exdb_worker;

-- ----- bundle store: one row per ingested revision, immutable -----
-- A revision is new exact bytes of a migration id: a verify, rollback or
-- comment change keeps the apply checksum; a new checksum is allowed only
-- for an id never applied anywhere (rewritten_unapplied). The bytes are the
-- ones the server validated and hashed itself.
CREATE TABLE migrations.bundle_revisions (
  project_id       text        NOT NULL REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  migration_id     text        NOT NULL CHECK (migration_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  revision         integer     NOT NULL CHECK (revision >= 1),
  name             text        NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(name) <= 64),
  checksum         text        NOT NULL CHECK (checksum ~ '^sha256:c1:[0-9a-f]{64}$'),
  verify_digest    text        CHECK (verify_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  rollback_digest  text        CHECK (rollback_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  source_digest    text        NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  bundle_digest    text        NOT NULL CHECK (bundle_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  transactional    boolean     NOT NULL,
  depends_on       text[]      NOT NULL,
  -- P of c1 (defaults materialized) and the project defaults it used
  manifest         jsonb       NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  defaults         jsonb       NOT NULL CHECK (jsonb_typeof(defaults) = 'object'),
  manifest_yaml    bytea       NOT NULL CHECK (octet_length(manifest_yaml) <= 65536),
  up_sql           bytea       NOT NULL CHECK (octet_length(up_sql) <= 4194304),
  verify_sql       bytea       CHECK (octet_length(verify_sql) <= 524288),
  down_sql         bytea       CHECK (octet_length(down_sql) <= 4194304),
  -- a source reference as the submitter claimed it (OD-6 (a)); never verified
  source           jsonb       CHECK (source IS NULL OR (jsonb_typeof(source) = 'object' AND source ->> 'provenance' = 'claimed')),
  ingested_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  ingested_by      text        NOT NULL CHECK (ingested_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  PRIMARY KEY (project_id, migration_id, revision),
  UNIQUE (project_id, migration_id, checksum, bundle_digest)
);
CREATE INDEX bundle_revisions_by_checksum ON migrations.bundle_revisions (project_id, checksum);
CREATE TRIGGER bundle_revisions_immutable BEFORE UPDATE OR DELETE ON migrations.bundle_revisions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER bundle_revisions_no_truncate BEFORE TRUNCATE ON migrations.bundle_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- ----- mirror of each target's ledger (ledger.md §5) -----
CREATE TABLE migrations.ledger_mirror (
  target_id           text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation          integer     NOT NULL CHECK (generation >= 1),
  migration_id        text        NOT NULL CHECK (char_length(migration_id) BETWEEN 1 AND 210),
  origin              text        NOT NULL CHECK (origin IN ('exponetdb', 'legacy_import', 'baseline')),
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  checksum            text        NOT NULL CHECK (char_length(checksum) BETWEEN 1 AND 200),
  verify_digest       text,
  rollback_digest     text,
  applied_seq         bigint      NOT NULL,
  applied_at          timestamptz NOT NULL,
  operation_id        text        NOT NULL,
  plan_id             text,
  fingerprint_before  text,
  fingerprint_after   text,
  reverted_at         timestamptz,
  reverted_by_op      text,
  mirrored_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target_id, generation, migration_id)
);

CREATE TABLE migrations.ledger_state (
  target_id          text        PRIMARY KEY REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation         integer     NOT NULL CHECK (generation >= 1),
  ledger_state_hash  text        NOT NULL CHECK (ledger_state_hash ~ '^sha256:ls1:[0-9a-f]{64}$'),
  baseline_id        text        CHECK (baseline_id ~ '^baseline:[a-z0-9]+(-[a-z0-9]+)*$'),
  observed_at        timestamptz NOT NULL,
  -- divergent: the target's ledger was found to differ from the mirror in a
  -- way no ExponetDB operation explains (ledger.md §5); schema plans stop
  divergent          boolean     NOT NULL DEFAULT false,
  divergence         jsonb       CHECK (divergence IS NULL OR jsonb_typeof(divergence) = 'object')
);

-- ----- mirror of verification runs (append-only, like the target's) -----
CREATE TABLE migrations.verification_mirror (
  verification_id  text        PRIMARY KEY CHECK (verification_id ~ '^vfy_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id        text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation       integer     NOT NULL CHECK (generation >= 1),
  migration_id     text        NOT NULL CHECK (char_length(migration_id) BETWEEN 1 AND 210),
  operation_id     text        NOT NULL,
  verify_digest    text,
  status           text        NOT NULL CHECK (status IN ('passed', 'failed', 'partial', 'error')),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  structural       jsonb       NOT NULL CHECK (jsonb_typeof(structural) = 'object'),
  runtime          jsonb       CHECK (runtime IS NULL OR jsonb_typeof(runtime) = 'object'),
  engine           jsonb       NOT NULL CHECK (jsonb_typeof(engine) = 'object'),
  fingerprint      text        NOT NULL,
  mirrored_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX verification_mirror_by_migration
  ON migrations.verification_mirror (target_id, migration_id, finished_at DESC);
CREATE TRIGGER verification_mirror_immutable BEFORE UPDATE OR DELETE ON migrations.verification_mirror
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();

-- ----- per-migration progress of a migration operation -----
-- Written by the worker that holds the operation's lease; the operation
-- view shows it next to the operation's own outcomes. Also the record of a
-- pre-commit gate (L0) failure: the target's ledger has no row for a
-- migration that was rolled back, so its verification result lives here.
CREATE TABLE migrations.operation_migrations (
  operation_id          text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  position              integer     NOT NULL CHECK (position >= 0),
  migration_id          text        NOT NULL CHECK (migration_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  name                  text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  apply_outcome         text        NOT NULL CHECK (apply_outcome IN ('not_started', 'applied', 'not_applied',
                                                                     'partially_applied', 'unknown')),
  verification_outcome  text        NOT NULL CHECK (verification_outcome IN ('not_applicable', 'pending', 'passed',
                                                                            'failed', 'partial', 'error')),
  statement_index       integer     CHECK (statement_index >= 0),
  sqlstate              text        CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
  error_code            text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- a gate or verification result without a ledger row (L0 failure): the
  -- structural summary only, never target data
  gate                  jsonb       CHECK (gate IS NULL OR jsonb_typeof(gate) = 'object'),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, position),
  UNIQUE (operation_id, migration_id)
);

-- ----- privileges -----
GRANT SELECT ON ALL TABLES IN SCHEMA migrations TO exdb_serve, exdb_worker;
GRANT INSERT ON migrations.bundle_revisions TO exdb_serve;
GRANT INSERT, UPDATE ON migrations.ledger_mirror, migrations.ledger_state, migrations.operation_migrations
  TO exdb_worker;
GRANT INSERT ON migrations.verification_mirror TO exdb_worker;
