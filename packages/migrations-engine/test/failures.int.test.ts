import { randomBytes } from 'node:crypto'
import { type MigrationId, newId } from '@exponetdb/kernel'
import {
  type ChangedBinding,
  type DispatchAdmission,
  type OperationRecord,
  requestVerificationRetry,
} from '@exponetdb/operations'
import {
  readLedgerRows,
  readMigrationEvents,
  readVerifications,
  sql,
  TargetError,
  type TrustedSql,
} from '@exponetdb/postgres'
import type { Connector } from '@exponetdb/registry'
import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationError } from '../../registry/test/harness.ts'
import { MigrationError, planMigrationVerify, readProgress } from '../src/index.ts'
import { writeMirror } from '../src/records.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './world.ts'

/**
 * The failure cases of the migration engine
 * ([`failure-and-recovery.md` §1](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#1-edge-case-catalog)),
 * each one caused for real on PostgreSQL 17: a lock held by another
 * session, a statement cut off by its timeout, a COMMIT whose reply never
 * arrives, a backend terminated while it waits, a verify.sql that fails or
 * cannot get its lock, a ledger changed by hand, and an applying identity
 * whose authority is revoked between two migrations. Every case checks the
 * outcome, the per-migration progress, the target's own ledger and what a
 * next plan does.
 */
const pg17 = serverFor(17)
let w: World
let t: Target
let base = '' as MigrationId

async function ledger(target: Target) {
  const opened = await w.h.workerConnector.forTarget(target.record, 'observer', 'test')
  try {
    return await opened.session.readOnly((tx) => readLedgerRows(tx))
  } finally {
    await opened.session.close()
  }
}

async function verifications(target: Target, migrationId: string) {
  const opened = await w.h.workerConnector.forTarget(target.record, 'observer', 'test')
  try {
    return await opened.session.readOnly((tx) => readVerifications(tx, migrationId))
  } finally {
    await opened.session.close()
  }
}

async function events(target: Target, migrationId: string) {
  const opened = await w.h.workerConnector.forTarget(target.record, 'observer', 'test')
  try {
    return await opened.session.readOnly((tx) => readMigrationEvents(tx, { migrationId }))
  } finally {
    await opened.session.close()
  }
}

async function asSuperuser<T>(
  target: Target,
  fn: (c: Awaited<ReturnType<typeof superuserClient>>) => Promise<T>,
): Promise<T> {
  const c = await superuserClient(pg17, target.database)
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function hasColumn(target: Target, table: string, column: string): Promise<boolean> {
  return asSuperuser(target, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    )
    return r.rowCount === 1
  })
}

async function errorOf(op: OperationRecord): Promise<string | null> {
  return (await operationError(w.h, op.operationId)).code
}

