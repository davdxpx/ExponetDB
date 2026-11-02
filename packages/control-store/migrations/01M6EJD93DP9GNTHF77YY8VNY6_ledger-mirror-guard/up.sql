-- VC-045: the mirror is insert-and-revert-only for the worker. The engine's upsert
-- (INSERT ... ON CONFLICT DO UPDATE SET reverted_at, reverted_by_op, mirrored_at) is the only
-- update, and it changes nothing else.
CREATE FUNCTION migrations.ledger_mirror_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'reverted_at' - 'reverted_by_op' - 'mirrored_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'reverted_at' - 'reverted_by_op' - 'mirrored_at') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM03',
      MESSAGE = 'a ledger mirror row is never rewritten; only its revert is recorded';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.ledger_mirror_guard() FROM PUBLIC;
CREATE TRIGGER ledger_mirror_update_guard BEFORE UPDATE ON migrations.ledger_mirror
  FOR EACH ROW EXECUTE FUNCTION migrations.ledger_mirror_guard();

-- VC-102: the rows the named, still running, leased ledger.reconcile operation of this target is
-- entitled to move. The plan lists at most 256 ids per class and the counts of all: a plan that lists
-- them all binds every id, a larger one the number, summed over all calls of the operation (the
-- operation recomputes the divergence under the digest the plan carries).
CREATE OR REPLACE FUNCTION migrations.archive_mirror_rows(
  p_operation text, p_target text, p_generation integer, p_ids text[], p_reason text
) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  moved integer;
  body  jsonb;
  shown jsonb;
  total integer;
BEGIN
  IF p_reason IS DISTINCT FROM 'missing' AND p_reason IS DISTINCT FROM 'differs' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01', MESSAGE = 'unknown reason for archiving a mirror row';
  END IF;
  SELECT b.body::jsonb INTO body
    FROM operations.operations o
    JOIN operations.plans p ON p.plan_id = o.plan_id
    JOIN operations.plan_bodies b ON b.plan_id = p.plan_id
   WHERE o.operation_id = p_operation AND o.kind = 'ledger.reconcile' AND o.state = 'running'
     AND o.lease_expires_at > clock_timestamp() AND p.target_id = p_target
     FOR SHARE OF o;
  IF body IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01',
      MESSAGE = 'only a running ledger.reconcile operation of the target, under its lease, archives its mirror rows';
  END IF;
  IF (body -> 'content' ->> 'generation')::integer IS DISTINCT FROM p_generation THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01', MESSAGE = 'the generation is not the one the plan names';
  END IF;
  shown := body -> 'content' -> 'divergence' -> (CASE p_reason WHEN 'missing' THEN 'missing' ELSE 'checksumDiffers' END);
  total := (body -> 'content' -> 'counts' ->> (CASE p_reason WHEN 'missing' THEN 'missing' ELSE 'checksumDiffers' END))::integer;
  IF shown IS NULL OR total IS NULL OR cardinality(p_ids) > total
     OR (SELECT count(*) FROM migrations.ledger_mirror_history h
          WHERE h.operation_id = p_operation AND h.reason = p_reason) + cardinality(p_ids) > total
     OR (jsonb_array_length(shown) = total
         AND EXISTS (SELECT FROM unnest(p_ids) AS i WHERE NOT shown ? i)) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM01', MESSAGE = 'the ids are not the ones the plan names';
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

-- appliedElsewhere and the recorded-rows check look an operation's progress up by migration id.
CREATE INDEX IF NOT EXISTS operation_migrations_by_migration
  ON migrations.operation_migrations (migration_id);
