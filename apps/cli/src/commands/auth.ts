import {
  isDeviceFlowScope,
  isScope,
  isScopeGrantableTo,
  SCOPE_IDS,
  SCOPES,
} from '@exponetdb/contracts'
import { UsageError } from '../cli/args.ts'
import { EXIT } from '../cli/exit.ts'
import type { Profile } from '../cli/profiles.ts'
import { resolveServer } from '../cli/remote.ts'
import type { CommandInput, CommandSpec } from '../cli/spec.ts'
import type { RunContext } from '../cli/types.ts'
import { CliError } from '../errors.ts'
import { DEFAULT_SCOPES, deviceLogin, discover, logout, loopbackLogin } from '../oauth.ts'
import { type Block, result } from '../output/model.ts'
import {
  deviceRefused,
  isCliScope,
  isPreset,
  PRESET_NAMES,
  rememberable,
  SCOPE_PRESETS,
  scopeList,
  scopeReport,
} from '../presets.ts'

/**
 * Sign-in ([`05-mcp/oauth.md` §5](../../../../exponetdb-docs/05-mcp/oauth.md)):
 * the Wave 3B flows unchanged in their guarantees (loopback PKCE S256 with
 * state and issuer checks, the device flow, the private token store with
 * single refresh under its lock, revocation before the local copy goes).
 * Prompts go to stderr so stdout stays a result; a token, a code or a
 * verifier is never printed.
 */
function scopesFrom(raw: unknown): readonly string[] {
  const scopes = scopeList(String(raw))
  for (const s of scopes) {
    if (!isScope(s)) throw new UsageError(`${s} is not a scope.`, 'exponetdb auth scopes')
    if (!isScopeGrantableTo(s, 'cli')) {
      throw new UsageError(`The CLI cannot hold ${s} (Web App only).`, 'exponetdb auth scopes')
    }
  }
  if (scopes.length === 0) throw new UsageError('--scope names at least one scope.')
  return scopes
}

function presetFrom(raw: unknown): readonly string[] {
  const name = String(raw)
  if (!isPreset(name)) {
    throw new UsageError(
      `${name} is not a preset (${PRESET_NAMES.join(', ')}).`,
      'exponetdb auth presets',
    )
  }
  return SCOPE_PRESETS[name].scopes
}

/**
 * What `login` asks for (15-cli §3): `--preset` and `--scope` (their union),
 * else the scopes granted at the profile's last sign-in, else those of the
 * sign-in the token store still holds, else the default.
 */
async function requestedScopes(
  ctx: RunContext,
  input: CommandInput,
  origin: string,
  profile: Profile | undefined,
): Promise<{ readonly scopes: readonly string[]; readonly source: string }> {
  const { scope, preset } = input.flags
  if (scope !== undefined || preset !== undefined) {
    const scopes = [
      ...(preset === undefined ? [] : presetFrom(preset)),
      ...(scope === undefined ? [] : scopesFrom(scope)),
    ]
    return { scopes: [...new Set(scopes)], source: 'flags' }
  }
  const remembered =
    profile?.auth.method === 'oauth' && profile.auth.scopes !== undefined
      ? { scopes: profile.auth.scopes, source: `remembered for profile ${profile.name}` }
      : await ctx.tokens
          .read(origin)
          .then(
            (c) => c && { scopes: scopeList(c.scope), source: `the current sign-in to ${origin}` },
          )
  if (remembered === undefined) return { scopes: DEFAULT_SCOPES, source: 'default' }
  const known = remembered.scopes.filter(isCliScope)
  const dropped = remembered.scopes.filter((s) => !isCliScope(s))
  // JSON quoting: the file is the person's, but its text never reaches the terminal raw.
  if (dropped.length > 0)
    ctx.hint(`Not asked for (unknown to this CLI): ${JSON.stringify(dropped)}.`)
  return known.length === 0
    ? { scopes: DEFAULT_SCOPES, source: 'default' }
    : { scopes: known, source: remembered.source }
}

/**
 * Records the grant on the profile (non-secret) for the next `login`, unless
 * the profile was removed, re-keyed or moved while the browser was open; the
 * sign-in itself already succeeded, so a failure here is a hint, not an error.
 */