async function refusal(p: Promise<unknown>): Promise<MigrationError> {
  try {
    await p
  } catch (error) {
    if (error instanceof MigrationError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/**
 * A connector whose migrator sessions lose the reply to the first COMMIT:
 * `commit` lets the server commit, `rollback` never lets the COMMIT arrive.
 * Either way the engine sees a broken connection after sending COMMIT.
 */
function lostCommitReply(mode: 'commit' | 'rollback'): (c: Connector) => Connector {
  let fired = false
  return (connector) =>
    new Proxy(connector, {
      get(real, prop) {
        const value = Reflect.get(real, prop, real)
        if (prop !== 'forTarget' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(real) : value
        }
        return async (...args: Parameters<Connector['forTarget']>) => {
          const opened = await real.forTarget(...args)
          if (args[1] !== 'migrator') return opened
          const session = new Proxy(opened.session, {
            get(s, p) {
              const v = Reflect.get(s, p, s)
              if (p !== 'query' || typeof v !== 'function') {
                return typeof v === 'function' ? v.bind(s) : v
              }
              return async (statement: TrustedSql, ...rest: unknown[]) => {
                if (!fired && statement.text === 'COMMIT') {
                  fired = true
                  await s.query(mode === 'commit' ? statement : sql`ROLLBACK`)
                  throw new TargetError('TARGET_UNAVAILABLE', 'connection_lost')
                }
                return (s.query as (...a: unknown[]) => unknown)(statement, ...rest)
              }
            },
          })
          return { ...opened, session }
        }
      },
    })
}

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_failures', pg17)
  t = await w.registerTarget('fail-a', 'nonprod')
  base = w.ulid()
  const op = await w.apply(
    await w.plan(t, {
      bundles: [
        w.bundle({
          id: base,
          name: 'items',
          up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n',
        }),
      ],
    }),
  )
  expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
}, 240_000)

afterAll(async () => {
  await w?.close()
})

describe('failures before COMMIT (E1, E6, E30)', () => {
  it('E1: a lock timeout leaves nothing applied; the same bundle applies once the lock is gone', async () => {
    const id = w.ulid()
    const spec = {
      id,
      name: 'items-note',
      up: 'ALTER TABLE public.items ADD COLUMN note text;\n',
      dependsOn: [base],
    }
    // An application transaction writes to the table: ALTER TABLE waits for it, catalog reads do not.
    const p = await w.plan(t, { bundles: [w.bundle(spec)] })
    const holder = await superuserClient(pg17, t.database)
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ROW EXCLUSIVE MODE')
      const op = await w.apply(p)
      expect(op).toMatchObject({
        state: 'failed',
        applyOutcome: 'not_applied',
        verificationOutcome: 'not_applicable',
      })
      expect(await errorOf(op)).toBe('MIGRATION_LOCK_TIMEOUT')
      expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
        applyOutcome: 'not_applied',
        statementIndex: 0,
        sqlstate: '55P03',
        errorCode: 'MIGRATION_LOCK_TIMEOUT',
      })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
    expect(await hasColumn(t, 'items', 'note')).toBe(false)
    // Nothing was applied: the stored bundle is planned again, unchanged.
    const again = await w.apply(await w.plan(t, { migrationIds: [id] }))
    expect(again).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    expect(await hasColumn(t, 'items', 'note')).toBe(true)
  })

  it('E30: a data change cut off by its statement timeout rolls back completely', async () => {
    const table = w.ulid()
    await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id: table,
            name: 'batch',
            up: 'CREATE TABLE public.batch (n bigint NOT NULL);\n',
            dependsOn: [base],
          }),
        ],
      }),
    )
    const id = w.ulid()
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'unbounded-backfill',
            up: 'INSERT INTO public.batch (n) SELECT g FROM generate_series(1, 500000000) AS g;\n',
            dependsOn: [table],
          }),
        ],
        defaults: { ...DEFAULTS, statementTimeout: '1s' },
      }),
    )
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      applyOutcome: 'not_applied',
      statementIndex: 0,
      sqlstate: '57014',
      errorCode: 'MIGRATION_EXECUTION_FAILED',
    })
    const rows = await asSuperuser(t, (c) => c.query('SELECT count(*)::int AS n FROM public.batch'))
    expect(rows.rows[0]?.n).toBe(0)
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
  })

  it('E6: a backend terminated while it waits rolls back; the target is not blocked afterwards', async () => {
    const id = w.ulid()
    const p = await w.plan(t, {
      bundles: [
        w.bundle({
          id,
          name: 'items-flag',
          up: 'ALTER TABLE public.items ADD COLUMN flag boolean;\n',
          dependsOn: [base],
        }),
      ],
      defaults: { ...DEFAULTS, lockTimeout: '60s' },
    })
    const holder = await superuserClient(pg17, t.database)
    // Outside the holder's transaction: inside one, pg_stat_activity is a snapshot taken once.
    const watcher = await superuserClient(pg17, t.database)
    let running: Promise<OperationRecord> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ROW EXCLUSIVE MODE')
      running = w.apply(p)
      // The migrator's backend waits for the lock: the server ends it (a restart looks the same).
      let terminated = false
      for (let i = 0; i < 200 && !terminated; i++) {
        const r = await watcher.query(
          `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'exponetdb_migrator'
              AND wait_event_type = 'Lock'`,
        )
        terminated = r.rows.some((row) => row.done === true)
        if (!terminated) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(terminated).toBe(true)
      const op = await running
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
      expect(await errorOf(op)).toBe('TARGET_UNAVAILABLE')
      expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
        applyOutcome: 'not_applied',
        errorCode: 'TARGET_UNAVAILABLE',
      })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await watcher.end()
      // Never leave an apply running into the next case.
      await running?.catch(() => undefined)
    }
    expect(await hasColumn(t, 'items', 'flag')).toBe(false)
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
    const again = await w.apply(await w.plan(t, { migrationIds: [id] }))
    expect(again).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
  })
})

