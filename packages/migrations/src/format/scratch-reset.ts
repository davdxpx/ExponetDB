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
  /** The project's managed scope: the listed schemas, else all but the excluded ones. */
  readonly includeSchemas?: readonly string[]
  readonly excludeSchemas?: readonly string[]
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const array = (values: readonly string[]) =>
  values.length === 0 ? 'ARRAY[]::text[]' : `ARRAY[${values.map(literal).join(', ')}]::text[]`
const ID = /^[a-z]{3}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export function scratchResetSql(input: ScratchResetInput): string {
  if (!ID.test(input.installationId) || !ID.test(input.targetId)) {
    throw new Error('an installation and a target id are canonical ids')
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('a generation is a positive integer')
  }
  const managed =
    input.includeSchemas === undefined
      ? `ARRAY(SELECT n.nspname::text FROM pg_catalog.pg_namespace n
             WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ('information_schema', 'exponetdb')
               AND NOT (n.nspname = ANY (${array(input.excludeSchemas ?? [])})))`
      : array(input.includeSchemas.filter((s) => s !== 'exponetdb'))
  // The path and the database name are shown in comments only, never executed.
  const shown = (v: string) => v.replace(/[^\x20-\x7e]/g, '?')
  return `-- ExponetDB: reset the scratch target ${shown(input.targetPath)} in place (legacy-import.md §2.5).
-- Run as a superuser connected to ${input.databaseName === undefined ? "the scratch target's database" : `the database ${shown(input.databaseName)}`}; it stops anywhere else.
-- Keeps the database (its oid), the identity marker and every schema outside the managed scope.
BEGIN;
DO $reset$
DECLARE
  managed text[] := ${managed};
  s record;
  g record;
  e record;
BEGIN
  IF NOT EXISTS (SELECT FROM exponetdb.target_identity
                  WHERE installation_id = ${literal(input.installationId)}
                    AND target_id = ${literal(input.targetId)}
                    AND generation = ${input.generation}) THEN
    RAISE EXCEPTION 'this database is not the scratch target %', ${literal(shown(input.targetPath))};
  END IF;
  IF EXISTS (SELECT FROM exponetdb.schema_migrations) THEN
    RAISE EXCEPTION 'the database has ledger rows: it was migrated, not only replayed';
  END IF;
  CREATE TEMPORARY TABLE exdb_reset_extensions ON COMMIT DROP AS
    SELECT x.extname::text AS name, n.nspname::text AS schema, x.extversion AS version
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
  FOR e IN SELECT * FROM exdb_reset_extensions LOOP
    EXECUTE pg_catalog.format('CREATE EXTENSION %I WITH SCHEMA %I VERSION %L', e.name, e.schema, e.version);
  END LOOP;
END
$reset$;
COMMIT;
`
}
