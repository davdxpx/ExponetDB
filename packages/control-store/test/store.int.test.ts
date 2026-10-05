import { MetricsRegistry } from '@exponetdb/observability'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlStoreError, controlStoreMetrics } from '../src/index.ts'
import { type MigratedTestDatabase, migratedTestDatabase } from '../src/testing/index.ts'

let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_store')
  await db.asSuperuser(async (c) => {
    await c.query('CREATE TABLE control.tx_probe (k text PRIMARY KEY, v integer NOT NULL)')
    await c.query('GRANT SELECT, INSERT, UPDATE, DELETE ON control.tx_probe TO exdb_worker')
  })
})

afterAll(async () => {
  await db?.drop()
})

async function probe(k: string): Promise<number | undefined> {
  const { rows } = await db
    .store('exdb_worker')
    .query('test.probe.read', 'SELECT v FROM control.tx_probe WHERE k = $1', [k])
  return rows[0]?.int('v')
}

describe('transactions', () => {
  it('commits when the function resolves and rolls back when it throws', async () => {
    const store = db.store('exdb_worker')
    await store.transaction('test.commit', async (tx) => {
      await tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', ['a', 1])
    })
    expect(await probe('a')).toBe(1)
    await expect(
      store.transaction('test.rollback', async (tx) => {
        await tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', [
          'b',
          1,
        ])
        throw new Error('domain failure after the insert')
      }),
    ).rejects.toThrow('domain failure after the insert')
    expect(await probe('b')).toBeUndefined()
  })

  it('a savepoint rolls back only its own work', async () => {
    const store = db.store('exdb_worker')
    await store.transaction('test.savepoint', async (tx) => {
      await tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', ['c', 1])
      await expect(
        tx.savepoint(async (inner) => {
          await inner.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', [
            'd',
            1,
          ])
          await inner.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', [
            'c',
            2,
          ])
        }),
      ).rejects.toMatchObject({ code: 'control_store_conflict', sqlstate: '23505' })
      await tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', ['e', 1])
    })
    expect([await probe('c'), await probe('d'), await probe('e')]).toEqual([1, undefined, 1])
  })

  it('a transaction handle cannot be used after its transaction ended', async () => {
    const store = db.store('exdb_worker')
    let leaked: import('../src/index.ts').Tx | undefined
    await store.transaction('test.leak', async (tx) => {
      leaked = tx
    })
    await expect(leaked?.query('test.after', 'SELECT 1')).rejects.toThrow(
      'transaction handle used after',
    )
  })

  it('refuses query classes that are not static dotted identifiers', async () => {
    await expect(db.store('exdb_worker').query('SELECT 1', 'SELECT 1')).rejects.toThrow(
      'static dotted identifiers',
    )
  })

  it('a read-only transaction refuses writes', async () => {
    await expect(
      db
        .store('exdb_worker')
        .transaction(
          'test.read_only',
          (tx) =>
            tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', [
              'ro',
              1,
            ]),
          { readOnly: true },
        ),
    ).rejects.toMatchObject({ sqlstate: '25006' })
  })

  it('observes duration by role and query class, never SQL text', async () => {
    const registry = new MetricsRegistry()
    const store = db.store('exdb_worker', { observer: controlStoreMetrics(registry) })
    await store.query('readiness.schema_check', 'SELECT 1 AS one')
    await store
      .query('readiness.schema_check', 'SELECT * FROM missing_table')
      .catch(() => undefined)
    const text = registry.render()
    expect(text).toContain('query_class="readiness.schema_check"')
    expect(text).toContain('outcome="ok"')
    expect(text).toContain('outcome="error"')
    expect(text).not.toContain('SELECT')
    expect(text).not.toContain('missing_table')
  })
})

describe('failure injection', () => {
  it('a connection killed during a transaction fails the transaction; nothing is committed; the pool recovers', async () => {
    const store = db.store('exdb_worker', { poolMax: 1 })
    const failure = store.transaction('test.killed', async (tx) => {
      await tx.query('test.insert', 'INSERT INTO control.tx_probe (k, v) VALUES ($1, $2)', [
        'killed',
        1,
      ])
      const { rows } = await tx.query('test.pid', 'SELECT pg_backend_pid() AS pid')
      const pid = rows[0]?.int('pid')
      await db.asSuperuser((c) => c.query('SELECT pg_terminate_backend($1)', [pid]))
      await tx.query('test.after_kill', 'SELECT 1')
    })
    await expect(failure).rejects.toSatisfy(
      (e) => e instanceof ControlStoreError && e.code === 'control_store_unavailable',
    )
    expect(await probe('killed')).toBeUndefined()
    const { rows } = await store.query('test.recovered', 'SELECT 1 AS one')
    expect(rows[0]?.int('one')).toBe(1)
  })

  it('an unreachable Control Store is reported as unavailable, not as an empty result', async () => {
    const url = new URL(db.url('exdb_worker'))
    url.port = '1'
    const { ControlStore } = await import('../src/index.ts')
    const store = new ControlStore({
      url: url.toString(),
      role: 'exdb_worker',
      connectTimeoutMs: 500,
    })
    await expect(store.query('test.unreachable', 'SELECT 1')).rejects.toMatchObject({
      code: 'control_store_unavailable',
    })
    await store.close()
  })

  it('session state (advisory locks) never leaks back into the pool', async () => {
    const store = db.store('exdb_worker', { poolMax: 1 })
    await store.session((s) => s.query('test.lock', 'SELECT pg_advisory_lock(42)'))
    const { rows } = await store.query(
      'test.locks',
      "SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
    )
    expect(rows[0]?.int('n')).toBe(0)
  })
})
