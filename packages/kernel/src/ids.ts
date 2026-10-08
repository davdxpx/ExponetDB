import { type Failure, failure, InvariantError } from './errors.ts'
import { err, ok, type Result } from './result.ts'
import { CANONICAL_ULID_PATTERN, isCanonicalUlid, newUlid, ulidRefusal } from './ulid.ts'

/**
 * Entity id prefixes ([domain model §2](../../../exponetdb-docs/01-architecture/domain-model.md#2-identifiers)).
 * Closed set: a new entity type is a contract change.
 */
export const ID_PREFIXES = {
  prd: 'Product',
  prj: 'Project',
  env: 'Environment',
  tgt: 'Target',
  plc: 'Placement',
  srv: 'Server',
  nod: 'Node',
  cls: 'Cluster',
  dbs: 'Database',
  end: 'Endpoint',
  crd: 'Credential',
  bkr: 'Backup repository',
  bkp: 'Backup',
  rst: 'Restore',
  crt: 'Certificate',
  pln: 'Plan',
  op: 'Operation',
  job: 'Node job',
  apr: 'Approval',
  bgl: 'Break-glass grant',
  evd: 'Evidence record',
  idn: 'Identity',
  rlb: 'Role binding',
  cli: 'OAuth client',
  grt: 'OAuth grant',
  key: 'API key',
  ses: 'Web session',
  aud: 'Audit event',
  fnd: 'Finding',
  smp: 'Sample batch',
  ins: 'Installation',
  sec: 'Secret',
  prc: 'Process instance',
  fac: 'Authentication factor',
  cap: 'One-time capability',
  chl: 'Authentication challenge',
  rau: 'Re-authentication event',
  ent: 'Node enrollment token',
  req: 'Request (correlation id, not a stored entity)',
} as const

export type IdPrefix = keyof typeof ID_PREFIXES

declare const idBrand: unique symbol
declare const migrationIdBrand: unique symbol

/**
 * An entity id `<prefix>_<ULID>`. The brand makes `EntityId<'pln'>` and
 * `EntityId<'tgt'>` incompatible at compile time; the only way to obtain one
 * is a validating parser or {@link newId}.
 */
export type EntityId<P extends IdPrefix> = string & { readonly [idBrand]: P }

/** A migration id: a bare canonical ULID, outside ExponetDB's id space. */
export type MigrationId = string & { readonly [migrationIdBrand]: true }

export type ProductId = EntityId<'prd'>
export type ProjectId = EntityId<'prj'>
export type EnvironmentId = EntityId<'env'>
export type TargetId = EntityId<'tgt'>
export type PlacementId = EntityId<'plc'>
export type ServerId = EntityId<'srv'>
export type NodeId = EntityId<'nod'>
export type ClusterId = EntityId<'cls'>
export type DatabaseId = EntityId<'dbs'>
export type EndpointId = EntityId<'end'>
export type CredentialId = EntityId<'crd'>
export type BackupRepositoryId = EntityId<'bkr'>
export type BackupId = EntityId<'bkp'>
export type RestoreId = EntityId<'rst'>
export type CertificateId = EntityId<'crt'>
export type PlanId = EntityId<'pln'>
export type OperationId = EntityId<'op'>
export type JobId = EntityId<'job'>
export type ApprovalId = EntityId<'apr'>
export type BreakGlassGrantId = EntityId<'bgl'>
export type EvidenceId = EntityId<'evd'>
export type IdentityId = EntityId<'idn'>
export type RoleBindingId = EntityId<'rlb'>
export type OAuthClientId = EntityId<'cli'>
export type GrantId = EntityId<'grt'>
export type ApiKeyId = EntityId<'key'>
export type SessionId = EntityId<'ses'>
export type AuditEventId = EntityId<'aud'>
export type FindingId = EntityId<'fnd'>
export type SampleBatchId = EntityId<'smp'>
export type InstallationId = EntityId<'ins'>
export type SecretId = EntityId<'sec'>
export type ProcessInstanceId = EntityId<'prc'>
export type AuthFactorId = EntityId<'fac'>
export type CapabilityId = EntityId<'cap'>
export type ChallengeId = EntityId<'chl'>
export type ReauthEventId = EntityId<'rau'>
export type RequestId = EntityId<'req'>

/**
 * Why a value is not the expected id, in the order the rules are checked
 * ([domain model §2](../../../exponetdb-docs/01-architecture/domain-model.md#2-identifiers)).
 */
export type IdRefusal = 'invalid_prefix' | 'wrong_prefix' | 'not_canonical' | 'invalid_ulid'

export type IdFailure = Failure<
  'invalid_id',
  { readonly reason: IdRefusal; readonly expected: string }
>

export function isIdPrefix(value: string): value is IdPrefix {
  return Object.hasOwn(ID_PREFIXES, value)
}

/** The first failing rule for `value` as an id with `prefix`, or undefined when valid. */
export function idRefusal(prefix: IdPrefix, value: string): IdRefusal | undefined {
  const separator = value.indexOf('_')
  if (separator < 0) {
    return 'invalid_prefix'
  }
  const actual = value.slice(0, separator)
  if (!isIdPrefix(actual)) {
    return 'invalid_prefix'
  }
  if (actual !== prefix) {
    return 'wrong_prefix'
  }
  return ulidRefusal(value.slice(separator + 1))
}

/**
 * JSON Schema / ECMAScript pattern equivalent to {@link isId} for one prefix
 * (`^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$`). Generated schemas use it; validation in
 * code uses {@link isId}. A test keeps both in step.
 */
export function idPattern(prefix: IdPrefix): string {
  return `^${prefix}_${CANONICAL_ULID_PATTERN.source.slice(1, -1)}$`
}

/** Pattern equivalent to {@link isMigrationId}. */
export const MIGRATION_ID_PATTERN: string = CANONICAL_ULID_PATTERN.source

export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is EntityId<P> {
  return typeof value === 'string' && idRefusal(prefix, value) === undefined
}

/** Validates untrusted input as an id of one entity type. Never folds case. */
export function parseId<P extends IdPrefix>(
  prefix: P,
  value: unknown,
): Result<EntityId<P>, IdFailure> {
  if (isId(prefix, value)) {
    return ok(value)
  }
  const reason =
    typeof value === 'string' ? (idRefusal(prefix, value) ?? 'invalid_ulid') : 'invalid_prefix'
  return err(
    failure('invalid_id', `Not a valid ${ID_PREFIXES[prefix]} id (${prefix}_<ULID>).`, {
      reason,
      expected: prefix,
    }),
  )
}

export function isMigrationId(value: unknown): value is MigrationId {
  return typeof value === 'string' && isCanonicalUlid(value)
}

export function parseMigrationId(value: unknown): Result<MigrationId, IdFailure> {
  if (isMigrationId(value)) {
    return ok(value)
  }
  const reason: IdRefusal =
    typeof value === 'string' ? (ulidRefusal(value) ?? 'invalid_ulid') : 'invalid_ulid'
  return err(
    failure('invalid_id', 'Not a valid migration id (26-character uppercase ULID).', {
      reason,
      expected: 'migration',
    }),
  )
}

/** Creates a new id. `timeMs` comes from an injected clock, never from `Date.now()`. */
export function newId<P extends IdPrefix>(
  prefix: P,
  timeMs: number,
  random?: (size: number) => Uint8Array,
): EntityId<P> {
  const candidate = `${prefix}_${newUlid(timeMs, random)}`
  if (!isId(prefix, candidate)) {
    throw new InvariantError(`generated id is not canonical: ${prefix}`)
  }
  return candidate
}
