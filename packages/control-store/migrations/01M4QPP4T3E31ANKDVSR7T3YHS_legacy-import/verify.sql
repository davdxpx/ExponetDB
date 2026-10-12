-- check: serve records reports, files and decisions; the worker writes results
SELECT has_table_privilege('exdb_serve', 'migrations.import_reports', 'INSERT')
       AND has_table_privilege('exdb_serve', 'migrations.import_files', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'migrations.import_items', 'INSERT')
       AND has_column_privilege('exdb_serve', 'migrations.import_items', 'decision_state', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'migrations.import_items', 'state', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'migrations.import_reports', 'state', 'UPDATE')
       AND has_table_privilege('exdb_worker', 'migrations.import_items', 'INSERT')
       AND has_column_privilege('exdb_worker', 'migrations.import_reports', 'state', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'migrations.import_items', 'decision_state', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'migrations.import_files', 'INSERT')
       AND NOT has_table_privilege('exdb_gateway', 'migrations.import_reports', 'SELECT') AS ok;

-- check: files are immutable, items change only their decision, nothing is deleted
SELECT count(*) = 4 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgname IN ('import_files_immutable', 'import_files_no_truncate', 'import_items_guard',
                    'import_items_no_truncate')
   AND NOT t.tgisinternal;
