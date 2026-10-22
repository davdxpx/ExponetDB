import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * Registry refusals carry a catalog code and, where the catalog defines
 * them, schema-checked details (a `reason` for `REGISTRY_CONFLICT` and
 * `TARGET_REGISTRATION_REFUSED`). The message is the catalog's fixed text;
 * request values and database text are never part of it.
 */
export class RegistryError extends Error {
  override readonly name = 'RegistryError'
  readonly code: ErrorCode
  readonly details: JsonObject | undefined

  constructor(code: ErrorCode, details?: JsonObject, options: { cause?: unknown } = {}) {
    super(errorDefinition(code).message, options.cause === undefined ? undefined : options)
    this.code = code
    this.details = details
  }
}

export type ConflictReason =
  | 'slug_taken'
  | 'path_taken'
  | 'address_taken'
  | 'database_taken'
  | 'cluster_not_confirmed'
  | 'cluster_already_confirmed'
  | 'cluster_retired'
  | 'evidence_cycle'
  | 'evidence_other_product'
  | 'tier_in_use'
  | 'target_state'
  | 'endpoint_retired'
  | 'database_not_found'
  | 'database_retired'
  | 'database_in_use'
  | 'no_active_endpoint'
  | 'observer_credential_missing'
  | 'system_identifier_taken'
  | 'credential_missing'
  | 'exception_active'
  | 'exception_not_active'

export function conflict(reason: ConflictReason): RegistryError {
  return new RegistryError('REGISTRY_CONFLICT', { reason })
}

export type RegistrationRefusal =
  | 'control_store'
  | 'cluster_hosts_control_store'
  | 'foreign_installation'
  | 'other_target'
  | 'generation_mismatch'
  | 'schema_exists_without_marker'
  | 'marker_unreadable'
  | 'database_mismatch'
  | 'unsupported_version'
  | 'credential_missing'
  | 'lock_unavailable'

export function registrationRefused(reason: RegistrationRefusal): RegistryError {
  return new RegistryError('TARGET_REGISTRATION_REFUSED', { reason })
}
