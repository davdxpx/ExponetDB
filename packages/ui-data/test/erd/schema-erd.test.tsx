import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchemaErd } from '../../src/erd/schema-erd.tsx'
import type { SchemaErdData, SchemaErdProps } from '../../src/erd/types.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'
const OBSERVED = '2026-10-13T14:03:30Z'

const SCHEMA: SchemaErdData = {
  tables: [
    {
      id: 'users',
      schema: 'public',
      name: 'users',
      columns: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'email', type: 'text' },
      ],
    },
    {
      id: 'orders',
      schema: 'public',
      name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'user_id', type: 'uuid' },
        { name: 'total', type: 'numeric(12,2)' },
      ],
    },
    {
      id: 'audit',
      schema: 'private',
      name: 'audit_log',
      columns: [{ name: 'at', type: 'timestamptz' }],
    },
  ],
  relations: [
    {
      name: 'orders_user_fk',
      fromTable: 'orders',
      fromColumns: ['user_id'],
      toTable: 'users',
      toColumns: ['id'],
    },
  ],
}

function ready(value: SchemaErdData): Readable<SchemaErdData> {
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED }
}

function renderErd(readable: Readable<SchemaErdData>, props: Partial<SchemaErdProps> = {}) {
  return render(
    <TooltipProvider>
      <SchemaErd readable={readable} now={NOW} {...props} />
    </TooltipProvider>,
  )
}

function tableNode(name: RegExp): HTMLElement {
  return screen.getByRole('group', { name })
}

