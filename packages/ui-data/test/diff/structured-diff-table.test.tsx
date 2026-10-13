import '@testing-library/jest-dom/vitest'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StructuredDiffRow } from '../../src/diff/structured-diff.ts'
import { StructuredDiffTable } from '../../src/diff/structured-diff-table.tsx'
import { axeViolations } from '../support/axe.ts'
import { FAILED, NOW, partial, ready, stale } from './fixtures.ts'

afterEach(cleanup)

const ROWS: readonly StructuredDiffRow[] = [
  { key: 'max_connections', before: '100', after: '200' },
  { key: 'work_mem', before: null, after: '64MB' },
  { key: 'log_statement', before: 'ddl', after: null },
  { key: 'shared_buffers', before: '128MB', after: '128MB' },
  { key: 'timezone', before: 'UTC', after: 'UTC' },
]

function renderTable(
  rows: Readable<readonly StructuredDiffRow[]>,
  props: Partial<Parameters<typeof StructuredDiffTable>[0]> = {},
) {
  return render(<StructuredDiffTable rows={rows} now={NOW} {...props} />)
}

function rowOf(key: string): HTMLElement {
  const row = screen.getByText(key).closest('tr')
  if (row === null) throw new Error(`no row for ${key}`)
  return row
}

describe('StructuredDiffTable', () => {
  it('marks rows added, removed and changed with a word and an icon', () => {
    renderTable(ready(ROWS))

    const changed = rowOf('max_connections')
    expect(changed).toHaveAttribute('data-change', 'changed')
    expect(within(changed).getByText('Changed')).toBeInTheDocument()
    expect(changed.querySelector('svg')).not.toBeNull()
    expect(within(changed).getByText('100')).toBeInTheDocument()
    expect(within(changed).getByText('200')).toBeInTheDocument()

    expect(within(rowOf('work_mem')).getByText('Added')).toBeInTheDocument()
    expect(within(rowOf('log_statement')).getByText('Removed')).toBeInTheDocument()
    expect(rowOf('work_mem').querySelector('svg')).not.toBeNull()
    expect(rowOf('log_statement').querySelector('svg')).not.toBeNull()
  })

  it('tells an absent value from an empty one', () => {
    renderTable(
      ready([
        { key: 'added_empty', before: null, after: '' },
        { key: 'removed_empty', before: '', after: null },
      ]),
      { absentLabel: 'not granted' },
    )
    const added = rowOf('added_empty')
    expect(within(added).getByText('not granted')).toBeInTheDocument()
    expect(within(added).getByText('(empty)')).toBeInTheDocument()
    const removed = rowOf('removed_empty')
    expect(within(removed).getByText('not granted')).toBeInTheDocument()
    expect(within(removed).getByText('(empty)')).toBeInTheDocument()
  })

  it('summarizes the rows and folds the unchanged ones behind a counted button', async () => {
    const user = userEvent.setup()
    renderTable(ready(ROWS))

    expect(screen.getByText('1 added, 1 changed, 1 removed; 2 unchanged.')).toBeInTheDocument()
    expect(screen.queryByText('shared_buffers')).toBeNull()
    expect(screen.queryByText('timezone')).toBeNull()

    const toggle = screen.getByRole('button', { name: 'Show 2 unchanged rows' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByText('shared_buffers')).toBeInTheDocument()
    expect(rowOf('timezone')).toHaveAttribute('data-change', 'unchanged')
    expect(within(rowOf('timezone')).getByText('Unchanged')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide 2 unchanged rows' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'Hide 2 unchanged rows' }))
    expect(screen.queryByText('shared_buffers')).toBeNull()
  })

  it('says that nothing differs when every row is unchanged and still lets you see them', async () => {
    const user = userEvent.setup()
    renderTable(ready([{ key: 'timezone', before: 'UTC', after: 'UTC' }]))
    expect(screen.getByText('No differences: all 1 row is the same.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show 1 unchanged row' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('timezone')).toBeInTheDocument()
  })

  it('does not claim that nothing differs when the read is partial', () => {
    renderTable(
      partial([{ key: 'timezone', before: 'UTC', after: 'UTC' }], ['Grants of role app.']),
    )
    expect(screen.getByText('No differences in the rows that were read.')).toBeInTheDocument()
    expect(screen.queryByText(/No differences: all/)).toBeNull()
    expect(screen.getByText('Showing part of settings and grants')).toBeInTheDocument()
    expect(screen.getByText('Grants of role app.')).toBeInTheDocument()
  })

  it('names the columns and the table for assistive technology', () => {
    renderTable(ready(ROWS), {
      keyLabel: 'Grant',
      beforeLabel: 'Held before',
      afterLabel: 'Held after',
      caption: 'Grants changed by this plan',
    })
    const table = screen.getByRole('table', { name: 'Grants changed by this plan' })
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
    expect(headers).toEqual(['Change', 'Grant', 'Held before', 'Held after'])
  })

  it('shows keys and values as untrusted text', () => {
    const { container } = renderTable(
      ready([
        {
          key: 'role\u{202E}<img src=x onerror=alert(1)>',
          before: '<script>alert(1)</script>',
          after: 'a\u{200B}b\nsecond line',
        },
      ]),
    )
    expect(container.querySelector('img, script')).toBeNull()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('[data-code-point="U+202E"]')).not.toBeNull()
    expect(container.querySelector('[data-code-point="U+200B"]')).not.toBeNull()
    expect(screen.getByText('second line', { exact: false })).toBeInTheDocument()
    expect(container.querySelectorAll('[data-untrusted]').length).toBeGreaterThanOrEqual(3)
  })

  it('cuts a long value and shows the rest on request', async () => {
    const user = userEvent.setup()
    const long = 'x'.repeat(2_000)
    renderTable(ready([{ key: 'search_path', before: 'a', after: long }]))
    expect(screen.queryByText(long)).toBeNull()
    await user.click(screen.getByRole('button', { name: /Show all .* of after/ }))
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('keeps rows that repeat a key apart', () => {
    renderTable(
      ready([
        { key: 'dup', before: '1', after: '2' },
        { key: 'dup', before: '3', after: '4' },
      ]),
    )
    expect(screen.getAllByText('dup')).toHaveLength(2)
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('does not draw a failed read as an empty table', () => {
    const onRetry = vi.fn()
    renderTable(FAILED, { onRetry })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read settings and grants')
    expect(screen.getByRole('alert')).toHaveTextContent('TARGET_UNREACHABLE')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText(/No differences|Nothing to compare/)).toBeNull()
  })

  it('shows a loading state, an earlier read with a notice, and an empty read honestly', () => {
    const { rerender } = renderTable({ state: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading settings and grants')

    rerender(<StructuredDiffTable rows={stale(ROWS)} now={NOW} />)
    expect(screen.getByText('Showing an earlier read of settings and grants')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()

    rerender(<StructuredDiffTable rows={ready([])} now={NOW} />)
    expect(screen.getByText('Nothing to compare')).toBeInTheDocument()
    expect(
      screen.getByText('The read succeeded and found no settings and grants.'),
    ).toBeInTheDocument()

    rerender(<StructuredDiffTable rows={stale([])} now={NOW} />)
    expect(
      screen.getByText('The last successful read found no settings and grants.'),
    ).toBeInTheDocument()

    rerender(<StructuredDiffTable rows={partial([], ['Everything on node b.'])} now={NOW} />)
    expect(
      screen.getByText(/The part that was read has no settings and grants/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/The read succeeded/)).toBeNull()
  })

  it('puts the class name of the caller on the table in a ready read', () => {
    const { container } = renderTable(ready(ROWS), { className: 'caller-class' })
    expect(container.querySelector('.caller-class')).not.toBeNull()
  })

  it('has no accessibility violations', async () => {
    const user = userEvent.setup()
    const { container } = renderTable(ready(ROWS))
    expect(await axeViolations(container)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Show 2 unchanged rows' }))
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no accessibility violations in the failed, partial and empty states', async () => {
    const { container, rerender } = renderTable(FAILED)
    expect(await axeViolations(container)).toEqual([])
    rerender(<StructuredDiffTable rows={partial(ROWS, ['Roles.'])} now={NOW} />)
    expect(await axeViolations(container)).toEqual([])
    rerender(<StructuredDiffTable rows={ready([])} now={NOW} />)
    expect(await axeViolations(container)).toEqual([])
  })
})
