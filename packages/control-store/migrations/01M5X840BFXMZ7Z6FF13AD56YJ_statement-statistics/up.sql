-- Statement statistics (performance.md §2). Owner: exdb_migrate.
CREATE TABLE observation.statement_samples (
  sample_id        text        PRIMARY KEY CHECK (sample_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id        text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation       integer     NOT NULL CHECK (generation >= 1),
  outcome          text        NOT NULL CHECK (outcome IN ('ok', 'extension_missing', 'not_permitted', 'failed')),
  error_code       text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- pg_stat_statements_info.stats_reset and .dealloc, pg_postmaster_start_time() as read with the sample
  stats_reset      timestamptz,
  dealloc          bigint      CHECK (dealloc >= 0),
  postmaster_start timestamptz,
  discontinuity    text        NOT NULL CHECK (discontinuity IN ('none', 'first', 'stats_reset', 'server_restart', 'entries_deallocated')),
  statements       integer     NOT NULL CHECK (statements BETWEEN 0 AND 200),
  duration_ms      integer     NOT NULL CHECK (duration_ms >= 0),
  sampled_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'ok') = (error_code IS NULL)),
  CHECK (outcome = 'ok' OR statements = 0)
);
CREATE INDEX statement_samples_by_target ON observation.statement_samples (target_id, sampled_at DESC);

CREATE TABLE observation.stats_reset_events (
  sample_id  text        PRIMARY KEY REFERENCES observation.statement_samples (sample_id) ON DELETE RESTRICT,
  target_id  text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  kind       text        NOT NULL CHECK (kind IN ('stats_reset', 'server_restart', 'entries_deallocated')),
  at         timestamptz NOT NULL
);
CREATE INDEX stats_reset_events_by_target ON observation.stats_reset_events (target_id, at DESC);

