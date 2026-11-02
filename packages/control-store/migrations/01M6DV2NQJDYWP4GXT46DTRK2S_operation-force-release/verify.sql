-- check: the release edge is the one pair needs_attention -> failed, and nothing else
SELECT count(*) FILTER (WHERE operations.release_transition_allowed(f, t)) = 1
       AND operations.release_transition_allowed('needs_attention', 'failed') AS ok
  FROM unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS f,
       unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS t;

-- check: the request table is append-only with its guard enabled, owned by the migration login
SELECT (SELECT count(*) FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'recovery.force_releases'::regclass AND NOT tgisinternal AND tgenabled = 'O') = 3
   AND (SELECT r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
         WHERE c.oid = 'recovery.force_releases'::regclass) = 'exdb_migrate'
   AND (SELECT r.rolname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
         WHERE p.oid = 'recovery.force_releases_guard()'::regprocedure) = 'exdb_migrate'
   AND NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = 'recovery.force_releases_guard()'::regprocedure) AS ok;

-- check: serve records requests, the worker only starts them, nobody else and nothing more
SELECT has_table_privilege('exdb_serve', 'recovery.force_releases', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'recovery.force_releases', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'recovery.force_releases', 'started_at', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'recovery.force_releases', 'reason', 'UPDATE')
   AND NOT has_table_privilege('exdb_worker', 'recovery.force_releases', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'recovery.force_releases', 'DELETE') AS ok;

-- check: the guard accepts both recovery edges and the roles that run it can execute the new function
SELECT pg_get_functiondef('operations.operation_guard()'::regprocedure) LIKE '%release_transition_allowed%'
   AND pg_get_functiondef('operations.operation_guard()'::regprocedure) LIKE '%recovery_transition_allowed%'
   AND has_function_privilege('exdb_serve', 'operations.release_transition_allowed(text, text)', 'EXECUTE')
   AND has_function_privilege('exdb_worker', 'operations.release_transition_allowed(text, text)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'operations.release_transition_allowed(text, text)', 'EXECUTE') AS ok;
