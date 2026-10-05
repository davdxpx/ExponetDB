import { InvariantError } from '@exponetdb/kernel'
import { LABELS, type MetricsRegistry, type SpanAttributes } from '@exponetdb/observability'
import pg from 'pg'
import { ControlStoreError, toControlStoreError } from './errors.ts'
import type { ControlStoreRole } from './roles.ts'
import { Row, rowsOf } from './rows.ts'

/**
 * The connection and transaction boundary of the Control Store
 * ([control-database.md](../../../exponetdb-docs/02-control-plane/control-database.md)).
 *
 * - One pool per process role and login; packages never open their own.
 * - Every statement names a static **query class** (`audit.append`,
 *   `operation.claim`): it labels the duration metric and the trace span. SQL
 *   text and parameters never become labels, attributes or log fields.
 * - Every statement is parameterized (`$1`, `$2`, …). Identifiers are never
 *   built from untrusted text.
 * - Transactions take an explicit handle (`Tx`) that packages share, so a
 *   state change and its audit event commit together. A handle is unusable
 *   after its transaction ends. Nested work uses savepoints explicitly; there
 *   are no nested pseudo-transactions.
 * - Driver errors become {@link ControlStoreError}: a code and a SQLSTATE,
 *   never the driver message or `DETAIL`.
 */
export type QueryClass = string
const QUERY_CLASS = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export interface QueryResult {
  readonly rows: readonly Row[]
  readonly rowCount: number
}

export interface ScriptStatementResult {
  readonly columns: readonly { readonly name: string; readonly typeOid: number }[]
  readonly rows: readonly Row[]
}

export interface Queryable {
  query(queryClass: QueryClass, sql: string, params?: readonly unknown[]): Promise<QueryResult>
}

export interface Tx extends Queryable {
  /** Runs `fn` inside a savepoint; an error rolls back to it and is rethrown. */
  savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /**
   * Executes a reviewed, shipped SQL script (simple query protocol, several
   * statements) inside this transaction. Only the Control Store migration
   * runner uses it, for its own bundles; never for anything a caller sent.
   */
  executeScript(queryClass: QueryClass, script: string): Promise<readonly ScriptStatementResult[]>
}

export type Isolation = 'read committed' | 'repeatable read' | 'serializable'
export interface TransactionOptions {
  readonly isolation?: Isolation
  readonly readOnly?: boolean
  /** End with ROLLBACK even when `fn` resolves (verification runs). */
  readonly rollbackOnly?: boolean
}

/** A dedicated connection (session advisory locks, the migration runner). */
export interface Session extends Queryable {
  transaction<T>(
    queryClass: QueryClass,
    fn: (tx: Tx) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>
}

export interface QueryObservation {
  readonly role: ControlStoreRole
  readonly queryClass: QueryClass
  readonly outcome: 'ok' | 'error' | 'timeout'
  readonly seconds: number
}

export interface ControlStoreObserver {
  query(observation: QueryObservation): void
}

/** Registers `exdb_control_store_query_duration_seconds` once per registry. */
export function controlStoreMetrics(registry: MetricsRegistry): ControlStoreObserver {
  const histogram = registry.histogram(
    'exdb_control_store_query_duration_seconds',
    'Duration of Control Store statements by process role and static query class.',
    {
      role: { values: ['migrate', 'serve', 'worker', 'gateway', 'audit_maint'] },
      query_class: LABELS.queryClass,
      outcome: LABELS.outcome,
    },
  )
  return {
    query: (o) =>
      histogram.observe(
        { role: o.role.replace(/^exdb_/, ''), query_class: o.queryClass, outcome: o.outcome },
        o.seconds,
      ),
  }
}

export interface SpanRunner {
  withSpan<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T>
}

export interface ControlStoreOptions {
  /** Connection URL of this role's own login. Never logged. */
  readonly url: string
  /** The login this store must be (checked by {@link ControlStore.verifyLogin}). */
  readonly role: ControlStoreRole
  readonly applicationName?: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
  readonly idleInTransactionTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly observer?: ControlStoreObserver
  readonly tracing?: SpanRunner
  /** Called with a safe error when an idle pooled connection fails. */
  readonly onPoolError?: (error: ControlStoreError) => void
}

export interface LoginFacts {
  readonly role: string
  readonly database: string
  readonly serverVersionNum: number
  readonly superuser: boolean
  readonly createRole: boolean
  readonly createDb: boolean
  readonly replication: boolean
  readonly bypassRls: boolean
  readonly memberships: number
}

function checkQueryClass(queryClass: QueryClass): void {
  if (!QUERY_CLASS.test(queryClass)) {
    throw new InvariantError('query classes are static dotted identifiers')
  }
}

function beginStatement(options: TransactionOptions | undefined): string {
  const isolation = options?.isolation ?? 'read committed'
  const mode = options?.readOnly === true ? 'READ ONLY' : 'READ WRITE'
  switch (isolation) {
    case 'read committed':
      return `BEGIN ISOLATION LEVEL READ COMMITTED ${mode}`
    case 'repeatable read':
      return `BEGIN ISOLATION LEVEL REPEATABLE READ ${mode}`
    case 'serializable':
      return `BEGIN ISOLATION LEVEL SERIALIZABLE ${mode}`
  }
}

type Client = pg.PoolClient | pg.Client

class Executor {
  readonly #role: ControlStoreRole
  readonly #observer: ControlStoreObserver | undefined
  readonly #tracing: SpanRunner | undefined

