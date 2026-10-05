-- check: ac1 in SQL reproduces golden vector ac1-001
SELECT audit.ac1(
  'ac1:genesis:ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  '{"action":"operation.accepted","actor":{"identityId":null,"kind":"system","label":"system:worker"},"id":"aud_01JB2Z6G8M4Q7R9T1V3W5X7Y00","occurredAt":"2026-10-05T12:00:00.000001Z","phase":"accepted","schema":"exponetdb.audit/v1","seq":1}'
) = 'sha256:ac1:f1b307c71c438bf48c173c266b56756ae9bf674bfcdf17f76922fc3b918825db' AS ok;

-- check: audit events are range-partitioned and a partition covers the current month
SELECT c.relkind = 'p'
       AND EXISTS (SELECT FROM audit.partition_inventory p
                    WHERE p.lower_bound <= clock_timestamp() AND clock_timestamp() < p.upper_bound) AS ok
  FROM pg_catalog.pg_class c WHERE c.oid = 'audit.audit_events'::regclass;

-- check: the chain guard and the append-only triggers are enabled
SELECT count(*) = 6 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgparentid = 0
   AND (t.tgrelid, t.tgname) IN (
     ('audit.audit_events'::regclass, 'audit_events_chain_guard'),
     ('audit.audit_events'::regclass, 'audit_events_append_only'),
     ('audit.audit_events'::regclass, 'audit_events_no_truncate'),
     ('audit.audit_chain_checkpoints'::regclass, 'checkpoints_append_only'),
     ('audit.checkpoint_exports'::regclass, 'exports_append_only'),
     ('audit.audit_chain_checkpoints'::regclass, 'checkpoints_match_chain'));

-- check: no role may update, delete or truncate audit rows; every role may insert and read
SELECT bool_and(has_table_privilege(r, 'audit.audit_events', 'SELECT, INSERT')
                AND NOT has_table_privilege(r, 'audit.audit_events', 'UPDATE')
                AND NOT has_table_privilege(r, 'audit.audit_events', 'DELETE')
                AND NOT has_table_privilege(r, 'audit.audit_events', 'TRUNCATE')
                AND NOT has_table_privilege(r, 'audit.audit_chain_checkpoints', 'UPDATE, DELETE, TRUNCATE')
                AND NOT has_table_privilege(r, 'audit.checkpoint_exports', 'UPDATE, DELETE, TRUNCATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r;

-- check: only exdb_audit_maint may drop expired partitions; worker and maint may extend
SELECT has_function_privilege('exdb_audit_maint', 'audit.drop_expired_partition(text, integer)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_worker', 'audit.drop_expired_partition(text, integer)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_serve', 'audit.drop_expired_partition(text, integer)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_gateway', 'audit.drop_expired_partition(text, integer)', 'EXECUTE')
       AND has_function_privilege('exdb_worker', 'audit.ensure_partitions(integer)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_serve', 'audit.ensure_partitions(integer)', 'EXECUTE') AS ok;

-- check: PUBLIC holds no privilege on audit tables, partitions or functions
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'audit'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'audit'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;
