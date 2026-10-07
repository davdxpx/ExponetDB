import { sql, type TrustedSql } from '../sql.ts'
import type { SupportedMajor } from '../versions.ts'

/**
 * Introspection queries, one per object class ([postgres-adapter.md §4](../../../../exponetdb-docs/03-database-model/postgres-adapter.md#4-introspection),
 * [schema-fingerprints.md §3](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md#3-what-is-in-the-document)).
 *
 * - `pg_catalog` only (never `information_schema`, which filters by
 *   privilege and hides PostgreSQL-specific objects such as TRUNCATE
 *   triggers); roles through `pg_roles`, never `pg_authid`.
 * - User objects only (`oid >= 16384`, FirstNormalObjectId); objects that
 *   belong to an extension (`pg_depend.deptype = 'e'`) are excluded and the
 *   extension stands for them.
 * - The large classes (relations, functions, types) are read in keyset pages
 *   by OID through the catalog's OID index; their dependents (columns,
 *   constraints, indexes, triggers, policies, rules, parents) are driven
 *   from the page's OIDs (`unnest`) through the dependents' own indexes, one
 *   lateral lookup per relation behind an `OFFSET 0` fence, so the cost
 *   follows the page, never the size of the catalog (a hash join would scan
 *   the whole dependent catalog once per page: quadratic; plan guard).
 * - Every aggregate has an explicit `ORDER BY … COLLATE "C"`, and the
 *   snapshotter re-sorts every collection by its key in UTF-8 byte order;
 *   result rows are ordered for stability only. Names are
 *   returned as separate schema and name columns, never as a rendered
 *   `regclass`, so no rendering rule decides identity.
 * - Effective ACLs: `aclexplode(coalesce(acl, acldefault(kind, owner)))`,
 *   with PUBLIC as grantee 0 (never confused with a role named "Public").
 * - Version differences are chosen by major: `conenforced` (18), the
 *   collation locale column (`colliculocale` 16, `colllocale` 17+).
 *
 * Parameters are bind values: OIDs as text, OID arrays as array literals
 * built from integers by the snapshotter.
 */

/** Effective ACL of a catalog row as a sorted JSON array. */
function acl(column: TrustedSql, kind: TrustedSql, owner: TrustedSql): TrustedSql {
  return sql`(SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
      'to', CASE WHEN x.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END,
      'by', pg_catalog.pg_get_userbyid(x.grantor)::text,
      'privilege', x.privilege_type,
      'grantable', x.is_grantable)
      ORDER BY (CASE WHEN x.grantee = 0 THEN '' ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END) COLLATE "C",
               x.privilege_type COLLATE "C", pg_catalog.pg_get_userbyid(x.grantor)::text COLLATE "C")
    FROM pg_catalog.aclexplode(COALESCE(${column}, pg_catalog.acldefault(${kind}, ${owner}))) x)`
}

/** Explicit column ACL only (columns have no default). */
function columnAcl(column: TrustedSql): TrustedSql {
  return sql`(SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
      'to', CASE WHEN x.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END,
      'by', pg_catalog.pg_get_userbyid(x.grantor)::text,
      'privilege', x.privilege_type,
      'grantable', x.is_grantable)
      ORDER BY (CASE WHEN x.grantee = 0 THEN '' ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END) COLLATE "C",
               x.privilege_type COLLATE "C", pg_catalog.pg_get_userbyid(x.grantor)::text COLLATE "C")
    FROM pg_catalog.aclexplode(${column}) x)`
}

function notExtensionMember(catalog: TrustedSql, oid: TrustedSql): TrustedSql {
  return sql`NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = ${catalog}::regclass AND d.objid = ${oid} AND d.deptype = 'e')`
}

/** Schemas of the database with their attributes (filtered to the scope by the snapshotter). */
export const SCHEMAS = sql`SELECT n.oid::text AS oid, n.nspname::text AS name, pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,
       ${acl(sql`n.nspacl`, sql`'n'`, sql`n.nspowner`)} AS acl,
       pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment,
       ${notExtensionMember(sql`'pg_catalog.pg_namespace'`, sql`n.oid`)} AS own
  FROM pg_catalog.pg_namespace n
 ORDER BY n.nspname COLLATE "C"`

