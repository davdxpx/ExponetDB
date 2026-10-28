/**
 * Builds fixtures/hazard and fixtures/safe with the product's own
 * `exponetdb migration new` (ULID, dependsOn = heads, manifest template) and
 * then fills in manifest fields, up.sql and verify.sql from specs.ts.
 *
 *   EXDB_TREE=/path/to/tree bun --conditions=@exponetdb/source build-fixtures.ts <out-dir>
 *
 * Existing fixtures are deleted first (new ULIDs each run: fixtures are
 * generated once and committed).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HAZARD, SAFE, type Spec } from './specs.ts'

const tree = process.env['EXDB_TREE'] ?? '/home/david/Development/ExponetDB-verify-b3'
const out = process.argv[2]
if (out === undefined) throw new Error('usage: build-fixtures.ts <out-dir>')

const PROJECT = (name: string) => `schema: exponetdb.project/v1
project: demo/${name}
layout: bundles
defaults:
  role: owner
  searchPath: ["public"]
executionRoles:
  owner: shop_owner
managedScope:
  includeSchemas: ["public"]
  excludeSchemas: []
lintProfile: strict
`

async function cli(workdir: string, args: string[]): Promise<{ migrationId: string; directory: string }> {
  const proc = Bun.spawn(
    ['bun', '--conditions=@exponetdb/source', `${tree}/apps/cli/src/main.ts`, '--workdir', workdir, '--output', 'json', ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`cli ${args.join(' ')} failed: ${text} ${await new Response(proc.stderr).text()}`)
  return JSON.parse(text).data
}

function manifest(text: string, spec: Spec): string {
  const desc = spec.description.replace(/\n/g, ' ')
  let m = text.replace('  What this migration changes and why.', `  ${desc}`)
  const extra = [
    spec.lockTimeout === undefined ? '' : `  lockTimeout: ${spec.lockTimeout}\n`,
    spec.statementTimeout === undefined ? '' : `  statementTimeout: ${spec.statementTimeout}\n`,
  ].join('')
  m = m.replace(/(  transactional: (?:true|false)\n)/, `$1${extra}`)
  const declared = spec.declared ?? 'additive'
  const notes = declared === 'additive' ? '' : `  notes: ${spec.id} is ${declared} by design (DDL hazard fixture).\n`
  return m.replace('  declared: additive\n', `  declared: ${declared}\n${notes}`)
}

function verify(spec: Spec): string {
  const covers = (spec.covers ?? []).length === 0 ? '' : `-- covers: ${(spec.covers ?? []).join(', ')}\n`
  return `-- check: ${spec.slug.replaceAll('-', ' ')} left the database usable\n${covers}${spec.verify ?? 'SELECT true AS ok;'}\n`
}

async function build(name: string, specs: readonly Spec[]) {
  const dir = join(out, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'exponetdb.project.yaml'), PROJECT(name))
  const made: string[] = []
  for (const spec of specs) {
    const flags = spec.transactional === false ? ['--nontransactional'] : []
    const r = await cli(dir, ['migration', 'new', `${spec.id}-${spec.slug}`, ...flags])
    const path = join(dir, r.directory)
    const text = await readFile(join(path, 'migration.yaml'), 'utf8')
    await writeFile(join(path, 'migration.yaml'), manifest(text, spec))
    await writeFile(join(path, 'up.sql'), spec.up)
    await writeFile(join(path, 'verify.sql'), verify(spec))
    made.push(r.directory)
    // ULIDs sort by time; keep creation times distinct and ordered.
    await new Promise((res) => setTimeout(res, 3))
  }
  console.log(`${name}: ${(await readdir(dir)).length - 1} bundles`)
}

await build('hazard', HAZARD)
await build('safe', SAFE)
