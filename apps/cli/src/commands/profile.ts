import { isAbsolute, resolve } from 'node:path'
import { UsageError } from '../cli/args.ts'
import { EXIT } from '../cli/exit.ts'
import { type Profile, type ProfileAuth, validProfileName } from '../cli/profiles.ts'
import type { CommandSpec } from '../cli/spec.ts'
import { parseServer } from '../oauth.ts'
import { result } from '../output/model.ts'

/**
 * Profiles and configuration ([`15-cli/README.md` §3](../../../../exponetdb-docs/15-cli/README.md#3-profiles-context-and-precedence)).
 * Everything here is local: a profile is written without contacting the
 * server; the first remote command records the installation id it sees.
 */
function authRows(auth: ProfileAuth): [string, string][] {
  if (auth.method === 'oauth') return [['Auth', 'oauth (exponetdb login)']]
  if (auth.method === 'api-key')
    return [
      ['Auth', 'api-key'],
      ['Key file', auth.keyFile],
    ]
  return [
    ['Auth', 'service-account'],
    ['Client', auth.clientId],
    ['Key id', auth.keyId],
    ['Key file', auth.keyFile],
    ['Scopes', auth.scopes.join(' ')],
  ]
}

function view(p: Profile, current: boolean) {
  const { auth } = p
  return {
    name: p.name,
    current,
    server: p.server,
    installationId: p.installationId,
    auth:
      auth.method === 'oauth'
        ? { method: auth.method }
        : auth.method === 'api-key'
          ? { method: auth.method, keyFile: auth.keyFile }
          : {
              method: auth.method,
              clientId: auth.clientId,
              keyId: auth.keyId,
              keyFile: auth.keyFile,
              scopes: auth.scopes,
            },
    defaults: p.defaults,
  }
}

const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path))

