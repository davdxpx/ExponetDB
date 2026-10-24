import type { BundleSubmission, ProjectConfig } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { decodeUtf8 } from '@exponetdb/kernel'
import { parseProjectDefaults } from '@exponetdb/migrations/format'
import { lintBundles, prepareLint } from '@exponetdb/migrations/lint'
import {
  type LedgerRecord,
  readMigrationEvents,
  readVerifications,
  sql,
  type VerificationRecord,
} from '@exponetdb/postgres'
import type { Connector, TargetRecord } from '@exponetdb/registry'
import { ledgerDivergence } from './divergence.ts'
import { MigrationError } from './errors.ts'
import { projectAliases } from './execution-roles.ts'
import { supersededImportedRows } from './legacy.ts'
import { fileDigest, revisionsOf, storedStream, submissionInput } from './store.ts'
import { readTargetState } from './target.ts'
import type { Layer } from './verification.ts'

/**
 * The engine's reads for the interfaces: a target's migrations live from
 * its ledger, one migration's history, stored bundles and their exact
 * files, and the project lint of submitted bundles. Reads of a target are
 * live (C-11): a failed read is an error, never an empty list.
 */
export interface ReadDeps {
  readonly store: Queryable
  /** An observer connector (serve). */
  readonly connector: Connector
  readonly installationId: string
}

async function scopeOf(q: Queryable, projectId: string) {
  const { rows } = await q.query(
    'migrations.reads.scope',
    'SELECT managed_scope FROM registry.projects WHERE project_id = $1',
    [projectId],
  )
  const scope = rows[0]?.json('managed_scope') as
    | { includeSchemas?: unknown; excludeSchemas?: unknown }
    | undefined
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    ...(Array.isArray(scope?.includeSchemas)
      ? { includeSchemas: strings(scope?.includeSchemas) }
      : {}),
    excludeSchemas: strings(scope?.excludeSchemas),
  }
}

const INCOMPLETE_NONTX = sql`SELECT DISTINCT e.migration_id FROM exponetdb.migration_events e
 WHERE e.event = 'nontx_started'
   AND NOT EXISTS (SELECT 1 FROM exponetdb.schema_migrations m WHERE m.migration_id = e.migration_id)
   AND NOT EXISTS (SELECT 1 FROM exponetdb.migration_events r
                    WHERE r.migration_id = e.migration_id AND r.event = 'ledger_reconciled'
                      AND r.event_seq > e.event_seq)`

function latestOf(verifications: readonly VerificationRecord[], migrationId: string) {
  return verifications
    .filter((v) => v.migrationId === migrationId)
    .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0))[0]
}

const iso = (value: string) => new Date(value).toISOString()

/**
 * An imported row's verification (follow-up 4 addendum, C-5): the row never
 * has a run of its own, the baseline's verification checks it. Its status is
 * its share of the baseline's latest run: `failed` when one of its
 * expectations is open, `passed` when none is and the run kept every failure
 * (else the run's status, as the share is unknown), `error` when the run
 * could not read the history; `pending` without a run. A row whose file was
 * decided superseded is not checked: it says so, with the run's status.
 */
export function importedVerification(
  stem: string,
  baselineId: string,
  run: VerificationRecord | undefined,
  superseded: boolean,
) {
  const via = baselineId as `baseline:${string}`
  if (run === undefined) {
    return {
      status: 'pending' as const,
      verifiedAt: null,
      verifyDigest: null,
      via,
      ...(superseded ? { superseded: true as const } : {}),
    }
  }
  const verifiedAt = iso(run.finishedAt)
  if (superseded) {
    return { status: run.status, verifiedAt, verifyDigest: null, via, superseded: true as const }
  }
  const layer = layerFrom(run.structural, 'structural')
  const mine = (layer.failures ?? []).filter((f) => f.file === stem)
  const open = mine.filter((f) => !f.excused).length
  const excused = mine.length - open
  const complete =
    (layer.failed === 0 && (layer.excused ?? 0) === 0) ||
    (layer.failures !== undefined && (layer.failuresTotal ?? 0) <= layer.failures.length)
  const status =
    layer.status === 'error'
      ? ('error' as const)
      : open > 0
        ? ('failed' as const)
        : complete
          ? ('passed' as const)
          : run.status
  return { status, verifiedAt, verifyDigest: null, via, ...(excused > 0 ? { excused } : {}) }
}

