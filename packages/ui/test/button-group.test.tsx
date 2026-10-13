import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ButtonGroup, ButtonGroupItem } from '../src/button-group.tsx'
import { axeViolations } from './support/axe.ts'

describe('ButtonGroup', () => {
  it('is a named group of text buttons without accessibility violations', async () => {
    const onClick = vi.fn()
    render(
      <ButtonGroup aria-label="Row actions">
        <ButtonGroupItem icon={<svg data-testid="icon" />} onClick={onClick}>
          Copy path
        </ButtonGroupItem>
        <ButtonGroupItem>Open in editor</ButtonGroupItem>
      </ButtonGroup>,
    )

    expect(screen.getByRole('group', { name: 'Row actions' })).toBeInTheDocument()
    const first = screen.getByRole('button', { name: 'Copy path' })
    expect(first).toHaveClass('hover:bg-accent', 'justify-start', 'rounded-none')
    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('aria-hidden', 'true')
    await userEvent.click(first)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(await axeViolations()).toEqual([])
  })

  it('moves through the items with the Tab key and skips a disabled one', async () => {
    render(
      <ButtonGroup>
        <ButtonGroupItem>One</ButtonGroupItem>
        <ButtonGroupItem disabled>Two</ButtonGroupItem>
        <ButtonGroupItem>Three</ButtonGroupItem>
      </ButtonGroup>,
    )

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Three' })).toHaveFocus()
  })

  it('renders an item as a link with asChild', () => {
    render(
      <ButtonGroup aria-label="Navigate">
        <ButtonGroupItem asChild>
          <a href="/targets">Targets</a>
        </ButtonGroupItem>
      </ButtonGroup>,
    )

    expect(screen.getByRole('link', { name: 'Targets' })).toHaveAttribute('href', '/targets')
  })

  it('merges classNames', () => {
    render(
      <ButtonGroup className="w-48" aria-label="Actions">
        <ButtonGroupItem className="py-1">Run</ButtonGroupItem>
      </ButtonGroup>,
    )

    expect(screen.getByRole('group')).toHaveClass('w-48', 'flex-col')
    expect(screen.getByRole('button', { name: 'Run' })).toHaveClass('py-1')
    expect(screen.getByRole('button', { name: 'Run' })).not.toHaveClass('py-2')
  })
})
