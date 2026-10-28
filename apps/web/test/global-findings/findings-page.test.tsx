import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  filtersOf,
  globalFindingsSearch,
  searchString,
} from '../../src/features/global-findings/search.ts'
import { BIDI, finding, HOSTILE, mountApp, ulid, World, worldWithFindings } from './support.tsx'

afterEach(cleanup)

const CAPTION = 'Findings across the databases you may read, newest first'
const LIST = '/api/v1/findings'

const table = (): Promise<HTMLElement> => screen.findByRole('table', { name: CAPTION })

function lastQuery(world: World): URLSearchParams {
  const request = [...world.requests].reverse().find((r) => r.startsWith(LIST))
  return new URL(request ?? LIST, 'http://x').searchParams
}

describe('the findings search parameters', () => {
  it('keeps only allowlist values and a target path that is three slugs', () => {
    expect(
      globalFindingsSearch({
        severity: 'critical',
        state: 'all',
        kind: 'drift',
        target: 'shop/platform/staging',
      }),
    ).toEqual({
      severity: 'critical',
      state: 'all',
      kind: 'drift',
      target: 'shop/platform/staging',
    })
    expect(
      globalFindingsSearch({
        severity: '<script>',
        state: ['open'],
        kind: 'DROP TABLE x',
        target: 'tgt_01M4S9',
      }),
    ).toEqual({ severity: undefined, state: undefined, kind: undefined, target: undefined })
    for (const target of [
      '../../etc/passwd',
      'a/b',
      'a/b/c/d',
      'A/b/c',
      'a/b/c‮',
      'a/b/<c>',
      7,
      null,
    ]) {
      expect(globalFindingsSearch({ target }).target, String(target)).toBeUndefined()
    }
  })

  it('asks for the open findings unless the address says otherwise, and writes only validated values', () => {
    expect(filtersOf({})).toEqual({ state: 'open' })
    expect(filtersOf({ severity: 'info', kind: 'health', target: 'a/b/c' })).toEqual({
      state: 'open',
      severity: 'info',
      kind: 'health',
      target: 'a/b/c',
    })
    expect(searchString({ severity: 'info', state: 'open', kind: 'health' })).toBe(
      '?severity=info&kind=health',
    )
    expect(searchString({ state: 'resolved', target: 'shop/platform/staging' })).toBe(
      '?state=resolved&target=shop/platform/staging',
    )
    expect(searchString({ target: '<script>' })).toBe('')
    expect(searchString({})).toBe('')
  })
})