function entryOf(r: LedgerRecord, verifications: readonly VerificationRecord[]) {
  const latest = latestOf(verifications, r.migrationId)
  return {
    migrationId: r.migrationId,
    origin: r.origin,
    name: r.name.slice(0, 200),
    checksum: r.checksum,
    appliedAt: iso(r.appliedAt),
    reverted: r.revertedAt !== null,
    operationId: /^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(r.operationId) ? r.operationId : null,
    verification:
      latest === undefined
        ? { status: 'pending' as const, verifiedAt: null, verifyDigest: null }
        : {
            status: latest.status,
            verifiedAt: iso(latest.finishedAt),
            verifyDigest: latest.verifyDigest,
          },
  }
}

/** `migration.status.get`: the target's ledger live, its verifications and what the store knows is pending. */
export async function migrationStatus(deps: ReadDeps, target: TargetRecord) {
  const scope = await scopeOf(deps.store, target.projectId)
  const opened = await deps.connector.forTarget(target, 'observer', `status/${target.targetId}`)
  let live: {
    state: Awaited<ReturnType<typeof readTargetState>>
    verifications: VerificationRecord[]
    incomplete: string[]
  }
  try {
    live = await opened.session.readOnly(
      async (tx) => ({
        state: await readTargetState(
          tx,
          {
            installationId: deps.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: target.placement?.systemIdentifier ?? null,
          },
          scope,
          { sizes: false },
        ),
        verifications: await readVerifications(tx),
        incomplete: (await tx.query(INCOMPLETE_NONTX)).map((r) => r.text('migration_id')),
      }),
      { statementTimeoutMs: 60_000 },
    )
  } finally {
    await opened.session.close()
  }
  const { state } = live
  // The rows a legacy import recorded are verified by their baseline (follow-up 4 addendum).
  const baseline = state.ledger.find((r) => r.origin === 'baseline' && r.revertedAt === null)
  const baselineRun =
    baseline === undefined ? undefined : latestOf(live.verifications, baseline.migrationId)
  const superseded =
    baseline?.planId === null || baseline === undefined
      ? new Set<string>()
      : await supersededImportedRows(deps.store, baseline.planId)
  const applied = new Set(state.ledger.map((r) => r.migrationId))
  const stream = await storedStream(deps.store, target.projectId)
  const pending: { migrationId: string; name: string; checksum: string }[] = []
  for (const [id, s] of stream) {
    if (applied.has(id)) continue
    const newest = (await revisionsOf(deps.store, target.projectId, id))[0]
    pending.push({ migrationId: id, name: newest?.name ?? '', checksum: s.checksum })
  }
  const { rows } = await deps.store.query(
    'migrations.reads.mirror_state',
    'SELECT ledger_state_hash, observed_at FROM migrations.ledger_state WHERE target_id = $1',
    [target.targetId],
  )
  const mirror = rows[0]
  const divergence = await ledgerDivergence(
    deps.store,
    target.targetId,
    target.generation,
    state.ledger,
  )
  return {
    targetId: target.targetId,
    ledgerStateHash: state.ledgerStateHash,
    baselineId: state.meta.baselineId,
    applied: state.ledger.map((r) =>
      r.origin === 'legacy_import' && baseline !== undefined
        ? {
            ...entryOf(r, live.verifications),
            verification: importedVerification(
              r.name,
              baseline.migrationId,
              baselineRun,
              superseded.has(r.migrationId),
            ),
          }
        : entryOf(r, live.verifications),
    ),
    pending,
    mirror: {
      inSync:
        mirror !== undefined &&
        divergence === null &&
        mirror.text('ledger_state_hash') === state.ledgerStateHash,
      checkedAt: new Date().toISOString(),
    },
    incompleteNontransactional: live.incomplete,
    source: 'live' as const,
    observedAt: state.observedAt,
  }
}

