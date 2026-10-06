#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { InstallationSchema } from '@exponetdb/contracts'
import { CliError } from './errors.ts'
import {
  DEFAULT_SCOPES,
  deviceLogin,
  discover,
  type Fetch,
  liveCredentials,
  logout,
  loopbackLogin,
  parseServer,
} from './oauth.ts'
import { TokenStore } from './store.ts'

/**
 * `exponetdb` — the command-line client (Wave 3B: sign-in only). Talks to
 * the REST API of one server with the first-party CLI client; never prints
 * or logs a token.
 *
 *   exponetdb login  [--server URL] [--scope "a b"] [--device] [--no-browser]
 *   exponetdb logout [--server URL]
 *   exponetdb whoami [--server URL]
 *
 * The server comes from `--server`, else `EXPONETDB_URL`, else the only
 * server with stored credentials.
 */
export interface Io {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env: NodeJS.ProcessEnv
  readonly fetch: Fetch
  readonly store: TokenStore
  readonly openBrowser: (url: string) => void
}

interface Args {
  readonly command: string | undefined
  readonly server: string | undefined
  readonly scopes: readonly string[] | undefined
  readonly device: boolean
  readonly browser: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let command: string | undefined
  let server: string | undefined
  let scopes: string[] | undefined
  let device = false
  let browser = true
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--server':
        server = argv[++i]
        break
      case '--scope':
        scopes = (argv[++i] ?? '').split(' ').filter((s) => s.length > 0)
        break
      case '--device':
        device = true
        break
      case '--no-browser':
        browser = false
        break
      default:
        if (arg === undefined || arg.startsWith('-') || command !== undefined) {
          throw new CliError('usage', `Unknown argument: ${arg ?? ''}`)
        }
        command = arg
    }
  }
  return { command, server, scopes, device, browser }
}

async function resolveServer(io: Io, args: Args): Promise<string> {
  const explicit = args.server ?? io.env['EXPONETDB_URL']
  if (explicit !== undefined && explicit.length > 0) {
    return parseServer(explicit)
  }
  const known = await io.store.servers()
  if (known.length === 1 && known[0] !== undefined) {
    return known[0]
  }
  throw new CliError('usage', 'Name the server with --server or EXPONETDB_URL.')
}

/** Opens a URL with the platform's opener, without a shell; failures are ignored (the URL is printed anyway). */
export function systemBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open'
  if (opener !== undefined && /^https?:\/\//.test(url)) {
    execFile(opener, [url], { timeout: 5000 }, () => undefined)
  }
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.err(error instanceof Error ? error.message : 'Invalid arguments.')
    return 2
  }
  try {
    switch (args.command) {
      case 'login': {
        const server = await discover(io.fetch, await resolveServer(io, args))
        const scopes = args.scopes ?? DEFAULT_SCOPES
        const credentials = args.device
          ? await deviceLogin(io.fetch, server, {
              scopes,
              present: async (uri, code) => {
                io.err(`Open ${uri} in a browser and enter the code ${code}.`)
                io.err('Check that the code matches before you approve.')
              },
            })
          : await loopbackLogin(io.fetch, server, {
              scopes,
              present: async (url) => {
                io.err(`Sign in at: ${url}`)
                if (args.browser) {
                  io.openBrowser(url)
                }
              },
            })
        await io.store.withLock(() => io.store.write(credentials))
        io.out(`Signed in to ${server.origin} (scope: ${credentials.scope}).`)
        return 0
      }
      case 'logout': {
        const origin = await resolveServer(io, args)
        const server = await discover(io.fetch, origin)
        const result = await logout(io.fetch, io.store, server)
        if (!result.revoked) {
          io.err(
            `Signed out locally. The server did not confirm the revocation; revoke the grant in the Web App under Connected applications.`,
          )
          return 1
        }
        io.out(`Signed out of ${origin}; the grant is revoked.`)
        return 0
      }
      case 'whoami': {
        const server = await discover(io.fetch, await resolveServer(io, args))
        const credentials = await liveCredentials(io.fetch, io.store, server)
        const response = await io.fetch(`${server.origin}/api/v1/installation`, {
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            accept: 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        })
        if (response.status !== 200) {
          io.err(`The server refused the request (${response.status}).`)
          return 1
        }
        const installation = InstallationSchema.safeParse(JSON.parse(await response.text()))
        io.out(`Server:  ${server.origin}`)
        io.out(`Version: ${installation.success ? installation.data.version : 'unknown'}`)
        io.out(`Scope:   ${credentials.scope}`)
        io.out(
          `Token:   valid until ${new Date(credentials.accessExpiresAt).toISOString()} (refreshed as needed)`,
        )
        return 0
      }
      default:
        io.err(
          'Usage: exponetdb <login|logout|whoami> [--server URL] [--scope "a b"] [--device] [--no-browser]',
        )
        return 2
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message)
      return error.code === 'usage' ? 2 : 1
    }
    io.err('Unexpected failure.')
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    fetch,
    store: new TokenStore(),
    openBrowser: systemBrowser,
  }).then((code) => {
    process.exitCode = code
  })
}