describe('SchemaErd: the diagram', () => {
  it('draws a node per table with its columns, types and key markers', () => {
    renderErd(ready(SCHEMA))

    const users = tableNode(/public\.users/)
    expect(within(users).getByText('email')).toBeInTheDocument()
    expect(within(users).getAllByText('uuid').length).toBeGreaterThan(0)
    // Primary key: the letters for sight, the words for a screen reader.
    expect(within(users).getByText('PK')).toBeInTheDocument()
    expect(within(users).getByText('primary key')).toBeInTheDocument()

    const orders = tableNode(/public\.orders/)
    const userId = within(orders).getByText('user_id').closest('li') as HTMLElement
    expect(within(userId).getByText('FK')).toBeInTheDocument()
    expect(within(userId).getByText('foreign key')).toBeInTheDocument()
    expect(within(userId).queryByText('PK')).toBeNull()
    expect(within(orders).getByText('numeric(12,2)')).toBeInTheDocument()

    expect(tableNode(/private\.audit_log/)).toBeInTheDocument()
  })

  it('draws one connection per pair of tables that a foreign key joins', () => {
    const { container } = renderErd(ready(SCHEMA))

    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1)
  })

  it('merges two foreign keys between the same tables into one connection', () => {
    const { container } = renderErd(
      ready({
        ...SCHEMA,
        relations: [
          ...SCHEMA.relations,
          {
            name: 'orders_billing_fk',
            fromTable: 'orders',
            fromColumns: ['user_id'],
            toTable: 'users',
            toColumns: ['id'],
          },
        ],
      }),
    )

    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1)
  })

  it('makes the tables keyboard focusable, each named by its table name', async () => {
    const user = userEvent.setup()
    renderErd(ready(SCHEMA))

    const nodes = screen
      .getAllByRole('group')
      .filter((node) => node.classList.contains('react-flow__node'))
    expect(nodes).toHaveLength(3)
    for (const node of nodes) {
      expect(node).toHaveAttribute('tabindex', '0')
      expect(node).toHaveAccessibleName(/\w+\.\w+/)
    }
    nodes[0]?.focus()
    expect(nodes[0]).toHaveFocus()
    await user.tab()
    expect(nodes[1]).toHaveFocus()
    await user.tab()
    expect(nodes[2]).toHaveFocus()
  })

  it('tells a screen reader what a table references and what references it', () => {
    renderErd(ready(SCHEMA))

    expect(tableNode(/public\.orders/)).toHaveTextContent('References public.users')
    expect(tableNode(/public\.users/)).toHaveTextContent('Referenced by public.orders')
    expect(tableNode(/private\.audit_log/)).not.toHaveTextContent('References')
  })

  it('does not let the nodes be dragged, connected, selected or deleted', () => {
    const { container } = renderErd(ready(SCHEMA))

    const node = container.querySelector('.react-flow__node') as HTMLElement
    expect(node).not.toHaveClass('draggable')
    expect(node).not.toHaveClass('selectable')
  })

  it('has zoom controls with words and a fit-to-view control', async () => {
    const user = userEvent.setup()
    renderErd(ready(SCHEMA))

    const toolbar = screen.getByRole('toolbar', { name: 'Diagram zoom' })
    const zoomIn = within(toolbar).getByRole('button', { name: 'Zoom in' })
    const zoomOut = within(toolbar).getByRole('button', { name: 'Zoom out' })
    const fit = within(toolbar).getByRole('button', { name: 'Fit to view' })

    await user.click(zoomIn)
    await user.click(zoomOut)
    await user.click(fit)

    expect(screen.getByRole('application', { name: 'Schema diagram' })).toBeInTheDocument()
  })

  it('names itself with an accessible name and explains how to move between tables', () => {
    const { container } = renderErd(ready(SCHEMA))

    const description = container.querySelector('[id^="react-flow__node-desc"]')
    expect(description).toHaveTextContent('Press Tab to move to the next table')
    expect(description).toHaveTextContent('Show as table')
  })

  it('says where the read comes from and when', () => {
    renderErd(ready(SCHEMA))

    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText(/Observed/)).toHaveTextContent('4 min ago')
    expect(screen.getByText('3 tables, 1 relation')).toBeInTheDocument()
  })

  it('shows the first columns of a wide table and counts the rest', () => {
    renderErd(
      ready({
        tables: [
          {
            id: 'wide',
            schema: 'public',
            name: 'wide',
            columns: Array.from({ length: 10 }, (_, index) => ({
              name: `col_${index}`,
              type: 'int',
            })),
          },
        ],
        relations: [],
      }),
      { maxColumnsPerNode: 4 },
    )

    const node = tableNode(/public\.wide/)
    expect(within(node).getByText('col_3')).toBeInTheDocument()
    expect(within(node).queryByText('col_4')).toBeNull()
    expect(within(node).getByText('and 6 more columns (see the table view)')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('first 4')
  })

  it('says a relation from a table to itself is not drawn', () => {
    const { container } = renderErd(
      ready({
        tables: [
          {
            id: 'emp',
            schema: 'public',
            name: 'employees',
            columns: [{ name: 'manager_id', type: 'uuid' }],
          },
        ],
        relations: [
          {
            name: 'emp_manager_fk',
            fromTable: 'emp',
            fromColumns: ['manager_id'],
            toTable: 'emp',
            toColumns: ['id'],
          },
        ],
      }),
    )

    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
    expect(screen.getByRole('note')).toHaveTextContent(
      '1 relation from a table to itself is not drawn',
    )
  })

  it('says a relation to a table the read does not list is not drawn', () => {
    renderErd(
      ready({
        ...SCHEMA,
        relations: [
          {
            name: 'x',
            fromTable: 'orders',
            fromColumns: ['user_id'],
            toTable: 'ghost',
            toColumns: ['id'],
          },
        ],
      }),
    )

    expect(screen.getByRole('note')).toHaveTextContent('refers to a table this read does not list')
  })
})

