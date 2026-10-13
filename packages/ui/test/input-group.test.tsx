import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '../src/input-group.tsx'
import { axeViolations } from './support/axe.ts'

describe('InputGroup', () => {
  it('groups an input with its addons and has no accessibility violations', async () => {
    render(
      <InputGroup aria-label="Connection host">
        <InputGroupAddon>
          <InputGroupText>postgres://</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput aria-label="Host" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="Copy host">Copy</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    )

    expect(screen.getByRole('group', { name: 'Connection host' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveAttribute(
      'data-slot',
      'input-group-control',
    )
    expect(screen.getByText('postgres://')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy host' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('focuses the control when an addon is clicked, but leaves a button in the addon alone', async () => {
    const onCopy = vi.fn()
    render(
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>Host</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput aria-label="Host" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={onCopy}>Copy</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    )

    await userEvent.click(screen.getByText('Host', { selector: 'span' }))
    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus()
  })

  it('does not expose each addon as an unnamed group', () => {
    render(
      <InputGroup>
        <InputGroupAddon data-testid="addon">
          <InputGroupText>USD</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput aria-label="Amount" />
      </InputGroup>,
    )

    expect(screen.getByTestId('addon')).not.toHaveAttribute('role')
    expect(screen.getAllByRole('group')).toHaveLength(1)
  })

  it('records the alignment of an addon', () => {
    render(
      <InputGroup>
        <InputGroupAddon align="block-start" data-testid="addon">
          Label
        </InputGroupAddon>
        <InputGroupInput aria-label="Value" />
      </InputGroup>,
    )

    expect(screen.getByTestId('addon')).toHaveAttribute('data-align', 'block-start')
  })

  it('wraps a textarea the same way', async () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="Statement" />
      </InputGroup>,
    )

    const textarea = screen.getByRole('textbox', { name: 'Statement' })
    await userEvent.type(textarea, 'select 1')
    expect(textarea).toHaveValue('select 1')
    expect(textarea).toHaveAttribute('data-slot', 'input-group-control')
    expect(await axeViolations()).toEqual([])
  })

  it('does not take the id and aria props that a form control adds to the group', () => {
    render(
      <InputGroup id="field" aria-invalid="true" aria-describedby="hint" data-testid="group">
        <InputGroupInput aria-label="Value" />
      </InputGroup>,
    )

    const group = screen.getByTestId('group')
    expect(group).not.toHaveAttribute('id')
    expect(group).not.toHaveAttribute('aria-invalid')
    expect(group).not.toHaveAttribute('aria-describedby')
  })

  it('does not focus or accept text in a disabled control', async () => {
    render(
      <InputGroup>
        <InputGroupInput aria-label="Host" disabled />
      </InputGroup>,
    )

    expect(screen.getByRole('textbox', { name: 'Host' })).toBeDisabled()
  })
})
