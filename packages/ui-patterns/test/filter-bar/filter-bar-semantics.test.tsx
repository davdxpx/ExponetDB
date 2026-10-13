import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FilterBar, type FilterBarProps } from '../../src/filter-bar/filter-bar.tsx'
import type { FilterBarHandle } from '../../src/filter-bar/filter-bar-context.tsx'
import type { FilterGroup, FilterProperty } from '../../src/filter-bar/types.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const emptyFilters: FilterGroup = { logicalOperator: 'AND', conditions: [] }

const properties: FilterProperty[] = [
  { label: 'Name', name: 'name', type: 'string', operators: ['=', '!=', 'CONTAINS'] },
  {
    label: 'Status',
    name: 'status',
    type: 'string',
    options: ['active', 'inactive', 'pending'],
    operators: ['=', '!='],
  },
  { label: 'Count', name: 'count', type: 'number', operators: ['=', '>', '<'] },
]

type HarnessProps = Partial<
  Pick<FilterBarProps, 'filterProperties' | 'supportsOperators' | 'isLoading' | 'variant'>
> & {
  initial?: FilterGroup
  onApply?: (filters: FilterGroup) => void
  onFilterChange?: (filters: FilterGroup) => void
  children?: ReactNode
}

/** A controlled bar, the way a page uses it. */
function Harness({
  initial = emptyFilters,
  filterProperties = properties,
  onApply,
  onFilterChange,
  ...rest
}: HarnessProps) {
  const [filters, setFilters] = useState(initial)
  const [freeformText, setFreeformText] = useState('')
  return (
    <FilterBar
      filterProperties={filterProperties}
      filters={filters}
      onFilterChange={(next) => {
        setFilters(next)
        onFilterChange?.(next)
      }}
      onApply={onApply}
      freeformText={freeformText}
      onFreeformTextChange={setFreeformText}
      {...rest}
    />
  )
}

function withCondition(condition: FilterGroup['conditions'][number]): FilterGroup {
  return { logicalOperator: 'AND', conditions: [condition] }
}

