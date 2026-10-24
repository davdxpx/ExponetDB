-- check: import items carry their failing expectations as an array or nothing
SELECT count(*) = 1 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'migrations' AND table_name = 'import_items'
   AND column_name = 'failing' AND data_type = 'jsonb' AND is_nullable = 'YES';

-- check: the column is guarded, and serve may not change it
SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'import_items_failing_guard'
                 AND tgrelid = 'migrations.import_items'::regclass AND NOT tgisinternal)
   AND NOT has_column_privilege('exdb_serve', 'migrations.import_items', 'failing', 'UPDATE')
   AND has_column_privilege('exdb_worker', 'migrations.import_items', 'failing', 'INSERT') AS ok;
