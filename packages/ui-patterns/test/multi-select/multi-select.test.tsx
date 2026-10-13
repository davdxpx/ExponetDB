// Derived from supabase/supabase packages/ui-patterns/src/multi-select/multi-select.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MultiSelector,
  MultiSelectorContent,
  MultiSelectorInput,
  MultiSelectorItem,
  MultiSelectorList,
  MultiSelectorTrigger,
} from '../../src/multi-select/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const ENVIRONMENTS = ['development', 'staging', 'preview', 'production']

function Demo({
  initial = [],
  onChange,
  creatable = false,
  loading = false,
  error = false,
  disabled = false,
  triggerProps,
}: {
  initial?: string[]
  onChange?: (values: string[]) => void
  creatable?: boolean
  loading?: boolean
  error?: boolean
  disabled?: boolean
  triggerProps?: Partial<React.ComponentProps<typeof MultiSelectorTrigger>>
}) {
  const [values, setValues] = useState<string[]>(initial)
  return (
    <MultiSelector
      label="Environments"
      values={values}
      disabled={disabled}
      onValuesChange={(next) => {
        setValues(next)
        onChange?.(next)
      }}
    >
      <MultiSelectorTrigger label="Select environments" {...triggerProps} />
      <MultiSelectorContent>
        <MultiSelectorInput placeholder="Search environments" showResetIcon />
        <MultiSelectorList
          creatable={creatable}
          loading={loading}
          error={error}
          errorLabel="Could not read environments"
        >
          {ENVIRONMENTS.map((name) => (
            <MultiSelectorItem key={name} value={name} disabled={name === 'preview'}>
              {name}
            </MultiSelectorItem>
          ))}
        </MultiSelectorList>
      </MultiSelectorContent>
    </MultiSelector>
  )
}

/** The combobox button; while the list is open the search field is a second combobox. */
function trigger(): HTMLElement {
  const found = screen.getAllByRole('combobox').find((element) => element.tagName === 'BUTTON')
  if (found === undefined) throw new Error('No combobox button')
  return found
}

