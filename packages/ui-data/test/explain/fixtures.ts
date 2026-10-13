import type { Readable } from '@exponetdb/ui-patterns'

export const OBSERVED_AT = '2026-10-13T12:00:00.000Z'
export const NOW = '2026-10-13T12:05:00.000Z'

export function ready<T>(value: T): Readable<T> {
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED_AT }
}

/**
 * EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of a hash join. Own time per node:
 * Hash Join 3 ms, Seq Scan 12 ms, Hash 1 ms, Index Scan 4 ms (sum 20 ms), so
 * the Seq Scan on orders is the most expensive node with 60% of the whole.
 */
export function analyzedPlan(): unknown {
  return [
    {
      Plan: {
        'Node Type': 'Hash Join',
        'Join Type': 'Inner',
        'Startup Cost': 10.5,
        'Total Cost': 100,
        'Plan Rows': 500,
        'Plan Width': 8,
        'Actual Startup Time': 1.2,
        'Actual Total Time': 20,
        'Actual Rows': 480,
        'Actual Loops': 1,
        'Hash Cond': '(o.user_id = u.id)',
        'Shared Hit Blocks': 30,
        'Shared Read Blocks': 0,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Parent Relationship': 'Outer',
            'Relation Name': 'orders',
            Schema: 'public',
            Alias: 'o',
            'Startup Cost': 0,
            'Total Cost': 60,
            'Plan Rows': 500,
            'Actual Startup Time': 0.01,
            'Actual Total Time': 12,
            'Actual Rows': 480,
            'Actual Loops': 1,
            Filter: "(status = 'open'::text)",
            'Rows Removed by Filter': 20,
            'Shared Hit Blocks': 10,
            'Shared Read Blocks': 2,
          },
          {
            'Node Type': 'Hash',
            'Parent Relationship': 'Inner',
            'Startup Cost': 20,
            'Total Cost': 25,
            'Plan Rows': 100,
            'Actual Startup Time': 5,
            'Actual Total Time': 5,
            'Actual Rows': 100,
            'Actual Loops': 1,
            Plans: [
              {
                'Node Type': 'Index Scan',
                'Parent Relationship': 'Outer',
                'Scan Direction': 'Forward',
                'Index Name': 'users_pkey',
                'Relation Name': 'users',
                Schema: 'public',
                Alias: 'u',
                'Startup Cost': 0.1,
                'Total Cost': 20,
                'Plan Rows': 100,
                'Actual Startup Time': 0.02,
                'Actual Total Time': 4,
                'Actual Rows': 100,
                'Actual Loops': 1,
                'Index Cond': '(id > 0)',
              },
            ],
          },
        ],
      },
      'Planning Time': 0.2,
      'Execution Time': 21,
    },
  ]
}

/** EXPLAIN (FORMAT JSON) without ANALYZE: costs and estimated rows only. */
export function plainPlan(): unknown {
  return [
    {
      Plan: {
        'Node Type': 'Nested Loop',
        'Startup Cost': 0.5,
        'Total Cost': 80,
        'Plan Rows': 40,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'accounts',
            'Startup Cost': 0,
            'Total Cost': 30,
            'Plan Rows': 10,
          },
          {
            'Node Type': 'Index Scan',
            'Index Name': 'ledger_account_idx',
            'Relation Name': 'ledger',
            'Startup Cost': 0.5,
            'Total Cost': 4,
            'Plan Rows': 4,
          },
        ],
      },
    },
  ]
}
