-- check: serve records an offline drill through the function only; it has no right on the table
SELECT has_function_privilege('exdb_serve', 'backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz)', 'EXECUTE')
   AND NOT has_function_privilege('exdb_worker', 'backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz)', 'EXECUTE')
   AND NOT has_table_privilege('exdb_serve', 'backups.drills', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'backups.drills', 'UPDATE')
   AND NOT has_table_privilege('exdb_serve', 'backups.drills', 'DELETE') AS ok;

-- check: the function is a definer with a pinned search_path
SELECT p.prosecdef AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog, pg_temp' = ANY (p.proconfig) AS ok
  FROM pg_proc p
 WHERE p.oid = 'backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz)'::regprocedure;