/** A page of relations ($1 after oid, $2 namespace oids, $3 page size). */
export const RELATIONS = sql`SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind,
       c.relpersistence::text AS persistence, c.relispartition AS is_partition,
       CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
       CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS partition_bound,
       c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced, c.relreplident::text AS replica_identity,
       CASE WHEN c.relreplident = 'i' THEN
         (SELECT ic.relname::text FROM pg_catalog.pg_index ri JOIN pg_catalog.pg_class ic ON ic.oid = ri.indexrelid
           WHERE ri.indrelid = c.oid AND ri.indisreplident) END AS replica_identity_index,
       (SELECT am.amname::text FROM pg_catalog.pg_am am WHERE am.oid = c.relam) AS access_method,
       (SELECT pg_catalog.json_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(c.reloptions) o) AS reloptions,
       (SELECT ts.spcname::text FROM pg_catalog.pg_tablespace ts WHERE ts.oid = c.reltablespace) AS tablespace,
       pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       ${acl(sql`c.relacl`, sql`(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char"`, sql`c.relowner`)} AS acl,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS view_definition,
       c.relispopulated AS populated,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
       (SELECT pg_catalog.json_build_object(
                 'type', pg_catalog.format_type(s.seqtypid, NULL), 'start', s.seqstart::text,
                 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text,
                 'cycle', s.seqcycle, 'cache', s.seqcache::text)
          FROM pg_catalog.pg_sequence s WHERE s.seqrelid = c.oid) AS sequence,
       (SELECT pg_catalog.json_build_array(tn.nspname::text, tc.relname::text, ta.attname::text)
          FROM pg_catalog.pg_depend d
          JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
          JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
          JOIN pg_catalog.pg_attribute ta ON ta.attrelid = d.refobjid AND ta.attnum = d.refobjsubid
         WHERE c.relkind = 'S' AND d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
           AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') LIMIT 1) AS owned_by,
       (SELECT d.deptype::text FROM pg_catalog.pg_depend d
         WHERE c.relkind = 'S' AND d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
           AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'i' LIMIT 1) AS identity_owned,
       (SELECT pg_catalog.json_build_object('server', fs.srvname::text,
                 'options', (SELECT pg_catalog.json_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(ft.ftoptions) o))
          FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver
         WHERE ft.ftrelid = c.oid) AS foreign_table
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.oid > $1::oid AND c.oid >= 16384 AND c.relnamespace = ANY ($2::oid[])
   AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
   AND ${notExtensionMember(sql`'pg_catalog.pg_class'`, sql`c.oid`)}
 ORDER BY c.oid
 LIMIT $3`

/** Columns of a page of relations ($1 relation oids). */
export const COLUMNS = sql`SELECT a.attrelid::text AS rel, a.attname::text AS name, a.attnum AS num,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
       nullif(a.attidentity::text, '') AS identity, nullif(a.attgenerated::text, '') AS generated,
       CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
         (SELECT pg_catalog.json_build_array(cn.nspname::text, co.collname::text) FROM pg_catalog.pg_collation co
            JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation) END AS collation,
       CASE WHEN a.attstorage <> t.typstorage THEN a.attstorage::text END AS storage,
       nullif(a.attcompression::text, '') AS compression,
       nullif(a.attstattarget::int, -1) AS statistics_target,
       ${columnAcl(sql`a.attacl`)} AS acl,
       pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
       (SELECT pg_catalog.json_build_object(
                 'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text,
                 'max', s.seqmax::text, 'cycle', s.seqcycle, 'cache', s.seqcache::text,
                 'type', pg_catalog.format_type(s.seqtypid, NULL))
          FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_sequence s ON s.seqrelid = d.objid
         WHERE a.attidentity <> '' AND d.classid = 'pg_catalog.pg_class'::regclass
           AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = a.attrelid
           AND d.refobjsubid = a.attnum AND d.deptype = 'i' LIMIT 1) AS identity_sequence,
       (SELECT ${columnAcl(sql`sc.relacl`)}
          FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class sc ON sc.oid = d.objid
         WHERE a.attidentity <> '' AND d.classid = 'pg_catalog.pg_class'::regclass
           AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = a.attrelid
           AND d.refobjsubid = a.attnum AND d.deptype = 'i' AND sc.relacl IS NOT NULL
           -- A GRANT then REVOKE leaves the default spelled out: the same privileges, no ACL.
           AND NOT (sc.relacl @> pg_catalog.acldefault('s', sc.relowner)
                    AND pg_catalog.acldefault('s', sc.relowner) @> sc.relacl) LIMIT 1) AS identity_acl
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_attribute x
                      WHERE x.attrelid = page.oid AND x.attnum > 0 AND NOT x.attisdropped OFFSET 0) a
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN LATERAL (SELECT * FROM pg_catalog.pg_attrdef y
                      WHERE y.adrelid = a.attrelid AND y.adnum = a.attnum OFFSET 0) ad ON true
 ORDER BY a.attrelid, a.attnum`

/** Constraints of a page of relations ($1 relation oids). */
export function constraints(major: SupportedMajor): TrustedSql {
  const enforced = major >= 18 ? sql`k.conenforced` : sql`true`
  return sql`SELECT k.conrelid::text AS rel, k.conname::text AS name, k.contype::text AS type,
       pg_catalog.pg_get_constraintdef(k.oid, true) AS definition,
       k.condeferrable AS deferrable, k.condeferred AS deferred, k.convalidated AS validated,
       ${enforced} AS enforced,
       (SELECT pg_catalog.json_build_array(rn.nspname::text, rc.relname::text) FROM pg_catalog.pg_class rc
          JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace WHERE rc.oid = k.confrelid) AS references,
       pg_catalog.obj_description(k.oid, 'pg_constraint') AS comment
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_constraint x WHERE x.conrelid = page.oid OFFSET 0) k
 ORDER BY k.conrelid, k.conname COLLATE "C"`
}

/** Indexes of a page of relations ($1 relation oids). */
export const INDEXES = sql`SELECT i.indrelid::text AS rel, n.nspname::text AS schema, ic.relname::text AS name,
       pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AS is_unique,
       i.indisprimary AS is_primary, i.indisexclusion AS is_exclusion, i.indnullsnotdistinct AS nulls_not_distinct,
       i.indisvalid AS valid, i.indisready AS ready,
       (SELECT ts.spcname::text FROM pg_catalog.pg_tablespace ts WHERE ts.oid = ic.reltablespace) AS tablespace,
       pg_catalog.obj_description(i.indexrelid, 'pg_class') AS comment
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_index x WHERE x.indrelid = page.oid OFFSET 0) i
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_class y WHERE y.oid = i.indexrelid OFFSET 0) ic
  JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
 ORDER BY i.indrelid, ic.relname COLLATE "C"`

/** Triggers (not internal) of a page of relations ($1 relation oids). */
export const TRIGGERS = sql`SELECT t.tgrelid::text AS rel, t.tgname::text AS name,
       pg_catalog.pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled::text AS enabled,
       (t.tgconstraint <> 0) AS is_constraint,
       pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_trigger x WHERE x.tgrelid = page.oid AND NOT x.tgisinternal OFFSET 0) t
 ORDER BY t.tgrelid, t.tgname COLLATE "C"`

/** Row-security policies of a page of relations ($1 relation oids). */
export const POLICIES = sql`SELECT p.polrelid::text AS rel, p.polname::text AS name, p.polcmd::text AS command,
       p.polpermissive AS permissive,
       (SELECT pg_catalog.json_agg(CASE WHEN r = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(r)::text END
                                   ORDER BY (CASE WHEN r = 0 THEN '' ELSE pg_catalog.pg_get_userbyid(r)::text END) COLLATE "C")
          FROM pg_catalog.unnest(p.polroles) r) AS roles,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
       pg_catalog.obj_description(p.oid, 'pg_policy') AS comment
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_policy x WHERE x.polrelid = page.oid OFFSET 0) p
 ORDER BY p.polrelid, p.polname COLLATE "C"`

/** Rules (other than a view's `_RETURN`) of a page of relations ($1 relation oids). */
export const RULES = sql`SELECT r.ev_class::text AS rel, r.rulename::text AS name,
       pg_catalog.pg_get_ruledef(r.oid, true) AS definition, r.ev_enabled::text AS enabled
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_rewrite x WHERE x.ev_class = page.oid AND x.rulename <> '_RETURN' OFFSET 0) r
 ORDER BY r.ev_class, r.rulename COLLATE "C"`

/** Inheritance parents of a page of relations ($1 relation oids). */
export const PARENTS = sql`SELECT i.inhrelid::text AS rel, pn.nspname::text AS schema, pc.relname::text AS name
  FROM pg_catalog.unnest($1::oid[]) AS page(oid)
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_inherits x WHERE x.inhrelid = page.oid OFFSET 0) i
 CROSS JOIN LATERAL (SELECT * FROM pg_catalog.pg_class y WHERE y.oid = i.inhparent OFFSET 0) pc
  JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
 ORDER BY i.inhrelid, pn.nspname COLLATE "C", pc.relname COLLATE "C"`

/** A page of functions, procedures and aggregates ($1 after oid, $2 namespace oids, $3 page size). */
export const FUNCTIONS = sql`SELECT p.oid::text AS oid, n.nspname::text AS schema, p.proname::text AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args, p.prokind::text AS kind,
       pg_catalog.pg_get_function_result(p.oid) AS result, l.lanname::text AS language,
       pg_catalog.pg_get_expr(p.proargdefaults, 0) AS argument_defaults,
       p.prosrc AS src, p.probin AS bin, pg_catalog.pg_get_function_sqlbody(p.oid) AS sql_body,
       p.provolatile::text AS volatility, p.proisstrict AS strict, p.proleakproof AS leakproof,
       p.proparallel::text AS parallel, p.prosecdef AS security_definer,
       (SELECT pg_catalog.json_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(p.proconfig) o) AS config,
       p.procost::text AS cost, p.prorows::text AS rows,
       pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
       ${acl(sql`p.proacl`, sql`'f'`, sql`p.proowner`)} AS acl,
       (SELECT pg_catalog.json_strip_nulls(pg_catalog.json_build_object(
                 'kind', ag.aggkind::text, 'transition', ag.aggtransfn::regprocedure::text,
                 'final', nullif(ag.aggfinalfn::oid, 0)::regprocedure::text,
                 'finalExtra', CASE WHEN ag.aggfinalextra THEN true END,
                 'finalModify', ag.aggfinalmodify::text,
                 'combine', nullif(ag.aggcombinefn::oid, 0)::regprocedure::text,
                 'serial', nullif(ag.aggserialfn::oid, 0)::regprocedure::text,
                 'deserial', nullif(ag.aggdeserialfn::oid, 0)::regprocedure::text,
                 'movingTransition', nullif(ag.aggmtransfn::oid, 0)::regprocedure::text,
                 'movingInverse', nullif(ag.aggminvtransfn::oid, 0)::regprocedure::text,
                 'movingFinal', nullif(ag.aggmfinalfn::oid, 0)::regprocedure::text,
                 'movingFinalExtra', CASE WHEN ag.aggmfinalextra THEN true END,
                 'movingFinalModify', CASE WHEN ag.aggmtransfn::oid <> 0 THEN ag.aggmfinalmodify::text END,
                 'movingState', CASE WHEN ag.aggmtranstype <> 0 THEN pg_catalog.format_type(ag.aggmtranstype, NULL) END,
                 'movingInitial', ag.aggminitval,
                 'sortOperator', nullif(ag.aggsortop::oid, 0)::regoperator::text,
                 'stateSpace', nullif(ag.aggtransspace, 0),
                 'movingStateSpace', nullif(ag.aggmtransspace, 0),
                 'state', pg_catalog.format_type(ag.aggtranstype, NULL), 'initial', ag.agginitval))
          FROM pg_catalog.pg_aggregate ag WHERE ag.aggfnoid = p.oid) AS aggregate,
       pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
 WHERE p.oid > $1::oid AND p.oid >= 16384 AND p.pronamespace = ANY ($2::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_proc'`, sql`p.oid`)}
 ORDER BY p.oid
 LIMIT $3`

/** A page of user-defined types: enum, domain, standalone composite, range ($1 after, $2 namespaces, $3 page). */
export const TYPES = sql`SELECT t.oid::text AS oid, n.nspname::text AS schema, t.typname::text AS name, t.typtype::text AS type_kind,
       pg_catalog.pg_get_userbyid(t.typowner)::text AS owner,
       ${acl(sql`t.typacl`, sql`'T'`, sql`t.typowner`)} AS acl,
       CASE WHEN t.typtype = 'e' THEN (SELECT pg_catalog.json_agg(e.enumlabel::text ORDER BY e.enumsortorder)
                                         FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) END AS labels,
       CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS base_type,
       t.typnotnull AS not_null, pg_catalog.pg_get_expr(t.typdefaultbin, 0) AS default_expr,
       CASE WHEN t.typtype = 'd' THEN (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                 'name', k.conname::text, 'definition', pg_catalog.pg_get_constraintdef(k.oid, true),
                 'validated', k.convalidated) ORDER BY k.conname COLLATE "C")
               FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid) END AS checks,
       CASE WHEN t.typtype = 'd' AND t.typcollation <> 0
             AND t.typcollation <> (SELECT b.typcollation FROM pg_catalog.pg_type b WHERE b.oid = t.typbasetype) THEN
         (SELECT pg_catalog.json_build_array(cn.nspname::text, co.collname::text) FROM pg_catalog.pg_collation co
            JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = t.typcollation) END AS collation,
       CASE WHEN t.typtype = 'c' THEN (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                 'name', a.attname::text, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                 'collation', CASE WHEN a.attcollation <> 0 AND a.attcollation <> at.typcollation
                   THEN (SELECT pg_catalog.json_build_array(cn.nspname::text, co.collname::text)
                           FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
                          WHERE co.oid = a.attcollation) END)
                 ORDER BY a.attnum)
               FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type at ON at.oid = a.atttypid
              WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) END AS attributes,
       CASE WHEN t.typtype = 'r' THEN (SELECT pg_catalog.json_build_object(
                 'subtype', pg_catalog.format_type(r.rngsubtype, NULL),
                 'opclass', (SELECT pg_catalog.json_build_array(ocn.nspname::text, oc.opcname::text)
                               FROM pg_catalog.pg_opclass oc JOIN pg_catalog.pg_namespace ocn ON ocn.oid = oc.opcnamespace
                              WHERE oc.oid = r.rngsubopc),
                 'collation', (SELECT pg_catalog.json_build_array(cn.nspname::text, co.collname::text)
                                 FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
                                WHERE co.oid = r.rngcollation),
                 'canonical', nullif(r.rngcanonical::oid, 0)::regprocedure::text,
                 'subdiff', nullif(r.rngsubdiff::oid, 0)::regprocedure::text)
               FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid) END AS range,
       pg_catalog.obj_description(t.oid, 'pg_type') AS comment
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
 WHERE t.oid > $1::oid AND t.oid >= 16384 AND t.typnamespace = ANY ($2::oid[])
   AND (t.typtype IN ('e', 'd', 'r')
        OR (t.typtype = 'c' AND (SELECT rc.relkind FROM pg_catalog.pg_class rc WHERE rc.oid = t.typrelid) = 'c'))
   AND ${notExtensionMember(sql`'pg_catalog.pg_type'`, sql`t.oid`)}
 ORDER BY t.oid
 LIMIT $3`

/**
 * Extensions of the database (every one: they stand for their member objects).
 * `members` are the identities of the extension's members that were created
 * in this database (`oid >= 16384`): `ALTER EXTENSION … ADD` moves an object
 * out of the document, and this list is where the move shows (owner decision
 * R1, 2026-10-07). An extension created at `initdb` (`plpgsql`) has none;
 * implicit types are left out (an array type follows its element type, a
 * row type its relation).
 */
export const EXTENSIONS = sql`SELECT e.extname::text AS name, e.extversion AS version, n.nspname::text AS schema,
       (SELECT pg_catalog.json_agg(pg_catalog.json_build_array(o.type, o.identity)
                 ORDER BY o.type COLLATE "C", o.identity COLLATE "C")
          FROM pg_catalog.pg_depend d
         CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) o
         WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.refobjid = e.oid
           AND d.deptype = 'e' AND d.objid >= 16384
           -- An implicit type follows its owner: an array type its element type, a row
           -- type its relation. PostgreSQL 17 began to record them as members too, 16
           -- does not. A standalone composite type (relkind c) is a member of its own.
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type it
                            WHERE d.classid = 'pg_catalog.pg_type'::regclass AND it.oid = d.objid
                              AND ((it.typelem <> 0
                                    AND (SELECT et.typarray FROM pg_catalog.pg_type et WHERE et.oid = it.typelem) = it.oid)
                                   OR (it.typrelid <> 0
                                    AND (SELECT rc.relkind FROM pg_catalog.pg_class rc WHERE rc.oid = it.typrelid) <> 'c')))) AS members,
       pg_catalog.obj_description(e.oid, 'pg_extension') AS comment
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 ORDER BY e.extname COLLATE "C"`

/** Event triggers of the database. */
export const EVENT_TRIGGERS = sql`SELECT et.evtname::text AS name, et.evtevent::text AS event,
       (SELECT pg_catalog.json_agg(tag ORDER BY tag COLLATE "C") FROM pg_catalog.unnest(et.evttags) tag) AS tags,
       et.evtfoid::regprocedure::text AS function, et.evtenabled::text AS enabled,
       pg_catalog.pg_get_userbyid(et.evtowner)::text AS owner,
       pg_catalog.obj_description(et.oid, 'pg_event_trigger') AS comment
  FROM pg_catalog.pg_event_trigger et
 WHERE ${notExtensionMember(sql`'pg_catalog.pg_event_trigger'`, sql`et.oid`)}
 ORDER BY et.evtname COLLATE "C"`

/**
 * Publications of the database with tables (row filters, column lists) and
 * schemas; from PostgreSQL 18 also whether generated columns are published.
 */
export function publications(major: SupportedMajor): TrustedSql {
  const generated = major >= 18 ? sql`p.pubgencols::text` : sql`NULL::text`
  return sql`SELECT p.pubname::text AS name, p.puballtables AS all_tables, p.pubinsert AS ins, p.pubupdate AS upd,
       p.pubdelete AS del, p.pubtruncate AS trunc, p.pubviaroot AS via_root, ${generated} AS generated_columns,
       (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                 'schema', tn.nspname::text, 'name', tc.relname::text,
                 'rowFilter', pg_catalog.pg_get_expr(pr.prqual, pr.prrelid),
                 'columns', (SELECT pg_catalog.json_agg(a.attname::text ORDER BY a.attnum)
                               FROM pg_catalog.pg_attribute a
                              WHERE a.attrelid = pr.prrelid AND a.attnum = ANY (pr.prattrs::int2[])))
                 ORDER BY tn.nspname COLLATE "C", tc.relname COLLATE "C")
          FROM pg_catalog.pg_publication_rel pr
          JOIN pg_catalog.pg_class tc ON tc.oid = pr.prrelid
          JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
         WHERE pr.prpubid = p.oid) AS tables,
       (SELECT pg_catalog.json_agg(sn.nspname::text ORDER BY sn.nspname COLLATE "C")
          FROM pg_catalog.pg_publication_namespace pn JOIN pg_catalog.pg_namespace sn ON sn.oid = pn.pnnspid
         WHERE pn.pnpubid = p.oid) AS schemas,
       pg_catalog.pg_get_userbyid(p.pubowner)::text AS owner
  FROM pg_catalog.pg_publication p
 ORDER BY p.pubname COLLATE "C"`
}

/** Default privileges (global, or for a schema of the scope: $1 namespace oids). */
export const DEFAULT_ACLS = sql`SELECT pg_catalog.pg_get_userbyid(d.defaclrole)::text AS role,
       (SELECT n.nspname::text FROM pg_catalog.pg_namespace n WHERE n.oid = d.defaclnamespace) AS schema,
       d.defaclobjtype::text AS object_type,
       (SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                 'to', CASE WHEN x.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END,
                 'by', pg_catalog.pg_get_userbyid(x.grantor)::text,
                 'privilege', x.privilege_type, 'grantable', x.is_grantable)
                 ORDER BY (CASE WHEN x.grantee = 0 THEN '' ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END) COLLATE "C",
                          x.privilege_type COLLATE "C")
          FROM pg_catalog.aclexplode(d.defaclacl) x) AS acl
  FROM pg_catalog.pg_default_acl d
 WHERE d.defaclnamespace = 0 OR d.defaclnamespace = ANY ($1::oid[])
 ORDER BY 1, 2, 3`

/** Extended statistics objects ($1 namespace oids). */
export const STATISTICS = sql`SELECT n.nspname::text AS schema, s.stxname::text AS name,
       pg_catalog.pg_get_statisticsobjdef(s.oid) AS definition
  FROM pg_catalog.pg_statistic_ext s JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
 WHERE s.oid >= 16384 AND s.stxnamespace = ANY ($1::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_statistic_ext'`, sql`s.oid`)}
 ORDER BY 1, 2`

/** User-defined collations ($1 namespace oids). */
export function collations(major: SupportedMajor): TrustedSql {
  const locale = major >= 17 ? sql`c.colllocale` : sql`c.colliculocale`
  return sql`SELECT n.nspname::text AS schema, c.collname::text AS name, c.collprovider::text AS provider,
       c.collcollate AS lc_collate, c.collctype AS lc_ctype, ${locale} AS locale, c.collicurules AS rules,
       c.collisdeterministic AS deterministic, pg_catalog.pg_get_userbyid(c.collowner)::text AS owner
  FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
 WHERE c.oid >= 16384 AND c.collnamespace = ANY ($1::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_collation'`, sql`c.oid`)}
 ORDER BY 1, 2`
}

/** User-defined casts (not part of an extension). */
export const CASTS = sql`SELECT pg_catalog.format_type(c.castsource, NULL) AS source, pg_catalog.format_type(c.casttarget, NULL) AS target,
       nullif(c.castfunc, 0)::regprocedure::text AS function, c.castcontext::text AS context, c.castmethod::text AS method
  FROM pg_catalog.pg_cast c
 WHERE c.oid >= 16384 AND ${notExtensionMember(sql`'pg_catalog.pg_cast'`, sql`c.oid`)}
 ORDER BY 1, 2`

/** User-defined operators ($1 namespace oids). */
export const OPERATORS = sql`SELECT n.nspname::text AS schema, o.oprname::text AS name,
       CASE WHEN o.oprleft = 0 THEN 'NONE' ELSE pg_catalog.format_type(o.oprleft, NULL) END AS left_type,
       CASE WHEN o.oprright = 0 THEN 'NONE' ELSE pg_catalog.format_type(o.oprright, NULL) END AS right_type,
       pg_catalog.format_type(o.oprresult, NULL) AS result, o.oprcode::regprocedure::text AS function,
       nullif(o.oprcom, 0)::regoperator::text AS commutator, nullif(o.oprnegate, 0)::regoperator::text AS negator,
       nullif(o.oprrest, 0)::regprocedure::text AS restrict, nullif(o.oprjoin, 0)::regprocedure::text AS join_fn,
       o.oprcanhash AS hashes, o.oprcanmerge AS merges, pg_catalog.pg_get_userbyid(o.oprowner)::text AS owner
  FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace
 WHERE o.oid >= 16384 AND o.oprnamespace = ANY ($1::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_operator'`, sql`o.oid`)}
 ORDER BY 1, 2, 3, 4`

/** User-defined operator classes ($1 namespace oids). */
export const OPCLASSES = sql`SELECT n.nspname::text AS schema, c.opcname::text AS name, am.amname::text AS method,
       pg_catalog.format_type(c.opcintype, NULL) AS input_type, c.opcdefault AS is_default,
       (SELECT pg_catalog.json_build_array(fn.nspname::text, f.opfname::text) FROM pg_catalog.pg_opfamily f
          JOIN pg_catalog.pg_namespace fn ON fn.oid = f.opfnamespace WHERE f.oid = c.opcfamily) AS family,
       CASE WHEN c.opckeytype = 0 THEN NULL ELSE pg_catalog.format_type(c.opckeytype, NULL) END AS key_type,
       pg_catalog.pg_get_userbyid(c.opcowner)::text AS owner
  FROM pg_catalog.pg_opclass c JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace
  JOIN pg_catalog.pg_am am ON am.oid = c.opcmethod
 WHERE c.oid >= 16384 AND c.opcnamespace = ANY ($1::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_opclass'`, sql`c.oid`)}
 ORDER BY 1, 2, 3`

/** User-defined text search configurations ($1 namespace oids). */
export const TS_CONFIGS = sql`SELECT n.nspname::text AS schema, c.cfgname::text AS name,
       (SELECT pn.nspname::text || '.' || p.prsname::text FROM pg_catalog.pg_ts_parser p
          JOIN pg_catalog.pg_namespace pn ON pn.oid = p.prsnamespace WHERE p.oid = c.cfgparser) AS parser,
       (SELECT pg_catalog.json_agg(pg_catalog.json_build_array(m.maptokentype, m.mapseqno,
                 (SELECT dn.nspname::text || '.' || d.dictname::text FROM pg_catalog.pg_ts_dict d
                    JOIN pg_catalog.pg_namespace dn ON dn.oid = d.dictnamespace WHERE d.oid = m.mapdict))
                 ORDER BY m.maptokentype, m.mapseqno)
          FROM pg_catalog.pg_ts_config_map m WHERE m.mapcfg = c.oid) AS mappings,
       pg_catalog.pg_get_userbyid(c.cfgowner)::text AS owner
  FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace
 WHERE c.oid >= 16384 AND c.cfgnamespace = ANY ($1::oid[])
   AND ${notExtensionMember(sql`'pg_catalog.pg_ts_config'`, sql`c.oid`)}
 ORDER BY 1, 2`

/** Determinism settings pinned inside the snapshot transaction (schema-fingerprints.md §4 rule 1). */
export const PIN_SETTINGS = sql`SELECT pg_catalog.set_config('search_path', '', true),
       pg_catalog.set_config('TimeZone', 'UTC', true),
       pg_catalog.set_config('DateStyle', 'ISO, YMD', true),
       pg_catalog.set_config('IntervalStyle', 'postgres', true),
       pg_catalog.set_config('extra_float_digits', '1', true),
       pg_catalog.set_config('bytea_output', 'hex', true),
       pg_catalog.set_config('standard_conforming_strings', 'on', true),
       pg_catalog.set_config('quote_all_identifiers', 'off', true),
       pg_catalog.set_config('lc_monetary', 'C', true)`

/** Roles, memberships and per-database role settings (the cluster fingerprint). */
export const CLUSTER_ROLES = sql`SELECT r.rolname::text AS name, r.rolsuper AS superuser, r.rolinherit AS inherit,
       r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolcanlogin AS login,
       r.rolreplication AS replication, r.rolbypassrls AS bypassrls, r.rolconnlimit AS connection_limit,
       r.rolvaliduntil::text AS valid_until,
       (SELECT pg_catalog.json_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(r.rolconfig) o) AS config
  FROM pg_catalog.pg_roles r
 WHERE r.rolname !~ '^pg_'
 ORDER BY r.rolname COLLATE "C"`

export const CLUSTER_MEMBERSHIPS = sql`SELECT pg_catalog.pg_get_userbyid(m.roleid)::text AS role, pg_catalog.pg_get_userbyid(m.member)::text AS member,
       pg_catalog.pg_get_userbyid(m.grantor)::text AS grantor, m.admin_option AS admin,
       m.inherit_option AS inherit, m.set_option AS set
  FROM pg_catalog.pg_auth_members m
 ORDER BY 1, 2, 3`

export const CLUSTER_SETTINGS = sql`SELECT (SELECT d.datname::text FROM pg_catalog.pg_database d WHERE d.oid = s.setdatabase) AS database,
       CASE WHEN s.setrole = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(s.setrole)::text END AS role,
       (SELECT pg_catalog.json_agg(o ORDER BY o COLLATE "C") FROM pg_catalog.unnest(s.setconfig) o) AS config
  FROM pg_catalog.pg_db_role_setting s
 ORDER BY 1 NULLS FIRST, 2 NULLS FIRST`

/** Sizes of relations for the inspection model only ($1 relation oids); never part of a fingerprint. */
export const SIZES = sql`SELECT c.oid::text AS oid, pg_catalog.pg_total_relation_size(c.oid)::text AS size_bytes
  FROM pg_catalog.pg_class c
 WHERE c.oid = ANY ($1::oid[]) AND c.relkind IN ('r', 'p', 'm', 'i', 'I', 'S')
 ORDER BY c.oid`