describe('the reply to COMMIT never arrives (E3)', () => {
  it('reconciles a committed migration as applied: one ledger row, one applied event, verified', async () => {
    const id = w.ulid()
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'committed',
            up: 'CREATE TABLE public.committed (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
      { wrap: lostCommitReply('commit') },
    )
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    const steps = await w.h.worker.query(
      'test.failures.steps',
      `SELECT detail->>'step' AS step FROM operations.operation_events
        WHERE operation_id = $1 AND kind = 'step_started' ORDER BY event_id`,
      [op.operationId],
    )
    expect(steps.rows.map((r) => r.textOrNull('step'))).toEqual(['execute', 'reconcile', 'verify'])
    const rows = (await ledger(t)).filter((r) => r.migrationId === id)
    expect(rows.map((r) => r.operationId)).toEqual([op.operationId])
    const applied = (await events(t, id)).filter((e) => e.event === 'applied')
    expect(applied).toHaveLength(1)
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
  })

  it('reconciles a COMMIT that never arrived as not applied, and nothing blocks the next plan', async () => {
    const id = w.ulid()
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'lost',
            up: 'CREATE TABLE public.lost (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
      { wrap: lostCommitReply('rollback') },
    )
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      applyOutcome: 'not_applied',
      errorCode: 'OUTCOME_UNKNOWN',
    })
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
    expect(await events(t, id)).toEqual([])
    const again = await w.apply(await w.plan(t, { migrationIds: [id] }))
    expect(again).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
  })
})

