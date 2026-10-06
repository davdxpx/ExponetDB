-- Delegated authority (oauth.md, identity.md §5, Wave 3B). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- Rules carried by this schema (the database enforces them whatever the
-- caller does; packages/auth enforces them first and gives the errors):
-- * bearer-style secrets (access and refresh tokens, authorization codes,
--   device and user codes, API keys, request handles, assertion ids) are
--   stored as SHA-256 hashes only; client keys are public keys;
-- * every lifetime is computed from the database clock by a trigger, never
--   taken from the caller;
-- * a stored scope is a catalog scope that the client kind may hold: an
--   MCP-ineligible or session-only scope cannot be stored for a client that
--   may not hold it, whatever the caller writes;
-- * one-time things are used once (codes, device codes, refresh tokens,
--   assertion ids); at most one live refresh token exists per grant;
-- * a grant is created only for an active client and an active identity,
--   and a production write or human-only scope only with a re-authentication
--   of that identity at most 5 minutes old;
-- * a client that leaves `active`, and an identity that is disabled or
--   erased, end every grant and API key that depends on them.
CREATE SCHEMA oauth AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA oauth FROM PUBLIC;
GRANT USAGE ON SCHEMA oauth TO exdb_serve, exdb_worker;

-- The scope catalog (authorization.md §4): every scope a token or API key
-- can hold, with the client kinds that may hold it. `api` (Web App session
-- only) and `plans.approve` (Web App only) are absent: no token holds them.
-- A new scope in the code grants nothing until a later bundle adds its row
-- and the release's catalog matches (readiness check `scope_catalog`).
CREATE TABLE oauth.scopes (
  scope         text    PRIMARY KEY CHECK (scope ~ '^[a-z][a-z_]*\.[a-z][a-z_]*(:(prod|nonprod))?$'),
  permission    text    NOT NULL CHECK (permission ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  tier          text    CHECK (tier IN ('prod', 'nonprod')),
  mcp_grantable boolean NOT NULL,
  client_kinds  text[]  NOT NULL CHECK (cardinality(client_kinds) BETWEEN 1 AND 3
                                         AND client_kinds <@ ARRAY['cli', 'mcp', 'ci']),
  human_only    boolean NOT NULL,
  write         boolean NOT NULL,
  CHECK (mcp_grantable = ('mcp' = ANY (client_kinds))),
  CHECK (NOT human_only OR client_kinds = ARRAY['cli']),
  CHECK ((tier IS NULL) = (scope !~ ':'))
);
INSERT INTO oauth.scopes (scope, permission, tier, mcp_grantable, client_kinds, human_only, write) VALUES
  ('targets.read', 'targets.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('schema.read', 'schema.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('diagnostics.read', 'diagnostics.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('data.read:nonprod', 'data.read', 'nonprod', true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('data.read:prod', 'data.read', 'prod', true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('migrations.read', 'migrations.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('migrations.plan', 'migrations.plan', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('migrations.apply:nonprod', 'migrations.apply', 'nonprod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('migrations.apply:prod', 'migrations.apply', 'prod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('connections.operate:nonprod', 'connections.operate', 'nonprod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('connections.operate:prod', 'connections.operate', 'prod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('backups.read', 'backups.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('backups.run', 'backups.run', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('restore.plan', 'restore.plan', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('nodes.read', 'nodes.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('nodes.plan', 'nodes.plan', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('nodes.operate:nonprod', 'nodes.operate', 'nonprod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('nodes.operate:prod', 'nodes.operate', 'prod', true, ARRAY['cli', 'mcp', 'ci'], false, true),
  ('audit.read', 'audit.read', NULL, true, ARRAY['cli', 'mcp', 'ci'], false, false),
  ('registry.manage', 'registry.manage', NULL, false, ARRAY['cli'], true, true),
  ('access.read', 'access.read', NULL, false, ARRAY['cli'], true, false),
  ('access.manage', 'access.manage', NULL, false, ARRAY['cli'], true, true),
  ('policy.manage', 'policy.manage', NULL, false, ARRAY['cli'], true, true),
  ('restore.execute', 'restore.execute', NULL, false, ARRAY['cli'], true, true),
  ('operations.recover', 'operations.recover', NULL, false, ARRAY['cli'], true, true),
  ('breakglass.activate', 'breakglass.activate', NULL, false, ARRAY['cli'], true, true),
  ('diagnostics.read_sensitive', 'diagnostics.read_sensitive', NULL, false, ARRAY['cli'], true, false),
  ('data.read_sensitive', 'data.read_sensitive', NULL, false, ARRAY['cli'], true, false),
  ('migrations.import', 'migrations.import', NULL, false, ARRAY['cli'], true, true),
  ('schema.manage', 'schema.manage', NULL, false, ARRAY['cli'], true, true);
CREATE TRIGGER scopes_append_only BEFORE UPDATE OR DELETE ON oauth.scopes
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER scopes_no_truncate BEFORE TRUNCATE ON oauth.scopes
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- A scope set a client kind may hold: non-empty, no duplicate, catalog
-- scopes only, each holdable by the kind. Volatile on purpose (reads the
-- catalog); used by the guards, never by a CHECK constraint.
CREATE FUNCTION oauth.scopes_holdable(p_scopes text[], p_client_kind text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT p_scopes IS NOT NULL
     AND cardinality(p_scopes) BETWEEN 1 AND 64
     AND cardinality(p_scopes) = (SELECT count(DISTINCT s) FROM unnest(p_scopes) AS s)
     AND NOT EXISTS (
       SELECT FROM unnest(p_scopes) AS s(scope)
        WHERE NOT EXISTS (SELECT FROM oauth.scopes c
                           WHERE c.scope = s.scope AND p_client_kind = ANY (c.client_kinds)))
$fn$;
REVOKE ALL ON FUNCTION oauth.scopes_holdable(text[], text) FROM PUBLIC;

-- Scopes that need a fresh re-authentication to be delegated: production
-- writes and human-only scopes that change something.
CREATE FUNCTION oauth.scopes_need_reauth(p_scopes text[]) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT EXISTS (SELECT FROM oauth.scopes c
                  WHERE c.scope = ANY (p_scopes) AND c.write AND (c.tier = 'prod' OR c.human_only))
$fn$;
REVOKE ALL ON FUNCTION oauth.scopes_need_reauth(text[]) FROM PUBLIC;

-- Every tiered scope's tier is among the restriction's tiers.
CREATE FUNCTION oauth.tiers_cover(p_scopes text[], p_tiers text[]) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT NOT EXISTS (SELECT FROM oauth.scopes c
                      WHERE c.scope = ANY (p_scopes) AND c.tier IS NOT NULL AND NOT (c.tier = ANY (p_tiers)))
$fn$;
REVOKE ALL ON FUNCTION oauth.tiers_cover(text[], text[]) FROM PUBLIC;

-- A re-authentication of this identity within 5 minutes (database clock).
CREATE FUNCTION oauth.fresh_reauth(p_identity_id text, p_reauth_event_id text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT EXISTS (SELECT FROM auth.reauth_events r
                  WHERE r.reauth_event_id = p_reauth_event_id AND r.identity_id = p_identity_id
                    AND r.method IN ('passkey', 'totp')
                    AND r.occurred_at > clock_timestamp() - interval '5 minutes')
$fn$;
REVOKE ALL ON FUNCTION oauth.fresh_reauth(text, text) FROM PUBLIC;

-- Redirect URIs (oauth.md §3): https, or http on a loopback host; never a
-- fragment, userinfo, whitespace or control character. packages/auth also
-- requires the exact WHATWG serialization; this is the defense in depth.
CREATE FUNCTION oauth.redirect_uris_valid(p_uris text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_uris IS NOT NULL AND cardinality(p_uris) <= 8
     AND NOT EXISTS (
       SELECT FROM unnest(p_uris) AS u(uri)
        WHERE u.uri IS NULL OR char_length(u.uri) > 512
           OR u.uri ~ '[[:space:][:cntrl:]#]'
           OR NOT (u.uri ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?/'
                   OR u.uri ~ '^http://(127\.0\.0\.1|\[::1\]|localhost)(:[0-9]{1,5})?/'))
$fn$;
REVOKE ALL ON FUNCTION oauth.redirect_uris_valid(text[]) FROM PUBLIC;

-- OAuth clients (oauth.md §3, OD-5). `client_id` is the internal entity id
-- (plans, audit); `external_id` is the OAuth client_id on the wire. The
-- registration fixes the client kind and the authentication method.
-- Display metadata is untrusted presentation data; the fingerprint covers
-- the security-relevant metadata, and an active client's approval binds it.
CREATE TABLE oauth.clients (
  client_id                  text        PRIMARY KEY CHECK (client_id ~ '^cli_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  external_id                text        NOT NULL UNIQUE CHECK (char_length(external_id) BETWEEN 1 AND 512
                                                              AND external_id !~ '[[:space:][:cntrl:]]'),
  registration               text        NOT NULL CHECK (registration IN ('first_party', 'pre_registered', 'cimd', 'dcr')),
  kind                       text        NOT NULL CHECK (kind IN ('web', 'cli', 'mcp', 'ci')),
  state                      text        NOT NULL CHECK (state IN ('pending', 'active', 'rejected', 'disabled')),
  display_name               text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100
                                                         AND display_name !~ '[[:cntrl:]]'),
  redirect_uris              text[]      NOT NULL DEFAULT '{}' CHECK (oauth.redirect_uris_valid(redirect_uris)),
  application_type           text        CHECK (application_type IN ('web', 'native')),
  token_endpoint_auth_method text        NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'private_key_jwt')),
  grant_types                text[]      NOT NULL CHECK (grant_types <@ ARRAY['authorization_code', 'refresh_token',
                                                           'client_credentials', 'urn:ietf:params:oauth:grant-type:device_code']),
  metadata                   jsonb       CHECK (metadata IS NULL OR (jsonb_typeof(metadata) = 'object'
                                                                     AND octet_length(metadata::text) <= 8192)),
  metadata_fingerprint       text        NOT NULL CHECK (metadata_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  approved_fingerprint       text        CHECK (approved_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  approved_by_identity_id    text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  approved_at                timestamptz,
  service_identity_id        text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  jwks                       jsonb       CHECK (jwks IS NULL OR (jsonb_typeof(jwks -> 'keys') = 'array'
                                                                 AND jsonb_array_length(jwks -> 'keys') BETWEEN 1 AND 4
                                                                 AND octet_length(jwks::text) <= 16384)),
  requester_hash             text        CHECK (requester_hash ~ '^hmac-sha256:[0-9a-f]{64}$'),
  created_by_identity_id     text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  created_at                 timestamptz NOT NULL,
  state_changed_at           timestamptz NOT NULL,
  pending_expires_at         timestamptz,
  metadata_fetched_at        timestamptz,
  metadata_expires_at        timestamptz,
  CHECK (registration <> 'first_party'
         OR (kind IN ('web', 'cli') AND token_endpoint_auth_method = 'none' AND service_identity_id IS NULL
             AND jwks IS NULL AND requester_hash IS NULL)),
  CHECK (registration <> 'pre_registered'
         OR (kind = 'ci' AND token_endpoint_auth_method = 'private_key_jwt' AND service_identity_id IS NOT NULL
             AND jwks IS NOT NULL AND grant_types = ARRAY['client_credentials'] AND cardinality(redirect_uris) = 0
             AND external_id = client_id AND requester_hash IS NULL)),
  CHECK (registration NOT IN ('cimd', 'dcr')
         OR (kind = 'mcp' AND token_endpoint_auth_method = 'none' AND service_identity_id IS NULL AND jwks IS NULL
             AND cardinality(redirect_uris) >= 1
             AND grant_types <@ ARRAY['authorization_code', 'refresh_token']
             AND 'authorization_code' = ANY (grant_types))),
  CHECK ((registration = 'cimd') = (external_id ~ '^https://')),
  CHECK (registration <> 'cimd' OR metadata_fetched_at IS NOT NULL),
  CHECK (registration <> 'dcr' OR external_id ~ '^exdb-dcr-[A-Za-z0-9_-]{43}$'),
  CHECK (requester_hash IS NULL OR registration = 'dcr'),
  CHECK (state <> 'active' OR (approved_fingerprint = metadata_fingerprint AND approved_at IS NOT NULL)),
  CHECK ((pending_expires_at IS NOT NULL) = (registration = 'dcr' AND state = 'pending'))
);
CREATE UNIQUE INDEX clients_one_per_service_identity ON oauth.clients (service_identity_id)
  WHERE service_identity_id IS NOT NULL;
CREATE INDEX clients_by_state ON oauth.clients (state, created_at);

CREATE FUNCTION oauth.client_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  identity_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only expired DCR registrations that were never approved are removed (worker prune).
    IF NOT (OLD.registration = 'dcr' AND OLD.state IN ('pending', 'rejected') AND OLD.approved_at IS NULL
            AND OLD.state_changed_at < clock_timestamp() - interval '7 days') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'only expired, never approved DCR registrations are removed';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.registration = 'first_party' AND current_user <> 'exdb_migrate' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'first-party clients come only from the Control Store bundles';
    END IF;
    IF NEW.registration IN ('cimd', 'dcr') AND NEW.state <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a CIMD or DCR client starts pending: discovery and registration are not approval';
    END IF;
    IF NEW.registration = 'pre_registered' THEN
      SELECT i.kind INTO identity_kind FROM auth.identities i
       WHERE i.identity_id = NEW.service_identity_id AND i.state = 'active' FOR SHARE;
      IF identity_kind IS DISTINCT FROM 'service' OR NEW.state <> 'active'
         OR NEW.approved_by_identity_id IS DISTINCT FROM NEW.created_by_identity_id
         OR NEW.created_by_identity_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a service-account client belongs to an active service identity and is approved by its creator';
      END IF;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    IF NEW.state = 'active' THEN
      NEW.approved_at := NEW.created_at;
    ELSE
      NEW.approved_at := NULL;
      NEW.approved_fingerprint := NULL;
      NEW.approved_by_identity_id := NULL;
    END IF;
    NEW.pending_expires_at := CASE WHEN NEW.registration = 'dcr' AND NEW.state = 'pending'
                                   THEN NEW.created_at + interval '7 days' END;
    RETURN NEW;
  END IF;
  IF (NEW.client_id, NEW.external_id, NEW.registration, NEW.kind, NEW.token_endpoint_auth_method,
      NEW.service_identity_id, NEW.requester_hash, NEW.created_by_identity_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.client_id, OLD.external_id, OLD.registration, OLD.kind, OLD.token_endpoint_auth_method,
      OLD.service_identity_id, OLD.requester_hash, OLD.created_by_identity_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'client identity, registration, kind and authentication method are immutable';
  END IF;
  IF OLD.registration = 'dcr' AND (NEW.redirect_uris, NEW.grant_types, NEW.application_type, NEW.metadata_fingerprint)
     IS DISTINCT FROM (OLD.redirect_uris, OLD.grant_types, OLD.application_type, OLD.metadata_fingerprint) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a DCR registration never changes: a new registration is a new client';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (('pending', 'active'), ('pending', 'rejected'), ('rejected', 'active'),
                                       ('active', 'disabled'), ('active', 'pending'), ('disabled', 'active'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'client state transition not allowed';
    END IF;
    IF (OLD.state, NEW.state) = ('active', 'pending')
       AND NEW.metadata_fingerprint IS NOT DISTINCT FROM OLD.approved_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a client returns to review only when its security metadata changed';
    END IF;
    IF NEW.state = 'active' THEN
      IF NEW.approved_by_identity_id IS NULL OR NEW.approved_fingerprint IS DISTINCT FROM NEW.metadata_fingerprint THEN
        RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'an approval names its approver and binds the current fingerprint';
      END IF;
      NEW.approved_at := clock_timestamp();
    END IF;
    NEW.state_changed_at := clock_timestamp();
    NEW.pending_expires_at := NULL;
  ELSIF (NEW.approved_fingerprint, NEW.approved_by_identity_id, NEW.approved_at, NEW.state_changed_at, NEW.pending_expires_at)
        IS DISTINCT FROM
        (OLD.approved_fingerprint, OLD.approved_by_identity_id, OLD.approved_at, OLD.state_changed_at, OLD.pending_expires_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'approval data changes only with an approval';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.client_guard() FROM PUBLIC;
CREATE TRIGGER clients_guard BEFORE INSERT OR UPDATE OR DELETE ON oauth.clients
  FOR EACH ROW EXECUTE FUNCTION oauth.client_guard();
CREATE TRIGGER clients_no_truncate BEFORE TRUNCATE ON oauth.clients
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- The first-party clients (oauth.md §3): fixed records, active, public. The
-- Web App never holds tokens (sessions only), so it has no grant type.
INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                           application_type, token_endpoint_auth_method, grant_types, metadata_fingerprint,
                           approved_fingerprint)
VALUES
  ('cli_01M47XTGSBD4SV7Q3AWZRWY8QP', 'exponetdb-web', 'first_party', 'web', 'active', 'ExponetDB Web App',
   '{}', 'web', 'none', '{}',
   'sha256:' || encode(sha256(convert_to(E'exponetdb/first-party-client/v1\nexponetdb-web', 'UTF8')), 'hex'),
   'sha256:' || encode(sha256(convert_to(E'exponetdb/first-party-client/v1\nexponetdb-web', 'UTF8')), 'hex')),
  ('cli_01M47XTGSDXW4ASYC2ZX7YK0X0', 'exponetdb-cli', 'first_party', 'cli', 'active', 'ExponetDB CLI',
   ARRAY['http://127.0.0.1/callback', 'http://[::1]/callback'], 'native', 'none',
   ARRAY['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
   'sha256:' || encode(sha256(convert_to(E'exponetdb/first-party-client/v1\nexponetdb-cli', 'UTF8')), 'hex'),
   'sha256:' || encode(sha256(convert_to(E'exponetdb/first-party-client/v1\nexponetdb-cli', 'UTF8')), 'hex'));

-- Service accounts (identity.md §5): a service identity with a responsible
-- person. Created by an authorized human; never self-registered.
CREATE TABLE oauth.service_accounts (
  identity_id             text        PRIMARY KEY REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  responsible_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  created_by_identity_id  text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL
);
CREATE FUNCTION oauth.service_account_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.identity_id AND i.kind = 'service')
     OR NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.responsible_identity_id
                     AND i.kind = 'human' AND i.state = 'active')
     OR NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.created_by_identity_id
                     AND i.kind = 'human' AND i.state = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO02', MESSAGE = 'a service account is a service identity with an active responsible person';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.service_account_guard() FROM PUBLIC;
CREATE TRIGGER service_accounts_guard BEFORE INSERT ON oauth.service_accounts
  FOR EACH ROW EXECUTE FUNCTION oauth.service_account_guard();
CREATE TRIGGER service_accounts_append_only BEFORE UPDATE OR DELETE ON oauth.service_accounts
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER service_accounts_no_truncate BEFORE TRUNCATE ON oauth.service_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Grants (oauth.md §4, §6): the maximum authority an identity delegated to
-- a client for one resource. A delegated grant comes from a person's
-- consent; a machine grant from an administrator for a service account's
-- client. Live role bindings remain authoritative at every use; a grant
-- never holds permissions. `target_ids` NULL means every target the
-- identity reaches through its bindings.
CREATE TABLE oauth.grants (
  grant_id               text        PRIMARY KEY CHECK (grant_id ~ '^grt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind                   text        NOT NULL CHECK (kind IN ('delegated', 'machine')),
  identity_id            text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  client_id              text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  client_kind            text        NOT NULL CHECK (client_kind IN ('cli', 'mcp', 'ci')),
  resource               text        NOT NULL CHECK (resource IN ('api', 'mcp')),
  scopes                 text[]      NOT NULL,
  tiers                  text[]      NOT NULL CHECK (cardinality(tiers) BETWEEN 1 AND 2
                                                     AND tiers <@ ARRAY['prod', 'nonprod']
                                                     AND (cardinality(tiers) = 1 OR tiers[1] <> tiers[2])),
  target_ids             text[]      CHECK (target_ids IS NULL OR (cardinality(target_ids) BETWEEN 1 AND 64
                                            AND array_to_string(target_ids, ',') ~ '^(tgt_[0-7][0-9A-HJKMNP-TV-Z]{25})(,tgt_[0-7][0-9A-HJKMNP-TV-Z]{25})*$')),
  created_by_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  reauth_event_id        text        REFERENCES auth.reauth_events (reauth_event_id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL,
  consent_at             timestamptz,
  expires_at             timestamptz NOT NULL,
  state                  text        NOT NULL CHECK (state IN ('active', 'revoked')),
  revoked_at             timestamptz,
  revoke_reason          text        CHECK (revoke_reason IN ('owner', 'administrator', 'client_disabled',
                                            'client_review', 'identity_disabled', 'identity_erased',
                                            'refresh_reuse', 'code_replay', 'out_of_band_recovery',
                                            'token_revocation', 'replaced')),
  revoked_by_identity_id text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CHECK (kind <> 'delegated' OR (client_kind IN ('cli', 'mcp') AND consent_at IS NOT NULL
                                 AND created_by_identity_id = identity_id)),
  CHECK (kind <> 'machine' OR (client_kind = 'ci' AND resource = 'api' AND consent_at IS NULL)),
  CHECK (client_kind = 'mcp' OR resource = 'api'),
  CHECK (expires_at > created_at
         AND expires_at <= created_at + CASE kind WHEN 'machine' THEN interval '365 days' ELSE interval '90 days' END)
);
CREATE INDEX grants_by_identity ON oauth.grants (identity_id, state);
CREATE INDEX grants_by_client ON oauth.grants (client_id, state);
-- One live machine authority per service client: a new one replaces the old in the same transaction.
CREATE UNIQUE INDEX grants_one_active_machine ON oauth.grants (client_id) WHERE kind = 'machine' AND state = 'active';

CREATE FUNCTION oauth.grant_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  client oauth.clients%ROWTYPE;
  identity_kind text;
  max_days integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO client FROM oauth.clients c WHERE c.client_id = NEW.client_id FOR SHARE;
    IF NOT FOUND OR client.state <> 'active' OR client.kind = 'web' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a grant is given only to an active client that holds tokens';
    END IF;
    NEW.client_kind := client.kind;
    -- Locked: a concurrent disable waits for this grant and then revokes it.
    SELECT i.kind INTO identity_kind FROM auth.identities i
     WHERE i.identity_id = NEW.identity_id AND i.state = 'active' FOR SHARE;
    IF identity_kind IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a grant is given only for an active identity';
    END IF;
    IF NEW.kind = 'delegated' AND (identity_kind <> 'human' OR client.registration NOT IN ('first_party', 'cimd', 'dcr')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a delegated grant is a person''s consent to a public client';
    END IF;
    IF NEW.kind = 'machine' AND (identity_kind <> 'service' OR client.service_identity_id IS DISTINCT FROM NEW.identity_id
                                 OR NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.created_by_identity_id
                                                 AND i.kind = 'human' AND i.state = 'active')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a machine grant belongs to the service account of its client and is created by a person';
    END IF;
    IF NOT oauth.scopes_holdable(NEW.scopes, client.kind) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a scope is unknown, repeated or not holdable by this client kind';
    END IF;
    IF NOT oauth.tiers_cover(NEW.scopes, NEW.tiers) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a tiered scope needs its tier in the restriction';
    END IF;
    IF oauth.scopes_need_reauth(NEW.scopes)
       AND NOT oauth.fresh_reauth(NEW.created_by_identity_id, NEW.reauth_event_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'production writes and human-only changes need a re-authentication at most 5 minutes old';
    END IF;
    max_days := CASE NEW.kind WHEN 'machine' THEN 365 ELSE 90 END;
    IF NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp()
       OR NEW.expires_at > clock_timestamp() + make_interval(days => max_days) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a grant expires within its maximum lifetime';
    END IF;
    IF NEW.state <> 'active' OR NEW.revoked_at IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a grant starts active';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.consent_at := CASE NEW.kind WHEN 'delegated' THEN NEW.created_at END;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'revoked_at', 'revoke_reason', 'revoked_by_identity_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'revoked_at', 'revoke_reason', 'revoked_by_identity_id'])
     OR OLD.state <> 'active' OR NEW.state <> 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO03', MESSAGE = 'a grant is revoked once and never changes otherwise';
  END IF;
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.grant_guard() FROM PUBLIC;
CREATE TRIGGER grants_guard BEFORE INSERT OR UPDATE ON oauth.grants
  FOR EACH ROW EXECUTE FUNCTION oauth.grant_guard();
CREATE TRIGGER grants_no_delete BEFORE DELETE ON oauth.grants
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER grants_no_truncate BEFORE TRUNCATE ON oauth.grants
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- A client that leaves `active` (disabled, or back to review after a
-- security metadata change) ends every grant it holds, in the same
-- transaction. Runs with the schema owner's rights so no caller can skip it.
CREATE FUNCTION oauth.client_left_active() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE oauth.grants SET state = 'revoked',
         revoke_reason = CASE NEW.state WHEN 'disabled' THEN 'client_disabled' ELSE 'client_review' END
   WHERE client_id = NEW.client_id AND state = 'active';
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.client_left_active() FROM PUBLIC;
CREATE TRIGGER clients_left_active AFTER UPDATE OF state ON oauth.clients
  FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION oauth.client_left_active();

-- Authorization requests (oauth.md §4): the validated request, stored on the
-- server while the person decides. Found by the hash of an opaque handle and
-- bound to the hash of the starting browser's binding cookie. 10 minutes;
-- decided once.
CREATE TABLE oauth.authorization_requests (
  request_id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle_hash        text        NOT NULL UNIQUE CHECK (handle_hash ~ '^sha256:[0-9a-f]{64}$'),
  binding_hash       text        NOT NULL CHECK (binding_hash ~ '^sha256:[0-9a-f]{64}$'),
  client_id          text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  client_fingerprint text        NOT NULL CHECK (client_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  redirect_uri       text        NOT NULL CHECK (oauth.redirect_uris_valid(ARRAY[redirect_uri])),
  scopes             text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 64),
  resource           text        NOT NULL CHECK (resource IN ('api', 'mcp')),
  code_challenge     text        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state              text        NOT NULL CHECK (char_length(state) BETWEEN 1 AND 512 AND state ~ '^[\x20-\x7e]+$'),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  decided_at         timestamptz,
  decision           text        CHECK (decision IN ('allowed', 'denied')),
  identity_id        text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((decided_at IS NULL) = (decision IS NULL)),
  CHECK ((decision IS NULL) = (identity_id IS NULL))
);
CREATE INDEX authorization_requests_expiry ON oauth.authorization_requests (expires_at);
CREATE FUNCTION oauth.authorization_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO04', MESSAGE = 'only requests that ended more than a day ago are pruned';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT FROM oauth.clients c WHERE c.client_id = NEW.client_id AND c.state = 'active'
                    AND c.metadata_fingerprint = NEW.client_fingerprint) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO04', MESSAGE = 'an authorization request names an active client and its current fingerprint';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '10 minutes';
    NEW.decided_at := NULL;
    NEW.decision := NULL;
    NEW.identity_id := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['decided_at', 'decision', 'identity_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['decided_at', 'decision', 'identity_id'])
     OR OLD.decision IS NOT NULL OR NEW.decision IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO04', MESSAGE = 'an authorization request is decided once and never changes otherwise';
  END IF;
  IF OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO04', MESSAGE = 'an expired authorization request cannot be decided';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.authorization_request_guard() FROM PUBLIC;
CREATE TRIGGER authorization_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON oauth.authorization_requests
  FOR EACH ROW EXECUTE FUNCTION oauth.authorization_request_guard();
CREATE TRIGGER authorization_requests_no_truncate BEFORE TRUNCATE ON oauth.authorization_requests
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Authorization codes (oauth.md §5): one per delegated grant, 60 seconds,
-- bound to client, identity, redirect URI, PKCE challenge, resource and
-- scopes, consumed once (a second presentation is a replay).
CREATE TABLE oauth.authorization_codes (
  code_hash      text        PRIMARY KEY CHECK (code_hash ~ '^sha256:[0-9a-f]{64}$'),
  grant_id       text        NOT NULL UNIQUE REFERENCES oauth.grants (grant_id) ON DELETE RESTRICT,
  client_id      text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  identity_id    text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  redirect_uri   text        NOT NULL CHECK (oauth.redirect_uris_valid(ARRAY[redirect_uri])),
  code_challenge text        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource       text        NOT NULL CHECK (resource IN ('api', 'mcp')),
  scopes         text[]      NOT NULL,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (expires_at = created_at + interval '60 seconds')
);
CREATE FUNCTION oauth.authorization_code_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO05', MESSAGE = 'only codes that ended more than a day ago are pruned';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT FROM oauth.grants g
                    WHERE g.grant_id = NEW.grant_id AND g.kind = 'delegated' AND g.state = 'active'
                      AND g.client_id = NEW.client_id AND g.identity_id = NEW.identity_id
                      AND g.resource = NEW.resource AND g.scopes = NEW.scopes) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO05', MESSAGE = 'a code carries exactly its active grant';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '60 seconds';
    NEW.consumed_at := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
     OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO05', MESSAGE = 'an authorization code is consumed once and never changes otherwise';
  END IF;
  NEW.consumed_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.authorization_code_guard() FROM PUBLIC;
CREATE TRIGGER authorization_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON oauth.authorization_codes
  FOR EACH ROW EXECUTE FUNCTION oauth.authorization_code_guard();
CREATE TRIGGER authorization_codes_no_truncate BEFORE TRUNCATE ON oauth.authorization_codes
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Access and refresh tokens (oauth.md §5, ADR-0022): opaque, stored as
-- hashes. An access token lives 10 minutes; a refresh token lives until its
-- grant ends, is spent by its single rotation, and a grant has at most one
-- live refresh token. Validation joins the grant, the client and the
-- identity live, so revoking any of them ends the token at once.
CREATE TABLE oauth.tokens (
  token_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash      text        NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  grant_id        text        NOT NULL REFERENCES oauth.grants (grant_id) ON DELETE RESTRICT,
  client_id       text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  identity_id     text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  resource        text        NOT NULL CHECK (resource IN ('api', 'mcp')),
  scopes          text[]      NOT NULL,
  generation      integer     NOT NULL DEFAULT 1 CHECK (generation >= 1),
  parent_token_id bigint      REFERENCES oauth.tokens (token_id),
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  spent_at        timestamptz,
  revoked_at      timestamptz,
  CHECK (kind <> 'access' OR (spent_at IS NULL AND generation = 1 AND parent_token_id IS NULL
                              AND expires_at <= issued_at + interval '10 minutes')),
  CHECK (expires_at > issued_at)
);
CREATE INDEX tokens_by_grant ON oauth.tokens (grant_id, kind);
CREATE INDEX tokens_expiry ON oauth.tokens (expires_at);
CREATE UNIQUE INDEX tokens_one_live_refresh ON oauth.tokens (grant_id)
  WHERE kind = 'refresh' AND spent_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION oauth.token_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  g oauth.grants%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'access' AND OLD.expires_at > clock_timestamp() - interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO06', MESSAGE = 'an access token is pruned only a day after it expired';
    END IF;
    -- A refresh token stays while its grant could still be used, so a rotated-out
    -- token presented again is recognized as reuse.
    IF OLD.kind = 'refresh' AND EXISTS (
         SELECT FROM oauth.grants gr WHERE gr.grant_id = OLD.grant_id
            AND coalesce(gr.revoked_at, gr.expires_at) > clock_timestamp() - interval '30 days') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO06', MESSAGE = 'a refresh token is pruned only 30 days after its grant ended';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO g FROM oauth.grants gr WHERE gr.grant_id = NEW.grant_id FOR SHARE;
    IF NOT FOUND OR g.state <> 'active' OR g.expires_at <= clock_timestamp()
       OR g.client_id <> NEW.client_id OR g.identity_id <> NEW.identity_id OR g.resource <> NEW.resource
       OR NOT (NEW.scopes <@ g.scopes) OR cardinality(NEW.scopes) = 0
       OR NOT EXISTS (SELECT FROM oauth.clients c WHERE c.client_id = g.client_id AND c.state = 'active')
       OR NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = g.identity_id AND i.state = 'active') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO06', MESSAGE = 'a token is issued only from an active grant, within its scopes';
    END IF;
    IF NEW.kind = 'refresh' AND g.kind <> 'delegated' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO06', MESSAGE = 'a machine grant has no refresh token';
    END IF;
    NEW.issued_at := clock_timestamp();
    NEW.expires_at := CASE NEW.kind
                        WHEN 'access' THEN least(NEW.issued_at + interval '10 minutes', g.expires_at)
                        ELSE g.expires_at END;
    NEW.spent_at := NULL;
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['spent_at', 'revoked_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['spent_at', 'revoked_at'])
     OR (NEW.spent_at IS DISTINCT FROM OLD.spent_at AND (OLD.spent_at IS NOT NULL OR OLD.kind <> 'refresh'))
     OR (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND OLD.revoked_at IS NOT NULL)
     OR (NEW.spent_at IS NULL AND OLD.spent_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO06', MESSAGE = 'a token is spent or revoked once and never changes otherwise';
  END IF;
  IF NEW.spent_at IS DISTINCT FROM OLD.spent_at THEN
    NEW.spent_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    NEW.revoked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.token_guard() FROM PUBLIC;
CREATE TRIGGER tokens_guard BEFORE INSERT OR UPDATE OR DELETE ON oauth.tokens
  FOR EACH ROW EXECUTE FUNCTION oauth.token_guard();
CREATE TRIGGER tokens_no_truncate BEFORE TRUNCATE ON oauth.tokens
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- A revoked grant revokes its tokens in the same transaction (validation
-- also checks the grant live; this keeps the token rows truthful).
CREATE FUNCTION oauth.grant_revoked() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE oauth.tokens SET revoked_at = clock_timestamp()
   WHERE grant_id = NEW.grant_id AND revoked_at IS NULL;
  UPDATE oauth.device_codes SET state = 'consumed'
   WHERE grant_id = NEW.grant_id AND state = 'approved';
  RETURN NULL;
END
$fn$;

-- Device authorizations (RFC 8628, oauth.md §5): the first-party CLI's
-- headless sign-in. The device code and the user code are stored as hashes;
-- 10 minutes; the polling interval only grows; approved once, consumed once.
CREATE TABLE oauth.device_codes (
  device_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_code_hash text        NOT NULL UNIQUE CHECK (device_code_hash ~ '^sha256:[0-9a-f]{64}$'),
  user_code_hash   text        NOT NULL UNIQUE CHECK (user_code_hash ~ '^sha256:[0-9a-f]{64}$'),
  client_id        text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  scopes           text[]      NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 64),
  resource         text        NOT NULL CHECK (resource IN ('api', 'mcp')),
  interval_seconds integer     NOT NULL CHECK (interval_seconds BETWEEN 5 AND 60),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  last_polled_at   timestamptz,
  state            text        NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'consumed')),
  identity_id      text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  grant_id         text        UNIQUE REFERENCES oauth.grants (grant_id) ON DELETE RESTRICT,
  decided_at       timestamptz,
  consumed_at      timestamptz,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((state = 'pending') = (identity_id IS NULL)),
  CHECK ((state IN ('approved', 'consumed')) = (grant_id IS NOT NULL)),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX device_codes_expiry ON oauth.device_codes (expires_at);
CREATE FUNCTION oauth.device_code_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'only device codes that ended more than a day ago are pruned';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT FROM oauth.clients c WHERE c.client_id = NEW.client_id AND c.state = 'active'
                    AND 'urn:ietf:params:oauth:grant-type:device_code' = ANY (c.grant_types))
       OR NOT oauth.scopes_holdable(NEW.scopes, (SELECT c.kind FROM oauth.clients c WHERE c.client_id = NEW.client_id)) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'a device authorization belongs to an active device client and holdable scopes';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '10 minutes';
    NEW.interval_seconds := greatest(NEW.interval_seconds, 5);
    NEW.state := 'pending';
    NEW.identity_id := NULL;
    NEW.grant_id := NULL;
    NEW.decided_at := NULL;
    NEW.consumed_at := NULL;
    NEW.last_polled_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.device_id, NEW.device_code_hash, NEW.user_code_hash, NEW.client_id, NEW.scopes, NEW.resource,
      NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.device_id, OLD.device_code_hash, OLD.user_code_hash, OLD.client_id, OLD.scopes, OLD.resource,
      OLD.created_at, OLD.expires_at)
     OR NEW.interval_seconds < OLD.interval_seconds THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'a device authorization keeps its codes, scopes and lifetime; the interval only grows';
  END IF;
  IF NEW.last_polled_at IS DISTINCT FROM OLD.last_polled_at THEN
    NEW.last_polled_at := clock_timestamp();
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (('pending', 'approved'), ('pending', 'denied'), ('approved', 'consumed'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'device authorization state transition not allowed';
    END IF;
    IF OLD.state = 'pending' THEN
      IF OLD.expires_at <= clock_timestamp() OR NEW.identity_id IS NULL
         OR (NEW.state = 'approved') <> (NEW.grant_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'a live device authorization is decided by a person, with a grant when approved';
      END IF;
      NEW.decided_at := clock_timestamp();
    ELSE
      NEW.consumed_at := clock_timestamp();
    END IF;
  ELSIF (NEW.identity_id, NEW.grant_id, NEW.decided_at, NEW.consumed_at)
        IS DISTINCT FROM (OLD.identity_id, OLD.grant_id, OLD.decided_at, OLD.consumed_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO07', MESSAGE = 'a device decision changes only with its state';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.device_code_guard() FROM PUBLIC;
CREATE TRIGGER device_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON oauth.device_codes
  FOR EACH ROW EXECUTE FUNCTION oauth.device_code_guard();
CREATE TRIGGER device_codes_no_truncate BEFORE TRUNCATE ON oauth.device_codes
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

REVOKE ALL ON FUNCTION oauth.grant_revoked() FROM PUBLIC;
CREATE TRIGGER grants_revoked AFTER UPDATE OF state ON oauth.grants
  FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state = 'revoked')
  EXECUTE FUNCTION oauth.grant_revoked();

-- Replay store of `private_key_jwt` assertions (RFC 7523 §3): the hash of
-- each accepted `jti` per client until the assertion expires. A second
-- insert of the same pair fails: an assertion is accepted once.
CREATE TABLE oauth.client_assertions (
  client_id  text        NOT NULL REFERENCES oauth.clients (client_id) ON DELETE RESTRICT,
  jti_hash   text        NOT NULL CHECK (jti_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (client_id, jti_hash),
  CHECK (expires_at <= used_at + interval '10 minutes')
);
CREATE INDEX client_assertions_expiry ON oauth.client_assertions (expires_at);
CREATE FUNCTION oauth.client_assertion_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 hour' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO08', MESSAGE = 'an assertion id is pruned only after it expired';
    END IF;
    RETURN OLD;
  END IF;
  NEW.used_at := clock_timestamp();
  IF NEW.expires_at <= NEW.used_at OR NEW.expires_at > NEW.used_at + interval '10 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO08', MESSAGE = 'an assertion is live and short-lived';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.client_assertion_guard() FROM PUBLIC;
CREATE TRIGGER client_assertions_guard BEFORE INSERT OR DELETE ON oauth.client_assertions
  FOR EACH ROW EXECUTE FUNCTION oauth.client_assertion_guard();
CREATE TRIGGER client_assertions_no_update BEFORE UPDATE ON oauth.client_assertions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER client_assertions_no_truncate BEFORE TRUNCATE ON oauth.client_assertions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- API keys (identity.md §5): a service account's REST credential, stored as
-- a hash, with scopes, restrictions and a mandatory expiry (at most 365
-- days). The key is shown once at creation. A key is revoked once; nothing
-- else of it changes except the coarse last-use time.
CREATE TABLE oauth.api_keys (
  key_id                 text        PRIMARY KEY CHECK (key_id ~ '^key_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id            text        NOT NULL REFERENCES oauth.service_accounts (identity_id) ON DELETE RESTRICT,
  key_hash               text        NOT NULL UNIQUE CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$'),
  label                  text        CHECK (char_length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]'),
  scopes                 text[]      NOT NULL,
  tiers                  text[]      NOT NULL CHECK (cardinality(tiers) BETWEEN 1 AND 2
                                                     AND tiers <@ ARRAY['prod', 'nonprod']
                                                     AND (cardinality(tiers) = 1 OR tiers[1] <> tiers[2])),
  target_ids             text[]      CHECK (target_ids IS NULL OR (cardinality(target_ids) BETWEEN 1 AND 64
                                            AND array_to_string(target_ids, ',') ~ '^(tgt_[0-7][0-9A-HJKMNP-TV-Z]{25})(,tgt_[0-7][0-9A-HJKMNP-TV-Z]{25})*$')),
  created_by_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  reauth_event_id        text        REFERENCES auth.reauth_events (reauth_event_id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  revoke_reason          text        CHECK (revoke_reason IN ('administrator', 'identity_disabled', 'identity_erased')),
  revoked_by_identity_id text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX api_keys_by_identity ON oauth.api_keys (identity_id);
CREATE FUNCTION oauth.api_key_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.identities i WHERE i.identity_id = NEW.identity_id FOR SHARE;
    IF NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.identity_id
                    AND i.kind = 'service' AND i.state = 'active')
       OR NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.created_by_identity_id
                       AND i.kind = 'human' AND i.state = 'active') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO09', MESSAGE = 'an API key belongs to an active service account and is created by a person';
    END IF;
    IF NOT oauth.scopes_holdable(NEW.scopes, 'ci') OR NOT oauth.tiers_cover(NEW.scopes, NEW.tiers) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO09', MESSAGE = 'an API key holds catalog scopes a service account may hold, within its tiers';
    END IF;
    IF oauth.scopes_need_reauth(NEW.scopes)
       AND NOT oauth.fresh_reauth(NEW.created_by_identity_id, NEW.reauth_event_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO09', MESSAGE = 'production write authority needs a re-authentication at most 5 minutes old';
    END IF;
    IF NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp()
       OR NEW.expires_at > clock_timestamp() + interval '365 days' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO09', MESSAGE = 'an API key expires within 365 days';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.last_used_at := NULL;
    NEW.revoked_at := NULL;
    NEW.revoke_reason := NULL;
    NEW.revoked_by_identity_id := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['last_used_at', 'revoked_at', 'revoke_reason', 'revoked_by_identity_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['last_used_at', 'revoked_at', 'revoke_reason', 'revoked_by_identity_id'])
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoke_reason, NEW.revoked_by_identity_id)
                                        IS DISTINCT FROM (OLD.revoked_at, OLD.revoke_reason, OLD.revoked_by_identity_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO09', MESSAGE = 'an API key is revoked once; its secret, scopes and expiry never change';
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    NEW.revoked_at := clock_timestamp();
  END IF;
  IF NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
    NEW.last_used_at := greatest(coalesce(OLD.last_used_at, '-infinity'), clock_timestamp());
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.api_key_guard() FROM PUBLIC;
CREATE TRIGGER api_keys_guard BEFORE INSERT OR UPDATE ON oauth.api_keys
  FOR EACH ROW EXECUTE FUNCTION oauth.api_key_guard();
CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON oauth.api_keys
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER api_keys_no_truncate BEFORE TRUNCATE ON oauth.api_keys
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Rate limits of the protocol endpoints (oauth.md §5): fixed-window
-- counters per bucket. Addresses appear only as HMAC values under the
-- installation's rate-limit key. Rows idle for a day are pruned.
CREATE TABLE oauth.rate_limits (
  bucket            text        PRIMARY KEY CHECK (bucket ~ '^(dcr-ip|dcr-all|token-ip|assertion|device-idn|device-ip|authorize-ip):[A-Za-z0-9_-]{1,96}$'),
  window_started_at timestamptz NOT NULL,
  hits              integer     NOT NULL CHECK (hits >= 0),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rate_limits_updated ON oauth.rate_limits (updated_at);
CREATE TRIGGER rate_limits_no_truncate BEFORE TRUNCATE ON oauth.rate_limits
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Guards on the Wave 3A tables (that bundle stays frozen): a service
-- identity never has a Web session, an authentication factor, a one-time
-- link or the owner role.
CREATE FUNCTION oauth.human_identity_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.identity_id AND i.kind = 'human') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO10', MESSAGE = 'only a person has sessions, factors and one-time links';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.human_identity_only() FROM PUBLIC;
CREATE TRIGGER web_sessions_human_only BEFORE INSERT ON auth.web_sessions
  FOR EACH ROW EXECUTE FUNCTION oauth.human_identity_only();
CREATE TRIGGER factors_human_only BEFORE INSERT ON auth.factors
  FOR EACH ROW EXECUTE FUNCTION oauth.human_identity_only();
CREATE TRIGGER capabilities_human_only BEFORE INSERT ON auth.capabilities
  FOR EACH ROW EXECUTE FUNCTION oauth.human_identity_only();

CREATE FUNCTION oauth.no_service_owner() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.role_id = 'owner' AND EXISTS (SELECT FROM auth.identities i
                                        WHERE i.identity_id = NEW.identity_id AND i.kind = 'service') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO10', MESSAGE = 'a service account is never an owner';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.no_service_owner() FROM PUBLIC;
CREATE TRIGGER role_bindings_no_service_owner BEFORE INSERT ON auth.role_bindings
  FOR EACH ROW EXECUTE FUNCTION oauth.no_service_owner();

-- Identity lifecycle (identity.md §7): disabling or erasing an identity ends
-- its grants and API keys and disables the client of a service account, in
-- the same transaction, whoever changes the state (serve disables, the
-- worker erases). Runs with the schema owner's rights.
CREATE FUNCTION oauth.identity_left_active() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  reason text := CASE NEW.state WHEN 'erased' THEN 'identity_erased' ELSE 'identity_disabled' END;
BEGIN
  UPDATE oauth.grants SET state = 'revoked', revoke_reason = reason
   WHERE identity_id = NEW.identity_id AND state = 'active';
  UPDATE oauth.api_keys SET revoked_at = clock_timestamp(), revoke_reason = reason
   WHERE identity_id = NEW.identity_id AND revoked_at IS NULL;
  UPDATE oauth.clients SET state = 'disabled'
   WHERE service_identity_id = NEW.identity_id AND state = 'active';
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.identity_left_active() FROM PUBLIC;
CREATE TRIGGER identities_left_active AFTER UPDATE OF state ON auth.identities
  FOR EACH ROW WHEN (NEW.state IN ('disabled', 'erased') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION oauth.identity_left_active();

-- Privileges. serve: the authorization server and the delegation use cases;
-- it reads the hashes it verifies against. worker: pruning only; it never
-- reads a token, code, device, user-code, assertion or API key hash, a
-- binding hash or a client key. Nobody else uses the schema.
GRANT SELECT ON oauth.scopes TO exdb_serve, exdb_worker;
-- The guards run with the caller's rights and call these helpers.
GRANT EXECUTE ON FUNCTION oauth.scopes_holdable(text[], text), oauth.scopes_need_reauth(text[]),
                          oauth.tiers_cover(text[], text[]), oauth.fresh_reauth(text, text),
                          oauth.redirect_uris_valid(text[])
  TO exdb_serve;

GRANT SELECT, INSERT ON oauth.clients TO exdb_serve;
GRANT UPDATE (state, display_name, redirect_uris, application_type, grant_types, metadata, metadata_fingerprint,
              approved_fingerprint, approved_by_identity_id, jwks, metadata_fetched_at, metadata_expires_at)
  ON oauth.clients TO exdb_serve;
GRANT SELECT (client_id, registration, state, approved_at, state_changed_at, pending_expires_at), DELETE
  ON oauth.clients TO exdb_worker;

GRANT SELECT, INSERT ON oauth.service_accounts TO exdb_serve;
GRANT SELECT (identity_id, responsible_identity_id, created_at) ON oauth.service_accounts TO exdb_worker;

GRANT SELECT, INSERT ON oauth.grants TO exdb_serve;
GRANT UPDATE (state, revoke_reason, revoked_by_identity_id) ON oauth.grants TO exdb_serve;
GRANT SELECT (grant_id, kind, identity_id, client_id, state, expires_at, revoked_at) ON oauth.grants TO exdb_worker;

GRANT SELECT, INSERT ON oauth.authorization_requests TO exdb_serve;
GRANT UPDATE (decision, identity_id) ON oauth.authorization_requests TO exdb_serve;
GRANT SELECT (request_id, expires_at), DELETE ON oauth.authorization_requests TO exdb_worker;

GRANT SELECT, INSERT ON oauth.authorization_codes TO exdb_serve;
GRANT UPDATE (consumed_at) ON oauth.authorization_codes TO exdb_serve;
GRANT SELECT (grant_id, expires_at, consumed_at), DELETE ON oauth.authorization_codes TO exdb_worker;

GRANT SELECT, INSERT ON oauth.tokens TO exdb_serve;
GRANT UPDATE (spent_at, revoked_at) ON oauth.tokens TO exdb_serve;
GRANT SELECT (token_id, kind, grant_id, expires_at, spent_at, revoked_at), DELETE ON oauth.tokens TO exdb_worker;

GRANT SELECT, INSERT ON oauth.device_codes TO exdb_serve;
GRANT UPDATE (state, identity_id, grant_id, last_polled_at, interval_seconds) ON oauth.device_codes TO exdb_serve;
GRANT SELECT (device_id, expires_at, state), DELETE ON oauth.device_codes TO exdb_worker;

GRANT SELECT, INSERT ON oauth.client_assertions TO exdb_serve;
GRANT SELECT (client_id, expires_at), DELETE ON oauth.client_assertions TO exdb_worker;

GRANT SELECT, INSERT ON oauth.api_keys TO exdb_serve;
GRANT UPDATE (last_used_at, revoked_at, revoke_reason, revoked_by_identity_id) ON oauth.api_keys TO exdb_serve;

GRANT SELECT, INSERT, UPDATE ON oauth.rate_limits TO exdb_serve;
GRANT SELECT (bucket, updated_at), DELETE ON oauth.rate_limits TO exdb_worker;