/**
 * A stored layer of a verification run as the contract shows it. A
 * baseline's run before Part A follow-up 3 stored counts only (`{checked,
 * held}`, `{fingerprint: match|mismatch}`): read as a layer that says how
 * many failed, without naming them. A missing layer did not run.
 */
export function layerFrom(value: unknown, layer: 'structural' | 'runtime' | 'engine'): Layer {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (typeof v['status'] === 'string') return v as unknown as Layer
  if (layer === 'structural' && typeof v['checked'] === 'number' && typeof v['held'] === 'number') {
    const failed = Math.max(0, v['checked'] - v['held'])
    const unparsed = typeof v['unparsed'] === 'string'
    return {
      // An unparsed chain checked nothing and failed the run: an error, as runs write it now.
      status: unparsed
        ? 'error'
        : v['checked'] === 0
          ? 'skipped'
          : failed === 0
            ? 'passed'
            : 'failed',
      checks: v['checked'],
      failed,
      firstFailure: unparsed
        ? { name: `unparsed: ${String(v['unparsed'])}`.slice(0, 128), detail: null }
        : null,
    }
  }
  if (layer === 'engine' && (v['fingerprint'] === 'match' || v['fingerprint'] === 'mismatch')) {
    const match = v['fingerprint'] === 'match'
    return {
      status: match ? 'passed' : 'failed',
      checks: 1,
      failed: match ? 0 : 1,
      firstFailure: match ? null : { name: 'schema fingerprint', detail: null },
    }
  }
  return { status: 'skipped', checks: 0, failed: 0, firstFailure: null }
}

/** `migration.get`: one migration's ledger row, events and verification runs (live). */
export async function migrationDetail(deps: ReadDeps, target: TargetRecord, migrationId: string) {
  const scope = await scopeOf(deps.store, target.projectId)
  const opened = await deps.connector.forTarget(target, 'observer', `migration/${target.targetId}`)
  try {
    return await opened.session.readOnly(
      async (tx) => {
        const state = await readTargetState(
          tx,
          {
            installationId: deps.installationId,
            targetId: target.targetId,
            generation: target.generation,
            systemIdentifier: target.placement?.systemIdentifier ?? null,
          },
          scope,
          { sizes: false },
        )
        const row = state.ledger.find((r) => r.migrationId === migrationId)
        const events = await readMigrationEvents(tx, { migrationId })
        const verifications = await readVerifications(tx, migrationId)
        const stream = await storedStream(deps.store, target.projectId)
        const partial = row === undefined && events.some((e) => e.event === 'nontx_started')
        return {
          targetId: target.targetId,
          migrationId,
          state:
            row !== undefined
              ? row.revertedAt === null
                ? ('applied' as const)
                : ('reverted' as const)
              : partial
                ? ('partially_applied' as const)
                : stream.has(migrationId)
                  ? ('pending' as const)
                  : ('unknown_to_target' as const),
          checksum: row?.checksum ?? stream.get(migrationId)?.checksum ?? null,
          appliedAt: row === undefined ? null : iso(row.appliedAt),
          operationId: row?.operationId ?? null,
          planId: row?.planId ?? null,
          fingerprintBefore: row?.fingerprintBefore ?? null,
          fingerprintAfter: row?.fingerprintAfter ?? null,
          events: events.map((e) => ({
            at: iso(e.at),
            event: e.event,
            operationId: /^op_/.test(e.operationId) ? e.operationId : null,
            statementIndex:
              typeof e.detail['statementIndex'] === 'number' ? e.detail['statementIndex'] : null,
            sqlstate:
              typeof e.detail['sqlstate'] === 'string' && /^[0-9A-Z]{5}$/.test(e.detail['sqlstate'])
                ? e.detail['sqlstate']
                : null,
          })),
          verifications: verifications.map((v) => ({
            verificationId: v.verificationId,
            migrationId: v.migrationId,
            operationId: v.operationId,
            verifyDigest: v.verifyDigest,
            status: v.status,
            startedAt: iso(v.startedAt),
            finishedAt: iso(v.finishedAt),
            structural: layerFrom(v.structural, 'structural'),
            runtime: layerFrom(v.runtime, 'runtime'),
            engine: layerFrom(v.engine, 'engine'),
            fingerprint: v.fingerprint,
          })),
          source: 'live' as const,
          observedAt: state.observedAt,
        }
      },
      { statementTimeoutMs: 60_000 },
    )
  } finally {
    await opened.session.close()
  }
}

