-- CLI step-ups (ADR-0026). Owner: exdb_migrate. A schema of its own, like
-- breakglass. serve creates a step-up for a person's CLI grant, confirms it
-- for the same person's Web App session after a fresh re-authentication,
-- and redeems the receipt in the transaction of the bound request. A row
-- keeps no secret: the user code is stored as a hash. The binding (identity,
-- client, grant, action, object) never changes; the state only moves
-- forward: pending -> confirmed -> redeemed, or to expired, refused or
-- canceled.
CREATE SCHEMA stepup AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA stepup FROM PUBLIC;
GRANT USAGE ON SCHEMA stepup TO exdb_serve;

CREATE TABLE stepup.step_ups (
  step_up_id          text        PRIMARY KEY CHECK (step_up_id ~ '^stu_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id         text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  client_id           text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  grant_id            text        NOT NULL REFERENCES oauth.grants (grant_id) ON DELETE RESTRICT,
  action              text        NOT NULL CHECK (action IN ('plan.apply', 'node.enrollment_token.reveal')),
  plan_id             text        CHECK (plan_id ~ '^pln_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  plan_hash           text        CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  token_id            text        CHECK (token_id ~ '^ent_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  binding_digest      text        NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  user_code_hash      text        NOT NULL CHECK (user_code_hash ~ '^sha256:[0-9a-f]{64}$'),
  state               text        NOT NULL DEFAULT 'pending'
                                  CHECK (state IN ('pending', 'confirmed', 'redeemed', 'expired', 'refused', 'canceled')),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at          timestamptz NOT NULL,
  confirmed_at        timestamptz,
  confirmed_session   text,
  reauth_at           timestamptz,
  reauth_method       text        CHECK (reauth_method IN ('passkey', 'totp')),
  receipt_expires_at  timestamptz,
  redeemed_at         timestamptz,
  refused_reason      text        CHECK (refused_reason IN ('code_attempts', 'grant_revoked')),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((action = 'plan.apply') = (plan_id IS NOT NULL AND plan_hash IS NOT NULL)),
  CHECK ((action = 'node.enrollment_token.reveal') = (token_id IS NOT NULL)),
  CHECK ((confirmed_at IS NULL) = (reauth_at IS NULL)
         AND (confirmed_at IS NULL) = (reauth_method IS NULL)
         AND (confirmed_at IS NULL) = (confirmed_session IS NULL)
         AND (confirmed_at IS NULL) = (receipt_expires_at IS NULL)),
  CHECK (receipt_expires_at IS NULL OR receipt_expires_at <= confirmed_at + interval '120 seconds'),
  CHECK (state NOT IN ('confirmed', 'redeemed') OR confirmed_at IS NOT NULL),
  CHECK ((state = 'redeemed') = (redeemed_at IS NOT NULL)),
  CHECK ((state = 'refused') = (refused_reason IS NOT NULL))
);
CREATE INDEX step_ups_by_identity ON stepup.step_ups (identity_id, created_at);
CREATE INDEX step_ups_by_grant ON stepup.step_ups (grant_id) WHERE state IN ('pending', 'confirmed');

-- The binding never changes; the state moves forward only; a confirmation,
-- a redemption and a refusal happen once.
CREATE FUNCTION stepup.step_ups_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'step-ups are never deleted' USING ERRCODE = 'EXO12';
  END IF;
  IF (NEW.step_up_id, NEW.identity_id, NEW.client_id, NEW.grant_id, NEW.action, NEW.plan_id, NEW.plan_hash,
      NEW.token_id, NEW.binding_digest, NEW.user_code_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.step_up_id, OLD.identity_id, OLD.client_id, OLD.grant_id, OLD.action, OLD.plan_id, OLD.plan_hash,
      OLD.token_id, OLD.binding_digest, OLD.user_code_hash, OLD.created_at, OLD.expires_at)
     OR NEW.attempts < OLD.attempts
     OR (OLD.confirmed_at IS NOT NULL
         AND (NEW.confirmed_at, NEW.confirmed_session, NEW.reauth_at, NEW.reauth_method, NEW.receipt_expires_at)
             IS DISTINCT FROM
             (OLD.confirmed_at, OLD.confirmed_session, OLD.reauth_at, OLD.reauth_method, OLD.receipt_expires_at))
     OR (OLD.state <> NEW.state AND NOT (
           (OLD.state = 'pending' AND NEW.state IN ('confirmed', 'expired', 'refused', 'canceled'))
        OR (OLD.state = 'confirmed' AND NEW.state IN ('redeemed', 'expired', 'refused', 'canceled'))))
     OR (OLD.state IN ('redeemed', 'expired', 'refused', 'canceled') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'a step-up keeps its binding and only moves forward' USING ERRCODE = 'EXO12';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION stepup.step_ups_guard() FROM PUBLIC;
CREATE TRIGGER step_ups_guard BEFORE UPDATE OR DELETE ON stepup.step_ups
  FOR EACH ROW EXECUTE FUNCTION stepup.step_ups_guard();
CREATE TRIGGER step_ups_no_truncate BEFORE TRUNCATE ON stepup.step_ups
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT, INSERT ON stepup.step_ups TO exdb_serve;
GRANT UPDATE (state, attempts, confirmed_at, confirmed_session, reauth_at, reauth_method, receipt_expires_at,
              redeemed_at, refused_reason) ON stepup.step_ups TO exdb_serve;
