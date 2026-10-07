import { connect as connectTcp, isIP } from 'node:net'
import { checkServerIdentity, connect as connectTls, type PeerCertificate } from 'node:tls'
import pg from 'pg'
import Cursor from 'pg-cursor'
import type { CircuitBreaker, ConnectionBudget } from './budget.ts'
import { mapDriverError, TargetError } from './errors.ts'
import { TargetRow } from './rows.ts'
import { isTrustedSql, sql, type TrustedSql } from './sql.ts'
import { majorOf, type SupportedMajor } from './versions.ts'

/**
 * Verified sessions to managed targets ([postgres-adapter.md §3](../../../exponetdb-docs/03-database-model/postgres-adapter.md#3-driver-and-connections),
 * [credentials-and-roles.md §6](../../../exponetdb-docs/03-database-model/credentials-and-roles.md#6-tls-to-managed-clusters)).
 *
 * - TLS is always `verify-full`: the endpoint's CA bundle only (never the
 *   system store), certificate verification on, and the certificate's names
 *   checked against the endpoint's `tlsServerName`. There is no option to
 *   relax it and no plaintext fallback.
 * - The password goes only into a SCRAM exchange (bound to the TLS
 *   connection when the server offers SCRAM-SHA-256-PLUS); a request for a
 *   cleartext or MD5 password is refused before anything is sent.
 * - The session pins its settings in the startup packet (`search_path`
 *   empty, UTC, ISO dates, timeouts), so nothing the server or a role
 *   default says changes how engine SQL is read.
 * - Guards run before the session is handed out: TLS really in use
 *   (`pg_stat_ssl`), `system_identifier` of the cluster, the database name,
 *   the server version; the identity marker for write-capable paths.
 * - Only `TrustedSql` is executed; values are bind parameters.
 * - Every query has a server-side `statement_timeout` and a client-side
 *   deadline behind it; a deadline that fires destroys the connection.
 */
export const ACCESS_ROLES = ['observer', 'reader', 'verifier', 'operator', 'migrator'] as const
export type AccessRole = (typeof ACCESS_ROLES)[number]

/** ExponetDB's own login roles on a managed cluster (role names are API). */
export const ROLE_NAMES: Readonly<Record<AccessRole, string>> = {
  observer: 'exponetdb_observer',
  reader: 'exponetdb_reader',
  verifier: 'exponetdb_verifier',
  operator: 'exponetdb_operator',
  migrator: 'exponetdb_migrator',
}
export const LEDGER_OWNER_ROLE = 'exponetdb_ledger_owner'

const READ_ONLY_ROLES: ReadonlySet<AccessRole> = new Set(['observer', 'reader', 'verifier'])

export interface Endpoint {
  /** DNS name or IP literal; never a URL, never with credentials. */
  readonly host: string
  readonly port: number
  /**
   * The name the server certificate must carry. For a DNS host it must equal
   * the host (the driver sends the host as SNI); for an IP host it is
   * required and names the certificate's DNS name.
   */
  readonly tlsServerName: string
  /** PEM CA bundle of the cluster; the system trust store is never used. */
  readonly caPem: string
}

export interface ConnectionSpec {
  readonly endpoint: Endpoint
  readonly database: string
  readonly role: AccessRole
  /** The login role; ExponetDB's own role for the path. */
  readonly user: string
  /** In memory only: never logged, never part of an error. */
  readonly password: string
  /** `exponetdb/<path>/<request or operation id>`, sanitized and capped. */
  readonly applicationName: string
}

export interface SessionGuards {
  /** The pinned `system_identifier`; omitted only when a cluster is being confirmed. */
  readonly systemIdentifier?: string
  /** The database the placement names (always checked). */
  readonly database?: string
}

export interface SessionLimits {
  readonly connectTimeoutMs: number
  readonly statementTimeoutMs: number
  readonly lockTimeoutMs: number
  readonly idleInTransactionMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  connectTimeoutMs: 5000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 2000,
  idleInTransactionMs: 30_000,
}

