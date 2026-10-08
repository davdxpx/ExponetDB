-- check: node_admission is owned by exdb_migrate; only the gateway may use it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_gateway', 'node_admission', 'USAGE')
       AND NOT has_schema_privilege('exdb_serve', 'node_admission', 'USAGE')
       AND NOT has_schema_privilege('exdb_worker', 'node_admission', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'node_admission', 'USAGE')
       AND NOT has_schema_privilege('public', 'node_admission', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'node_admission';

-- check: the schema holds exactly one function and no table, view or sequence
SELECT (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'node_admission'::regnamespace) = 1
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = 'node_admission'::regnamespace) AS ok;

-- check: job_capability is security definer with a fixed search path, executable by the gateway only
SELECT p.prosecdef
       AND p.proconfig = ARRAY['search_path=pg_catalog']
       AND has_function_privilege('exdb_gateway', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('exdb_worker', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('public', p.oid, 'EXECUTE') AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'node_admission.job_capability(text, bytea, text)'::regprocedure;

-- check: the gateway still reads no job directly
SELECT NOT has_table_privilege('exdb_gateway', 'nodes.jobs', 'SELECT') AS ok;
