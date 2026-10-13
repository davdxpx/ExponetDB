import { readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EXIT } from '../cli/exit.ts'
import { arg, flag } from '../cli/reads.ts'
import type { CommandInput, CommandSpec, FlagSpec, RunContext } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { CliError } from '../errors.ts'
import { createNewPrivateFile, writePrivateJson } from '../files.ts'
import { localDocker } from '../lab/docker.ts'
import { findSource, type ImageChoice } from '../lab/image.ts'
import { SUITES, testLab } from '../lab/runs.ts'
import {
  checkDocker,
  createLab,
  exportLab,
  type LabEnv,
  type LabStatus,
  labStatus,
  quiesce,
  removeLab,
  resumeLab,
  runningContainer,
  stopLab,
} from '../lab/stack.ts'
import {
  checkLabId,
  DATABASE_ROLES,
  labPaths,
  listRuns,
  ROLES,
  type Role,
  readLab,
  readRun,
  runDir,
} from '../lab/state.ts'
import type { Major } from '../local/grammar.ts'
import { type Block, type CommandResult, result } from '../output/model.ts'

/**
 * The local test lab ([`15-cli/lab.md`](../../../../exponetdb-docs/15-cli/lab.md)):
 * a disposable ExponetDB installation on this machine's Docker, for
 * development and the owner's tests. Every command acts only on the Docker
 * objects one lab ID created (recorded by ID, checked by label) through the
 * local Docker socket; nothing here talks to a server, a registered target
 * or production. `dev sql` and `dev shell` open the lab's own containers.
 */
const PLATFORMS = ['linux', 'darwin'] as const

/**
 * The lab's local MCP client (`exponetdb dev mcp-client`): a public client
 * for the loopback redirects of the common MCP clients (any port matches,
 * RFC 8252): `/callback` (Claude Code, Codex, the SDK harness), `/` (VS Code)
 * and `/oauth/callback` (MCP Inspector: the CLI on 127.0.0.1, the web UI on localhost).
 */
export const LAB_MCP_CLIENT = {
  name: 'ExponetDB lab client',
  redirectUris: [
    'http://127.0.0.1/callback',
    'http://localhost/callback',
    'http://127.0.0.1/',
    'http://127.0.0.1/oauth/callback',
    'http://localhost/oauth/callback',
  ],
} as const

const LAB_FLAG: FlagSpec = {
  name: 'lab',
  type: 'string',
  placeholder: 'id',
  description: 'The lab ID (default local, or EXPONETDB_LAB).',
}
const INTERRUPT_FLAG: FlagSpec = {
  name: 'interrupt',
  type: 'boolean',
  description: 'Stop a test run that holds the lab (recorded as interrupted) instead of refusing.',
}

function labEnv(ctx: RunContext, input: CommandInput): LabEnv {
  const labId = checkLabId(flag(input, 'lab') ?? ctx.io.env['EXPONETDB_LAB'] ?? 'local')
  return {
    docker: localDocker(ctx.io.env),
    paths: labPaths(ctx.io.configDir, labId),
    labId,
    progress: (line) => ctx.progress(`lab ${labId}: ${line}`),
    now: ctx.io.now,
    sleep: (ms) => ctx.io.sleep(ms, ctx.io.signal),
    fetch: ctx.io.fetch,
  }
}

async function confirmDestructive(
  ctx: RunContext,
  question: string,
  input: CommandInput,
): Promise<void> {
  if (ctx.global.yes || input.flags['yes'] === true) return
  if (ctx.global.noInput || !ctx.io.tty.stdin) {
    throw new UsageError(`${question} Pass --yes to confirm.`)
  }
  if (!(await ctx.io.confirm(question))) {
    throw new CliError('canceled', 'Nothing was changed.')
  }
}

