import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DialogDisclosure,
  DialogDisclosureContent,
  DialogDisclosureTrigger,
} from '../src/dialog-disclosure.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

function Disclosure({ open }: { open?: boolean }) {
  return (
    <DialogDisclosure defaultOpen={open}>
      <DialogDisclosureTrigger>Show statements</DialogDisclosureTrigger>
      <DialogDisclosureContent>
        <p>ALTER TABLE accounts ADD COLUMN note text;</p>
      </DialogDisclosureContent>
    </DialogDisclosure>
  )
}

describe('DialogDisclosure', () => {
  it('is a closed button with aria-expanded=false that controls its content', () => {
    render(<Disclosure />)

    const trigger = screen.getByRole('button', { name: 'Show statements' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/ALTER TABLE/)).not.toBeInTheDocument()
  })

  it('opens and closes on press and with the keyboard', async () => {
    const user = userEvent.setup()
    render(<Disclosure />)

    await user.click(screen.getByRole('button', { name: 'Show statements' }))
    const trigger = screen.getByRole('button', { name: 'Show statements' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/ALTER TABLE/)).toBeVisible()
    expect(trigger).toHaveAttribute(
      'aria-controls',
      screen.getByText(/ALTER TABLE/).parentElement?.id,
    )

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders the statement text as text', () => {
    render(<Disclosure open />)

    expect(screen.getByText('ALTER TABLE accounts ADD COLUMN note text;')).toBeVisible()
  })

  it('takes an icon in place of the chevron and hides it from assistive technology', () => {
    const { container } = render(
      <DialogDisclosure>
        <DialogDisclosureTrigger icon={<span data-testid="own">+</span>}>
          Show
        </DialogDisclosureTrigger>
        <DialogDisclosureContent>Content</DialogDisclosureContent>
      </DialogDisclosure>,
    )

    expect(screen.getByTestId('own').parentElement).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Disclosure open />)

    expect(await axeViolations(container)).toEqual([])
  })
})
