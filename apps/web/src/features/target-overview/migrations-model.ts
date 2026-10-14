import type { MigrationStream } from '@exponetdb/sdk/operations'
import type { MessageKey } from '../../lib/i18n/i18n.ts'

/**
 * The pure part of the migration block: the columns (environments in
 * evidence order) and rows (the newest bundles) of the promotion matrix, and
 * the state of one cell. A cell the stream does not hold is `unknown`, never
 * "not applied": the stream comes from mirrors, and an environment without a
 * mirror, or a target the caller may not see, has no state to report.
 */

/** Bundles the overview shows: the newest in dependency order (the Migrations page has all). */
export const MATRIX_BUNDLES = 8

type Bundle = MigrationStream['bundles'][number]
type Cell = Bundle['states'][number]
type Environment = MigrationStream['environments'][number]

export interface MatrixColumn {
  readonly slug: string
  readonly displayName: string
  readonly tier: Environment['tier']
  /** The environment of the page's own target. */
  readonly current: boolean
  readonly hasTarget: boolean
  /** When the mirror of this environment was written; `null` when it never was. */
  readonly mirrorObservedAt: string | null
  readonly divergent: boolean
}

export function matrixColumns(stream: MigrationStream, path: string): readonly MatrixColumn[] {
  return stream.environments
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((environment) => ({
      slug: environment.slug,
      displayName: environment.displayName,
      tier: environment.tier,
      current: environment.target?.path === path,
      hasTarget: environment.target !== null,
      mirrorObservedAt: environment.mirror?.observedAt ?? null,
      divergent: environment.mirror?.divergent === true,
    }))
}

export function matrixBundles(stream: MigrationStream): readonly Bundle[] {
  return stream.bundles.slice(-MATRIX_BUNDLES)
}

export function cellOf(bundle: Bundle, slug: string): Cell | undefined {
  return bundle.states.find((cell) => cell.environment === slug)
}

const KNOWN = [
  'not_applied',
  'applied',
  'verified',
  'failed',
  'reverted',
  'divergent',
  'unknown',
] as const
export type KnownStreamState = (typeof KNOWN)[number]

export interface StreamState {
  /** A state the page has words for, `unknown` for a missing cell, `other` for a word it does not know. */
  readonly state: KnownStreamState | 'other'
  /** The mirror holds a checksum that differs from the newest stored revision of the bundle. */
  readonly checksumDiffers: boolean
}

export function streamState(cell: Cell | undefined): StreamState {
  if (cell === undefined) return { state: 'unknown', checksumDiffers: false }
  const known = KNOWN.find((state) => state === cell.state)
  return {
    state: known ?? 'other',
    checksumDiffers: cell.checksumMatches === false,
  }
}

export function stateKey(state: StreamState['state']): MessageKey {
  return `overview.migrations.cell.${state}`
}
