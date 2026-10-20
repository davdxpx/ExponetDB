import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { bodyOf, clearStorage, editor, SQL, select, type, world } from './helpers.tsx'
import { BIDI, mountSql } from './support.tsx'

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
afterEach(cleanup)

const THREE = 'SELECT 1;\nSELECT 2;\nSELECT 3'

interface RunBody {
  readonly sql: string
}

async function ready(area: HTMLTextAreaElement, count: number): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('[data-multi-statement-hint]')).toHaveTextContent(
      `The text holds ${count} statements`,
    ),
  )
  expect(area).toBeInTheDocument()
}

describe('running one statement of several', () => {
  it('sends the statement under the cursor and says which one and on which line', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    await ready(area, 3)
    select(area, THREE.indexOf('SELECT 2') + 3, THREE.indexOf('SELECT 2') + 3)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    const sent = w.calls('POST', '/queries')
    expect(sent).toHaveLength(1)
    expect(bodyOf<RunBody>(sent[0])?.sql).toBe('SELECT 2')
    expect(screen.getByText('Sent statement 2 of 3, which starts on line 2.')).toBeInTheDocument()
  })

  it('sends the first statement when the cursor is at the start and the last at the end', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    await ready(area, 3)
    select(area, 0, 0)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    select(area, THREE.length, THREE.length)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() => expect(w.calls('POST', '/queries')).toHaveLength(2))
    expect(w.calls('POST', '/queries').map((s) => (s.body as RunBody).sql)).toEqual([
      'SELECT 1',
      'SELECT 3',
    ])
    expect(await screen.findByText(/Sent statement 3 of 3, which starts on line 3/)).toBeVisible()
  })

  it('takes the statement before the cursor when the cursor is between two statements', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    const text = 'SELECT 1;\n\n\n  SELECT 2'
    type(area, text)
    await ready(area, 2)
    select(area, 11, 11)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 1')
  })

  it('sends the selected text before the statement under the cursor', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    await ready(area, 3)
    select(area, 0, 'SELECT 1'.length)
    expect(document.querySelector('[data-multi-statement-hint]')).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: /^Run selected/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 1')
    expect(screen.getByText('Sent the selected text.')).toBeInTheDocument()
    expect(screen.queryByText(/Sent statement/)).toBeNull()
  })

  it('sends all of the text and says nothing about a statement when there is only one', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT 1;')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 1;')
    expect(document.querySelector('[data-run-scope]')).toBeNull()
    expect(document.querySelector('[data-multi-statement-hint]')).toBeNull()
  })

  it('does not send a write under the cursor and says which statement was held back', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    const text = 'SELECT 1;\nDROP TABLE public.orders'
    type(area, text)
    await ready(area, 2)
    select(area, text.length, text.length)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-write-explanation="held"]')).not.toBeNull(),
    )
    expect(
      screen.getByText('Statement 2 of 2, which starts on line 2, was not sent.'),
    ).toBeInTheDocument()
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('runs the read under the cursor even when another statement is a write', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    const text = 'SELECT 1;\nDROP TABLE public.orders'
    type(area, text)
    await ready(area, 2)
    select(area, 2, 2)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 1')
  })

  it('explains the statement under the cursor too', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    await ready(area, 3)
    select(area, THREE.indexOf('SELECT 3'), THREE.indexOf('SELECT 3'))
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }))
    await screen.findByText('Total cost')
    expect(bodyOf<RunBody>(w.calls('POST', '/explain')[0])?.sql).toBe('SELECT 3')
    expect(screen.getByText(/Sent statement 3 of 3/)).toBeInTheDocument()
  })

  it('sends all of the text when the server cannot classify it, and shows the refusal', async () => {
    const w = world()
    w.classify = () => ({
      status: 503,
      body: { code: 'UNAVAILABLE', message: 'The parser is busy.' },
    })
    w.run = () => ({
      status: 422,
      body: { code: 'QUERY_NOT_READ_ONLY', message: 'Only one read-only statement is allowed.' },
    })
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    select(area, 12, 12)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    expect(await screen.findByText(/QUERY_NOT_READ_ONLY/)).toBeInTheDocument()
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe(THREE)
    expect(document.querySelector('[data-run-scope]')).toBeNull()
  })

  it('sends all of the text when it is too large to classify', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    const big = `SELECT '${'x'.repeat(70_000)}'; SELECT 2`
    type(area, big)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe(big)
    expect(w.calls('POST', '/sql/classifications')).toEqual([])
  })

  it('sends a statement with hidden characters as it is and keeps them out of the scope note', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    const text = `SELECT '${BIDI}';\nSELECT 2`
    type(area, text)
    await ready(area, 2)
    select(area, text.length, text.length)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(bodyOf<RunBody>(w.calls('POST', '/queries')[0])?.sql).toBe('SELECT 2')
    expect(document.querySelector('[data-run-scope]')?.textContent).not.toContain(BIDI)
  })

  it('passes axe with the hint and the scope note', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, THREE)
    await ready(area, 3)
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(await axeViolations()).toEqual([])
  })
})
