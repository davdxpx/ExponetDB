-- check: the lane tables exist
SELECT count(*) = 2 AS ok
  FROM information_schema.tables
 WHERE table_schema = 'dataread' AND table_name IN ('workers', 'reads');

-- check: PUBLIC has no access to the lane schema
SELECT NOT has_schema_privilege('public', 'dataread', 'USAGE') AS ok;

-- check: serve submits and cancels but never writes a result
SELECT has_table_privilege('exdb_serve', 'dataread.reads', 'INSERT')
       AND has_column_privilege('exdb_serve', 'dataread.reads', 'cancel_requested', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'dataread.reads', 'result', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'dataread.reads', 'state', 'UPDATE') AS ok;

-- check: the worker writes results but never submits a read or changes who asked
SELECT has_column_privilege('exdb_worker', 'dataread.reads', 'result', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'dataread.reads', 'INSERT')
       AND NOT has_column_privilege('exdb_worker', 'dataread.reads', 'identity_id', 'UPDATE')
       AND NOT has_column_privilege('exdb_worker', 'dataread.reads', 'request', 'UPDATE') AS ok;
