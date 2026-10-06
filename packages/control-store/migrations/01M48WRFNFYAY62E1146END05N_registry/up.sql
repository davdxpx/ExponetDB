-- The target registry (registry.md, domain-model.md §3, Wave 4). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- Rules carried by this schema (the database enforces them whatever the
-- caller does; packages/registry enforces them first and gives the errors):
-- * ids are typed (prefix and canonical ULID); slugs are lowercase, unique
--   in their parent and never change;
-- * every row is created by an operation (its id is recorded) except a
--   credential, which serve records from the write-only submission; nothing
--   is deleted, history stays;
-- * a target's path is product/project/environment slugs, never changed and
--   never reused (a decommissioned target keeps it); its tier is its environment's; its
--   generation only grows; its state moves registered → active ⇄ suspended
--   → decommissioned (terminal) or registered → decommissioned;
-- * a target has at most one current placement, a database is the current
--   placement of at most one target, and a placement only ends;
-- * an environment's evidence source is in the same product and never forms
--   a cycle; an environment's tier does not change while a live target uses
--   it;
-- * a cluster's system identifier is pinned once (pending → active);
-- * a network endpoint names the TLS server name its certificate must carry
--   (for a DNS host the host itself); endpoints are only retired, never
--   changed;
-- * a credential points at one secret version of its own cluster and role
--   and never at another; pending → active | failed, active → retired; at
--   most one pending and one active per cluster and role; serve only records
--   a submission and supersedes the pending one, activation is the worker's
--   after a verified login.
CREATE SCHEMA registry AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA registry FROM PUBLIC;
GRANT USAGE ON SCHEMA registry TO exdb_serve, exdb_worker;

CREATE TABLE registry.products (
  product_id              text        PRIMARY KEY CHECK (product_id ~ '^prd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  slug                    text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,38}$'),
  display_name            text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
                                                      AND display_name !~ '[[:cntrl:]]'),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT
);

CREATE TABLE registry.environments (
  environment_id          text        PRIMARY KEY CHECK (environment_id ~ '^env_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  product_id              text        NOT NULL REFERENCES registry.products (product_id) ON DELETE RESTRICT,
  slug                    text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,38}$'),
  display_name            text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
                                                      AND display_name !~ '[[:cntrl:]]'),
  tier                    text        NOT NULL CHECK (tier IN ('prod', 'nonprod')),
  evidence_from           text        REFERENCES registry.environments (environment_id) ON DELETE RESTRICT,
  rank                    integer     NOT NULL DEFAULT 0 CHECK (rank BETWEEN 0 AND 1000),
  revision                integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  updated_at              timestamptz,
  updated_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  UNIQUE (product_id, slug),
  CHECK (evidence_from IS DISTINCT FROM environment_id)
);

CREATE TABLE registry.projects (
  project_id              text        PRIMARY KEY CHECK (project_id ~ '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  product_id              text        NOT NULL REFERENCES registry.products (product_id) ON DELETE RESTRICT,
  slug                    text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,38}$'),
  display_name            text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
                                                      AND display_name !~ '[[:cntrl:]]'),
  -- {"includeSchemas"?: [..], "excludeSchemas": [..]} (schema-fingerprints.md §2)
  managed_scope           jsonb       NOT NULL CHECK (jsonb_typeof(managed_scope) = 'object'
                                                      AND jsonb_typeof(managed_scope -> 'excludeSchemas') = 'array'
                                                      AND (NOT managed_scope ? 'includeSchemas'
                                                           OR jsonb_typeof(managed_scope -> 'includeSchemas') = 'array')
                                                      AND managed_scope - 'includeSchemas' - 'excludeSchemas' = '{}'::jsonb),
  -- environment slug → "none": an explicit, audited absence of an evidence target (I-9)
  evidence_override       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_override) = 'object'),
  revision                integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  updated_at              timestamptz,
  updated_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  UNIQUE (product_id, slug)
);

CREATE TABLE registry.servers (
  server_id               text        PRIMARY KEY CHECK (server_id ~ '^srv_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  display_name            text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
                                                      AND display_name !~ '[[:cntrl:]]'),
  provider                text        NOT NULL CHECK (provider IN ('hetzner_cloud', 'hetzner_robot', 'other', 'unknown')),
  provider_ref            text        CHECK (char_length(provider_ref) BETWEEN 1 AND 128 AND provider_ref !~ '[[:cntrl:]]'),
  location                text        CHECK (char_length(location) BETWEEN 1 AND 64 AND location !~ '[[:cntrl:]]'),
  labels                  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT
);

