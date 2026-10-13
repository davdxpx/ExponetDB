-- Identity profiles (owner decision S10 of 2026-10-13; identity.md §12).
-- Owner: exdb_migrate. A profile is personal data a person chose: a display
-- name and a picture. Both are untrusted: stored and shown, never
-- interpreted; neither is ever written to the audit (audit.md §6). Erasure
-- deletes the row (identity.md §7).
CREATE SCHEMA profiles AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA profiles FROM PUBLIC;
GRANT USAGE ON SCHEMA profiles TO exdb_serve, exdb_worker;

CREATE TABLE profiles.identity_profiles (
  identity_id       text        PRIMARY KEY REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  display_name      text        CHECK (display_name IS NULL OR (
                                  char_length(display_name) BETWEEN 1 AND 64
                                  AND display_name !~ '[[:cntrl:]\u0080-\u009f​-‏ -‮⁠-⁩﻿]'
                                  AND display_name ~ '^[^[:space:]](.*[^[:space:]])?$')),
  avatar            bytea       CHECK (avatar IS NULL OR octet_length(avatar) BETWEEN 1 AND 262144),
  avatar_media_type text        CHECK (avatar_media_type IS NULL
                                       OR avatar_media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  avatar_sha256     text,
  avatar_width      integer     CHECK (avatar_width IS NULL OR avatar_width BETWEEN 32 AND 1024),
  avatar_height     integer     CHECK (avatar_height IS NULL OR avatar_height BETWEEN 32 AND 1024),
  revision          integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A picture is complete or absent.
  CHECK ((avatar IS NULL) = (avatar_media_type IS NULL)
         AND (avatar IS NULL) = (avatar_sha256 IS NULL)
         AND (avatar IS NULL) = (avatar_width IS NULL)
         AND (avatar IS NULL) = (avatar_height IS NULL)),
  -- The hash is the hash of the bytes (it keys the cached address).
  CHECK (avatar IS NULL OR avatar_sha256 = 'sha256:' || encode(sha256(avatar), 'hex')),
  -- The bytes start like their media type (the server parses the whole image structure first).
  CHECK (avatar IS NULL
         OR (avatar_media_type = 'image/png' AND substring(avatar FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea)
         OR (avatar_media_type = 'image/jpeg' AND substring(avatar FROM 1 FOR 3) = '\xffd8ff'::bytea)
         OR (avatar_media_type = 'image/webp' AND substring(avatar FROM 1 FOR 4) = '\x52494646'::bytea
             AND substring(avatar FROM 9 FOR 4) = '\x57454250'::bytea)),
  CHECK (updated_at >= created_at)
);

-- The identity never changes; a change raises the revision by exactly one;
-- the times are the database's; a profile is changed only for an active
-- person and removed only with the erasure of its identity. Security
-- definer: it reads the identity's state whoever writes.
CREATE FUNCTION profiles.identity_profiles_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT FROM auth.identities i
                    WHERE i.identity_id = OLD.identity_id AND i.state = 'erased') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXF01', MESSAGE = 'a profile is removed only with the erasure of its identity';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT FROM auth.identities i
                  WHERE i.identity_id = NEW.identity_id AND i.kind = 'human' AND i.state = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXF02', MESSAGE = 'only an active person changes a profile';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.identity_id, NEW.created_at) IS DISTINCT FROM (OLD.identity_id, OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXF01',
      MESSAGE = 'a profile keeps its identity; a change raises its revision by one';
  END IF;
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION profiles.identity_profiles_guard() FROM PUBLIC;
CREATE TRIGGER identity_profiles_guard BEFORE INSERT OR UPDATE OR DELETE ON profiles.identity_profiles
  FOR EACH ROW EXECUTE FUNCTION profiles.identity_profiles_guard();
CREATE TRIGGER identity_profiles_no_truncate BEFORE TRUNCATE ON profiles.identity_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- The display name of a person at the revision the change is based on (0
-- while there is no profile): EXF03 when it moved on, EXF02 (the guard)
-- when the identity is no active person. Returns the new revision.
CREATE FUNCTION profiles.set_display_name(p_identity_id text, p_revision integer, p_display_name text)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  current_revision integer;
  next_revision integer;
BEGIN
  SELECT p.revision INTO current_revision
    FROM profiles.identity_profiles p WHERE p.identity_id = p_identity_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_revision IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXF03', MESSAGE = 'the profile changed since that revision';
    END IF;
    INSERT INTO profiles.identity_profiles (identity_id, display_name) VALUES (p_identity_id, p_display_name)
    ON CONFLICT (identity_id) DO NOTHING
    RETURNING revision INTO next_revision;
    IF next_revision IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXF03', MESSAGE = 'the profile changed since that revision';
    END IF;
    RETURN next_revision;
  END IF;
  IF current_revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'EXF03', MESSAGE = 'the profile changed since that revision';
  END IF;
  UPDATE profiles.identity_profiles p
     SET display_name = p_display_name, revision = p.revision + 1
   WHERE p.identity_id = p_identity_id
  RETURNING p.revision INTO next_revision;
  RETURN next_revision;
END
$fn$;
REVOKE ALL ON FUNCTION profiles.set_display_name(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION profiles.set_display_name(text, integer, text) TO exdb_serve;

-- The picture of a person, replacing any earlier one. Returns the new revision.
CREATE FUNCTION profiles.set_avatar(p_identity_id text, p_avatar bytea, p_media_type text,
                                    p_sha256 text, p_width integer, p_height integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  next_revision integer;
BEGIN
  INSERT INTO profiles.identity_profiles AS p
         (identity_id, avatar, avatar_media_type, avatar_sha256, avatar_width, avatar_height)
  VALUES (p_identity_id, p_avatar, p_media_type, p_sha256, p_width, p_height)
  ON CONFLICT (identity_id) DO UPDATE
     SET avatar = excluded.avatar, avatar_media_type = excluded.avatar_media_type,
         avatar_sha256 = excluded.avatar_sha256, avatar_width = excluded.avatar_width,
         avatar_height = excluded.avatar_height, revision = p.revision + 1
  RETURNING p.revision INTO next_revision;
  RETURN next_revision;
END
$fn$;
REVOKE ALL ON FUNCTION profiles.set_avatar(text, bytea, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION profiles.set_avatar(text, bytea, text, text, integer, integer) TO exdb_serve;

-- Removes the picture of a person. Returns the new revision, or NULL when
-- there was none (nothing changes).
CREATE FUNCTION profiles.clear_avatar(p_identity_id text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  next_revision integer;
BEGIN
  UPDATE profiles.identity_profiles p
     SET avatar = NULL, avatar_media_type = NULL, avatar_sha256 = NULL,
         avatar_width = NULL, avatar_height = NULL, revision = p.revision + 1
   WHERE p.identity_id = p_identity_id AND p.avatar IS NOT NULL
  RETURNING p.revision INTO next_revision;
  RETURN next_revision;
END
$fn$;
REVOKE ALL ON FUNCTION profiles.clear_avatar(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION profiles.clear_avatar(text) TO exdb_serve;

-- serve reads (it serves the pictures); it holds no INSERT, UPDATE or DELETE.
GRANT SELECT ON profiles.identity_profiles TO exdb_serve;
-- The worker deletes the profile of an identity it erases and checks that it
-- is gone; it never reads the name or the picture.
GRANT SELECT (identity_id), DELETE ON profiles.identity_profiles TO exdb_worker;
