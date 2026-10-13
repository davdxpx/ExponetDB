import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchemaTree, type SchemaTreeProps } from '../../src/schema/schema-tree.tsx'
import type {
  SchemaTreeLoader,
  SchemaTreeObject,
  SchemaTreeSchema,
} from '../../src/schema/schema-tree-types.ts'
import { axeViolations } from '../support/axe.ts'

// A connection URL with a password, as a driver error might carry one; built
// at run time so the repository's secret scan never sees a literal one.
const LEAKY_URL = ['postgres://admin', ':', 'secret', '@10.0.0.1/db'].join('')

import { deferred, FAILED, NOW, partial, ready, stale } from './fixtures.ts'

afterEach(cleanup)

const SCHEMAS: readonly SchemaTreeSchema[] = [{ name: 'public' }, { name: 'exponetdb' }]
const USERS: readonly SchemaTreeObject[] = [{ name: 'users' }, { name: 'orders' }]

type Answer = Readable<readonly SchemaTreeObject[]>

function loaderOf(answer: Answer = ready(USERS)) {
  return vi.fn<SchemaTreeLoader>(async () => answer)
}

function renderTree(props: Partial<SchemaTreeProps> = {}) {
  const loadObjects = props.loadObjects ?? loaderOf()
  const utils = render(
    <TooltipProvider>
      <SchemaTree schemas={ready(SCHEMAS)} loadObjects={loadObjects} now={NOW} {...props} />
    </TooltipProvider>,
  )
  return { ...utils, loadObjects }
}

/** The treeitem that holds a row with this text. */
function itemOf(text: string | RegExp): HTMLElement {
  const item = screen.getAllByText(text)[0]?.closest('[role="treeitem"]')
  if (!(item instanceof HTMLElement)) throw new Error(`no tree item for ${String(text)}`)
  return item
}

async function openClass(
  user: ReturnType<typeof userEvent.setup>,
  schema = 'public',
  cls = 'Tables',
) {
  await user.click(screen.getByText(schema))
  // The second schema's classes are in the page too; take the ones under this schema.
  const schemaItem = itemOf(schema)
  await user.click(within(schemaItem).getByText(cls))
}

