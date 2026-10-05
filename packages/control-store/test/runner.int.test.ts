import { newId } from '@exponetdb/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ControlStore,
  expectedMigrations,
  loadBundleSet,
  MIGRATE_LOCK,
  MigrateError,
  migrateControlStore,
  schemaState,
} from '../src/index.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing/index.ts'
import { type BundleDir, bundleDir, probeBundle } from './fixtures.ts'

const PROBE = '01M46KZZZZZZZZZZZZZZZZZZZZ'
const PROBE_DIR = `${PROBE}_probe`
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn()
  }
})

async function setup(): Promise<{ db: TestDatabase; dir: BundleDir }> {
  const db = await createTestDatabase('exdb_it_runner')
  const dir = await bundleDir()
  cleanup.push(
    () => db.drop(),
    () => dir.remove(),
  )
  return { db, dir }
}

async function migrate(store: ControlStore, path: string, lockWaitMs?: number) {
  return migrateControlStore({
    store,
    bundles: await loadBundleSet(path),
    engineVersion: 'test',
    newInstallationId: () => newId('ins', Date.now()),
    ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
  })
}

async function probeRuns(db: TestDatabase): Promise<number> {
  return db.asSuperuser(async (c) =>
    Number((await c.query('SELECT count(*) AS n FROM control.probe_runs')).rows[0].n),
  )
}

async function refusal(promise: Promise<unknown>): Promise<MigrateError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof MigrateError) {
      return error
    }
    throw error
  }
  throw new Error('expected a MigrateError')
}

describe('runner: applied is not verified', () => {
  it('a failed verification after commit is retried without re-running up.sql', async () => {
    const { db, dir } = await setup()
    await dir.add(
      PROBE_DIR,
      probeBundle(PROBE, {
        verify: "-- check: deliberately false\nSELECT false AS ok, 'probe says no' AS detail;\n",
      }),
    )
    const store = db.store('exdb_migrate')

    const first = await migrate(store, dir.path)
    expect(first.applied).toContain(PROBE)
    expect(first.verifications.find((v) => v.migrationId === PROBE)).toMatchObject({
      status: 'failed',
      failedChecks: ['deliberately false'],
    })
    expect(first.state).toEqual({ status: 'unverified', ids: [PROBE] })
    expect(await probeRuns(db)).toBe(1)
    const expected = expectedMigrations(await loadBundleSet(dir.path))
    expect(await schemaState(db.store('exdb_serve'), expected)).toEqual({
      status: 'unverified',
      ids: [PROBE],
    })

    // Same run again: still applied once, still unverified (verification re-runs, fails again).
    const second = await migrate(store, dir.path)
    expect(second.applied).toEqual([])
    expect(second.verifications.map((v) => v.status)).toEqual(['failed'])
    expect(await probeRuns(db)).toBe(1)

    // A verify revision (same up.sql, fixed verify.sql) verifies without re-running up.sql.
    await dir.write(
      PROBE_DIR,
      'verify.sql',
      '-- check: probe ran exactly once\nSELECT count(*) = 1 AS ok FROM control.probe_runs;\n',
    )
    const third = await migrate(store, dir.path)
    expect(third.applied).toEqual([])
    expect(third.verifications).toEqual([
      { migrationId: PROBE, status: 'passed', failedChecks: [] },
    ])
    expect(third.state).toEqual({ status: 'current' })
    expect(await probeRuns(db)).toBe(1)

    const history = await db.asSuperuser(
      async (c) =>
        (
          await c.query(
            'SELECT status, summary FROM control.migration_verifications WHERE migration_id = $1 ORDER BY verification_seq',
            [PROBE],
          )
        ).rows,
    )
    expect(history.map((h) => h.status)).toEqual(['failed', 'failed', 'passed'])
    expect(history[0].summary.checks[0]).toMatchObject({
      ok: false,
      reason: 'ok_false',
      detail: 'probe says no',
    })
  })

  it('zero rows fail and a statement error is recorded as error with its SQLSTATE', async () => {
    const { db, dir } = await setup()
    await dir.add(
      PROBE_DIR,
      probeBundle(PROBE, { verify: '-- check: nothing found\nSELECT true AS ok WHERE false;\n' }),
    )
    const store = db.store('exdb_migrate')
    const report = await migrate(store, dir.path)
    expect(report.verifications.find((v) => v.migrationId === PROBE)).toMatchObject({
      status: 'failed',
      failedChecks: ['nothing found'],
    })
    await dir.write(PROBE_DIR, 'verify.sql', '-- check: broken\nSELECT FROM WHERE;\n')
    const broken = await migrate(store, dir.path)
    expect(broken.verifications).toEqual([
      { migrationId: PROBE, status: 'error', failedChecks: [], errorCode: '42601' },
    ])
  })

  it('verification runs read-only and is rolled back', async () => {
    const { db, dir } = await setup()
    await dir.add(
      PROBE_DIR,
      probeBundle(PROBE, {
        verify:
          '-- check: tries to write\nINSERT INTO control.probe_runs (n) VALUES (2) RETURNING true AS ok;\n',
      }),
    )
    const report = await migrate(db.store('exdb_migrate'), dir.path)
    expect(report.verifications.find((v) => v.migrationId === PROBE)).toMatchObject({
      status: 'error',
      errorCode: '25006',
    })
    expect(await probeRuns(db)).toBe(1)
  })
})

