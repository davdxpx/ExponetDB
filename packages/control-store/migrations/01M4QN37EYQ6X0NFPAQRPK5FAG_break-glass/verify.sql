-- check: the schema belongs to exdb_migrate and only serve and the worker use it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'breakglass', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'breakglass', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'breakglass', 'USAGE')
       AND NOT has_schema_privilege('public', 'breakglass', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'breakglass';

-- check: serve records, uses and reviews grants; the worker only reads them
SELECT has_table_privilege('exdb_serve', 'breakglass.grants', 'INSERT')
       AND has_column_privilege('exdb_serve', 'breakglass.grants', 'uses', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'breakglass.grants', 'rules', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'breakglass.grants', 'expires_at', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'breakglass.grants', 'DELETE')
       AND has_table_privilege('exdb_worker', 'breakglass.grants', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'breakglass.grants', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'breakglass.grants', 'UPDATE')
       AND NOT has_table_privilege('exdb_audit_maint', 'breakglass.grants', 'SELECT') AS ok;

-- check: the guard and the truncate refusal are in place
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'breakglass.grants'::regclass
   AND t.tgname IN ('grants_guard', 'grants_no_truncate')
   AND NOT t.tgisinternal;

-- check: a grant lasts at most two hours and names at least one rule
SELECT count(*) >= 2 AS ok
  FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'breakglass.grants'::regclass AND c.contype = 'c';
