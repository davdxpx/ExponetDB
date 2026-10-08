import { isIP } from 'node:net'
import { type InstallationId, isId } from '@exponetdb/kernel'
import { isLogLevel, type LogLevel } from '@exponetdb/observability'

/**
 * Configuration from the environment ([deployment.md §2](../../../../exponetdb-docs/12-operations/deployment.md#2-configuration)).
 *
 * Strict: every `EXPONETDB_*` variable must be known **and** used by the
 * program being started; anything else fails startup (a typo must never
 * silently disable a feature). Each process role and each one-shot command
 * has its own set. Problems name the variable and a reason code, never a
 * value: connection strings, keyrings and object storage secrets come in
 * through these variables.
 */
export type RoleName = 'serve' | 'worker' | 'gateway'
export type Program =
  | RoleName
  | 'migrate'
  | 'audit_maint'
  | 'keyring'
  | 'readonly_store'
  | 'auth_operator'
  | 'node_pki'

type Spec = { readonly programs: readonly Program[] }
const ROLES: readonly Program[] = ['serve', 'worker', 'gateway']
const ALL: readonly Program[] = [
  ...ROLES,
  'migrate',
  'audit_maint',
  'keyring',
  'readonly_store',
  'auth_operator',
  'node_pki',
]

const VARIABLES: Readonly<Record<string, Spec>> = {
  EXPONETDB_ROLE: { programs: ROLES },
  EXPONETDB_CONTROL_STORE_URL: {
    programs: [
      ...ROLES,
      'migrate',
      'audit_maint',
      'keyring',
      'readonly_store',
      'auth_operator',
      'node_pki',
    ],
  },
  EXPONETDB_INSTALLATION_ID: { programs: ROLES },
  EXPONETDB_KEYRING: { programs: [...ROLES, 'keyring', 'node_pki'] },
  EXPONETDB_KEYRING_FILE: { programs: [...ROLES, 'keyring', 'node_pki'] },
  EXPONETDB_LISTEN: { programs: ['serve'] },
  EXPONETDB_PUBLIC_URL: { programs: ['serve', 'auth_operator'] },
  EXPONETDB_WEBAUTHN_RP_ID: { programs: ['serve', 'auth_operator'] },
  EXPONETDB_TRUSTED_PROXIES: { programs: ['serve'] },
  EXPONETDB_EGRESS_ADDRESSES: { programs: ['serve'] },
  EXPONETDB_INTERNAL_LISTEN: { programs: ROLES },
  EXPONETDB_SHUTDOWN_TIMEOUT_MS: { programs: ROLES },
  EXPONETDB_LOG_LEVEL: { programs: ALL },
  EXPONETDB_OTLP_ENDPOINT: { programs: [...ROLES, 'migrate', 'audit_maint'] },
  EXPONETDB_AUDIT_EXPORT_DIR: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_ENDPOINT: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_REGION: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_BUCKET: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_PREFIX: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_ACCESS_KEY_ID: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_OBJECT_LOCK_MODE: { programs: ['worker'] },
  EXPONETDB_AUDIT_S3_OBJECT_LOCK_DAYS: { programs: ['worker'] },
  // The gateway's agent listener (Wave 5): HTTP/2 mTLS, private network.
  EXPONETDB_GATEWAY_LISTEN: { programs: ['gateway'] },
}

/** Reserved variables, refused until the wave that implements them (none at present). */
const NOT_YET: Readonly<Record<string, string>> = {}

export interface ConfigProblem {
  readonly variable: string
  readonly reason: string
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly problems: readonly ConfigProblem[]
  constructor(problems: readonly ConfigProblem[]) {
    super(
      `Configuration refused: ${problems.map((p) => `${p.variable} (${p.reason})`).join(', ')}.`,
    )
    this.problems = problems
  }
}

export interface Endpoint {
  readonly host: string
  readonly port: number
}

export interface CommonConfig {
  readonly logLevel: LogLevel
  readonly otlpEndpoint: string | undefined
}

