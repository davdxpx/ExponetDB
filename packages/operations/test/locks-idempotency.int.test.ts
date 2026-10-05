import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptPlan,
  acquireLocks,
  beginIdempotent,
  completeIdempotent,
  heldLocks,
  KindRegistry,
  pruneIdempotencyKeys,
  requestHash,
} from '../src/index.ts'
import {
  human,
  newPlan,
  serveActor,
  sleep,
  sqlstate,
  stores,
  syntheticKind,
  target,
} from './support.ts'

let db: MigratedTestDatabase
let as: ReturnType<typeof stores>
const kind = syntheticKind('synthetic.locks')

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_locks')
  as = stores(db)
})

afterAll(async () => {
  await db?.drop()
})

async function operation(): Promise<string> {
  const plan = await newPlan(as('exdb_serve'), { kind: kind.kind })
  const result = await as('exdb_serve').transaction('test.accept', (tx) =>
    acceptPlan(
      tx,
      { planId: plan.planId, actor: human },
      {
        kinds: new KindRegistry([kind]),
        clock: systemClock,
        systemActor: serveActor,
        recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
      },
    ),
  )
  if (result.status !== 'accepted') {
    throw result.error
  }
  return result.operation.operationId
}

describe('exclusivity locks (§7)', () => {
  it('a held domain blocks another operation, leaving nothing behind; maintenance covers schema', async () => {
    const t = target()
    const a = await operation()
    const b = await operation()
    const worker = as('exdb_worker')
    expect(
      await worker.transaction('test.lock.a', (tx) =>
        acquireLocks(tx, a, [`target:${t}:maintenance`]),
      ),
    ).toMatchObject({ acquired: true })
    expect(
      await worker.transaction('test.lock.b', (tx) => acquireLocks(tx, b, [`target:${t}:schema`])),
    ).toEqual({
      acquired: false,
      domain: `target:${t}:schema`,
      blockingOperationId: a,
    })
    expect(await heldLocks(worker, b)).toEqual([])
    expect(
      await worker.transaction('test.lock.again', (tx) =>
        acquireLocks(tx, a, [`target:${t}:schema`]),
      ),
    ).toMatchObject({ acquired: true })
  })

  it('there is no force-release: a live operation’s lock cannot be deleted', async () => {
    const t = target()
    const a = await operation()
    const worker = as('exdb_worker')
    await worker.transaction('test.lock', (tx) => acquireLocks(tx, a, [`target:${t}:schema`]))
    const { rowCount } = await worker.query(
      'test.lock.delete',
      'DELETE FROM operations.operation_locks WHERE operation_id = $1',
      [a],
    )
    expect(rowCount).toBe(0)
    expect(await heldLocks(worker, a)).toEqual([`target:${t}:schema`])
    expect(await sqlstate(as('exdb_serve'), 'DELETE FROM operations.operation_locks')).toBe('42501')
    expect(
      await sqlstate(worker, 'UPDATE operations.operation_locks SET operation_id = operation_id'),
    ).toBe('42501')
  })

  it('concurrent acquisitions of overlapping domains in any order never deadlock and never double-hold', async () => {
    const workers = Array.from({ length: 6 }, () => db.store('exdb_worker', { poolMax: 1 }))
    const domains = [target(), target(), target()].flatMap((t) => [
      `target:${t}:schema`,
      `target:${t}:maintenance`,
    ])
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.shuffledSubarray(domains, { minLength: 1, maxLength: 4 }), {
          minLength: 2,
          maxLength: 6,
        }),
        async (sets) => {
          const ops = await Promise.all(sets.map(() => operation()))
          const results = await Promise.all(
            sets.map((set, i) =>
              (workers[i] ?? as('exdb_worker')).transaction('test.lock.race', async (tx) => {
                const r = await acquireLocks(tx, ops[i] ?? '', set)
                await sleep(5)
                return r
              }),
            ),
          )
          const { rows } = await as('exdb_worker').query(
            'test.lock.all',
            'SELECT domain_key, operation_id FROM operations.operation_locks WHERE operation_id = ANY($1::text[])',
            [ops],
          )
          const holders = new Map<string, string>()
          for (const r of rows) {
            expect(holders.has(r.text('domain_key'))).toBe(false)
            holders.set(r.text('domain_key'), r.text('operation_id'))
          }
          expect(results.some((r) => r.acquired)).toBe(true)
          // Clean up for the next run: finish the operations, which releases their locks.
          for (const op of ops) {
            await db.asSuperuser(async (c) => {
              await c.query(
                "UPDATE operations.operations SET state = 'canceled', verification_outcome = 'not_applicable' WHERE operation_id = $1",
                [op],
              )
              await c.query('DELETE FROM operations.operation_locks WHERE operation_id = $1', [op])
            })
          }
        },
      ),
      { numRuns: 15 },
    )
  })
})

