import { type OrderIssue, orderBundles } from './order.ts'
import type {
  MigrationMarkerState,
  MigrationTimelineData,
  TimelineBundle,
  TimelineEnvironment,
} from './types.ts'

/** The default number of rows shown: the contract lists at most 1,000 bundles. */
export const DEFAULT_MAX_BUNDLES = 1_000

/** One cell of the grid after the environments and the cells of a bundle were matched. */
export interface ResolvedCell {
  readonly environmentId: string
  readonly state: MigrationMarkerState
  /** When the state was reached; `undefined` without a time. */
  readonly at: string | undefined
  /** When the mirror of the environment's target was last written. */
  readonly observedAt: string | undefined
  /** The evidence path as given; the view checks that it is an app path before linking. */
  readonly evidencePath: string | undefined
  /** `false`: the read holds no cell for this environment, so the state is `unknown`. */
  readonly recorded: boolean
  /** The read holds several cells for this environment, so the state is `unknown`. */
  readonly conflicting: boolean
}

export interface DependencyHint {
  readonly id: string
  /** The name of the bundle, when the dependency is a bundle of the read. */
  readonly name: string | undefined
  /**
   * `bundle`: a row of the read; `baseline`: a baseline node, not a row; `unlisted`: an id the
   * read does not list (a list cut to the last bundles, or a dangling dependency).
   */
  readonly kind: 'bundle' | 'baseline' | 'unlisted'
}

export interface TimelineRow {
  readonly id: string
  readonly slug: string
  readonly cells: readonly ResolvedCell[]
  readonly dependencies: readonly DependencyHint[]
}

export type ModelIssue =
  | OrderIssue
  /** Environments that repeat an id; the first is kept. */
  | { readonly kind: 'duplicate_environment'; readonly id: string; readonly dropped: number }
  /** Cells that name an environment the read does not list; they are not shown. */
  | { readonly kind: 'unlisted_environment'; readonly count: number }

export interface TimelineModel {
  readonly environments: readonly TimelineEnvironment[]
  /** In dependency order, the last `maxBundles` of them. */
  readonly rows: readonly TimelineRow[]
  /** Bundles ordered before the first row and not shown. */
  readonly hiddenEarlier: number
  /** Bundles in the stream, as far as the read says (the list, or `totalBundleCount`). */
  readonly totalBundles: number
  /** Bundles the server left out of the list before the first of them. */
  readonly omittedByServer: number
  readonly issues: readonly ModelIssue[]
}

function orUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value
}

function resolveCells(
  bundle: TimelineBundle,
  environments: readonly TimelineEnvironment[],
): readonly ResolvedCell[] {
  const byEnvironment = new Map<string, TimelineBundle['cells'][number][]>()
  for (const cell of bundle.cells) {
    const list = byEnvironment.get(cell.environmentId)
    if (list === undefined) byEnvironment.set(cell.environmentId, [cell])
    else list.push(cell)
  }
  return environments.map((environment): ResolvedCell => {
    const found = byEnvironment.get(environment.id) ?? []
    const [only] = found
    if (only === undefined) {
      return {
        environmentId: environment.id,
        state: 'unknown',
        at: undefined,
        observedAt: undefined,
        evidencePath: undefined,
        recorded: false,
        conflicting: false,
      }
    }
    if (found.length > 1) {
      return {
        environmentId: environment.id,
        state: 'unknown',
        at: undefined,
        observedAt: undefined,
        evidencePath: undefined,
        recorded: true,
        conflicting: true,
      }
    }
    return {
      environmentId: environment.id,
      state: only.state,
      at: orUndefined(only.at),
      observedAt: orUndefined(only.observedAt),
      evidencePath: orUndefined(only.evidencePath),
      recorded: true,
      conflicting: false,
    }
  })
}

/**
 * Turns the data of the timeline into rows: bundles in dependency order (ties by id), the cells
 * matched to the environments (in the order the caller gave them), dependency hints, and a list of
 * the things in the data that the grid could not honor. A missing cell is `unknown`, never `not
 * applied`; two cells for one environment are `unknown`, never one of them picked.
 */
export function buildTimelineModel(
  data: MigrationTimelineData,
  maxBundles: number = DEFAULT_MAX_BUNDLES,
): TimelineModel {
  const issues: ModelIssue[] = []

  const environments: TimelineEnvironment[] = []
  const seenEnvironments = new Set<string>()
  const droppedEnvironments = new Map<string, number>()
  for (const environment of data.environments) {
    if (seenEnvironments.has(environment.id)) {
      droppedEnvironments.set(environment.id, (droppedEnvironments.get(environment.id) ?? 0) + 1)
    } else {
      seenEnvironments.add(environment.id)
      environments.push(environment)
    }
  }
  for (const [id, dropped] of droppedEnvironments) {
    issues.push({ kind: 'duplicate_environment', id, dropped })
  }

  const { ordered, issues: orderIssues } = orderBundles(data.bundles)
  issues.push(...orderIssues)

  let unlistedCells = 0
  for (const bundle of ordered) {
    for (const cell of bundle.cells)
      if (!seenEnvironments.has(cell.environmentId)) unlistedCells += 1
  }
  if (unlistedCells > 0) issues.push({ kind: 'unlisted_environment', count: unlistedCells })

  const names = new Map<string, string>()
  for (const bundle of ordered) names.set(bundle.id, bundle.slug)
  const baselines = new Set(data.baselines ?? [])

  const limit = Math.max(0, Math.floor(maxBundles))
  const hiddenEarlier = Math.max(0, ordered.length - limit)
  const shown = hiddenEarlier === 0 ? ordered : ordered.slice(hiddenEarlier)

  const rows = shown.map((bundle): TimelineRow => {
    const seen = new Set<string>()
    const dependencies: DependencyHint[] = []
    for (const id of bundle.dependsOn) {
      if (seen.has(id)) continue
      seen.add(id)
      const name = names.get(id)
      if (name !== undefined) dependencies.push({ id, name, kind: 'bundle' })
      else
        dependencies.push({
          id,
          name: undefined,
          kind: baselines.has(id) ? 'baseline' : 'unlisted',
        })
    }
    return {
      id: bundle.id,
      slug: bundle.slug,
      cells: resolveCells(bundle, environments),
      dependencies,
    }
  })

  const listed = ordered.length
  const reported = data.totalBundleCount
  const totalBundles = reported !== undefined && reported >= listed ? reported : listed
  return {
    environments,
    rows,
    hiddenEarlier,
    totalBundles,
    omittedByServer: totalBundles - listed,
    issues,
  }
}
