-- check: execution role bindings exist with one current row per alias and their guard
SELECT EXISTS (SELECT FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
                WHERE i.indisunique AND i.indpred IS NOT NULL
                  AND ic.relname = 'execution_role_bindings_one_current'
                  AND ic.relnamespace = 'registry'::regnamespace)
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'execution_role_bindings_guard'
                 AND tgrelid = 'registry.execution_role_bindings'::regclass AND NOT tgisinternal)
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'execution_role_bindings_no_truncate'
                 AND tgrelid = 'registry.execution_role_bindings'::regclass AND NOT tgisinternal) AS ok;

-- check: only the worker writes bindings, inserts and ends them only; nobody deletes; serve reads them
SELECT has_table_privilege('exdb_worker', 'registry.execution_role_bindings', 'INSERT')
   AND has_column_privilege('exdb_worker', 'registry.execution_role_bindings', 'ended_at', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'registry.execution_role_bindings', 'ended_by_operation_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'registry.execution_role_bindings', 'role', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'registry.execution_role_bindings', 'alias', 'UPDATE')
   AND NOT has_table_privilege('exdb_worker', 'registry.execution_role_bindings', 'DELETE, TRUNCATE')
   AND NOT has_table_privilege('exdb_serve', 'registry.execution_role_bindings', 'INSERT, UPDATE, DELETE, TRUNCATE')
   AND has_table_privilege('exdb_serve', 'registry.execution_role_bindings', 'SELECT') AS ok;
