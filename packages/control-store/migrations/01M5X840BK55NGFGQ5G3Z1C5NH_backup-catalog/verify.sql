-- check: no secret column exists in the backup schema
SELECT NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'backups'
                    AND column_name ~ '(passphrase|password|secret_key|access_key|cipher_pass|credential)') AS ok;

-- check: a lock is never stored as proven and secrets come only from the host
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'backups.repositories'::regclass
                AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%lock_capability%unproven%'
                AND pg_get_constraintdef(c.oid) NOT LIKE '%''proven''%')
   AND EXISTS (SELECT FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'backups.repositories'::regclass
                AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%secret_source = ''host_config''%') AS ok;

-- check: at most one open engine run per cluster; clones are refused
SELECT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'backups' AND indexname = 'runs_one_open_per_cluster')
   AND EXISTS (SELECT FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'backups.restores'::regclass
                AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%purpose%drill%recovery%'
                AND pg_get_constraintdef(c.oid) NOT LIKE '%clone%') AS ok;

-- check: backup obligations guard the cluster's retirement; guards are in place
SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'clusters_backup_obligations'
                 AND tgrelid = 'registry.clusters'::regclass AND NOT tgisinternal)
   AND (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'backups' AND t.tgname LIKE '%guard' AND NOT t.tgisinternal) = 6 AS ok;

-- check: serve only reads; nobody deletes
SELECT bool_and(has_table_privilege('exdb_serve', format('backups.%I', c.relname), 'SELECT')
            AND NOT has_table_privilege('exdb_serve', format('backups.%I', c.relname), 'INSERT')
            AND NOT has_table_privilege('exdb_serve', format('backups.%I', c.relname), 'UPDATE')
            AND NOT has_table_privilege('exdb_worker', format('backups.%I', c.relname), 'DELETE')) AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'backups' AND c.relkind = 'r';
