import { err, isMigrationId, ok, type Result } from '@exponetdb/kernel'

/**
 * The migration dependency graph ([dependency-graph.md](../../../../exponetdb-docs/04-migrations/dependency-graph.md)).
 *
 * Pure: the caller passes already loaded and validated bundle metadata; no
 * file system, network or database. The Control Store bootstrap runner (Wave
 * 2), the engine and the CLI (Wave 6) call the same functions, so every
 * planner computes the same order.
 *
 * Nodes are migrations (bare ULIDs) and baseline nodes (`baseline:<slug>`).
 * An edge "B depends on A" means A is applied before B. Order is a pure
 * function of the graph: Kahn's algorithm, and among ready nodes the smallest
 * id (code point order) first. Input order never matters.
 */
export const BASELINE_REF = /^baseline:[a-z0-9]+(?:-[a-z0-9]+)*$/
const BASELINE_MAX_LENGTH = 'baseline:'.length + 64

export function isBaselineRef(value: string): boolean {
  return value.length <= BASELINE_MAX_LENGTH && BASELINE_REF.test(value)
}

/** One migration as the graph needs it: its id and its declared `dependsOn`. */
export interface GraphMigration {
  readonly id: string
  readonly dependsOn: readonly string[]
}

export interface GraphInput {
  readonly migrations: readonly GraphMigration[]
  /** Baseline nodes known to the stream (legacy import, Wave 6). They have no dependencies. */
  readonly baselines?: readonly string[]
}

/**
 * Why a stream is not a valid graph, in the order the checks run (the first
 * failing check is reported, so the result is deterministic):
 *
 * - `invalid_id`: a node id is neither a canonical ULID nor a baseline ref;
 * - `duplicate_id`: two nodes share an id (`MIGRATION_BUNDLE_INVALID`,
 *   reason `duplicate_migration_id`);
 * - `invalid_reference`: a `dependsOn` entry is neither form;
 * - `unknown_dependency`: `dependsOn` names an id that is not in the stream
 *   (`MIGRATION_DEPENDENCY_UNKNOWN`);
 * - `cycle`: the declarations form a cycle, a self-dependency included
 *   (`MIGRATION_DEPENDENCY_CYCLE`); `cycle` lists the ids in dependency order
 *   starting at the smallest id of the smallest cycle through it;
 * - `unanchored_root`: a migration without dependencies in a stream that has a
 *   baseline (roots of such a stream are baselines only).
 */
export type GraphFailure =
  | { readonly code: 'invalid_id'; readonly id: string }
  | { readonly code: 'duplicate_id'; readonly id: string }
  | { readonly code: 'invalid_reference'; readonly from: string; readonly reference: string }
  | {
      readonly code: 'unknown_dependency'
      readonly from: string
      readonly missing: readonly string[]
    }
  | { readonly code: 'cycle'; readonly cycle: readonly string[] }
  | { readonly code: 'unanchored_root'; readonly id: string }

interface Node {
  readonly id: string
  readonly baseline: boolean
  /** Deduplicated, sorted. */
  readonly dependsOn: readonly string[]
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A validated, acyclic stream. Immutable; every query result is sorted or topologically ordered. */
export class MigrationGraph {
  readonly #nodes: ReadonlyMap<string, Node>
  readonly #dependants: ReadonlyMap<string, readonly string[]>
  readonly #order: readonly string[]

  /** Use {@link buildGraph}. */
  private constructor(nodes: ReadonlyMap<string, Node>) {
    this.#nodes = nodes
    const dependants = new Map<string, string[]>()
    for (const id of nodes.keys()) {
      dependants.set(id, [])
    }
    for (const node of nodes.values()) {
      for (const dep of node.dependsOn) {
        dependants.get(dep)?.push(node.id)
      }
    }
    for (const list of dependants.values()) {
      list.sort(compareIds)
    }
    this.#dependants = dependants
    this.#order = topologicalOrder(nodes, new Set(nodes.keys()))
  }