export interface SessionFacts {
  readonly systemIdentifier: string
  readonly database: string
  /** The connected database's oid: a dropped and re-created database of the same name has another. */
  readonly databaseOid: string
  readonly serverVersionNum: number
  readonly major: SupportedMajor
  readonly backendPid: number
  /** `backend_start` as text (UTC): with the pid, the identity of this backend. */
  readonly backendStart: string
  readonly user: string
}

export interface OpenOptions {
  readonly guards?: SessionGuards
  readonly limits?: Partial<SessionLimits>
  /** Per-cluster connection budget of this process; the key is the cluster id. */
  readonly budget?: {
    readonly pool: ConnectionBudget
    readonly key: string
    readonly waitMs?: number
  }
  /** Circuit breaker keyed by cluster or target. */
  readonly breaker?: { readonly breaker: CircuitBreaker; readonly key: string }
  /**
   * The protocol of the guard query that opens every session (default
   * `extended`, like every engine statement). Health probes open with
   * `simple` so a path whose extended protocol hangs still opens and the
   * two probes can tell "simple works, extended hangs" from "down".
   */
  readonly guardProtocol?: 'simple' | 'extended'
}

/** Registry rule for endpoints: refuses a TLS configuration that could not be verified as registered. */
export function endpointProblem(endpoint: Endpoint): 'host' | 'port' | 'server_name' | 'ca' | null {
  if (
    endpoint.host.length === 0 ||
    endpoint.host.length > 253 ||
    /[\s/@?#\\]/.test(endpoint.host) ||
    endpoint.host.includes('://')
  ) {
    return 'host'
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    return 'port'
  }
  const name = endpoint.tlsServerName
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(name) || isIP(name) !== 0) {
    return 'server_name'
  }
  if (isIP(endpoint.host) === 0 && endpoint.host.toLowerCase() !== name.toLowerCase()) {
    return 'server_name'
  }
  if (!endpoint.caPem.includes('-----BEGIN CERTIFICATE-----')) {
    return 'ca'
  }
  return null
}

const APP_NAME = /[^\x20-\x7e]/g

function applicationName(value: string): string {
  return value.replace(APP_NAME, '?').slice(0, 63)
}

function ms(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 86_400_000) {
    throw new RangeError('timeouts are whole milliseconds up to one day')
  }
  return String(value)
}

/** Startup options: the pinned settings of every ExponetDB session (schema-fingerprints.md §4). */
function startupOptions(role: AccessRole, limits: SessionLimits): string {
  return [
    'search_path=',
    'TimeZone=UTC',
    'DateStyle=ISO,YMD',
    'IntervalStyle=postgres',
    'extra_float_digits=1',
    'bytea_output=hex',
    'standard_conforming_strings=on',
    'quote_all_identifiers=off',
    // `money` constants deparse through lc_monetary (`'$12.34'::money` or `'12,34 €'::money`).
    'lc_monetary=C',
    `statement_timeout=${ms(limits.statementTimeoutMs)}`,
    `lock_timeout=${ms(limits.lockTimeoutMs)}`,
    `idle_in_transaction_session_timeout=${ms(limits.idleInTransactionMs)}`,
    `default_transaction_read_only=${READ_ONLY_ROLES.has(role) ? 'on' : 'off'}`,
  ]
    .map((s) => `-c ${s}`)
    .join(' ')
}

const RAW_TEXT = { getTypeParser: () => (value: string) => value }

/**
 * The authentication exchange the server asked for, seen before the driver
 * answers it (see `watchAuthentication`).
 */
interface AuthenticationSeen {
  method: 'scram' | 'refused' | undefined
}

