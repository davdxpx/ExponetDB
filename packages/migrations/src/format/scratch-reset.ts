/**
 * The in-place reset of a consumed scratch target
 * ([`legacy-import.md` §2.5](../../../../exponetdb-docs/04-migrations/legacy-import.md#25-scratch-targets),
 * Wave 9 order A7), as SQL text an operator runs as a superuser connected
 * to the scratch database. Pure: built from registry values the CLI reads
 * over REST; ExponetDB never runs it.
 *
 * The script stops unless the database carries the scratch target's
 * identity marker and has no ledger row; then, in one transaction, it drops
 * and re-creates each schema of the project's managed scope with its owner
 * and its grants, and re-creates the extensions that lived there in their
 * versions. The database (its oid), the `exponetdb` schema with the marker,
 * and every schema outside the scope (the schema-only copies a replay
 * needs) stay. Default privileges set inside a dropped schema go with it.
 */
export interface ScratchResetInput {
  readonly installationId: string
  readonly targetId: string
  readonly targetPath: string
  readonly generation: number
  /** For the comment only; the marker identifies the database. */
  readonly databaseName?: string
  /**
   * The project's managed scope: the listed schemas, else (absent or null, as
   * the REST project view gives a scope without a list) all but the excluded ones.
   */
  readonly includeSchemas?: readonly string[] | null
  readonly excludeSchemas?: readonly string[] | null
}

// E-strings: their quoting does not depend on standard_conforming_strings, which a database's
// owner may set for the database (the script also pins it, below).
const literal = (value: string) => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
const array = (values: readonly string[]) =>
  values.length === 0 ? 'ARRAY[]::text[]' : `ARRAY[${values.map(literal).join(', ')}]::text[]`
const ID = /^[a-z]{3}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/**
 * Every object outside the managed scope, by its identity (`pg_identify_object`),
 * as the reset compares them before and after (review of follow-up 2): an
 * object of a schema outside the scope, or one without a schema. Objects of
 * the managed schemas, TOAST and temporary schemas and the system schemas
 * are not listed. An extension of the scope is re-created before the
 * comparison, so its members are found again under the same identity.
 * Its aliases never name a variable of the script's block (`s`, `g`, `e`).
 */
const OUTSIDE_INVENTORY = `SELECT DISTINCT (pg_catalog.pg_identify_object(o.classid, o.objid, o.objsubid)).type
         || ' ' || (pg_catalog.pg_identify_object(o.classid, o.objid, o.objsubid)).identity AS object
    FROM (SELECT 'pg_catalog.pg_class'::regclass AS classid, c.oid AS objid, 0 AS objsubid, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL SELECT 'pg_catalog.pg_class'::regclass, a.attrelid, a.attnum, c.relnamespace
                      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                     WHERE a.attnum > 0 AND NOT a.attisdropped
          UNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass, d.oid, 0, c.relnamespace FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
          UNION ALL SELECT 'pg_catalog.pg_constraint'::regclass, k.oid, 0, k.connamespace FROM pg_catalog.pg_constraint k
          UNION ALL SELECT 'pg_catalog.pg_trigger'::regclass, tg.oid, 0, c.relnamespace FROM pg_catalog.pg_trigger tg JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
          UNION ALL SELECT 'pg_catalog.pg_policy'::regclass, y.oid, 0, c.relnamespace FROM pg_catalog.pg_policy y JOIN pg_catalog.pg_class c ON c.oid = y.polrelid
          UNION ALL SELECT 'pg_catalog.pg_rewrite'::regclass, r.oid, 0, c.relnamespace FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
          UNION ALL SELECT 'pg_catalog.pg_proc'::regclass, f.oid, 0, f.pronamespace FROM pg_catalog.pg_proc f
          UNION ALL SELECT 'pg_catalog.pg_type'::regclass, t.oid, 0, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL SELECT 'pg_catalog.pg_operator'::regclass, q.oid, 0, q.oprnamespace FROM pg_catalog.pg_operator q
          UNION ALL SELECT 'pg_catalog.pg_opclass'::regclass, q.oid, 0, q.opcnamespace FROM pg_catalog.pg_opclass q
          UNION ALL SELECT 'pg_catalog.pg_opfamily'::regclass, q.oid, 0, q.opfnamespace FROM pg_catalog.pg_opfamily q
          UNION ALL SELECT 'pg_catalog.pg_collation'::regclass, q.oid, 0, q.collnamespace FROM pg_catalog.pg_collation q
          UNION ALL SELECT 'pg_catalog.pg_statistic_ext'::regclass, q.oid, 0, q.stxnamespace FROM pg_catalog.pg_statistic_ext q
          UNION ALL SELECT 'pg_catalog.pg_namespace'::regclass, n.oid, 0, n.oid FROM pg_catalog.pg_namespace n
          UNION ALL SELECT 'pg_catalog.pg_extension'::regclass, x.oid, 0, NULL FROM pg_catalog.pg_extension x
          UNION ALL SELECT 'pg_catalog.pg_foreign_data_wrapper'::regclass, w.oid, 0, NULL FROM pg_catalog.pg_foreign_data_wrapper w
          UNION ALL SELECT 'pg_catalog.pg_foreign_server'::regclass, v.oid, 0, NULL FROM pg_catalog.pg_foreign_server v
          UNION ALL SELECT 'pg_catalog.pg_user_mapping'::regclass, u.oid, 0, NULL FROM pg_catalog.pg_user_mapping u
          UNION ALL SELECT 'pg_catalog.pg_cast'::regclass, k.oid, 0, NULL FROM pg_catalog.pg_cast k
          UNION ALL SELECT 'pg_catalog.pg_am'::regclass, m.oid, 0, NULL FROM pg_catalog.pg_am m
          UNION ALL SELECT 'pg_catalog.pg_language'::regclass, l.oid, 0, NULL FROM pg_catalog.pg_language l
          UNION ALL SELECT 'pg_catalog.pg_event_trigger'::regclass, et.oid, 0, NULL FROM pg_catalog.pg_event_trigger et
          UNION ALL SELECT 'pg_catalog.pg_publication'::regclass, b.oid, 0, NULL FROM pg_catalog.pg_publication b) o
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = o.ns
   WHERE o.ns IS NULL
      OR NOT (n.nspname = ANY (managed) OR n.nspname IN ('pg_catalog', 'information_schema', 'pg_toast')
              OR n.nspname LIKE 'pg\\_temp\\_%' OR n.nspname LIKE 'pg\\_toast\\_temp\\_%')`

