/**
 * The model of an `EXPLAIN (FORMAT JSON)` result and the defensive reader that
 * builds it. This module is light: no React, no component library. The input is
 * `unknown` (the parsed JSON the server returns as data), narrowed by hand; a
 * field that is missing or has the wrong type is "not reported", never a guess,
 * and a result that is not a plan at all is a reason, not a crash (C-26, C-28).
 *
 * PostgreSQL returns `[ { "Plan": { ... }, "Planning Time": 0.1, ... } ]`; a
 * bare `{ "Plan": ... }` object and a bare plan node are read too.
 */

/** Most nodes a plan may have before it is refused (a runaway or hostile input must not freeze the page). */
export const MAX_EXPLAIN_NODES = 5_000
/** Deepest nesting of `Plans` before the plan is refused. */
export const MAX_EXPLAIN_DEPTH = 100

/** What a node may fail to report, in the words the view uses. */
export type ExplainFieldKey =
  | 'estimated rows'
  | 'cost'
  | 'actual rows'
  | 'loops'
  | 'time'
  | 'buffers'

/** Every field in the order the view names them. */
export const EXPLAIN_FIELDS: readonly ExplainFieldKey[] = [
  'estimated rows',
  'cost',
  'actual rows',
  'loops',
  'time',
  'buffers',
]

/** A labeled text from the plan: a condition, a key, an output list. Untrusted. */
export interface ExplainDetail {
  readonly label: string
  readonly text: string
}

/** A count of buffers, such as "shared hit" = 12. */
export interface ExplainFigure {
  readonly label: string
  readonly value: number
}

/** A row estimate that is far off the actual rows (per loop). */
export interface ExplainEstimateMiss {
  /** How many times too far off, at least 10. */
  readonly factor: number
  /** `low`: the planner expected fewer rows than there were. */
  readonly direction: 'low' | 'high'
}

export interface ExplainNode {
  /** The path of the node in the tree: `n` is the root, `n.0` its first child. Stable for one plan. */
  readonly id: string
  readonly depth: number
  readonly nodeType: string | null
  readonly relationName: string | null
  readonly schema: string | null
  readonly alias: string | null
  readonly indexName: string | null
  readonly joinType: string | null
  readonly strategy: string | null
  readonly scanDirection: string | null
  readonly subplanName: string | null
  readonly cteName: string | null
  readonly startupCost: number | null
  readonly totalCost: number | null
  readonly planRows: number | null
  readonly actualStartupTime: number | null
  readonly actualTotalTime: number | null
  readonly actualRows: number | null
  readonly actualLoops: number | null
  /** Buffer counts that were reported (all kinds), in a fixed order. */
  readonly buffers: readonly ExplainFigure[]
  /** Whether the node reported any buffer count at all (zero counts included). */
  readonly buffersReported: boolean
  /** Counts such as "Rows Removed by Filter", as `label` / formatted number pairs. */
  readonly counts: readonly ExplainFigure[]
  /** Conditions, keys and output lists. */
  readonly details: readonly ExplainDetail[]
  readonly children: readonly ExplainNode[]
  /**
   * Time spent in this node itself, in ms: its total time over all loops minus
   * that of its children. `null` unless this node and all its children
   * reported a total time.
   */
  readonly ownTime: number | null
  /** Cost of this node itself: its total cost minus that of its children. `null` unless all reported. */
  readonly ownCost: number | null
  readonly estimateMiss: ExplainEstimateMiss | null
}

export interface ExplainTrigger {
  readonly name: string | null
  readonly relation: string | null
  readonly time: number | null
  readonly calls: number | null
}

export interface ExplainPlan {
  readonly root: ExplainNode
  /** Every node in pre-order. */
  readonly nodes: readonly ExplainNode[]
  readonly planningTime: number | null
  readonly executionTime: number | null
  readonly triggers: readonly ExplainTrigger[]
  /** Plans after the first in the result; only the first is drawn. */
  readonly extraPlans: number
  /** Things in the plan that could not be read and were left out, in words. */
  readonly problems: readonly string[]
  /** Fields that no node reports (a plain EXPLAIN reports no actual rows, loops, time or buffers). */
  readonly notReportedAnywhere: readonly ExplainFieldKey[]
  /** Fields that some nodes report and this one does not. */
  readonly notReportedByNode: ReadonlyMap<string, readonly ExplainFieldKey[]>
  /** Every node reports its own time: bars can be drawn by time. */
  readonly timeAvailable: boolean
  /** Every node reports its own cost: bars can be drawn by cost. */
  readonly costAvailable: boolean
}