async function remember(
  ctx: RunContext,
  profile: Profile,
  granted: readonly string[],
  requested: readonly string[],
): Promise<boolean> {
  try {
    const current = (await ctx.profiles.load()).profiles[profile.name]
    if (
      current === undefined ||
      current.auth.method !== 'oauth' ||
      current.server !== profile.server
    ) {
      return false
    }
    await ctx.profiles.put(
      {
        ...current,
        auth: { method: 'oauth', scopes: rememberable(granted), requestedScopes: [...requested] },
      },
      false,
    )
    return true
  } catch (error) {
    ctx.hint(
      `Signed in, but the profile could not be updated: ${error instanceof Error ? error.message : 'unknown'}`,
    )
    return false
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export const authCommands: readonly CommandSpec[] = [
  {
    path: ['login'],
    aliases: [['auth', 'login']],
    summary: 'Sign in through the browser (or the device flow) and store the tokens privately.',
    description:
      'Opens the authorization page of the server (loopback redirect, PKCE S256). Without --scope or --preset it asks for the scopes granted at the last sign-in (remembered per profile), else targets.read. With --device the CLI shows a code to enter on another device; the device flow never carries a production or administrative scope. Production and administrative scopes need explicit consent in the browser.',
    group: 'auth',
    flags: [
      {
        name: 'scope',
        type: 'string',
        placeholder: 'scopes',
        description:
          'Scopes to ask for, space or comma separated (default: the last grant of the profile, else targets.read).',
      },
      {
        name: 'preset',
        type: 'enum',
        values: PRESET_NAMES,
        description: 'A named scope list (exponetdb auth presets); combines with --scope.',
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
      'exponetdb login --preset developer:nonprod',
      'exponetdb login --preset admin --scope migrations.apply:prod',
      'exponetdb login --scope "targets.read migrations.plan migrations.apply:nonprod"',
      'exponetdb login --device --preset developer:nonprod',
    ],
    async run(ctx, input) {
      const device = input.flags['device'] === true
      const { server: origin, profile } = await resolveServer(ctx)
      if (profile !== undefined && profile.auth.method !== 'oauth') {
        throw new CliError(
          'usage',
          `The profile ${profile.name} signs in with a ${profile.auth.method} key; no browser sign-in is needed.`,
        )
      }
      const { scopes, source } = await requestedScopes(ctx, input, origin, profile)
      if (device) {
        const refused = deviceRefused(scopes)
        if (refused.length > 0) {
          throw new UsageError(
            `The device flow never carries ${refused.join(', ')}${source === 'flags' ? '' : ` (${source})`}; sign in through the browser for it.`,
            'exponetdb login --device --preset developer:nonprod',
          )
        }
      }
      ctx.hint(`Asking for: ${scopes.join(' ')}${source === 'flags' ? '' : ` (${source})`}.`)
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
      const granted = scopeList(credentials.scope)
      const notGranted = scopes.filter((s) => !granted.includes(s))
      const remembered =
        profile === undefined ? false : await remember(ctx, profile, granted, scopes)
      return result({
        command: 'login',
        data: {
          server: server.origin,
          scope: credentials.scope,
          requested: scopes,
          notGranted,
          ...(remembered && profile !== undefined ? { rememberedFor: profile.name } : {}),
          accessExpiresAt: iso(credentials.accessExpiresAt),
        },
        blocks: [
          {
            kind: 'text',
            lines: [
              `Signed in to ${server.origin} (scope: ${credentials.scope}).`,
              ...(notGranted.length === 0
                ? []
                : [
                    `Not granted: ${notGranted.join(' ')} (the account does not hold them, or they were not ticked on the consent page).`,
                  ]),
              profile === undefined
                ? 'Not remembered: no profile is in use (exponetdb profile add <name> --server <url> --use).'
                : remembered
                  ? `Remembered for profile ${profile.name}; the next exponetdb login asks for the same${rememberable(granted).length < granted.length ? ' without the production scopes' : ''}.`
                  : `Not remembered: the profile ${profile.name} changed during the sign-in.`,
            ],
          },
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
      const requested =
        remote.profile?.auth.method === 'oauth' ? remote.profile.auth.requestedScopes : undefined
      const report =
        stored === undefined ? undefined : scopeReport(scopeList(stored.scope), requested)
      const data = {
        server: remote.server,
        version: remote.installation.version,
        ...(remote.installationId === undefined ? {} : { installationId: remote.installationId }),
        ...(remote.profile === undefined ? {} : { profile: remote.profile.name }),
        auth: method,
        ...(stored === undefined
          ? {}
          : { scope: stored.scope, accessExpiresAt: iso(stored.accessExpiresAt) }),
        ...(report === undefined ? {} : { scopes: report }),
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
      if (report?.notGranted != null && report.notGranted.length > 0) {
        rows.push(['Not granted', `${report.notGranted.join(' ')} (asked for at the last sign-in)`])
      }
      const blocks: Block[] = [{ kind: 'fields', rows }]
      if (report !== undefined) {
        blocks.push({
          kind: 'table',
          columns: [
            { title: 'PRESET' },
            { title: 'GRANTED' },
            { title: 'MISSING', flexible: true },
          ],
          rows: report.presets.map((p) => [
            p.preset,
            p.covered ? 'yes' : 'no',
            p.missing.join(' '),
          ]),
        })
        ctx.hint(
          'A sign-in replaces the grant; exponetdb doctor names one that keeps these scopes. The consent page shows what the account holds.',
        )
      }
      return result({ command: 'whoami', data, blocks })
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
    path: ['auth', 'presets'],
    summary: 'List the named scope presets of exponetdb login --preset (local).',
    description:
      'From this CLI version. A preset is shorthand for a scope list: the consent page still offers only what the account holds; only a preset named …:prod holds a production scope.',
    group: 'auth',
    locality: 'local',
    effect: 'local',
    output: 'ScopePresetList',
    async run() {
      const items = PRESET_NAMES.map((name) => ({
        preset: name,
        summary: SCOPE_PRESETS[name].summary,
        scopes: SCOPE_PRESETS[name].scopes,
        deviceFlow: deviceRefused(SCOPE_PRESETS[name].scopes).length === 0,
      }))
      return result({
        command: 'auth presets',
        items,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'PRESET' },
              { title: 'DEVICE FLOW' },
              { title: 'SCOPES', flexible: true },
            ],
            rows: items.map((i) => [i.preset, i.deviceFlow ? 'yes' : 'no', i.scopes.join(' ')]),
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
