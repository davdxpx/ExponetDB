import type { MigrationStream } from '@exponetdb/contracts'
import type { Queryable, Row } from '@exponetdb/control-store'
import { buildGraph, type GraphFailure, isBaselineRef } from '@exponetdb/migrations/graph'

/**
 * The promotion stream of a project (`migration.stream.get`, Wave 8 order §9),
 * read from the Control Store's mirrors and never from a target: the newest
 * stored revision of every bundle with its dependencies, the environments of
 * the product in evidence order, and per bundle and environment what the
 * mirror of the project's target there says (`ledger_mirror`, `ledger_state`,
 * `verification_mirror`, written by the worker after each operation). A target
 * the mirror has no record of at its current generation reads `unknown` in
 * every cell, never `not_applied`.
 */
export const STREAM_BUNDLE_LIMIT = 1000

const APPLY_CHECKSUM = /^sha256:c[1-9][0-9]*:[0-9a-f]{64}$/

type Environment = MigrationStream['environments'][number]
type Cell = MigrationStream['bundles'][number]['states'][number]

interface StoredBundle {
  readonly migrationId: string
  readonly name: string
  readonly revision: number
  readonly checksum: string
  readonly dependsOn: readonly string[]
}

interface MirrorRow {
  readonly checksum: string
  readonly appliedAt: string
  readonly reverted: boolean
}

interface Mirror {
  readonly observedAt: string
  readonly ledgerStateHash: string
  readonly baselineId: string | null
  readonly divergent: boolean
  readonly divergence: {
    readonly missing: string[]
    readonly checksumDiffers: string[]
    readonly unrecorded: string[]
  } | null
  readonly rows: ReadonlyMap<string, MirrorRow>
  readonly verifications: ReadonlyMap<string, { status: string; finishedAt: string }>
}

const iso = (row: Row, column: string): string => row.date(column).toISOString()

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').slice(0, 16)
    : []
}

function divergenceOf(value: unknown): Mirror['divergence'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const d = value as Record<string, unknown>
  return {
    missing: strings(d['missing']),
    checksumDiffers: strings(d['checksumDiffers']),
    unrecorded: strings(d['unrecorded']),
  }
}

/** The environments of a product with the project's live target in each (a decommissioned target is not live). */
async function environmentsOf(q: Queryable, projectId: string) {
  const { rows } = await q.query(
    'migrations.stream.environments',
    `SELECT e.slug, e.display_name, e.tier, ev.slug AS evidence_from, e.rank,
            t.target_id, t.path, t.state, t.generation
       FROM registry.projects p
       JOIN registry.environments e ON e.product_id = p.product_id
       LEFT JOIN registry.environments ev ON ev.environment_id = e.evidence_from
       LEFT JOIN registry.targets t ON t.project_id = p.project_id
                                   AND t.environment_id = e.environment_id
                                   AND t.state <> 'decommissioned'
      WHERE p.project_id = $1`,
    [projectId],
  )
  return rows
}

/**
 * Evidence order: an environment comes after the one it takes evidence from;
 * among those that may come next, the lower rank first, then the slug (a
 * stable topological order). A cycle cannot be registered; environments in
 * one would be listed last, by rank and slug, rather than lost.
 */
export function evidenceOrder<
  T extends { readonly slug: string; readonly evidenceFrom: string | null; readonly rank: number },
>(environments: readonly T[]): T[] {
  const bySlug = new Set(environments.map((e) => e.slug))
  const byRank = (a: T, b: T) => a.rank - b.rank || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  const placed = new Set<string>()
  const out: T[] = []
  let rest = [...environments].sort(byRank)
  for (;;) {
    const next = rest.find(
      (e) => e.evidenceFrom === null || !bySlug.has(e.evidenceFrom) || placed.has(e.evidenceFrom),
    )
    if (next === undefined) break
    out.push(next)
    placed.add(next.slug)
    rest = rest.filter((e) => e !== next)
  }
  return [...out, ...rest]
}

