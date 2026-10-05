-- check: control schema is owned by exdb_migrate and not usable by PUBLIC
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND NOT has_schema_privilege('public', 'control', 'USAGE')
       AND NOT has_schema_privilege('public', 'control', 'CREATE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'control';

-- check: foundation tables exist and belong to exdb_migrate
SELECT count(*) = 4 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'control'::regnamespace AND c.relkind = 'r'
   AND c.relname IN ('installation', 'settings', 'schema_migrations', 'migration_verifications')
   AND c.relowner = 'exdb_migrate'::regrole;

-- check: ledger columns have the expected types
SELECT count(*) = 12 AS ok
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = 'control.schema_migrations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
   AND (a.attname, format_type(a.atttypid, a.atttypmod)) IN (
     ('migration_id', 'text'), ('name', 'text'), ('checksum', 'text'), ('verify_digest', 'text'),
     ('rollback_digest', 'text'), ('bundle_digest', 'text'), ('dependencies', 'text[]'),
     ('applied_seq', 'bigint'), ('applied_at', 'timestamp with time zone'),
     ('apply_duration_ms', 'integer'), ('engine_version', 'text'), ('pg_version_num', 'integer'));

-- check: verification history references the ledger
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_constraint k
 WHERE k.conrelid = 'control.migration_verifications'::regclass AND k.contype = 'f'
   AND k.confrelid = 'control.schema_migrations'::regclass;

-- check: append-only triggers guard the marker, the ledger and the verification history
SELECT count(*) = 6 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
   AND t.tgfoid = 'control.reject_change()'::regprocedure
   AND t.tgrelid IN ('control.installation'::regclass, 'control.schema_migrations'::regclass,
                     'control.migration_verifications'::regclass);

-- check: runtime roles can read but not change the ledger
SELECT bool_and(has_table_privilege(r, 'control.schema_migrations', 'SELECT')
                AND NOT has_table_privilege(r, 'control.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE')
                AND has_table_privilege(r, 'control.installation', 'SELECT')
                AND NOT has_table_privilege(r, 'control.installation', 'INSERT, UPDATE, DELETE, TRUNCATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r;

-- check: PUBLIC holds no privilege on any control table and cannot execute its functions
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'control'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'control'::regnamespace
            AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;

-- check: new functions of exdb_migrate are not executable by PUBLIC by default
SELECT count(*) = 1 AS ok
  FROM pg_catalog.pg_default_acl d
 WHERE d.defaclrole = 'exdb_migrate'::regrole AND d.defaclobjtype = 'f' AND d.defaclnamespace = 0
   AND NOT EXISTS (SELECT FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0);
