/**
 * The schema-only copies a scratch target needs before a legacy replay
 * ([`legacy-import.md` §2.5](../../../../exponetdb-docs/04-migrations/legacy-import.md#25-scratch-targets),
 * follow-up 2 F3), as shell commands an operator runs: `pg_dump
 * --schema-only` of the named schemas of the imported target, a TOC filter
 * that leaves their triggers and row security policies out (a trigger on
 * `auth.users` calling a function of the managed scope, the
 * `on_auth_user_created` pattern, or a policy on `storage.objects` calling
 * one, would fail before the replay creates that function, and the history
 * creates them again anyway), and `pg_restore` in one transaction into the scratch
 * target. Pure; ExponetDB never runs it, and no credential is part of it:
 * the operator sets `IMPORTED_URL` and `SCRATCH_URL`.
 */
export interface ScratchCopyInput {
  /** The schemas to copy (`copySchemas` of the scratch preflight). */
  readonly schemas: readonly string[]
  /** For the comment only. */
  readonly targetPath?: string
  readonly scratchPath?: string
}

/** A schema name as a `pg_dump --schema` pattern that matches exactly it, shell-quoted. */
function schemaPattern(schema: string): string {
  // Inside double quotes a pattern is literal; in single quotes the shell keeps everything.
  const pattern = `"${schema.replaceAll('"', '""')}"`
  return `'${pattern.replaceAll("'", `'\\''`)}'`
}

export function scratchCopyCommands(input: ScratchCopyInput): string {
  if (input.schemas.length === 0) throw new Error('no schema to copy')
  for (const s of input.schemas) {
    const control = [...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch === '\u007f')
    if (s.length === 0 || s.length > 63 || control) {
      throw new Error('a schema name is 1 to 63 printable characters')
    }
  }
  const shown = (v: string | undefined, otherwise: string) =>
    v === undefined ? otherwise : v.replace(/[^\x20-\x7e]/g, '?')
  const flags = [...new Set(input.schemas)].map((s) => `--schema=${schemaPattern(s)}`).join(' ')
  return `# ExponetDB: schema-only copies for the scratch target ${shown(input.scratchPath, '')} (legacy-import.md §2.5).
# From the imported target ${shown(input.targetPath, '')}: no data, no triggers, no policies. Set IMPORTED_URL to a connection
# to the imported target's database and SCRATCH_URL to the scratch target's, as a role that may
# read the schemas and create them (owners and grants are kept: the roles must exist where the
# copy goes). Use pg_dump and pg_restore of the server's major or newer. A schema that already
# exists on the scratch target stops the restore: drop it there first.
set -euo pipefail
pg_dump --schema-only --format=custom --file=exdb-scratch-copy.dump ${flags} "$IMPORTED_URL"
pg_restore --list exdb-scratch-copy.dump | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (TRIGGER|POLICY|COMMENT [^ ]+ (TRIGGER|POLICY)) ' > exdb-scratch-copy.list
pg_restore --exit-on-error --single-transaction --use-list=exdb-scratch-copy.list --dbname="$SCRATCH_URL" exdb-scratch-copy.dump
`
}
