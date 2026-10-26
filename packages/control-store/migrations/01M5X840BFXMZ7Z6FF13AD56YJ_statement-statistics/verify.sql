-- check: no stored delta can be negative
SELECT bool_and(EXISTS (SELECT FROM pg_catalog.pg_constraint c
                         WHERE c.conrelid = 'observation.statement_deltas'::regclass AND c.contype = 'c'
                           AND pg_get_constraintdef(c.oid) LIKE '%' || col || ' >= %')) AS ok
  FROM unnest(ARRAY['calls', 'total_time_ms', 'rows', 'blks_hit', 'blks_read']) AS col;

-- check: deltas are guarded and history is append-only
SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'statement_deltas_guard' AND NOT tgisinternal)
   AND EXISTS (SELECT FROM pg_trigger WHERE tgname = 'statement_samples_append_only' AND NOT tgisinternal) AS ok;

-- check: serve only reads; the worker never deletes
SELECT has_table_privilege('exdb_serve', 'observation.statement_samples', 'SELECT')
   AND NOT has_table_privilege('exdb_serve', 'observation.statement_samples', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'observation.statement_latest', 'UPDATE')
   AND NOT has_table_privilege('exdb_worker', 'observation.statement_samples', 'DELETE')
   AND NOT has_table_privilege('exdb_worker', 'observation.statement_daily', 'DELETE') AS ok;

-- check: today's delta partition exists
SELECT to_regclass(format('observation.statement_deltas_d%s', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDD'))) IS NOT NULL AS ok;
