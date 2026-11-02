-- check: the append-only trigger keeps its name and still refuses updates and other deletes
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'migrations.bundle_revisions'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
   AND t.tgname IN ('bundle_revisions_immutable', 'bundle_revisions_no_update', 'bundle_revisions_purge_guard');

-- check: only the worker may purge, and no runtime login may delete or update a revision itself
SELECT has_function_privilege('exdb_worker', 'migrations.purge_revisions(text, text[], integer[])', 'EXECUTE')
       AND NOT has_function_privilege('exdb_serve', 'migrations.purge_revisions(text, text[], integer[])', 'EXECUTE')
       AND NOT has_function_privilege('public', 'migrations.purge_revisions(text, text[], integer[])', 'EXECUTE')
       AND NOT has_table_privilege('exdb_worker', 'migrations.bundle_revisions', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'migrations.bundle_revisions', 'DELETE')
       AND NOT has_table_privilege('exdb_worker', 'migrations.bundle_revisions', 'UPDATE') AS ok;

-- check: the guard judges every delete by age and references
SELECT pg_get_functiondef('migrations.revision_purge_guard()'::regprocedure) LIKE '%interval ''90 days''%'
   AND pg_get_functiondef('migrations.revision_purge_guard()'::regprocedure) LIKE '%revision_referenced%' AS ok;
