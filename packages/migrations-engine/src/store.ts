import type { BundleSubmission, SourceClaim } from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import { encodeUtf8, isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import {
  type BundleFailure,
  type BundleInput,
  parseProjectDefaults,
  validateBundle,
} from '@exponetdb/migrations/format'
import { MigrationError } from './errors.ts'

/**
 * The bundle store ([migration-bundles.md §3](../../../../exponetdb-docs/04-migrations/migration-bundles.md#what-a-mismatch-means),
 * G6 order §12): the exact bytes of every ingested revision, validated and
 * hashed by the server itself (a client's hashes are no authority), stored
 * immutably per `(project, migration id, revision)`.
 *
 * - the same bytes again are `unchanged` (the stored revision);
 * - a new verify, rollback or comment content with the same apply checksum
 *   is a `verify_revision` (the apply checksum and finished verifications
 *   are never touched);
 * - a new apply checksum is allowed only for an id no target of the
 *   project ever applied (`rewritten_unapplied`, the earlier bytes stay
 *   for audit); otherwise `MIGRATION_CHECKSUM_MISMATCH`.
 *
 * A source reference is stored as the submitter claimed it (OD-6 (a)):
 * nothing is fetched, no repository is read, no URL is resolved.
 */
export interface StoredRevision {
  readonly projectId: string
  readonly migrationId: string
  readonly revision: number
  readonly name: string
  readonly checksum: string
  readonly verifyDigest: string | null
  readonly rollbackDigest: string | null
  readonly sourceDigest: string
  readonly bundleDigest: string
  readonly transactional: boolean
  readonly dependsOn: readonly string[]
  /** P of c1 with the defaults materialized. */
  readonly manifest: JsonObject
  /** The project defaults the checksum was computed with. */
  readonly defaults: JsonObject
  readonly files: {
    readonly 'migration.yaml': Uint8Array
    readonly 'up.sql': Uint8Array
    readonly 'verify.sql': Uint8Array | null
    readonly 'down.sql': Uint8Array | null
  }
  readonly source: JsonObject | null
  readonly ingestedAt: string
}

export type IngestStatus = 'stored' | 'unchanged' | 'verify_revision' | 'rewritten_unapplied'

export interface IngestedItem {
  readonly status: IngestStatus
  readonly revision: StoredRevision
}

export interface IngestInput {
  readonly projectId: string
  readonly bundles: readonly BundleSubmission[]
  readonly defaults: unknown
  readonly source?: SourceClaim
  readonly identityId: string
  /** The identity's quota; {@link INGEST_DAILY_BYTES} unless a caller (a test) names another. */
  readonly dailyBytes?: number
  /** The configured Control Store volume (OD-70 (b)); absent: not checked. */
  readonly volumeBytes?: number
}

/** OD-70 (b): ingest stops when the Control Store database fills this share of its volume. */
export const VOLUME_REFUSE_PERCENT = 90

/**
 * The bundle bytes one identity may store in 24 hours (VC-001; the value is
 * [OD-70](../../../exponetdb-docs/00-product/open-decisions.md#od-70-control-store-disk-and-bundle-ingest)).
 * Revisions are permanent (the table is append-only), so a holder of
 * `migrations.plan` could otherwise fill the Control Store's disk with a few
 * requests until PostgreSQL stops. Re-submitting stored bytes costs nothing.
 */
export const INGEST_DAILY_BYTES = 64 * 1024 * 1024

// shortcut: a scan of the identity's revisions of the last day (no index on ingested_by); index it
// in a new bundle once bundle_revisions holds more than some 100,000 rows.
const QUOTA_USED = `SELECT coalesce(sum(octet_length(manifest_yaml) + octet_length(up_sql)
          + coalesce(octet_length(verify_sql), 0) + coalesce(octet_length(down_sql), 0)), 0)::bigint AS used,
        ceil(extract(epoch FROM min(ingested_at) + interval '1 day' - clock_timestamp()))::int AS wait
   FROM migrations.bundle_revisions
  WHERE ingested_by = $1 AND ingested_at > clock_timestamp() - interval '1 day'`

const COLUMNS = `project_id, migration_id, revision, name, checksum, verify_digest, rollback_digest,
  source_digest, bundle_digest, transactional, depends_on, manifest, defaults, manifest_yaml, up_sql,
  verify_sql, down_sql, source, ingested_at`

function revisionFrom(row: Row): StoredRevision {
  const manifest = row.json('manifest') as JsonValue
  const defaults = row.json('defaults') as JsonValue
  const source = row.json('source') as JsonValue
  const verify =
    row.has('verify_sql') && row.json('verify_sql') !== null ? row.bytes('verify_sql') : null
  const down = row.has('down_sql') && row.json('down_sql') !== null ? row.bytes('down_sql') : null
  return {
    projectId: row.text('project_id'),
    migrationId: row.text('migration_id'),
    revision: row.int('revision'),
    name: row.text('name'),
    checksum: row.text('checksum'),
    verifyDigest: row.textOrNull('verify_digest'),
    rollbackDigest: row.textOrNull('rollback_digest'),
    sourceDigest: row.text('source_digest'),
    bundleDigest: row.text('bundle_digest'),
    transactional: row.bool('transactional'),
    dependsOn: row.textArray('depends_on'),
    manifest: isJsonObject(manifest) ? manifest : {},
    defaults: isJsonObject(defaults) ? defaults : {},
    files: {
      'migration.yaml': row.bytes('manifest_yaml'),
      'up.sql': row.bytes('up_sql'),
      'verify.sql': verify,
      'down.sql': down,
    },
    source: isJsonObject(source) ? source : null,
    ingestedAt: row.date('ingested_at').toISOString(),
  }
}

/** The bundle's files as bytes (the JSON body carries them as text; UTF-8 bytes are what is hashed). */
export function submissionInput(bundle: BundleSubmission, defaults: unknown): BundleInput {
  const files = new Map<string, Uint8Array>()
  for (const [name, text] of Object.entries(bundle.files)) {
    if (typeof text === 'string') files.set(name, encodeUtf8(text))
  }
  return { directory: bundle.directory, files, projectDefaults: defaults }
}

/** The input of a stored revision for the linter (the stored bytes, the stored defaults). */
export function revisionInput(r: StoredRevision): BundleInput {
  const files = new Map<string, Uint8Array>([
    ['migration.yaml', r.files['migration.yaml']],
    ['up.sql', r.files['up.sql']],
  ])
  if (r.files['verify.sql'] !== null) files.set('verify.sql', r.files['verify.sql'])
  if (r.files['down.sql'] !== null) files.set('down.sql', r.files['down.sql'])
  return { directory: `${r.migrationId}_${r.name}`, files, projectDefaults: r.defaults }
}

function bundleRefusal(failure: BundleFailure): MigrationError {
  return new MigrationError(failure.code, failure.details as unknown as JsonObject)
}

/** Every checksum of an id applied on any target of the project (mirror), reverted rows included. */
async function appliedElsewhere(
  q: Queryable,
  projectId: string,
  migrationId: string,
): Promise<{ readonly checksum: string; readonly targetId: string }[]> {
  const { rows } = await q.query(
    'migrations.store.applied_elsewhere',
    `SELECT m.checksum, m.target_id FROM migrations.ledger_mirror m
       JOIN registry.targets t ON t.target_id = m.target_id
      WHERE t.project_id = $1 AND m.migration_id = $2
      ORDER BY m.target_id`,
    [projectId, migrationId],
  )
  return rows.map((r) => ({ checksum: r.text('checksum'), targetId: r.text('target_id') }))
}

/** Ingests bundles in the caller's transaction (serve); refuses the whole submission on the first refusal. */
export async function ingestBundles(tx: Tx, input: IngestInput): Promise<IngestedItem[]> {
  const defaults = parseProjectDefaults(input.defaults ?? {})
  if (!defaults.ok) {
    throw new MigrationError('MIGRATION_MANIFEST_INVALID', {
      errors: [
        { path: '/defaults', code: defaults.error.code, message: 'Invalid project defaults.' },
      ],
    })
  }
  const quota = input.dailyBytes ?? INGEST_DAILY_BYTES
  // One identity's ingests one at a time, so two requests cannot both pass the quota.
  await tx.query(
    'migrations.store.quota_lock',
    'SELECT pg_advisory_xact_lock(1163412546, hashtext($1))',
    [`bundle-quota/${input.identityId}`],
  )
  if (input.volumeBytes !== undefined) {
    const size = await tx.query(
      'migrations.store.volume_used',
      'SELECT pg_database_size(current_database())::bigint AS n',
    )
    const usedBytes = Number(size.rows[0]?.text('n') ?? '0')
    if (usedBytes * 100 >= input.volumeBytes * VOLUME_REFUSE_PERCENT) {
      throw new MigrationError('CONTROL_STORE_VOLUME_FULL', {
        usedBytes,
        volumeBytes: input.volumeBytes,
      })
    }
  }
  const usage = (await tx.query('migrations.store.quota_used', QUOTA_USED, [input.identityId]))
    .rows[0]
  let used = usage === undefined ? 0 : Number(usage.text('used'))
  const wait = usage?.intOrNull('wait') ?? 24 * 3600
  const seen = new Set<string>()
  const out: IngestedItem[] = []
  for (const bundle of input.bundles) {
    const validated = validateBundle(submissionInput(bundle, defaults.value))
    if (!validated.ok) {
      throw bundleRefusal(validated.error)
    }
    const v = validated.value
    const id = v.manifest.id
    if (seen.has(id)) {
      throw new MigrationError('MIGRATION_BUNDLE_INVALID', { reason: 'duplicate_migration_id' })
    }
    seen.add(id)
    // One ingestion of an id at a time (revision numbers are assigned here).
    await tx.query(
      'migrations.store.lock',
      'SELECT pg_advisory_xact_lock(1163412546, hashtext($1))',
      [`bundle/${input.projectId}/${id}`],
    )
    const { rows } = await tx.query(
      'migrations.store.revisions_of',
      `SELECT ${COLUMNS} FROM migrations.bundle_revisions
        WHERE project_id = $1 AND migration_id = $2 ORDER BY revision DESC`,
      [input.projectId, id],
    )
    const existing = rows.map(revisionFrom)
    const same = existing.find(
      (r) => r.checksum === v.digests.checksum && r.bundleDigest === v.digests.bundleDigest,
    )
    if (same !== undefined) {
      out.push({ status: 'unchanged', revision: same })
      continue
    }
    const newest = existing[0]
    let status: IngestStatus = 'stored'
    if (newest !== undefined) {
      if (existing.some((r) => r.checksum === v.digests.checksum)) {
        status = 'verify_revision'
      } else {
        const applied = (await appliedElsewhere(tx, input.projectId, id)).find(
          (a) => a.checksum !== v.digests.checksum,
        )
        if (applied !== undefined) {
          throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', {
            migrationId: id,
            knownChecksum: applied.checksum,
            where: { kind: 'target_ledger', targetId: applied.targetId },
          })
        }
        status = 'rewritten_unapplied'
      }
    } else {
      const applied = (await appliedElsewhere(tx, input.projectId, id)).find(
        (a) => a.checksum !== v.digests.checksum,
      )
      if (applied !== undefined) {
        throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', {
          migrationId: id,
          knownChecksum: applied.checksum,
          where: { kind: 'target_ledger', targetId: applied.targetId },
        })
      }
    }
    const files = submissionInput(bundle, defaults.value).files
    const bytes = ['migration.yaml', 'up.sql', 'verify.sql', 'down.sql'].reduce(
      (n, name) => n + (files.get(name)?.byteLength ?? 0),
      0,
    )
    if (used + bytes > quota) {
      throw new MigrationError('RATE_LIMITED', { retryAfterSeconds: Math.max(1, wait) })
    }
    used += bytes
    const revision = (newest?.revision ?? 0) + 1
    const source =
      input.source === undefined
        ? null
        : {
            repository: input.source.repository,
            commit: input.source.commit,
            path: input.source.path,
            provenance: 'claimed',
          }
    const inserted = await tx.query(
      'migrations.store.insert',
      `INSERT INTO migrations.bundle_revisions
         (project_id, migration_id, revision, name, checksum, verify_digest, rollback_digest, source_digest,
          bundle_digest, transactional, depends_on, manifest, defaults, manifest_yaml, up_sql, verify_sql,
          down_sql, source, ingested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13::jsonb, $14, $15, $16,
               $17, $18::jsonb, $19)
       RETURNING ${COLUMNS}`,
      [
        input.projectId,
        id,
        revision,
        v.manifest.name,
        v.digests.checksum,
        v.digests.verifyDigest,
        v.digests.rollbackDigest,
        v.digests.sourceDigest,
        v.digests.bundleDigest,
        v.manifest.execution.transactional,
        [...new Set(v.manifest.dependsOn)].sort(),
        JSON.stringify(v.digests.canonicalManifest),
        JSON.stringify(defaults.value),
        Buffer.from(files.get('migration.yaml') ?? new Uint8Array()),
        Buffer.from(files.get('up.sql') ?? new Uint8Array()),
        files.has('verify.sql') ? Buffer.from(files.get('verify.sql') as Uint8Array) : null,
        files.has('down.sql') ? Buffer.from(files.get('down.sql') as Uint8Array) : null,
        source === null ? null : JSON.stringify(source),
        input.identityId,
      ],
    )
    const row = inserted.rows[0]
    if (row === undefined) {
      throw new MigrationError('INTERNAL')
    }
    out.push({ status, revision: revisionFrom(row) })
  }
  return out
}

