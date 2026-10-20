import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { objectHref, type SchemaSearch } from '../../src/features/schema/search.ts'
import { parseSqlLink } from '../../src/features/sql/sql-model.ts'
import {
  BIDI,
  BrowseWorld,
  fingerprintFixture,
  GLOBAL_GRANT,
  mountBrowse,
  objectFixture,
  orderRows,
  ordersObject,
  overviewFixture,
  project,
  ref,
  resultFixture,
  ZWSP,
} from './browse-support.tsx'

// The target pages run in the shortcut and command providers of the real shell, without the rail.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The grid is a lazy TanStack chunk (tested in packages/ui-data); the stand-in shows what it got
// and offers the controls the real grid has: sortable headers and "Load more rows".
vi.mock('@exponetdb/ui-data/grid/data-grid', async () => {
  const React = await import('react')
  type Props = {
    columns: readonly { name: string; masked?: boolean }[]
    rows: { state: string; value?: readonly (readonly unknown[])[] }
    truncated?: { reason: string }
    page?: { hasMore: boolean; loading: boolean; onLoadMore: () => void }
    sort?: {
      column: number | null
      direction: 'asc' | 'desc'
      onSortChange: (next: { column: number; direction: 'asc' | 'desc' } | null) => void
    }
    onRefresh?: () => void
  }
  return {
    DataGrid: (props: Props) => {
      const rows = props.rows.value ?? []
      const sort = props.sort
      return React.createElement(
        'div',
        {
          'data-testid': 'grid',
          'data-state': props.rows.state,
          'data-rows': rows.length,
          'data-masked': props.columns.filter((c) => c.masked === true).length,
          'data-truncated': props.truncated?.reason,
          'data-sort': sort === undefined ? '' : `${String(sort.column)}:${sort.direction}`,
        },
        ...props.columns.map((column, index) =>
          React.createElement(
            'button',
            {
              key: `h${index}`,
              type: 'button',
              onClick: () =>
                sort?.onSortChange(
                  sort.column === index
                    ? sort.direction === 'asc'
                      ? { column: index, direction: 'desc' }
                      : null
                    : { column: index, direction: 'asc' },
                ),
            },
            `Sort by ${column.name}`,
          ),
        ),
        rows.length === 0
          ? React.createElement('p', { key: 'none' }, 'No rows')
          : React.createElement(
              'ul',
              { key: 'rows' },
              ...rows.map((row, index) =>
                React.createElement(
                  'li',
                  { key: `r${index}` },
                  row
                    .map((cell) => (typeof cell === 'object' ? JSON.stringify(cell) : String(cell)))
                    .join('|'),
                ),
              ),
            ),
        props.rows.state === 'stale'
          ? React.createElement(
              'button',
              { key: 'refresh', type: 'button', onClick: props.onRefresh },
              'Refresh rows',
            )
          : null,
        props.page?.hasMore === true
          ? React.createElement(
              'button',
              {
                key: 'more',
                type: 'button',
                disabled: props.page.loading,
                onClick: props.page.onLoadMore,
              },
              'Load more rows',
            )
          : null,
      )
    },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const STAGING = 'shop/platform/staging'
const TARGET = { product: 'shop', project: 'platform', environment: 'staging' }
const PROD_TARGET = { product: 'shop', project: 'platform', environment: 'production' }

function readyWorld(): BrowseWorld {
  const world = new BrowseWorld()
  project(world)
  world.sample(STAGING)
  world.sample('shop/platform/production')
  world.overview = overviewFixture()
  world.fingerprint = fingerprintFixture()
  world.permissions = ['data.read']
  world.refs = [ref({ name: 'orders' })]
  world.objects.set('table|"public"."orders"', ordersObject())
  return world
}

function rowsPath(extra: Partial<SchemaSearch> = {}, target = TARGET): string {
  const href = objectHref(
    target,
    { kind: 'table', key: ['public', 'orders'] },
    { tab: 'rows', ...extra },
  )
  if (href === undefined) throw new Error('no link')
  return href
}

async function openRows(world: BrowseWorld, path = rowsPath()) {
  const mounted = mountBrowse(path, world)
  await screen.findByRole('button', { name: 'Read rows' })
  return { ...mounted, user: userEvent.setup() }
}

async function readFirst(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Read (rows|again)$/ }))
  return screen.findByTestId('grid')
}