export interface StoreConfig extends CommonConfig {
  /** Secret: never logged, never part of an error. */
  readonly controlStoreUrl: string
}

export interface RoleConfig extends StoreConfig {
  readonly role: RoleName
  readonly installationId: InstallationId
  readonly keyringEnv: Readonly<Record<string, string | undefined>>
  readonly internalListen: Endpoint
  readonly shutdownTimeoutMs: number
}

export interface ServeConfig extends RoleConfig {
  readonly role: 'serve'
  readonly listen: Endpoint
  /** Origin of the Web App and the WebAuthn relying party (identity.md §8): trusted configuration only. */
  readonly publicUrl: string
  readonly webauthnRpId: string | undefined
  /** Peers whose `X-Forwarded-For` is believed (exact addresses or CIDR ranges). */
  readonly trustedProxies: readonly string[]
  /**
   * The addresses serve and the worker connect to managed clusters from; a
   * pg_hba plan protects ExponetDB's own access from them (control-plane.md §9.6).
   */
  readonly egressAddresses: readonly string[]
}

/** `exponetdb bootstrap owner` and `exponetdb auth recover-owner`: the serve login and the public URL. */
export interface AuthOperatorConfig extends StoreConfig {
  readonly publicUrl: string
  readonly webauthnRpId: string | undefined
}

export type AuditExportConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'file'; readonly directory: string }
  | {
      readonly kind: 's3'
      readonly endpoint: string
      readonly region: string
      readonly bucket: string
      readonly prefix: string | undefined
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly objectLock:
        | { readonly mode: 'COMPLIANCE' | 'GOVERNANCE'; readonly days: number }
        | undefined
    }

export interface WorkerConfig extends RoleConfig {
  readonly role: 'worker'
  readonly auditExport: AuditExportConfig
}

export interface GatewayConfig extends RoleConfig {
  readonly role: 'gateway'
  /** The agent listener; `undefined` opens none (control-plane.md §5). */
  readonly agentListen: Endpoint | undefined
}

export type Env = Readonly<Record<string, string | undefined>>

class Reader {
  readonly problems: ConfigProblem[] = []
  readonly #env: Env

  constructor(env: Env, program: Program) {
    this.#env = env
    for (const name of Object.keys(env).sort()) {
      if (!name.startsWith('EXPONETDB_') || env[name] === undefined) {
        continue
      }
      const spec = VARIABLES[name]
      if (spec === undefined) {
        this.problems.push({ variable: name, reason: 'unknown_variable' })
      } else if (NOT_YET[name] !== undefined) {
        this.problems.push({ variable: name, reason: NOT_YET[name] ?? 'not_available' })
      } else if (!spec.programs.includes(program)) {
        this.problems.push({ variable: name, reason: `not_used_by_${program}` })
      }
    }
  }

  raw(name: string): string | undefined {
    const value = this.#env[name]
    return value === undefined || value.length === 0 ? undefined : value
  }

  required(name: string): string | undefined {
    const value = this.raw(name)
    if (value === undefined) {
      this.problems.push({ variable: name, reason: 'missing' })
    }
    return value
  }

  invalid(name: string, reason = 'invalid'): undefined {
    this.problems.push({ variable: name, reason })
    return undefined
  }

  done<T>(value: T): T {
    if (this.problems.length > 0) {
      throw new ConfigError(this.problems)
    }
    return value
  }
}

function endpoint(r: Reader, name: string, fallback: string): Endpoint {
  const text = r.raw(name) ?? fallback
  const m = /^(?<host>(?:\d{1,3}\.){3}\d{1,3}|localhost|\[[0-9a-fA-F:]+\]):(?<port>\d{1,5})$/.exec(
    text,
  )
  const port = Number(m?.groups?.['port'])
  const host = m?.groups?.['host']
  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    r.invalid(name)
    return { host: '127.0.0.1', port: 1 }
  }
  return { host: host.startsWith('[') ? host.slice(1, -1) : host, port }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function httpsUrl(r: Reader, name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') {
      return r.invalid(name, 'credentials_in_url')
    }
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
      return url.toString()
    }
    return r.invalid(name, 'https_required')
  } catch {
    return r.invalid(name)
  }
}

