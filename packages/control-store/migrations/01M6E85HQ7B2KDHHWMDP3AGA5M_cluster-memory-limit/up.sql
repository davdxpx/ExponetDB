-- OD-68 (b): whether the cluster's PostgreSQL runs under a memory limit, so that a read that
-- exhausts memory ends one backend with an error instead of a restart of the cluster.
ALTER TABLE registry.clusters
  ADD COLUMN memory_limit                 text        CHECK (memory_limit IN ('cgroup', 'overcommit', 'none')),
  ADD COLUMN memory_limit_at              timestamptz,
  ADD COLUMN memory_limit_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT clusters_memory_limit_recorded
    CHECK ((memory_limit IS NULL) = (memory_limit_at IS NULL)
           AND (memory_limit IS NULL) = (memory_limit_by_operation_id IS NULL));

-- A cluster starts undeclared; a declaration is made by an operation of the kind
-- registry.cluster.declare_memory_limit, never on a retired cluster, and is never removed.
CREATE FUNCTION registry.cluster_memory_limit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.memory_limit, NEW.memory_limit_at, NEW.memory_limit_by_operation_id) IS DISTINCT FROM (NULL, NULL, NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts without a declared memory limit';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.memory_limit, NEW.memory_limit_at, NEW.memory_limit_by_operation_id)
     IS NOT DISTINCT FROM (OLD.memory_limit, OLD.memory_limit_at, OLD.memory_limit_by_operation_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.memory_limit IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a declared memory limit is never removed';
  END IF;
  IF OLD.state = 'retired' OR NEW.state = 'retired' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a retired cluster keeps its declared memory limit';
  END IF;
  IF NEW.memory_limit_by_operation_id IS NULL
     OR NEW.memory_limit_by_operation_id IS NOT DISTINCT FROM OLD.memory_limit_by_operation_id
     OR NOT EXISTS (SELECT FROM operations.operations o
                     WHERE o.operation_id = NEW.memory_limit_by_operation_id
                       AND o.kind = 'registry.cluster.declare_memory_limit') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a memory limit is declared by its own registry.cluster.declare_memory_limit operation';
  END IF;
  NEW.memory_limit_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.cluster_memory_limit_guard() FROM PUBLIC;
CREATE TRIGGER clusters_memory_limit_guard BEFORE INSERT OR UPDATE ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_memory_limit_guard();

-- Only the worker declares, as the operation it executes; serve reads the columns.
GRANT UPDATE (memory_limit, memory_limit_at, memory_limit_by_operation_id)
  ON registry.clusters TO exdb_worker;
