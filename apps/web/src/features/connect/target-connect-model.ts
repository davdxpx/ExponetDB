import { type ConnectEndpoint, connectionLines } from '../configuration/connect-model.ts'
import { shellWord } from './clients.ts'

/**
 * The Connect sheet of a target as data (ADR-0034 §4): its modes, the address parameter that
 * opens it, and the text a person copies for each mode. Pure, unit-tested with hostile input.
 *
 * Nothing here is a secret or builds one: ExponetDB never holds an application password, so the
 * role and the password are placeholders the person fills in (`<role>`, `[YOUR-PASSWORD]`, or an
 * environment variable). Host, port, database and TLS name come from the registry's endpoint and
 * database records, which only `registry.manage` may read; a value that is not safe to paste is
 * refused the way `connectionLines` refuses it, never escaped into something that looks right.
 */

export const CONNECT_MODES = ['direct', 'app', 'cli', 'mcp', 'api'] as const
export type ConnectMode = (typeof CONNECT_MODES)[number]

/** The address parameter of the sheet: `?connect=<mode>` (an allowlist value). */
export const CONNECT_PARAM = 'connect'
/** On a project's home, the environment the sheet is for: `?environment=<slug>`. */
export const CONNECT_ENVIRONMENT_PARAM = 'environment'

export function isConnectMode(value: unknown): value is ConnectMode {
  return typeof value === 'string' && (CONNECT_MODES as readonly string[]).includes(value)
}

export const APP_FRAMEWORKS = ['env', 'node', 'python', 'go'] as const
export type AppFramework = (typeof APP_FRAMEWORKS)[number]

export type AppSnippets =
  | { readonly kind: 'snippets'; readonly snippets: Readonly<Record<AppFramework, string>> }
  | { readonly kind: 'unsafe'; readonly what: 'database' | 'host' }

/** Where the CA certificate goes: a path the person fills in, never a file ExponetDB serves. */
const CA_PLACEHOLDER = '/path/to/postgresql-ca.pem'

/**
 * Driver templates for one endpoint and database, each with TLS checked against the server's
 * name (`verify-full` or the driver's equivalent). For an endpoint that is an address, the
 * certificate is checked against the TLS server name while the connection goes to the address
 * (libpq's `hostaddr`, node-postgres' `servername`, pgx's `TLSConfig.ServerName`).
 */
export function appSnippets(endpoint: ConnectEndpoint, database: string): AppSnippets {
  const lines = connectionLines(endpoint, database)
  if (lines.kind === 'unsafe') return lines
  const name = lines.address ? endpoint.tlsServerName : endpoint.host
  const address = lines.address ? endpoint.host : undefined
  const port = endpoint.port
  const env = [
    '# ExponetDB never holds application passwords: fill in the role and its password.',
    `PGHOST=${name}`,
    ...(address === undefined ? [] : [`PGHOSTADDR=${address}`]),
    `PGPORT=${port}`,
    `PGDATABASE=${database}`,
    'PGUSER=<role>',
    'PGPASSWORD=[YOUR-PASSWORD]',
    'PGSSLMODE=verify-full',
    `PGSSLROOTCERT=${CA_PLACEHOLDER}`,
  ].join('\n')
  const node = [
    '// npm install pg — reads PGUSER and PGPASSWORD from the environment.',
    "import { readFileSync } from 'node:fs'",
    "import pg from 'pg'",
    '',
    'const pool = new pg.Pool({',
    `  host: '${address ?? name}',`,
    `  port: ${port},`,
    `  database: '${database}',`,
    '  ssl: {',
    "    ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8'),",
    '    rejectUnauthorized: true,',
    ...(address === undefined ? [] : [`    servername: '${name}',`]),
    '  },',
    '})',
  ].join('\n')
  const python = [
    '# pip install "psycopg[binary]"',
    'import os',
    '',
    'import psycopg',
    '',
    'conn = psycopg.connect(',
    `    host="${name}",`,
    ...(address === undefined ? [] : [`    hostaddr="${address}",`]),
    `    port=${port},`,
    `    dbname="${database}",`,
    '    user=os.environ["PGUSER"],',
    '    password=os.environ["PGPASSWORD"],',
    '    sslmode="verify-full",',
    '    sslrootcert=os.environ["PGSSLROOTCERT"],',
    ')',
  ].join('\n')
  const go = [
    '// go get github.com/jackc/pgx/v5',
    '// DATABASE_URL=postgresql://<role>:[YOUR-PASSWORD]@' +
      `${(address ?? name).includes(':') ? `[${address ?? name}]` : (address ?? name)}:${port}/${database}` +
      `?sslmode=verify-full&sslrootcert=${CA_PLACEHOLDER}`,
    'config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))',
    'if err != nil {',
    '\treturn err',
    '}',
    ...(address === undefined
      ? []
      : [
          '// The address is not the certificate’s name: check the certificate against the name.',
          `config.ConnConfig.TLSConfig.ServerName = "${name}"`,
        ]),
    'pool, err := pgxpool.NewWithConfig(ctx, config)',
  ].join('\n')
  return { kind: 'snippets', snippets: { env, node, python, go } }
}

/** The ExponetDB CLI's own commands for a target: management over the REST API, never a database connection. */
export function cliCommands(origin: string, path: string): readonly string[] {
  return [
    `exponetdb login --server ${shellWord(origin)} --preset developer:nonprod`,
    `exponetdb target show ${shellWord(path)}`,
    `exponetdb migration status --target ${shellWord(path)}`,
    `exponetdb migration plan --target ${shellWord(path)}`,
  ]
}

/** The management API for a target: a `curl` line and the SDK, with the key from the environment. */
export function apiSnippets(
  origin: string,
  path: string,
): { readonly base: string; readonly curl: string; readonly sdk: string } {
  const base = `${origin}/api/v1`
  const url = `${base}/targets/${encodeURIComponent(path)}`
  return {
    base,
    curl: `curl -H "Authorization: Bearer $EXPONETDB_API_KEY" ${shellWord(url)}`,
    sdk: [
      "import { ExponetDB } from '@exponetdb/sdk'",
      '',
      'const exdb = new ExponetDB({',
      `  baseUrl: '${origin}',`,
      "  auth: { kind: 'apiKey', key: process.env.EXPONETDB_API_KEY },",
      '})',
      `const target = await exdb.targets.get('${path}')`,
      'if (!target.ok) throw new Error(target.error.code)',
    ].join('\n'),
  }
}
