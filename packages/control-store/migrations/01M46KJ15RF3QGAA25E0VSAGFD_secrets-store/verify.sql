-- check: every secrets table is owned by exdb_migrate
SELECT bool_and(c.relowner = 'exdb_migrate'::regrole) AND count(*) = 7 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'secrets'::regnamespace AND c.relkind = 'r';

-- check: ciphertext is readable only by its consumers
SELECT has_table_privilege('exdb_worker', 'secrets.secret_blobs_worker', 'SELECT')
       AND NOT has_table_privilege('exdb_serve', 'secrets.secret_blobs_worker', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'secrets.secret_blobs_worker', 'SELECT')
       AND has_table_privilege('exdb_worker', 'secrets.secret_blobs_observer', 'SELECT')
       AND has_table_privilege('exdb_serve', 'secrets.secret_blobs_observer', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'secrets.secret_blobs_observer', 'SELECT')
       AND has_table_privilege('exdb_serve', 'secrets.secret_blobs_auth', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'secrets.secret_blobs_auth', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'secrets.secret_blobs_auth', 'SELECT')
       AND has_table_privilege('exdb_gateway', 'secrets.secret_blobs_gateway', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'secrets.secret_blobs_gateway', 'SELECT')
       AND NOT has_table_privilege('exdb_serve', 'secrets.secret_blobs_gateway', 'SELECT') AS ok;

-- check: exdb_audit_maint and PUBLIC have no access to the secrets schema
SELECT NOT has_schema_privilege('exdb_audit_maint', 'secrets', 'USAGE')
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'secrets'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'secrets'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;

-- check: no role may update or delete secret rows except the worker's re-wrap columns
SELECT bool_and(NOT has_table_privilege(r, t, 'UPDATE') AND NOT has_table_privilege(r, t, 'DELETE')
                AND NOT has_table_privilege(r, t, 'TRUNCATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway']) AS r,
       unnest(ARRAY['secrets.master_keys', 'secrets.secret_versions', 'secrets.secret_blobs_worker',
                    'secrets.secret_blobs_observer', 'secrets.secret_blobs_auth',
                    'secrets.secret_blobs_gateway']) AS t;

-- check: only the worker re-wraps, and only the wrap columns
SELECT has_column_privilege('exdb_worker', 'secrets.data_keys', 'wrapped_key', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'secrets.data_keys', 'secret_id', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'secrets.data_keys', 'version', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'secrets.data_keys', 'UPDATE')
       AND NOT has_table_privilege('exdb_gateway', 'secrets.data_keys', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'secrets.data_keys', 'DELETE') AS ok;

-- check: the guard and append-only triggers are enabled
SELECT count(*) = 20 AS ok
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'secrets'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'O';
