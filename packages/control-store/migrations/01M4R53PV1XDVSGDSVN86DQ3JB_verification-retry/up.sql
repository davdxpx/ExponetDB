-- Requests to verify again an operation in needs_attention (operations-engine.md
-- §4.1: "operator retries verification"). serve may not move an operation that
-- started (EXO02), so it records the request; the worker claims the operation,
-- starts the request and makes the transition under its lease. A request is
-- never deleted; at most one is open per operation. A schema of its own: the
-- operations schema's own checks (frozen) count its triggers.
CREATE SCHEMA recovery AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA recovery FROM PUBLIC;
GRANT USAGE ON SCHEMA recovery TO exdb_serve, exdb_worker;

CREATE TABLE recovery.verification_retries (
  retry_id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id             text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  requested_by_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  requested_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at               timestamptz,
  CHECK (started_at IS NULL OR started_at >= requested_at)
);
CREATE UNIQUE INDEX verification_retries_open ON recovery.verification_retries (operation_id)
  WHERE started_at IS NULL;

-- Only the start is ever recorded, once; nothing else changes and nothing is removed.
CREATE FUNCTION recovery.verification_retries_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.started_at IS NOT NULL OR NEW.started_at IS NULL
     OR NEW.retry_id <> OLD.retry_id OR NEW.operation_id <> OLD.operation_id
     OR NEW.requested_by_identity_id <> OLD.requested_by_identity_id
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO12', MESSAGE = 'a verification retry only records its start, once';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER verification_retries_guard BEFORE UPDATE ON recovery.verification_retries
  FOR EACH ROW EXECUTE FUNCTION recovery.verification_retries_guard();
CREATE TRIGGER verification_retries_no_delete BEFORE DELETE ON recovery.verification_retries
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER verification_retries_no_truncate BEFORE TRUNCATE ON recovery.verification_retries
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT, INSERT ON recovery.verification_retries TO exdb_serve;
GRANT SELECT, UPDATE (started_at) ON recovery.verification_retries TO exdb_worker;
REVOKE ALL ON FUNCTION recovery.verification_retries_guard() FROM PUBLIC;