describe('FilterBar combobox semantics', () => {
  it('is a named group whose search field is a collapsed combobox until it takes focus', () => {
    render(<Harness />)

    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument()
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).toHaveAttribute('aria-haspopup', 'listbox')
    expect(input).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('announces a value field as a combobox only when it offers values', () => {
    render(
      <Harness
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'name', operator: '=', value: '' },
            { propertyName: 'status', operator: '=', value: '' },
          ],
        }}
      />,
    )

    // Free text: a plain text field, not a collapsed combobox that never opens.
    expect(screen.getByRole('textbox', { name: 'Value for Name' })).not.toHaveAttribute(
      'aria-expanded',
    )
    expect(screen.getByRole('combobox', { name: 'Value for Status' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('takes a name from the caller', () => {
    render(
      <FilterBar.Root
        filterProperties={properties}
        filters={emptyFilters}
        onFilterChange={() => {}}
        freeformText=""
        onFreeformTextChange={() => {}}
        label="Audit filters"
      >
        <FilterBar.Content />
      </FilterBar.Root>,
    )

    expect(screen.getByRole('group', { name: 'Audit filters' })).toBeInTheDocument()
  })

  it('opens a named listbox of options that the combobox controls and highlights one', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })

    await user.click(input)

    const listbox = await screen.findByRole('listbox', { name: 'Properties' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(input).toHaveAttribute('aria-controls', listbox.id))
    const options = within(listbox).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Name', 'Status', 'Count'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id))
    // The field keeps keyboard focus; the list never takes it.
    expect(input).toHaveFocus()
  })

  it('moves the highlight with the arrow keys and announces it through aria-activedescendant', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    await user.click(input)
    const listbox = await screen.findByRole('listbox', { name: 'Properties' })

    await user.keyboard('{ArrowDown}')
    const status = within(listbox).getByRole('option', { name: 'Status' })
    expect(status).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', status.id))

    await user.keyboard('{ArrowDown}{ArrowDown}')
    const count = within(listbox).getByRole('option', { name: 'Count' })
    expect(count).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', count.id))

    await user.keyboard('{ArrowUp}')
    expect(within(listbox).getByRole('option', { name: 'Status' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('highlights the option under the pointer', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    await user.click(input)
    const count = await screen.findByRole('option', { name: 'Count' })

    await user.hover(count)

    expect(count).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', count.id))
    // Pressing an option does not take focus from the field.
    expect(input).toHaveFocus()
  })

  it('dismisses the list with Escape and keeps the cursor in the field', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(<Harness onFilterChange={onFilterChange} />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    await user.click(input)
    await screen.findByRole('listbox', { name: 'Properties' })

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(input).toHaveFocus()

    // Enter does not pick from a list that is not shown.
    await user.keyboard('{Enter}')
    expect(onFilterChange).not.toHaveBeenCalled()

    // An arrow key shows the list again.
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox', { name: 'Properties' })).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows a dismissed list again when the person types', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    await user.click(input)
    await screen.findByRole('listbox', { name: 'Properties' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

    await user.keyboard('s')

    const listbox = await screen.findByRole('listbox', { name: 'Properties' })
    expect(within(listbox).getByRole('option', { name: 'Status' })).toBeInTheDocument()
  })

  it('leaves the field with a second Escape', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Add filter' })
    await user.click(input)
    await screen.findByRole('listbox', { name: 'Properties' })

    await user.keyboard('{Escape}{Escape}')

    await waitFor(() => expect(input).not.toHaveFocus())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('dismisses the operator and value lists the same way', async () => {
    const user = userEvent.setup()
    render(<Harness initial={withCondition({ propertyName: 'status', operator: '', value: '' })} />)
    const operator = screen.getByRole('combobox', { name: 'Operator for Status' })
    await user.click(operator)
    await screen.findByRole('listbox', { name: 'Operators' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(operator).toHaveFocus()

    const value = screen.getByRole('combobox', { name: 'Value for Status' })
    await user.click(value)
    await screen.findByRole('listbox', { name: 'Values' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(value).toHaveFocus()
  })

  it('narrows the properties while typing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('combobox', { name: 'Add filter' }))

    await user.keyboard('sta')

    const listbox = await screen.findByRole('listbox', { name: 'Properties' })
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    expect(within(listbox).getByRole('option', { name: 'Status' })).toBeInTheDocument()
  })
})

describe('FilterBar keyboard operation', () => {
  it('builds a condition from the keyboard: property, operator, value', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(<Harness onApply={onApply} />)

    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Add filter' })).toHaveFocus()
    await screen.findByRole('listbox', { name: 'Properties' })
    await user.keyboard('{ArrowDown}{Enter}') // Status

    const operator = await screen.findByRole('combobox', { name: 'Operator for Status' })
    await waitFor(() => expect(operator).toHaveFocus())
    const operators = await screen.findByRole('listbox', { name: 'Operators' })
    expect(within(operators).getAllByRole('option')).toHaveLength(2)
    await user.keyboard('{Enter}') // =

    const value = await screen.findByRole('combobox', { name: 'Value for Status' })
    await waitFor(() => expect(value).toHaveFocus())
    const values = await screen.findByRole('listbox', { name: 'Values' })
    expect(
      within(values)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['active', 'inactive', 'pending'])
    await user.keyboard('{ArrowDown}{Enter}') // inactive

    await waitFor(() =>
      expect(onApply).toHaveBeenLastCalledWith({
        logicalOperator: 'AND',
        conditions: [{ propertyName: 'status', operator: '=', value: 'inactive' }],
      }),
    )
    // Focus returns to the search field to add the next condition.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Add filter' })).toHaveFocus())
  })

  it('commits a typed value with Enter', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '=', value: '' })}
        onApply={onApply}
      />,
    )

    await user.click(screen.getByLabelText('Value for Name'))
    await user.keyboard('billing{Enter}')

    await waitFor(() =>
      expect(onApply).toHaveBeenLastCalledWith({
        logicalOperator: 'AND',
        conditions: [{ propertyName: 'name', operator: '=', value: 'billing' }],
      }),
    )
  })

  it('removes a condition with its labelled button and keeps the cursor in the bar', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '=', value: 'a' })}
        onFilterChange={onFilterChange}
      />,
    )

    const remove = screen.getByRole('button', { name: 'Remove Name filter' })
    remove.focus()
    await user.keyboard('{Enter}')

    expect(onFilterChange).toHaveBeenLastCalledWith(emptyFilters)
    expect(screen.queryByRole('combobox', { name: 'Value for Name' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Add filter' })).toHaveFocus())
  })

  it('selects the last condition with Backspace in the empty field, then removes it with the next', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(
      <Harness
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'name', operator: '=', value: 'a' },
            { propertyName: 'status', operator: '=', value: 'active' },
          ],
        }}
        onFilterChange={onFilterChange}
      />,
    )

    await user.click(screen.getByRole('combobox', { name: 'Add filter' }))
    await user.keyboard('{Backspace}')

    // The first Backspace only marks the condition that the next one would remove.
    expect(onFilterChange).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Status filter' })).toHaveAttribute(
      'data-highlighted',
      'true',
    )

    await user.keyboard('{Backspace}')

    expect(onFilterChange).toHaveBeenLastCalledWith({
      logicalOperator: 'AND',
      conditions: [{ propertyName: 'name', operator: '=', value: 'a' }],
    })
    expect(screen.queryByRole('group', { name: 'Status filter' })).not.toBeInTheDocument()
  })

  it('shows a condition of an unknown property as text and lets the person remove it', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(
      <Harness
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'retired_column', operator: '=', value: 'x' },
            { propertyName: 'name', operator: '=', value: 'a' },
          ],
        }}
        onFilterChange={onFilterChange}
      />,
    )

    // It still applies, so it is not hidden.
    const unknown = screen.getByRole('group', { name: 'retired_column filter, unknown property' })
    expect(unknown).toHaveTextContent('retired_column = x')

    await user.click(screen.getByRole('button', { name: 'Remove retired_column filter' }))

    expect(onFilterChange).toHaveBeenLastCalledWith({
      logicalOperator: 'AND',
      conditions: [{ propertyName: 'name', operator: '=', value: 'a' }],
    })
  })

  it('removes a condition with Backspace in its empty operator field', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '', value: '' })}
        onFilterChange={onFilterChange}
      />,
    )

    const operator = screen.getByRole('combobox', { name: 'Operator for Name' })
    await user.click(operator)
    await user.keyboard('{Backspace}')

    expect(onFilterChange).toHaveBeenLastCalledWith(emptyFilters)
  })

  it('switches the property of a condition from the keyboard', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '=', value: 'a' })}
        onApply={onApply}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Change property from Name' }))
    const listbox = await screen.findByRole('listbox', { name: 'Properties' })
    // The property being changed is not offered again.
    expect(within(listbox).queryByRole('option', { name: 'Name' })).not.toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}') // Count

    await waitFor(() =>
      expect(onApply).toHaveBeenLastCalledWith({
        logicalOperator: 'AND',
        conditions: [{ propertyName: 'count', operator: '=', value: 'a' }],
      }),
    )
  })

  it('toggles AND and OR with a button named by its state when groups are supported', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(
      <Harness
        supportsOperators
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'name', operator: '=', value: 'a' },
            { propertyName: 'status', operator: '=', value: 'active' },
          ],
        }}
        onApply={onApply}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'AND, change to OR' }))

    expect(onApply).toHaveBeenLastCalledWith({
      logicalOperator: 'OR',
      conditions: [
        { propertyName: 'name', operator: '=', value: 'a' },
        { propertyName: 'status', operator: '=', value: 'active' },
      ],
    })
    expect(screen.getByRole('button', { name: 'OR, change to AND' })).toBeInTheDocument()
  })

  it('focuses the search field through its handle', async () => {
    const handle: { current: FilterBarHandle | null } = { current: null }
    render(
      <FilterBar
        ref={(value) => {
          handle.current = value
        }}
        filterProperties={properties}
        filters={emptyFilters}
        onFilterChange={() => {}}
        freeformText=""
        onFreeformTextChange={() => {}}
      />,
    )

    handle.current?.focus()

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Add filter' })).toHaveFocus())
  })

  it('marks the bar busy while it loads', () => {
    const { container } = render(<Harness isLoading />)

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
  })
})

