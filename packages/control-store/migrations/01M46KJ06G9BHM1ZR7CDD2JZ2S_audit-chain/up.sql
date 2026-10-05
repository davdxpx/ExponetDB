-- Audit (audit.md §3, §4, §6; ADR-0023). Owner: exdb_migrate.
CREATE SCHEMA audit AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA audit TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;

-- ac1 in SQL: a second implementation, independent of the TypeScript one.
-- The chain guard below recomputes every hash with it, so an insert whose
-- hash the two implementations disagree on fails (mutations fail closed).
-- The database encoding is UTF-8 (bootstrap), so text bytes are UTF-8 bytes.
CREATE FUNCTION audit.ac1(p_prev text, p_event text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT 'sha256:ac1:' || encode(sha256(convert_to(
           'exponetdb/audit-chain/ac1' || E'\n'
           || 'prevHash' || E'\n' || octet_length(convert_to(p_prev, 'UTF8'))::text || E'\n' || p_prev || E'\n'
           || 'event' || E'\n' || octet_length(convert_to(p_event, 'UTF8'))::text || E'\n' || p_event || E'\n',
         'UTF8')), 'hex')
$fn$;
REVOKE ALL ON FUNCTION audit.ac1(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.ac1(text, text) TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;

-- Events: one row per event; `event` is the canonical (JCS) text that was
-- hashed; the other columns are copies for querying, checked against it.
CREATE TABLE audit.audit_events (
  seq          bigint      NOT NULL CHECK (seq >= 1),
  occurred_at  timestamptz NOT NULL,
  event_id     text        NOT NULL CHECK (event_id ~ '^aud_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  action       text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length(action) <= 64),
  phase        text        NOT NULL CHECK (phase IN ('requested', 'denied', 'accepted', 'completed', 'failed', 'reconciled')),
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id     text        CHECK (actor_id ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  operation_id text        CHECK (operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  plan_id      text        CHECK (plan_id ~ '^pln_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  event        text        NOT NULL CHECK (octet_length(event) <= 65536),
  prev_hash    text        NOT NULL CHECK (prev_hash ~ '^(ac1:genesis:ins_[0-7][0-9A-HJKMNP-TV-Z]{25}|sha256:ac1:[0-9a-f]{64})$'),
  hash         text        NOT NULL CHECK (hash ~ '^sha256:ac1:[0-9a-f]{64}$'),
  PRIMARY KEY (seq, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX audit_events_seq ON audit.audit_events (seq);
CREATE INDEX audit_events_operation ON audit.audit_events (operation_id, seq) WHERE operation_id IS NOT NULL;
CREATE INDEX audit_events_action ON audit.audit_events (action, occurred_at);

-- Chain guard: under the chain lock (the writer takes the same lock first),
-- the new row must continue the chain (next seq, previous hash or the
-- genesis value of this installation, a time not before the head's), its
-- hash must equal ac1 computed here, and its query columns must match the
-- event. A fork, a gap or a forged link cannot be inserted, whatever the
-- writer does.
CREATE FUNCTION audit.chain_guard() RETURNS trigger
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
  IF NEW.occurred_at < head_at OR NEW.occurred_at > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA02', MESSAGE = 'audit chain: the event time does not continue the chain';
  END IF;
  IF NEW.hash <> audit.ac1(NEW.prev_hash, NEW.event) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA03', MESSAGE = 'audit chain: the hash does not match ac1 of the event';
  END IF;
  e := NEW.event::jsonb;
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
REVOKE ALL ON FUNCTION audit.chain_guard() FROM PUBLIC;

CREATE TRIGGER audit_events_chain_guard BEFORE INSERT ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.chain_guard();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Checkpoints: (seq, hash) of an existing event; append-only.
CREATE TABLE audit.audit_chain_checkpoints (
  seq        bigint      PRIMARY KEY CHECK (seq >= 1),
  hash       text        NOT NULL CHECK (hash ~ '^sha256:ac1:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason     text        NOT NULL CHECK (reason IN ('scheduled', 'retention', 'manual'))
);
CREATE FUNCTION audit.checkpoint_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM audit.audit_events a WHERE a.seq = NEW.seq AND a.hash = NEW.hash) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA06', MESSAGE = 'audit checkpoint does not match the chain';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION audit.checkpoint_guard() FROM PUBLIC;
CREATE TRIGGER checkpoints_match_chain BEFORE INSERT ON audit.audit_chain_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit.checkpoint_guard();
CREATE TRIGGER checkpoints_append_only BEFORE UPDATE OR DELETE ON audit.audit_chain_checkpoints
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER checkpoints_no_truncate BEFORE TRUNCATE ON audit.audit_chain_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Off-host exports of checkpoints: one row per checkpoint and sink, append-only.
CREATE TABLE audit.checkpoint_exports (
  checkpoint_seq bigint      NOT NULL REFERENCES audit.audit_chain_checkpoints (seq) ON DELETE RESTRICT,
  sink           text        NOT NULL CHECK (sink ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  location       text        NOT NULL CHECK (char_length(location) BETWEEN 1 AND 1024),
  exported_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (checkpoint_seq, sink)
);
CREATE TRIGGER exports_append_only BEFORE UPDATE OR DELETE ON audit.checkpoint_exports
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER exports_no_truncate BEFORE TRUNCATE ON audit.checkpoint_exports
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Partition upkeep: monthly partitions from the current month on. Runs as
-- the owner; callable by the worker and the audit maintenance role; the
-- names and bounds come from the database clock, never from the caller.
CREATE FUNCTION audit.ensure_partitions(p_months_ahead integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $fn$
DECLARE
  month   date;
  created integer := 0;
  name    text;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 1 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'months ahead must be between 1 and 24';
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, 1537273328);
  month := date_trunc('month', clock_timestamp())::date;
  FOR i IN 0 .. p_months_ahead LOOP
    name := format('audit_events_y%sm%s', to_char(month, 'YYYY'), to_char(month, 'MM'));
    IF to_regclass(format('audit.%I', name)) IS NULL THEN
      EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.audit_events FOR VALUES FROM (%L) TO (%L)',
                     name, month::timestamptz, (month + interval '1 month')::timestamptz);
      EXECUTE format('REVOKE ALL ON audit.%I FROM PUBLIC', name);
      EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit.%I FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change()', name);
      created := created + 1;
    END IF;
    month := (month + interval '1 month')::date;
  END LOOP;
  RETURN created;
END
$fn$;
REVOKE ALL ON FUNCTION audit.ensure_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.ensure_partitions(integer) TO exdb_worker, exdb_audit_maint;

-- Retention (data-retention.md §2): drops one expired monthly partition,
-- only with a retention of at least 400 days, never the partition holding
-- the chain head, oldest first, and only when an exported checkpoint covers
-- its last event. Returns the boundary the caller records in the
-- retention.pruned event (same transaction). Only exdb_audit_maint may call it.
CREATE FUNCTION audit.drop_expired_partition(p_partition text, p_retention_days integer)
  RETURNS TABLE (dropped_through_seq bigint, boundary_hash text, dropped_rows bigint,
                 lower_bound timestamptz, upper_bound timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $fn$
DECLARE
  lo        timestamptz;
  hi        timestamptz;
  min_seq   bigint;
  max_seq   bigint;
  row_count bigint;
  head      bigint;
  oldest    bigint;
  last_hash text;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 400 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'audit retention is never shorter than 400 days';
  END IF;
  IF p_partition IS NULL OR p_partition !~ '^audit_events_y[0-9]{4}m(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'not an audit partition name';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'audit.audit_events'::regclass
       AND c.relnamespace = 'audit'::regnamespace AND c.relname = p_partition) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'not a partition of audit.audit_events';
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, -295030770);
  lo := make_timestamptz(substr(p_partition, 15, 4)::integer, substr(p_partition, 20, 2)::integer, 1, 0, 0, 0, 'UTC');
  hi := lo + interval '1 month';
  IF hi > clock_timestamp() - make_interval(days => p_retention_days) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'the partition is inside the retention period';
  END IF;
  EXECUTE format('SELECT min(seq), max(seq), count(*) FROM audit.%I', p_partition) INTO min_seq, max_seq, row_count;
  IF row_count > 0 THEN
    SELECT max(a.seq), min(a.seq) INTO head, oldest FROM audit.audit_events a;
    IF max_seq = head THEN
      RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'the partition holds the chain head';
    END IF;
    IF min_seq <> oldest
       OR (SELECT count(*) FROM audit.audit_events a WHERE a.seq <= max_seq) <> row_count THEN
      RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'older audit events must be pruned first';
    END IF;
    IF NOT EXISTS (
      SELECT FROM audit.audit_chain_checkpoints c JOIN audit.checkpoint_exports x ON x.checkpoint_seq = c.seq
       WHERE c.seq >= max_seq) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXA05', MESSAGE = 'no exported checkpoint covers the partition';
    END IF;
    SELECT a.hash INTO last_hash FROM audit.audit_events a WHERE a.seq = max_seq;
  END IF;
  EXECUTE format('DROP TABLE audit.%I', p_partition);
  RETURN QUERY SELECT max_seq, last_hash, row_count, lo, hi;
END
$fn$;
REVOKE ALL ON FUNCTION audit.drop_expired_partition(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.drop_expired_partition(text, integer) TO exdb_audit_maint;

-- Partition inventory for safe discovery (names, bounds, row ranges).
CREATE VIEW audit.partition_inventory AS
  SELECT c.relname::text AS partition,
         make_timestamptz(substr(c.relname, 15, 4)::integer, substr(c.relname, 20, 2)::integer, 1, 0, 0, 0, 'UTC') AS lower_bound,
         make_timestamptz(substr(c.relname, 15, 4)::integer, substr(c.relname, 20, 2)::integer, 1, 0, 0, 0, 'UTC') + interval '1 month' AS upper_bound
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = 'audit.audit_events'::regclass
     AND c.relname ~ '^audit_events_y[0-9]{4}m(0[1-9]|1[0-2])$';

GRANT SELECT, INSERT ON audit.audit_events TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
GRANT SELECT ON audit.audit_chain_checkpoints, audit.checkpoint_exports, audit.partition_inventory
  TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
GRANT INSERT ON audit.audit_chain_checkpoints, audit.checkpoint_exports TO exdb_worker;
GRANT INSERT ON audit.audit_chain_checkpoints TO exdb_audit_maint;

SELECT audit.ensure_partitions(3);