describe('verification (E2, E10)', () => {
  it('E2: a failing verify.sql leaves the migration applied but failed, and its dependent is not started', async () => {
    const first = w.ulid()
    const second = w.ulid()
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id: first,
            name: 'needs-rows',
            up: 'CREATE TABLE public.needs_rows (id int);\n',
            verify:
              '-- check: the table has a row\nSELECT count(*) > 0 AS ok FROM public.needs_rows;\n',
            dependsOn: [base],
          }),
          w.bundle({
            id: second,
            name: 'after-needs-rows',
            up: 'CREATE TABLE public.after_needs_rows (id int);\n',
            dependsOn: [first],
          }),
        ],
      }),
    )
    expect(op).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'partially_applied',
      verificationOutcome: 'failed',
    })
    const progress = await readProgress(w.h.worker, op.operationId)
    expect(progress.map((p) => [p.migrationId, p.applyOutcome, p.verificationOutcome])).toEqual([
      [first, 'applied', 'failed'],
      [second, 'not_started', 'not_applicable'],
    ])
    const ids = (await ledger(t)).map((r) => r.migrationId)
    expect(ids).toContain(first)
    expect(ids).not.toContain(second)
  })

  it('E10: a verify.sql that cannot get its lock ends in error and needs attention; verified again on an operator request', async () => {
    // Its own target: the operation keeps the target's schema domain until an operator acts.
    const v = await w.registerTarget('fail-c', 'nonprod')
    // A table outside the managed scope that verify.sql reads: the apply and the
    // structural checks never wait for it, only the runtime check does.
    await asSuperuser(v, (c) =>
      c.query(`CREATE SCHEMA outside_scope;
               CREATE TABLE outside_scope.busy (id int);
               GRANT USAGE ON SCHEMA outside_scope TO exponetdb_verifier;
               GRANT SELECT ON outside_scope.busy TO exponetdb_verifier`),
    )
    const id = w.ulid()
    const p = await w.plan(v, {
      bundles: [
        w.bundle({
          id,
          name: 'reads-busy',
          up: 'CREATE TABLE public.reads_busy (id int);\n',
          verify: '-- check: busy readable\nSELECT count(*) >= 0 AS ok FROM outside_scope.busy;\n',
        }),
      ],
    })
    const holder = await superuserClient(pg17, v.database)
    let op: OperationRecord
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE outside_scope.busy IN ACCESS EXCLUSIVE MODE')
      op = await w.apply(p)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    expect(op).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
    })
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      errorCode: 'VERIFICATION_ERROR',
    })
    expect((await ledger(v)).map((r) => r.migrationId)).toContain(id)
    expect((await events(v, id)).filter((e) => e.event === 'applied')).toHaveLength(1)
    // Never claimed again by itself, and no other schema change starts on the target meanwhile.
    const locks = await w.h.worker.query(
      'test.failures.locks',
      'SELECT domain_key FROM operations.operation_locks WHERE operation_id = $1',
      [op.operationId],
    )
    expect(locks.rows.map((r) => r.text('domain_key'))).toEqual([
      `target:${v.record.targetId}:schema`,
    ])
    // The worker never picks it up by itself.
    await w.drive()
    expect((await w.operation(op.operationId)).state).toBe('needs_attention')

    // An operator asks to verify again (serve records the request): the worker
    // moves it to verifying under its lease and re-runs only the verification.
    const operator = newId('idn', Date.now())
    await w.h.db.asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
         VALUES ($1, 'human', 'invited', 'operator@example.test', 'operator@example.test', $2)`,
        [operator, randomBytes(32)],
      )
    })
    await w.h.serve.transaction('test.failures.retry', (tx) =>
      requestVerificationRetry(tx, op.operationId, operator),
    )
    await w.drive()
    expect(await w.operation(op.operationId)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
      errorCode: null,
    })
    expect((await events(v, id)).filter((e) => e.event === 'applied')).toHaveLength(1)
    const runs = await verifications(v, id)
    expect(runs.map((r) => r.status)).toEqual(['error', 'passed'])
    const released = await w.h.worker.query(
      'test.failures.locks_after',
      'SELECT count(*)::int AS n FROM operations.operation_locks WHERE operation_id = $1',
      [op.operationId],
    )
    expect(released.rows[0]?.int('n')).toBe(0)
    const retry = await w.h.worker.query(
      'test.failures.retry_row',
      'SELECT started_at IS NOT NULL AS started FROM recovery.verification_retries WHERE operation_id = $1',
      [op.operationId],
    )
    expect(retry.rows.map((r) => r.bool('started'))).toEqual([true])
  })

  it('E10: a re-verification whose verify.sql cannot get its lock is verified again on an operator request (follow-up 3 review P1-1)', async () => {
    const v = await w.registerTarget('fail-d', 'nonprod')
    await asSuperuser(v, (c) =>
      c.query(`CREATE SCHEMA outside_scope;
               CREATE TABLE outside_scope.busy (id int);
               GRANT USAGE ON SCHEMA outside_scope TO exponetdb_verifier;
               GRANT SELECT ON outside_scope.busy TO exponetdb_verifier`),
    )
    const id = w.ulid()
    const applied = await w.apply(
      await w.plan(v, {
        bundles: [
          w.bundle({
            id,
            name: 'reads-busy-again',
            up: 'CREATE TABLE public.reads_busy_again (id int);\n',
            verify:
              '-- check: busy readable\nSELECT count(*) >= 0 AS ok FROM outside_scope.busy;\n',
          }),
        ],
      }),
    )
    expect(applied).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const p = await w.h.serve.transaction('test.failures.reverify', (tx) =>
      planMigrationVerify(tx, w.ctx, w.a, v.record.targetId, id, {}),
    )
    const holder = await superuserClient(pg17, v.database)
    let op: OperationRecord
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE outside_scope.busy IN ACCESS EXCLUSIVE MODE')
      op = await w.apply(p)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    // Before the review, nothing could release this target: the kind was not retryable.
    expect(op).toMatchObject({
      kind: 'migration.verify',
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
    })
    const operator = newId('idn', Date.now())
    await w.h.db.asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
         VALUES ($1, 'human', 'invited', 'operator-d@example.test', 'operator-d@example.test', $2)`,
        [operator, randomBytes(32)],
      )
    })
    await w.h.serve.transaction('test.failures.retry', (tx) =>
      requestVerificationRetry(tx, op.operationId, operator),
    )
    await w.drive()
    expect(await w.operation(op.operationId)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    expect((await readProgress(w.h.worker, op.operationId))[0]).toMatchObject({
      verificationOutcome: 'passed',
      errorCode: null,
    })
    expect((await verifications(v, id)).map((r) => r.status)).toEqual(['passed', 'error', 'passed'])
    const released = await w.h.worker.query(
      'test.failures.locks_after',
      'SELECT count(*)::int AS n FROM operations.operation_locks WHERE operation_id = $1',
      [op.operationId],
    )
    expect(released.rows[0]?.int('n')).toBe(0)
  })
})