function statusBlocks(s: LabStatus): Block[] {
  if (!s.exists) {
    return [
      {
        kind: 'text',
        lines: [`There is no lab ${s.labId}. Create it with: exponetdb dev up --lab ${s.labId}`],
      },
    ]
  }
  return [
    { kind: 'header', title: `lab ${s.labId}${s.ready ? ' · ready' : ' · not ready'}` },
    {
      kind: 'fields',
      rows: [
        ['Server', s.server],
        ['Installation', s.installationId],
        [
          'Image',
          s.image === null ? null : `${s.image.ref} (${s.image.revision ?? 'no revision label'})`,
        ],
        [
          'Source',
          s.freshness === null || s.freshness.source === null
            ? 'none (an image named with --image)'
            : `${s.freshness.source}${s.freshness.current ? '' : ` (the lab runs ${s.freshness.running}: dev up --rebuild)`}`,
        ],
        ['Targets', s.postgres === null ? null : `PostgreSQL ${s.postgres} with TLS`],
        [
          'Active run',
          s.activeRun === null
            ? 'none'
            : `${s.activeRun.runId} (${s.activeRun.suite}, since ${s.activeRun.startedAt})`,
        ],
        [
          'Last run',
          s.lastRun === null
            ? 'none'
            : `${s.lastRun.runId} ${s.lastRun.suite}: ${s.lastRun.state} (${s.lastRun.endedAt ?? s.lastRun.startedAt})`,
        ],
      ],
    },
    {
      kind: 'table',
      columns: [
        { title: 'ROLE' },
        { title: 'CONTAINER' },
        { title: 'STATE' },
        { title: 'READY' },
        { title: 'DETAIL', flexible: true },
      ],
      rows: s.roles.map((r) => [
        r.role,
        r.container ?? '-',
        r.state,
        r.ready ? 'yes' : 'no',
        r.detail,
      ]),
    },
    {
      kind: 'table',
      columns: [
        { title: 'TARGET' },
        { title: 'HOST (lab network)' },
        { title: 'PORT' },
        { title: 'CA BUNDLE', flexible: true },
      ],
      rows: s.targets.map((t) => [t.role, t.host, String(t.port), t.caFile]),
    },
  ]
}

function statusResult(command: string, s: LabStatus, next: readonly string[] = []): CommandResult {
  return result({
    command,
    data: s,
    blocks: statusBlocks(s),
    next,
    ...(s.ready
      ? {}
      : {
          status: 'failed' as const,
          exitCode: EXIT.failure,
          error: {
            code: s.exists ? 'lab_not_ready' : 'lab_not_found',
            message: s.exists ? `Lab ${s.labId} is not ready.` : `There is no lab ${s.labId}.`,
          },
        }),
  })
}

async function imageChoice(ctx: RunContext, input: CommandInput): Promise<ImageChoice> {
  const image = flag(input, 'image')
  const source = flag(input, 'source')
  if (image !== undefined && source !== undefined)
    throw new UsageError('--image and --source exclude each other.')
  if (image !== undefined) return { kind: 'image', ref: image }
  const dir =
    source !== undefined
      ? resolve(ctx.io.cwd, source)
      : await findSource(ctx.global.workdir ?? ctx.io.cwd)
  if (dir === undefined) {
    throw new UsageError(
      'dev up builds the image from an ExponetDB source checkout: run it inside one, pass --source <dir>, or name an image with --image.',
    )
  }
  return { kind: 'source', dir }
}

/** Output text as lines for the renderer (which removes control sequences). */
function lines(text: string): string[] {
  const all = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  return text === '' ? [] : all
}

function databaseOf(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new UsageError(`Unknown role ${role}; one of: ${ROLES.join(', ')}.`)
  }
  return role as Role
}