function body(sent: { body: unknown } | undefined): {
  sql: string
  params: unknown[]
  queryId: string
} {
  return sent?.body as { sql: string; params: unknown[]; queryId: string }
}

describe('the row browser opens idle', () => {
  it('shows the statement it would send and reads nothing until the press', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    expect(world.runs()).toHaveLength(0)
    expect(screen.queryByTestId('grid')).toBeNull()
    const statement = document.querySelector('[data-slot="statement"]')
    expect(statement?.textContent).toContain('"public"."orders"')
    expect(statement?.textContent).toContain('LIMIT 101')
    await readFirst(user)
    expect(world.runs()).toHaveLength(1)
    const sent = body(world.runs()[0])
    expect(sent.sql).toBe('SELECT *\nFROM "public"."orders"\nORDER BY "id" ASC\nLIMIT 101')
    expect(sent.params).toEqual([])
    expect(sent.queryId).toMatch(/^qry_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(world.runs()[0]?.path).toBe('/api/v1/targets/shop%2Fplatform%2Fstaging/queries')
  })

  it('does not read when the link already carries a sort and filters', async () => {
    const world = readyWorld()
    await openRows(
      world,
      rowsPath({ sort: 'status', dir: 'desc', filter: [['status', '=', 'paid']] }),
    )
    expect(world.runs()).toHaveLength(0)
    expect(document.querySelector('[data-slot="sort"]')?.textContent).toContain('status')
    expect(document.querySelector('[data-slot="statement"]')?.textContent).toContain('$1')
  })

  it('names the production target and still waits for the press', async () => {
    const world = readyWorld()
    world.objects.set('table|"public"."orders"', ordersObject())
    const { user } = await openRows(world, rowsPath({}, PROD_TARGET))
    expect(document.querySelector('[data-production-cue="true"]')?.textContent).toContain(
      'production target',
    )
    expect(world.runs()).toHaveLength(0)
    await readFirst(user)
    expect(world.runs()[0]?.path).toBe('/api/v1/targets/shop%2Fplatform%2Fproduction/queries')
  })

  it('has no way to change a row: no edit, insert, delete or run-this-write control', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    await readFirst(user)
    const labels = [
      ...screen.getAllByRole('button').map((b) => b.textContent ?? ''),
      ...screen.getAllByRole('link').map((a) => a.textContent ?? ''),
    ].join('|')
    expect(labels).not.toMatch(/\b(insert|delete|update|edit row|drop|truncate)\b/i)
  })
})

