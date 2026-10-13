import { describe, expect, it } from 'vitest'

import { type Orderable, orderBundles } from '../../src/timeline/order.ts'

function bundle(id: string, ...dependsOn: string[]): Orderable {
  return { id, dependsOn }
}

function ids(list: readonly Orderable[]): string[] {
  return list.map((entry) => entry.id)
}

/** A small deterministic generator, so the shuffles of the tests are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    const a = copy[index]
    const b = copy[other]
    if (a !== undefined && b !== undefined) {
      copy[index] = b
      copy[other] = a
    }
  }
  return copy
}

describe('orderBundles', () => {
  it('puts a bundle after everything it depends on', () => {
    const { ordered, issues } = orderBundles([
      bundle('D', 'B', 'C'),
      bundle('B', 'A'),
      bundle('C', 'A'),
      bundle('A'),
    ])

    expect(ids(ordered)).toEqual(['A', 'B', 'C', 'D'])
    expect(issues).toEqual([])
  })

  it('lets the dependencies decide before the ids do', () => {
    // "Z" sorts last by id, but "A" depends on it, so it comes first.
    const { ordered } = orderBundles([bundle('A', 'Z'), bundle('Z')])

    expect(ids(ordered)).toEqual(['Z', 'A'])
  })

  it('breaks ties by id: of the bundles that are ready, the smallest id comes next', () => {
    const { ordered } = orderBundles([
      bundle('M'),
      bundle('B'),
      bundle('X', 'B'),
      bundle('A', 'M'),
      bundle('C'),
    ])

    // Ready at the start: B, C, M. B first; then X is ready as well (X, C, M): C; then M; then A (A, X).
    expect(ids(ordered)).toEqual(['B', 'C', 'M', 'A', 'X'])
  })

  it('gives the same order for every arrangement of the same bundles', () => {
    const base: Orderable[] = [
      bundle('01J', '01A', '01C'),
      bundle('01A'),
      bundle('01C', '01A'),
      bundle('01B'),
      bundle('01K', '01B'),
      bundle('01D', '01J', '01K'),
      bundle('01E'),
    ]
    const expected = ids(orderBundles(base).ordered)
    const random = seeded(7)

    for (let round = 0; round < 25; round += 1) {
      expect(ids(orderBundles(shuffled(base, random)).ordered)).toEqual(expected)
    }
    // Every dependency comes before its dependent.
    const position = new Map(expected.map((id, index) => [id, index]))
    for (const entry of base) {
      for (const dependency of entry.dependsOn) {
        expect(position.get(dependency)).toBeLessThan(position.get(entry.id) ?? -1)
      }
    }
  })

  it('compares ids by code unit, not by locale', () => {
    const { ordered } = orderBundles([bundle('b'), bundle('B'), bundle('a'), bundle('Z')])

    expect(ids(ordered)).toEqual(['B', 'Z', 'a', 'b'])
  })

  it('does not let a dependency on an id outside the list hold a bundle back', () => {
    const { ordered, issues } = orderBundles([bundle('B', 'baseline-1', 'missing'), bundle('A')])

    expect(ids(ordered)).toEqual(['A', 'B'])
    expect(issues).toEqual([])
  })

  it('counts a dependency listed twice once', () => {
    const { ordered } = orderBundles([bundle('B', 'A', 'A'), bundle('A')])

    expect(ids(ordered)).toEqual(['A', 'B'])
  })

  it('keeps the first of two bundles with one id and says so', () => {
    const first = { id: 'A', dependsOn: [], tag: 'first' }
    const second = { id: 'A', dependsOn: [], tag: 'second' }
    const { ordered, issues } = orderBundles([first, second, bundle('B')])

    expect(ordered).toHaveLength(2)
    expect(ordered[0]).toBe(first)
    expect(issues).toEqual([{ kind: 'duplicate_id', id: 'A', dropped: 1 }])
  })

  it('does not lose bundles to a cycle: they follow the ordered ones, by id, with an issue', () => {
    const { ordered, issues } = orderBundles([
      bundle('A', 'B'),
      bundle('B', 'A'),
      bundle('C'),
      bundle('D', 'A'),
      bundle('E', 'C'),
    ])

    expect(ids(ordered)).toEqual(['C', 'E', 'A', 'B', 'D'])
    expect(issues).toEqual([{ kind: 'cycle', ids: ['A', 'B', 'D'] }])
  })

  it('treats a bundle that depends on itself as a cycle', () => {
    const { ordered, issues } = orderBundles([bundle('A', 'A'), bundle('B')])

    expect(ids(ordered)).toEqual(['B', 'A'])
    expect(issues).toEqual([{ kind: 'cycle', ids: ['A'] }])
  })

  it('orders an empty list', () => {
    expect(orderBundles([])).toEqual({ ordered: [], issues: [] })
  })

  it('orders a long chain in linear-ish time without recursion', () => {
    const count = 20_000
    const chain: Orderable[] = []
    for (let index = count - 1; index >= 0; index -= 1) {
      const id = String(index).padStart(6, '0')
      chain.push(index === 0 ? bundle(id) : bundle(id, String(index - 1).padStart(6, '0')))
    }

    const started = Date.now()
    const { ordered, issues } = orderBundles(chain)

    expect(ordered).toHaveLength(count)
    expect(issues).toEqual([])
    expect(ordered[0]?.id).toBe('000000')
    expect(ordered[count - 1]?.id).toBe(String(count - 1).padStart(6, '0'))
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
