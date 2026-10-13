import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import pg from 'pg'

/**
 * The disposable managed-target servers of the tests (`tooling/dev/targets.sh`
 * locally and in CI): PostgreSQL 16, 17 and 18 that accept TLS only, with a
 * server certificate from a CA generated for the run, and one PostgreSQL 17
 * without TLS. `EXDB_TEST_TARGETS` names the description file. Without it
 * the suites fail with an explanation; they are never skipped.
 */
export const TEST_TARGETS_ENV = 'EXDB_TEST_TARGETS'

export interface TestServer {
  readonly major: 16 | 17 | 18
  readonly host: string
  readonly port: number
  /** The container's name, for tools that run next to the server (pg_dump, pg_restore). */
  readonly container?: string
}

export interface TestTargets {
  readonly serverName: string
  readonly caPem: string
  readonly otherCaPem: string
  readonly serverCertPem: string
  readonly serverKeyPem: string
  readonly superuser: string
  readonly superuserPassword: string
  readonly servers: readonly TestServer[]
  readonly plaintext: TestServer
}

let cached: TestTargets | undefined

function field(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined
}

function server(value: unknown): TestServer {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const major = field(v, 'major')
  const host = field(v, 'host')
  const port = field(v, 'port')
  const container = field(v, 'container')
  if (
    (major !== 16 && major !== 17 && major !== 18) ||
    typeof host !== 'string' ||
    typeof port !== 'number'
  ) {
    throw new Error(`${TEST_TARGETS_ENV}: a server entry is malformed`)
  }
  return typeof container === 'string' ? { major, host, port, container } : { major, host, port }
}

export function testTargets(): TestTargets {
  if (cached !== undefined) {
    return cached
  }
  const file = process.env[TEST_TARGETS_ENV]
  if (file === undefined || file.length === 0) {
    throw new Error(
      `${TEST_TARGETS_ENV} is not set. The Wave 4 target tests need the disposable TLS servers: eval "$(bash tooling/dev/targets.sh)" (see exponetdb-docs/12-operations/local-development.md).`,
    )
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const text = (key: string): string => {
    const v = field(raw, key)
    if (typeof v !== 'string') throw new Error(`${TEST_TARGETS_ENV}: ${key} is missing`)
    return v
  }
  const servers = field(raw, 'servers')
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error(`${TEST_TARGETS_ENV}: no servers`)
  }
  cached = {
    serverName: text('serverName'),
    caPem: readFileSync(text('caFile'), 'utf8'),
    otherCaPem: readFileSync(text('otherCaFile'), 'utf8'),
    serverCertPem: readFileSync(text('serverCertFile'), 'utf8'),
    serverKeyPem: readFileSync(text('serverKeyFile'), 'utf8'),
    superuser: text('superuser'),
    superuserPassword: readFileSync(text('passwordFile'), 'utf8').trim(),
    servers: servers.map(server),
    plaintext: server(field(raw, 'plaintext')),
  }
  return cached
}

/** The servers of the version matrix, one per supported major. */
export function matrix(): readonly TestServer[] {
  return testTargets().servers
}

export function serverFor(major: 16 | 17 | 18): TestServer {
  const s = testTargets().servers.find((x) => x.major === major)
  if (s === undefined) {
    throw new Error(`${TEST_TARGETS_ENV}: no PostgreSQL ${major} server`)
  }
  return s
}

/** TLS settings for test superuser connections: verify-full against the run's CA. */
export function testTls(): pg.ClientConfig['ssl'] {
  const t = testTargets()
  return {
    ca: t.caPem,
    servername: t.serverName,
    rejectUnauthorized: true,
    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
      checkServerIdentity(t.serverName, cert),
  }
}

/** A superuser client of a test server (test setup only: product code never connects as a superuser). */
export async function superuserClient(s: TestServer, database = 'postgres'): Promise<pg.Client> {
  const t = testTargets()
  const client = new pg.Client({
    host: s.host,
    port: s.port,
    user: t.superuser,
    password: t.superuserPassword,
    database,
    ssl: testTls(),
    connectionTimeoutMillis: 10_000,
  })
  client.on('error', () => undefined)
  await client.connect()
  return client
}

/**
 * A login role's own session over verified TLS (test assertions on which
 * password a server accepts). Rejects with the server's error (its `code`).
 */