describe('sort, filter and paging', () => {
  it('adds a filter through the form: the link holds it and the value goes as a parameter', async () => {
    const world = readyWorld()
    const { user, router } = await openRows(world)
    await user.click(screen.getByRole('combobox', { name: 'Column' }))
    await user.click(await screen.findByRole('option', { name: 'status' }))
    await user.type(screen.getByLabelText('Value'), "paid'; DROP TABLE orders; --")
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        object: ['table', 'public', 'orders'],
        tab: 'rows',
        filter: [['status', '=', "paid'; DROP TABLE orders; --"]],
      }),
    )
    // Adding a filter before the first press reads nothing.
    expect(world.runs()).toHaveLength(0)
    await readFirst(user)
    const sent = body(world.runs()[0])
    expect(sent.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nWHERE "status" = $1\nORDER BY "id" ASC\nLIMIT 101',
    )
    expect(sent.params).toEqual(["paid'; DROP TABLE orders; --"])
    expect(sent.sql).not.toContain('DROP')
  })

  it('offers only the allowed operators, and ILIKE only for text columns', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    await user.click(screen.getByRole('combobox', { name: 'Column' }))
    await user.click(await screen.findByRole('option', { name: 'total' }))
    await user.click(screen.getByRole('combobox', { name: 'Operator' }))
    const numeric = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(numeric).toEqual([
      'Is equal to',
      'Is not equal to',
      'Is less than',
      'Is at most',
      'Is greater than',
      'Is at least',
      'Is null',
      'Is not null',
    ])
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('combobox', { name: 'Column' }))
    await user.click(await screen.findByRole('option', { name: 'status' }))
    await user.click(screen.getByRole('combobox', { name: 'Operator' }))
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toContain(
      'Matches, ignoring case',
    )
  })

  it('filters with IS NULL without a value and sends no parameter', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    await user.click(screen.getByRole('combobox', { name: 'Column' }))
    await user.click(await screen.findByRole('option', { name: 'total' }))
    await user.click(screen.getByRole('combobox', { name: 'Operator' }))
    await user.click(await screen.findByRole('option', { name: 'Is null' }))
    expect(screen.queryByLabelText('Value')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await readFirst(user)
    const sent = body(world.runs()[0])
    expect(sent.sql).toContain('WHERE "total" IS NULL')
    expect(sent.params).toEqual([])
  })

  it('removes a filter and caps them at five', async () => {
    const world = readyWorld()
    const filter = [1, 2, 3, 4, 5].map((n) => ['total', '>', String(n)] as ['total', '>', string])
    const { user } = await openRows(world, rowsPath({ filter }))
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeDisabled()
    expect(screen.getByText('At most 5 filters.')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Filters, all of which must hold' })
    await user.click(
      within(list).getAllByRole('button', { name: 'Remove filter' })[0] as HTMLElement,
    )
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4))
  })

  it('reads the first page again when the sort changes after a read, and not before', async () => {
    const world = readyWorld()
    const { user, router } = await openRows(world)
    await readFirst(user)
    expect(world.runs()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Sort by status' }))
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    expect(body(world.runs()[1]).sql).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "status" ASC, "id" ASC\nLIMIT 101',
    )
    expect(router.state.location.search).toMatchObject({ sort: 'status' })
    await user.click(screen.getByRole('button', { name: 'Sort by status' }))
    await waitFor(() => expect(world.runs()).toHaveLength(3))
    expect(body(world.runs()[2]).sql).toContain('ORDER BY "status" DESC, "id" ASC')
    expect(router.state.location.search).toMatchObject({ sort: 'status', dir: 'desc' })
    await user.click(screen.getByRole('button', { name: 'Sort by status' }))
    await waitFor(() => expect(world.runs()).toHaveLength(4))
    expect(body(world.runs()[3]).sql).toContain('ORDER BY "id" ASC')
    expect(router.state.location.search.sort).toBeUndefined()
  })

  it('pages by the primary key: the next page starts after the last key, as a parameter', async () => {
    const world = readyWorld()
    world.run = (_body, call) => ({
      status: 200,
      body: resultFixture({ rows: call === 1 ? orderRows(101) : orderRows(30, 101) }),
    })
    const { user } = await openRows(world)
    let grid = await readFirst(user)
    expect(grid).toHaveAttribute('data-rows', '100')
    expect(document.querySelector('[data-note="paging"]')?.textContent).toContain('do not shift')
    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    const second = body(world.runs()[1])
    expect(second.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nWHERE ("id" > $1)\nORDER BY "id" ASC\nLIMIT 101',
    )
    expect(second.params).toEqual(['u-00100'])
    grid = await screen.findByTestId('grid')
    await waitFor(() => expect(grid).toHaveAttribute('data-rows', '130'))
    // 130 rows are all there are: nothing more is offered.
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
    expect(grid).toHaveAttribute('data-state', 'ready')
  })

  it('pages by offset, and says rows may shift, when the order is not the key', async () => {
    const world = readyWorld()
    world.run = (_body, call) => ({
      status: 200,
      body: resultFixture({ rows: call === 1 ? orderRows(101) : orderRows(5, 101) }),
    })
    const { user } = await openRows(world, rowsPath({ sort: 'status' }))
    await readFirst(user)
    expect(document.querySelector('[data-note="order"]')?.textContent).toContain('sort you chose')
    expect(document.querySelector('[data-note="paging"]')?.textContent).toContain('may shift')
    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    const second = body(world.runs()[1])
    expect(second.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "status" ASC, "id" ASC\nLIMIT 101\nOFFSET 100',
    )
    expect(second.params).toEqual([])
  })

  it('says there is no order when there is no primary key and no sort', async () => {
    const world = readyWorld()
    world.objects.set('table|"public"."orders"', ordersObject({ constraints: [] }))
    const { user } = await openRows(world)
    await readFirst(user)
    expect(body(world.runs()[0]).sql).toBe('SELECT *\nFROM "public"."orders"\nLIMIT 101')
    expect(document.querySelector('[data-note="order"]')?.textContent).toContain(
      'order of rows is not defined',
    )
  })

  it('falls back to an offset, and says so, when the key of the last row is masked', async () => {
    const world = readyWorld()
    world.run = (_body, call) => ({
      status: 200,
      body: resultFixture({
        columns: [
          { name: 'id', type: 'uuid', masked: true },
          { name: 'status', type: 'text', masked: false },
          { name: 'total', type: 'numeric', masked: false },
        ],
        rows:
          call === 1
            ? orderRows(101).map((row) => [null, row[1] ?? null, row[2] ?? null])
            : orderRows(2, 101),
      }),
    })
    const { user } = await openRows(world)
    await readFirst(user)
    expect(document.querySelector('[data-note="paging"]')?.textContent).toContain(
      'could not be sent back',
    )
    expect(document.querySelector('[data-note="masked"]')?.textContent).toContain('1 columns')
    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    expect(body(world.runs()[1]).sql).toContain('OFFSET 100')
    expect(body(world.runs()[1]).sql).not.toContain('WHERE')
  })

  it('stops at the most rows it loads in one session and says so', async () => {
    const world = readyWorld()
    world.run = (_body, call) => ({
      status: 200,
      body: resultFixture({ rows: orderRows(101, (call - 1) * 100 + 1) }),
    })
    const { user } = await openRows(world)
    await readFirst(user)
    for (let page = 2; page <= 50; page += 1) {
      await user.click(await screen.findByRole('button', { name: 'Load more rows' }))
      await waitFor(() => expect(world.runs()).toHaveLength(page))
      await waitFor(() =>
        expect(screen.getByTestId('grid')).toHaveAttribute('data-rows', String(page * 100)),
      )
    }
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
    expect(document.querySelector('[data-note="limit"]')?.textContent).toContain(
      '5,000 loaded rows',
    )
  }, 120_000)
})

