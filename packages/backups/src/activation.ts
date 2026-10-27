import { BackupError } from './errors.ts'

/**
 * The installation's activation of backup runs and restores (ADR-0037,
 * ADR-0038 §2). Planning works everywhere; executing an engine run or a
 * restore is refused (`FEATURE_NOT_ACTIVATED`) until an operator turns it on
 * for the tier after the evidence exists (`PRE-WAVE-11-REVIEW.md` W9-02).
 * The default is `disabled`: a missing or unknown value never enables.
 */
export type BackupExecution = 'disabled' | 'nonprod' | 'all'
export type RestoreExecution = 'disabled' | 'scratch' | 'all'

export interface ExecutionSettings {
  readonly backups: BackupExecution
  readonly restores: RestoreExecution
}

export const EXECUTION_DISABLED: ExecutionSettings = { backups: 'disabled', restores: 'disabled' }

export function parseBackupExecution(value: string | undefined): BackupExecution {
  return value === 'nonprod' || value === 'all' ? value : 'disabled'
}

export function parseRestoreExecution(value: string | undefined): RestoreExecution {
  return value === 'scratch' || value === 'all' ? value : 'disabled'
}

/** Refuses a backup engine run on a tier the installation has not activated (an unknown tier counts as production). */
export function requireBackupExecution(
  settings: ExecutionSettings,
  tier: 'prod' | 'nonprod' | undefined,
): void {
  const ok = settings.backups === 'all' || (settings.backups === 'nonprod' && tier === 'nonprod')
  if (!ok) {
    throw new BackupError('FEATURE_NOT_ACTIVATED', {
      setting: 'EXPONETDB_BACKUP_EXECUTION',
      current: settings.backups,
    })
  }
}

/** Refuses a restore the installation has not activated: drills need `scratch`, recoveries `all`. */
export function requireRestoreExecution(
  settings: ExecutionSettings,
  purpose: 'drill' | 'recovery',
): void {
  const ok = settings.restores === 'all' || (settings.restores === 'scratch' && purpose === 'drill')
  if (!ok) {
    throw new BackupError('FEATURE_NOT_ACTIVATED', {
      setting: 'EXPONETDB_RESTORE_EXECUTION',
      current: settings.restores,
    })
  }
}
