-- check: import items carry an evidence strength from the closed list
SELECT count(*) = 1 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'migrations' AND table_name = 'import_items'
   AND column_name = 'evidence_strength' AND is_nullable = 'YES';

-- check: import reports carry the drift total and the truncation flag
SELECT count(*) = 2 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'migrations' AND table_name = 'import_reports'
   AND column_name IN ('drift_total', 'drift_truncated');

-- check: both are guarded, and only the worker writes the drift totals
SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'import_items_evidence_guard'
                 AND tgrelid = 'migrations.import_items'::regclass AND NOT tgisinternal)
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'import_reports_drift_guard'
                 AND tgrelid = 'migrations.import_reports'::regclass AND NOT tgisinternal)
   AND has_column_privilege('exdb_worker', 'migrations.import_reports', 'drift_truncated', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'migrations.import_reports', 'drift_truncated', 'UPDATE')
   AND NOT has_column_privilege('exdb_serve', 'migrations.import_items', 'evidence_strength', 'UPDATE') AS ok;
