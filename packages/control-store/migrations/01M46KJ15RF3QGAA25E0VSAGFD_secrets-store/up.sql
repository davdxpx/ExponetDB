-- Secrets (secrets.md §2, §4). Owner: exdb_migrate. Key material never
-- enters the Control Store: master keys stay in the keyring of each process,
-- data keys are stored only wrapped, plaintext only in process memory.
CREATE SCHEMA secrets AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA secrets FROM PUBLIC;
GRANT USAGE ON SCHEMA secrets TO exdb_serve, exdb_worker, exdb_gateway;

-- Master key ids and their key check values (HMAC-SHA-256 of a fixed message
-- under the key): a process proves its keyring matches the keys that wrapped
-- the stored data keys without the store ever holding a key.
CREATE TABLE secrets.master_keys (
  key_id        text        PRIMARY KEY CHECK (key_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  check_value   text        NOT NULL CHECK (check_value ~ '^hmac-sha256:[0-9a-f]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per secret version: what it is for and who consumes it. The
-- context (secret id, purpose, subject, version) is the associated data of
-- the ciphertext, so it can never be changed without breaking decryption.
CREATE TABLE secrets.secret_versions (
  secret_id  text        NOT NULL CHECK (secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  version    integer     NOT NULL CHECK (version >= 1),
  purpose    text        NOT NULL CHECK (char_length(purpose) <= 64
                                         AND purpose ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  subject_id text        NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 256
                                         AND subject_id ~ '^[A-Za-z0-9_.:/@-]+$'),
  consumer   text        NOT NULL CHECK (consumer IN ('worker', 'observer', 'auth', 'gateway')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text        NOT NULL,
  PRIMARY KEY (secret_id, version)
);

-- A new version continues its secret: version 1 starts it, version n + 1
-- follows the latest and keeps its purpose, subject and consumer. The
-- creating login is recorded by the database, not by the caller.
CREATE FUNCTION secrets.version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  latest secrets.secret_versions%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM secrets.secret_versions v
   WHERE v.secret_id = NEW.secret_id ORDER BY v.version DESC LIMIT 1;
  IF latest.secret_id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXS01', MESSAGE = 'a secret starts at version 1';
    END IF;
  ELSIF NEW.version <> latest.version + 1
        OR NEW.purpose <> latest.purpose
        OR NEW.subject_id <> latest.subject_id
        OR NEW.consumer <> latest.consumer THEN
    RAISE EXCEPTION USING ERRCODE = 'EXS01', MESSAGE = 'a new version must follow the latest and keep its context';
  END IF;
  NEW.created_by := current_user;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION secrets.version_guard() FROM PUBLIC;
CREATE TRIGGER secret_versions_guard BEFORE INSERT ON secrets.secret_versions
  FOR EACH ROW EXECUTE FUNCTION secrets.version_guard();

-- The data key of each version, wrapped by a master key (AES-256-GCM:
-- 32 bytes + 16-byte tag). Only the re-wrap columns may change, only by the
-- worker's re-wrap job; rows are never deleted.
CREATE TABLE secrets.data_keys (
  secret_id   text        NOT NULL,
  version     integer     NOT NULL,
  key_id      text        NOT NULL REFERENCES secrets.master_keys (key_id) ON DELETE RESTRICT,
  wrap_nonce  bytea       NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrapped_key bytea       NOT NULL CHECK (octet_length(wrapped_key) = 48),
  wrapped_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (secret_id, version),
  FOREIGN KEY (secret_id, version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT
);
CREATE INDEX data_keys_by_key ON secrets.data_keys (key_id);

CREATE FUNCTION secrets.data_key_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.secret_id <> OLD.secret_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION USING ERRCODE = 'EXS01', MESSAGE = 'a data key belongs to its secret version for good';
  END IF;
  NEW.wrapped_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION secrets.data_key_guard() FROM PUBLIC;
CREATE TRIGGER data_keys_guard BEFORE UPDATE ON secrets.data_keys
  FOR EACH ROW EXECUTE FUNCTION secrets.data_key_guard();

-- Ciphertext, one table per consumer (secrets.md §4): the grant on the table
-- decides which process role can decrypt. A row must belong to a version of
-- the same consumer.
CREATE FUNCTION secrets.blob_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM secrets.secret_versions v
                  WHERE v.secret_id = NEW.secret_id AND v.version = NEW.version
                    AND v.consumer = TG_ARGV[0]) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXS02', MESSAGE = 'the secret version belongs to another consumer';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION secrets.blob_guard() FROM PUBLIC;

CREATE TABLE secrets.secret_blobs_worker (
  secret_id  text  NOT NULL,
  version    integer NOT NULL,
  nonce      bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
  PRIMARY KEY (secret_id, version),
  FOREIGN KEY (secret_id, version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT
);
CREATE TABLE secrets.secret_blobs_observer (LIKE secrets.secret_blobs_worker INCLUDING CONSTRAINTS);
ALTER TABLE secrets.secret_blobs_observer ADD PRIMARY KEY (secret_id, version),
  ADD FOREIGN KEY (secret_id, version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT;
CREATE TABLE secrets.secret_blobs_auth (LIKE secrets.secret_blobs_worker INCLUDING CONSTRAINTS);
ALTER TABLE secrets.secret_blobs_auth ADD PRIMARY KEY (secret_id, version),
  ADD FOREIGN KEY (secret_id, version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT;
CREATE TABLE secrets.secret_blobs_gateway (LIKE secrets.secret_blobs_worker INCLUDING CONSTRAINTS);
ALTER TABLE secrets.secret_blobs_gateway ADD PRIMARY KEY (secret_id, version),
  ADD FOREIGN KEY (secret_id, version) REFERENCES secrets.secret_versions (secret_id, version) ON DELETE RESTRICT;

CREATE TRIGGER blobs_worker_consumer BEFORE INSERT ON secrets.secret_blobs_worker
  FOR EACH ROW EXECUTE FUNCTION secrets.blob_guard('worker');
CREATE TRIGGER blobs_observer_consumer BEFORE INSERT ON secrets.secret_blobs_observer
  FOR EACH ROW EXECUTE FUNCTION secrets.blob_guard('observer');
CREATE TRIGGER blobs_auth_consumer BEFORE INSERT ON secrets.secret_blobs_auth
  FOR EACH ROW EXECUTE FUNCTION secrets.blob_guard('auth');
CREATE TRIGGER blobs_gateway_consumer BEFORE INSERT ON secrets.secret_blobs_gateway
  FOR EACH ROW EXECUTE FUNCTION secrets.blob_guard('gateway');

-- Append-only: versions, ciphertext and key registrations never change; a
-- data key changes only through its re-wrap columns and is never deleted.
CREATE TRIGGER master_keys_append_only BEFORE UPDATE OR DELETE ON secrets.master_keys
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER master_keys_no_truncate BEFORE TRUNCATE ON secrets.master_keys
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER secret_versions_append_only BEFORE UPDATE OR DELETE ON secrets.secret_versions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER secret_versions_no_truncate BEFORE TRUNCATE ON secrets.secret_versions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER data_keys_no_delete BEFORE DELETE ON secrets.data_keys
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER data_keys_no_truncate BEFORE TRUNCATE ON secrets.data_keys
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_worker_append_only BEFORE UPDATE OR DELETE ON secrets.secret_blobs_worker
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_worker_no_truncate BEFORE TRUNCATE ON secrets.secret_blobs_worker
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_observer_append_only BEFORE UPDATE OR DELETE ON secrets.secret_blobs_observer
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_observer_no_truncate BEFORE TRUNCATE ON secrets.secret_blobs_observer
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_auth_append_only BEFORE UPDATE OR DELETE ON secrets.secret_blobs_auth
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_auth_no_truncate BEFORE TRUNCATE ON secrets.secret_blobs_auth
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_gateway_append_only BEFORE UPDATE OR DELETE ON secrets.secret_blobs_gateway
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER blobs_gateway_no_truncate BEFORE TRUNCATE ON secrets.secret_blobs_gateway
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Grants (secrets.md §4). Metadata and wrapped keys are readable by the
-- process roles (useless without both a master key and the ciphertext);
-- ciphertext is readable only by its consumers. serve may submit worker
-- secrets write-only; the worker writes gateway secrets write-only.
GRANT SELECT ON secrets.master_keys, secrets.secret_versions, secrets.data_keys
  TO exdb_serve, exdb_worker, exdb_gateway;
GRANT INSERT ON secrets.master_keys, secrets.secret_versions, secrets.data_keys
  TO exdb_serve, exdb_worker;
GRANT UPDATE (key_id, wrap_nonce, wrapped_key, wrapped_at) ON secrets.data_keys TO exdb_worker;
GRANT SELECT, INSERT ON secrets.secret_blobs_worker TO exdb_worker;
GRANT INSERT ON secrets.secret_blobs_worker TO exdb_serve;
GRANT SELECT, INSERT ON secrets.secret_blobs_observer TO exdb_worker, exdb_serve;
GRANT SELECT, INSERT ON secrets.secret_blobs_auth TO exdb_serve;
GRANT SELECT ON secrets.secret_blobs_gateway TO exdb_gateway;
GRANT INSERT ON secrets.secret_blobs_gateway TO exdb_worker;
