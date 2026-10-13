import type { CellValue, GridColumn, GridSort } from '@exponetdb/ui-data'
import { DataGrid } from '@exponetdb/ui-data/grid/data-grid'
import { type ReactNode, useMemo, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'

type Rows = readonly (readonly CellValue[])[]

const OBSERVED = minutesAgo(2)

const COLUMNS: readonly GridColumn[] = [
  { name: 'id', type: 'int8' },
  { name: 'customer', type: 'text' },
  { name: 'status', type: 'text' },
  { name: 'total', type: 'numeric' },
  { name: 'placed_at', type: 'timestamptz' },
  { name: 'details', type: 'jsonb' },
  { name: 'email', type: 'text', masked: true },
]

const ROWS: Rows = [
  [
    1,
    'Acme Supplies',
    'open',
    '1280.50',
    '2026-10-13T09:14:02.120Z',
    '{"channel":"web","items":3}',
    null,
  ],
  [
    2,
    'Northwind Traders',
    'shipped',
    '86.00',
    '2026-10-13T09:20:41.004Z',
    '{"channel":"api","items":1}',
    null,
  ],
  [3, null, 'open', '0.00', '2026-10-13T09:31:10.777Z', null, null],
  [4, '', 'cancelled', '412.25', '2026-10-13T10:02:55.310Z', '{"channel":"web","items":0}', null],
  [5, 'Ada\u{202E}drow\u{200B}', 'open', '19.99', '2026-10-13T10:15:09.001Z', '{}', null],
  [
    6,
    {
      truncated: true,
      preview: 'A long order note that the server kept only the beginning of',
      bytes: 48210,
      unit: 'characters',
    },
    'open',
    '5400.00',
    '2026-10-13T10:40:00.000Z',
    '{"channel":"web","items":12}',
    null,
  ],
]

function ready(value: Rows) {
  return { state: 'ready' as const, value, source: 'live' as const, observedAt: OBSERVED }
}

function SortableGrid(): ReactNode {
  const [sort, setSort] = useState<{ column: number; direction: 'asc' | 'desc' } | null>(null)
  // The server orders. This stand-in orders the mock rows the way a server would answer.
  const rows = useMemo(() => {
    if (sort === null) return ROWS
    const index = sort.column
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...ROWS].sort((a, b) => {
      const left = String(a[index] ?? '')
      const right = String(b[index] ?? '')
      return left.localeCompare(right, 'en-US', { numeric: true }) * factor
    })
  }, [sort])
  const gridSort: GridSort = {
    column: sort?.column ?? null,
    direction: sort?.direction ?? 'asc',
    onSortChange: setSort,
  }
  return (
    <DataGrid
      label="Orders, sortable by the server"
      columns={COLUMNS}
      rows={ready(rows)}
      sort={gridSort}
      now={NOW}
      maxHeight={260}
    />
  )
}

function PagedGrid(): ReactNode {
  const [count, setCount] = useState(3)
  const [loading, setLoading] = useState(false)
  return (
    <DataGrid
      label="Orders, loaded by page"
      columns={COLUMNS}
      rows={ready(ROWS.slice(0, count))}
      page={{
        hasMore: count < ROWS.length,
        loading,
        onLoadMore: () => {
          setLoading(true)
          setTimeout(() => {
            setCount((current) => Math.min(ROWS.length, current + 3))
            setLoading(false)
          }, 400)
        },
      }}
      now={NOW}
      maxHeight={260}
    />
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/data-grid/result',
    title:
      'Result grid: NULL, empty, masked and cut values each look different, and a hostile value is marked',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={ready(ROWS)}
        now={NOW}
        maxHeight={300}
      />
    ),
  },
  {
    id: 'ui-data/data-grid/sortable',
    title: 'Sortable headers: pressing one asks the server to read the result again in that order',
    visual: false,
    render: () => <SortableGrid />,
  },
  {
    id: 'ui-data/data-grid/paged',
    title: 'Paging: rows load only when the person presses the button',
    visual: false,
    render: () => <PagedGrid />,
  },
  {
    id: 'ui-data/data-grid/server-cut',
    title:
      'The server cut the result at its cap: the grid says so, and exports do not claim to be whole',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={ready(ROWS.slice(0, 3))}
        truncated={{ reason: 'the 5,000 row limit' }}
        now={NOW}
        maxHeight={220}
      />
    ),
  },
  {
    id: 'ui-data/data-grid/empty',
    title: 'Empty: only after a read that succeeded and returned no rows',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={ready([])}
        now={NOW}
        maxHeight={220}
      />
    ),
  },
  {
    id: 'ui-data/data-grid/failed',
    title: 'Failed: the reason and a retry, never "No rows"',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={{
          state: 'failed',
          error: {
            code: 'QUERY_TIMEOUT',
            message: 'The statement ran longer than the 30 second limit.',
          },
        }}
        onRetry={() => undefined}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-data/data-grid/loading',
    title: 'Loading: a header and rows of skeleton, announced as one status',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={{ state: 'loading' }}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-data/data-grid/stale',
    title: 'Stale: the rows under a banner with their source and age',
    render: () => (
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={{
          state: 'stale',
          value: ROWS.slice(0, 2),
          source: 'cached',
          observedAt: minutesAgo(35),
          error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
        }}
        onRefresh={() => undefined}
        now={NOW}
        maxHeight={200}
      />
    ),
  },
]
