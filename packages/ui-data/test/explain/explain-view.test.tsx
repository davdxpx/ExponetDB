import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExplainView } from '../../src/explain/explain-view.tsx'
import { axeViolations } from '../support/axe.ts'
import { analyzedPlan, NOW, OBSERVED_AT, plainPlan, ready } from './fixtures.ts'

afterEach(cleanup)

function renderView(
  plan: Readable<unknown>,
  props: Partial<Parameters<typeof ExplainView>[0]> = {},
) {
  return render(
    <TooltipProvider>
      <ExplainView plan={plan} now={NOW} {...props} />
    </TooltipProvider>,
  )
}

function nodeBox(container: HTMLElement, id: string): HTMLElement {
  const box = container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
  if (box === null) throw new Error(`no node ${id}`)
  return box
}

describe('ExplainView', () => {
  it('draws the nodes with their relation, index, join type, rows, loops, cost and time', () => {
    const { container } = renderView(ready(analyzedPlan()))

    const list = screen.getByRole('list', { name: 'Plan nodes' })
    expect(within(list).getByText('Hash Join')).toBeInTheDocument()
    expect(within(list).getByText('Seq Scan')).toBeInTheDocument()
    expect(within(list).getByText('Index Scan')).toBeInTheDocument()
    expect(within(list).getByText('orders')).toBeInTheDocument()
    expect(within(list).getByText('users_pkey')).toBeInTheDocument()
    expect(within(list).getByText('Inner')).toBeInTheDocument()

    const seqScan = nodeBox(container, 'n.0')
    expect(seqScan).toHaveTextContent('Estimated rows500')
    expect(seqScan).toHaveTextContent('Actual rows480')
    expect(seqScan).toHaveTextContent('Loops1')
    expect(seqScan).toHaveTextContent('Cost (startup..total)0.00..60.00')
    expect(seqScan).toHaveTextContent('Time (startup..total)0.01..12 ms')
    expect(seqScan).toHaveTextContent('Own time12 ms')
    expect(seqScan).toHaveTextContent('Rows removed by filter20')
    expect(seqScan).toHaveTextContent('Buffersshared hit=10, shared read=2')
    expect(seqScan).toHaveTextContent("Filter(status = 'open'::text)")

    expect(screen.getByText('Planning time').nextSibling).toHaveTextContent('0.2 ms')
    expect(screen.getByText('Execution time').nextSibling).toHaveTextContent('21 ms')
    expect(screen.getByText('Plan nodes').nextSibling).toHaveTextContent('4')
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('marks the most expensive node in words and sizes the bars by share', () => {
    const { container } = renderView(ready(analyzedPlan()))

    const marks = screen.getAllByText('Most expensive')
    expect(marks).toHaveLength(1)
    const hot = nodeBox(container, 'n.0')
    expect(hot).toHaveAttribute('data-hottest', 'true')
    expect(within(hot).getByText('Most expensive')).toBeInTheDocument()
    expect(hot).toHaveTextContent("60% of the plan's own time")

    const bar = hot.querySelector<HTMLElement>('[style]')
    expect(bar?.style.width).toBe('60%')
    const other = nodeBox(container, 'n').querySelector<HTMLElement>('[style]')
    expect(other?.style.width).toBe('15%')
    // The bars are decoration: the share is in the text next to them.
    expect(bar?.parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('flags a row estimate that is far off, in words', () => {
    const plan = [
      {
        Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 10, 'Actual Rows': 5000, 'Actual Loops': 2 },
      },
    ]
    renderView(ready(plan))
    expect(screen.getByText('Row estimate is 500x too low.')).toBeInTheDocument()
    expect(screen.getByText('5,000 per loop')).toBeInTheDocument()
  })

  it('says "Never executed" for a node that ran zero times', () => {
    renderView(
      ready([
        {
          Plan: {
            'Node Type': 'Append',
            'Actual Total Time': 1,
            'Actual Loops': 1,
            Plans: [{ 'Node Type': 'Seq Scan', 'Actual Total Time': 0, 'Actual Loops': 0 }],
          },
        },
      ]),
    )
    expect(screen.getByText('Never executed')).toBeInTheDocument()
  })

  it('draws a plain EXPLAIN by cost and says that actual figures are not reported', () => {
    const { container } = renderView(ready(plainPlan()))

    expect(
      screen.getByText(
        'Not reported: actual rows, loops, time, buffers. Run EXPLAIN with ANALYZE to see actual rows and time.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Planning time').nextSibling).toHaveTextContent('not reported')
    expect(screen.getByText('Execution time').nextSibling).toHaveTextContent('not reported')
    expect(screen.getByText(/Bars show each node's own cost/)).toBeInTheDocument()
    expect(nodeBox(container, 'n')).toHaveTextContent("of the plan's own cost")
    expect(nodeBox(container, 'n')).toHaveAttribute('data-hottest', 'true')
    expect(nodeBox(container, 'n')).not.toHaveTextContent('Actual rows')
  })

  it('names a field that only some nodes lack, on that node', () => {
    const { container } = renderView(
      ready([
        {
          Plan: {
            'Node Type': 'Append',
            'Total Cost': 10,
            'Plan Rows': 5,
            Plans: [{ 'Node Type': 'Seq Scan', 'Total Cost': 4 }],
          },
        },
      ]),
    )
    expect(nodeBox(container, 'n.0')).toHaveTextContent('Not reported: estimated rows.')
    expect(nodeBox(container, 'n')).not.toHaveTextContent('Not reported: estimated rows.')
  })

  it('offers a choice of bars when both time and cost are reported', async () => {
    const user = userEvent.setup()
    const { container } = renderView(ready(analyzedPlan()))

    const group = screen.getByRole('group', { name: 'Bars show' })
    const time = within(group).getByRole('button', { name: 'Time' })
    const cost = within(group).getByRole('button', { name: 'Cost' })
    expect(time).toHaveAttribute('aria-pressed', 'true')
    expect(cost).toHaveAttribute('aria-pressed', 'false')

    await user.click(cost)
    expect(cost).toHaveAttribute('aria-pressed', 'true')
    // Own cost: Hash Join 100 - 60 - 25 = 15; Seq Scan 60; Hash 25 - 20 = 5; Index Scan 20.
    expect(nodeBox(container, 'n.0')).toHaveTextContent("60% of the plan's own cost")
    expect(nodeBox(container, 'n.1.0')).toHaveTextContent("20% of the plan's own cost")
  })

  it('folds and unfolds subtrees with a named, stateful button', async () => {
    const user = userEvent.setup()
    renderView(ready(analyzedPlan()))

    expect(screen.getByText('Index Scan')).toBeInTheDocument()
    const hashToggle = screen.getByRole('button', { name: 'Hash' })
    expect(hashToggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(hashToggle)
    expect(hashToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Index Scan')).toBeNull()

    await user.click(hashToggle)
    expect(screen.getByText('Index Scan')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('Seq Scan')).toBeNull()
    expect(screen.getByRole('button', { name: /^Hash Join/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await user.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByText('Index Scan')).toBeInTheDocument()
  })

  it('keeps the folds and the choice of bars when you visit the raw JSON tab and come back', async () => {
    const user = userEvent.setup()
    renderView(ready(analyzedPlan()))
    await user.click(screen.getByRole('button', { name: 'Cost' }))
    await user.click(screen.getByRole('button', { name: 'Hash' }))
    expect(screen.queryByText('Index Scan')).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(screen.queryByRole('list', { name: 'Plan nodes' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Plan' }))

    expect(screen.queryByText('Index Scan')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hash' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Cost' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('folds the deep parts of a large plan at first and keeps the way to the hottest node open', () => {
    const slow = { 'Node Type': 'Seq Scan', 'Total Cost': 1000 }
    const chain = (cost: number) => ({
      'Node Type': 'Sort',
      'Total Cost': cost + 1,
      Plans: [
        {
          'Node Type': 'Limit',
          'Total Cost': cost,
          Plans: [{ 'Node Type': 'Result', 'Total Cost': cost - 1 }],
        },
      ],
    })
    const middle = Array.from({ length: 10 }, (_, index) => ({
      'Node Type': 'Append',
      'Total Cost': 5000,
      Plans: Array.from({ length: 10 }, (_, leaf) => ({
        'Node Type': 'Subquery Scan',
        'Total Cost': 40,
        Plans: [index === 3 && leaf === 4 ? { ...slow, Plans: [chain(900)] } : chain(30)],
      })),
    }))
    const plan = [{ Plan: { 'Node Type': 'Gather', 'Total Cost': 90000, Plans: middle } }]
    const { container } = renderView(ready(plan))

    expect(container.querySelectorAll('[data-node-id]').length).toBeGreaterThan(100)
    // Depth 3 nodes with children are folded, except on the way to the hottest node.
    const folded = container.querySelectorAll('button[aria-expanded="false"]')
    expect(folded.length).toBeGreaterThan(50)
    expect(container.querySelector('[data-hottest="true"]')).not.toBeNull()
  })

  it('shows every string of the plan as untrusted text', () => {
    const hostile = [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'a\u{202E}b<img src=x onerror=alert(1)>',
          Schema: '<script>alert(1)</script>',
          Alias: 'zero\u{200B}width',
          Filter: "(x = 'a\u{202E}')\n<b>bold</b> OR true",
          Output: ['<i>col</i>'],
          'Total Cost': 5,
        },
      },
    ]
    const { container } = renderView(ready(hostile))

    expect(container.querySelector('img, script, b, i')).toBeNull()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    // The direction override and the zero-width space are shown by code point, not applied.
    expect(container.querySelectorAll('[data-code-point="U+202E"]').length).toBeGreaterThanOrEqual(
      2,
    )
    expect(container.querySelector('[data-code-point="U+200B"]')).not.toBeNull()
    expect(screen.getAllByText('⟨U+202E⟩').length).toBeGreaterThanOrEqual(2)
    for (const element of container.querySelectorAll('[data-untrusted]')) {
      expect(element.querySelector('[dir="ltr"]')).not.toBeNull()
    }
    expect(screen.getByText('<i>col</i>')).toBeInTheDocument()
  })

  it('cuts a very long condition and shows the rest only on request', async () => {
    const user = userEvent.setup()
    const long = `(${'a = 1 AND '.repeat(200)}true)`
    renderView(ready([{ Plan: { 'Node Type': 'Seq Scan', Filter: long, 'Total Cost': 1 } }]))

    const showAll = screen.getByRole('button', { name: /Show all .* of filter/ })
    expect(screen.queryByText(long)).toBeNull()
    await user.click(showAll)
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('shows the JSON, pretty-printed as text, on its own tab', async () => {
    const user = userEvent.setup()
    renderView(
      ready([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': '<b>x</b>', 'Total Cost': 5 } }]),
    )

    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText(/"Node Type"/)).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Raw JSON' }))

    const panel = screen.getByRole('tabpanel', { name: 'Raw JSON' })
    expect(panel).toHaveTextContent('[ { "Plan": {')
    expect(panel.textContent).toContain('  {\n    "Plan": {\n      "Node Type": "Seq Scan",')
    expect(panel.textContent).toContain('"Relation Name": "<b>x</b>"')
    expect(panel.querySelector('b')).toBeNull()
  })

  it('shows direction characters of the raw JSON by code point', async () => {
    const user = userEvent.setup()
    renderView(ready([{ Plan: { 'Node Type': 'Seq Scan', Alias: 'a\u{202E}b' } }]))
    await user.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    const panel = screen.getByRole('tabpanel', { name: 'Raw JSON' })
    expect(panel.querySelector('[data-code-point="U+202E"]')).not.toBeNull()
  })

  it('says so when the value cannot be written as JSON', async () => {
    const user = userEvent.setup()
    const looped: { Plan: unknown; self?: unknown } = { Plan: { 'Node Type': 'Result' } }
    looped.self = looped
    renderView(ready([looped]))
    await user.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(screen.getByText('The plan cannot be written as JSON.')).toBeInTheDocument()
  })

  it.each([
    ['text', 'SELECT 1'],
    ['null', null],
    ['an empty list', []],
    ['an object without a plan', { rows: [] }],
    ['a plan that is a string', [{ Plan: 'x' }]],
  ])('shows a failed read with the reason for %s, never an empty plan', (_name, value) => {
    renderView(ready(value))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read query plan')
    expect(screen.getByText('INVALID_PLAN')).toBeInTheDocument()
    expect(screen.getByText(/This does not mean there is no query plan\./)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('EXPLAIN (FORMAT JSON)')
    expect(screen.queryByText('Nothing to show')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('shows a failed read for a plan beyond the limits', () => {
    const children = Array.from({ length: 5_000 }, () => ({ 'Node Type': 'Result' }))
    renderView(ready([{ Plan: { 'Node Type': 'Append', Plans: children } }]))
    expect(screen.getByRole('alert')).toHaveTextContent('more than 5,000 nodes')
  })

  it('renders the states of a read truthfully', () => {
    const failure = { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' }
    const { rerender } = renderView({ state: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading query plan')

    const wrap = (plan: Readable<unknown>) => (
      <TooltipProvider>
        <ExplainView plan={plan} now={NOW} />
      </TooltipProvider>
    )
    rerender(wrap({ state: 'failed', error: failure }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read query plan')
    expect(screen.getByRole('alert')).toHaveTextContent('TARGET_UNREACHABLE')
    expect(screen.queryByRole('list', { name: 'Plan nodes' })).toBeNull()

    rerender(
      wrap({
        state: 'stale',
        value: plainPlan(),
        source: 'cached',
        observedAt: OBSERVED_AT,
        error: failure,
      }),
    )
    expect(screen.getByText('Showing an earlier read of query plan')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Plan nodes' })).toBeInTheDocument()

    rerender(
      wrap({
        state: 'partial',
        value: plainPlan(),
        source: 'agent_reported',
        observedAt: OBSERVED_AT,
        missing: ['The execution statistics.'],
      }),
    )
    expect(screen.getByText('Showing part of query plan')).toBeInTheDocument()
    expect(screen.getByText('The execution statistics.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Plan nodes' })).toBeInTheDocument()
  })

  it('starts from the defaults of a new plan when the plan changes', async () => {
    const user = userEvent.setup()
    const { rerender } = renderView(ready(analyzedPlan()))
    await user.click(screen.getByRole('button', { name: 'Hash' }))
    expect(screen.queryByText('Index Scan')).toBeNull()

    rerender(
      <TooltipProvider>
        <ExplainView plan={ready(analyzedPlan())} now={NOW} />
      </TooltipProvider>,
    )
    expect(screen.getByText('Index Scan')).toBeInTheDocument()
  })

  it('puts the class name of the caller on the view in every state', () => {
    const { container, rerender } = renderView(ready(plainPlan()), { className: 'caller-class' })
    expect(container.querySelector('.caller-class')).not.toBeNull()
    rerender(
      <TooltipProvider>
        <ExplainView plan={{ state: 'loading' }} now={NOW} className="caller-class" />
      </TooltipProvider>,
    )
    expect(container.querySelector('.caller-class')).not.toBeNull()
  })

  it('calls the retry of a failed read', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderView({ state: 'failed', error: { code: 'NETWORK', message: 'No answer.' } }, { onRetry })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations in any state', async () => {
    const { container, rerender } = renderView(ready(analyzedPlan()))
    expect(await axeViolations(container)).toEqual([])

    rerender(
      <TooltipProvider>
        <ExplainView plan={ready(plainPlan())} now={NOW} />
      </TooltipProvider>,
    )
    expect(await axeViolations(container)).toEqual([])

    rerender(
      <TooltipProvider>
        <ExplainView plan={ready('nope')} now={NOW} />
      </TooltipProvider>,
    )
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no accessibility violations on the raw JSON tab or with folded subtrees', async () => {
    const user = userEvent.setup()
    const { container } = renderView(ready(analyzedPlan()))
    await user.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(await axeViolations(container)).toEqual([])
    await user.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(await axeViolations(container)).toEqual([])
  })
})
