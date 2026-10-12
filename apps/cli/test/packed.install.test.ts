import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The packed CLI, installed outside the monorepo (order §60, §68;
 * [`15-cli/install.md`](../../../exponetdb-docs/15-cli/install.md)): the
 * tarball from `bun run pack`, installed with npm from the file alone (no
 * registry), run with Node 24 from a directory that is not the repository
 * and an environment that names nothing of it. The remote half of the same
 * artifact runs in the server's CLI process suite with `EXDB_CLI_BIN`.
 *
 * Needs Node 24 and npm: `EXDB_CLI_NODE` (default `node` on PATH) must be
 * major 24, otherwise the suite fails (it never skips).
 */
const run = promisify(execFile)
const app = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(app, '..', '..')
const NODE = process.env['EXDB_CLI_NODE'] ?? 'node'
const nodeDir = dirname(NODE)
const NPM = NODE === 'node' ? 'npm' : join(nodeDir, 'npm')
const PATH = `${NODE === 'node' ? '' : `${nodeDir}:`}/usr/local/bin:/usr/bin:/bin`

let work = ''
let artifact = ''
let bin = ''
let installed = ''

interface Out {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function exdb(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Out> {
  try {
    const { stdout, stderr } = await run(bin, [...args], {
      cwd,
      env: { PATH, HOME: join(work, 'home'), NO_COLOR: '1', ...env },
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await files(full)))
    else out.push(full)
  }
  return out
}

beforeAll(async () => {
  const version = spawnSync(NODE, ['--version'], { encoding: 'utf8' }).stdout.trim()
  expect(version, `Node 24 is needed (EXDB_CLI_NODE=${NODE})`).toMatch(/^v24\./)
  work = await realpath(await mkdtemp(join(tmpdir(), 'exdb-cli-install-')))
  expect(work.startsWith(repo)).toBe(false)
  const packed = spawnSync('bun', ['run', 'pack'], { cwd: app, encoding: 'utf8' })
  expect(packed.status, packed.stderr).toBe(0)
  const info = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('{'))) as {
    artifact: string
    sha256: string
  }
  artifact = join(repo, info.artifact)
  const digest = createHash('sha256')
    .update(await readFile(artifact))
    .digest('hex')
  expect(digest).toBe(info.sha256)
  expect(await readFile(`${artifact}.sha256`, 'utf8')).toBe(
    `${digest}  ${artifact.split('/').pop()}\n`,
  )
  // Install from the file alone: --offline proves no registry is needed.
  const prefix = join(work, 'prefix')
  const install = spawnSync(
    NPM,
    ['install', '--global', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, artifact],
    { cwd: work, encoding: 'utf8', env: { PATH, HOME: join(work, 'home') } },
  )
  expect(install.status, install.stderr).toBe(0)
  bin = join(prefix, 'bin', 'exponetdb')
  installed = join(prefix, 'lib', 'node_modules', '@exponetdb', 'cli')
}, 240_000)

afterAll(async () => {
  if (work !== '') await rm(work, { recursive: true, force: true })
})