export const devCommands: readonly CommandSpec[] = [
  {
    path: ['dev', 'up'],
    summary:
      'Create or start a local lab: Control Store, staging and production targets, serve, worker and gateway.',
    description:
      'Builds the server image from the source checkout at its current commit (or uses --image), then sets the installation up like an operator: the image’s bootstrap SQL, control-store migrate, a keyring, one login per role. A stopped lab starts again; a lab whose image is older than the source refuses until --rebuild or --keep-image.',
    group: 'dev',
    flags: [
      LAB_FLAG,
      {
        name: 'image',
        type: 'string',
        placeholder: 'ref',
        description: 'Use this ExponetDB image instead of building one.',
      },
      {
        name: 'source',
        type: 'string',
        placeholder: 'dir',
        description:
          'The ExponetDB source checkout to build from (default: the one around the working directory).',
      },
      {
        name: 'postgres',
        type: 'enum',
        values: ['16', '17', '18'],
        description: 'PostgreSQL major of the targets (new lab only; default 17).',
      },
      {
        name: 'port',
        type: 'number',
        description: 'Loopback port of serve (new lab only; default 8480).',
      },
      {
        name: 'rebuild',
        type: 'boolean',
        description: 'Move an existing lab to an image of the current source.',
      },
      {
        name: 'keep-image',
        type: 'boolean',
        description: 'Start an existing lab with its image even though the source moved on.',
      },
    ],
    examples: [
      'exponetdb dev up',
      'exponetdb dev up --postgres 18 --lab pg18',
      'exponetdb dev up --image exponetdb:ci',
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabStatus',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      const existing = await readLab(env.paths)
      if (existing === undefined) {
        await createLab(env, {
          image: await imageChoice(ctx, input),
          postgres: Number(input.flags['postgres'] ?? 17) as Major,
          port: Number(input.flags['port'] ?? 8480),
        })
      } else {
        if (
          input.flags['postgres'] !== undefined &&
          Number(input.flags['postgres']) !== existing.postgres
        ) {
          throw new UsageError(
            `Lab ${env.labId} runs PostgreSQL ${existing.postgres}; reset or destroy it to change the major.`,
          )
        }
        const { stale } = await resumeLab(env, existing, {
          rebuild: input.flags['rebuild'] === true,
          keepImage: input.flags['keep-image'] === true,
        })
        if (stale !== null)
          ctx.hint(
            `Lab ${env.labId} keeps running ${stale.running}; the source is at ${stale.source}.`,
          )
      }
      const s = await labStatus(env)
      return statusResult('dev up', s, [
        `exponetdb profile add ${env.labId} --server ${s.server ?? ''}`,
        `exponetdb dev owner --lab ${env.labId} --email <you@example.test> --open`,
        `exponetdb login --profile ${env.labId}`,
        `exponetdb dev test smoke --lab ${env.labId}`,
      ])
    },
  },
  {
    path: ['dev', 'status'],
    summary:
      'The lab’s roles and readiness, its image against the source, the active and the last run (exit 0 only when ready).',
    group: 'dev',
    flags: [LAB_FLAG],
    locality: 'local',
    effect: 'read',
    output: 'LabStatus',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      return statusResult('dev status', await labStatus(env))
    },
  },
  {
    path: ['dev', 'owner'],
    summary:
      'Issue the first-owner setup link of the lab into a new private file (or open it in the browser).',
    description:
      'Runs `bootstrap owner` of the lab’s image with the serve login. The link is a single-use secret valid 30 minutes: it is written to a new 0600 file in the lab’s state, never printed; --open hands it to the browser.',
    group: 'dev',
    flags: [
      LAB_FLAG,
      {
        name: 'email',
        type: 'string',
        placeholder: 'address',
        description: 'The owner’s email address.',
        required: true,
      },
      {
        name: 'display-name',
        type: 'string',
        placeholder: 'text',
        description: 'The owner’s display name.',
      },
      {
        name: 'reissue',
        type: 'boolean',
        description: 'Replace a pending setup link (the earlier one stops working).',
      },
      { name: 'open', type: 'boolean', description: 'Open the setup link in the browser.' },
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabOwnerLink',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const lab = await readLab(env.paths)
      if (lab === undefined)
        throw new CliError(
          'lab_not_found',
          `There is no lab ${env.labId}; run: exponetdb dev up --lab ${env.labId}`,
        )
      await runningContainer(env, 'serve')
      const email = flag(input, 'email') ?? ''
      if (!/^[^\s@]+@[^\s@]+$/.test(email))
        throw new UsageError('--email must be an email address.')
      const name = flag(input, 'display-name')
      const r = await env.docker.run([
        'run',
        '--rm',
        '--network',
        lab.network.name,
        '--env-file',
        join(env.paths.secrets, 'operator.env'),
        lab.image.id,
        'bootstrap',
        'owner',
        '--email',
        email,
        ...(name === undefined ? [] : ['--display-name', name]),
        ...(input.flags['reissue'] === true ? ['--reissue'] : []),
      ])
      if (r.code !== 0) {
        const refusal = /refused \(([a-z_]+)\)/.exec(`${r.stdout}${r.stderr}`)?.[1]
        throw new CliError(
          refusal === 'bootstrap_pending'
            ? 'bootstrap_pending'
            : refusal === 'bootstrap_closed'
              ? 'bootstrap_closed'
              : 'lab_failed',
          refusal === 'bootstrap_pending'
            ? 'A setup link is pending; pass --reissue to replace it.'
            : refusal === 'bootstrap_closed'
              ? 'The lab already has an owner; sign in with: exponetdb login'
              : 'bootstrap owner failed; see: exponetdb dev logs serve',
        )
      }
      const link = /"setupLink":\s*"([^"]+)"/.exec(r.stdout)?.[1]
      if (link === undefined || !link.startsWith(`http://localhost:${lab.port}/setup#token=`)) {
        throw new CliError('lab_failed', 'bootstrap owner printed no setup link for this lab.')
      }
      const file = join(env.paths.secrets, 'owner-setup-link')
      await rm(file, { force: true })
      await createNewPrivateFile(file, `${link}\n`)
      if (input.flags['open'] === true) ctx.io.openBrowser(link)
      return result({
        command: 'dev owner',
        data: { labId: env.labId, file, validMinutes: 30, opened: input.flags['open'] === true },
        blocks: [
          {
            kind: 'text',
            lines: [
              `The single-use setup link (30 minutes) is in ${file} (0600).`,
              input.flags['open'] === true
                ? 'It was opened in your browser: register a passkey, set a password and confirm an authenticator app.'
                : 'Open it in a browser on this machine; it is never printed.',
            ],
          },
        ],
        next: [`exponetdb login --server http://localhost:${lab.port}`],
      })
    },
  },
  {
    path: ['dev', 'mcp-client'],
    summary: 'Register the lab’s local MCP client (pending until the lab’s owner approves it).',
    description:
      'Registers one public MCP client with the lab through Dynamic Client Registration, as any MCP client would: no secret, PKCE, loopback redirect URIs on any port (Claude Code, Codex, VS Code, the MCP Inspector, the SDK harness). Like every client it is pending until an administrator approves exactly it in the Web App (Admin, Clients) with a passkey; nothing is pre-trusted. The client ID is kept in the lab’s state and printed; it is not a secret.',
    group: 'dev',
    flags: [LAB_FLAG],
    locality: 'local',
    effect: 'local',
    output: 'LabMcpClient',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const lab = await readLab(env.paths)
      if (lab === undefined)
        throw new CliError(
          'lab_not_found',
          `There is no lab ${env.labId}; run: exponetdb dev up --lab ${env.labId}`,
        )
      await runningContainer(env, 'serve')
      const server = `http://localhost:${lab.port}`
      const response = await env
        .fetch(`${server}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: LAB_MCP_CLIENT.name,
            software_id: 'exponetdb-lab',
            application_type: 'native',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            redirect_uris: [...LAB_MCP_CLIENT.redirectUris],
          }),
          signal: AbortSignal.timeout(10_000),
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'TimeoutError')
            throw new CliError(
              'lab_failed',
              'The lab did not answer the registration within 10 seconds; see: exponetdb dev logs serve',
            )
          throw error
        })
      const body = (await response.json().catch(() => ({}))) as { client_id?: unknown }
      if (response.status !== 201 || typeof body.client_id !== 'string')
        throw new CliError(
          'lab_failed',
          `The lab refused the registration (HTTP ${response.status}); see: exponetdb dev logs serve`,
        )
      const clientId = body.client_id
      const file = join(env.paths.root, 'mcp-client.json')
      await writePrivateJson(file, {
        clientId,
        server,
        registeredAt: new Date(env.now()).toISOString(),
      })
      const mcp = `${server}/mcp`
      return result({
        command: 'dev mcp-client',
        data: {
          labId: env.labId,
          clientId,
          state: 'pending',
          mcpUrl: mcp,
          approveAt: `${server}/admin/clients`,
          redirectUris: [...LAB_MCP_CLIENT.redirectUris],
        },
        blocks: [
          {
            kind: 'text',
            lines: [
              `Registered ${LAB_MCP_CLIENT.name}: ${clientId} (pending).`,
              `Approve exactly this client as the lab’s owner: ${server}/admin/clients (a passkey confirms it).`,
              `Then connect a client to ${mcp}, for example:`,
              `  claude mcp add --transport http --client-id ${clientId} --callback-port 8080 exponetdb-lab ${mcp}`,
            ],
          },
        ],
        next: [`exponetdb dev status --lab ${env.labId}`],
      })
    },
  },
  {
    path: ['dev', 'logs'],
    summary: 'A role’s container log, or a test run’s own log.',
    group: 'dev',
    args: [{ name: 'role', description: `One of ${ROLES.join(', ')} (or --run).` }],
    flags: [
      LAB_FLAG,
      {
        name: 'run',
        type: 'string',
        placeholder: 'run_…',
        description: 'Show the log of this test run instead.',
      },
      {
        name: 'follow',
        type: 'boolean',
        short: 'f',
        description: 'Keep printing new lines (role logs, table output).',
      },
      { name: 'tail', type: 'number', description: 'Only the last lines.' },
      {
        name: 'since',
        type: 'string',
        placeholder: 'time',
        description: 'Only lines since this time (e.g. 10m, 2026-10-12T10:00:00Z).',
      },
    ],
    locality: 'local',
    effect: 'read',
    output: 'LabLog',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const runId = flag(input, 'run')
      if (runId !== undefined) {
        if (!/^run_[0-9A-Z]{26}$/.test(runId)) throw new UsageError('--run takes a run id (run_…).')
        const run = await readRun(env.paths, runId)
        if (run === undefined)
          throw new CliError('NOT_FOUND', `Lab ${env.labId} has no run ${runId}.`)
        const text = await readFile(join(runDir(env.paths, runId), run.log), 'utf8')
        return result({
          command: 'dev logs',
          data: { run, log: text },
          blocks: [{ kind: 'text', lines: lines(text) }],
        })
      }
      const roleArg = input.args['role']
      if (typeof roleArg !== 'string') throw new UsageError('Name a role or --run.')
      const role = databaseOf(roleArg)
      const id = await runningContainer(env, role).catch(async (error: unknown) => {
        const lab = await readLab(env.paths)
        const recorded = lab?.containers[role]
        if (recorded === undefined) throw error
        return recorded
      })
      const opts = [
        ...(typeof input.flags['tail'] === 'number' ? ['--tail', String(input.flags['tail'])] : []),
        ...(flag(input, 'since') === undefined ? [] : ['--since', flag(input, 'since') ?? '']),
      ]
      if (input.flags['follow'] === true) {
        if (ctx.format !== 'table')
          throw new UsageError('--follow prints to the terminal; leave out --json.')
        const code = await env.docker.attach(['logs', '--follow', ...opts, id])
        return result({
          command: 'dev logs',
          status: code === 0 ? 'ok' : 'failed',
          exitCode: code === 0 ? 0 : EXIT.failure,
          blocks: [],
        })
      }
      const r = await env.docker.run(['logs', ...opts, id])
      const text = `${r.stdout}${r.stderr}`
      return result({
        command: 'dev logs',
        data: { role, log: text },
        blocks: [{ kind: 'text', lines: lines(text) }],
      })
    },
  },
  {
    path: ['dev', 'shell'],
    summary: 'A shell in one of the lab’s containers (a terminal is needed).',
    group: 'dev',
    args: [{ name: 'role', description: `One of ${ROLES.join(', ')}.`, required: true }],
    flags: [LAB_FLAG],
    locality: 'local',
    effect: 'local',
    output: 'none',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      if (!ctx.io.tty.stdin || !ctx.io.tty.stdout || ctx.format !== 'table') {
        throw new UsageError('dev shell needs a terminal (and no --json).')
      }
      const env = labEnv(ctx, input)
      const role = databaseOf(arg(input, 'role'))
      const id = await runningContainer(env, role)
      const user = (DATABASE_ROLES as readonly string[]).includes(role)
        ? ['--user', 'postgres']
        : []
      const code = await env.docker.attach(['exec', '--interactive', '--tty', ...user, id, 'sh'])
      return result({
        command: 'dev shell',
        status: code === 0 ? 'ok' : 'failed',
        exitCode: code === 0 ? 0 : EXIT.failure,
        blocks: [],
      })
    },
  },
  {
    path: ['dev', 'sql'],
    summary:
      'psql in one of the lab’s own databases (control, staging, production), as its local superuser.',
    description:
      'For the lab only: e.g. to apply the roles script a cluster registration generates, or to look at a test database. Interactive on a terminal; otherwise the SQL comes from --file or stdin. Never reaches a registered target or a server.',
    group: 'dev',
    args: [{ name: 'database', description: 'control, staging or production.', required: true }],
    flags: [
      LAB_FLAG,
      {
        name: 'file',
        type: 'string',
        placeholder: 'path',
        description: 'Run this SQL file (ON_ERROR_STOP).',
      },
      {
        name: 'db',
        type: 'string',
        placeholder: 'name',
        description: 'The database inside (default exponetdb_control or postgres).',
      },
    ],
    examples: ['exponetdb dev sql staging --file roles.sql', 'exponetdb dev sql control'],
    locality: 'local',
    effect: 'local',
    output: 'LabSql',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const which = arg(input, 'database')
      if (!(DATABASE_ROLES as readonly string[]).includes(which)) {
        throw new UsageError('The database is control, staging or production.')
      }
      const role = which as Role
      const db = flag(input, 'db') ?? (role === 'control' ? 'exponetdb_control' : 'postgres')
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db))
        throw new UsageError('--db takes a plain database name.')
      const id = await runningContainer(env, role)
      const psql = ['psql', '-v', 'ON_ERROR_STOP=1', '-d', db]
      const file = flag(input, 'file')
      let sql: string | undefined
      if (file !== undefined) {
        const path = resolve(ctx.io.cwd, file)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || !info.isFile()) throw new UsageError(`${path} is not a file.`)
        if (info.size > 16 * 1024 * 1024) throw new UsageError(`${path} is larger than 16 MiB.`)
        sql = await readFile(path, 'utf8')
      } else if (!ctx.io.tty.stdin) {
        sql = await ctx.io.readStdin(16 * 1024 * 1024)
      }
      if (sql === undefined) {
        if (ctx.format !== 'table')
          throw new UsageError(
            'An interactive psql needs a terminal; leave out --json or pass --file.',
          )
        const code = await env.docker.attach([
          'exec',
          '--interactive',
          '--tty',
          '--user',
          'postgres',
          id,
          ...psql,
        ])
        return result({
          command: 'dev sql',
          status: code === 0 ? 'ok' : 'failed',
          exitCode: code === 0 ? 0 : EXIT.failure,
          blocks: [],
        })
      }
      const r = await env.docker.run(
        ['exec', '--interactive', '--user', 'postgres', id, ...psql, '-q'],
        { input: sql },
      )
      const output = r.stdout
      return result({
        command: 'dev sql',
        status: r.code === 0 ? 'ok' : 'failed',
        exitCode: r.code === 0 ? 0 : EXIT.failure,
        data: { database: role, db, exitCode: r.code, output, errors: r.stderr },
        blocks: [
          { kind: 'text', lines: lines(output) },
          ...(r.stderr === ''
            ? []
            : [{ kind: 'text' as const, lines: lines(r.stderr), tone: 'warn' as const }]),
        ],
        ...(r.code === 0
          ? {}
          : {
              error: {
                code: 'sql_failed',
                message: (r.stderr.trim().split('\n')[0] ?? 'psql failed').slice(0, 300),
              },
            }),
      })
    },
  },
  {
    path: ['dev', 'test'],
    summary:
      'Run a suite with its own run record and log: smoke (the lab), unit, integration, install, host:<scenario>.',
    description:
      'smoke checks the running lab (every role, TLS on the targets, the server surface, no secret in a log). The other suites run the repository’s own entrypoints from the source checkout, like CI. One run holds the lab at a time; a missing environment ends lab_unavailable (exit 5), a failing suite failed (exit 1, its real exit code in the record).',
    group: 'dev',
    args: [{ name: 'suite', description: SUITES.join(', '), required: true }],
    flags: [
      LAB_FLAG,
      {
        name: 'source',
        type: 'string',
        placeholder: 'dir',
        description:
          'The source checkout (default: the lab’s, or the one around the working directory).',
      },
    ],
    examples: [
      'exponetdb dev test smoke',
      'exponetdb dev test unit',
      'sudo -E exponetdb dev test host:config',
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabRun',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const suite = arg(input, 'suite')
      if (suite === 'smoke') await checkDocker(env.docker)
      const source = flag(input, 'source')
      const sourceDir =
        source !== undefined
          ? resolve(ctx.io.cwd, source)
          : suite === 'smoke'
            ? undefined
            : await findSource(ctx.io.cwd)
      const { run, checks } = await testLab(env, suite, {
        sourceDir,
        processEnv: ctx.io.env,
        echo:
          ctx.format === 'table' && !ctx.global.quiet ? (text) => ctx.io.stderr(text) : undefined,
        signal: ctx.io.signal,
      })
      const exitCode =
        run.state === 'passed'
          ? EXIT.ok
          : run.state === 'lab_unavailable'
            ? EXIT.unavailable
            : run.state === 'interrupted'
              ? EXIT.interrupted
              : EXIT.failure
      return result({
        command: 'dev test',
        status: run.state === 'passed' ? 'ok' : 'failed',
        exitCode,
        data: { run, checks },
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Run', run.runId],
              ['Suite', run.suite],
              ['Outcome', run.state],
              ['Exit code', run.exitCode === null ? null : String(run.exitCode)],
              ['Reason', run.reason ?? '-'],
              ['Source', run.source?.commit ?? 'none (the lab’s image)'],
              ['Log', join(runDir(env.paths, run.runId), run.log)],
            ],
          },
        ],
        ...(run.state === 'passed'
          ? {}
          : {
              error: {
                code:
                  run.state === 'lab_unavailable'
                    ? 'lab_unavailable'
                    : run.state === 'interrupted'
                      ? 'interrupted'
                      : 'tests_failed',
                message: run.reason ?? run.state,
              },
            }),
        next: [`exponetdb dev logs --run ${run.runId} --lab ${env.labId}`],
      })
    },
  },
  {
    path: ['dev', 'runs'],
    summary: 'The lab’s test runs, newest first, each with its own outcome.',
    group: 'dev',
    flags: [LAB_FLAG],
    locality: 'local',
    effect: 'read',
    output: 'LabRunList',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      const runs = await listRuns(env.paths)
      return result({
        command: 'dev runs',
        items: runs,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'RUN' },
              { title: 'SUITE' },
              { title: 'STATE' },
              { title: 'EXIT' },
              { title: 'STARTED' },
              { title: 'SOURCE', flexible: true },
            ],
            rows: runs.map((r) => [
              r.runId,
              r.suite,
              r.state,
              r.exitCode === null ? '-' : String(r.exitCode),
              r.startedAt,
              r.source?.commit ?? '-',
            ]),
            empty: 'No runs yet.',
          },
        ],
      })
    },
  },
  {
    path: ['dev', 'export'],
    summary:
      'Write the lab’s logs, container facts (no environment) and run records into a new directory.',
    group: 'dev',
    flags: [
      LAB_FLAG,
      {
        name: 'output',
        type: 'string',
        placeholder: 'dir',
        description: 'A new directory (default below the CLI’s lab-exports).',
      },
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabExport',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      const lab = await readLab(env.paths)
      const out = flag(input, 'output')
      const dir = await exportLab(
        env,
        lab,
        out === undefined ? undefined : resolve(ctx.io.cwd, out),
      )
      return result({
        command: 'dev export',
        data: { labId: env.labId, directory: dir },
        blocks: [{ kind: 'text', lines: [`Exported lab ${env.labId} to ${dir}`] }],
      })
    },
  },
  {
    path: ['dev', 'stop'],
    summary: 'Stop the lab’s containers; volumes, secrets and runs stay (dev up starts it again).',
    group: 'dev',
    flags: [LAB_FLAG, INTERRUPT_FLAG],
    locality: 'local',
    effect: 'local',
    output: 'LabStatus',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      const lab = await readLab(env.paths)
      if (lab === undefined) throw new CliError('lab_not_found', `There is no lab ${env.labId}.`)
      const interrupted = await quiesce(env, input.flags['interrupt'] === true)
      await stopLab(env, lab)
      const s = await labStatus(env)
      return result({
        command: 'dev stop',
        data: { ...s, interruptedRun: interrupted },
        blocks: [
          {
            kind: 'text',
            lines: [
              `Lab ${env.labId} is stopped; its data stays. Start it with: exponetdb dev up --lab ${env.labId}`,
            ],
          },
        ],
      })
    },
  },
  {
    path: ['dev', 'reset'],
    summary:
      'Export, then replace the lab’s databases and containers with new ones (same lab ID, image and port).',
    group: 'dev',
    flags: [
      LAB_FLAG,
      INTERRUPT_FLAG,
      { name: 'yes', type: 'boolean', description: 'Confirm deleting the lab’s databases.' },
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabStatus',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      const lab = await readLab(env.paths)
      if (lab === undefined) throw new CliError('lab_not_found', `There is no lab ${env.labId}.`)
      await confirmDestructive(
        ctx,
        `Delete the databases and containers of lab ${env.labId}?`,
        input,
      )
      await quiesce(env, input.flags['interrupt'] === true)
      const exported = await exportLab(env, lab)
      env.progress(`exported to ${exported}`)
      await removeLab(env, lab, true)
      await createLab(env, {
        image:
          lab.source === null
            ? { kind: 'image', ref: lab.image.ref }
            : { kind: 'source', dir: lab.source.dir },
        postgres: lab.postgres,
        port: lab.port,
      })
      return statusResult('dev reset', await labStatus(env))
    },
  },
  {
    path: ['dev', 'destroy'],
    summary:
      'Export, then remove every container, volume and the network of the lab, and its state.',
    group: 'dev',
    flags: [
      LAB_FLAG,
      INTERRUPT_FLAG,
      { name: 'yes', type: 'boolean', description: 'Confirm removing the lab.' },
    ],
    locality: 'local',
    effect: 'local',
    output: 'LabExport',
    platforms: [...PLATFORMS],
    async run(ctx, input) {
      const env = labEnv(ctx, input)
      await checkDocker(env.docker)
      const lab = await readLab(env.paths)
      if (lab === undefined) throw new CliError('lab_not_found', `There is no lab ${env.labId}.`)
      await confirmDestructive(ctx, `Remove lab ${env.labId} with its databases?`, input)
      await quiesce(env, input.flags['interrupt'] === true)
      const exported = await exportLab(env, lab)
      await removeLab(env, lab, false)
      return result({
        command: 'dev destroy',
        data: { labId: env.labId, export: exported, image: lab.image.ref },
        blocks: [
          {
            kind: 'text',
            lines: [
              `Lab ${env.labId} is removed; its export is ${exported}.`,
              `The image ${lab.image.ref} stays (docker image rm to remove it).`,
            ],
          },
        ],
      })
    },
  },
]