describe('what a result says about itself', () => {
  it('shows a page that has more rows as partial, naming how many were read', async () => {
    const world = readyWorld()
    world.run = () => ({ status: 200, body: resultFixture({ rows: orderRows(101) }) })
    const { user } = await openRows(world)
    const grid = await readFirst(user)
    expect(grid).toHaveAttribute('data-state', 'partial')
    expect(grid).toHaveAttribute('data-rows', '100')
    expect(screen.getByRole('button', { name: 'Load more rows' })).toBeInTheDocument()
  })

  it('shows a whole result as ready, with the time it took', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    const grid = await readFirst(user)
    expect(grid).toHaveAttribute('data-state', 'ready')
    expect(document.querySelector('[data-result-meta="true"]')?.textContent).toContain(
      '3 rows read in 7 ms',
    )
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
  })

  it('tells that the server cut a page, with its limit, and still offers the next rows', async () => {
    const world = readyWorld()
    world.run = () => ({
      status: 200,
      body: resultFixture({
        rows: orderRows(40),
        truncated: true,
        truncation: { reason: 'bytes', cap: 5_242_880 },
      }),
    })
    const { user } = await openRows(world)
    const grid = await readFirst(user)
    expect(grid).toHaveAttribute('data-truncated', 'The 5,242,880 byte limit')
    expect(grid).toHaveAttribute('data-rows', '40')
    expect(screen.getByRole('button', { name: 'Load more rows' })).toBeInTheDocument()
  })

  it('names the masked columns and the relations with row level security', async () => {
    const world = readyWorld()
    world.run = () => ({
      status: 200,
      body: resultFixture({
        columns: [
          { name: 'id', type: 'uuid', masked: false },
          { name: 'status', type: 'text', masked: true },
          { name: 'total', type: 'numeric', masked: true },
        ],
        rlsRelations: ['public.orders', `public.x${BIDI}y`],
      }),
    })
    const { user } = await openRows(world)
    const grid = await readFirst(user)
    expect(grid).toHaveAttribute('data-masked', '2')
    expect(document.querySelector('[data-note="masked"]')?.textContent).toContain('2 columns')
    const rls = document.querySelector('[data-note="rls"]')
    expect(rls?.textContent).toContain('bypasses row level security')
    expect(rls?.textContent).toContain('⟨U+202E⟩')
    expect(rls?.textContent).not.toContain(BIDI)
  })

  it('says a read that returned no rows is empty only after it succeeded', async () => {
    const world = readyWorld()
    world.run = () => ({ status: 200, body: resultFixture({ rows: [] }) })
    const { user } = await openRows(world)
    const grid = await readFirst(user)
    expect(within(grid).getByText('No rows')).toBeInTheDocument()
    expect(grid).toHaveAttribute('data-state', 'ready')
    expect(screen.queryByText(/Could not read/)).toBeNull()
  })

  it('shows rows read a long time ago as stale, and a refresh reads the first page again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const world = readyWorld()
    const mounted = mountBrowse(rowsPath(), world)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await screen.findByRole('button', { name: 'Read rows' })
    await readFirst(user)
    expect(screen.getByTestId('grid')).toHaveAttribute('data-state', 'ready')
    await act(async () => {
      vi.advanceTimersByTime(6 * 60_000)
    })
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveAttribute('data-state', 'stale'))
    expect(screen.getByTestId('grid')).toHaveAttribute('data-rows', '3')
    await user.click(screen.getByRole('button', { name: 'Refresh rows' }))
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveAttribute('data-state', 'ready'))
    expect(mounted.router).toBeDefined()
  })

  it('keeps the rows and the press when the read of the object turns old', async () => {
    // An object read older than a minute is shown under a banner above the panel.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const world = readyWorld()
    const mounted = mountBrowse(rowsPath(), world)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await screen.findByRole('button', { name: 'Read rows' })
    await readFirst(user)
    // The clock moves on without a tick: nothing renders until the person does something.
    vi.setSystemTime(Date.now() + 2 * 60_000)
    // Sorting changes the link, which builds the panel again under the older read.
    await user.click(screen.getByRole('button', { name: 'Sort by status' }))
    await waitFor(() =>
      expect(mounted.router.state.location.search).toMatchObject({ sort: 'status' }),
    )
    // The object read is now an earlier one, under a banner; the panel below keeps what it read.
    expect(await screen.findByText(/Showing an earlier read of object details/)).toBeInTheDocument()
    await waitFor(() => expect(world.runs()).toHaveLength(2))
    expect(body(world.runs()[1]).sql).toContain('ORDER BY "status" ASC, "id" ASC')
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveAttribute('data-rows', '3'))
    expect(screen.getByRole('button', { name: 'Read again' })).toBeInTheDocument()
  })
})

