-- What ExponetDB observes about registered targets (Wave 4). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- Rules carried by this schema:
-- * a canonical document is stored once per fingerprint and never changes;
--   its digest is checked on read by packages/diagnostics;
-- * snapshots, baselines and drift checks are history: inserted, never
--   changed or deleted; a baseline comes only from a complete snapshot of
--   the same target and generation (an incomplete fingerprint is never
--   authoritative, schema-fingerprints.md §8);
-- * a finding is open once per target and deduplication key; it is updated
--   while open and resolved once; nothing is deleted;
-- * the latest health state per target is a row the worker replaces; raw
--   samples live in daily partitions that only the owner functions create
--   and drop (data-retention.md: 14 days by default, 3 to 60);
-- * a failed probe or check is stored as a failure with its class, never as
--   zero sessions, zero locks or an empty schema (C-28).
CREATE SCHEMA observation AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA observation FROM PUBLIC;
GRANT USAGE ON SCHEMA observation TO exdb_serve, exdb_worker;

CREATE TABLE observation.schema_documents (
  fingerprint     text        PRIMARY KEY CHECK (fingerprint ~ '^fp[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$'),
  canonicalizer   text        NOT NULL CHECK (canonicalizer ~ '^fp[1-9][0-9]*$'),
  pg_major        integer     NOT NULL CHECK (pg_major BETWEEN 16 AND 99),
  entries         integer     NOT NULL CHECK (entries >= 0),
  -- The stored bytes: `encoding` of the document's canonical JSON (compression
  -- is storage only, never part of the fingerprint); document_digest is the
  -- SHA-256 of the uncompressed bytes, content_bytes their length (the reader
  -- refuses to inflate more than that).
  encoding        text        NOT NULL CHECK (encoding = 'gzip'),
  document        bytea       NOT NULL CHECK (octet_length(document) <= 67108864),
  content_bytes   integer     NOT NULL CHECK (content_bytes BETWEEN 1 AND 268435456),
  document_digest text        NOT NULL CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (fingerprint LIKE canonicalizer || ':' || pg_major || ':%')
);

CREATE TABLE observation.schema_snapshots (
  snapshot_id        text        PRIMARY KEY CHECK (snapshot_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id          text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation         integer     NOT NULL CHECK (generation >= 1),
  fingerprint        text        NOT NULL REFERENCES observation.schema_documents (fingerprint) ON DELETE RESTRICT,
  complete           boolean     NOT NULL,
  -- [{class, key, attribute, reason}] (names from the catalog: untrusted, capped)
  visibility         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(visibility) = 'array'),
  missing_schemas    jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_schemas) = 'array'),
  -- schemas that exist outside the managed scope (unmanaged, never "matched")
  excluded_schemas   jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(excluded_schemas) = 'array'),
  server_version_num integer     NOT NULL CHECK (server_version_num BETWEEN 160000 AND 999999),
  purpose            text        NOT NULL CHECK (purpose IN ('registration', 'drift_check', 'read')),
  duration_ms        integer     NOT NULL CHECK (duration_ms >= 0),
  operation_id       text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  taken_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (complete = (jsonb_array_length(visibility) = 0))
);
CREATE INDEX schema_snapshots_latest ON observation.schema_snapshots (target_id, taken_at DESC);