/** `migration.bundle.get`: a stored bundle with every revision and the checksums rewritten before it. */
export async function bundleView(q: Queryable, projectId: string, migrationId: string) {
  const revisions = await revisionsOf(q, projectId, migrationId)
  const newest = revisions[0]
  if (newest === undefined) {
    throw new MigrationError('NOT_FOUND')
  }
  const current = revisions.filter((r) => r.checksum === newest.checksum)
  const superseded = new Map<string, string>()
  for (const r of revisions) {
    if (r.checksum !== newest.checksum && !superseded.has(r.checksum)) {
      superseded.set(r.checksum, r.ingestedAt)
    }
  }
  return {
    projectId,
    migrationId,
    name: newest.name,
    checksum: newest.checksum,
    transactional: newest.transactional,
    dependsOn: [...newest.dependsOn],
    revisions: current.map((r) => ({
      revision: r.revision,
      verifyDigest: r.verifyDigest,
      rollbackDigest: r.rollbackDigest,
      sourceDigest: r.sourceDigest,
      bundleDigest: r.bundleDigest,
      files: Object.fromEntries(
        Object.entries(r.files)
          .filter((e): e is [string, Uint8Array] => e[1] !== null)
          .map(([name, bytes]) => [name, { bytes: bytes.length, digest: fileDigest(bytes) }]),
      ),
      source: r.source,
      ingestedAt: r.ingestedAt,
    })),
    superseded: [...superseded].map(([checksum, ingestedAt]) => ({ checksum, ingestedAt })),
  }
}

/** One file of a revision, exactly as stored. */
export async function bundleFile(
  q: Queryable,
  projectId: string,
  migrationId: string,
  revision: number,
  file: 'migration.yaml' | 'up.sql' | 'verify.sql' | 'down.sql',
) {
  const r = (await revisionsOf(q, projectId, migrationId)).find((x) => x.revision === revision)
  const bytes = r?.files[file] ?? null
  if (r === undefined || bytes === null) {
    throw new MigrationError('NOT_FOUND')
  }
  const text = decodeUtf8(bytes)
  if (!text.ok) {
    throw new MigrationError('INTERNAL')
  }
  return {
    migrationId,
    revision,
    file,
    text: text.value,
    bytes: bytes.length,
    digest: fileDigest(bytes),
  }
}

export type ReviewFile = 'up.sql' | 'verify.sql' | 'down.sql'

const REVIEW_COLUMNS: Readonly<Record<ReviewFile, string>> = {
  'up.sql': 'up_sql',
  'verify.sql': 'verify_sql',
  'down.sql': 'down_sql',
}

/**
 * The files a plan runs, for the approval review, in one query: grouped by
 * file in the given order (every `up.sql` before any `verify.sql`), within a
 * file in the order of `items`; a revision without `down.sql` or
 * `verify.sql` simply has none. A revision the store does not have is left
 * out; bytes that are not UTF-8 are `INTERNAL`, as in `bundleFile`.
 */
export async function reviewFiles(
  q: Queryable,
  projectId: string,
  items: readonly { readonly migrationId: string; readonly revision: number }[],
  files: readonly ReviewFile[],
): Promise<
  {
    readonly migrationId: string
    readonly revision: number
    readonly file: ReviewFile
    readonly text: string
    readonly bytes: number
  }[]
