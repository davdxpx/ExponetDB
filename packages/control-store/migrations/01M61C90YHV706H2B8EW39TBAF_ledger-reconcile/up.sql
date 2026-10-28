-- TC-007 (MIG-03): the history of the mirror rows ledger.reconcile moved. Owner: exdb_migrate.
-- Append-only like the mirror's other records; the worker reads it and never writes it directly.
CREATE TABLE migrations.ledger_mirror_history (
  history_id   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id    text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation   integer     NOT NULL CHECK (generation >= 1),
  migration_id text        NOT NULL CHECK (char_length(migration_id) BETWEEN 1 AND 210),
  -- missing: the target no longer has the row (a restore); differs: it has another row of that id
  reason       text        NOT NULL CHECK (reason IN ('missing', 'differs')),
  mirror_row   jsonb       NOT NULL CHECK (jsonb_typeof(mirror_row) = 'object'),
  operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  archived_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ledger_mirror_history_by_target
  ON migrations.ledger_mirror_history (target_id, generation, migration_id);
CREATE TRIGGER ledger_mirror_history_guard BEFORE UPDATE OR DELETE ON migrations.ledger_mirror_history
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER ledger_mirror_history_no_truncate BEFORE TRUNCATE ON migrations.ledger_mirror_history
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
GRANT SELECT ON migrations.ledger_mirror_history TO exdb_serve, exdb_worker;

-- Moves the named mirror rows of one target generation to the history, in one statement. The worker
-- has no DELETE on the mirror: this function is the only way a row leaves it, and only for a
-- running ledger.reconcile operation whose plan is for this target.
CREATE FUNCTION migrations.archive_mirror_rows(
  p_operation text, p_target text, p_generation integer, p_ids text[], p_reason text
) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  moved integer;
BEGIN
  IF p_reason NOT IN ('missing', 'differs') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01', MESSAGE = 'unknown reason for archiving a mirror row';
  END IF;
  IF NOT EXISTS (
    SELECT FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
     WHERE o.operation_id = p_operation AND o.kind = 'ledger.reconcile' AND o.state = 'running'
       AND p.target_id = p_target
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01',
      MESSAGE = 'only a running ledger.reconcile operation of the target archives its mirror rows';
  END IF;
  WITH gone AS (
    DELETE FROM migrations.ledger_mirror m
     WHERE m.target_id = p_target AND m.generation = p_generation AND m.migration_id = ANY (p_ids)
    RETURNING m.*
  ), kept AS (
    INSERT INTO migrations.ledger_mirror_history (target_id, generation, migration_id, reason, mirror_row, operation_id)
    SELECT g.target_id, g.generation, g.migration_id, p_reason, to_jsonb(g), p_operation FROM gone g
    RETURNING 1
  )
  SELECT count(*) INTO moved FROM kept;
  RETURN moved;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.archive_mirror_rows(text, text, integer, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migrations.archive_mirror_rows(text, text, integer, text[], text) TO exdb_worker;
