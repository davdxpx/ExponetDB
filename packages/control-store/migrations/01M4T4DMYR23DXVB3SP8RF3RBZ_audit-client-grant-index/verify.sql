-- check: both audit filter indexes exist on the partitioned table
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_indexes
 WHERE schemaname = 'audit' AND tablename = 'audit_events'
   AND indexname IN ('audit_events_client', 'audit_events_grant');