describe('MultiSelector trigger', () => {
  it('is a combobox button named by its label, closed at first', () => {
    render(<Demo />)

    expect(trigger()).toHaveAccessibleName('Select environments')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(trigger().tagName).toBe('BUTTON')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('falls back to the label of the whole control for its name', () => {
    render(
      <MultiSelector label="Environments" values={[]} onValuesChange={() => undefined}>
        <MultiSelectorTrigger />
      </MultiSelector>,
    )

    expect(trigger()).toHaveAccessibleName('Environments')
  })

  it('shows chosen values as a list of chips, each with its own remove button', () => {
    render(<Demo initial={['staging', 'production']} />)

    const chips = screen.getByRole('list', { name: 'Environments, selected' })
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2)
    expect(within(chips).getByText('staging')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove staging' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove production' })).toBeInTheDocument()
    // No control is nested in the combobox.
    expect(within(trigger()).queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the name of the trigger when chips replace the visible label', () => {
    const { rerender } = render(
      <MultiSelector values={[]} onValuesChange={() => undefined}>
        <MultiSelectorTrigger label="Select environments" />
      </MultiSelector>,
    )
    expect(trigger()).toHaveTextContent('Select environments')

    rerender(
      <MultiSelector values={['staging']} onValuesChange={() => undefined}>
        <MultiSelectorTrigger label="Select environments" />
      </MultiSelector>,
    )

    expect(trigger()).toHaveAccessibleName('Select environments')
    expect(screen.getByText('staging')).toBeInTheDocument()
  })

  it('removes a chip with its button and moves focus to the next chip', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo initial={['development', 'staging', 'production']} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Remove development' }))

    expect(onChange).toHaveBeenCalledWith(['staging', 'production'])
    expect(screen.queryByText('development')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove staging' })).toHaveFocus()
  })

  it('removes a chip with the keyboard (Enter) and moves focus to the trigger after the last', async () => {
    const user = userEvent.setup()
    render(<Demo initial={['staging']} />)

    screen.getByRole('button', { name: 'Remove staging' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('names the remove button after the plain text of a value that is shown differently', () => {
    render(
      <MultiSelector values={['101']} onValuesChange={() => undefined}>
        <MultiSelectorTrigger
          renderValue={(value) => `Public.MixedCase_${value}`}
          valueLabel={(value) => `table ${value}`}
        />
      </MultiSelector>,
    )

    expect(screen.getByText('Public.MixedCase_101')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove table 101' })).toBeInTheDocument()
  })

  it('shows the label next to the chips when asked', () => {
    render(
      <MultiSelector values={['staging']} onValuesChange={() => undefined}>
        <MultiSelectorTrigger label="Add environment" persistLabel />
      </MultiSelector>,
    )

    expect(trigger()).toHaveTextContent('Add environment')
    expect(screen.getByText('Add environment')).not.toHaveClass('sr-only')
  })

  it('shows at most the badge limit and says how many more are chosen', () => {
    render(
      <MultiSelector
        values={['development', 'staging', 'preview', 'production', 'sandbox']}
        onValuesChange={() => undefined}
      >
        <MultiSelectorTrigger badgeLimit={2} wrapBadges />
      </MultiSelector>,
    )

    const chips = screen.getByRole('list')
    expect(within(chips).getByText('development')).toBeInTheDocument()
    expect(within(chips).getByText('staging')).toBeInTheDocument()
    expect(within(chips).queryByText('preview')).not.toBeInTheDocument()
    expect(within(chips).getByText('3 more selected')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
  })

  it('summarizes the choice when the badge limit is below one', () => {
    render(
      <MultiSelector values={['development', 'staging']} onValuesChange={() => undefined}>
        <MultiSelectorTrigger badgeLimit={0} />
      </MultiSelector>,
    )

    expect(screen.getByText('2 items selected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  })

  it('shows values that are data as text, never as markup', () => {
    render(
      <MultiSelector
        values={['<img src=x onerror=alert(1)>', '<b>bold</b>']}
        onValuesChange={() => undefined}
      >
        <MultiSelectorTrigger />
      </MultiSelector>,
    )

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(screen.getByText('<b>bold</b>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('list').querySelector('b')).toBeNull()
  })

  it('passes the id, description and validity of a form control to the combobox', () => {
    render(
      <>
        <label htmlFor="env-field">Environments</label>
        <p id="env-help">Choose where the plan runs.</p>
        <MultiSelector
          id="env-field"
          aria-describedby="env-help"
          aria-invalid
          values={[]}
          onValuesChange={() => undefined}
        >
          <MultiSelectorTrigger label="Select environments" />
        </MultiSelector>
      </>,
    )

    expect(trigger()).toHaveAttribute('id', 'env-field')
    expect(trigger()).toHaveAccessibleDescription('Choose where the plan runs.')
    expect(trigger()).toBeInvalid()
  })

  it('is disabled with its remove buttons gone when disabled', () => {
    render(<Demo initial={['staging']} disabled />)

    expect(trigger()).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove staging' })).not.toBeInTheDocument()
  })
})

describe('MultiSelector list', () => {
  it('opens a named dialog with a search field and a multiselectable listbox', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    await user.click(trigger())

    const dialog = await screen.findByRole('dialog', { name: 'Environments' })
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(trigger()).toHaveAttribute('aria-controls', dialog.id)
    expect(within(dialog).getByRole('combobox', { name: 'Search options' })).toBeInTheDocument()
    const list = within(dialog).getByRole('listbox', { name: 'Environments' })
    expect(list).toHaveAttribute('aria-multiselectable', 'true')
    expect(within(list).getAllByRole('option')).toHaveLength(4)
  })

  it('moves focus to the search field when it opens', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    await user.click(trigger())

    expect(await screen.findByPlaceholderText('Search environments')).toHaveFocus()
  })

  it('opens with the arrow keys and returns focus to the trigger on Escape', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    trigger().focus()
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger()).toHaveFocus())
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('adds and removes a value when an option is toggled, and marks it checked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)

    await user.click(trigger())
    await user.click(await screen.findByRole('option', { name: 'staging' }))

    expect(onChange).toHaveBeenLastCalledWith(['staging'])
    expect(screen.getByRole('option', { name: 'staging' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('option', { name: 'production' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('status')).toHaveTextContent('staging added, 1 selected')

    await user.click(screen.getByRole('option', { name: 'staging' }))

    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByRole('status')).toHaveTextContent('staging removed, none selected')
  })

  it('chooses an option with the keyboard alone', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)

    trigger().focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenLastCalledWith(['staging'])
  })

  it('filters the options by what is typed and finds them by their raw value', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    await user.click(trigger())
    await user.type(await screen.findByPlaceholderText('Search environments'), 'prod')

    expect(screen.getByRole('option', { name: 'production' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'staging' })).not.toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    await user.click(trigger())
    await user.type(await screen.findByPlaceholderText('Search environments'), 'zzz')

    expect(await screen.findByText('No results found')).toBeInTheDocument()
  })

  it('does not select a disabled option', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)

    await user.click(trigger())
    const preview = await screen.findByRole('option', { name: 'preview' })
    await user.click(preview)

    expect(preview).toHaveAttribute('aria-disabled', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes the last value with Backspace on the trigger and in an empty search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo initial={['development', 'staging']} onChange={onChange} />)

    trigger().focus()
    await user.keyboard('{Backspace}')
    expect(onChange).toHaveBeenLastCalledWith(['development'])

    await user.keyboard('{ArrowDown}')
    await screen.findByRole('dialog')
    await user.keyboard('{Backspace}')
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('does not remove a value with Backspace while there is text in the search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo initial={['staging']} onChange={onChange} />)

    trigger().focus()
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('dialog')
    await user.keyboard('ab{Backspace}')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears the search with the reset button and keeps focus in the field', async () => {
    const user = userEvent.setup()
    render(<Demo />)

    await user.click(trigger())
    const input = await screen.findByPlaceholderText('Search environments')
    await user.type(input, 'sta')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('adds a typed value when the list is creatable', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo creatable onChange={onChange} />)

    await user.click(trigger())
    await user.type(await screen.findByPlaceholderText('Search environments'), 'sandbox')
    await user.click(await screen.findByRole('option', { name: 'Create "sandbox"' }))

    expect(onChange).toHaveBeenLastCalledWith(['sandbox'])
    expect(screen.getByRole('button', { name: 'Remove sandbox' })).toBeInTheDocument()
  })

  it('shows loading inside the open list only, without options', async () => {
    const user = userEvent.setup()
    render(<Demo loading />)

    expect(screen.queryByText('Loading options')).not.toBeInTheDocument()

    await user.click(trigger())

    expect(await screen.findByText('Loading options')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('shows a failed read as a failure, never as no options', async () => {
    const user = userEvent.setup()
    render(<Demo error />)

    await user.click(trigger())

    expect(await screen.findByText('Could not read environments')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.queryByText('No results found')).not.toBeInTheDocument()
    expect(screen.queryByText('No options available')).not.toBeInTheDocument()
  })

  it('says there are no options only for a list that was read and is empty', async () => {
    const user = userEvent.setup()
    render(
      <MultiSelector label="Environments" values={[]} onValuesChange={() => undefined}>
        <MultiSelectorTrigger label="Select environments" />
        <MultiSelectorContent>
          <MultiSelectorInput placeholder="Search environments" />
          <MultiSelectorList emptyLabel="No environments">{[]}</MultiSelectorList>
        </MultiSelectorContent>
      </MultiSelector>,
    )

    await user.click(trigger())

    expect(await screen.findByText('No environments')).toBeInTheDocument()
  })

  it('shows option text that is data as text', async () => {
    const user = userEvent.setup()
    render(
      <MultiSelector label="Names" values={[]} onValuesChange={() => undefined}>
        <MultiSelectorTrigger label="Select names" />
        <MultiSelectorContent>
          <MultiSelectorInput placeholder="Search names" />
          <MultiSelectorList>
            <MultiSelectorItem value="x">{'<b>bold</b>'}</MultiSelectorItem>
          </MultiSelectorList>
        </MultiSelectorContent>
      </MultiSelector>,
    )

    await user.click(trigger())

    expect(await screen.findByRole('option', { name: '<b>bold</b>' })).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('reports opening and closing', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <MultiSelector values={[]} onValuesChange={() => undefined} onOpenChange={onOpenChange}>
        <MultiSelectorTrigger label="Select" />
        <MultiSelectorContent>
          <MultiSelectorInput placeholder="Search" />
          <MultiSelectorList>
            <MultiSelectorItem value="a">a</MultiSelectorItem>
          </MultiSelectorList>
        </MultiSelectorContent>
      </MultiSelector>,
    )

    await user.click(trigger())
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]))
  })
})

describe('MultiSelector accessibility', () => {
  it('has no violations closed, with chips', async () => {
    const { container } = render(<Demo initial={['staging', 'production']} />)

    expect(await axeViolations(container)).toEqual([])
  })

  it('has no violations open, with options and a chosen value', async () => {
    const user = userEvent.setup()
    render(<Demo initial={['staging']} />)
    await user.click(trigger())
    await screen.findByRole('dialog')

    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no violations open with a loading list or a failed one', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Demo loading />)
    await user.click(trigger())
    await screen.findByRole('dialog')
    expect(await axeViolations(document.body)).toEqual([])
    unmount()

    render(<Demo error />)
    await user.click(trigger())
    await screen.findByRole('dialog')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