describe('SchemaErd: the table alternative', () => {
  it('starts with the diagram and the switch off', () => {
    renderErd(ready(SCHEMA))

    expect(screen.getByRole('switch', { name: 'Show as table' })).not.toBeChecked()
    expect(screen.queryByRole('table', { name: /Tables and their columns/ })).toBeNull()
  })

  it('lists every table with its columns and every relation as text when the switch is on', async () => {
    const user = userEvent.setup()
    const { container } = renderErd(ready(SCHEMA))

    await user.click(screen.getByRole('switch', { name: 'Show as table' }))

    expect(container.querySelector('.react-flow')).toBeNull()
    const tables = screen.getByRole('table', { name: /Tables and their columns/ })
    expect(
      within(tables)
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(['public.users', 'public.orders', 'private.audit_log'])
    const orders = within(tables)
      .getByRole('rowheader', { name: 'public.orders' })
      .closest('tr') as HTMLElement
    expect(within(orders).getByText('user_id')).toBeInTheDocument()
    expect(within(orders).getByText('numeric(12,2)')).toBeInTheDocument()
    const userId = within(orders).getByText('user_id').closest('li') as HTMLElement
    expect(userId).toHaveTextContent('foreign key')
    expect(userId).not.toHaveTextContent('primary key')
    expect(within(orders).getAllByText('primary key')).toHaveLength(1)

    const relations = screen.getByRole('table', { name: /Relations between tables/ })
    const row = within(relations)
      .getByRole('rowheader', { name: 'orders_user_fk' })
      .closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('public.orders(user_id)')
    expect(cells[1]).toHaveTextContent('public.users(id)')
  })

  it('goes back to the diagram when the switch is turned off again', async () => {
    const user = userEvent.setup()
    const { container } = renderErd(ready(SCHEMA))

    await user.click(screen.getByRole('switch', { name: 'Show as table' }))
    await user.click(screen.getByRole('switch', { name: 'Show as table' }))

    expect(container.querySelector('.react-flow')).not.toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('can start with the table', () => {
    const { container } = renderErd(ready(SCHEMA), { initialView: 'table' })

    expect(screen.getByRole('switch', { name: 'Show as table' })).toBeChecked()
    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.getByRole('table', { name: /Tables and their columns/ })).toBeInTheDocument()
  })

  it('says so when there are no relations', () => {
    renderErd(ready({ ...SCHEMA, relations: [] }), { initialView: 'table' })

    expect(
      screen.getByText('The read found no foreign keys between these tables.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: /Relations between tables/ })).toBeNull()
  })

  it('lists a relation to an unknown table by its id, marked as not in the read', () => {
    renderErd(
      ready({
        ...SCHEMA,
        relations: [
          {
            name: 'x',
            fromTable: 'orders',
            fromColumns: ['user_id'],
            toTable: 'ghost',
            toColumns: ['id'],
          },
        ],
      }),
      { initialView: 'table' },
    )

    const relations = screen.getByRole('table', { name: /Relations between tables/ })
    expect(within(relations).getByText('(table not in this read)')).toBeInTheDocument()
    expect(within(relations).getByText('ghost')).toBeInTheDocument()
  })

  // Renders 250 rows and pages through them in jsdom: about 1.3 s alone, but it ran past the
  // default 5 s once in a full parallel run of every package (2026-10-13), so it gets its own bound.
  it('shows a long list in pages with an explicit "Show more"', async () => {
    const user = userEvent.setup()
    const tables = Array.from({ length: 250 }, (_, index) => ({
      id: `t${index}`,
      schema: 'public',
      name: `table_${String(index).padStart(3, '0')}`,
      columns: [{ name: 'id', type: 'int', pk: true }],
    }))
    renderErd(ready({ tables, relations: [] }), { initialView: 'table', maxNodes: 1_000 })

    const list = () => screen.getByRole('table', { name: /Tables and their columns/ })
    expect(within(list()).getAllByRole('rowheader')).toHaveLength(100)
    expect(screen.getByText('250 tables')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show 100 more tables (150 not shown)' }))
    expect(within(list()).getAllByRole('rowheader')).toHaveLength(200)

    await user.click(screen.getByRole('button', { name: 'Show 50 more tables (50 not shown)' }))
    expect(within(list()).getAllByRole('rowheader')).toHaveLength(250)
    expect(screen.queryByRole('button', { name: /more tables/ })).toBeNull()
  }, 20_000)
})

describe('SchemaErd: the node limit', () => {
  const MANY: SchemaErdData = {
    tables: Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      schema: 'public',
      name: `table_${index}`,
      columns: [{ name: 'id', type: 'int' }],
    })),
    relations: [],
  }

  it('shows the table view with a note instead of the diagram above the limit', () => {
    const { container } = renderErd(ready(MANY), { maxNodes: 4 })

    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.getByRole('table', { name: /Tables and their columns/ })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(
      'This schema has 5 tables, more than the diagram limit of 4. Only the table view is shown.',
    )
    const toggle = screen.getByRole('switch', { name: 'Show as table' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
  })

  it('draws the diagram at the limit', () => {
    const { container } = renderErd(ready(MANY), { maxNodes: 5 })

    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(5)
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('uses 150 tables as the default limit', () => {
    const tables = Array.from({ length: 151 }, (_, index) => ({
      id: `t${index}`,
      schema: 'public',
      name: `t${index}`,
      columns: [],
    }))
    const { container } = renderErd(ready({ tables, relations: [] }))

    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent('limit of 150')
  })

  it('shows the table view when there are more connections than the diagram can show', () => {
    const tables = Array.from({ length: 6 }, (_, index) => ({
      id: `t${index}`,
      schema: 'public',
      name: `t${index}`,
      columns: [{ name: 'id', type: 'int' }],
    }))
    const relations = [
      ['t0', 't1'],
      ['t0', 't2'],
      ['t0', 't3'],
      ['t1', 't2'],
    ].map(([from, to]) => ({
      name: `${from}_${to}`,
      fromTable: from as string,
      fromColumns: ['id'],
      toTable: to as string,
      toColumns: ['id'],
    }))
    const { container } = renderErd(ready({ tables, relations }), { maxEdges: 3 })

    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent(
      '4 connections between tables, more than the diagram limit of 3',
    )
  })
})

describe('SchemaErd: truthful states', () => {
  it('renders a failed read as the failed state, never as an empty diagram', () => {
    const { container } = renderErd({
      state: 'failed',
      error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
    })

    expect(screen.getByText(/Could not read schema diagram/)).toBeInTheDocument()
    expect(screen.getByText(/This does not mean there is no schema diagram/)).toBeInTheDocument()
    expect(screen.getByText('TARGET_UNREACHABLE')).toBeInTheDocument()
    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.queryByText('No tables')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders a read in progress as loading', () => {
    renderErd({ state: 'loading' })

    expect(screen.getByRole('status')).toHaveTextContent('Loading schema diagram')
    expect(screen.queryByText('No tables')).toBeNull()
  })

  it('says a successful read that found no tables found no tables', () => {
    renderErd(ready({ tables: [], relations: [] }))

    expect(screen.getByText('No tables')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows a stale read under its banner with the diagram', () => {
    const { container } = renderErd({
      state: 'stale',
      value: SCHEMA,
      source: 'cached',
      observedAt: '2026-10-13T12:00:00Z',
    })

    expect(screen.getByText(/Showing an earlier read of schema diagram/)).toBeInTheDocument()
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3)
  })

  it('shows a partial read under its banner and never as empty', () => {
    renderErd({
      state: 'partial',
      value: { tables: [], relations: [] },
      source: 'live',
      observedAt: OBSERVED,
      missing: ['schema billing (permission denied)'],
    })

    expect(screen.getByText(/schema billing \(permission denied\)/)).toBeInTheDocument()
    expect(screen.queryByText('No tables')).toBeNull()
  })
})

describe('SchemaErd: hostile content', () => {
  const HOSTILE: SchemaErdData = {
    tables: [
      {
        id: '<b>id</b>',
        schema: '<script>alert(1)</script>',
        name: '<img src=x onerror=alert(2)>\u{202E}evil',
        columns: [
          { name: '"; DROP TABLE users; --', type: '<svg onload=alert(3)>' },
          { name: 'a\u{200B}b', type: 'text' },
        ],
      },
      { id: 'ok', schema: 'public', name: 'ok', columns: [] },
    ],
    relations: [
      {
        name: '<a href="javascript:alert(4)">fk</a>',
        fromTable: '<b>id</b>',
        fromColumns: ['a\u{200B}b'],
        toTable: 'ok',
        toColumns: ['id'],
      },
    ],
  }

  function expectNothingInjected(container: HTMLElement) {
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('svg[onload]')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
  }

  it('draws names, columns and types as text with hidden characters shown by code point', () => {
    const { container } = renderErd(ready(HOSTILE))

    expectNothingInjected(container)
    expect(container.textContent).toContain('<img src=x onerror=alert(2)>')
    expect(container.textContent).toContain('⟨U+202E⟩')
    expect(container.textContent).toContain('⟨U+200B⟩')
    expect(container.querySelector('[data-segment="hidden"]')).not.toBeNull()
  })

  it('lists them as text in the table view too, with the name in full and a way to see all of it', async () => {
    const user = userEvent.setup()
    const long = `t_${'y'.repeat(300)}`
    const { container } = renderErd(
      ready({
        ...HOSTILE,
        tables: [...HOSTILE.tables, { id: 'long', schema: 'public', name: long, columns: [] }],
      }),
      { initialView: 'table' },
    )

    expectNothingInjected(container)
    expect(container.textContent).toContain('⟨U+202E⟩')
    expect(container.textContent).not.toContain('y'.repeat(100))
    await user.click(screen.getByRole('button', { name: /Show all .*of table name/ }))
    expect(container.textContent).toContain('y'.repeat(300))
  })

  it('cuts a very long name in the diagram with an ellipsis, and bounds what a screen reader gets', () => {
    const { container } = renderErd(
      ready({
        tables: [{ id: 'long', schema: 'public', name: `t_${'z'.repeat(400)}`, columns: [] }],
        relations: [],
      }),
    )

    const visible = container.querySelector('[id$="-name"] [aria-hidden="true"]') as HTMLElement
    expect(visible.textContent).toContain('…')
    expect(visible.textContent).not.toContain('z'.repeat(60))
    expect(container.textContent).not.toContain('z'.repeat(150))
  })
})

describe('SchemaErd: what the page may and may not contain', () => {
  it('creates no style element and renders no attribution link', () => {
    const created: string[] = []
    const original = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      options?: ElementCreationOptions,
    ) => {
      created.push(tag.toLowerCase())
      return original(tag, options)
    }) as typeof document.createElement)

    try {
      const { container } = renderErd(ready(SCHEMA))

      expect(created.length).toBeGreaterThan(0)
      expect(created).not.toContain('style')
      expect(document.querySelectorAll('style')).toHaveLength(0)
      expect(container.querySelector('.react-flow__attribution')).toBeNull()
      expect(container.querySelector('a[href*="reactflow"]')).toBeNull()
      expect(container.querySelectorAll('a')).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('SchemaErd: accessibility', () => {
  it('has no axe violations as a diagram', async () => {
    renderErd(ready(SCHEMA))

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations as a diagram with notes and hidden columns', async () => {
    renderErd(
      ready({
        tables: [
          {
            id: 'emp',
            schema: 'public',
            name: 'employees',
            columns: Array.from({ length: 8 }, (_, index) => ({ name: `c${index}`, type: 'int' })),
          },
        ],
        relations: [
          {
            name: 'self',
            fromTable: 'emp',
            fromColumns: ['c0'],
            toTable: 'emp',
            toColumns: ['c1'],
          },
          {
            name: 'ghost',
            fromTable: 'emp',
            fromColumns: ['c0'],
            toTable: 'nope',
            toColumns: ['c1'],
          },
        ],
      }),
      { maxColumnsPerNode: 3 },
    )

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations as a table', async () => {
    renderErd(ready(SCHEMA), { initialView: 'table' })

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations above the node limit', async () => {
    renderErd(ready(SCHEMA), { maxNodes: 1 })

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations in the failed, loading and empty states', async () => {
    const { rerender } = renderErd({
      state: 'failed',
      error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
    })
    expect(await axeViolations()).toEqual([])

    rerender(
      <TooltipProvider>
        <SchemaErd readable={{ state: 'loading' }} />
      </TooltipProvider>,
    )
    expect(await axeViolations()).toEqual([])

    rerender(
      <TooltipProvider>
        <SchemaErd readable={ready({ tables: [], relations: [] })} />
      </TooltipProvider>,
    )
    expect(await axeViolations()).toEqual([])
  })
})
