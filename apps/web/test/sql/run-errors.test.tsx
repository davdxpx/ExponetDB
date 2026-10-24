import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { clearStorage, editor, SQL, type, world } from './helpers.tsx'
import { BIDI, mountSql, type SqlWorld } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))
vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
  (await import('./stand-ins.tsx')).editorModule(),
)
vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
  (await import('./stand-ins.tsx')).gridModule(),
)

const CATALOG_MESSAGE =
  'The statement failed on the target; only its SQLSTATE is returned (a server message can quote data).'

beforeEach(() => {
  clearStorage()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function failing(w: SqlWorld, details: unknown, code = 'QUERY_FAILED', message = CATALOG_MESSAGE) {
  w.run = () => ({
    status: 422,
    body: { code, message, ...(details === undefined ? {} : { details }) },
  })
}

async function runFailing(w: SqlWorld) {
  mountSql(SQL, w)
  type(await editor(), 'SELECT 1 / 0')
  await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
  return document.querySelector('[data-block="sql-result"][data-state="failed"]') as HTMLElement
}

async function failedBlock(): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = document.querySelector('[data-block="sql-result"][data-state="failed"]')
    if (found === null) throw new Error('not failed yet')
    return found as HTMLElement
  })
}

describe('a run that failed on the target', () => {
  it('shows the SQLSTATE with the catalog message and the stable code', async () => {
    const w = world()
    failing(w, { sqlstate: '22012' })
    await runFailing(w)
    const block = await failedBlock()
    expect(within(block).getByText(CATALOG_MESSAGE)).toBeInTheDocument()
    expect(within(block).getByText('QUERY_FAILED')).toBeInTheDocument()
    const state = block.querySelector('[data-sqlstate]')
    expect(state).toHaveAttribute('data-sqlstate', '22012')
    expect(state).toHaveTextContent('PostgreSQL error code (SQLSTATE): 22012')
    expect(screen.queryByTestId('grid')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('shows the SQLSTATE of a failed explain too', async () => {
    const w = world()
    w.explain = () => ({
      status: 422,
      body: { code: 'QUERY_FAILED', message: CATALOG_MESSAGE, details: { sqlstate: '42P01' } },
    })
    mountSql(SQL, w)
    type(await editor(), 'SELECT * FROM missing')
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }))
    const block = await failedBlock()
    expect(block.querySelector('[data-sqlstate]')).toHaveAttribute('data-sqlstate', '42P01')
  })

  it.each([
    ['too short', { sqlstate: '2201' }],
    ['too long', { sqlstate: '220120' }],
    ['lower case', { sqlstate: '22a12' }],
    ['with a direction character', { sqlstate: `2201${BIDI}` }],
    ['a number', { sqlstate: 22012 }],
    ['an object', { sqlstate: { code: '22012' } }],
    ['missing', {}],
    ['details that are not an object', 'sqlstate 22012'],
    ['no details at all', undefined],
  ])(
    'ignores a SQLSTATE that is %s and still shows the message and the code',
    async (_, details) => {
      const w = world()
      failing(w, details)
      await runFailing(w)
      const block = await failedBlock()
      expect(block.querySelector('[data-sqlstate]')).toBeNull()
      expect(block).not.toHaveTextContent('SQLSTATE:')
      expect(within(block).getByText(CATALOG_MESSAGE)).toBeInTheDocument()
      expect(within(block).getByText('QUERY_FAILED')).toBeInTheDocument()
    },
  )

  it('shows a SQLSTATE only for QUERY_FAILED, never for another code', async () => {
    const w = world()
    failing(
      w,
      { sqlstate: '22012' },
      'DATA_READ_NOT_PERMITTED',
      'Data reads are limited to people.',
    )
    await runFailing(w)
    const block = await failedBlock()
    expect(block.querySelector('[data-sqlstate]')).toBeNull()
    expect(within(block).getByText('DATA_READ_NOT_PERMITTED')).toBeInTheDocument()
  })

  it('shows nothing the server sent besides the code, the message and the SQLSTATE', async () => {
    const w = world()
    failing(w, {
      sqlstate: '23505',
      detail: 'Key (email)=(ada@example.test) already exists.',
      statement: 'SELECT secret FROM vault',
    })
    await runFailing(w)
    const block = await failedBlock()
    expect(block).not.toHaveTextContent('ada@example.test')
    expect(block).not.toHaveTextContent('vault')
  })

  it('shows a hostile message as text with hidden characters as code points', async () => {
    const w = world()
    failing(w, { sqlstate: 'XX000' }, 'QUERY_FAILED', `<img src=x onerror=alert(1)> ${BIDI}evil`)
    await runFailing(w)
    const block = await failedBlock()
    expect(block.querySelector('img')).toBeNull()
    expect(block).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(block.textContent).not.toContain(BIDI)
    expect(block).toHaveTextContent('⟨U+202E⟩evil')
  })

  it('copies the code, the SQLSTATE and the catalog message, and nothing else', async () => {
    const user = userEvent.setup()
    const w = world()
    failing(w, { sqlstate: '22012', detail: 'must not be copied' })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1 / 0')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const block = await failedBlock()
    await user.click(within(block).getByRole('button', { name: 'Copy error' }))
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        `QUERY_FAILED (SQLSTATE 22012): ${CATALOG_MESSAGE}`,
      ),
    )
    expect(within(block).getByRole('status')).toHaveTextContent(
      'Copied the error code and message.',
    )
    expect(await navigator.clipboard.readText()).not.toContain('must not be copied')
  })

  it('copies the code and the message of an error that has no SQLSTATE', async () => {
    const user = userEvent.setup()
    const w = world()
    failing(w, undefined, 'DATA_READ_NOT_PERMITTED', 'Data reads are limited to people.')
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const block = await failedBlock()
    await user.click(within(block).getByRole('button', { name: 'Copy error' }))
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        'DATA_READ_NOT_PERMITTED: Data reads are limited to people.',
      ),
    )
  })

  it('says so when the browser refuses the clipboard', async () => {
    const user = userEvent.setup()
    const w = world()
    failing(w, { sqlstate: '22012' })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1 / 0')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const block = await failedBlock()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await user.click(within(block).getByRole('button', { name: 'Copy error' }))
    expect(await within(block).findByRole('status')).toHaveTextContent(
      'Could not copy. Select the text and copy it yourself.',
    )
  })

  it('is reachable with the keyboard', async () => {
    const user = userEvent.setup()
    const w = world()
    failing(w, { sqlstate: '22012' })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1 / 0')
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    const block = await failedBlock()
    const copy = within(block).getByRole('button', { name: 'Copy error' })
    copy.focus()
    await user.keyboard('{Enter}')
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('22012'))
  })

  it('replaces the failure with the result of the next run', async () => {
    const w = world()
    failing(w, { sqlstate: '22012' })
    mountSql(SQL, w)
    type(await editor(), 'SELECT 1 / 0')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await failedBlock()
    w.run = (body) => ({
      status: 200,
      body: {
        queryId: body.queryId,
        columns: [{ name: 'n', type: 'integer', masked: false }],
        rows: [[1]],
        rowCount: 1,
        durationMs: 1,
        rlsRelations: [],
        statementDigest: `sha256:${'a'.repeat(64)}`,
        truncated: false,
        truncation: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    expect(await screen.findByTestId('grid')).toBeInTheDocument()
    expect(document.querySelector('[data-sqlstate]')).toBeNull()
  })
})
