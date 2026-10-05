-- Invariants that later, additive bundles keep: the built-in rows exist,
-- forbidden privileges are absent. The exact role matrix is compared with
-- the release's code by the server at startup (a later bundle may add a
-- permission row together with the code that lists it).

-- check: the six built-in roles exist and are marked built-in
SELECT count(*) = 6 AS ok FROM auth.roles r
 WHERE r.built_in AND r.role_id IN ('owner', 'admin', 'operator', 'developer', 'viewer', 'auditor');

-- check: every seeded permission row of the Wave 3A matrix is present
SELECT NOT EXISTS (
  SELECT FROM (VALUES
                ('owner', 'targets.read'),
                ('owner', 'schema.read'),
                ('owner', 'schema.manage'),
                ('owner', 'diagnostics.read'),
                ('owner', 'diagnostics.read_sensitive'),
                ('owner', 'data.read'),
                ('owner', 'data.read_sensitive'),
                ('owner', 'migrations.read'),
                ('owner', 'migrations.plan'),
                ('owner', 'migrations.apply'),
                ('owner', 'migrations.import'),
                ('owner', 'connections.operate'),
                ('owner', 'backups.read'),
                ('owner', 'backups.run'),
                ('owner', 'restore.plan'),
                ('owner', 'restore.execute'),
                ('owner', 'nodes.read'),
                ('owner', 'nodes.plan'),
                ('owner', 'nodes.operate'),
                ('owner', 'plans.approve'),
                ('owner', 'operations.recover'),
                ('owner', 'breakglass.activate'),
                ('owner', 'audit.read'),
                ('owner', 'registry.manage'),
                ('owner', 'access.read'),
                ('owner', 'access.manage'),
                ('owner', 'policy.manage'),
                ('admin', 'targets.read'),
                ('admin', 'schema.read'),
                ('admin', 'schema.manage'),
                ('admin', 'diagnostics.read'),
                ('admin', 'diagnostics.read_sensitive'),
                ('admin', 'data.read'),
                ('admin', 'data.read_sensitive'),
                ('admin', 'migrations.read'),
                ('admin', 'migrations.plan'),
                ('admin', 'migrations.apply'),
                ('admin', 'migrations.import'),
                ('admin', 'connections.operate'),
                ('admin', 'backups.read'),
                ('admin', 'backups.run'),
                ('admin', 'restore.plan'),
                ('admin', 'restore.execute'),
                ('admin', 'nodes.read'),
                ('admin', 'nodes.plan'),
                ('admin', 'nodes.operate'),
                ('admin', 'plans.approve'),
                ('admin', 'operations.recover'),
                ('admin', 'audit.read'),
                ('admin', 'registry.manage'),
                ('admin', 'access.read'),
                ('admin', 'access.manage'),
                ('admin', 'policy.manage'),
                ('operator', 'targets.read'),
                ('operator', 'schema.read'),
                ('operator', 'diagnostics.read'),
                ('operator', 'migrations.read'),
                ('operator', 'migrations.plan'),
                ('operator', 'migrations.apply'),
                ('operator', 'connections.operate'),
                ('operator', 'backups.read'),
                ('operator', 'backups.run'),
                ('operator', 'restore.plan'),
                ('operator', 'nodes.read'),
                ('operator', 'nodes.plan'),
                ('operator', 'nodes.operate'),
                ('operator', 'plans.approve'),
                ('operator', 'operations.recover'),
                ('operator', 'audit.read'),
                ('developer', 'targets.read'),
                ('developer', 'schema.read'),
                ('developer', 'diagnostics.read'),
                ('developer', 'data.read'),
                ('developer', 'migrations.read'),
                ('developer', 'migrations.plan'),
                ('developer', 'migrations.apply'),
                ('developer', 'backups.read'),
                ('developer', 'nodes.read'),
                ('viewer', 'targets.read'),
                ('viewer', 'schema.read'),
                ('viewer', 'diagnostics.read'),
                ('viewer', 'migrations.read'),
                ('viewer', 'backups.read'),
                ('viewer', 'nodes.read'),
                ('auditor', 'audit.read'),
                ('auditor', 'access.read'),
                ('auditor', 'targets.read'),
                ('auditor', 'schema.read'),
                ('auditor', 'diagnostics.read'),
                ('auditor', 'migrations.read'),
                ('auditor', 'backups.read'),
                ('auditor', 'nodes.read')) AS v (role_id, permission)
   WHERE NOT EXISTS (SELECT FROM auth.role_permissions p WHERE p.role_id = v.role_id AND p.permission = v.permission)) AS ok;

