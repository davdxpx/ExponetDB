import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SchemaDiffEntry } from '../../src/diff/schema-diff.ts'
import { SchemaDiffView } from '../../src/diff/schema-diff-view.tsx'
import { axeViolations } from '../support/axe.ts'
import { FAILED, NOW, partial, ready, stale } from './fixtures.ts'

afterEach(cleanup)

const ENTRIES: readonly SchemaDiffEntry[] = [
  {
    objectType: 'table',
    schema: 'public',
    name: 'orders',
    change: 'changed',
    classes: ['rewrite', 'security'],
    details: 'ALTER TABLE public.orders ALTER COLUMN total TYPE numeric(14,2);',
  },
  {
    objectType: 'table',
    schema: 'public',
    name: 'legacy_events',
    change: 'removed',
    classes: ['destructive'],
    details: 'DROP TABLE public.legacy_events;',
  },
  {
    objectType: 'index',
    schema: 'public',
    name: 'orders_created_at_idx',
    change: 'added',
    classes: ['non_transactional'],
    details: 'CREATE INDEX CONCURRENTLY orders_created_at_idx ON public.orders (created_at);',
  },
  {
    objectType: 'extension',
    schema: '',
    name: 'pgcrypto',
    change: 'added',
    classes: [],
    details: '',
  },
]

function renderView(
  diff: Readable<readonly SchemaDiffEntry[]>,
  props: Partial<Parameters<typeof SchemaDiffView>[0]> = {},
) {
  return render(
    <TooltipProvider>
      <SchemaDiffView diff={diff} now={NOW} {...props} />
    </TooltipProvider>,
  )
}

