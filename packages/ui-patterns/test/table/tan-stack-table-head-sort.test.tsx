// Derived from supabase/supabase packages/ui-patterns/src/Table/TanStackTableHeadSort.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@exponetdb/ui'
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { TanStackTableHeadSort } from '../../src/table/tan-stack-table-head-sort.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

type Row = {
  name: string
  amount: number
}

const data: Row[] = [
  { name: 'Bravo', amount: 200 },
  { name: 'Alpha', amount: 100 },
]

const columns: ColumnDef<Row>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => <TanStackTableHeadSort column={column}>Name</TanStackTableHeadSort>,
    cell: ({ row }) => row.getValue('name'),
  },
  {
    accessorKey: 'amount',
    enableSorting: false,
    header: ({ column }) => <TanStackTableHeadSort column={column}>Amount</TanStackTableHeadSort>,
    cell: ({ row }) => row.getValue('amount'),
  },
]

const classNameColumns: ColumnDef<Row>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => (
      <TanStackTableHeadSort column={column} className="justify-end">
        Name
      </TanStackTableHeadSort>
    ),
    cell: ({ row }) => row.getValue('name'),
  },
]

const TestTable = ({ tableColumns = columns }: { tableColumns?: ColumnDef<Row>[] }) => {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

describe('TanStackTableHeadSort', () => {
  it('cycles unsorted, ascending, descending, and cleared', async () => {
    const user = userEvent.setup()

    render(<TestTable />)

    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bravo')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Alpha')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bravo')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bravo')
  })

  it('renders non-sortable columns as plain content', () => {
    render(<TestTable />)

    expect(screen.getByText('Amount')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Amount' })).not.toBeInTheDocument()
  })

  it('passes className through to the rendered sort control', () => {
    render(<TestTable tableColumns={classNameColumns} />)

    expect(screen.getByRole('button', { name: 'Name' })).toHaveClass('justify-end')
  })

  it('reports the sort state on the column header with aria-sort', async () => {
    const user = userEvent.setup()

    render(<TestTable />)
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' })
    const amountHeader = screen.getByRole('columnheader', { name: 'Amount' })

    expect(nameHeader).toHaveAttribute('aria-sort', 'none')
    // A column that cannot be sorted does not claim to be sortable.
    expect(amountHeader).not.toHaveAttribute('aria-sort')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending')

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(nameHeader).toHaveAttribute('aria-sort', 'none')
  })

  it('sorts with Enter and with Space', async () => {
    const user = userEvent.setup()

    render(<TestTable />)
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' })
    await user.tab()
    expect(screen.getByRole('button', { name: 'Name' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Alpha')

    await user.keyboard(' ')
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bravo')
  })

  it('has no axe violations, unsorted and sorted', async () => {
    const user = userEvent.setup()

    render(<TestTable />)
    expect(await axeViolations()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(await axeViolations()).toEqual([])
  })
})