async function mirrorsOf(
  q: Queryable,
  targets: readonly { readonly targetId: string }[],
): Promise<Map<string, Mirror>> {
  if (targets.length === 0) return new Map()
  const ids = targets.map((t) => t.targetId)
  // Only a mirror of the target's current generation says anything about it now.
  const states = await q.query(
    'migrations.stream.ledger_state',
    `SELECT s.target_id, s.ledger_state_hash, s.baseline_id, s.observed_at, s.divergent, s.divergence
       FROM migrations.ledger_state s JOIN registry.targets t ON t.target_id = s.target_id
      WHERE s.target_id = ANY($1::text[]) AND s.generation = t.generation`,
    [ids],
  )
  const rows = await q.query(
    'migrations.stream.ledger_mirror',
    `SELECT m.target_id, m.migration_id, m.checksum, m.applied_at, m.reverted_at
       FROM migrations.ledger_mirror m JOIN registry.targets t ON t.target_id = m.target_id
      WHERE m.target_id = ANY($1::text[]) AND m.generation = t.generation`,
    [ids],
  )
  const verifications = await q.query(
    'migrations.stream.verifications',
    `SELECT DISTINCT ON (v.target_id, v.migration_id) v.target_id, v.migration_id, v.status, v.finished_at
       FROM migrations.verification_mirror v JOIN registry.targets t ON t.target_id = v.target_id
      WHERE v.target_id = ANY($1::text[]) AND v.generation = t.generation
      ORDER BY v.target_id, v.migration_id, v.finished_at DESC`,
    [ids],
  )
  const mirrors = new Map<string, Mirror>()
  for (const s of states.rows) {
    const targetId = s.text('target_id')
    const own = rows.rows.filter((r) => r.text('target_id') === targetId)
    const checks = verifications.rows.filter((r) => r.text('target_id') === targetId)
    mirrors.set(targetId, {
      observedAt: iso(s, 'observed_at'),
      ledgerStateHash: s.text('ledger_state_hash'),
      baselineId: s.textOrNull('baseline_id'),
      divergent: s.bool('divergent'),
      divergence: divergenceOf(s.json('divergence')),
      rows: new Map(
        own.map((r) => [
          r.text('migration_id'),
          {
            checksum: r.text('checksum'),
            appliedAt: iso(r, 'applied_at'),
            reverted: r.dateOrNull('reverted_at') !== null,
          },
        ]),
      ),
      verifications: new Map(
        checks.map((r) => [
          r.text('migration_id'),
          { status: r.text('status'), finishedAt: iso(r, 'finished_at') },
        ]),
      ),
    })
  }
  return mirrors
}

function cellOf(environment: string, bundle: StoredBundle, mirror: Mirror | undefined): Cell {
  if (mirror === undefined) {
    return {
      environment,
      state: 'unknown',
      checksum: null,
      checksumMatches: null,
      appliedAt: null,
      verification: null,
      observedAt: null,
    }
  }
  const row = mirror.rows.get(bundle.migrationId)
  const check = mirror.verifications.get(bundle.migrationId)
  const named = new Set([
    ...(mirror.divergence?.missing ?? []),
    ...(mirror.divergence?.checksumDiffers ?? []),
    ...(mirror.divergence?.unrecorded ?? []),
  ])
  let state: Cell['state']
  if (named.has(bundle.migrationId)) state = 'divergent'
  else if (row === undefined) state = 'not_applied'
  else if (row.reverted) state = 'reverted'
  else if (check?.status === 'passed') state = 'verified'
  else if (check !== undefined && ['failed', 'partial', 'error'].includes(check.status)) {
    state = 'failed'
  } else state = 'applied'
  return {
    environment,
    state,
    // A legacy entry carries the checksum of its own format: shown only when it is an apply checksum.
    checksum:
      row !== undefined && APPLY_CHECKSUM.test(row.checksum) ? (row.checksum as never) : null,
    checksumMatches: row === undefined ? null : row.checksum === bundle.checksum,
    appliedAt: row?.appliedAt ?? null,
    verification:
      check === undefined
        ? null
        : {
            status: check.status as NonNullable<Cell['verification']>['status'],
            verifiedAt: check.finishedAt,
          },
    observedAt: mirror.observedAt,
  }
}

function graphErrors(failure: GraphFailure): { code: string; migrationIds: string[] } {
  switch (failure.code) {
    case 'cycle':
      return { code: 'MIGRATION_DEPENDENCY_CYCLE', migrationIds: [...failure.cycle].slice(0, 256) }
    case 'unknown_dependency':
      return {
        code: 'MIGRATION_DEPENDENCY_UNKNOWN',
        migrationIds: [failure.from, ...failure.missing].slice(0, 256),
      }
    case 'unanchored_root':
      return { code: 'MIGRATION_DEPENDENCY_MISSING', migrationIds: [failure.id] }
    case 'invalid_reference':
      return { code: 'MIGRATION_BUNDLE_INVALID', migrationIds: [failure.from] }
    default:
      return { code: 'MIGRATION_BUNDLE_INVALID', migrationIds: [failure.id] }
  }
}

