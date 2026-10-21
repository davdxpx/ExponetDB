-- check: the excused attributes are fixed to bypassrls by a CHECK constraint
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint c
                WHERE c.conrelid = 'registry.execution_role_exceptions'::regclass
                  AND c.contype = 'c' AND c.convalidated
                  AND pg_get_constraintdef(c.oid) LIKE '%attributes = ARRAY[''bypassrls''::text]%') AS ok;

-- check: one active exception per project, environment and role; guarded
SELECT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'registry'
                 AND indexname = 'execution_role_exceptions_one_active')
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'execution_role_exceptions_guard'
                 AND tgrelid = 'registry.execution_role_exceptions'::regclass AND NOT tgisinternal) AS ok;

-- check: only the worker writes exceptions, it never deletes one, and serve only reads
SELECT has_table_privilege('exdb_worker', 'registry.execution_role_exceptions', 'INSERT')
   AND NOT has_table_privilege('exdb_worker', 'registry.execution_role_exceptions', 'DELETE')
   AND NOT has_column_privilege('exdb_worker', 'registry.execution_role_exceptions', 'attributes', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'registry.execution_role_exceptions', 'role_name', 'UPDATE')
   AND NOT has_table_privilege('exdb_serve', 'registry.execution_role_exceptions', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'registry.execution_role_exceptions', 'UPDATE')
   AND has_table_privilege('exdb_serve', 'registry.execution_role_exceptions', 'SELECT') AS ok;
