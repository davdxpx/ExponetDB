import { readFile } from 'node:fs/promises'
import { bootstrapOwnerCommand, recoverOwnerCommand } from '../composition/access.ts'
import {
  auditPrune,
  auditVerify,
  bootstrapSql,
  CommandRefused,
  keyringAddKey,
  keyringGenerate,
  keyringReport,
  migrate,
  schemaStatus,
  writeSecretFile,
} from '../composition/commands.ts'
import { createRuntime } from '../composition/runtime.ts'
import { BUILD } from '../config/build-info.ts'
import {
  authOperatorConfig,
  ConfigError,
  type Env,
  gatewayConfig,
  keyringCommandConfig,
  plainCommandConfig,
  serveConfig,
  storeCommandConfig,
  workerConfig,
} from '../config/env.ts'
import { runGateway, runServe, runWorker } from '../roles/roles.ts'

/**
 * The `exponetdb` command line. One image, three long-running roles and the
 * operator's one-shot commands. Machine-readable results go to standard
 * output as JSON; logs of one-shot commands go to standard error. Exit codes:
 * 0 success, 1 the command ran and its result is negative (verification
 * failed, schema not current), 2 usage or configuration error, 3 refused to
 * start.
 */
export interface Io {
  readonly env: Env
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export const USAGE = `exponetdb <command>

Process roles (one image, three resources):
  serve                           the Web App, /auth and /api/v1 on EXPONETDB_LISTEN (EXPONETDB_PUBLIC_URL)
  worker                          maintenance tasks and the operations loop
  gateway                         heartbeat and readiness; no agent listener before Wave 5

Control Store:
  control-store migrate           apply and verify the Control Store bundles (login exdb_migrate)
  control-store status            schema state, read-only (a process login)
  control-store bootstrap-sql --credentials-file <new file> [--database <name>] [--output <new file>]

Keyring:
  keyring generate --key-id <id> [--output <new file>]
  keyring add-key --input <file> --key-id <id> --output <new file>
  keyring status                  key ids and references (never key material)

Identity (inside the serve container, login exdb_serve):
  bootstrap owner --email <address> [--display-name <name>] [--reissue]
                                  first-owner setup link (30 minutes), printed once
  auth recover-owner --email <address> --reason-file <file>
                                  out-of-band recovery of the last owner (30-minute link)

Audit:
  audit verify [--from-checkpoint <seq>]   read-only recomputation of the chain
  audit prune [--max-partitions <n>]       retention (login exdb_audit_maint)

Other:
  healthcheck                     exit 0 when the internal readiness probe answers 200
  version
`

class UsageError extends Error {}

function flags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const name = args[i] ?? ''
    const value = args[i + 1]
    if (!allowed.includes(name) || value === undefined || value.startsWith('--') || out.has(name)) {
      throw new UsageError(name)
    }
    out.set(name, value)
    i++
  }
  return out
}

function json(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

function commandRuntime(io: Io, level: 'debug' | 'info' | 'warn' | 'error', otlp?: string) {
  return createRuntime({
    role: 'cli',
    logLevel: level,
    otlpEndpoint: otlp,
    write: (line) => io.stderr(`${line}\n`),
  })
}

export async function runCommand(argv: readonly string[], io: Io): Promise<number> {
  const [command, sub, ...rest] = argv
  try {
    switch (command) {
      case 'serve':
        expectNone(sub, rest)
        return await runServe(serveConfig(io.env))
      case 'worker':
        expectNone(sub, rest)
        return await runWorker(workerConfig(io.env))
      case 'gateway':
        expectNone(sub, rest)
        return await runGateway(gatewayConfig(io.env))
      case 'version':
        expectNone(sub, rest)
        json(io, { version: BUILD.version, commit: BUILD.commit })
        return 0
      case 'healthcheck':
        expectNone(sub, rest)
        return await healthcheck(io.env)
      case 'control-store':
        return await controlStore(sub, rest, io)
      case 'keyring':
        return await keyring(sub, rest, io)
      case 'audit':
        return await audit(sub, rest, io)
      case 'bootstrap':
        return await bootstrap(sub, rest, io)
      case 'auth':
        return await authCommand(sub, rest, io)
      case undefined:
      case 'help':
      case '--help':
        io.stdout(USAGE)
        return command === undefined ? 2 : 0
      default:
        throw new UsageError(command)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`exponetdb: invalid arguments\n\n${USAGE}`)
      return 2
    }
    if (error instanceof ConfigError) {
      io.stderr(`exponetdb: ${error.message}\n`)
      return 2
    }
    if (error instanceof CommandRefused) {
      io.stderr(`exponetdb: refused (${error.code})\n`)
      return 2
    }
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'command_failed'
    if (error instanceof Error && error.name === 'AuthError' && /^[a-z][a-z_]{1,63}$/.test(code)) {
      // Operator refusals of the auth commands carry a fixed, secret-free explanation.
      io.stderr(`exponetdb: refused (${code}): ${error.message}\n`)
      return 2
    }
    io.stderr(
      `exponetdb: failed (${/^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'command_failed'})\n`,
    )
    return 1
  }
}

