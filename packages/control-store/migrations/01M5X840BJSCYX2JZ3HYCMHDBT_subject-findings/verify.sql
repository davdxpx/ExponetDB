-- check: a subject finding names exactly one target or one cluster, backup findings a cluster
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint c
                WHERE c.conrelid = 'observation.subject_findings'::regclass AND c.contype = 'c'
                  AND pg_get_constraintdef(c.oid) LIKE '%(target_id IS NULL) <> (cluster_id IS NULL)%') AS ok;

-- check: one open finding per subject, kind and key; guarded; never deleted
SELECT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'observation' AND indexname = 'subject_findings_one_open_target')
   AND EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'observation' AND indexname = 'subject_findings_one_open_cluster')
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'subject_findings_guard' AND NOT tgisinternal)
   AND NOT has_table_privilege('exdb_worker', 'observation.subject_findings', 'DELETE')
   AND NOT has_table_privilege('exdb_serve', 'observation.subject_findings', 'DELETE') AS ok;

-- check: the identity of a finding cannot be updated by the roles
SELECT NOT has_column_privilege('exdb_worker', 'observation.subject_findings', 'kind', 'UPDATE')
   AND NOT has_column_privilege('exdb_worker', 'observation.subject_findings', 'target_id', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'observation.subject_findings', 'dedup_key', 'UPDATE') AS ok;
