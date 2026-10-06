-- check: observation schema is owned by exdb_migrate and not usable by PUBLIC, gateway or audit maintenance
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND NOT has_schema_privilege('public', 'observation', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'observation', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'observation', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'observation';

-- check: the observation tables exist and belong to exdb_migrate
SELECT count(*) = 7 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'observation'::regnamespace AND c.relkind IN ('r', 'p')
   AND c.relname IN ('schema_documents', 'schema_snapshots', 'schema_baselines', 'drift_checks', 'findings',
                     'target_status', 'health_samples')
   AND c.relowner = 'exdb_migrate'::regrole;

-- check: history tables are append-only and nothing is truncated
SELECT bool_and(EXISTS (SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                          AND t.tgenabled = 'O' AND t.tgname = c.relname || '_append_only'))
       AND count(*) = 4 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'observation'::regnamespace
   AND c.relname IN ('schema_documents', 'schema_snapshots', 'schema_baselines', 'drift_checks');

-- check: a baseline needs a complete snapshot and a finding is open once per key
SELECT EXISTS (SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'observation.schema_baselines'::regclass
                 AND t.tgname = 'schema_baselines_guard' AND t.tgenabled = 'O')
       AND EXISTS (SELECT FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
                    WHERE ic.relname = 'findings_one_open' AND i.indisunique
                      AND ic.relnamespace = 'observation'::regnamespace)
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'observation.schema_snapshots'::regclass
                    AND k.contype = 'c' AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%jsonb_array_length(visibility) = 0%') AS ok;

-- check: the partition functions are owner functions that only the worker may call
SELECT bool_and(p.prosecdef AND p.proowner = 'exdb_migrate'::regrole
                AND has_function_privilege('exdb_worker', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('exdb_serve', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
       AND count(*) = 2 AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'observation'::regnamespace
   AND p.proname IN ('ensure_sample_partitions', 'drop_expired_sample_partitions');

-- check: serve never writes the health state, samples or baselines; no runtime role deletes
SELECT NOT has_table_privilege('exdb_serve', 'observation.target_status', 'INSERT, UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'observation.health_samples', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'observation.schema_baselines', 'INSERT')
       AND has_table_privilege('exdb_worker', 'observation.target_status', 'INSERT, UPDATE')
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c
                        WHERE c.relnamespace = 'observation'::regnamespace AND c.relkind IN ('r', 'p')
                          AND (has_table_privilege('exdb_serve', c.oid, 'DELETE, TRUNCATE')
                               OR has_table_privilege('exdb_worker', c.oid, 'DELETE, TRUNCATE'))) AS ok;

-- check: a finding's identity cannot be changed by any runtime role
SELECT NOT has_column_privilege(r, 'observation.findings', 'target_id', 'UPDATE')
       AND NOT has_column_privilege(r, 'observation.findings', 'dedup_key', 'UPDATE')
       AND NOT has_column_privilege(r, 'observation.findings', 'first_seen_at', 'UPDATE') AS ok
  FROM pg_catalog.unnest(ARRAY['exdb_serve', 'exdb_worker']) r;