export async function loginClient(
  s: TestServer,
  user: string,
  password: string,
  database = 'postgres',
): Promise<pg.Client> {
  const client = new pg.Client({
    host: s.host,
    port: s.port,
    user,
    password,
    database,
    ssl: testTls(),
    connectionTimeoutMillis: 10_000,
  })
  client.on('error', () => undefined)
  await client.connect()
  return client
}

/** Whether a fresh login with the password succeeds (`28P01` and other refusals: false). */
export async function logsIn(s: TestServer, user: string, password: string): Promise<boolean> {
  try {
    const c = await loginClient(s, user, password)
    await c.end()
    return true
  } catch {
    return false
  }
}

export async function withSuperuser<T>(
  s: TestServer,
  database: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await superuserClient(s, database)
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** A password for a test login role, derived from the run's superuser secret (stable across suites). */
export function testRolePassword(role: string): string {
  return createHmac('sha256', testTargets().superuserPassword)
    .update(`exponetdb-target-test/${role}`)
    .digest('base64url')
}

/** A unique database name for one suite (lowercase, under 63 bytes). */
export function uniqueDatabaseName(label: string): string {
  const clean = label
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 30)
  return `exdb_t_${clean}_${randomBytes(5).toString('hex')}`
}

/** Creates an empty database (owned by the superuser) and returns its name. */
export async function createDatabase(s: TestServer, label: string): Promise<string> {
  const name = uniqueDatabaseName(label)
  await withSuperuser(s, 'postgres', async (c) => {
    await c.query(`CREATE DATABASE "${name}"`)
  })
  return name
}

/** The advisory lock of {@link withClusterTurn} (any constant no other suite uses). */
const CLUSTER_TURN_LOCK = 7_270_001

/**
 * Runs `fn` while holding this cluster's worker turn: a session advisory
 * lock on a superuser connection (which no role connection limit counts).
 * The product's role connection limits are per cluster (migrator 2,
 * verifier 4: one installation's budget), and parallel suites are several
 * installations on one shared test cluster, so the suites that run the
 * worker against it take turns instead of exhausting each other's budget.
 */
export async function withClusterTurn<T>(s: TestServer, fn: () => Promise<T>): Promise<T> {
  return withSuperuser(s, 'postgres', async (c) => {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [CLUSTER_TURN_LOCK])
    try {
      return await fn()
    } finally {
      await c
        .query('SELECT pg_advisory_unlock($1::bigint)', [CLUSTER_TURN_LOCK])
        .catch(() => undefined)
    }
  })
}

/** Drops a test database, ending its sessions first. */
export async function dropDatabase(s: TestServer, name: string): Promise<void> {
  if (!/^exdb_t_[a-z0-9_]+$/.test(name)) {
    throw new Error('only test databases are dropped')
  }
  await withSuperuser(s, 'postgres', async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  })
}

/**
 * Runs statements in a database as the superuser, under a cluster-wide
 * advisory lock when `lock` is given (role creation is cluster-wide, so
 * parallel suites take turns).
 */
export async function runAsSuperuser(
  s: TestServer,
  database: string,
  statements: readonly string[],
  lock?: number,
): Promise<void> {
  await withSuperuser(s, database, async (c) => {
    if (lock !== undefined) {
      await c.query('SELECT pg_advisory_lock($1::bigint)', [lock])
    }
    try {
      for (const statement of statements) {
        await c.query(statement)
      }
    } finally {
      if (lock !== undefined) {
        await c.query('SELECT pg_advisory_unlock($1::bigint)', [lock])
      }
    }
  })
}

/**
 * A checksum over everything a user could see change in a database's catalog
 * (relations with their columns, functions, schemas, large objects), read as
 * the superuser. Test assertions that a refused or read-only statement left
 * the database as it was; the temporary schemas of a session are excluded.
 */
export async function catalogChecksum(s: TestServer, database: string): Promise<string> {
  return withSuperuser(s, database, async (c) => {
    const { rows } = await c.query<{ checksum: string }>(
      `SELECT md5(string_agg(x, ',' ORDER BY x)) AS checksum FROM (
         SELECT 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relnatts AS x
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         UNION ALL
         SELECT 'col:' || a.attrelid || '.' || a.attname || ':' || a.atttypid
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attnum > 0 AND NOT a.attisdropped
            AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         UNION ALL
         SELECT 'fn:' || n.nspname || '.' || p.proname || ':' || p.oid
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         UNION ALL
         SELECT 'ns:' || nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
         UNION ALL
         SELECT 'lo:' || count(*) FROM pg_largeobject_metadata
       ) t`,
    )
    return String(rows[0]?.checksum)
  })
}