function expectNone(sub: string | undefined, rest: readonly string[]): void {
  if (sub !== undefined || rest.length > 0) {
    throw new UsageError('unexpected arguments')
  }
}

async function controlStore(
  sub: string | undefined,
  rest: readonly string[],
  io: Io,
): Promise<number> {
  switch (sub) {
    case 'migrate': {
      flags(rest, [])
      const config = storeCommandConfig(io.env, 'migrate')
      const runtime = commandRuntime(io, config.logLevel, config.otlpEndpoint)
      const report = await migrate(config, runtime)
      json(io, report)
      return report.state.status === 'current' ? 0 : 1
    }
    case 'status': {
      flags(rest, [])
      const config = storeCommandConfig(io.env, 'readonly_store')
      const status = await schemaStatus(config, commandRuntime(io, config.logLevel))
      json(io, status)
      return status.status === 'current' ? 0 : 1
    }
    case 'bootstrap-sql': {
      const f = flags(rest, ['--credentials-file', '--database', '--output'])
      plainCommandConfig(io.env)
      const credentialsFile = f.get('--credentials-file')
      if (credentialsFile === undefined) {
        throw new UsageError('--credentials-file')
      }
      const out = bootstrapSql(f.get('--database'))
      await writeSecretFile(credentialsFile, out.credentials)
      const output = f.get('--output')
      if (output === undefined) {
        io.stdout(out.script)
      } else {
        await writeSecretFile(output, out.script)
      }
      return 0
    }
    default:
      throw new UsageError(sub ?? 'control-store')
  }
}

async function keyring(sub: string | undefined, rest: readonly string[], io: Io): Promise<number> {
  switch (sub) {
    case 'generate': {
      const f = flags(rest, ['--key-id', '--output'])
      plainCommandConfig(io.env)
      const keyId = f.get('--key-id')
      if (keyId === undefined) {
        throw new UsageError('--key-id')
      }
      const text = keyringGenerate(keyId)
      const output = f.get('--output')
      if (output === undefined) {
        io.stderr('exponetdb: writing key material to standard output; prefer --output <file>\n')
        io.stdout(text)
      } else {
        await writeSecretFile(output, text)
      }
      return 0
    }
    case 'add-key': {
      const f = flags(rest, ['--input', '--key-id', '--output'])
      plainCommandConfig(io.env)
      const input = f.get('--input')
      const keyId = f.get('--key-id')
      const output = f.get('--output')
      if (input === undefined || keyId === undefined || output === undefined) {
        throw new UsageError('add-key')
      }
      await writeSecretFile(output, keyringAddKey(await readFile(input, 'utf8'), keyId))
      return 0
    }
    case 'status': {
      flags(rest, [])
      const config = keyringCommandConfig(io.env)
      const report = await keyringReport(config, commandRuntime(io, config.logLevel))
      json(io, report)
      return report.missing.length === 0 && report.mismatched.length === 0 ? 0 : 1
    }
    default:
      throw new UsageError(sub ?? 'keyring')
  }
}

