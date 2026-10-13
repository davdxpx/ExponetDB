-- check: the saved queries table exists in its own schema, owned by exdb_migrate
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_tables
 WHERE schemaname = 'savedq' AND tablename = 'saved_queries' AND tableowner = 'exdb_migrate';

-- check: PUBLIC has no access to the saved queries schema
SELECT NOT has_schema_privilege('public', 'savedq', 'USAGE') AS ok;

-- check: serve saves and reads but never changes or deletes a row directly
SELECT has_table_privilege('exdb_serve', 'savedq.saved_queries', 'SELECT')
       AND has_table_privilege('exdb_serve', 'savedq.saved_queries', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'savedq.saved_queries', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'savedq.saved_queries', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'savedq.saved_queries', 'TRUNCATE')
       AND NOT has_schema_privilege('exdb_worker', 'savedq', 'USAGE') AS ok;

-- check: changes go through the owner- and revision-checking function, executable by serve only
SELECT p.prosecdef
       AND has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('exdb_worker', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('public', p.oid, 'EXECUTE') AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'savedq.update_saved_query(text, text, integer, text, text, text, text)'::regprocedure;

-- check: deletions go through the owner-checking function, executable by serve only
SELECT p.prosecdef
       AND has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('exdb_worker', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('public', p.oid, 'EXECUTE') AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'savedq.delete_saved_query(text, text)'::regprocedure;

-- check: the guard and the truncate refusal are installed
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger
 WHERE tgrelid = 'savedq.saved_queries'::regclass
   AND tgname IN ('saved_queries_guard', 'saved_queries_no_truncate')
   AND NOT tgisinternal;

-- check: the index of data reads by actor exists on the partitioned audit table
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_indexes
 WHERE schemaname = 'audit' AND tablename = 'audit_events'
   AND indexname = 'audit_events_data_read_actor';
