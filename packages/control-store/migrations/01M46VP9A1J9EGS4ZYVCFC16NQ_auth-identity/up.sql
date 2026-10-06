-- Identity and authentication state (identity.md, Wave 3A). Owner:
-- exdb_migrate. Nothing is granted to PUBLIC.
--
-- Rules carried by this schema (the database enforces them whatever the
-- caller does; packages/auth enforces them first and gives the errors):
-- * bearer-style secrets (session tokens, CSRF tokens, one-time links,
--   ceremony handles, recovery codes) are stored as SHA-256 hashes only;
--   passwords as Argon2id strings; TOTP secrets in the secrets store
--   (consumer auth), referenced by id;
-- * every expiry is computed from the database clock by a trigger, never
--   taken from the caller;
-- * one-time things are consumed once: a consumed, redeemed or invalidated
--   row never becomes usable again;
-- * serve runs the ceremonies and the self-service changes; the worker runs
--   the planned access operations (enable, erase); each login may change
--   only what its process needs (EXU01 to EXU05).
CREATE SCHEMA auth AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO exdb_serve, exdb_worker;

-- Identity providers (federation.md §4): `local` only in V1. An external
-- (OIDC) provider can be recorded but not enabled without a later bundle.
CREATE TABLE auth.identity_providers (
  provider_id text        PRIMARY KEY CHECK (provider_id ~ '^[a-z][a-z0-9_-]{0,31}$'),
  kind        text        NOT NULL CHECK (kind IN ('local', 'oidc')),
  issuer      text        CHECK (issuer IS NULL OR (char_length(issuer) <= 512 AND issuer ~ '^https://[^[:space:][:cntrl:]]+$')),
  enabled     boolean     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'local') = (issuer IS NULL)),
  CHECK (kind = 'local' OR NOT enabled)
);
INSERT INTO auth.identity_providers (provider_id, kind, issuer, enabled) VALUES ('local', 'local', NULL, true);
CREATE TRIGGER identity_providers_append_only BEFORE UPDATE OR DELETE ON auth.identity_providers
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER identity_providers_no_truncate BEFORE TRUNCATE ON auth.identity_providers
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Pseudonymous labels `human #<n>` (audit.md §6): assigned once, never reused.
CREATE SEQUENCE auth.identity_labels AS bigint START 1 MINVALUE 1 MAXVALUE 9999999999 NO CYCLE;

-- Identities (identity.md §1). E-mail is contact data, never an identifier:
-- external subjects map by (issuer, sub). Erasure removes every personal
-- field; the id and the label stay for history (audit.md §6).
CREATE TABLE auth.identities (
  identity_id          text        PRIMARY KEY CHECK (identity_id ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind                 text        NOT NULL CHECK (kind IN ('human', 'service')),
  label_number         bigint      NOT NULL UNIQUE DEFAULT nextval('auth.identity_labels'),
  state                text        NOT NULL CHECK (state IN ('invited', 'active', 'disabled', 'erased')),
  email                text        CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254
                                          AND email !~ '[[:cntrl:][:space:]]' AND email ~ '^[^@]+@[^@]+$')),
  email_normalized     text,
  display_name         text        CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 128
                                          AND display_name !~ '[[:cntrl:]]')),
  webauthn_user_handle bytea       UNIQUE CHECK (webauthn_user_handle IS NULL OR octet_length(webauthn_user_handle) = 32),
  bootstrap            boolean     NOT NULL DEFAULT false,
  recovery_required    boolean     NOT NULL DEFAULT false,
  session_epoch        integer     NOT NULL DEFAULT 1 CHECK (session_epoch >= 1),
  authz_revision       bigint      NOT NULL DEFAULT 1 CHECK (authz_revision >= 1),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at         timestamptz,
  disabled_at          timestamptz,
  erased_at            timestamptz,
  state_changed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((email IS NULL) = (email_normalized IS NULL)),
  CHECK (email_normalized IS NULL OR email_normalized = lower(email)),
  CHECK (state <> 'erased' OR (email IS NULL AND display_name IS NULL AND webauthn_user_handle IS NULL)),
  CHECK (state = 'erased' OR kind <> 'human' OR (email IS NOT NULL AND webauthn_user_handle IS NOT NULL)),
  CHECK (kind = 'human' OR NOT bootstrap)
);
CREATE UNIQUE INDEX identities_email ON auth.identities (email_normalized) WHERE email_normalized IS NOT NULL;
-- At most one first-owner bootstrap identity waits for its setup at a time.
CREATE UNIQUE INDEX identities_one_pending_bootstrap ON auth.identities (bootstrap) WHERE bootstrap AND state = 'invited';

