import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  checkOrder,
  type GraphMigration,
  type MigrationGraph,
  pendingOrder,
  selectionOrder,
  toCatalogError,
} from '../src/graph/index.ts'
import { u } from './graph-fixtures.ts'

function m(id: string, ...dependsOn: string[]): GraphMigration {
  return { id, dependsOn }
}

function graph(migrations: GraphMigration[], baselines?: string[]): MigrationGraph {
  const built = buildGraph(baselines === undefined ? { migrations } : { migrations, baselines })
  if (!built.ok) {
    throw new Error(`unexpected failure: ${JSON.stringify(built.error)}`)
  }
  return built.value
}

const A = u(1)
const B = u(2)
const C = u(3)
const D = u(4)
const E = u(5)

describe('migration graph: order', () => {
  it('orders a chain A → B → C by dependencies, not by input order', () => {
    const g = graph([m(C, B), m(A), m(B, A)])
    expect(g.order()).toEqual([A, B, C])
    expect(g.heads()).toEqual([C])
    expect(g.roots()).toEqual([A])
  })

  it('orders independent nodes by ULID', () => {
    const g = graph([m(B), m(A)])
    expect(g.order()).toEqual([A, B])
    expect(g.heads()).toEqual([A, B])
  })

  it('a dependency beats a smaller id: B before A when A depends on B', () => {
    const g = graph([m(A, B), m(B)])
    expect(g.order()).toEqual([B, A])
  })

  it('orders a diamond deterministically', () => {
    // D depends on B and C, both depend on A.
    const g = graph([m(D, C, B), m(C, A), m(B, A), m(A)])
    expect(g.order()).toEqual([A, B, C, D])
    expect(g.ancestors(D)).toEqual([A, B, C])
    expect(g.dependants(A)).toEqual([B, C, D])
    expect(g.heads()).toEqual([D])
  })

  it('reports multiple heads', () => {
    const g = graph([m(A), m(B, A), m(C, A), m(E)])
    expect(g.heads()).toEqual([B, C, E])
  })

  it('deduplicates repeated dependency edges', () => {
    const g = graph([m(A), m(B, A, A)])
    expect(g.dependenciesOf(B)).toEqual([A])
  })
})

