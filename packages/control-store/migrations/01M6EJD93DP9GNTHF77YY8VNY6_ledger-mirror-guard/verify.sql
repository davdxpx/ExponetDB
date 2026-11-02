-- check: the update guard is enabled and the worker still holds no DELETE on the mirror
SELECT EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'migrations.ledger_mirror'::regclass AND t.tgname = 'ledger_mirror_update_guard'
                  AND t.tgenabled = 'O')
       AND NOT has_table_privilege('exdb_worker', 'migrations.ledger_mirror', 'DELETE') AS ok;

-- check: archive_mirror_rows locks its operation, holds it to its lease and binds the plan, for the worker only
SELECT pg_get_functiondef('migrations.archive_mirror_rows(text, text, integer, text[], text)'::regprocedure) LIKE '%FOR SHARE OF o%'
   AND pg_get_functiondef('migrations.archive_mirror_rows(text, text, integer, text[], text)'::regprocedure) LIKE '%lease_expires_at%'
   AND pg_get_functiondef('migrations.archive_mirror_rows(text, text, integer, text[], text)'::regprocedure) LIKE '%plan_bodies%'
   AND has_function_privilege('exdb_worker', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE')
   AND NOT has_function_privilege('exdb_serve', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'migrations.archive_mirror_rows(text, text, integer, text[], text)', 'EXECUTE') AS ok;
