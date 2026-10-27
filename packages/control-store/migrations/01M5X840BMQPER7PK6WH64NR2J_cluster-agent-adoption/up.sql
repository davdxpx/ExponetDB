-- OD-54 option (a), the owner's Wave 9 Part B order (2026-10-26), registry.md §4.5: a cluster
-- registered external becomes agent-managed by one controlled, one-way operation,
-- registry.cluster.adopt_agent. The cluster keeps its id, CA bundle, pinned system identifier,
-- databases and history; targets keep their placement, generation and identity marker.

ALTER TABLE registry.clusters
  ADD COLUMN adopted_at              timestamptz,
  ADD COLUMN adopted_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ADD COLUMN adopted_node_id         text        REFERENCES nodes.nodes (node_id) ON DELETE RESTRICT,
  ADD CONSTRAINT clusters_adoption_recorded
    CHECK ((adopted_at IS NULL) = (adopted_by_operation_id IS NULL)
           AND (adopted_at IS NULL) = (adopted_node_id IS NULL)),
  ADD CONSTRAINT clusters_adopted_by_agent
    CHECK (adopted_at IS NULL OR management_mode = 'agent');
-- One adoption operation adopts one cluster.
CREATE UNIQUE INDEX clusters_one_adoption_per_operation ON registry.clusters (adopted_by_operation_id)
  WHERE adopted_by_operation_id IS NOT NULL;

-- The frozen registry bundle's guard, replaced: its rules stay word for word in effect, and the
-- one change of a cluster's server and mode is the adoption below. Nothing else moves them.
CREATE OR REPLACE FUNCTION registry.cluster_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  v_server_state text;
  v_node_server  text;
  v_node_state   text;
  v_node_report  jsonb;
  v_reports      integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts pending: its identity is pinned by confirmation';
    END IF;
    IF (NEW.adopted_at, NEW.adopted_by_operation_id, NEW.adopted_node_id) IS DISTINCT FROM (NULL, NULL, NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts without an agent adoption';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.cluster_id, NEW.ca_bundle, NEW.created_at, NEW.created_by_operation_id)
     IS DISTINCT FROM (OLD.cluster_id, OLD.ca_bundle, OLD.created_at, OLD.created_by_operation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster keeps its id, server, mode and CA bundle';
  END IF;
  IF (NEW.server_id, NEW.management_mode, NEW.adopted_at, NEW.adopted_by_operation_id, NEW.adopted_node_id)
     IS DISTINCT FROM (OLD.server_id, OLD.management_mode, OLD.adopted_at, OLD.adopted_by_operation_id, OLD.adopted_node_id) THEN
    -- OD-54 (a): exactly external → agent, once, on an active cluster, by its own operation.
    IF OLD.management_mode <> 'external' OR NEW.management_mode <> 'agent'
       OR OLD.adopted_by_operation_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster keeps its id, server, mode and CA bundle; its mode moves only external → agent, once';
    END IF;
    IF OLD.state <> 'active' OR NEW.state <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'only an active cluster is adopted by the node agent';
    END IF;
    IF NEW.server_id IS NULL OR (OLD.server_id IS NOT NULL AND NEW.server_id <> OLD.server_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'an adopted cluster keeps its server, or gains its node''s server when it had none';
    END IF;
    IF NEW.adopted_by_operation_id IS NULL OR NEW.adopted_node_id IS NULL
       OR NOT EXISTS (SELECT FROM operations.operations o
                       WHERE o.operation_id = NEW.adopted_by_operation_id
                         AND o.kind = 'registry.cluster.adopt_agent') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster is adopted by its own registry.cluster.adopt_agent operation';
    END IF;
    -- The server and the node are locked like a new child locks its parent: a retirement of the
    -- server or a revocation of the node and this adoption serialize, and the side that runs
    -- second sees the other's commit.
    SELECT s.state INTO v_server_state FROM registry.servers s WHERE s.server_id = NEW.server_id FOR SHARE;
    IF v_server_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a retired server gets no cluster';
    END IF;
    SELECT n.server_id, n.state, n.clusters INTO v_node_server, v_node_state, v_node_report
      FROM nodes.nodes n WHERE n.node_id = NEW.adopted_node_id FOR SHARE;
    IF v_node_server IS DISTINCT FROM NEW.server_id OR v_node_state IS NULL
       OR v_node_state NOT IN ('active', 'degraded') THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster is adopted by an enrolled, live node of its server';
    END IF;
    SELECT count(*) INTO v_reports FROM jsonb_array_elements(v_node_report) r
     WHERE jsonb_typeof(r) = 'object' AND r ->> 'systemIdentifier' = NEW.system_identifier;
    IF NEW.system_identifier IS NULL OR v_reports <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'the node reports the cluster''s pinned system identifier exactly once';
    END IF;
    NEW.adopted_at := clock_timestamp();
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

-- Only the worker adopts, as the operation it executes; serve reads the columns through its
-- table-wide SELECT.
GRANT UPDATE (server_id, management_mode, adopted_at, adopted_by_operation_id, adopted_node_id)
  ON registry.clusters TO exdb_worker;
