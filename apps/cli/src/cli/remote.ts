import { createPrivateKey, type webcrypto } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ROUTE_LIST } from '@exponetdb/contracts'
import { type ApiError, type Authenticator, ExponetDB, type Result } from '@exponetdb/sdk'
import { CliError } from '../errors.ts'
import { findProjectFile, readLink } from '../local/project.ts'
import { discover, liveCredentials, parseServer, type ServerInfo } from '../oauth.ts'
import { CLI_VERSION, olderThan } from '../version.ts'
import type { Profile } from './profiles.ts'
import type { Remote, RunContext } from './types.ts'
import { UsageError } from './usage.ts'

/**
 * The server a remote command talks to and an authenticated SDK client
 * ([`15-cli/README.md` §3](../../../../exponetdb-docs/15-cli/README.md#3-profiles-context-and-precedence)).
 * Answers are read with a size bound and checked against the route's
 * response schema from the contracts: an answer of another shape is
 * `RESPONSE_INVALID`, never a rendered result.
 */
export type { Remote }

const ROUTES = new Map(ROUTE_LIST.map((r) => [r.operationId, r]))

/**
 * Whether a success body matches the route's response schema. A field this CLI does not know is
 * ignored (versioning.md §2: a client ignores unknown fields; a newer server adds them within a
 * major); a missing field, a wrong type or a value outside a closed enum is not.
 */
export function matchesContract(operationId: string, body: unknown): boolean {
  const parsed = ROUTES.get(operationId)?.response.schema.safeParse(body)
  return (
    parsed !== undefined &&
    (parsed.success || parsed.error.issues.every((i) => i.code === 'unrecognized_keys'))
  )
}

function fail(code: string, message: string): { ok: false; error: ApiError } {
  return { ok: false, error: { code, message, status: null, requestId: null, retryable: false } }
}

/** The person's OAuth grant from the token store; a refused token is refreshed once. */
function tokenAuthenticator(ctx: RunContext, origin: string): Authenticator {
  let info: ServerInfo | undefined
  let last: string | undefined
  let refused: string | undefined
  return {
    renewable: true,
    async header() {
      try {
        info ??= await discover(ctx.io.fetch, origin)
        const credentials = await liveCredentials(
          ctx.io.fetch,
          ctx.tokens,
          info,
          ctx.io.now,
          refused,
        )
        last = credentials.accessToken
        return { ok: true, value: `Bearer ${credentials.accessToken}` }
      } catch (error) {
        if (error instanceof CliError) {
          // The sign-in layer's own codes, in the catalog's words.
          return fail(
            error.code === 'signed_out' || error.code === 'expired'
              ? 'UNAUTHENTICATED'
              : error.code === 'network'
                ? 'TRANSPORT_FAILED'
                : error.code,
            error.message,
          )
        }
        return fail('TRANSPORT_FAILED', 'The sign-in could not be read.')
      }
    },
    invalidate() {
      refused = last
    },
  }
}

/** A key file the person named: a regular file that only they can read. */
async function privateFile(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new CliError('usage', `The key file ${path} does not exist or is not a regular file.`)
  }
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
  ) {
    throw new CliError('store_insecure', `The key file ${path} must be yours and private (0600).`)
  }
  return (await readFile(path, 'utf8')).trim()
}

/** A service account's PEM key as a WebCrypto key (never extractable). */
function cryptoKeyOf(pem: string): Promise<webcrypto.CryptoKey> {
  const key = createPrivateKey(pem)
  const type = key.asymmetricKeyType
  const details = key.asymmetricKeyDetails ?? {}
  if (
    type === 'ec' &&
    (details.namedCurve === 'prime256v1' || details.namedCurve === 'secp384r1')
  ) {
    return Promise.resolve(
      key.toCryptoKey(
        { name: 'ECDSA', namedCurve: details.namedCurve === 'prime256v1' ? 'P-256' : 'P-384' },
        false,
        ['sign'],
      ),
    )
  }
  if (type === 'ed25519')
    return Promise.resolve(key.toCryptoKey({ name: 'Ed25519' }, false, ['sign']))
  if (type === 'rsa') {
    return Promise.resolve(
      key.toCryptoKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
    )
  }
  throw new CliError('usage', 'The service account key is not an ES256, ES384, EdDSA or RS256 key.')
}

/**
 * The server and profile of this invocation, by precedence: `--server` /
 * `--profile`, then `EXPONETDB_URL` / `EXPONETDB_PROFILE`, then the current
 * profile, then the only server with stored credentials. A server other
 * than the profile's uses none of the profile's settings.
 */
