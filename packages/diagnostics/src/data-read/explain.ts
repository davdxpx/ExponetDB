import type { JsonValue } from '@exponetdb/kernel'

/**
 * EXPLAIN output for callers ([sql-execution-security.md §3](../../../../exponetdb-docs/03-database-model/sql-execution-security.md#3-explain)):
 * the `FORMAT JSON` plan with the constants of its expressions replaced
 * (a filter can carry a value of a row: `email = 'x@y'`), and a summary
 * computed from the tree. Only expression members are rewritten; names
 * of nodes, relations and indexes stay (they are catalog data, labeled
 * untrusted by the contract).
 */
const EXPRESSION_KEYS: ReadonlySet<string> = new Set([
  'Filter',
  'Index Cond',
  'Recheck Cond',
  'Join Filter',
  'Hash Cond',
  'Merge Cond',
  'One-Time Filter',
  'TID Cond',
  'Run Condition',
  'Order By',
  'Cache Key',
  'Output',
  'Sort Key',
  'Presorted Key',
  'Group Key',
  'Hash Key',
  'Function Call',
  'Table Function Call',
  'Repeatable Seed',
  'Sampling Parameters',
])

/** Replaces string and number literals of one deparsed expression. */
export function redactExpression(expression: string): string {
  return expression
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/(?<![A-Za-z0-9_$."])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![A-Za-z0-9_$])/g, '?')
}

function redactNode(value: JsonValue, key: string | undefined): JsonValue {
  if (typeof value === 'string') {
    return key !== undefined && EXPRESSION_KEYS.has(key) ? redactExpression(value) : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactNode(v, key))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactNode(v, k)]))
  }
  return value
}

/** The plan with every expression's constants replaced. */
export function redactPlan(plan: JsonValue): JsonValue {
  return redactNode(plan, undefined)
}

export interface PlanSummary {
  readonly totalCost: number
  readonly planRows: number
  readonly actualRows: number | null
  readonly sequentialScans: string[]
  readonly misestimates: { node: string; estimated: number; actual: number }[]
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Cost and rows of the root, sequential scans and estimates off by ten times or more (ANALYZE). */
export function summarizePlan(output: JsonValue): PlanSummary | undefined {
  const first = Array.isArray(output) ? output[0] : undefined
  const root =
    first !== null && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, JsonValue>)['Plan']
      : undefined
  if (root === null || typeof root !== 'object' || Array.isArray(root) || root === undefined) {
    return undefined
  }
  const top = root as Record<string, JsonValue>
  const scans = new Set<string>()
  const misestimates: PlanSummary['misestimates'] = []
  const walk = (node: Record<string, JsonValue>) => {
    const type = typeof node['Node Type'] === 'string' ? (node['Node Type'] as string) : 'node'
    if (type === 'Seq Scan' && typeof node['Relation Name'] === 'string') {
      const schema = typeof node['Schema'] === 'string' ? `${node['Schema']}.` : ''
      scans.add(`${schema}${node['Relation Name']}`.slice(0, 127))
    }
    const estimated = num(node['Plan Rows'])
    const actual = num(node['Actual Rows'])
    if (
      estimated !== undefined &&
      actual !== undefined &&
      Math.max(estimated, actual) >= 10 * Math.max(1, Math.min(estimated, actual))
    ) {
      misestimates.push({ node: type.slice(0, 127), estimated, actual })
    }
    const children = node['Plans']
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c !== null && typeof c === 'object' && !Array.isArray(c)) {
          walk(c as Record<string, JsonValue>)
        }
      }
    }
  }
  walk(top)
  return {
    totalCost: num(top['Total Cost']) ?? 0,
    planRows: num(top['Plan Rows']) ?? 0,
    actualRows: num(top['Actual Rows']) ?? null,
    sequentialScans: [...scans].sort(),
    misestimates: misestimates.slice(0, 50),
  }
}
