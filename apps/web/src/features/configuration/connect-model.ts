import type { DatabaseView, EndpointView, ProbeResult } from '@exponetdb/sdk/operations'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * The connect panel as data: which endpoints an application can use, the
 * database of the target, and the two lines a person copies (a URI and a
 * `psql` command) with placeholders where a role and a password go. Pure
 * functions, unit-tested with hostile input.
 *
 * ExponetDB never holds an application password, so no line here carries one:
 * `<role>` and `[YOUR-PASSWORD]` are placeholders the person replaces. The
 * lines are built only from text that is safe to paste into a shell and a URI
 * (the names are untrusted registry text, C-26): anything else is left out and
 * said so, never escaped into something that looks right.
 */
export type ApplicationKind = 'private' | 'public' | 'pooler'

export interface ConnectEndpoint {
  readonly id: string
  readonly label: string
  readonly kind: ApplicationKind
  readonly poolerMode: 'session' | 'transaction' | null
  readonly host: string
  readonly port: number
  readonly tlsServerName: string
}

export interface ConnectModel {
  /** The name of the database placed on the target, when the cluster's list names it. */
  readonly database: string | undefined
  readonly endpoints: readonly ConnectEndpoint[]
  /** Active endpoints for the host's own sockets: not for applications, counted and left out. */
  readonly localSockets: number
  /** What the answers do not cover, in words (a partial read). */
  readonly missing: readonly string[]
}

export interface ConnectInput {
  readonly endpoints: {
    readonly items: readonly EndpointView[]
    readonly truncated: boolean
  }
  /** `undefined` while the databases could not be read; `databasesFailure` says why. */
  readonly databases:
    | { readonly items: readonly DatabaseView[]; readonly truncated: boolean }
    | undefined
  readonly databasesFailure?: string
  readonly targetId: string
}

export function connectModel(input: ConnectInput): ConnectModel {
  const missing: string[] = []
  if (input.endpoints.truncated) missing.push(t('configuration.connect.missing.endpoints'))
  let database: string | undefined
  if (input.databases === undefined) {
    missing.push(
      t('configuration.connect.missing.databaseFailed', {
        reason: input.databasesFailure ?? '',
      }),
    )
  } else {
    database = input.databases.items.find(
      (candidate) =>
        candidate.state === 'registered' && candidate.placement?.targetId === input.targetId,
    )?.name
    if (database === undefined) {
      missing.push(
        t(
          input.databases.truncated
            ? 'configuration.connect.missing.databases'
            : 'configuration.connect.missing.databaseUnknown',
        ),
      )
    }
  }
  const endpoints: ConnectEndpoint[] = []
  let localSockets = 0
  for (const endpoint of input.endpoints.items) {
    if (endpoint.state !== 'active') continue
    if (endpoint.kind === 'local_socket') {
      localSockets += 1
      continue
    }
    endpoints.push({
      id: endpoint.id,
      label: endpoint.label,
      kind: endpoint.kind,
      poolerMode: endpoint.poolerMode,
      host: endpoint.host,
      port: endpoint.port,
      tlsServerName: endpoint.tlsServerName,
    })
  }
  return { database, endpoints, localSockets, missing }
}

// ----- the lines a person copies -----

const SAFE_HOST = /^[A-Za-z0-9.:-]{1,253}$/
const SAFE_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const SAFE_DATABASE = /^[A-Za-z0-9_.-]{1,63}$/
const IPV4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/

/** Whether a host is an address (an IPv4 or IPv6 literal) rather than a DNS name. */
export function isAddress(host: string): boolean {
  return IPV4.test(host) || host.includes(':')
}

export type ConnectionLines =
  | {
      readonly kind: 'lines'
      readonly uri: string
      readonly psql: string
      readonly address: boolean
    }
  | { readonly kind: 'unsafe'; readonly what: 'database' | 'host' }

/**
 * The URI and the `psql` command for one endpoint and database, always with
 * `sslmode=verify-full`. For an endpoint that is an address, the server
 * certificate is checked against the TLS server name and the address goes in
 * `hostaddr` (libpq's way to check one name while connecting to another).
 * The role and the password are placeholders.
 */
/**
 * The user information of the URI: placeholders, never a credential. Kept apart
 * from the scheme so that no line of the source reads as a URL with credentials
 * to the repository's secret scanner.
 */
const USERINFO = '<role>:[YOUR-PASSWORD]'

export function connectionLines(endpoint: ConnectEndpoint, database: string): ConnectionLines {
  if (!SAFE_DATABASE.test(database)) return { kind: 'unsafe', what: 'database' }
  if (!SAFE_HOST.test(endpoint.host)) return { kind: 'unsafe', what: 'host' }
  const address = isAddress(endpoint.host) && endpoint.tlsServerName !== endpoint.host
  if (address && !SAFE_NAME.test(endpoint.tlsServerName)) return { kind: 'unsafe', what: 'host' }
  const name = address ? endpoint.tlsServerName : endpoint.host
  const bracketed = name.includes(':') ? `[${name}]` : name
  const hostaddr = address ? endpoint.host : undefined
  const uri =
    `postgresql://${USERINFO}@${bracketed}:${endpoint.port}/${database}` +
    `?sslmode=verify-full${hostaddr === undefined ? '' : `&hostaddr=${hostaddr}`}`
  const psql =
    `psql "host=${name} port=${endpoint.port} dbname=${database} user=<role> ` +
    `sslmode=verify-full${hostaddr === undefined ? '' : ` hostaddr=${hostaddr}`}"`
  return { kind: 'lines', uri, psql, address }
}

// ----- the endpoint check, from the probes of the health sample -----

export interface EndpointCheck {
  readonly total: number
  readonly ok: number
  readonly tls: 'verified' | 'failed' | 'not_reached' | 'mixed'
  readonly identityVerified: boolean
  /** The newest probe of the endpoint. */
  readonly observedAt: string
}

/**
 * What the recorded probes say about one endpoint: how many succeeded, what
 * TLS did and whether the endpoint's identity was verified. `undefined` when
 * no probe of the endpoint is recorded: an endpoint nobody probed is not
 * verified, and the panel says so. A probe is a recorded observation, never a
 * check this page made.
 */
export function endpointCheck(
  endpointId: string,
  probes: readonly ProbeResult[],
): EndpointCheck | undefined {
  const own = probes.filter((probe) => probe.endpoint.id === endpointId)
  if (own.length === 0) return undefined
  const verified = own.filter((probe) => probe.tls === 'verified').length
  const failed = own.some((probe) => probe.tls === 'failed')
  const tls = failed
    ? 'failed'
    : verified === own.length
      ? 'verified'
      : verified === 0
        ? 'not_reached'
        : 'mixed'
  const observedAt = own.reduce(
    (newest, probe) => (probe.observedAt > newest ? probe.observedAt : newest),
    own[0]?.observedAt ?? '',
  )
  return {
    total: own.length,
    ok: own.filter((probe) => probe.outcome === 'ok').length,
    tls,
    identityVerified: own.every((probe) => probe.endpoint.verified),
    observedAt,
  }
}
