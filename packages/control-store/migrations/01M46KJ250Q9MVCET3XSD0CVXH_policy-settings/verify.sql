-- check: settings are readable by serve and worker, writable only by the worker, never changed
SELECT has_table_privilege('exdb_serve', 'policy.rule_settings', 'SELECT')
       AND has_table_privilege('exdb_worker', 'policy.rule_settings', 'SELECT, INSERT')
       AND NOT has_table_privilege('exdb_serve', 'policy.rule_settings', 'INSERT')
       AND NOT has_schema_privilege('exdb_gateway', 'policy', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'policy', 'USAGE')
       AND NOT has_table_privilege('exdb_worker', 'policy.rule_settings', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'policy.rule_settings', 'DELETE')
       AND NOT has_table_privilege('exdb_worker', 'policy.rule_settings', 'TRUNCATE') AS ok;

-- check: the revision guard and the append-only triggers are enabled
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'policy.rule_settings'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O';

-- check: PUBLIC holds nothing in the policy schema
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'policy'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'policy'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;
