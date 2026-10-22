export {
  type ClusterGlobalHistory,
  clusterGlobalHistory,
} from './fixtures/cluster-global-history.ts'
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
export { type LargeHistoryOptions, largeLegacyHistory } from './fixtures/large-history.ts'
export {
  LEGACY_ALIASES,
  LEGACY_FILES,
  LEGACY_NOT_APPLICABLE,
  type LegacyFile,
  legacyTargetStatements,
} from './fixtures/legacy-history.ts'
export {
  reosaShapedEventTriggerStatements,
  reosaShapedRoleStatements,
  reosaShapedStatements,
  SHAPED_SCHEMA,
} from './fixtures/reosa-shaped.ts'
export {
  SUPABASE_ALIASES,
  SUPABASE_FILES,
  supabaseTargetStatements,
} from './fixtures/supabase-history.ts'
export { FaultProxy, type ProxyMode } from './proxy.ts'
export { loginPassword, provisionRoles, type RoleProvisioning, withRolesHeld } from './roles.ts'
export {
  catalogChecksum,
  createDatabase,
  dropDatabase,
  loginClient,
  logsIn,
  matrix,
  type PsqlRun,
  runAsSuperuser,
  runPsql,
  serverFor,
  superuserClient,
  TEST_TARGETS_ENV,
  type TestServer,
  type TestTargets,
  testRolePassword,
  testTargets,
  testTls,
  uniqueDatabaseName,
  withClusterTurn,
  withSuperuser,
} from './servers.ts'
export { databaseFromFixture, ensureTemplate, type Fixture } from './templates.ts'
