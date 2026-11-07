-- ADR-0036 §4: a person's statement that an offline copy of the repository's key exists is
-- recorded by its own operation, backup.repository.attest_offline_key. Owner: exdb_migrate.
-- The operation is kept beside the time, so the kind verifies exactly its own write.
ALTER TABLE backups.repositories
  ADD COLUMN offline_copy_attested_by_operation_id text
    REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT repositories_offline_copy_attested
    CHECK ((offline_copy_confirmed_at IS NULL) = (offline_copy_attested_by_operation_id IS NULL));
GRANT UPDATE (offline_copy_attested_by_operation_id) ON backups.repositories TO exdb_worker;

-- The guard of the backup-catalog bundle again (same signature, owner and trigger). A row changes
-- by exactly one of four paths:
--   * an ownership change, adopted_observed to adopted_runs, by a new, unfinished
--     backup.repository.ownership operation recorded on no other repository, raising the revision;
--   * a retirement: once, by a backup.repository.retire operation recorded on no other repository,
--     raising the revision, nothing else changing;
--   * an offline key attestation, by a new, unfinished backup.repository.attest_offline_key
--     operation recorded on no other repository, raising the revision, nothing else changing; the
--     time is the database's; never for a retired repository or one whose effective cipher (the
--     observed one when the engine reported it, else the declared one) is none; never taken back;
--   * an observation, by the worker's catalog refresh without an operation: only the observation
--     columns, all of them together with reconciled_at moving forward (never later than now), and
--     state only to active on an ok reconciliation or to degraded on a failed one.
-- The other declared facts (priority, purpose, lock, cipher, pinned engine version) keep what the
-- adoption recorded. A repository starts unattested. Nothing is deleted.
CREATE OR REPLACE FUNCTION backups.repository_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  cluster_state text;
  declared_changed boolean;
  observation_changed boolean;
  attestation_changed boolean;
  effective_cipher text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a backup repository record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT c.state INTO cluster_state FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id FOR SHARE;
    IF cluster_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository is adopted for an active cluster';
    END IF;
    IF NEW.ownership <> 'adopted_observed' OR NEW.state <> 'observing' OR NEW.revision <> 1
       OR NEW.changed_by_operation_id IS NOT NULL OR NEW.reconciled_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'a repository starts adopted_observed, observing, unreconciled, at revision 1';
    END IF;
    IF NEW.offline_copy_confirmed_at IS NOT NULL OR NEW.offline_copy_attested_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'a repository starts unattested; its offline key copy is attested by its own operation';
    END IF;
    IF NOT EXISTS (SELECT FROM operations.operations o
                    WHERE o.operation_id = NEW.created_by_operation_id AND o.kind = 'backup.repository.adopt')
       OR EXISTS (SELECT FROM backups.repositories r WHERE r.created_by_operation_id = NEW.created_by_operation_id) THEN
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
  IF (NEW.priority, NEW.purpose, NEW.lock_mode, NEW.lock_capability, NEW.lock_retention_days, NEW.cipher,
      NEW.pinned_engine_version)
     IS DISTINCT FROM
     (OLD.priority, OLD.purpose, OLD.lock_mode, OLD.lock_capability, OLD.lock_retention_days, OLD.cipher,
      OLD.pinned_engine_version) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01',
      MESSAGE = 'a repository''s declared facts change by no operation of this bundle';
  END IF;
  declared_changed := (NEW.ownership, NEW.changed_by_operation_id) IS DISTINCT FROM (OLD.ownership, OLD.changed_by_operation_id);
  observation_changed := (NEW.observed, NEW.observed_at, NEW.reconciled_at, NEW.reconciliation_outcome,
                          NEW.reconciliation_error, NEW.observed_engine_version, NEW.engine_advisory)
                         IS DISTINCT FROM
                         (OLD.observed, OLD.observed_at, OLD.reconciled_at, OLD.reconciliation_outcome,
                          OLD.reconciliation_error, OLD.observed_engine_version, OLD.engine_advisory);
  attestation_changed := (NEW.offline_copy_confirmed_at, NEW.offline_copy_attested_by_operation_id)
                         IS DISTINCT FROM
                         (OLD.offline_copy_confirmed_at, OLD.offline_copy_attested_by_operation_id);

  IF NEW.state = 'retired' THEN
    IF declared_changed OR observation_changed OR attestation_changed THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a retirement changes nothing but the retirement';
    END IF;
    IF NEW.revision <> OLD.revision + 1 OR NOT EXISTS (
         SELECT FROM operations.operations o
          WHERE o.operation_id = NEW.retired_by_operation_id AND o.kind = 'backup.repository.retire')
       OR EXISTS (SELECT FROM backups.repositories r WHERE r.retired_by_operation_id = NEW.retired_by_operation_id
                   AND r.repository_id <> OLD.repository_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'a repository is retired once, by its own retirement operation';
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

  IF attestation_changed THEN
    IF declared_changed OR observation_changed OR NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'an offline key attestation changes nothing but the attestation';
    END IF;
    IF NEW.revision <> OLD.revision + 1
       OR NEW.offline_copy_attested_by_operation_id IS NULL
       OR NEW.offline_copy_attested_by_operation_id IS NOT DISTINCT FROM OLD.offline_copy_attested_by_operation_id
       OR NOT EXISTS (SELECT FROM operations.operations o
                       WHERE o.operation_id = NEW.offline_copy_attested_by_operation_id
                         AND o.kind = 'backup.repository.attest_offline_key'
                         AND o.state IN ('queued', 'running', 'verifying', 'needs_reconciliation', 'needs_attention'))
       OR EXISTS (SELECT FROM backups.repositories r
                   WHERE r.repository_id <> OLD.repository_id
                     AND NEW.offline_copy_attested_by_operation_id IN (r.created_by_operation_id, r.changed_by_operation_id,
                                                                       r.retired_by_operation_id,
                                                                       r.offline_copy_attested_by_operation_id)) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'an offline key copy is attested by its own, new attestation operation, raising the revision';
    END IF;
    -- What the engine said wins over what a person declared (as the protection state reads it).
    effective_cipher := CASE WHEN NEW.observed -> 'stanza' ->> 'cipher' IN ('aes-256-cbc', 'none')
                             THEN NEW.observed -> 'stanza' ->> 'cipher' ELSE NEW.cipher END;
    IF effective_cipher = 'none' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'an unencrypted repository has no key to attest';
    END IF;
    NEW.offline_copy_confirmed_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF declared_changed THEN
    IF observation_changed OR NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'an ownership change changes nothing but the ownership';
    END IF;
    IF NOT (OLD.ownership = 'adopted_observed' AND NEW.ownership = 'adopted_runs') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'ownership moves only from adopted_observed to adopted_runs';
    END IF;
    IF NEW.revision <> OLD.revision + 1
       OR NEW.changed_by_operation_id IS NULL
       OR NEW.changed_by_operation_id IS NOT DISTINCT FROM OLD.changed_by_operation_id
       OR NOT EXISTS (SELECT FROM operations.operations o
                       WHERE o.operation_id = NEW.changed_by_operation_id AND o.kind = 'backup.repository.ownership'
                         AND o.state IN ('queued', 'running', 'verifying', 'needs_reconciliation', 'needs_attention'))
       OR EXISTS (SELECT FROM backups.repositories r
                   WHERE r.repository_id <> OLD.repository_id
                     AND NEW.changed_by_operation_id IN (r.changed_by_operation_id, r.created_by_operation_id,
                                                         r.retired_by_operation_id,
                                                         r.offline_copy_attested_by_operation_id)) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'an ownership change is made by its own, new ownership operation, raising the revision';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB01', MESSAGE = 'an observation does not change the revision';
  END IF;
  IF observation_changed OR NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.reconciled_at IS NULL
       OR NEW.reconciled_at <= coalesce(OLD.reconciled_at, '-infinity'::timestamptz)
       OR NEW.reconciled_at > clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'an observation is recorded by a reconciliation, its time moving forward and never later than now';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT ((NEW.state = 'active' AND NEW.reconciliation_outcome = 'ok')
             OR (NEW.state = 'degraded' AND NEW.reconciliation_outcome = 'failed')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXB01',
        MESSAGE = 'a repository becomes active by an ok reconciliation or degraded by a failed one';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
