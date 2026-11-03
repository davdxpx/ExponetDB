-- ADR-0039 §4: a pooler that routes by the login name is reached as exponetdb_<role>.<suffix>.
-- Only a pooler endpoint carries a suffix; like every other endpoint field it never changes.
ALTER TABLE registry.endpoints
  ADD COLUMN login_suffix text CHECK (login_suffix ~ '^[a-z0-9]{1,40}$'),
  ADD CONSTRAINT endpoints_login_suffix_pooler CHECK (login_suffix IS NULL OR kind = 'pooler');

-- ADR-0039 §1: a target is managed (marker, ledger, writes) or observed (read as the observer
-- only, nothing written to its database). The mode is chosen at registration and never changes.
ALTER TABLE registry.targets
  ADD COLUMN mode text NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed', 'observed'));

-- The guards of the registry bundle again, with the new column immutable (endpoint), the mode
-- immutable and an observed target held out of active and suspended (target), and the recorded
-- database oid kept once set (database). Same signatures, owners and triggers; the earlier
-- verify.sql files stay true.
CREATE OR REPLACE FUNCTION registry.endpoint_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG08', MESSAGE = 'an endpoint starts active';
    END IF;
    IF EXISTS (SELECT FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id AND c.state = 'retired') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG08', MESSAGE = 'a retired cluster gets no endpoint';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.endpoint_id, NEW.cluster_id, NEW.kind, NEW.pooler_mode, NEW.host, NEW.port, NEW.tls_server_name,
      NEW.label, NEW.login_suffix, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.endpoint_id, OLD.cluster_id, OLD.kind, OLD.pooler_mode, OLD.host, OLD.port,
      OLD.tls_server_name, OLD.label, OLD.login_suffix, OLD.created_at, OLD.created_by_operation_id)
     OR OLD.state <> 'active' OR NEW.state <> 'retired' OR NEW.retired_by_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG08', MESSAGE = 'an endpoint is only retired, by an operation, once';
  END IF;
  NEW.retired_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION registry.target_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  expected_path text;
  env_tier      text;
BEGIN
  -- FOR SHARE: a concurrent tier change of the environment waits for this
  -- insert (and then sees the live target), never commits beside it.
  SELECT pr.slug || '/' || pj.slug || '/' || e.slug, e.tier
    INTO expected_path, env_tier
    FROM registry.projects pj
    JOIN registry.environments e ON e.environment_id = NEW.environment_id AND e.product_id = pj.product_id
    JOIN registry.products pr ON pr.product_id = pj.product_id
   WHERE pj.project_id = NEW.project_id
     FOR SHARE OF e;
  IF TG_OP = 'INSERT' THEN
    IF expected_path IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'project and environment belong to the same product';
    END IF;
    IF NEW.path <> expected_path OR NEW.tier <> env_tier THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target path is product/project/environment and its tier is the environment''s';
    END IF;
    IF NEW.state <> 'registered' OR NEW.generation <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target starts registered at generation 1';
    END IF;
    -- A path names one logical target forever: a decommissioned target keeps it (C-4).
    IF EXISTS (SELECT FROM registry.targets t WHERE t.path = NEW.path) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target path is never reused';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    NEW.state_changed_by_operation_id := NEW.created_by_operation_id;
    RETURN NEW;
  END IF;
  IF (NEW.target_id, NEW.project_id, NEW.environment_id, NEW.path, NEW.tier, NEW.mode, NEW.created_at,
      NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.target_id, OLD.project_id, OLD.environment_id, OLD.path, OLD.tier, OLD.mode, OLD.created_at,
      OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target keeps its id, project, environment, path, tier and mode';
  END IF;
  -- ADR-0039 §1: an observed target is never written to, so it never becomes active.
  IF NEW.mode = 'observed' AND NEW.state IN ('active', 'suspended') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'an observed target stays registered until it is decommissioned';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target generation only grows';
  END IF;
  IF OLD.state = 'decommissioned' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a decommissioned target never changes';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'registered' AND NEW.state IN ('active', 'decommissioned'))
            OR (OLD.state = 'active' AND NEW.state IN ('suspended', 'decommissioned'))
            OR (OLD.state = 'suspended' AND NEW.state IN ('active', 'decommissioned'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target moves registered → active ⇄ suspended → decommissioned';
    END IF;
    -- Each state change names the operation that made it; the registering
    -- operation itself both records the target and, once verified, activates it.
    IF NEW.state_changed_by_operation_id IS NULL
       OR (NEW.state_changed_by_operation_id IS NOT DISTINCT FROM OLD.state_changed_by_operation_id
           AND NOT (OLD.state = 'registered' AND NEW.state = 'active'
                    AND NEW.state_changed_by_operation_id = OLD.created_by_operation_id)) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target state change names its operation';
    END IF;
    NEW.state_changed_at := clock_timestamp();
  ELSIF (NEW.state_changed_at, NEW.state_changed_by_operation_id, NEW.state_reason)
        IS DISTINCT FROM (OLD.state_changed_at, OLD.state_changed_by_operation_id, OLD.state_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'the state record changes only with the state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION registry.database_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'registered' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database starts registered';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id AND c.state = 'active') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database is registered on a confirmed, active cluster';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.database_id, NEW.cluster_id, NEW.name, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.database_id, OLD.cluster_id, OLD.name, OLD.created_at, OLD.created_by_operation_id)
     OR (OLD.state = 'retired' AND NEW.state <> 'retired') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database keeps its cluster and name; retirement is final';
  END IF;
  -- ADR-0039 §2: the oid recorded at registration is an observed target's identity.
  IF OLD.observed_oid IS NOT NULL AND NEW.observed_oid IS DISTINCT FROM OLD.observed_oid THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database keeps the oid recorded at its registration';
  END IF;
  IF NEW.state = 'retired' AND OLD.state = 'registered' AND EXISTS (
       SELECT FROM registry.placements p WHERE p.database_id = NEW.database_id AND p.valid_to IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database that is a current placement is not retired';
  END IF;
  RETURN NEW;
END
$fn$;
