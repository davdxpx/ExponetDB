import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/cli/exit.ts'
import { referenceMarkdown } from '../src/cli/reference.ts'
import { COMMANDS } from '../src/commands/index.ts'
import { run } from '../src/main.ts'
import { testIo } from './support.ts'

/**
 * The local half of the CLI against a real directory: init, the project
 * file, new bundles, checksums, the graph and lint with the PostgreSQL
 * parser, the SCRAM verifier (a secret canary never reaches any output but
 * the one it was asked for), doctor without a server and the generated
 * reference.
 */
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-cli-local-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const noNetwork: typeof fetch = () => Promise.reject(new Error('no network in this test'))

async function cli(argv: readonly string[], extra: Partial<Parameters<typeof testIo>[0]> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(
    argv,
    testIo({
      configDir: join(dir, 'config'),
      cwd: join(dir, 'repo'),
      fetch: noNetwork,
      stdout,
      stderr,
      ...extra,
    }),
  )
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('a local migration stream', () => {
  it('initializes a project, adds bundles in dependency order, and checks them like the server', async () => {
    await mkdir(join(dir, 'repo'))
    expect((await cli(['init', '--project', 'demo/platform'])).code).toBe(0)
    expect((await cli(['init', '--project', 'demo/platform'])).code).toBe(EXIT.failure)
    expect((await cli(['project', 'validate', '--json'])).code).toBe(0)

    const first = JSON.parse((await cli(['migration', 'new', 'create-leads', '--json'])).stdout)
    expect(first.data.dependsOn).toEqual([])
    await writeFile(
      join(first.data.path, 'up.sql'),
      'CREATE TABLE public.leads (id bigint PRIMARY KEY, email text NOT NULL);\nGRANT SELECT ON public.leads TO app_reader;\n',
    )
    await writeFile(
      join(first.data.path, 'verify.sql'),
      "-- check: leads exists\nSELECT to_regclass('public.leads') IS NOT NULL AS ok;\n",
    )
    const second = JSON.parse(
      (await cli(['migration', 'new', 'leads-email-index', '--nontransactional', '--json'])).stdout,
    )
    expect(second.data.dependsOn).toEqual([first.data.migrationId])
    await writeFile(
      join(second.data.path, 'up.sql'),
      'CREATE INDEX CONCURRENTLY leads_email_idx ON public.leads (email);\n',
    )

    const graph = JSON.parse((await cli(['migration', 'graph', '--json'])).stdout)
    expect(graph.data).toMatchObject({
      valid: true,
      order: [first.data.migrationId, second.data.migrationId],
      heads: [second.data.migrationId],
    })

    const sums = JSON.parse((await cli(['migration', 'checksum', '--json'])).stdout)
    expect(sums.data.items).toHaveLength(2)
    for (const i of sums.data.items) expect(i.checksum).toMatch(/^sha256:c1:[0-9a-f]{64}$/)
    // A comment-only change keeps the apply checksum; an executable change does not.
    await writeFile(
      join(first.data.path, 'up.sql'),
      `-- a note\n${await readFile(join(first.data.path, 'up.sql'), 'utf8')}`,
    )
    const again = JSON.parse((await cli(['migration', 'checksum', '--json'])).stdout)
    expect(again.data.items[0].checksum).toBe(sums.data.items[0].checksum)

    const lint = await cli(['migration', 'lint', '--tier', 'nonprod', '--json'])
    const report = JSON.parse(lint.stdout)
    expect(report.data.bundles).toHaveLength(2)
    expect(report.data.graph.valid).toBe(true)
    expect([0, 1]).toContain(lint.code)
    expect(lint.code === 0).toBe(report.status === 'ok')
  })

  it('refuses a broken bundle with its reason and an exit code that is never 0', async () => {
    await mkdir(join(dir, 'repo'))
    await cli(['init', '--project', 'demo/platform'])
    const made = JSON.parse((await cli(['migration', 'new', 'broken', '--json'])).stdout)
    await writeFile(join(made.data.path, 'extra.txt'), 'not a bundle file')
    const sums = await cli(['migration', 'checksum', '--json'])
    expect(sums.code).toBe(EXIT.failure)
    expect(JSON.parse(sums.stdout).data.items[0]).toMatchObject({
      valid: false,
      error: expect.stringContaining('unexpected_file'),
    })
    const lint = await cli(['migration', 'lint'])
    expect(lint.code).toBe(EXIT.failure)
  })

  it('reports where every setting comes from', async () => {
    await mkdir(join(dir, 'repo'))
    await cli(['init', '--project', 'demo/platform'])
    await cli([
      'profile',
      'add',
      'lab',
      '--server',
      'https://db.example.test',
      '--use',
      '--default-target',
      'tgt_x',
    ])
    const ctx = JSON.parse(
      (await cli(['project', 'context', '--json'], { env: { EXPONETDB_OUTPUT: 'table' } })).stdout,
    )
    expect(ctx.data).toMatchObject({
      server: { value: 'https://db.example.test', source: 'profile lab' },
      project: { value: 'demo/platform' },
      target: { value: 'tgt_x', source: 'profile lab' },
      output: { value: 'json', source: '--output' },
    })
    expect((await cli(['config', 'set', 'output', 'ndjson'])).code).toBe(0)
    expect(JSON.parse((await cli(['config', 'show', '-o', 'json'])).stdout).data.defaults).toEqual({
      output: 'ndjson',
      target: 'tgt_x',
    })
    expect((await cli(['config', 'unset', 'target'])).code).toBe(0)
    expect((await cli(['config', 'set', 'color', 'x'])).code).toBe(EXIT.usage)
  })
})

describe('secrets scram-verifier', () => {
  const CANARY = 'canary-password-4f9d2c1b-never-printed'

  it('writes a PostgreSQL verifier to a new private file and never prints the password', async () => {
    await mkdir(join(dir, 'repo'))
    const out = await cli(
      ['secrets', 'scram-verifier', '--stdin', '--file', 'app.verifier', '--json'],
      { stdin: `${CANARY}\n` },
    )
    expect(out.code).toBe(0)
    const file = join(dir, 'repo', 'app.verifier')
    const verifier = (await readFile(file, 'utf8')).trim()
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    )
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600')
    expect(out.stdout + out.stderr).not.toContain(CANARY)
    expect(out.stdout + out.stderr).not.toContain(verifier)
    // Never overwritten; never in JSON; the password never comes from an argument.
    expect(
      (
        await cli(['secrets', 'scram-verifier', '--stdin', '--file', 'app.verifier'], {
          stdin: CANARY,
        })
      ).code,
    ).toBe(EXIT.failure)
    expect(
      (await cli(['secrets', 'scram-verifier', '--stdin', '--stdout', '--json'], { stdin: CANARY }))
        .code,
    ).toBe(EXIT.usage)
    expect((await cli(['secrets', 'scram-verifier', CANARY, '--stdout'])).code).toBe(EXIT.usage)
    const printed = await cli(['secrets', 'scram-verifier', '--stdin', '--stdout'], {
      stdin: CANARY,
    })
    expect(printed.stdout).toMatch(/^SCRAM-SHA-256\$/)
    expect(printed.stdout + printed.stderr).not.toContain(CANARY)
    expect(
      (await cli(['secrets', 'scram-verifier', '--stdin', '--stdout'], { stdin: 'short' })).code,
    ).toBe(EXIT.usage)
    expect((await readdir(join(dir, 'repo'))).sort()).toEqual(['app.verifier'])
  })
})

describe('doctor, agent help and the reference', () => {
  it('runs doctor without a server and says what it skipped', async () => {
    await mkdir(join(dir, 'repo'))
    const out = await cli(['doctor', '--skip-parser', '--json'])
    const doc = JSON.parse(out.stdout)
    const checks = Object.fromEntries(
      doc.data.items.map((c: { check: string; status: string }) => [c.check, c.status]),
    )
    expect(checks).toMatchObject({
      cli: 'ok',
      'token store': 'ok',
      profiles: 'ok',
      server: 'skip',
      project: 'skip',
    })
    expect(out.code).toBe(0)
  })

  it('keeps 15-cli/reference.md generated from the registry', async () => {
    const path = fileURLToPath(
      new URL('../../../exponetdb-docs/15-cli/reference.md', import.meta.url),
    )
    expect(await readFile(path, 'utf8')).toBe(referenceMarkdown(COMMANDS))
  })

  it('gives an agent the contract, the exit codes and every command', async () => {
    const out = await cli(['agent-help'])
    expect(out.stdout).toContain('--no-input')
    expect(out.stdout).toContain('130 interrupted')
    for (const c of COMMANDS) expect(out.stdout).toContain(`### ${c.path.join(' ')}`)
  })
})
