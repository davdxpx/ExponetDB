-- Declared execution-role exceptions (ADR-0034 §1). An execution role may
-- carry BYPASSRLS only where a person declared it for the project and the
-- environment; SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN and any
-- reach into pg_* or exponetdb_* roles are never excusable, and this table
-- cannot even say otherwise: `attributes` is exactly {bypassrls}.
CREATE TABLE registry.execution_role_exceptions (
  exception_id            text        PRIMARY KEY CHECK (exception_id ~ '^rxe_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  project_id              text        NOT NULL REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  environment_id          text        NOT NULL REFERENCES registry.environments (environment_id) ON DELETE RESTRICT,
  role_name               text        NOT NULL CHECK (octet_length(role_name) BETWEEN 1 AND 63
                                                      AND role_name !~ '[[:cntrl:]]'
                                                      AND role_name !~ '^pg_' AND role_name !~ '^exponetdb_'),
  attributes              text[]      NOT NULL CHECK (attributes = ARRAY['bypassrls']::text[]),
  reason                  text        NOT NULL CHECK (char_length(reason) BETWEEN 20 AND 1000
                                                      AND reason !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  review_by               date,
  state                   text        NOT NULL CHECK (state IN ('active', 'revoked')),
  revision                integer     NOT NULL CHECK (revision >= 1),
  declared_by             text        NOT NULL CHECK (declared_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  declared_at             timestamptz NOT NULL,
  declared_by_operation_id text       NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  revoked_by              text        CHECK (revoked_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  revoked_at              timestamptz,
  revoked_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  revoke_reason           text        CHECK (revoke_reason IS NULL OR (char_length(revoke_reason) BETWEEN 1 AND 1000
                                                      AND revoke_reason !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)
     AND (state = 'revoked') = (revoked_by IS NOT NULL)
     AND (state = 'revoked') = (revoked_by_operation_id IS NOT NULL)
     AND (state = 'revoked') = (revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX execution_role_exceptions_one_active
  ON registry.execution_role_exceptions (project_id, environment_id, role_name) WHERE state = 'active';
CREATE INDEX execution_role_exceptions_by_environment
  ON registry.execution_role_exceptions (environment_id);

-- A declaration starts active at revision 1, by its own declare operation,
-- for an environment of the project's product; afterwards the only change
-- is one revocation by a revoke operation, which raises the revision. No
-- record is ever deleted. Times come from the database clock.
CREATE FUNCTION registry.execution_role_exception_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an execution role exception is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.revision <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an exception starts active at revision 1';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.projects p JOIN registry.environments e ON e.product_id = p.product_id
                    WHERE p.project_id = NEW.project_id AND e.environment_id = NEW.environment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an exception names an environment of the project''s product';
    END IF;
    IF NOT EXISTS (SELECT FROM operations.operations o
                    WHERE o.operation_id = NEW.declared_by_operation_id
                      AND o.kind = 'registry.execution_role_exception.declare') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an exception is declared by its own declare operation';
    END IF;
    NEW.declared_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.exception_id, NEW.project_id, NEW.environment_id, NEW.role_name, NEW.attributes, NEW.reason,
      NEW.review_by, NEW.declared_by, NEW.declared_at, NEW.declared_by_operation_id)
     IS DISTINCT FROM
     (OLD.exception_id, OLD.project_id, OLD.environment_id, OLD.role_name, OLD.attributes, OLD.reason,
      OLD.review_by, OLD.declared_by, OLD.declared_at, OLD.declared_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'a declared exception keeps its scope, role, reason and declaration';
  END IF;
  IF OLD.state <> 'active' OR NEW.state <> 'revoked' OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an exception is revoked once, raising its revision';
  END IF;
  IF NOT EXISTS (SELECT FROM operations.operations o
                  WHERE o.operation_id = NEW.revoked_by_operation_id
                    AND o.kind = 'registry.execution_role_exception.revoke') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG14', MESSAGE = 'an exception is revoked by its own revoke operation';
  END IF;
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.execution_role_exception_guard() FROM PUBLIC;
CREATE TRIGGER execution_role_exceptions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON registry.execution_role_exceptions
  FOR EACH ROW EXECUTE FUNCTION registry.execution_role_exception_guard();
CREATE TRIGGER execution_role_exceptions_no_truncate BEFORE TRUNCATE ON registry.execution_role_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON registry.execution_role_exceptions TO exdb_serve, exdb_worker;
GRANT INSERT ON registry.execution_role_exceptions TO exdb_worker;
GRANT UPDATE (state, revision, revoked_by, revoked_at, revoked_by_operation_id, revoke_reason)
  ON registry.execution_role_exceptions TO exdb_worker;

-- An environment keeps its tier while it binds execution roles or holds an
-- active exception: both were set under that tier's authority (a nonprod
-- declaration has no approval), so a tier change first ends them. Checked
-- here, on the frozen environments table, by an additive trigger.
CREATE FUNCTION registry.environment_execution_roles_keep_tier() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.tier IS DISTINCT FROM OLD.tier
     AND (EXISTS (SELECT FROM registry.execution_role_exceptions x
                   WHERE x.environment_id = OLD.environment_id AND x.state = 'active')
          OR EXISTS (SELECT FROM registry.execution_role_bindings b
                      WHERE b.environment_id = OLD.environment_id AND b.ended_at IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG14',
      MESSAGE = 'an environment with execution role bindings or an active exception keeps its tier';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.environment_execution_roles_keep_tier() FROM PUBLIC;
CREATE TRIGGER environments_execution_roles_keep_tier
  BEFORE UPDATE OF tier ON registry.environments
  FOR EACH ROW EXECUTE FUNCTION registry.environment_execution_roles_keep_tier();