function common(r: Reader): CommonConfig {
  const level = r.raw('EXPONETDB_LOG_LEVEL') ?? 'info'
  const otlp = r.raw('EXPONETDB_OTLP_ENDPOINT')
  let otlpEndpoint: string | undefined
  if (otlp !== undefined) {
    try {
      const url = new URL(otlp)
      otlpEndpoint =
        url.protocol === 'https:' || url.protocol === 'http:'
          ? url.toString()
          : r.invalid('EXPONETDB_OTLP_ENDPOINT')
    } catch {
      r.invalid('EXPONETDB_OTLP_ENDPOINT')
    }
  }
  return {
    logLevel: isLogLevel(level) ? level : (r.invalid('EXPONETDB_LOG_LEVEL') ?? 'info'),
    otlpEndpoint,
  }
}

function storeUrl(r: Reader): string {
  const value = r.required('EXPONETDB_CONTROL_STORE_URL')
  if (value === undefined) {
    return ''
  }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      url.username === '' ||
      url.password === '' ||
      url.hostname === '' ||
      url.pathname.length < 2
    ) {
      r.invalid('EXPONETDB_CONTROL_STORE_URL')
    }
  } catch {
    r.invalid('EXPONETDB_CONTROL_STORE_URL')
  }
  return value
}

type RoleBase = Omit<RoleConfig, 'installationId'> & {
  readonly installationId: InstallationId | undefined
}

/** After `done`, a required value is present; this only satisfies the type system. */
function present(base: RoleBase): RoleConfig {
  const { installationId } = base
  if (installationId === undefined) {
    throw new ConfigError([{ variable: 'EXPONETDB_INSTALLATION_ID', reason: 'missing' }])
  }
  return { ...base, installationId }
}

function roleBase(r: Reader, role: RoleName): RoleBase {
  const declared = r.raw('EXPONETDB_ROLE')
  if (declared !== undefined && declared !== role) {
    r.invalid('EXPONETDB_ROLE', 'role_mismatch')
  }
  const installation = r.required('EXPONETDB_INSTALLATION_ID')
  if (installation !== undefined && !isId('ins', installation)) {
    r.invalid('EXPONETDB_INSTALLATION_ID')
  }
  const inline = r.raw('EXPONETDB_KEYRING')
  const file = r.raw('EXPONETDB_KEYRING_FILE')
  if (inline === undefined && file === undefined) {
    r.invalid('EXPONETDB_KEYRING', 'missing')
  }
  if (inline !== undefined && file !== undefined) {
    r.invalid('EXPONETDB_KEYRING_FILE', 'keyring_ambiguous')
  }
  const timeout = Number(r.raw('EXPONETDB_SHUTDOWN_TIMEOUT_MS') ?? '25000')
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300_000) {
    r.invalid('EXPONETDB_SHUTDOWN_TIMEOUT_MS')
  }
  return {
    ...common(r),
    role,
    controlStoreUrl: storeUrl(r),
    installationId: isId('ins', installation) ? installation : undefined,
    keyringEnv: { EXPONETDB_KEYRING: inline, EXPONETDB_KEYRING_FILE: file },
    internalListen: endpoint(r, 'EXPONETDB_INTERNAL_LISTEN', '127.0.0.1:9464'),
    shutdownTimeoutMs: timeout,
  }
}

const RP_ID =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
/** An IPv4 or IPv6 address, or a CIDR range of either family (prefix within the family's width). */
function validProxy(entry: string): boolean {
  const [base = '', bits, extra] = entry.split('/')
  const version = isIP(base)
  if (extra !== undefined || version === 0) {
    return false
  }
  return (
    bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128))
  )
}

function publicOrigin(r: Reader): string {
  const url = httpsUrl(r, 'EXPONETDB_PUBLIC_URL', r.required('EXPONETDB_PUBLIC_URL'))
  if (url === undefined) {
    return ''
  }
  const parsed = new URL(url)
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    r.invalid('EXPONETDB_PUBLIC_URL', 'origin_only')
  }
  return parsed.origin
}

