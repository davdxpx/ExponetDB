-- check: a snapshot may be taken for a migration and a baseline recorded for one
SELECT pg_get_constraintdef(s.oid) LIKE '%''migration''%'
       AND pg_get_constraintdef(b.oid) LIKE '%''migration''%' AS ok
  FROM pg_catalog.pg_constraint s, pg_catalog.pg_constraint b
 WHERE s.conrelid = 'observation.schema_snapshots'::regclass AND s.conname = 'schema_snapshots_purpose_check'
   AND b.conrelid = 'observation.schema_baselines'::regclass AND b.conname = 'schema_baselines_reason_check';

-- check: baselines stay append-only and checked against their snapshot
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'observation.schema_baselines'::regclass
   AND t.tgname IN ('schema_baselines_guard', 'schema_baselines_append_only')
   AND NOT t.tgisinternal;
