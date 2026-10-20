import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { DEFAULT_ROW_LIMIT, SQL_ROW_LIMIT_KEY } from '../../src/lib/storage/sql-prefs.ts'
import { bodyOf, clearStorage, editor, SQL, select, type, world } from './helpers.tsx'
import { mountSql, resultFixture } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))
vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
  (await import('./stand-ins.tsx')).editorModule(),
)
vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
  (await import('./stand-ins.tsx')).gridModule(),
)

beforeEach(clearStorage)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

interface RunBody {
  readonly sql: string
  readonly queryId: string
  readonly maxRows?: number
}

async function chooseLimit(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: 'Row limit' }))
  await user.click(await screen.findByRole('option', { name }))
}

describe('the row limit', () => {
  it('sends the server default of 1,000 rows until a person chooses another', async () => {
    const w = world()
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    expect(await screen.findByRole('combobox', { name: 'Row limit' })).toHaveTextContent(
      '1,000 rows',
    )
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    const body = w.calls('POST', '/queries')[0]?.body as RunBody
    expect(body.maxRows).toBe(DEFAULT_ROW_LIMIT)
    expect(DEFAULT_ROW_LIMIT).toBe(1000)
  })

  it('offers 100, 500, 1,000 and 5,000 rows and sends the one chosen with every run', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await user.click(await screen.findByRole('combobox', { name: 'Row limit' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['100 rows', '500 rows', '1,000 rows', '5,000 rows'])
    await user.click(screen.getByRole('option', { name: '500 rows' }))

    await user.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() => expect(w.calls('POST', '/queries')).toHaveLength(1))
    await screen.findByTestId('grid')
    await chooseLimit(user, '5,000 rows')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() => expect(w.calls('POST', '/queries')).toHaveLength(2))
    const bodies = w.calls('POST', '/queries').map((s) => (s.body as RunBody).maxRows)
    expect(bodies).toEqual([500, 5000])
  })

  it('keeps the choice in this browser for the next visit', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    await editor()
    await chooseLimit(user, '100 rows')
    expect(window.localStorage.getItem(SQL_ROW_LIMIT_KEY)).toBe('100')
    cleanup()

    mountSql(SQL, world())
    expect(await screen.findByRole('combobox', { name: 'Row limit' })).toHaveTextContent('100 rows')
  })

  it('ignores a stored value that is not one of the limits', async () => {
    window.localStorage.setItem(SQL_ROW_LIMIT_KEY, '777')
    mountSql(SQL, world())
    expect(await screen.findByRole('combobox', { name: 'Row limit' })).toHaveTextContent(
      '1,000 rows',
    )
    cleanup()
    window.localStorage.setItem(SQL_ROW_LIMIT_KEY, 'not json {')
    mountSql(SQL, world())
    expect(await screen.findByRole('combobox', { name: 'Row limit' })).toHaveTextContent(
      '1,000 rows',
    )
  })

  it('works with a storage that throws on every read and write', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is full')
    })
    const w = world()
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await chooseLimit(user, '500 rows')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.maxRows).toBe(500)
  })

  it('names the chosen limit in the notice of a result cut at it', async () => {
    const user = userEvent.setup()
    const w = world()
    w.run = (body: RunBody) => ({
      status: 200,
      body: resultFixture({
        queryId: body.queryId,
        truncated: true,
        truncation: { reason: 'rows', cap: body.maxRows ?? 0 },
      }),
    })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await chooseLimit(user, '500 rows')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const notice = await screen.findByText(/cut at the 500 row limit/)
    expect(notice).toHaveTextContent('The rows shown are not all the rows.')
    expect(notice).toHaveTextContent('Choose a higher row limit to read more rows.')
  })

  it('offers no higher limit in the notice when the highest was already chosen', async () => {
    const user = userEvent.setup()
    const w = world()
    w.run = (body: RunBody) => ({
      status: 200,
      body: resultFixture({
        queryId: body.queryId,
        truncated: true,
        truncation: { reason: 'rows', cap: body.maxRows ?? 0 },
      }),
    })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await chooseLimit(user, '5,000 rows')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const notice = await screen.findByText(/cut at the 5,000 row limit/)
    expect(notice).not.toHaveTextContent('Choose a higher row limit')
  })

  it('says so when the server cut the read below the limit that was asked for', async () => {
    const w = world()
    w.run = (body: RunBody) => ({
      status: 200,
      body: resultFixture({
        queryId: body.queryId,
        truncated: true,
        truncation: { reason: 'rows', cap: 200 },
      }),
    })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    const notice = await screen.findByText(/cut at the 200 row limit/)
    expect(notice).toHaveTextContent(
      'You asked for at most 1,000 rows; the server limits this read to 200.',
    )
    expect(notice).not.toHaveTextContent('Choose a higher row limit')
  })

  it('does not send a row limit with an explain', async () => {
    const w = world()
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }))
    await screen.findByText('Total cost')
    expect(w.calls('POST', '/explain')[0]?.body).not.toHaveProperty('maxRows')
  })

  it('passes axe with the selector and has no selector in Draft mode', async () => {
    mountSql(SQL, world())
    await editor()
    expect(await axeViolations()).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Draft a change', pressed: false }))
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Row limit' })).toBeNull())
  })
})

describe('the shortcut hints and the selection label', () => {
  it('reads the keys of Run and Save from the registry for the platform', async () => {
    mountSql(SQL, world())
    await editor()
    const run = screen.getByRole('button', { name: /^Run/ })
    const save = screen.getByRole('button', { name: /^Save query/ })
    expect(run).toHaveAttribute('aria-keyshortcuts', 'Control+Enter')
    expect(save).toHaveAttribute('aria-keyshortcuts', 'Control+S')
    expect(within(run).getByText('Ctrl ↵')).toBeInTheDocument()
    expect(within(save).getByText('Ctrl S')).toBeInTheDocument()
    // The symbols are decorative: what a screen reader gets is the attribute, once.
    expect(within(run).getByText('Ctrl ↵').closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('shows Command on an Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    mountSql(SQL, world())
    await editor()
    const run = screen.getByRole('button', { name: /^Run/ })
    const save = screen.getByRole('button', { name: /^Save query/ })
    expect(run).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(save).toHaveAttribute('aria-keyshortcuts', 'Meta+S')
    expect(within(run).getByText('⌘↵')).toBeInTheDocument()
    expect(within(save).getByText('⌘S')).toBeInTheDocument()
  })

  it('changes Run to Run selected while text is selected and sends only that text', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT 1 AS one UNION SELECT 2')
    expect(screen.getByRole('button', { name: /^Run( |$)/ })).not.toHaveTextContent('selected')
    select(area, 0, 'SELECT 1 AS one'.length)
    const button = await screen.findByRole('button', { name: /^Run selected/ })
    await userEvent.click(button)
    await waitFor(() => expect(w.calls('POST', '/queries')).toHaveLength(1))
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 1 AS one')
    expect(await screen.findByText('Sent the selected text.')).toBeInTheDocument()
    select(area, 3, 3)
    expect(await screen.findByRole('button', { name: /^Run( |$)/ })).not.toHaveTextContent(
      'selected',
    )
  })
})
