-- VC-006, VC-055, VC-007: a person's force release of an operation in needs_attention
-- (operations-engine.md §4.1). Owner: exdb_migrate. serve records the request; the worker
-- claims the operation and closes it under its lease. A request is never deleted; at most one
-- is open per operation. In the recovery schema, next to the verification retries.
CREATE TABLE recovery.force_releases (
  release_id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id             text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  requested_by_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  asserted_outcome         text        NOT NULL CHECK (asserted_outcome IN ('applied', 'not_applied', 'unknown')),
  reason                   text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  requested_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at               timestamptz,
  CHECK (started_at IS NULL OR started_at >= requested_at)
);
CREATE UNIQUE INDEX force_releases_open ON recovery.force_releases (operation_id)
  WHERE started_at IS NULL;

-- Only the start is ever recorded, once; nothing else changes and nothing is removed.
CREATE FUNCTION recovery.force_releases_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.started_at IS NOT NULL OR NEW.started_at IS NULL
     OR (NEW.release_id, NEW.operation_id, NEW.requested_by_identity_id, NEW.asserted_outcome,
         NEW.reason, NEW.requested_at)
        IS DISTINCT FROM
        (OLD.release_id, OLD.operation_id, OLD.requested_by_identity_id, OLD.asserted_outcome,
         OLD.reason, OLD.requested_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO13', MESSAGE = 'a force release only records its start, once';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION recovery.force_releases_guard() FROM PUBLIC;
CREATE TRIGGER force_releases_guard BEFORE UPDATE ON recovery.force_releases
  FOR EACH ROW EXECUTE FUNCTION recovery.force_releases_guard();
CREATE TRIGGER force_releases_no_delete BEFORE DELETE ON recovery.force_releases
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER force_releases_no_truncate BEFORE TRUNCATE ON recovery.force_releases
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT, INSERT ON recovery.force_releases TO exdb_serve;
GRANT SELECT, UPDATE (started_at) ON recovery.force_releases TO exdb_worker;

-- The edge of a force release of a change the person found not applied: its own pure function,
-- as the supersession edge is (operations.recovery_transition_allowed and its verify.sql stay as
-- they are; operations.transition_allowed of the frozen operations bundle keeps its 15 pairs).
CREATE FUNCTION operations.release_transition_allowed(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT (p_from, p_to) = ('needs_attention', 'failed')
$fn$;
REVOKE ALL ON FUNCTION operations.release_transition_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations.release_transition_allowed(text, text) TO exdb_serve, exdb_worker;

-- The guard of the operation-supersession bundle, unchanged except for the one more condition.
CREATE OR REPLACE FUNCTION operations.operation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('awaiting_approval', 'queued')
       OR NOT operations.state_admits(NEW.state, NEW.apply_outcome, NEW.verification_outcome)
       OR NEW.lease_owner IS NOT NULL OR NEW.attempt <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'an operation starts awaiting approval or queued, unleased';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.operation_id, NEW.plan_id, NEW.kind, NEW.kind_version, NEW.actor_kind, NEW.actor_id,
      NEW.client_kind, NEW.client_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.operation_id, OLD.plan_id, OLD.kind, OLD.kind_version, OLD.actor_kind, OLD.actor_id,
      OLD.client_kind, OLD.client_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'operation identity is immutable';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'verification_failed', 'canceled') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a finished operation never changes';
  END IF;
  IF NEW.state <> OLD.state AND NOT (operations.transition_allowed(OLD.state, NEW.state)
                                     OR operations.recovery_transition_allowed(OLD.state, NEW.state)
                                     OR operations.release_transition_allowed(OLD.state, NEW.state)) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'operation state transition not allowed';
  END IF;
  IF NOT operations.state_admits(NEW.state, NEW.apply_outcome, NEW.verification_outcome) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'outcomes do not match the operation state';
  END IF;
  IF NEW.state IN ('succeeded', 'failed', 'verification_failed', 'canceled') AND NEW.lease_owner IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a finished operation holds no lease';
  END IF;
  IF NEW.state IN ('running', 'verifying', 'needs_reconciliation') AND NEW.lease_owner IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a working operation needs a lease';
  END IF;
  -- serve decides approvals and cancellations before execution; everything
  -- from execution on belongs to the worker.
  IF current_user = 'exdb_serve'
     AND NOT (OLD.state IN ('awaiting_approval', 'queued') AND NEW.state IN ('queued', 'canceled')
              AND OLD.lease_owner IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO02', MESSAGE = 'serve may only approve or cancel an operation that has not started';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

-- The claim and the approval-window task read operations in needs_attention and awaiting_approval
-- every few seconds; operations_claimable covers only the working states.
CREATE INDEX operations_waiting ON operations.operations (state, created_at, operation_id)
  WHERE state IN ('needs_attention', 'awaiting_approval');
