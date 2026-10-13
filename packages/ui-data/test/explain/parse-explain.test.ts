import { describe, expect, it } from 'vitest'

import {
  defaultExplainBasis,
  explainShares,
  MAX_EXPLAIN_DEPTH,
  MAX_EXPLAIN_NODES,
  parseExplainPlan,
} from '../../src/explain/parse-explain.ts'
import { analyzedPlan, plainPlan } from './fixtures.ts'

function parsed(input: unknown) {
  const result = parseExplainPlan(input)
  if (!result.ok) throw new Error(`expected a plan, got: ${result.reason}`)
  return result.plan
}

describe('parseExplainPlan', () => {
  it('reads the nodes of an analyzed plan in pre-order with their facts', () => {
    const plan = parsed(analyzedPlan())
    expect(plan.nodes.map((node) => node.nodeType)).toEqual([
      'Hash Join',
      'Seq Scan',
      'Hash',
      'Index Scan',
    ])
    expect(plan.nodes.map((node) => node.id)).toEqual(['n', 'n.0', 'n.1', 'n.1.0'])
    expect(plan.planningTime).toBe(0.2)
    expect(plan.executionTime).toBe(21)
    const seqScan = plan.nodes[1]
    expect(seqScan).toMatchObject({
      relationName: 'orders',
      schema: 'public',
      alias: 'o',
      actualRows: 480,
      actualLoops: 1,
    })
    expect(seqScan?.counts).toEqual([{ label: 'Rows removed by filter', value: 20 }])
    expect(seqScan?.details).toEqual([{ label: 'Filter', text: "(status = 'open'::text)" }])
    expect(plan.notReportedAnywhere).toEqual([])
  })

  it('computes the own time of a node from its children and the loops', () => {
    const plan = parsed(analyzedPlan())
    expect(plan.nodes.map((node) => node.ownTime)).toEqual([3, 12, 1, 4])
    expect(plan.timeAvailable).toBe(true)
    const shares = explainShares(plan, 'time')
    expect(shares.total).toBe(20)
    expect(shares.hottestId).toBe('n.0')
    expect(shares.byNode.get('n.0')).toBeCloseTo(0.6)
    let sum = 0
    for (const share of shares.byNode.values()) sum += share
    expect(sum).toBeCloseTo(1)
  })

  it('multiplies by the loops of a node and never reports a negative own time', () => {
    const plan = parsed([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Actual Total Time': 5,
          'Actual Loops': 1,
          Plans: [
            { 'Node Type': 'Index Scan', 'Actual Total Time': 0.5, 'Actual Loops': 20 },
            { 'Node Type': 'Seq Scan', 'Actual Total Time': 1, 'Actual Loops': 1 },
          ],
        },
      },
    ])
    // 5 - (0.5 * 20 + 1) < 0: clamped
    expect(plan.root.ownTime).toBe(0)
    expect(plan.nodes[1]?.ownTime).toBe(10)
  })

  it('draws a plain EXPLAIN by cost and says what no node reports', () => {
    const plan = parsed(plainPlan())
    expect(plan.timeAvailable).toBe(false)
    expect(plan.costAvailable).toBe(true)
    expect(defaultExplainBasis(plan)).toBe('cost')
    expect(plan.notReportedAnywhere).toEqual(['actual rows', 'loops', 'time', 'buffers'])
    expect(plan.notReportedByNode.size).toBe(0)
    expect(explainShares(plan, 'cost').hottestId).toBe('n')
  })

  it('names a field one node lacks while the others report it', () => {
    const plan = parsed([
      {
        Plan: {
          'Node Type': 'Append',
          'Total Cost': 10,
          'Plan Rows': 5,
          Plans: [{ 'Node Type': 'Seq Scan', 'Total Cost': 4 }],
        },
      },
    ])
    expect(plan.notReportedByNode.get('n.0')).toEqual(['estimated rows'])
    expect(plan.notReportedByNode.has('n')).toBe(false)
  })

  it('has no basis when neither time nor cost is reported for every node', () => {
    const plan = parsed([{ Plan: { 'Node Type': 'Result' } }])
    expect(defaultExplainBasis(plan)).toBeNull()
    expect(explainShares(plan, 'cost').hottestId).toBeNull()
  })

  it('flags a row estimate that is off by ten times or more', () => {
    const plan = parsed([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Plan Rows': 10,
          'Actual Rows': 5000,
          'Actual Loops': 1,
        },
      },
    ])
    expect(plan.root.estimateMiss).toEqual({ factor: 500, direction: 'low' })
    const close = parsed([
      { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 10, 'Actual Rows': 50 } },
    ])
    expect(close.root.estimateMiss).toBeNull()
    const high = parsed([
      { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1000, 'Actual Rows': 0 } },
    ])
    expect(high.root.estimateMiss).toEqual({ factor: 1000, direction: 'high' })
    const never = parsed([
      { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1000, 'Actual Rows': 0, 'Actual Loops': 0 } },
    ])
    expect(never.root.estimateMiss).toBeNull()
  })

  it('accepts a bare plan object and a bare node, and counts further plans', () => {
    expect(parsed({ Plan: { 'Node Type': 'Result' } }).root.nodeType).toBe('Result')
    expect(parsed({ 'Node Type': 'Result' }).root.nodeType).toBe('Result')
    const two = parsed([{ Plan: { 'Node Type': 'Result' } }, { Plan: { 'Node Type': 'Other' } }])
    expect(two.extraPlans).toBe(1)
    expect(two.root.nodeType).toBe('Result')
  })

  it('treats a field of the wrong type as not reported', () => {
    const plan = parsed([
      {
        Plan: {
          'Node Type': 7,
          'Relation Name': { name: 'x' },
          'Total Cost': '12',
          'Plan Rows': Number.NaN,
          'Actual Rows': null,
          Filter: ['a', 3, 'b'],
          'Index Cond': 12,
        },
      },
    ])
    expect(plan.root).toMatchObject({
      nodeType: null,
      relationName: null,
      totalCost: null,
      planRows: null,
      actualRows: null,
    })
    expect(plan.root.details).toEqual([{ label: 'Filter', text: 'a, b' }])
  })

  it('reports sub-plans it could not read instead of dropping them silently', () => {
    const plan = parsed([
      { Plan: { 'Node Type': 'Append', Plans: [{ 'Node Type': 'Seq Scan' }, 'oops', 4] } },
    ])
    expect(plan.nodes).toHaveLength(2)
    expect(plan.problems).toEqual(['2 sub-plan entries were not plan nodes and are not shown.'])
    const notArray = parsed([{ Plan: { 'Node Type': 'Append', Plans: { x: 1 } } }])
    expect(notArray.problems).toEqual([
      'A node lists its sub-plans in a form that is not an array; they are not shown.',
    ])
  })

  it('reads triggers and ignores entries that are not objects', () => {
    const plan = parsed([
      {
        Plan: { 'Node Type': 'Result' },
        Triggers: [{ 'Trigger Name': 't1', Relation: 'orders', Time: 1.5, Calls: 3 }, 'x'],
      },
    ])
    expect(plan.triggers).toEqual([{ name: 't1', relation: 'orders', time: 1.5, calls: 3 }])
  })

  it('does not read inherited properties', () => {
    const polluted = JSON.parse('{"Plan":{"Node Type":"Result","__proto__":{"Plans":[1]}}}')
    expect(parsed(polluted).problems).toEqual([])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a plan'],
    ['a number', 7],
    ['an empty array', []],
    ['an array of strings', ['x']],
    ['an object without a plan', { 'Planning Time': 1 }],
    ['a plan that is not an object', { Plan: 'x' }],
    ['a plan that is an array', { Plan: [] }],
  ])('refuses %s with a reason', (_name, input) => {
    const result = parseExplainPlan(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(10)
      expect(result.reason).toMatch(/EXPLAIN|result/i)
    }
  })

  it('does not quote the input in a reason', () => {
    const result = parseExplainPlan('<img src=x onerror=alert(1)>')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).not.toContain('img')
  })

  it('refuses a plan nested deeper than the limit', () => {
    let node: Record<string, unknown> = { 'Node Type': 'Result' }
    for (let level = 0; level < MAX_EXPLAIN_DEPTH + 1; level += 1) {
      node = { 'Node Type': 'Limit', Plans: [node] }
    }
    const result = parseExplainPlan([{ Plan: node }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('deeper than')
  })

  it('refuses a plan with more nodes than the limit', () => {
    const children = Array.from({ length: MAX_EXPLAIN_NODES }, () => ({ 'Node Type': 'Result' }))
    const result = parseExplainPlan([{ Plan: { 'Node Type': 'Append', Plans: children } }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('more than 5,000 nodes')
    const fits = Array.from({ length: MAX_EXPLAIN_NODES - 1 }, () => ({ 'Node Type': 'Result' }))
    expect(parseExplainPlan([{ Plan: { 'Node Type': 'Append', Plans: fits } }]).ok).toBe(true)
  })
})
