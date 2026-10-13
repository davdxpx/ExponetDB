-- check: the schema belongs to exdb_migrate and only serve and the worker use it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'role_verifiers', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'role_verifiers', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'role_verifiers', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'role_verifiers', 'USAGE')
       AND NOT has_schema_privilege('public', 'role_verifiers', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'role_verifiers';

-- check: serve inserts role verifiers and reads only their metadata, never a sealed column
SELECT has_table_privilege('exdb_serve', 'role_verifiers.verifiers', 'INSERT')
       AND has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'state', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'ciphertext', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'nonce', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'wrapped_key', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'wrap_nonce', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'key_id', 'SELECT')
       AND NOT has_column_privilege('exdb_serve', 'role_verifiers.verifiers', 'operation_id', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'role_verifiers.verifiers', 'DELETE') AS ok;

-- check: the worker reads and clears them; no other role reads them
SELECT has_table_privilege('exdb_worker', 'role_verifiers.verifiers', 'SELECT')
       AND has_column_privilege('exdb_worker', 'role_verifiers.verifiers', 'ciphertext', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'role_verifiers.verifiers', 'role_name', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'role_verifiers.verifiers', 'DELETE')
       AND NOT has_column_privilege('exdb_gateway', 'role_verifiers.verifiers', 'ciphertext', 'SELECT')
       AND NOT has_column_privilege('exdb_audit_maint', 'role_verifiers.verifiers', 'ciphertext', 'SELECT') AS ok;

-- check: the guard and the truncate refusal are in place
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'role_verifiers.verifiers'::regclass
   AND t.tgname IN ('verifiers_guard', 'verifiers_no_truncate')
   AND NOT t.tgisinternal;

-- check: a verifier is sealed exactly while submitted
SELECT count(*) >= 2 AS ok
  FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'role_verifiers.verifiers'::regclass AND c.contype = 'c'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%ciphertext IS%';

-- check: one submitted verifier per role of a cluster
SELECT EXISTS (SELECT FROM pg_catalog.pg_indexes
                WHERE schemaname = 'role_verifiers' AND indexname = 'verifiers_one_submitted') AS ok;
