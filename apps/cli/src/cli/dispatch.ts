import type { ApiError } from '@exponetdb/sdk'
import { CliError } from '../errors.ts'
import type { CommandResult, OutputContext, SafeError } from '../output/model.ts'
import { renderHuman, renderJson, renderNdjson, type Terminal } from '../output/render.ts'
import { TokenStore } from '../store.ts'
import { BUILD } from '../version.ts'
import { type GlobalOptions, type Parsed, parse, UsageError } from './args.ts'
import { EXIT, exitFor } from './exit.ts'
import { commandHelp, groupHelp, rootHelp } from './help.ts'
import { ProfileStore } from './profiles.ts'
import { connect, type Remote, RemoteFailure } from './remote.ts'
import { contextFor, type Io, type RunContext } from './run.ts'
import { type CommandSpec, commandName } from './spec.ts'

/** Whether the terminal takes UTF-8 box and ellipsis characters. */
function utf8(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return true
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || ''
  return locale === '' || /utf-?8/i.test(locale)
}

export function terminalFor(io: Io, global: GlobalOptions): Terminal {
  const dumb = io.env['TERM'] === 'dumb'
  const mode = global.color ?? 'auto'
  const color =
    mode === 'always' ||
    (mode === 'auto' &&
      io.tty.stdout &&
      !dumb &&
      (io.env['NO_COLOR'] ?? '') === '' &&
      io.env['CI'] === undefined)
  return {
    columns: io.tty.stdout ? Math.max(20, io.columns ?? 80) : 120,
    color,
    ascii: dumb || !utf8(io.env, io.platform),
    quiet: global.quiet,
  }
}

/** Next steps a person can copy for well-known refusals. */
function nextFor(code: string, spec: CommandSpec | undefined, server?: string): string[] {
  const on = server === undefined ? '' : ` --server ${server}`
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'TOKEN_EXPIRED':
    case 'GRANT_REVOKED':
    case 'signed_out':
    case 'expired':
      return [`exponetdb login${on}`]
    case 'INSUFFICIENT_SCOPE':
      return spec?.scopes === undefined
        ? [`exponetdb auth scopes${on}`]
        : [`exponetdb login${on} --scope "${spec.scopes.join(' ')}"`]
    case 'installation_changed':
      return ['exponetdb profile show', 'exponetdb doctor']
    case 'TRANSPORT_FAILED':
    case 'CONTROL_PLANE_DEGRADED':
      return [`exponetdb doctor${on}`]
    default:
      return []
  }
}

export function apiFailure(
  command: string,
  spec: CommandSpec | undefined,
  e: ApiError,
  server?: string,
): CommandResult {
  const error: SafeError = {
    code: e.code,
    message:
      e.message ??
      (e.code === 'TRANSPORT_FAILED'
        ? 'The server could not be reached.'
        : e.code === 'RESPONSE_INVALID'
          ? 'The server answered something this CLI cannot read as the contract.'
          : 'The server refused the request.'),
    ...(e.remediation === undefined ? {} : { remediation: e.remediation }),
    ...(e.details === undefined ? {} : { details: e.details }),
  }
  return {
    command,
    status: 'error',
    exitCode: exitFor(e.code),
    error,
    ...(e.requestId === null ? {} : { requestId: e.requestId }),
    ...(e.planId === undefined ? {} : { planId: e.planId }),
    ...(e.operationId === undefined ? {} : { operationId: e.operationId }),
    next: nextFor(e.code, spec, server),
    blocks: [],
  }
}

function cliFailure(command: string, spec: CommandSpec | undefined, e: CliError): CommandResult {
  return {
    command,
    status: 'error',
    exitCode: exitFor(e.code),
    error: { code: e.code, message: e.message },
    next: nextFor(e.code, spec),
    blocks: [],
  }
}