-- The cumulative counters of the last successful sample per statement: the
-- base of the next delta. Replaced by the worker with every sample.
CREATE TABLE observation.statement_latest (
  target_id      text             NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  statement_key  text             NOT NULL CHECK (statement_key ~ '^sha256:[0-9a-f]{64}$'),
  sample_id      text             NOT NULL CHECK (sample_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  stats_reset    timestamptz,
  postmaster_start timestamptz,
  calls          bigint           NOT NULL CHECK (calls >= 0),
  total_time_ms  double precision NOT NULL CHECK (total_time_ms >= 0),
  rows           bigint           NOT NULL CHECK (rows >= 0),
  blks_hit       bigint           NOT NULL CHECK (blks_hit >= 0),
  blks_read      bigint           NOT NULL CHECK (blks_read >= 0),
  sampled_at     timestamptz      NOT NULL,
  PRIMARY KEY (target_id, statement_key)
);

CREATE TABLE observation.statement_deltas (
  sample_id       text             NOT NULL CHECK (sample_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id       text             NOT NULL,
  statement_key   text             NOT NULL CHECK (statement_key ~ '^sha256:[0-9a-f]{64}$'),
  sampled_at      timestamptz      NOT NULL,
  -- the interval the delta covers: from the previous sample of the same statement
  from_at         timestamptz      NOT NULL,
  queryid         text             NOT NULL CHECK (queryid ~ '^-?[0-9]{1,20}$'),
  database_name   text             NOT NULL CHECK (octet_length(database_name) BETWEEN 1 AND 63),
  role_name       text             NOT NULL CHECK (octet_length(role_name) BETWEEN 1 AND 63),
  normalized_text text             NOT NULL CHECK (char_length(normalized_text) BETWEEN 1 AND 16384),
  text_redacted   boolean          NOT NULL,
  calls           bigint           NOT NULL CHECK (calls >= 0),
  total_time_ms   double precision NOT NULL CHECK (total_time_ms >= 0),
  rows            bigint           NOT NULL CHECK (rows >= 0),
  blks_hit        bigint           NOT NULL CHECK (blks_hit >= 0),
  blks_read       bigint           NOT NULL CHECK (blks_read >= 0),
  CHECK (from_at < sampled_at),
  PRIMARY KEY (sample_id, statement_key, sampled_at)
) PARTITION BY RANGE (sampled_at);
CREATE INDEX statement_deltas_by_target ON observation.statement_deltas (target_id, sampled_at DESC);
CREATE INDEX statement_deltas_by_statement ON observation.statement_deltas (target_id, statement_key, sampled_at DESC);

CREATE TABLE observation.statement_daily (
  target_id       text             NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  day             date             NOT NULL,
  statement_key   text             NOT NULL CHECK (statement_key ~ '^sha256:[0-9a-f]{64}$'),
  queryid         text             NOT NULL CHECK (queryid ~ '^-?[0-9]{1,20}$'),
  normalized_text text             NOT NULL CHECK (char_length(normalized_text) BETWEEN 1 AND 16384),
  text_redacted   boolean          NOT NULL,
  calls           bigint           NOT NULL CHECK (calls >= 0),
  total_time_ms   double precision NOT NULL CHECK (total_time_ms >= 0),
  rows            bigint           NOT NULL CHECK (rows >= 0),
  samples         integer          NOT NULL CHECK (samples >= 1),
  PRIMARY KEY (target_id, day, statement_key)
);

-- History is append-only; deltas leave only by whole partitions.
CREATE TRIGGER statement_samples_append_only BEFORE UPDATE OR DELETE ON observation.statement_samples
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER statement_samples_no_truncate BEFORE TRUNCATE ON observation.statement_samples
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER stats_reset_events_append_only BEFORE UPDATE OR DELETE ON observation.stats_reset_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER stats_reset_events_no_truncate BEFORE TRUNCATE ON observation.stats_reset_events
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER statement_deltas_append_only BEFORE UPDATE OR DELETE ON observation.statement_deltas
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER statement_daily_no_delete BEFORE DELETE ON observation.statement_daily
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();

-- A sample with a discontinuity has exactly one reset event; the deltas of a
-- sample come only from an ok sample of the same target.
CREATE FUNCTION observation.statement_delta_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM observation.statement_samples s
                  WHERE s.sample_id = NEW.sample_id AND s.target_id = NEW.target_id
                    AND s.outcome = 'ok' AND s.sampled_at = NEW.sampled_at
                    AND s.discontinuity IN ('none', 'entries_deallocated')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXH20',
      MESSAGE = 'a delta belongs to an ok sample of its target that crossed no reset';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION observation.statement_delta_guard() FROM PUBLIC;
CREATE TRIGGER statement_deltas_guard BEFORE INSERT ON observation.statement_deltas
  FOR EACH ROW EXECUTE FUNCTION observation.statement_delta_guard();

-- ----- delta partitions (data-retention.md §2: 30 days by default, 7 to 90) -----

CREATE FUNCTION observation.ensure_statement_partitions(p_days_ahead integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $fn$
DECLARE
  day     date;
  created integer := 0;
  name    text;
BEGIN
  IF p_days_ahead IS NULL OR p_days_ahead < 1 OR p_days_ahead > 14 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'days ahead must be between 1 and 14';
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, 1537273330);
  day := date_trunc('day', clock_timestamp())::date;
  FOR i IN 0 .. p_days_ahead LOOP
    name := format('statement_deltas_d%s', to_char(day, 'YYYYMMDD'));
    IF to_regclass(format('observation.%I', name)) IS NULL THEN
      EXECUTE format('CREATE TABLE observation.%I PARTITION OF observation.statement_deltas FOR VALUES FROM (%L) TO (%L)',
                     name, day::timestamptz, (day + 1)::timestamptz);
      EXECUTE format('REVOKE ALL ON observation.%I FROM PUBLIC', name);
      created := created + 1;
    END IF;
    day := day + 1;
  END LOOP;
  RETURN created;
END
$fn$;
REVOKE ALL ON FUNCTION observation.ensure_statement_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION observation.ensure_statement_partitions(integer) TO exdb_worker;

CREATE FUNCTION observation.drop_expired_statement_partitions(p_retention_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $fn$
DECLARE
  part    record;
  dropped integer := 0;
  bound   date;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 7 OR p_retention_days > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retention must be between 7 and 90 days';
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, 1537273330);
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'observation.statement_deltas'::regclass
       AND c.relname ~ '^statement_deltas_d[0-9]{8}$'
     ORDER BY c.relname
  LOOP
    bound := to_date(substring(part.relname FROM 19 FOR 8), 'YYYYMMDD') + 1;
    IF bound < (clock_timestamp() - make_interval(days => p_retention_days))::date THEN
      EXECUTE format('DROP TABLE observation.%I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$fn$;
REVOKE ALL ON FUNCTION observation.drop_expired_statement_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION observation.drop_expired_statement_partitions(integer) TO exdb_worker;

SELECT observation.ensure_statement_partitions(2);

-- ----- privileges: the worker samples, serve only reads -----
GRANT SELECT ON observation.statement_samples, observation.stats_reset_events, observation.statement_latest,
  observation.statement_deltas, observation.statement_daily TO exdb_serve, exdb_worker;
GRANT INSERT ON observation.statement_samples, observation.stats_reset_events, observation.statement_deltas
  TO exdb_worker;
GRANT INSERT, UPDATE ON observation.statement_latest, observation.statement_daily TO exdb_worker;
