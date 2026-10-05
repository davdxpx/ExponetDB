-- Control Store foundation (control-database.md §3 to §6).
-- Owner of every object: exdb_migrate (the login running this bundle).
-- Nothing is granted to PUBLIC; every grant names a role.

CREATE SCHEMA control AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA control FROM PUBLIC;
GRANT USAGE ON SCHEMA control TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;

-- Functions are not executable by PUBLIC unless granted explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE exdb_migrate REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Append-only guard shared by immutable tables. It fires for every role,
-- the table owner included; only a superuser (outside the Control Plane)
-- can disable it.
CREATE FUNCTION control.reject_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'EXA01',
    MESSAGE = format('%I.%I is append-only (%s refused)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP);
END
$fn$;
REVOKE ALL ON FUNCTION control.reject_change() FROM PUBLIC;

-- Installation marker: exactly one row, written by the first migration run.
CREATE TABLE control.installation (
  singleton         boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id   text        NOT NULL UNIQUE
                    CHECK (installation_id ~ '^ins_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_engine text        NOT NULL CHECK (char_length(created_by_engine) BETWEEN 1 AND 64)
);
CREATE TRIGGER installation_append_only BEFORE UPDATE OR DELETE ON control.installation
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER installation_no_truncate BEFORE TRUNCATE ON control.installation
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Installation-wide settings (one setting, one place: P-12). Written by the
-- migration role or later by planned access operations, read by every role.
CREATE TABLE control.settings (
  key        text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{0,127}$'),
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The Control Store's own ledger (ledger.md §2 without target identity).
CREATE TABLE control.schema_migrations (
  migration_id      text        PRIMARY KEY CHECK (migration_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  name              text        NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  checksum          text        NOT NULL CHECK (checksum ~ '^sha256:c1:[0-9a-f]{64}$'),
  verify_digest     text        NOT NULL CHECK (verify_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  rollback_digest   text        NOT NULL CHECK (rollback_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  bundle_digest     text        NOT NULL CHECK (bundle_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  dependencies      text[]      NOT NULL,
  applied_seq       bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  applied_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  apply_duration_ms integer     NOT NULL CHECK (apply_duration_ms >= 0),
  engine_version    text        NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  pg_version_num    integer     NOT NULL
);
CREATE TRIGGER schema_migrations_append_only BEFORE UPDATE OR DELETE ON control.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_migrations_no_truncate BEFORE TRUNCATE ON control.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Verification history: one row per run, never changed. The latest row of a
-- migration is its verification status.
CREATE TABLE control.migration_verifications (
  verification_seq bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  migration_id     text        NOT NULL REFERENCES control.schema_migrations (migration_id) ON DELETE RESTRICT,
  verify_digest    text        NOT NULL CHECK (verify_digest ~ '^sha256:c1:[0-9a-f]{64}$'),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  status           text        NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  summary          jsonb       NOT NULL,
  engine_version   text        NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  CHECK (finished_at >= started_at)
);
CREATE INDEX migration_verifications_latest ON control.migration_verifications (migration_id, verification_seq DESC);
CREATE TRIGGER migration_verifications_append_only BEFORE UPDATE OR DELETE ON control.migration_verifications
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER migration_verifications_no_truncate BEFORE TRUNCATE ON control.migration_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Ledger with the latest verification of each migration.
CREATE VIEW control.migration_status AS
  SELECT m.migration_id, m.name, m.checksum, m.verify_digest, m.applied_seq, m.applied_at,
         v.verify_digest AS verified_digest, v.status AS verification_status,
         v.finished_at AS verified_at, v.summary AS verification_summary
    FROM control.schema_migrations m
    LEFT JOIN LATERAL (
      SELECT x.verify_digest, x.status, x.finished_at, x.summary
        FROM control.migration_verifications x
       WHERE x.migration_id = m.migration_id
       ORDER BY x.verification_seq DESC LIMIT 1) v ON true;

GRANT SELECT ON control.installation, control.settings, control.schema_migrations,
  control.migration_verifications, control.migration_status
  TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