export async function resolveServer(
  ctx: RunContext,
): Promise<{ readonly server: string; readonly profile: Profile | undefined }> {
  const file = await ctx.profiles.load()
  const explicitProfile = ctx.global.profile ?? emptyToUndefined(ctx.io.env['EXPONETDB_PROFILE'])
  const explicitServer = ctx.global.server ?? emptyToUndefined(ctx.io.env['EXPONETDB_URL'])
  let profile: Profile | undefined
  if (explicitProfile !== undefined) {
    profile = file.profiles[explicitProfile]
    if (profile === undefined)
      throw new UsageError(`There is no profile ${explicitProfile}.`, 'exponetdb profile list')
  } else if (file.current !== null) {
    profile = file.profiles[file.current]
  }
  if (explicitServer !== undefined) {
    const server = parseServer(explicitServer)
    if (profile !== undefined && profile.server !== server) {
      if (explicitProfile !== undefined) {
        // A named profile's settings never go to another origin.
        throw new UsageError(
          `The profile ${profile.name} belongs to ${profile.server}, not ${server}.`,
          `exponetdb --server ${server} <command> (without --profile)`,
        )
      }
      ctx.hint(
        `Using ${server}; the current profile ${profile.name} (${profile.server}) is not used.`,
      )
      profile = undefined
    }
    return { server, profile }
  }
  if (profile !== undefined) return { server: profile.server, profile }
  // The project's link (exponetdb project link), when the working directory has one.
  const projectFile = await findProjectFile(ctx.global.workdir ?? ctx.io.cwd).catch(() => undefined)
  const link =
    projectFile === undefined
      ? undefined
      : await readLink(dirname(projectFile)).catch(() => undefined)
  if (link !== undefined) {
    const linked = link.profile === null ? undefined : file.profiles[link.profile]
    return {
      server: parseServer(link.server),
      profile: linked?.server === parseServer(link.server) ? linked : undefined,
    }
  }
  const known = await ctx.tokens.servers()
  if (known.length === 1 && known[0] !== undefined) return { server: known[0], profile: undefined }
  throw new UsageError(
    'Name the server with --server, EXPONETDB_URL or a profile.',
    'exponetdb profile add local --server https://db.example.com',
  )
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/
const shownVersion = (v: unknown): string =>
  typeof v === 'string' && v.length <= 64 && VERSION_SHAPE.test(v) ? v : 'unknown'

export async function connect(ctx: RunContext): Promise<Remote> {
  const { server, profile } = await resolveServer(ctx)
  const auth = profile?.auth ?? { method: 'oauth' as const }
  // The installation is read before it is judged: a server of another REST major or a CLI below the
  // server's minimum must be named as that, not fail the strict parse of an answer it cannot read.
  let connecting = true
  const sdk = new ExponetDB({
    baseUrl: server,
    fetch: ctx.io.fetch,
    timeoutMs: ctx.global.timeoutMs ?? 30_000,
    validate: (id, body) => (connecting && id === 'getInstallation') || matchesContract(id, body),
    userAgent: `exponetdb-cli/${CLI_VERSION}`,
    auth:
      auth.method === 'oauth'
        ? { kind: 'provider', authenticator: tokenAuthenticator(ctx, server) }
        : auth.method === 'api-key'
          ? { kind: 'apiKey', key: await privateFile(auth.keyFile) }
          : {
              kind: 'serviceAccount',
              clientId: auth.clientId,
              keyId: auth.keyId,
              privateKey: await cryptoKeyOf(await privateFile(auth.keyFile)),
              scopes: auth.scopes,
            },
  })
  // The installation answering at this origin is the one the profile recorded.
  const installation = await sdk.installation.get()
  if (!installation.ok) throw new RemoteFailure(installation.error)
  connecting = false
  const seen = installation.value as unknown as {
    readonly version?: unknown
    readonly minCliVersion?: unknown
    readonly contracts?: { readonly restApi?: unknown }
  }
  // Text of the server that reaches an error message is only ever a version or an API name of the
  // expected shape, otherwise `unknown`: it is judged before the contract check below.
  const serverVersion = shownVersion(seen.version)
  if (seen.contracts?.restApi !== 'v1') {
    const api = String(seen.contracts?.restApi)
    throw new CliError(
      'incompatible_server',
      `The server at ${server} (${serverVersion}) speaks the REST API ${/^[a-z0-9.-]{1,16}$/.test(api) ? api : 'unknown'}; this CLI (${CLI_VERSION}) speaks v1. Use a CLI release that matches the server.`,
    )
  }
  const minimum = shownVersion(seen.minCliVersion)
  if (minimum !== 'unknown' && olderThan(CLI_VERSION, minimum)) {
    throw new CliError(
      'cli_outdated',
      `The server at ${server} (${serverVersion}) needs CLI ${minimum} or newer; this CLI is ${CLI_VERSION}. Update the CLI.`,
    )
  }
  if (!matchesContract('getInstallation', installation.value)) {
    throw new RemoteFailure({
      code: 'RESPONSE_INVALID',
      status: null,
      requestId: null,
      retryable: false,
    })
  }
  const installationId = installation.value.installationId
  if (
    profile !== undefined &&
    profile.installationId !== null &&
    installationId !== undefined &&
    installationId !== profile.installationId
  ) {
    throw new CliError(
      'installation_changed',
      `Another installation answers at ${server} (${installationId}, the profile recorded ${profile.installationId}). Check the server, then run: exponetdb profile add ${profile.name} --server ${server} --force`,
    )
  }
  if (profile !== undefined && profile.installationId === null && installationId !== undefined) {
    await ctx.profiles.put({ ...profile, installationId }, false)
  }
  return {
    server,
    profile,
    installationId,
    installation: { version: installation.value.version, features: installation.value.features },
    sdk,
    context: {
      server,
      ...(profile === undefined ? {} : { profile: profile.name }),
      ...(installationId === undefined ? {} : { installationId }),
    },
  }
}

/** A failed API call raised out of `connect` (rendered like any API error). */
export class RemoteFailure extends Error {
  override readonly name = 'RemoteFailure'
  readonly error: ApiError
  constructor(error: ApiError) {
    super(error.message ?? error.code)
    this.error = error
  }
}

/** Unwraps an SDK result or raises the API error. */
export function must<T>(r: Result<T>): T {
  if (!r.ok) throw new RemoteFailure(r.error)
  return r.value
}

function emptyToUndefined(v: string | undefined): string | undefined {
  return v === undefined || v.length === 0 ? undefined : v
}
