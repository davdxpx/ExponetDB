-- check: the profiles table exists in its own schema, owned by exdb_migrate
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_tables
 WHERE schemaname = 'profiles' AND tablename = 'identity_profiles' AND tableowner = 'exdb_migrate';

-- check: only serve and the worker use the schema
SELECT has_schema_privilege('exdb_serve', 'profiles', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'profiles', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'profiles', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'profiles', 'USAGE')
       AND NOT has_schema_privilege('public', 'profiles', 'USAGE') AS ok;

-- check: serve reads but never writes a row directly
SELECT has_table_privilege('exdb_serve', 'profiles.identity_profiles', 'SELECT')
       AND NOT has_table_privilege('exdb_serve', 'profiles.identity_profiles', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'profiles.identity_profiles', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'profiles.identity_profiles', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'profiles.identity_profiles', 'TRUNCATE') AS ok;

-- check: the worker deletes rows and reads only the identity, never the name or the picture
SELECT has_table_privilege('exdb_worker', 'profiles.identity_profiles', 'DELETE')
       AND has_column_privilege('exdb_worker', 'profiles.identity_profiles', 'identity_id', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'profiles.identity_profiles', 'display_name', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'profiles.identity_profiles', 'avatar', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'profiles.identity_profiles', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'profiles.identity_profiles', 'UPDATE') AS ok;

-- check: changes go through the three security-definer functions, executable by serve only
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.oid IN ('profiles.set_display_name(text, integer, text)'::regprocedure,
                 'profiles.set_avatar(text, bytea, text, text, integer, integer)'::regprocedure,
                 'profiles.clear_avatar(text)'::regprocedure)
   AND p.prosecdef
   AND has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
   AND NOT has_function_privilege('exdb_worker', p.oid, 'EXECUTE')
   AND NOT has_function_privilege('public', p.oid, 'EXECUTE');

-- check: the guard and the truncate refusal are installed
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger
 WHERE tgrelid = 'profiles.identity_profiles'::regclass
   AND tgname IN ('identity_profiles_guard', 'identity_profiles_no_truncate')
   AND NOT tgisinternal;
