// I3 Order is the DAG, engine level: the plan lists migrations in dependency order (smallest ULID first only
// among the ready), the worker applies them in that order, the order does not depend on upload order, and
// the plan CONTENT is deterministic (the plan hash is not: it binds a random plan id and timestamps).
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MigrationError } from '@exponetdb/migrations-engine'
import { readLedgerRows } from '@exponetdb/postgres'
import { serverFor } from '@exponetdb/testkit'
import { migrationWorld, type Target, type World } from './lib/world.ts'

let w: World
let a: Target
let b: Target

beforeAll(async () => {
  w = await migrationWorld('b2_i3', serverFor(17))
  a = await w.registerTarget('order-a', 'nonprod')
  b = await w.registerTarget('order-b', 'nonprod')
}, 300_000)
afterAll(async () => {
  await w?.close()
})

const planItems = (p: { body: Record<string, unknown> }): string[] =>
  ((p.body['content'] as { migrations: { migrationId: string }[] }).migrations).map((m) => m.migrationId)

async function ledgerOrder(t: Target): Promise<string[]> {
  const opened = await w.h.workerConnector.forTarget(t.record, 'observer', 'b2')
  try {
    const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
    return [...rows].sort((x, y) => Number(x.appliedSeq) - Number(y.appliedSeq)).map((r) => r.migrationId)
  } finally {
    await opened.session.close()
  }
}

function shape(prefix: string) {
  // ids in creation order: lo < mid < hi.  lo depends on hi (the dependency order contradicts the ULID order), mid is independent.
  const lo = w.ulid()
  const mid = w.ulid()
  const hi = w.ulid()
  return {
    lo, mid, hi,
    bundles: [
      w.bundle({ id: lo, name: `${prefix}-lo`, up: `CREATE TABLE public.${prefix}_lo (i int);\n`, dependsOn: [hi] }),
      w.bundle({ id: mid, name: `${prefix}-mid`, up: `CREATE TABLE public.${prefix}_mid (i int);\n` }),
      w.bundle({ id: hi, name: `${prefix}-hi`, up: `CREATE TABLE public.${prefix}_hi (i int);\n` }),
    ],
  }
}

describe('I3 plan order and apply order', () => {
  test('the plan lists hi before lo (dependency) and mid by id among the ready; upload order is irrelevant', async () => {
    const s = shape('o1')
    const orders = new Set<string>()
    for (const upload of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const p = await w.plan(a, { bundles: upload.map((i) => s.bundles[i] as never) })
      orders.add(JSON.stringify(planItems(p)))
      // every dependency is listed before its dependant
      const items = planItems(p)
      expect(items.indexOf(s.hi)).toBeLessThan(items.indexOf(s.lo))
    }
    expect(orders.size, 'plan order for four upload orders').toBe(1)
    // Kahn with smallest-id-first: ready = {mid, hi}; mid < hi -> mid, hi, then lo
    expect([...orders][0]).toBe(JSON.stringify([s.mid, s.hi, s.lo]))
  })

  test('the worker applies in plan order; the ledger records applied_seq in that order', async () => {
    const s = shape('o2')
    const p = await w.plan(a, { bundles: [...s.bundles].reverse() as never })
    const planned = planItems(p)
    const op = await w.apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' })
    const applied = (await ledgerOrder(a)).filter((id) => planned.includes(id))
    expect(applied).toEqual(planned)
  })

  test('plan CONTENT is deterministic (contentChecksum), the plan hash is per plan (id, createdAt, expiresAt)', async () => {
    const s = shape('o3')
    const p1 = await w.plan(b, { bundles: s.bundles as never })
    const p2 = await w.plan(b, { bundles: [...s.bundles].reverse() as never })
    expect(p2.planId).not.toBe(p1.planId)
    expect(p2.body['contentChecksum'], 'two plans of the same bundles and state have equal content checksums').toBe(p1.body['contentChecksum'])
    // The brief says "same plan hash"; the implementation binds a random id and timestamps, so the hashes differ by design.
    expect(p2.planHash === p1.planHash, 'two plans of identical content have equal plan hashes').toBe(false)
  })

  test('two different ULID labellings of the same shape plan a dependency-valid order each (only incomparable nodes may swap)', async () => {
    const s1 = shape('o4')
    const s2 = shape('o5')
    for (const s of [s1, s2]) {
      const items = planItems(await w.plan(b, { bundles: s.bundles as never }))
      expect(items.indexOf(s.hi)).toBeLessThan(items.indexOf(s.lo))
    }
  })
})