  /** @internal Called by {@link buildGraph} after validation. */
  static fromValidated(nodes: ReadonlyMap<string, Node>): MigrationGraph {
    return new MigrationGraph(nodes)
  }

  /** Every node id, sorted. */
  ids(): readonly string[] {
    return [...this.#nodes.keys()].sort(compareIds)
  }

  has(id: string): boolean {
    return this.#nodes.has(id)
  }

  isBaseline(id: string): boolean {
    return this.#nodes.get(id)?.baseline === true
  }

  /** The declared dependencies of `id`, deduplicated and sorted. */
  dependenciesOf(id: string): readonly string[] {
    return this.#nodes.get(id)?.dependsOn ?? []
  }

  /** The whole stream in application order. */
  order(): readonly string[] {
    return this.#order
  }

  /** Nodes without dependants, sorted. */
  heads(): readonly string[] {
    return this.ids().filter((id) => (this.#dependants.get(id)?.length ?? 0) === 0)
  }

  /** Nodes without dependencies (baselines, or migrations of a stream without one), sorted. */
  roots(): readonly string[] {
    return this.ids().filter((id) => (this.#nodes.get(id)?.dependsOn.length ?? 0) === 0)
  }

  /** Everything `id` depends on, directly or transitively, sorted. Empty for an unknown id. */
  ancestors(id: string): readonly string[] {
    return this.#reach(id, (n) => this.#nodes.get(n)?.dependsOn ?? [])
  }

  /** Everything that depends on `id`, directly or transitively, sorted. */
  dependants(id: string): readonly string[] {
    return this.#reach(id, (n) => this.#dependants.get(n) ?? [])
  }

  #reach(start: string, next: (id: string) => readonly string[]): readonly string[] {
    const seen = new Set<string>()
    const stack = [...next(start)]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || seen.has(id)) {
        continue
      }
      seen.add(id)
      stack.push(...next(id))
    }
    return [...seen].sort(compareIds)
  }

  /** @internal */
  nodeMap(): ReadonlyMap<string, Node> {
    return this.#nodes
  }
}

/** Validates a stream and builds its graph. */
export function buildGraph(input: GraphInput): Result<MigrationGraph, GraphFailure> {
  const entries: { id: string; baseline: boolean; dependsOn: readonly string[] }[] = [
    ...input.migrations.map((m) => ({ id: m.id, baseline: false, dependsOn: m.dependsOn })),
    ...(input.baselines ?? []).map((id) => ({ id, baseline: true, dependsOn: [] })),
  ].sort((a, b) => compareIds(a.id, b.id))

  for (const e of entries) {
    if (e.baseline ? !isBaselineRef(e.id) : !isMigrationId(e.id)) {
      return err({ code: 'invalid_id', id: e.id })
    }
  }
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]?.id === entries[i - 1]?.id) {
      return err({ code: 'duplicate_id', id: entries[i]?.id ?? '' })
    }
  }
  const nodes = new Map<string, Node>()
  for (const e of entries) {
    for (const ref of [...e.dependsOn].sort(compareIds)) {
      if (!isMigrationId(ref) && !isBaselineRef(ref)) {
        return err({ code: 'invalid_reference', from: e.id, reference: ref })
      }
    }
    nodes.set(e.id, {
      id: e.id,
      baseline: e.baseline,
      dependsOn: [...new Set(e.dependsOn)].sort(compareIds),
    })
  }
  for (const node of nodes.values()) {
    const missing = node.dependsOn.filter((d) => !nodes.has(d))
    if (missing.length > 0) {
      return err({ code: 'unknown_dependency', from: node.id, missing })
    }
  }
  const cycle = smallestCycle(nodes)
  if (cycle !== undefined) {
    return err({ code: 'cycle', cycle })
  }
  const hasBaseline = [...nodes.values()].some((n) => n.baseline)
  if (hasBaseline) {
    for (const node of nodes.values()) {
      if (!node.baseline && node.dependsOn.length === 0) {
        return err({ code: 'unanchored_root', id: node.id })
      }
    }
  }
  return ok(MigrationGraph.fromValidated(nodes))
}

