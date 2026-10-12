import {
  isDeviceFlowScope,
  isScope,
  isScopeGrantableTo,
  SCOPE_IDS,
  SCOPES,
} from '@exponetdb/contracts'
import { UsageError } from '../cli/args.ts'
import { EXIT } from '../cli/exit.ts'
import { resolveServer } from '../cli/remote.ts'
import type { CommandSpec } from '../cli/spec.ts'
import { CliError } from '../errors.ts'
import { DEFAULT_SCOPES, deviceLogin, discover, logout, loopbackLogin } from '../oauth.ts'
import { result } from '../output/model.ts'

/**
 * Sign-in ([`05-mcp/oauth.md` §5](../../../../exponetdb-docs/05-mcp/oauth.md)):
 * the Wave 3B flows unchanged in their guarantees (loopback PKCE S256 with
 * state and issuer checks, the device flow, the private token store with
 * single refresh under its lock, revocation before the local copy goes).
 * Prompts go to stderr so stdout stays a result; a token, a code or a
 * verifier is never printed.
 */
function scopesFrom(raw: unknown): readonly string[] {
  if (raw === undefined) return DEFAULT_SCOPES
  const scopes = String(raw)
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
  for (const s of scopes) {
    if (!isScope(s)) throw new UsageError(`${s} is not a scope.`, 'exponetdb auth scopes')
    if (!isScopeGrantableTo(s, 'cli')) {
      throw new UsageError(`The CLI cannot hold ${s} (Web App only).`, 'exponetdb auth scopes')
    }
  }
  if (scopes.length === 0) throw new UsageError('--scope names at least one scope.')
  return [...new Set(scopes)]
}

const iso = (ms: number) => new Date(ms).toISOString()