/**
 * The password is given only to a SCRAM exchange. A server that asks for it
 * in cleartext or as MD5 (`password` or `md5` in `pg_hba.conf`, or a server
 * that is not the registered cluster but holds a certificate for its name)
 * receives nothing: the identity guards run only after authentication, so
 * the secret must not depend on them. The driver asks for the password from
 * its authentication handlers, which it attaches in `connect()`, after the
 * listeners added here, so the method is known when the password is asked.
 */
function watchAuthentication(client: pg.Client, seen: AuthenticationSeen): void {
  client.connection.on('authenticationSASL', () => {
    seen.method ??= 'scram'
  })
  for (const event of ['authenticationCleartextPassword', 'authenticationMD5Password']) {
    client.connection.on(event, () => {
      seen.method = 'refused'
    })
  }
}

function clientConfig(
  spec: ConnectionSpec,
  limits: SessionLimits,
  seen: AuthenticationSeen,
): pg.ClientConfig {
  const expected = spec.endpoint.tlsServerName
  return {
    host: spec.endpoint.host,
    port: spec.endpoint.port,
    database: spec.database,
    user: spec.user,
    password: async () => {
      if (seen.method !== 'scram') {
        throw new TargetError('TARGET_CREDENTIAL_INVALID', 'auth_method')
      }
      return spec.password
    },
    application_name: applicationName(spec.applicationName),
    options: startupOptions(spec.role, limits),
    connectionTimeoutMillis: limits.connectTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    types: RAW_TEXT,
    // SCRAM-SHA-256-PLUS when the server offers it (PostgreSQL over TLS does;
    // a pooler may not): the exchange is then bound to this TLS connection.
    enableChannelBinding: true,
    ssl: {
      ca: spec.endpoint.caPem,
      servername: expected,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      // Verification is pinned to the registered name, whatever SNI the driver sends.
      checkServerIdentity: (_host: string, cert: PeerCertificate) =>
        checkServerIdentity(expected, cert),
    },
  }
}

export interface QueryOptions {
  /** Client-side deadline; defaults to the statement timeout plus a grace second. */
  readonly timeoutMs?: number
  /** `simple` only for parameter-free probes; everything else uses the extended protocol. */
  readonly protocol?: 'simple' | 'extended'
}

const GUARD_SQL = sql`SELECT (SELECT s.system_identifier::text FROM pg_catalog.pg_control_system() s) AS system_identifier,
       pg_catalog.current_database() AS database,
       (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS database_oid,
       pg_catalog.current_setting('server_version_num') AS version_num,
       pg_catalog.pg_backend_pid() AS pid,
       (SELECT a.backend_start::text FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid()) AS backend_start,
       (SELECT l.ssl FROM pg_catalog.pg_stat_ssl l WHERE l.pid = pg_catalog.pg_backend_pid()) AS ssl,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles s
                WHERE s.rolsuper AND pg_catalog.pg_has_role(session_user, s.oid, 'MEMBER')) AS superuser,
       session_user AS login`

export class TargetSession {
  readonly facts: SessionFacts
  readonly role: AccessRole
  readonly #client: pg.Client
  readonly #spec: ConnectionSpec
  readonly #limits: SessionLimits
  readonly #release: (() => void) | undefined
  #broken = false
  #closed = false

  private constructor(
    client: pg.Client,
    spec: ConnectionSpec,
    limits: SessionLimits,
    facts: SessionFacts,
    release: (() => void) | undefined,
  ) {
    this.#client = client
    this.#spec = spec
    this.#limits = limits
    this.facts = facts
    this.role = spec.role
    this.#release = release
  }

