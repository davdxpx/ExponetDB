-- check: a cluster records its agent adoption (time, operation, node), nullable and together
SELECT count(*) = 3 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'registry' AND table_name = 'clusters'
   AND column_name IN ('adopted_at', 'adopted_by_operation_id', 'adopted_node_id')
   AND is_nullable = 'YES';

-- check: one adoption operation adopts one cluster
SELECT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'registry' AND indexname = 'clusters_one_adoption_per_operation'
                 AND indexdef LIKE '%UNIQUE%') AS ok;

-- check: the cluster guard still pins the identity and admits only the adoption operation
SELECT pg_catalog.pg_get_functiondef('registry.cluster_guard()'::regprocedure) LIKE '%pinned once%'
   AND pg_catalog.pg_get_functiondef('registry.cluster_guard()'::regprocedure) LIKE '%registry.cluster.adopt_agent%'
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'clusters_guard'
                 AND tgrelid = 'registry.clusters'::regclass AND NOT tgisinternal AND tgenabled = 'O') AS ok;

-- check: only the worker may write a cluster's server and mode; the CA bundle stays unwritable
SELECT has_column_privilege('exdb_worker', 'registry.clusters', 'management_mode', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'registry.clusters', 'adopted_node_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'registry.clusters', 'management_mode', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'registry.clusters', 'server_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'registry.clusters', 'ca_bundle', 'UPDATE')
   AND has_column_privilege('exdb_serve', 'registry.clusters', 'adopted_at', 'SELECT') AS ok;
