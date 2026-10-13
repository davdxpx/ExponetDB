import '@testing-library/jest-dom/vitest'
import { Toaster, toast } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataGrid } from '../../src/grid/data-grid.tsx'
import type { CellValue, DataGridProps, ExportResult, GridColumn } from '../../src/grid/types.ts'
import { axeViolations } from '../support/axe.ts'

type Rows = readonly (readonly CellValue[])[]

const OBSERVED = '2026-10-13T10:00:00Z'
const NOW = '2026-10-13T10:05:00Z'

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
  [2, 'Grace, "the admiral"', false],
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

function cellAt(row: number, col: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-exdb-r="${row}"][data-exdb-c="${col}"]`)
  if (el === null) throw new Error(`no cell at ${row}:${col}`)
  return el
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/** Captures what the grid hands to the browser as a download. */
function captureDownloads() {
  const blobs: Blob[] = []
  const links: HTMLAnchorElement[] = []
  const create = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return `blob:test/${blobs.length}`
  })
  const revoke = vi.fn()
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push(this.cloneNode() as HTMLAnchorElement)
  })
  return { blobs, links, create, revoke }
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  toast.clear()
  vi.restoreAllMocks()
})

describe('DataGrid: the full value', () => {
  const LONG = `${'0123456789'.repeat(50)}END`

  it('cuts a long value in the cell and offers the whole value on request', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'note', type: 'text' }],
      rows: ready([[LONG], ['short']]),
    })

    expect(cellAt(1, 0)).not.toHaveTextContent('END')
    expect(cellAt(1, 0).textContent).toContain('…')
    expect(within(cellAt(2, 0)).queryByRole('button', { name: 'Show full value' })).toBeNull()

    await user.click(within(cellAt(1, 0)).getByRole('button', { name: 'Show full value' }))

    const sheet = await screen.findByRole('dialog', { name: 'Full value' })
    expect(sheet).toHaveTextContent('Row 1, column note of type text')
    expect(sheet).toHaveTextContent('END')
    expect(sheet.textContent).toContain(LONG)
    expect(within(sheet).getByRole('button', { name: 'Copy value' })).toBeEnabled()
  })

  it('copies the whole value from the sheet', async () => {
    const user = userEvent.setup()
    renderGrid({ columns: [{ name: 'note', type: 'text' }], rows: ready([[LONG]]) })

    await user.click(within(cellAt(1, 0)).getByRole('button', { name: 'Show full value' }))
    await user.click(await screen.findByRole('button', { name: 'Copy value' }))

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(LONG))
    expect(screen.getAllByText('Copied the value.').length).toBeGreaterThan(0)
  })

  it('opens from the keyboard with Enter, Space or F2 and closes with Escape, returning focus to the cell', async () => {
    const user = userEvent.setup()
    renderGrid()

    for (const key of ['{Enter}', ' ', '{F2}']) {
      cellAt(1, 1).focus()
      await user.keyboard(key)
      const sheet = await screen.findByRole('dialog', { name: 'Full value' })
      expect(sheet).toHaveTextContent('Ada')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(cellAt(1, 1)).toHaveFocus()
    }
  })

  it('counts the characters of the value, in the singular for one', async () => {
    const user = userEvent.setup()
    renderGrid({ columns: [{ name: 'v', type: 'text' }], rows: ready([['x'], ['😀😀']]) })

    cellAt(1, 0).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveTextContent('1 character')
    expect(screen.getByRole('dialog')).not.toHaveTextContent('1 characters')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    cellAt(2, 0).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveTextContent('2 characters')
  })

  it('opens on a double click', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.dblClick(cellAt(1, 1))
    expect(await screen.findByRole('dialog', { name: 'Full value' })).toHaveTextContent('Ada')
  })

  it('shows JSON indented and keeps every digit', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'doc', type: 'jsonb' }],
      rows: ready([['{"id":12345678901234567890,"tags":["a","b"]}']]),
    })

    cellAt(1, 0).focus()
    await user.keyboard('{Enter}')
    const sheet = await screen.findByRole('dialog')

    expect(sheet.textContent).toContain('"id": 12345678901234567890')
    expect(sheet.textContent).toContain('"tags": [')
  })

  it('says what the server cut and what the grid holds', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'body', type: 'text' }],
      rows: ready([[{ truncated: true, preview: 'The start', bytes: 54_321, unit: 'characters' }]]),
    })

    await user.click(within(cellAt(1, 0)).getByRole('button', { name: 'Show full value' }))
    const sheet = await screen.findByRole('dialog')

    expect(sheet).toHaveTextContent('The server cut this value')
    expect(sheet).toHaveTextContent('54,321 characters')
    expect(sheet).toHaveTextContent('The start')
  })

  it('says a NULL value is NULL and has nothing to copy', async () => {
    const user = userEvent.setup()
    renderGrid()

    cellAt(3, 1).focus()
    await user.keyboard('{Enter}')
    const sheet = await screen.findByRole('dialog')

    expect(sheet).toHaveTextContent('This value is NULL')
    expect(within(sheet).getByRole('button', { name: 'Copy value' })).toBeDisabled()
  })

  it('shows hostile text, direction characters and a hostile column name as text', async () => {
    const user = userEvent.setup()
    const hostile = '<img src=x onerror=alert(1)>\u{202E}gnp.exe\u{200B}'
    renderGrid({
      columns: [{ name: '<b>col</b>\u{202E}', type: 'text' }],
      rows: ready([[hostile]]),
    })

    cellAt(1, 0).focus()
    await user.keyboard('{Enter}')
    const sheet = await screen.findByRole('dialog')

    expect(sheet.querySelector('img, b')).toBeNull()
    expect(sheet).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(sheet.textContent).not.toContain('\u{202E}')
    expect(sheet.textContent).not.toContain('\u{200B}')
    expect(within(sheet).getAllByText('⟨U+202E⟩').length).toBeGreaterThanOrEqual(2)
    expect(within(sheet).getByText('⟨U+200B⟩')).toBeInTheDocument()
  })

  it('keeps its arrow keys to itself', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'note', type: 'text' }],
      rows: ready([[LONG], ['b'], ['c']]),
    })

    cellAt(1, 0).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')
    await user.keyboard('{ArrowDown}{ArrowDown}{End}')

    expect(cellAt(1, 0)).toHaveAttribute('tabindex', '0')
    expect(cellAt(3, 0)).toHaveAttribute('tabindex', '-1')
  })

  it('has no axe violations with the sheet open', async () => {
    const user = userEvent.setup()
    renderGrid({ columns: [{ name: 'note', type: 'text' }], rows: ready([[LONG]]) })

    await user.click(within(cellAt(1, 0)).getByRole('button', { name: 'Show full value' }))
    await screen.findByRole('dialog')
    expect(await axeViolations()).toEqual([])
  })
})

describe('DataGrid: copy', () => {
  it('copies the active cell with the keyboard', async () => {
    const user = userEvent.setup()
    renderGrid()

    cellAt(2, 1).focus()
    await user.keyboard('{Control>}c{/Control}')

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('Grace, "the admiral"'),
    )
    expect(screen.getAllByText('Copied the cell value.')).toHaveLength(2)
  })

  it('copies the cell and the row from the buttons, the row as tab-separated values', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.click(cellAt(1, 1))
    await user.click(screen.getByRole('button', { name: 'Copy cell' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('Ada'))

    await user.click(screen.getByRole('button', { name: 'Copy row' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('1\tAda\ttrue'))
    expect(screen.getAllByText('Copied the row as tab-separated values.')).toHaveLength(2)
  })

  it('quotes what a spreadsheet would split and guards formulas in a copied row', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'text' },
        { name: 'c', type: 'int4' },
      ],
      rows: ready([['=1+1', 'two\tfields "x"', -4]]),
    })

    await user.click(cellAt(1, 0))
    await user.click(screen.getByRole('button', { name: 'Copy row' }))

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(`'=1+1\t"two\tfields ""x"""\t-4`),
    )
  })

  it('copies a cell exactly, without a guard', async () => {
    const user = userEvent.setup()
    renderGrid({ columns: [{ name: 'a', type: 'text' }], rows: ready([['=1+1']]) })

    cellAt(1, 0).focus()
    await user.keyboard('{Control>}c{/Control}')

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('=1+1'))
  })

  it('copies nothing for NULL and says so', async () => {
    const user = userEvent.setup()
    await navigator.clipboard.writeText('before')
    renderGrid()

    cellAt(3, 1).focus()
    await user.keyboard('{Control>}c{/Control}')

    expect(
      await screen.findByText('Nothing was copied: the cell has no value.'),
    ).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('before')
  })

  it('says a copied value holds hidden characters and copies them as they are', async () => {
    const user = userEvent.setup()
    const value = 'a\u{202E}b\u{200B}c'
    renderGrid({ columns: [{ name: 'v', type: 'text' }], rows: ready([[value]]) })

    cellAt(1, 0).focus()
    await user.keyboard('{Control>}c{/Control}')

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(value))
    expect(
      screen.getAllByText(/It holds 2 hidden characters, copied as they are\./).length,
    ).toBeGreaterThan(0)
  })

  it('says a value the server cut was copied as the part the grid has', async () => {
    const user = userEvent.setup()
    renderGrid({
      columns: [{ name: 'v', type: 'text' }],
      rows: ready([[{ truncated: true, preview: 'abc', bytes: 999 }]]),
    })

    cellAt(1, 0).focus()
    await user.keyboard('{Control>}c{/Control}')

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('abc'))
    expect(
      screen.getAllByText(/The server cut this value; the copy holds the part the grid has\./)
        .length,
    ).toBeGreaterThan(0)
  })

  it('leaves Control+C alone while text is selected', async () => {
    const user = userEvent.setup()
    await navigator.clipboard.writeText('before')
    renderGrid()
    cellAt(1, 1).focus()
    const range = document.createRange()
    range.selectNodeContents(cellAt(1, 1))
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    await user.keyboard('{Control>}c{/Control}')

    expect(screen.queryByText('Copied the cell value.')).toBeNull()
    expect(await navigator.clipboard.readText()).toBe('before')
    window.getSelection()?.removeAllRanges()
  })

  it('says so when the browser refuses the clipboard', async () => {
    const user = userEvent.setup()
    renderGrid()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))

    cellAt(1, 1).focus()
    await user.keyboard('{Control>}c{/Control}')

    expect(await screen.findAllByText('Could not copy to the clipboard')).not.toHaveLength(0)
    expect(
      screen.getByText('Could not copy: the browser did not allow access to the clipboard.'),
    ).toBeInTheDocument()
  })

  it('copies a bytea value as a hex literal', async () => {
    const user = userEvent.setup()
    renderGrid({ columns: [{ name: 'b', type: 'bytea' }], rows: ready([['deadbeef']]) })

    cellAt(1, 0).focus()
    await user.keyboard('{Control>}c{/Control}')

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('\\xdeadbeef'))
  })

  it('disables the copy buttons while the header is the active position', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.click(screen.getAllByRole('columnheader')[0] as HTMLElement)
    cellAt(0, 0).focus()
    expect(screen.getByRole('button', { name: 'Copy cell' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy row' })).toBeDisabled()
  })
})