describe('the ledger changed by hand (E22, E24)', () => {
  let u: Target
  let root = '' as MigrationId
  let pending = '' as MigrationId

  beforeAll(async () => {
    u = await w.registerTarget('fail-b', 'nonprod')
    root = w.ulid()
    const op = await w.apply(
      await w.plan(u, {
        bundles: [w.bundle({ id: root, name: 'root', up: 'CREATE TABLE public.root (id int);\n' })],
      }),
    )
    expect(op.state).toBe('succeeded')
    // Stored, never applied on u: a candidate for a row written by hand.
    pending = w.ulid()
    await w.plan(u, {
      bundles: [
        w.bundle({
          id: pending,
          name: 'pending',
          up: 'CREATE TABLE public.pending (id int);\n',
          dependsOn: [root],
        }),
      ],
    })
  }, 120_000)

  async function rootRow() {
    const row = (await ledger(u)).find((r) => r.migrationId === root)
    if (row === undefined) throw new Error('root row')
    return row
  }

  /** Changes the target's append-only ledger as its superuser, past the guard triggers. */
  async function tamper(statement: string, params: unknown[] = []) {
    await asSuperuser(u, async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(statement, params)
      await c.query('COMMIT')
    })
  }

  /** A ledger row as someone writes it by hand: an operation id this installation never had. */
  const handRow = `INSERT INTO exponetdb.schema_migrations
    (migration_id, origin, name, checksum, checksum_provenance, applied_at, operation_id,
     engine_version, pg_version_num)
    VALUES ($1, 'exponetdb', 'by-hand', $2, 'computed_at_apply', now(), $3, 'by-hand', 170000)`
  const FOREIGN_OPERATION = 'op_01M4R2T03VG6F43SEKX6F5ST5G'

  const dependent = () =>
    w.bundle({
      id: w.ulid(),
      name: 'dependent',
      up: 'CREATE TABLE public.dependent (id int);\n',
      dependsOn: [root],
    })

  it('E22: a dependency whose ledger checksum changed blocks plans with the row named', async () => {
    const before = await rootRow()
    await tamper(`UPDATE exponetdb.schema_migrations SET checksum = $2 WHERE migration_id = $1`, [
      root,
      `sha256:c1:${'0'.repeat(64)}`,
    ])
    try {
      const refused = await refusal(w.plan(u, { bundles: [dependent()] }))
      expect(refused.code).toBe('LEDGER_DIVERGENCE')
      expect(refused.details).toEqual({ missing: [], checksumDiffers: [root], unrecorded: [] })
    } finally {
      await tamper(`UPDATE exponetdb.schema_migrations SET checksum = $2 WHERE migration_id = $1`, [
        root,
        before.checksum,
      ])
    }
    expect((await w.plan(u, { bundles: [dependent()] })).state).toBe('active')
  })

  it('E24: a ledger row deleted by hand is missing; written back, plans run again', async () => {
    const c = await superuserClient(pg17, u.database)
    try {
      // The row is kept in this session and written back exactly (its applied_seq too).
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        'CREATE TEMP TABLE kept AS SELECT * FROM exponetdb.schema_migrations WHERE migration_id = $1',
        [root],
      )
      await c.query('DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', [root])
      await c.query('COMMIT')
      const refused = await refusal(w.plan(u, { bundles: [dependent()] }))
      expect(refused.code).toBe('LEDGER_DIVERGENCE')
      expect(refused.details).toEqual({ missing: [root], checksumDiffers: [], unrecorded: [] })
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        'INSERT INTO exponetdb.schema_migrations OVERRIDING SYSTEM VALUE SELECT * FROM kept',
      )
      await c.query('COMMIT')
      await c.end()
    }
    expect((await w.plan(u, { bundles: [dependent()] })).state).toBe('active')
  })

  it('E24: a row no operation wrote is unrecorded; removed again, plans run again (no stale block)', async () => {
    await tamper(handRow, [pending, `sha256:c1:${'1'.repeat(64)}`, FOREIGN_OPERATION])
    try {
      const refused = await refusal(w.plan(u, { migrationIds: [pending] }))
      expect(refused.code).toBe('LEDGER_DIVERGENCE')
      expect(refused.details).toEqual({ missing: [], checksumDiffers: [], unrecorded: [pending] })
    } finally {
      await tamper('DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', [pending])
    }
    expect((await w.plan(u, { migrationIds: [pending] })).state).toBe('active')
  })

  it('E24: a row written before acceptance refuses the apply as stale', async () => {
    const p = await w.plan(u, { migrationIds: [pending] })
    const extra = w.ulid()
    await tamper(handRow, [extra, `sha256:c1:${'2'.repeat(64)}`, FOREIGN_OPERATION])
    try {
      await expect(w.accept(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    } finally {
      await tamper('DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', [extra])
    }
  })

  it('E24: a row written after acceptance stops the apply at dispatch; the mirror never adopts it', async () => {
    const p = await w.plan(u, { migrationIds: [pending] })
    const accepted = await w.accept(p)
    const extra = w.ulid()
    await tamper(handRow, [extra, `sha256:c1:${'2'.repeat(64)}`, FOREIGN_OPERATION])
    try {
      await w.drive()
      const op = await w.operation(accepted.operationId)
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
      expect(await errorOf(op)).toBe('PLAN_STALE')
      const mirrored = await w.h.worker.query(
        'test.failures.mirror',
        'SELECT migration_id FROM migrations.ledger_mirror WHERE target_id = $1',
        [u.record.targetId],
      )
      expect(mirrored.rows.map((r) => r.text('migration_id'))).not.toContain(extra)
      expect((await ledger(u)).map((r) => r.migrationId)).not.toContain(pending)
    } finally {
      await tamper('DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', [extra])
    }
  })

  it('the worker mirrors only rows an operation of the target wrote and records what differs', async () => {
    const live = await ledger(u)
    const forged = {
      ...(await rootRow()),
      migrationId: w.ulid(),
      operationId: FOREIGN_OPERATION,
    }
    const state = () =>
      w.h.worker.query(
        'test.failures.state',
        'SELECT divergent, divergence FROM migrations.ledger_state WHERE target_id = $1',
        [u.record.targetId],
      )
    await w.h.worker.transaction('test.failures.write_mirror', (tx) =>
      writeMirror(tx, {
        targetId: u.record.targetId,
        generation: u.record.generation,
        rows: [...live, forged],
        ledgerStateHash: `sha256:ls1:${'3'.repeat(64)}`,
        baselineId: null,
      }),
    )
    const mirrored = await w.h.worker.query(
      'test.failures.mirror_rows',
      'SELECT migration_id FROM migrations.ledger_mirror WHERE target_id = $1',
      [u.record.targetId],
    )
    expect(mirrored.rows.map((r) => r.text('migration_id'))).not.toContain(forged.migrationId)
    const marked = (await state()).rows[0]
    expect(marked?.bool('divergent')).toBe(true)
    expect(marked?.json('divergence')).toEqual({
      missing: [],
      checksumDiffers: [],
      unrecorded: [forged.migrationId],
    })
    // Observed again without the forged row: the record follows what the worker sees.
    await w.h.worker.transaction('test.failures.write_mirror_again', (tx) =>
      writeMirror(tx, {
        targetId: u.record.targetId,
        generation: u.record.generation,
        rows: live,
        ledgerStateHash: `sha256:ls1:${'4'.repeat(64)}`,
        baselineId: null,
      }),
    )
    expect((await state()).rows[0]?.bool('divergent')).toBe(false)
  })
})

