import type { InstallationId } from '@exponetdb/kernel'
import { pendingOrder } from '@exponetdb/migrations/graph'
import { type Logger, SafeError, silentLogger } from '@exponetdb/observability'
import { type BundleSet, expectedMigrations, type LoadedBundle, MIGRATE_LOGIN } from './bundles.ts'
import { ControlStoreError } from './errors.ts'
import { ensureInstallation } from './installation.ts'
import { compareSchema, readLedger, type SchemaState } from './ledger.ts'
import { MIGRATE_LOCK } from './locks.ts'
import type { ControlStore, Session } from './store.ts'
import { runVerification, searchPathValue, type VerificationResult } from './verify.ts'

/**
 * `exponetdb control-store migrate`: the bootstrap runner
 * ([control-database.md §5](../../../exponetdb-docs/02-control-plane/control-database.md#5-the-control-stores-own-migrations)).
 * It is not the Operations Engine: the engine depends on the Control Store,
 * so it cannot create it.
 *
 * 1. Connect as `exdb_migrate` and refuse any other login.
 * 2. Take the session advisory lock (one runner at a time).
 * 3. Read the ledger; refuse a checksum mismatch (hard failure) and ids this
 *    release does not know (the schema is newer: no downgrade).
 * 4. Apply pending bundles in DAG order, each in its own transaction:
 *    `up.sql` and its ledger row commit together.
 * 5. Write the installation marker on the first run; keep it afterwards.
 * 6. Verify, separately, every bundle whose latest verification did not pass
 *    with the shipped verify digest, and append the result.
 *
 * Applied is not verified: when `up.sql` committed but verification failed,
 * the next run never runs `up.sql` again; it sees "applied, unverified" and
 * runs the verification only. Nothing is rolled back automatically.
 */
export type MigrateErrorCode =
  | 'migrate_lock_timeout'
  | 'migrate_checksum_mismatch'
  | 'migrate_schema_newer'
  | 'migrate_ledger_inconsistent'
  | 'migrate_order_invalid'
  | 'migrate_apply_failed'
  | 'migrate_wrong_role'

export class MigrateError extends SafeError {
  override readonly name = 'MigrateError'
  declare readonly code: MigrateErrorCode
  /** Migration ids involved (shipped ids, not input). */
  readonly ids: readonly string[]
  readonly sqlstate: string | undefined

