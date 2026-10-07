-- The node agent's control plane (control-plane.md, Wave 5). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- Rules carried by this schema:
-- * the agent PKI's certificates and the references to the gateway-consumer
--   secrets of its two CA keys are recorded once (node-pki init); the root's
--   private key is never here, and the gateway mints its own short-lived TLS
--   certificate from the server CA (control-plane.md §3);
-- * job-signing keys are worker-consumer secrets; at most one is active;
-- * an enrollment token is created by an operation without a secret, issued
--   once by serve (the redeem hash and the worker-consumer secret of the
--   bind key, 30 minutes), redeemed once by the gateway, and otherwise
--   expires; its secret is never stored;
-- * one node that is not revoked, decommissioned or failed per server (I-6);
--   a node starts pending_binding and becomes active only when the worker
--   has checked its bind proof; its keys never change, only its TLS key and
--   certificate are replaced on renewal;
-- * the gateway writes only through the functions below, each checking the
--   node's current certificate, its state and the transition; it cannot
--   create a job, change one's envelope or judge a result;
-- * a job's envelope, signed by the worker, never changes; a job moves
--   pending → dispatched → running → completed, or ends expired, canceled or
--   outcome_unknown; a dispatched job that is not started within 60 s returns
--   to pending with the identical envelope (ADR-0024 §4).
CREATE SCHEMA nodes AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA nodes FROM PUBLIC;
GRANT USAGE ON SCHEMA nodes TO exdb_serve, exdb_worker, exdb_gateway;

