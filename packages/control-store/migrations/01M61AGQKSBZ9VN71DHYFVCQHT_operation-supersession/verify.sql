-- check: the recovery edge is the one pair needs_attention -> verification_failed, and nothing else
SELECT count(*) FILTER (WHERE operations.recovery_transition_allowed(f, t)) = 1
       AND operations.recovery_transition_allowed('needs_attention', 'verification_failed') AS ok
  FROM unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS f,
       unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS t;

-- check: the frozen list of the operations bundle is untouched and a finished operation has no way out
SELECT NOT operations.transition_allowed('needs_attention', 'verification_failed')
   AND operations.transition_allowed('needs_attention', 'verifying')
   AND NOT operations.recovery_transition_allowed('verification_failed', 'needs_attention')
   AND NOT operations.recovery_transition_allowed('succeeded', 'verifying') AS ok;

-- check: the guard accepts the recovery edge and the roles that run it can execute both functions
SELECT pg_get_functiondef('operations.operation_guard()'::regprocedure) LIKE '%recovery_transition_allowed%'
   AND has_function_privilege('exdb_serve', 'operations.recovery_transition_allowed(text, text)', 'EXECUTE')
   AND has_function_privilege('exdb_worker', 'operations.recovery_transition_allowed(text, text)', 'EXECUTE')
   AND NOT has_function_privilege('public', 'operations.recovery_transition_allowed(text, text)', 'EXECUTE') AS ok;