export type ExplainParseResult =
  | { readonly ok: true; readonly plan: ExplainPlan }
  | { readonly ok: false; readonly reason: string }

type JsonRecord = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own property; inherited names such as `__proto__` never count. */
function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function readString(record: JsonRecord, key: string): string | null {
  const value = own(record, key)
  return typeof value === 'string' ? value : null
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = own(record, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A string, or a list of strings joined by ", "; anything else is not a text. */
function readText(record: JsonRecord, key: string): string | null {
  const value = own(record, key)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string')
    return parts.length === 0 ? null : parts.join(', ')
  }
  return null
}

const DETAIL_KEYS: readonly (readonly [key: string, label: string])[] = [
  ['Index Cond', 'Index condition'],
  ['Recheck Cond', 'Recheck condition'],
  ['TID Cond', 'TID condition'],
  ['Filter', 'Filter'],
  ['Join Filter', 'Join filter'],
  ['Hash Cond', 'Hash condition'],
  ['Merge Cond', 'Merge condition'],
  ['Sort Key', 'Sort key'],
  ['Group Key', 'Group key'],
  ['Function Name', 'Function'],
  ['Sort Method', 'Sort method'],
  ['Output', 'Output'],
]

const COUNT_KEYS: readonly (readonly [key: string, label: string])[] = [
  ['Rows Removed by Filter', 'Rows removed by filter'],
  ['Rows Removed by Join Filter', 'Rows removed by join filter'],
  ['Rows Removed by Index Recheck', 'Rows removed by index recheck'],
  ['Heap Fetches', 'Heap fetches'],
  ['Workers Planned', 'Workers planned'],
  ['Workers Launched', 'Workers launched'],
]

const BUFFER_KEYS: readonly (readonly [key: string, label: string])[] = [
  ['Shared Hit Blocks', 'shared hit'],
  ['Shared Read Blocks', 'shared read'],
  ['Shared Dirtied Blocks', 'shared dirtied'],
  ['Shared Written Blocks', 'shared written'],
  ['Local Hit Blocks', 'local hit'],
  ['Local Read Blocks', 'local read'],
  ['Local Dirtied Blocks', 'local dirtied'],
  ['Local Written Blocks', 'local written'],
  ['Temp Read Blocks', 'temp read'],
  ['Temp Written Blocks', 'temp written'],
]

/** A limit of the reader was hit; the whole plan is refused with this reason. */
class ExplainLimitError extends Error {}

interface ReadState {
  count: number
  readonly problems: Set<string>
}

function totalTime(node: {
  actualTotalTime: number | null
  actualLoops: number | null
}): number | null {
  if (node.actualTotalTime === null) return null
  return node.actualTotalTime * (node.actualLoops ?? 1)
}

function ownOf(
  total: number | null,
  children: readonly ExplainNode[],
  childTotal: (child: ExplainNode) => number | null,
): number | null {
  if (total === null) return null
  let spent = 0
  for (const child of children) {
    const value = childTotal(child)
    if (value === null) return null
    spent += value
  }
  // Workers, loops and sub-plans can make the children add up to more than the parent.
  return Math.max(0, total - spent)
}

function estimateMissOf(planRows: number | null, actualRows: number | null, loops: number | null) {
  if (planRows === null || actualRows === null || loops === 0) return null
  const expected = Math.max(planRows, 1)
  const found = Math.max(actualRows, 1)
  const factor = Math.max(expected / found, found / expected)
  if (factor < 10) return null
  return { factor: Math.round(factor), direction: found > expected ? 'low' : 'high' } as const
}

function readNode(raw: JsonRecord, id: string, depth: number, state: ReadState): ExplainNode {
  if (depth > MAX_EXPLAIN_DEPTH) {
    throw new ExplainLimitError(`The plan is nested deeper than ${MAX_EXPLAIN_DEPTH} levels.`)
  }
  state.count += 1
  if (state.count > MAX_EXPLAIN_NODES) {
    throw new ExplainLimitError(
      `The plan has more than ${MAX_EXPLAIN_NODES.toLocaleString('en-US')} nodes.`,
    )
  }

  const children: ExplainNode[] = []
  const rawPlans = own(raw, 'Plans')
  if (rawPlans !== undefined) {
    if (Array.isArray(rawPlans)) {
      let skipped = 0
      for (const [index, child] of rawPlans.entries()) {
        if (isRecord(child)) children.push(readNode(child, `${id}.${index}`, depth + 1, state))
        else skipped += 1
      }
      if (skipped > 0) {
        state.problems.add(
          `${skipped} sub-plan ${skipped === 1 ? 'entry was' : 'entries were'} not plan nodes and ${skipped === 1 ? 'is' : 'are'} not shown.`,
        )
      }
    } else {
      state.problems.add(
        'A node lists its sub-plans in a form that is not an array; they are not shown.',
      )
    }
  }

  const buffers: ExplainFigure[] = []
  for (const [key, label] of BUFFER_KEYS) {
    const value = readNumber(raw, key)
    if (value !== null) buffers.push({ label, value })
  }
  const counts: ExplainFigure[] = []
  for (const [key, label] of COUNT_KEYS) {
    const value = readNumber(raw, key)
    if (value !== null) counts.push({ label, value })
  }
  const details: ExplainDetail[] = []
  for (const [key, label] of DETAIL_KEYS) {
    const text = readText(raw, key)
    if (text !== null) details.push({ label, text })
  }

  const actualTotalTime = readNumber(raw, 'Actual Total Time')
  const actualLoops = readNumber(raw, 'Actual Loops')
  const totalCost = readNumber(raw, 'Total Cost')
  const planRows = readNumber(raw, 'Plan Rows')
  const actualRows = readNumber(raw, 'Actual Rows')

  return {
    id,
    depth,
    nodeType: readString(raw, 'Node Type'),
    relationName: readString(raw, 'Relation Name'),
    schema: readString(raw, 'Schema'),
    alias: readString(raw, 'Alias'),
    indexName: readString(raw, 'Index Name'),
    joinType: readString(raw, 'Join Type'),
    strategy: readString(raw, 'Strategy'),
    scanDirection: readString(raw, 'Scan Direction'),
    subplanName: readString(raw, 'Subplan Name'),
    cteName: readString(raw, 'CTE Name'),
    startupCost: readNumber(raw, 'Startup Cost'),
    totalCost,
    planRows,
    actualStartupTime: readNumber(raw, 'Actual Startup Time'),
    actualTotalTime,
    actualRows,
    actualLoops,
    buffers,
    buffersReported: buffers.length > 0,
    counts,
    details,
    children,
    ownTime: ownOf(totalTime({ actualTotalTime, actualLoops }), children, totalTime),
    ownCost: ownOf(totalCost, children, (child) => child.totalCost),
    estimateMiss: estimateMissOf(planRows, actualRows, actualLoops),
  }
}

function flatten(root: ExplainNode): ExplainNode[] {
  const out: ExplainNode[] = []
  const stack: ExplainNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    out.push(node)
    // Reversed, so the first child is visited first (pre-order).
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

function reports(node: ExplainNode, field: ExplainFieldKey): boolean {
  switch (field) {
    case 'estimated rows':
      return node.planRows !== null
    case 'cost':
      return node.totalCost !== null
    case 'actual rows':
      return node.actualRows !== null
    case 'loops':
      return node.actualLoops !== null
    case 'time':
      return node.actualTotalTime !== null
    case 'buffers':
      return node.buffersReported
  }
}

function readTrigger(raw: unknown): ExplainTrigger | null {
  if (!isRecord(raw)) return null
  return {
    name: readString(raw, 'Trigger Name'),
    relation: readString(raw, 'Relation'),
    time: readNumber(raw, 'Time'),
    calls: readNumber(raw, 'Calls'),
  }
}

/**
 * Reads the JSON a server returned for `EXPLAIN (FORMAT JSON)`. Never throws:
 * input that is not a plan, or is larger than the limits, comes back as
 * `{ ok: false, reason }` with a reason a person can act on (the reason never
 * quotes the input).
 */
export function parseExplainPlan(input: unknown): ExplainParseResult {
  const entries: readonly unknown[] = Array.isArray(input) ? input : [input]
  if (entries.length === 0) {
    return {
      ok: false,
      reason: 'The result is an empty list; EXPLAIN (FORMAT JSON) returns one plan.',
    }
  }
  const first = entries[0]
  if (!isRecord(first)) {
    return {
      ok: false,
      reason: 'The result is not an EXPLAIN (FORMAT JSON) plan: the first entry is not an object.',
    }
  }
  const rawRoot = own(first, 'Plan')
  const rootRecord = isRecord(rawRoot)
    ? rawRoot
    : readString(first, 'Node Type') !== null
      ? first
      : null
  if (rootRecord === null) {
    return {
      ok: false,
      reason: 'The result is not an EXPLAIN (FORMAT JSON) plan: it has no "Plan" object.',
    }
  }

  const state: ReadState = { count: 0, problems: new Set() }
  let root: ExplainNode
  try {
    root = readNode(rootRecord, 'n', 0, state)
  } catch (error) {
    if (error instanceof ExplainLimitError) {
      return { ok: false, reason: `${error.message} It is not shown; open the raw JSON instead.` }
    }
    return { ok: false, reason: 'The plan could not be read.' }
  }

  const nodes = flatten(root)
  const notReportedAnywhere = EXPLAIN_FIELDS.filter((field) =>
    nodes.every((node) => !reports(node, field)),
  )
  const notReportedByNode = new Map<string, readonly ExplainFieldKey[]>()
  for (const node of nodes) {
    const missing = EXPLAIN_FIELDS.filter(
      (field) => !notReportedAnywhere.includes(field) && !reports(node, field),
    )
    if (missing.length > 0) notReportedByNode.set(node.id, missing)
  }

  const rawTriggers = own(first, 'Triggers')
  const triggers: ExplainTrigger[] = []
  if (Array.isArray(rawTriggers)) {
    for (const raw of rawTriggers) {
      const trigger = readTrigger(raw)
      if (trigger !== null) triggers.push(trigger)
    }
  }

  return {
    ok: true,
    plan: {
      root,
      nodes,
      planningTime: readNumber(first, 'Planning Time'),
      executionTime: readNumber(first, 'Execution Time'),
      triggers,
      extraPlans: Math.max(0, entries.length - 1),
      problems: [...state.problems],
      notReportedAnywhere,
      notReportedByNode,
      timeAvailable: nodes.every((node) => node.ownTime !== null),
      costAvailable: nodes.every((node) => node.ownCost !== null),
    },
  }
}

/** What bars measure. */
export type ExplainBasis = 'time' | 'cost'

export interface ExplainShares {
  readonly basis: ExplainBasis
  /** The sum of the own values of all nodes: the whole the shares are parts of. */
  readonly total: number
  /** Each node's share of the whole, 0 to 1, by node id. */
  readonly byNode: ReadonlyMap<string, number>
  /** The node with the largest own value, or `null` when no node has a positive one. */
  readonly hottestId: string | null
}

function ownValue(node: ExplainNode, basis: ExplainBasis): number {
  return (basis === 'time' ? node.ownTime : node.ownCost) ?? 0
}

/**
 * Each node's share of the plan by own time or own cost. Shares add up to 1, so
 * they are parts of one whole; the first node in pre-order wins a tie.
 */
export function explainShares(plan: ExplainPlan, basis: ExplainBasis): ExplainShares {
  let total = 0
  for (const node of plan.nodes) total += ownValue(node, basis)
  const byNode = new Map<string, number>()
  let hottestId: string | null = null
  let hottest = 0
  for (const node of plan.nodes) {
    const value = ownValue(node, basis)
    byNode.set(node.id, total > 0 ? value / total : 0)
    if (value > hottest) {
      hottest = value
      hottestId = node.id
    }
  }
  return { basis, total, byNode, hottestId }
}

/** The basis a plan is drawn by unless the person chooses: time when every node has it, else cost, else none. */
export function defaultExplainBasis(plan: ExplainPlan): ExplainBasis | null {
  if (plan.timeAvailable) return 'time'
  if (plan.costAvailable) return 'cost'
  return null
}
