-- D0 proposal (exploratory, run on the d0-pg copy only): a new additive bundle makes the mirror "insert-and-revert-only"
-- in the database, not only in the worker's code. Owner: exdb_migrate.
\set ON_ERROR_STOP off
\set VERBOSITY terse
\o /dev/stderr
\connect - exdb_migrate
BEGIN;
SET LOCAL search_path = pg_catalog;
CREATE FUNCTION migrations.ledger_mirror_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  -- the mirror's row keeps everything it recorded; only the revert columns (and the time of the last write) move
  IF (NEW.target_id, NEW.generation, NEW.migration_id, NEW.origin, NEW.name, NEW.checksum, NEW.verify_digest,
      NEW.rollback_digest, NEW.applied_seq, NEW.applied_at, NEW.operation_id, NEW.plan_id,
      NEW.fingerprint_before, NEW.fingerprint_after)
     IS DISTINCT FROM
     (OLD.target_id, OLD.generation, OLD.migration_id, OLD.origin, OLD.name, OLD.checksum, OLD.verify_digest,
      OLD.rollback_digest, OLD.applied_seq, OLD.applied_at, OLD.operation_id, OLD.plan_id,
      OLD.fingerprint_before, OLD.fingerprint_after) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM02', MESSAGE = 'a mirrored ledger row changes only its revert columns';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.ledger_mirror_guard() FROM PUBLIC;
CREATE TRIGGER ledger_mirror_guard BEFORE UPDATE ON migrations.ledger_mirror FOR EACH ROW EXECUTE FUNCTION migrations.ledger_mirror_guard();
COMMIT;
\warn '=== worker: rewrite of checksum / generation (expect EXM02 x2); revert columns and the upsert of insertMirrorRow (expect UPDATE 1); the archive function still deletes'
\connect - exdb_worker
UPDATE migrations.ledger_mirror SET checksum='sha256:c1:FORGED' WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND migration_id='X1';
UPDATE migrations.ledger_mirror SET generation=99 WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND migration_id='X2';
UPDATE migrations.ledger_mirror SET reverted_at=now(), reverted_by_op='op_01M61C90YHV706H2B8EW39TBQ1', mirrored_at=clock_timestamp() WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND migration_id='X1';
INSERT INTO migrations.ledger_mirror (target_id, generation, migration_id, origin, name, checksum, applied_seq, applied_at, operation_id)
VALUES ('tgt_01M61C90YHV706H2B8EW39TBA2', 1, 'X2', 'exponetdb', 'n-X2', 'sha256:c1:X2', 2, now(), 'op_01M61C90YHV706H2B8EW39TBA0')
ON CONFLICT (target_id, generation, migration_id) DO UPDATE SET reverted_at = EXCLUDED.reverted_at, reverted_by_op = EXCLUDED.reverted_by_op, mirrored_at = clock_timestamp();
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ2','tgt_01M61C90YHV706H2B8EW39TBA2',1,ARRAY['X1'],'differs') AS archived;
