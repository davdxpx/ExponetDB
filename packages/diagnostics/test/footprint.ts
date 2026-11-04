import { type TestServer, withSuperuser } from '@exponetdb/testkit'

/**
 * What ExponetDB could have written to the database and the cluster: schemas, relations,
 * functions and comments with their owners and ACLs, the database's owner and ACL, default
 * privileges, extensions, and ExponetDB's roles with their attributes, the observer's
 * memberships and the role settings in this database. Large lists are compared by digest.
 */
export const catalogFootprint = (server: TestServer, database: string) =>
  withSuperuser(server, database, async (c) => {
    const r = await c.query(
      `SELECT (SELECT array_agg(nspname::text ORDER BY nspname) FROM pg_catalog.pg_namespace) AS schemas,
              (SELECT md5(string_agg(n.nspname || ':' || n.nspowner::regrole::text || ':' || coalesce(n.nspacl::text, ''), ',' ORDER BY n.nspname))
                 FROM pg_catalog.pg_namespace n) AS namespace_acls,
              (SELECT count(*)::int FROM pg_catalog.pg_class) AS relations,
              (SELECT md5(string_agg(c.oid::text || ':' || c.relowner::regrole::text || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.oid))
                 FROM pg_catalog.pg_class c) AS relation_acls,
              (SELECT count(*)::int FROM pg_catalog.pg_proc) AS functions,
              (SELECT md5(string_agg(p.oid::text || ':' || p.proowner::regrole::text || ':' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid))
                 FROM pg_catalog.pg_proc p) AS function_acls,
              (SELECT count(*)::int FROM pg_catalog.pg_description) AS comments,
              (SELECT d.datdba::regrole::text || ':' || coalesce(d.datacl::text, '')
                 FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS database_acl,
              (SELECT count(*)::int FROM pg_catalog.pg_default_acl) AS default_acls,
              (SELECT array_agg(e.extname || ':' || e.extversion || ':' || e.extowner::regrole::text ORDER BY e.extname)
                 FROM pg_catalog.pg_extension e) AS extensions,
              (SELECT array_agg(r.rolname || ':' || r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication
                                || r.rolbypassrls || r.rolcanlogin || r.rolinherit ORDER BY r.rolname)
                 FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'exponetdb\\_%') AS roles,
              (SELECT array_agg(g.rolname || ':' || a.inherit_option || a.set_option || a.admin_option ORDER BY g.rolname)
                 FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
                WHERE a.member = 'exponetdb_observer'::regrole) AS observer_memberships,
              (SELECT count(*)::int FROM pg_catalog.pg_db_role_setting s
                 JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
                WHERE d.datname = pg_catalog.current_database()) AS database_role_settings`,
    )
    return r.rows[0]
  })