describe('FilterBar suggestions that the caller loads', () => {
  const loaded: FilterProperty = {
    label: 'Target',
    name: 'target',
    type: 'string',
    operators: ['='],
  }
  const initial = withCondition({ propertyName: 'target', operator: '=', value: '' })

  it('asks the caller after typing pauses and lists the answer as options', async () => {
    const user = userEvent.setup()
    const options = vi.fn(async (search?: string) => [
      { label: `billing/api (${search || 'all'})`, value: 'tgt_1' },
      'reports/api',
    ])
    render(<Harness initial={initial} filterProperties={[{ ...loaded, options }]} />)

    await user.click(screen.getByRole('combobox', { name: 'Value for Target' }))

    const listbox = await screen.findByRole('listbox', { name: 'Values' }, { timeout: 3000 })
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['billing/api (all)', 'reports/api'])
    expect(options).toHaveBeenCalledWith('')

    await user.keyboard('rep')
    await waitFor(() => expect(options).toHaveBeenLastCalledWith('rep'), { timeout: 3000 })
    expect(
      await screen.findByRole('option', { name: 'billing/api (rep)' }, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('says that suggestions are loading while the caller has not answered', async () => {
    const user = userEvent.setup()
    let answer: (value: string[]) => void = () => {}
    const options = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve
        }),
    )
    render(<Harness initial={initial} filterProperties={[{ ...loaded, options }]} />)

    await user.click(screen.getByRole('combobox', { name: 'Value for Target' }))

    expect(await screen.findByRole('status', {}, { timeout: 3000 })).toHaveTextContent(
      'Loading suggestions',
    )
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    answer(['billing/api'])

    expect(await screen.findByRole('option', { name: 'billing/api' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says "Could not load suggestions" when the caller fails, never an empty list', async () => {
    const user = userEvent.setup()
    const options = vi.fn(async () => {
      throw new Error('request failed')
    })
    render(<Harness initial={initial} filterProperties={[{ ...loaded, options }]} />)
    const value = screen.getByRole('combobox', { name: 'Value for Target' })

    await user.click(value)

    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent('Could not load suggestions')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/no (results|suggestions|matches)/i)).not.toBeInTheDocument()
    // The person can still type a value by hand.
    await user.keyboard('manual')
    expect(value).toHaveValue('manual')
  })

  it('shows the failure and also the older suggestions when a later search fails', async () => {
    const user = userEvent.setup()
    const options = vi.fn(async (search?: string) => {
      if (search === 'x') throw new Error('request failed')
      return ['billing/api']
    })
    render(<Harness initial={initial} filterProperties={[{ ...loaded, options }]} />)

    await user.click(screen.getByRole('combobox', { name: 'Value for Target' }))
    await screen.findByRole('option', { name: 'billing/api' }, { timeout: 3000 })

    await user.keyboard('x')

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Could not load suggestions',
    )
  })

  const withOperators: FilterProperty = {
    ...loaded,
    operators: [
      { value: '=', label: 'Equals', group: 'comparison' },
      { value: 'like', label: 'Like', group: 'pattern' },
      { value: 'is', label: 'Is', group: 'setNull' },
    ],
  }

  it('does not ask the caller for a pattern operator: the person types freely', async () => {
    const user = userEvent.setup()
    const options = vi.fn(async () => ['billing/api'])
    render(
      <Harness
        initial={withCondition({ propertyName: 'target', operator: 'like', value: '' })}
        filterProperties={[{ ...withOperators, options }]}
      />,
    )

    await user.click(screen.getByRole('textbox', { name: 'Value for Target' }))
    await new Promise((resolve) => setTimeout(resolve, 450))

    expect(options).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers the values of IS instead of asking the caller', async () => {
    const user = userEvent.setup()
    const options = vi.fn(async () => ['billing/api'])
    render(
      <Harness
        initial={withCondition({ propertyName: 'target', operator: 'is', value: '' })}
        filterProperties={[{ ...withOperators, options }]}
      />,
    )

    await user.click(screen.getByRole('combobox', { name: 'Value for Target' }))

    const listbox = await screen.findByRole('listbox', { name: 'Values' })
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['NULL', 'NOT NULL'])
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(options).not.toHaveBeenCalled()
  })
})

