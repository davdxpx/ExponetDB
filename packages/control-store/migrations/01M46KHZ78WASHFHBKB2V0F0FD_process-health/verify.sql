-- check: heartbeat and task tables exist and belong to exdb_migrate
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'control'::regnamespace AND c.relkind = 'r'
   AND c.relname IN ('process_heartbeats', 'maintenance_tasks')
   AND c.relowner = 'exdb_migrate'::regrole;

-- check: row-level security is enabled on heartbeats with eight policies
SELECT c.relrowsecurity
       AND (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) = 8 AS ok
  FROM pg_catalog.pg_class c WHERE c.oid = 'control.process_heartbeats'::regclass;

-- check: runtime roles may insert heartbeats and update only the beat columns
SELECT bool_and(has_table_privilege(r, 'control.process_heartbeats', 'SELECT, INSERT')
                AND has_column_privilege(r, 'control.process_heartbeats', 'heartbeat_at', 'UPDATE')
                AND NOT has_column_privilege(r, 'control.process_heartbeats', 'role', 'UPDATE')
                AND NOT has_column_privilege(r, 'control.process_heartbeats', 'process_id', 'UPDATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway']) AS r;

-- check: only the worker prunes heartbeats and holds maintenance leases
SELECT has_table_privilege('exdb_worker', 'control.process_heartbeats', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'control.process_heartbeats', 'DELETE')
       AND NOT has_table_privilege('exdb_gateway', 'control.process_heartbeats', 'DELETE')
       AND has_table_privilege('exdb_worker', 'control.maintenance_tasks', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'control.maintenance_tasks', 'UPDATE')
       AND NOT has_table_privilege('exdb_gateway', 'control.maintenance_tasks', 'UPDATE') AS ok;

-- check: PUBLIC holds no privilege on the new tables
SELECT NOT EXISTS (
  SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.oid IN ('control.process_heartbeats'::regclass, 'control.maintenance_tasks'::regclass)
     AND a.grantee = 0) AS ok;
