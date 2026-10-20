import '@testing-library/jest-dom/vitest'
import { Toaster, toast } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataGrid } from '../../src/grid/data-grid.tsx'
import type { CellValue, DataGridProps, ExportResult, GridColumn } from '../../src/grid/types.ts'
import { axeViolations } from '../support/axe.ts'

type Rows = readonly (readonly CellValue[])[]

const OBSERVED = '2026-10-20T10:00:00Z'
const NOW = '2026-10-20T10:05:00Z'

function ready(value: Rows): Readable<Rows> {
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED }
}

const COLUMNS: GridColumn[] = [
  { name: 'id', type: 'int8' },
  { name: 'name', type: 'text' },
  { name: 'active', type: 'bool' },
]

const ROWS: Rows = [
  [1, 'Ada', true],
  [2, 'Grace | "the admiral"', false],
  [3, null, true],
]

function renderGrid(props: Partial<DataGridProps> = {}) {
  return render(
    <>
      <DataGrid label="Query result" columns={COLUMNS} rows={ready(ROWS)} now={NOW} {...props} />
      <Toaster />
    </>,
  )
}

async function copyAs(user: ReturnType<typeof userEvent.setup>, format: string) {
  await user.click(screen.getByRole('button', { name: 'Copy as' }))
  await user.click(await screen.findByRole('menuitem', { name: format }))
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  toast.clear()
  vi.restoreAllMocks()
})

describe('DataGrid: copy as', () => {
  it('offers Markdown, CSV and JSON in a menu next to the export buttons', async () => {
    const user = userEvent.setup()
    renderGrid()
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy as' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Markdown', 'CSV', 'JSON'])
    expect(await axeViolations()).toEqual([])
  })

  it('copies the loaded rows as a Markdown table and says so', async () => {
    const user = userEvent.setup()
    renderGrid()
    await copyAs(user, 'Markdown')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        [
          '| id | name | active |',
          '| ---: | --- | --- |',
          '| 1 | Ada | true |',
          '| 2 | Grace \\| "the admiral" | false |',
          '| 3 |  | true |',
          '',
        ].join('\n'),
      ),
    )
    expect(screen.getAllByText('Copied 3 rows as Markdown.')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Copy as' })).toBeInTheDocument()
  })

  it('copies the same text as the CSV export, with its formula guard', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [
        { name: 'a', type: 'text' },
        { name: 'n', type: 'int4' },
      ],
      rows: ready([
        ['=1+1', -4],
        ['plain, text', 7],
      ]),
    })
    await copyAs(user, 'CSV')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        ['a,n', "'=1+1,-4", '"plain, text",7', ''].join('\r\n'),
      ),
    )
    expect(screen.getAllByText('Copied 2 rows as CSV.')).toHaveLength(2)
  })

  it('copies JSON that parses back', async () => {
    const user = userEvent.setup()
    renderGrid()
    await copyAs(user, 'JSON')
    await waitFor(async () =>
      expect(JSON.parse(await navigator.clipboard.readText())).toEqual([
        { id: 1, name: 'Ada', active: true },
        { id: 2, name: 'Grace | "the admiral"', active: false },
        { id: 3, name: null, active: true },
      ]),
    )
    expect(screen.getAllByText('Copied 3 rows as JSON.')).toHaveLength(2)
  })

  it('stops at the row cap and says the result has more', async () => {
    const user = userEvent.setup()
    renderGrid({ exportLimit: { rows: 2, bytes: 1_000_000 } })
    await copyAs(user, 'Markdown')
    await waitFor(async () =>
      expect((await navigator.clipboard.readText()).split('\n')).toHaveLength(2 + 2 + 1),
    )
    expect(
      screen.getAllByText('Copied the first 2 rows as Markdown; the result has more.'),
    ).toHaveLength(2)
  })

  it('says the result has more than the loaded rows when the server cut it', async () => {
    const user = userEvent.setup()
    renderGrid({ truncated: { reason: 'the 500 row limit' } })
    await copyAs(user, 'Markdown')
    expect(
      (await screen.findAllByText('Copied the 3 loaded rows as Markdown; the result has more.'))
        .length,
    ).toBeGreaterThan(0)
  })

  it('says a value the server cut and a masked column were copied as a preview and empty', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [
        { name: 'body', type: 'text' },
        { name: 'email', type: 'text', masked: true },
      ],
      rows: ready([[{ truncated: true, preview: 'abc', bytes: 9_999 }, null]]),
    })
    await copyAs(user, 'Markdown')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        '| body | email |\n| --- | --- |\n| abc…[truncated: 9999 bytes] |  |\n',
      ),
    )
    expect(
      screen.getAllByText(
        'Copied 1 row as Markdown. 1 value cut by the server is copied as a preview. Masked columns are copied empty.',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('copies hostile text as text and says it holds hidden characters', async () => {
    const user = userEvent.setup()
    const hostile = '<img src=x onerror=alert(1)>\u{202E}gnp.exe'
    renderGrid({
      columns: [{ name: '<b>col</b>', type: 'text' }],
      rows: ready([[hostile]]),
    })
    await copyAs(user, 'Markdown')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        `| <b>col</b> |\n| --- |\n| ${hostile} |\n`,
      ),
    )
    expect(document.querySelector('img, b')).toBeNull()
    expect(
      screen.getAllByText(/It holds 1 hidden character, copied as they are\./).length,
    ).toBeGreaterThan(0)
  })

  it('escapes backslashes, pipes and line breaks of cells and column names', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'a|b', type: 'text' }],
      rows: ready([['C:\\dir|x\nnext']]),
    })
    await copyAs(user, 'Markdown')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        '| a\\|b |\n| --- |\n| C:\\\\dir\\|x<br>next |\n',
      ),
    )
  })

  it('copies nothing and says so when the browser refuses the clipboard', async () => {
    const user = userEvent.setup()
    renderGrid()
    await navigator.clipboard.writeText('before')
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await copyAs(user, 'CSV')
    expect(await screen.findAllByText('Could not copy to the clipboard')).not.toHaveLength(0)
    expect(
      screen.getByText('Could not copy: the browser did not allow access to the clipboard.'),
    ).toBeInTheDocument()
  })

  it('downloads nothing and reports no export', async () => {
    const user = userEvent.setup()
    const create = vi.fn(() => 'blob:test/1')
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
    const onExport = vi.fn<(result: ExportResult) => void>()
    renderGrid({ onExport })
    await copyAs(user, 'Markdown')
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('| id |'))
    expect(create).not.toHaveBeenCalled()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('works with the keyboard: Enter opens the menu, the arrows move, Enter copies', async () => {
    const user = userEvent.setup()
    renderGrid()
    screen.getByRole('button', { name: 'Copy as' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toMatch(/^id,name,active/),
    )
    expect(screen.getAllByText('Copied 3 rows as CSV.').length).toBeGreaterThan(0)
    // Escape closes the menu and returns to the button.
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('button', { name: 'Copy as' })).toHaveFocus()
  })
})
