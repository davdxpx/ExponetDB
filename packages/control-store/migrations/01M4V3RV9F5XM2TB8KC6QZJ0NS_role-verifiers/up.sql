-- Role verifiers (owner decision S3, 2026-10-13; credentials-and-roles.md
-- §4). Owner: exdb_migrate. A person submits the SCRAM-SHA-256 verifier of
-- one role of a cluster (never a password); serve seals it with se1 at once
-- (the secret AAD names the row's context id, purpose `pg_role_verifier`
-- and subject `<cluster id>/<verifier id>`) and stores it here. serve may
-- insert a row and supersede a submitted one (which clears it) but reads
-- none of the sealed columns; the worker opens a submitted verifier once,
-- seals it for the node in the apply job of `postgres.roles.verifier.set`
-- and clears it in the same transaction (`consumed`). A cleared row keeps
-- its metadata for the audit trail; nothing is ever deleted. A schema of
-- its own (the frozen secrets bundle pins its tables): only serve and the
-- worker may use it.
CREATE SCHEMA role_verifiers AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA role_verifiers FROM PUBLIC;
GRANT USAGE ON SCHEMA role_verifiers TO exdb_serve, exdb_worker;

CREATE TABLE role_verifiers.verifiers (
  verifier_id      text        PRIMARY KEY CHECK (verifier_id ~ '^rvf_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id       text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  -- A consumer role (credentials-and-roles.md §4): never a predefined role
  -- and never one of ExponetDB's own roles (those go through
  -- credential.rotate or the credential submission).
  role_name        text        NOT NULL CHECK (role_name ~ '^[a-z_][a-z0-9_$-]{0,62}$'
                                               AND role_name !~ '^(pg_|exponetdb_)'),
  state            text        NOT NULL CHECK (state IN ('submitted', 'consumed', 'superseded')),
  -- The se1 context: a `sec_` id that names this sealed value only (no row
  -- in secrets.secret_versions: the value is cleared, never versioned).
  secret_id        text        NOT NULL UNIQUE CHECK (secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  key_id           text        CHECK (key_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  wrap_nonce       bytea       CHECK (octet_length(wrap_nonce) = 12),
  wrapped_key      bytea       CHECK (octet_length(wrapped_key) = 48),
  nonce            bytea       CHECK (octet_length(nonce) = 12),
  ciphertext       bytea       CHECK (octet_length(ciphertext) BETWEEN 17 AND 1040),
  submitted_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_by     text        NOT NULL CHECK (submitted_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation_id     text        CHECK (operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  -- Sealed exactly while submitted; a consumed verifier names its operation.
  CHECK ((state = 'submitted') = (ciphertext IS NOT NULL)),
  CHECK ((key_id IS NULL) = (ciphertext IS NULL) AND (wrap_nonce IS NULL) = (ciphertext IS NULL)
         AND (wrapped_key IS NULL) = (ciphertext IS NULL) AND (nonce IS NULL) = (ciphertext IS NULL)),
  CHECK ((state = 'consumed') = (operation_id IS NOT NULL))
);
-- One submitted verifier per role of a cluster: a new submission supersedes it.
CREATE UNIQUE INDEX verifiers_one_submitted ON role_verifiers.verifiers (cluster_id, role_name)
  WHERE state = 'submitted';

-- A row starts submitted and sealed, with the database's times; it moves
-- once, to consumed (with its operation) or superseded, and is cleared
-- then; its binding (id, cluster, role, context, submitter) never changes.
CREATE FUNCTION role_verifiers.verifiers_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXS03', MESSAGE = 'role verifiers are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'submitted' OR NEW.operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXS03', MESSAGE = 'a role verifier starts submitted';
    END IF;
    NEW.submitted_at := pg_catalog.clock_timestamp();
    NEW.state_changed_at := NEW.submitted_at;
    RETURN NEW;
  END IF;
  IF (NEW.verifier_id, NEW.cluster_id, NEW.role_name, NEW.secret_id, NEW.submitted_at, NEW.submitted_by)
     IS DISTINCT FROM
     (OLD.verifier_id, OLD.cluster_id, OLD.role_name, OLD.secret_id, OLD.submitted_at, OLD.submitted_by)
     OR OLD.state <> 'submitted'
     OR NEW.state NOT IN ('consumed', 'superseded')
     OR NEW.ciphertext IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXS03',
      MESSAGE = 'a role verifier keeps its binding and is cleared once, when it is consumed or superseded';
  END IF;
  NEW.state_changed_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION role_verifiers.verifiers_guard() FROM PUBLIC;
CREATE TRIGGER verifiers_guard BEFORE INSERT OR UPDATE OR DELETE ON role_verifiers.verifiers
  FOR EACH ROW EXECUTE FUNCTION role_verifiers.verifiers_guard();
CREATE TRIGGER verifiers_no_truncate BEFORE TRUNCATE ON role_verifiers.verifiers
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Write-only for serve: it inserts, reads the metadata (to plan and to
-- supersede) and clears a submitted row, but never reads a sealed column.
-- The worker reads what apply needs and clears it. No other role.
GRANT INSERT ON role_verifiers.verifiers TO exdb_serve;
GRANT SELECT (verifier_id, cluster_id, role_name, state, submitted_at, submitted_by, state_changed_at,
              operation_id)
  ON role_verifiers.verifiers TO exdb_serve;
GRANT UPDATE (state, key_id, wrap_nonce, wrapped_key, nonce, ciphertext)
  ON role_verifiers.verifiers TO exdb_serve;
GRANT SELECT ON role_verifiers.verifiers TO exdb_worker;
GRANT UPDATE (state, key_id, wrap_nonce, wrapped_key, nonce, ciphertext, operation_id)
  ON role_verifiers.verifiers TO exdb_worker;
