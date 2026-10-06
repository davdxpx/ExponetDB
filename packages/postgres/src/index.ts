export {
  bootstrapScript,
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  LOGIN_ROLES,
  passwordStatements,
  type RoleVerifiers,
} from './bootstrap.ts'
export { CircuitBreaker, ConnectionBudget } from './budget.ts'
export {
  mapDriverError,
  type ServerFields,
  TargetError,
  type TargetErrorCode,
  type TargetErrorReason,
} from './errors.ts'
export {
  CANONICALIZER,
  type CanonicalDocument,
  type CanonicalEntry,
  compareEntries,
  type DocumentHeader,
  documentFromJson,
  documentJson,
  entryId,
  fingerprintOf,
  type ManagedScope,
  makeDocument,
  makeEntry,
  OBJECT_CLASSES,
  type ObjectClass,
} from './introspection/canonical.ts'
export { type ClusterFingerprint, clusterFingerprint } from './introspection/cluster.ts'
export {
  type DocumentDiff,
  diffDocuments,
  type EntryChange,
  securityRelevant,
} from './introspection/diff.ts'
export {
  ALWAYS_EXCLUDED_SCHEMAS,
  alwaysExcluded,
  type Snapshot,
  type SnapshotOptions,
  scopeHeader,
  takeSnapshot,
  type VisibilityItem,
} from './introspection/snapshot.ts'
export {
  controlStoreSigns,
  type IdentityMarker,
  isEmptyLedger,
  LEDGER_SCHEMA,
  LEDGER_SCHEMA_VERSION,
  LEDGER_TABLES,
  type LedgerShape,
  LOCK_NAMESPACE,
  ledgerShape,
  lockKey2,
  type MarkerState,
  preflightStamp,
  readMarker,
  type Stamp,
  type StampRefusal,
  StampRefused,
  type StampResult,
  stampTarget,
  takeSchemaLock,
} from './ledger.ts'
export {
  type ActivitySummary,
  type CapacitySettings,
  type IdentityProbe,
  type ProbeOutcome,
  probeExtended,
  probeIdentity,
  probeSimple,
  readActivity,
  readCapacity,
  requireActivityVisibility,
  type SessionNote,
} from './probes.ts'
export { resolveRelationKinds } from './relations.ts'
export { RowShapeError, TargetRow } from './rows.ts'
export {
  ACCESS_ROLES,
  type AccessRole,
  type ConnectionSpec,
  DEFAULT_LIMITS,
  type Endpoint,
  endpointProblem,
  LEDGER_OWNER_ROLE,
  type OpenOptions,
  type QueryOptions,
  ReadOnlyTransaction,
  ROLE_NAMES,
  type SessionFacts,
  type SessionGuards,
  type SessionLimits,
  TargetSession,
} from './session.ts'
export {
  dollarQuote,
  ident,
  identifierTooLong,
  isTrustedSql,
  join,
  literal,
  MAX_IDENTIFIER_BYTES,
  qualified,
  quoteIdent,
  quoteLiteral,
  SqlBuildError,
  type SqlBuildErrorCode,
  sql,
  type TrustedSql,
} from './sql.ts'
export { isSupportedMajor, majorOf, SUPPORTED_MAJORS, type SupportedMajor } from './versions.ts'
