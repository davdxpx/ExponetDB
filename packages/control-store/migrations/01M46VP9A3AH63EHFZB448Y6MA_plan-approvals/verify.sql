-- check: approvals are append-only and checked by the database on insert
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'approvals.plan_approvals'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
   AND t.tgname IN ('plan_approvals_guard', 'plan_approvals_append_only', 'plan_approvals_no_truncate');

-- check: one decision per approver and operation; approvals come from the Web App only
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = 'approvals.plan_approvals'::regclass AND k.contype = 'u'
                  AND pg_get_constraintdef(k.oid) = 'UNIQUE (operation_id, approver_identity_id)')
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint k
                    WHERE k.conrelid = 'approvals.plan_approvals'::regclass AND k.contype = 'c'
                      AND pg_get_constraintdef(k.oid) LIKE '%approver_client = ''web''%') AS ok;

-- check: serve records, the worker reads, nobody changes or deletes a decision
SELECT has_table_privilege('exdb_serve', 'approvals.plan_approvals', 'SELECT, INSERT')
       AND has_table_privilege('exdb_worker', 'approvals.plan_approvals', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'approvals.plan_approvals', 'INSERT')
       AND bool_and(NOT has_table_privilege(r, 'approvals.plan_approvals', 'UPDATE')
                    AND NOT has_table_privilege(r, 'approvals.plan_approvals', 'DELETE')
                    AND NOT has_table_privilege(r, 'approvals.plan_approvals', 'TRUNCATE'))
       AND NOT has_schema_privilege('exdb_gateway', 'approvals', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'approvals', 'USAGE') AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r;

-- check: PUBLIC holds nothing in the approvals schema
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'approvals'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'approvals'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;
