import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SUPABASE_ALIASES, SUPABASE_FILES, supabaseTargetStatements } from '../src/index.ts'

/**
 * Writes the synthetic, Supabase-shaped history of the tests as files for
 * the owner test package of Wave 9 Part A
 * ([`owner-test-package.md`](../../../exponetdb-docs/04-migrations/owner-test-package.md)):
 *
 * - `roles.sql`: the project's roles on the cluster (run once in `postgres`):
 *   a default owner and the staging owner, `NOLOGIN`, the staging owner with
 *   `BYPASSRLS` like the reference installation's;
 * - `imported.sql`: the imported database as the history left it (run in
 *   that database): the objects, owned by the staging owner, the Supabase
 *   ledger in its real shape and a name-only runner's table. The observer's
 *   read of the ledgers comes from the bootstrap SQL, not from here;
 * - `legacy/*.sql`, `hints.yaml` (the multi-file alias and the ledgers) and
 *   `exponetdb.project.yaml` (`layout: legacy+bundles`).
 *
 * Shapes only: no consumer name, no data, no password.
 *
 * Usage: `bun run --cwd packages/testkit fixture:supabase <dir> [--project acme/platform]`
 */
const args = process.argv.slice(2)
const projectAt = args.indexOf('--project')
const project = projectAt >= 0 ? args[projectAt + 1] : 'acme/platform'
const dir = args.find((a, i) => !a.startsWith('--') && (projectAt < 0 || i !== projectAt + 1))
if (
  dir === undefined ||
  project === undefined ||
  !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(project)
) {
  process.stderr.write('usage: supabase-fixture.ts <dir> [--project <product>/<project>]\n')
  process.exit(2)
}
const OWNER = 'acme_owner'
const STAGING_OWNER = 'acme_staging_owner'
const out = resolve(dir)
const observerGrant = /^GRANT (USAGE|SELECT) ON .*exponetdb_observer$/

await mkdir(join(out, 'legacy'), { recursive: true })
await mkdir(join(out, 'migrations'), { recursive: true })
for (const f of SUPABASE_FILES) await writeFile(join(out, 'legacy', f.name), f.text)
const role = (name: string, attributes: string) =>
  `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} ${attributes}; END IF; END $$;`
await writeFile(
  join(out, 'roles.sql'),
  [
    '-- The project roles on the cluster (run once in the postgres database, as a superuser).',
    role(OWNER, 'NOLOGIN'),
    role(STAGING_OWNER, 'NOLOGIN BYPASSRLS'),
    '',
  ].join('\n'),
)
await writeFile(
  join(out, 'imported.sql'),
  [
    '-- The imported database as its history left it (run in that database, as a superuser).',
    `GRANT USAGE, CREATE ON SCHEMA public TO ${STAGING_OWNER};`,
    ...supabaseTargetStatements(STAGING_OWNER, 'exponetdb_observer')
      .filter((s) => !observerGrant.test(s))
      .map((s) => (s.trimEnd().endsWith(';') ? s.trimEnd() : `${s.trimEnd()};`)),
    '',
  ].join('\n'),
)
await writeFile(
  join(out, 'hints.yaml'),
  [
    'aliases:',
    ...Object.entries(SUPABASE_ALIASES).map(([name, stems]) => `  ${name}: [${stems.join(', ')}]`),
    'ledgers: [supabase, applied_migrations]',
    '',
  ].join('\n'),
)
await writeFile(
  join(out, 'exponetdb.project.yaml'),
  [
    'schema: exponetdb.project/v1',
    `project: ${project}`,
    'layout: legacy+bundles',
    'defaults:',
    '  lockTimeout: 5s',
    '  statementTimeout: 15m',
    '  role: owner',
    '  searchPath: [public]',
    'executionRoles:',
    `  owner: ${OWNER}`,
    'managedScope:',
    '  includeSchemas: [public]',
    '  excludeSchemas: []',
    'lintProfile: standard',
    'bundleRoots:',
    '  - migrations',
    'legacy:',
    '  directory: legacy',
    '  baseline: baseline:acme-supabase-2026',
    '',
  ].join('\n'),
)
process.stdout.write(
  `wrote ${SUPABASE_FILES.length} legacy files, roles.sql, imported.sql, hints.yaml and exponetdb.project.yaml to ${out}\n`,
)
