import type { ImportReport, MigrationStream } from '@exponetdb/sdk/operations'
import {
  type MigrationTimelineData,
  markerStateFromStream,
  type TimelineBundle,
} from '@exponetdb/ui-data'
import type { Readable } from '@exponetdb/ui-patterns'

/**
 * The migrations page as data: the server's answers turned into the props of
 * the timeline and the review blocks. Nothing is decided here: a cell the
 * stream does not list stays missing (the timeline shows it as unknown, never
 * as "not applied"), a state this build does not know becomes `unknown`.
 */

/** The same read with its value mapped; a read without a value stays what it was. */
export function mapReadable<T, U>(readable: Readable<T>, map: (value: T) => U): Readable<U> {
  switch (readable.state) {
    case 'loading':
    case 'failed':
      return readable
    case 'stale':
      return { ...readable, value: map(readable.value) }
    case 'partial':
      return { ...readable, value: map(readable.value) }
    case 'ready':
      return { ...readable, value: map(readable.value) }
  }
}

/** `MigrationStream` as the timeline's data (the mapping the timeline's types document). */
export function timelineDataOf(stream: MigrationStream): MigrationTimelineData {
  const bundles: TimelineBundle[] = stream.bundles.map((bundle) => ({
    id: bundle.migrationId,
    slug: bundle.name,
    dependsOn: bundle.dependsOn,
    cells: bundle.states.map((cell) => ({
      environmentId: cell.environment,
      state: markerStateFromStream(cell.state),
      at: cell.verification?.verifiedAt ?? cell.appliedAt,
      observedAt: cell.observedAt,
    })),
  }))
  return {
    environments: stream.environments.map((environment) => ({
      id: environment.slug,
      name: environment.displayName,
      tier: environment.tier,
      evidenceFrom: environment.evidenceFrom,
    })),
    bundles,
    baselines: stream.baselines,
    ...(stream.truncated ? { totalBundleCount: stream.bundleCount } : {}),
  }
}

/** What the stream cannot say, in the words of the page: a truncated list. */
export function streamMissing(stream: MigrationStream): readonly string[] | undefined {
  return stream.truncated ? ['older bundles (the stream lists the last 1,000)'] : undefined
}

export interface EnvironmentNote {
  readonly slug: string
  readonly kind: 'no_target' | 'no_mirror' | 'divergent'
  /** Bundle ids the mirror says are missing, differ in checksum or are unrecorded (divergent only). */
  readonly missing: readonly string[]
  readonly checksumDiffers: readonly string[]
  readonly unrecorded: readonly string[]
}

/**
 * Environments whose cells are not a statement about the target: no target
 * the caller may see, a target without a mirror (every cell reads unknown),
 * or a mirror that differs from the target's ledger.
 */
export function environmentNotes(stream: MigrationStream): readonly EnvironmentNote[] {
  const notes: EnvironmentNote[] = []
  for (const environment of stream.environments) {
    const none = { missing: [], checksumDiffers: [], unrecorded: [] }
    if (environment.target === null) {
      notes.push({ slug: environment.slug, kind: 'no_target', ...none })
    } else if (environment.mirror === null) {
      notes.push({ slug: environment.slug, kind: 'no_mirror', ...none })
    } else if (environment.mirror.divergent) {
      const divergence = environment.mirror.divergence
      notes.push({
        slug: environment.slug,
        kind: 'divergent',
        missing: divergence?.missing ?? [],
        checksumDiffers: divergence?.checksumDiffers ?? [],
        unrecorded: divergence?.unrecorded ?? [],
      })
    }
  }
  return notes
}

type ImportItem = ImportReport['items'][number]

/** The states a person has to decide on (legacy-import.md step 4: the review items). */
const REVIEW_STATES: readonly ImportItem['state'][] = [
  'recorded_missing',
  'unrecorded_missing',
  'superseded',
  'ambiguous',
]

/** Whether an item of an open report asks for a decision that has not been taken. */
export function needsDecision(item: ImportItem): boolean {
  return item.decision === null && REVIEW_STATES.includes(item.state)
}

/** The states a decision may record (everything but `ambiguous`). */
export const DECISION_STATES = [
  'recorded_present',
  'unrecorded_present',
  'recorded_missing',
  'unrecorded_missing',
  'superseded',
  'not_applicable',
] as const satisfies readonly Exclude<ImportItem['state'], 'ambiguous'>[]

export type DecisionState = (typeof DECISION_STATES)[number]

export function isDecisionState(value: unknown): value is DecisionState {
  return typeof value === 'string' && (DECISION_STATES as readonly string[]).includes(value)
}

/** The longest note a decision carries (the contract's limit). */
export const NOTE_MAX_LENGTH = 1000

/** The report id the page was asked to open (`?report=`), else `undefined`. */
export function reportSearch(search: Readonly<Record<string, unknown>>): {
  readonly report?: string
} {
  const report = search['report']
  return {
    report:
      typeof report === 'string' && /^imr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(report)
        ? report
        : undefined,
  }
}
