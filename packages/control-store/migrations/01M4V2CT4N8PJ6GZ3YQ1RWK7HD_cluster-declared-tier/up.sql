-- OD-22, extended by the owner on 2026-10-13 (authorization.md §5.1,
-- registry.md §4): a cluster carries the tier it is meant for, declared by
-- a person with production authority. NULL means undeclared; the
-- authorization engine then treats the cluster as production for every
-- registry.manage decision (fail closed). The bundle registry (frozen)
-- stays as it is: its cluster guard does not look at these columns, a
-- second guard below does.
ALTER TABLE registry.clusters
  ADD COLUMN declared_tier                 text        CHECK (declared_tier IN ('prod', 'nonprod')),
  ADD COLUMN declared_tier_at              timestamptz,
  ADD COLUMN declared_tier_by_operation_id text        REFERENCES operations.operations (operation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT clusters_declared_tier_recorded
    CHECK ((declared_tier IS NULL) = (declared_tier_at IS NULL)
           AND (declared_tier IS NULL) = (declared_tier_by_operation_id IS NULL));

-- A cluster starts undeclared; a declaration is made by an operation of
-- the kind registry.cluster.declare_tier (each declaration its own
-- operation, the time from the database clock), never on a retired
-- cluster, and a declared cluster never becomes undeclared again.
CREATE FUNCTION registry.cluster_declared_tier_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.declared_tier, NEW.declared_tier_at, NEW.declared_tier_by_operation_id) IS DISTINCT FROM (NULL, NULL, NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a cluster starts without a declared tier';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.declared_tier, NEW.declared_tier_at, NEW.declared_tier_by_operation_id)
     IS NOT DISTINCT FROM (OLD.declared_tier, OLD.declared_tier_at, OLD.declared_tier_by_operation_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.declared_tier IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a declared tier is never removed';
  END IF;
  IF OLD.state = 'retired' OR NEW.state = 'retired' THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a retired cluster keeps its declared tier';
  END IF;
  IF NEW.declared_tier_by_operation_id IS NULL
     OR NEW.declared_tier_by_operation_id IS NOT DISTINCT FROM OLD.declared_tier_by_operation_id
     OR NOT EXISTS (SELECT FROM operations.operations o
                     WHERE o.operation_id = NEW.declared_tier_by_operation_id
                       AND o.kind = 'registry.cluster.declare_tier') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXG07', MESSAGE = 'a tier is declared by its own registry.cluster.declare_tier operation';
  END IF;
  NEW.declared_tier_at := clock_timestamp();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION registry.cluster_declared_tier_guard() FROM PUBLIC;
CREATE TRIGGER clusters_tier_guard BEFORE INSERT OR UPDATE ON registry.clusters
  FOR EACH ROW EXECUTE FUNCTION registry.cluster_declared_tier_guard();

-- Only the worker declares, as the operation it executes; serve reads the
-- columns through its table-wide SELECT.
GRANT UPDATE (declared_tier, declared_tier_at, declared_tier_by_operation_id)
  ON registry.clusters TO exdb_worker;
