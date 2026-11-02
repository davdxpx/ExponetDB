-- check: the memory limit is declared through its guard, by the worker only
SELECT EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'registry.clusters'::regclass AND t.tgname = 'clusters_memory_limit_guard'
                  AND t.tgenabled = 'O')
       AND has_column_privilege('exdb_worker', 'registry.clusters', 'memory_limit', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'registry.clusters', 'memory_limit', 'UPDATE') AS ok;
