-- check: the history table exists, is append-only and the worker only reads it
SELECT to_regclass('migrations.ledger_mirror_history') IS NOT NULL
   AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid = 'migrations.ledger_mirror_history'::regclass) = 2
   AND has_table_privilege('exdb_worker', 'migrations.ledger_mirror_history', 'SELECT')
   AND NOT has_table_privilege('exdb_worker', 'migrations.ledger_mirror_history', 'INSERT')
   AND NOT has_table_privilege('exdb_worker', 'migrations.ledger_mirror_history', 'DELETE') AS ok;

-- check: only the function removes a mirror row; the worker has no DELETE on the mirror
SELECT has_function_privilege('exdb_worker', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE')
   AND NOT has_function_privilege('exdb_serve', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE')
   AND NOT has_table_privilege('exdb_worker', 'migrations.ledger_mirror', 'DELETE') AS ok;
