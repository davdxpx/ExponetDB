import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import { EXIT } from '../cli/exit.ts'
import { flag } from '../cli/reads.ts'
import { agentHelp } from '../cli/reference.ts'
import { must, resolveServer } from '../cli/remote.ts'
import { stepUpHeader } from '../cli/stepup.ts'
import type { CommandSpec, RunContext } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { CliError } from '../errors.ts'
import { createNewPrivateFile, writePrivateJson } from '../files.ts'
import { loadGrammar, MAJORS } from '../local/grammar.ts'
import {
  bundleRoots,
  currentProject,
  findProjectFile,
  LINK_DIR,
  LINK_FILE,
  PROJECT_FILE,
  readBundles,
  readLink,
  readProject,
} from '../local/project.ts'
import { discover } from '../oauth.ts'
import { header } from '../output/format.ts'
import { type Block, result } from '../output/model.ts'
import { scopeHint, scopeList, scopeReport } from '../presets.ts'
import { BUILD } from '../version.ts'

/**
 * Local tools: the project file and its link to a server, profile
 * defaults, the step-up on request, `doctor`, the agent help and the one
 * deliberate local secret utility (a SCRAM verifier).
 */
const workdir = (ctx: RunContext) => ctx.global.workdir ?? ctx.io.cwd

function template(project: string): string {
  return [
    'schema: exponetdb.project/v1',
    `project: ${project}`,
    'layout: bundles',
    'defaults:',
    '  lockTimeout: 5s',
    '  statementTimeout: 15m',
    '  role: migrator',
    '  searchPath: [public]',
    'executionRoles:',
    '  migrator: app_migrator',
    'managedScope:',
    '  includeSchemas: [public]',
    '  excludeSchemas: []',
    'lintProfile: strict',
    'bundleRoots:',
    '  - migrations',
    '',
  ].join('\n')
}

type Check = {
  readonly check: string
  readonly status: 'ok' | 'warn' | 'fail' | 'skip'
  readonly detail: string
}

