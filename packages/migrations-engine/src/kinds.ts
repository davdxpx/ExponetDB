import type { OperationKind } from '@exponetdb/operations'
import type { MigrationKindDeps } from './deps.ts'
import { MigrationApplyKind } from './kind.ts'
import { ImportReplayKind, MigrationBaselineKind } from './legacy.ts'
import { MigrationVerifyKind } from './reverify.ts'
import { MigrationRollbackKind } from './rollback.ts'

/** The migration kinds the worker registers (`migration.resume` is the apply kind over a resume plan). */
export function migrationKinds(deps: MigrationKindDeps): readonly OperationKind[] {
  return [
    new MigrationApplyKind(deps),
    new MigrationApplyKind(deps, 'migration.resume'),
    new MigrationVerifyKind(deps),
    new MigrationRollbackKind(deps),
    new ImportReplayKind(deps),
    new MigrationBaselineKind(deps),
  ]
}