/**
 * Reads the stream. `visible` decides, per target, whether the caller may
 * see it (the central engine, in the use case); a target it refuses is
 * left out as if the environment had none. Reads nothing from a target.
 */
export async function projectStream(
  q: Queryable,
  projectId: string,
  visible: (targetId: string) => Promise<boolean>,
): Promise<MigrationStream> {
  const stored = await q.query(
    'migrations.stream.bundles',
    `SELECT DISTINCT ON (migration_id) migration_id, revision, name, checksum, depends_on
       FROM migrations.bundle_revisions WHERE project_id = $1
      ORDER BY migration_id, revision DESC`,
    [projectId],
  )
  const bundles = new Map<string, StoredBundle>(
    stored.rows.map((r) => [
      r.text('migration_id'),
      {
        migrationId: r.text('migration_id'),
        name: r.text('name'),
        revision: r.int('revision'),
        checksum: r.text('checksum'),
        dependsOn: [...r.textArray('depends_on')].sort(),
      },
    ]),
  )
  const baselines = [
    ...new Set([...bundles.values()].flatMap((b) => b.dependsOn.filter(isBaselineRef))),
  ].sort()
  const graph = buildGraph({
    migrations: [...bundles.values()].map((b) => ({ id: b.migrationId, dependsOn: b.dependsOn })),
    baselines,
  })
  const ids = [...bundles.keys()].sort()
  const order = graph.ok ? graph.value.order().filter((id) => bundles.has(id)) : ids
  const heads = graph.ok ? graph.value.heads().filter((id) => bundles.has(id)) : []

  const raw = await environmentsOf(q, projectId)
  const environments = evidenceOrder(
    raw.map((r) => ({
      row: r,
      slug: r.text('slug'),
      evidenceFrom: r.textOrNull('evidence_from'),
      rank: r.int('rank'),
    })),
  )
  const seen: { readonly targetId: string; readonly slug: string }[] = []
  const placed = new Map<string, Environment>()
  for (const e of environments) {
    const targetId = e.row.textOrNull('target_id')
    const shown = targetId !== null && (await visible(targetId))
    if (shown) seen.push({ targetId, slug: e.slug })
    const state = e.row.textOrNull('state')
    placed.set(e.slug, {
      slug: e.slug,
      displayName: e.row.text('display_name'),
      tier: e.row.text('tier') === 'prod' ? 'prod' : 'nonprod',
      evidenceFrom: e.evidenceFrom,
      rank: e.rank,
      target:
        shown && state !== null
          ? {
              id: targetId as never,
              path: e.row.text('path') as never,
              lifecycle: state as never,
              generation: e.row.int('generation'),
            }
          : null,
      mirror: null,
    })
  }
  const mirrors = await mirrorsOf(q, seen)
  const outside = (mirror: Mirror) =>
    [...mirror.rows.keys()].filter((id) => !bundles.has(id)).length
  const environmentViews: Environment[] = environments.map((e) => {
    const base = placed.get(e.slug) as Environment
    const target = seen.find((s) => s.slug === e.slug)
    const mirror = target === undefined ? undefined : mirrors.get(target.targetId)
    return {
      ...base,
      mirror:
        mirror === undefined
          ? null
          : {
              observedAt: mirror.observedAt,
              ledgerStateHash: mirror.ledgerStateHash as never,
              baselineId: mirror.baselineId as never,
              divergent: mirror.divergent,
              divergence: mirror.divergence,
              entriesOutsideStream: outside(mirror),
            },
    }
  })

  const listed = order.slice(-STREAM_BUNDLE_LIMIT)
  const clock = await q.query('migrations.stream.clock', 'SELECT clock_timestamp() AS now')
  return {
    projectId: projectId as never,
    graph: graph.ok
      ? { valid: true, errors: [] }
      : { valid: false, errors: [graphErrors(graph.error)] },
    heads: heads.slice(0, 1000) as never,
    baselines: baselines.slice(0, 1000) as never,
    bundles: listed.map((id) => {
      const bundle = bundles.get(id) as StoredBundle
      return {
        migrationId: id as never,
        name: bundle.name,
        revision: bundle.revision,
        checksum: bundle.checksum as never,
        dependsOn: [...bundle.dependsOn] as never,
        states: seen.map((s) => cellOf(s.slug, bundle, mirrors.get(s.targetId))),
      }
    }),
    bundleCount: order.length,
    truncated: order.length > STREAM_BUNDLE_LIMIT,
    environments: environmentViews,
    source: 'cached',
    observedAt: clock.rows[0]?.date('now').toISOString() ?? new Date().toISOString(),
  }
}