describe('FilterBar untrusted content', () => {
  const markup = '<img src=x onerror=alert(1)><b>bold</b>'

  it('renders a typed value and option labels as text, never as markup', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '=', value: markup })}
        filterProperties={[
          {
            label: 'Name',
            name: 'name',
            type: 'string',
            operators: ['='],
            options: [{ label: markup, value: 'v' }, '<script>x</script>'],
          },
        ]}
      />,
    )

    expect(screen.getByLabelText('Value for Name')).toHaveValue(markup)
    await user.click(screen.getByLabelText('Value for Name'))
    const listbox = await screen.findByRole('listbox', { name: 'Values' })

    expect(within(listbox).getByRole('option', { name: markup })).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: '<script>x</script>' })).toBeInTheDocument()
    for (const root of [container, document.body]) {
      expect(root.querySelector('img')).toBeNull()
      expect(root.querySelector('b')).toBeNull()
      expect(root.querySelector('script')).toBeNull()
    }
  })

  it('emits a structured value, not SQL, for text that looks like SQL', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '=', value: '' })}
        onApply={onApply}
      />,
    )

    await user.click(screen.getByLabelText('Value for Name'))
    await user.keyboard("x'; DROP TABLE users; --{Enter}")

    await waitFor(() =>
      expect(onApply).toHaveBeenLastCalledWith({
        logicalOperator: 'AND',
        conditions: [{ propertyName: 'name', operator: '=', value: "x'; DROP TABLE users; --" }],
      }),
    )
  })
})

