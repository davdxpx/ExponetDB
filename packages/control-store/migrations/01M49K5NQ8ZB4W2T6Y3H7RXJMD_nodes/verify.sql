-- check: nodes schema is owned by exdb_migrate; serve, worker and gateway may use it, audit maintenance and PUBLIC not
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'nodes', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'nodes', 'USAGE')
       AND has_schema_privilege('exdb_gateway', 'nodes', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'nodes', 'USAGE')
       AND NOT has_schema_privilege('public', 'nodes', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'nodes';

-- check: PUBLIC has no privilege on a table and may execute no function of the schema
SELECT NOT EXISTS (SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
                    WHERE c.relnamespace = 'nodes'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p
                        WHERE p.pronamespace = 'nodes'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;

-- check: the gateway writes no table directly and never reads tokens, bind proofs or node encryption keys
SELECT bool_and(NOT has_table_privilege('exdb_gateway', t, 'INSERT')
                AND NOT has_table_privilege('exdb_gateway', t, 'UPDATE')
                AND NOT has_table_privilege('exdb_gateway', t, 'DELETE')
                AND NOT has_table_privilege('exdb_gateway', t, 'TRUNCATE'))
       AND NOT has_table_privilege('exdb_gateway', 'nodes.enrollment_tokens', 'SELECT')
       AND NOT has_column_privilege('exdb_gateway', 'nodes.nodes', 'bind_proof', 'SELECT')
       AND NOT has_column_privilege('exdb_gateway', 'nodes.nodes', 'node_encryption_key', 'SELECT')
       AND NOT has_column_privilege('exdb_gateway', 'nodes.job_keys', 'secret_id', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'nodes.jobs', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'nodes.observations', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'nodes.postgres_ca', 'SELECT')
       AND NOT has_table_privilege('exdb_gateway', 'nodes.credential_rotations', 'SELECT') AS ok
  FROM unnest(ARRAY['nodes.pki', 'nodes.job_keys', 'nodes.enrollment_tokens', 'nodes.nodes', 'nodes.jobs',
                    'nodes.observations', 'nodes.postgres_ca', 'nodes.credential_rotations']) AS t;

-- check: the gateway may execute exactly its eight functions, and nobody else may
SELECT (SELECT count(*) FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'nodes'::regnamespace AND has_function_privilege('exdb_gateway', p.oid, 'EXECUTE')) = 8
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p
                        WHERE p.pronamespace = 'nodes'::regnamespace
                          AND p.proname IN ('enroll', 'hello', 'heartbeat', 'renew', 'claim', 'start', 'progress', 'complete')
                          AND (has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
                               OR has_function_privilege('exdb_worker', p.oid, 'EXECUTE'))) AS ok;

-- check: serve only reads and issues tokens; it never writes nodes, jobs or keys
SELECT bool_and(NOT has_table_privilege('exdb_serve', t, 'INSERT')
                AND NOT has_table_privilege('exdb_serve', t, 'DELETE'))
       AND NOT has_table_privilege('exdb_serve', 'nodes.nodes', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'nodes.jobs', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'nodes.job_keys', 'UPDATE')
       AND has_column_privilege('exdb_serve', 'nodes.enrollment_tokens', 'redeem_hash', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'nodes.enrollment_tokens', 'server_id', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'nodes.postgres_ca', 'key_secret_id', 'SELECT') AS ok
  FROM unnest(ARRAY['nodes.pki', 'nodes.job_keys', 'nodes.enrollment_tokens', 'nodes.nodes', 'nodes.jobs',
                    'nodes.observations', 'nodes.postgres_ca', 'nodes.credential_rotations']) AS t;

-- check: the worker changes only states, verdicts and cancel flags, never an envelope, a key or a certificate
SELECT has_column_privilege('exdb_worker', 'nodes.jobs', 'node_signature_valid', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'nodes.jobs', 'envelope', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'nodes.jobs', 'completion', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'nodes.nodes', 'certificate', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'nodes.nodes', 'node_signing_key', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'nodes.enrollment_tokens', 'redeem_hash', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'nodes.nodes', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'nodes.nodes', 'DELETE')
       AND has_table_privilege('exdb_worker', 'nodes.observations', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'nodes.observations', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'nodes.postgres_ca', 'UPDATE')
       AND has_table_privilege('exdb_worker', 'registry.credentials', 'INSERT')
       AND NOT has_column_privilege('exdb_worker', 'registry.credentials', 'secret_id', 'UPDATE')
       AND has_column_privilege('exdb_worker', 'nodes.nodes', 'trusted_job_keys', 'UPDATE')
       AND NOT has_column_privilege('exdb_gateway', 'nodes.nodes', 'trusted_job_keys', 'UPDATE') AS ok;

-- check: every table has its guard and refuses delete and truncate; I-6 is an index
SELECT (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         WHERE c.relnamespace = 'nodes'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'O') = 24
       AND EXISTS (SELECT FROM pg_catalog.pg_indexes
                    WHERE schemaname = 'nodes' AND indexname = 'nodes_one_live_per_server'
                      AND indexdef LIKE '%UNIQUE%')
       AND (SELECT count(*) FROM pg_catalog.pg_indexes
             WHERE schemaname = 'nodes' AND indexname IN ('job_keys_one_active', 'job_keys_one_staged')
               AND indexdef LIKE '%UNIQUE%') = 2 AS ok;

-- check: every function pins its search_path; the gateway's run as the schema owner
SELECT bool_and(p.proconfig @> ARRAY['search_path=pg_catalog'])
       AND bool_and(p.proowner = 'exdb_migrate'::regrole)
       AND (SELECT count(*) FROM pg_catalog.pg_proc q
             WHERE q.pronamespace = 'nodes'::regnamespace AND q.prosecdef) = 9 AS ok
  FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'nodes'::regnamespace;