function emit(
  io: Io,
  r: CommandResult,
  format: RunContext['format'],
  terminal: Terminal,
  context: OutputContext,
): void {
  if (format === 'json') {
    io.stdout(`${renderJson(r, context)}\n`)
    if (r.error !== undefined && terminal.columns > 0) {
      // A person reading a terminal still sees the error on stderr.
      if (io.tty.stderr) io.stderr(`${r.error.code}: ${r.error.message}\n`)
    }
    return
  }
  if (format === 'ndjson') {
    for (const line of renderNdjson(r, context)) io.stdout(`${line}\n`)
    return
  }
  const { out, err } = renderHuman(r, terminal)
  if (out.length > 0) io.stdout(`${out.join('\n')}\n`)
  if (err.length > 0) io.stderr(`${err.join('\n')}\n`)
}

/** Runs one invocation: parse, help, the command, the output; returns the exit code. */
export async function dispatch(
  argv: readonly string[],
  io: Io,
  commands: readonly CommandSpec[],
): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parse(commands, argv)
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`Error: ${error.message}\n`)
      if (error.suggestion !== undefined) io.stderr(`Did you mean: ${error.suggestion}\n`)
      io.stderr(
        error.command === undefined
          ? 'Run `exponetdb --help` for the commands.\n'
          : `Run \`exponetdb ${commandName(error.command)} --help\` for its usage.\n`,
      )
      return EXIT.usage
    }
    throw error
  }
  const { global, command } = parsed
  if (global.version && command === undefined) {
    io.stdout(
      `exponetdb ${BUILD.version} (${BUILD.commit}${BUILD.builtAt === null ? '' : `, built ${BUILD.builtAt}`})\n`,
    )
    return EXIT.ok
  }
  if (command === undefined || global.help) {
    const text =
      command !== undefined
        ? commandHelp(command)
        : parsed.words.length > 0
          ? (groupHelp(commands, parsed.words) ?? rootHelp(commands))
          : rootHelp(commands)
    io.stdout(`${text}\n`)
    return EXIT.ok
  }
  const profiles = new ProfileStore(io.configDir)
  const envOutput = io.env['EXPONETDB_OUTPUT']
  let format: RunContext['format'] =
    global.output ??
    (envOutput === 'json' || envOutput === 'ndjson' || envOutput === 'table' ? envOutput : 'table')
  if (global.output === undefined && envOutput === undefined) {
    // A profile's default output (when a profile is in use).
    try {
      const file = await profiles.load()
      const name = global.profile ?? io.env['EXPONETDB_PROFILE'] ?? file.current ?? undefined
      const p = name === undefined ? undefined : file.profiles[name]
      if (p?.defaults.output !== undefined) format = p.defaults.output
    } catch {
      // An unreadable profiles file is reported by the command that needs it.
    }
  }
  const terminal = terminalFor(io, global)
  let remote: Remote | undefined
  let remotePromise: Promise<Remote> | undefined
  const name = commandName(command)
  const ctx: RunContext = contextFor({
    io,
    global,
    terminal,
    format,
    tokens: new TokenStore(io.configDir),
    profiles,
    commands,
    command: name,
    remote() {
      remotePromise ??= connect(ctx).then((r) => {
        remote = r
        return r
      })
      return remotePromise
    },
    outputContext: () => remote?.context ?? {},
  })
  let r: CommandResult
  try {
    r = await command.run(ctx, parsed.input)
  } catch (error) {
    if (io.signal.aborted) {
      r = {
        command: name,
        status: 'error',
        exitCode: EXIT.interrupted,
        error: {
          code: 'interrupted',
          message: 'Interrupted. Anything the server already accepted continues there.',
        },
        blocks: [],
      }
    } else if (error instanceof UsageError) {
      io.stderr(`Error: ${error.message}\n`)
      if (error.suggestion !== undefined) io.stderr(`Did you mean: ${error.suggestion}\n`)
      return EXIT.usage
    } else if (error instanceof RemoteFailure) {
      r = apiFailure(name, command, error.error, remote?.server)
    } else if (error instanceof CliError) {
      r = cliFailure(name, command, error)
    } else {
      r = {
        command: name,
        status: 'error',
        exitCode: EXIT.failure,
        error: {
          code: 'unexpected',
          message: 'The CLI failed unexpectedly; nothing more is known. Run again with --verbose.',
        },
        blocks: [],
      }
      if (global.verbose && error instanceof Error) io.stderr(`(${error.name})\n`)
    }
  }
  emit(io, r, format, terminal, ctx.outputContext())
  return r.exitCode
}