function rpId(r: Reader, origin: string): string | undefined {
  const value = r.raw('EXPONETDB_WEBAUTHN_RP_ID')
  if (value === undefined || origin === '') {
    return value
  }
  const host = new URL(origin).hostname
  if (!RP_ID.test(value) || !(host === value || host.endsWith(`.${value}`))) {
    return r.invalid('EXPONETDB_WEBAUTHN_RP_ID', 'not_the_host_or_a_parent')
  }
  return value
}

export function serveConfig(env: Env): ServeConfig {
  const r = new Reader(env, 'serve')
  const base = present(r.done(roleBase(r, 'serve')))
  const origin = publicOrigin(r)
  const proxies = (r.raw('EXPONETDB_TRUSTED_PROXIES') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (proxies.length > 16 || proxies.some((p) => !validProxy(p))) {
    r.invalid('EXPONETDB_TRUSTED_PROXIES')
  }
  const egress = (r.raw('EXPONETDB_EGRESS_ADDRESSES') ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
  if (egress.length > 8 || egress.some((a) => isIP(a) === 0 || a !== a.toLowerCase())) {
    r.invalid('EXPONETDB_EGRESS_ADDRESSES')
  }
  return r.done({
    ...base,
    role: 'serve',
    listen: endpoint(r, 'EXPONETDB_LISTEN', '0.0.0.0:8080'),
    publicUrl: origin,
    webauthnRpId: rpId(r, origin),
    trustedProxies: proxies,
    egressAddresses: [...new Set(egress)],
  })
}

export function authOperatorConfig(env: Env): AuthOperatorConfig {
  const r = new Reader(env, 'auth_operator')
  const base = common(r)
  const controlStoreUrl = storeUrl(r)
  const origin = publicOrigin(r)
  return r.done({ ...base, controlStoreUrl, publicUrl: origin, webauthnRpId: rpId(r, origin) })
}

function auditExport(r: Reader): AuditExportConfig {
  const dir = r.raw('EXPONETDB_AUDIT_EXPORT_DIR')
  const s3 = r.raw('EXPONETDB_AUDIT_S3_ENDPOINT')
  if (dir !== undefined && s3 !== undefined) {
    r.invalid('EXPONETDB_AUDIT_EXPORT_DIR', 'one_export_sink_only')
  }
  if (dir !== undefined) {
    return dir.startsWith('/')
      ? { kind: 'file', directory: dir }
      : (r.invalid('EXPONETDB_AUDIT_EXPORT_DIR') ?? { kind: 'none' })
  }
  if (s3 === undefined) {
    for (const name of Object.keys(VARIABLES).filter((n) => n.startsWith('EXPONETDB_AUDIT_S3_'))) {
      if (r.raw(name) !== undefined) {
        r.invalid(name, 'requires_EXPONETDB_AUDIT_S3_ENDPOINT')
      }
    }
    return { kind: 'none' }
  }
  const endpointUrl = httpsUrl(r, 'EXPONETDB_AUDIT_S3_ENDPOINT', s3) ?? ''
  const region = r.required('EXPONETDB_AUDIT_S3_REGION') ?? ''
  if (region !== '' && !/^[a-z0-9-]{1,32}$/.test(region)) {
    r.invalid('EXPONETDB_AUDIT_S3_REGION')
  }
  const bucket = r.required('EXPONETDB_AUDIT_S3_BUCKET') ?? ''
  if (bucket !== '' && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    r.invalid('EXPONETDB_AUDIT_S3_BUCKET')
  }
  const prefix = r.raw('EXPONETDB_AUDIT_S3_PREFIX')
  if (prefix !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(prefix)) {
    r.invalid('EXPONETDB_AUDIT_S3_PREFIX')
  }
  const mode = r.raw('EXPONETDB_AUDIT_S3_OBJECT_LOCK_MODE')
  const daysText = r.raw('EXPONETDB_AUDIT_S3_OBJECT_LOCK_DAYS')
  let objectLock: { mode: 'COMPLIANCE' | 'GOVERNANCE'; days: number } | undefined
  if (mode !== undefined || daysText !== undefined) {
    const days = Number(daysText)
    if (mode !== 'COMPLIANCE' && mode !== 'GOVERNANCE') {
      r.invalid('EXPONETDB_AUDIT_S3_OBJECT_LOCK_MODE')
    } else if (!Number.isInteger(days) || days < 1 || days > 36_500) {
      r.invalid('EXPONETDB_AUDIT_S3_OBJECT_LOCK_DAYS')
    } else {
      objectLock = { mode, days }
    }
  }
  return {
    kind: 's3',
    endpoint: endpointUrl,
    region,
    bucket,
    prefix,
    accessKeyId: r.required('EXPONETDB_AUDIT_S3_ACCESS_KEY_ID') ?? '',
    secretAccessKey: r.required('EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY') ?? '',
    objectLock,
  }
}

export function workerConfig(env: Env): WorkerConfig {
  const r = new Reader(env, 'worker')
  const base = roleBase(r, 'worker')
  const exportConfig = auditExport(r)
  return { ...present(r.done(base)), role: 'worker', auditExport: exportConfig }
}

export function gatewayConfig(env: Env): GatewayConfig {
  const r = new Reader(env, 'gateway')
  const base = roleBase(r, 'gateway')
  const agentListen =
    r.raw('EXPONETDB_GATEWAY_LISTEN') === undefined
      ? undefined
      : endpoint(r, 'EXPONETDB_GATEWAY_LISTEN', '')
  return { ...present(r.done(base)), role: 'gateway', agentListen }
}

/** `exponetdb node-pki init`: the worker login and the keyring. */
export function nodePkiCommandConfig(env: Env): StoreConfig & { keyringEnv: Env } {
  const r = new Reader(env, 'node_pki')
  const base = common(r)
  return r.done({
    ...base,
    controlStoreUrl: storeUrl(r),
    keyringEnv: {
      EXPONETDB_KEYRING: r.raw('EXPONETDB_KEYRING'),
      EXPONETDB_KEYRING_FILE: r.raw('EXPONETDB_KEYRING_FILE'),
    },
  })
}

/** One-shot commands that use one Control Store login (migrate, audit maintenance, read-only checks). */
export function storeCommandConfig(
  env: Env,
  program: 'migrate' | 'audit_maint' | 'readonly_store',
): StoreConfig {
  const r = new Reader(env, program)
  const base = common(r)
  return r.done({ ...base, controlStoreUrl: storeUrl(r) })
}

/** `exponetdb keyring status`: the keyring and a Control Store login to compare it with. */
export function keyringCommandConfig(env: Env): StoreConfig & { keyringEnv: Env } {
  const r = new Reader(env, 'keyring')
  const base = common(r)
  return r.done({
    ...base,
    controlStoreUrl: storeUrl(r),
    keyringEnv: {
      EXPONETDB_KEYRING: r.raw('EXPONETDB_KEYRING'),
      EXPONETDB_KEYRING_FILE: r.raw('EXPONETDB_KEYRING_FILE'),
    },
  })
}

/** Commands without a Control Store (`version`, `keyring generate`, `bootstrap-sql`): only the log level. */
export function plainCommandConfig(env: Env): Pick<CommonConfig, 'logLevel'> {
  const r = new Reader(env, 'keyring')
  for (const name of [
    'EXPONETDB_CONTROL_STORE_URL',
    'EXPONETDB_KEYRING',
    'EXPONETDB_KEYRING_FILE',
  ]) {
    if (r.raw(name) !== undefined) {
      r.invalid(name, 'not_used_by_this_command')
    }
  }
  const level = r.raw('EXPONETDB_LOG_LEVEL') ?? 'info'
  return r.done({
    logLevel: isLogLevel(level) ? level : (r.invalid('EXPONETDB_LOG_LEVEL') ?? 'info'),
  })
}