async function doctorChecks(ctx: RunContext, includeParser: boolean): Promise<Check[]> {
  const checks: Check[] = []
  const add = (check: string, status: Check['status'], detail: string) =>
    checks.push({ check, status, detail })
  const major = Number(process.versions.node.split('.')[0])
  // The supported runtime is Node 24 (the package's engines); 22 and 23
  // still run the CLI and are reported, anything older is refused.
  add(
    'cli',
    major >= 24 ? 'ok' : major >= 22 ? 'warn' : 'fail',
    `exponetdb ${BUILD.version} (${BUILD.commit}) on Node ${process.versions.node}${major >= 24 ? '' : ': the supported runtime is Node 24'}`,
  )
  const dir = await stat(ctx.io.configDir).catch(() => undefined)
  if (dir === undefined)
    add(
      'config',
      'warn',
      `${ctx.io.configDir} does not exist yet (created at the first sign-in or profile)`,
    )
  else if (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)
    add('config', 'fail', `${ctx.io.configDir} is readable by others; make it 0700`)
  else add('config', 'ok', `${ctx.io.configDir} is private`)
  let servers: string[] = []
  try {
    servers = await ctx.tokens.servers()
    add(
      'token store',
      'ok',
      `${servers.length} sign-in${servers.length === 1 ? '' : 's'} stored (no token shown)`,
    )
  } catch (error) {
    add(
      'token store',
      'fail',
      error instanceof CliError ? error.message : 'The token store cannot be read.',
    )
  }
  try {
    const file = await ctx.profiles.load()
    add(
      'profiles',
      'ok',
      `${Object.keys(file.profiles).length} profile(s); current: ${file.current ?? 'none'}`,
    )
  } catch (error) {
    add(
      'profiles',
      'fail',
      error instanceof CliError ? error.message : 'The profiles file cannot be read.',
    )
  }
  let server: string | undefined
  try {
    const resolved = await resolveServer(ctx)
    server = resolved.server
    add(
      'server',
      'ok',
      `${server}${resolved.profile === undefined ? '' : ` (profile ${resolved.profile.name})`}`,
    )
  } catch (error) {
    add('server', 'skip', error instanceof Error ? error.message : 'No server named.')
  }
  if (server !== undefined) {
    try {
      const ready = await ctx.io.fetch(`${server}/healthz/ready`, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      add(
        'readiness',
        ready.status === 200 ? 'ok' : 'warn',
        `the server answers ${ready.status} at /healthz/ready`,
      )
    } catch {
      add('readiness', 'fail', `${server} cannot be reached`)
    }
    try {
      await discover(ctx.io.fetch, server)
      add('oauth', 'ok', 'the authorization server metadata names this origin')
    } catch (error) {
      add(
        'oauth',
        'fail',
        error instanceof CliError ? error.message : 'The OAuth metadata cannot be read.',
      )
    }
    try {
      const remote = await ctx.remote()
      add(
        'sign-in',
        'ok',
        `authenticated; installation ${remote.installationId ?? 'unknown'}, server ${remote.installation.version}, REST v1`,
      )
      const stored = await ctx.tokens.read(server)
      if (stored !== undefined) {
        const auth = remote.profile?.auth
        const report = scopeReport(
          scopeList(stored.scope),
          auth?.method === 'oauth' ? auth.requestedScopes : undefined,
        )
        const covered = report.presets.filter((p) => p.covered).map((p) => p.preset)
        add(
          'scopes',
          'ok',
          `${stored.scope}; presets covered: ${covered.length === 0 ? 'none' : covered.join(', ')}`,
        )
        if (report.notGranted !== null && report.notGranted.length > 0) {
          add(
            'scopes not granted',
            'warn',
            `${report.notGranted.join(' ')} (asked for at the last sign-in; the account does not hold them or they were not ticked)`,
          )
        }
        const next = report.presets.find((p) => !p.covered && !p.preset.endsWith(':prod'))
        if (next !== undefined) {
          // A sign-in replaces the grant: the suggestion keeps what is held.
          const login = scopeHint(report.granted, next.missing, ` --server ${server}`)
          add(
            'more scopes',
            'skip',
            `${next.preset} adds ${next.missing.join(' ')}: ${login.at(-1)} (the consent page shows what the account holds)`,
          )
        }
      }
    } catch (error) {
      const code =
        error instanceof CliError
          ? error.code
          : error instanceof Error && 'error' in error
            ? String((error as { error: { code: string } }).error.code)
            : 'unknown'
      add(
        'sign-in',
        code === 'installation_changed' ? 'fail' : 'warn',
        error instanceof Error ? `${code}: ${error.message}` : code,
      )
    }
  }
  const projectFile = await findProjectFile(workdir(ctx)).catch(() => undefined)
  if (projectFile === undefined) {
    add('project', 'skip', `no ${PROJECT_FILE} in ${resolve(workdir(ctx))} or above`)
  } else {
    try {
      const project = await readProject(projectFile)
      add('project', 'ok', `${project.config.project} (${projectFile})`)
      const roots = bundleRoots(project)
      const bundles = await readBundles(project)
      add('bundle roots', 'ok', `${roots.length} root(s), ${bundles.length} bundle(s)`)
      const link = await readLink(project.root).catch(() => undefined)
      add(
        'link',
        link === undefined ? 'skip' : 'ok',
        link === undefined
          ? 'not linked (exponetdb project link)'
          : `${link.server}${link.profile === null ? '' : ` (profile ${link.profile})`}`,
      )
    } catch (error) {
      add(
        'project',
        'fail',
        error instanceof Error ? error.message : 'The project file is not valid.',
      )
    }
  }
  if (includeParser) {
    for (const major of MAJORS) {
      try {
        await loadGrammar(major)
        add(`parser ${major}`, 'ok', `the PostgreSQL ${major} parser loads (local lint works)`)
      } catch {
        add(
          `parser ${major}`,
          'fail',
          `the PostgreSQL ${major} parser cannot be loaded; reinstall the CLI`,
        )
      }
    }
  }
  return checks
}

export const toolCommands: readonly CommandSpec[] = [
  {
    path: ['init'],
    summary: `Create ${PROJECT_FILE} and a migrations directory in the working directory (nothing is overwritten).`,
    group: 'project',
    flags: [
      {
        name: 'project',
        type: 'string',
        placeholder: 'product/project',
        description: 'The registry path of the project.',
        required: true,
      },
    ],
    locality: 'local',
    effect: 'local',
    output: 'ProjectInit',
    examples: ['exponetdb init --project demo/platform'],
    async run(ctx, input) {
      const project = String(input.flags['project'])
      if (!/^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/.test(project)) {
        throw new UsageError('--project is <product>/<project> in lowercase slugs.')
      }
      const root = resolve(workdir(ctx))
      const file = join(root, PROJECT_FILE)
      await writeFile(file, template(project), { flag: 'wx' }).catch(() => {
        throw new CliError('file_refused', `${file} already exists; nothing was overwritten.`)
      })
      await mkdir(join(root, 'migrations'), { recursive: true })
      await readProject(file)
      return result({
        command: 'init',
        data: { file, migrations: join(root, 'migrations') },
        blocks: [
          {
            kind: 'text',
            lines: [
              `Created ${file} and ${join(root, 'migrations')}. Edit the execution roles and managed scope to match the registry.`,
            ],
          },
        ],
        next: ['exponetdb project validate', 'exponetdb migration new <name>'],
      })
    },
  },
  {
    path: ['project', 'validate'],
    summary: 'Validate the project file and read every bundle root (local).',
    group: 'project',
    locality: 'local',
    effect: 'local',
    output: 'ProjectValidation',
    async run(ctx) {
      const project = await currentProject(workdir(ctx))
      const bundles = await readBundles(project)
      return result({
        command: 'project validate',
        data: {
          file: project.file,
          project: project.config.project,
          bundleRoots: bundleRoots(project),
          bundles: bundles.length,
        },
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Project file', project.file],
              ['Project', project.config.project],
              ['Layout', project.config.layout],
              ['Lint profile', project.config.lintProfile],
              ['Bundle roots', bundleRoots(project).join(', ')],
              ['Bundles', String(bundles.length)],
            ],
          },
        ],
        next: ['exponetdb migration lint'],
      })
    },
  },
  {
    path: ['project', 'link'],
    summary:
      'Link the project to the current server and profile, after checking the project exists there.',
    group: 'project',
    locality: 'remote',
    effect: 'local',
    action: 'project.list',
    scopes: ['targets.read'],
    output: 'ProjectLink',
    async run(ctx) {
      const project = await currentProject(workdir(ctx))
      const remote = await ctx.remote()
      const [product] = project.config.project.split('/')
      let found: { id: string; path: string } | undefined
      for await (const page of remote.sdk.pages('listProjects', undefined, { product } as never)) {
        found = must(page).items.find((p) => p.path === project.config.project)
        if (found !== undefined) break
      }
      if (found === undefined) {
        return result({
          command: 'project link',
          status: 'error',
          exitCode: EXIT.failure,
          error: {
            code: 'NOT_FOUND',
            message: `No project ${project.config.project} on ${remote.server} is visible to you.`,
          },
          next: [`exponetdb project create ${product ?? '<product>'} <slug> --name …`],
        })
      }
      const link = {
        server: remote.server,
        profile: remote.profile?.name ?? null,
        projectId: found.id,
        installationId: remote.installationId ?? null,
      }
      await writePrivateJson(join(project.root, LINK_DIR, LINK_FILE), link)
      return result({
        command: 'project link',
        data: link,
        blocks: [
          {
            kind: 'text',
            lines: [
              `Linked ${project.config.project} (${found.id}) to ${remote.server}. Add ${LINK_DIR}/ to .gitignore: the link is personal.`,
            ],
          },
        ],
      })
    },
  },
  {
    path: ['project', 'unlink'],
    summary: 'Remove the project’s link to a server (local).',
    group: 'project',
    locality: 'local',
    effect: 'local',
    output: 'ProjectLink',
    async run(ctx) {
      const project = await currentProject(workdir(ctx))
      const path = join(project.root, LINK_DIR, LINK_FILE)
      const existed = (await lstat(path).catch(() => undefined)) !== undefined
      await rm(path, { force: true })
      return result({
        command: 'project unlink',
        data: { unlinked: existed },
        blocks: [{ kind: 'text', lines: [existed ? 'Unlinked.' : 'The project was not linked.'] }],
      })
    },
  },
  {
    path: ['project', 'context'],
    summary:
      'Where every setting of this invocation comes from: server, profile, project, output (local).',
    aliases: [['context']],
    group: 'project',
    locality: 'local',
    effect: 'local',
    output: 'Context',
    async run(ctx) {
      const env = ctx.io.env
      const file = await ctx.profiles.load().catch(() => undefined)
      const profileName =
        ctx.global.profile ?? (env['EXPONETDB_PROFILE'] || undefined) ?? file?.current ?? undefined
      const profile = profileName === undefined ? undefined : file?.profiles[profileName]
      const projectFile = await findProjectFile(workdir(ctx)).catch(() => undefined)
      const project =
        projectFile === undefined
          ? undefined
          : await readProject(projectFile).catch(() => undefined)
      const link =
        project === undefined ? undefined : await readLink(project.root).catch(() => undefined)
      const server: readonly [string | null, string] =
        ctx.global.server !== undefined
          ? [ctx.global.server, '--server']
          : env['EXPONETDB_URL']
            ? [env['EXPONETDB_URL'] ?? null, 'EXPONETDB_URL']
            : profile !== undefined
              ? [profile.server, `profile ${profile.name}`]
              : link !== undefined
                ? [link.server, 'project link']
                : [null, 'none']
      const output: readonly [string, string] =
        ctx.global.output !== undefined
          ? [ctx.global.output, '--output']
          : env['EXPONETDB_OUTPUT']
            ? [env['EXPONETDB_OUTPUT'] ?? 'table', 'EXPONETDB_OUTPUT']
            : profile?.defaults.output !== undefined
              ? [profile.defaults.output, `profile ${profile.name}`]
              : ['table', 'default']
      const data = {
        server: { value: server[0], source: server[1] },
        profile: {
          value: profile?.name ?? null,
          source:
            ctx.global.profile !== undefined
              ? '--profile'
              : env['EXPONETDB_PROFILE']
                ? 'EXPONETDB_PROFILE'
                : profile !== undefined
                  ? 'current profile'
                  : 'none',
        },
        project: { value: project?.config.project ?? null, file: projectFile ?? null },
        target: {
          value: profile?.defaults.target ?? null,
          source: profile?.defaults.target === undefined ? 'none' : `profile ${profile.name}`,
        },
        output: { value: output[0], source: output[1] },
      }
      return result({
        command: 'project context',
        data,
        blocks: [
          {
            kind: 'table',
            columns: [{ title: 'SETTING' }, { title: 'VALUE', flexible: true }, { title: 'FROM' }],
            rows: [
              ['server', String(data.server.value ?? '-'), data.server.source],
              ['profile', String(data.profile.value ?? '-'), data.profile.source],
              [
                'project',
                String(data.project.value ?? '-'),
                data.project.file ?? 'no project file',
              ],
              ['target', String(data.target.value ?? '-'), data.target.source],
              ['output', String(data.output.value), data.output.source],
            ],
          },
        ],
      })
    },
  },
  {
    path: ['config', 'show'],
    summary: 'The current profile’s defaults and the CLI’s private paths (local).',
    group: 'config',
    locality: 'local',
    effect: 'local',
    output: 'Config',
    async run(ctx) {
      const file = await ctx.profiles.load()
      const name = ctx.global.profile ?? file.current
      const p = name === null || name === undefined ? undefined : file.profiles[name]
      return result({
        command: 'config show',
        data: {
          profile: p?.name ?? null,
          defaults: p?.defaults ?? {},
          configDir: ctx.io.configDir,
        },
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Profile', p?.name ?? null],
              ['Output', p?.defaults.output ?? 'table (default)'],
              ['Target', p?.defaults.target ?? '-'],
              ['Directory', ctx.io.configDir],
            ],
          },
        ],
      })
    },
  },
  ...(['set', 'unset'] as const).map(
    (verb): CommandSpec => ({
      path: ['config', verb],
      summary:
        verb === 'set'
          ? 'Set a default of the current profile (output or target).'
          : 'Remove a default of the current profile.',
      group: 'config',
      args: [
        { name: 'key', description: 'output or target.', required: true },
        ...(verb === 'set' ? [{ name: 'value', description: 'The value.', required: true }] : []),
      ],
      locality: 'local',
      effect: 'local',
      output: 'Config',
      async run(ctx, input) {
        const key = String(input.args['key'])
        if (key !== 'output' && key !== 'target')
          throw new UsageError('The key is output or target.')
        const file = await ctx.profiles.load()
        const name = ctx.global.profile ?? file.current
        const p = name === null || name === undefined ? undefined : file.profiles[name]
        if (p === undefined)
          throw new UsageError(
            'No profile is current.',
            'exponetdb profile add <name> --server <url> --use',
          )
        const value = String(input.args['value'] ?? '')
        if (verb === 'set' && key === 'output' && !['table', 'json', 'ndjson'].includes(value)) {
          throw new UsageError('output is table, json or ndjson.')
        }
        const { [key]: _old, ...rest } = p.defaults
        const defaults = verb === 'set' ? { ...rest, [key]: value } : rest
        await ctx.profiles.put({ ...p, defaults }, false)
        return result({
          command: `config ${verb}`,
          data: { profile: p.name, defaults },
          blocks: [
            {
              kind: 'text',
              lines: [
                `Profile ${p.name}: ${verb === 'set' ? `${key} = ${value}` : `${key} removed`}.`,
              ],
            },
          ],
        })
      },
    }),
  ),
  {
    path: ['auth', 'reauth'],
    summary:
      'Confirm a step-up in the browser now, for a plan to apply or an enrollment token to reveal.',
    description:
      'Prints the receipt id to pass as --step-up within 120 seconds. Usually not needed: plan apply and node enrollment create ask for the confirmation themselves.',
    group: 'auth',
    flags: [
      { name: 'plan', type: 'string', placeholder: 'pln_…', description: 'The plan to apply.' },
      {
        name: 'token',
        type: 'string',
        placeholder: 'ent_…',
        description: 'The enrollment token to reveal.',
      },
    ],
    locality: 'remote',
    effect: 'session',
    action: 'step_up.request',
    output: 'StepUp',
    async run(ctx, input) {
      const planId = flag(input, 'plan')
      const tokenId = flag(input, 'token')
      if ((planId === undefined) === (tokenId === undefined))
        throw new UsageError('Name exactly one of --plan and --token.')
      const remote = await ctx.remote()
      const id = await stepUpHeader(
        ctx,
        remote,
        planId !== undefined
          ? { action: 'plan.apply', planId }
          : { action: 'node.enrollment_token.reveal', tokenId: tokenId ?? '' },
      )
      return result({
        command: 'auth reauth',
        data: { stepUpId: id },
        blocks: [{ kind: 'text', lines: [`Confirmed: ${id} (valid for 120 seconds, once).`] }],
        next: planId === undefined ? [] : [`exponetdb plan apply ${planId} --step-up ${id}`],
      })
    },
  },
  {
    path: ['doctor'],
    summary:
      'Check the CLI, its private files, the server, the sign-in, the project and the parser (no changes).',
    group: 'general',
    flags: [
      { name: 'skip-parser', type: 'boolean', description: 'Do not load the PostgreSQL parser.' },
    ],
    locality: 'remote',
    effect: 'read',
    output: 'DoctorReport',
    async run(ctx, input) {
      const checks = await doctorChecks(ctx, input.flags['skip-parser'] !== true)
      const failed = checks.filter((c) => c.status === 'fail').length
      const blocks: Block[] = [
        header('doctor', {}),
        {
          kind: 'table',
          columns: [{ title: 'CHECK' }, { title: 'STATUS' }, { title: 'DETAIL', flexible: true }],
          rows: checks.map((c) => [c.check, c.status, c.detail]),
        },
        {
          kind: 'status',
          word: failed === 0 ? 'OK' : 'PROBLEMS',
          tone: failed === 0 ? 'ok' : 'error',
          text: `${failed} failed, ${checks.filter((c) => c.status === 'warn').length} warnings`,
        },
      ]
      return result({
        command: 'doctor',
        status: failed === 0 ? 'ok' : 'failed',
        exitCode: failed === 0 ? EXIT.ok : EXIT.failure,
        items: checks,
        ...(failed === 0
          ? {}
          : {
              error: {
                code: 'doctor_failed',
                message: `${failed} check${failed === 1 ? '' : 's'} failed.`,
              },
            }),
        blocks,
      })
    },
  },
  {
    path: ['agent-help'],
    summary:
      'How an automated agent uses the CLI safely, with the full command reference (Markdown).',
    group: 'general',
    locality: 'local',
    effect: 'local',
    output: 'AgentHelp',
    async run(ctx) {
      const text = agentHelp(ctx.commands)
      if (ctx.format === 'table') {
        ctx.io.stdout(`${text}\n`)
        return result({ command: 'agent-help' })
      }
      return result({ command: 'agent-help', data: { markdown: text } })
    },
  },
  {
    path: ['secrets', 'scram-verifier'],
    summary:
      'Turn a password into a PostgreSQL SCRAM-SHA-256 verifier, locally (the password never leaves this machine).',
    description:
      'Reads the password from the terminal without echo (twice), or from stdin with --stdin; never from an argument or the environment. Writes the verifier to a new 0600 file (--file), or to stdout only with the explicit --stdout. A verifier is sensitive: it allows an offline guessing attack on the password.',
    group: 'secrets',
    flags: [
      {
        name: 'file',
        type: 'string',
        placeholder: 'path',
        description: 'A new file for the verifier (0600).',
      },
      {
        name: 'stdout',
        type: 'boolean',
        description: 'Print the verifier to stdout instead (opt-in, for automation).',
      },
      { name: 'stdin', type: 'boolean', description: 'Read the password from stdin (one line).' },
      {
        name: 'iterations',
        type: 'number',
        description: 'PBKDF2 iterations (4096 to 1000000).',
        default: 4096,
      },
    ],
    locality: 'local',
    effect: 'local',
    output: 'ScramVerifier',
    async run(ctx, input) {
      const file = flag(input, 'file')
      const toStdout = input.flags['stdout'] === true
      if ((file === undefined) === !toStdout)
        throw new UsageError('Name exactly one output: --file <new file> or --stdout.')
      if (toStdout && ctx.format !== 'table')
        throw new UsageError('--stdout prints the verifier alone; JSON output never carries it.')
      let password: string
      if (input.flags['stdin'] === true) {
        password = (await ctx.io.readStdin(2048)).replace(/\r?\n$/, '')
      } else {
        if (ctx.global.noInput || !ctx.io.tty.stdin)
          throw new UsageError('Type the password on a terminal, or pass --stdin.')
        password = await ctx.io.readSecret('Password: ')
        const again = await ctx.io.readSecret('Again: ')
        if (again !== password) throw new UsageError('The two entries differ.')
      }
      let verifier: string
      try {
        verifier = scramSha256Verifier(password, {
          iterations: Number(input.flags['iterations'] ?? 4096),
        })
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : 'The password is not usable.')
      }
      password = ''
      if (toStdout) {
        ctx.io.stdout(`${verifier}\n`)
        return result({ command: 'secrets scram-verifier' })
      }
      const path = resolve(ctx.io.cwd, file ?? '')
      await createNewPrivateFile(path, `${verifier}\n`)
      return result({
        command: 'secrets scram-verifier',
        data: { file: path },
        blocks: [
          {
            kind: 'text',
            lines: [`Verifier written to ${path} (0600). The password itself was not stored.`],
          },
        ],
      })
    },
  },
]
