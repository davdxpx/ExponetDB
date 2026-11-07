-- check: repositories record the operation that attested the offline key copy, together with the time
SELECT EXISTS (SELECT FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = 'backups.repositories'::regclass
                  AND a.attname = 'offline_copy_attested_by_operation_id'
                  AND NOT a.attnotnull AND NOT a.attisdropped)
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint c
                    WHERE c.conrelid = 'backups.repositories'::regclass
                      AND c.conname = 'repositories_offline_copy_attested' AND c.convalidated)
       AND NOT EXISTS (SELECT FROM backups.repositories
                        WHERE (offline_copy_confirmed_at IS NULL) <> (offline_copy_attested_by_operation_id IS NULL)) AS ok;

-- check: the worker records an attestation; serve only reads
SELECT has_column_privilege('exdb_worker', 'backups.repositories', 'offline_copy_attested_by_operation_id', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'backups.repositories', 'offline_copy_confirmed_at', 'UPDATE')
   AND has_column_privilege('exdb_serve', 'backups.repositories', 'offline_copy_attested_by_operation_id', 'SELECT')
   AND NOT has_column_privilege('exdb_serve', 'backups.repositories', 'offline_copy_attested_by_operation_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'backups.repositories', 'offline_copy_confirmed_at', 'UPDATE') AS ok;

-- check: the guard takes an attestation only from its own operation, and still guards the row
SELECT pg_get_functiondef('backups.repository_guard()'::regprocedure) LIKE '%backup.repository.attest_offline_key%'
   AND pg_get_functiondef('backups.repository_guard()'::regprocedure) LIKE '%an unencrypted repository has no key to attest%'
   AND pg_get_functiondef('backups.repository_guard()'::regprocedure) LIKE '%a retired repository record never changes%'
   AND EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'backups.repositories'::regclass AND t.tgname = 'repositories_guard'
                  AND t.tgenabled = 'O') AS ok;
