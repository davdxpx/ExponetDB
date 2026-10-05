-- Approvals (operations-engine.md §6, OD-9). Owner: exdb_migrate. Nothing
-- is granted to PUBLIC. An approval is evidence: written once by serve
-- (the Web App), never changed or deleted.
--
-- The database checks, whatever serve claims (EXR01):
-- * the operation awaits approval and belongs to the plan; the plan hash is
--   the plan's current hash (an outdated view cannot approve);
-- * the approver is an active human identity, deciding through one of its
--   own live Web App sessions, with a re-authentication of that session
--   at most 300 seconds old;
-- * one decision per approver and operation;
-- * `self_approval` is computed here: the approver is the plan's actor and
--   the plan came from a human client (web or cli). An agent-initiated
--   plan approved by the person behind the agent is not a self-approval
--   (OD-9). Time and not-before come from the database clock; the cooling
--   length itself is the policy parameter serve evaluated, recorded here.
CREATE SCHEMA approvals AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA approvals FROM PUBLIC;
GRANT USAGE ON SCHEMA approvals TO exdb_serve, exdb_worker;

CREATE TABLE approvals.plan_approvals (
  approval_id          text        PRIMARY KEY CHECK (approval_id ~ '^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  operation_id         text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  plan_id              text        NOT NULL REFERENCES operations.plans (plan_id) ON DELETE RESTRICT,
  plan_hash            text        NOT NULL CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  approver_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  approver_session_id  text        NOT NULL REFERENCES auth.web_sessions (session_id) ON DELETE RESTRICT,
  approver_client      text        NOT NULL CHECK (approver_client = 'web'),
  decision             text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  self_approval        boolean     NOT NULL,
  reauth_event_id      text        NOT NULL REFERENCES auth.reauth_events (reauth_event_id) ON DELETE RESTRICT,
  cooling_seconds      integer     NOT NULL CHECK (cooling_seconds BETWEEN 0 AND 86400),
  policy_version       text        NOT NULL CHECK (policy_version ~ '^sha256:pv1:[0-9a-f]{64}$'),
  decided_at           timestamptz NOT NULL,
  not_before           timestamptz NOT NULL,
  UNIQUE (operation_id, approver_identity_id),
  CHECK (not_before = decided_at + make_interval(secs => cooling_seconds)),
  CHECK (decision = 'approved' OR cooling_seconds = 0)
);
CREATE INDEX plan_approvals_by_operation ON approvals.plan_approvals (operation_id);

CREATE FUNCTION approvals.approval_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  op_state text;
  op_plan text;
  hash text;
  actor_id text;
  actor_kind text;
  actor_client text;
  proof timestamptz;
BEGIN
  SELECT o.state, o.plan_id INTO op_state, op_plan FROM operations.operations o
   WHERE o.operation_id = NEW.operation_id FOR SHARE;
  IF op_state IS DISTINCT FROM 'awaiting_approval' OR op_plan IS DISTINCT FROM NEW.plan_id THEN
    RAISE EXCEPTION USING ERRCODE = 'EXR01', MESSAGE = 'the operation does not await approval of this plan';
  END IF;
  SELECT p.plan_hash, p.actor_id, p.actor_kind, p.client_kind INTO hash, actor_id, actor_kind, actor_client
    FROM operations.plans p WHERE p.plan_id = NEW.plan_id;
  IF hash IS DISTINCT FROM NEW.plan_hash THEN
    RAISE EXCEPTION USING ERRCODE = 'EXR01', MESSAGE = 'the approval names another plan hash than the plan''s';
  END IF;
  IF NOT EXISTS (SELECT FROM auth.identities i
                  WHERE i.identity_id = NEW.approver_identity_id AND i.kind = 'human' AND i.state = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXR01', MESSAGE = 'the approver is an active human';
  END IF;
  IF NOT EXISTS (SELECT FROM auth.web_sessions s
                  WHERE s.session_id = NEW.approver_session_id AND s.identity_id = NEW.approver_identity_id
                    AND s.revoked_at IS NULL AND s.assurance = 'full'
                    AND s.absolute_expires_at > clock_timestamp()
                    AND s.last_seen_at + interval '30 minutes' > clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXR01', MESSAGE = 'the approver decides through an own live Web App session';
  END IF;
  SELECT r.occurred_at INTO proof FROM auth.reauth_events r
   WHERE r.reauth_event_id = NEW.reauth_event_id AND r.identity_id = NEW.approver_identity_id
     AND (r.session_id = NEW.approver_session_id OR r.session_id IS NULL)
     AND r.method IN ('passkey', 'totp');
  IF proof IS NULL OR proof < clock_timestamp() - interval '300 seconds' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXR01', MESSAGE = 'an approval needs a passkey or TOTP re-authentication of at most 300 seconds';
  END IF;
  NEW.self_approval := (actor_kind = 'human' AND actor_id = NEW.approver_identity_id AND actor_client IN ('web', 'cli'));
  NEW.decided_at := clock_timestamp();
  NEW.not_before := NEW.decided_at + make_interval(secs => NEW.cooling_seconds);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION approvals.approval_guard() FROM PUBLIC;
CREATE TRIGGER plan_approvals_guard BEFORE INSERT ON approvals.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION approvals.approval_guard();
CREATE TRIGGER plan_approvals_append_only BEFORE UPDATE OR DELETE ON approvals.plan_approvals
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER plan_approvals_no_truncate BEFORE TRUNCATE ON approvals.plan_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT, INSERT ON approvals.plan_approvals TO exdb_serve;
GRANT SELECT ON approvals.plan_approvals TO exdb_worker;