describe('the packed CLI', () => {
  it('carries its runtime, three parsers, its build identity and nothing of the build machine', async () => {
    const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    expect(JSON.stringify(pkg)).not.toContain('workspace:')
    expect(pkg.bundleDependencies).toEqual(['libpg-query-16', 'libpg-query-17', 'libpg-query-18'])
    expect(pkg.engines.node).toBe('>=24.0.0 <25')
    expect(pkg.private).toBe(true)
    const build = JSON.parse(await readFile(join(installed, 'BUILD.json'), 'utf8'))
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim()
    expect(build.commit.replace(/-dirty$/, '')).toBe(head)
    for (const major of [16, 17, 18]) {
      await expect(
        lstat(join(installed, 'node_modules', `libpg-query-${major}`, 'wasm', 'libpg-query.wasm')),
      ).resolves.toBeDefined()
    }
    // Every file is inside the install; no link leads back to the repository.
    for (const file of await files(join(work, 'prefix'))) {
      const s = await lstat(file)
      if (s.isSymbolicLink()) {
        const target = resolve(dirname(file), await readlink(file))
        expect(target.startsWith(join(work, 'prefix'))).toBe(true)
      }
    }
    const text = await readFile(join(installed, 'bin', 'exponetdb.mjs'), 'utf8')
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
    for (const s of [repo, process.env['HOME'] ?? '/nonexistent-home', 'workspace:']) {
      expect(text.includes(s), s).toBe(false)
    }
    expect(text).not.toMatch(/from ["']@exponetdb\//)
  })

  it('answers --version and every help without a network or a configuration', async () => {
    const version = await exdb(['--version'], work, { HTTPS_PROXY: 'http://127.0.0.1:9' })
    expect(version.code).toBe(0)
    const build = JSON.parse(await readFile(join(installed, 'BUILD.json'), 'utf8'))
    expect(version.stdout).toBe(
      `exponetdb ${build.version} (${build.commit}, built ${build.builtAt})\n`,
    )
    const listing = await exdb(['commands', '--json'], work)
    expect(listing.code).toBe(0)
    const commands = JSON.parse(listing.stdout).data.items as { command: string }[]
    expect(commands.length).toBeGreaterThan(80)
    for (const c of commands) {
      const help = await exdb([...c.command.split(' '), '--help'], work)
      expect(help.code, c.command).toBe(0)
      expect(help.stdout, c.command).toContain(`exponetdb ${c.command}`)
    }
    for (const shell of ['bash', 'zsh', 'fish']) {
      expect((await exdb(['completion', shell], work)).code).toBe(0)
    }
    const agent = await exdb(['agent-help'], work)
    expect(agent.code).toBe(0)
    expect(agent.stdout).toContain('exponetdb.cli-output/v1')
  }, 120_000)

  it('lints with the grammar of the major it is asked for, at the exact byte', async () => {
    const project = join(work, 'project')
    await mkdir(project)
    expect((await exdb(['init', '--project', 'demo/platform'], project)).code).toBe(0)
    const created = await exdb(['migration', 'new', 'add-notes', '--json'], project)
    const dir = JSON.parse(created.stdout).data.path as string
    const lint = async (major: number) => {
      const r = await exdb(['migration', 'lint', '--postgres', String(major), '--json'], project)
      const doc = JSON.parse(r.stdout)
      const findings = doc.data.bundles.flatMap((b: { findings: unknown[] }) => b.findings) as {
        rule: string
        line: number | null
        column: number | null
      }[]
      return { code: r.code, findings, parse: findings.find((f) => f.rule === 'parse_error') }
    }
    await writeFile(
      join(dir, 'up.sql'),
      'CREATE TABLE public.notes (id bigint PRIMARY KEY, body text NOT NULL);\nGRANT SELECT ON public.notes TO PUBLIC;\n',
    )
    for (const major of [16, 17, 18]) {
      const r = await lint(major)
      expect(r.code, `PostgreSQL ${major}`).toBe(0)
      expect(r.findings).toEqual([])
    }
    // SET EXPRESSION is PostgreSQL 17 grammar: 16 refuses it at "EXPRESSION".
    await writeFile(
      join(dir, 'up.sql'),
      'ALTER TABLE public.notes ALTER COLUMN b SET EXPRESSION AS (a * 3);\n',
    )
    expect((await lint(16)).parse).toMatchObject({ line: 1, column: 45 })
    expect((await lint(17)).parse).toBeUndefined()
    // A virtual generated column is PostgreSQL 18 grammar.
    await writeFile(
      join(dir, 'up.sql'),
      'CREATE TABLE public.calc (a int, b int GENERATED ALWAYS AS (a * 2) VIRTUAL);\n',
    )
    const v17 = await lint(17)
    expect(v17.code).toBe(1)
    expect(v17.parse).toMatchObject({ line: 1, column: 68 })
    expect((await lint(18)).parse).toBeUndefined()
  }, 120_000)

  it('fails clearly, never with a stack trace, when a parser asset is missing', async () => {
    const broken = join(work, 'broken')
    await cp(installed, broken, { recursive: true })
    await rm(join(broken, 'node_modules', 'libpg-query-17', 'wasm', 'libpg-query.wasm'))
    const project = join(work, 'broken-project')
    await mkdir(project)
    expect((await exdb(['init', '--project', 'demo/platform'], project)).code).toBe(0)
    const created = await exdb(['migration', 'new', 'add-notes', '--json'], project)
    await writeFile(
      join(JSON.parse(created.stdout).data.path, 'up.sql'),
      'CREATE TABLE public.notes (id bigint PRIMARY KEY);\nGRANT SELECT ON public.notes TO PUBLIC;\n',
    )
    const lint = async (major: number): Promise<Out> => {
      try {
        const { stdout, stderr } = await run(
          join(broken, 'bin', 'exponetdb.mjs'),
          ['migration', 'lint', '--postgres', String(major), '--json'],
          { cwd: project, env: { PATH, HOME: join(work, 'home') } },
        )
        return { code: 0, stdout, stderr }
      } catch (error) {
        return error as Out
      }
    }
    const missing = await lint(17)
    expect(missing.code).not.toBe(0)
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: 'error',
      error: { code: 'parser_unavailable' },
    })
    expect(missing.stderr).not.toContain('Aborted(')
    expect(`${missing.stdout}${missing.stderr}`).not.toMatch(/\n\s+at .+:\d+:\d+/)
    // The other grammars still work in the same copy.
    expect((await lint(18)).code).toBe(0)
  }, 60_000)

  it('reads a token store written by the previous CLI (Wave 3B) without showing a token', async () => {
    // The previous store, written by main's own code (not a hand-made file).
    const old = join(work, 'previous')
    await mkdir(old)
    for (const file of ['store.ts', 'errors.ts']) {
      const source = spawnSync('git', ['-C', repo, 'show', `origin/main:apps/cli/src/${file}`], {
        encoding: 'utf8',
      })
      expect(source.status, source.stderr).toBe(0)
      await writeFile(join(old, file), source.stdout)
    }
    const config = join(work, 'upgrade-config')
    // Tokens in the store's own format (exat_/exrt_ and 43 characters).
    const canary = `exat_${'C'.repeat(31)}ANARY7f3c0ab`
    const refresh = `exrt_${'C'.repeat(31)}ANARY7f3c0ab`
    await writeFile(
      join(old, 'write.ts'),
      `import { TokenStore } from './store.ts'
await new TokenStore(${JSON.stringify(config)}).write({
  server: 'https://db.example.test',
  clientId: 'cli_x',
  accessToken: '${canary}',
  accessExpiresAt: Date.now() + 3600_000,
  refreshToken: '${refresh}',
  scope: 'openid targets.read',
  obtainedAt: Date.now(),
} as never)
`,
    )
    const wrote = spawnSync('bun', [join(old, 'write.ts')], { cwd: old, encoding: 'utf8' })
    expect(wrote.status, wrote.stderr).toBe(0)
    const status = await exdb(['auth', 'status', '--json'], work, { EXPONETDB_CONFIG_DIR: config })
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).data.items).toMatchObject([
      { server: 'https://db.example.test', state: 'signed_in', scope: 'openid targets.read' },
    ])
    expect(`${status.stdout}${status.stderr}`).not.toContain(canary)
    expect(`${status.stdout}${status.stderr}`).not.toContain(refresh)
  }, 60_000)
})