async function bootstrap(
  sub: string | undefined,
  rest: readonly string[],
  io: Io,
): Promise<number> {
  if (sub !== 'owner') {
    throw new UsageError(sub ?? 'bootstrap')
  }
  const reissue = rest.includes('--reissue')
  const f = flags(
    rest.filter((a) => a !== '--reissue'),
    ['--email', '--display-name'],
  )
  const email = f.get('--email')
  if (email === undefined) {
    throw new UsageError('--email')
  }
  const config = authOperatorConfig(io.env)
  const displayName = f.get('--display-name')
  const result = await bootstrapOwnerCommand(config, commandRuntime(io, config.logLevel), {
    email,
    ...(displayName === undefined ? {} : { displayName }),
    reissue,
  })
  // The link carries the one-time secret: standard output only, never a log line.
  json(io, {
    identityId: result.identityId,
    setupLink: result.link,
    expiresAt: result.expiresAt,
    reissued: result.reissued,
  })
  return 0
}

async function authCommand(
  sub: string | undefined,
  rest: readonly string[],
  io: Io,
): Promise<number> {
  if (sub !== 'recover-owner') {
    throw new UsageError(sub ?? 'auth')
  }
  const f = flags(rest, ['--email', '--reason-file'])
  const email = f.get('--email')
  const reasonFile = f.get('--reason-file')
  if (email === undefined || reasonFile === undefined) {
    throw new UsageError('recover-owner')
  }
  const config = authOperatorConfig(io.env)
  const result = await recoverOwnerCommand(config, commandRuntime(io, config.logLevel), {
    email,
    reasonFile,
  })
  json(io, {
    identityId: result.identityId,
    recoveryLink: result.link,
    expiresAt: result.expiresAt,
    sessionsEnded: result.sessionsEnded,
    ownersNotified: result.ownersNotified,
    notificationsDelivered: result.deliveries,
  })
  return 0
}

function positiveInt(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) {
    return fallback
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(value)
  }
  return n
}

async function audit(sub: string | undefined, rest: readonly string[], io: Io): Promise<number> {
  switch (sub) {
    case 'verify': {
      const f = flags(rest, ['--from-checkpoint'])
      const config = storeCommandConfig(io.env, 'readonly_store')
      const result = await auditVerify(
        config,
        commandRuntime(io, config.logLevel),
        positiveInt(f.get('--from-checkpoint'), undefined),
      )
      json(io, result)
      return result.ok ? 0 : 1
    }
    case 'prune': {
      const f = flags(rest, ['--max-partitions'])
      const config = storeCommandConfig(io.env, 'audit_maint')
      const report = await auditPrune(
        config,
        commandRuntime(io, config.logLevel, config.otlpEndpoint),
        positiveInt(f.get('--max-partitions'), 1) ?? 1,
      )
      json(io, report)
      return 0
    }
    default:
      throw new UsageError(sub ?? 'audit')
  }
}

/**
 * The container health probe. It reads only `EXPONETDB_INTERNAL_LISTEN` (the
 * other variables of the role's environment are the role's, not its own) and
 * asks the role's internal listener.
 */
async function healthcheck(env: Env): Promise<number> {
  const listen = env['EXPONETDB_INTERNAL_LISTEN'] ?? '127.0.0.1:9464'
  const m = /^(?<host>(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[0-9a-fA-F:]+\]):(?<port>\d{1,5})$/.exec(
    listen,
  )
  if (m === null) {
    return 2
  }
  const host = m.groups?.['host'] === '0.0.0.0' ? '127.0.0.1' : (m.groups?.['host'] ?? '127.0.0.1')
  try {
    const response = await fetch(`http://${host}:${m.groups?.['port'] ?? '9464'}/healthz/ready`, {
      signal: AbortSignal.timeout(3000),
    })
    await response.arrayBuffer()
    return response.status === 200 ? 0 : 1
  } catch {
    return 1
  }
}