describe('migration graph: validation', () => {
  it('refuses a missing dependency', () => {
    expect(buildGraph({ migrations: [m(B, A, C)] })).toEqual({
      ok: false,
      error: { code: 'unknown_dependency', from: B, missing: [A, C] },
    })
  })

  it('refuses a self dependency as a cycle', () => {
    expect(buildGraph({ migrations: [m(A, A)] })).toEqual({
      ok: false,
      error: { code: 'cycle', cycle: [A] },
    })
  })

  it('refuses a two-node cycle', () => {
    expect(buildGraph({ migrations: [m(B, A), m(A, B)] })).toEqual({
      ok: false,
      error: { code: 'cycle', cycle: [A, B] },
    })
  })

  it('refuses an N-node cycle and lists it in dependency order from the smallest id', () => {
    // A → D → C → B → A (each depends on the next), plus an acyclic tail E → A.
    const result = buildGraph({ migrations: [m(A, D), m(D, C), m(C, B), m(B, A), m(E, A)] })
    expect(result).toEqual({ ok: false, error: { code: 'cycle', cycle: [A, D, C, B] } })
  })

  it('reports the shortest cycle through the smallest id', () => {
    // A depends on B and C; B → A (short) and C → D → A (long).
    const result = buildGraph({ migrations: [m(A, B, C), m(B, A), m(C, D), m(D, A)] })
    expect(result).toEqual({ ok: false, error: { code: 'cycle', cycle: [A, B] } })
  })

  it('refuses a duplicate id', () => {
    expect(buildGraph({ migrations: [m(A), m(A)] })).toEqual({
      ok: false,
      error: { code: 'duplicate_id', id: A },
    })
  })

  it('refuses ids and references that are neither ULIDs nor baselines', () => {
    expect(buildGraph({ migrations: [m('01jb000')] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_id' },
    })
    expect(buildGraph({ migrations: [m(A, 'baseline:Bad Slug')] })).toEqual({
      ok: false,
      error: { code: 'invalid_reference', from: A, reference: 'baseline:Bad Slug' },
    })
    expect(buildGraph({ migrations: [], baselines: ['legacy:x'] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_id', id: 'legacy:x' },
    })
  })

  it('maps failures to the catalog codes they surface as', () => {
    expect(toCatalogError({ code: 'cycle', cycle: [A, B] })).toEqual({
      code: 'MIGRATION_DEPENDENCY_CYCLE',
      details: { cycle: [A, B] },
    })
    expect(toCatalogError({ code: 'duplicate_id', id: A })).toEqual({
      code: 'MIGRATION_BUNDLE_INVALID',
      details: { reason: 'duplicate_migration_id' },
    })
    expect(toCatalogError({ code: 'unknown_dependency', from: A, missing: [B] })).toEqual({
      code: 'MIGRATION_DEPENDENCY_UNKNOWN',
    })
    expect(toCatalogError({ code: 'dependency_missing', from: A, missing: [B] })).toEqual({
      code: 'MIGRATION_DEPENDENCY_MISSING',
      details: { missing: [B] },
    })
    expect(toCatalogError({ code: 'unanchored_root', id: A })).toBeUndefined()
  })
})

describe('migration graph: baselines', () => {
  const BASE = 'baseline:demo-2026-10'

  it('treats a baseline as a root that migrations depend on', () => {
    const g = graph([m(B, BASE), m(A, BASE)], [BASE])
    expect(g.roots()).toEqual([BASE])
    expect(g.order()).toEqual([BASE, A, B])
    expect(g.isBaseline(BASE)).toBe(true)
  })

  it('refuses a migration without dependencies in a stream with a baseline', () => {
    expect(buildGraph({ migrations: [m(A, BASE), m(B)], baselines: [BASE] })).toEqual({
      ok: false,
      error: { code: 'unanchored_root', id: B },
    })
  })

  it('refuses a reference to a baseline the stream does not know', () => {
    expect(buildGraph({ migrations: [m(A, BASE)] })).toEqual({
      ok: false,
      error: { code: 'unknown_dependency', from: A, missing: [BASE] },
    })
  })

  it('never executes a baseline: a target without it is refused', () => {
    const g = graph([m(A, BASE)], [BASE])
    expect(pendingOrder(g, new Set())).toEqual({
      ok: false,
      error: { code: 'baseline_missing', baseline: BASE },
    })
    expect(pendingOrder(g, new Set([BASE]))).toEqual({ ok: true, value: [A] })
  })
})

describe('migration graph: pending sets', () => {
  const g = graph([m(A), m(B, A), m(C, A), m(D, B, C), m(E)])

  it('computes the pending set in application order', () => {
    expect(pendingOrder(g, new Set())).toEqual({ ok: true, value: [A, B, C, D, E] })
    expect(pendingOrder(g, new Set([A, C]))).toEqual({ ok: true, value: [B, D, E] })
    expect(pendingOrder(g, new Set([A, B, C, D, E]))).toEqual({ ok: true, value: [] })
  })

  it('refuses applied ids the stream does not know', () => {
    expect(pendingOrder(g, new Set([A, u(99)]))).toEqual({
      ok: false,
      error: { code: 'unknown_applied', ids: [u(99)] },
    })
  })

  it('refuses an applied migration whose dependency is not applied', () => {
    expect(pendingOrder(g, new Set([B]))).toEqual({
      ok: false,
      error: { code: 'dependency_missing', from: B, missing: [A] },
    })
  })

  it('selects exactly the chosen migrations plus their pending ancestors', () => {
    expect(selectionOrder(g, new Set([A]), [D])).toEqual({ ok: true, value: [B, C, D] })
    expect(selectionOrder(g, new Set(), [E])).toEqual({ ok: true, value: [E] })
    expect(selectionOrder(g, new Set([A]), [u(77)])).toEqual({
      ok: false,
      error: { code: 'unknown_selection', ids: [u(77)] },
    })
  })

  it('checks an externally supplied order', () => {
    expect(checkOrder(g, new Set([A]), [C, B, D])).toEqual({ ok: true, value: true })
    expect(checkOrder(g, new Set([A]), [D, B, C])).toEqual({
      ok: false,
      error: { code: 'dependency_missing', from: D, missing: [B, C] },
    })
  })
})
