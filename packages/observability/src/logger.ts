import { type Clock, formatTimestamp, isId, systemClock } from '@exponetdb/kernel'
import { currentCorrelation } from './context.ts'
import { describeError } from './errors.ts'
import { redactText } from './redact.ts'

/**
 * Structured JSON logger ([self-observability.md §2](../../../exponetdb-docs/10-observability/self-observability.md#2-log-fields)).
 *
 * - One JSON object per line: `ts`, `level`, `msg` (a stable event name such
 *   as `operation.step.finished`, never prose), `role`, then the fields.
 * - Field allowlist: only the fields below are written, each with a typed
 *   validator. A field that is unknown or whose value does not match is dropped
 *   and named in `droppedFields`, so a forgotten secret in a new call site
 *   is not written.
 * - Pattern denylist: every string that passes the allowlist is scanned for
 *   secret shapes and IP addresses ({@link redactText}).
 * - Errors go in the `err` field and are projected by {@link describeError}:
 *   never their message (unless a constant `SafeError` message), never
 *   PostgreSQL `DETAIL`, never stack traces.
 *
 * Logging never throws: a broken sink loses a line, never a request.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value)
}

export type ProcessRole = 'serve' | 'worker' | 'gateway' | 'migrate' | 'cli'

export type LogValue = string | number | boolean | null | undefined | LogActor | readonly string[]
export interface LogActor {
  readonly kind: 'human' | 'service' | 'system'
  readonly id?: string
}
export interface LogFields {
  readonly [name: string]: LogValue | unknown
}

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /** A logger that adds `fields` to every line. The same allowlist applies. */
  child(fields: LogFields): Logger
}

const EVENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const TOKEN = /^[A-Za-z0-9_.:/@+-]{1,128}$/

type Validator = (value: unknown) => unknown

const idOf =
  (prefix: Parameters<typeof isId>[0]): Validator =>
  (v) =>
    isId(prefix, v) ? v : undefined
const pattern =
  (re: RegExp): Validator =>
  (v) =>
    typeof v === 'string' && re.test(v) ? v : undefined
const token = pattern(TOKEN)
const number: Validator = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const boolean: Validator = (v) => (typeof v === 'boolean' ? v : undefined)
const tokens: Validator = (v) =>
  Array.isArray(v) && v.length <= 32 && v.every((x) => typeof x === 'string' && TOKEN.test(x))
    ? v
    : undefined
const actor: Validator = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return undefined
  }
  const kind = 'kind' in v ? v.kind : undefined
  const id = 'id' in v ? v.id : undefined
  if (kind !== 'human' && kind !== 'service' && kind !== 'system') {
    return undefined
  }
  if (id === undefined) {
    return { kind }
  }
  return isId('idn', id) ||
    isId('cli', id) ||
    (typeof id === 'string' && /^system:[a-z]+$/.test(id))
    ? { kind, id }
    : undefined
}

/** The allowlist. A new field is a reviewed change to this table, never an ad-hoc key. */
export const LOG_FIELDS: Readonly<Record<string, Validator>> = {
  requestId: idOf('req'),
  traceId: pattern(/^[0-9a-f]{32}$/),
  spanId: pattern(/^[0-9a-f]{16}$/),
  operationId: idOf('op'),
  planId: idOf('pln'),
  jobId: idOf('job'),
  targetId: idOf('tgt'),
  clusterId: idOf('cls'),
  nodeId: idOf('nod'),
  processId: idOf('prc'),
  installationId: idOf('ins'),
  secretId: idOf('sec'),
  auditId: idOf('aud'),
  migrationId: pattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  migrationName: pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  actor,
  code: token,
  reason: token,
  outcome: token,
  state: token,
  fromState: token,
  toState: token,
  kind: token,
  task: token,
  check: token,
  component: token,
  queryClass: token,
  keyId: pattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  sqlstate: pattern(/^[0-9A-Z]{5}$/),
  errorName: pattern(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  errorCode: token,
  causeCode: token,
  route: pattern(/^\/[A-Za-z0-9_./:{}*-]{0,127}$/),
  method: pattern(/^[A-Z]{3,7}$/),
  status: number,
  durationMs: number,
  count: number,
  seq: number,
  attempt: number,
  port: number,
  exitCode: number,
  leaseSeconds: number,
  buildVersion: pattern(/^[0-9A-Za-z.+-]{1,64}$/),
  buildCommit: pattern(/^(?:[0-9a-f]{7,40}|unknown)$/),
  ok: boolean,
  checks: tokens,
  missing: tokens,
  names: tokens,
}

export interface LoggerOptions {
  readonly role: ProcessRole
  readonly level?: LogLevel
  /** Receives one complete JSON line without the trailing newline. */
  readonly write?: (line: string) => void
  readonly clock?: Clock
}

const defaultWrite = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/** Applies the allowlist and the denylist to `fields`. Exposed for tests and error sinks. */
export function sanitizeFields(fields: LogFields): {
  readonly fields: Record<string, unknown>
  readonly dropped: readonly string[]
} {
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name]
    if (value === undefined) {
      continue
    }
    if (name === 'err') {
      Object.assign(out, describeError(value))
      continue
    }
    const validate = LOG_FIELDS[name]
    const checked = validate === undefined ? undefined : validate(value)
    if (checked === undefined) {
      dropped.push(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'invalid_field_name')
      continue
    }
    out[name] = checked
  }
  return { fields: redactValues(out), dropped }
}

function redactValues(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      out[name] = redactText(value)
    } else if (Array.isArray(value)) {
      out[name] = value.map((v) => (typeof v === 'string' ? redactText(v) : v))
    } else {
      out[name] = value
    }
  }
  return out
}

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info']
  const write = options.write ?? defaultWrite
  const clock = options.clock ?? systemClock
  const emit = (level: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (LEVELS[level] < threshold) {
      return
    }
    try {
      const msg = EVENT.test(event) ? event : 'log.invalid_event_name'
      const correlation = currentCorrelation()
      const sanitized = sanitizeFields({ ...correlation, ...bound, ...fields })
      const line: Record<string, unknown> = {
        ts: formatTimestamp(clock.nowMs()),
        level,
        msg,
        role: options.role,
        ...sanitized.fields,
      }
      if (sanitized.dropped.length > 0) {
        line['droppedFields'] = sanitized.dropped
      }
      write(JSON.stringify(line))
    } catch {
      // A failing sink or serializer must never break the caller.
    }
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  }
}

/** A logger that writes nothing (tests, library defaults). */
export const silentLogger: Logger = createLogger({ role: 'cli', write: () => undefined })
