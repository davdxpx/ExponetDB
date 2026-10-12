import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from '../errors.ts'
import { sourceCommit } from './image.ts'
import {
  databaseReady,
  inspectContainer,
  type LabEnv,
  ownedContainer,
  readLabSecret,
  serveReady,
} from './stack.ts'
import {
  containerName,
  FIXTURE_VERSION,
  finishRun,
  type LabRecord,
  PROCESS_ROLES,
  prepareDirs,
  ROLES,
  type RunRecord,
  readLab,
  runDir,
  startRun,
  writeRun,
} from './state.ts'

/**
 * Test runs of a lab ([`15-cli/lab.md` §5](../../../../exponetdb-docs/15-cli/lab.md)):
 * each run has its own ID, record and log, holds the lab's lock (one
 * mutating run at a time), and ends with the real outcome. `smoke` checks
 * the running lab itself; the other suites run the repository's own
 * entrypoints (the same commands as CI and the README) from the source
 * checkout. A run whose environment is missing ends `lab_unavailable`,
 * never `failed`: a missing lab is not a product failure.
 */
export const SUITES = ['smoke', 'unit', 'integration', 'install', 'host:<scenario>'] as const

interface SuitePlan {
  readonly command: readonly string[]
  readonly env: Record<string, string>
  /** Why the suite cannot run here (a lab problem, not a test failure). */
  readonly unavailable: string | null
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function planSuite(
  suite: string,
  source: string,
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<SuitePlan> {
  const missing = (names: readonly string[]) => names.filter((n) => (env[n] ?? '') === '')
  if (suite === 'unit') return { command: ['bun', 'run', 'test'], env: {}, unavailable: null }
  if (suite === 'install') {
    return {
      command: ['bun', 'run', '--cwd', 'apps/cli', 'test:install'],
      env: {},
      unavailable: null,
    }
  }
  if (suite === 'integration') {
    const gone = missing(['EXDB_TEST_PG_URL', 'EXDB_TEST_TARGETS'])
    return {
      command: ['bun', 'run', 'test:integration'],
      env: {},
      unavailable:
        gone.length === 0
          ? null
          : `${gone.join(' and ')} not set: prepare the disposable servers with tooling/dev/control-store.sh and tooling/dev/targets.sh (local-development.md)`,
    }
  }
  const host = /^host:([a-z][a-z0-9-]{0,40})$/.exec(suite)
  if (host !== null) {
    const scenario = host[1] ?? ''
    const file = join('test', 'host', `${scenario}.host.test.ts`)
    const reasons = [
      (await exists(join(source, 'apps', 'server', file)))
        ? null
        : `there is no host scenario ${scenario}`,
      process.getuid?.() === 0
        ? null
        : 'host scenarios run as root on a disposable systemd host (this CLI never uses sudo)',
      (await exists('/run/systemd/system')) ? null : 'systemd is not running on this host',
      ...missing(['EXDB_TEST_PG_URL', 'EXDB_NODE_CLUSTERS', 'EXDB_NODE_E2E_AGENT_USER']).map(
        (n) => `${n} is not set`,
      ),
    ].filter((r): r is string => r !== null)
    return {
      command: ['bun', 'run', '--cwd', 'apps/server', 'test:host', file],
      env: { EXDB_LAB_RUN_DIR: directory },
      unavailable: reasons.length === 0 ? null : reasons.join('; '),
    }
  }
  throw new CliError('usage', `Unknown suite ${suite}; one of: ${SUITES.join(', ')}.`)
}

export interface RunOutcome {
  readonly run: RunRecord
  readonly checks: readonly SmokeCheck[]
}

/** Starts a run, executes the suite, records and returns the outcome. */
export async function testLab(
  env: LabEnv,
  suite: string,
  options: {
    readonly sourceDir: string | undefined
    readonly processEnv: NodeJS.ProcessEnv
    readonly echo: ((text: string) => void) | undefined
    readonly signal: AbortSignal
  },
): Promise<RunOutcome> {
  const lab = await readLab(env.paths)
  if (suite === 'smoke' && lab === undefined) {
    throw new CliError(
      'lab_not_found',
      `There is no lab ${env.labId}; run: exponetdb dev up --lab ${env.labId}`,
    )
  }
  const sourceDir = options.sourceDir ?? lab?.source?.dir
  const commit = sourceDir === undefined ? null : await sourceCommit(sourceDir)
  if (suite !== 'smoke' && sourceDir === undefined) {
    throw new CliError(
      'usage',
      'This suite runs from an ExponetDB source checkout: run it there or pass --source.',
    )
  }
  await prepareDirs(env.paths)
  const run = await startRun(
    env.paths,
    {
      labId: env.labId,
      suite,
      source: commit === null ? null : { commit },
      image: lab?.image ?? null,
      fixture: FIXTURE_VERSION,
      pid: process.pid,
    },
    env.now(),
  )
  const logPath = join(runDir(env.paths, run.runId), run.log)
  const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  const write = async (text: string) => {
    await log.write(text)
    options.echo?.(text)
  }
  try {
    if (suite === 'smoke') {
      if (lab === undefined) throw new CliError('lab_not_found', 'no lab')
      const checks = await smoke(env, lab)
      for (const c of checks) await write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}: ${c.detail}\n`)
      const failed = checks.filter((c) => !c.ok)
      return {
        run: await finishRun(
          env.paths,
          run,
          failed.length === 0
            ? { state: 'passed', exitCode: 0 }
            : {
                state: 'failed',
                exitCode: 1,
                reason: `${failed.length} check(s) failed: ${failed.map((c) => c.check).join(', ')}`,
              },
          env.now(),
        ),
        checks,
      }
    }
    const plan = await planSuite(
      suite,
      sourceDir ?? '',
      runDir(env.paths, run.runId),
      options.processEnv,
    )
    if (plan.unavailable !== null) {
      await write(`lab unavailable: ${plan.unavailable}\n`)
      return {
        run: await finishRun(
          env.paths,
          run,
          { state: 'lab_unavailable', exitCode: null, reason: plan.unavailable },
          env.now(),
        ),
        checks: [],
      }
    }
    await write(`$ ${plan.command.join(' ')}   (in ${sourceDir}, commit ${commit ?? 'unknown'})\n`)
    const [program, ...args] = plan.command
    const child = spawn(program ?? 'bun', args, {
      cwd: sourceDir,
      env: { ...options.processEnv, ...plan.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await writeRun(env.paths, { ...run, childPid: child.pid ?? null })
    const pending: Promise<void>[] = []
    child.stdout.on('data', (c: Buffer) => pending.push(write(c.toString('utf8'))))
    child.stderr.on('data', (c: Buffer) => pending.push(write(c.toString('utf8'))))
    const abort = () => child.kill('SIGTERM')
    options.signal.addEventListener('abort', abort, { once: true })
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(127))
      child.on('close', (c) => resolve(c))
    })
    options.signal.removeEventListener('abort', abort)
    await Promise.all(pending)
    const current = { ...run, childPid: child.pid ?? null }
    if (options.signal.aborted) {
      return {
        run: await finishRun(
          env.paths,
          current,
          { state: 'interrupted', exitCode: code, reason: 'interrupted (Ctrl-C)' },
          env.now(),
        ),
        checks: [],
      }
    }
    return {
      run: await finishRun(
        env.paths,
        current,
        code === 0
          ? { state: 'passed', exitCode: 0 }
          : {
              state: 'failed',
              exitCode: code,
              reason: `the suite exited ${code ?? 'by a signal'}`,
            },
        env.now(),
      ),
      checks: [],
    }
  } catch (error) {
    await finishRun(
      env.paths,
      run,
      {
        state:
          error instanceof CliError && error.code === 'lab_unavailable'
            ? 'lab_unavailable'
            : 'failed',
        exitCode: null,
        reason: error instanceof Error ? error.message : 'the run failed',
      },
      env.now(),
    )
    throw error
  } finally {
    await log.close()
  }
}

// ----- the smoke suite -----

export interface SmokeCheck {
  readonly check: string
  readonly ok: boolean
  readonly detail: string
}

const SECRET_SHAPES = /postgres:\/\/|SCRAM-SHA-256|"key":|exs[tu]_|exck_/

/** Checks the running lab: every role, TLS on the targets, the server's surface, and no secret in any log. */
export async function smoke(env: LabEnv, lab: LabRecord): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = []
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail })
  for (const role of ROLES) {
    const c = await ownedContainer(env, lab, role).catch((e: Error) => e)
    if (c instanceof Error || c === undefined) {
      add(`${role} container`, false, c instanceof Error ? c.message : 'gone')
      continue
    }
    add(
      `${role} container`,
      c.State.Running,
      `${c.State.Status}${c.State.Health === undefined ? '' : `, health ${c.State.Health.Status}`}`,
    )
    if (role === 'control' || role === 'staging' || role === 'production') {
      add(`${role} accepts connections`, await databaseReady(env, c.Id), 'pg_isready over TCP')
    } else {
      add(
        `${role} healthy`,
        c.State.Health?.Status === 'healthy',
        `Docker health ${c.State.Health?.Status ?? 'none'}`,
      )
      add(`${role} runs the lab image`, c.Image === lab.image.id, c.Image.slice(7, 19))
    }
  }
  for (const role of ['staging', 'production'] as const) {
    const id = lab.containers[role] ?? ''
    const name = containerName(env.labId, role)
    const conn = (mode: string) =>
      `host=${name} port=5432 dbname=postgres user=postgres sslmode=${mode}${mode === 'verify-full' ? ' sslrootcert=/var/lib/postgresql/data/tls/ca.crt' : ''}`
    const plain = await env.docker.run([
      'exec',
      '--user',
      'postgres',
      id,
      'psql',
      '-w',
      conn('disable'),
      '-tAc',
      'SELECT 1',
    ])
    add(
      `${role} refuses plaintext`,
      plain.code !== 0 && /no encryption/.test(plain.stderr),
      plain.code === 0 ? 'a plaintext connection was accepted' : 'pg_hba rejects TCP without TLS',
    )
    const tls = await env.docker.run([
      'exec',
      '--user',
      'postgres',
      id,
      'psql',
      '-w',
      conn('verify-full'),
      '-tAc',
      'SELECT 1',
    ])
    // -w never prompts: reaching the password request proves the server
    // certificate verified against the target's CA for its name.
    add(
      `${role} TLS verify-full`,
      /no password supplied|password authentication failed/.test(tls.stderr),
      /certificate|SSL/.test(tls.stderr)
        ? (tls.stderr.trim().split('\n')[0] ?? '')
        : 'certificate verified, then SCRAM requested',
    )
  }
  const base = `http://127.0.0.1:${lab.port}`
  add('serve ready', await serveReady(env, lab.port), `${base}/healthz/ready`)
  for (const path of ['/api/v1/targets', '/api/v1/nodes', '/api/v1/me']) {
    const status = await env
      .fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.status)
      .catch(() => 0)
    add(`${path} needs a sign-in`, status === 401, `answered ${status}`)
  }
  const login = await env
    .fetch(`${base}/login`, { signal: AbortSignal.timeout(5000) })
    .catch(() => undefined)
  const csp = login?.headers.get('content-security-policy') ?? ''
  add(
    'Web App with its CSP',
    login?.status === 200 && csp.startsWith("default-src 'none'"),
    csp.slice(0, 60),
  )
  const credentials = await readLabSecret(env.paths, 'credentials').catch(() => '')
  const passwords = credentials
    .split('\n')
    .map((l) => l.slice(l.indexOf('=') + 1).trim())
    .filter((p) => p.length >= 16)
  for (const role of PROCESS_ROLES) {
    const id = lab.containers[role]
    if (id === undefined || (await inspectContainer(env.docker, id)) === undefined) continue
    const logs = await env.docker.run(['logs', id])
    const text = `${logs.stdout}${logs.stderr}`
    const leaked = SECRET_SHAPES.test(text) || passwords.some((p) => text.includes(p))
    add(
      `${role} logs carry no secret`,
      !leaked,
      leaked ? 'secret material in the log' : `${text.split('\n').length} lines checked`,
    )
  }
  return checks
}
