/**
 * The order of the migration timeline: bundles in dependency order (a bundle after everything it
 * depends on), ties broken by id. Order comes from `dependsOn`, never from the ids themselves
 * (migration rules); the id only makes the order stable when the graph does not decide.
 */

export interface Orderable {
  readonly id: string
  readonly dependsOn: readonly string[]
}

/** Something about the input that the order could not honor, said instead of hidden. */
export type OrderIssue =
  /** The id appears more than once; the first occurrence is kept, the others are dropped. */
  | { readonly kind: 'duplicate_id'; readonly id: string; readonly dropped: number }
  /**
   * Bundles that a dependency cycle (or a dependency on one) keeps out of the dependency order.
   * They follow the ordered bundles, by id.
   */
  | { readonly kind: 'cycle'; readonly ids: readonly string[] }

export interface BundleOrder<T extends Orderable> {
  readonly ordered: readonly T[]
  readonly issues: readonly OrderIssue[]
}

/** Code unit order: the same on every device and locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A binary min-heap of ids, so picking the smallest ready id costs O(log n). */
class IdHeap {
  private readonly items: string[] = []

  get size(): number {
    return this.items.length
  }

  push(id: string): void {
    const items = this.items
    items.push(id)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      const current = items[index]
      const above = items[parent]
      if (current === undefined || above === undefined || compareIds(above, current) <= 0) break
      items[index] = above
      items[parent] = current
      index = parent
    }
  }

  pop(): string | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (top === undefined || last === undefined) return undefined
    if (items.length === 0) return top
    items[0] = last
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      const leftId = items[left]
      const rightId = items[right]
      const smallestId = items[smallest]
      if (leftId !== undefined && smallestId !== undefined && compareIds(leftId, smallestId) < 0) {
        smallest = left
      }
      const nowSmallest = items[smallest]
      if (
        rightId !== undefined &&
        nowSmallest !== undefined &&
        compareIds(rightId, nowSmallest) < 0
      ) {
        smallest = right
      }
      if (smallest === index) return top
      const a = items[index]
      const b = items[smallest]
      if (a === undefined || b === undefined) return top
      items[index] = b
      items[smallest] = a
      index = smallest
    }
  }
}

/**
 * Orders bundles by a topological sort of `dependsOn` (Kahn's algorithm), taking the smallest id
 * among the bundles that are ready. A dependency on an id that is not a bundle of the list (a
 * baseline, or a bundle outside a truncated list) imposes no order. Duplicate ids and cycles do
 * not lose rows silently: see `OrderIssue`.
 */
export function orderBundles<T extends Orderable>(bundles: readonly T[]): BundleOrder<T> {
  const issues: OrderIssue[] = []

  const byId = new Map<string, T>()
  const dropped = new Map<string, number>()
  for (const bundle of bundles) {
    if (byId.has(bundle.id)) {
      dropped.set(bundle.id, (dropped.get(bundle.id) ?? 0) + 1)
    } else {
      byId.set(bundle.id, bundle)
    }
  }
  for (const [id, count] of dropped) issues.push({ kind: 'duplicate_id', id, dropped: count })

  // dependents.get(x): the bundles that wait for x; waiting.get(y): how many bundles y waits for.
  const dependents = new Map<string, string[]>()
  const waiting = new Map<string, number>()
  for (const [id, bundle] of byId) {
    const needs = new Set<string>()
    for (const dependency of bundle.dependsOn) if (byId.has(dependency)) needs.add(dependency)
    waiting.set(id, needs.size)
    for (const dependency of needs) {
      const list = dependents.get(dependency)
      if (list === undefined) dependents.set(dependency, [id])
      else list.push(id)
    }
  }

  const ready = new IdHeap()
  for (const [id, count] of waiting) if (count === 0) ready.push(id)

  const placed = new Set<string>()
  const ordered: T[] = []
  while (ready.size > 0) {
    const id = ready.pop()
    if (id === undefined) break
    const bundle = byId.get(id)
    if (bundle === undefined) continue
    placed.add(id)
    ordered.push(bundle)
    for (const next of dependents.get(id) ?? []) {
      const remaining = (waiting.get(next) ?? 0) - 1
      waiting.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  if (placed.size < byId.size) {
    const rest = [...byId.keys()].filter((id) => !placed.has(id)).sort(compareIds)
    issues.push({ kind: 'cycle', ids: rest })
    for (const id of rest) {
      const bundle = byId.get(id)
      if (bundle !== undefined) ordered.push(bundle)
    }
  }

  return { ordered, issues }
}
