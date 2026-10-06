-- check: registry schema is owned by exdb_migrate and not usable by PUBLIC, gateway or audit maintenance
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND NOT has_schema_privilege('public', 'registry', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'registry', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'registry', 'USAGE')
       AND has_schema_privilege('exdb_serve', 'registry', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'registry', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'registry';

-- check: the registry tables exist and belong to exdb_migrate
SELECT count(*) = 10 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'registry'::regnamespace AND c.relkind = 'r'
   AND c.relname IN ('products', 'environments', 'projects', 'servers', 'clusters', 'endpoints', 'databases',
                     'targets', 'placements', 'credentials')
   AND c.relowner = 'exdb_migrate'::regrole;

-- check: every registry table has its guard, refuses deletion and truncation
SELECT bool_and(
         EXISTS (SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                   AND t.tgenabled = 'O' AND t.tgname = c.relname || '_guard')
         AND EXISTS (SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                   AND t.tgenabled = 'O' AND t.tgname = c.relname || '_no_delete')
         AND EXISTS (SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                   AND t.tgenabled = 'O' AND t.tgname = c.relname || '_no_truncate')) AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'registry'::regnamespace AND c.relkind = 'r'
   AND c.relname IN ('products', 'environments', 'projects', 'servers', 'clusters', 'endpoints', 'databases',
                     'targets', 'placements', 'credentials');

-- check: one live target per path and per project and environment, one current placement per target and per database
SELECT count(*) = 4 AS ok
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
 WHERE i.indisunique AND i.indpred IS NOT NULL
   AND ic.relname IN ('targets_one_live_path', 'targets_one_live_pair', 'placements_one_current_per_target',
                      'placements_one_current_per_database')
   AND ic.relnamespace = 'registry'::regnamespace;

-- check: at most one active and one pending credential per cluster and role, one row per secret version
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
 WHERE i.indisunique
   AND ic.relname IN ('credentials_one_active', 'credentials_one_pending', 'credentials_one_row_per_secret_version')
   AND ic.relnamespace = 'registry'::regnamespace;

-- check: serve reads the registry and writes nothing but a credential submission
SELECT bool_and(has_table_privilege('exdb_serve', c.oid, 'SELECT')
                AND NOT has_table_privilege('exdb_serve', c.oid, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
                AND (c.relname = 'credentials' OR NOT has_table_privilege('exdb_serve', c.oid, 'INSERT, UPDATE'))) AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'registry'::regnamespace AND c.relkind = 'r';

-- check: serve changes a credential's state only (superseding a pending one), never its secret pointer
SELECT has_column_privilege('exdb_serve', 'registry.credentials', 'state', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'registry.credentials', 'secret_id', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'registry.credentials', 'secret_version', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'registry.credentials', 'verified_at', 'UPDATE')
       AND pg_catalog.pg_get_functiondef('registry.credential_guard()'::regprocedure) LIKE '%serve only supersedes a pending credential%' AS ok;

-- check: the worker writes the registry through operations and no runtime role deletes
SELECT bool_and(c.relname NOT IN ('products', 'environments', 'projects', 'servers', 'clusters', 'endpoints',
                                  'databases', 'targets', 'placements', 'credentials')
                OR has_table_privilege('exdb_worker', c.oid, 'SELECT, INSERT'))
       AND bool_and(NOT has_table_privilege('exdb_worker', c.oid, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
                    AND NOT has_table_privilege('exdb_serve', c.oid, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')) AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'registry'::regnamespace AND c.relkind = 'r';

-- check: identity columns cannot be updated by any runtime role
SELECT NOT has_column_privilege(r, 'registry.targets', 'path', 'UPDATE')
       AND NOT has_column_privilege(r, 'registry.targets', 'tier', 'UPDATE')
       AND NOT has_column_privilege(r, 'registry.clusters', 'ca_bundle', 'UPDATE')
       AND NOT has_column_privilege(r, 'registry.endpoints', 'host', 'UPDATE')
       AND NOT has_column_privilege(r, 'registry.products', 'slug', 'UPDATE') AS ok
  FROM pg_catalog.unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) r;

-- check: a cluster's system identifier is pinned once (the guard refuses a change after confirmation)
SELECT pg_catalog.pg_get_functiondef('registry.cluster_guard()'::regprocedure) LIKE '%pinned once%' AS ok;

-- check: the derived tier views exist and are readable by serve and the worker
SELECT count(*) = 2
       AND bool_and(has_table_privilege('exdb_serve', c.oid, 'SELECT') AND has_table_privilege('exdb_worker', c.oid, 'SELECT')) AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'registry'::regnamespace AND c.relkind = 'v'
   AND c.relname IN ('cluster_tiers', 'server_tiers');
