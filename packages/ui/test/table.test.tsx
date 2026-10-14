import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableHeadSort,
  TableRow,
} from '../src/table.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

type Column = 'name' | 'created'

function SortableTable({
  initial = '',
  onSort,
}: {
  initial?: string
  onSort?: (c: Column) => void
}) {
  const [sort, setSort] = useState(initial)
  const change = (column: Column) => {
    onSort?.(column)
    setSort((current) => (current === `${column}:asc` ? `${column}:desc` : `${column}:asc`))
  }

  return (
    <Table>
      <TableCaption>Migrations</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>
            <TableHeadSort column="name" currentSort={sort} onSortChange={change}>
              Name
            </TableHeadSort>
          </TableHead>
          <TableHead>
            <TableHeadSort column="created" currentSort={sort} onSortChange={change}>
              Created
            </TableHeadSort>
          </TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>add_users</TableCell>
          <TableCell>2026-10-01</TableCell>
          <TableCell>Verified</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>1 migration</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

describe('Table', () => {
  it('renders a table with its parts and has no accessibility violations', async () => {
    render(<SortableTable />)

    expect(screen.getByRole('table', { name: 'Migrations' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
    expect(screen.getByRole('cell', { name: 'add_users' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('renders cell content as text', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>{'<b>bold</b>'}</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    expect(screen.getByRole('cell').textContent).toBe('<b>bold</b>')
    expect(document.querySelector('b')).toBeNull()
  })

  it('keeps the scroll area around the table and passes container props to it', () => {
    render(
      <Table containerProps={{ 'aria-label': 'Migrations table', className: 'max-h-40' }}>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    const table = screen.getByRole('table')
    const scroller = table.parentElement
    expect(scroller).toHaveAttribute('aria-label', 'Migrations table')
    expect(scroller).toHaveClass('overflow-auto', 'max-h-40')
    expect(scroller?.parentElement).toHaveClass('relative')
  })
})

describe('TableHeadSort', () => {
  it('puts aria-sort on the column header, none when the column is not sorted', () => {
    render(<SortableTable />)

    const [name, created, status] = screen.getAllByRole('columnheader')
    expect(name).toHaveAttribute('aria-sort', 'none')
    expect(created).toHaveAttribute('aria-sort', 'none')
    // a header without a sort control does not claim to be sortable
    expect(status).not.toHaveAttribute('aria-sort')
  })

  it('states the direction of the sorted column and none for the others', () => {
    const { rerender } = render(<SortableTable initial="created:asc" />)
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'none')

    rerender(<SortableTable key="desc" initial="created:desc" />)
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })

  it('is a button inside the header that sorts with Enter and Space', async () => {
    const user = userEvent.setup()
    const onSort = vi.fn()
    render(<SortableTable onSort={onSort} />)

    const button = screen.getByRole('button', { name: 'Name' })
    expect(button.closest('th')).toBe(screen.getByRole('columnheader', { name: /Name/ }))
    expect(button).toHaveAttribute('type', 'button')

    await user.tab()
    expect(button).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onSort).toHaveBeenCalledTimes(1)
    expect(onSort).toHaveBeenLastCalledWith('name')
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )

    await user.keyboard(' ')
    expect(onSort).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(await axeViolations()).toEqual([])
  })

  it('sorts with a click and moves between the sort buttons with Tab', async () => {
    const user = userEvent.setup()
    const onSort = vi.fn()
    render(<SortableTable onSort={onSort} />)

    await user.click(screen.getByRole('button', { name: 'Created' }))
    expect(onSort).toHaveBeenCalledWith('created')

    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Name' })).toHaveFocus()
  })

  it('hides the arrows from assistive technology: the header states the sort', () => {
    render(<SortableTable initial="name:asc" />)

    const button = screen.getByRole('button', { name: 'Name' })
    expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(button.querySelectorAll('svg')).toHaveLength(3)
  })

  it('reads a column id that contains a colon', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <TableHeadSort column="a:b" currentSort="a:b:desc" onSortChange={() => {}}>
                Odd
              </TableHeadSort>
            </TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    )

    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending')
  })

  it('lets a header set aria-sort itself', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead aria-sort="ascending">Name</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    )

    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending')
  })

  it('removes aria-sort when the sort button goes away', () => {
    const { rerender } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <TableHeadSort column="name" currentSort="name:asc" onSortChange={() => {}}>
                Name
              </TableHeadSort>
            </TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    )
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending')

    rerender(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    )
    expect(screen.getByRole('columnheader')).not.toHaveAttribute('aria-sort')
  })
})

describe('TableRow', () => {
  it('shows a visible inset focus on a row that is a control', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Table>
        <TableBody>
          <TableRow tabIndex={0} onClick={onClick} aria-label="Open add_users">
            <TableCell>add_users</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>plain</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    const [interactive, plain] = screen.getAllByRole('row')
    expect(interactive).toHaveClass('focus-inset')
    expect(plain).not.toHaveClass('focus-inset')

    await user.tab()
    expect(interactive).toHaveFocus()
    await user.click(interactive as HTMLElement)
    expect(onClick).toHaveBeenCalled()
  })

  it('marks a selected row through data-state', () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-state="selected">
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    expect(screen.getByRole('row')).toHaveClass('data-[state=selected]:bg-muted')
    expect(screen.getByRole('row')).toHaveAttribute('data-state', 'selected')
  })
})

describe('ShadowScrollArea in a table', () => {
  function overflow(scrollWidth: number, clientWidth: number) {
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth)
  }

  it('is not a tab stop while everything fits', () => {
    overflow(300, 300)
    render(
      <Table containerProps={{ 'aria-label': 'Migrations table' }}>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    const scroller = screen.getByRole('table').parentElement
    expect(scroller).not.toHaveAttribute('tabindex')
    expect(scroller).not.toHaveAttribute('role')
  })

  it('becomes a focusable, named region while its content overflows', async () => {
    overflow(900, 300)
    render(
      <Table containerProps={{ 'aria-label': 'Migrations table' }}>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    const region = screen.getByRole('region', { name: 'Migrations table' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveClass('focus-inset')
    expect(region).toContainElement(screen.getByRole('table'))
    expect(await axeViolations()).toEqual([])
  })

  it('forwards its ref to the scrolling element', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <Table containerProps={{ ref }}>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    expect(ref.current).toBe(screen.getByRole('table').parentElement)
  })

  it('sits in a horizontally scrollable region that may shrink below its table (no page overflow)', () => {
    const { container } = render(
      <div className="flex">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>{'x'.repeat(400)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>,
    )
    const table = container.querySelector('table') as HTMLElement
    const scroller = table.parentElement as HTMLElement
    const outer = scroller.parentElement as HTMLElement
    expect(scroller.className).toContain('overflow-auto')
    expect(scroller.className).toContain('w-full')
    // Positioned, so `sr-only` text of a far column scrolls with the box and never widens the page.
    expect(scroller).toHaveClass('relative')
    // A flex or grid parent would otherwise size the region to the table's content.
    expect(outer.className).toContain('min-w-0')
    expect(outer.className).toContain('max-w-full')
  })
})
