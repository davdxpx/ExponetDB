-- check: the state machine allows exactly the documented transitions
SELECT count(*) FILTER (WHERE operations.transition_allowed(f, t)) = 15 AS ok
  FROM unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS f,
       unnest(ARRAY['awaiting_approval', 'queued', 'running', 'verifying', 'needs_reconciliation',
                    'needs_attention', 'succeeded', 'failed', 'verification_failed', 'canceled']) AS t;

-- check: a succeeded operation was applied, a failed one was not, a canceled one never started
SELECT operations.state_admits('succeeded', 'applied', 'passed')
       AND NOT operations.state_admits('succeeded', 'unknown', 'passed')
       AND NOT operations.state_admits('succeeded', 'applied', 'pending')
       AND NOT operations.state_admits('failed', 'applied', 'not_applicable')
       AND NOT operations.state_admits('canceled', 'unknown', 'not_applicable')
       AND operations.state_admits('needs_reconciliation', 'unknown', 'pending') AS ok;

-- check: guard, append-only and row-level security are in place
SELECT (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         WHERE c.relnamespace = 'operations'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'O') = 13
       AND (SELECT bool_and(c.relrowsecurity) FROM pg_catalog.pg_class c
             WHERE c.oid IN ('operations.operation_locks'::regclass, 'operations.idempotency_keys'::regclass)) AS ok;

-- check: no role may delete plans, operations or events; only the worker releases locks
SELECT bool_and(NOT has_table_privilege(r, t, 'DELETE') AND NOT has_table_privilege(r, t, 'TRUNCATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker']) AS r,
       unnest(ARRAY['operations.plans', 'operations.plan_bodies', 'operations.operations',
                    'operations.operation_events']) AS t;

-- check: gateway, audit maintenance and PUBLIC have no access
SELECT NOT has_schema_privilege('exdb_gateway', 'operations', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'operations', 'USAGE')
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'operations'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'operations'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;
