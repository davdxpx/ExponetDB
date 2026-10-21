-- Execution roles per environment (ADR-0034 §5): an environment of the
-- project's product may bind an alias of the project to another role than
-- the project's default map (one cluster can host staging and production of
-- one project with their own role sets). Resolution per alias: the current
-- row here, else registry.projects.execution_roles.
--
-- Nothing is deleted (no runtime role deletes in the registry): a change
-- ends the current row of an alias and inserts its successor in the same
-- operation, so the table is also the history of an environment's bindings.
CREATE TABLE registry.execution_role_bindings (
  project_id            text        NOT NULL REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  environment_id        text        NOT NULL REFERENCES registry.environments (environment_id) ON DELETE RESTRICT,
  alias                 text        NOT NULL CHECK (alias ~ '^[a-z][a-z0-9_]{0,62}$'),
  role                  text        NOT NULL CHECK (octet_length(role) BETWEEN 1 AND 63
                                                    AND role !~ '[[:cntrl:]]'
                                                    AND role !~ '^pg_' AND role !~ '^exponetdb_'),
  set_at                timestamptz NOT NULL,
  set_by_operation_id   text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ended_at              timestamptz,
  ended_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_role_bindings_ended CHECK ((ended_at IS NULL) = (ended_by_operation_id IS NULL)),
  -- An operation sets an alias of an environment at most once.
  PRIMARY KEY (project_id, environment_id, alias, set_by_operation_id)
);
CREATE UNIQUE INDEX execution_role_bindings_one_current
  ON registry.execution_role_bindings (project_id, environment_id, alias) WHERE ended_at IS NULL;
CREATE INDEX execution_role_bindings_by_environment
  ON registry.execution_role_bindings (environment_id) WHERE ended_at IS NULL;

-- Only an operation of the kind registry.execution_role_binding.set inserts
-- a binding (for an environment of the project's product) or ends a current
-- one; an ended binding never changes again, and no other column ever
-- changes. Times are the database clock.
CREATE FUNCTION registry.execution_role_binding_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'an execution role binding is ended, never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'a binding is inserted current';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.projects p JOIN registry.environments e ON e.product_id = p.product_id
                    WHERE p.project_id = NEW.project_id AND e.environment_id = NEW.environment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'a binding names an environment of the project''s product';
    END IF;
    IF NOT EXISTS (SELECT FROM operations.operations o
                    WHERE o.operation_id = NEW.set_by_operation_id
                      AND o.kind = 'registry.execution_role_binding.set') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'a binding is set by its own registry.execution_role_binding.set operation';
    END IF;
    NEW.set_at := clock_timestamp();
    RETURN NEW;
  END IF;
  -- UPDATE: only ending a current binding.
  IF OLD.ended_at IS NOT NULL OR NEW.ended_by_operation_id IS NULL
     OR (NEW.project_id, NEW.environment_id, NEW.alias, NEW.role, NEW.set_at, NEW.set_by_operation_id)
        IS DISTINCT FROM
        (OLD.project_id, OLD.environment_id, OLD.alias, OLD.role, OLD.set_at, OLD.set_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'a binding only ends, once';
  END IF;
  IF NOT EXISTS (SELECT FROM operations.operations o
                  WHERE o.operation_id = NEW.ended_by_operation_id
                    AND o.kind = 'registry.execution_role_binding.set') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG13', MESSAGE = 'a binding is ended by a registry.execution_role_binding.set operation';
  END IF;
  NEW.ended_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.execution_role_binding_guard() FROM PUBLIC;
CREATE TRIGGER execution_role_bindings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON registry.execution_role_bindings
  FOR EACH ROW EXECUTE FUNCTION registry.execution_role_binding_guard();
CREATE TRIGGER execution_role_bindings_no_truncate BEFORE TRUNCATE ON registry.execution_role_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON registry.execution_role_bindings TO exdb_serve, exdb_worker;
GRANT INSERT ON registry.execution_role_bindings TO exdb_worker;
GRANT UPDATE (ended_at, ended_by_operation_id) ON registry.execution_role_bindings TO exdb_worker;
