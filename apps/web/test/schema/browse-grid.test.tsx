import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { objectHref } from '../../src/features/schema/search.ts'
import {
  BrowseWorld,
  fingerprintFixture,
  mountBrowse,
  orderRows,
  ordersObject,
  overviewFixture,
  project,
  ref,
  resultFixture,
} from './browse-support.tsx'

// The real data grid (not the stand-in of browse.test.tsx): what the browser passes it must be
// what it takes, so a sort header, "Load more rows" and the page notes work end to end.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const TARGET = { product: 'shop', project: 'platform', environment: 'staging' }

function world(): BrowseWorld {
  const w = new BrowseWorld()
  project(w)
  w.sample('shop/platform/staging')
  w.overview = overviewFixture()
  w.fingerprint = fingerprintFixture()
  w.permissions = ['data.read']
  w.refs = [ref({ name: 'orders' })]
  w.objects.set('table|"public"."orders"', ordersObject())
  return w
}

describe('the row browser on the real grid', () => {
  it('shows the columns with their types, sorts by a header and loads more rows on the press', async () => {
    const w = world()
    w.run = (_body, call) => ({
      status: 200,
      body: resultFixture({
        rows: call === 2 ? orderRows(101) : call === 3 ? orderRows(10, 101) : orderRows(5),
      }),
    })
    const href = objectHref(TARGET, { kind: 'table', key: ['public', 'orders'] }, { tab: 'rows' })
    if (href === undefined) throw new Error('no link')
    const { router } = mountBrowse(href, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Read rows' }))
    const grid = await screen.findByRole('grid', { name: 'Rows of the object' })
    expect(grid).toHaveAttribute('aria-readonly', 'true')
    const header = within(grid).getByRole('columnheader', { name: /status/ })
    expect(header).toHaveAttribute('aria-sort', 'none')
    // Sorting is the server's: the header asks, the browser reads the first page again.
    await user.click(within(header).getByRole('button'))
    await waitFor(() => expect(w.runs()).toHaveLength(2))
    expect(router.state.location.search).toMatchObject({ sort: 'status' })
    await waitFor(() =>
      expect(
        within(screen.getByRole('grid', { name: 'Rows of the object' })).getByRole('columnheader', {
          name: /status/,
        }),
      ).toHaveAttribute('aria-sort', 'ascending'),
    )
    // The second answer has more rows than a page: the grid offers them, and only on the press.
    const more = await screen.findByRole('button', { name: 'Load more rows' })
    expect(screen.getByText('More rows are available.')).toBeInTheDocument()
    expect(w.runs()).toHaveLength(2)
    await user.click(more)
    await waitFor(() => expect(w.runs()).toHaveLength(3))
    await waitFor(() => expect(screen.getByText('All rows are loaded.')).toBeInTheDocument())
    expect(screen.getByText('110 rows loaded, 3 columns')).toBeInTheDocument()
  })
})