describe('idempotency keys (§5)', () => {
  const principal = 'idn:idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
  const hash = requestHash('POST', '/api/v1/plans', { kind: 'x' })

  it('replays the stored response for the same request and refuses a different one', async () => {
    const serve = as('exdb_serve')
    const first = await serve.transaction('test.idem.first', async (tx) => {
      const start = await beginIdempotent(tx, { principal, key: 'key-1', requestHash: hash })
      if (start.status === 'new') {
        await completeIdempotent(tx, {
          principal,
          key: 'key-1',
          response: { planId: 'pln_x', n: 1 },
        })
      }
      return start
    })
    expect(first).toEqual({ status: 'new' })
    const again = await serve.transaction('test.idem.second', (tx) =>
      beginIdempotent(tx, { principal, key: 'key-1', requestHash: hash }),
    )
    expect(again).toEqual({ status: 'replay', response: { n: 1, planId: 'pln_x' } })
    await expect(
      serve.transaction('test.idem.third', (tx) =>
        beginIdempotent(tx, {
          principal,
          key: 'key-1',
          requestHash: requestHash('POST', '/api/v1/plans', { kind: 'y' }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    // Another principal may use the same key independently.
    expect(
      await serve.transaction('test.idem.fourth', (tx) =>
        beginIdempotent(tx, {
          principal: 'idn:idn_01JB2Z6G8M4Q7R9T1V3W5X7YA0',
          key: 'key-1',
          requestHash: hash,
        }),
      ),
    ).toEqual({ status: 'new' })
  })

  it('concurrent requests with the same key: exactly one runs, the others replay its response', async () => {
    let executions = 0
    const servers = Array.from({ length: 6 }, () => db.store('exdb_serve', { poolMax: 1 }))
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (servers[i] ?? as('exdb_serve')).transaction('test.idem.race', async (tx) => {
          const start = await beginIdempotent(tx, { principal, key: 'race', requestHash: hash })
          if (start.status === 'new') {
            executions += 1
            await sleep(100)
            await completeIdempotent(tx, { principal, key: 'race', response: { winner: i } })
            return { winner: i }
          }
          return start.response
        }),
      ),
    )
    expect(executions).toBe(1)
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
  })

  it('a rolled-back first request leaves the key free', async () => {
    await db
      .store('exdb_serve')
      .transaction('test.idem.rollback', async (tx) => {
        await beginIdempotent(tx, { principal, key: 'rolled-back', requestHash: hash })
        throw new Error('the mutation failed')
      })
      .catch(() => undefined)
    expect(
      await as('exdb_serve').transaction('test.idem.retry', (tx) =>
        beginIdempotent(tx, { principal, key: 'rolled-back', requestHash: hash }),
      ),
    ).toEqual({
      status: 'new',
    })
  })

  it('refuses malformed keys and principals; expired keys are reusable and pruned only by the worker', async () => {
    for (const key of ['', 'with space', 'ä', 'x'.repeat(256)]) {
      await expect(
        as('exdb_serve').transaction('test.idem.bad', (tx) =>
          beginIdempotent(tx, { principal, key, requestHash: hash }),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      })
    }
    await db.asSuperuser((c) =>
      c.query(
        "UPDATE operations.idempotency_keys SET created_at = now() - interval '26 hours', expires_at = now() - interval '2 hours' WHERE idem_key = 'key-1' AND principal_key = 'idn:idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'",
      ),
    )
    expect(
      await as('exdb_serve').transaction('test.idem.expired', (tx) =>
        beginIdempotent(tx, {
          principal,
          key: 'key-1',
          requestHash: requestHash('POST', '/api/v1/plans', { kind: 'z' }),
        }),
      ),
    ).toEqual({ status: 'new' })
    await db.asSuperuser((c) =>
      c.query(
        "UPDATE operations.idempotency_keys SET created_at = now() - interval '26 hours', expires_at = now() - interval '2 hours' WHERE idem_key = 'race'",
      ),
    )
    expect(await sqlstate(as('exdb_serve'), 'DELETE FROM operations.idempotency_keys')).toBe(
      '42501',
    )
    const live = await as('exdb_worker').query(
      'test.idem.count',
      'SELECT count(*)::int AS n FROM operations.idempotency_keys',
    )
    expect(await pruneIdempotencyKeys(as('exdb_worker'))).toBe(1)
    const after = await as('exdb_worker').query(
      'test.idem.count_after',
      'SELECT count(*)::int AS n FROM operations.idempotency_keys',
    )
    expect(after.rows[0]?.int('n')).toBe((live.rows[0]?.int('n') ?? 0) - 1)
  })
})
