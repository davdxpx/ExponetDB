-- The backup domain (ADR-0036 to ADR-0038). Owner: exdb_migrate. Nothing
-- here is a key, a passphrase or a storage credential: secrets stay on the
-- node (secret_source host_config); a sealed delivery needs a later bundle.
CREATE SCHEMA backups AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA backups FROM PUBLIC;
GRANT USAGE ON SCHEMA backups TO exdb_serve, exdb_worker;

CREATE TABLE backups.repositories (
  repository_id    text        PRIMARY KEY CHECK (repository_id ~ '^bkr_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id       text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  layer            text        NOT NULL CHECK (layer IN ('l1_physical', 'l2_logical', 'l3_offprovider')),
  engine           text        NOT NULL CHECK (engine IN ('pgbackrest', 'pg_dump', 'restic')),
  provider         text        NOT NULL CHECK (provider IN ('hetzner_object_storage', 'cloudflare_r2', 's3_compatible', 'posix')),
  endpoint_host    text        CHECK (endpoint_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
                                      AND octet_length(endpoint_host) <= 253),
  region           text        CHECK (region ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  bucket           text        CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  prefix           text        NOT NULL CHECK (prefix ~ '^([A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]*$'
                                               AND octet_length(prefix) <= 256
                                               AND ('/' || prefix || '/') !~ '/\.\.?/'),
  stanza           text        CHECK (stanza ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'),
  repo_index       integer     CHECK (repo_index BETWEEN 1 AND 4),
  priority         integer     NOT NULL CHECK (priority BETWEEN 1 AND 9),
  purpose          text        NOT NULL CHECK (purpose IN ('primary', 'secondary', 'offsite')),
  ownership        text        NOT NULL CHECK (ownership IN ('external', 'adopted_observed', 'adopted_runs', 'owned')),
  -- sealed delivery from the Control Plane does not exist yet (ADR-0036 §4)
  secret_source    text        NOT NULL CHECK (secret_source = 'host_config'),
  lock_mode        text        NOT NULL CHECK (lock_mode IN ('none', 's3_object_lock', 'r2_bucket_lock', 'unknown')),
  -- 'proven' needs a recorded deletion and overwrite experiment, an operation this bundle does not have
  lock_capability  text        NOT NULL CHECK (lock_capability IN ('unknown', 'unsupported', 'unproven')),
  lock_retention_days integer  CHECK (lock_retention_days BETWEEN 0 AND 36500),
  cipher           text        NOT NULL CHECK (cipher IN ('aes-256-cbc', 'restic', 'none', 'unknown')),
  offline_copy_confirmed_at timestamptz,
  pinned_engine_version   text CHECK (pinned_engine_version ~ '^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$'),
  observed_engine_version text CHECK (char_length(observed_engine_version) BETWEEN 1 AND 32),
  engine_advisory  text        NOT NULL DEFAULT 'unknown' CHECK (engine_advisory IN ('none', 'below_floor', 'subkey_check_missing', 'unknown')),
  state            text        NOT NULL CHECK (state IN ('registered', 'observing', 'active', 'degraded', 'retired')),
  revision         integer     NOT NULL CHECK (revision >= 1),
  observed         jsonb       CHECK (observed IS NULL OR (jsonb_typeof(observed) = 'object' AND octet_length(observed::text) <= 65536)),
  observed_at      timestamptz,
  reconciled_at    timestamptz,
  reconciliation_outcome text  CHECK (reconciliation_outcome IN ('ok', 'partial', 'failed')),
  reconciliation_error   text  CHECK (reconciliation_error ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_operation_id text NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  changed_by_operation_id text REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  retired_at       timestamptz,
  retired_by_operation_id text REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CHECK ((provider = 'posix') = (endpoint_host IS NULL) AND (provider = 'posix') = (bucket IS NULL)),
  CHECK ((engine = 'pgbackrest') = (stanza IS NOT NULL) AND (engine = 'pgbackrest') = (repo_index IS NOT NULL)),
  CHECK ((layer, engine) IN (('l1_physical', 'pgbackrest'), ('l2_logical', 'pg_dump'), ('l2_logical', 'restic'),
                             ('l3_offprovider', 'restic'), ('l3_offprovider', 'pgbackrest'))),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL) AND (state = 'retired') = (retired_by_operation_id IS NOT NULL)),
  CHECK ((reconciled_at IS NULL) = (reconciliation_outcome IS NULL)),
  CHECK (reconciliation_outcome IS DISTINCT FROM 'ok' OR reconciliation_error IS NULL)
);
-- One live record per physical location: the same stanza and repository, or
-- the same bucket and prefix, is never adopted twice.
CREATE UNIQUE INDEX repositories_one_live_location ON backups.repositories
  (cluster_id, engine, coalesce(stanza, ''), coalesce(repo_index, 0), coalesce(endpoint_host, ''),
   coalesce(bucket, ''), prefix)
  WHERE state <> 'retired';
CREATE INDEX repositories_by_cluster ON backups.repositories (cluster_id);

CREATE TABLE backups.policies (
  policy_id    text        PRIMARY KEY CHECK (policy_id ~ '^bpl_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id   text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  revision     integer     NOT NULL CHECK (revision >= 1),
  state        text        NOT NULL CHECK (state IN ('active', 'superseded')),
  body         jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 16384),
  operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cluster_id, revision)
);
CREATE UNIQUE INDEX policies_one_active ON backups.policies (cluster_id) WHERE state = 'active';

CREATE TABLE backups.runs (
  run_id          text        PRIMARY KEY CHECK (run_id ~ '^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id      text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  repository_id   text        REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  node_id         text        NOT NULL REFERENCES nodes.nodes (node_id) ON DELETE RESTRICT,
  purpose         text        NOT NULL CHECK (purpose IN ('backup', 'verify', 'expire', 'restore', 'reverify', 'discard')),
  kind            text        CHECK (kind IN ('full', 'differential', 'incremental', 'logical')),
  operation_id    text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  start_job_id    text        CHECK (start_job_id ~ '^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  start_args_hash text        CHECK (start_args_hash ~ '^sha256:[0-9a-f]{64}$'),
  state           text        NOT NULL CHECK (state IN ('starting', 'running', 'succeeded', 'failed', 'canceled', 'lost', 'unknown')),
  started_at      timestamptz,
  finished_at     timestamptz,
  last_status_at  timestamptz,
  exit_code       integer     CHECK (exit_code BETWEEN -1 AND 255),
  progress        jsonb       CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object'),
  outcome         jsonb       CHECK (outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 16384)),
  error_code      text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((purpose = 'backup') = (kind IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'canceled', 'lost')) = (finished_at IS NOT NULL)),
  CHECK (purpose IN ('discard') OR repository_id IS NOT NULL)
);
-- At most one engine run per cluster that is not known to be over (ADR-0037 §3).
CREATE UNIQUE INDEX runs_one_open_per_cluster ON backups.runs (cluster_id)
  WHERE state IN ('starting', 'running', 'unknown');
CREATE INDEX runs_by_cluster ON backups.runs (cluster_id, created_at DESC);

CREATE TABLE backups.catalog (
  backup_id           text        PRIMARY KEY CHECK (backup_id ~ '^bkp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  repository_id       text        NOT NULL REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  engine_label        text        NOT NULL CHECK (char_length(engine_label) BETWEEN 1 AND 128 AND engine_label !~ '[[:cntrl:]]'),
  kind                text        NOT NULL CHECK (kind IN ('full', 'differential', 'incremental', 'logical')),
  state               text        NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  size_bytes          bigint      CHECK (size_bytes >= 0),
  repository_size_bytes bigint    CHECK (repository_size_bytes >= 0),
  lsn_start           text        CHECK (lsn_start ~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'),
  lsn_stop            text        CHECK (lsn_stop ~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'),
  timeline            integer     CHECK (timeline >= 1),
  pg_major            integer     CHECK (pg_major BETWEEN 9 AND 99),
  system_identifier   text        CHECK (system_identifier ~ '^[0-9]{1,20}$'),
  engine_version      text        CHECK (char_length(engine_version) BETWEEN 1 AND 32),
  verification_state  text        NOT NULL DEFAULT 'pending' CHECK (verification_state IN ('pending', 'passed', 'failed')),
  verified_at         timestamptz,
  verification_run_id text        REFERENCES backups.runs (run_id) ON DELETE RESTRICT,
  divergence          text        NOT NULL DEFAULT 'none' CHECK (divergence IN ('none', 'missing_in_engine')),
  missing_since       timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_id, engine_label),
  CHECK ((verification_state = 'pending') = (verified_at IS NULL)),
  CHECK ((verification_state = 'pending') = (verification_run_id IS NULL)),
  CHECK ((divergence = 'missing_in_engine') = (missing_since IS NOT NULL))
);
CREATE INDEX catalog_by_repository ON backups.catalog (repository_id, started_at DESC);

CREATE TABLE backups.wal_coverage (
  repository_id text        NOT NULL REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  archive_id    text        NOT NULL CHECK (archive_id ~ '^[0-9]{1,2}-[0-9]{1,5}$'),
  timeline      integer     NOT NULL CHECK (timeline >= 1),
  min_segment   text        CHECK (min_segment ~ '^[0-9A-F]{24}$'),
  max_segment   text        CHECK (max_segment ~ '^[0-9A-F]{24}$'),
  max_archived_at timestamptz,
  gaps          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  observed_at   timestamptz NOT NULL,
  PRIMARY KEY (repository_id, archive_id, timeline)
);

CREATE TABLE backups.reconciliations (
  reconciliation_id text        PRIMARY KEY CHECK (reconciliation_id ~ '^smp_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  repository_id     text        NOT NULL REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  job_id            text        CHECK (job_id ~ '^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  outcome           text        NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
  error_code        text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  entries           integer     NOT NULL CHECK (entries >= 0),
  divergent         integer     NOT NULL CHECK (divergent >= 0),
  observed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX reconciliations_by_repository ON backups.reconciliations (repository_id, observed_at DESC);

CREATE TABLE backups.restores (
  restore_id     text        PRIMARY KEY CHECK (restore_id ~ '^rst_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id     text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  target_id      text        REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  -- clone is out of scope in V1 (restore.clone-masking is not built)
  purpose        text        NOT NULL CHECK (purpose IN ('drill', 'recovery')),
  state          text        NOT NULL CHECK (state IN ('planned', 'preparing', 'restoring', 'recovering', 'verifying',
                                                       'ready', 'failed', 'discarded', 'promoted', 'needs_attention')),
  repository_id  text        NOT NULL REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  backup_id      text        REFERENCES backups.catalog (backup_id) ON DELETE RESTRICT,
  point_in_time  timestamptz,
  timeline       integer     CHECK (timeline >= 1),
  wal_from       text        CHECK (wal_from ~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'),
  wal_to         text        CHECK (wal_to ~ '^[0-9A-F]{1,8}/[0-9A-F]{1,8}$'),
  destination_kind text      NOT NULL CHECK (destination_kind IN ('scratch', 'new_cluster')),
  node_id        text        NOT NULL REFERENCES nodes.nodes (node_id) ON DELETE RESTRICT,
  run_id         text        REFERENCES backups.runs (run_id) ON DELETE RESTRICT,
  port           integer     CHECK (port BETWEEN 55400 AND 55499),
  phases         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(phases) = 'array'),
  checks         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  plan_id        text        NOT NULL REFERENCES operations.plans (plan_id) ON DELETE RESTRICT,
  operation_id   text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at    timestamptz,
  discarded_at   timestamptz,
  CHECK ((purpose = 'drill') = (destination_kind = 'scratch')),
  CHECK ((purpose = 'recovery') = (target_id IS NOT NULL)),
  CHECK ((state = 'discarded') = (discarded_at IS NOT NULL))
);
CREATE INDEX restores_by_cluster ON backups.restores (cluster_id, created_at DESC);

CREATE TABLE backups.drills (
  drill_id        text        PRIMARY KEY CHECK (drill_id ~ '^drl_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id      text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  restore_id      text        REFERENCES backups.restores (restore_id) ON DELETE RESTRICT,
  repository_id   text        NOT NULL REFERENCES backups.repositories (repository_id) ON DELETE RESTRICT,
  selection       text        NOT NULL CHECK (selection IN ('latest', 'older', 'pitr_random', 'backup', 'pitr')),
  mode            text        NOT NULL CHECK (mode IN ('control_plane', 'offline_runbook')),
  outcome         text        NOT NULL CHECK (outcome IN ('pending', 'passed', 'failed', 'aborted', 'attested')),
  measured_rto_seconds integer CHECK (measured_rto_seconds >= 0),
  runbook_digest  text        CHECK (runbook_digest ~ '^sha256:[0-9a-f]{64}$'),
  notes           text        CHECK (char_length(notes) BETWEEN 1 AND 4000),
  recorded_by     text        CHECK (recorded_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((mode = 'offline_runbook') = (restore_id IS NULL)),
  CHECK ((mode = 'offline_runbook') = (runbook_digest IS NOT NULL)),
  CHECK ((mode = 'offline_runbook') = (recorded_by IS NOT NULL)),
  -- an offline drill is an attestation, never a measured pass; only a passed drill has a measured RTO
  CHECK (mode = 'control_plane' OR outcome IN ('attested', 'failed')),
  CHECK (mode = 'offline_runbook' OR outcome <> 'attested'),
  CHECK (measured_rto_seconds IS NULL OR outcome = 'passed')
);
CREATE INDEX drills_by_cluster ON backups.drills (cluster_id, created_at DESC);

-- ----- guards -----

-- A repository is adopted by its own operation, on a cluster that is not
-- retired (the cluster row locked FOR SHARE, so a retirement waits); then
-- it changes ownership only adopted_observed -> adopted_runs by an ownership
-- operation (owned needs a capability that does not exist yet), is retired
-- once by a retirement operation, and otherwise only its observation
-- columns change. Nothing is deleted.
CREATE FUNCTION backups.repository_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  cluster_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a backup repository record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT c.state INTO cluster_state FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id FOR SHARE;
    IF cluster_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository is adopted for an active cluster';
    END IF;
    IF NEW.ownership <> 'adopted_observed' OR NEW.state <> 'observing' OR NEW.revision <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository starts adopted_observed, observing, at revision 1';
    END IF;
    IF NOT EXISTS (SELECT FROM operations.operations o
                    WHERE o.operation_id = NEW.created_by_operation_id AND o.kind = 'backup.repository.adopt') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository is adopted by its own operation';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.state = 'retired' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a retired repository record never changes';
  END IF;
  IF (NEW.repository_id, NEW.cluster_id, NEW.layer, NEW.engine, NEW.provider, NEW.endpoint_host, NEW.region,
      NEW.bucket, NEW.prefix, NEW.stanza, NEW.repo_index, NEW.secret_source, NEW.created_at,
      NEW.created_by_operation_id)
     IS DISTINCT FROM
     (OLD.repository_id, OLD.cluster_id, OLD.layer, OLD.engine, OLD.provider, OLD.endpoint_host, OLD.region,
      OLD.bucket, OLD.prefix, OLD.stanza, OLD.repo_index, OLD.secret_source, OLD.created_at,
      OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository keeps its location and engine';
  END IF;
  IF NEW.state = 'retired' THEN
    IF NEW.revision <> OLD.revision + 1 OR NOT EXISTS (
         SELECT FROM operations.operations o
          WHERE o.operation_id = NEW.retired_by_operation_id AND o.kind = 'backup.repository.retire') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository is retired once, by its retirement operation';
    END IF;
    IF EXISTS (SELECT FROM backups.runs r WHERE r.repository_id = OLD.repository_id
                AND r.state IN ('starting', 'running', 'unknown'))
       OR EXISTS (SELECT FROM backups.restores x WHERE x.repository_id = OLD.repository_id
                   AND x.state NOT IN ('discarded', 'promoted')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'a repository with an open run or an undiscarded restore is not retired';
    END IF;
    NEW.retired_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.ownership IS DISTINCT FROM OLD.ownership
     OR NEW.priority IS DISTINCT FROM OLD.priority OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.lock_mode IS DISTINCT FROM OLD.lock_mode OR NEW.cipher IS DISTINCT FROM OLD.cipher
     OR NEW.pinned_engine_version IS DISTINCT FROM OLD.pinned_engine_version
     OR NEW.offline_copy_confirmed_at IS DISTINCT FROM OLD.offline_copy_confirmed_at THEN
    IF NEW.revision <> OLD.revision + 1 OR NOT EXISTS (
         SELECT FROM operations.operations o
          WHERE o.operation_id = NEW.changed_by_operation_id AND o.kind = 'backup.repository.ownership') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository''s declared facts change by an ownership operation, raising its revision';
    END IF;
    IF NEW.ownership IS DISTINCT FROM OLD.ownership
       AND NOT (OLD.ownership = 'adopted_observed' AND NEW.ownership = 'adopted_runs') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'ownership moves only from adopted_observed to adopted_runs';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'an observation does not change the revision';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.repository_guard() FROM PUBLIC;
CREATE TRIGGER repositories_guard BEFORE INSERT OR UPDATE OR DELETE ON backups.repositories
  FOR EACH ROW EXECUTE FUNCTION backups.repository_guard();

-- A policy revision is set by its operation; the previous one is superseded
-- in the same transaction; nothing else changes.
CREATE FUNCTION backups.policy_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NOT EXISTS (SELECT FROM operations.operations o
         WHERE o.operation_id = NEW.operation_id AND o.kind = 'backup.policy.set') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB02', MESSAGE = 'a policy revision starts active, set by its operation';
    END IF;
    IF NEW.revision <> coalesce((SELECT max(p.revision) FROM backups.policies p WHERE p.cluster_id = NEW.cluster_id), 0) + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB02', MESSAGE = 'a policy revision follows the previous one';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.policy_id, NEW.cluster_id, NEW.revision, NEW.body, NEW.operation_id, NEW.created_at)
     IS DISTINCT FROM (OLD.policy_id, OLD.cluster_id, OLD.revision, OLD.body, OLD.operation_id, OLD.created_at)
     OR OLD.state <> 'active' OR NEW.state <> 'superseded' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB02', MESSAGE = 'a policy revision is only superseded';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.policy_guard() FROM PUBLIC;
CREATE TRIGGER policies_guard BEFORE INSERT OR UPDATE ON backups.policies
  FOR EACH ROW EXECUTE FUNCTION backups.policy_guard();

-- An engine run belongs to its operation and its cluster; a finished run
-- never changes again; its identity and binding never change.
CREATE FUNCTION backups.run_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'starting' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a run starts in starting';
    END IF;
    IF NOT EXISTS (SELECT FROM operations.operations o WHERE o.operation_id = NEW.operation_id
                    AND o.kind IN ('backup.run', 'backup.verify', 'restore.drill', 'restore.execute', 'restore.discard')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a run belongs to a backup or restore operation';
    END IF;
    IF NEW.repository_id IS NOT NULL AND NOT EXISTS (SELECT FROM backups.repositories r
         WHERE r.repository_id = NEW.repository_id AND r.cluster_id = NEW.cluster_id AND r.state <> 'retired') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a run uses a live repository of its cluster';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.run_id, NEW.cluster_id, NEW.repository_id, NEW.node_id, NEW.purpose, NEW.kind, NEW.operation_id, NEW.created_at)
     IS DISTINCT FROM (OLD.run_id, OLD.cluster_id, OLD.repository_id, OLD.node_id, OLD.purpose, OLD.kind,
                       OLD.operation_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a run keeps its identity';
  END IF;
  IF OLD.start_job_id IS NOT NULL AND (NEW.start_job_id, NEW.start_args_hash) IS DISTINCT FROM (OLD.start_job_id, OLD.start_args_hash) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a run keeps the job that started it';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'canceled', 'lost') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB03', MESSAGE = 'a finished run never changes';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.run_guard() FROM PUBLIC;
CREATE TRIGGER runs_guard BEFORE INSERT OR UPDATE ON backups.runs
  FOR EACH ROW EXECUTE FUNCTION backups.run_guard();

-- The mirror keeps what an engine listed: a verification is recorded only
-- from a succeeded verify run of the same repository, an entry is never
-- moved to another repository or renamed.
CREATE FUNCTION backups.catalog_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.backup_id, NEW.repository_id, NEW.engine_label, NEW.kind, NEW.started_at, NEW.first_seen_at)
     IS DISTINCT FROM (OLD.backup_id, OLD.repository_id, OLD.engine_label, OLD.kind, OLD.started_at, OLD.first_seen_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB04', MESSAGE = 'a catalog entry keeps its identity';
  END IF;
  IF NEW.verification_state <> 'pending'
     AND (TG_OP = 'INSERT' OR NEW.verification_run_id IS DISTINCT FROM OLD.verification_run_id)
     AND NOT EXISTS (SELECT FROM backups.runs r WHERE r.run_id = NEW.verification_run_id
                      AND r.repository_id = NEW.repository_id AND r.purpose = 'verify'
                      AND r.state IN ('succeeded', 'failed')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB04', MESSAGE = 'a verification comes from a finished verify run of the repository';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.first_seen_at := clock_timestamp();
    NEW.last_seen_at := NEW.first_seen_at;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.catalog_guard() FROM PUBLIC;
CREATE TRIGGER catalog_guard BEFORE INSERT OR UPDATE ON backups.catalog
  FOR EACH ROW EXECUTE FUNCTION backups.catalog_guard();

-- A restore belongs to its plan's kind; a discarded or promoted restore never changes.
CREATE FUNCTION backups.restore_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' OR NOT EXISTS (SELECT FROM operations.plans p WHERE p.plan_id = NEW.plan_id
         AND p.kind IN ('restore.drill', 'restore.execute')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB05', MESSAGE = 'a restore starts planned, from a drill or restore plan';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.restore_id, NEW.cluster_id, NEW.target_id, NEW.purpose, NEW.repository_id, NEW.backup_id,
      NEW.point_in_time, NEW.destination_kind, NEW.node_id, NEW.plan_id, NEW.created_at)
     IS DISTINCT FROM (OLD.restore_id, OLD.cluster_id, OLD.target_id, OLD.purpose, OLD.repository_id,
      OLD.backup_id, OLD.point_in_time, OLD.destination_kind, OLD.node_id, OLD.plan_id, OLD.created_at)
     OR OLD.state IN ('discarded', 'promoted') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB05', MESSAGE = 'a restore keeps its source and destination and ends once';
  END IF;
  IF NEW.state = 'promoted' THEN
    -- a placement move promotes a recovery; it does not exist in this bundle
    RAISE EXCEPTION USING ERRCODE = 'EXB05', MESSAGE = 'no operation promotes a restore yet';
  END IF;
  IF NEW.state = 'discarded' THEN
    NEW.discarded_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.restore_guard() FROM PUBLIC;
CREATE TRIGGER restores_guard BEFORE INSERT OR UPDATE ON backups.restores
  FOR EACH ROW EXECUTE FUNCTION backups.restore_guard();

-- A drill outcome is set once; an offline drill is recorded by a person (the worker writes it for them).
CREATE FUNCTION backups.drill_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.mode = 'control_plane' AND NEW.outcome <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB06', MESSAGE = 'a drill run by ExponetDB starts pending';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.drill_id, NEW.cluster_id, NEW.restore_id, NEW.repository_id, NEW.selection, NEW.mode,
      NEW.runbook_digest, NEW.notes, NEW.recorded_by, NEW.created_at)
     IS DISTINCT FROM (OLD.drill_id, OLD.cluster_id, OLD.restore_id, OLD.repository_id, OLD.selection, OLD.mode,
      OLD.runbook_digest, OLD.notes, OLD.recorded_by, OLD.created_at)
     OR OLD.outcome <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB06', MESSAGE = 'a drill keeps its identity and gets its outcome once';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.drill_guard() FROM PUBLIC;
CREATE TRIGGER drills_guard BEFORE INSERT OR UPDATE ON backups.drills
  FOR EACH ROW EXECUTE FUNCTION backups.drill_guard();

-- History is never deleted.
CREATE TRIGGER policies_no_delete BEFORE DELETE ON backups.policies FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER runs_no_delete BEFORE DELETE ON backups.runs FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER catalog_no_delete BEFORE DELETE ON backups.catalog FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER wal_coverage_no_delete BEFORE DELETE ON backups.wal_coverage FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER reconciliations_append_only BEFORE UPDATE OR DELETE ON backups.reconciliations FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER restores_no_delete BEFORE DELETE ON backups.restores FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER drills_no_delete BEFORE DELETE ON backups.drills FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER repositories_no_truncate BEFORE TRUNCATE ON backups.repositories FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER policies_no_truncate BEFORE TRUNCATE ON backups.policies FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER runs_no_truncate BEFORE TRUNCATE ON backups.runs FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER catalog_no_truncate BEFORE TRUNCATE ON backups.catalog FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER wal_coverage_no_truncate BEFORE TRUNCATE ON backups.wal_coverage FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER reconciliations_no_truncate BEFORE TRUNCATE ON backups.reconciliations FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER restores_no_truncate BEFORE TRUNCATE ON backups.restores FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER drills_no_truncate BEFORE TRUNCATE ON backups.drills FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- ----- retirement (registry.md §4.4): backup obligations block a cluster's retirement -----
-- Additive, on the frozen registry.clusters: a cluster is not retired while
-- a repository of it is not retired, a run is open or a restore is not
-- discarded. Repository inserts lock the cluster row FOR SHARE (the guard
-- above), so a concurrent adoption and retirement serialize.
CREATE FUNCTION backups.cluster_backup_obligations() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.state = 'retired' AND OLD.state IS DISTINCT FROM 'retired' THEN
    IF EXISTS (SELECT FROM backups.repositories r WHERE r.cluster_id = OLD.cluster_id AND r.state <> 'retired') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB07', MESSAGE = 'a cluster with a backup repository that is not retired is not retired';
    END IF;
    IF EXISTS (SELECT FROM backups.runs r WHERE r.cluster_id = OLD.cluster_id AND r.state IN ('starting', 'running', 'unknown')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB07', MESSAGE = 'a cluster with an engine run that is not over is not retired';
    END IF;
    IF EXISTS (SELECT FROM backups.restores x WHERE x.cluster_id = OLD.cluster_id AND x.state NOT IN ('discarded', 'promoted')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB07', MESSAGE = 'a cluster with a restore that is not discarded is not retired';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION backups.cluster_backup_obligations() FROM PUBLIC;
CREATE TRIGGER clusters_backup_obligations BEFORE UPDATE OF state ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION backups.cluster_backup_obligations();

-- ----- privileges: the worker writes as operations and reconciliations; serve reads -----
GRANT SELECT ON ALL TABLES IN SCHEMA backups TO exdb_serve, exdb_worker;
GRANT INSERT ON backups.repositories, backups.policies, backups.runs, backups.catalog, backups.reconciliations,
  backups.restores, backups.drills, backups.wal_coverage TO exdb_worker;
GRANT UPDATE (ownership, priority, purpose, lock_mode, lock_capability, lock_retention_days, cipher,
  offline_copy_confirmed_at, pinned_engine_version, observed_engine_version, engine_advisory, state, revision,
  observed, observed_at, reconciled_at, reconciliation_outcome, reconciliation_error, changed_by_operation_id,
  retired_at, retired_by_operation_id) ON backups.repositories TO exdb_worker;
GRANT UPDATE (state) ON backups.policies TO exdb_worker;
GRANT UPDATE (start_job_id, start_args_hash, state, started_at, finished_at, last_status_at, exit_code, progress,
  outcome, error_code) ON backups.runs TO exdb_worker;
GRANT UPDATE (state, finished_at, size_bytes, repository_size_bytes, lsn_start, lsn_stop, timeline, pg_major,
  system_identifier, engine_version, verification_state, verified_at, verification_run_id, divergence,
  missing_since, last_seen_at) ON backups.catalog TO exdb_worker;
GRANT UPDATE (min_segment, max_segment, max_archived_at, gaps, observed_at) ON backups.wal_coverage TO exdb_worker;
GRANT UPDATE (state, timeline, wal_from, wal_to, run_id, port, phases, checks, operation_id, finished_at,
  discarded_at) ON backups.restores TO exdb_worker;
GRANT UPDATE (outcome, measured_rto_seconds, started_at, finished_at) ON backups.drills TO exdb_worker;