describe('SchemaTree', () => {
  it('is a named tree of schemas, collapsed at first, with no object read yet', () => {
    const { loadObjects } = renderTree()
    const tree = screen.getByRole('tree', { name: 'Database schemas' })
    const items = within(tree).getAllByRole('treeitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('aria-expanded', 'false')
    expect(items[0]).toHaveAttribute('aria-level', '1')
    expect(items[0]).toHaveAttribute('aria-setsize', '2')
    expect(items[1]).toHaveAttribute('aria-posinset', '2')
    expect(loadObjects).not.toHaveBeenCalled()
  })

  it('shows the object classes of a schema when it opens', async () => {
    const user = userEvent.setup()
    renderTree()
    await user.click(screen.getByText('public'))
    const publicItem = itemOf('public')
    expect(publicItem).toHaveAttribute('aria-expanded', 'true')
    const classes = within(publicItem)
      .getAllByRole('treeitem')
      .map((item) => item.getAttribute('aria-level'))
    expect(classes).toEqual(Array(8).fill('2'))
    for (const label of [
      'Tables',
      'Views',
      'Materialized views',
      'Foreign tables',
      'Functions',
      'Sequences',
      'Types',
      'Extensions',
    ]) {
      expect(within(publicItem).getByText(label)).toBeInTheDocument()
    }
  })

  it('reads the objects of a class once, the first time it opens', async () => {
    const user = userEvent.setup()
    const { loadObjects } = renderTree()
    await openClass(user)

    expect(await screen.findByText('users')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(1)
    expect(loadObjects).toHaveBeenCalledWith({ schema: 'public', classId: 'table' })
    // The count of a complete read is shown next to the class.
    expect(within(itemOf('Tables')).getByText('2')).toBeInTheDocument()

    // Closing and opening again does not read again.
    const tables = within(itemOf('public')).getByText('Tables')
    await user.click(tables)
    expect(screen.queryByText('users')).toBeNull()
    await user.click(tables)
    expect(screen.getByText('users')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(1)
  })

  it('shows a loading row while the objects are being read and announces when they arrive', async () => {
    const user = userEvent.setup()
    const pending = deferred<Answer>()
    renderTree({ loadObjects: vi.fn<SchemaTreeLoader>(() => pending.promise) })
    await openClass(user)

    const loading = screen.getByText('Loading tables…')
    expect(loading.closest('[data-status="loading"]')).not.toBeNull()
    expect(loading.closest('[role="treeitem"]')).toHaveAttribute('aria-level', '3')
    expect(screen.queryByText(/No tables/)).toBeNull()

    await act(async () => pending.resolve(ready(USERS)))
    expect(await screen.findByText('users')).toBeInTheDocument()
    expect(screen.queryByText('Loading tables…')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Tables loaded: 2.')
  })

  it('shows a failed branch load inside the branch, never as an empty branch', async () => {
    const user = userEvent.setup()
    renderTree({ loadObjects: loaderOf(FAILED) })
    await openClass(user)

    const row = await screen.findByText('Could not read tables')
    const status = row.closest('[data-status="failed"]')
    expect(status).not.toBeNull()
    expect(status).toHaveTextContent('The target did not answer within 5 seconds.')
    expect(status).toHaveTextContent('Error code TARGET_UNREACHABLE')
    expect(status).toHaveTextContent('This does not mean there are no tables.')
    expect(itemOf('Tables').contains(status)).toBe(true)
    expect(screen.queryByText(/No tables/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Could not read tables.')
    // The failure does not leak to the other branches of the tree.
    expect(within(itemOf('exponetdb')).queryByText(/Could not read/)).toBeNull()
  })

  it('reads again from the retry of a failed branch and takes focus back to the branch', async () => {
    const user = userEvent.setup()
    const loadObjects = vi
      .fn<SchemaTreeLoader>()
      .mockResolvedValueOnce(FAILED)
      .mockResolvedValueOnce(ready(USERS))
    renderTree({ loadObjects })
    await openClass(user)

    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('users')).toBeInTheDocument()
    expect(screen.queryByText('Could not read tables')).toBeNull()
    expect(loadObjects).toHaveBeenCalledTimes(2)
    expect(itemOf('Tables')).toHaveFocus()
  })

  it('retries from the keyboard on the status row without selecting it', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const loadObjects = vi
      .fn<SchemaTreeLoader>()
      .mockResolvedValueOnce(FAILED)
      .mockResolvedValueOnce(ready(USERS))
    renderTree({ loadObjects, onSelect })
    await openClass(user)
    await screen.findByText('Could not read tables')
    onSelect.mockClear()

    // Down from the class to its status row, then Enter.
    itemOf('Tables').focus()
    await user.keyboard('{ArrowDown}')
    const status = document.querySelector<HTMLElement>('[data-status="failed"]')
    expect(status).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(await screen.findByText('users')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(2)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('never shows the text of an exception, whether the loader rejects or throws', async () => {
    const user = userEvent.setup()
    const loadObjects = vi
      .fn<SchemaTreeLoader>()
      .mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${LEAKY_URL}`))
      .mockImplementationOnce(() => {
        throw new Error(LEAKY_URL)
      })
    renderTree({ loadObjects })
    await openClass(user)

    const status = await screen.findByText('Could not read tables')
    expect(status.closest('[data-status="failed"]')).toHaveTextContent(
      'The list could not be read.',
    )
    expect(status.closest('[data-status="failed"]')).toHaveTextContent('Error code UNKNOWN')
    expect(document.body).not.toHaveTextContent('secret')

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(loadObjects).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Could not read tables')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('secret')
  })

  it('keeps what was shown, as an earlier read, when a refresh is rejected', async () => {
    const user = userEvent.setup()
    const loadObjects = vi
      .fn<SchemaTreeLoader>()
      .mockResolvedValueOnce(stale(USERS))
      .mockRejectedValueOnce(new Error('x'))
    renderTree({ loadObjects })
    await openClass(user)
    await screen.findByText('users')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(loadObjects).toHaveBeenCalledTimes(2))
    expect(
      await screen.findByText(/Could not refresh: The list could not be read\./),
    ).toBeInTheDocument()
    expect(screen.getByText('users')).toBeInTheDocument()
  })

  it('shows an earlier read with its source and age, and refreshes it', async () => {
    const user = userEvent.setup()
    const loadObjects = vi
      .fn<SchemaTreeLoader>()
      .mockResolvedValueOnce(stale(USERS))
      .mockResolvedValueOnce(ready([{ name: 'fresh_table' }]))
    renderTree({ loadObjects })
    await openClass(user)

    const row = (await screen.findByText('Showing an earlier read of tables')).closest(
      '[data-status]',
    )
    expect(row).toHaveAttribute('data-status', 'stale')
    expect(row).toHaveTextContent('cached, 5 min ago')
    expect(row).toHaveTextContent(
      'Could not refresh: The target did not answer. TARGET_UNREACHABLE',
    )
    expect(screen.getByText('users')).toBeInTheDocument()
    // An earlier read has no count: it may be out of date.
    expect(within(itemOf('Tables')).queryByText('2')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('fresh_table')).toBeInTheDocument()
    expect(screen.queryByText('users')).toBeNull()
    expect(screen.queryByText('Showing an earlier read of tables')).toBeNull()
  })

  it('says what is missing when a branch is only partly read, and shows what was read', async () => {
    const user = userEvent.setup()
    renderTree({
      loadObjects: loaderOf(partial(USERS, ['Tables the role cannot see.', 'Row counts.'])),
    })
    await openClass(user)

    const row = (await screen.findByText('Showing part of the tables')).closest('[data-status]')
    expect(row).toHaveAttribute('data-status', 'partial')
    expect(row).toHaveTextContent('Missing: Tables the role cannot see.; Row counts.')
    expect(screen.getByText('users')).toBeInTheDocument()
    expect(within(itemOf('Tables')).queryByText('2')).toBeNull()
  })

  it('says that a successful read found nothing only when it did', async () => {
    const user = userEvent.setup()
    renderTree({ loadObjects: loaderOf(ready([])) })
    await openClass(user)
    const row = (await screen.findByText(/No tables in/)).closest('[data-status]')
    expect(row).toHaveAttribute('data-status', 'empty')
    expect(row).toHaveTextContent('No tables in public. The read succeeded.')
  })

  it('does not call a partly read empty branch empty', async () => {
    const user = userEvent.setup()
    renderTree({ loadObjects: loaderOf(partial([], ['Everything.'])) })
    await openClass(user)
    expect(await screen.findByText('Showing part of the tables')).toBeInTheDocument()
    expect(screen.queryByText(/No tables in/)).toBeNull()
  })

  it('does not select a status row', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderTree({ loadObjects: loaderOf(ready([])), onSelect })
    await openClass(user)
    onSelect.mockClear()
    const row = (await screen.findByText(/No tables in/)).closest<HTMLElement>('[data-status]')
    if (row === null) throw new Error('no status row')
    await user.click(row)
    expect(row).toHaveFocus()
    expect(onSelect).not.toHaveBeenCalled()
    expect(row).not.toHaveAttribute('aria-selected')
  })

  it('tells the caller what was selected', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderTree({ onSelect })

    await user.click(screen.getByText('public'))
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'schema', schema: 'public' })
    expect(itemOf('public')).toHaveAttribute('aria-selected', 'true')

    await user.click(within(itemOf('public')).getByText('Tables'))
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'class', schema: 'public', classId: 'table' })

    await user.click(await screen.findByText('users'))
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: 'object',
      schema: 'public',
      classId: 'table',
      name: 'users',
      key: 'users',
    })
    expect(itemOf('users')).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).toHaveBeenCalledTimes(3)
  })

  it('works from the keyboard like a tree', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderTree({ onSelect })

    await user.tab()
    expect(itemOf('public')).toHaveFocus()
    expect(itemOf('public')).toHaveAttribute('tabindex', '0')
    expect(itemOf('exponetdb')).toHaveAttribute('tabindex', '-1')

    // Right opens a closed branch, Right again goes to its first child.
    await user.keyboard('{ArrowRight}')
    expect(itemOf('public')).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowRight}')
    expect(within(itemOf('public')).getByText('Tables').closest('[role="treeitem"]')).toHaveFocus()

    // Right on a class opens it and reads its objects.
    await user.keyboard('{ArrowRight}')
    expect(await screen.findByText('users')).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(itemOf('users')).toHaveFocus()

    // Enter selects the object.
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: 'object',
      schema: 'public',
      classId: 'table',
      name: 'users',
      key: 'users',
    })

    // Down and Up walk the visible items; Left goes to the parent.
    await user.keyboard('{ArrowDown}')
    expect(itemOf('orders')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(itemOf('users')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(within(itemOf('public')).getByText('Tables').closest('[role="treeitem"]')).toHaveFocus()

    // Left on an open branch closes it.
    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByText('users')).toBeNull()

    // Home and End.
    await user.keyboard('{End}')
    expect(itemOf('exponetdb')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(itemOf('public')).toHaveFocus()

    // Type-ahead on the first letter walks the visible items: Extensions of public, then exponetdb.
    await user.keyboard('e')
    expect(
      within(itemOf('public')).getByText('Extensions').closest('[role="treeitem"]'),
    ).toHaveFocus()
    await user.keyboard('e')
    expect(itemOf('exponetdb')).toHaveFocus()
  })

  it('opens and selects a branch with Enter', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderTree({ onSelect })
    await user.tab()
    await user.keyboard('{Enter}')
    expect(itemOf('public')).toHaveAttribute('aria-expanded', 'true')
    expect(onSelect).toHaveBeenCalledWith({ kind: 'schema', schema: 'public' })
  })

  it('has one tab stop for the whole tree', async () => {
    const user = userEvent.setup()
    renderTree()
    await user.click(screen.getByText('public'))
    await user.tab()
    // Tab leaves the tree instead of walking through every row.
    expect(document.body).toHaveFocus()
  })

  it('reads two branches independently', async () => {
    const user = userEvent.setup()
    const loadObjects = vi.fn<SchemaTreeLoader>(async ({ schema, classId }) =>
      schema === 'public' && classId === 'table'
        ? FAILED
        : ready([{ name: `${schema}_${classId}` }]),
    )
    renderTree({ loadObjects })
    await user.click(screen.getByText('public'))
    await user.click(within(itemOf('public')).getByText('Tables'))
    await user.click(within(itemOf('public')).getByText('Views'))
    expect(await screen.findByText('public_view')).toBeInTheDocument()
    expect(screen.getByText('Could not read tables')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(2)
  })

  it('uses the classes the caller names', async () => {
    const user = userEvent.setup()
    const { loadObjects } = renderTree({
      classes: [
        { id: 'table', label: 'Tables' },
        { id: 'policy', label: 'Policies' },
      ],
      loadObjects: loaderOf(ready([{ name: 'p1' }])),
    })
    await user.click(screen.getByText('public'))
    expect(within(itemOf('public')).getAllByRole('treeitem')).toHaveLength(2)
    await user.click(within(itemOf('public')).getByText('Policies'))
    expect(await screen.findByText('p1')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledWith({ schema: 'public', classId: 'policy' })
  })

  it('keeps objects that share a name apart', async () => {
    const user = userEvent.setup()
    renderTree({
      loadObjects: loaderOf(
        ready([
          { name: 'f', key: 'f(integer)' },
          { name: 'f', key: 'f(text)' },
          { name: 'g' },
          { name: 'g' },
        ]),
      ),
    })
    await openClass(user, 'public', 'Tables')
    expect(await screen.findAllByText('f')).toHaveLength(2)
    expect(screen.getAllByText('g')).toHaveLength(2)
  })

  it('does not break on an object with an empty name when typing', async () => {
    const user = userEvent.setup()
    renderTree({ loadObjects: loaderOf(ready([{ name: '' }, { name: 'a' }])) })
    await openClass(user)
    expect(await screen.findByText('(empty)')).toBeInTheDocument()
    await user.keyboard('a')
    expect(itemOf('a')).toHaveFocus()
  })

  it('shows hostile names as text with their hidden characters made visible', async () => {
    const user = userEvent.setup()
    const hostile = 'pu\u{202E}blic<img src=x onerror=alert(1)>'
    const { container } = renderTree({
      schemas: ready([{ name: hostile }]),
      loadObjects: loaderOf(ready([{ name: 'ta<b>ble</b>\u{200B}\nsecond' }])),
    })
    await user.click(screen.getByText(/^pu/))
    await user.click(within(container).getByText('Tables'))
    await screen.findByText(/ta<b>ble<\/b>/)

    expect(container.querySelector('img, b')).toBeNull()
    expect(container.querySelector('[data-code-point="U+202E"]')).not.toBeNull()
    expect(container.querySelector('[data-code-point="U+200B"]')).not.toBeNull()
    expect(container.querySelector('[data-code-point="U+000A"]')).not.toBeNull()
    expect(screen.getAllByText('⟨U+202E⟩').length).toBe(1)
    for (const name of container.querySelectorAll('[data-untrusted="name"]')) {
      expect(name).toHaveAttribute('dir', 'ltr')
    }
    // A treeitem has no native tooltip with the raw name.
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('shows a hostile schema name inside the failure of a branch as text', async () => {
    const user = userEvent.setup()
    const { container } = renderTree({
      schemas: ready([{ name: '<script>alert(1)</script>\u{202E}' }]),
      loadObjects: loaderOf(FAILED),
    })
    await user.click(screen.getByText(/script/))
    await user.click(within(container).getByText('Tables'))
    await screen.findByText('Could not read tables')
    expect(container.querySelector('script')).toBeNull()
    expect(
      container.querySelector('[data-status="failed"] [data-code-point="U+202E"]'),
    ).not.toBeNull()
  })

  it('cuts a very long name and says so', async () => {
    const user = userEvent.setup()
    const long = 'n'.repeat(500)
    renderTree({ schemas: ready([{ name: long }]) })
    await user.click(screen.getByText(/^n+$/))
    const name = document.querySelector('[data-untrusted="name"]')
    expect(name?.firstChild?.textContent).toBe('n'.repeat(120))
    expect(name).toHaveTextContent('(name shortened)')
  })

  it('does not draw a failed read of the schemas as an empty tree', () => {
    const onRetry = vi.fn()
    renderTree({ schemas: FAILED, onRetry })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read schemas')
    expect(screen.getByRole('alert')).toHaveTextContent('TARGET_UNREACHABLE')
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.queryByText('No schemas')).toBeNull()
  })

  it('renders the other states of the read of the schemas truthfully', () => {
    const { rerender } = renderTree({ schemas: { state: 'loading' } })
    expect(screen.getByText('Loading schemas')).toBeInTheDocument()
    expect(screen.queryByRole('tree')).toBeNull()

    const wrap = (schemas: Readable<readonly SchemaTreeSchema[]>) => (
      <TooltipProvider>
        <SchemaTree schemas={schemas} loadObjects={loaderOf()} now={NOW} />
      </TooltipProvider>
    )
    rerender(wrap(stale(SCHEMAS)))
    expect(screen.getByText('Showing an earlier read of schemas')).toBeInTheDocument()
    expect(screen.getByRole('tree')).toBeInTheDocument()

    rerender(wrap(partial(SCHEMAS, ['Schemas the role cannot see.'])))
    expect(screen.getByText('Showing part of schemas')).toBeInTheDocument()
    expect(screen.getByRole('tree')).toBeInTheDocument()

    rerender(wrap(ready([])))
    expect(screen.getByText('No schemas')).toBeInTheDocument()
    expect(screen.getByText('The read succeeded and found no schemas.')).toBeInTheDocument()
    expect(screen.queryByRole('tree')).toBeNull()

    rerender(wrap(partial([], ['All of them.'])))
    expect(screen.getByText(/The part that was read has no schemas/)).toBeInTheDocument()
  })

  it('keeps what is open and selected, and what was read, when the read of the schemas is refreshed', async () => {
    const user = userEvent.setup()
    const loadObjects = loaderOf()
    const wrap = (schemas: Readable<readonly SchemaTreeSchema[]>) => (
      <TooltipProvider>
        <SchemaTree schemas={schemas} loadObjects={loadObjects} now={NOW} />
      </TooltipProvider>
    )
    const { rerender } = render(wrap(ready(SCHEMAS)))
    await openClass(user)
    await user.click(await screen.findByText('users'))
    expect(itemOf('users')).toHaveAttribute('aria-selected', 'true')

    rerender(wrap(stale(SCHEMAS)))
    expect(screen.getByText('Showing an earlier read of schemas')).toBeInTheDocument()
    expect(itemOf('users')).toHaveAttribute('aria-selected', 'true')
    expect(itemOf('public')).toHaveAttribute('aria-expanded', 'true')

    rerender(wrap(ready(SCHEMAS)))
    expect(screen.getByText('users')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(1)
  })

  it('does not report a selection again when the tree is drawn again', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const wrap = (schemas: Readable<readonly SchemaTreeSchema[]>) => (
      <TooltipProvider>
        <SchemaTree schemas={schemas} loadObjects={loaderOf()} onSelect={onSelect} now={NOW} />
      </TooltipProvider>
    )
    const { rerender } = render(wrap(ready(SCHEMAS)))
    await user.click(screen.getByText('public'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    rerender(wrap(stale(SCHEMAS)))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('reads a branch once under React StrictMode, which runs effects twice', async () => {
    const user = userEvent.setup()
    const loadObjects = loaderOf()
    render(
      <StrictMode>
        <TooltipProvider>
          <SchemaTree schemas={ready(SCHEMAS)} loadObjects={loadObjects} now={NOW} />
        </TooltipProvider>
      </StrictMode>,
    )
    await openClass(user)
    expect(await screen.findByText('users')).toBeInTheDocument()
    expect(loadObjects).toHaveBeenCalledTimes(1)
  })

  it('ignores a load that finishes after the tree is gone', async () => {
    const user = userEvent.setup()
    const pending = deferred<Answer>()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderTree({ loadObjects: vi.fn<SchemaTreeLoader>(() => pending.promise) })
    await openClass(user)
    unmount()
    await act(async () => pending.resolve(ready(USERS)))
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('puts the class name of the caller on the tree', () => {
    const { container } = renderTree({ className: 'caller-class' })
    expect(container.querySelector('.caller-class [role="tree"]')).not.toBeNull()
  })

  it('has no accessibility violations', async () => {
    const user = userEvent.setup()
    const { container } = renderTree()
    expect(await axeViolations(container)).toEqual([])
    await openClass(user)
    await screen.findByText('users')
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no accessibility violations in a failed, partial, earlier or empty branch', async () => {
    const user = userEvent.setup()
    const answers: Record<string, Answer> = {
      table: FAILED,
      view: partial(USERS, ['Row counts.']),
      function: stale(USERS),
      sequence: ready([]),
    }
    const loadObjects = vi.fn<SchemaTreeLoader>(
      async ({ classId }) => answers[classId] ?? ready([]),
    )
    const { container } = renderTree({ loadObjects })
    await user.click(screen.getByText('public'))
    const schemaItem = itemOf('public')
    for (const label of ['Tables', 'Views', 'Functions', 'Sequences']) {
      await user.click(within(schemaItem).getByText(label))
    }
    await waitFor(() => expect(container.querySelectorAll('[data-status]')).toHaveLength(4))
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no accessibility violations in the failed and loading states of the schemas', async () => {
    const { container, rerender } = renderTree({ schemas: FAILED })
    expect(await axeViolations(container)).toEqual([])
    rerender(
      <TooltipProvider>
        <SchemaTree schemas={{ state: 'loading' }} loadObjects={loaderOf()} now={NOW} />
      </TooltipProvider>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