describe('DataGrid: export', () => {
  it('downloads the loaded rows as CSV and reports it', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    const onExport = vi.fn<(result: ExportResult) => void>()
    renderGrid({ onExport })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(downloads.blobs).toHaveLength(1)
    expect(downloads.blobs[0]?.type).toBe('text/csv;charset=utf-8')
    expect(await readBlob(downloads.blobs[0] as Blob)).toBe(
      ['id,name,active', '1,Ada,true', '2,"Grace, ""the admiral""",false', '3,,true', ''].join(
        '\r\n',
      ),
    )
    expect(downloads.links[0]?.download).toBe('result.csv')
    expect(downloads.links[0]?.getAttribute('href')).toBe('blob:test/1')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({
      format: 'csv',
      rowsExported: 3,
      rowsLoaded: 3,
      cappedBy: null,
      incomplete: false,
      message: 'Exported 3 rows.',
    })
    // The inline status and the toast both say it.
    expect(screen.getAllByText('Exported 3 rows.')).toHaveLength(2)
  })

  it('downloads the loaded rows as JSON under the name the caller gives', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    renderGrid({ fileName: 'orders 2026' })

    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(downloads.blobs[0]?.type).toBe('application/json;charset=utf-8')
    expect(downloads.links[0]?.download).toBe('orders-2026.json')
    expect(JSON.parse(await readBlob(downloads.blobs[0] as Blob))).toEqual([
      { id: 1, name: 'Ada', active: true },
      { id: 2, name: 'Grace, "the admiral"', active: false },
      { id: 3, name: null, active: true },
    ])
  })

  it('guards formulas in CSV cells and header names', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    renderGrid({
      columns: [
        { name: '=evil()', type: 'text' },
        { name: 'n', type: 'int4' },
      ],
      rows: ready([
        ['=HYPERLINK("http://x.test")', -7],
        ['+1', 0],
        ['-1', 1],
        ['@x', 2],
        ['\tx', 3],
      ]),
    })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    const text = await readBlob(downloads.blobs[0] as Blob)
    expect(text.split('\r\n')).toEqual([
      "'=evil(),n",
      `"'=HYPERLINK(""http://x.test"")",-7`,
      "'+1,0",
      "'-1,1",
      "'@x,2",
      "'\tx,3",
      '',
    ])
  })

  it('says the first rows were exported when the row cap is hit, in the status and in a toast', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    const onExport = vi.fn<(result: ExportResult) => void>()
    renderGrid({ exportLimit: { rows: 2, bytes: 1_000_000 }, onExport })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect((await readBlob(downloads.blobs[0] as Blob)).split('\r\n')).toHaveLength(4)
    expect(screen.getAllByText('Exported the first 2 rows; the result has more.')).toHaveLength(2)
    expect(onExport.mock.calls[0]?.[0]).toMatchObject({
      cappedBy: 'rows',
      rowsExported: 2,
      incomplete: true,
    })
  })

  it('says it by the owner wording at the default cap of 10,000 rows', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    const many = Array.from({ length: 10_001 }, (_, i): readonly CellValue[] => [i, 'x', true])
    renderGrid({ rows: ready(many) })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(
      screen.getAllByText('Exported the first 10,000 rows; the result has more.'),
    ).toHaveLength(2)
    expect((await readBlob(downloads.blobs[0] as Blob)).split('\r\n')).toHaveLength(10_002)
  })

  it('says the size limit ended the export', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    renderGrid({ exportLimit: { rows: 100, bytes: 40 } })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    const text = await readBlob(downloads.blobs[0] as Blob)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(
      screen.getAllByText(
        /the export reached its size limit of 40 bytes and the result has more\./,
      ),
    ).toHaveLength(2)
  })

  it('says the result has more than the loaded rows when the server cut it', async () => {
    const user = userEvent.setup()
    captureDownloads()
    renderGrid({ truncated: { reason: 'the row limit' } })

    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(screen.getAllByText('Exported the 3 loaded rows; the result has more.')).toHaveLength(2)
  })

  it('says the result has more than the loaded rows when more pages exist', async () => {
    const user = userEvent.setup()
    captureDownloads()
    renderGrid({ page: { hasMore: true, onLoadMore: vi.fn(), loading: false } })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(screen.getAllByText('Exported the 3 loaded rows; the result has more.')).toHaveLength(2)
  })

  it('says values the server cut and masked columns were exported as previews and empty', async () => {
    const user = userEvent.setup()
    const downloads = captureDownloads()
    renderGrid({
      columns: [
        { name: 'body', type: 'text' },
        { name: 'email', type: 'text', masked: true },
      ],
      rows: ready([[{ truncated: true, preview: 'abc', bytes: 9_999 }, null]]),
    })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(await readBlob(downloads.blobs[0] as Blob)).toBe(
      'body,email\r\nabc…[truncated: 9999 bytes],\r\n',
    )
    expect(
      screen.getAllByText(
        'Exported 1 row. 1 value cut by the server is exported as a preview. Masked columns are exported empty.',
      ),
    ).toHaveLength(2)
  })

  it('does not open a window', async () => {
    const user = userEvent.setup()
    captureDownloads()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderGrid()

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await user.click(screen.getByRole('button', { name: 'Export JSON' }))

    expect(open).not.toHaveBeenCalled()
  })

  it('says so and reports nothing when the browser cannot start the download', async () => {
    const user = userEvent.setup()
    Object.assign(URL, {
      createObjectURL: () => {
        throw new Error('no blobs')
      },
      revokeObjectURL: vi.fn(),
    })
    const onExport = vi.fn()
    renderGrid({ onExport })

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(screen.getByText('Could not create the file.')).toBeInTheDocument()
    expect(onExport).not.toHaveBeenCalled()
  })
})
