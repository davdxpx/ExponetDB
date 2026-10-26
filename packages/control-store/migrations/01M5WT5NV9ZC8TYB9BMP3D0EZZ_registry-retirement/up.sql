-- Servers and clusters are retired by operation, bottom-up (registry.md §4.4).

ALTER TABLE registry.servers
  ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by_operation_id text REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT servers_retired_by_operation
    CHECK ((state = 'retired') = (retired_at IS NOT NULL AND retired_by_operation_id IS NOT NULL));

-- A cluster that was never confirmed (a wrong registration) must be retirable too: the frozen
-- rule "pending exactly when no system identifier" holds for clusters that are not retired; a
-- retired cluster keeps whatever identifier it had (none when it was retired pending).
DO $do$
DECLARE
  v_name text;
BEGIN
  SELECT c.conname INTO STRICT v_name FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'registry.clusters'::regclass AND c.contype = 'c'
     AND pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK (((state = ''pending''::text) = (system_identifier IS NULL)))';
  EXECUTE format('ALTER TABLE registry.clusters DROP CONSTRAINT %I', v_name);
END
$do$;
ALTER TABLE registry.clusters
  ADD CONSTRAINT clusters_pending_without_identifier
    CHECK (state = 'retired' OR ((state = 'pending') = (system_identifier IS NULL)));

ALTER TABLE registry.clusters
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_by_operation_id text REFERENCES operations.operations (operation_id) ON DELETE RESTRICT;
-- No code path wrote a retired cluster before this bundle; NOT VALID keeps an older row, if one
-- exists, from blocking the upgrade, and every new or changed row is held to the rule.
ALTER TABLE registry.clusters
  ADD CONSTRAINT clusters_retired_by_operation
    CHECK (state <> 'retired' OR (retired_at IS NOT NULL AND retired_by_operation_id IS NOT NULL)) NOT VALID;

-- A server record changes only by its retirement, which needs every child gone first.
CREATE OR REPLACE FUNCTION registry.server_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.retired_at IS NOT NULL OR NEW.retired_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server starts active';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.server_id, NEW.display_name, NEW.provider, NEW.provider_ref, NEW.location, NEW.labels,
      NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.server_id, OLD.display_name, OLD.provider, OLD.provider_ref, OLD.location,
      OLD.labels, OLD.created_at, OLD.created_by_operation_id)
     OR OLD.state <> 'active' OR NEW.state <> 'retired' OR NEW.retired_by_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server record changes only by its retirement, once, by an operation';
  END IF;
  -- Take the row's strongest lock: it waits for every insert of a child still holding the key
  -- share lock of its foreign key (a cluster, an enrollment token), and each query below then
  -- sees what such an insert committed. A child inserted after this waits for this transaction
  -- (clusters by their trigger below, enrollment tokens by `node.enroll`'s own check).
  PERFORM 1 FROM registry.servers s WHERE s.server_id = NEW.server_id FOR UPDATE;
  IF EXISTS (SELECT FROM registry.clusters c WHERE c.server_id = NEW.server_id AND c.state <> 'retired') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server that holds a cluster which is not retired is not retired';
  END IF;
  IF EXISTS (SELECT FROM nodes.nodes n WHERE n.server_id = NEW.server_id
               AND n.state IN ('pending_binding', 'active', 'degraded', 'revoked')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server with a node that is not decommissioned is not retired';
  END IF;
  IF EXISTS (SELECT FROM nodes.enrollment_tokens e WHERE e.server_id = NEW.server_id
               AND ((e.state = 'created' AND e.reveal_until > clock_timestamp())
                    OR (e.state = 'issued' AND e.expires_at > clock_timestamp()))) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server with an enrollment token that can still be redeemed is not retired';
  END IF;
  IF EXISTS (SELECT FROM nodes.jobs j JOIN nodes.nodes n ON n.node_id = j.node_id
              WHERE n.server_id = NEW.server_id
                AND j.state IN ('pending', 'dispatched', 'running', 'outcome_unknown')) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a server with a node job that is not finished is not retired';
  END IF;
  NEW.retired_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.server_guard() FROM PUBLIC;

-- A cluster's retirement needs every child record retired first; its retirement columns are
-- written once, with it, and never otherwise.
CREATE FUNCTION registry.cluster_retirement_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.retired_at IS NOT NULL OR NEW.retired_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts not retired';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'retired' AND NEW.state = 'retired' THEN
    IF NEW.retired_by_operation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster is retired by an operation';
    END IF;
    IF EXISTS (SELECT FROM registry.databases d WHERE d.cluster_id = NEW.cluster_id AND d.state = 'registered') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster with a registered database is not retired';
    END IF;
    IF EXISTS (SELECT FROM registry.endpoints e WHERE e.cluster_id = NEW.cluster_id AND e.state = 'active') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster with an active endpoint is not retired';
    END IF;
    IF EXISTS (SELECT FROM registry.credentials c WHERE c.cluster_id = NEW.cluster_id
                 AND c.state IN ('pending', 'active')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster with a pending or active credential is not retired';
    END IF;
    NEW.retired_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.retired_at, NEW.retired_by_operation_id) IS DISTINCT FROM (OLD.retired_at, OLD.retired_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster''s retirement is recorded once, with it';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.cluster_retirement_guard() FROM PUBLIC;
CREATE TRIGGER clusters_retirement_guard BEFORE INSERT OR UPDATE ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_retirement_guard();

-- A new child locks its parent row FOR SHARE and needs it live: a retirement of the parent
-- (which takes the row's update lock) and the new child then serialize, and whichever comes
-- second sees the other (the lock waits, then the check reads the committed state). SECURITY
-- DEFINER: the inserting role need not hold UPDATE on the parent for the lock.
CREATE FUNCTION registry.server_child_lock() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_state text;
BEGIN
  IF NEW.server_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.state INTO v_state FROM registry.servers s WHERE s.server_id = NEW.server_id FOR SHARE;
  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG06', MESSAGE = 'a retired server gets no cluster';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.server_child_lock() FROM PUBLIC;
-- Only on registry.clusters: the frozen nodes bundle pins the triggers of its schema, so an
-- enrollment token checks its server in `node.enroll` (FOR SHARE, the same serialization), and a
-- node needs a redeemable token, which a retirement refuses to leave behind.
CREATE TRIGGER clusters_server_lock BEFORE INSERT ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION registry.server_child_lock();

CREATE FUNCTION registry.cluster_child_lock() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_state text;
BEGIN
  SELECT c.state INTO v_state FROM registry.clusters c WHERE c.cluster_id = NEW.cluster_id FOR SHARE;
  IF v_state IS NULL OR v_state = 'retired' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a retired cluster gets no database, endpoint or credential';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.cluster_child_lock() FROM PUBLIC;
CREATE TRIGGER databases_cluster_lock BEFORE INSERT ON registry.databases
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_child_lock();
CREATE TRIGGER endpoints_cluster_lock BEFORE INSERT ON registry.endpoints
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_child_lock();
CREATE TRIGGER credentials_cluster_lock BEFORE INSERT ON registry.credentials
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_child_lock();

GRANT UPDATE (state, retired_at, retired_by_operation_id) ON registry.servers TO exdb_worker;
GRANT UPDATE (retired_at, retired_by_operation_id) ON registry.clusters TO exdb_worker;