describe('the findings page', () => {
  it('reads the open findings of every database and lists severity, kind, object, database, times and state', async () => {
    const world = worldWithFindings()
    mountApp('/findings', world)
    const rows = within(await table()).getAllByRole('row')
    // The header row and the two findings, newest first as the server sent them.
    expect(rows).toHaveLength(3)
    expect(within(rows[1] as HTMLElement).getByText('Warning')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('public.orders_1')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText(/First seen/)).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText(/Last seen/)).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Seen 3 times')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('Critical')).toBeInTheDocument()
    const query = lastQuery(world)
    expect([query.get('state'), query.get('limit')]).toEqual(['open', '50'])
    expect(query.has('target')).toBe(false)
    expect(screen.getByRole('heading', { level: 1, name: 'Findings' })).toBeInTheDocument()
  })

  it('links the database of a finding to its findings, from typed slugs', async () => {
    mountApp('/findings', worldWithFindings())
    const t = await table()
    expect(
      within(t).getByRole('link', { name: 'Open the findings of shop/platform/staging' }),
    ).toHaveAttribute('href', '/t/shop/platform/staging/findings')
    expect(
      within(t).getByRole('link', { name: 'Open the findings of billing/api/live' }),
    ).toHaveAttribute('href', '/t/billing/api/live/findings')
    expect(
      within(t)
        .getAllByRole('link', { name: 'Only this database' })
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/findings?target=shop/platform/staging', '/findings?target=billing/api/live'])
  })

  it('passes the filters of the address to the request', async () => {
    const world = worldWithFindings()
    mountApp('/findings?severity=critical&state=all&kind=drift&target=shop/platform/staging', world)
    await table()
    const query = lastQuery(world)
    expect([
      query.get('severity'),
      query.get('state'),
      query.get('kind'),
      query.get('target'),
    ]).toEqual(['critical', 'all', 'drift', 'shop/platform/staging'])
    expect(screen.getByLabelText('Severity')).toHaveValue('critical')
    expect(screen.getByLabelText('State')).toHaveValue('all')
    expect(screen.getByLabelText('Kind')).toHaveValue('drift')
    expect(
      screen.getByText('Showing the findings of shop/platform/staging only.'),
    ).toBeInTheDocument()
    // That database has no "only this database" link: the list is limited to it already.
    expect(screen.getByRole('link', { name: 'Show every database' })).toHaveAttribute(
      'href',
      '/findings?severity=critical&state=all&kind=drift',
    )
  })

  it('offers every kind the server returns, and keeps advisor and statements in the address (TC-036)', async () => {
    const world = worldWithFindings()
    mountApp('/findings?kind=advisor', world)
    await table()
    // The contract's kinds, not only drift and health: every finding of a target that has only
    // advisor findings used to be unreachable by a filter.
    const options = within(screen.getByLabelText('Kind')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Any',
      'Drift',
      'Health',
      'Advisor',
      'Statements',
    ])
    expect(lastQuery(world).get('kind')).toBe('advisor')
    expect(screen.getByLabelText('Kind')).toHaveValue('advisor')
  })

  it('ignores a hostile filter of the address', async () => {
    const world = worldWithFindings()
    mountApp('/findings?severity=%3Cscript%3E&state=bogus&kind=%00&target=..%2F..%2Fetc', world)
    await table()
    const query = lastQuery(world)
    expect(query.get('severity')).toBeNull()
    expect(query.get('state')).toBe('open')
    expect(query.get('kind')).toBeNull()
    expect(query.get('target')).toBeNull()
    expect(screen.queryByText(/Showing the findings of/)).toBeNull()
  })

  it('changes a filter through the address, and reads again', async () => {
    const user = userEvent.setup()
    const world = worldWithFindings()
    const { router } = mountApp('/findings', world)
    await table()
    await user.selectOptions(screen.getByLabelText('Severity'), 'warning')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ severity: 'warning' }))
    await waitFor(() => expect(lastQuery(world).get('severity')).toBe('warning'))
    await user.selectOptions(screen.getByLabelText('State'), 'resolved')
    await waitFor(() => expect(lastQuery(world).get('state')).toBe('resolved'))
  })

  it('limits the list to one database with the link of a row, and back with the link of the note', async () => {
    const user = userEvent.setup()
    const world = worldWithFindings()
    const { router } = mountApp('/findings', world)
    const t = await table()
    await user.click(
      within(t).getAllByRole('link', { name: 'Only this database' })[0] as HTMLElement,
    )
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ target: 'shop/platform/staging' }),
    )
    await waitFor(() => expect(lastQuery(world).get('target')).toBe('shop/platform/staging'))
    await user.click(await screen.findByRole('link', { name: 'Show every database' }))
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty('target', 'shop/platform/staging'),
    )
  })

  it('loads more with the cursor of the server', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.globalFindings = (url) =>
      url.searchParams.get('cursor') === 'next'
        ? { items: [finding(3)], nextCursor: null }
        : { items: [finding(1)], nextCursor: 'next' }
    mountApp('/findings', world)
    await user.click(await screen.findByRole('button', { name: 'Load more findings' }))
    await screen.findByText('public.orders_3')
    expect(screen.getByText('public.orders_1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more findings' })).toBeNull()
    expect(lastQuery(world).get('cursor')).toBe('next')
  })
})