export const authCommands: readonly CommandSpec[] = [
  {
    path: ['login'],
    aliases: [['auth', 'login']],
    summary: 'Sign in through the browser (or the device flow) and store the tokens privately.',
    description:
      'Opens the authorization page of the server (loopback redirect, PKCE S256). With --device the CLI shows a code to enter on another device; the device flow never carries a production or administrative scope. Production and administrative scopes need explicit consent in the browser.',
    group: 'auth',
    flags: [
      {
        name: 'scope',
        type: 'string',
        placeholder: 'scopes',
        description: 'Scopes to ask for, space or comma separated (default targets.read).',
      },
      {
        name: 'device',
        type: 'boolean',
        description: 'Use the device flow (a code to type elsewhere).',
      },
      {
        name: 'no-browser',
        type: 'boolean',
        description: 'Print the sign-in URL without opening a browser.',
      },
    ],
    locality: 'remote',
    effect: 'session',
    output: 'SignIn',
    examples: [
      'exponetdb login --server https://db.example.com',
      'exponetdb login --scope "targets.read migrations.plan migrations.apply:nonprod"',
      'exponetdb login --device',
    ],
    async run(ctx, input) {
      const scopes = scopesFrom(input.flags['scope'])
      const device = input.flags['device'] === true
      if (device) {
        const refused = scopes.filter((s) => isScope(s) && !isDeviceFlowScope(s))
        if (refused.length > 0) {
          throw new UsageError(
            `The device flow never carries ${refused.join(', ')}; sign in through the browser for it.`,
            'exponetdb login --scope "…"',
          )
        }
      }
      const { server: origin, profile } = await resolveServer(ctx)
      if (profile !== undefined && profile.auth.method !== 'oauth') {
        throw new CliError(
          'usage',
          `The profile ${profile.name} signs in with a ${profile.auth.method} key; no browser sign-in is needed.`,
        )
      }
      const server = await discover(ctx.io.fetch, origin)
      const browser = input.flags['no-browser'] !== true && !ctx.global.noInput
      const credentials = device
        ? await deviceLogin(ctx.io.fetch, server, {
            scopes,
            present: async (uri, code) => {
              ctx.io.stderr(`Open ${uri} in a browser and enter the code ${code}.\n`)
              ctx.io.stderr('Check that the code matches before you approve.\n')
            },
            sleep: (ms) => ctx.io.sleep(ms, ctx.io.signal),
          })
        : await loopbackLogin(ctx.io.fetch, server, {
            scopes,
            present: async (url) => {
              ctx.io.stderr(`Sign in at: ${url}\n`)
              if (browser) ctx.io.openBrowser(url)
            },
          })
      await ctx.tokens.withLock(() => ctx.tokens.write(credentials))
      return result({
        command: 'login',
        data: {
          server: server.origin,
          scope: credentials.scope,
          accessExpiresAt: iso(credentials.accessExpiresAt),
        },
        blocks: [
          { kind: 'text', lines: [`Signed in to ${server.origin} (scope: ${credentials.scope}).`] },
        ],
      })
    },
  },
  {
    path: ['logout'],
    aliases: [['auth', 'logout']],
    summary: 'Revoke the grant on the server, then delete the local tokens.',
    group: 'auth',
    locality: 'remote',
    effect: 'session',
    output: 'SignOut',
    examples: ['exponetdb logout'],
    async run(ctx) {
      const { server: origin } = await resolveServer(ctx)
      const server = await discover(ctx.io.fetch, origin)
      const { revoked } = await logout(ctx.io.fetch, ctx.tokens, server)
      if (!revoked) {
        return result({
          command: 'logout',
          status: 'failed',
          exitCode: EXIT.failure,
          data: { server: origin, revoked: false, localCopyDeleted: true },
          error: {
            code: 'revocation_unconfirmed',
            message:
              'Signed out locally. The server did not confirm the revocation; revoke the grant in the Web App under Connected applications.',
          },
        })
      }
      return result({
        command: 'logout',
        data: { server: origin, revoked: true, localCopyDeleted: true },
        blocks: [{ kind: 'text', lines: [`Signed out of ${origin}; the grant is revoked.`] }],
      })
    },
  },
  {
    path: ['whoami'],
    aliases: [['auth', 'whoami']],
    summary: 'Show the server, its version and the sign-in in use (one authenticated request).',
    group: 'auth',
    locality: 'remote',
    effect: 'read',
    action: 'installation.get',
    scopes: ['targets.read'],
    output: 'WhoAmI',
    examples: ['exponetdb whoami', 'exponetdb whoami --json'],
    async run(ctx) {
      // Connecting reads the installation with the credentials: that request is the check.
      const remote = await ctx.remote()
      const method = remote.profile?.auth.method ?? 'oauth'
      const stored = method === 'oauth' ? await ctx.tokens.read(remote.server) : undefined
      const data = {
        server: remote.server,
        version: remote.installation.version,
        ...(remote.installationId === undefined ? {} : { installationId: remote.installationId }),
        ...(remote.profile === undefined ? {} : { profile: remote.profile.name }),
        auth: method,
        ...(stored === undefined
          ? {}
          : { scope: stored.scope, accessExpiresAt: iso(stored.accessExpiresAt) }),
      }
      const rows: [string, string | null][] = [
        ['Server', remote.server],
        ['Version', remote.installation.version],
        ...(remote.profile === undefined
          ? []
          : [['Profile', remote.profile.name] as [string, string]]),
        ['Auth', method],
      ]
      if (stored !== undefined) {
        rows.push(
          ['Scope', stored.scope],
          ['Token', `valid until ${iso(stored.accessExpiresAt)} (refreshed as needed)`],
        )
      }
      return result({ command: 'whoami', data, blocks: [{ kind: 'fields', rows }] })
    },
  },
  {
    path: ['auth', 'status'],
    summary: 'List the servers this CLI holds a sign-in for (local; no network, no token shown).',
    group: 'auth',
    locality: 'local',
    effect: 'local',
    output: 'AuthStatus',
    async run(ctx) {
      const servers = await ctx.tokens.servers()
      const now = ctx.io.now()
      const items = []
      for (const server of servers) {
        const c = await ctx.tokens.read(server)
        if (c === undefined) continue
        items.push({
          server,
          scope: c.scope,
          accessExpiresAt: iso(c.accessExpiresAt),
          state:
            c.accessExpiresAt > now
              ? 'signed_in'
              : c.refreshToken === null
                ? 'expired'
                : 'refreshable',
          signedInAt: iso(c.obtainedAt),
        })
      }
      return result({
        command: 'auth status',
        items,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'SERVER' },
              { title: 'STATE' },
              { title: 'ACCESS UNTIL' },
              { title: 'SCOPE', flexible: true },
            ],
            rows: items.map((i) => [i.server, i.state, i.accessExpiresAt, i.scope]),
            empty: 'Not signed in anywhere. Run: exponetdb login --server <url>',
          },
        ],
      })
    },
  },
  {
    path: ['auth', 'scopes'],
    summary: 'List the OAuth scopes the CLI can ask for, and which need the browser.',
    description:
      "From the contracts of this CLI version. A scope is an upper bound: the server still checks the person's permissions, the target's tier and policy on every request.",
    group: 'auth',
    locality: 'local',
    effect: 'local',
    output: 'ScopeList',
    async run() {
      const items = SCOPE_IDS.filter((s) => isScopeGrantableTo(s, 'cli')).map((s) => ({
        scope: s,
        tier: SCOPES[s].tier,
        humanOnly: SCOPES[s].humanOnly,
        explicitConsent: SCOPES[s].explicitConsent,
        deviceFlow: isDeviceFlowScope(s),
      }))
      return result({
        command: 'auth scopes',
        items,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'SCOPE' },
              { title: 'TIER' },
              { title: 'CONSENT' },
              { title: 'DEVICE FLOW' },
            ],
            rows: items.map((i) => [
              i.scope,
              i.tier ?? '-',
              i.explicitConsent ? 'explicit (browser)' : 'standard',
              i.deviceFlow ? 'yes' : 'no',
            ]),
          },
        ],
      })
    },
  },
]
