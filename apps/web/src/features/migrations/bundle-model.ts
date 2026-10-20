import type {
  MigrationBundle,
  MigrationBundleRevision,
  MigrationStream,
} from '@exponetdb/sdk/operations'

/**
 * Stored bundles and their promotion as data: which revision and which files
 * the side panel reads, which bundles of a project's stream a person may plan
 * on an environment, and what the evidence environment's mirror says about
 * each of them. Nothing here decides: the server orders the bundles, checks
 * the evidence live and applies the policy when it plans (C-15). A value the
 * read did not give stays "not known", never the favorable case (C-30).
 * Pure functions, unit-tested with hostile input.
 */
const MIGRATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** Whether a value is a migration id (a ULID): the only thing a bundle request may carry. */
export function isMigrationId(value: unknown): value is string {
  return typeof value === 'string' && MIGRATION_ID.test(value)
}

/** Whether a value is a revision number of a bundle (a positive safe integer). */
export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * The most bundles one migration plan takes by id (`MigrationPlanRequest.migrationIds`,
 * `maxItems` of the contract).
 */
export const PLAN_MIGRATION_CAP = 200

/** The files of a bundle the side panel shows, in the order a person reads them. */
export const BUNDLE_FILES = ['up.sql', 'verify.sql', 'down.sql'] as const
export type BundleFileName = (typeof BUNDLE_FILES)[number]

export function isBundleFile(value: unknown): value is BundleFileName {
  return typeof value === 'string' && (BUNDLE_FILES as readonly string[]).includes(value)
}

/** The revisions of a stored bundle, newest first (by number; the server's order is not assumed). */
export function revisionsNewestFirst(
  bundle: Pick<MigrationBundle, 'revisions'>,
): readonly MigrationBundleRevision[] {
  return [...bundle.revisions]
    .filter((revision) => isRevision(revision.revision))
    .sort((a, b) => b.revision - a.revision)
}

/** The files of a revision among `up.sql`, `verify.sql` and `down.sql`, in reading order. */
export function filesOfRevision(
  revision: Pick<MigrationBundleRevision, 'files'>,
): readonly BundleFileName[] {
  return BUNDLE_FILES.filter((file) => Object.hasOwn(revision.files, file))
}

/**
 * The revision the panel shows: the one asked for when the bundle has it,
 * else the newest. `undefined` when the bundle lists no revision.
 */
export function pickRevision(
  bundle: Pick<MigrationBundle, 'revisions'>,
  wanted: number | undefined,
): MigrationBundleRevision | undefined {
  const revisions = revisionsNewestFirst(bundle)
  return revisions.find((revision) => revision.revision === wanted) ?? revisions[0]
}

/** The revision before `revision` (the comparison's left side), or `undefined` for the first. */
export function previousRevision(
  bundle: Pick<MigrationBundle, 'revisions'>,
  revision: number,
): MigrationBundleRevision | undefined {
  return revisionsNewestFirst(bundle).find((candidate) => candidate.revision < revision)
}

/** The longest file text the panel renders (the plan review's limit, `REVIEW_SOURCE_MAX_CHARS`). */
export const FILE_TEXT_MAX_CHARS = 262_144

/** A file's text as the panel renders it: at most `FILE_TEXT_MAX_CHARS` characters, cut said. */
export function shownText(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length > FILE_TEXT_MAX_CHARS
    ? { text: text.slice(0, FILE_TEXT_MAX_CHARS), truncated: true }
    : { text, truncated: false }
}

// ---------------------------------------------------------------------------
// Evidence and promotion
// ---------------------------------------------------------------------------

/**
 * What the evidence environment's mirror says about one bundle before it is
 * planned on a production-tier environment (staging-production-policy.md
 * §1.2), from the Control Store mirror (`source: cached`). The server reads
 * the evidence environment live when it plans; this is the explanation the
 * page gives before, never the decision.
 */
export type EvidenceState =
  /** The destination is not production: the evidence rule does not apply. */
  | { readonly kind: 'not_required' }
  /** Production without a configured evidence environment. */
  | { readonly kind: 'no_environment' }
  | { readonly kind: 'verified'; readonly from: string }
  /** Verified there, but with another apply checksum: not evidence for this bundle. */
  | { readonly kind: 'other_checksum'; readonly from: string }
  /** Applied, failed, not applied, reverted or divergent there. */
  | { readonly kind: 'not_verified'; readonly from: string; readonly state: string }
  /** The mirror holds nothing that says (no target, no mirror, an unknown cell, no read). */
  | { readonly kind: 'not_known'; readonly from: string | null }

type StreamEnvironment = MigrationStream['environments'][number]
type StreamBundle = MigrationStream['bundles'][number]