export function scratchResetSql(input: ScratchResetInput): string {
  if (!ID.test(input.installationId) || !ID.test(input.targetId)) {
    throw new Error('an installation and a target id are canonical ids')
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('a generation is a positive integer')
  }
  const managed =
    input.includeSchemas === undefined || input.includeSchemas === null
      ? `ARRAY(SELECT n.nspname::text FROM pg_catalog.pg_namespace n
             WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ('information_schema', 'exponetdb')
               AND NOT (n.nspname = ANY (${array(input.excludeSchemas ?? [])})))`
      : array(input.includeSchemas.filter((s) => s !== 'exponetdb'))
  // The path and the database name are shown in comments only, never executed.
  const shown = (v: string) => v.replace(/[^\x20-\x7e]/g, '?')
  const body = `DECLARE
  managed text[] := ${managed};
  outside text;
  outside_count bigint;
  lost text;
  lost_count bigint;
  s record;
  g record;
  e record;
BEGIN
  -- The marker and the ledger are read only once the catalog shows them as ExponetDB made
  -- them: plain tables of the ledger owner, without children or row security, of built-in
  -- column types. A replay that reached the ledger owner could have put a view or a type
  -- there whose code would run as the superuser running this script.
  IF EXISTS (
       SELECT FROM pg_catalog.unnest(ARRAY['target_identity', 'schema_migrations']) AS t(name)
        WHERE NOT EXISTS (
                SELECT FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
                 WHERE n.nspname OPERATOR(pg_catalog.=) 'exponetdb'
                   AND c.relname OPERATOR(pg_catalog.=) t.name
                   AND c.relkind OPERATOR(pg_catalog.=) 'r'
                   AND NOT c.relrowsecurity AND NOT c.relhassubclass
                   AND pg_catalog.pg_get_userbyid(c.relowner) OPERATOR(pg_catalog.=) 'exponetdb_ledger_owner'
                   AND NOT EXISTS (
                         SELECT FROM pg_catalog.pg_attribute a
                           JOIN pg_catalog.pg_type ty ON ty.oid OPERATOR(pg_catalog.=) a.atttypid
                          WHERE a.attrelid OPERATOR(pg_catalog.=) c.oid AND a.attnum OPERATOR(pg_catalog.>) 0
                            AND NOT a.attisdropped
                            AND ty.typnamespace OPERATOR(pg_catalog.<>) 'pg_catalog'::pg_catalog.regnamespace))) THEN
    RAISE EXCEPTION 'the identity marker or the ledger of this database is not as ExponetDB made it: re-create the scratch database';
  END IF;
  IF NOT EXISTS (SELECT FROM ONLY exponetdb.target_identity
                  WHERE installation_id OPERATOR(pg_catalog.=) ${literal(input.installationId)}::pg_catalog.text
                    AND target_id OPERATOR(pg_catalog.=) ${literal(input.targetId)}::pg_catalog.text
                    AND generation OPERATOR(pg_catalog.=) ${input.generation}::pg_catalog.int4) THEN
    RAISE EXCEPTION 'this database is not the scratch target %', ${literal(shown(input.targetPath))};
  END IF;
  IF EXISTS (SELECT FROM ONLY exponetdb.schema_migrations) THEN
    RAISE EXCEPTION 'the database has ledger rows: it was migrated, not only replayed';
  END IF;
  -- DROP SCHEMA ... CASCADE would also drop what lies outside the scope and depends on it (a
  -- view or a column of a copy, a trigger or a default on a table there, a cast): refuse
  -- instead, naming it. Triggers, policies, rules, defaults and operator-family members carry
  -- no schema of their own: theirs is their table's or family's. Extensions are re-created.
  WITH dep AS (
    SELECT d.classid, d.objid, d.objsubid,
           CASE WHEN d.refclassid = 'pg_catalog.pg_namespace'::regclass
                THEN (SELECT n.nspname::text FROM pg_catalog.pg_namespace n WHERE n.oid = d.refobjid)
                -- An extension's members go with the extension, which lives in its schema.
                WHEN d.refclassid = 'pg_catalog.pg_extension'::regclass
                THEN (SELECT n.nspname::text FROM pg_catalog.pg_extension x
                        JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace WHERE x.oid = d.refobjid)
                ELSE (pg_catalog.pg_identify_object(d.refclassid, d.refobjid, 0)).schema
           END AS referenced,
           coalesce(
             (SELECT n.nspname::text FROM pg_catalog.pg_namespace n
               WHERE n.oid = CASE d.classid
                 WHEN 'pg_catalog.pg_rewrite'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
                 WHEN 'pg_catalog.pg_trigger'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE t.oid = d.objid)
                 WHEN 'pg_catalog.pg_policy'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
                 WHEN 'pg_catalog.pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
                 WHEN 'pg_catalog.pg_amop'::regclass THEN (SELECT f.opfnamespace FROM pg_catalog.pg_amop o JOIN pg_catalog.pg_opfamily f ON f.oid = o.amopfamily WHERE o.oid = d.objid)
                 WHEN 'pg_catalog.pg_amproc'::regclass THEN (SELECT f.opfnamespace FROM pg_catalog.pg_amproc o JOIN pg_catalog.pg_opfamily f ON f.oid = o.amprocfamily WHERE o.oid = d.objid)
                 WHEN 'pg_catalog.pg_extension'::regclass THEN (SELECT x.extnamespace FROM pg_catalog.pg_extension x WHERE x.oid = d.objid)
               END),
             (pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid)).schema) AS dependent
      FROM pg_catalog.pg_depend d
     -- A publication's member row goes with its table; the publication itself stays.
     WHERE (d.deptype IN ('n', 'a')
            OR (d.deptype = 'e' AND d.refclassid = 'pg_catalog.pg_extension'::regclass))
       AND d.classid NOT IN ('pg_catalog.pg_default_acl'::regclass, 'pg_catalog.pg_publication_rel'::regclass,
                             'pg_catalog.pg_publication_namespace'::regclass))
  SELECT pg_catalog.count(DISTINCT (dep.classid, dep.objid, dep.objsubid)),
         pg_catalog.string_agg(DISTINCT pg_catalog.pg_describe_object(dep.classid, dep.objid, dep.objsubid), ', ')
    INTO outside_count, outside
    FROM dep
   WHERE dep.referenced = ANY (managed)
     AND (dep.dependent IS NULL OR NOT dep.dependent = ANY (managed))
     -- An object without a schema of its own (a cast, an access method) that belongs to an
     -- extension in the scope goes with that extension, which is re-created below. A member in
     -- a schema outside the scope refuses: the drop would take it, and a replay that owns an
     -- extension can add its own objects to it (ALTER EXTENSION ... ADD).
     AND NOT (dep.dependent IS NULL AND EXISTS (
           SELECT FROM pg_catalog.pg_depend m
             JOIN pg_catalog.pg_extension x ON x.oid = m.refobjid
             JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace
            WHERE m.classid = dep.classid AND m.objid = dep.objid AND m.objsubid = 0
              AND m.refclassid = 'pg_catalog.pg_extension'::regclass AND m.deptype = 'e'
              AND n.nspname = ANY (managed)));
  IF outside IS NOT NULL THEN
    RAISE EXCEPTION 'objects outside the managed scope depend on it and would be dropped (%): %', outside_count,
      pg_catalog.left(outside, 2000) || CASE WHEN pg_catalog.length(outside) > 2000 THEN ' (list cut)' ELSE '' END;
  END IF;
  -- What lies outside the scope now, so the reset can prove it dropped none of it: a cascade
  -- can reach further than the dependencies above show (a server of a wrapper an extension of
  -- the scope holds, an extension outside the scope that holds an object inside it).
  CREATE TEMPORARY TABLE exdb_reset_outside ON COMMIT DROP AS ${OUTSIDE_INVENTORY};
  -- Each with how many extensions it requires in a row: re-created after what it requires,
  -- whatever order the catalog holds them in (an updated extension's row moves to the end).
  CREATE TEMPORARY TABLE exdb_reset_extensions ON COMMIT DROP AS
    WITH RECURSIVE requires(ext, level) AS (
      SELECT x.oid, 0 FROM pg_catalog.pg_extension x
      UNION ALL
      SELECT d.objid, r.level + 1
        FROM pg_catalog.pg_depend d JOIN requires r ON r.ext = d.refobjid
       WHERE d.classid = 'pg_catalog.pg_extension'::regclass
         AND d.refclassid = 'pg_catalog.pg_extension'::regclass
         AND d.deptype = 'n' AND r.level < 100)
    SELECT x.extname::text AS name, n.nspname::text AS schema, x.extversion AS version,
           (SELECT pg_catalog.max(r.level) FROM requires r WHERE r.ext = x.oid) AS level
      FROM pg_catalog.pg_extension x JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace
     WHERE n.nspname = ANY (managed);
  FOR s IN SELECT n.nspname::text AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner, n.nspowner, n.nspacl
             FROM pg_catalog.pg_namespace n WHERE n.nspname = ANY (managed) LOOP
    EXECUTE pg_catalog.format('DROP SCHEMA %I CASCADE', s.name);
    EXECUTE pg_catalog.format('CREATE SCHEMA %I AUTHORIZATION %I', s.name, s.owner);
    FOR g IN SELECT a.privilege_type, a.grantee, a.is_grantable
               FROM pg_catalog.aclexplode(s.nspacl) a WHERE a.grantee <> s.nspowner LOOP
      EXECUTE pg_catalog.format('GRANT %s ON SCHEMA %I TO %s%s', g.privilege_type, s.name,
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(g.grantee)) END,
        CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
  FOR e IN SELECT * FROM exdb_reset_extensions ORDER BY level, name LOOP
    EXECUTE pg_catalog.format('CREATE EXTENSION %I WITH SCHEMA %I VERSION %L', e.name, e.schema, e.version);
  END LOOP;
  SELECT pg_catalog.count(*), pg_catalog.string_agg(o.object, ', ' ORDER BY o.object)
    INTO lost_count, lost
    FROM exdb_reset_outside o
   WHERE NOT EXISTS (SELECT FROM (${OUTSIDE_INVENTORY}) cur WHERE cur.object = o.object);
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'the reset would drop objects outside the managed scope (%), nothing was changed: %', lost_count,
      pg_catalog.left(lost, 2000) || CASE WHEN pg_catalog.length(lost) > 2000 THEN ' (list cut)' ELSE '' END;
  END IF;
END`
  // A dollar-quote tag that cannot occur in the body: schema names may hold `$`.
  let tag = 'reset'
  for (let i = 1; body.includes(`$${tag}$`); i++) tag = `reset${i}`
  return `-- ExponetDB: reset the scratch target ${shown(input.targetPath)} in place (legacy-import.md §2.5).
-- Run it with psql -v ON_ERROR_STOP=1 as a superuser connected to ${input.databaseName === undefined ? "the scratch target's database" : `the database ${shown(input.databaseName)}`}; it stops anywhere else.
-- Keeps the database (its oid), the identity marker and every schema outside the managed scope.
BEGIN;
-- Only the system catalog resolves names: an operator a replay left in a managed schema
-- (public.=(oid, regclass), say) never runs as the superuser running this script.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL standard_conforming_strings = on;
DO $${tag}$
${body}
$${tag}$;
COMMIT;
`
}
