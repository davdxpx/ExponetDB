import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormInputGroupInput,
  FormItem,
  FormLabel,
  FormMessage,
} from '../src/form.tsx'
import { Input } from '../src/input.tsx'
import { InputGroup } from '../src/input-group.tsx'
import { axeViolations } from './support/axe.ts'

type Values = { name: string }

function NameForm({
  onSubmit = () => {},
  message,
  description = 'Lowercase letters and dashes.',
  rule = 'Name is required',
}: {
  onSubmit?: (values: Values) => void
  message?: string
  description?: string
  rule?: string
}) {
  const form = useForm<Values>({ defaultValues: { name: '' } })
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          rules={{ required: rule }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Target name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>{description}</FormDescription>
              <FormMessage>{message}</FormMessage>
            </FormItem>
          )}
        />
        <button type="submit">Create target</button>
      </form>
    </Form>
  )
}

describe('Form', () => {
  it('wires the label, the control and the description together without violations', async () => {
    render(<NameForm />)

    const input = screen.getByRole('textbox', { name: 'Target name' })
    expect(input).toHaveAccessibleDescription('Lowercase letters and dashes.')
    expect(input).not.toBeInvalid()
    expect(await axeViolations()).toEqual([])
  })

  it('submits the typed values when they are valid', async () => {
    const onSubmit = vi.fn()
    render(<NameForm onSubmit={onSubmit} />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Target name' }), 'reos-prod')
    await userEvent.click(screen.getByRole('button', { name: 'Create target' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ name: 'reos-prod' })
  })

  it('shows the validation message as an alert, marks the control invalid and describes it by both', async () => {
    const onSubmit = vi.fn()
    render(<NameForm onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('button', { name: 'Create target' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Name is required')
    expect(alert.tagName).toBe('P')
    const input = screen.getByRole('textbox', { name: 'Target name' })
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('Lowercase letters and dashes. Name is required')
    expect(screen.getByText('Target name')).toHaveClass('text-destructive!')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })

  it('renders a validation message as text, never as markup', async () => {
    render(<NameForm rule="<b>bold</b> <img src=x onerror=alert(1)>" />)

    await userEvent.click(screen.getByRole('button', { name: 'Create target' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('<b>bold</b> <img src=x onerror=alert(1)>')
    expect(alert.querySelector('b, img')).toBeNull()
  })

  it('clears the message once the value is valid', async () => {
    render(<NameForm />)

    await userEvent.click(screen.getByRole('button', { name: 'Create target' }))
    await screen.findByRole('alert')
    await userEvent.type(screen.getByRole('textbox', { name: 'Target name' }), 'a')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Target name' })).not.toBeInvalid()
  })

  it('shows its children as a hint when the field has no error, without an alert role', () => {
    render(<NameForm message="Pick a short name." />)

    const hint = screen.getByText('Pick a short name.')
    expect(hint).not.toHaveAttribute('role')
    expect(hint.id).toMatch(/-form-item-message$/)
  })

  it('renders nothing for a message with no error and no children', () => {
    const { container } = render(<NameForm />)

    expect(container.querySelector('[id$="-form-item-message"]')).toBeNull()
  })

  it('does not animate with an animation library: no motion wrapper around the message', async () => {
    render(<NameForm />)

    await userEvent.click(screen.getByRole('button', { name: 'Create target' }))
    const alert = await screen.findByRole('alert')
    expect(alert.parentElement?.tagName).toBe('DIV')
    expect(alert.parentElement?.getAttribute('style')).toBeNull()
  })

  it('works with an input group through FormInputGroupInput', async () => {
    function GroupForm() {
      const form = useForm<Values>({ defaultValues: { name: '' } })
      return (
        <Form {...form}>
          <FormField
            control={form.control}
            name="name"
            rules={{ required: 'Host is required' }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Host</FormLabel>
                <InputGroup>
                  <FormInputGroupInput {...field} />
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />
          <button type="button" onClick={() => void form.trigger()}>
            Check
          </button>
        </Form>
      )
    }
    render(<GroupForm />)

    const input = screen.getByRole('textbox', { name: 'Host' })
    expect(input).toHaveAttribute('data-slot', 'input-group-control')
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Host is required')
    expect(input).toBeInvalid()
  })

  it('fails loudly when a part is used outside FormField or FormItem', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Bare() {
      const form = useForm<Values>()
      return (
        <Form {...form}>
          <FormLabel>Orphan</FormLabel>
        </Form>
      )
    }
    expect(() => render(<Bare />)).toThrow('useFormField should be used within <FormField>')
    error.mockRestore()
  })
})