describe('SchemaDiffView', () => {
  it('groups the objects by type under headings with counts, known types in dependency order', () => {
    renderView(ready(ENTRIES))

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings).toEqual(['Extensions(1)', 'Tables(2)', 'Indexes(1)'])
    const tables = screen.getByRole('region', { name: 'Tables(2)' })
    expect(within(tables).getAllByRole('listitem')).toHaveLength(2)
    expect(within(tables).getByText('orders')).toBeInTheDocument()
    expect(within(tables).getByText('legacy_events')).toBeInTheDocument()
  })

  it('shows what happened to each object in words and with an icon', () => {
    renderView(ready(ENTRIES))
    const tables = screen.getByRole('region', { name: 'Tables(2)' })
    const [orders, legacy] = within(tables).getAllByRole('listitem')
    expect(orders).toHaveAttribute('data-change', 'changed')
    expect(within(orders as HTMLElement).getByText('Changed')).toBeInTheDocument()
    expect(within(legacy as HTMLElement).getByText('Removed')).toBeInTheDocument()
    expect((legacy as HTMLElement).querySelector('svg')).not.toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Indexes(1)' })).getByText('Added'),
    ).toBeInTheDocument()
  })

  it('shows a classification badge for each class of an object', () => {
    renderView(ready(ENTRIES))
    const tables = screen.getByRole('region', { name: 'Tables(2)' })
    const [orders, legacy] = within(tables).getAllByRole('listitem')
    expect(within(orders as HTMLElement).getByText('Rewrite')).toBeInTheDocument()
    expect(within(orders as HTMLElement).getByText('Security')).toBeInTheDocument()
    expect(within(legacy as HTMLElement).getByText('Destructive')).toBeInTheDocument()
    const index = within(screen.getByRole('region', { name: 'Indexes(1)' }))
    expect(index.getByText('Non-transactional')).toBeInTheDocument()
    const extension = within(screen.getByRole('region', { name: 'Extensions(1)' }))
    expect(extension.queryByText('Destructive')).toBeNull()
  })

  it('explains a badge on keyboard focus', async () => {
    const user = userEvent.setup()
    renderView(ready(ENTRIES))
    const tables = screen.getByRole('region', { name: 'Tables(2)' })
    const badge = within(tables).getByText('Destructive').parentElement
    if (badge === null) throw new Error('no badge')
    badge.focus()
    expect(badge).toHaveFocus()
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('Removes data or objects'),
    )
    await user.keyboard('{Escape}')
  })

  it('summarizes the diff by change and by statement class', () => {
    renderView(ready(ENTRIES))
    expect(screen.getByText('4 objects: 2 added, 1 removed, 1 changed.')).toBeInTheDocument()
    const classes = screen.getByRole('list', { name: 'Statement classes in this diff' })
    const items = within(classes).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Rewrite1',
      'Security1',
      'Destructive1',
      'Non-transactional1',
    ])
  })

  it('shows the schema-qualified name, and only the name for an object outside a schema', () => {
    renderView(ready(ENTRIES))
    const orders = screen.getByText('orders').closest('li')
    expect(orders).toHaveTextContent('public.orders')
    const extension = screen.getByText('pgcrypto').closest('li')
    expect(extension).toHaveTextContent(/^Addedpgcrypto$/)
  })

  it('shows the details as text and none for an empty one', () => {
    renderView(ready(ENTRIES))
    expect(
      screen.getByText('ALTER TABLE public.orders ALTER COLUMN total TYPE numeric(14,2);'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('pgcrypto').closest('li')?.querySelector('[data-untrusted="text"]'),
    ).toBeNull()
  })

  it('shows hostile names, types and details as untrusted text', () => {
    const { container } = renderView(
      ready([
        {
          objectType: 'ta<b>ble</b>\u{202E}',
          schema: '<img src=x onerror=alert(1)>',
          name: 'na\u{200B}me\nline two',
          change: 'changed',
          classes: ['destructive'],
          details: '</pre><script>alert(1)</script>\u{202E}DROP',
        },
      ]),
    )
    expect(container.querySelector('img, script, b')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('[data-code-point="U+200B"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-code-point="U+202E"]').length).toBeGreaterThanOrEqual(
      2,
    )
    expect(container.querySelector('[data-code-point="U+000A"]')).not.toBeNull()
    // The heading of an unknown type is the type itself, as text.
    expect(screen.getByRole('heading')).toHaveTextContent('ta<b>ble</b>')
  })

  it('shows a change it does not know by its own name', () => {
    const { container } = renderView(
      ready([
        { ...ENTRIES[0], change: 'renamed' } as unknown as SchemaDiffEntry,
        { ...ENTRIES[1], classes: ['reindex'] } as unknown as SchemaDiffEntry,
      ]),
    )
    expect(screen.getByText('Unknown change')).toBeInTheDocument()
    expect(screen.getByText('renamed')).toBeInTheDocument()
    // Once in the summary of classes and once on the object.
    expect(screen.getAllByText('reindex')).toHaveLength(2)
    expect(screen.getByText('2 objects: 1 removed, 1 with an unknown change.')).toBeInTheDocument()
    expect(container.querySelector('[data-change="unknown"]')).not.toBeNull()
  })

  it('does not draw a failed read as "no differences"', () => {
    const onRetry = vi.fn()
    renderView(FAILED, { onRetry })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read schema changes')
    expect(screen.getByText(/This does not mean there is no schema changes/)).toBeInTheDocument()
    expect(screen.queryByText('No differences')).toBeNull()
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('says what is missing when the read is partial, and still shows what was read', () => {
    renderView(partial(ENTRIES, ['Functions of schema auth.']))
    expect(screen.getByText('Showing part of schema changes')).toBeInTheDocument()
    expect(screen.getByText('Functions of schema auth.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tables(2)' })).toBeInTheDocument()
  })

  it('words an empty diff by the state of the read', () => {
    const { rerender } = renderView(ready([]))
    expect(screen.getByText('No differences')).toBeInTheDocument()
    expect(screen.getByText('The read succeeded and found no schema changes.')).toBeInTheDocument()

    rerender(
      <TooltipProvider>
        <SchemaDiffView diff={stale([])} now={NOW} />
      </TooltipProvider>,
    )
    expect(
      screen.getByText('The last successful read found no schema changes.'),
    ).toBeInTheDocument()

    rerender(
      <TooltipProvider>
        <SchemaDiffView diff={partial([], ['Tables.'])} now={NOW} />
      </TooltipProvider>,
    )
    expect(screen.queryByText(/The read succeeded/)).toBeNull()
    expect(screen.getByText(/The part that was read has no schema changes/)).toBeInTheDocument()

    rerender(
      <TooltipProvider>
        <SchemaDiffView diff={{ state: 'loading' }} now={NOW} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading schema changes')
  })

  it('puts the group headings at the requested level', () => {
    renderView(ready(ENTRIES), { headingLevel: 4 })
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(3)
  })

  it('puts the class name of the caller on the view in a ready read', () => {
    const { container } = renderView(ready(ENTRIES), { className: 'caller-class' })
    expect(container.querySelector('.caller-class')).not.toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container, rerender } = renderView(ready(ENTRIES))
    expect(await axeViolations(container)).toEqual([])
    rerender(
      <TooltipProvider>
        <SchemaDiffView diff={partial(ENTRIES, ['Tables.'])} now={NOW} />
      </TooltipProvider>,
    )
    expect(await axeViolations(container)).toEqual([])
    rerender(
      <TooltipProvider>
        <SchemaDiffView diff={FAILED} now={NOW} />
      </TooltipProvider>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