CREATE TABLE nodes.pki (
  singleton                boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  root_certificate         bytea       NOT NULL CHECK (octet_length(root_certificate) BETWEEN 64 AND 8192),
  root_fingerprint         text        NOT NULL CHECK (root_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  issuing_ca_certificate   bytea       NOT NULL CHECK (octet_length(issuing_ca_certificate) BETWEEN 64 AND 8192),
  issuing_ca_key_secret_id text        NOT NULL CHECK (issuing_ca_key_secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  server_ca_certificate    bytea       NOT NULL CHECK (octet_length(server_ca_certificate) BETWEEN 64 AND 8192),
  server_ca_key_secret_id  text        NOT NULL CHECK (server_ca_key_secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  gateway_url              text        NOT NULL CHECK (gateway_url ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[1-9][0-9]{0,4})?$'
                                                   AND gateway_url !~ ':443$'),
  gateway_server_name      text        NOT NULL CHECK (char_length(gateway_server_name) <= 253
                                                   AND gateway_server_name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'),
  created_at               timestamptz NOT NULL
);

CREATE TABLE nodes.job_keys (
  key_id           text        PRIMARY KEY CHECK (key_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  public_key       bytea       NOT NULL CHECK (octet_length(public_key) = 32),
  fingerprint      text        NOT NULL UNIQUE CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  secret_id        text        NOT NULL UNIQUE CHECK (secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  state            text        NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  created_at       timestamptz NOT NULL,
  state_changed_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX job_keys_one_active ON nodes.job_keys ((true)) WHERE state = 'active';

CREATE TABLE nodes.enrollment_tokens (
  token_id                text        PRIMARY KEY CHECK (token_id ~ '^ent_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  server_id               text        NOT NULL REFERENCES registry.servers (server_id) ON DELETE RESTRICT,
  job_keys                jsonb       NOT NULL CHECK (jsonb_typeof(job_keys) = 'array'
                                                  AND jsonb_array_length(job_keys) BETWEEN 1 AND 3),
  state                   text        NOT NULL CHECK (state IN ('created', 'issued', 'used', 'expired')),
  reveal_by               text        NOT NULL CHECK (reveal_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  reveal_until            timestamptz NOT NULL,
  redeem_hash             text        CHECK (redeem_hash ~ '^sha256:[0-9a-f]{64}$'),
  bind_secret_id          text        CHECK (bind_secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  issued_at               timestamptz,
  expires_at              timestamptz,
  used_at                 timestamptz,
  used_by_node_id         text        CHECK (used_by_node_id ~ '^nod_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at              timestamptz NOT NULL,
  created_by_operation_id text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  CHECK ((state = 'created') = (redeem_hash IS NULL AND issued_at IS NULL)
         OR state = 'expired'),
  CHECK (state <> 'issued' OR (redeem_hash IS NOT NULL AND bind_secret_id IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((state = 'used') = (used_at IS NOT NULL AND used_by_node_id IS NOT NULL))
);

CREATE TABLE nodes.nodes (
  node_id                      text        PRIMARY KEY CHECK (node_id ~ '^nod_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  server_id                    text        NOT NULL REFERENCES registry.servers (server_id) ON DELETE RESTRICT,
  token_id                     text        NOT NULL UNIQUE REFERENCES nodes.enrollment_tokens (token_id) ON DELETE RESTRICT,
  state                        text        NOT NULL CHECK (state IN ('pending_binding', 'active', 'degraded', 'binding_failed',
                                                                     'revoked', 'decommissioned')),
  tls_key                      bytea       NOT NULL CHECK (octet_length(tls_key) = 32),
  node_signing_key             bytea       NOT NULL UNIQUE CHECK (octet_length(node_signing_key) = 32),
  node_encryption_key          bytea       NOT NULL UNIQUE CHECK (octet_length(node_encryption_key) = 32),
  bind_proof                   text        CHECK (bind_proof ~ '^[A-Za-z0-9_-]{43}$'),
  bound_at                     timestamptz,
  certificate                  bytea       NOT NULL CHECK (octet_length(certificate) BETWEEN 64 AND 8192),
  certificate_expires_at       timestamptz NOT NULL,
  certificate_renewed_at       timestamptz,
  -- The certificate a renewal replaced, still accepted until the renewed one
  -- is first presented (a crash before the agent stored the renewed
  -- certificate must not lock the node out).
  previous_certificate         bytea       CHECK (octet_length(previous_certificate) BETWEEN 64 AND 8192),
  host                         jsonb       NOT NULL CHECK (jsonb_typeof(host) = 'object'),
  agent_version                text        NOT NULL CHECK (char_length(agent_version) BETWEEN 5 AND 64),
  protocol_major               integer     CHECK (protocol_major >= 1),
  capabilities                 jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(capabilities) = 'array'),
  in_flight                    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(in_flight) = 'array'),
  heartbeat                    jsonb       CHECK (heartbeat IS NULL OR jsonb_typeof(heartbeat) = 'object'),
  last_hello_at                timestamptz,
  last_heartbeat_at            timestamptz,
  enrolled_at                  timestamptz NOT NULL,
  state_changed_at             timestamptz NOT NULL,
  state_changed_by_operation_id text       REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  state_reason                 text        CHECK (state_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CHECK ((state = 'pending_binding') = (bind_proof IS NOT NULL)),
  CHECK (state IN ('pending_binding', 'binding_failed') OR bound_at IS NOT NULL OR state IN ('revoked', 'decommissioned'))
);
-- I-6: one node that is not terminal per server.
CREATE UNIQUE INDEX nodes_one_live_per_server ON nodes.nodes (server_id)
  WHERE state IN ('pending_binding', 'active', 'degraded');

CREATE TABLE nodes.jobs (
  job_id             text        PRIMARY KEY CHECK (job_id ~ '^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  node_id            text        NOT NULL REFERENCES nodes.nodes (node_id) ON DELETE RESTRICT,
  operation_id       text        NOT NULL REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  capability         text        NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]{0,3}$'),
  envelope           jsonb       NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  args_hash          text        NOT NULL CHECK (args_hash ~ '^sha256:[0-9a-f]{64}$'),
  nonce              text        NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  not_before         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  state              text        NOT NULL CHECK (state IN ('pending', 'dispatched', 'running', 'completed', 'expired',
                                                           'canceled', 'outcome_unknown')),
  dispatched_at      timestamptz,
  started_at         timestamptz,
  lease_expires_at   timestamptz,
  steps              jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  cancel_requested   boolean     NOT NULL DEFAULT false,
  completion         jsonb       CHECK (completion IS NULL OR jsonb_typeof(completion) = 'object'),
  outcome            text        CHECK (outcome IN ('succeeded', 'failed', 'rejected', 'canceled')),
  completed_at       timestamptz,
  node_signature_valid boolean,
  judged_at          timestamptz,
  created_at         timestamptz NOT NULL,
  state_changed_at   timestamptz NOT NULL,
  CHECK (expires_at > not_before AND expires_at - not_before <= interval '60 minutes'),
  CHECK ((completion IS NULL) = (outcome IS NULL)),
  CHECK (state <> 'completed' OR completion IS NOT NULL)
);
CREATE INDEX jobs_by_node_state ON nodes.jobs (node_id, state, created_at);
CREATE INDEX jobs_by_operation ON nodes.jobs (operation_id);

-- ----- guards -----

CREATE FUNCTION nodes.pki_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT FROM secrets.secret_versions v
                WHERE v.secret_id IN (NEW.issuing_ca_key_secret_id, NEW.server_ca_key_secret_id)
                  AND v.consumer <> 'gateway')
       OR (SELECT count(DISTINCT v.secret_id) FROM secrets.secret_versions v
            WHERE v.secret_id IN (NEW.issuing_ca_key_secret_id, NEW.server_ca_key_secret_id)) <> 2 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN01', MESSAGE = 'the agent PKI keys are two distinct gateway-consumer secrets';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'EXN01', MESSAGE = 'the agent PKI record does not change in this release';
END
$fn$;
REVOKE ALL ON FUNCTION nodes.pki_guard() FROM PUBLIC;
CREATE TRIGGER pki_guard BEFORE INSERT OR UPDATE ON nodes.pki FOR EACH ROW EXECUTE FUNCTION nodes.pki_guard();

CREATE FUNCTION nodes.job_key_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT FROM secrets.secret_versions v
                    WHERE v.secret_id = NEW.secret_id AND v.consumer = 'worker' AND v.purpose = 'node.job_key'
                      AND v.subject_id = NEW.key_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN02', MESSAGE = 'a job key is a worker-consumer node.job_key secret of its own key id';
    END IF;
    IF NEW.fingerprint <> 'sha256:' || encode(sha256(NEW.public_key), 'hex') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN02', MESSAGE = 'a job key fingerprint is sha256 of its public key';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.key_id, NEW.public_key, NEW.fingerprint, NEW.secret_id, NEW.created_at)
     IS DISTINCT FROM (OLD.key_id, OLD.public_key, OLD.fingerprint, OLD.secret_id, OLD.created_at)
     OR NOT ((OLD.state = 'active' AND NEW.state = 'retiring') OR (OLD.state = 'retiring' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN02', MESSAGE = 'a job key only moves active → retiring → retired';
  END IF;
  NEW.state_changed_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.job_key_guard() FROM PUBLIC;
CREATE TRIGGER job_keys_guard BEFORE INSERT OR UPDATE ON nodes.job_keys
  FOR EACH ROW EXECUTE FUNCTION nodes.job_key_guard();

CREATE FUNCTION nodes.token_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'created' OR NEW.redeem_hash IS NOT NULL OR NEW.bind_secret_id IS NOT NULL
       OR NEW.issued_at IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'a token is created without a secret';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.token_id, NEW.server_id, NEW.job_keys, NEW.reveal_by, NEW.reveal_until, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.token_id, OLD.server_id, OLD.job_keys, OLD.reveal_by, OLD.reveal_until, OLD.created_at,
      OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'a token keeps its server, anchors and revealer';
  END IF;
  IF OLD.state = 'created' AND NEW.state = 'issued' THEN
    IF clock_timestamp() > OLD.reveal_until THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'the token can no longer be revealed';
    END IF;
    IF NOT EXISTS (SELECT FROM secrets.secret_versions v
                    WHERE v.secret_id = NEW.bind_secret_id AND v.consumer = 'worker' AND v.purpose = 'node.bind_key'
                      AND v.subject_id = NEW.token_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'a bind key is a worker-consumer node.bind_key secret of its own token';
    END IF;
    NEW.issued_at := clock_timestamp();
    NEW.expires_at := NEW.issued_at + interval '30 minutes';
    RETURN NEW;
  END IF;
  IF (NEW.redeem_hash, NEW.bind_secret_id, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.redeem_hash, OLD.bind_secret_id, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'a token''s secret parts are set once, at issue';
  END IF;
  IF OLD.state = 'issued' AND NEW.state = 'used' THEN
    NEW.used_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.state IN ('created', 'issued') AND NEW.state = 'expired' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'EXN03', MESSAGE = 'a token moves created → issued → used, or expires';
END
$fn$;
REVOKE ALL ON FUNCTION nodes.token_guard() FROM PUBLIC;
CREATE TRIGGER enrollment_tokens_guard BEFORE INSERT OR UPDATE ON nodes.enrollment_tokens
  FOR EACH ROW EXECUTE FUNCTION nodes.token_guard();

CREATE FUNCTION nodes.node_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending_binding' OR NEW.bound_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a node starts pending_binding';
    END IF;
    NEW.enrolled_at := clock_timestamp();
    NEW.state_changed_at := NEW.enrolled_at;
    RETURN NEW;
  END IF;
  IF (NEW.node_id, NEW.server_id, NEW.token_id, NEW.node_signing_key, NEW.node_encryption_key, NEW.enrolled_at)
     IS DISTINCT FROM (OLD.node_id, OLD.server_id, OLD.token_id, OLD.node_signing_key, OLD.node_encryption_key,
      OLD.enrolled_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a node keeps its id, server, token and long-term keys';
  END IF;
  IF OLD.state IN ('revoked', 'decommissioned', 'binding_failed') AND NEW IS DISTINCT FROM OLD THEN
    -- A terminal node changes only from revoked to decommissioned.
    IF NOT (OLD.state = 'revoked' AND NEW.state = 'decommissioned') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a terminal node does not change';
    END IF;
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'pending_binding' AND NEW.state IN ('active', 'binding_failed', 'revoked', 'decommissioned'))
            OR (OLD.state = 'active' AND NEW.state IN ('degraded', 'revoked', 'decommissioned'))
            OR (OLD.state = 'degraded' AND NEW.state IN ('active', 'revoked', 'decommissioned'))
            OR (OLD.state = 'revoked' AND NEW.state = 'decommissioned')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a node moves pending_binding → active ⇄ degraded → revoked → decommissioned';
    END IF;
    IF OLD.state = 'pending_binding' AND NEW.state = 'active' THEN
      NEW.bound_at := clock_timestamp();
    END IF;
    IF NEW.state IN ('revoked', 'decommissioned') AND NEW.state_changed_by_operation_id IS NOT DISTINCT FROM OLD.state_changed_by_operation_id THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a revocation or decommissioning names its operation';
    END IF;
    IF OLD.state = 'pending_binding' THEN
      NEW.bind_proof := NULL;
    END IF;
    NEW.state_changed_at := clock_timestamp();
  ELSIF NEW.bound_at IS DISTINCT FROM OLD.bound_at OR NEW.bind_proof IS DISTINCT FROM OLD.bind_proof THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN04', MESSAGE = 'a binding is recorded only by the state change';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.node_guard() FROM PUBLIC;
CREATE TRIGGER nodes_guard BEFORE INSERT OR UPDATE ON nodes.nodes FOR EACH ROW EXECUTE FUNCTION nodes.node_guard();

CREATE FUNCTION nodes.job_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.completion IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a job starts pending';
    END IF;
    IF NOT EXISTS (SELECT FROM nodes.nodes n WHERE n.node_id = NEW.node_id AND n.state IN ('active', 'degraded')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a job is created only for a bound, served node';
    END IF;
    IF NEW.envelope ->> 'jobId' IS DISTINCT FROM NEW.job_id OR NEW.envelope ->> 'nodeId' IS DISTINCT FROM NEW.node_id
       OR NEW.envelope ->> 'operationId' IS DISTINCT FROM NEW.operation_id
       OR NEW.envelope ->> 'argsHash' IS DISTINCT FROM NEW.args_hash OR NEW.envelope ->> 'nonce' IS DISTINCT FROM NEW.nonce
       OR (NEW.envelope -> 'capability' ->> 'name') || '@' || (NEW.envelope -> 'capability' ->> 'major') IS DISTINCT FROM NEW.capability
       OR jsonb_typeof(NEW.envelope -> 'signature') <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a job''s columns are its signed envelope''s';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.job_id, NEW.node_id, NEW.operation_id, NEW.capability, NEW.envelope, NEW.args_hash, NEW.nonce,
      NEW.not_before, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.job_id, OLD.node_id, OLD.operation_id, OLD.capability, OLD.envelope, OLD.args_hash,
      OLD.nonce, OLD.not_before, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a job''s envelope never changes';
  END IF;
  IF OLD.completion IS NOT NULL AND NEW.completion IS DISTINCT FROM OLD.completion THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a completion is recorded once';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'pending' AND NEW.state IN ('dispatched', 'expired', 'canceled'))
            OR (OLD.state = 'dispatched' AND NEW.state IN ('pending', 'running', 'completed', 'expired', 'canceled'))
            OR (OLD.state = 'running' AND NEW.state IN ('completed', 'outcome_unknown'))
            OR (OLD.state = 'outcome_unknown' AND NEW.state = 'completed')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a job moves pending → dispatched → running → completed, or ends';
    END IF;
    NEW.state_changed_at := clock_timestamp();
  END IF;
  IF OLD.node_signature_valid IS NOT NULL AND NEW.node_signature_valid IS DISTINCT FROM OLD.node_signature_valid THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN05', MESSAGE = 'a verdict is recorded once';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.job_guard() FROM PUBLIC;
CREATE TRIGGER jobs_guard BEFORE INSERT OR UPDATE ON nodes.jobs FOR EACH ROW EXECUTE FUNCTION nodes.job_guard();

-- Nothing here is deleted or truncated.
CREATE TRIGGER pki_no_delete BEFORE DELETE ON nodes.pki FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER job_keys_no_delete BEFORE DELETE ON nodes.job_keys FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER enrollment_tokens_no_delete BEFORE DELETE ON nodes.enrollment_tokens FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes.nodes FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER jobs_no_delete BEFORE DELETE ON nodes.jobs FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER pki_no_truncate BEFORE TRUNCATE ON nodes.pki FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER job_keys_no_truncate BEFORE TRUNCATE ON nodes.job_keys FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER enrollment_tokens_no_truncate BEFORE TRUNCATE ON nodes.enrollment_tokens FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER nodes_no_truncate BEFORE TRUNCATE ON nodes.nodes FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER jobs_no_truncate BEFORE TRUNCATE ON nodes.jobs FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- ----- the gateway's writes (control-plane.md §5) -----
-- Each function runs as the schema owner and takes the node's presented
-- certificate: the node must hold it as its current certificate (or, until
-- the current one is first presented, the one its last renewal replaced) and
-- be in a state the request allows. This binds each write to what TLS
-- verified; it stops a faulty gateway, not a compromised one, which can read
-- the certificates: against that, only the transitions below bound what a
-- write can do. Only hello and heartbeat serve a node that is still pending
-- binding (it has no jobs yet). Every comparison is NULL-safe: plpgsql treats
-- an IF on NULL as false.

CREATE FUNCTION nodes.served_node(p_node_id text, p_certificate bytea, p_allow_pending boolean) RETURNS nodes.nodes
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  n nodes.nodes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM nodes.nodes WHERE node_id = p_node_id FOR UPDATE;
  IF NOT FOUND OR p_certificate IS NULL
     OR NOT (n.certificate = p_certificate OR coalesce(n.previous_certificate = p_certificate, false))
     OR NOT (n.state IN ('active', 'degraded') OR (coalesce(p_allow_pending, false) AND n.state = 'pending_binding')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN06', MESSAGE = 'the certificate is not this node''s current one, or the node is not served';
  END IF;
  -- The first use of a renewed certificate retires the one it replaced.
  IF n.previous_certificate IS NOT NULL AND n.certificate = p_certificate THEN
    UPDATE nodes.nodes SET previous_certificate = NULL WHERE node_id = p_node_id;
  END IF;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.served_node(text, bytea, boolean) FROM PUBLIC;

CREATE FUNCTION nodes.enroll(p_node_id text, p_token_id text, p_redeem_hash text, p_tls_key bytea,
                             p_node_signing_key bytea, p_node_encryption_key bytea, p_bind_proof text,
                             p_certificate bytea, p_certificate_expires_at timestamptz, p_host jsonb,
                             p_agent_version text)
  RETURNS TABLE (server_id text, job_keys jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  t nodes.enrollment_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM nodes.enrollment_tokens WHERE token_id = p_token_id FOR UPDATE;
  -- One refusal for every token failure: the answer reveals nothing about a token.
  IF NOT FOUND OR t.state <> 'issued' OR p_redeem_hash IS NULL OR t.redeem_hash IS DISTINCT FROM p_redeem_hash
     OR NOT clock_timestamp() < t.expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN07', MESSAGE = 'enrollment refused';
  END IF;
  IF EXISTS (SELECT FROM nodes.nodes n WHERE n.server_id = t.server_id AND n.state IN ('pending_binding', 'active', 'degraded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN08', MESSAGE = 'the server already has a node';
  END IF;
  INSERT INTO nodes.nodes (node_id, server_id, token_id, state, tls_key, node_signing_key, node_encryption_key,
                           bind_proof, certificate, certificate_expires_at, host, agent_version)
  VALUES (p_node_id, t.server_id, t.token_id, 'pending_binding', p_tls_key, p_node_signing_key, p_node_encryption_key,
          p_bind_proof, p_certificate, p_certificate_expires_at, p_host, p_agent_version);
  UPDATE nodes.enrollment_tokens SET state = 'used', used_by_node_id = p_node_id WHERE token_id = t.token_id;
  RETURN QUERY SELECT t.server_id, t.job_keys;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.enroll(text, text, text, bytea, bytea, bytea, text, bytea, timestamptz, jsonb, text) FROM PUBLIC;

CREATE FUNCTION nodes.hello(p_node_id text, p_certificate bytea, p_host jsonb, p_agent_version text,
                            p_protocol_major integer, p_capabilities jsonb, p_in_flight jsonb)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  n nodes.nodes%ROWTYPE;
BEGIN
  n := nodes.served_node(p_node_id, p_certificate, true);
  UPDATE nodes.nodes SET host = p_host, agent_version = p_agent_version, protocol_major = p_protocol_major,
         capabilities = p_capabilities, in_flight = p_in_flight, last_hello_at = clock_timestamp()
   WHERE node_id = p_node_id;
  RETURN n.state;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.hello(text, bytea, jsonb, text, integer, jsonb, jsonb) FROM PUBLIC;

CREATE FUNCTION nodes.heartbeat(p_node_id text, p_certificate bytea, p_heartbeat jsonb)
  RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  n nodes.nodes%ROWTYPE;
BEGIN
  n := nodes.served_node(p_node_id, p_certificate, true);
  UPDATE nodes.nodes SET heartbeat = p_heartbeat, last_heartbeat_at = clock_timestamp() WHERE node_id = p_node_id;
  RETURN n.certificate_expires_at;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.heartbeat(text, bytea, jsonb) FROM PUBLIC;

-- A renewal from the current certificate keeps it as the previous one until
-- the new one is presented; a renewal again from that previous one (the agent
-- lost the certificate it was issued) keeps it, and the lost one is never
-- accepted again.
CREATE FUNCTION nodes.renew(p_node_id text, p_certificate bytea, p_tls_key bytea, p_new_certificate bytea,
                            p_new_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  n nodes.nodes%ROWTYPE;
BEGIN
  n := nodes.served_node(p_node_id, p_certificate, false);
  UPDATE nodes.nodes SET tls_key = p_tls_key, certificate = p_new_certificate,
         previous_certificate = CASE WHEN n.certificate = p_certificate THEN n.certificate ELSE n.previous_certificate END,
         certificate_expires_at = p_new_expires_at, certificate_renewed_at = clock_timestamp()
   WHERE node_id = p_node_id;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.renew(text, bytea, bytea, bytea, timestamptz) FROM PUBLIC;

-- Hands out at most one job: the node's oldest pending job within its
-- validity; a dispatched job without a start for 60 s is pending again
-- (the identical envelope, ADR-0024 §4).
CREATE FUNCTION nodes.claim(p_node_id text, p_certificate bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  j nodes.jobs%ROWTYPE;
  now_ timestamptz := clock_timestamp();
BEGIN
  PERFORM nodes.served_node(p_node_id, p_certificate, false);
  UPDATE nodes.jobs SET state = 'pending', dispatched_at = NULL
   WHERE node_id = p_node_id AND state = 'dispatched' AND dispatched_at < now_ - interval '60 seconds';
  UPDATE nodes.jobs SET state = 'expired'
   WHERE node_id = p_node_id AND state IN ('pending', 'dispatched') AND expires_at <= now_;
  -- One job per node at a time: nothing new while another one is out.
  IF EXISTS (SELECT FROM nodes.jobs WHERE node_id = p_node_id AND state IN ('dispatched', 'running')) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO j FROM nodes.jobs
   WHERE node_id = p_node_id AND state = 'pending' AND NOT cancel_requested AND not_before <= now_ + interval '30 seconds'
   ORDER BY created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE nodes.jobs SET state = 'dispatched', dispatched_at = now_ WHERE job_id = j.job_id;
  RETURN j.envelope;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.claim(text, bytea) FROM PUBLIC;

CREATE FUNCTION nodes.start(p_node_id text, p_certificate bytea, p_job_id text)
  RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  lease timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
  PERFORM nodes.served_node(p_node_id, p_certificate, false);
  UPDATE nodes.jobs SET state = 'running', started_at = clock_timestamp(), lease_expires_at = lease
   WHERE job_id = p_job_id AND node_id = p_node_id AND state = 'dispatched' AND NOT cancel_requested;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN09', MESSAGE = 'the job is not dispatched to this node';
  END IF;
  RETURN lease;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.start(text, bytea, text) FROM PUBLIC;

CREATE FUNCTION nodes.progress(p_node_id text, p_certificate bytea, p_job_id text, p_steps jsonb)
  RETURNS TABLE (lease_expires_at timestamptz, cancel_requested boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  PERFORM nodes.served_node(p_node_id, p_certificate, false);
  RETURN QUERY
  UPDATE nodes.jobs j SET lease_expires_at = clock_timestamp() + interval '60 seconds', steps = p_steps
   WHERE j.job_id = p_job_id AND j.node_id = p_node_id AND j.state = 'running'
  RETURNING j.lease_expires_at, j.cancel_requested;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN09', MESSAGE = 'the job is not running on this node';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.progress(text, bytea, text, jsonb) FROM PUBLIC;

-- Records a completion as received; the verdict on its node signature is the
-- worker's. A repeated completion is a duplicate, never a second record.
CREATE FUNCTION nodes.complete(p_node_id text, p_certificate bytea, p_job_id text, p_completion jsonb)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  j nodes.jobs%ROWTYPE;
BEGIN
  PERFORM nodes.served_node(p_node_id, p_certificate, false);
  SELECT * INTO j FROM nodes.jobs WHERE job_id = p_job_id AND node_id = p_node_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN09', MESSAGE = 'no such job for this node';
  END IF;
  IF j.completion IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;
  IF p_completion ->> 'jobId' IS DISTINCT FROM p_job_id OR p_completion ->> 'nodeId' IS DISTINCT FROM p_node_id
     OR coalesce(p_completion ->> 'outcome', '') NOT IN ('succeeded', 'failed', 'rejected', 'canceled') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXN09', MESSAGE = 'the completion is for another job';
  END IF;
  IF j.state NOT IN ('dispatched', 'running', 'outcome_unknown') THEN
    -- A late result for an expired or canceled job is kept for the worker's
    -- judgment but changes nothing.
    UPDATE nodes.jobs SET completion = p_completion, outcome = p_completion ->> 'outcome',
           completed_at = clock_timestamp()
     WHERE job_id = p_job_id;
    RETURN 'late';
  END IF;
  UPDATE nodes.jobs SET state = 'completed', completion = p_completion, outcome = p_completion ->> 'outcome',
         completed_at = clock_timestamp()
   WHERE job_id = p_job_id;
  RETURN 'accepted';
END
$fn$;
REVOKE ALL ON FUNCTION nodes.complete(text, bytea, text, jsonb) FROM PUBLIC;

-- ----- the worker's sweep -----
-- A running job whose lease ran out has an unknown outcome; nothing pending
-- outlives its envelope.
CREATE FUNCTION nodes.sweep_jobs() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  changed integer;
  more    integer;
BEGIN
  UPDATE nodes.jobs SET state = 'outcome_unknown'
   WHERE state = 'running' AND lease_expires_at < clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  UPDATE nodes.jobs SET state = 'expired'
   WHERE state IN ('pending', 'dispatched') AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS more = ROW_COUNT;
  RETURN changed + more;
END
$fn$;
REVOKE ALL ON FUNCTION nodes.sweep_jobs() FROM PUBLIC;

-- ----- privileges -----
-- serve reads node state for the interfaces and issues tokens (reveal);
-- the worker creates tokens, binds and revokes nodes, signs jobs and judges
-- results; the gateway reads what the agent API needs and writes only
-- through the functions above.
GRANT SELECT ON nodes.pki, nodes.job_keys, nodes.nodes, nodes.jobs TO exdb_serve, exdb_worker;
GRANT SELECT ON nodes.enrollment_tokens TO exdb_serve, exdb_worker;
GRANT UPDATE (state, redeem_hash, bind_secret_id) ON nodes.enrollment_tokens TO exdb_serve;
GRANT INSERT ON nodes.pki, nodes.job_keys, nodes.enrollment_tokens, nodes.jobs TO exdb_worker;
GRANT UPDATE (state) ON nodes.job_keys TO exdb_worker;
GRANT UPDATE (state) ON nodes.enrollment_tokens TO exdb_worker;
GRANT UPDATE (state, state_changed_by_operation_id, state_reason) ON nodes.nodes TO exdb_worker;
GRANT UPDATE (state, cancel_requested, node_signature_valid, judged_at) ON nodes.jobs TO exdb_worker;
GRANT EXECUTE ON FUNCTION nodes.sweep_jobs() TO exdb_worker;
GRANT SELECT ON nodes.pki TO exdb_gateway;
GRANT SELECT (key_id, public_key, fingerprint, state) ON nodes.job_keys TO exdb_gateway;
GRANT SELECT (node_id, server_id, state, tls_key, node_signing_key, certificate, certificate_expires_at)
  ON nodes.nodes TO exdb_gateway;
GRANT EXECUTE ON FUNCTION nodes.enroll(text, text, text, bytea, bytea, bytea, text, bytea, timestamptz, jsonb, text),
  nodes.hello(text, bytea, jsonb, text, integer, jsonb, jsonb), nodes.heartbeat(text, bytea, jsonb),
  nodes.renew(text, bytea, bytea, bytea, timestamptz), nodes.claim(text, bytea), nodes.start(text, bytea, text),
  nodes.progress(text, bytea, text, jsonb), nodes.complete(text, bytea, text, jsonb)
  TO exdb_gateway;
