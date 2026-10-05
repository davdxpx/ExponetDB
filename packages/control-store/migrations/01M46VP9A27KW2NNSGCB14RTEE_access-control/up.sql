-- Role-based access control (authorization.md §3, Wave 3A). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- * Roles list their permissions explicitly. There is no wildcard and no
--   rule that derives a role's permissions from the catalog: a permission
--   added to the catalog is held by no role until a later bundle inserts
--   its row (and the release's code lists it; the server refuses to start
--   when the stored matrix differs from the code).
-- * Role bindings change only through planned operations executed by the
--   worker (access.role_binding.create/delete); serve can read them and can
--   create exactly one binding ever: the first owner's, through
--   auth.activate_bootstrap_owner, which refuses once an active owner
--   exists.
-- * At least one active owner must remain: revoking the last active
--   owner's binding or deactivating the last active owner is refused
--   (EXU06), serialized by a transaction advisory lock, so two concurrent
--   removals cannot both see "the other owner remains".
CREATE TABLE auth.roles (
  role_id    text        PRIMARY KEY CHECK (role_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  title      text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 64),
  built_in   boolean     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO auth.roles (role_id, title, built_in) SELECT r, t, true FROM (VALUES
  ('owner', 'Owner'),
  ('admin', 'Admin'),
  ('operator', 'Operator'),
  ('developer', 'Developer'),
  ('viewer', 'Viewer'),
  ('auditor', 'Auditor')) AS v (r, t);

CREATE TABLE auth.role_permissions (
  role_id    text NOT NULL REFERENCES auth.roles (role_id) ON DELETE RESTRICT,
  permission text NOT NULL CONSTRAINT role_permissions_catalog CHECK (permission IN (
                                     'targets.read',
                                     'schema.read',
                                     'schema.manage',
                                     'diagnostics.read',
                                     'diagnostics.read_sensitive',
                                     'data.read',
                                     'data.read_sensitive',
                                     'migrations.read',
                                     'migrations.plan',
                                     'migrations.apply',
                                     'migrations.import',
                                     'connections.operate',
                                     'backups.read',
                                     'backups.run',
                                     'restore.plan',
                                     'restore.execute',
                                     'nodes.read',
                                     'nodes.plan',
                                     'nodes.operate',
                                     'plans.approve',
                                     'operations.recover',
                                     'breakglass.activate',
                                     'audit.read',
                                     'registry.manage',
                                     'access.read',
                                     'access.manage',
                                     'policy.manage')),
  PRIMARY KEY (role_id, permission)
);
INSERT INTO auth.role_permissions (role_id, permission) VALUES
  ('owner', 'targets.read'),
  ('owner', 'schema.read'),
  ('owner', 'schema.manage'),
  ('owner', 'diagnostics.read'),
  ('owner', 'diagnostics.read_sensitive'),
  ('owner', 'data.read'),
  ('owner', 'data.read_sensitive'),
  ('owner', 'migrations.read'),
  ('owner', 'migrations.plan'),
  ('owner', 'migrations.apply'),
  ('owner', 'migrations.import'),
  ('owner', 'connections.operate'),
  ('owner', 'backups.read'),
  ('owner', 'backups.run'),
  ('owner', 'restore.plan'),
  ('owner', 'restore.execute'),
  ('owner', 'nodes.read'),
  ('owner', 'nodes.plan'),
  ('owner', 'nodes.operate'),
  ('owner', 'plans.approve'),
  ('owner', 'operations.recover'),
  ('owner', 'breakglass.activate'),
  ('owner', 'audit.read'),
  ('owner', 'registry.manage'),
  ('owner', 'access.read'),
  ('owner', 'access.manage'),
  ('owner', 'policy.manage'),
  ('admin', 'targets.read'),
  ('admin', 'schema.read'),
  ('admin', 'schema.manage'),
  ('admin', 'diagnostics.read'),
  ('admin', 'diagnostics.read_sensitive'),
  ('admin', 'data.read'),
  ('admin', 'data.read_sensitive'),
  ('admin', 'migrations.read'),
  ('admin', 'migrations.plan'),
  ('admin', 'migrations.apply'),
  ('admin', 'migrations.import'),
  ('admin', 'connections.operate'),
  ('admin', 'backups.read'),
  ('admin', 'backups.run'),
  ('admin', 'restore.plan'),
  ('admin', 'restore.execute'),
  ('admin', 'nodes.read'),
  ('admin', 'nodes.plan'),
  ('admin', 'nodes.operate'),
  ('admin', 'plans.approve'),
  ('admin', 'operations.recover'),
  ('admin', 'audit.read'),
  ('admin', 'registry.manage'),
  ('admin', 'access.read'),
  ('admin', 'access.manage'),
  ('admin', 'policy.manage'),
  ('operator', 'targets.read'),
  ('operator', 'schema.read'),
  ('operator', 'diagnostics.read'),
  ('operator', 'migrations.read'),
  ('operator', 'migrations.plan'),
  ('operator', 'migrations.apply'),
  ('operator', 'connections.operate'),
  ('operator', 'backups.read'),
  ('operator', 'backups.run'),
  ('operator', 'restore.plan'),
  ('operator', 'nodes.read'),
  ('operator', 'nodes.plan'),
  ('operator', 'nodes.operate'),
  ('operator', 'plans.approve'),
  ('operator', 'operations.recover'),
  ('operator', 'audit.read'),
  ('developer', 'targets.read'),
  ('developer', 'schema.read'),
  ('developer', 'diagnostics.read'),
  ('developer', 'data.read'),
  ('developer', 'migrations.read'),
  ('developer', 'migrations.plan'),
  ('developer', 'migrations.apply'),
  ('developer', 'backups.read'),
  ('developer', 'nodes.read'),
  ('viewer', 'targets.read'),
  ('viewer', 'schema.read'),
  ('viewer', 'diagnostics.read'),
  ('viewer', 'migrations.read'),
  ('viewer', 'backups.read'),
  ('viewer', 'nodes.read'),
  ('auditor', 'audit.read'),
  ('auditor', 'access.read'),
  ('auditor', 'targets.read'),
  ('auditor', 'schema.read'),
  ('auditor', 'diagnostics.read'),
  ('auditor', 'migrations.read'),
  ('auditor', 'backups.read'),
  ('auditor', 'nodes.read');

CREATE TRIGGER roles_append_only BEFORE UPDATE OR DELETE ON auth.roles
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER roles_no_truncate BEFORE TRUNCATE ON auth.roles
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER role_permissions_append_only BEFORE UPDATE OR DELETE ON auth.role_permissions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER role_permissions_no_truncate BEFORE TRUNCATE ON auth.role_permissions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Role bindings (authorization.md §3): identity, role, scope. Coverage is
-- structural and computed by packages/auth; scope ids are typed entity
-- ids, never patterns. The owner role is bound only globally.
CREATE TABLE auth.role_bindings (
  binding_id              text        PRIMARY KEY CHECK (binding_id ~ '^rlb_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id             text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  role_id                 text        NOT NULL REFERENCES auth.roles (role_id) ON DELETE RESTRICT,
  scope_kind              text        NOT NULL CHECK (scope_kind IN ('global', 'product', 'project', 'environment', 'target')),
  scope_id                text,
  state                   text        NOT NULL CHECK (state IN ('active', 'revoked')),
  origin                  text        NOT NULL CHECK (origin IN ('operation', 'bootstrap')),
  created_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL,
  revoked_at              timestamptz,
  revoke_reason           text        CHECK (revoke_reason IS NULL OR revoke_reason IN ('operation', 'identity_erased')),
  revoked_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CHECK (
    (scope_kind = 'global' AND scope_id IS NULL)
    OR (scope_kind = 'product' AND scope_id ~ '^prd_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'project' AND scope_id ~ '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'environment' AND scope_id ~ '^env_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    OR (scope_kind = 'target' AND scope_id ~ '^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  ),
  CONSTRAINT role_bindings_owner_global CHECK (role_id <> 'owner' OR scope_kind = 'global'),
  CHECK ((origin = 'operation') = (created_by_operation_id IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CHECK ((revoke_reason = 'operation') = (revoked_by_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX role_bindings_one_active ON auth.role_bindings (identity_id, role_id, scope_kind, coalesce(scope_id, ''))
  WHERE state = 'active';
CREATE INDEX role_bindings_active_by_identity ON auth.role_bindings (identity_id) WHERE state = 'active';
CREATE INDEX role_bindings_active_owners ON auth.role_bindings (identity_id) WHERE state = 'active' AND role_id = 'owner';

CREATE FUNCTION auth.role_binding_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.revoked_at IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU06', MESSAGE = 'a role binding starts active';
    END IF;
    -- Only the first-owner activation (running as the schema owner) creates
    -- a binding outside an operation.
    IF NEW.origin = 'bootstrap' AND current_user <> 'exdb_migrate' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU06', MESSAGE = 'a binding without an operation comes only from the first-owner activation';
    END IF;
    IF EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.identity_id AND i.state IN ('disabled', 'erased')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU06', MESSAGE = 'a role is bound only to an invited or active identity';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.binding_id, NEW.identity_id, NEW.role_id, NEW.scope_kind, NEW.scope_id, NEW.origin,
      NEW.created_by_operation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.binding_id, OLD.identity_id, OLD.role_id, OLD.scope_kind, OLD.scope_id, OLD.origin,
      OLD.created_by_operation_id, OLD.created_at)
     OR OLD.state <> 'active' OR NEW.state <> 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU06', MESSAGE = 'a role binding is revoked once and never changes otherwise';
  END IF;
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.role_binding_guard() FROM PUBLIC;
CREATE TRIGGER role_bindings_guard BEFORE INSERT OR UPDATE ON auth.role_bindings
  FOR EACH ROW EXECUTE FUNCTION auth.role_binding_guard();
CREATE TRIGGER role_bindings_no_delete BEFORE DELETE ON auth.role_bindings
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER role_bindings_no_truncate BEFORE TRUNCATE ON auth.role_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Every binding change advances the identity's authorization revision
-- (plans bind to it; a change between plan and apply makes the plan stale).
CREATE FUNCTION auth.role_binding_revision() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE auth.identities SET authz_revision = authz_revision + 1
   WHERE identity_id = NEW.identity_id AND state <> 'erased';
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION auth.role_binding_revision() FROM PUBLIC;
CREATE TRIGGER role_bindings_revision AFTER INSERT OR UPDATE ON auth.role_bindings
  FOR EACH ROW EXECUTE FUNCTION auth.role_binding_revision();

-- Active owners: an active identity with an active global owner binding.
CREATE FUNCTION auth.active_owner_count() RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT count(DISTINCT b.identity_id)
    FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
   WHERE b.state = 'active' AND b.role_id = 'owner' AND b.scope_kind = 'global' AND i.state = 'active'
$fn$;
REVOKE ALL ON FUNCTION auth.active_owner_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.active_owner_count() TO exdb_serve, exdb_worker;

-- The last-owner invariant. The lock (EXDB, h("control-store/owner-invariant"))
-- serializes every change that can remove an owner; after waiting for it,
-- the count runs on a fresh snapshot (volatile function, read committed),
-- so it sees the other transaction's committed removal.
CREATE FUNCTION auth.owner_invariant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  remaining bigint;
BEGIN
  IF TG_TABLE_NAME = 'identities' THEN
    IF NOT EXISTS (SELECT FROM auth.role_bindings b
                    WHERE b.identity_id = OLD.identity_id AND b.role_id = 'owner' AND b.state = 'active') THEN
      RETURN NULL;
    END IF;
  ELSIF NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = OLD.identity_id AND i.state = 'active') THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(1163412546, 1792970966);
  SELECT count(DISTINCT b.identity_id) INTO remaining
    FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
   WHERE b.state = 'active' AND b.role_id = 'owner' AND b.scope_kind = 'global' AND i.state = 'active';
  IF remaining = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU06', MESSAGE = 'the change would leave no active owner';
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION auth.owner_invariant() FROM PUBLIC;
CREATE TRIGGER role_bindings_owner_invariant AFTER UPDATE ON auth.role_bindings
  FOR EACH ROW WHEN (OLD.role_id = 'owner' AND OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION auth.owner_invariant();
CREATE TRIGGER identities_owner_invariant AFTER UPDATE OF state ON auth.identities
  FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION auth.owner_invariant();

-- The first owner (bootstrap.md §3): the only binding serve ever creates.
-- Precondition, checked here under the owner lock: no active owner exists,
-- the identity is the pending bootstrap identity, its setup link was
-- redeemed, and passkey, password, TOTP and ten unused recovery codes are
-- in place. Afterwards the function refuses forever, because an active
-- owner exists and the last one can never be removed.
CREATE FUNCTION auth.activate_bootstrap_owner(p_identity_id text, p_binding_id text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  candidate auth.identities%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(1163412546, 1792970966);
  IF (SELECT count(*) FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
       WHERE b.state = 'active' AND b.role_id = 'owner' AND i.state = 'active') > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU07', MESSAGE = 'an active owner exists; the bootstrap is closed';
  END IF;
  SELECT * INTO candidate FROM auth.identities i WHERE i.identity_id = p_identity_id FOR UPDATE;
  IF NOT FOUND OR NOT candidate.bootstrap OR candidate.state <> 'invited' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU07', MESSAGE = 'not the pending bootstrap identity';
  END IF;
  IF NOT EXISTS (SELECT FROM auth.capabilities c
                  WHERE c.identity_id = p_identity_id AND c.kind = 'setup' AND c.redeemed_at IS NOT NULL)
     OR NOT EXISTS (SELECT FROM auth.factors f WHERE f.identity_id = p_identity_id AND f.kind = 'passkey' AND f.state = 'active')
     OR NOT EXISTS (SELECT FROM auth.factors f WHERE f.identity_id = p_identity_id AND f.kind = 'password' AND f.state = 'active')
     OR NOT EXISTS (SELECT FROM auth.factors f WHERE f.identity_id = p_identity_id AND f.kind = 'totp' AND f.state = 'active')
     OR (SELECT count(*) FROM auth.recovery_codes r JOIN auth.factors f USING (factor_id)
          WHERE f.identity_id = p_identity_id AND f.kind = 'recovery_codes' AND f.state = 'active'
            AND r.used_at IS NULL) <> 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU07', MESSAGE = 'the first-owner setup is incomplete';
  END IF;
  UPDATE auth.identities SET state = 'active' WHERE identity_id = p_identity_id;
  INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin)
  VALUES (p_binding_id, p_identity_id, 'owner', 'global', NULL, 'active', 'bootstrap');
END
$fn$;
REVOKE ALL ON FUNCTION auth.activate_bootstrap_owner(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.activate_bootstrap_owner(text, text) TO exdb_serve;

GRANT SELECT ON auth.roles, auth.role_permissions, auth.role_bindings TO exdb_serve, exdb_worker;
GRANT INSERT ON auth.role_bindings TO exdb_worker;
GRANT UPDATE (state, revoked_at, revoke_reason, revoked_by_operation_id) ON auth.role_bindings TO exdb_worker;