describe('the findings list is a truthful read', () => {
  it('shows a failed read as failed with its code and a retry, never as an empty list', async () => {
    const user = userEvent.setup()
    const world = worldWithFindings()
    world.failures.set(LIST, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The control store did not answer.',
    })
    mountApp('/findings', world)
    expect(await screen.findByText(/Could not read findings/)).toBeInTheDocument()
    expect(document.body.textContent).toContain('INTERNAL_ERROR')
    expect(screen.queryByRole('table')).toBeNull()
    expect(document.body.textContent).not.toContain('no open finding')
    world.failures.clear()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await table()
  })

  it('names the missing permission when the read is refused, not an empty list', async () => {
    const world = worldWithFindings()
    world.failures.set(LIST, { status: 403, code: 'PERMISSION_DENIED' })
    mountApp('/findings', world)
    expect(await screen.findByText(/diagnostics\.read/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows an earlier read as stale with its age and a refresh when the list cannot be refreshed', async () => {
    const user = userEvent.setup()
    const world = worldWithFindings()
    const { queryClient } = mountApp('/findings', world)
    await table()
    world.failures.set(LIST, { status: 500, code: 'INTERNAL_ERROR' })
    await queryClient.refetchQueries({ queryKey: ['global-findings'] })
    expect(await screen.findByText(/earlier read/i)).toBeInTheDocument()
    // The earlier findings are still there.
    expect(within(await table()).getAllByRole('row')).toHaveLength(3)
    world.failures.clear()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByText(/earlier read/i)).toBeNull())
  })

  it('says the list is partial while the server has more findings than the pages read', async () => {
    mountApp('/findings', worldWithFindings([finding(1)], 'next'))
    await table()
    expect(
      await screen.findByText(/More findings exist than the pages read so far\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more findings' })).toBeInTheDocument()
  })

  it('says there is no open finding only after a read that succeeded', async () => {
    mountApp('/findings', worldWithFindings([]))
    expect(
      await screen.findByText('The read succeeded: no open finding on the databases you may read.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says no finding matches the filters when a filtered read is empty', async () => {
    mountApp('/findings?severity=critical', worldWithFindings([]))
    expect(
      await screen.findByText('The read succeeded: no finding matches these filters.'),
    ).toBeInTheDocument()
  })

  it('shows a loading state while the list is read', async () => {
    const world = worldWithFindings()
    let release: () => void = () => undefined
    world.delays.set(
      LIST,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp('/findings', world)
    await screen.findByRole('heading', { level: 1, name: 'Findings' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText(/The read succeeded/)).toBeNull()
    release()
    await table()
  })
})

describe('untrusted text on the findings page', () => {
  it("shows a finding's summary, code and object as text, with hidden characters made visible", async () => {
    mountApp(
      '/findings',
      worldWithFindings([
        finding(1, {
          summary: `Dropped ${HOSTILE}`,
          object: `public.${HOSTILE}`,
          code: 'schema_drift',
        }),
      ]),
    )
    const t = await table()
    expect(t.querySelectorAll('script')).toHaveLength(0)
    expect(t.innerHTML).not.toContain('<script>alert')
    expect(t.textContent).toContain('<script>alert(1)</script>')
    expect(t.textContent).toContain('⟨U+202E⟩')
    expect(t.textContent).not.toContain(BIDI)
  })

  it('does not link a database whose path is not three slugs, and says it is not linked', async () => {
    mountApp(
      '/findings',
      worldWithFindings([
        finding(1, { targetPath: `Shop/${HOSTILE}/prod` }),
        finding(2, { targetPath: 'shop/platform/staging' }),
      ]),
    )
    const t = await table()
    expect(within(t).getAllByRole('link', { name: /^Open the findings of/ })).toHaveLength(1)
    expect(
      within(t).getByText('Not linked: the server sent a path the page cannot link.'),
    ).toBeInTheDocument()
    expect(t.querySelectorAll('script')).toHaveLength(0)
    expect(t.querySelector('a[href*="script"]')).toBeNull()
    expect(t.querySelector('a[href*="Shop"]')).toBeNull()
  })
})

describe('the findings page in the navigation', () => {
  it('is the second page of the overview section, current in its menu, with its own title', async () => {
    mountApp('/findings', worldWithFindings())
    await table()
    const menu = screen.getByRole('navigation', { name: 'Overview pages' })
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Overview', 'Findings'])
    expect(within(menu).getByRole('link', { name: 'Findings' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(menu).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(document.title).toBe('Findings · ExponetDB')
    // The rail item of the overview is the current section.
    expect(
      within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', {
        name: 'Overview',
      }),
    ).toHaveAttribute('aria-current', 'true')
  })

  it('is a command of the command menu', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/audit', worldWithFindings())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('combobox'), 'go to findings')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/findings'))
  })

  it('has no accessibility violations', async () => {
    mountApp('/findings', worldWithFindings())
    await table()
    expect(await axeViolations()).toEqual([])
  })

  it('keeps the ids of the findings out of the address', async () => {
    mountApp('/findings', worldWithFindings([finding(7)]))
    await table()
    expect(document.body.innerHTML).not.toContain(`href="/findings/${ulid(7)}`)
  })
})