  /** Opens and guards a session; nothing is returned before every guard passed. */
  static async open(spec: ConnectionSpec, options: OpenOptions = {}): Promise<TargetSession> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    const problem = endpointProblem(spec.endpoint)
    if (problem !== null) {
      throw new TargetError(
        problem === 'server_name' || problem === 'ca' ? 'TARGET_TLS_FAILED' : 'TARGET_UNAVAILABLE',
        problem === 'server_name'
          ? 'tls_hostname'
          : problem === 'ca'
            ? 'tls_unverified'
            : 'protocol',
      )
    }
    options.breaker?.breaker.check(options.breaker.key)
    const release =
      options.budget === undefined
        ? undefined
        : await options.budget.pool.acquire(
            options.budget.key,
            options.budget.waitMs ?? limits.connectTimeoutMs,
          )
    const seen: AuthenticationSeen = { method: undefined }
    const client = new pg.Client(clientConfig(spec, limits, seen))
    watchAuthentication(client, seen)
    // Errors on an idle client must never crash the process; the session is then broken.
    let broken = false
    client.on('error', () => {
      broken = true
    })
    // Notices can carry data; they are not kept.
    client.on('notice', () => undefined)
    try {
      await client.connect()
    } catch (error) {
      release?.()
      await client.end().catch(() => undefined)
      const mapped = mapDriverError(error, 'connect')
      if (mapped.code === 'TARGET_UNAVAILABLE' || mapped.code === 'TARGET_TLS_FAILED') {
        options.breaker?.breaker.failure(options.breaker.key)
      }
      throw mapped
    }
    options.breaker?.breaker.success(options.breaker.key)
    let facts: SessionFacts
    try {
      // The guard has the connect deadline: a path that accepts the connection but never
      // answers (a hung pooler) fails here instead of hanging the caller.
      const result = await client.query({
        text: GUARD_SQL.text,
        query_timeout: limits.connectTimeoutMs,
        ...(options.guardProtocol === 'simple' ? {} : { queryMode: 'extended' }),
      } as never)
      const row = new TargetRow((result as pg.QueryResult).rows[0] ?? {})
      const versionNum = row.int('version_num')
      const major = majorOf(versionNum)
      if (row.textOrNull('ssl') !== 't') {
        throw new TargetError('TARGET_TLS_FAILED', 'tls_unavailable')
      }
      // Never a superuser over the network (C-21): checked on every session, not only
      // when the credential was verified, so a later ALTER ROLE … SUPERUSER is noticed.
      if (row.bool('superuser')) {
        throw new TargetError('TARGET_CREDENTIAL_INVALID', 'superuser_login')
      }
      facts = {
        systemIdentifier: row.text('system_identifier'),
        database: row.text('database'),
        databaseOid: row.text('database_oid'),
        serverVersionNum: versionNum,
        major,
        backendPid: row.int('pid'),
        backendStart: row.text('backend_start'),
        user: row.text('login'),
      }
      const guards = options.guards ?? {}
      if (
        guards.systemIdentifier !== undefined &&
        guards.systemIdentifier !== facts.systemIdentifier
      ) {
        throw new TargetError('CLUSTER_IDENTITY_MISMATCH', 'system_identifier')
      }
      if ((guards.database ?? spec.database) !== facts.database) {
        throw new TargetError('TARGET_IDENTITY_MISMATCH', 'database_name')
      }
    } catch (error) {
      release?.()
      await client.end().catch(() => undefined)
      const mapped = mapDriverError(error, 'query')
      // A guard that did not answer within the connect deadline: the path did not open.
      throw mapped.reason === 'query_timeout'
        ? new TargetError('TARGET_UNAVAILABLE', 'connect_timeout')
        : mapped
    }
    const session = new TargetSession(client, spec, limits, facts, release)
    if (broken) {
      session.#broken = true
    }
    client.removeAllListeners('error')
    client.on('error', () => {
      session.#broken = true
    })
    return session
  }

  get usable(): boolean {
    return !this.#broken && !this.#closed
  }

  /** Runs engine SQL with bind parameters; rows as text values. */
  async query(
    statement: TrustedSql,
    params: readonly (string | number | boolean | null)[] = [],
    options: QueryOptions = {},
  ): Promise<TargetRow[]> {
    if (!isTrustedSql(statement)) {
      throw new TypeError('only engine SQL (TrustedSql) runs on an engine path')
    }
    if (!this.usable) {
      throw new TargetError('TARGET_UNAVAILABLE', 'session_closed')
    }
    if (options.protocol === 'simple' && params.length > 0) {
      throw new TypeError('the simple protocol carries no parameters')
    }
    const deadline = options.timeoutMs ?? this.#limits.statementTimeoutMs + 1000
    try {
      const config = {
        text: statement.text,
        values: params.map((p) =>
          typeof p === 'number' || typeof p === 'boolean' ? String(p) : p,
        ),
        query_timeout: deadline,
        ...(options.protocol === 'simple' ? {} : { queryMode: 'extended' }),
      }
      const result = (await this.#client.query(config as never)) as pg.QueryResult
      return result.rows.map((r) => new TargetRow(r as Record<string, unknown>))
    } catch (error) {
      const mapped = mapDriverError(error, 'query')
      if (mapped.reason === 'query_timeout' || mapped.code === 'TARGET_UNAVAILABLE') {
        // A client-side deadline leaves the protocol state unknown: the connection is gone.
        this.#broken = true
        await this.close()
      }
      throw mapped
    }
  }

  /**
   * A read-only transaction (`REPEATABLE READ READ ONLY`, an engine `SELECT 1`
   * first so `SET TRANSACTION READ WRITE` is no longer possible), always
   * rolled back. Local timeouts are set inside the transaction.
   */
  async readOnly<T>(
    fn: (tx: ReadOnlyTransaction) => Promise<T>,
    options: { readonly statementTimeoutMs?: number; readonly lockTimeoutMs?: number } = {},
  ): Promise<T> {
    await this.query(sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`)
    try {
      await this.query(sql`SELECT 1`)
      await this.#setLocal(options)
      return await fn(new ReadOnlyTransaction(this))
    } finally {
      if (this.usable) {
        await this.query(sql`ROLLBACK`).catch(() => undefined)
      }
    }
  }

  /** A read-write transaction (write-capable paths only): committed when `fn` returns, rolled back otherwise. */
  async transaction<T>(
    fn: () => Promise<T>,
    options: { readonly statementTimeoutMs?: number; readonly lockTimeoutMs?: number } = {},
  ): Promise<T> {
    if (READ_ONLY_ROLES.has(this.role)) {
      throw new TypeError(`a ${this.role} session never opens a read-write transaction`)
    }
    await this.query(sql`BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`)
    let committed = false
    try {
      await this.#setLocal(options)
      const value = await fn()
      await this.query(sql`COMMIT`)
      committed = true
      return value
    } finally {
      if (!committed && this.usable) {
        await this.query(sql`ROLLBACK`).catch(() => undefined)
      }
    }
  }

  async #setLocal(options: {
    readonly statementTimeoutMs?: number
    readonly lockTimeoutMs?: number
  }): Promise<void> {
    if (options.statementTimeoutMs !== undefined) {
      await this.query(sql`SELECT pg_catalog.set_config('statement_timeout', $1, true)`, [
        `${ms(options.statementTimeoutMs)}ms`,
      ])
    }
    if (options.lockTimeoutMs !== undefined) {
      await this.query(sql`SELECT pg_catalog.set_config('lock_timeout', $1, true)`, [
        `${ms(options.lockTimeoutMs)}ms`,
      ])
    }
  }

  /** Reads a capped number of rows through a server-side cursor (inside a transaction). */
  async readCursor(
    statement: TrustedSql,
    params: readonly (string | number | boolean | null)[],
    maxRows: number,
  ): Promise<{ readonly rows: TargetRow[]; readonly truncated: boolean }> {
    if (!isTrustedSql(statement)) {
      throw new TypeError('only engine SQL (TrustedSql) runs on an engine path')
    }
    const cursor = this.#client.query(
      new Cursor(
        statement.text,
        params.map((p) => (typeof p === 'number' || typeof p === 'boolean' ? String(p) : p)),
        { types: RAW_TEXT } as never,
      ),
    )
    try {
      const rows = (await cursor.read(maxRows + 1)) as Record<string, unknown>[]
      return {
        rows: rows.slice(0, maxRows).map((r) => new TargetRow(r)),
        truncated: rows.length > maxRows,
      }
    } catch (error) {
      throw mapDriverError(error, 'query')
    } finally {
      await cursor.close().catch(() => undefined)
    }
  }

  /**
   * Sends a protocol CancelRequest for this session's running statement on a
   * new connection with the same TLS verification (process id and secret
   * key of this backend only; it can never hit another backend).
   */
  async cancel(): Promise<void> {
    const keys = this.#client as pg.Client & { processID?: number; secretKey?: number }
    if (typeof keys.processID !== 'number' || typeof keys.secretKey !== 'number') {
      return
    }
    await sendCancel(
      this.#spec.endpoint,
      keys.processID,
      keys.secretKey,
      this.#limits.connectTimeoutMs,
    )
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    try {
      if (this.#broken) {
        destroy(this.#client)
      } else {
        await Promise.race([
          this.#client.end(),
          new Promise((resolve) => setTimeout(resolve, 2000).unref()),
        ])
        destroy(this.#client)
      }
    } finally {
      this.#release?.()
    }
  }
}

const SSL_REQUEST = 80877103
const CANCEL_REQUEST = 80877102

/** SSLRequest, then a verified TLS handshake, then the 16-byte CancelRequest. */
function sendCancel(
  endpoint: Endpoint,
  pid: number,
  key: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const raw = connectTcp(endpoint.port, endpoint.host)
    const timer = setTimeout(() => {
      raw.destroy()
      reject(new TargetError('TARGET_UNAVAILABLE', 'connect_timeout'))
    }, timeoutMs)
    const fail = (error: unknown) => {
      clearTimeout(timer)
      raw.destroy()
      reject(mapDriverError(error, 'connect'))
    }
    raw.once('error', fail)
    raw.once('connect', () => {
      const request = Buffer.alloc(8)
      request.writeInt32BE(8, 0)
      request.writeInt32BE(SSL_REQUEST, 4)
      raw.write(request)
      raw.once('data', (answer: Buffer) => {
        if (answer.toString('latin1', 0, 1) !== 'S') {
          fail(new TargetError('TARGET_TLS_FAILED', 'tls_unavailable'))
          return
        }
        const secure = connectTls({
          socket: raw,
          ca: endpoint.caPem,
          servername: endpoint.tlsServerName,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(endpoint.tlsServerName, cert),
        })
        secure.once('error', fail)
        secure.once('secureConnect', () => {
          const cancel = Buffer.alloc(16)
          cancel.writeInt32BE(16, 0)
          cancel.writeInt32BE(CANCEL_REQUEST, 4)
          cancel.writeInt32BE(pid, 8)
          cancel.writeInt32BE(key, 12)
          secure.end(cancel, () => {
            clearTimeout(timer)
            resolve()
          })
        })
      })
    })
  })
}

/** The connection's socket is closed without waiting for the server (after a deadline or on error). */
function destroy(client: pg.Client): void {
  const internal = client as pg.Client & { connection?: { stream?: { destroy?: () => void } } }
  internal.connection?.stream?.destroy?.()
}

/** Queries inside a read-only transaction; the same rules as the session. */
export class ReadOnlyTransaction {
  readonly #session: TargetSession

  constructor(session: TargetSession) {
    this.#session = session
  }

  get facts(): SessionFacts {
    return this.#session.facts
  }

  query(
    statement: TrustedSql,
    params: readonly (string | number | boolean | null)[] = [],
    options: QueryOptions = {},
  ): Promise<TargetRow[]> {
    return this.#session.query(statement, params, options)
  }

  readCursor(
    statement: TrustedSql,
    params: readonly (string | number | boolean | null)[],
    maxRows: number,
  ) {
    return this.#session.readCursor(statement, params, maxRows)
  }
}
