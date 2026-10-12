-- Break-glass grants (operations-engine.md §8). Owner: exdb_migrate. A schema
-- of its own: the frozen operations bundle pins the objects of its schema.
-- serve records an activation (a person, re-authenticated, with a reason
-- and the named rules), counts a use when a plan made under the grant is
-- accepted and records the review; the worker reads grants when it
-- re-checks a plan's policy before execution. A grant never changes after
-- it was recorded except its use count (up to its maximum), its
-- revocation and its review (each once).
CREATE SCHEMA breakglass AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA breakglass FROM PUBLIC;
GRANT USAGE ON SCHEMA breakglass TO exdb_serve, exdb_worker;

CREATE TABLE breakglass.grants (
  grant_id        text        PRIMARY KEY CHECK (grant_id ~ '^bgl_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id     text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  target_id       text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  rules           text[]      NOT NULL CHECK (cardinality(rules) BETWEEN 1 AND 32),
  reason          text        NOT NULL CHECK (char_length(reason) BETWEEN 20 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL,
  max_uses        integer     CHECK (max_uses BETWEEN 1 AND 100),
  uses            integer     NOT NULL DEFAULT 0 CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses)),
  revoked_at      timestamptz,
  reviewed_at     timestamptz,
  reviewed_by     text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  review_note     text        CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 2000),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 hours'),
  CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL) AND (reviewed_at IS NULL) = (review_note IS NULL))
);
CREATE INDEX grants_by_target ON breakglass.grants (target_id, expires_at);
CREATE INDEX grants_unreviewed ON breakglass.grants (created_at) WHERE reviewed_at IS NULL;

-- Only the use count may grow, and revocation and review happen once.
CREATE FUNCTION breakglass.grants_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'break-glass grants are never deleted' USING ERRCODE = 'EXO11';
  END IF;
  IF (NEW.grant_id, NEW.identity_id, NEW.target_id, NEW.rules, NEW.reason, NEW.created_at, NEW.expires_at, NEW.max_uses)
     IS DISTINCT FROM
     (OLD.grant_id, OLD.identity_id, OLD.target_id, OLD.rules, OLD.reason, OLD.created_at, OLD.expires_at, OLD.max_uses)
     OR NEW.uses < OLD.uses
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at, NEW.reviewed_by, NEW.review_note)
                                         IS DISTINCT FROM (OLD.reviewed_at, OLD.reviewed_by, OLD.review_note)) THEN
    RAISE EXCEPTION 'a break-glass grant changes only its uses, its revocation and its review' USING ERRCODE = 'EXO11';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION breakglass.grants_guard() FROM PUBLIC;
CREATE TRIGGER grants_guard BEFORE UPDATE OR DELETE ON breakglass.grants
  FOR EACH ROW EXECUTE FUNCTION breakglass.grants_guard();
CREATE TRIGGER grants_no_truncate BEFORE TRUNCATE ON breakglass.grants
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON breakglass.grants TO exdb_serve, exdb_worker;
GRANT INSERT ON breakglass.grants TO exdb_serve;
GRANT UPDATE (uses, revoked_at, reviewed_at, reviewed_by, review_note) ON breakglass.grants TO exdb_serve;