describe('FilterBar accessibility', () => {
  it('has no axe violations at rest, with conditions', async () => {
    render(
      <Harness
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'name', operator: '=', value: 'billing' },
            { propertyName: 'status', operator: '!=', value: 'pending' },
          ],
        }}
      />,
    )

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with groups and the AND/OR button', async () => {
    render(
      <Harness
        supportsOperators
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'name', operator: '=', value: 'billing' },
            {
              logicalOperator: 'OR',
              conditions: [{ propertyName: 'status', operator: '=', value: 'active' }],
            },
          ],
        }}
      />,
    )

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with the property list open', async () => {
    const user = userEvent.setup()
    render(<Harness supportsOperators />)
    await user.click(screen.getByRole('combobox', { name: 'Add filter' }))
    await screen.findByRole('listbox', { name: 'Properties' })

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with the operator list (grouped) open', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={withCondition({ propertyName: 'name', operator: '', value: '' })}
        filterProperties={[
          {
            label: 'Name',
            name: 'name',
            type: 'string',
            operators: [
              { value: '=', label: 'Equals', group: 'comparison' },
              { value: 'like', label: 'Like', group: 'pattern' },
              { value: 'is', label: 'Is', group: 'setNull' },
            ],
          },
        ]}
      />,
    )
    await user.click(screen.getByRole('combobox', { name: 'Operator for Name' }))
    const listbox = await screen.findByRole('listbox', { name: 'Operators' })

    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('Comparison')).toBeInTheDocument()
    expect(screen.getByText('Pattern matching')).toBeInTheDocument()
    expect(screen.getByText('Set and null checks')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with the value list open and an option taken', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'status', operator: '=', value: 'active' },
            { propertyName: 'status', operator: '=', value: '' },
          ],
        }}
      />,
    )
    const values = screen.getAllByRole('combobox', { name: 'Value for Status' })
    await user.click(values[1] as HTMLElement)
    const listbox = await screen.findByRole('listbox', { name: 'Values' })

    // A value that another condition already uses cannot be picked twice.
    const taken = within(listbox).getByRole('option', { name: /^active/ })
    expect(taken).toHaveAttribute('aria-disabled', 'true')
    expect(taken).toHaveTextContent('already used')
    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with the failure message shown', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={withCondition({ propertyName: 'target', operator: '=', value: '' })}
        filterProperties={[
          {
            label: 'Target',
            name: 'target',
            type: 'string',
            operators: ['='],
            options: async () => {
              throw new Error('request failed')
            },
          },
        ]}
      />,
    )
    await user.click(screen.getByRole('combobox', { name: 'Value for Target' }))
    await screen.findByRole('alert', {}, { timeout: 3000 })

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with the caller’s own picker open', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initial={withCondition({ propertyName: 'range', operator: '=', value: '' })}
        filterProperties={[
          {
            label: 'Time range',
            name: 'range',
            type: 'date',
            operators: ['='],
            options: {
              component: ({ onChange, onCancel }) => (
                <div>
                  <button type="button" onClick={() => onChange('1h')}>
                    Last hour
                  </button>
                  <button type="button" onClick={onCancel}>
                    Cancel
                  </button>
                </div>
              ),
            },
          },
        ]}
      />,
    )
    const value = screen.getByRole('combobox', { name: 'Value for Time range' })
    await user.click(value)

    expect(await screen.findByRole('dialog', { name: 'Values' })).toBeInTheDocument()
    expect(value).toHaveAttribute('aria-haspopup', 'dialog')
    expect(await axeViolations()).toEqual([])
  })
})