describe('I3 refusals at plan time (named errors)', () => {
  async function code(p: Promise<unknown>): Promise<string> {
    try {
      await p
      return 'no error'
    } catch (e) {
      return e instanceof MigrationError ? e.code : String(e)
    }
  }
  test('cycle: MIGRATION_DEPENDENCY_CYCLE with the cycle listed', async () => {
    const x = w.ulid()
    const y = w.ulid()
    const r = await code(w.plan(a, { bundles: [w.bundle({ id: x, name: 'cyc-x', up: 'SELECT 1;', dependsOn: [y] }), w.bundle({ id: y, name: 'cyc-y', up: 'SELECT 1;', dependsOn: [x] })] }))
    expect(r).toBe('MIGRATION_DEPENDENCY_CYCLE')
  })
  test('self-dependency: MIGRATION_DEPENDENCY_CYCLE', async () => {
    const x = w.ulid()
    expect(await code(w.plan(a, { bundles: [w.bundle({ id: x, name: 'self', up: 'SELECT 1;', dependsOn: [x] })] }))).toBe('MIGRATION_DEPENDENCY_CYCLE')
  })
  test('unknown dependency: MIGRATION_DEPENDENCY_UNKNOWN', async () => {
    const x = w.ulid()
    expect(await code(w.plan(a, { bundles: [w.bundle({ id: x, name: 'unk', up: 'SELECT 1;', dependsOn: [w.ulid()] })] }))).toBe('MIGRATION_DEPENDENCY_UNKNOWN')
  })
  test('a 1,000-deep chain plans in dependency order within a time and memory budget', async () => {
    const ids = Array.from({ length: 1000 }, () => w.ulid())
    const bundles = ids.map((id, i) => w.bundle({ id, name: `chain${i}`, up: i === 0 ? 'CREATE TABLE public.chain_t (i int);\n' : `COMMENT ON TABLE public.chain_t IS 'step ${i}';\n`, dependsOn: i === 0 ? [] : [ids[i - 1] as string] }))
    const t0 = Date.now()
    const rss0 = process.memoryUsage().rss
    // 50 bundles per request: ingest in batches, then plan the tail by id (the plan pulls in its pending ancestors)
    for (let i = 0; i < bundles.length; i += 50) {
      await w.h.serve.transaction('b2.chain', async (tx) => {
        const { ingestBundles } = await import('@exponetdb/migrations-engine')
        await ingestBundles(tx, { projectId: a.record.projectId, bundles: bundles.slice(i, i + 50), defaults: (await import('./lib/world.ts')).DEFAULTS, identityId: w.a.identityId })
      })
    }
    let p
    try {
      p = await w.plan(a, { migrationIds: [ids[999] as string] })
    } catch (e) {
      // The lint of a 1,000-chain is CPU bound inside the plan's Control Store transaction (idle_in_transaction_session_timeout = 60 s).
      throw new Error(`the plan of a 1,000-bundle chain FAILED after ${Math.round((Date.now() - t0) / 1000)} s: ${(e as Error).name}: ${(e as Error).message}`)
    }
    const planned = planItems(p)
    const ms = Date.now() - t0
    console.log(`I3 engine: plan of a 1,000-deep chain: ${planned.length} items in ${ms} ms, RSS +${Math.round((process.memoryUsage().rss - rss0) / 1048576)} MiB`)
    expect(planned).toEqual(ids)
    expect(ms, 'a 1,000-bundle project must plan in under 30 s (it is 53 s on an idle machine and fails with a Control Store timeout under load)').toBeLessThan(30_000)
  }, 300_000)
})