/** One revision (or the newest one) of a migration id. */
export async function readRevision(
  q: Queryable,
  projectId: string,
  migrationId: string,
  revision?: number,
): Promise<StoredRevision | undefined> {
  const { rows } = await q.query(
    'migrations.store.read',
    `SELECT ${COLUMNS} FROM migrations.bundle_revisions
      WHERE project_id = $1 AND migration_id = $2 AND ($3::int IS NULL OR revision = $3::int)
      ORDER BY revision DESC LIMIT 1`,
    [projectId, migrationId, revision ?? null],
  )
  const row = rows[0]
  return row === undefined ? undefined : revisionFrom(row)
}

/** Every revision of an id, newest first. */
export async function revisionsOf(
  q: Queryable,
  projectId: string,
  migrationId: string,
): Promise<StoredRevision[]> {
  const { rows } = await q.query(
    'migrations.store.revisions',
    `SELECT ${COLUMNS} FROM migrations.bundle_revisions
      WHERE project_id = $1 AND migration_id = $2 ORDER BY revision DESC`,
    [projectId, migrationId],
  )
  return rows.map(revisionFrom)
}

/**
 * The stream of a project as the store knows it: per id, its newest
 * revision's dependencies (the graph does not depend on file bytes).
 */
export async function storedStream(
  q: Queryable,
  projectId: string,
): Promise<Map<string, { readonly dependsOn: readonly string[]; readonly checksum: string }>> {
  const { rows } = await q.query(
    'migrations.store.stream',
    `SELECT DISTINCT ON (migration_id) migration_id, depends_on, checksum
       FROM migrations.bundle_revisions WHERE project_id = $1
      ORDER BY migration_id, revision DESC`,
    [projectId],
  )
  return new Map(
    rows.map((r) => [
      r.text('migration_id'),
      { dependsOn: r.textArray('depends_on'), checksum: r.text('checksum') },
    ]),
  )
}

/** SHA-256 of exact stored bytes (the bundle view's per-file digests). */
export function fileDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`
}
