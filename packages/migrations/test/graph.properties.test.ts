import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphMigration, pendingOrder } from '../src/graph/index.ts'
import { u } from './graph-fixtures.ts'

/**
 * Property tests over random DAGs (dependency-graph.md §9): the order is a
 * pure function of the graph, respects every edge, prefers the smallest ready
 * id, and the pending set is exactly the unapplied nodes in that order.
 */

interface Dag {
  readonly migrations: GraphMigration[]
}

/** A random DAG: node k may only depend on nodes created before it (in a random id permutation). */
const dagArbitrary = fc
  .integer({ min: 1, max: 40 })
  .chain((n) =>
    fc.record({
      ids: fc.shuffledSubarray(
        Array.from({ length: n * 3 }, (_, i) => u(i + 1)),
        { minLength: n, maxLength: n },
      ),
      edges: fc.array(fc.array(fc.nat({ max: 1000 }), { maxLength: 4 }), {
        minLength: n,
        maxLength: n,
      }),
    }),
  )
  .map(
    ({ ids, edges }): Dag => ({
      migrations: ids.map((id, k) => ({
        id,
        dependsOn: k === 0 ? [] : (edges[k] ?? []).map((e) => ids[e % k] ?? ''),
      })),
    }),
  )

function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) {
      out[i] = b
      out[j] = a
    }
  }
  return out
}

function orderOf(migrations: readonly GraphMigration[]): readonly string[] {
  const g = buildGraph({ migrations })
  if (!g.ok) {
    throw new Error(`generated DAG refused: ${g.error.code}`)
  }
  return g.value.order()
}

describe('migration graph properties', () => {
  it('randomized input order (nodes and edges) always yields the identical order', () => {
    fc.assert(
      fc.property(dagArbitrary, fc.integer(), (dag, seed) => {
        const shuffled = permute(dag.migrations, seed).map((mig, i) => ({
          id: mig.id,
          dependsOn: permute(mig.dependsOn, seed + i),
        }))
        expect(orderOf(shuffled)).toEqual(orderOf(dag.migrations))
      }),
      { numRuns: 300 },
    )
  })

  it('the order contains every node once and respects every dependency', () => {
    fc.assert(
      fc.property(dagArbitrary, (dag) => {
        const order = orderOf(dag.migrations)
        expect([...order].sort()).toEqual(dag.migrations.map((x) => x.id).sort())
        const position = new Map(order.map((id, i) => [id, i]))
        for (const mig of dag.migrations) {
          for (const dep of mig.dependsOn) {
            expect(position.get(dep) ?? -1).toBeLessThan(position.get(mig.id) ?? -1)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  it('at every step the smallest ready id is chosen (ULID tie-break)', () => {
    fc.assert(
      fc.property(dagArbitrary, (dag) => {
        const order = orderOf(dag.migrations)
        const deps = new Map(dag.migrations.map((x) => [x.id, new Set(x.dependsOn)]))
        const done = new Set<string>()
        for (const id of order) {
          const ready = dag.migrations
            .map((x) => x.id)
            .filter((x) => !done.has(x) && [...(deps.get(x) ?? [])].every((d) => done.has(d)))
            .sort()
          expect(id).toBe(ready[0])
          done.add(id)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('pending = stream − applied, in graph order, for every downward-closed applied set', () => {
    fc.assert(
      fc.property(dagArbitrary, fc.nat(), (dag, cut) => {
        const g = buildGraph({ migrations: dag.migrations })
        if (!g.ok) {
          throw new Error('generated DAG refused')
        }
        const order = g.value.order()
        // Any prefix of a valid order is a consistent applied set.
        const applied = new Set(order.slice(0, cut % (order.length + 1)))
        const pending = pendingOrder(g.value, applied)
        expect(pending.ok).toBe(true)
        if (pending.ok) {
          expect(pending.value).toEqual(order.filter((id) => !applied.has(id)))
        }
      }),
      { numRuns: 300 },
    )
  })

  it('adding a back edge always produces a cycle that is reported', () => {
    fc.assert(
      fc.property(dagArbitrary, fc.nat(), (dag, pick) => {
        const g = buildGraph({ migrations: dag.migrations })
        if (!g.ok || dag.migrations.length < 2) {
          return
        }
        // Make an ancestor depend on one of its dependants.
        const withDeps = dag.migrations.filter((x) => x.dependsOn.length > 0)
        const child = withDeps[pick % Math.max(1, withDeps.length)]
        if (child === undefined) {
          return
        }
        const parent = child.dependsOn[0] ?? ''
        const cyclic = dag.migrations.map((x) =>
          x.id === parent ? { id: x.id, dependsOn: [...x.dependsOn, child.id] } : x,
        )
        const result = buildGraph({ migrations: cyclic })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe('cycle')
          if (result.error.code === 'cycle') {
            const ids = new Map(cyclic.map((x) => [x.id, x.dependsOn]))
            const cycle = result.error.cycle
            // Each member depends on the next, the last on the first.
            for (let i = 0; i < cycle.length; i++) {
              const from = cycle[i] ?? ''
              const to = cycle[(i + 1) % cycle.length] ?? ''
              expect(ids.get(from)).toContain(to)
            }
            expect(cycle[0]).toBe([...cycle].sort()[0])
          }
        }
      }),
      { numRuns: 300 },
    )
  })
})
