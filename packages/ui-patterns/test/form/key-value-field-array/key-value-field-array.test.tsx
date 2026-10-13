// Derived from supabase/supabase packages/ui-patterns/src/form/KeyValueFieldArray/KeyValueFieldArray.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { Button, Form } from '@exponetdb/ui'
import { zodResolver } from '@hookform/resolvers/zod'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  KeyValueFieldArray,
  type KeyValueFieldArrayAction,
} from '../../../src/form/key-value-field-array/key-value-field-array.tsx'
import { axeViolations } from '../../support/axe.ts'

afterEach(cleanup)

const keyValueSchema = z.object({
  headers: z.array(
    z.object({
      key: z.string().min(1, 'Header name is required'),
      value: z.string().min(1, 'Header value is required'),
    }),
  ),
})

const nameValueSchema = z.object({
  headers: z.array(
    z.object({
      id: z.string(),
      name: z.string().min(1, 'Header name is required'),
      value: z.string().min(1, 'Header value is required'),
    }),
  ),
})

type KeyValueFormValues = z.infer<typeof keyValueSchema>
type NameValueFormValues = z.infer<typeof nameValueSchema>

const presetActions: KeyValueFieldArrayAction<KeyValueFormValues['headers'][number]>[] = [
  {
    key: 'auth',
    label: 'Add authorization headers',
    description: 'Required when the receiving endpoint verifies a token',
    createRows: () => [
      { key: 'Authorization', value: 'Bearer example-token' },
      { key: 'X-Api-Key', value: 'example-key' },
    ],
  },
  {
    key: 'source',
    label: 'Add source header',
    description: 'Lets the receiver verify that the request came from this webhook',
    createRows: () => ({ key: 'x-exponetdb-source', value: 'plan-events' }),
    separatorAbove: true,
  },
]