/**
 * Kahn's algorithm over `subset` (edges to nodes outside it are ignored), with
 * the smallest ready id first. The caller guarantees acyclicity.
 */
function topologicalOrder(nodes: ReadonlyMap<string, Node>, subset: ReadonlySet<string>): string[] {
  const remaining = new Map<string, number>()
  const dependants = new Map<string, string[]>()
  for (const id of subset) {
    const node = nodes.get(id)
    const deps = (node?.dependsOn ?? []).filter((d) => subset.has(d))
    remaining.set(id, deps.length)
    for (const d of deps) {
      const list = dependants.get(d) ?? []
      list.push(id)
      dependants.set(d, list)
    }
  }
  const ready = new MinHeap()
  for (const [id, count] of remaining) {
    if (count === 0) {
      ready.push(id)
    }
  }
  const out: string[] = []
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    out.push(id)
    for (const next of dependants.get(id) ?? []) {
      const count = (remaining.get(next) ?? 0) - 1
      remaining.set(next, count)
      if (count === 0) {
        ready.push(next)
      }
    }
  }
  return out
}

/** Binary min-heap of ids in code point order. */
class MinHeap {
  readonly #items: string[] = []

  push(id: string): void {
    const a = this.#items
    a.push(id)
    let i = a.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      const p = a[parent] ?? ''
      if (p <= id) {
        break
      }
      a[i] = p
      i = parent
    }
    a[i] = id
  }

  pop(): string | undefined {
    const a = this.#items
    const top = a[0]
    const last = a.pop()
    if (a.length === 0 || last === undefined) {
      return top
    }
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      let best = last
      const lv = a[l]
      if (lv !== undefined && lv < best) {
        m = l
        best = lv
      }
      const rv = a[r]
      if (rv !== undefined && rv < best) {
        m = r
        best = rv
      }
      if (m === i) {
        break
      }
      a[i] = best
      i = m
    }
    a[i] = last
    return top
  }
}

/**
 * Tarjan's strongly connected components (iterative). Returns the shortest
 * cycle through the smallest id that lies on any cycle, following `dependsOn`
 * edges and preferring smaller ids on ties; undefined when the graph is acyclic.
 */
function smallestCycle(nodes: ReadonlyMap<string, Node>): string[] | undefined {
  const ids = [...nodes.keys()].sort(compareIds)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const component = new Map<string, number>()
  let counter = 0
  let components = 0
  for (const root of ids) {
    if (index.has(root)) {
      continue
    }
    const work: { id: string; edge: number }[] = [{ id: root, edge: 0 }]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame === undefined) {
        break
      }
      const deps = nodes.get(frame.id)?.dependsOn ?? []
      if (frame.edge < deps.length) {
        const next = deps[frame.edge] ?? ''
        frame.edge += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ id: next, edge: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0))
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        for (;;) {
          const member = stack.pop()
          if (member === undefined) {
            break
          }
          onStack.delete(member)
          component.set(member, components)
          if (member === frame.id) {
            break
          }
        }
        components += 1
      }
    }
  }
  const size = new Map<number, number>()
  for (const c of component.values()) {
    size.set(c, (size.get(c) ?? 0) + 1)
  }
  for (const id of ids) {
    const node = nodes.get(id)
    const c = component.get(id)
    const selfLoop = node?.dependsOn.includes(id) === true
    if (c === undefined || (!selfLoop && (size.get(c) ?? 0) < 2)) {
      continue
    }
    if (selfLoop) {
      return [id]
    }
    // Shortest path id → … → id inside the component, breadth first with sorted edges.
    const previous = new Map<string, string>()
    const queue = [id]
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] ?? ''
      for (const next of nodes.get(current)?.dependsOn ?? []) {
        if (component.get(next) !== c) {
          continue
        }
        if (next === id) {
          const path = [current]
          for (let p = previous.get(current); p !== undefined; p = previous.get(p)) {
            path.push(p)
          }
          return path.reverse()
        }
        if (!previous.has(next) && next !== id) {
          previous.set(next, current)
          queue.push(next)
        }
      }
    }
  }
  return undefined
}

