-- check: the schema belongs to exdb_migrate and only serve and the worker use it
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'migrations', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'migrations', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'migrations', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'migrations', 'USAGE')
       AND NOT has_schema_privilege('public', 'migrations', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'migrations';

-- check: serve stores bundle revisions and changes nothing else here
SELECT has_table_privilege('exdb_serve', 'migrations.bundle_revisions', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'migrations.bundle_revisions', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'migrations.bundle_revisions', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'migrations.ledger_mirror', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'migrations.verification_mirror', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'migrations.operation_migrations', 'INSERT') AS ok;

-- check: the worker writes the mirrors and the progress, never a bundle
SELECT NOT has_table_privilege('exdb_worker', 'migrations.bundle_revisions', 'INSERT')
       AND has_table_privilege('exdb_worker', 'migrations.ledger_mirror', 'INSERT')
       AND has_table_privilege('exdb_worker', 'migrations.verification_mirror', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'migrations.verification_mirror', 'UPDATE')
       AND has_table_privilege('exdb_worker', 'migrations.operation_migrations', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'migrations.ledger_mirror', 'DELETE') AS ok;

-- check: bundle revisions and verification runs refuse every change after insert
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgname IN ('bundle_revisions_immutable', 'bundle_revisions_no_truncate', 'verification_mirror_immutable')
   AND NOT t.tgisinternal;

-- check: projects carry execution roles and trusted extensions, written by the worker only
SELECT has_column_privilege('exdb_worker', 'registry.projects', 'execution_roles', 'UPDATE')
       AND has_column_privilege('exdb_worker', 'registry.projects', 'trusted_extensions', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'registry.projects', 'execution_roles', 'UPDATE') AS ok;