export const profileCommands: readonly CommandSpec[] = [
  {
    path: ['profile', 'list'],
    summary: 'List profiles (local).',
    group: 'config',
    locality: 'local',
    effect: 'local',
    output: 'ProfileList',
    async run(ctx) {
      const file = await ctx.profiles.load()
      const items = Object.values(file.profiles).map((p) => view(p, p.name === file.current))
      return result({
        command: 'profile list',
        items,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: '' },
              { title: 'NAME' },
              { title: 'SERVER', flexible: true },
              { title: 'AUTH' },
              { title: 'INSTALLATION' },
            ],
            rows: items.map((p) => [
              p.current ? '*' : '',
              p.name,
              p.server,
              p.auth.method,
              p.installationId ?? 'not seen yet',
            ]),
            empty:
              'No profiles. Add one: exponetdb profile add local --server https://db.example.com',
          },
        ],
      })
    },
  },
  {
    path: ['profile', 'show'],
    summary: 'Show a profile (default: the current one).',
    group: 'config',
    args: [{ name: 'name', description: 'The profile.' }],
    locality: 'local',
    effect: 'local',
    output: 'Profile',
    async run(ctx, input) {
      const file = await ctx.profiles.load()
      const name =
        (input.args['name'] as string | undefined) ??
        ctx.global.profile ??
        file.current ??
        undefined
      const p = name === undefined ? undefined : file.profiles[name]
      if (p === undefined) {
        return result({
          command: 'profile show',
          status: 'error',
          exitCode: EXIT.usage,
          error: {
            code: 'usage',
            message: name === undefined ? 'No profile is current.' : `There is no profile ${name}.`,
          },
          next: ['exponetdb profile list'],
        })
      }
      return result({
        command: 'profile show',
        data: view(p, p.name === file.current),
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Profile', `${p.name}${p.name === file.current ? ' (current)' : ''}`],
              ['Server', p.server],
              ['Installation', p.installationId],
              ...authRows(p.auth),
              ['Output', p.defaults.output ?? 'table'],
              ['Target', p.defaults.target ?? '-'],
            ],
          },
        ],
      })
    },
  },
  {
    path: ['profile', 'add'],
    summary: 'Add or replace a profile (local; no token is stored in it).',
    description:
      'A profile binds a server origin, the installation seen there, how to authenticate and non-secret defaults. A service account or API key stays in its own private file (0600) that the profile names; the key is read when a command runs. --force replaces an existing profile and forgets the installation it recorded.',
    group: 'config',
    args: [{ name: 'name', description: 'Lowercase letters, digits and dashes.', required: true }],
    flags: [
      {
        name: 'server',
        type: 'string',
        placeholder: 'url',
        description: 'The server origin.',
        required: true,
      },
      {
        name: 'auth',
        type: 'enum',
        values: ['oauth', 'api-key', 'service-account'],
        description: 'How this profile authenticates.',
        default: 'oauth',
      },
      {
        name: 'key-file',
        type: 'string',
        placeholder: 'path',
        description: 'Private key or API key file (api-key, service-account).',
      },
      {
        name: 'client-id',
        type: 'string',
        placeholder: 'id',
        description: 'Service account client id.',
      },
      {
        name: 'key-id',
        type: 'string',
        placeholder: 'kid',
        description: 'Service account key id.',
      },
      { name: 'scopes', type: 'list', placeholder: 'a,b', description: 'Service account scopes.' },
      {
        name: 'default-output',
        type: 'enum',
        values: ['table', 'json', 'ndjson'],
        description: 'Default output format.',
      },
      {
        name: 'default-target',
        type: 'string',
        placeholder: 'tgt_…',
        description: 'Default target.',
      },
      { name: 'use', type: 'boolean', description: 'Make it the current profile.' },
      { name: 'force', type: 'boolean', description: 'Replace an existing profile of this name.' },
    ],
    locality: 'local',
    effect: 'local',
    output: 'Profile',
    examples: [
      'exponetdb profile add local --server https://db.example.com --use',
      'exponetdb profile add ci --server https://db.example.com --auth service-account --client-id exsc_… --key-id k1 --key-file ./ci.pem --scopes migrations.read,migrations.plan',
    ],
    async run(ctx, input) {
      // Global --server is parsed as a global flag; the command flag of the same name wins here.
      const name = String(input.args['name'])
      if (!validProfileName(name))
        throw new UsageError('A profile name is lowercase letters, digits and dashes (1 to 32).')
      const server = parseServer(String(input.flags['server'] ?? ctx.global.server ?? ''))
      const method = String(input.flags['auth'] ?? 'oauth')
      const keyFile =
        input.flags['key-file'] === undefined
          ? undefined
          : absolute(ctx.io.cwd, String(input.flags['key-file']))
      let auth: ProfileAuth
      if (method === 'oauth') {
        auth = { method: 'oauth' }
      } else if (method === 'api-key') {
        if (keyFile === undefined) throw new UsageError('--auth api-key needs --key-file.')
        auth = { method: 'api-key', keyFile }
      } else {
        const clientId = input.flags['client-id']
        const keyId = input.flags['key-id']
        if (keyFile === undefined || clientId === undefined || keyId === undefined) {
          throw new UsageError('--auth service-account needs --client-id, --key-id and --key-file.')
        }
        auth = {
          method: 'service-account',
          clientId: String(clientId),
          keyId: String(keyId),
          keyFile,
          scopes: (input.flags['scopes'] as readonly string[] | undefined) ?? [],
        }
      }
      const file = await ctx.profiles.load()
      if (name in file.profiles && input.flags['force'] !== true) {
        return result({
          command: 'profile add',
          status: 'error',
          exitCode: EXIT.usage,
          error: { code: 'usage', message: `The profile ${name} exists.` },
          next: [`exponetdb profile add ${name} --server ${server} --force`],
        })
      }
      const output = input.flags['default-output'] as Profile['defaults']['output']
      const target = input.flags['default-target'] as string | undefined
      const profile: Profile = {
        name,
        server,
        installationId: null,
        auth,
        defaults: {
          ...(output === undefined ? {} : { output }),
          ...(target === undefined ? {} : { target }),
        },
      }
      await ctx.profiles.put(profile, input.flags['use'] === true)
      const after = await ctx.profiles.load()
      return result({
        command: 'profile add',
        data: view(profile, after.current === name),
        blocks: [
          {
            kind: 'text',
            lines: [
              `Profile ${name} saved (${server}${after.current === name ? ', current' : ''}).`,
            ],
          },
        ],
        next:
          auth.method === 'oauth'
            ? [`exponetdb login --profile ${name}`]
            : [`exponetdb whoami --profile ${name}`],
      })
    },
  },
  {
    path: ['profile', 'use'],
    summary: 'Make a profile the current one.',
    group: 'config',
    args: [{ name: 'name', description: 'The profile.', required: true }],
    locality: 'local',
    effect: 'local',
    output: 'Profile',
    async run(ctx, input) {
      const name = String(input.args['name'])
      await ctx.profiles.use(name)
      return result({
        command: 'profile use',
        data: { current: name },
        blocks: [{ kind: 'text', lines: [`Current profile: ${name}.`] }],
      })
    },
  },
  {
    path: ['profile', 'remove'],
    summary: 'Remove a profile (its sign-in stays until exponetdb logout).',
    group: 'config',
    args: [{ name: 'name', description: 'The profile.', required: true }],
    locality: 'local',
    effect: 'local',
    output: 'Profile',
    async run(ctx, input) {
      const name = String(input.args['name'])
      const removed = await ctx.profiles.remove(name)
      if (!removed) {
        return result({
          command: 'profile remove',
          status: 'error',
          exitCode: EXIT.usage,
          error: { code: 'usage', message: `There is no profile ${name}.` },
        })
      }
      return result({
        command: 'profile remove',
        data: { removed: name },
        blocks: [{ kind: 'text', lines: [`Profile ${name} removed.`] }],
      })
    },
  },
  {
    path: ['config', 'path'],
    summary: 'Show where the CLI keeps its private files.',
    group: 'config',
    locality: 'local',
    effect: 'local',
    output: 'ConfigPaths',
    async run(ctx) {
      const data = {
        configDir: ctx.io.configDir,
        credentials: ctx.tokens.path,
        profiles: ctx.profiles.path,
      }
      return result({
        command: 'config path',
        data,
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Directory', data.configDir],
              ['Credentials', data.credentials],
              ['Profiles', data.profiles],
            ],
          },
        ],
      })
    },
  },
]
