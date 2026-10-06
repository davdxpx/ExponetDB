import {
  createDatabase,
  databaseFromFixture,
  type Fixture,
  loginPassword,
  provisionRoles,
  runAsSuperuser,
  type TestServer,
  testTargets,
} from '@exponetdb/testkit'
import {
  type AccessRole,
  type ConnectionSpec,
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  type Endpoint,
  type OpenOptions,
  passwordStatements,
  ROLE_NAMES,
  TargetSession,
} from '../src/index.ts'

/** Test glue: the run's servers with ExponetDB's roles from the product bootstrap SQL. */
export async function ensureRoles(server: TestServer): Promise<void> {
  await provisionRoles(server, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
}

export function endpoint(server: TestServer, overrides: Partial<Endpoint> = {}): Endpoint {
  const t = testTargets()
  return {
    host: server.host,
    port: server.port,
    tlsServerName: t.serverName,
    caPem: t.caPem,
    ...overrides,
  }
}

export function spec(
  server: TestServer,
  database: string,
  role: AccessRole,
  overrides: Partial<ConnectionSpec> = {},
): ConnectionSpec {
  return {
    endpoint: endpoint(server),
    database,
    role,
    user: ROLE_NAMES[role],
    password: loginPassword(ROLE_NAMES[role]),
    applicationName: `exponetdb/test/${role}`,
    ...overrides,
  }
}

/** A fresh database (empty or from a fixture) with the per-database bootstrap grants. */
export async function prepareDatabase(
  server: TestServer,
  label: string,
  fixture?: Fixture,
  extra: readonly string[] = [],
): Promise<string> {
  await ensureRoles(server)
  const database =
    fixture === undefined
      ? await createDatabase(server, label)
      : await databaseFromFixture(server, fixture, label)
  await runAsSuperuser(server, database, [...databaseBootstrapStatements(database), ...extra])
  return database
}

export function open(
  server: TestServer,
  database: string,
  role: AccessRole,
  options: OpenOptions = {},
  overrides: Partial<ConnectionSpec> = {},
): Promise<TargetSession> {
  return TargetSession.open(spec(server, database, role, overrides), options)
}
