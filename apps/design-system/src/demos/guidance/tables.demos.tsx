import {
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableHeadSort,
  TableRow,
} from '@exponetdb/ui'
import type { CellValue, GridColumn } from '@exponetdb/ui-data'
import {
  type HealthState,
  type Readable,
  type ReadSource,
  StateBadge,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { NOW, OBSERVED } from './support.tsx'

// ---------------------------------------------------------------------------
// A plain table: a short list that is read, not worked on
// ---------------------------------------------------------------------------

const ROLES = [
  {
    role: 'observer',
    purpose: 'Catalog reads and health sampling',
    verified: '2026-10-13 11:56 UTC',
  },
  {
    role: 'reader',
    purpose: 'Reads of data, inside read-only transactions',
    verified: '2026-10-13 11:56 UTC',
  },
  {
    role: 'migrator',
    purpose: 'Schema changes from the migration engine',
    verified: '2026-10-12 08:30 UTC',
  },
] as const

function RolesTable(): ReactNode {
  return (
    <Card>
      <Table aria-label="Roles ExponetDB uses on the cluster shop-main">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Role</TableHead>
            <TableHead scope="col">Purpose</TableHead>
            <TableHead scope="col">Last verified</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROLES.map((row) => (
            <TableRow key={row.role}>
              <TableCell className="font-mono text-xs">{row.role}</TableCell>
              <TableCell>{row.purpose}</TableCell>
              <TableCell className="text-foreground-light">{row.verified}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// A sortable table: the header states the order, the arrows only repeat it
// ---------------------------------------------------------------------------

interface TargetRow {
  readonly path: string
  readonly state: HealthState
  readonly source: ReadSource
  readonly observedAt: string
  readonly lastOperation: string
}

const TARGETS: readonly TargetRow[] = [
  {
    path: 'shop/platform/production',
    state: 'healthy',
    source: 'live',
    observedAt: OBSERVED,
    lastOperation: '2026-10-13T09:10:00.000Z',
  },
  {
    path: 'shop/platform/staging',
    state: 'healthy',
    source: 'sampled',
    observedAt: OBSERVED,
    lastOperation: '2026-10-13T11:20:00.000Z',
  },
  {
    path: 'shop/billing/production',
    state: 'degraded',
    source: 'sampled',
    observedAt: '2026-10-13T11:30:00.000Z',
    lastOperation: '2026-10-12T16:45:00.000Z',
  },
  {
    path: 'acme/orders/staging',
    state: 'unknown',
    source: 'agent_reported',
    observedAt: '2026-10-13T10:00:00.000Z',
    lastOperation: '2026-10-10T08:00:00.000Z',
  },
]

type SortColumn = 'path' | 'lastOperation'
type SortDirection = 'asc' | 'desc'

function sortedTargets(
  rows: readonly TargetRow[],
  sort: { readonly column: SortColumn; readonly direction: SortDirection } | null,
): readonly TargetRow[] {
  if (sort === null) return rows
  const factor = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => factor * a[sort.column].localeCompare(b[sort.column], 'en-US'))
}

function SortableTargets(): ReactNode {
  const [sort, setSort] = useState<{
    readonly column: SortColumn
    readonly direction: SortDirection
  } | null>({ column: 'path', direction: 'asc' })
  const current = sort === null ? '' : `${sort.column}:${sort.direction}`

  // Ascending, then descending, then unsorted: the same cycle for every column.
  const cycle = (column: SortColumn) =>
    setSort((previous) => {
      if (previous === null || previous.column !== column) return { column, direction: 'asc' }
      return previous.direction === 'asc' ? { column, direction: 'desc' } : null
    })

  return (
    <Card>
      <Table aria-label="Targets of the products shop and acme">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">
              <TableHeadSort column="path" currentSort={current} onSortChange={cycle}>
                Target
              </TableHeadSort>
            </TableHead>
            <TableHead scope="col">Health</TableHead>
            <TableHead scope="col">
              <TableHeadSort column="lastOperation" currentSort={current} onSortChange={cycle}>
                Last operation
              </TableHeadSort>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedTargets(TARGETS, sort).map((row) => (
            <TableRow key={row.path}>
              <TableCell>
                <UntrustedName name={row.path} mono label="target path" />
              </TableCell>
              <TableCell>
                <StateBadge
                  state={row.state}
                  source={row.source}
                  observedAt={row.observedAt}
                  now={NOW}
                />
              </TableCell>
              <TableCell className="text-foreground-light">
                <time dateTime={row.lastOperation}>
                  {row.lastOperation.slice(0, 16).replace('T', ' ')} UTC
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// A grid: a query result, read only, ordered by the server, loaded on request
// ---------------------------------------------------------------------------

// The grid pulls in table and virtualization libraries; it loads only where it is shown.
const DataGrid = lazy(async () => {
  const module = await import('@exponetdb/ui-data/grid/data-grid')
  return { default: module.DataGrid }
})

const COLUMNS: readonly GridColumn[] = [
  { name: 'id', type: 'int8' },
  { name: 'order_ref', type: 'text' },
  { name: 'status', type: 'text' },
  { name: 'total_cents', type: 'int8' },
  { name: 'placed_at', type: 'timestamptz' },
]

const GRID_ROWS: readonly (readonly CellValue[])[] = [
  [1001, 'A-5521', 'paid', 4200, '2026-10-13 08:01:12+00'],
  [1002, 'A-5522', 'paid', 1890, '2026-10-13 08:03:40+00'],
  [1003, 'A-5523', 'refunded', 990, '2026-10-13 08:09:05+00'],
  [1004, 'A-5524', 'pending', null, '2026-10-13 08:12:51+00'],
  [1005, 'A-5525', 'paid', 15600, '2026-10-13 08:15:22+00'],
]

/** NULL sorts last; numbers sort as numbers. This stands in for the ORDER BY the server applies. */
function compareCells(a: CellValue | undefined, b: CellValue | undefined): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return String(a).localeCompare(String(b), 'en-US', { numeric: true })
}

function orderedRows(
  sort: { readonly column: number; readonly direction: SortDirection } | null,
): Readable<readonly (readonly CellValue[])[]> {
  const factor = sort?.direction === 'desc' ? -1 : 1
  const value =
    sort === null
      ? GRID_ROWS
      : [...GRID_ROWS].sort((a, b) => factor * compareCells(a[sort.column], b[sort.column]))
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED }
}

function ResultGrid(): ReactNode {
  // The grid never reorders rows: pressing a header asks the page to read the result again in
  // the new order. Here the page reorders its own sample.
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null)
  return (
    <Suspense fallback={<Skeleton className="h-48 w-full" />}>
      <DataGrid
        label="Result of the last query"
        columns={COLUMNS}
        rows={orderedRows(sort)}
        what="result rows"
        now={NOW}
        maxHeight={240}
        sort={{
          column: sort?.column ?? null,
          direction: sort?.direction ?? 'asc',
          onSortChange: setSort,
        }}
        page={{ hasMore: true, loading: false, onLoadMore: () => undefined }}
      />
    </Suspense>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/tables-and-grids/plain-table',
    title: 'A plain table for a short list that is only read',
    render: () => <RolesTable />,
  },
  {
    id: 'guidance/tables-and-grids/sortable-table',
    title: 'A sortable table: the column header states the order',
    render: () => <SortableTargets />,
  },
  {
    id: 'guidance/tables-and-grids/result-grid',
    title: 'A grid for a query result: read only, the server orders, rows load on request',
    render: () => <ResultGrid />,
  },
]
