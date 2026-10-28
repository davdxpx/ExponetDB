-- TC-005 (MIG-01): the one new edge of the operation state machine,
-- needs_attention -> verification_failed (operations-engine.md §4.1). Owner: exdb_migrate.
--
-- operations.transition_allowed is the frozen list of the operations bundle (its verify.sql
-- counts exactly 15 pairs) and stays as it is. The recovery edge is its own pure function,
-- and the guard accepts a transition either function allows. packages/operations
-- (states.ts) lists every edge; the engine test compares both functions with it for every input.
CREATE FUNCTION operations.recovery_transition_allowed(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT (p_from, p_to) = ('needs_attention', 'verification_failed')
$fn$;
REVOKE ALL ON FUNCTION operations.recovery_transition_allowed(text, text) FROM PUBLIC;
-- The guard runs as the invoking login, which therefore needs to execute it.
GRANT EXECUTE ON FUNCTION operations.recovery_transition_allowed(text, text) TO exdb_serve, exdb_worker;

-- The guard of the operations bundle, unchanged except for the one condition on transitions.
-- CREATE OR REPLACE keeps its owner, its REVOKE and the trigger that calls it.
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
                                     OR operations.recovery_transition_allowed(OLD.state, NEW.state)) THEN
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
