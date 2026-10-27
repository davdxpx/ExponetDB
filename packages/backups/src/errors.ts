import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * Refusals of the backup domain: a catalog code and schema-checked details
 * (a `reason` for `REGISTRY_CONFLICT`). The message is the catalog's fixed
 * text; request values, engine output and storage names are never in it.
 */
export class BackupError extends Error {
  override readonly name = 'BackupError'
  readonly code: ErrorCode
  readonly details: JsonObject | undefined

  constructor(code: ErrorCode, details?: JsonObject) {
    super(errorDefinition(code).message)
    this.code = code
    this.details = details
  }
}

export type BackupConflictReason =
  | 'cluster_retired'
  | 'cluster_not_confirmed'
  | 'repository_location_taken'
  | 'repository_retired'
  | 'repository_not_adopted_observed'
  | 'repository_other_cluster'
  | 'repository_runs_not_allowed'
  | 'repository_in_use'
  | 'run_active'
  | 'restore_not_discardable'
  | 'policy_repository_unknown'
  | 'backup_not_found'
  | 'backup_not_verified'
  | 'wal_not_continuous'
  | 'point_in_time_outside_window'
  | 'no_backup_selectable'
  | 'repository_engine_below_floor'

export function conflict(reason: BackupConflictReason): BackupError {
  return new BackupError('REGISTRY_CONFLICT', { reason })
}
