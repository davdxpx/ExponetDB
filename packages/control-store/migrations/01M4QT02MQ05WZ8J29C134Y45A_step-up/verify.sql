-- check: the schema belongs to exdb_migrate and only serve uses it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'stepup', 'USAGE')
       AND NOT has_schema_privilege('exdb_worker', 'stepup', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'stepup', 'USAGE')
       AND NOT has_schema_privilege('public', 'stepup', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'stepup';

-- check: serve records and advances step-ups and never rewrites a binding
SELECT has_table_privilege('exdb_serve', 'stepup.step_ups', 'INSERT')
       AND has_column_privilege('exdb_serve', 'stepup.step_ups', 'state', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'stepup.step_ups', 'binding_digest', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'stepup.step_ups', 'identity_id', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'stepup.step_ups', 'expires_at', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'stepup.step_ups', 'DELETE')
       AND NOT has_table_privilege('exdb_audit_maint', 'stepup.step_ups', 'SELECT') AS ok;

-- check: the guard and the truncate refusal are in place
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'stepup.step_ups'::regclass
   AND t.tgname IN ('step_ups_guard', 'step_ups_no_truncate')
   AND NOT t.tgisinternal;

-- check: a step-up lasts at most ten minutes and its receipt 120 seconds
SELECT count(*) >= 6 AS ok
  FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'stepup.step_ups'::regclass AND c.contype = 'c';