describe('authority revoked while the operation runs (E27)', () => {
  const revokedAfter =
    (allowed: number): DispatchAdmission =>
    async () => {
      calls += 1
      const changed: ChangedBinding[] =
        calls > allowed ? [{ binding: 'authorization', actual: 'revoked' }] : []
      return changed
    }
  let calls = 0

  it('stops before the next migration: what ran stays applied and verified, the rest is not started', async () => {
    const first = w.ulid()
    const second = w.ulid()
    calls = 0
    // Allowed at dispatch and at execution start; revoked before the second migration.
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id: first,
            name: 'first-of-two',
            up: 'CREATE TABLE public.first_of_two (id int);\n',
            dependsOn: [base],
          }),
          w.bundle({
            id: second,
            name: 'second-of-two',
            up: 'CREATE TABLE public.second_of_two (id int);\n',
            dependsOn: [first],
          }),
        ],
      }),
      { admit: revokedAfter(2) },
    )
    expect(op).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'partially_applied',
      verificationOutcome: 'partial',
    })
    const progress = await readProgress(w.h.worker, op.operationId)
    expect(progress.map((p) => [p.applyOutcome, p.verificationOutcome, p.errorCode])).toEqual([
      ['applied', 'passed', null],
      ['not_started', 'not_applicable', 'GRANT_REVOKED'],
    ])
    const ids = (await ledger(t)).map((r) => r.migrationId)
    expect(ids).toContain(first)
    expect(ids).not.toContain(second)
  })

  it('never starts when the authority is gone at dispatch: failed with GRANT_REVOKED', async () => {
    const id = w.ulid()
    calls = 0
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'never-started',
            up: 'CREATE TABLE public.never_started (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
      { admit: revokedAfter(0) },
    )
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
    expect(await errorOf(op)).toBe('GRANT_REVOKED')
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
  })

  it('stops at execution start when the authority went between dispatch and the lock', async () => {
    const id = w.ulid()
    calls = 0
    const op = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'stopped-at-start',
            up: 'CREATE TABLE public.stopped_at_start (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
      { admit: revokedAfter(1) },
    )
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    expect(await errorOf(op)).toBe('GRANT_REVOKED')
    expect((await ledger(t)).map((r) => r.migrationId)).not.toContain(id)
  })
})