const KeyValueForm = ({
  defaultValues = { headers: [] },
  addActions,
  onSubmit = vi.fn(),
}: {
  defaultValues?: KeyValueFormValues
  addActions?: KeyValueFieldArrayAction<KeyValueFormValues['headers'][number]>[]
  onSubmit?: (values: KeyValueFormValues) => void
}) => {
  const form = useForm<KeyValueFormValues>({
    resolver: zodResolver(keyValueSchema),
    defaultValues,
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <KeyValueFieldArray
          control={form.control}
          name="headers"
          keyFieldName="key"
          valueFieldName="value"
          createEmptyRow={() => ({ key: '', value: '' })}
          keyPlaceholder="Header name"
          valuePlaceholder="Header value"
          addLabel="Add header"
          addActions={addActions}
          removeLabel="Remove header"
          aria-label="Headers"
        />
        <Button variant="primary" type="submit">
          Save headers
        </Button>
      </form>
    </Form>
  )
}

const NameValueForm = ({
  onSubmit = vi.fn(),
}: {
  onSubmit?: (values: NameValueFormValues) => void
}) => {
  const form = useForm<NameValueFormValues>({
    resolver: zodResolver(nameValueSchema),
    defaultValues: {
      headers: [{ id: 'row-1', name: 'Authorization', value: 'Bearer token' }],
    },
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <KeyValueFieldArray
          control={form.control}
          name="headers"
          keyFieldName="name"
          valueFieldName="value"
          createEmptyRow={() => ({ id: crypto.randomUUID(), name: '', value: '' })}
          keyPlaceholder="Header name"
          valuePlaceholder="Header value"
          addLabel="Add header"
          removeLabel="Remove header"
        />
        <Button variant="primary" type="submit">
          Save headers
        </Button>
      </form>
    </Form>
  )
}

describe('KeyValueFieldArray', () => {
  it('appends an empty row', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm />)

    await user.click(screen.getByRole('button', { name: 'Add header' }))

    expect(screen.getByPlaceholderText('Header name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Header value')).toBeInTheDocument()
  })

  it('removes a row', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm defaultValues={{ headers: [{ key: 'x-test', value: '1' }] }} />)

    await user.click(screen.getByRole('button', { name: 'Add header' }))
    expect(screen.getAllByPlaceholderText('Header name')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Remove header 2' }))

    expect(screen.getAllByPlaceholderText('Header name')).toHaveLength(1)
    expect(screen.getByDisplayValue('x-test')).toBeInTheDocument()
  })

  it('names every control by its row so that no two share a name', () => {
    render(
      <KeyValueForm
        defaultValues={{
          headers: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2' },
          ],
        }}
      />,
    )

    expect(screen.getByRole('list', { name: 'Headers' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toHaveValue('a')
    expect(screen.getByRole('textbox', { name: 'Header value 2' })).toHaveValue('2')
    expect(screen.getByRole('button', { name: 'Remove header 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove header 2' })).toBeInTheDocument()
  })

  it('moves focus to the first field of a new row', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm defaultValues={{ headers: [{ key: 'x-test', value: '1' }] }} />)

    await user.click(screen.getByRole('button', { name: 'Add header' }))

    expect(screen.getByRole('textbox', { name: 'Header name 2' })).toHaveFocus()
  })

  it('adds and removes rows with the keyboard alone', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm />)

    await user.tab()
    expect(screen.getByRole('button', { name: 'Add header' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toHaveFocus()

    await user.keyboard('x-one{Tab}1{Tab}')
    expect(screen.getByRole('button', { name: 'Remove header 1' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add header' })).toHaveFocus()
  })

  it('moves focus to the row that took the removed row place, else the row above', async () => {
    const user = userEvent.setup()

    render(
      <KeyValueForm
        defaultValues={{
          headers: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2' },
            { key: 'c', value: '3' },
          ],
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Remove header 2' }))
    expect(screen.getByRole('textbox', { name: 'Header name 2' })).toHaveValue('c')
    expect(screen.getByRole('textbox', { name: 'Header name 2' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Remove header 2' }))
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toHaveFocus()
  })

  it('renders and submits key/value field names', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    render(
      <KeyValueForm defaultValues={{ headers: [{ key: '', value: '' }] }} onSubmit={onSubmit} />,
    )

    await user.type(screen.getByPlaceholderText('Header name'), 'X-Test-Header')
    await user.type(screen.getByPlaceholderText('Header value'), 'test-value')
    await user.click(screen.getByRole('button', { name: 'Save headers' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { headers: [{ key: 'X-Test-Header', value: 'test-value' }] },
        expect.anything(),
      ),
    )
  })

  it('renders and submits name/value field names while preserving row ids', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    render(<NameValueForm onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Save headers' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        {
          headers: [{ id: 'row-1', name: 'Authorization', value: 'Bearer token' }],
        },
        expect.anything(),
      ),
    )
  })

  it('shows resolver errors per cell as alerts and marks the cell invalid', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm defaultValues={{ headers: [{ key: '', value: '' }] }} />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save headers' }))

    const nameError = await screen.findByText('Header name is required')
    expect(nameError).toHaveAttribute('role', 'alert')
    expect(screen.getByText('Header value is required')).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toBeInvalid()
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toHaveAccessibleDescription(
      'Header name is required',
    )
  })

  it('supports preset actions that append one or multiple rows', async () => {
    const user = userEvent.setup()

    render(<KeyValueForm addActions={presetActions} />)

    await user.click(screen.getByRole('button', { name: 'Add header options' }))
    await user.click(await screen.findByRole('menuitem', { name: /Add authorization headers/ }))

    expect(screen.getAllByPlaceholderText('Header name')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Add header options' }))
    await user.click(await screen.findByRole('menuitem', { name: /Add source header/ }))

    expect(screen.getAllByPlaceholderText('Header name')).toHaveLength(3)
    expect(screen.getByDisplayValue('Authorization')).toBeInTheDocument()
    expect(screen.getByDisplayValue('X-Api-Key')).toBeInTheDocument()
    expect(screen.getByDisplayValue('x-exponetdb-source')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Header name 3' })).toHaveFocus()
  })

  it('disables every control when disabled', () => {
    const Disabled = () => {
      const form = useForm<KeyValueFormValues>({
        defaultValues: { headers: [{ key: 'a', value: '1' }] },
      })
      return (
        <Form {...form}>
          <KeyValueFieldArray
            control={form.control}
            name="headers"
            keyFieldName="key"
            valueFieldName="value"
            createEmptyRow={() => ({ key: '', value: '' })}
            keyPlaceholder="Header name"
            valuePlaceholder="Header value"
            addLabel="Add header"
            removeLabel="Remove header"
            disabled
          />
        </Form>
      )
    }
    render(<Disabled />)

    expect(screen.getByRole('textbox', { name: 'Header name 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add header' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove header 1' })).toBeDisabled()
  })

  it('has no accessibility violations with rows and errors', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <KeyValueForm
        defaultValues={{ headers: [{ key: '', value: '' }] }}
        addActions={presetActions}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Save headers' }))
    await screen.findByText('Header name is required')

    expect(await axeViolations(container)).toEqual([])
  })
})