describe('a refusal or a failure is never an empty table', () => {
  it('shows a refusal as a refusal, with the server message and code', async () => {
    const world = readyWorld()
    world.run = () => ({
      status: 422,
      body: {
        code: 'QUERY_CONSTRUCT_UNSUPPORTED',
        message: 'The statement uses a construct the data-read path does not support.',
      },
    })
    const { user } = await openRows(world)
    await user.click(screen.getByRole('button', { name: 'Read rows' }))
    const refused = await waitFor(() => {
      const el = document.querySelector('[data-state="refused"]')
      if (el === null) throw new Error('no refusal yet')
      return el as HTMLElement
    })
    expect(refused).toHaveTextContent('The server refused this read')
    expect(refused).toHaveTextContent('construct the data-read path does not support')
    expect(refused).toHaveTextContent('QUERY_CONSTRUCT_UNSUPPORTED')
    expect(refused).toHaveTextContent('This is not an empty table')
    expect(screen.queryByTestId('grid')).toBeNull()
    expect(screen.queryByText('No rows')).toBeNull()
  })

  it('shows a permission refusal of the server the same way', async () => {
    const world = readyWorld()
    world.run = () => ({
      status: 403,
      body: { code: 'PERMISSION_DENIED', message: 'You may not read data on this target.' },
    })
    const { user } = await openRows(world)
    await user.click(screen.getByRole('button', { name: 'Read rows' }))
    expect(await screen.findByText(/You may not read data on this target\./)).toBeInTheDocument()
    expect(screen.getByText('PERMISSION_DENIED')).toBeInTheDocument()
    expect(document.querySelector('[data-state="refused"]')).not.toBeNull()
  })

  it('shows a failed read as failed, with a retry, never as empty', async () => {
    const world = readyWorld()
    world.run = (_body, call) =>
      call === 1
        ? { status: 500, body: { code: 'INTERNAL_ERROR', message: 'The reader is down.' } }
        : { status: 200, body: resultFixture() }
    const { user } = await openRows(world)
    await user.click(screen.getByRole('button', { name: 'Read rows' }))
    expect(await screen.findByText(/The reader is down\./)).toBeInTheDocument()
    expect(screen.getByText('INTERNAL_ERROR')).toBeInTheDocument()
    expect(screen.getByText(/This does not mean there is no rows/)).toBeInTheDocument()
    expect(screen.queryByTestId('grid')).toBeNull()
    expect(screen.queryByText('No rows')).toBeNull()
    expect(document.querySelector('[data-state="refused"]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('grid')).toHaveAttribute('data-rows', '3')
  })

  it('keeps the rows already read when a later page fails, and retries only that page', async () => {
    const world = readyWorld()
    world.run = (_body, call) =>
      call === 2
        ? { status: 500, body: { code: 'INTERNAL_ERROR', message: 'The reader is down.' } }
        : {
            status: 200,
            body: resultFixture({ rows: call === 1 ? orderRows(101) : orderRows(10, 101) }),
          }
    const { user } = await openRows(world)
    await readFirst(user)
    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    const alert = await waitFor(() => {
      const el = document.querySelector('[data-state="more-failed"]')
      if (el === null) throw new Error('no failure yet')
      return el as HTMLElement
    })
    expect(alert).toHaveTextContent(
      'Could not read the next rows: The reader is down. (INTERNAL_ERROR)',
    )
    expect(screen.getByTestId('grid')).toHaveAttribute('data-rows', '100')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveAttribute('data-rows', '110'))
    // The retry asked for the same page: the key of the last row of the first page.
    expect(body(world.runs()[2]).params).toEqual(['u-00100'])
  })

  it('says an object whose read lists no column cannot be read, instead of showing an empty table', async () => {
    const world = readyWorld()
    world.objects.set('table|"public"."orders"', ordersObject({ columns: [] }))
    mountBrowse(rowsPath(), world)
    expect(await screen.findByText(/lists no column for this object/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read rows' })).toBeNull()
    expect(screen.queryByTestId('grid')).toBeNull()
    expect(world.runs()).toHaveLength(0)
  })
})

describe('who may read rows', () => {
  it('names the missing permission and the scope of the tier, and offers no read', async () => {
    const world = readyWorld()
    world.permissions = ['schema.read']
    mountBrowse(rowsPath(), world)
    const state = await waitFor(() => {
      const el = document.querySelector('[data-state="not-permitted"]')
      if (el === null) throw new Error('no state yet')
      return el as HTMLElement
    })
    expect(state).toHaveTextContent('You do not have access to rows of this object')
    expect(state).toHaveTextContent('data.read')
    expect(state).toHaveTextContent('data.read:nonprod')
    expect(screen.queryByRole('button', { name: 'Read rows' })).toBeNull()
    expect(world.runs()).toHaveLength(0)
  })

  it('does not take a grant on another environment as a grant for production', async () => {
    const world = readyWorld()
    world.grants = [
      {
        permission: 'data.read',
        scopes: [{ kind: 'environment', environmentId: 'env_00000000000000000000000099' }],
      },
    ]
    mountBrowse(rowsPath({}, PROD_TARGET), world)
    expect(await screen.findByText(/Missing scope:/)).toBeInTheDocument()
    expect(screen.getByText('data.read:prod')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read rows' })).toBeNull()
  })

  it('opens for a grant bound to the target by its project', async () => {
    const world = readyWorld()
    world.grants = [
      {
        permission: 'data.read',
        scopes: [{ kind: 'project', projectId: 'prj_00000000000000000000000001' }],
      },
    ]
    await openRows(world)
    expect(screen.getByRole('button', { name: 'Read rows' })).toBeEnabled()
  })

  it('says data reads are off for a target whose setting disables them, and offers no read', async () => {
    const world = readyWorld()
    world.grants = [GLOBAL_GRANT, { permission: 'access.read', scopes: [{ kind: 'global' }] }]
    world.policy = {
      rules: [
        {
          id: 'data.read',
          version: 1,
          description: 'Who may read rows.',
          appliesTo: ['query.run'],
          severity: 'deny',
          defaults: { mode: 'by_tier', sensitiveColumns: [] },
          settings: [
            {
              scopeKind: 'installation',
              scopeId: 'installation',
              revision: 2,
              params: { mode: 'disabled', sensitiveColumns: [] },
              createdAt: new Date().toISOString(),
              operationId: null,
            },
          ],
        },
      ],
    }
    mountBrowse(rowsPath(), world)
    const off = await waitFor(() => {
      const el = document.querySelector('[data-state="reads-off"]')
      if (el === null) throw new Error('no state yet')
      return el as HTMLElement
    })
    expect(off).toHaveTextContent('The data-read setting of this target is disabled')
    expect(off).toHaveTextContent('This does not mean the object has no rows')
    expect(
      within(off).getByRole('link', { name: 'Open the target configuration' }),
    ).toHaveAttribute('href', '/t/shop/platform/staging/configuration#data-read')
    expect(screen.getByText('Data reads are off for this target')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read rows' })).toBeNull()
    expect(world.runs()).toHaveLength(0)
  })

  it('stays open, and says the setting is unread, when the setting cannot be read', async () => {
    const world = readyWorld()
    world.grants = [GLOBAL_GRANT, { permission: 'access.read', scopes: [{ kind: 'global' }] }]
    // No policy answer: the fake server answers 404.
    await openRows(world)
    expect(
      await screen.findByText(/Could not read the data-read setting of this target/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read rows' })).toBeEnabled()
  })

  it('does not ask for the setting of a person who cannot read it', async () => {
    const world = readyWorld()
    await openRows(world)
    expect(world.sent.some((s) => s.path.includes('policy-settings'))).toBe(false)
  })
})

describe('what a link can and cannot do', () => {
  it('ignores a filter on a column the object does not have, and says so', async () => {
    const world = readyWorld()
    const { user } = await openRows(
      world,
      rowsPath({
        filter: [
          ['ghost"; DROP TABLE x; --', '=', '1'],
          ['status', '=', 'paid'],
        ],
      }),
    )
    const items = within(
      screen.getByRole('list', { name: 'Filters, all of which must hold' }),
    ).getAllByRole('listitem')
    expect(items[0]).toHaveAttribute('data-ignored', 'true')
    expect(items[0]).toHaveTextContent('ignored')
    expect(items[1]).not.toHaveAttribute('data-ignored')
    await readFirst(user)
    const sent = body(world.runs()[0])
    expect(sent.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nWHERE "status" = $1\nORDER BY "id" ASC\nLIMIT 101',
    )
    expect(sent.params).toEqual(['paid'])
    expect(sent.sql).not.toContain('ghost')
  })

  it('ignores a sort on a column the object does not have, and says so', async () => {
    const world = readyWorld()
    const { user } = await openRows(world, rowsPath({ sort: 'nope"; DROP TABLE x; --' }))
    expect(document.querySelector('[data-slot="sort-ignored"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="sort"]')).toBeNull()
    await readFirst(user)
    expect(body(world.runs()[0]).sql).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "id" ASC\nLIMIT 101',
    )
  })

  it('shows the details tab for a tab it does not know, and reads nothing', async () => {
    const world = readyWorld()
    mountBrowse(
      `${rowsPath().split('?')[0]}?object=%5B%22table%22%2C%22public%22%2C%22orders%22%5D&tab=evil`,
      world,
    )
    expect(await screen.findByRole('table', { name: 'Columns' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read rows' })).toBeNull()
    expect(world.runs()).toHaveLength(0)
  })

  it('opens in the SQL editor with the first page and the values as escaped literals, and never runs', async () => {
    const world = readyWorld()
    await openRows(
      world,
      rowsPath({
        sort: 'status',
        dir: 'desc',
        filter: [['status', '=', "it's; DROP TABLE orders"]],
      }),
    )
    const link = screen.getByRole('link', { name: 'Open in SQL editor' })
    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('/t/shop/platform/staging/sql?sql=')).toBe(true)
    const parsed = parseSqlLink(href.slice(href.indexOf('?')))
    expect(parsed.sql).toEqual({
      kind: 'text',
      sql: `SELECT *\nFROM "public"."orders"\nWHERE "status" = 'it''s; DROP TABLE orders'\nORDER BY "status" DESC, "id" ASC\nLIMIT 100`,
    })
    expect(world.runs()).toHaveLength(0)
  })
})

describe('hostile identifiers', () => {
  const NAME = 'a"; DROP TABLE x; --'

  it('quotes the table and its columns, and shows them as text', async () => {
    const world = readyWorld()
    const hostile = ref({ name: NAME, key: ['public', NAME] })
    const column = (name: string) => ({
      name,
      type: 'text',
      nullable: true,
      default: null,
      generated: null,
      identity: null,
    })
    world.objects.set(
      `table|"public"."${NAME.replaceAll('"', '""')}"`,
      objectFixture(hostile, {
        columns: [column(`bidi${BIDI}col`), column(`zero${ZWSP}wide`), column(NAME)],
        constraints: [
          {
            name: 'pk',
            type: 'primary_key',
            definition: `PRIMARY KEY ("bidi${BIDI}col")`,
            validated: true,
          },
        ],
      }),
    )
    const href = objectHref(
      TARGET,
      { kind: 'table', key: ['public', NAME] },
      {
        tab: 'rows',
        sort: `zero${ZWSP}wide`,
        filter: [[NAME, 'ILIKE', '%x%']],
      },
    )
    if (href === undefined) throw new Error('no link')
    const mounted = mountBrowse(href, world)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Read rows' })
    const statement = document.querySelector('[data-slot="statement"]') as HTMLElement
    expect(statement.textContent).toContain('⟨U+202E⟩')
    expect(document.body.textContent).not.toContain(BIDI)
    expect(document.body.textContent).not.toContain(ZWSP)
    await user.click(screen.getByRole('button', { name: 'Read rows' }))
    await screen.findByTestId('grid')
    const sent = body(world.runs()[0])
    expect(sent.sql).toBe(
      [
        'SELECT *',
        'FROM "public"."a""; DROP TABLE x; --"',
        'WHERE "a""; DROP TABLE x; --" ILIKE $1',
        `ORDER BY "zero${ZWSP}wide" ASC, "bidi${BIDI}col" ASC`,
        'LIMIT 101',
      ].join('\n'),
    )
    expect(sent.params).toEqual(['%x%'])
    expect(mounted.router).toBeDefined()
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('accessibility', () => {
  it('has no axe violations on the idle panel', async () => {
    const world = readyWorld()
    await openRows(world, rowsPath({ filter: [['status', '=', 'paid']], sort: 'status' }))
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations on a read, a refusal and a not-permitted state', async () => {
    const world = readyWorld()
    const { user } = await openRows(world)
    await readFirst(user)
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const refused = readyWorld()
    refused.run = () => ({
      status: 422,
      body: { code: 'QUERY_CONSTRUCT_UNSUPPORTED', message: 'Not supported.' },
    })
    const second = await openRows(refused)
    await second.user.click(screen.getByRole('button', { name: 'Read rows' }))
    await waitFor(() => expect(document.querySelector('[data-state="refused"]')).not.toBeNull())
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const denied = readyWorld()
    denied.permissions = []
    mountBrowse(rowsPath(), denied)
    await waitFor(() =>
      expect(document.querySelector('[data-state="not-permitted"]')).not.toBeNull(),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
