-- check: a cluster carries a nullable declared tier with its time and operation
SELECT count(*) = 3 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'registry' AND table_name = 'clusters'
   AND column_name IN ('declared_tier', 'declared_tier_at', 'declared_tier_by_operation_id')
   AND is_nullable = 'YES';

-- check: the declared tier is guarded and only the worker may set it
SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'clusters_tier_guard'
                 AND tgrelid = 'registry.clusters'::regclass AND NOT tgisinternal)
   AND has_column_privilege('exdb_worker', 'registry.clusters', 'declared_tier', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'registry.clusters', 'declared_tier', 'UPDATE')
   AND has_column_privilege('exdb_serve', 'registry.clusters', 'declared_tier', 'SELECT') AS ok;