describe('runner: refusals', () => {
  it('refuses a checksum mismatch of an applied bundle', async () => {
    const { db, dir } = await setup()
    await dir.add(PROBE_DIR, probeBundle(PROBE))
    const store = db.store('exdb_migrate')
    await migrate(store, dir.path)
    // Comment-only edits keep the c1 checksum; an executable change does not.
    await dir.write(
      PROBE_DIR,
      'up.sql',
      '-- only a comment changed\nCREATE TABLE control.probe_runs (n integer NOT NULL);\nINSERT INTO control.probe_runs (n) VALUES (1);\n',
    )
    expect((await migrate(store, dir.path)).applied).toEqual([])
    await dir.write(PROBE_DIR, 'up.sql', 'CREATE TABLE control.probe_runs (n bigint NOT NULL);\n')
    const error = await refusal(migrate(store, dir.path))
    expect(error.code).toBe('migrate_checksum_mismatch')
    expect(error.ids).toEqual([PROBE])
    const expected = expectedMigrations(await loadBundleSet(dir.path))
    expect(await schemaState(db.store('exdb_gateway'), expected)).toEqual({
      status: 'mismatch',
      ids: [PROBE],
    })
  })

  it('refuses a ledger that is newer than the release (no downgrade)', async () => {
    const { db, dir } = await setup()
    await dir.add(PROBE_DIR, probeBundle(PROBE))
    await migrate(db.store('exdb_migrate'), dir.path)
    const shipped = await bundleDir()
    cleanup.push(() => shipped.remove())
    const error = await refusal(migrate(db.store('exdb_migrate'), shipped.path))
    expect(error.code).toBe('migrate_schema_newer')
    expect(error.ids).toEqual([PROBE])
    expect(
      await schemaState(
        db.store('exdb_serve'),
        expectedMigrations(await loadBundleSet(shipped.path)),
      ),
    ).toEqual({
      status: 'newer',
      unknown: [PROBE],
    })
  })

  it('reports a missing expected bundle as pending', async () => {
    const { db, dir } = await setup()
    await dir.keepOnly(['01M46KHY80CWGMHV633DGSP8S8'])
    await migrate(db.store('exdb_migrate'), dir.path)
    const full = await loadBundleSet()
    const state = await schemaState(db.store('exdb_serve'), expectedMigrations(full))
    expect(state.status).toBe('pending')
  })

  it('rolls back a failing up.sql completely and records nothing', async () => {
    const { db, dir } = await setup()
    await dir.add(
      PROBE_DIR,
      probeBundle(PROBE, { up: 'CREATE TABLE control.probe_runs (n integer);\nSELECT 1 / 0;\n' }),
    )
    const error = await refusal(migrate(db.store('exdb_migrate'), dir.path))
    expect(error.code).toBe('migrate_apply_failed')
    expect(error.sqlstate).toBe('22012')
    expect(error.ids).toEqual([PROBE])
    const state = await db.asSuperuser(async (c) => ({
      table: (await c.query("SELECT to_regclass('control.probe_runs') IS NOT NULL AS t")).rows[0].t,
      ledger: Number(
        (
          await c.query(
            'SELECT count(*) AS n FROM control.schema_migrations WHERE migration_id = $1',
            [PROBE],
          )
        ).rows[0].n,
      ),
    }))
    expect(state).toEqual({ table: false, ledger: 0 })
  })

  it('refuses any login other than exdb_migrate', async () => {
    const { db } = await setup()
    const error = await refusal(migrate(db.store('exdb_worker'), (await bundleDir()).path))
    expect(error.code).toBe('migrate_wrong_role')
  })
})

describe('runner: one run at a time', () => {
  it('two concurrent runs apply each bundle once', async () => {
    const { db, dir } = await setup()
    const [a, b] = await Promise.all([
      migrate(db.store('exdb_migrate'), dir.path),
      migrate(db.store('exdb_migrate'), dir.path),
    ])
    const applied = [...a.applied, ...b.applied].sort()
    const set = await loadBundleSet(dir.path)
    expect(applied).toEqual(set.bundles.map((x) => x.id).sort())
    expect(a.installationId).toBe(b.installationId)
    const rows = await db.asSuperuser(async (c) =>
      Number((await c.query('SELECT count(*) AS n FROM control.schema_migrations')).rows[0].n),
    )
    expect(rows).toBe(set.bundles.length)
  })

  it('gives up when the advisory lock stays taken', async () => {
    const { db, dir } = await setup()
    const holder = db.store('exdb_migrate')
    await holder.session(async (s) => {
      await s.query('test.lock', 'SELECT pg_advisory_lock($1::int, $2::int)', [
        MIGRATE_LOCK.key1,
        MIGRATE_LOCK.key2,
      ])
      const error = await refusal(migrate(db.store('exdb_migrate'), dir.path, 600))
      expect(error.code).toBe('migrate_lock_timeout')
      await s.query('test.unlock', 'SELECT pg_advisory_unlock($1::int, $2::int)', [
        MIGRATE_LOCK.key1,
        MIGRATE_LOCK.key2,
      ])
    })
  })
})
