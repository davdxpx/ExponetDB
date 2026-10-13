-- Saved queries (Wave 8, order §9; sql-execution-security.md §2.2). Owner:
-- exdb_migrate. A saved query is data: a name and a SQL text a person
-- wrote, never run, parsed or classified by saving it. Who may read one is
-- decided by the application on its scope (authorization.md); who may
-- change or delete one is enforced here as well: only its owner, only at
-- the revision the change is based on.
CREATE SCHEMA savedq AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA savedq FROM PUBLIC;
GRANT USAGE ON SCHEMA savedq TO exdb_serve;

CREATE TABLE savedq.saved_queries (
  saved_query_id    text        PRIMARY KEY CHECK (saved_query_id ~ '^sqy_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  owner_identity_id text        NOT NULL REFERENCES auth.identities (identity_id) ON DELETE RESTRICT,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120
                                                AND name !~ '[[:cntrl:]]'),
  sql_text          text        NOT NULL CHECK (char_length(sql_text) BETWEEN 1 AND 65536),
  sql_digest        text        NOT NULL CHECK (sql_digest ~ '^sha256:[0-9a-f]{64}$'),
  visibility        text        NOT NULL CHECK (visibility IN ('personal', 'project')),
  scope_kind        text        NOT NULL CHECK (scope_kind IN ('project', 'target')),
  project_id        text        REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  target_id         text        REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  revision          integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_kind = 'project') = (project_id IS NOT NULL)),
  CHECK ((scope_kind = 'target') = (target_id IS NOT NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX saved_queries_by_owner ON savedq.saved_queries (owner_identity_id, saved_query_id);
CREATE INDEX saved_queries_shared ON savedq.saved_queries (saved_query_id) WHERE visibility = 'project';

-- Identity, owner and scope never change; a change raises the revision by
-- exactly one; the times are the database's.
CREATE FUNCTION savedq.saved_queries_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.saved_query_id, NEW.owner_identity_id, NEW.scope_kind, NEW.project_id, NEW.target_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.saved_query_id, OLD.owner_identity_id, OLD.scope_kind, OLD.project_id, OLD.target_id, OLD.created_at)
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXQ01',
      MESSAGE = 'a saved query keeps its id, owner and scope; a change raises its revision by one';
  END IF;
  NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION savedq.saved_queries_guard() FROM PUBLIC;
CREATE TRIGGER saved_queries_guard BEFORE INSERT OR UPDATE ON savedq.saved_queries
  FOR EACH ROW EXECUTE FUNCTION savedq.saved_queries_guard();
CREATE TRIGGER saved_queries_no_truncate BEFORE TRUNCATE ON savedq.saved_queries
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

-- A change by its owner at the revision it is based on: EXQ02 when the row
-- does not exist or belongs to someone else, EXQ03 when it moved on.
-- Returns the new revision.
CREATE FUNCTION savedq.update_saved_query(p_saved_query_id text, p_owner_identity_id text,
                                          p_revision integer, p_name text, p_sql_text text,
                                          p_sql_digest text, p_visibility text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  current savedq.saved_queries%ROWTYPE;
  next_revision integer;
BEGIN
  SELECT * INTO current FROM savedq.saved_queries q WHERE q.saved_query_id = p_saved_query_id FOR UPDATE;
  IF NOT FOUND OR current.owner_identity_id IS DISTINCT FROM p_owner_identity_id THEN
    RAISE EXCEPTION USING ERRCODE = 'EXQ02', MESSAGE = 'only its owner changes or deletes a saved query';
  END IF;
  IF current.revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'EXQ03', MESSAGE = 'the saved query changed since that revision';
  END IF;
  UPDATE savedq.saved_queries q
     SET name = p_name, sql_text = p_sql_text, sql_digest = p_sql_digest, visibility = p_visibility,
         revision = q.revision + 1
   WHERE q.saved_query_id = p_saved_query_id
  RETURNING q.revision INTO next_revision;
  RETURN next_revision;
END
$fn$;
REVOKE ALL ON FUNCTION savedq.update_saved_query(text, text, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION savedq.update_saved_query(text, text, integer, text, text, text, text) TO exdb_serve;

-- A deletion by its owner: EXQ02 when the row does not exist or belongs to someone else.
CREATE FUNCTION savedq.delete_saved_query(p_saved_query_id text, p_owner_identity_id text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  DELETE FROM savedq.saved_queries q
   WHERE q.saved_query_id = p_saved_query_id AND q.owner_identity_id = p_owner_identity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'EXQ02', MESSAGE = 'only its owner changes or deletes a saved query';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION savedq.delete_saved_query(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION savedq.delete_saved_query(text, text) TO exdb_serve;

-- serve saves and reads; it holds no UPDATE or DELETE on the table.
GRANT SELECT, INSERT ON savedq.saved_queries TO exdb_serve;

-- The history of one's own data reads (resources.md "Queries"): the audit
-- events of `data.read` by actor, newest first by sequence. A partitioned
-- index (every monthly partition, present and later, carries it); the
-- events and their hash chain are unchanged.
CREATE INDEX audit_events_data_read_actor
  ON audit.audit_events (actor_id, seq)
  WHERE action = 'data.read';
