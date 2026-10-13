import '@testing-library/jest-dom/vitest'
import { Input } from '@exponetdb/ui'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { FormLayout } from '../../../src/form/layout/form-layout.tsx'
import { axeViolations } from '../../support/axe.ts'

afterEach(cleanup)

describe('FormLayout', () => {
  it('points the label at the control and links the description to it', async () => {
    const { container } = render(
      <FormLayout label="Target name" description="Lowercase letters and dashes.">
        {(control) => <Input {...control} />}
      </FormLayout>,
    )

    const input = screen.getByRole('textbox', { name: 'Target name' })
    expect(input).toHaveAccessibleDescription('Lowercase letters and dashes.')
    expect(input).not.toBeInvalid()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('uses the id it was given for the control', () => {
    render(
      <FormLayout label="Host" id="host-field">
        {(control) => <Input {...control} />}
      </FormLayout>,
    )

    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveAttribute('id', 'host-field')
  })

  it('shows the error as an alert linked to the control only while there is an error', async () => {
    function Field() {
      const [value, setValue] = useState('')
      return (
        <FormLayout
          label="Target name"
          description="Lowercase letters and dashes."
          error={value === '' ? 'Target name is required' : undefined}
        >
          {(control) => (
            <Input {...control} value={value} onChange={(event) => setValue(event.target.value)} />
          )}
        </FormLayout>
      )
    }
    const user = userEvent.setup()
    const { container } = render(<Field />)

    const input = screen.getByRole('textbox', { name: 'Target name' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Target name is required')
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription(
      'Lowercase letters and dashes. Target name is required',
    )
    expect(await axeViolations(container)).toEqual([])

    await user.type(input, 'reos-prod')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toBeInvalid()
    expect(input).toHaveAccessibleDescription('Lowercase letters and dashes.')
  })

  it('keeps the control invalid but does not render the message when it is hidden', () => {
    render(
      <FormLayout label="Port" error="Port is out of range" hideMessage>
        {(control) => <Input {...control} />}
      </FormLayout>,
    )

    expect(screen.getByRole('textbox', { name: 'Port' })).toBeInvalid()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Port' })).not.toHaveAccessibleDescription()
  })

  it.each(['horizontal', 'vertical', 'flex', 'flex-row-reverse'] as const)(
    'renders the %s layout with label, control, description and error',
    async (layout) => {
      const { container } = render(
        <FormLayout
          layout={layout}
          label="Require approval"
          description="Plans for production wait for a person."
          error="Choose an option"
          labelOptional="Optional"
        >
          {(control) => <Input {...control} />}
        </FormLayout>,
      )

      const input = screen.getByRole('textbox', { name: 'Require approval' })
      expect(input).toHaveAccessibleDescription(
        'Plans for production wait for a person. Choose an option',
      )
      expect(screen.getByText('Optional')).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('Choose an option')
      expect(await axeViolations(container)).toEqual([])
    },
  )

  it('shows the parts next to the label and keeps the label text as the name', () => {
    render(
      <FormLayout
        label="Retention"
        beforeLabel="Backups"
        afterLabel={<span>days</span>}
        labelOptional="Optional"
      >
        {(control) => <Input {...control} />}
      </FormLayout>,
    )

    expect(screen.getByText('Backups')).toBeInTheDocument()
    expect(screen.getByText('days')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Retention/ })).toBeInTheDocument()
  })

  it('renders plain children as they are', () => {
    render(
      <FormLayout label="Notes">
        <p>Static content</p>
      </FormLayout>,
    )

    expect(screen.getByText('Static content')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
  })

  it('shows an error that is data as text, never as markup', () => {
    render(
      <FormLayout label="Name" error="<b>bold</b> & <i>x</i>">
        {(control) => <Input {...control} />}
      </FormLayout>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('<b>bold</b> & <i>x</i>')
    expect(screen.getByRole('alert').querySelector('b')).toBeNull()
  })
})