CREATE TABLE observation.schema_baselines (
  baseline_id    text        PRIMARY KEY CHECK (baseline_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id      text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation     integer     NOT NULL CHECK (generation >= 1),
  snapshot_id    text        NOT NULL REFERENCES observation.schema_snapshots (snapshot_id) ON DELETE RESTRICT,
  fingerprint    text        NOT NULL REFERENCES observation.schema_documents (fingerprint) ON DELETE RESTRICT,
  reason         text        NOT NULL CHECK (reason IN ('registration', 'drift_accept')),
  operation_id   text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  established_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX schema_baselines_latest ON observation.schema_baselines (target_id, established_at DESC);

CREATE TABLE observation.drift_checks (
  check_id             text        PRIMARY KEY CHECK (check_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id            text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation           integer     NOT NULL CHECK (generation >= 1),
  -- 'schedule' for the worker, or the identity that asked
  requested_by         text        NOT NULL CHECK (requested_by = 'schedule' OR requested_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  -- not_comparable: the baseline and the current snapshot differ in canonicalizer or
  -- PostgreSQL major, so fingerprints cannot be compared (no finding changes)
  status               text        NOT NULL CHECK (status IN ('clean', 'drifted', 'incomplete', 'no_baseline',
                                     'not_comparable', 'failed')),
  baseline_fingerprint text,
  current_fingerprint  text,
  snapshot_id          text        REFERENCES observation.schema_snapshots (snapshot_id) ON DELETE RESTRICT,
  -- triage buckets (drift-detection.md §4): drifted and matched objects; unmanaged
  -- counts the schemas outside the managed scope (never compared, never "matched")
  drifted              integer     NOT NULL DEFAULT 0 CHECK (drifted >= 0),
  matched              integer     NOT NULL DEFAULT 0 CHECK (matched >= 0),
  unmanaged            integer     NOT NULL DEFAULT 0 CHECK (unmanaged >= 0),
  opened               integer     NOT NULL DEFAULT 0 CHECK (opened >= 0),
  updated              integer     NOT NULL DEFAULT 0 CHECK (updated >= 0),
  resolved             integer     NOT NULL DEFAULT 0 CHECK (resolved >= 0),
  error_code           text        CHECK (error_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  started_at           timestamptz NOT NULL,
  finished_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CHECK (status IN ('failed', 'no_baseline') OR current_fingerprint IS NOT NULL),
  CHECK (finished_at >= started_at)
);
CREATE INDEX drift_checks_latest ON observation.drift_checks (target_id, finished_at DESC);

CREATE TABLE observation.findings (
  finding_id        text        PRIMARY KEY CHECK (finding_id ~ '^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id         text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  kind              text        NOT NULL CHECK (kind IN ('drift', 'health')),
  code              text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  severity          text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  dedup_key         text        NOT NULL CHECK (char_length(dedup_key) BETWEEN 1 AND 1024),
  summary           text        NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1024),
  details           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  state             text        NOT NULL CHECK (state IN ('open', 'resolved')),
  occurrences       integer     NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  resolved_at       timestamptz,
  resolution        text        CHECK (resolution IN ('cleared', 'accepted', 'superseded')),
  opened_by_check   text        REFERENCES observation.drift_checks (check_id) ON DELETE RESTRICT,
  resolved_by_check text        REFERENCES observation.drift_checks (check_id) ON DELETE RESTRICT,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE UNIQUE INDEX findings_one_open ON observation.findings (target_id, dedup_key) WHERE state = 'open';
CREATE INDEX findings_by_target ON observation.findings (target_id, state, last_seen_at DESC);

CREATE TABLE observation.target_status (
  target_id       text        PRIMARY KEY REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  state           text        NOT NULL CHECK (state IN ('healthy', 'degraded', 'unhealthy', 'unreachable', 'unknown', 'suspended')),
  conditions      jsonb       NOT NULL CHECK (jsonb_typeof(conditions) = 'array'),
  probes          jsonb       NOT NULL CHECK (jsonb_typeof(probes) = 'array'),
  unknown_because text        CHECK (unknown_because ~ '^[a-z][a-z0-9_]{0,63}$'),
  observed_at     timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'unknown') = (unknown_because IS NOT NULL))
);

CREATE TABLE observation.health_samples (
  sample_id   text        NOT NULL CHECK (sample_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id   text        NOT NULL,
  endpoint_id text,
  observed_at timestamptz NOT NULL,
  state       text        NOT NULL CHECK (state IN ('healthy', 'degraded', 'unhealthy', 'unreachable', 'unknown', 'suspended')),
  probes      jsonb       NOT NULL CHECK (jsonb_typeof(probes) = 'array'),
  conditions  jsonb       NOT NULL CHECK (jsonb_typeof(conditions) = 'array'),
  PRIMARY KEY (sample_id, observed_at)
) PARTITION BY RANGE (observed_at);
CREATE INDEX health_samples_by_target ON observation.health_samples (target_id, observed_at DESC);

-- ----- guards -----

CREATE FUNCTION observation.findings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.occurrences <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH01', MESSAGE = 'a finding starts open';
    END IF;
    NEW.first_seen_at := clock_timestamp();
    NEW.last_seen_at := NEW.first_seen_at;
    RETURN NEW;
  END IF;
  IF (NEW.finding_id, NEW.target_id, NEW.kind, NEW.code, NEW.dedup_key, NEW.first_seen_at, NEW.opened_by_check)
     IS DISTINCT FROM (OLD.finding_id, OLD.target_id, OLD.kind, OLD.code, OLD.dedup_key, OLD.first_seen_at,
      OLD.opened_by_check)
     OR OLD.state <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXH01', MESSAGE = 'a finding keeps its identity and is changed only while open';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.occurrences <> OLD.occurrences + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH01', MESSAGE = 'an open finding seen again counts one more occurrence';
    END IF;
    NEW.last_seen_at := clock_timestamp();
  ELSE
    IF NEW.occurrences <> OLD.occurrences THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH01', MESSAGE = 'resolving a finding does not count an occurrence';
    END IF;
    NEW.resolved_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION observation.findings_guard() FROM PUBLIC;
CREATE TRIGGER findings_guard BEFORE INSERT OR UPDATE ON observation.findings
  FOR EACH ROW EXECUTE FUNCTION observation.findings_guard();

CREATE FUNCTION observation.baseline_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM observation.schema_snapshots s
                  WHERE s.snapshot_id = NEW.snapshot_id AND s.target_id = NEW.target_id
                    AND s.generation = NEW.generation AND s.fingerprint = NEW.fingerprint AND s.complete) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXH02', MESSAGE = 'a baseline is a complete snapshot of the same target and generation';
  END IF;
  NEW.established_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION observation.baseline_guard() FROM PUBLIC;
CREATE TRIGGER schema_baselines_guard BEFORE INSERT ON observation.schema_baselines
  FOR EACH ROW EXECUTE FUNCTION observation.baseline_guard();

CREATE FUNCTION observation.snapshot_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM registry.targets t WHERE t.target_id = NEW.target_id AND t.generation = NEW.generation) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXH03', MESSAGE = 'a snapshot names its target''s current generation';
  END IF;
  NEW.taken_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION observation.snapshot_guard() FROM PUBLIC;
CREATE TRIGGER schema_snapshots_guard BEFORE INSERT ON observation.schema_snapshots
  FOR EACH ROW EXECUTE FUNCTION observation.snapshot_guard();

-- History tables are append-only; nothing is deleted or truncated.
CREATE TRIGGER schema_documents_append_only BEFORE UPDATE OR DELETE ON observation.schema_documents
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_snapshots_append_only BEFORE UPDATE OR DELETE ON observation.schema_snapshots
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_baselines_append_only BEFORE UPDATE OR DELETE ON observation.schema_baselines
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER drift_checks_append_only BEFORE UPDATE OR DELETE ON observation.drift_checks
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER findings_no_delete BEFORE DELETE ON observation.findings
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER target_status_no_delete BEFORE DELETE ON observation.target_status
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_documents_no_truncate BEFORE TRUNCATE ON observation.schema_documents
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_snapshots_no_truncate BEFORE TRUNCATE ON observation.schema_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER schema_baselines_no_truncate BEFORE TRUNCATE ON observation.schema_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER drift_checks_no_truncate BEFORE TRUNCATE ON observation.drift_checks
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER findings_no_truncate BEFORE TRUNCATE ON observation.findings
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER target_status_no_truncate BEFORE TRUNCATE ON observation.target_status
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- ----- health sample partitions (data-retention.md §2) -----

-- Creates the daily partitions from today to `p_days_ahead` days ahead.
CREATE FUNCTION observation.ensure_sample_partitions(p_days_ahead integer) RETURNS integer
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
  PERFORM pg_advisory_xact_lock(1163412546, 1537273329);
  day := date_trunc('day', clock_timestamp())::date;
  FOR i IN 0 .. p_days_ahead LOOP
    name := format('health_samples_d%s', to_char(day, 'YYYYMMDD'));
    IF to_regclass(format('observation.%I', name)) IS NULL THEN
      EXECUTE format('CREATE TABLE observation.%I PARTITION OF observation.health_samples FOR VALUES FROM (%L) TO (%L)',
                     name, day::timestamptz, (day + 1)::timestamptz);
      EXECUTE format('REVOKE ALL ON observation.%I FROM PUBLIC', name);
      created := created + 1;
    END IF;
    day := day + 1;
  END LOOP;
  RETURN created;
END
$fn$;
REVOKE ALL ON FUNCTION observation.ensure_sample_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION observation.ensure_sample_partitions(integer) TO exdb_worker;

-- Drops the daily partitions that end before now − retention (3 to 60 days). Returns the number dropped.
CREATE FUNCTION observation.drop_expired_sample_partitions(p_retention_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET timezone = 'UTC' SET lock_timeout = '5s' AS $fn$
DECLARE
  part    record;
  dropped integer := 0;
  bound   date;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 3 OR p_retention_days > 60 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'retention must be between 3 and 60 days';
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, 1537273329);
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'observation.health_samples'::regclass
       AND c.relname ~ '^health_samples_d[0-9]{8}$'
     ORDER BY c.relname
  LOOP
    bound := to_date(substring(part.relname FROM 17 FOR 8), 'YYYYMMDD') + 1;
    IF bound < (clock_timestamp() - make_interval(days => p_retention_days))::date THEN
      EXECUTE format('DROP TABLE observation.%I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$fn$;
REVOKE ALL ON FUNCTION observation.drop_expired_sample_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION observation.drop_expired_sample_partitions(integer) TO exdb_worker;

SELECT observation.ensure_sample_partitions(2);

-- ----- privileges -----
-- serve reads everything and records what a read or an on-demand drift check
-- observed (documents, snapshots, checks, findings); the worker samples,
-- checks on schedule, registers baselines and replaces the latest status.
GRANT SELECT ON ALL TABLES IN SCHEMA observation TO exdb_serve, exdb_worker;
GRANT INSERT ON observation.schema_documents, observation.schema_snapshots, observation.drift_checks,
  observation.findings TO exdb_serve, exdb_worker;
GRANT UPDATE (severity, summary, details, state, occurrences, last_seen_at, resolved_at, resolution, resolved_by_check)
  ON observation.findings TO exdb_serve, exdb_worker;
GRANT INSERT ON observation.schema_baselines, observation.health_samples TO exdb_worker;
GRANT INSERT, UPDATE ON observation.target_status TO exdb_worker;
