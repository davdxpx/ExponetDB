-- check: the excused-value tables exist with their keys
SELECT to_regclass('migrations.excused_value_key') IS NOT NULL
   AND to_regclass('migrations.import_value_keys') IS NOT NULL
   AND to_regclass('migrations.import_value_digests') IS NOT NULL AS ok;

-- check: every table is guarded against change and removal
SELECT count(*) = 3 AS ok
  FROM pg_trigger
 WHERE NOT tgisinternal AND tgname IN ('excused_value_key_guard', 'import_value_keys_guard',
                                       'import_value_digests_guard');

-- check: the worker writes, serve reads only which key a report used, never a digest
SELECT has_table_privilege('exdb_worker', 'migrations.import_value_digests', 'INSERT')
   AND has_table_privilege('exdb_worker', 'migrations.excused_value_key', 'INSERT')
   AND has_table_privilege('exdb_serve', 'migrations.import_value_keys', 'SELECT')
   AND NOT has_table_privilege('exdb_serve', 'migrations.import_value_digests', 'SELECT')
   AND NOT has_table_privilege('exdb_serve', 'migrations.excused_value_key', 'SELECT')
   AND NOT has_table_privilege('exdb_worker', 'migrations.import_value_digests', 'UPDATE') AS ok;
