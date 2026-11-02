-- check: the chain guard takes a marked head time while the head is at most 24 hours ahead
SELECT pg_get_functiondef('audit.chain_guard()'::regprocedure) LIKE '%audit.clock_skew_marks%'
   AND pg_get_functiondef('audit.chain_guard()'::regprocedure) LIKE '%interval ''24 hours''%'
   AND pg_get_functiondef('audit.chain_guard()'::regprocedure) LIKE '%audit.ac1(NEW.prev_hash, NEW.event)%' AS ok;

-- check: the chain guard trigger is still the one of the audit-chain bundle and enabled
SELECT EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'audit.audit_events'::regclass AND t.tgname = 'audit_events_chain_guard'
                  AND t.tgenabled = 'O' AND t.tgfoid = 'audit.chain_guard()'::regprocedure) AS ok;

-- check: the marks are append-only and no role may change or remove one
SELECT bool_and(has_table_privilege(r, 'audit.clock_skew_marks', 'SELECT, INSERT')
                AND NOT has_table_privilege(r, 'audit.clock_skew_marks', 'UPDATE')
                AND NOT has_table_privilege(r, 'audit.clock_skew_marks', 'DELETE')
                AND NOT has_table_privilege(r, 'audit.clock_skew_marks', 'TRUNCATE'))
       AND (SELECT count(*) = 2 FROM pg_catalog.pg_trigger t
             WHERE t.tgrelid = 'audit.clock_skew_marks'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O') AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r;