CREATE FUNCTION auth.identity_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'invited' OR NEW.recovery_required OR NEW.session_epoch <> 1 OR NEW.authz_revision <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'an identity starts invited, without history';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    NEW.activated_at := NULL;
    NEW.disabled_at := NULL;
    NEW.erased_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.state = 'erased' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'an erased identity never changes';
  END IF;
  IF (NEW.identity_id, NEW.kind, NEW.label_number, NEW.bootstrap, NEW.created_at)
     IS DISTINCT FROM (OLD.identity_id, OLD.kind, OLD.label_number, OLD.bootstrap, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'identity id, kind, label and origin are immutable';
  END IF;
  IF NEW.session_epoch < OLD.session_epoch OR NEW.authz_revision < OLD.authz_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'session epoch and authorization revision only grow';
  END IF;
  IF NEW.webauthn_user_handle IS DISTINCT FROM OLD.webauthn_user_handle AND NEW.state <> 'erased' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'the WebAuthn user handle changes only by erasure';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email AND NOT (OLD.state = 'invited' OR NEW.state = 'erased') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'the e-mail address changes only before activation or by erasure';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF (OLD.state, NEW.state) NOT IN (('invited', 'active'), ('invited', 'disabled'), ('invited', 'erased'),
                                      ('active', 'disabled'), ('active', 'erased'),
                                      ('disabled', 'active'), ('disabled', 'erased')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'identity state transition not allowed';
    END IF;
    -- serve activates through enrollment and disables; enabling and erasure
    -- are planned operations that only the worker executes.
    IF current_user = 'exdb_serve' AND (OLD.state, NEW.state) NOT IN
       (('invited', 'active'), ('invited', 'disabled'), ('active', 'disabled')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'serve may only activate an invited identity or disable one';
    END IF;
    IF current_user = 'exdb_worker' AND NOT (NEW.state = 'erased' OR (OLD.state, NEW.state) = ('disabled', 'active')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'the worker may only enable a disabled identity or erase one';
    END IF;
    NEW.state_changed_at := clock_timestamp();
    IF NEW.state = 'active' AND OLD.state = 'invited' THEN
      NEW.activated_at := NEW.state_changed_at;
    ELSIF NEW.state = 'disabled' THEN
      NEW.disabled_at := NEW.state_changed_at;
    ELSIF NEW.state = 'erased' THEN
      NEW.erased_at := NEW.state_changed_at;
    END IF;
  ELSIF (NEW.activated_at, NEW.disabled_at, NEW.erased_at, NEW.state_changed_at)
        IS DISTINCT FROM (OLD.activated_at, OLD.disabled_at, OLD.erased_at, OLD.state_changed_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'lifecycle times are set by the database';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.identity_guard() FROM PUBLIC;
CREATE TRIGGER identities_guard BEFORE INSERT OR UPDATE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION auth.identity_guard();
CREATE TRIGGER identities_no_delete BEFORE DELETE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER identities_no_truncate BEFORE TRUNCATE ON auth.identities
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- External subjects (federation.md §4): (issuer, sub) → identity, never an
-- e-mail address. Data model only in V1: no runtime login may link one.
CREATE TABLE auth.external_subjects (
  provider_id text        NOT NULL REFERENCES auth.identity_providers (provider_id) ON DELETE RESTRICT,
  issuer      text        NOT NULL CHECK (char_length(issuer) BETWEEN 9 AND 512),
  subject     text        NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255 AND subject !~ '[[:cntrl:]]'),
  identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX external_subjects_by_identity ON auth.external_subjects (identity_id);
CREATE FUNCTION auth.external_subject_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT FROM auth.identity_providers p
                  WHERE p.provider_id = NEW.provider_id AND p.kind = 'oidc' AND p.issuer = NEW.issuer) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU01', MESSAGE = 'an external subject belongs to an OIDC provider with its issuer';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.external_subject_guard() FROM PUBLIC;
CREATE TRIGGER external_subjects_guard BEFORE INSERT ON auth.external_subjects
  FOR EACH ROW EXECUTE FUNCTION auth.external_subject_guard();
CREATE TRIGGER external_subjects_no_update BEFORE UPDATE ON auth.external_subjects
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER external_subjects_no_truncate BEFORE TRUNCATE ON auth.external_subjects
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Authentication factors (identity.md §2): passkeys (public key material,
-- not secret), the Argon2id password string, the TOTP secret reference,
-- and the recovery code set. A factor is `pending` while it is being
-- enrolled and `active` once usable. Removal deletes the row.
CREATE TABLE auth.factors (
  factor_id           text        PRIMARY KEY CHECK (factor_id ~ '^fac_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id         text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  kind                text        NOT NULL CHECK (kind IN ('passkey', 'password', 'totp', 'recovery_codes')),
  state               text        NOT NULL CHECK (state IN ('pending', 'active')),
  label               text        CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]')),
  credential_id       bytea       UNIQUE CHECK (credential_id IS NULL OR octet_length(credential_id) BETWEEN 16 AND 1023),
  public_key          bytea       CHECK (public_key IS NULL OR octet_length(public_key) BETWEEN 16 AND 4096),
  sign_count          bigint      CHECK (sign_count IS NULL OR sign_count BETWEEN 0 AND 4294967295),
  transports          text[]      CHECK (transports IS NULL OR (cardinality(transports) <= 8
                                         AND transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])),
  backed_up           boolean,
  device_type         text        CHECK (device_type IS NULL OR device_type IN ('singleDevice', 'multiDevice')),
  password_hash       text        CHECK (password_hash IS NULL OR password_hash ~
                                     '^\$argon2id\$v=19\$m=[0-9]{1,8},t=[0-9]{1,3},p=[0-9]{1,2}\$[A-Za-z0-9+/]{16,64}\$[A-Za-z0-9+/]{16,128}$'),
  totp_secret_id      text        CHECK (totp_secret_id IS NULL OR totp_secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  totp_secret_version integer     CHECK (totp_secret_version IS NULL OR totp_secret_version >= 1),
  totp_last_step      bigint      CHECK (totp_last_step IS NULL OR totp_last_step >= 0),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at        timestamptz,
  last_used_at        timestamptz,
  CHECK ((kind = 'passkey') = (credential_id IS NOT NULL)),
  CHECK ((kind = 'passkey') = (public_key IS NOT NULL AND sign_count IS NOT NULL
                               AND backed_up IS NOT NULL AND device_type IS NOT NULL)),
  CHECK (kind = 'passkey' OR (transports IS NULL AND label IS NULL)),
  CHECK ((kind = 'password') = (password_hash IS NOT NULL)),
  CHECK ((kind = 'totp') = (totp_secret_id IS NOT NULL AND totp_secret_version IS NOT NULL)),
  CHECK (kind = 'totp' OR totp_last_step IS NULL),
  CHECK ((state = 'active') = (confirmed_at IS NOT NULL))
);
CREATE INDEX factors_by_identity ON auth.factors (identity_id, kind);
CREATE UNIQUE INDEX factors_one_password ON auth.factors (identity_id) WHERE kind = 'password';
CREATE UNIQUE INDEX factors_one_active_totp ON auth.factors (identity_id) WHERE kind = 'totp' AND state = 'active';
CREATE UNIQUE INDEX factors_one_pending_totp ON auth.factors (identity_id) WHERE kind = 'totp' AND state = 'pending';
CREATE UNIQUE INDEX factors_one_recovery_set ON auth.factors (identity_id) WHERE kind = 'recovery_codes';

CREATE FUNCTION auth.factor_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.last_used_at := NULL;
    IF NEW.state = 'active' THEN
      NEW.confirmed_at := NEW.created_at;
    ELSE
      NEW.confirmed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.factor_id, NEW.identity_id, NEW.kind, NEW.credential_id, NEW.public_key, NEW.password_hash,
      NEW.totp_secret_id, NEW.totp_secret_version, NEW.created_at, NEW.device_type)
     IS DISTINCT FROM
     (OLD.factor_id, OLD.identity_id, OLD.kind, OLD.credential_id, OLD.public_key, OLD.password_hash,
      OLD.totp_secret_id, OLD.totp_secret_version, OLD.created_at, OLD.device_type) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'factor material is immutable: a new value is a new factor';
  END IF;
  IF OLD.state = 'active' AND NEW.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'an active factor never returns to pending';
  END IF;
  IF NEW.state = 'active' AND OLD.state = 'pending' THEN
    NEW.confirmed_at := clock_timestamp();
  ELSIF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'the confirmation time is set by the database';
  END IF;
  -- A replayed TOTP step or a counter that goes backwards is refused here
  -- too; signature counters of synchronized passkeys stay 0.
  IF NEW.totp_last_step < OLD.totp_last_step OR (OLD.totp_last_step IS NOT NULL AND NEW.totp_last_step IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'the last accepted TOTP step only grows';
  END IF;
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'the signature counter never goes backwards';
  END IF;
  IF NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
    NEW.last_used_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.factor_guard() FROM PUBLIC;
CREATE TRIGGER factors_guard BEFORE INSERT OR UPDATE ON auth.factors
  FOR EACH ROW EXECUTE FUNCTION auth.factor_guard();
CREATE TRIGGER factors_no_truncate BEFORE TRUNCATE ON auth.factors
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Recovery codes (identity.md §2): ten per set, SHA-256 of a 80-bit code,
-- consumed once (used_at set once, never cleared). Deleted with their set.
CREATE TABLE auth.recovery_codes (
  factor_id  text        NOT NULL REFERENCES auth.factors (factor_id) ON DELETE CASCADE,
  code_index smallint    NOT NULL CHECK (code_index BETWEEN 1 AND 10),
  code_hash  text        NOT NULL CHECK (code_hash ~ '^sha256:[0-9a-f]{64}$'),
  used_at    timestamptz,
  PRIMARY KEY (factor_id, code_index),
  UNIQUE (factor_id, code_hash)
);
CREATE FUNCTION auth.recovery_code_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.used_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.factor_id, NEW.code_index, NEW.code_hash) IS DISTINCT FROM (OLD.factor_id, OLD.code_index, OLD.code_hash)
     OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU02', MESSAGE = 'a recovery code is used once and never changes otherwise';
  END IF;
  NEW.used_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.recovery_code_guard() FROM PUBLIC;
CREATE TRIGGER recovery_codes_guard BEFORE INSERT OR UPDATE ON auth.recovery_codes
  FOR EACH ROW EXECUTE FUNCTION auth.recovery_code_guard();
CREATE TRIGGER recovery_codes_no_truncate BEFORE TRUNCATE ON auth.recovery_codes
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- One-time links (identity.md §6, bootstrap.md §3): first-owner setup and
-- out-of-band recovery live exactly 30 minutes, invitations 24 hours, from
-- the database clock. A link is redeemed once or invalidated; at most one
-- live link per identity and kind, so issuing a new one must invalidate
-- the old one in the same transaction.
CREATE TABLE auth.capabilities (
  capability_id         text        PRIMARY KEY CHECK (capability_id ~ '^cap_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind                  text        NOT NULL CHECK (kind IN ('setup', 'invitation', 'recovery')),
  identity_id           text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  token_hash            text        NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  issued_by_identity_id text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  redeemed_at           timestamptz,
  invalidated_at        timestamptz,
  CHECK (expires_at = created_at + CASE kind WHEN 'invitation' THEN interval '24 hours' ELSE interval '30 minutes' END),
  CHECK (redeemed_at IS NULL OR invalidated_at IS NULL),
  CHECK ((kind = 'invitation') = (issued_by_identity_id IS NOT NULL))
);
CREATE UNIQUE INDEX capabilities_one_live ON auth.capabilities (identity_id, kind)
  WHERE redeemed_at IS NULL AND invalidated_at IS NULL;
CREATE FUNCTION auth.capability_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + CASE NEW.kind WHEN 'invitation' THEN interval '24 hours' ELSE interval '30 minutes' END;
    NEW.redeemed_at := NULL;
    NEW.invalidated_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.capability_id, NEW.kind, NEW.identity_id, NEW.token_hash, NEW.issued_by_identity_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.capability_id, OLD.kind, OLD.identity_id, OLD.token_hash, OLD.issued_by_identity_id, OLD.created_at, OLD.expires_at)
     OR OLD.redeemed_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU03', MESSAGE = 'a one-time link is redeemed or invalidated once and never changes otherwise';
  END IF;
  IF NEW.redeemed_at IS NOT NULL THEN
    IF OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU03', MESSAGE = 'an expired link cannot be redeemed';
    END IF;
    NEW.redeemed_at := clock_timestamp();
  ELSIF NEW.invalidated_at IS NOT NULL THEN
    NEW.invalidated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.capability_guard() FROM PUBLIC;
CREATE TRIGGER capabilities_guard BEFORE INSERT OR UPDATE ON auth.capabilities
  FOR EACH ROW EXECUTE FUNCTION auth.capability_guard();
CREATE TRIGGER capabilities_no_delete BEFORE DELETE ON auth.capabilities
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER capabilities_no_truncate BEFORE TRUNCATE ON auth.capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Web sessions (identity.md §3). The cookie value and the CSRF token are
-- stored as SHA-256 hashes; `ses_` ids are public (UI, audit). Idle timeout
-- 30 minutes from the last request, absolute lifetime 12 hours from
-- creation, both on the database clock. A session belongs to the identity's
-- session epoch at creation: raising the epoch ends every older session.
CREATE TABLE auth.web_sessions (
  session_id          text        PRIMARY KEY CHECK (session_id ~ '^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id         text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  token_hash          text        NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  csrf_hash           text        NOT NULL CHECK (csrf_hash ~ '^sha256:[0-9a-f]{64}$'),
  secret_generation   integer     NOT NULL DEFAULT 1 CHECK (secret_generation >= 1),
  session_epoch       integer     NOT NULL CHECK (session_epoch >= 1),
  assurance           text        NOT NULL CHECK (assurance IN ('full', 'recovery')),
  device_label        text        CHECK (device_label IS NULL OR (char_length(device_label) BETWEEN 1 AND 64 AND device_label !~ '[[:cntrl:]]')),
  created_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  rotated_at          timestamptz,
  reauth_at           timestamptz,
  reauth_event_id     text        CHECK (reauth_event_id IS NULL OR reauth_event_id ~ '^rau_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  revoked_at          timestamptz,
  revoke_reason       text        CHECK (revoke_reason IS NULL OR revoke_reason IN
                                     ('logout', 'self_revoked', 'others_revoked', 'identity_disabled', 'identity_erased',
                                      'recovery', 'factors_changed', 'out_of_band_recovery')),
  CHECK (absolute_expires_at = created_at + interval '12 hours'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK ((reauth_at IS NULL) = (reauth_event_id IS NULL))
);
CREATE INDEX web_sessions_live_by_identity ON auth.web_sessions (identity_id) WHERE revoked_at IS NULL;
CREATE FUNCTION auth.session_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  epoch integer;
  identity_state text;
  proof timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT i.session_epoch, i.state INTO epoch, identity_state FROM auth.identities i WHERE i.identity_id = NEW.identity_id;
    IF identity_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'a session is issued to an active identity only';
    END IF;
    NEW.session_epoch := epoch;
    NEW.secret_generation := 1;
    NEW.created_at := clock_timestamp();
    NEW.absolute_expires_at := NEW.created_at + interval '12 hours';
    NEW.last_seen_at := NEW.created_at;
    NEW.rotated_at := NULL;
    NEW.revoked_at := NULL;
    NEW.revoke_reason := NULL;
  ELSE
    IF OLD.revoked_at IS NOT NULL THEN
      -- Erasure (identity.md §7) may clear the coarse device label of a revoked
      -- session; nothing else of a revoked session ever changes.
      IF NEW.device_label IS NULL AND OLD.device_label IS NOT NULL
         AND (to_jsonb(NEW) - 'device_label') = (to_jsonb(OLD) - 'device_label') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'a revoked session never changes';
    END IF;
    IF (NEW.session_id, NEW.identity_id, NEW.session_epoch, NEW.created_at, NEW.absolute_expires_at)
       IS DISTINCT FROM (OLD.session_id, OLD.identity_id, OLD.session_epoch, OLD.created_at, OLD.absolute_expires_at) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'session identity and lifetime are immutable';
    END IF;
    IF (NEW.token_hash, NEW.csrf_hash) IS DISTINCT FROM (OLD.token_hash, OLD.csrf_hash) THEN
      IF NEW.token_hash = OLD.token_hash OR NEW.csrf_hash = OLD.csrf_hash
         OR NEW.secret_generation <> OLD.secret_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'a rotation replaces both secrets and advances the generation';
      END IF;
      NEW.rotated_at := clock_timestamp();
    ELSIF NEW.secret_generation <> OLD.secret_generation OR NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'the generation moves only with a rotation';
    END IF;
    IF OLD.assurance = 'full' AND NEW.assurance = 'recovery' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'a full session never becomes a recovery session';
    END IF;
    IF NEW.last_seen_at < OLD.last_seen_at THEN
      NEW.last_seen_at := OLD.last_seen_at;
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      NEW.revoked_at := clock_timestamp();
    END IF;
  END IF;
  -- The re-authentication time is the recorded event's own time, for this
  -- session and identity; the caller cannot choose it.
  IF NEW.reauth_event_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.reauth_event_id IS DISTINCT FROM OLD.reauth_event_id) THEN
    SELECT r.occurred_at INTO proof FROM auth.reauth_events r
     WHERE r.reauth_event_id = NEW.reauth_event_id AND r.identity_id = NEW.identity_id
       AND (r.session_id = NEW.session_id OR (TG_OP = 'INSERT' AND r.session_id IS NULL));
    IF proof IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'a re-authentication belongs to its own identity and session';
    END IF;
    NEW.reauth_at := proof;
  ELSIF TG_OP = 'UPDATE' AND NEW.reauth_at IS DISTINCT FROM OLD.reauth_at THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU05', MESSAGE = 'the re-authentication time comes from the recorded event';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.session_guard() FROM PUBLIC;

-- Re-authentication evidence (identity.md §4): a fresh passkey assertion
-- with user verification or a TOTP code (sign-in records one too). Never a
-- password alone. Append-only, time from the database clock. The event of
-- a sign-in is recorded before its session exists (session_id NULL) and is
-- then attached to the new session by the session guard.
CREATE TABLE auth.reauth_events (
  reauth_event_id text        PRIMARY KEY CHECK (reauth_event_id ~ '^rau_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id     text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  session_id      text        REFERENCES auth.web_sessions (session_id) ON DELETE RESTRICT,
  method          text        NOT NULL CHECK (method IN ('passkey', 'totp', 'recovery_code')),
  factor_id       text        NOT NULL CHECK (factor_id ~ '^fac_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  user_verified   boolean     NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (method <> 'passkey' OR user_verified)
);
CREATE INDEX reauth_events_by_session ON auth.reauth_events (session_id, occurred_at DESC);
CREATE FUNCTION auth.reauth_event_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.reauth_event_guard() FROM PUBLIC;
CREATE TRIGGER reauth_events_time BEFORE INSERT ON auth.reauth_events
  FOR EACH ROW EXECUTE FUNCTION auth.reauth_event_guard();
CREATE TRIGGER reauth_events_append_only BEFORE UPDATE OR DELETE ON auth.reauth_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER reauth_events_no_truncate BEFORE TRUNCATE ON auth.reauth_events
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- One re-authentication event backs at most one session.
CREATE UNIQUE INDEX web_sessions_reauth_event ON auth.web_sessions (reauth_event_id) WHERE reauth_event_id IS NOT NULL;
CREATE TRIGGER web_sessions_guard BEFORE INSERT OR UPDATE ON auth.web_sessions
  FOR EACH ROW EXECUTE FUNCTION auth.session_guard();
CREATE TRIGGER web_sessions_no_delete BEFORE DELETE ON auth.web_sessions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER web_sessions_no_truncate BEFORE TRUNCATE ON auth.web_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Ceremony state (challenges): a WebAuthn challenge, the step between
-- password and second factor, and an enrollment through a one-time link.
-- Pre-session ceremonies are found by the hash of an opaque handle kept in
-- an HttpOnly cookie. Lifetimes come from the database clock; a challenge
-- is consumed once. Expired rows are pruned by the worker after a day.
CREATE TABLE auth.challenges (
  challenge_id        text        PRIMARY KEY CHECK (challenge_id ~ '^chl_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind                text        NOT NULL CHECK (kind IN ('passkey_login', 'second_factor', 'passkey_reauth',
                                                            'enrollment', 'passkey_registration')),
  handle_hash         text        UNIQUE CHECK (handle_hash IS NULL OR handle_hash ~ '^sha256:[0-9a-f]{64}$'),
  identity_id         text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  session_id          text        REFERENCES auth.web_sessions (session_id) ON DELETE RESTRICT,
  parent_challenge_id text        REFERENCES auth.challenges (challenge_id) ON DELETE CASCADE,
  capability_id       text        REFERENCES auth.capabilities (capability_id) ON DELETE RESTRICT,
  webauthn_challenge  text        CHECK (webauthn_challenge IS NULL OR webauthn_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  CHECK (expires_at = created_at + CASE kind WHEN 'enrollment' THEN interval '30 minutes' ELSE interval '5 minutes' END),
  CHECK (kind <> 'passkey_login' OR (handle_hash IS NOT NULL AND webauthn_challenge IS NOT NULL AND identity_id IS NULL)),
  CHECK (kind <> 'second_factor' OR (handle_hash IS NOT NULL AND identity_id IS NOT NULL AND webauthn_challenge IS NULL)),
  CHECK (kind <> 'enrollment' OR (handle_hash IS NOT NULL AND identity_id IS NOT NULL AND capability_id IS NOT NULL)),
  CHECK (kind <> 'passkey_registration' OR (identity_id IS NOT NULL AND webauthn_challenge IS NOT NULL
                                            AND (session_id IS NOT NULL) <> (parent_challenge_id IS NOT NULL))),
  CHECK (kind <> 'passkey_reauth' OR (identity_id IS NOT NULL AND session_id IS NOT NULL AND webauthn_challenge IS NOT NULL))
);
CREATE INDEX challenges_by_session ON auth.challenges (session_id, kind) WHERE consumed_at IS NULL;
CREATE INDEX challenges_by_parent ON auth.challenges (parent_challenge_id) WHERE consumed_at IS NULL;
CREATE INDEX challenges_expiry ON auth.challenges (expires_at);
CREATE FUNCTION auth.challenge_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() - interval '1 day' AND (OLD.consumed_at IS NULL OR OLD.consumed_at > clock_timestamp() - interval '1 day') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXU04', MESSAGE = 'only challenges ended more than a day ago are pruned';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + CASE NEW.kind WHEN 'enrollment' THEN interval '30 minutes' ELSE interval '5 minutes' END;
    NEW.consumed_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.challenge_id, NEW.kind, NEW.handle_hash, NEW.identity_id, NEW.session_id, NEW.parent_challenge_id,
      NEW.capability_id, NEW.webauthn_challenge, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.challenge_id, OLD.kind, OLD.handle_hash, OLD.identity_id, OLD.session_id, OLD.parent_challenge_id,
      OLD.capability_id, OLD.webauthn_challenge, OLD.created_at, OLD.expires_at)
     OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXU04', MESSAGE = 'a challenge is consumed once and never changes otherwise';
  END IF;
  NEW.consumed_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION auth.challenge_guard() FROM PUBLIC;
CREATE TRIGGER challenges_guard BEFORE INSERT OR UPDATE OR DELETE ON auth.challenges
  FOR EACH ROW EXECUTE FUNCTION auth.challenge_guard();
CREATE TRIGGER challenges_no_truncate BEFORE TRUNCATE ON auth.challenges
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Authentication rate limits (identity.md §2): failure counters per
-- pseudonymized account address, per pseudonymized client address and per
-- identity. Keys are HMAC values under the installation's rate-limit key;
-- no address is stored. Rows untouched for a day are pruned by the worker.
CREATE TABLE auth.rate_limits (
  bucket            text        PRIMARY KEY CHECK (bucket ~ '^(acct|ip|idn):[A-Za-z0-9_-]{1,96}$'),
  window_started_at timestamptz NOT NULL,
  failures          integer     NOT NULL CHECK (failures >= 0),
  last_failure_at   timestamptz,
  locked_until      timestamptz,
  audited_failures  integer     NOT NULL DEFAULT 0 CHECK (audited_failures >= 0),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rate_limits_updated ON auth.rate_limits (updated_at);
CREATE TRIGGER rate_limits_no_truncate BEFORE TRUNCATE ON auth.rate_limits
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Security notifications (identity.md §2, §6): what must be told to whom,
-- and whether it was delivered. No content, no link, no address: the
-- recipient is resolved at delivery time. Without a configured provider
-- the status is `unavailable`, never `sent`.
CREATE TABLE auth.notifications (
  notification_id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind                  text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length(kind) <= 64),
  recipient_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  subject_identity_id   text        REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  status                text        NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unavailable')),
  error_code            text        CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  status_changed_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notifications_pending ON auth.notifications (created_at) WHERE status = 'pending';
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON auth.notifications
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON auth.notifications
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- References to the installation's keys for keyed pseudonyms (audit.md §1,
-- OD-8): one key for audit IP and user-agent pseudonyms, a separate key for
-- rate-limit buckets (domain separation). The keys themselves are secrets
-- of consumer auth (serve only); this table names them.
CREATE TABLE auth.installation_keys (
  purpose    text        PRIMARY KEY CHECK (purpose IN ('audit.pseudonym_key', 'auth.rate_limit_key')),
  secret_id  text        NOT NULL UNIQUE CHECK (secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER installation_keys_append_only BEFORE UPDATE OR DELETE ON auth.installation_keys
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER installation_keys_no_truncate BEFORE TRUNCATE ON auth.installation_keys
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- Privileges. serve: ceremonies, sessions and self-service; reads every
-- secret-bearing column it verifies against. worker: erasure and enabling
-- (planned operations), pruning; it never reads a password hash, a token
-- hash, a CSRF hash, an e-mail address or a name.
GRANT SELECT ON auth.identity_providers, auth.external_subjects TO exdb_serve, exdb_worker;
GRANT DELETE ON auth.external_subjects TO exdb_worker;

GRANT SELECT, INSERT ON auth.identities TO exdb_serve;
GRANT UPDATE (state, email, email_normalized, display_name, recovery_required, session_epoch)
  ON auth.identities TO exdb_serve;
GRANT USAGE ON SEQUENCE auth.identity_labels TO exdb_serve;
GRANT SELECT (identity_id, kind, label_number, state, bootstrap, recovery_required, session_epoch, authz_revision,
              created_at, activated_at, disabled_at, erased_at, state_changed_at)
  ON auth.identities TO exdb_worker;
GRANT UPDATE (state, email, email_normalized, display_name, webauthn_user_handle, recovery_required,
              session_epoch, authz_revision)
  ON auth.identities TO exdb_worker;

GRANT SELECT, INSERT, DELETE ON auth.factors TO exdb_serve;
GRANT UPDATE (state, label, sign_count, backed_up, transports, totp_last_step, last_used_at)
  ON auth.factors TO exdb_serve;
GRANT SELECT (factor_id, identity_id, kind, state, created_at) ON auth.factors TO exdb_worker;
GRANT DELETE ON auth.factors TO exdb_worker;

GRANT SELECT, INSERT ON auth.recovery_codes TO exdb_serve;
GRANT UPDATE (used_at) ON auth.recovery_codes TO exdb_serve;

GRANT SELECT, INSERT ON auth.capabilities TO exdb_serve;
GRANT UPDATE (redeemed_at, invalidated_at) ON auth.capabilities TO exdb_serve;
GRANT SELECT (capability_id, kind, identity_id, created_at, expires_at, redeemed_at, invalidated_at)
  ON auth.capabilities TO exdb_worker;
GRANT UPDATE (invalidated_at) ON auth.capabilities TO exdb_worker;

GRANT SELECT, INSERT ON auth.web_sessions TO exdb_serve;
GRANT UPDATE (token_hash, csrf_hash, secret_generation, assurance, last_seen_at, reauth_at, reauth_event_id,
              revoked_at, revoke_reason)
  ON auth.web_sessions TO exdb_serve;
GRANT SELECT (session_id, identity_id, created_at, absolute_expires_at, last_seen_at, revoked_at, revoke_reason)
  ON auth.web_sessions TO exdb_worker;
GRANT UPDATE (revoked_at, revoke_reason, device_label) ON auth.web_sessions TO exdb_worker;

GRANT SELECT, INSERT ON auth.reauth_events TO exdb_serve;
GRANT SELECT (reauth_event_id, identity_id, session_id, method, user_verified, occurred_at)
  ON auth.reauth_events TO exdb_worker;

GRANT SELECT, INSERT ON auth.challenges TO exdb_serve;
GRANT UPDATE (consumed_at) ON auth.challenges TO exdb_serve;
GRANT SELECT (challenge_id, kind, identity_id, session_id, created_at, expires_at, consumed_at)
  ON auth.challenges TO exdb_worker;
GRANT UPDATE (consumed_at), DELETE ON auth.challenges TO exdb_worker;

GRANT SELECT, INSERT, UPDATE ON auth.rate_limits TO exdb_serve;
GRANT SELECT (bucket, updated_at), DELETE ON auth.rate_limits TO exdb_worker;

GRANT SELECT, INSERT ON auth.notifications TO exdb_serve, exdb_worker;
GRANT UPDATE (status, error_code, status_changed_at) ON auth.notifications TO exdb_serve, exdb_worker;

GRANT SELECT, INSERT ON auth.installation_keys TO exdb_serve;