  constructor(role: ControlStoreRole, observer?: ControlStoreObserver, tracing?: SpanRunner) {
    this.#role = role
    this.#observer = observer
    this.#tracing = tracing
  }

  async run<T>(queryClass: QueryClass, work: () => Promise<T>): Promise<T> {
    checkQueryClass(queryClass)
    const started = performance.now()
    const observe = (outcome: QueryObservation['outcome']): void => {
      try {
        this.#observer?.query({
          role: this.#role,
          queryClass,
          outcome,
          seconds: (performance.now() - started) / 1000,
        })
      } catch {
        // Metrics never break a statement.
      }
    }
    const execute = async (): Promise<T> => {
      try {
        const result = await work()
        observe('ok')
        return result
      } catch (error) {
        const mapped = toControlStoreError(error)
        observe(mapped.code === 'control_store_timeout' ? 'timeout' : 'error')
        throw mapped
      }
    }
    return this.#tracing === undefined
      ? execute()
      : this.#tracing.withSpan('control_store.query', { 'exdb.query_class': queryClass }, execute)
  }

  async query(
    client: Client,
    queryClass: QueryClass,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult> {
    return this.run(queryClass, async () => {
      const result = await client.query({ text: sql, values: [...params] })
      return { rows: rowsOf(result.rows), rowCount: result.rowCount ?? 0 }
    })
  }

  async script(
    client: Client,
    queryClass: QueryClass,
    script: string,
  ): Promise<ScriptStatementResult[]> {
    return this.run(queryClass, async () => {
      // No values: node-postgres uses the simple query protocol, which runs
      // every statement of the script in order inside the open transaction.
      const raw: unknown = await client.query(script)
      const results: unknown[] = Array.isArray(raw) ? raw : [raw]
      return results.map((r) => {
        const fields: unknown =
          typeof r === 'object' && r !== null ? Reflect.get(r, 'fields') : undefined
        const rows: unknown =
          typeof r === 'object' && r !== null ? Reflect.get(r, 'rows') : undefined
        const columns = Array.isArray(fields)
          ? fields.map((f: unknown) => ({
              name: String(typeof f === 'object' && f !== null ? Reflect.get(f, 'name') : ''),
              typeOid: Number(
                typeof f === 'object' && f !== null ? Reflect.get(f, 'dataTypeID') : 0,
              ),
            }))
          : []
        const list: Record<string, unknown>[] = Array.isArray(rows) ? rows.filter(isRecord) : []
        return { columns, rows: list.map((x) => new Row(x)) }
      })
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class TxImpl implements Tx {
  readonly #client: Client
  readonly #executor: Executor
  #open = true
  #savepoints = 0

  constructor(client: Client, executor: Executor) {
    this.#client = client
    this.#executor = executor
  }

  close(): void {
    this.#open = false
  }

  #check(): void {
    if (!this.#open) {
      throw new InvariantError('transaction handle used after its transaction ended')
    }
  }

  async query(
    queryClass: QueryClass,
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult> {
    this.#check()
    return this.#executor.query(this.#client, queryClass, sql, params)
  }

  async executeScript(
    queryClass: QueryClass,
    script: string,
  ): Promise<readonly ScriptStatementResult[]> {
    this.#check()
    return this.#executor.script(this.#client, queryClass, script)
  }

  async savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.#check()
    this.#savepoints += 1
    const name = `exdb_sp_${this.#savepoints}`
    await this.#executor.query(this.#client, 'control_store.savepoint', `SAVEPOINT ${name}`)
    try {
      const result = await fn(this)
      await this.#executor.query(
        this.#client,
        'control_store.savepoint',
        `RELEASE SAVEPOINT ${name}`,
      )
      return result
    } catch (error) {
      await this.#executor
        .query(this.#client, 'control_store.savepoint', `ROLLBACK TO SAVEPOINT ${name}`)
        .catch(() => undefined)
      throw error
    }
  }
}

async function runTransaction<T>(
  client: Client,
  executor: Executor,
  queryClass: QueryClass,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions | undefined,
): Promise<T> {
  checkQueryClass(queryClass)
  await executor.query(client, `${queryClass}.begin`, beginStatement(options))
  const tx = new TxImpl(client, executor)
  let result: T
  try {
    result = await fn(tx)
  } catch (error) {
    tx.close()
    await executor.query(client, `${queryClass}.rollback`, 'ROLLBACK').catch(() => undefined)
    throw error
  }
  tx.close()
  if (options?.rollbackOnly === true) {
    await executor.query(client, `${queryClass}.rollback`, 'ROLLBACK')
    return result
  }
  // A failed COMMIT (lost connection) leaves the outcome unknown to this
  // process; it surfaces as an error and callers re-read before acting.
  await executor.query(client, `${queryClass}.commit`, 'COMMIT')
  return result
}

export class ControlStore implements Queryable {
  readonly role: ControlStoreRole
  readonly #pool: pg.Pool
  readonly #executor: Executor
  readonly #clientConfig: pg.ClientConfig
  readonly #onPoolError: ((error: ControlStoreError) => void) | undefined
  #closed = false

  constructor(options: ControlStoreOptions) {
    this.role = options.role
    this.#executor = new Executor(options.role, options.observer, options.tracing)
    this.#clientConfig = {
      connectionString: options.url,
      application_name:
        options.applicationName ?? `exponetdb-${options.role.replace(/^exdb_/, '')}`,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
      keepAlive: true,
    }
    this.#pool = new pg.Pool({
      ...this.#clientConfig,
      max: options.poolMax ?? 5,
      idleTimeoutMillis: 30_000,
    })
    this.#onPoolError = options.onPoolError
    this.#pool.on('error', (error: unknown) => {
      options.onPoolError?.(toControlStoreError(error))
    })
  }

  async #connect(): Promise<pg.PoolClient> {
    if (this.#closed) {
      throw new ControlStoreError('control_store_unavailable')
    }
    let client: pg.PoolClient
    try {
      client = await this.#pool.connect()
    } catch (error) {
      throw toControlStoreError(error)
    }
    // A checked-out client that loses its connection emits 'error'; without a
    // listener that would crash the process. The failing statement reports
    // the error to its caller; the listener only keeps the process alive.
    const onError = (error: unknown): void => {
      this.#onPoolError?.(toControlStoreError(error))
    }
    client.on('error', onError)
    const release = client.release.bind(client)
    client.release = (destroy?: boolean | Error) => {
      client.off('error', onError)
      client.release = release
      release(destroy)
    }
    return client
  }

  /** A single statement on a pooled connection (autocommit). */
  async query(
    queryClass: QueryClass,
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult> {
    const client = await this.#connect()
    let broken = false
    try {
      return await this.#executor.query(client, queryClass, sql, params)
    } catch (error) {
      broken = error instanceof ControlStoreError && error.code === 'control_store_unavailable'
      throw error
    } finally {
      client.release(broken)
    }
  }

  /** Runs `fn` in one transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  async transaction<T>(
    queryClass: QueryClass,
    fn: (tx: Tx) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const client = await this.#connect()
    let broken = true
    try {
      const result = await runTransaction(client, this.#executor, queryClass, fn, options)
      broken = false
      return result
    } finally {
      client.release(broken)
    }
  }

  /** A dedicated pooled connection for the duration of `fn`; released (and reset) afterwards. */
  async session<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const client = await this.#connect()
    let broken = false
    const executor = this.#executor
    const session: Session = {
      query: (queryClass, sql, params) => executor.query(client, queryClass, sql, params),
      transaction: (queryClass, body, options) =>
        runTransaction(client, executor, queryClass, body, options),
    }
    try {
      return await fn(session)
    } catch (error) {
      broken = true
      throw error
    } finally {
      // Session-level state (advisory locks, settings) must not leak into the pool.
      if (!broken) {
        await client.query('DISCARD ALL').catch(() => {
          broken = true
        })
      }
      client.release(broken)
    }
  }

  /**
   * A new connection outside the pool, closed after `fn` (verification runs
   * on its own connection that is never reused).
   */
  async isolated<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const client = new pg.Client(this.#clientConfig)
    client.on('error', () => undefined)
    try {
      await client.connect()
    } catch (error) {
      throw toControlStoreError(error)
    }
    const executor = this.#executor
    try {
      return await fn({
        query: (queryClass, sql, params) => executor.query(client, queryClass, sql, params),
        transaction: (queryClass, body, options) =>
          runTransaction(client, executor, queryClass, body, options),
      })
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  /** Facts about the login this store uses; the caller decides what is acceptable. */
  async loginFacts(): Promise<LoginFacts> {
    const { rows } = await this.query(
      'control_store.login_facts',
      `SELECT current_user::text AS role, current_database()::text AS database,
              current_setting('server_version_num')::int AS version_num,
              r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships
         FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    )
    const [row] = rows
    if (row === undefined) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return {
      role: row.text('role'),
      database: row.text('database'),
      serverVersionNum: row.int('version_num'),
      superuser: row.bool('rolsuper'),
      createRole: row.bool('rolcreaterole'),
      createDb: row.bool('rolcreatedb'),
      replication: row.bool('rolreplication'),
      bypassRls: row.bool('rolbypassrls'),
      memberships: row.int('memberships'),
    }
  }

  /**
   * Refuses a login that is not exactly the expected role or that holds any
   * privilege a Control Plane process must never have.
   */
  async verifyLogin(): Promise<LoginFacts> {
    const facts = await this.loginFacts()
    if (
      facts.role !== this.role ||
      facts.superuser ||
      facts.createRole ||
      facts.createDb ||
      facts.replication ||
      facts.bypassRls ||
      facts.memberships !== 0
    ) {
      throw new ControlStoreError('control_store_wrong_role')
    }
    return facts
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    await this.#pool.end().catch(() => undefined)
  }
}
