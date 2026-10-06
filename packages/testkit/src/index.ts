export {
  HOSTILE_SCHEMA,
  HOSTILE_TABLE_NAMES,
  hostileRoleStatements,
  hostileStatements,
  LONG_NAME,
  TRUNCATED_LONG_NAME,
} from './fixtures/hostile.ts'
export {
  CONSUMER_SCHEMA,
  CONSUMER_SIZED,
  consumerSizedStatements,
  LARGE_CATALOG,
  LARGE_SCHEMA,
  type LargeCatalogShape,
  largeCatalogStatements,
} from './fixtures/large-catalog.ts'
export {
  reosaShapedEventTriggerStatements,
  reosaShapedRoleStatements,
  reosaShapedStatements,
  SHAPED_SCHEMA,
} from './fixtures/reosa-shaped.ts'
export { FaultProxy, type ProxyMode } from './proxy.ts'
export { loginPassword, provisionRoles, type RoleProvisioning } from './roles.ts'
export {
  createDatabase,
  dropDatabase,
  matrix,
  runAsSuperuser,
  serverFor,
  superuserClient,
  TEST_TARGETS_ENV,
  type TestServer,
  type TestTargets,
  testRolePassword,
  testTargets,
  testTls,
  uniqueDatabaseName,
  withSuperuser,
} from './servers.ts'
export { databaseFromFixture, ensureTemplate, type Fixture } from './templates.ts'
