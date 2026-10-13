import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { flattenTree, type INodeRendererProps, TreeView, TreeViewItem } from '../src/tree-view.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const data = flattenTree({
  name: '',
  children: [
    { name: 'public', children: [{ name: 'users' }, { name: 'orders' }] },
    { name: 'exponetdb', children: [{ name: 'ledger' }] },
  ],
})

function renderNode({
  element,
  getNodeProps,
  isBranch,
  isExpanded,
  isSelected,
  level,
  setsize,
  posinset,
  isDisabled,
  isHalfSelected,
  handleSelect,
  handleExpand,
  treeState,
  dispatch,
}: INodeRendererProps) {
  return (
    <TreeViewItem
      {...getNodeProps()}
      name={element.name}
      level={level}
      isBranch={isBranch}
      isExpanded={isExpanded}
      isSelected={isSelected}
      setsize={setsize}
      posinset={posinset}
      isDisabled={isDisabled}
      isHalfSelected={isHalfSelected}
      handleSelect={handleSelect}
      handleExpand={handleExpand}
      treeState={treeState}
      dispatch={dispatch}
    />
  )
}

describe('TreeView', () => {
  it('is a named tree of treeitems with their level and position', async () => {
    render(
      <TreeView
        data={data}
        aria-label="Schemas"
        defaultExpandedIds={[1]}
        nodeRenderer={renderNode}
      />,
    )

    const tree = screen.getByRole('tree', { name: 'Schemas' })
    const items = within(tree).getAllByRole('treeitem')
    expect(items).toHaveLength(4)

    const publicSchema = items[0]
    expect(publicSchema).toHaveAttribute('aria-level', '1')
    expect(publicSchema).toHaveAttribute('aria-expanded', 'true')
    expect(publicSchema).toHaveAttribute('aria-setsize', '2')
    expect(publicSchema).toHaveAttribute('aria-posinset', '1')

    const users = items[1]
    expect(users).toHaveAttribute('aria-level', '2')
    expect(users).toHaveAttribute('aria-selected', 'false')
    expect(users).not.toHaveAttribute('aria-expanded')
    expect(items[3]).toHaveAttribute('aria-expanded', 'false')
    expect(await axeViolations()).toEqual([])
  })

  it('puts the state of a branch on its treeitem only, not on the row inside it', () => {
    const { container } = render(
      <TreeView
        data={data}
        aria-label="Schemas"
        defaultExpandedIds={[1]}
        nodeRenderer={renderNode}
      />,
    )

    const rows = container.querySelectorAll('[data-treeview-is-branch="true"]')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).not.toHaveAttribute('aria-expanded')
      expect(row).not.toHaveAttribute('aria-selected')
      expect(row).not.toHaveAttribute('role')
    }
    expect(rows[0]).toHaveAttribute('data-state', 'open')
    expect(rows[1]).toHaveAttribute('data-state', 'closed')
    // no stray attributes from the renderer reach the DOM
    expect(container.querySelector('[setsize], [posinset], [disabled]')).toBeNull()
  })

  it('renders names as text, never as markup', () => {
    const hostile = flattenTree({
      name: '',
      children: [{ name: '<img src=x onerror=alert(1)>' }, { name: '<b>bold</b>' }],
    })
    render(<TreeView data={hostile} aria-label="Objects" nodeRenderer={renderNode} />)

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(screen.getByText('<b>bold</b>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
  })

  it('moves with the arrow keys, expands with ArrowRight and selects with Enter', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <TreeView data={data} aria-label="Schemas" onSelect={onSelect} nodeRenderer={renderNode} />,
    )

    const [publicSchema, exponetdb] = screen.getAllByRole('treeitem')
    await user.tab()
    expect(publicSchema).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(publicSchema).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('treeitem', { name: 'users' })).toBeInTheDocument()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('treeitem', { name: 'users' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('treeitem', { name: 'users' })).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).toHaveBeenCalled()

    await user.keyboard('{ArrowLeft}')
    expect(publicSchema).toHaveFocus()
    expect(exponetdb).toBeInTheDocument()
  })

  it('shows loading on a branch without the folder state changing', () => {
    render(
      <TreeView
        data={data}
        aria-label="Schemas"
        nodeRenderer={({ element, getNodeProps, isBranch, level, isExpanded }) => (
          <TreeViewItem
            {...getNodeProps()}
            name={element.name}
            level={level}
            isBranch={isBranch}
            isExpanded={isExpanded}
            isLoading
          />
        )}
      />,
    )

    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })
})

describe('TreeViewItem rename', () => {
  function Rename({ onSubmit }: { onSubmit: (value: string) => void }) {
    const [editing, setEditing] = useState(true)
    return (
      <TreeView
        data={data}
        aria-label="Schemas"
        nodeRenderer={({ element, getNodeProps, isBranch, level }) => (
          <TreeViewItem
            {...getNodeProps()}
            name={element.name}
            level={level}
            isBranch={isBranch}
            isEditing={editing && element.name === 'public'}
            editLabel="Schema name"
            onEditSubmit={(value) => {
              onSubmit(value)
              setEditing(false)
            }}
          />
        )}
      />
    )
  }

  it('shows a labelled field only on the row being renamed, and only while renaming', async () => {
    render(<Rename onSubmit={() => {}} />)

    const input = screen.getByRole('textbox', { name: 'Schema name' })
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(input).toHaveValue('public')
    expect(input).toHaveFocus()
    expect(await axeViolations()).toEqual([])
  })

  it('submits the new name on Enter once the opening grace period is over', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    render(<Rename onSubmit={onSubmit} />)
    now.mockReturnValue(5_000)

    const input = screen.getByRole('textbox', { name: 'Schema name' })
    await user.clear(input)
    await user.type(input, 'app{Enter}')

    expect(onSubmit).toHaveBeenCalledWith('app')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('ignores a blur that comes right after the rename started (a closing menu)', async () => {
    const onSubmit = vi.fn()
    render(<Rename onSubmit={onSubmit} />)

    const input = screen.getByRole('textbox', { name: 'Schema name' })
    input.blur()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it('stays in rename mode when the field is clicked (the click does not reach the row)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    render(<Rename onSubmit={onSubmit} />)
    now.mockReturnValue(5_000)

    const input = screen.getByRole('textbox', { name: 'Schema name' })
    await user.click(input)

    expect(input).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getAllByRole('treeitem')[0]).toHaveAttribute('aria-expanded', 'false')
  })

  it('puts the old name back on Escape', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Rename onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox', { name: 'Schema name' }), 'xyz{Escape}')

    expect(onSubmit).toHaveBeenCalledWith('public')
  })

  it('keeps the keys of the field away from the tree', async () => {
    const user = userEvent.setup()
    render(<Rename onSubmit={() => {}} />)

    const tree = screen.getByRole('tree')
    const onKeyDown = vi.fn()
    tree.addEventListener('keydown', onKeyDown)
    await user.type(screen.getByRole('textbox', { name: 'Schema name' }), 'ab')

    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
