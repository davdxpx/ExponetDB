import type { GraphFailure, PendingFailure } from './graph.ts'

/**
 * The error catalog code a graph or pending-set failure surfaces as
 * ([error-model.md §3](../../../../exponetdb-docs/02-control-plane/error-model.md#3-catalog)).
 * Only codes whose meaning matches exactly are mapped; the rest are
 * structural refusals that the caller reports with its own context
 * (ingestion in Wave 6, the Control Store runner's startup refusal in Wave 2).
 */
export type CatalogGraphError =
  | {
      readonly code: 'MIGRATION_BUNDLE_INVALID'
      readonly details: { readonly reason: 'duplicate_migration_id' }
    }
  | { readonly code: 'MIGRATION_DEPENDENCY_UNKNOWN' }
  | {
      readonly code: 'MIGRATION_DEPENDENCY_CYCLE'
      readonly details: { readonly cycle: readonly string[] }
    }
  | {
      readonly code: 'MIGRATION_DEPENDENCY_MISSING'
      readonly details: { readonly missing: readonly string[] }
    }

export function toCatalogError(
  failure: GraphFailure | PendingFailure,
): CatalogGraphError | undefined {
  switch (failure.code) {
    case 'duplicate_id':
      return { code: 'MIGRATION_BUNDLE_INVALID', details: { reason: 'duplicate_migration_id' } }
    case 'unknown_dependency':
      return { code: 'MIGRATION_DEPENDENCY_UNKNOWN' }
    case 'cycle':
      return { code: 'MIGRATION_DEPENDENCY_CYCLE', details: { cycle: failure.cycle } }
    case 'dependency_missing':
      return { code: 'MIGRATION_DEPENDENCY_MISSING', details: { missing: failure.missing } }
    default:
      return undefined
  }
}
