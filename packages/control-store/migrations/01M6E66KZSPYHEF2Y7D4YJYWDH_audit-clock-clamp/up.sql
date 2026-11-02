-- OD-69 (b), bounded to 24 h (verification campaign VC-003): an event written
-- while the database clock is behind the chain head takes the head's time; a
-- mark says so (which seq, the database time, the head's time). Append-only,
-- like the chain.
CREATE TABLE audit.clock_skew_marks (
  seq         bigint      PRIMARY KEY CHECK (seq >= 1),
  database_at timestamptz NOT NULL,
  -- not head_at: the guard's own variable has that name
  chain_head_at timestamptz NOT NULL,
  CHECK (chain_head_at > database_at)
);
CREATE TRIGGER clock_skew_marks_append_only BEFORE UPDATE OR DELETE ON audit.clock_skew_marks
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER clock_skew_marks_no_truncate BEFORE TRUNCATE ON audit.clock_skew_marks
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
GRANT SELECT, INSERT ON audit.clock_skew_marks TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;

-- The chain guard of the audit-chain bundle, with one more accepted case for
-- the event time. The rest of its text is unchanged.
CREATE OR REPLACE FUNCTION audit.chain_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  head_seq      bigint;
  head_hash     text;
  head_at       timestamptz;
  installation  text;
  expected_prev text;
  e             jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(1163412546, -295030770);
  SELECT a.seq, a.hash, a.occurred_at INTO head_seq, head_hash, head_at
    FROM audit.audit_events a ORDER BY a.seq DESC LIMIT 1;
  IF head_seq IS NULL THEN
    SELECT i.installation_id INTO installation FROM control.installation i;
    IF installation IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXA02', MESSAGE = 'audit chain: the installation marker is missing';
    END IF;
    head_seq := 0;
    expected_prev := 'ac1:genesis:' || installation;
  ELSE
    expected_prev := head_hash;
  END IF;
  IF NEW.seq <> head_seq + 1 OR NEW.prev_hash <> expected_prev THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA02', MESSAGE = 'audit chain: the event does not continue the chain';
  END IF;
  -- Time never runs backwards along the chain and never ahead of the
  -- database clock, so monthly partitions hold contiguous ranges of seq.
  -- OD-69 (b): while the head is at most 24 hours ahead (a clock step back),
  -- an event may take the head's own time if its seq has a clock-skew mark
  -- written in the same transaction (database time within a minute of the
  -- clock). ac1 and exponetdb.audit/v1 stay as they are: the mark is a row.
  e := NEW.event::jsonb;
  IF NEW.occurred_at < head_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA02', MESSAGE = 'audit chain: the event time does not continue the chain';
  END IF;
  -- coalesce: a missing marker is a refusal, never an unknown that IF lets pass.
  IF NEW.occurred_at > clock_timestamp() + interval '1 minute'
     AND NOT coalesce(NEW.occurred_at = head_at
                      AND head_at <= clock_timestamp() + interval '24 hours'
                      AND EXISTS (SELECT FROM audit.clock_skew_marks m
                                   WHERE m.seq = NEW.seq AND m.chain_head_at = head_at
                                     AND m.database_at BETWEEN clock_timestamp() - interval '1 minute'
                                                           AND clock_timestamp() + interval '1 minute'),
                      false) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA02', MESSAGE = 'audit chain: the event time does not continue the chain';
  END IF;
  IF NEW.hash <> audit.ac1(NEW.prev_hash, NEW.event) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA03', MESSAGE = 'audit chain: the hash does not match ac1 of the event';
  END IF;
  IF (e ->> 'seq')::bigint IS DISTINCT FROM NEW.seq
     OR e ->> 'id' IS DISTINCT FROM NEW.event_id
     OR e ->> 'action' IS DISTINCT FROM NEW.action
     OR e ->> 'phase' IS DISTINCT FROM NEW.phase
     OR (e ->> 'occurredAt')::timestamptz IS DISTINCT FROM NEW.occurred_at
     OR e -> 'actor' ->> 'kind' IS DISTINCT FROM NEW.actor_kind
     OR e -> 'actor' ->> 'identityId' IS DISTINCT FROM NEW.actor_id
     OR e -> 'refs' ->> 'operationId' IS DISTINCT FROM NEW.operation_id
     OR e -> 'refs' ->> 'planId' IS DISTINCT FROM NEW.plan_id THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA04', MESSAGE = 'audit chain: the columns do not match the event';
  END IF;
  RETURN NEW;
END
$fn$;