-- check: no permission is a wildcard or outside the dotted catalog form; auditors and viewers never read data
SELECT NOT EXISTS (SELECT FROM auth.role_permissions p WHERE p.permission !~ '^[a-z]+\.[a-z_]+$' OR p.permission ~ '[*%?]')
       AND NOT EXISTS (SELECT FROM auth.role_permissions p WHERE p.role_id IN ('auditor', 'viewer')
                        AND p.permission IN ('data.read', 'data.read_sensitive', 'diagnostics.read_sensitive'))
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conname = 'role_permissions_catalog'
                    AND k.conrelid = 'auth.role_permissions'::regclass) AS ok;

-- check: owner bindings are global only and one active binding per identity, role and scope
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conname = 'role_bindings_owner_global'
                AND k.conrelid = 'auth.role_bindings'::regclass)
       AND EXISTS (SELECT FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
                    WHERE x.relname = 'role_bindings_one_active' AND x.relnamespace = 'auth'::regnamespace
                      AND i.indisunique AND i.indpred IS NOT NULL) AS ok;

-- check: the guards, the revision trigger and the last-owner invariant are enabled
SELECT count(*) = 9 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
   AND (t.tgrelid, t.tgname) IN (('auth.roles'::regclass, 'roles_append_only'),
                                 ('auth.roles'::regclass, 'roles_no_truncate'),
                                 ('auth.role_permissions'::regclass, 'role_permissions_append_only'),
                                 ('auth.role_bindings'::regclass, 'role_bindings_guard'),
                                 ('auth.role_bindings'::regclass, 'role_bindings_no_delete'),
                                 ('auth.role_bindings'::regclass, 'role_bindings_no_truncate'),
                                 ('auth.role_bindings'::regclass, 'role_bindings_revision'),
                                 ('auth.role_bindings'::regclass, 'role_bindings_owner_invariant'),
                                 ('auth.identities'::regclass, 'identities_owner_invariant'));

-- check: only the worker changes bindings; nobody changes roles or their permissions
SELECT NOT has_table_privilege('exdb_serve', 'auth.role_bindings', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'auth.role_bindings', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'auth.role_bindings', 'DELETE')
       AND NOT has_table_privilege('exdb_worker', 'auth.role_bindings', 'DELETE')
       AND has_table_privilege('exdb_worker', 'auth.role_bindings', 'INSERT')
       AND bool_and(NOT has_table_privilege(r, t, 'INSERT') AND NOT has_table_privilege(r, t, 'UPDATE')
                    AND NOT has_table_privilege(r, t, 'DELETE') AND NOT has_table_privilege(r, t, 'TRUNCATE')) AS ok
  FROM unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r,
       unnest(ARRAY['auth.roles', 'auth.role_permissions']) AS t;

-- check: only serve may run the first-owner activation, and nobody else any function of the schema
SELECT has_function_privilege('exdb_serve', 'auth.activate_bootstrap_owner(text, text)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_worker', 'auth.activate_bootstrap_owner(text, text)', 'EXECUTE')
       AND NOT has_function_privilege('exdb_gateway', 'auth.activate_bootstrap_owner(text, text)', 'EXECUTE')
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p
                        WHERE p.pronamespace = 'auth'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE'))
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
                        WHERE c.relnamespace = 'auth'::regnamespace AND a.grantee = 0) AS ok;
