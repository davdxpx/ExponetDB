-- check: the schema belongs to exdb_migrate and only serve and the worker use it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'recovery', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'recovery', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'recovery', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'recovery', 'USAGE')
       AND NOT has_schema_privilege('public', 'recovery', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'recovery';

-- check: serve records requests, the worker only starts them, nobody removes one
SELECT has_table_privilege('exdb_serve', 'recovery.verification_retries', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'recovery.verification_retries', 'UPDATE')
       AND has_column_privilege('exdb_worker', 'recovery.verification_retries', 'started_at', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'recovery.verification_retries', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'recovery.verification_retries', 'DELETE')
       AND NOT has_table_privilege('exdb_worker', 'recovery.verification_retries', 'DELETE') AS ok;

-- check: the start is guarded, deletes and truncation are refused
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'recovery.verification_retries'::regclass
   AND t.tgname IN ('verification_retries_guard', 'verification_retries_no_delete',
                    'verification_retries_no_truncate')
   AND NOT t.tgisinternal;

-- check: at most one open request per operation
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_indexes
 WHERE schemaname = 'recovery' AND indexname = 'verification_retries_open';
