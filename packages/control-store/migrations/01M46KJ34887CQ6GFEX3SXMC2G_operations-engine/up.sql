-- Operations Engine (operations-engine.md). Owner: exdb_migrate. The state
-- machine lives in packages/operations and, as a second line of defense, in
-- the triggers below: an invalid transition or outcome fails in the
-- database whatever the caller does (EXO01).
CREATE SCHEMA operations AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA operations FROM PUBLIC;
GRANT USAGE ON SCHEMA operations TO exdb_serve, exdb_worker;

-- Plans (§3): binding members are immutable; only the state moves, once,
-- out of `active`. A plan whose policy decision is deny exists as `denied`.
CREATE TABLE operations.plans (
  plan_id          text        PRIMARY KEY CHECK (plan_id ~ '^pln_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind             text        NOT NULL CHECK (char_length(kind) <= 64 AND kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  kind_version     integer     NOT NULL CHECK (kind_version >= 1),
  action_class     text        NOT NULL CHECK (action_class IN ('low', 'standard', 'high', 'critical')),
  state            text        NOT NULL CHECK (state IN ('active', 'consumed', 'expired', 'invalidated', 'denied', 'withdrawn')),
  decision         text        NOT NULL CHECK (decision IN ('allow', 'require', 'deny')),
  plan_hash        text        NOT NULL UNIQUE CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_checksum text        NOT NULL CHECK (content_checksum ~ '^sha256:[0-9a-f]{64}$'),
  policy_version   text        NOT NULL CHECK (policy_version ~ '^sha256:pv1:[0-9a-f]{64}$'),
  actor_kind       text        NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id         text        CHECK (actor_id ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  client_kind      text        NOT NULL CHECK (client_kind IN ('web', 'rest', 'mcp', 'cli', 'ci', 'system')),
  client_id        text        CHECK (client_id ~ '^cli_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id        text        CHECK (target_id ~ '^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tier             text        CHECK (tier IN ('prod', 'nonprod')),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 hours'),
  CHECK ((decision = 'deny') = (state = 'denied'))
);
CREATE INDEX plans_active_expiry ON operations.plans (expires_at) WHERE state = 'active';

CREATE FUNCTION operations.plan_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('active', 'denied') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a plan starts active, or denied';
    END IF;
    NEW.state_changed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.plan_id, NEW.kind, NEW.kind_version, NEW.action_class, NEW.decision, NEW.plan_hash,
      NEW.content_checksum, NEW.policy_version, NEW.actor_kind, NEW.actor_id, NEW.client_kind,
      NEW.client_id, NEW.target_id, NEW.tier, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.plan_id, OLD.kind, OLD.kind_version, OLD.action_class, OLD.decision, OLD.plan_hash,
      OLD.content_checksum, OLD.policy_version, OLD.actor_kind, OLD.actor_id, OLD.client_kind,
      OLD.client_id, OLD.target_id, OLD.tier, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'plan bindings are immutable';
  END IF;
  IF OLD.state <> 'active' OR NEW.state NOT IN ('consumed', 'expired', 'invalidated', 'withdrawn') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a plan leaves active once, to a terminal state';
  END IF;
  IF NEW.state = 'expired' AND OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a plan expires only after its expiry time';
  END IF;
  NEW.state_changed_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION operations.plan_guard() FROM PUBLIC;
CREATE TRIGGER plans_guard BEFORE INSERT OR UPDATE ON operations.plans
  FOR EACH ROW EXECUTE FUNCTION operations.plan_guard();
CREATE TRIGGER plans_no_delete BEFORE DELETE ON operations.plans
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER plans_no_truncate BEFORE TRUNCATE ON operations.plans
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- The canonical body B of each plan (JCS text): its SHA-256 is the plan hash.
CREATE TABLE operations.plan_bodies (
  plan_id text PRIMARY KEY REFERENCES operations.plans (plan_id) ON DELETE RESTRICT,
  body    text NOT NULL CHECK (octet_length(body) <= 4194304)
);
CREATE FUNCTION operations.plan_body_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM operations.plans p
                  WHERE p.plan_id = NEW.plan_id
                    AND p.plan_hash = 'sha256:' || encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'the plan body does not hash to the plan hash';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION operations.plan_body_guard() FROM PUBLIC;
CREATE TRIGGER plan_bodies_hash BEFORE INSERT ON operations.plan_bodies
  FOR EACH ROW EXECUTE FUNCTION operations.plan_body_guard();
CREATE TRIGGER plan_bodies_append_only BEFORE UPDATE OR DELETE ON operations.plan_bodies
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER plan_bodies_no_truncate BEFORE TRUNCATE ON operations.plan_bodies
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Operations (§4): one per accepted plan (plan_id unique: §5 idempotency).
CREATE TABLE operations.operations (
  operation_id         text        PRIMARY KEY CHECK (operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  plan_id              text        UNIQUE REFERENCES operations.plans (plan_id) ON DELETE RESTRICT,
  kind                 text        NOT NULL CHECK (char_length(kind) <= 64 AND kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  kind_version         integer     NOT NULL CHECK (kind_version >= 1),
  state                text        NOT NULL CHECK (state IN ('awaiting_approval', 'queued', 'running', 'verifying',
                                     'needs_reconciliation', 'needs_attention', 'succeeded', 'failed',
                                     'verification_failed', 'canceled')),
  apply_outcome        text        NOT NULL CHECK (apply_outcome IN ('not_started', 'applied', 'not_applied',
                                     'partially_applied', 'unknown')),
  verification_outcome text        NOT NULL CHECK (verification_outcome IN ('not_applicable', 'pending', 'passed',
                                     'failed', 'partial', 'error')),
  actor_kind           text        NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id             text        CHECK (actor_id ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  client_kind          text        NOT NULL CHECK (client_kind IN ('web', 'rest', 'mcp', 'cli', 'ci', 'system')),
  client_id            text        CHECK (client_id ~ '^cli_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  lease_owner          text        CHECK (lease_owner ~ '^prc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  lease_expires_at     timestamptz,
  attempt              integer     NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX operations_claimable ON operations.operations (created_at, operation_id)
  WHERE state IN ('queued', 'running', 'verifying', 'needs_reconciliation');

-- Allowed transitions (§4.1) and the outcomes each state admits. The same
-- table is in packages/operations (states.ts); both are tested.
CREATE FUNCTION operations.state_admits(p_state text, p_apply text, p_verification text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT CASE p_state
    WHEN 'awaiting_approval'    THEN p_apply = 'not_started' AND p_verification IN ('pending', 'not_applicable')
    WHEN 'queued'               THEN p_apply = 'not_started' AND p_verification IN ('pending', 'not_applicable')
    WHEN 'running'              THEN p_apply = 'not_started' AND p_verification IN ('pending', 'not_applicable')
    WHEN 'verifying'            THEN p_apply IN ('applied', 'partially_applied') AND p_verification = 'pending'
    WHEN 'needs_reconciliation' THEN p_apply = 'unknown' AND p_verification IN ('pending', 'not_applicable')
    WHEN 'needs_attention'      THEN p_apply IN ('applied', 'partially_applied', 'unknown') AND p_verification IN ('pending', 'error')
    WHEN 'succeeded'            THEN p_apply = 'applied' AND p_verification IN ('passed', 'not_applicable')
    WHEN 'failed'               THEN p_apply IN ('not_started', 'not_applied') AND p_verification = 'not_applicable'
    WHEN 'verification_failed'  THEN p_apply IN ('applied', 'partially_applied') AND p_verification IN ('failed', 'partial')
    WHEN 'canceled'             THEN p_apply = 'not_started' AND p_verification = 'not_applicable'
    ELSE false
  END
$fn$;
REVOKE ALL ON FUNCTION operations.state_admits(text, text, text) FROM PUBLIC;

CREATE FUNCTION operations.transition_allowed(p_from text, p_to text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT (p_from, p_to) IN (
    ('awaiting_approval', 'queued'), ('awaiting_approval', 'canceled'),
    ('queued', 'running'), ('queued', 'failed'), ('queued', 'canceled'),
    ('running', 'verifying'), ('running', 'failed'), ('running', 'needs_reconciliation'),
    ('needs_reconciliation', 'verifying'), ('needs_reconciliation', 'failed'),
    ('needs_reconciliation', 'needs_attention'),
    ('verifying', 'succeeded'), ('verifying', 'verification_failed'), ('verifying', 'needs_attention'),
    ('needs_attention', 'verifying'))
$fn$;
REVOKE ALL ON FUNCTION operations.transition_allowed(text, text) FROM PUBLIC;
-- Pure functions: the guard runs as the invoking login, which therefore
-- needs to execute them.
GRANT EXECUTE ON FUNCTION operations.state_admits(text, text, text), operations.transition_allowed(text, text)
  TO exdb_serve, exdb_worker;

CREATE FUNCTION operations.operation_guard() RETURNS trigger
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
  IF NEW.state <> OLD.state AND NOT operations.transition_allowed(OLD.state, NEW.state) THEN
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
REVOKE ALL ON FUNCTION operations.operation_guard() FROM PUBLIC;
CREATE TRIGGER operations_guard BEFORE INSERT OR UPDATE ON operations.operations
  FOR EACH ROW EXECUTE FUNCTION operations.operation_guard();
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations.operations
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER operations_no_truncate BEFORE TRUNCATE ON operations.operations
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Every transition and step (§4.2), append-only.
CREATE TABLE operations.operation_events (
  event_id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind         text        NOT NULL CHECK (kind IN ('created', 'transition', 'lease_acquired', 'lease_taken_over',
                                                    'locks_acquired', 'locks_waiting', 'locks_released',
                                                    'step_started', 'step_finished')),
  from_state   text,
  to_state     text,
  actor        text        NOT NULL DEFAULT current_user,
  detail       jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192)
);
CREATE INDEX operation_events_by_operation ON operations.operation_events (operation_id, event_id);
CREATE TRIGGER operation_events_append_only BEFORE UPDATE OR DELETE ON operations.operation_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER operation_events_no_truncate BEFORE TRUNCATE ON operations.operation_events
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Exclusivity domains (§7): one row per held domain. Only a finished
-- operation's locks can be deleted (row-level security), so there is no
-- shortcut that releases a live operation's lock; force-release is its own
-- planned operation kind (operation.force_release, Wave 6).
CREATE TABLE operations.operation_locks (
  domain_key   text        PRIMARY KEY CHECK (char_length(domain_key) <= 128 AND domain_key ~
                 '^(target:tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}:(schema|maintenance)|cluster:cls_[0-7][0-9A-HJKMNP-TV-Z]{25}:(config|backup)|node:nod_[0-7][0-9A-HJKMNP-TV-Z]{25}:packages)$'),
  operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  acquired_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operation_locks_by_operation ON operations.operation_locks (operation_id);
ALTER TABLE operations.operation_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY locks_read ON operations.operation_locks FOR SELECT TO exdb_serve, exdb_worker USING (true);
CREATE POLICY locks_acquire ON operations.operation_locks FOR INSERT TO exdb_worker
  WITH CHECK (EXISTS (SELECT FROM operations.operations o
                       WHERE o.operation_id = operation_locks.operation_id
                         AND o.state IN ('queued', 'running', 'verifying', 'needs_reconciliation', 'needs_attention')));
CREATE POLICY locks_release ON operations.operation_locks FOR DELETE TO exdb_worker
  USING (EXISTS (SELECT FROM operations.operations o
                  WHERE o.operation_id = operation_locks.operation_id
                    AND o.state IN ('succeeded', 'failed', 'verification_failed', 'canceled')));
CREATE TRIGGER operation_locks_no_update BEFORE UPDATE ON operations.operation_locks
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER operation_locks_no_truncate BEFORE TRUNCATE ON operations.operation_locks
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Idempotency keys (§5.3): per principal, 24 hours, request hash bound.
CREATE TABLE operations.idempotency_keys (
  principal_key text        NOT NULL CHECK (principal_key ~ '^[a-z]+:[A-Za-z0-9_:#-]{1,96}$'),
  idem_key      text        NOT NULL CHECK (idem_key ~ '^[!-~]{1,255}$'),
  request_hash  text        NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  response      jsonb       CHECK (response IS NULL OR octet_length(response::text) <= 65536),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (principal_key, idem_key),
  CHECK (expires_at <= created_at + interval '24 hours')
);
CREATE INDEX idempotency_keys_expiry ON operations.idempotency_keys (expires_at);
ALTER TABLE operations.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idem_serve_all ON operations.idempotency_keys FOR ALL TO exdb_serve
  USING (true) WITH CHECK (true);
CREATE POLICY idem_worker_read ON operations.idempotency_keys FOR SELECT TO exdb_worker USING (true);
CREATE POLICY idem_worker_prune ON operations.idempotency_keys FOR DELETE TO exdb_worker
  USING (expires_at < clock_timestamp());

GRANT SELECT, INSERT ON operations.plans, operations.plan_bodies TO exdb_serve, exdb_worker;
GRANT UPDATE (state, state_changed_at) ON operations.plans TO exdb_serve, exdb_worker;
GRANT SELECT, INSERT ON operations.operations, operations.operation_events TO exdb_serve, exdb_worker;
GRANT UPDATE (state, apply_outcome, verification_outcome, updated_at) ON operations.operations TO exdb_serve;
GRANT UPDATE (state, apply_outcome, verification_outcome, lease_owner, lease_expires_at, attempt, updated_at)
  ON operations.operations TO exdb_worker;
GRANT SELECT ON operations.operation_locks TO exdb_serve;
GRANT SELECT, INSERT, DELETE ON operations.operation_locks TO exdb_worker;
GRANT SELECT, INSERT ON operations.idempotency_keys TO exdb_serve;
GRANT UPDATE (request_hash, response, created_at, completed_at, expires_at) ON operations.idempotency_keys TO exdb_serve;
GRANT SELECT, DELETE ON operations.idempotency_keys TO exdb_worker;
