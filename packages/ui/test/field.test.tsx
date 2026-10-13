import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '../src/field.tsx'
import { Input } from '../src/input.tsx'
import { axeViolations } from './support/axe.ts'

describe('Field', () => {
  it('lays out a labelled input with a description and has no accessibility violations', async () => {
    render(
      <FieldSet>
        <FieldLegend>Connection</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="host">Host</FieldLabel>
            <Input id="host" aria-describedby="host-hint" />
            <FieldDescription id="host-hint">The address of the server.</FieldDescription>
          </Field>
          <FieldSeparator />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Port</FieldTitle>
            </FieldContent>
            <Input aria-label="Port" />
          </Field>
        </FieldGroup>
      </FieldSet>,
    )

    expect(screen.getByRole('group', { name: 'Connection' })).toBeInTheDocument()
    const host = screen.getByRole('textbox', { name: 'Host' })
    expect(host).toHaveAccessibleDescription('The address of the server.')
    expect(screen.getAllByRole('group')).toHaveLength(3)
    expect(await axeViolations()).toEqual([])
  })

  it('records its orientation', () => {
    render(
      <>
        <Field data-testid="vertical">content</Field>
        <Field orientation="responsive" data-testid="responsive">
          content
        </Field>
      </>,
    )

    expect(screen.getByTestId('vertical')).toHaveAttribute('data-orientation', 'vertical')
    expect(screen.getByTestId('vertical')).toHaveClass('flex-col')
    expect(screen.getByTestId('responsive')).toHaveAttribute('data-orientation', 'responsive')
  })

  it('names the legend variants', () => {
    render(
      <fieldset>
        <FieldLegend variant="label">Options</FieldLegend>
      </fieldset>,
    )

    expect(screen.getByText('Options')).toHaveAttribute('data-variant', 'label')
  })

  it('puts content in the separator', () => {
    render(<FieldSeparator>or</FieldSeparator>)

    expect(screen.getByText('or')).toHaveAttribute('data-slot', 'field-separator-content')
  })
})

describe('FieldError', () => {
  it('announces its children as an alert', async () => {
    render(<FieldError>Host is required</FieldError>)

    expect(screen.getByRole('alert')).toHaveTextContent('Host is required')
    expect(await axeViolations()).toEqual([])
  })

  it('shows a single error message as text', () => {
    render(<FieldError errors={[{ message: 'Too short' }]} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Too short')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('lists several error messages and skips the ones without a message', () => {
    render(<FieldError errors={[{ message: 'Too short' }, undefined, { message: 'No spaces' }]} />)

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Too short',
      'No spaces',
    ])
  })

  it('renders markup in a message as text', () => {
    render(<FieldError errors={[{ message: '<b>bad</b>' }]} />)

    expect(screen.getByRole('alert').textContent).toBe('<b>bad</b>')
    expect(screen.getByRole('alert').querySelector('b')).toBeNull()
  })

  it('renders nothing without content', () => {
    const { container } = render(<FieldError errors={[]} />)
    const none = render(<FieldError />)

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(none.container.querySelector('[role="alert"]')).toBeNull()
  })
})