  constructor(
    code: MigrateErrorCode,
    ids: readonly string[] = [],
    options?: { cause?: unknown; sqlstate?: string },
  ) {
    super(
      code,
      'The Control Store migration run was refused.',
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.ids = ids
    this.sqlstate = options?.sqlstate
  }
}

export interface MigrateOptions {
  readonly store: ControlStore
  readonly bundles: BundleSet
  readonly engineVersion: string
  /** A fresh `ins_` id, used only if the Control Store has none yet. */
  readonly newInstallationId: () => InstallationId
  readonly lockWaitMs?: number
  readonly logger?: Logger
}

export interface VerificationOutcome {
  readonly migrationId: string
  readonly status: VerificationResult['status']
  readonly failedChecks: readonly string[]
  readonly errorCode?: string
}

export interface MigrateReport {
  readonly installationId: InstallationId
  readonly applied: readonly string[]
  readonly verifications: readonly VerificationOutcome[]
  readonly state: SchemaState
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function acquireLock(session: Session, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { rows } = await session.query(
      'migration.lock.try',
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS ok',
      [MIGRATE_LOCK.key1, MIGRATE_LOCK.key2],
    )
    if (rows[0]?.bool('ok') === true) {
      return
    }
    if (Date.now() >= deadline) {
      throw new MigrateError('migrate_lock_timeout')
    }
    await sleep(250)
  }
}

async function applyBundle(
  session: Session,
  bundle: LoadedBundle,
  engineVersion: string,
): Promise<void> {
  await session.transaction('migration.apply', async (tx) => {
    await tx.query(
      'migration.apply.settings',
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
              set_config('search_path', $3, true)`,
      [
        `${bundle.execution.lockTimeoutMs}ms`,
        `${bundle.execution.statementTimeoutMs}ms`,
        searchPathValue(bundle.execution.searchPath),
      ],
    )
    const who = await tx.query('migration.apply.role', 'SELECT current_user::text AS role')
    if (who.rows[0]?.text('role') !== MIGRATE_LOGIN) {
      throw new MigrateError('migrate_wrong_role')
    }
    const started = performance.now()
    await tx.executeScript('migration.apply.script', bundle.upSql)
    await tx.query(
      'migration.ledger.insert',
      `INSERT INTO control.schema_migrations
         (migration_id, name, checksum, verify_digest, rollback_digest, bundle_digest, dependencies,
          apply_duration_ms, engine_version, pg_version_num)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, current_setting('server_version_num')::int)`,
      [
        bundle.id,
        bundle.name,
        bundle.digests.checksum,
        bundle.digests.verifyDigest,
        bundle.digests.rollbackDigest,
        bundle.digests.bundleDigest,
        [...bundle.dependsOn].sort(),
        Math.round(performance.now() - started),
        engineVersion,
      ],
    )
  })
}

async function recordVerification(
  session: Session,
  bundle: LoadedBundle,
  result: VerificationResult,
  engineVersion: string,
): Promise<void> {
  const summary = {
    checks: result.checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      rows: c.rows,
      ...(c.reason === undefined ? {} : { reason: c.reason }),
      ...(c.detail === undefined ? {} : { detail: c.detail }),
    })),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  }
  await session.query(
    'migration.verification.insert',
    `INSERT INTO control.migration_verifications
       (migration_id, verify_digest, started_at, finished_at, status, summary, engine_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      bundle.id,
      bundle.digests.verifyDigest,
      result.startedAt,
      result.finishedAt,
      result.status,
      JSON.stringify(summary),
      engineVersion,
    ],
  )
}

export async function migrateControlStore(options: MigrateOptions): Promise<MigrateReport> {
  const log = options.logger ?? silentLogger
  const facts = await options.store.verifyLogin().catch((error: unknown) => {
    throw error instanceof ControlStoreError && error.code === 'control_store_wrong_role'
      ? new MigrateError('migrate_wrong_role', [], { cause: error })
      : error
  })
  if (facts.role !== MIGRATE_LOGIN) {
    throw new MigrateError('migrate_wrong_role')
  }
  const expected = expectedMigrations(options.bundles)
  const byId = new Map(options.bundles.bundles.map((b) => [b.id, b]))

  return options.store.session(async (session) => {
    await acquireLock(session, options.lockWaitMs ?? 120_000)
    try {
      const ledger = await readLedger(session)
      const before = compareSchema(expected, ledger)
      if (before.status === 'mismatch') {
        throw new MigrateError('migrate_checksum_mismatch', before.ids)
      }
      if (before.status === 'newer') {
        throw new MigrateError('migrate_schema_newer', before.unknown)
      }
      if (!ledger.exists) {
        const probe = await session.query(
          'migration.ledger.schema_probe',
          `SELECT to_regnamespace('control') IS NOT NULL AS present`,
        )
        if (probe.rows[0]?.bool('present') === true) {
          throw new MigrateError('migrate_ledger_inconsistent')
        }
      }
      const pending = pendingOrder(
        options.bundles.graph,
        new Set(ledger.entries.map((e) => e.migrationId)),
      )
      if (!pending.ok) {
        throw new MigrateError('migrate_order_invalid')
      }
      const applied: string[] = []
      for (const id of pending.value) {
        const bundle = byId.get(id)
        if (bundle === undefined) {
          throw new MigrateError('migrate_order_invalid', [id])
        }
        try {
          await applyBundle(session, bundle, options.engineVersion)
        } catch (error) {
          if (error instanceof MigrateError) {
            throw error
          }
          const sqlstate = error instanceof ControlStoreError ? error.sqlstate : undefined
          throw new MigrateError(
            'migrate_apply_failed',
            [id],
            sqlstate === undefined ? { cause: error } : { cause: error, sqlstate },
          )
        }
        applied.push(id)
        log.info('control_store.migration.applied', { migrationId: id, migrationName: bundle.name })
      }

      const installationId = await ensureInstallation(
        session,
        options.newInstallationId(),
        options.engineVersion,
      )

      const current = await readLedger(session)
      const verifications: VerificationOutcome[] = []
      for (const bundle of options.bundles.bundles) {
        const latest = current.latest.get(bundle.id)
        if (latest?.status === 'passed' && latest.verifyDigest === bundle.digests.verifyDigest) {
          continue
        }
        const result = await runVerification(options.store, bundle)
        await recordVerification(session, bundle, result, options.engineVersion)
        const outcome: VerificationOutcome = {
          migrationId: bundle.id,
          status: result.status,
          failedChecks: result.checks.filter((c) => !c.ok).map((c) => c.name),
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }
        verifications.push(outcome)
        const fields = {
          migrationId: bundle.id,
          migrationName: bundle.name,
          outcome: result.status,
        }
        if (result.status === 'passed') {
          log.info('control_store.migration.verified', fields)
        } else {
          log.error('control_store.migration.verification_failed', {
            ...fields,
            ...(result.errorCode === undefined ? {} : { code: result.errorCode }),
          })
        }
      }
      const state = compareSchema(expected, await readLedger(session))
      return { installationId, applied, verifications, state }
    } finally {
      await session
        .query('migration.lock.release', 'SELECT pg_advisory_unlock($1::int, $2::int)', [
          MIGRATE_LOCK.key1,
          MIGRATE_LOCK.key2,
        ])
        .catch(() => undefined)
    }
  })
}