> {
  if (items.length === 0 || files.length === 0) return []
  const { rows } = await q.query(
    'migrations.reads.review_files',
    // Only the files asked for: the column names come from REVIEW_COLUMNS, never from input.
    `SELECT r.migration_id, r.revision, ${files.map((f) => `r.${REVIEW_COLUMNS[f]}`).join(', ')}
       FROM migrations.bundle_revisions r
       JOIN unnest($2::text[], $3::int[]) AS w(migration_id, revision)
         ON w.migration_id = r.migration_id AND w.revision = r.revision
      WHERE r.project_id = $1`,
    [projectId, items.map((i) => i.migrationId), items.map((i) => i.revision)],
  )
  const byKey = new Map(rows.map((r) => [`${r.text('migration_id')}/${r.int('revision')}`, r]))
  const out = []
  for (const file of files) {
    for (const item of items) {
      const row = byKey.get(`${item.migrationId}/${item.revision}`)
      if (row === undefined) continue
      const column = REVIEW_COLUMNS[file]
      if (row.json(column) === null) continue
      const bytes = row.bytes(column)
      const text = decodeUtf8(bytes)
      if (!text.ok) throw new MigrationError('INTERNAL')
      out.push({
        migrationId: item.migrationId,
        revision: item.revision,
        file,
        text: text.value,
        bytes: bytes.length,
      })
    }
  }
  return out
}

/** `migration.lint`: the shared linter on submitted bundles, offline facts, the project's stream. */
export async function lintProject(
  q: Queryable,
  projectId: string,
  request: {
    readonly bundles: readonly BundleSubmission[]
    readonly defaults?: unknown
    readonly postgresMajor?: 16 | 17 | 18 | undefined
  },
) {
  const { rows } = await q.query(
    'migrations.reads.project',
    `SELECT p.slug, pr.slug AS product_slug, p.trusted_extensions, p.managed_scope
       FROM registry.projects p JOIN registry.products pr ON pr.product_id = p.product_id
      WHERE p.project_id = $1`,
    [projectId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new MigrationError('NOT_FOUND')
  }
  const defaults = parseProjectDefaults(request.defaults ?? {})
  if (!defaults.ok) {
    throw new MigrationError('MIGRATION_MANIFEST_INVALID', {
      errors: [
        { path: '/defaults', code: defaults.error.code, message: 'Invalid project defaults.' },
      ],
    })
  }
  const major = request.postgresMajor ?? 17
  await prepareLint(major)
  // Project-level lint has no target: the aliases of the project map (an environment
  // binding refines an alias, never adds one).
  const roles = await projectAliases(q, projectId)
  const trusted = row.json('trusted_extensions')
  const scope = await scopeOf(q, projectId)
  const project = {
    schema: 'exponetdb.project/v1',
    project: `${row.text('product_slug')}/${row.text('slug')}`,
    layout: 'bundles',
    defaults: defaults.value,
    executionRoles: Object.keys(roles).length > 0 ? roles : { owner: 'none' },
    managedScope: {
      includeSchemas: scope.includeSchemas ?? '*',
      excludeSchemas: scope.excludeSchemas,
    },
    trustedExtensions: Array.isArray(trusted) ? trusted : [],
    lintProfile: 'strict',
  } as unknown as ProjectConfig
  const stream = await storedStream(q, projectId)
  const report = lintBundles(
    request.bundles.map((b) => submissionInput(b, defaults.value)),
    {
      major,
      project,
      tier: 'prod',
      stream: [...stream].map(([id, s]) => ({ id, dependsOn: s.dependsOn })),
    },
  )
  return {
    bundles: report.bundles.map((b) => ({
      directory: b.directory,
      migrationId: b.migrationId,
      checksum: b.checksum,
      verifyDigest: b.verifyDigest,
      rollbackDigest: b.rollbackDigest,
      bundleDigest: b.bundleDigest,
      sourceDigest: b.sourceDigest,
      findings: b.findings.map((f) => ({
        rule: f.rule,
        level: f.level,
        blocking: f.blocking,
        message: f.message.slice(0, 1024),
        file: f.file,
        statementIndex: f.statementIndex,
        ...(f.code === undefined ? {} : { code: f.code }),
      })),
    })),
    graph: {
      valid: report.graph.valid,
      errors: report.graph.errors.map((e) => ({
        code: e.code.toUpperCase(),
        migrationIds: e.migrationIds.map((m) => m.slice(0, 80)),
      })),
    },
  }
}
