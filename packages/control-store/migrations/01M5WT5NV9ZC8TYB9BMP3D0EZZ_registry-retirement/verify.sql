-- check: servers carry a state, and their retirement names its operation
SELECT count(*) = 3 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'registry' AND table_name = 'servers'
   AND column_name IN ('state', 'retired_at', 'retired_by_operation_id');

-- check: clusters record the time and operation of their retirement
SELECT count(*) = 2 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'registry' AND table_name = 'clusters'
   AND column_name IN ('retired_at', 'retired_by_operation_id');

-- check: the retirement guards and the parent locks of new children are in place
SELECT count(*) = 5 AS ok
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname IN ('clusters_retirement_guard', 'clusters_server_lock', 'databases_cluster_lock',
                  'endpoints_cluster_lock', 'credentials_cluster_lock');

-- check: the nodes schema keeps the triggers its frozen bundle pins (none added here)
SELECT count(*) = 24 AS ok
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'nodes'::regnamespace AND NOT t.tgisinternal;

-- check: only the worker retires, and serve cannot
SELECT has_column_privilege('exdb_worker', 'registry.servers', 'state', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'registry.clusters', 'retired_by_operation_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'registry.servers', 'state', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'registry.clusters', 'retired_by_operation_id', 'UPDATE') AS ok;

-- check: an unretired cluster is pending exactly when it has no system identifier
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_constraint
 WHERE conrelid = 'registry.clusters'::regclass AND conname = 'clusters_pending_without_identifier';

-- check: the two SECURITY DEFINER parent locks search pg_catalog, then pg_temp, and nothing else
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_proc
 WHERE pronamespace = 'registry'::regnamespace AND prosecdef
   AND proname IN ('server_child_lock', 'cluster_child_lock')
   AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'];
