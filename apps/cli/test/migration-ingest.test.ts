import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/cli/exit.ts'
import { FakeApi, ok, refusal, ulid } from './fake-api.ts'

/**
 * `migration ingest`: a verify.sql corrected after the migration was applied cannot go through
 * `migration plan` (an applied migration is refused there with MIGRATION_ALREADY_APPLIED and
 * nothing is stored), and no command called the server's bundle store directly. The command
 * submits the exact bytes of local bundles to `POST /projects/{projectId}/bundles` and never plans,
 * applies or touches a target.
 */
let api: FakeApi
let repo = ''
const PRJ = ulid('prj', 1)
const checksum = `sha256:c1:${'a'.repeat(64)}`

const cli = (argv: readonly string[]) => api.cli(argv, { cwd: repo })

async function newBundle(name: string): Promise<{ id: string; directory: string; path: string }> {
  const made = JSON.parse((await cli(['migration', 'new', name, '--json'])).stdout)
  const path = made.data.path as string
  const directory = basename(path)
  return { id: directory.split('_')[0] as string, directory, path }
}

const sentBundles = () =>
  api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/bundles'))

beforeEach(async () => {
  api = new FakeApi()
  await api.open()
  repo = join(api.dir, 'repo')
  await mkdir(repo)
  expect((await cli(['init', '--project', 'reosa/platform'])).code).toBe(0)
  api.on('GET', '/projects', () =>
    ok('listProjects', {
      items: [
        {
          id: PRJ,
          productId: ulid('prd', 2),
          slug: 'platform',
          path: 'reosa/platform',
          displayName: 'Platform',
          evidenceOverride: {},
          managedScope: { includeSchemas: null, excludeSchemas: [] },
          revision: 1,
        },
      ],
      nextCursor: null,
    }),
  )
})

afterEach(() => api.close())

describe('migration ingest', () => {
  it('stores the named bundle with its exact bytes and names the verify to run next', async () => {
    const a = await newBundle('corrected')
    const b = await newBundle('other')
    const verify = "-- check: fixed\nSELECT to_regclass('public.t') IS NOT NULL AS ok;\n"
    await writeFile(join(a.path, 'verify.sql'), verify)
    api.on('POST', `/projects/${PRJ}/bundles`, () =>
      ok('ingestBundles', {
        items: [
          {
            migrationId: a.id,
            name: 'corrected',
            checksum,
            revision: 2,
            status: 'verify_revision',
          },
        ],
      }),
    )

    const r = await cli(['migration', 'ingest', a.id])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('verify_revision')
    expect(r.stdout).toContain(`exponetdb migration verify ${a.id} --revision 2 --target <target>`)

    const sent = sentBundles()
    expect(sent).toHaveLength(1)
    const body = sent[0]?.body as {
      bundles: { directory: string; files: Record<string, string> }[]
    }
    expect(body.bundles.map((x) => x.directory)).toEqual([a.directory])
    expect(body.bundles[0]?.files['verify.sql']).toBe(verify)
    expect(body.bundles[0]?.files['up.sql']).toBe(await readFile(join(a.path, 'up.sql'), 'utf8'))
    expect(JSON.stringify(body)).not.toContain(b.directory)
  })

  it('stores every local bundle when no id is named', async () => {
    const a = await newBundle('first')
    const b = await newBundle('second')
    api.on('POST', `/projects/${PRJ}/bundles`, () =>
      ok('ingestBundles', {
        items: [
          { migrationId: a.id, name: 'first', checksum, revision: 1, status: 'stored' },
          { migrationId: b.id, name: 'second', checksum, revision: 1, status: 'unchanged' },
        ],
      }),
    )
    const r = await cli(['migration', 'ingest', '--output', 'json'])
    expect(r.code, r.stderr).toBe(0)
    const body = sentBundles()[0]?.body as { bundles: { directory: string }[] }
    expect(body.bundles.map((x) => x.directory).sort()).toEqual([a.directory, b.directory].sort())
    expect(JSON.parse(r.stdout).data.items).toHaveLength(2)
  })

  it('suggests no verify for a bundle that was stored or unchanged', async () => {
    const a = await newBundle('plain')
    api.on('POST', `/projects/${PRJ}/bundles`, () =>
      ok('ingestBundles', {
        items: [{ migrationId: a.id, name: 'plain', checksum, revision: 1, status: 'unchanged' }],
      }),
    )
    const r = await cli(['migration', 'ingest', a.id])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('migration verify')
  })

  it('never plans, applies or reads a target', async () => {
    const a = await newBundle('only')
    api.on('POST', `/projects/${PRJ}/bundles`, () =>
      ok('ingestBundles', {
        items: [{ migrationId: a.id, name: 'only', checksum, revision: 1, status: 'stored' }],
      }),
    )
    expect((await cli(['migration', 'ingest', a.id])).code).toBe(0)
    expect(api.requests.map((q) => `${q.method} ${q.path}`).sort()).toEqual([
      'GET /projects',
      `POST /projects/${PRJ}/bundles`,
    ])
  })

  it('refuses an id that is not a local bundle before it sends anything', async () => {
    await newBundle('present')
    const r = await cli(['migration', 'ingest', ulid('mig', 9).replace('mig_', '')])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('Not every named migration is a local bundle')
    expect(api.requests).toHaveLength(0)
  })

  it('shows a refusal of the server and exits non-zero', async () => {
    const a = await newBundle('changed')
    api.on('POST', `/projects/${PRJ}/bundles`, () => refusal(409, 'MIGRATION_CHECKSUM_MISMATCH'))
    const r = await cli(['migration', 'ingest', a.id])
    expect(r.code).toBe(EXIT.failure)
    expect(r.stderr).toContain('MIGRATION_CHECKSUM_MISMATCH')
  })

  it('is listed with its scope and action in the command reference', async () => {
    const r = await cli(['migration', 'ingest', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('migrations.plan')
    expect(r.stdout).toContain('migration.bundle.ingest')
    expect(r.stdout).toContain('MIGRATION_ALREADY_APPLIED')
  })
})
