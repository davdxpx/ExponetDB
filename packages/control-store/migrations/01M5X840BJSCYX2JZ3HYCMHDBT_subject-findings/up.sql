CREATE TABLE observation.advisor_runs (
  advisor_run_id  text        PRIMARY KEY CHECK (advisor_run_id ~ '^adv_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id       text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  generation      integer     NOT NULL CHECK (generation >= 1),
  catalog_version integer     NOT NULL CHECK (catalog_version >= 1),
  categories      text[]      NOT NULL CHECK (cardinality(categories) BETWEEN 1 AND 4
                                              AND categories <@ ARRAY['security', 'performance', 'operations', 'change_safety']),
  -- {kind: 'schedule'} or {kind: 'identity', identityId}
  requested_by    jsonb       NOT NULL CHECK (jsonb_typeof(requested_by) = 'object'
                                              AND requested_by ->> 'kind' IN ('schedule', 'identity')),
  outcome         text        NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
  findings        integer     NOT NULL CHECK (findings >= 0),
  skipped         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skipped) = 'array'),
  error_code      text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  duration_ms     integer     NOT NULL CHECK (duration_ms >= 0),
  ran_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX advisor_runs_by_target ON observation.advisor_runs (target_id, ran_at DESC);

CREATE TABLE observation.subject_findings (
  finding_id      text        PRIMARY KEY CHECK (finding_id ~ '^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id       text        REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  cluster_id      text        REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  kind            text        NOT NULL CHECK (kind IN ('advisor', 'statements', 'backup')),
  code            text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  category        text        CHECK (category IN ('security', 'performance', 'operations', 'change_safety')),
  severity        text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  security_relevant boolean   NOT NULL DEFAULT false,
  dedup_key       text        NOT NULL CHECK (char_length(dedup_key) BETWEEN 1 AND 1024),
  summary         text        NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1024),
  object          text        CHECK (char_length(object) BETWEEN 1 AND 512),
  remediation     text        CHECK (char_length(remediation) BETWEEN 1 AND 2048),
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'
                                                                    AND octet_length(details::text) <= 16384),
  state           text        NOT NULL CHECK (state IN ('open', 'resolved')),
  occurrences     integer     NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  expires_at      timestamptz,
  resolved_at     timestamptz,
  resolution      text        CHECK (resolution IN ('cleared', 'expired', 'superseded')),
  opened_by_run   text        REFERENCES observation.advisor_runs (advisor_run_id) ON DELETE RESTRICT,
  resolved_by_run text        REFERENCES observation.advisor_runs (advisor_run_id) ON DELETE RESTRICT,
  CHECK ((target_id IS NULL) <> (cluster_id IS NULL)),
  CHECK ((kind = 'backup') = (cluster_id IS NOT NULL)),
  CHECK ((kind = 'advisor') = (category IS NOT NULL)),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE UNIQUE INDEX subject_findings_one_open_target ON observation.subject_findings (target_id, kind, dedup_key)
  WHERE state = 'open' AND target_id IS NOT NULL;
CREATE UNIQUE INDEX subject_findings_one_open_cluster ON observation.subject_findings (cluster_id, kind, dedup_key)
  WHERE state = 'open' AND cluster_id IS NOT NULL;
CREATE INDEX subject_findings_by_target ON observation.subject_findings (target_id, state, last_seen_at DESC)
  WHERE target_id IS NOT NULL;
CREATE INDEX subject_findings_by_cluster ON observation.subject_findings (cluster_id, state, last_seen_at DESC)
  WHERE cluster_id IS NOT NULL;
CREATE INDEX subject_findings_open_by_severity ON observation.subject_findings (state, severity, code);

CREATE FUNCTION observation.subject_findings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NEW.occurrences <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH21', MESSAGE = 'a finding starts open';
    END IF;
    NEW.first_seen_at := clock_timestamp();
    NEW.last_seen_at := NEW.first_seen_at;
    RETURN NEW;
  END IF;
  IF (NEW.finding_id, NEW.target_id, NEW.cluster_id, NEW.kind, NEW.code, NEW.category, NEW.dedup_key,
      NEW.first_seen_at, NEW.opened_by_run)
     IS DISTINCT FROM (OLD.finding_id, OLD.target_id, OLD.cluster_id, OLD.kind, OLD.code, OLD.category,
      OLD.dedup_key, OLD.first_seen_at, OLD.opened_by_run)
     OR OLD.state <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXH21', MESSAGE = 'a finding keeps its identity and is changed only while open';
  END IF;
  IF NEW.state = 'open' THEN
    IF NEW.occurrences <> OLD.occurrences + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH21', MESSAGE = 'an open finding seen again counts one more occurrence';
    END IF;
    NEW.last_seen_at := clock_timestamp();
  ELSE
    IF NEW.occurrences <> OLD.occurrences THEN
      RAISE EXCEPTION USING ERRCODE = 'EXH21', MESSAGE = 'resolving a finding does not count an occurrence';
    END IF;
    NEW.resolved_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION observation.subject_findings_guard() FROM PUBLIC;
CREATE TRIGGER subject_findings_guard BEFORE INSERT OR UPDATE ON observation.subject_findings
  FOR EACH ROW EXECUTE FUNCTION observation.subject_findings_guard();
CREATE TRIGGER subject_findings_no_delete BEFORE DELETE ON observation.subject_findings
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER subject_findings_no_truncate BEFORE TRUNCATE ON observation.subject_findings
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER advisor_runs_append_only BEFORE UPDATE OR DELETE ON observation.advisor_runs
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER advisor_runs_no_truncate BEFORE TRUNCATE ON observation.advisor_runs
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON observation.advisor_runs, observation.subject_findings TO exdb_serve, exdb_worker;
GRANT INSERT ON observation.advisor_runs, observation.subject_findings TO exdb_serve, exdb_worker;
GRANT UPDATE (severity, security_relevant, summary, object, remediation, details, state, occurrences,
  last_seen_at, expires_at, resolved_at, resolution, resolved_by_run)
  ON observation.subject_findings TO exdb_serve, exdb_worker;
