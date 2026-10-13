import '@testing-library/jest-dom/vitest'
import { Form, FormControl, FormField, Input } from '@exponetdb/ui'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FormItemLayout } from '../../../src/form/form-item-layout/form-item-layout.tsx'
import { FormItemWrapper } from '../../../src/form/utils.tsx'
import { axeViolations } from '../../support/axe.ts'

afterEach(cleanup)

type Values = { name: string }

function NameForm({
  layout = 'vertical',
  onSubmit = () => {},
}: {
  layout?: 'vertical' | 'horizontal'
  onSubmit?: (values: Values) => void
}) {
  const form = useForm<Values>({ defaultValues: { name: '' } })
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          rules={{ required: 'Target name is required' }}
          render={({ field }) => (
            <FormItemLayout
              layout={layout}
              label="Target name"
              description="Lowercase letters and dashes."
            >
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <button type="submit">Create target</button>
      </form>
    </Form>
  )
}

describe('FormItemLayout', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'links label and description to the control in the %s layout',
    async (layout) => {
      const { container } = render(<NameForm layout={layout} />)

      const input = screen.getByRole('textbox', { name: 'Target name' })
      expect(input).toHaveAccessibleDescription('Lowercase letters and dashes.')
      expect(input).not.toBeInvalid()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(await axeViolations(container)).toEqual([])
    },
  )

  it('announces the error only while the field has one and links it to the control', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = render(<NameForm onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Create target' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Target name is required')
    const input = screen.getByRole('textbox', { name: 'Target name' })
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription(
      'Lowercase letters and dashes. Target name is required',
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(await axeViolations(container)).toEqual([])

    await user.type(input, 'reos-prod')
    await user.click(screen.getByRole('button', { name: 'Create target' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toBeInvalid()
  })

  it('lays out a row control with its label and description (flex-row-reverse)', async () => {
    function Row() {
      const form = useForm<{ approval: boolean }>({ defaultValues: { approval: false } })
      return (
        <Form {...form}>
          <FormField
            control={form.control}
            name="approval"
            render={({ field }) => (
              <FormItemLayout
                layout="flex-row-reverse"
                label="Require approval"
                description="Plans for production wait for a person."
              >
                <FormControl>
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(event) => field.onChange(event.target.checked)}
                  />
                </FormControl>
              </FormItemLayout>
            )}
          />
        </Form>
      )
    }
    const { container } = render(<Row />)

    const box = screen.getByRole('checkbox', { name: 'Require approval' })
    expect(box).toHaveAccessibleDescription('Plans for production wait for a person.')
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('FormItemWrapper', () => {
  it('wraps its child in a form control of the field', () => {
    function Field() {
      const form = useForm<Values>({ defaultValues: { name: 'reos' } })
      return (
        <Form {...form}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItemWrapper>
                <Input {...field} aria-label="Target name" />
              </FormItemWrapper>
            )}
          />
        </Form>
      )
    }
    render(<Field />)

    expect(screen.getByRole('textbox', { name: 'Target name' })).toHaveValue('reos')
  })
})
