-- Policy configuration (policy-engine.md §5). Owner: exdb_migrate. Never set
-- by environment variables (P-12); changed only by a planned, audited
-- operation (access.policy_settings.update, Wave 3A), which the worker
-- executes. Rows are revisions: a change appends, nothing is overwritten.
CREATE SCHEMA policy AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA policy FROM PUBLIC;
GRANT USAGE ON SCHEMA policy TO exdb_serve, exdb_worker;

CREATE TABLE policy.rule_settings (
  scope_kind   text        NOT NULL CHECK (scope_kind IN ('installation', 'product', 'project', 'environment', 'target')),
  scope_id     text        NOT NULL,
  rule_id      text        NOT NULL CHECK (char_length(rule_id) <= 128
                                           AND rule_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9-]+)+$'),
  revision     integer     NOT NULL CHECK (revision >= 1),
  params       jsonb       NOT NULL CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 16384),
  operation_id text        CHECK (operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by   text        NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, rule_id, revision),
  CHECK (
    (scope_kind = 'installation' AND scope_id = 'installation')
    OR (scope_kind = 'product' AND scope_id ~ '^prd_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'project' AND scope_id ~ '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'environment' AND scope_id ~ '^env_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'target' AND scope_id ~ '^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  )
);

-- Revisions follow each other per scope and rule; the database records who
-- wrote them.
CREATE FUNCTION policy.revision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  latest integer;
BEGIN
  SELECT max(s.revision) INTO latest FROM policy.rule_settings s
   WHERE s.scope_kind = NEW.scope_kind AND s.scope_id = NEW.scope_id AND s.rule_id = NEW.rule_id;
  IF NEW.revision <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXP01', MESSAGE = 'a policy setting revision must follow the latest';
  END IF;
  NEW.created_by := current_user;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION policy.revision_guard() FROM PUBLIC;
CREATE TRIGGER rule_settings_revision BEFORE INSERT ON policy.rule_settings
  FOR EACH ROW EXECUTE FUNCTION policy.revision_guard();
CREATE TRIGGER rule_settings_append_only BEFORE UPDATE OR DELETE ON policy.rule_settings
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER rule_settings_no_truncate BEFORE TRUNCATE ON policy.rule_settings
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON policy.rule_settings TO exdb_serve, exdb_worker;
GRANT INSERT ON policy.rule_settings TO exdb_worker;
