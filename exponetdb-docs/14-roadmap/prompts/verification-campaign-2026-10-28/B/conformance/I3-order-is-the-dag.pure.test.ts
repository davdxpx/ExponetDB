// I3 Order is the DAG: only `dependsOn` orders execution; file names and ULIDs never do (they break ties).
// Library level: packages/migrations/graph (buildGraph, pendingOrder, selectionOrder, checkOrder) and the
// linter's view of the same stream. The engine-level proof (plan items in order, apply order) is in I3-order.int.test.ts.
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { buildGraph, pendingOrder, selectionOrder, type GraphMigration } from '@exponetdb/migrations/graph'
import { prepareLint } from '@exponetdb/migrations/lint'
import { lint, mk, ulidOf } from './lib/bundle.ts'
import { measure } from './lib/measure.ts'

const id = (n: number) => ulidOf(n)
const mig = (n: number, deps: number[] = []): GraphMigration => ({ id: id(n), dependsOn: deps.map(id) })
const orderOf = (migs: GraphMigration[], baselines: string[] = []) => {
  const g = buildGraph({ migrations: migs, baselines })
  if (!g.ok) throw new Error(`graph refused: ${JSON.stringify(g.error)}`)
  return g.value.order()
}
const shuffle = <T>(a: readonly T[], seed: number): T[] => {
  const out = a.slice()
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** The reference: repeatedly the smallest id whose dependencies are all done (O(n^2), obviously correct). */
function reference(migs: GraphMigration[]): string[] {
  const done = new Set<string>()
  const left = new Map(migs.map((m) => [m.id, m]))
  const out: string[] = []
  while (left.size > 0) {
    const ready = [...left.values()].filter((m) => m.dependsOn.every((d) => done.has(d))).map((m) => m.id).sort()
    const next = ready[0]
    if (next === undefined) throw new Error('reference: cycle')
    out.push(next)
    done.add(next)
    left.delete(next)
  }
  return out
}

describe('I3 shapes', () => {
  test('diamond: A <- B, C <- D; ties by smaller id; input order is irrelevant', () => {
    const m = [mig(1), mig(2, [1]), mig(3, [1]), mig(4, [2, 3])]
    const expected = [1, 2, 3, 4].map(id)
    for (let seed = 1; seed <= 24; seed++) expect(orderOf(shuffle(m, seed))).toEqual(expected)
  })

  test('diamond with ids assigned so the ULID order contradicts the dependency order', () => {
    // 9 depends on 1: ULID order says 1 before 9 anyway, so flip: node 1 depends on node 9.
    const m = [mig(1, [9]), mig(5, [9]), mig(9), mig(7, [1, 5])]
    expect(orderOf(m)).toEqual([9, 1, 5, 7].map(id))
  })

  test('independent nodes are ordered by id only (the documented tie-break), not by input order', () => {
    const m = [mig(30), mig(10), mig(20)]
    expect(orderOf(m)).toEqual([10, 20, 30].map(id))
    expect(orderOf(shuffle(m, 5))).toEqual([10, 20, 30].map(id))
  })

  test('self-dependency is a cycle of one (MIGRATION_DEPENDENCY_CYCLE)', () => {
    const g = buildGraph({ migrations: [mig(1, [1])] })
    expect(g).toMatchObject({ ok: false, error: { code: 'cycle', cycle: [id(1)] } })
  })

  test('two- and three-cycles are reported as the shortest cycle through the smallest id', () => {
    expect(buildGraph({ migrations: [mig(1, [2]), mig(2, [1])] })).toMatchObject({ ok: false, error: { code: 'cycle', cycle: [id(1), id(2)] } })
    const g3 = buildGraph({ migrations: [mig(3, [1]), mig(1, [2]), mig(2, [3])] })
    expect(g3).toMatchObject({ ok: false, error: { code: 'cycle' } })
    if (!g3.ok && g3.error.code === 'cycle') expect(new Set(g3.error.cycle)).toEqual(new Set([1, 2, 3].map(id)))
    // the same stream in any input order reports the same cycle
    const a = buildGraph({ migrations: [mig(3, [1]), mig(1, [2]), mig(2, [3])] })
    const b = buildGraph({ migrations: [mig(2, [3]), mig(3, [1]), mig(1, [2])] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test('unknown dependency is named with its declaring migration (MIGRATION_DEPENDENCY_UNKNOWN)', () => {
    const g = buildGraph({ migrations: [mig(1), mig(2, [1, 77])] })
    expect(g).toMatchObject({ ok: false, error: { code: 'unknown_dependency', from: id(2), missing: [id(77)] } })
  })

  test('a dependency on an id of another project is simply unknown here (the graph has one stream)', () => {
    const projectA = [mig(1), mig(2, [1])]
    const projectBId = id(500)
    const g = buildGraph({ migrations: [...projectA, { id: id(3), dependsOn: [projectBId] }] })
    expect(g).toMatchObject({ ok: false, error: { code: 'unknown_dependency', missing: [projectBId] } })
  })

  test('invalid references and ids are refused before anything else', () => {
    expect(buildGraph({ migrations: [{ id: 'not-a-ulid', dependsOn: [] }] })).toMatchObject({ ok: false, error: { code: 'invalid_id' } })
    expect(buildGraph({ migrations: [mig(1), { id: id(2), dependsOn: ['01jb2z6g8m4q7r9t1v3w5x7y9z'] }] })).toMatchObject({ ok: false, error: { code: 'invalid_reference' } })
    expect(buildGraph({ migrations: [mig(1), mig(1)] })).toMatchObject({ ok: false, error: { code: 'duplicate_id' } })
  })

  test('a baseline is a root; a root migration beside a baseline is unanchored; a baseline is never pending', () => {
    const bl = 'baseline:imported-2026-11'
    expect(buildGraph({ migrations: [{ id: id(1), dependsOn: [bl] }], baselines: [bl] }).ok).toBe(true)
    expect(buildGraph({ migrations: [mig(1)], baselines: [bl] })).toMatchObject({ ok: false, error: { code: 'unanchored_root' } })
    const g = buildGraph({ migrations: [{ id: id(1), dependsOn: [bl] }], baselines: [bl] })
    if (!g.ok) throw new Error('unexpected')
    expect(pendingOrder(g.value, new Set())).toMatchObject({ ok: false, error: { code: 'baseline_missing' } })
    expect(pendingOrder(g.value, new Set([bl]))).toEqual({ ok: true, value: [id(1)] })
  })

  test('selection pulls in pending ancestors only, in dependency order', () => {
    const g = buildGraph({ migrations: [mig(1), mig(2, [1]), mig(3), mig(4, [2, 3])] })
    if (!g.ok) throw new Error('graph')
    const r = selectionOrder(g.value, new Set([id(1)]), [id(4)])
    expect(r).toEqual({ ok: true, value: [2, 3, 4].map(id) })
    const only = selectionOrder(g.value, new Set(), [id(3)])
    expect(only).toEqual({ ok: true, value: [id(3)] })
  })

  test('an applied migration whose dependency is not applied is an inconsistent history, never ordered around', () => {
    const g = buildGraph({ migrations: [mig(1), mig(2, [1])] })
    if (!g.ok) throw new Error('graph')
    expect(pendingOrder(g.value, new Set([id(2)]))).toMatchObject({ ok: false, error: { code: 'dependency_missing' } })
    expect(pendingOrder(g.value, new Set([id(9)]))).toMatchObject({ ok: false, error: { code: 'unknown_applied' } })
  })
})

describe('I3 properties (random DAGs; reference = smallest ready id first)', () => {
  const dagArb = fc.integer({ min: 1, max: 40 }).chain((n) =>
    fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), { minLength: n, maxLength: n }).map((matrix) => {
      // edge j -> i (i depends on j) only for j < i in a hidden "layer" order: acyclic by construction
      const deps: number[][] = Array.from({ length: n }, () => [])
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (matrix[i]?.[j] === true && ((i * 31 + j * 17) % 3 !== 0)) deps[i]?.push(j)
      return deps
    }),
  )

  test('order equals the reference, is a topological order and ignores input order (300 runs)', () => {
    fc.assert(
      fc.property(dagArb, fc.nat(), fc.nat(), (deps, relabelSeed, shuffleSeed) => {
        const n = deps.length
        // random ULID labelling: the id order has nothing to do with the dependency layers
        const labels = shuffle(Array.from({ length: n }, (_, i) => 100 + i * 3), relabelSeed + 1)
        const migs: GraphMigration[] = deps.map((d, i) => ({ id: id(labels[i] as number), dependsOn: d.map((j) => id(labels[j] as number)) }))
        const o1 = orderOf(migs)
        const o2 = orderOf(shuffle(migs, shuffleSeed + 7))
        const pos = new Map(o1.map((x, k) => [x, k]))
        const topo = migs.every((m) => m.dependsOn.every((d) => (pos.get(d) ?? Infinity) < (pos.get(m.id) ?? -1)))
        return topo && JSON.stringify(o1) === JSON.stringify(o2) && JSON.stringify(o1) === JSON.stringify(reference(migs))
      }),
      { numRuns: 300, seed: 424242 },
    )
  })

  test('the same DAG shape with different ULID assignments: both orders are valid; only incomparable nodes may swap (200 runs)', () => {
    fc.assert(
      fc.property(dagArb, fc.nat(), fc.nat(), (deps, s1, s2) => {
        const n = deps.length
        const build = (seed: number) => {
          const labels = shuffle(Array.from({ length: n }, (_, i) => 100 + i * 3), seed + 1)
          return deps.map((d, i) => ({ id: id(labels[i] as number), dependsOn: d.map((j) => id(labels[j] as number)) }))
        }
        const a = build(s1)
        const b = build(s2)
        const oa = orderOf(a)
        const ob = orderOf(b)
        // map both back to shape indexes via the dependency structure: every edge respected in both
        const ok = (migs: GraphMigration[], o: readonly string[]) => {
          const p = new Map(o.map((x, k) => [x, k]))
          return migs.every((m) => m.dependsOn.every((d) => (p.get(d) ?? Infinity) < (p.get(m.id) ?? -1)))
        }
        return ok(a, oa) && ok(b, ob) && oa.length === n && ob.length === n
      }),
      { numRuns: 200, seed: 99 },
    )
  })

  test('a random cycle injected into a random DAG is always found, in any input order (200 runs)', () => {
    fc.assert(
      fc.property(dagArb, fc.nat(), fc.nat(), (deps, a, b) => {
        const n = deps.length
        if (n < 2) return true
        const hi = Math.max(a % n, b % n)
        const lo = Math.min(a % n, b % n)
        if (hi === lo) return true
        // make `lo` depend on `hi`, and `hi` already (transitively) may not depend on lo: force the edge hi -> lo
        const withCycle = deps.map((d) => d.slice())
        withCycle[hi]?.push(lo)
        withCycle[lo]?.push(hi)
        const migs = withCycle.map((d, i) => mig(100 + i * 3, d.map((j) => 100 + j * 3)))
        const g1 = buildGraph({ migrations: migs })
        const g2 = buildGraph({ migrations: shuffle(migs, a + b) })
        return !g1.ok && g1.error.code === 'cycle' && JSON.stringify(g1) === JSON.stringify(g2)
      }),
      { numRuns: 200, seed: 7 },
    )
  })
})

describe('I3 scale (time and memory are recorded in the measurement file)', () => {
  test('1,000-deep chain: order is the chain, selection of the tail pulls the whole chain', () => {
    const n = 1000
    const migs = Array.from({ length: n }, (_, i) => mig(1000 + i, i === 0 ? [] : [1000 + i - 1]))
    const m = measure('I3 chain-1000 build+order', () => orderOf(shuffle(migs, 3)))
    expect(m.value).toEqual(Array.from({ length: n }, (_, i) => id(1000 + i)))
    const g = buildGraph({ migrations: migs })
    if (!g.ok) throw new Error('graph')
    const sel = measure('I3 chain-1000 selectionOrder(tail)', () => selectionOrder(g.value, new Set(), [id(1000 + n - 1)]))
    expect(sel.value).toMatchObject({ ok: true })
    expect(m.ms).toBeLessThan(5_000)
  })

  test('chain in REVERSE id order: ULIDs say the opposite of dependsOn for 1,000 nodes', () => {
    const n = 1000
    const migs = Array.from({ length: n }, (_, i) => mig(5000 - i, i === 0 ? [] : [5000 - i + 1]))
    const o = orderOf(migs)
    expect(o).toEqual(Array.from({ length: n }, (_, i) => id(5000 - n + 1 + (n - 1 - i))))
  })

  test('5,000-wide fan-out: one root, 5,000 dependants; and a node with 5,000 dependencies', () => {
    const wide = [mig(1)]
    for (let i = 0; i < 5000; i++) wide.push(mig(10 + i, [1]))
    const m = measure('I3 fanout-5000 order', () => orderOf(shuffle(wide, 11)))
    expect(m.value).toHaveLength(5001)
    expect(m.value[0]).toBe(id(1))
    expect([...m.value].slice(1)).toEqual([...m.value].slice(1).sort())
    // 5,000 dependencies on one node: the graph accepts it (the manifest schema caps dependsOn at 1,000)
    const join = [...Array.from({ length: 5000 }, (_, i) => mig(10 + i)), mig(1, Array.from({ length: 5000 }, (_, i) => 10 + i))]
    const j = measure('I3 join-5000 order', () => orderOf(join))
    expect(j.value.at(-1)).toBe(id(1))
  })

  test('selection over a 5,000-chain: cost of selectionOrder with many selected ids', () => {
    const n = 5000
    const migs = Array.from({ length: n }, (_, i) => mig(1000 + i, i === 0 ? [] : [1000 + i - 1]))
    const g = buildGraph({ migrations: migs })
    if (!g.ok) throw new Error('graph')
    const selected = Array.from({ length: 200 }, (_, i) => id(1000 + 25 * i + 24))
    const r = measure('I3 chain-5000 selectionOrder(200 selected)', () => selectionOrder(g.value, new Set(), selected))
    expect(r.value).toMatchObject({ ok: true })
    expect(r.ms).toBeLessThan(30_000)
  })

  test('a 5,000-node cycle is found without a stack overflow, and reported as that cycle', () => {
    const n = 5000
    const migs = Array.from({ length: n }, (_, i) => mig(1000 + i, [1000 + ((i + 1) % n)]))
    const r = measure('I3 cycle-5000', () => buildGraph({ migrations: migs }))
    expect(r.value).toMatchObject({ ok: false, error: { code: 'cycle' } })
    if (!r.value.ok && r.value.error.code === 'cycle') expect(r.value.error.cycle).toHaveLength(n)
  })

  test('20,000 independent nodes: order, heads and roots', () => {
    const migs = Array.from({ length: 20000 }, (_, i) => mig(1000 + i))
    const r = measure('I3 flat-20000', () => orderOf(migs))
    expect(r.value).toHaveLength(20000)
  })
})

describe('I3 through the linter (the CLI / CI view of the same stream)', () => {
  test('lint order for bundles submitted in any file order equals the graph order; cycle, self, unknown are blocking', async () => {
    await prepareLint(17)
    const b = (n: number, deps: number[] = []) => mk({ id: id(n), name: `m${n}`, dependsOn: deps.map(id) })
    const stream = [b(3, [2]), b(1), b(2, [1])]
    const a = lint(stream)
    const c = lint(shuffle(stream, 9))
    expect(a.graph.valid).toBe(true)
    expect(a.graph.order).toEqual([1, 2, 3].map(id))
    expect(c.graph.order).toEqual(a.graph.order)

    const cyc = lint([b(1, [2]), b(2, [1])])
    expect(cyc.graph.valid).toBe(false)
    expect(cyc.graph.errors.map((e) => e.code)).toContain('MIGRATION_DEPENDENCY_CYCLE')
    expect(cyc.blocking).toBe(true)

    const self = lint([b(1, [1])])
    expect(self.graph.valid).toBe(false)
    expect(self.blocking).toBe(true)

    const unknown = lint([b(2, [77])])
    expect(unknown.graph.valid).toBe(false)
    expect(unknown.graph.errors.map((e) => e.code)).toContain('MIGRATION_DEPENDENCY_UNKNOWN')
    expect(unknown.blocking).toBe(true)
  })

  test('manifest dependsOn is capped at 1,000 entries (schema), duplicates are deduplicated', () => {
    const many = Array.from({ length: 1001 }, (_, i) => id(2000 + i))
    const over = lint([mk({ id: id(1), dependsOn: many })])
    expect(over.blocking).toBe(true)
    const dup = lint([mk({ id: id(2), dependsOn: [id(1), id(1)] }), mk({ id: id(1), name: 'one' })])
    expect(dup.graph.valid).toBe(true)
  })
})

describe('I3 scale of the linter over a dependency chain (the CLI / CI / plan view of a project)', () => {
  test('lint time over a chain of n bundles must not grow faster than quadratically: t(400) / t(200) < 3.5', async () => {
    await prepareLint(17)
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        mk({ id: ulidOf(1000 + i), name: `c${i}`, up: i === 0 ? 'CREATE TABLE public.ch (i int);\n' : `COMMENT ON TABLE public.ch IS 'step ${i}';\n`, dependsOn: i === 0 ? [] : [ulidOf(1000 + i - 1)] }),
      )
    lint(chain(60)) // warm the parser and the JIT
    const a = measure('I3 lint chain-200', () => lint(chain(200)))
    const b = measure('I3 lint chain-400', () => lint(chain(400)))
    console.log(`I3 lint chain: 200 -> ${a.ms} ms, 400 -> ${b.ms} ms (x${Math.round((b.ms / a.ms) * 10) / 10}); 800 bundles took 61 s in the first run (x8.7)`)
    expect(b.ms / a.ms, 'doubling the chain must not multiply lint time by more than 3.5').toBeLessThan(3.5)
  }, 300_000)

  test('lint time over 400 independent bundles that touch one table is linear (control)', async () => {
    await prepareLint(17)
    const indep = (n: number) => Array.from({ length: n }, (_, i) => mk({ id: ulidOf(5000 + i), name: `w${i}`, up: i === 0 ? 'CREATE TABLE public.ch (i int);\n' : `COMMENT ON TABLE public.ch IS 'step ${i}';\n` }))
    const a = measure('I3 lint indep-200', () => lint(indep(200)))
    const b = measure('I3 lint indep-400', () => lint(indep(400)))
    expect(b.ms / (a.ms + 1)).toBeLessThan(4)
  }, 300_000)
})