/** The environments of the stream in evidence order (by rank, then slug). */
export function environmentsInOrder(stream: MigrationStream): readonly StreamEnvironment[] {
  return [...stream.environments].sort(
    (a, b) => a.rank - b.rank || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  )
}

/**
 * The evidence of one bundle for a destination environment. `tier` is the
 * destination's tier as the page knows it; anything but exactly `nonprod`
 * is production (fails closed). Without a stream read the evidence
 * environment is not known.
 */
export function evidenceOf(
  stream: MigrationStream | undefined,
  destination: { readonly slug: string; readonly tier: string | null | undefined },
  bundle: { readonly migrationId: string; readonly checksum: string | null },
): EvidenceState {
  const environment = stream?.environments.find((e) => e.slug === destination.slug)
  // Not production only when every tier the page knows says exactly `nonprod`.
  const tiers = [environment?.tier, destination.tier].filter((tier) => tier !== undefined)
  if (tiers.length > 0 && tiers.every((tier) => tier === 'nonprod')) return { kind: 'not_required' }
  if (stream === undefined || environment === undefined) return { kind: 'not_known', from: null }
  const from = environment.evidenceFrom
  if (from === null) return { kind: 'no_environment' }
  const source = stream.environments.find((e) => e.slug === from)
  if (source === undefined || source.target === null || source.mirror === null) {
    return { kind: 'not_known', from }
  }
  const cell = stream.bundles
    .find((b) => b.migrationId === bundle.migrationId)
    ?.states.find((s) => s.environment === from)
  if (cell === undefined || cell.state === 'unknown') return { kind: 'not_known', from }
  if (cell.state !== 'verified') return { kind: 'not_verified', from, state: cell.state }
  const otherChecksum =
    cell.checksum !== null
      ? bundle.checksum !== null && cell.checksum !== bundle.checksum
      : cell.checksumMatches === false
  return otherChecksum ? { kind: 'other_checksum', from } : { kind: 'verified', from }
}

/** Whether the evidence note warns: production will refuse the plan unless break-glass applies. */
export function evidenceWarns(evidence: EvidenceState): boolean {
  return evidence.kind !== 'not_required' && evidence.kind !== 'verified'
}

/** A bundle of the stream that is not applied on the destination environment. */
export interface PromotionCandidate {
  readonly migrationId: string
  /** Untrusted: the bundle's own name. */
  readonly name: string
  readonly checksum: string
  readonly revision: number
  /** The mirror's state on the destination: `not_applied`, or `unknown` when it holds nothing. */
  readonly state: 'not_applied' | 'unknown'
  readonly evidence: EvidenceState
}

/** Cell states that say the bundle is not on the destination, or that the mirror does not know. */
function candidateState(bundle: StreamBundle, slug: string): 'not_applied' | 'unknown' | undefined {
  const cell = bundle.states.find((s) => s.environment === slug)
  if (cell === undefined || cell.state === 'unknown') return 'unknown'
  return cell.state === 'not_applied' ? 'not_applied' : undefined
}

/**
 * The bundles of the stream a person may plan on `slug`: those the mirror
 * holds as not applied there, and those it holds nothing for (`unknown`;
 * the server decides). Applied, verified, failed, reverted and divergent
 * bundles are not offered. In the stream's dependency order.
 */
export function candidatesFor(
  stream: MigrationStream,
  slug: string,
): readonly PromotionCandidate[] {
  const environment = stream.environments.find((e) => e.slug === slug)
  if (environment === undefined || environment.target === null) return []
  const candidates: PromotionCandidate[] = []
  for (const bundle of stream.bundles) {
    if (!isMigrationId(bundle.migrationId)) continue
    const state = candidateState(bundle, slug)
    if (state === undefined) continue
    candidates.push({
      migrationId: bundle.migrationId,
      name: bundle.name,
      checksum: bundle.checksum,
      revision: bundle.revision,
      state,
      evidence: evidenceOf(stream, { slug, tier: environment.tier }, bundle),
    })
  }
  return candidates
}

/** The environments a bundle can be planned on: those with a target the person may see. */
export function plannableEnvironments(stream: MigrationStream): readonly StreamEnvironment[] {
  return environmentsInOrder(stream).filter((e) => e.target !== null)
}

/**
 * The environment the promotion panel opens on. From a target's page
 * (`current`): the environment that takes its evidence from it (where its
 * bundles go next), else itself. Otherwise the first environment in evidence
 * order with a bundle to plan, else the first with a target.
 */
export function defaultDestination(stream: MigrationStream, current?: string): string | undefined {
  const environments = plannableEnvironments(stream)
  if (current !== undefined) {
    const next = environments.find((e) => e.evidenceFrom === current)
    if (next !== undefined) return next.slug
    if (environments.some((e) => e.slug === current)) return current
  }
  const withWork = environments.find((e) => candidatesFor(stream, e.slug).length > 0)
  return (withWork ?? environments[0])?.slug
}
