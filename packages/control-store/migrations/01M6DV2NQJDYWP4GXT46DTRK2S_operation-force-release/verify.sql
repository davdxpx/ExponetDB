-- check: the release edge is the one pair needs_attention -> failed, and nothing else
SELECT count(*) FILTER (WHERE operations.release_transition_allowed(f, t)) = 1
       AND operations.release_transition_allowed('needs_attention', 'failed') AS ok
  FROM unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS f,
       unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS t;

-- check: the guard accepts both recovery edges and the roles that run it can execute the new function
SELECT pg_get_functiondef('operations.operation_guard()'::regprocedure) LIKE '%release_transition_allowed%'
   AND pg_get_functiondef('operations.operation_guard()'::regprocedure) LIKE '%recovery_transition_allowed%'
   AND has_function_privilege('exdb_serve', 'operations.release_transition_allowed(text, text)', 'EXECUTE')
   AND has_function_privilege('exdb_worker', 'operations.release_transition_allowed(text, text)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'operations.release_transition_allowed(text, text)', 'EXECUTE') AS ok;

-- check: the claim reads waiting operations through their own index
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes
                WHERE schemaname = 'operations' AND indexname = 'operations_waiting') AS ok;
