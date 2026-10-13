import { ExplainView } from '@exponetdb/ui-data'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'

const OBSERVED = minutesAgo(1)

function ready(plan: unknown) {
  return { state: 'ready' as const, value: plan, source: 'live' as const, observedAt: OBSERVED }
}

/** EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of a join of orders and customers. */
const ANALYZED: unknown = [
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Inner',
      'Startup Cost': 18.5,
      'Total Cost': 240.75,
      'Plan Rows': 600,
      'Actual Startup Time': 2.1,
      'Actual Total Time': 31.4,
      'Actual Rows': 8200,
      'Actual Loops': 1,
      'Hash Cond': '(o.customer_id = c.id)',
      'Shared Hit Blocks': 120,
      'Shared Read Blocks': 4,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Parent Relationship': 'Outer',
          'Relation Name': 'orders',
          Schema: 'public',
          Alias: 'o',
          'Startup Cost': 0,
          'Total Cost': 180,
          'Plan Rows': 600,
          'Actual Startup Time': 0.02,
          'Actual Total Time': 24,
          'Actual Rows': 8200,
          'Actual Loops': 1,
          Filter: "(status = 'open'::text)",
          'Rows Removed by Filter': 1800,
          'Shared Hit Blocks': 90,
          'Shared Read Blocks': 4,
        },
        {
          'Node Type': 'Hash',
          'Parent Relationship': 'Inner',
          'Startup Cost': 12,
          'Total Cost': 12,
          'Plan Rows': 400,
          'Actual Startup Time': 3,
          'Actual Total Time': 3,
          'Actual Rows': 400,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Parent Relationship': 'Outer',
              'Scan Direction': 'Forward',
              'Index Name': 'customers_pkey',
              'Relation Name': 'customers',
              Schema: 'public',
              Alias: 'c',
              'Startup Cost': 0.15,
              'Total Cost': 12,
              'Plan Rows': 400,
              'Actual Startup Time': 0.02,
              'Actual Total Time': 2.5,
              'Actual Rows': 400,
              'Actual Loops': 1,
              'Index Cond': '(id > 0)',
            },
          ],
        },
      ],
    },
    'Planning Time': 0.42,
    'Execution Time': 32.1,
  },
]

/** A plain EXPLAIN (FORMAT JSON): estimates only. */
const PLAIN: unknown = [
  {
    Plan: {
      'Node Type': 'Index Scan',
      'Scan Direction': 'Forward',
      'Index Name': 'orders_pkey',
      'Relation Name': 'orders',
      Schema: 'public',
      Alias: 'orders',
      'Startup Cost': 0.28,
      'Total Cost': 8.3,
      'Plan Rows': 1,
      'Index Cond': '(id = 42)',
    },
  },
]

/** A plan whose strings carry a direction override and a zero-width space. */
const HOSTILE: unknown = [
  {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'orders\u{202E}gnidrow',
      Schema: 'public',
      Alias: 'o',
      'Startup Cost': 0,
      'Total Cost': 20,
      'Plan Rows': 100,
      Filter: "(note = 'x\u{200B}y'::text)",
    },
  },
]

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/explain-view/analyzed',
    title:
      'EXPLAIN ANALYZE: a tree with the share of each node, the most expensive one named in words',
    render: () => <ExplainView plan={ready(ANALYZED)} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/explain-view/plain',
    title: 'A plain EXPLAIN: what the plan does not report is said, not drawn as zero',
    render: () => <ExplainView plan={ready(PLAIN)} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/explain-view/hostile',
    title: 'A plan with a hostile relation name and filter: shown as marked text',
    render: () => <ExplainView plan={ready(HOSTILE)} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/explain-view/not-a-plan',
    title: 'A result that is not a plan is a failed read with the reason',
    render: () => <ExplainView plan={ready({ rows: [] })} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/explain-view/failed',
    title: 'A failed read of the plan: the reason and a retry',
    render: () => (
      <ExplainView
        plan={{
          state: 'failed',
          error: {
            code: 'QUERY_TIMEOUT',
            message: 'The statement ran longer than the 30 second limit.',
          },
        }}
        onRetry={() => undefined}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
]
