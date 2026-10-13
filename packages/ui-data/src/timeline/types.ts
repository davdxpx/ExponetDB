/**
 * Types of the migration timeline (information-architecture.md section 2, design-system.md
 * section 3). Light module: no component and no heavy library, so a page can import the
 * shapes without loading the view.
 *
 * The props are presentational. Mapping to the contracts (`MigrationStream` of
 * `packages/contracts/src/rest/resources.ts`, which this package never imports):
 *
 * - `TimelineEnvironment` is one entry of `environments` (`slug` -> `id`, `displayName` ->
 *   `name`, `tier`, `evidenceFrom`), already in evidence order (the contract's `rank`).
 * - `TimelineBundle` is one entry of `bundles` (`migrationId` -> `id`, `name` -> `slug`,
 *   `dependsOn`), with its `states` mapped to `cells`.
 * - `TimelineCell` is one entry of `states` (`environment` -> `environmentId`; `state` through
 *   `markerStateFromStream`; `appliedAt` or the verification time -> `at`; `observedAt`).
 * - `MigrationTimelineData.baselines` is the id list of `baselines`; `totalBundleCount` is
 *   `bundleCount` when `truncated` is true.
 */

/** What the mirror says about one bundle on one environment. */
export const MIGRATION_MARKER_STATES = [
  'not_applied',
  'pending',
  'applied',
  'verified',
  'failed',
  'drifted',
  'reverted',
  'unknown',
] as const

export type MigrationMarkerState = (typeof MIGRATION_MARKER_STATES)[number]

/**
 * The marker for a state string of the migration stream (`MigrationStreamState`). The contract's
 * enum is open: a state this build does not know becomes `unknown`, never a guess. `divergent`
 * (the target's ledger differs from the mirror) is shown as `drifted`.
 */
export function markerStateFromStream(state: string): MigrationMarkerState {
  switch (state) {
    case 'not_applied':
    case 'applied':
    case 'verified':
    case 'failed':
    case 'reverted':
    case 'pending':
      return state
    case 'divergent':
    case 'drifted':
      return 'drifted'
    default:
      return 'unknown'
  }
}

export interface TimelineEnvironment {
  /** The environment slug; cells refer to it. */
  readonly id: string
  /** The display name (untrusted text). */
  readonly name: string
  /** The tier: `production` or `prod` get the production chip. */
  readonly tier: string
  /** The id of the environment whose verification is the evidence for this one, if any. */
  readonly evidenceFrom?: string | null
}

export interface TimelineCell {
  readonly environmentId: string
  readonly state: MigrationMarkerState
  /** ISO 8601 time the state was reached (applied, verified or failed). */
  readonly at?: string | null
  /** ISO 8601 time the mirror of this environment's target was last written. */
  readonly observedAt?: string | null
  /** An app path to the evidence for this cell; the caller builds it from typed ids. */
  readonly evidencePath?: string | null
}

export interface TimelineBundle {
  /** The migration id (a ULID). */
  readonly id: string
  /** The migration name (untrusted text). */
  readonly slug: string
  /** Ids of the bundles (or baselines) this bundle depends on. */
  readonly dependsOn: readonly string[]
  /** At most one cell per environment; a missing cell is shown as unknown, never as not applied. */
  readonly cells: readonly TimelineCell[]
}

export interface MigrationTimelineData {
  /** In evidence order (development, staging, production, ...); the view does not reorder them. */
  readonly environments: readonly TimelineEnvironment[]
  /** In any order; the view orders them by `dependsOn`. */
  readonly bundles: readonly TimelineBundle[]
  /** Ids of baseline nodes that bundles may depend on; they are not rows. */
  readonly baselines?: readonly string[]
  /** The number of bundles in the stream when the list holds only the last ones. */
  readonly totalBundleCount?: number
}
