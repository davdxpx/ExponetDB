-- check: a snapshot may be taken for a drift acceptance; the baseline reason and the resolution exist
SELECT pg_get_constraintdef(s.oid) LIKE '%''drift_accept''%'
       AND pg_get_constraintdef(b.oid) LIKE '%''drift_accept''%'
       AND pg_get_constraintdef(f.oid) LIKE '%''accepted''%' AS ok
  FROM pg_catalog.pg_constraint s, pg_catalog.pg_constraint b, pg_catalog.pg_constraint f
 WHERE s.conrelid = 'observation.schema_snapshots'::regclass AND s.conname = 'schema_snapshots_purpose_check'
   AND b.conrelid = 'observation.schema_baselines'::regclass AND b.conname = 'schema_baselines_reason_check'
   AND f.conrelid = 'observation.findings'::regclass AND f.conname = 'findings_resolution_check';

-- check: only the worker records baselines; it may resolve findings
SELECT has_table_privilege('exdb_worker', 'observation.schema_baselines', 'INSERT')
   AND has_column_privilege('exdb_worker', 'observation.findings', 'resolution', 'UPDATE')
   AND NOT has_table_privilege('exdb_serve', 'observation.schema_baselines', 'INSERT') AS ok;