/** Why a pending set cannot be ordered against a target's applied state. */
export type PendingFailure =
  | { readonly code: 'unknown_applied'; readonly ids: readonly string[] }
  | { readonly code: 'baseline_missing'; readonly baseline: string }
  | {
      readonly code: 'dependency_missing'
      readonly from: string
      readonly missing: readonly string[]
    }
  | { readonly code: 'unknown_selection'; readonly ids: readonly string[] }

/**
 * The pending migrations of a target in application order
 * ([dependency-graph.md §4](../../../../exponetdb-docs/04-migrations/dependency-graph.md#4-ordering)).
 *
 * `applied` is the target's applied set (ledger). Applied ids the stream does
 * not know are refused (`unknown_applied`), so a newer or foreign history is
 * never silently ignored. A baseline is never executed: when the stream has a
 * baseline the target lacks, the result is `baseline_missing`. An applied
 * migration whose dependency is not applied is an inconsistent history and is
 * refused (`dependency_missing`). Every dependency of a pending migration is
 * then applied or pending, and pending ones come earlier in the order.
 */
export function pendingOrder(
  graph: MigrationGraph,
  applied: ReadonlySet<string>,
): Result<readonly string[], PendingFailure> {
  const unknown = [...applied].filter((id) => !graph.has(id)).sort(compareIds)
  if (unknown.length > 0) {
    return err({ code: 'unknown_applied', ids: unknown })
  }
  for (const id of [...applied].sort(compareIds)) {
    const missing = graph.dependenciesOf(id).filter((d) => !applied.has(d))
    if (missing.length > 0) {
      return err({ code: 'dependency_missing', from: id, missing })
    }
  }
  const pending = new Set(graph.ids().filter((id) => !applied.has(id)))
  for (const id of [...pending].sort(compareIds)) {
    if (graph.isBaseline(id)) {
      return err({ code: 'baseline_missing', baseline: id })
    }
  }
  return ok(topologicalOrder(graph.nodeMap(), pending))
}

/**
 * The plan contents when the caller selects migrations: exactly the selected
 * ids plus their pending ancestors, in application order. Selecting never
 * pulls in unrelated migrations ([dependency-graph.md §4](../../../../exponetdb-docs/04-migrations/dependency-graph.md#4-ordering)).
 */
export function selectionOrder(
  graph: MigrationGraph,
  applied: ReadonlySet<string>,
  selected: readonly string[],
): Result<readonly string[], PendingFailure> {
  const all = pendingOrder(graph, applied)
  if (!all.ok) {
    return all
  }
  const unknown = selected.filter((id) => !graph.has(id)).sort(compareIds)
  if (unknown.length > 0) {
    return err({ code: 'unknown_selection', ids: unknown })
  }
  const pending = new Set(all.value)
  const wanted = new Set<string>()
  for (const id of selected) {
    if (!pending.has(id)) {
      continue
    }
    wanted.add(id)
    for (const a of graph.ancestors(id)) {
      if (pending.has(a)) {
        wanted.add(a)
      }
    }
  }
  return ok(all.value.filter((id) => wanted.has(id)))
}

/**
 * Checks that every dependency of each id in `order` is applied or earlier in
 * `order`. Callers that build an order from another source (for example a
 * stored plan) use it to refuse an order that would break a dependency.
 */
export function checkOrder(
  graph: MigrationGraph,
  applied: ReadonlySet<string>,
  order: readonly string[],
): Result<true, PendingFailure> {
  const done = new Set(applied)
  for (const id of order) {
    const missing = graph.dependenciesOf(id).filter((d) => !done.has(d))
    if (!graph.has(id)) {
      return err({ code: 'unknown_selection', ids: [id] })
    }
    if (missing.length > 0) {
      return err({ code: 'dependency_missing', from: id, missing })
    }
    done.add(id)
  }
  return ok(true)
}