CREATE TABLE registry.clusters (
  cluster_id                text        PRIMARY KEY CHECK (cluster_id ~ '^cls_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  server_id                 text        REFERENCES registry.servers (server_id) ON DELETE RESTRICT,
  management_mode           text        NOT NULL CHECK (management_mode IN ('external', 'agent')),
  display_name              text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120
                                                        AND display_name !~ '[[:cntrl:]]'),
  state                     text        NOT NULL CHECK (state IN ('pending', 'active', 'retired')),
  system_identifier         text        CHECK (system_identifier ~ '^[0-9]{1,20}$'),
  server_version_num        integer     CHECK (server_version_num BETWEEN 160000 AND 999999),
  -- PEM bundle of the CA that signs the cluster's server certificates (not secret, never returned by an API).
  ca_bundle                 text        NOT NULL CHECK (char_length(ca_bundle) <= 65536
                                                        AND ca_bundle LIKE '%-----BEGIN CERTIFICATE-----%'),
  created_at                timestamptz NOT NULL,
  created_by_operation_id   text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  confirmed_at              timestamptz,
  confirmed_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CHECK ((state = 'pending') = (system_identifier IS NULL)),
  CHECK ((system_identifier IS NULL) = (confirmed_at IS NULL)),
  CHECK (management_mode = 'external' OR server_id IS NOT NULL)
);
-- One live cluster per PostgreSQL system identifier, registry-wide.
CREATE UNIQUE INDEX clusters_one_live_identifier ON registry.clusters (system_identifier)
  WHERE state <> 'retired' AND system_identifier IS NOT NULL;

CREATE TABLE registry.endpoints (
  endpoint_id             text        PRIMARY KEY CHECK (endpoint_id ~ '^end_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id              text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  kind                    text        NOT NULL CHECK (kind IN ('private', 'public', 'local_socket', 'pooler')),
  pooler_mode             text        CHECK (pooler_mode IN ('session', 'transaction')),
  host                    text        NOT NULL CHECK (char_length(host) BETWEEN 1 AND 253
                                                      AND host ~ '^[A-Za-z0-9.:-]+$'),
  port                    integer     NOT NULL CHECK (port BETWEEN 1 AND 65535),
  tls_server_name         text        NOT NULL CHECK (char_length(tls_server_name) BETWEEN 1 AND 253
                                                      AND tls_server_name ~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
                                                      AND tls_server_name !~ '^[0-9.]+$'),
  label                   text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]'),
  state                   text        NOT NULL CHECK (state IN ('active', 'retired')),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  retired_at              timestamptz,
  retired_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CHECK ((kind = 'pooler') = (pooler_mode IS NOT NULL)),
  -- A DNS host is the name the certificate is checked against; an IP host names it explicitly.
  CHECK (host ~ '^[0-9.]+$' OR host ~ ':' OR lower(host) = lower(tls_server_name)),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
-- An address names one cluster, registry-wide.
CREATE UNIQUE INDEX endpoints_one_active_address ON registry.endpoints (lower(host), port)
  WHERE state = 'active';

CREATE TABLE registry.databases (
  database_id             text        PRIMARY KEY CHECK (database_id ~ '^dbs_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id              text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  name                    text        NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 63 AND name !~ '[[:cntrl:]]'),
  state                   text        NOT NULL CHECK (state IN ('registered', 'retired')),
  observed_oid            bigint      CHECK (observed_oid > 0),
  observed_owner          text,
  observed_encoding       text,
  observed_collation      text,
  observed_at             timestamptz,
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX databases_one_registered_name ON registry.databases (cluster_id, name)
  WHERE state = 'registered';

CREATE TABLE registry.targets (
  target_id                     text        PRIMARY KEY CHECK (target_id ~ '^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  project_id                    text        NOT NULL REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  environment_id                text        NOT NULL REFERENCES registry.environments (environment_id) ON DELETE RESTRICT,
  path                          text        NOT NULL CHECK (path ~ '^[a-z][a-z0-9-]{0,38}/[a-z][a-z0-9-]{0,38}/[a-z][a-z0-9-]{0,38}$'),
  tier                          text        NOT NULL CHECK (tier IN ('prod', 'nonprod')),
  generation                    integer     NOT NULL CHECK (generation >= 1),
  state                         text        NOT NULL CHECK (state IN ('registered', 'active', 'suspended', 'decommissioned')),
  -- target-scoped settings (maintenance windows, data-read setting); policy reads them in later waves
  settings                      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at                    timestamptz NOT NULL,
  created_by_operation_id       text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  state_changed_at              timestamptz NOT NULL,
  state_changed_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  state_reason                  text        CHECK (state_reason ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE UNIQUE INDEX targets_one_live_path ON registry.targets (path) WHERE state <> 'decommissioned';
CREATE UNIQUE INDEX targets_one_live_pair ON registry.targets (project_id, environment_id) WHERE state <> 'decommissioned';
CREATE INDEX targets_by_environment ON registry.targets (environment_id);

CREATE TABLE registry.placements (
  placement_id          text        PRIMARY KEY CHECK (placement_id ~ '^plc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id             text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  database_id           text        NOT NULL REFERENCES registry.databases (database_id) ON DELETE RESTRICT,
  generation            integer     NOT NULL CHECK (generation >= 1),
  reason                text        NOT NULL CHECK (reason IN ('initial', 'move', 'restore', 'recreate')),
  valid_from            timestamptz NOT NULL,
  valid_to              timestamptz,
  operation_id          text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ended_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  UNIQUE (target_id, generation),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((valid_to IS NULL) = (ended_by_operation_id IS NULL))
);
-- I-2 and I-3: one current placement per target and per database.
CREATE UNIQUE INDEX placements_one_current_per_target ON registry.placements (target_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX placements_one_current_per_database ON registry.placements (database_id) WHERE valid_to IS NULL;

CREATE TABLE registry.credentials (
  credential_id     text        PRIMARY KEY CHECK (credential_id ~ '^crd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  cluster_id        text        NOT NULL REFERENCES registry.clusters (cluster_id) ON DELETE RESTRICT,
  access_role       text        NOT NULL CHECK (access_role IN ('observer', 'reader', 'verifier', 'operator', 'migrator')),
  -- Role names are API (credentials-and-roles.md §1): exponetdb_<access role>.
  role_name         text        NOT NULL CHECK (role_name = 'exponetdb_' || access_role),
  secret_id         text        NOT NULL,
  secret_version    integer     NOT NULL,
  state             text        NOT NULL CHECK (state IN ('pending', 'active', 'retired', 'failed')),
  submitted_at      timestamptz NOT NULL,
  submitted_by      text        NOT NULL CHECK (submitted_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  verified_at       timestamptz,
  failure_code      text        CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  state_changed_at  timestamptz NOT NULL,
  FOREIGN KEY (secret_id, secret_version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT,
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CHECK (state NOT IN ('active', 'retired') OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX credentials_one_active ON registry.credentials (cluster_id, access_role) WHERE state = 'active';
CREATE UNIQUE INDEX credentials_one_pending ON registry.credentials (cluster_id, access_role) WHERE state = 'pending';
CREATE UNIQUE INDEX credentials_one_row_per_secret_version ON registry.credentials (secret_id, secret_version);

-- ----- guards -----

CREATE FUNCTION registry.product_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'EXG01', MESSAGE = 'a product never changes (its slug is part of every target path)';
END
$fn$;
REVOKE ALL ON FUNCTION registry.product_guard() FROM PUBLIC;
CREATE TRIGGER products_guard BEFORE INSERT OR UPDATE ON registry.products
  FOR EACH ROW EXECUTE FUNCTION registry.product_guard();

CREATE FUNCTION registry.environment_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  hops integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.updated_at IS NOT NULL OR NEW.updated_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG02', MESSAGE = 'an environment starts at revision 1';
    END IF;
    NEW.created_at := clock_timestamp();
  ELSE
    IF (NEW.environment_id, NEW.product_id, NEW.slug, NEW.created_at, NEW.created_by_operation_id)
       IS DISTINCT FROM (OLD.environment_id, OLD.product_id, OLD.slug, OLD.created_at, OLD.created_by_operation_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG02', MESSAGE = 'an environment keeps its id, product and slug';
    END IF;
    IF NEW.revision <> OLD.revision + 1 OR NEW.updated_by_operation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG02', MESSAGE = 'an environment change is an operation and advances the revision by one';
    END IF;
    IF NEW.tier <> OLD.tier AND EXISTS (
         SELECT FROM registry.targets t WHERE t.environment_id = NEW.environment_id AND t.state <> 'decommissioned') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG03', MESSAGE = 'the tier of an environment with live targets does not change (their markers carry it)';
    END IF;
    NEW.updated_at := clock_timestamp();
  END IF;
  IF NEW.evidence_from IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM registry.environments e
                    WHERE e.environment_id = NEW.evidence_from AND e.product_id = NEW.product_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG04', MESSAGE = 'the evidence environment belongs to the same product';
    END IF;
    -- I-8: no cycle through the evidence chain.
    WITH RECURSIVE chain(environment_id, depth) AS (
      SELECT NEW.evidence_from, 1
      UNION ALL
      SELECT e.evidence_from, c.depth + 1
        FROM chain c JOIN registry.environments e ON e.environment_id = c.environment_id
       WHERE e.evidence_from IS NOT NULL AND c.depth < 100
    )
    SELECT count(*) INTO hops FROM chain WHERE environment_id = NEW.environment_id;
    IF hops > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG04', MESSAGE = 'the evidence chain would form a cycle';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.environment_guard() FROM PUBLIC;
CREATE TRIGGER environments_guard BEFORE INSERT OR UPDATE ON registry.environments
  FOR EACH ROW EXECUTE FUNCTION registry.environment_guard();

CREATE FUNCTION registry.project_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.updated_at IS NOT NULL OR NEW.updated_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG05', MESSAGE = 'a project starts at revision 1';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.project_id, NEW.product_id, NEW.slug, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.project_id, OLD.product_id, OLD.slug, OLD.created_at, OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG05', MESSAGE = 'a project keeps its id, product and slug';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_by_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG05', MESSAGE = 'a project change is an operation and advances the revision by one';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.project_guard() FROM PUBLIC;
CREATE TRIGGER projects_guard BEFORE INSERT OR UPDATE ON registry.projects
  FOR EACH ROW EXECUTE FUNCTION registry.project_guard();

CREATE FUNCTION registry.server_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server record does not change in this release';
END
$fn$;
REVOKE ALL ON FUNCTION registry.server_guard() FROM PUBLIC;
CREATE TRIGGER servers_guard BEFORE INSERT OR UPDATE ON registry.servers
  FOR EACH ROW EXECUTE FUNCTION registry.server_guard();

CREATE FUNCTION registry.cluster_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts pending: its identity is pinned by confirmation';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.cluster_id, NEW.server_id, NEW.management_mode, NEW.ca_bundle, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.cluster_id, OLD.server_id, OLD.management_mode, OLD.ca_bundle, OLD.created_at, OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster keeps its id, server, mode and CA bundle';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'active' THEN
    IF NEW.confirmed_by_operation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster is confirmed by an operation';
    END IF;
    NEW.confirmed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.system_identifier IS DISTINCT FROM OLD.system_identifier
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.confirmed_by_operation_id IS DISTINCT FROM OLD.confirmed_by_operation_id THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a system identifier is pinned once and never changes';
  END IF;
  IF NOT (NEW.state = OLD.state OR (OLD.state IN ('pending', 'active') AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster moves pending → active → retired';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.cluster_guard() FROM PUBLIC;
CREATE TRIGGER clusters_guard BEFORE INSERT OR UPDATE ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_guard();

CREATE FUNCTION registry.endpoint_guard() RETURNS trigger
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
      NEW.label, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.endpoint_id, OLD.cluster_id, OLD.kind, OLD.pooler_mode, OLD.host, OLD.port,
      OLD.tls_server_name, OLD.label, OLD.created_at, OLD.created_by_operation_id)
     OR OLD.state <> 'active' OR NEW.state <> 'retired' OR NEW.retired_by_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG08', MESSAGE = 'an endpoint is only retired, by an operation, once';
  END IF;
  NEW.retired_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.endpoint_guard() FROM PUBLIC;
CREATE TRIGGER endpoints_guard BEFORE INSERT OR UPDATE ON registry.endpoints
  FOR EACH ROW EXECUTE FUNCTION registry.endpoint_guard();

CREATE FUNCTION registry.database_guard() RETURNS trigger
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
  IF NEW.state = 'retired' AND OLD.state = 'registered' AND EXISTS (
       SELECT FROM registry.placements p WHERE p.database_id = NEW.database_id AND p.valid_to IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG09', MESSAGE = 'a database that is a current placement is not retired';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.database_guard() FROM PUBLIC;
CREATE TRIGGER databases_guard BEFORE INSERT OR UPDATE ON registry.databases
  FOR EACH ROW EXECUTE FUNCTION registry.database_guard();

CREATE FUNCTION registry.target_guard() RETURNS trigger
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
  IF (NEW.target_id, NEW.project_id, NEW.environment_id, NEW.path, NEW.tier, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.target_id, OLD.project_id, OLD.environment_id, OLD.path, OLD.tier, OLD.created_at,
      OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG10', MESSAGE = 'a target keeps its id, project, environment, path and tier';
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
REVOKE ALL ON FUNCTION registry.target_guard() FROM PUBLIC;
CREATE TRIGGER targets_guard BEFORE INSERT OR UPDATE ON registry.targets
  FOR EACH ROW EXECUTE FUNCTION registry.target_guard();

CREATE FUNCTION registry.placement_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.valid_to IS NOT NULL OR NEW.ended_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG11', MESSAGE = 'a placement starts current';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.targets t
                    WHERE t.target_id = NEW.target_id AND t.generation = NEW.generation AND t.state <> 'decommissioned') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG11', MESSAGE = 'a placement carries its live target''s generation';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.databases d WHERE d.database_id = NEW.database_id AND d.state = 'registered') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG11', MESSAGE = 'a placement binds a registered database';
    END IF;
    NEW.valid_from := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.placement_id, NEW.target_id, NEW.database_id, NEW.generation, NEW.reason, NEW.valid_from, NEW.operation_id)
     IS DISTINCT FROM (OLD.placement_id, OLD.target_id, OLD.database_id, OLD.generation, OLD.reason, OLD.valid_from,
      OLD.operation_id)
     OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.ended_by_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG11', MESSAGE = 'a placement only ends, by an operation, once';
  END IF;
  NEW.valid_to := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.placement_guard() FROM PUBLIC;
CREATE TRIGGER placements_guard BEFORE INSERT OR UPDATE ON registry.placements
  FOR EACH ROW EXECUTE FUNCTION registry.placement_guard();

CREATE FUNCTION registry.credential_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  v_purpose  text;
  v_subject  text;
  v_consumer text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.verified_at IS NOT NULL OR NEW.failure_code IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'a credential starts pending';
    END IF;
    IF NOT EXISTS (SELECT FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id AND c.state <> 'retired') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'a credential belongs to a cluster that is not retired';
    END IF;
    SELECT v.purpose, v.subject_id, v.consumer INTO v_purpose, v_subject, v_consumer
      FROM secrets.secret_versions v WHERE v.secret_id = NEW.secret_id AND v.version = NEW.secret_version;
    -- The secret is this cluster's and this role's; only the observer's is readable by serve.
    IF v_purpose IS DISTINCT FROM 'pg_credential'
       OR v_subject IS DISTINCT FROM NEW.cluster_id || '/' || NEW.role_name
       OR v_consumer IS DISTINCT FROM (CASE WHEN NEW.access_role = 'observer' THEN 'observer' ELSE 'worker' END) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'a credential points at a pg_credential secret of its own cluster, role and consumer';
    END IF;
    NEW.submitted_at := clock_timestamp();
    NEW.state_changed_at := NEW.submitted_at;
    RETURN NEW;
  END IF;
  IF (NEW.credential_id, NEW.cluster_id, NEW.access_role, NEW.role_name, NEW.secret_id, NEW.secret_version,
      NEW.submitted_at, NEW.submitted_by)
     IS DISTINCT FROM (OLD.credential_id, OLD.cluster_id, OLD.access_role, OLD.role_name, OLD.secret_id,
      OLD.secret_version, OLD.submitted_at, OLD.submitted_by) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'a credential keeps its cluster, role and secret';
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('active', 'failed'))
          OR (OLD.state = 'active' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'a credential moves pending → active | failed, active → retired';
  END IF;
  -- serve records submissions only: a new submission supersedes the pending
  -- one; verification and activation are the worker's (credentials-and-roles.md §4).
  IF current_user = 'exdb_serve'
     AND NOT (OLD.state = 'pending' AND NEW.state = 'failed' AND NEW.failure_code = 'superseded') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'serve only supersedes a pending credential; activation is the worker''s';
  END IF;
  IF NEW.state = 'active' THEN
    NEW.verified_at := clock_timestamp();
  ELSIF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG12', MESSAGE = 'only activation records a verification';
  END IF;
  NEW.state_changed_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.credential_guard() FROM PUBLIC;
CREATE TRIGGER credentials_guard BEFORE INSERT OR UPDATE ON registry.credentials
  FOR EACH ROW EXECUTE FUNCTION registry.credential_guard();

-- Nothing in the registry is deleted or truncated.
CREATE TRIGGER products_no_delete BEFORE DELETE ON registry.products FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER environments_no_delete BEFORE DELETE ON registry.environments FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER projects_no_delete BEFORE DELETE ON registry.projects FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER servers_no_delete BEFORE DELETE ON registry.servers FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER clusters_no_delete BEFORE DELETE ON registry.clusters FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER endpoints_no_delete BEFORE DELETE ON registry.endpoints FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER databases_no_delete BEFORE DELETE ON registry.databases FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER targets_no_delete BEFORE DELETE ON registry.targets FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER placements_no_delete BEFORE DELETE ON registry.placements FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER credentials_no_delete BEFORE DELETE ON registry.credentials FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER products_no_truncate BEFORE TRUNCATE ON registry.products FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER environments_no_truncate BEFORE TRUNCATE ON registry.environments FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER projects_no_truncate BEFORE TRUNCATE ON registry.projects FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER servers_no_truncate BEFORE TRUNCATE ON registry.servers FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER clusters_no_truncate BEFORE TRUNCATE ON registry.clusters FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER endpoints_no_truncate BEFORE TRUNCATE ON registry.endpoints FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER databases_no_truncate BEFORE TRUNCATE ON registry.databases FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER targets_no_truncate BEFORE TRUNCATE ON registry.targets FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER placements_no_truncate BEFORE TRUNCATE ON registry.placements FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER credentials_no_truncate BEFORE TRUNCATE ON registry.credentials FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- ----- derived tiers (registry.md §4) -----

-- Cluster tier: the highest tier of the live targets placed on it; NULL while it hosts none.
CREATE VIEW registry.cluster_tiers AS
SELECT c.cluster_id,
       CASE WHEN bool_or(t.tier = 'prod') THEN 'prod'
            WHEN count(t.target_id) > 0 THEN 'nonprod' END AS derived_tier,
       count(t.target_id) AS live_targets
  FROM registry.clusters c
  LEFT JOIN registry.databases d ON d.cluster_id = c.cluster_id
  LEFT JOIN registry.placements p ON p.database_id = d.database_id AND p.valid_to IS NULL
  LEFT JOIN registry.targets t ON t.target_id = p.target_id AND t.state <> 'decommissioned'
 GROUP BY c.cluster_id;

-- Server tier: the highest tier of its clusters.
CREATE VIEW registry.server_tiers AS
SELECT s.server_id,
       CASE WHEN bool_or(ct.derived_tier = 'prod') THEN 'prod'
            WHEN bool_or(ct.derived_tier = 'nonprod') THEN 'nonprod' END AS derived_tier
  FROM registry.servers s
  LEFT JOIN registry.clusters c ON c.server_id = s.server_id
  LEFT JOIN registry.cluster_tiers ct ON ct.cluster_id = c.cluster_id
 GROUP BY s.server_id;

-- ----- privileges -----
-- serve reads the registry and records a credential submission (write-only
-- secret first, in the same transaction); every other change is an
-- operation executed by the worker.
GRANT SELECT ON ALL TABLES IN SCHEMA registry TO exdb_serve, exdb_worker;
GRANT INSERT ON registry.credentials TO exdb_serve;
GRANT UPDATE (state, failure_code) ON registry.credentials TO exdb_serve;
GRANT INSERT ON registry.products, registry.environments, registry.projects, registry.servers, registry.clusters,
  registry.endpoints, registry.databases, registry.targets, registry.placements TO exdb_worker;
GRANT UPDATE (display_name, tier, evidence_from, rank, revision, updated_at, updated_by_operation_id)
  ON registry.environments TO exdb_worker;
GRANT UPDATE (display_name, managed_scope, evidence_override, revision, updated_at, updated_by_operation_id)
  ON registry.projects TO exdb_worker;
GRANT UPDATE (state, system_identifier, server_version_num, confirmed_at, confirmed_by_operation_id)
  ON registry.clusters TO exdb_worker;
GRANT UPDATE (state, retired_at, retired_by_operation_id) ON registry.endpoints TO exdb_worker;
GRANT UPDATE (state, observed_oid, observed_owner, observed_encoding, observed_collation, observed_at)
  ON registry.databases TO exdb_worker;
GRANT UPDATE (state, generation, state_changed_at, state_changed_by_operation_id, state_reason, settings)
  ON registry.targets TO exdb_worker;
GRANT UPDATE (valid_to, ended_by_operation_id) ON registry.placements TO exdb_worker;
GRANT UPDATE (state, verified_at, failure_code, state_changed_at) ON registry.credentials TO exdb_worker;
